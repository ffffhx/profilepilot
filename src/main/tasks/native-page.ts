import { createHash, randomUUID } from "node:crypto";
import type { BrowserAction, BrowserObservation, BrowserTask } from "../../shared/tasks";
import { FastBrowser, readLinkGuard, type PageReadOptions, type PageSlice, type PagedObservation } from "./fast-browser";

export type NativeCdp = (task: BrowserTask, method: string, params?: Record<string, unknown>, cdpSessionId?: string) => Promise<any>;
export interface FrameInfo { id: string; parentId?: string; url: string; name?: string; oopif: boolean; }
interface Frame extends FrameInfo { session?: string; context?: number; loaderId?: string; }
interface FrameState {
  sessions: Map<string, string | undefined>; initialized: Set<string>; frames: Map<string, Frame>;
  refs: Map<string, string>; nextRef: number; tabId?: number; generation: number;
  selection?: { frameId: string; url: string; loaderId?: string; slice?: PageSlice };
}
interface Binding { frameId: string; session?: string; context: number; generation: number; refs: Record<string, string>; localGuard: string; url: string; loaderId?: string; }
type NativeObservation = PagedObservation & { frames?: FrameInfo[]; fast?: NonNullable<BrowserObservation["fast"]> & { native?: Binding; slice?: PageSlice } };

class NativePaintError extends Error {
  readonly code = "NATIVE_RENDER_UNAVAILABLE";
}
function visualReadTimedOut(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return error instanceof Error && error.message === "截图无响应，已停止等待。" &&
    (code === undefined || code === "NATIVE_RENDER_UNAVAILABLE");
}
const visualStateExpression = "({url:location.href,document:performance.timeOrigin,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,scale:visualViewport?.scale||1,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})";

/** Frame ownership follows the extension's debugger session tree, never a
 * target enumeration across other tabs. Same-process frames get isolated
 * worlds; OOPIFs get the child debugger session provided by Chrome 125+. */
export class NativePage {
  private states = new Map<string, FrameState>();
  private serial = 0;
  constructor(private readonly cdp: NativeCdp) {}
  private key(task: Pick<BrowserTask, "profileId" | "sessionId" | "id">): string { return `${task.profileId}\0${task.sessionId}\0${task.id || ""}`; }
  private state(task: BrowserTask): FrameState {
    const key = this.key(task);
    let state = this.states.get(key);
    if (!state) { state = { sessions: new Map(), initialized: new Set(), frames: new Map(), refs: new Map(), nextRef: 1, generation: ++this.serial }; this.states.set(key, state); }
    return state;
  }
  event(event: { type: string; profileId: string; sessionId?: string; cdpSessionId?: string; tabId?: number; method?: string; params?: any; state?: any }): void {
    for (const [key, state] of this.states) {
      if (!key.startsWith(`${event.profileId}\0`) || (event.sessionId && !key.startsWith(`${event.profileId}\0${event.sessionId}\0`))) continue;
      if (event.type === "disconnected" || (event.type === "state" && (event.state?.ownership !== "agent" || (state.tabId !== undefined && state.tabId !== event.state?.tabId)))) {
        this.states.delete(key); continue;
      }
      if (event.type === "state") state.tabId = event.state?.tabId;
      if (event.type !== "cdp") continue;
      if (state.tabId !== undefined && event.tabId !== undefined && state.tabId !== event.tabId) continue;
      if (event.method === "Target.attachedToTarget" && event.params?.targetInfo?.type === "iframe") state.sessions.set(event.params.sessionId, event.cdpSessionId);
      if (event.method === "Target.detachedFromTarget") {
        const drop = (session: string) => {
          for (const [child, parent] of state.sessions) if (parent === session) drop(child);
          state.sessions.delete(session); state.initialized.delete(session);
          for (const [id, frame] of state.frames) if (frame.session === session) state.frames.delete(id);
        };
        drop(event.params?.sessionId);
      }
      if (event.method === "Page.frameDetached" && event.params?.reason !== "swap") state.frames.delete(event.params?.frameId);
      if (event.method === "Page.frameNavigated" && event.params?.frame?.id) {
        const frame = state.frames.get(event.params.frame.id);
        if (frame) {
          this.invalidateFrame(state, frame);
          Object.assign(frame, { url: event.params.frame.url, loaderId: event.params.frame.loaderId, context: undefined });
        }
      }
      if (event.method === "Page.navigatedWithinDocument") {
        const frame = state.frames.get(event.params?.frameId);
        if (frame && frame.url !== event.params?.url) {
          this.invalidateFrame(state, frame);
          frame.url = event.params.url;
        }
      }
    }
  }
  private invalidateFrame(state: FrameState, frame: Frame): void {
    if (!frame.parentId) {
      state.selection = undefined; state.refs.clear(); state.generation = ++this.serial;
    } else {
      if (state.selection?.frameId === frame.id) state.selection = undefined;
      for (const key of state.refs.keys()) if (key.startsWith(`${frame.id}\0`)) state.refs.delete(key);
    }
  }
  private async discover(task: BrowserTask): Promise<FrameState> {
    const state = this.state(task);
    const initialize = async (session?: string) => {
      const key = session || "";
      if (state.initialized.has(key)) return;
      await this.cdp(task, "Page.enable", {}, session);
      await this.cdp(task, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] }, session);
      state.initialized.add(key);
    };
    await initialize();
    // setAutoAttach is not recursive. Each round may announce grandchildren.
    for (let round = 0; ; round++) {
      const pending = [...state.sessions.keys()].filter(id => !state.initialized.has(id));
      if (!pending.length) break;
      if (round > 100) throw new Error("frame 树持续变化，请等待页面稳定后重试观察。");
      for (const session of pending) await initialize(session);
    }
    const frames = new Map<string, Frame>();
    const collect = (node: any, session?: string, parentId?: string) => {
      if (!node?.frame?.id) return;
      const f = node.frame;
      const previous = frames.get(f.id);
      frames.set(f.id, { id: f.id, parentId: f.parentId || parentId || previous?.parentId, name: f.name, url: f.url, loaderId: f.loaderId, oopif: Boolean(session), session });
      for (const child of node.childFrames || []) collect(child, session, f.id);
    };
    collect((await this.cdp(task, "Page.getFrameTree")).frameTree);
    for (const session of state.sessions.keys()) collect((await this.cdp(task, "Page.getFrameTree", {}, session)).frameTree, session);
    for (const frame of frames.values()) {
      const old = state.frames.get(frame.id);
      if (!old) continue;
      if (old.url !== frame.url || old.loaderId !== frame.loaderId || old.session !== frame.session) this.invalidateFrame(state, old);
      else frame.context = old.context;
    }
    state.frames = frames;
    if (state.selection && !frames.has(state.selection.frameId)) state.selection = undefined;
    if (!frames.size) throw new Error("Chrome 未返回 frame 树，请重新观察。");
    return state;
  }
  private async context(task: BrowserTask, frame: Frame): Promise<number> {
    if (frame.context) return frame.context;
    const result = await this.cdp(task, "Page.createIsolatedWorld", { frameId: frame.id, worldName: "profilepilot-dom-v2" }, frame.session);
    if (!Number.isInteger(result.executionContextId)) throw new Error("frame 执行上下文不可用，请重新观察。");
    return frame.context = result.executionContextId;
  }
  private scoped(task: BrowserTask, frame: Frame): FastBrowser {
    return new FastBrowser(async () => {}, async (_task, method, params) => {
      if (method === "Runtime.evaluate") return this.cdp(task, method, { ...params, contextId: await this.context(task, frame) }, frame.session);
      if (method === "Input.dispatchMouseEvent") {
        const point = await this.topPoint(task, frame, Number(params.x), Number(params.y));
        // Chrome routes OOPIF input through that renderer's debugger session.
        // Validate occlusion up to the root first, then use coordinates in the
        // receiving session's main frame (same-process descendants add offsets).
        const targetPoint = frame.session ? await this.topPoint(task, frame, Number(params.x), Number(params.y), true) : point;
        return this.cdp(task, method, { ...params, ...targetPoint }, frame.session);
      }
      return this.cdp(task, method, params, frame.session);
    });
  }
  private async synchronizePaint(task: BrowserTask, frame?: Frame): Promise<void> {
    // Hidden Chrome renderers can update scrollY without dispatching scroll,
    // rAF or IntersectionObserver. A screenshot requests compositor frames; it
    // does not focus the tab. Wait for two quiet frames after that wake-up so
    // lazy lists and finite entrance transitions can settle before we read.
    // Extension CDP is serialized: awaiting a page Promise would prevent the
    // screenshot queued behind it from supplying the frame it needs. Register
    // first, return immediately, then request bounded compositor pulses while
    // polling the SAME barrier. A capture may advance only a single rAF.
    const contextId = frame ? await this.context(task, frame) : undefined;
    const key = JSON.stringify(`__profilepilot_paint_${randomUUID()}`);
    const evaluate = (expression: string) => this.cdp(task, "Runtime.evaluate", { expression,
      ...(contextId ? { contextId } : {}), returnByValue: true }, frame?.session);
    const started = await evaluate(`/*profilepilot-paint:start*/(()=>{
      const key=${key}, state={ready:false};let raf,timer,revision=0,previous=-1,quiet=0;
      const observer=new MutationObserver(()=>revision++);
      state.dispose=()=>{clearTimeout(timer);cancelAnimationFrame(raf);observer.disconnect()};
      const tick=()=>{
        const animating=document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime));
        quiet=!animating&&revision===previous?quiet+1:0;previous=revision;
        if(quiet>=2){state.ready=true;observer.disconnect();}else raf=requestAnimationFrame(tick);
      };
      window[key]=state;observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>{state.dispose();delete window[key]},11000);raf=requestAnimationFrame(tick);return true;
    })()`);
    if (started.exceptionDetails) throw new NativePaintError("无法确认页面绘制帧。");
    try {
      // Chrome permits each visual read to take 2.5 s. Three slow pulses are
      // needed for the initial frame and two quiet frames on hidden Windows
      // tabs; a 4.5 s budget could never confirm that otherwise valid sequence.
      const deadline = Date.now() + 8000;
      for (let pulse = 0; pulse <= 8; pulse++) {
        const ready = await evaluate(`/*profilepilot-paint:poll*/(()=>{const state=window[${key}];return state?state.ready:null})()`);
        if (ready.exceptionDetails || ready.result?.value === null) break;
        if (ready.result?.value === true) return;
        if (pulse === 8 || Date.now() >= deadline) break;
        try {
          await this.cdp(task, "Page.captureScreenshot", { format: "jpeg", quality: 10, captureBeyondViewport: false });
        } catch (error) {
          // This image is only a compositor pulse, not the requested output.
          // Chrome can paint/dispatch rAF while its image read times out. Poll
          // the same registered barrier before deciding whether paint failed.
          // Never hide a real ownership/disconnect error or a candidate PNG
          // failure; the next poll still passes through the owned CDP route.
          if (!visualReadTimedOut(error)) throw error;
        }
      }
      throw new NativePaintError("后台页面未生成稳定绘制帧，当前画面尚不能确认。请读取当前状态后再决定下一步。");
    } finally {
      // This still uses the owned route. Takeover/disconnect refuses cleanup
      // commands; the page's expiry then disposes its observer and rAF itself.
      await evaluate(`/*profilepilot-paint:cleanup*/(()=>{const key=${key};window[key]?.dispose();delete window[key];return true})()`).catch(() => {});
    }
  }
  async visualState(task: BrowserTask): Promise<any> {
    const result = await this.cdp(task, "Runtime.evaluate", { expression: visualStateExpression, returnByValue: true });
    if (result.exceptionDetails || !result.result?.value) throw new Error("无法确认截图的页面坐标。");
    return result.result.value;
  }
  private async captureState(task: BrowserTask): Promise<{ visual: any; frames: any[] }> {
    const state = await this.discover(task), frames = [];
    for (const frame of [...state.frames.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const response = await this.cdp(task, "Runtime.evaluate", { expression: `/*profilepilot-capture-state*/(()=>{
        const key='__profilepilot_capture_v2';
        let state=window[key];
        if(!state){state={revision:0,next:1,ids:new WeakMap(),roots:[]};state.observer=new MutationObserver(()=>state.revision++);window[key]=state;}
        if(state.observer.takeRecords().length)state.revision++;
        const roots=[document];
        for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*'))if(node.shadowRoot)roots.push(node.shadowRoot);
        if(roots.length!==state.roots.length||roots.some((root,i)=>root!==state.roots[i])){
          state.revision++;state.observer.disconnect();
          for(const root of roots)state.observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:true});
          state.roots=roots;
        }
        const ids=roots.map(root=>{let id=state.ids.get(root);if(!id){id=state.next++;state.ids.set(root,id)}return id});
        return {url:location.href,document:performance.timeOrigin,revision:state.revision,roots:ids};
      })()`, contextId: await this.context(task, frame), returnByValue: true }, frame.session);
      if (response.exceptionDetails || !response.result?.value) throw new NativePaintError("无法确认截图的 frame 页面状态。");
      frames.push({ id: frame.id, parentId: frame.parentId, session: frame.session, loaderId: frame.loaderId, ...response.result.value });
    }
    return { visual: await this.visualState(task), frames };
  }
  async captureScreenshot(task: BrowserTask, params: Record<string, unknown> = {}): Promise<{ result: any; visual: any }> {
    if ((await this.visualState(task)).url === "about:blank") throw new NativePaintError("当前是空白任务页，没有可截图的内容。请先打开目标网站。");
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.synchronizePaint(task);
      const before = await this.captureState(task);
      let result;
      try { result = await this.cdp(task, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...params }); }
      catch (error) {
        // Only a known image-read timeout can consume another bounded capture
        // attempt. The next iteration rechecks ownership, frames and DOM; no
        // input is replayed, and a real control error always stops immediately.
        if (attempt < 2 && visualReadTimedOut(error)) continue;
        throw error;
      }
      if (typeof result.data !== "string" || !result.data) throw new NativePaintError("浏览器未返回画面。");
      await this.synchronizePaint(task);
      const after = await this.captureState(task);
      if (JSON.stringify(before) === JSON.stringify(after)) return { result, visual: after.visual };
    }
    throw new NativePaintError("截图期间页面持续变化，未返回过时画面。请等待页面稳定后再次截图。");
  }
  async pointer(task: BrowserTask, input: { kind: "click" | "hover"; x: number; y: number }, expectedVisual: any): Promise<void> {
    await this.synchronizePaint(task);
    await this.assertFresh(task);
    const state = await this.discover(task), root = [...state.frames.values()].find(frame => !frame.parentId);
    if (!root || JSON.stringify(await this.visualState(task)) !== JSON.stringify(expectedVisual)) throw new Error("截图页面或视口已变化，请重新截图后执行指针操作。");
    await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      const driver = this.scoped(task, root), point = { x: input.x, y: input.y };
      if (input.kind === "hover") await driver.raw(task, "Input.dispatchMouseEvent", { ...point, type: "mouseMoved", button: "none" });
      else {
        await driver.raw(task, "Input.dispatchMouseEvent", { ...point, type: "mousePressed", button: "left", clickCount: 1 });
        await driver.raw(task, "Input.dispatchMouseEvent", { ...point, type: "mouseReleased", button: "left", clickCount: 1 });
      }
    } finally { await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {}); }
  }
  async reobserve(task: BrowserTask): Promise<NativeObservation> {
    const state = await this.discover(task);
    let prior = task.observation as NativeObservation | undefined;
    const binding = prior?.fast?.native, frame = binding && state.frames.get(binding.frameId);
    if (!binding || !frame || binding.generation !== state.generation || binding.url !== frame.url || binding.loaderId !== frame.loaderId || binding.session !== frame.session) prior = undefined;
    const selection = state.selection;
    const range = prior?.fast?.slice || selection?.slice;
    return this.observe(task, { frameId: prior?.fast?.native?.frameId || selection?.frameId }, prior?.fast?.native ? { ...range, refs: Object.values(prior.fast.native.refs) } : range, true);
  }
  async observe(task: BrowserTask, options: PageReadOptions = {}, range?: PageSlice, fallbackToRoot = false): Promise<NativeObservation> {
    const state = await this.discover(task);
    let frameId = options.frameId, cursor = options.cursor;
    if (cursor) {
      let decoded: any;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("无效的 frame 分页游标。"); }
      if (decoded.generation !== state.generation || typeof decoded.frameId !== "string" || (frameId && frameId !== decoded.frameId)) throw new Error("frame 分页游标已失效，请重新观察。");
      frameId = decoded.frameId; cursor = decoded.cursor;
    }
    const frame = (frameId ? state.frames.get(frameId) : undefined) || ((!frameId || fallbackToRoot) ? [...state.frames.values()].find(f => !f.parentId) : undefined);
    if (!frame) throw new Error("frame 已移除或无法访问，请重新读取 frame 列表。");
    const observation: NativeObservation = await this.scoped(task, frame).observe(task, { ...options, cursor }, frameId && frame.id !== frameId ? undefined : range);
    const refs: Record<string, string> = {};
    for (const candidate of observation.fast!.candidates) {
      const local = candidate.ref, key = `${frame.id}\0${observation.fast!.document}\0${local}`;
      let global = state.refs.get(key);
      if (!global) { global = `e${state.nextRef++}`; state.refs.set(key, global); }
      refs[global] = local; candidate.ref = global;
    }
    // Replace only the ref annotations, never arbitrary text containing eN.
    const reverse = new Map(Object.entries(refs).map(([global, local]) => [local, global]));
    observation.snapshot = observation.snapshot.replace(/\[ref=(e\d+)\]/g, (all, local) => `[ref=${reverse.get(local) || local}]`);
    const localGuard = observation.fast!.guard;
    const guard = JSON.parse(localGuard);
    guard[2] = guard[2].map((candidate: { ref: string }) => ({ ...candidate, ref: reverse.get(candidate.ref) || candidate.ref }));
    guard[5] = { ...guard[5], focusedRef: reverse.get(guard[5]?.focusedRef), frame: { id: frame.id, session: frame.session, generation: state.generation, loaderId: frame.loaderId } };
    observation.fast!.guard = JSON.stringify(guard);
    observation.fast!.native = { frameId: frame.id, context: frame.context!, session: frame.session, generation: state.generation, refs, localGuard, url: frame.url, loaderId: frame.loaderId };
    state.selection = { frameId: frame.id, url: frame.url, loaderId: frame.loaderId, slice: observation.fast!.slice };
    observation.frames = [...state.frames.values()].map(({ id, parentId, name, url, oopif }) => ({ id, parentId, name, url, oopif }));
    observation.page!.frameId = frame.id;
    if (observation.page!.nextCursor) observation.page!.nextCursor = Buffer.from(JSON.stringify({ generation: state.generation, frameId: frame.id, cursor: observation.page!.nextCursor })).toString("base64url");
    observation.fingerprint = createHash("sha256").update(`${state.generation}:${frame.id}:${observation.fast!.guard}`).digest("hex");
    observation.snapshot += `\n当前 frame=${frame.id}；共 ${state.frames.size} 个 frame，可用 read_page(frameId) 读取子页面。`;
    return observation;
  }
  private binding(task: BrowserTask): { frame: Frame; observation: NativeObservation; binding: Binding } {
    const observation = task.observation as NativeObservation | undefined, binding = observation?.fast?.native;
    const state = this.state(task), frame = binding && state.frames.get(binding.frameId);
    if (!observation || !binding || !frame || binding.generation !== state.generation || binding.session !== frame.session || binding.url !== frame.url || binding.loaderId !== frame.loaderId) throw new Error("页面引用已失效，请重新观察。");
    return { frame: { ...frame, context: binding.context }, observation, binding };
  }
  async assertFresh(task: BrowserTask, action?: BrowserAction): Promise<void> {
    await this.discover(task);
    const { frame, observation, binding } = this.binding(task);
    const fresh = await this.scoped(task, frame).observe(task, {}, { ...observation.fast?.slice, refs: Object.values(binding.refs) });
    const localAction = action && { ...action, ref: action.ref ? binding.refs[action.ref.replace(/^@/, "")] : undefined };
    const target = localAction && readLinkGuard(binding.localGuard, localAction);
    if (fresh.fast?.guard !== binding.localGuard && (!target || target !== readLinkGuard(fresh.fast!.guard, localAction!))) throw new Error("页面已变化，动作未执行，请重新观察。");
  }
  async execute(task: BrowserTask, action: BrowserAction): Promise<string> {
    await this.discover(task);
    const { frame, observation, binding } = this.binding(task);
    const ref = action.ref?.replace(/^@/, ""), local = ref && binding.refs[ref];
    if (ref && !local) throw new Error("引用不属于本次观察，请重新观察。");
    const pointer = action.kind === "click" || action.kind === "hover";
    if (pointer) await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      await this.scrollAncestors(task, frame);
      const localObservation = { ...observation, fast: { ...observation.fast!, guard: binding.localGuard, candidates: observation.fast!.candidates.map(c => ({ ...c, ref: binding.refs[c.ref] })) } };
      const result = await this.scoped(task, frame).execute({ ...task, observation: localObservation }, { ...action, ref: local }, pointer ? async () => {
        // Scroll both ancestor frames and the target before waiting for paint.
        // Validate frame ownership and the target again before dispatching once.
        await this.synchronizePaint(task, frame);
        await this.discover(task);
        this.binding(task);
      } : undefined);
      if (action.kind === "scroll") {
        try { await this.synchronizePaint(task, frame); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw Object.assign(new Error(`滚动已执行，但绘制尚未确认：${detail} 请先核查控制状态并读取结果，勿直接重放滚动。`), { code: (error as { code?: string })?.code });
        }
      }
      return result;
    } finally { if (pointer) await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {}); }
  }
  async press(task: BrowserTask, action: BrowserAction, params: Record<string, unknown>): Promise<void> {
    await this.assertFresh(task, action);
    const { frame, binding } = this.binding(task);
    if (action.ref && !binding.refs[action.ref.replace(/^@/, "")]) throw new Error("引用不属于本次观察，请重新观察。");
    if (action.ref) {
      const focus = JSON.parse(binding.localGuard)[5]?.focusedRef;
      if (binding.refs[action.ref.replace(/^@/, "")] !== focus) throw new Error("键盘焦点不在目标元素，动作未执行，请重新观察。");
    }
    // Background Chrome can acknowledge key input without delivering it while
    // the page lacks emulated focus. This changes renderer focus, not the
    // selected tab or OS window. Keep the scope independent of pointer input;
    // extension takeover cleanup also resets this root-session setting.
    let failed = false;
    try {
      await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: true });
      // Focus handlers may change the form. Revalidate before sending input,
      // without moving focus to a model-supplied ref or retrying a key event.
      await this.assertFresh(task, action);
      // Keyboard input follows the observed frame/session, including an OOPIF.
      const driver = this.scoped(task, frame);
      await driver.raw(task, "Input.dispatchKeyEvent", { ...params, type: "keyDown" });
      const { text: _text, ...release } = params;
      await driver.raw(task, "Input.dispatchKeyEvent", { ...release, type: "keyUp" });
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.cdp(task, "Emulation.setFocusEmulationEnabled", { enabled: false }); }
      catch (error) { if (!failed) throw error; }
    }
  }
  async node(task: BrowserTask, ref: string, fn: string, returnByValue = true): Promise<{ result: any; frame: Frame }> {
    await this.assertFresh(task);
    const { frame, binding } = this.binding(task), local = binding.refs[ref.replace(/^@/, "")];
    if (!local) throw new Error("元素引用已失效。");
    const response = await this.cdp(task, "Runtime.evaluate", { expression: `(${fn})(window.__profilepilot_jev_dom_v1?.nodes.get(${JSON.stringify(local)}))`, contextId: frame.context, returnByValue }, frame.session);
    if (response.exceptionDetails) throw new Error("元素读取失败，请重新观察。");
    return { result: returnByValue ? response.result?.value : response.result, frame };
  }
  private async owner(task: BrowserTask, frame: Frame): Promise<{ parent: Frame; objectId: string }> {
    const parent = this.state(task).frames.get(frame.parentId || "");
    if (!parent) throw new Error("父 frame 已失效，请重新观察。");
    const owner = await this.cdp(task, "DOM.getFrameOwner", { frameId: frame.id }, parent.session);
    const resolved = await this.cdp(task, "DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: await this.context(task, parent) }, parent.session);
    if (!resolved.object?.objectId) throw new Error("iframe 元素已失效。");
    return { parent, objectId: resolved.object.objectId };
  }
  private async scrollAncestors(task: BrowserTask, frame: Frame): Promise<void> {
    if (!frame.parentId) return;
    const { parent, objectId } = await this.owner(task, frame);
    try {
      await this.scrollAncestors(task, parent);
      await this.cdp(task, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});}" }, parent.session);
    } finally { await this.cdp(task, "Runtime.releaseObject", { objectId }, parent.session).catch(() => {}); }
  }
  private async topPoint(task: BrowserTask, frame: Frame, x: number, y: number, sessionOnly = false): Promise<{ x: number; y: number }> {
    if (!frame.parentId) return { x, y };
    if (sessionOnly && this.state(task).frames.get(frame.parentId)?.session !== frame.session) return { x, y };
    const { parent, objectId } = await this.owner(task, frame);
    try {
      const response = await this.cdp(task, "Runtime.callFunctionOn", { objectId, returnByValue: true,
        arguments: [{ value: x }, { value: y }], functionDeclaration: `function(x,y){
          const r=this.getBoundingClientRect(), s=getComputedStyle(this);
          // A transformed iframe needs a projective transform. Refuse rather
          // than dispatch an input to a guessed point on another element.
          for(let n=this;n;n=n.parentElement) if(getComputedStyle(n).transform!=='none') throw Error('transformed iframe requires screenshot/pointer');
          const px=r.left+this.clientLeft+x, py=r.top+this.clientTop+y;
          let hit=this.ownerDocument.elementFromPoint(px,py);
          while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(px,py);if(!inner||inner===hit)break;hit=inner;}
          if(hit!==this)throw Error('iframe covered or outside viewport');
          return {x:px,y:py};
        }` }, parent.session);
      if (response.exceptionDetails || !response.result?.value) throw new Error("iframe 被遮挡、超出视口或存在变换；请观察截图后使用指针坐标。");
      const point = response.result.value;
      return this.topPoint(task, parent, point.x, point.y, sessionOnly);
    } finally { await this.cdp(task, "Runtime.releaseObject", { objectId }, parent.session).catch(() => {}); }
  }
  frameId(task: BrowserTask): string { return this.binding(task).binding.frameId; }
  resetSelection(task: BrowserTask): void { this.state(task).selection = undefined; }
  forget(task: BrowserTask): void { this.states.delete(this.key(task)); }
}
