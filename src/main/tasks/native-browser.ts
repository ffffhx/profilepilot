import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserAction, BrowserObservation, BrowserTask } from "../../shared/tasks";
import { browserActionSchema, type BrowserAdapter } from "./browser";
import type { PageReadOptions } from "./fast-browser";
import type { NativeBrowserTransport } from "./native-bridge";
import { NATIVE_EXTENSION_UPDATE_MESSAGE } from "./native-compatibility";
import { NativeControlError } from "../native-control/errors";
import { NativePage } from "./native-page";
import { registerNativeDownload, taskArtifactDirectory, type NativeDownloadInput, type NativeDownloadItem } from "./native-downloads";

export const isNativeTask = (task: BrowserTask): boolean => task.browserConnection === "extension" || task.profileId.startsWith("native:");

// The same task/approval pipeline is used by both transports. Native Chrome is
// never launched with debugging flags and no browser credentials are copied.
export class NativeBrowser implements BrowserAdapter {
  private readonly fast: NativePage;
  private readonly stopEvents: () => void;
  constructor(readonly bridge: NativeBrowserTransport, private readonly artifactRoot: string) {
    this.fast = new NativePage((task, method, params, session) => this.raw(task, method, params, session));
    this.stopEvents = bridge.onEvent(event => this.fast.event(event));
  }
  private async claim(task: BrowserTask): Promise<void> {
    const state = this.bridge.states().find(s => s.profileId === task.profileId);
    if (!state?.connected) throw new Error("系统 Chrome 扩展未连接，请先在扩展中连接此 Profile。");
    if (!state.taskTabs) throw new Error(NATIVE_EXTENSION_UPDATE_MESSAGE);
    if (state.ownerSessionId && state.ownerSessionId !== task.sessionId) throw new Error("这个 Profile 已由另一个任务占用。");
    if (state.ownerSessionId && state.ownership !== "agent") throw new Error("用户正在操作浏览器，请交还后继续。");
    if (!state.ownerSessionId) await this.bridge.request(task.profileId, "claim", { sessionId: task.sessionId, ...task.nativeTarget });
  }
  private async request(task: BrowserTask, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    await this.claim(task);
    return this.bridge.request(task.profileId, method, { ...params, sessionId: task.sessionId }, timeoutMs);
  }
  private raw(task: BrowserTask, method: string, params: Record<string, unknown> = {}, cdpSessionId?: string): Promise<any> {
    return this.request(task, "cdp", { method, params, ...(cdpSessionId ? { cdpSessionId } : {}) });
  }
  observeFast(task: BrowserTask): Promise<BrowserObservation> { return this.fast.reobserve(task); }
  readPage(task: BrowserTask, options: PageReadOptions = {}): Promise<BrowserObservation> { return this.fast.observe(task, options); }
  resetObservation(task: BrowserTask): void { this.fast.resetSelection(task); task.observation = undefined; }
  async screenshot(task: BrowserTask, params: Record<string, unknown> = {}): Promise<any> {
    return (await this.fast.captureScreenshot(task, params)).result;
  }
  async observe(task: BrowserTask, screenshot = false, retainScreenshot = true): Promise<BrowserObservation> {
    let observation = await this.fast.reobserve(task);
    // A fresh background about:blank page may have no compositor frame on
    // Windows. Its empty DOM is sufficient; requesting an image can hang Chrome
    // until the task is incorrectly interrupted before its first navigation.
    if (screenshot && observation.url === "about:blank") {
      observation.snapshot += "\n当前是新建的空白任务页，没有可截图的内容。请根据任务打开目标网站。";
      return observation;
    }
    if (screenshot) {
      let result, visual;
      try {
        ({ result, visual } = await this.fast.captureScreenshot(task));
        // Capturing can wake a hidden renderer and replace its virtualized DOM.
        // Bind refs/version to that final page, never to the pre-capture list.
        observation = await this.fast.reobserve(task);
        if (JSON.stringify(await this.fast.visualState(task)) !== JSON.stringify(visual)) throw new Error("截图之后页面坐标已变化，无法绑定当前画面。");
      } catch (error) {
        const state = this.bridge.states().find(s => s.profileId === task.profileId);
        // Keep the successful DOM read when only the image is unavailable.
        // A real takeover, disconnect or session change still stops the task.
        if (!state?.connected || state.ownerSessionId !== task.sessionId || state.ownership !== "agent" || state.pausedByBrowser) throw error;
        observation = await this.fast.reobserve(task);
        observation.snapshot += "\n截图暂不可用。请根据本次读取的页面文字和控件继续；不能据此判断页面的视觉外观。";
        return observation;
      }
      observation.screenshotDataUrl = `data:image/png;base64,${result.data}`;
      Object.assign(observation.fast!, { visual });
      observation.viewport = { width: visual.width, height: visual.height, x: visual.x, y: visual.y, scrollWidth: visual.scrollWidth, scrollHeight: visual.scrollHeight };
      if (retainScreenshot) {
        const dir = taskArtifactDirectory(this.artifactRoot, task.id);
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
      if (action.kind === "uncheck" && candidate.role === "radio") throw new Error("已选中的单选项不能单独取消，请选择同组的其他选项。");
      await this.request(task, "preparePointer");
      return this.fast.execute(task, { ...action, kind: "click" });
    }
    if (action.kind === "open") {
      const url = new URL(action.value || "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("只支持不含凭据的 HTTP/HTTPS 页面。");
      try {
        const result = await this.request(task, "open", { url: url.href });
        if (result.errorText) throw new Error(result.errorText);
      } finally { this.resetObservation(task); }
    } else if (action.kind === "back") {
      const history = await this.raw(task, "Page.getNavigationHistory");
      const entry = history.entries?.[history.currentIndex - 1];
      if (!entry) throw new Error("当前标签页没有可返回的历史页面。");
      await this.raw(task, "Page.navigateToHistoryEntry", { entryId: entry.id });
      this.resetObservation(task);
    } else if (action.kind === "switch_tab" || action.kind === "close_tab") {
      if (!/^\d{1,10}$/.test(action.value || "")) throw new Error("请选择标签页列表中的编号。");
      await this.request(task, action.kind === "switch_tab" ? "switch" : "closeTab", { tabId: Number(action.value) });
      this.fast.forget(task); task.observation = undefined;
    } else if (action.kind === "press") {
      const match = /^(?:(Control|Meta)\+)?(Enter|Return|Tab|Escape|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Space|Backspace|Delete|a)$/i.exec(action.value || "");
      if (!match || (match[1] && !/^(a|Enter|Return)$/i.test(match[2])) || (!match[1] && /^a$/i.test(match[2]))) throw new Error("不支持该按键。");
      const keys: Record<string, [string, number]> = { enter: ["Enter", 13], return: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], arrowdown: ["ArrowDown", 40], arrowup: ["ArrowUp", 38], arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39], space: [" ", 32], backspace: ["Backspace", 8], delete: ["Delete", 46], a: ["a", 65] };
      const [key, windowsVirtualKeyCode] = keys[match[2].toLowerCase()];
      const params = { key, code: key === " " ? "Space" : key === "a" ? "KeyA" : key, windowsVirtualKeyCode, modifiers: match[1]?.toLowerCase() === "control" ? 2 : match[1] ? 4 : 0 };
      await this.fast.press(task, action, { ...params, ...(!match[1] && key === "Enter" ? { text: "\r" } : !match[1] && key === " " ? { text: " " } : {}) });
    } else if (action.kind === "upload") {
      const file = [...task.attachments, ...(task.outputs || [])].find(f => f.id === action.attachmentId);
      if (!file) throw new Error("只能上传当前任务明确选择的附件。");
      await this.assertFresh(task);
      const ref = action.ref?.replace(/^@/, "");
      if (!task.observation?.fast?.candidates.some(c => c.ref === ref && c.role === "fileupload")) throw new Error("请选择观察结果中的文件上传控件。");
      const { result, frame } = await this.fast.node(task, ref!, "node => node", false);
      const objectId = result?.objectId;
      if (!objectId) throw new Error("上传控件已失效。");
      try { await this.raw(task, "DOM.setFileInputFiles", { objectId, files: [file.path] }, frame.session); }
      finally { await this.raw(task, "Runtime.releaseObject", { objectId }, frame.session).catch(() => {}); }
    } else if (action.kind === "download") {
      return JSON.stringify(await this.download(task, { ref: action.ref, filename: action.value }));
    }
    return "操作已执行；请重新观察确认结果。";
  }
  private async assertFresh(task: BrowserTask): Promise<void> {
    await this.fast.assertFresh(task);
  }
  async download(task: BrowserTask, input: NativeDownloadInput): Promise<{ download: NativeDownloadItem; file?: import("../../shared/tasks").TaskAttachment }> {
    const operation = input.operation || "start", timeoutMs = input.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("下载等待时间必须在 1–300000 毫秒内。");
    if (input.filename && (input.filename !== path.win32.basename(input.filename) || input.filename !== path.posix.basename(input.filename) || /[<>:"|?*\x00-\x1f]|[. ]$/.test(input.filename) || input.filename === "." || input.filename === ".." || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(input.filename))) throw new Error("下载文件名无效，请使用不含路径的文件名。");
    if (operation === "search" || operation === "cancel") return { download: await this.request(task, `downloads.${operation}`, { id: input.id, token: input.token }) };
    let id = input.id, token = input.token;
    if (operation === "start") {
      let url = input.url;
      if (input.ref) {
        const { result } = await this.fast.node(task, input.ref, "node => node?.tagName === 'A' ? node.href : undefined");
        if (typeof result === "string" && /^https?:/i.test(result)) url = result;
      }
      if (url) {
        if (!/^https?:/i.test(url)) throw new Error("显式下载 URL 必须为 HTTP(S)；blob/data 链接需用页面引用触发下载。");
        const parsed = new URL(url);
        if (parsed.username || parsed.password) throw new Error("下载 URL 不能包含凭据。");
        const item: NativeDownloadItem = await this.request(task, "downloads.start", { url, filename: input.filename });
        id = item.id;
      } else {
        if (!input.ref) throw new Error("下载需要明确 URL 或页面控件引用。");
        const armed = await this.request(task, "downloads.arm", { frameId: this.fast.frameId(task) });
        token = armed.token;
        try {
          await this.request(task, "preparePointer");
          await this.fast.execute(task, { kind: "click", ref: input.ref, effect: "read", summary: "触发已登记的下载监听" });
        } catch (error) { await this.request(task, "downloads.disarm", { token }).catch(() => {}); throw error; }
      }
    }
    if (id === undefined && !token) throw new Error("等待下载需要 download id 或监听 token。");
    try {
      const item: NativeDownloadItem = await this.request(task, "downloads.wait", { id, token, timeoutMs }, timeoutMs + 5000);
      const file = await registerNativeDownload(this.artifactRoot, task, item);
      if (token) await this.request(task, "downloads.disarm", { token }).catch(() => {});
      return { download: item, file };
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}（download id=${id ?? "待关联"}${token ? `, token=${token}` : ""}；请查询或等待现有下载，不要重复触发。）`);
    }
  }
  async pointer(task: BrowserTask, input: { kind: "click" | "hover"; x: number; y: number; version: string }): Promise<string> {
    const visual = (task.observation?.fast as (NonNullable<BrowserObservation["fast"]> & { visual?: any }) | undefined)?.visual;
    if (!task.observation || task.observation.version !== input.version || !visual) throw new Error("指针操作需要当前观察的截图和 version。");
    const viewport = task.observation.viewport;
    if (!viewport || !Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= viewport.width || input.y >= viewport.height) throw new Error("指针坐标超出截图视口。");
    await this.request(task, "preparePointer");
    await this.fast.pointer(task, input, visual);
    return "指针操作已执行；请重新观察确认结果。";
  }
  dispose(): void { this.stopEvents(); }
  controlGeneration(task: BrowserTask): string {
    const state = this.bridge.states().find(s => s.profileId === task.profileId);
    if (!state?.connected) throw new NativeControlError("NATIVE_DISCONNECTED", "扩展断线；请检查 status，不会自动恢复或重放。");
    if (!state.taskTabs || !state.controlGeneration) throw new NativeControlError("NATIVE_EXTENSION_UPDATE_REQUIRED", "当前扩展缺少停止代次保护，请更新并重新加载 ProfilePilot 扩展后再显式恢复任务；停止和结束仍可使用。");
    return state.controlGeneration;
  }
  async control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release", expectedGeneration?: string): Promise<void> {
    this.fast.forget(task);
    const state = this.bridge.states().find(s => s.profileId === task.profileId);
    // A disconnected extension already stopped input. Completing locally must not
    // reacquire it or unexpectedly resume Chrome on the next connection.
    if (!state?.connected && action !== "resume") return;
    const generation = action === "resume" ? expectedGeneration ?? this.controlGeneration(task) : undefined;
    const request = () => {
      if (action === "resume" && this.controlGeneration(task) !== generation) throw new NativeControlError("NATIVE_USER_IN_CONTROL", "用户已停止或接管，排队恢复已取消；请核查控制状态。");
      return this.bridge.request(task.profileId, "control", { sessionId: task.sessionId, action, ...(generation ? { controlGeneration: generation } : {}) });
    };
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
  readPage(task: BrowserTask, options: PageReadOptions): Promise<BrowserObservation> {
    const browser = this.route(task);
    if (!browser.readPage) throw new Error("此浏览器连接不支持分页读取。");
    return browser.readPage(task, options);
  }
  execute(task: BrowserTask, action: BrowserAction): Promise<string> { return this.route(task).execute(task, action); }
  tabs(task: BrowserTask): Promise<unknown> { return this.route(task).tabs(task); }
  control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release"): Promise<void> { return this.route(task).control(task, action); }
}
