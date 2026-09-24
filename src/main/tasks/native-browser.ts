import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserAction, BrowserObservation, BrowserTask } from "../../shared/tasks";
import { browserActionSchema, type BrowserAdapter } from "./browser";
import { FastBrowser } from "./fast-browser";
import { NativeBrowserBridge } from "./native-bridge";

export const isNativeTask = (task: BrowserTask): boolean => task.browserConnection === "extension" || task.profileId.startsWith("native:");

// The same task/approval pipeline is used by both transports. Native Chrome is
// never launched with debugging flags and no browser credentials are copied.
export class NativeBrowser implements BrowserAdapter {
  private readonly fast: FastBrowser;
  constructor(readonly bridge: NativeBrowserBridge, private readonly artifactRoot: string) {
    this.fast = new FastBrowser(async () => {}, (task, method, params) => this.raw(task, method, params));
  }
  private async claim(task: BrowserTask): Promise<void> {
    const state = this.bridge.states().find(s => s.profileId === task.profileId);
    if (!state?.connected) throw new Error("系统 Chrome 扩展未连接，请先在扩展中连接此 Profile。");
    if (!state.taskTabs) throw new Error("请在 Chrome 扩展管理页更新或重新加载 ProfilePilot 扩展，以启用自动新建任务标签页。");
    if (state.ownerSessionId && state.ownerSessionId !== task.sessionId) throw new Error("这个 Profile 已由另一个任务占用。");
    if (state.ownerSessionId && state.ownership !== "agent") throw new Error("用户正在操作浏览器，请交还后继续。");
    if (!state.ownerSessionId) await this.bridge.request(task.profileId, "claim", { sessionId: task.sessionId });
  }
  private async request(task: BrowserTask, method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.claim(task);
    return this.bridge.request(task.profileId, method, { ...params, sessionId: task.sessionId });
  }
  private raw(task: BrowserTask, method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.request(task, "cdp", { method, params });
  }
  observeFast(task: BrowserTask): Promise<BrowserObservation> { return this.fast.observe(task); }
  async observe(task: BrowserTask, screenshot = false, retainScreenshot = true): Promise<BrowserObservation> {
    const observation = await this.fast.observe(task);
    observation.snapshot += "\n\n系统 Chrome：仅包含已授权标签页的主文档。跨域 iframe、系统对话框和浏览器内部页需要用户接管。下载由 Chrome 管理，不能自动确认文件落盘。";
    // A fresh background about:blank page may have no compositor frame on
    // Windows. Its empty DOM is sufficient; requesting an image can hang Chrome
    // until the task is incorrectly interrupted before its first navigation.
    if (screenshot && observation.url === "about:blank") {
      observation.snapshot += "\n当前是新建的空白任务页，没有可截图的内容。请根据任务打开目标网站。";
      return observation;
    }
    if (screenshot) {
      let result;
      try {
        result = await this.raw(task, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        if (typeof result.data !== "string" || !result.data) throw new Error("浏览器未返回画面。");
      } catch (error) {
        const state = this.bridge.states().find(s => s.profileId === task.profileId);
        // Keep the successful DOM read when only the image is unavailable.
        // A real takeover, disconnect or session change still stops the task.
        if (!state?.connected || state.ownerSessionId !== task.sessionId || state.ownership !== "agent" || state.pausedByBrowser) throw error;
        observation.snapshot += "\n截图暂不可用。请根据本次读取的页面文字和控件继续；不能据此判断页面的视觉外观。";
        return observation;
      }
      observation.screenshotDataUrl = `data:image/png;base64,${result.data}`;
      if (retainScreenshot) {
        const dir = path.resolve(this.artifactRoot, task.id);
        if (!dir.startsWith(path.resolve(this.artifactRoot) + path.sep)) throw new Error("无效的任务目录。");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        observation.screenshotPath = path.join(dir, `${observation.version}.png`);
        writeFileSync(observation.screenshotPath, Buffer.from(result.data, "base64"), { mode: 0o600 });
      }
    }
    return observation;
  }
  tabs(task: BrowserTask): Promise<unknown> { return this.request(task, "tabs"); }
  async execute(task: BrowserTask, input: BrowserAction): Promise<string> {
    const action = browserActionSchema.parse(input);
    if (["click", "hover", "fill", "select", "scroll"].includes(action.kind)) {
      if (action.kind === "click" || action.kind === "hover") await this.request(task, "preparePointer");
      return this.fast.execute(task, action);
    }
    if (action.kind === "check" || action.kind === "uncheck") {
      await this.assertFresh(task);
      const candidate = task.observation?.fast?.candidates.find(c => c.ref === action.ref?.replace(/^@/, ""));
      if (candidate?.checked === undefined) throw new Error("目标不是复选框或单选框，请重新观察。");
      if (candidate.checked === (action.kind === "check")) return "目标已处于所需状态。";
      await this.request(task, "preparePointer");
      return this.fast.execute(task, { ...action, kind: "click" });
    }
    if (action.kind === "open") {
      const url = new URL(action.value || "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("只支持不含凭据的 HTTP/HTTPS 页面。");
      const result = await this.request(task, "open", { url: url.href });
      if (result.errorText) throw new Error(result.errorText);
    } else if (action.kind === "back") {
      const history = await this.raw(task, "Page.getNavigationHistory");
      const entry = history.entries?.[history.currentIndex - 1];
      if (!entry) throw new Error("当前标签页没有可返回的历史页面。");
      await this.raw(task, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else if (action.kind === "switch_tab" || action.kind === "close_tab") {
      if (!/^\d{1,10}$/.test(action.value || "")) throw new Error("请选择标签页列表中的编号。");
      await this.request(task, action.kind === "switch_tab" ? "switch" : "closeTab", { tabId: Number(action.value) });
    } else if (action.kind === "press") {
      await this.assertFresh(task);
      const match = /^(?:(Control|Meta)\+)?(Enter|Return|Tab|Escape|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Space|Backspace|Delete|a)$/i.exec(action.value || "");
      if (!match || (match[1] && !/^(a|Enter)$/i.test(match[2])) || (!match[1] && match[2] === "a")) throw new Error("不支持该按键。");
      const keys: Record<string, [string, number]> = { enter: ["Enter", 13], return: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], arrowdown: ["ArrowDown", 40], arrowup: ["ArrowUp", 38], arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39], space: [" ", 32], backspace: ["Backspace", 8], delete: ["Delete", 46], a: ["a", 65] };
      const [key, windowsVirtualKeyCode] = keys[match[2].toLowerCase()];
      const params = { key, windowsVirtualKeyCode, modifiers: match[1]?.toLowerCase() === "control" ? 2 : match[1] ? 4 : 0 };
      await this.raw(task, "Input.dispatchKeyEvent", { ...params, type: "keyDown", ...(!match[1] && key === "Enter" ? { text: "\r" } : !match[1] && key === " " ? { text: " " } : {}) });
      await this.raw(task, "Input.dispatchKeyEvent", { ...params, type: "keyUp" });
    } else if (action.kind === "upload") {
      const file = [...task.attachments, ...(task.outputs || [])].find(f => f.id === action.attachmentId);
      if (!file) throw new Error("只能上传当前任务明确选择的附件。");
      await this.assertFresh(task);
      const ref = action.ref?.replace(/^@/, "");
      if (!task.observation?.fast?.candidates.some(c => c.ref === ref && c.role === "fileupload")) throw new Error("请选择观察结果中的文件上传控件。");
      const result = await this.raw(task, "Runtime.evaluate", { expression: `window.__profilepilot_jev_dom_v1?.nodes.get(${JSON.stringify(ref)})`, returnByValue: false });
      const objectId = result.result?.objectId;
      if (!objectId) throw new Error("上传控件已失效。");
      try { await this.raw(task, "DOM.setFileInputFiles", { objectId, files: [file.path] }); }
      finally { await this.raw(task, "Runtime.releaseObject", { objectId }).catch(() => {}); }
    } else if (action.kind === "download") {
      throw new Error("系统 Chrome 的下载由浏览器管理。请让用户接管并确认下载结果；当前连接不自动读取下载目录。");
    }
    return "操作已执行；请重新观察确认结果。";
  }
  private async assertFresh(task: BrowserTask): Promise<void> {
    const fresh = await this.fast.observe(task);
    if (!task.observation?.fast || fresh.fast?.guard !== task.observation.fast.guard) throw new Error("页面已变化，动作未执行，请重新观察。");
  }
  async control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release"): Promise<void> {
    this.fast.forget(task);
    const state = this.bridge.states().find(s => s.profileId === task.profileId);
    // A disconnected extension already stopped input. Completing locally must not
    // reacquire it or unexpectedly resume Chrome on the next connection.
    if (!state?.connected && action !== "resume") return;
    if (action === "resume" && !state?.taskTabs) throw new Error("请更新或重新加载 ProfilePilot 扩展，以启用自动新建任务标签页。");
    const request = () => this.bridge.request(task.profileId, "control", { sessionId: task.sessionId, action });
    try { await request(); }
    catch (error) {
      // Older installed extensions require status=complete on the first wake.
      // They may time out after waking a usable but still loading renderer.
      // Retry only this explicit resume, once. Never replay a page action.
      if (action !== "resume" || !(error instanceof Error) || !error.message.includes("授权标签页正在从休眠恢复")) throw error;
      const current = this.bridge.states().find(s => s.profileId === task.profileId);
      if (!current?.connected || current.ownerSessionId !== task.sessionId) throw error;
      await request();
    }
  }
}

export class RoutedBrowser implements BrowserAdapter {
  constructor(private readonly gateway: BrowserAdapter, readonly native: NativeBrowser) {}
  private route(task: BrowserTask): BrowserAdapter { return isNativeTask(task) ? this.native : this.gateway; }
  observeFast(task: BrowserTask): Promise<BrowserObservation> { const browser = this.route(task); return browser.observeFast ? browser.observeFast(task) : browser.observe(task); }
  observe(task: BrowserTask, screenshot?: boolean, retain?: boolean): Promise<BrowserObservation> { return this.route(task).observe(task, screenshot, retain); }
  execute(task: BrowserTask, action: BrowserAction): Promise<string> { return this.route(task).execute(task, action); }
  tabs(task: BrowserTask): Promise<unknown> { return this.route(task).tabs(task); }
  control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release"): Promise<void> { return this.route(task).control(task, action); }
}
