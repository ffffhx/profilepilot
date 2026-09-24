import { TERMINAL_TASKS, type BrowserTask, type TaskPreviewUpdate } from "../../shared/tasks";
import { requestBrowserGateway, subscribeBrowserGatewayEvents, type GatewayEventSubscription } from "../browser-gateway-client";
import type { GatewayProfileBinding } from "../browser-gateway-control";
import { CdpBrowserClient, requestCdpJson } from "../cdp-client";

type Profile = GatewayProfileBinding & { connectionActive?: boolean; agentTarget?: { targetId: string; url: string } | null };
let nextFrameId = 0;

// Desktop-only observer. No navigation, input, window activation or Agent lease.
// Frames are transient and never enter the task store or the model context.
export class TaskPreviewStream {
  private readonly homeDir = process.env.PROFILEPILOT_GATEWAY_HOME;
  private client?: CdpBrowserClient;
  private session?: string;
  private target = "";
  private generation = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private subscription?: GatewayEventSubscription;
  private pendingFrame?: number;
  private queuedFrame?: { data: string; url: string };
  private frameTimer?: NodeJS.Timeout;
  private lastFrameAt = 0;
  private statusKey = "";
  private url = "";
  constructor(private readonly getTask: () => BrowserTask | undefined, private readonly emit: (update: TaskPreviewUpdate) => void) {}

  start(): void {
    this.subscription = subscribeBrowserGatewayEvents({ onEvent: ({ controlEvent }) => {
      const task = this.getTask();
      if (controlEvent.profile.profileId !== task?.profileId) return;
      // Release the internal observer before an Agent transport reconnects.
      if (controlEvent.profile.ownerSessionId !== task.sessionId || controlEvent.profile.driverState === "reconnecting" || controlEvent.profile.driverState === "connecting") this.disconnect();
    } }, { homeDir: this.homeDir });
    void this.subscription.ready.catch(() => {});
    void this.refresh();
  }
  ack(frameId: number): void {
    if (frameId !== this.pendingFrame) return;
    this.pendingFrame = undefined; this.flushFrame();
  }
  close(): void {
    this.closed = true; clearTimeout(this.timer); this.subscription?.close(); this.disconnect();
  }
  private disconnect(): void {
    this.generation++;
    const client = this.client; const session = this.session;
    this.client = undefined; this.session = undefined; this.target = ""; this.pendingFrame = undefined;
    this.queuedFrame = undefined; clearTimeout(this.frameTimer); this.frameTimer = undefined;
    if (client) {
      client.onEvent = null; client.onDisconnect = null;
      // Detaching/closing this internal session also stops its screencast.
      if (session) void client.send("Page.stopScreencast", {}, 1000, session).catch(() => {})
        .then(() => client.send("Emulation.setFocusEmulationEnabled", { enabled: false }, 1000, session).catch(() => {}))
        .finally(() => client.close());
      else client.close();
    }
  }
  private status(state: TaskPreviewUpdate["state"], message: string): void {
    const task = this.getTask(); if (!task || this.closed) return;
    const key = `${state}:${message}:${this.url}`;
    if (this.statusKey === key) return;
    this.statusKey = key;
    this.emit({ taskId: task.id, state, message, url: this.url });
  }
  private flushFrame(): void {
    const task = this.getTask();
    if (this.closed || !task || this.pendingFrame !== undefined || !this.queuedFrame || this.frameTimer) return;
    const delay = 100 - (Date.now() - this.lastFrameAt);
    if (delay > 0) {
      this.frameTimer = setTimeout(() => { this.frameTimer = undefined; this.flushFrame(); }, delay);
      return;
    }
    const frame = this.queuedFrame; this.queuedFrame = undefined;
    this.lastFrameAt = Date.now(); this.pendingFrame = ++nextFrameId; this.statusKey = "";
    this.emit({ taskId: task.id, state: "live", message: "实时画面", url: frame.url, frameId: this.pendingFrame, frame: frame.data });
  }
  private async refresh(): Promise<void> {
    try {
      const task = this.getTask();
      if (!task || this.closed) { this.close(); return; }
      if (TERMINAL_TASKS.has(task.status)) { this.disconnect(); this.status("ended", "任务已结束 · 实时画面已关闭"); return; }
      if (!task.port) { this.status("connecting", "等待任务连接浏览器…"); return; }
      const response = await requestBrowserGateway({ action: "status" }, { timeoutMs: 3000, homeDir: this.homeDir });
      if (this.closed) return;
      const profiles = (response.state as { profiles?: Profile[] } | undefined)?.profiles || [];
      const profile = profiles.find(p => p.profileId === task.profileId && p.publicPort === task.port);
      if (!response.ok || !profile) { this.disconnect(); this.status("unavailable", "浏览器未连接 · 打开窗口后自动重连"); return; }
      if (profile.ownerSessionId !== task.sessionId) { this.disconnect(); this.status("unavailable", "此任务的浏览器会话未连接"); return; }
      if (profile.ownership === "agent" && !profile.connectionActive) { this.disconnect(); this.status("connecting", "等待 Agent 连接浏览器…"); return; }
      const target = profile.agentTarget;
      if (!target?.targetId) { this.disconnect(); this.status("connecting", "等待任务打开页面…"); return; }
      this.url = target.url;
      if (this.client && this.target === target.targetId) {
        // A static page need not produce new frames; no age-based false disconnect.
        return;
      }
      this.disconnect(); this.status("connecting", "正在连接实时画面…");
      const generation = this.generation;
      const version = await requestCdpJson<{ Browser: string; webSocketDebuggerUrl: string }>(task.port, "/json/version", this.homeDir);
      const endpoint = new URL(version.webSocketDebuggerUrl);
      if (version.Browser !== "ProfilePilot Gateway" || endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(task.port) || endpoint.pathname !== "/devtools/browser/gateway") throw new Error("Invalid preview gateway");
      const client = await CdpBrowserClient.connect(endpoint.href, 3000);
      if (this.closed || generation !== this.generation) { client.close(); return; }
      this.client = client; this.target = target.targetId;
      client.onDisconnect = () => {
        if (this.client !== client) return;
        this.disconnect(); this.status("unavailable", "实时画面已断开 · 正在重连…");
      };
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, 3000);
      if (this.closed || generation !== this.generation) return;
      this.session = attached.sessionId;
      client.onEvent = (method, raw, sessionId) => {
        if (sessionId !== attached.sessionId || generation !== this.generation || this.closed) return;
        const params = raw as { data?: string; sessionId?: number; visible?: boolean; frame?: { parentId?: string; url?: string } };
        if (method === "Page.screencastVisibilityChanged" && !params.visible) this.status("unavailable", "页面暂不可见 · 可打开浏览器窗口查看");
        if (method === "Page.frameNavigated" && !params.frame?.parentId && params.frame?.url) this.url = params.frame.url;
        if (method !== "Page.screencastFrame") return;
        void client.send("Page.screencastFrameAck", { sessionId: params.sessionId }, 3000, attached.sessionId).catch(() => {});
        if (typeof params.data !== "string" || params.data.length > 4 * 1024 * 1024) return;
        this.queuedFrame = { data: params.data, url: this.url }; this.flushFrame();
      };
      await client.send("Page.enable", {}, 3000, attached.sessionId);
      // Chromium's focus emulation retains a capturer handle so hidden tabs keep
      // producing frames. It does not activate a native tab/window; detaching this
      // session releases the override. It temporarily reports page focus/visibility.
      await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 3000, attached.sessionId);
      await client.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 }, 3000, attached.sessionId);
    } catch {
      if (!this.closed) { this.disconnect(); this.status("unavailable", "暂时无法连接实时画面 · 正在重连…"); }
    } finally {
      if (!this.closed) { this.timer = setTimeout(() => void this.refresh(), 1000); this.timer.unref(); }
    }
  }
}
