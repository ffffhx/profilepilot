import { TERMINAL_TASKS, type BrowserTask, type TaskPreviewUpdate } from "../../shared/tasks";
import { NativeBrowserBridge } from "./native-bridge";

// Negative IDs are avoided because the renderer IPC accepts positive IDs only.
let nextFrameId = 1_000_000_000;
export class NativePreviewStream {
  private closed = false;
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private frameTimer?: NodeJS.Timeout;
  private pending?: number;
  private queued?: string;
  private lastAt = 0;
  private streaming?: number;
  private statusKey = "";
  constructor(private readonly bridge: NativeBrowserBridge, private readonly getTask: () => BrowserTask | undefined, private readonly emit: (value: TaskPreviewUpdate) => void) {}
  start(): void {
    this.unsubscribe = this.bridge.onEvent(event => {
      const task = this.getTask();
      if (!task || event.profileId !== task.profileId || event.sessionId !== task.sessionId || this.closed) return;
      if (event.type === "disconnected" || (event.type === "state" && (event.state?.tabId !== this.streaming || event.state?.pausedByBrowser))) { this.streaming = undefined; this.queued = undefined; this.pending = undefined; }
      if (event.type !== "cdp" || event.method !== "Page.screencastFrame") return;
      void this.command("Page.screencastFrameAck", { sessionId: event.params?.sessionId }).catch(() => {});
      if (typeof event.params?.data !== "string" || event.params.data.length > 4 * 1024 * 1024) return;
      this.queued = event.params.data; this.flush();
    });
    void this.refresh();
  }
  private async command(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const task = this.getTask(); if (!task) return;
    await this.bridge.request(task.profileId, "preview", { sessionId: task.sessionId, method, params }, 4000);
  }
  private status(state: TaskPreviewUpdate["state"], message: string): void {
    const task = this.getTask(); if (!task || this.closed || this.statusKey === `${state}:${message}`) return;
    this.statusKey = `${state}:${message}`; this.emit({ taskId: task.id, state, message });
  }
  private async refresh(): Promise<void> {
    try {
      const task = this.getTask(); if (!task || this.closed) return;
      if (TERMINAL_TASKS.has(task.status)) { this.status("ended", "任务已结束 · 实时画面已关闭"); this.close(); return; }
      const state = this.bridge.states().find(s => s.profileId === task.profileId);
      if (state?.pausedByBrowser) { this.streaming = undefined; this.status("unavailable", "浏览器调试已停止 · 点击继续任务后恢复画面"); return; }
      if (!state?.connected || !state.tabId || state.ownerSessionId !== task.sessionId) {
        this.streaming = undefined; this.status("unavailable", "等待系统 Chrome 扩展连接任务…"); return;
      }
      if (this.streaming === state.tabId) return;
      this.status("connecting", "正在连接系统 Chrome 实时画面…");
      await this.command("Page.enable");
      await this.command("Emulation.setFocusEmulationEnabled", { enabled: true });
      await this.command("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
      if (this.closed) { void this.command("Page.stopScreencast").catch(() => {}); return; }
      this.streaming = state.tabId;
    } catch {
      this.streaming = undefined; this.status("unavailable", "画面连接已暂停 · 请在扩展中检查连接或交还控制权");
    } finally {
      if (!this.closed) { this.timer = setTimeout(() => void this.refresh(), 1500); this.timer.unref(); }
    }
  }
  ack(id: number): void { if (id === this.pending) { this.pending = undefined; this.flush(); } }
  private flush(): void {
    const task = this.getTask(); if (this.closed || !task || this.pending || !this.queued || this.frameTimer) return;
    const delay = 100 - (Date.now() - this.lastAt);
    if (delay > 0) { this.frameTimer = setTimeout(() => { this.frameTimer = undefined; this.flush(); }, delay); return; }
    const frame = this.queued; this.queued = undefined; this.pending = ++nextFrameId; this.lastAt = Date.now(); this.statusKey = "";
    this.emit({ taskId: task.id, state: "live", message: "实时画面 · 系统 Chrome", url: this.bridge.states().find(s => s.profileId === task.profileId)?.url, frame, frameId: this.pending });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.frameTimer); this.unsubscribe?.();
    this.queued = undefined; this.pending = undefined;
    void this.command("Page.stopScreencast").catch(() => {});
  }
}
