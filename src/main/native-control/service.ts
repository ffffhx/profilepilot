import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserObservation, BrowserTask } from "../../shared/tasks";
import type { NativeBrowserBridge, NativeEvent } from "../tasks/native-bridge";
import { NativeBrowser } from "../tasks/native-browser";
import type { DomCandidate } from "../tasks/fast-browser";
import { NativeControlError, nativeControlError } from "./errors";
import { controlRecovery } from "../../shared/control-recovery";
import { parseCommonBrowserAction } from "../../shared/browser-contract";
import { writeControlTrace } from "../control-trace";
import { isNativeControlMethod } from "./protocol";
import { nativeExtensionReady, NATIVE_EXTENSION_UPDATE_MESSAGE } from "../tasks/native-compatibility";
import { NativeExtensionUi } from './extension-ui';
import { listSiteAdapters } from '../site-adapters/catalog';
import { BrowserDebugSession, type DebugEvent } from '../browser-debug/session';

interface Session {
  debug?: BrowserDebugSession;
  debugTab?: number;
  debugEpoch?: number;
  debugFrames?: Map<string,DebugEvent>;
  frameTab?: number;
  task: BrowserTask;
  queue: Promise<unknown>;
  epoch: number;
  ending: boolean;
  control: { connected: boolean; owned: boolean; agent: boolean; paused: boolean; generation?: string };
  termination?: Promise<unknown>;
  controller: string;
  source?: string;
  startedAt: string;
  lastActivityAt: string;
  pendingRequests: number;
  lastMethod?: string;
  lastRequestId?: string;
}
interface Receipt { signature: string; result: Promise<unknown>; }
const ACTION_RECEIPT_LIMIT = 10000;
const STATUS_RECEIPT_LIMIT = 256;

/** Keep the complete observation server-side for freshness and effect checks.
 * External callers need refs and values, not duplicated DOM guard internals. */
export function publicNativeObservation(observation: BrowserObservation): unknown {
  const { fast, ...result } = observation;
  if (!fast) return result;
  return { ...result, fast: { candidates: fast.candidates.map(candidate => {
    const { ref, role, label, kind, value, checked, multiple, selectedValues, inputType, options, submit, href, offscreen } = candidate;
    const dom = (candidate as DomCandidate).dom;
    const semantics = dom ? { effect: dom.effect, enterEffect: dom.enterEffect, search: dom.search, popup: dom.popup,
      toggle: dom.toggle, download: dom.download, command: dom.command } : undefined;
    return { ref, role, label, kind, value, checked, multiple, selectedValues: selectedValues?.slice(), inputType, options: options?.map(option => ({ ...option })), submit, href, offscreen, semantics };
  }) } };
}
export class NativeControlService {
  private readonly browser: NativeBrowser;
  private readonly extensionUi: NativeExtensionUi;
  private readonly sessions = new Map<string, Session>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly statusReceipts = new Map<string, Receipt>();
  private readonly events: Array<NativeEvent & { cursor: number; at: string }> = [];
  private cursor = 0;
  private eventBytes = 0;
  private readonly eventSizes: number[] = [];
  private readonly unsubscribe: () => void;
  constructor(private readonly bridge: NativeBrowserBridge, private readonly root: string) {
    this.browser = new NativeBrowser(bridge, path.join(root, "native-control-artifacts"));
    this.extensionUi = new NativeExtensionUi(bridge);
    this.unsubscribe = bridge.onEvent(event => {
      const entry = { ...event, cursor: ++this.cursor, at: new Date().toISOString() };
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      this.events.push(entry); this.eventSizes.push(bytes); this.eventBytes += bytes;
      while (this.events.length > 1000 || this.eventBytes > 8 * 1024 * 1024) { this.events.shift(); this.eventBytes -= this.eventSizes.shift()!; }
      if (event.type === "disconnected" || event.type === "state") {
        for (const session of this.sessions.values()) if (session.task.profileId === event.profileId) this.updateControlState(session, event.type === "state" ? event.state : undefined);
      }
      if (event.type === 'cdp' && event.method && event.sessionId) {
        const session = this.sessions.get(event.sessionId);
        if (session?.task.profileId === event.profileId && session.frameTab===event.tabId) {
          const frameEvent={method:event.method,params:event.params,sessionId:event.cdpSessionId};
          if(event.method==='Target.attachedToTarget' && event.params?.targetInfo?.type==='iframe'){
            session.debugFrames??=new Map();session.debugFrames.set(event.params.sessionId,frameEvent);
          }
          if(event.method==='Target.detachedFromTarget'){
            const removed=new Set<string>([event.params?.sessionId]);
            for(const [id,frame] of session.debugFrames||[])if(frame.sessionId&&removed.has(frame.sessionId))removed.add(id);
            for(const id of removed)session.debugFrames?.delete(id);
          }
          if(event.tabId === session.debugTab)session.debug?.event(frameEvent);
        }
      }
    });
  }
  close(): void { for(const session of this.sessions.values())session.debug?.suspend('service-closed'); this.unsubscribe(); this.extensionUi.close(); this.browser.dispose?.(); }
  hasSessions(): boolean { return this.sessions.size > 0; }
  ownsSession(profileId: string, sessionId: string): boolean { return this.sessions.get(sessionId)?.task.profileId === profileId; }
  private updateControlState(session: Session, state: NativeEvent["state"]): void {
    if(session.frameTab!==state?.tabId)session.debugFrames?.clear();session.frameTab=state?.tabId;
    const next = { connected: state?.connected === true, owned: state?.ownerSessionId === session.task.sessionId,
      agent: state?.ownership === "agent", paused: state?.pausedByBrowser === true, generation: state?.controlGeneration };
    const previous = session.control;
    // A real loss of connection/control invalidates work still in our queue.
    // Repeated user-state publications must not cancel a later explicit resume.
    if ((previous.connected && !next.connected) || (previous.owned && !next.owned) ||
        (previous.agent && !next.agent) || (!previous.paused && next.paused) ||
        (previous.generation !== undefined && previous.generation !== next.generation)) session.epoch++;
    session.control = next;
    if (session.debug && (session.debugEpoch !== session.epoch || session.debugTab !== state?.tabId || !next.connected || !next.owned || !next.agent || next.paused)) {session.debug.suspend('control-or-tab-changed');session.debugFrames?.clear();}
    if(!next.connected||!next.owned||!next.agent||next.paused)session.debugFrames?.clear();
    if (previous.generation !== undefined && previous.generation !== next.generation) this.extensionUi.cancel(session.task.sessionId);
    if (!next.connected || !next.owned || !next.agent || next.paused) {
      session.task.observation = undefined; this.extensionUi.cancel(session.task.sessionId);
    }
  }
  request(command: any): Promise<unknown> {
    if (!command || typeof command !== "object" || !isNativeControlMethod(command.method)) return Promise.reject(new NativeControlError("NATIVE_INVALID_REQUEST", "需要有效的浏览器操作 method。"));
    if (command.params !== undefined && (!command.params || typeof command.params !== "object" || Array.isArray(command.params))) return Promise.reject(new NativeControlError("NATIVE_INVALID_REQUEST", "params 必须是 JSON 对象。"));
    if (command.method === "claim" && command.params?.newTab !== undefined && typeof command.params.newTab !== "boolean") return Promise.reject(new NativeControlError("NATIVE_INVALID_REQUEST", "claim 的 newTab 必须是 JSON 布尔值。"));
    if (typeof command.requestId !== "string" || !/^[\w.-]{1,128}$/.test(command.requestId)) return Promise.reject(new NativeControlError("NATIVE_INVALID_REQUEST", "需要唯一 requestId。"));
    const signature = JSON.stringify(command);
    const previous = this.receipts.get(command.requestId) || this.statusReceipts.get(command.requestId);
    if (previous) return previous.signature === signature ? previous.result : Promise.reject(new Error("requestId 已被另一个请求使用。"));
    // Status polling must not exhaust the permanent at-most-once action ledger.
    // Only these side-effect-free snapshots may expire; action receipts never do.
    if (command.method === "status") {
      const result = this.tracked(command);
      this.statusReceipts.set(command.requestId, { signature, result });
      if (this.statusReceipts.size > STATUS_RECEIPT_LIMIT) this.statusReceipts.delete(this.statusReceipts.keys().next().value!);
      return result;
    }
    const recovery = command.method === "control" && ["handoff", "complete", "release"].includes(command.params?.action);
    // Existing sessions must remain stoppable at the soft limit. Keep their
    // recovery receipts too, so replay cannot stop a later same-name session.
    if (this.receipts.size >= ACTION_RECEIPT_LIMIT && !recovery) return Promise.reject(new NativeControlError("NATIVE_REQUEST_CAPACITY", "本次应用运行的动作请求记录已满；仍可 status、handoff、complete 或 release，结束会话后请重启应用。"));
    // An absent session cannot perform a control side effect. Report that actual
    // state without adding unlimited rejected recovery IDs beyond the limit.
    if (this.receipts.size >= ACTION_RECEIPT_LIMIT && recovery && !this.sessions.has(command.sessionId)) return this.tracked(command);
    const result = this.tracked(command);
    this.receipts.set(command.requestId, { signature, result });
    return result;
  }
  private async tracked(command: any): Promise<unknown> {
    const startedAt = Date.now();
    let failureCode: string | undefined, recovery;
    const session = this.sessions.get(command.sessionId);
    if (session && command.method !== "status") {
      session.pendingRequests++; session.lastActivityAt = new Date().toISOString();
      session.lastMethod = command.method; session.lastRequestId = command.requestId;
    }
    try { return await this.execute(command); }
    catch (error) {
      const failure = nativeControlError(error);
      failureCode = failure.code;
      const readOnly = ["status", "observe", "read", "screenshot", "tabs", "history", "events"].includes(command.method);
      const result = new NativeControlError(failure.code, failure.message,
        readOnly ? controlRecovery(failure.code, { stage: failure.recovery.stage, actionOutcome: "not-applicable" }) : failure.recovery);
      result.requestId = command.requestId; result.sessionId = command.sessionId;
      recovery = result.recovery;
      throw result;
    } finally {
      if (command.method !== "status" || failureCode) writeControlTrace(this.root, "extension", {
        requestId: command.requestId, sessionId: command.sessionId, target: session?.task.profileId || command.profileId,
        method: command.method, durationMs: Date.now() - startedAt, generation: session?.epoch, code: failureCode, recovery,
        extensionVersion: this.bridge.states().find(s => s.profileId === (session?.task.profileId || command.profileId))?.extensionVersion
      });
      if (session && command.method !== "status") { session.pendingRequests--; session.lastActivityAt = new Date().toISOString(); }
    }
  }
  private sessionSnapshot(id: string, session: Session) {
    const state = this.bridge.states().find(s => s.profileId === session.task.profileId);
    const pauseReason = !state?.connected ? "disconnected" : state.ownerSessionId !== id ? "owner-changed" :
      state.controlIssue?.code || (state.ownership === "user" || state.pausedByBrowser ? "user-control" : undefined);
    return { sessionId: id, profileId: session.task.profileId, title: session.task.title, controller: session.controller,
      source: session.source, startedAt: session.startedAt, lastActivityAt: session.lastActivityAt,
      idleMs: Math.max(0, Date.now() - Date.parse(session.lastActivityAt)), pendingRequests: session.pendingRequests,
      generation: session.epoch, ownership: state?.ownership, pauseReason,
      lastMethod: session.lastMethod, lastRequestId: session.lastRequestId,
      extensionUi: this.extensionUi.status(id),
      ...(session.ending ? { ending: true } : {}),
      nextStep: session.ending ? "release" : pauseReason ? "inspect-state" : "continue-owned-session" };
  }
  private profile(selector?: string): string {
    const states = this.bridge.states();
    if (selector) {
      const state = states.find(s => s.profileId === selector);
      if (!state?.connected) throw new Error("指定 Profile 的扩展未连接。");
      return selector;
    }
    const connected = states.filter(s => s.connected);
    if (connected.length !== 1) throw new Error("请先 status，并用 --profile 指定一个已连接 Profile。");
    return connected[0].profileId;
  }
  private async execute(command: any): Promise<unknown> {
    const { method, params = {} } = command;
    if (method === "sites") return listSiteAdapters(params.site);
    if (method === "status") return { protocolVersion: 1, profiles: this.bridge.states(), sessions: [...this.sessions].map(([id, s]) => this.sessionSnapshot(id, s)), cursor: this.cursor };
    if (method === "claim") {
      const profileId = this.profile(command.profileId), sessionId = command.sessionId || `direct-${randomUUID()}`;
      if (typeof sessionId !== "string" || !/^[\w.-]{1,160}$/.test(sessionId)) throw new Error("会话名称无效。");
      if (sessionId.startsWith("pp-task-")) throw new NativeControlError("NATIVE_INVALID_REQUEST", "pp-task- 是内置任务专用前缀，请为直接会话选择其他名称。");
      if (!nativeExtensionReady(this.bridge.states().find(state => state.profileId === profileId)!)) {
        throw new NativeControlError("NATIVE_EXTENSION_UPDATE_REQUIRED", NATIVE_EXTENSION_UPDATE_MESSAGE);
      }
      const previous = this.sessions.get(sessionId);
      if (previous) throw new Error("此直接会话已经存在，请继续使用或显式结束。");
      for (const key of ["controller", "task", "source"]) if (params[key] !== undefined && (typeof params[key] !== "string" || params[key].length > 256)) {
        throw new NativeControlError("NATIVE_INVALID_REQUEST", `claim 的 ${key} 必须是不超过 256 字的字符串。`);
      }
      const owner = this.bridge.states().find(s => s.profileId === profileId)?.ownerSessionId;
      if (owner && owner !== sessionId) {
        const title = this.sessions.get(owner)?.task.title;
        throw new NativeControlError("NATIVE_SESSION_CONFLICT", `此 Profile 已由任务 ${title || owner}（${owner}）占用。请查看 status 并等待原任务释放。`);
      }
      const task = { id: randomUUID(), sessionId, title: params.task?.trim() || sessionId, profileId, browserConnection: "extension", status: "running", attachments: [], outputs: [] } as unknown as BrowserTask;
      // Reserve synchronously before any I/O; two claims cannot overwrite the
      // same session or bind it to two Profiles.
      const session: Session = { task, queue: Promise.resolve(), epoch: 0, ending: false,
        controller: params.controller?.trim() || "CLI", source: params.source?.trim() || undefined,
        startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), pendingRequests: 0,
        lastMethod: "claim", lastRequestId: command.requestId,
        control: { connected: false, owned: false, agent: false, paused: false } };
      this.updateControlState(session, this.bridge.states().find(s => s.profileId === profileId));
      this.sessions.set(sessionId, session);
      try {
        await this.bridge.request(profileId, "claim", { sessionId, taskTitle: task.title, tabId: params.tabId, newTab: params.newTab === true });
        if (this.sessions.get(sessionId) !== session || session.ending) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "此直接会话已结束或正在结束，请检查 status。");
        this.updateControlState(session, this.bridge.states().find(s => s.profileId === profileId));
        return { sessionId, profileId, state: this.bridge.states().find(s => s.profileId === profileId) };
      } catch (error) {
        // Failed attach can still reserve the extension owner. Keep its local
        // identity so the caller can release/resume it explicitly.
        if (this.sessions.get(sessionId) === session && !session.ending && this.bridge.states().find(s => s.profileId === profileId)?.ownerSessionId !== sessionId) this.sessions.delete(sessionId);
        throw error;
      }
    }
    if (["tabs", "history", "extension.reload"].includes(method) && !command.sessionId) return this.bridge.request(this.profile(command.profileId), method, params);
    const session = this.sessions.get(command.sessionId);
    if (!session) throw new Error("直接会话不存在或浏览器服务已重启，请重新 claim；不会重放旧动作。");
    const task = session.task;
    if (command.profileId && command.profileId !== task.profileId) throw new Error("会话 Profile 不匹配。");
    if (method === 'extension-ui' && params.action === 'status') return this.extensionUi.status(task.sessionId);
    if (method === "control") {
      if (!["handoff", "resume", "complete", "release"].includes(params.action)) throw new NativeControlError("NATIVE_INVALID_REQUEST", "无效的控制动作。");
      if (["complete", "release"].includes(params.action)) {
        if (session.termination) return session.termination;
        // Invalidate queued resume/actions before awaiting the extension. Keep
        // the reservation until termination succeeds, and allow explicit retry
        // after failure without ever reopening this generation for new work.
        session.ending = true; session.epoch++; task.observation = undefined; session.debug?.suspend('session-ended');
        this.extensionUi.cancel(task.sessionId);
        const result = (async () => {
          if (!this.bridge.states().find(s => s.profileId === task.profileId)?.connected) throw new NativeControlError("NATIVE_DISCONNECTED", "扩展断线，尚未确认会话结束；已保留会话身份。重连后请显式 complete 或 release，不会自动恢复或重放。");
          await this.browser.control(task, params.action);
          if (this.sessions.get(task.sessionId) === session) this.sessions.delete(task.sessionId);
          return { state: this.bridge.states().find(s => s.profileId === task.profileId) };
        })();
        session.termination = result;
        try { return await result; }
        finally { if (session.termination === result) session.termination = undefined; }
      }
      if (params.action === "handoff") { session.epoch++; session.control.agent = false; session.debug?.suspend('user-control'); this.extensionUi.cancel(task.sessionId); }
    }
    // Bind permission before joining the service queue. The extension also
    // checks this original token, including if its newer state arrives late.
    const resumeGeneration = method === "control" && params.action === "resume" && !session.ending ? this.browser.controlGeneration(task) : undefined;
    const epoch = session.epoch;
    const invoke = async (): Promise<unknown> => {
      if (this.sessions.get(task.sessionId) !== session || session.ending) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "此直接会话已结束或正在结束，排队操作已取消；请检查 status。");
      if (session.epoch !== epoch) {
        const state = this.bridge.states().find(s => s.profileId === task.profileId);
        const code = !state?.connected ? "NATIVE_DISCONNECTED" : state.controlIssue?.code || "NATIVE_USER_IN_CONTROL";
        throw new NativeControlError(code, state?.controlIssue?.message || "控制状态已改变，排队操作未执行；请检查 status。",
          controlRecovery(code, { stage: "ownership", actionOutcome: "not-executed" }));
      }
      if (method === "control") {
        task.observation = undefined;
        await this.browser.control(task, params.action, resumeGeneration);
        this.updateControlState(session, this.bridge.states().find(s => s.profileId === task.profileId));
        return { state: this.bridge.states().find(s => s.profileId === task.profileId) };
      }
      const state = this.bridge.states().find(s => s.profileId === task.profileId);
      if (!state?.connected) throw new NativeControlError("NATIVE_DISCONNECTED", "扩展断线；请检查 status，不会自动恢复或重放。");
      if (state.ownerSessionId !== task.sessionId) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "浏览器会话已停止或所有者已改变，请检查 status。");
      if (state.ownership !== "agent" || state.pausedByBrowser) {
        if (state.controlIssue) throw new NativeControlError(state.controlIssue.code, state.controlIssue.message);
        throw new NativeControlError("NATIVE_USER_IN_CONTROL", "用户已接管或浏览器已停止，请显式交还后重新观察。");
      }
      if (method === 'extension-ui') {
        task.observation = undefined;
        if (params.action === 'connect') return this.extensionUi.start(task.profileId, task.sessionId, params.extensionId);
        if (params.action === 'observe') return this.extensionUi.observe(task.sessionId);
        if (params.action === 'click') return this.extensionUi.click(task.sessionId, params);
        if (params.action === 'disconnect') return this.extensionUi.disconnect(task.sessionId);
        throw new NativeControlError('NATIVE_INVALID_REQUEST', 'extension-ui 支持 connect/status/observe/click/disconnect。');
      }
      if (this.extensionUi.has(task.sessionId) && !['tabs', 'events'].includes(method)) throw new NativeControlError('NATIVE_EXTENSION_UI_ACTIVE', '请先 extension-ui disconnect，再操作普通网页。');
      if (method === "events") {
        const since = Number(params.since || 0), limit = Math.min(1000, Math.max(1, Number(params.limit) || 100));
        const selected = this.events.filter(e => e.profileId === task.profileId && (!e.sessionId || e.sessionId === task.sessionId) && e.cursor > since);
        const events = selected.slice(0, limit);
        return { events, cursor: events.at(-1)?.cursor ?? this.cursor, hasMore: selected.length > events.length, dropped: since < (this.events[0]?.cursor || this.cursor + 1) - 1 };
      }
      if (method === "observe" || method === "read") {
        const observation = method === "read" ? await this.browser.readPage(task, params) : await this.browser.observe(task, params.screenshot === true, false);
        task.observation = observation;
        return publicNativeObservation(observation);
      }
      if (method === "site") return this.browser.siteAdapter(task, params, () => {
        if (session.ending || session.epoch !== epoch || this.sessions.get(task.sessionId) !== session) throw new NativeControlError("NATIVE_USER_IN_CONTROL", "会话已改变，网站适配读取停止。");
      });
      if (method === "action" || method === "pointer") {
        if (!task.observation || params.version !== task.observation.version) throw new NativeControlError("NATIVE_OBSERVATION_STALE", "动作必须携带最近 observe/read 的 version；动作、交还后请重新观察。");
        const observation = task.observation;
        try {
          if (method === "pointer") {
            const pointer = (this.browser as any).pointer;
            if (!pointer) throw new Error("当前执行器尚不支持坐标操作。");
            return await pointer.call(this.browser, task, params);
          }
          if (params.kind === "upload" && params.files !== undefined) {
            const action = parseCommonBrowserAction(params);
            return await this.browser.uploadFiles(task, action.ref!, action.files!);
          }
          return await this.browser.execute(task, { effect: "edit", summary: "外部 Agent 直接操作", ...params, version: observation.version });
        } finally { task.observation = undefined; }
      }
      if (method === "screenshot") return this.browser.screenshot(task, params);
      if (['debug','network','console','errors','trace','profiler'].includes(method)) {
        if(!state.capabilities?.includes('debugCapture'))throw new NativeControlError('NATIVE_EXTENSION_UPDATE_REQUIRED','Network 调试需要扩展 0.2.14+；请更新/重新加载 ProfilePilot 扩展后再试。');
        if (!session.debug) {
          const check = () => {
            const now = this.bridge.states().find(s=>s.profileId===task.profileId);
            if (session.ending || this.sessions.get(task.sessionId)!==session || session.debugEpoch!==session.epoch || !now?.connected || now.ownerSessionId!==task.sessionId || now.ownership!=='agent' || now.pausedByBrowser || now.tabId!==session.debugTab)
              throw new NativeControlError('NATIVE_USER_IN_CONTROL','调试采集已停止；请检查控制状态。');
          };
          session.debug = new BrowserDebugSession({check,send:(cdpMethod,cdpParams,cdpSessionId)=>{
            check(); return this.bridge.request(task.profileId,'cdp',{sessionId:task.sessionId,method:cdpMethod,params:cdpParams,cdpSessionId,debugCapture:true});
          }},path.join(this.root,'native-control-artifacts',task.sessionId));
        }
        session.debugEpoch=epoch;session.debugTab=state.tabId;
        session.debug.bindTarget(String(state.tabId));
        session.debug.setFrameSessions([...(session.debugFrames?.values()||[])]);
        return session.debug.command(method,params);
      }
      if (method === "download") {
        const download = (this.browser as any).download;
        if (!download) throw new Error("当前执行器尚不支持下载。");
        return download.call(this.browser, task, params);
      }
      if (["open", "newTab", "switch"].includes(method)) {
        if (method === "open" || (method === "newTab" && params.url !== undefined)) {
          let url: URL;
          try { url = new URL(params.url); } catch { throw new NativeControlError("NATIVE_INVALID_REQUEST", "open 需要有效的 HTTP/HTTPS 网址。"); }
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new NativeControlError("NATIVE_INVALID_REQUEST", "只支持不含凭据的 HTTP/HTTPS 页面。");
        }
        if (method === "switch" && (!Number.isSafeInteger(params.tabId) || params.tabId <= 0)) throw new NativeControlError("NATIVE_INVALID_REQUEST", "switch 需要有效的标签页编号。");
        try {
          const result = await this.bridge.request(task.profileId, method, { ...params, sessionId: task.sessionId });
          if (result?.errorText) throw new NativeControlError("NATIVE_BROWSER_ERROR", `导航失败：${result.errorText}`);
          return result;
        } finally {
          // Even a failed navigation may commit Chrome's error document.
          this.browser.resetObservation(task);
        }
      }
      if (["tabs", "history", "cdp", "downloads.start", "downloads.search", "downloads.wait", "downloads.cancel", "downloads.disarm"].includes(method)) {
        if (!["tabs", "history", "downloads.search", "downloads.wait"].includes(method)) task.observation = undefined;
        return this.bridge.request(task.profileId, method, { ...params, sessionId: task.sessionId }, method === "downloads.wait" ? Math.min(305000, (Number(params.timeoutMs) || 30000) + 3000) : 15000);
      }
      throw new NativeControlError("NATIVE_INVALID_REQUEST", `未知直接操作：${method}`);
    };
    // Stop/control must invalidate extension ownership immediately rather than
    // queue behind a long read/download. Ordinary actions remain serialized.
    if ((method === "control" && params.action !== "resume") || ["downloads.wait", "downloads.cancel", "downloads.search"].includes(method) || (method === "download" && ["wait", "cancel", "search"].includes(params.operation))) return invoke();
    const result = session.queue.then(invoke);
    session.queue = result.catch(() => {}); return result;
  }
}
