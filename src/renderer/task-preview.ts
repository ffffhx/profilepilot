import type { TaskApi, TaskPreviewUpdate } from "../shared/tasks";

export function previewMarkup(): string {
  return `<section class="panel browser-live"><div class="panel-header"><h2>浏览器现场</h2><button data-action="focus-browser">打开窗口 ↗</button></div>
    <div class="live-heading"><span class="live-indicator" data-preview-state="connecting"></span><span data-preview-status role="status">正在连接实时画面…</span></div>
    <div class="live-stage"><canvas class="live-canvas" hidden aria-label="任务浏览器实时画面"></canvas><div class="preview-placeholder" data-preview-placeholder>正在连接实时画面…</div></div>
    <div class="url" data-preview-url></div><small>画面随页面变化更新 · 操作浏览器请打开窗口</small></section>`;
}

// Keep the same canvas through task snapshot renders; frames never rebuild the page.
export class TaskPreviewView {
  private taskId: string | null = null;
  private canvas = document.createElement("canvas");
  private panel?: HTMLElement;
  private latest?: TaskPreviewUpdate;
  private generation = 0;
  private updateSequence = 0;
  constructor(private readonly api: TaskApi) {
    this.canvas.className = "live-canvas";
    this.canvas.setAttribute("aria-label", "任务浏览器实时画面");
    this.canvas.hidden = true;
    api.onPreview(update => void this.receive(update));
    document.addEventListener("visibilitychange", () => {
      this.generation++;
      void api.watchPreview(document.hidden ? null : this.taskId).catch(() => {});
    });
    window.addEventListener("beforeunload", () => { void api.watchPreview(null); });
  }
  mount(panel: HTMLElement | null, taskId: string | null): void {
    if (this.taskId !== taskId) {
      this.generation++; this.taskId = taskId; this.latest = undefined; this.canvas.hidden = true;
      this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      void this.api.watchPreview(document.hidden ? null : taskId).catch(() => {
        if (this.taskId === taskId && taskId) { this.latest = { taskId, state: "unavailable", message: "暂时无法连接实时画面" }; this.paintStatus(); }
      });
    }
    this.panel = panel || undefined;
    panel?.querySelector("canvas")?.replaceWith(this.canvas);
    this.paintStatus();
  }
  private paintStatus(): void {
    if (!this.panel || !this.latest) return;
    const update = this.latest;
    this.panel.querySelector("[data-preview-status]")!.textContent = update.message;
    (this.panel.querySelector("[data-preview-state]") as HTMLElement).dataset.previewState = update.state;
    this.panel.querySelector("[data-preview-url]")!.textContent = update.url || "";
    const placeholder = this.panel.querySelector<HTMLElement>("[data-preview-placeholder]")!;
    placeholder.hidden = update.state === "live" && !this.canvas.hidden;
    placeholder.textContent = update.message;
    // Never present the previous target's last frame as a current live view.
    if (update.state !== "live") this.canvas.hidden = true;
  }
  private async receive(update: TaskPreviewUpdate): Promise<void> {
    const generation = this.generation;
    const sequence = ++this.updateSequence;
    try {
      if (update.taskId !== this.taskId) return;
      if (update.frame) {
        const image = new Image(); image.src = `data:image/jpeg;base64,${update.frame}`;
        await image.decode();
        if (generation !== this.generation || sequence !== this.updateSequence || update.taskId !== this.taskId) return;
        if (this.canvas.width !== image.naturalWidth) this.canvas.width = image.naturalWidth;
        if (this.canvas.height !== image.naturalHeight) this.canvas.height = image.naturalHeight;
        this.canvas.getContext("2d")?.drawImage(image, 0, 0);
        this.canvas.hidden = false;
      }
      this.latest = { ...update, frame: undefined }; this.paintStatus();
    } catch {
      if (update.taskId === this.taskId) { this.latest = { taskId: update.taskId, state: "unavailable", message: "画面加载失败，等待下一帧…" }; this.paintStatus(); }
    } finally {
      if (update.frameId !== undefined) void this.api.ackPreview(update.taskId, update.frameId).catch(() => {});
    }
  }
}
