import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CdpBrowserClient } from '../cdp-client';
import { nativeChromeUserDataDir } from '../chrome-launch';
import { parseNativeDebugEndpoint } from '../tasks/native-installer';
import type { NativeBrowserTransport } from '../tasks/native-bridge';
import { NativeControlError } from './errors';

type Client = Pick<CdpBrowserClient, 'send' | 'close' | 'onDisconnect'>;
type Frame = { id: string; url: string; loaderId: string };
type Tree = { frame: Frame; childFrames?: Tree[] };
type Binding = { targetId: string; tabId: number; url: string; generation: string };
type Ref = { session: string; context: number; key: string; index: number; label: string; frame: Frame };
interface Connection {
  profileId: string; sessionId: string; token: string; extensionId: string;
  abort: AbortController; stage: 'authorizing' | 'ready' | 'failed'; error?: string;
  client?: Client; binding?: Binding; pageSession?: string;
  timer?: NodeJS.Timeout; checking?: boolean; refs: Map<string, Ref>;
  version?: string; rootFrame?: Frame; children: Map<string, string>;
}
function failure(code: string, message: string): never { throw new NativeControlError(code, message); }
const flatten = (tree: Tree): Frame[] => [tree.frame, ...(tree.childFrames || []).flatMap(flatten)];
const sameFrame = (a: Frame, b: Frame) => a.id === b.id && a.loaderId === b.loaderId && a.url === b.url;

/** Narrow browser-level CDP companion. No arbitrary JS, passwords, extension
 * workers, other tabs, or desktop input are exposed by this API. */
export class NativeExtensionUi {
  private connections = new Map<string, Connection>();
  constructor(private readonly bridge: NativeBrowserTransport, private readonly options: {
    endpoint?: () => Promise<string>;
    connect?: typeof CdpBrowserClient.connect;
  } = {}) {}
  has(sessionId: string): boolean { return this.connections.has(sessionId); }
  status(sessionId: string) {
    const c = this.connections.get(sessionId);
    return c ? { stage: c.stage, extensionId: c.extensionId, error: c.error,
      requiresUser: c.stage === 'authorizing', automaticReplay: false,
      nextStep: c.stage === 'authorizing' ? '请在 Chrome 的远程调试连接请求中点击允许，再查询 extension-ui status。' : c.stage === 'ready' ? 'extension-ui observe' : '先 extension-ui disconnect；确认原因后显式重新连接。' }
      : { stage: 'disconnected', automaticReplay: false };
  }
  cancel(sessionId: string): void {
    const c = this.connections.get(sessionId); if (!c) return;
    this.connections.delete(sessionId); this.shutdown(c);
  }
  close(): void { for (const id of this.connections.keys()) this.cancel(id); }
  private shutdown(c: Connection): void {
    clearInterval(c.timer); c.abort.abort(); c.refs.clear(); c.version = undefined;
    if (c.client) { c.client.onDisconnect = null; c.client.close(); c.client = undefined; }
  }
  private assertOwner(c: Connection): void {
    if (this.connections.get(c.sessionId) !== c || c.abort.signal.aborted) failure('NATIVE_USER_IN_CONTROL', '扩展界面会话已停止。');
    const state = this.bridge.states().find(s => s.profileId === c.profileId);
    if (!state?.connected) failure('NATIVE_DISCONNECTED', 'ProfilePilot 扩展已断开。');
    if (state.ownerSessionId !== c.sessionId) failure('NATIVE_SESSION_CONFLICT', '当前任务已失去此 Profile 的控制权。');
    if (state.ownership !== 'agent' || state.pausedByBrowser) failure('NATIVE_USER_IN_CONTROL', '用户已接管，扩展界面操作已停止。');
  }
  private async check(c: Connection): Promise<Binding> {
    this.assertOwner(c);
    const binding: Binding = await this.bridge.request(c.profileId, 'extensionUi.check', { sessionId: c.sessionId, token: c.token }, 5000);
    this.assertOwner(c);
    if (c.binding && (binding.targetId !== c.binding.targetId || binding.tabId !== c.binding.tabId || binding.generation !== c.binding.generation)) failure('NATIVE_OBSERVATION_STALE', '授权标签页已改变，请断开扩展界面模式并重新连接。');
    return binding;
  }
  async start(profileId: string, sessionId: string, extensionId: unknown) {
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId) || extensionId === 'gmdaabnoocjlpimglalnbegfdaklfnaj') failure('NATIVE_INVALID_REQUEST', 'connect 需要目标扩展的 extensionId（32 个 a–p 字母）。');
    if (this.has(sessionId)) failure('NATIVE_EXTENSION_UI_ACTIVE', '已有扩展界面连接，请先查询 status 或 disconnect。');
    if (!this.bridge.states().find(s => s.profileId === profileId)?.capabilities?.includes('extensionUi')) failure('NATIVE_EXTENSION_UPDATE_REQUIRED', '扩展界面功能需要 ProfilePilot 扩展 0.2.13 或更新版本。');
    const endpoint = await (this.options.endpoint || (async () => {
      try { return parseNativeDebugEndpoint(await readFile(path.join(nativeChromeUserDataDir(), 'DevToolsActivePort'), 'utf8')); }
      catch { return failure('NATIVE_EXTENSION_UI_NOT_READY', '请在当前 Chrome 的 chrome://inspect/#remote-debugging 开启远程调试后重试。'); }
    }))();
    const c: Connection = { profileId, sessionId, extensionId, token: randomBytes(32).toString('hex'), abort: new AbortController(), stage: 'authorizing', refs: new Map(), children: new Map() };
    this.connections.set(sessionId, c);
    try {
      this.assertOwner(c);
      await this.bridge.request(profileId, 'extensionUi.begin', { sessionId, token: c.token });
      this.assertOwner(c); c.binding = await this.check(c);
      c.timer = setInterval(() => {
        if (c.checking) return; c.checking = true;
        void this.check(c).catch(() => this.fail(c, '扩展界面许可失效；请检查控制状态，不会自动重新连接。')).finally(() => { c.checking = false; });
      }, 3000); c.timer.unref();
      // Keep the socket in the service across CLI invocations. Authorization
      // does not hold the session queue or delay handoff/status/cancellation.
      void this.connect(c, endpoint);
      return this.status(sessionId);
    } catch (error) {
      this.cancel(sessionId);
      await this.bridge.request(profileId, 'extensionUi.end', { sessionId, token: c.token }).catch(() => {});
      throw error;
    }
  }
  private fail(c: Connection, message: string): void {
    if (this.connections.get(c.sessionId) !== c) return;
    this.shutdown(c); c.stage = 'failed'; c.error = message;
    // Restore ordinary mode only while the extension still accepts this exact
    // lease. No resume, reattach, or input replay is performed here.
    void this.bridge.request(c.profileId, 'extensionUi.end', { sessionId: c.sessionId, token: c.token }).catch(() => {});
  }
  private async connect(c: Connection, endpoint: string): Promise<void> {
    let client: Client | undefined;
    try {
      client = await (this.options.connect || CdpBrowserClient.connect)(endpoint, 180000, c.abort.signal);
      this.assertOwner(c); c.client = client;
      client.onDisconnect = () => this.fail(c, 'Chrome 调试连接已断开；未自动重连或重放操作。');
      const binding = await this.check(c);
      const result = await client.send<{ targetInfo: { targetId: string; type: string; url: string } }>('Target.getTargetInfo', { targetId: binding.targetId });
      // The paired extension supplies Chrome's exact tab -> target mapping.
      // Never match by title/URL, attach an extension worker, or choose a new tab.
      if (result.targetInfo.type !== 'page' || result.targetInfo.targetId !== binding.targetId || result.targetInfo.url !== binding.url) failure('NATIVE_OBSERVATION_STALE', 'Chrome 目标与已授权标签页不一致。');
      c.pageSession = (await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId: binding.targetId, flatten: true })).sessionId;
      await this.check(c); c.stage = 'ready';
    } catch (error) {
      client?.close(); this.fail(c, error instanceof NativeControlError ? error.message : 'Chrome 连接未建立或授权等待结束。请检查 Chrome；本次不会自动重试。');
    }
  }
  async disconnect(sessionId: string) {
    const c = this.connections.get(sessionId); if (!c) return this.status(sessionId);
    this.shutdown(c);
    // A failed connection already ended its extension lease. A live connection
    // must confirm mode exit before ordinary page commands become available.
    if (c.stage !== 'failed') {
      try { await this.bridge.request(c.profileId, 'extensionUi.end', { sessionId, token: c.token }); }
      catch (error) { c.stage = 'failed'; c.error = '连接已关闭，扩展尚未确认退出；请检查控制状态。'; throw error; }
    }
    this.connections.delete(sessionId);
    return this.status(sessionId);
  }
  private ready(sessionId: string): Connection {
    const c = this.connections.get(sessionId);
    if (!c || c.stage !== 'ready' || !c.client || !c.pageSession) failure('NATIVE_EXTENSION_UI_NOT_READY', '请先查询 extension-ui status；连接 ready 后才能观察或点击。');
    this.assertOwner(c); return c;
  }
  private async tree(c: Connection, session = c.pageSession!): Promise<Tree> {
    return (await c.client!.send<{ frameTree: Tree }>('Page.getFrameTree', {}, 5000, session)).frameTree;
  }
  private async frames(c: Connection) {
    const tree = await this.tree(c), local = flatten(tree);
    const targets = await c.client!.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; parentId?: string; parentFrameId?: string }> }>('Target.getTargets');
    // Chrome omits OOPIFs from the parent's Page.getFrameTree. Follow CDP's
    // explicit parent graph; a matching URL elsewhere in Chrome is insufficient.
    const descendants = new Set(local.map(f => f.id));
    for (let pass = 0; pass < targets.targetInfos.length; pass++) {
      let changed = false;
      for (const t of targets.targetInfos) if (t.type === 'iframe' && !descendants.has(t.targetId) &&
          (descendants.has(t.parentId || '') || descendants.has(t.parentFrameId || ''))) { descendants.add(t.targetId); changed = true; }
      if (!changed) break;
    }
    const frames = local.filter(f => f.url.startsWith(`chrome-extension://${c.extensionId}/`)).map(frame => ({ frame, session: c.pageSession! }));
    for (const t of targets.targetInfos.filter(t => t.type === 'iframe' && descendants.has(t.targetId) && t.url.startsWith(`chrome-extension://${c.extensionId}/`)).slice(0, 20)) {
      await this.check(c);
      const session = c.children.get(t.targetId) || (await c.client!.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      c.children.set(t.targetId, session);
      const child = await this.tree(c, session);
      if (child.frame.id !== t.targetId || !child.frame.url.startsWith(`chrome-extension://${c.extensionId}/`)) failure('NATIVE_OBSERVATION_STALE', '扩展 frame 已改变，请重新观察。');
      for (const frame of flatten(child).filter(f => f.url.startsWith(`chrome-extension://${c.extensionId}/`))) {
        const existing = frames.findIndex(f => f.frame.id === frame.id);
        if (existing >= 0) frames.splice(existing, 1);
        frames.push({ frame, session });
      }
    }
    return { tree, frames: frames.slice(0, 20) };
  }
  private async evaluate(c: Connection, session: string, context: number, expression: string, userGesture = false): Promise<any> {
    const result = await c.client!.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, contextId: context, returnByValue: true, userGesture }, 5000, session);
    if (result.exceptionDetails) failure('NATIVE_OBSERVATION_STALE', '扩展界面已改变或按钮不可用，请重新观察。');
    return result.result.value;
  }
  async observe(sessionId: string) {
    const c = this.ready(sessionId); await this.check(c);
    c.refs.clear(); c.version = undefined;
    const { tree, frames } = await this.frames(c);
    const version = randomUUID(), result = [];
    for (const { frame, session } of frames) {
      await this.check(c);
      const { executionContextId } = await c.client!.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'ProfilePilotExtensionUi' }, 5000, session);
      const key = `__pp_${c.token}`;
      const controls: Array<{ index: number; label: string; role: string }> = await this.evaluate(c, session, executionContextId, `(() => {
        const all = []; const visit = root => { for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) visit(e.shadowRoot); if (e.matches('button,a,[role="button"],[role="option"],[role="menuitem"]') && !e.matches('input,textarea,[contenteditable="true"]') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled && e.getAttribute('aria-disabled') !== 'true') all.push(e); } }; visit(document);
        const label = e => (e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0, 200);
        globalThis[${JSON.stringify(key)}] = all.slice(0, 100).map(e => ({e, label: label(e)}));
        return globalThis[${JSON.stringify(key)}].map(({e, label}, index) => ({index, label, role: e.getAttribute('role') || e.tagName.toLowerCase()}));
      })()`);
      const refs = controls.map(control => {
        const ref = `x${c.refs.size + 1}`;
        c.refs.set(ref, { session, context: executionContextId, key, index: control.index, label: control.label, frame });
        return { ref, label: control.label, role: control.role };
      });
      result.push({ frameId: frame.id, controls: refs });
    }
    await this.check(c);
    if (!sameFrame(tree.frame, (await this.tree(c)).frame)) failure('NATIVE_OBSERVATION_STALE', '页面已变化，请重新观察。');
    c.rootFrame = tree.frame; c.version = version;
    return { version, extensionId: c.extensionId, frames: result, empty: result.length === 0 };
  }
  async click(sessionId: string, params: { version?: unknown; ref?: unknown }) {
    const c = this.ready(sessionId), ref = typeof params.ref === 'string' ? c.refs.get(params.ref) : undefined;
    if (!ref || !c.version || c.version !== params.version) failure('NATIVE_OBSERVATION_STALE', '点击需要最近 extension-ui observe 的 version 和 ref。');
    c.version = undefined; c.refs.clear(); // consumed even when outcome is unknown
    await this.check(c);
    const { tree, frames } = await this.frames(c), frame = frames.find(f => f.frame.id === ref.frame.id)?.frame;
    if (!c.rootFrame || !sameFrame(c.rootFrame, tree.frame) || !frame || !sameFrame(ref.frame, frame)) failure('NATIVE_OBSERVATION_STALE', '页面或扩展浮层已变化，请重新观察。');
    await this.check(c);
    try {
      await this.evaluate(c, ref.session, ref.context, `(() => {
        const entry = globalThis[${JSON.stringify(ref.key)}]?.[${ref.index}]; delete globalThis[${JSON.stringify(ref.key)}];
        const e = entry?.e, label = e && (e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0,200);
        if (!e?.isConnected || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden' || e.disabled || e.getAttribute('aria-disabled') === 'true' || label !== ${JSON.stringify(ref.label)}) throw Error('stale');
        e.click(); return true;
      })()`, true);
    } catch (error) {
      if (error instanceof NativeControlError) throw error;
      return failure('NATIVE_TIMEOUT_UNCERTAIN', '扩展按钮点击结果不确定，请检查页面；不会重放。');
    }
    return { clicked: true, automaticReplay: false, nextStep: '重新观察扩展浮层或 disconnect 后观察网页，确认实际结果。' };
  }
}
