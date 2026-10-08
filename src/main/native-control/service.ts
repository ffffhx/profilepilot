import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserObservation, BrowserTask } from "../../shared/tasks";
import type { NativeBrowserBridge, NativeEvent } from "../tasks/native-bridge";
import { NativeBrowser } from "../tasks/native-browser";
import type { DomCandidate } from "../tasks/fast-browser";
import { NativeControlError } from "./errors";
import { isNativeControlMethod } from "./protocol";
import { nativeExtensionReady, NATIVE_EXTENSION_UPDATE_MESSAGE } from "../tasks/native-compatibility";

interface Session {
  task: BrowserTask;
  queue: Promise<unknown>;
  epoch: number;
  ending: boolean;
  control: { connected: boolean; owned: boolean; agent: boolean; paused: boolean; generation?: string };
  termination?: Promise<unknown>;
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
  private readonly sessions = new Map<string, Session>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly statusReceipts = new Map<string, Receipt>();
  private readonly events: Array<NativeEvent & { cursor: number; at: string }> = [];
  private cursor = 0;
  private eventBytes = 0;
  private readonly eventSizes: number[] = [];
  private readonly unsubscribe: () => void;
  constructor(private readonly bridge: NativeBrowserBridge, root: string) {
    this.browser = new NativeBrowser(bridge, path.join(root, "native-control-artifacts"));
    this.unsubscribe = bridge.onEvent(event => {
      const entry = { ...event, cursor: ++this.cursor, at: new Date().toISOString() };
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      this.events.push(entry); this.eventSizes.push(bytes); this.eventBytes += bytes;
      while (this.events.length > 1000 || this.eventBytes > 8 * 1024 * 1024) { this.events.shift(); this.eventBytes -= this.eventSizes.shift()!; }
      if (event.type === "disconnected" || event.type === "state") {
        for (const session of this.sessions.values()) if (session.task.profileId === event.profileId) this.updateControlState(session, event.type === "state" ? event.state : undefined);
      }
    });
  }
  close(): void { this.unsubscribe(); this.browser.dispose?.(); }
  hasSessions(): boolean { return this.sessions.size > 0; }
  ownsSession(profileId: string, sessionId: string): boolean { return this.sessions.get(sessionId)?.task.profileId === profileId; }
  private updateControlState(session: Session, state: NativeEvent["state"]): void {
    const next = { connected: state?.connected === true, owned: state?.ownerSessionId === session.task.sessionId,
      agent: state?.ownership === "agent", paused: state?.pausedByBrowser === true, generation: state?.controlGeneration };
    const previous = session.control;
    // A real loss of connection/control invalidates work still in our queue.
    // Repeated user-state publications must not cancel a later explicit resume.
    if ((previous.connected && !next.connected) || (previous.owned && !next.owned) ||
        (previous.agent && !next.agent) || (!previous.paused && next.paused) ||
        (previous.generation !== undefined && previous.generation !== next.generation)) session.epoch++;
    session.control = next;
    if (!next.connected || !next.owned || !next.agent || next.paused) session.task.observation = undefined;
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
      const result = this.execute(command);
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
    if (this.receipts.size >= ACTION_RECEIPT_LIMIT && recovery && !this.sessions.has(command.sessionId)) return this.execute(command);
    const result = this.execute(command);
    this.receipts.set(command.requestId, { signature, result });
    return result;
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
    if (method === "status") return { protocolVersion: 1, profiles: this.bridge.states(), sessions: [...this.sessions].map(([id, s]) => ({ sessionId: id, profileId: s.task.profileId, ...(s.ending ? { ending: true } : {}) })), cursor: this.cursor };
    if (method === "claim") {
      const profileId = this.profile(command.profileId), sessionId = command.sessionId || `direct-${randomUUID()}`;
      if (typeof sessionId !== "string" || !/^[\w.-]{1,160}$/.test(sessionId)) throw new Error("会话名称无效。");
      if (sessionId.startsWith("pp-task-")) throw new NativeControlError("NATIVE_INVALID_REQUEST", "pp-task- 是内置任务专用前缀，请为直接会话选择其他名称。");
      if (!nativeExtensionReady(this.bridge.states().find(state => state.profileId === profileId)!)) {
        throw new NativeControlError("NATIVE_EXTENSION_UPDATE_REQUIRED", NATIVE_EXTENSION_UPDATE_MESSAGE);
      }
      const previous = this.sessions.get(sessionId);
      if (previous) throw new Error("此直接会话已经存在，请继续使用或显式结束。");
      const task = { id: randomUUID(), sessionId, profileId, browserConnection: "extension", status: "running", attachments: [], outputs: [] } as unknown as BrowserTask;
      // Reserve synchronously before any I/O; two claims cannot overwrite the
      // same session or bind it to two Profiles.
      const session: Session = { task, queue: Promise.resolve(), epoch: 0, ending: false,
        control: { connected: false, owned: false, agent: false, paused: false } };
      this.updateControlState(session, this.bridge.states().find(s => s.profileId === profileId));
      this.sessions.set(sessionId, session);
      try {
        await this.bridge.request(profileId, "claim", { sessionId, tabId: params.tabId, newTab: params.newTab === true });
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
    if (method === "control") {
      if (!["handoff", "resume", "complete", "release"].includes(params.action)) throw new NativeControlError("NATIVE_INVALID_REQUEST", "无效的控制动作。");
      if (["complete", "release"].includes(params.action)) {
        if (session.termination) return session.termination;
        // Invalidate queued resume/actions before awaiting the extension. Keep
        // the reservation until termination succeeds, and allow explicit retry
        // after failure without ever reopening this generation for new work.
        session.ending = true; session.epoch++; task.observation = undefined;
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
      if (params.action === "handoff") { session.epoch++; session.control.agent = false; }
    }
    // Bind permission before joining the service queue. The extension also
    // checks this original token, including if its newer state arrives late.
    const resumeGeneration = method === "control" && params.action === "resume" && !session.ending ? this.browser.controlGeneration(task) : undefined;
    const epoch = session.epoch;
    const invoke = async (): Promise<unknown> => {
      if (this.sessions.get(task.sessionId) !== session || session.ending) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "此直接会话已结束或正在结束，排队操作已取消；请检查 status。");
      if (session.epoch !== epoch) throw new NativeControlError("NATIVE_USER_IN_CONTROL", "用户已停止或接管，排队操作已取消。");
      if (method === "control") {
        task.observation = undefined;
        await this.browser.control(task, params.action, resumeGeneration);
        this.updateControlState(session, this.bridge.states().find(s => s.profileId === task.profileId));
        return { state: this.bridge.states().find(s => s.profileId === task.profileId) };
      }
      const state = this.bridge.states().find(s => s.profileId === task.profileId);
      if (!state?.connected) throw new NativeControlError("NATIVE_DISCONNECTED", "扩展断线；请检查 status，不会自动恢复或重放。");
      if (state.ownerSessionId !== task.sessionId) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "浏览器会话已停止或所有者已改变，请检查 status。");
      if (state.ownership !== "agent" || state.pausedByBrowser) throw new NativeControlError("NATIVE_USER_IN_CONTROL", "用户已接管或浏览器已停止，请显式交还后重新观察。");
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
      if (method === "action" || method === "pointer") {
        if (!task.observation || params.version !== task.observation.version) throw new NativeControlError("NATIVE_OBSERVATION_STALE", "动作必须携带最近 observe/read 的 version；动作、交还后请重新观察。");
        const observation = task.observation;
        try {
          if (method === "pointer") {
            const pointer = (this.browser as any).pointer;
            if (!pointer) throw new Error("当前执行器尚不支持坐标操作。");
            return await pointer.call(this.browser, task, params);
          }
          return await this.browser.execute(task, { effect: "edit", summary: "外部 Agent 直接操作", ...params, version: observation.version });
        } finally { task.observation = undefined; }
      }
      if (method === "screenshot") return this.browser.screenshot(task, params);
      if (method === "debug") {
        const domains = params.domains || ["Runtime", "Network", "Log", "Performance"];
        if (!Array.isArray(domains) || domains.some(d => !/^[A-Za-z]+$/.test(d))) throw new Error("调试域无效。");
        for (const domain of domains) await this.bridge.request(task.profileId, "cdp", { sessionId: task.sessionId, method: `${domain}.enable`, params: {} });
        return { domains, cursor: this.cursor };
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
