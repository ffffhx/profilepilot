import { CdpLiveTab, CdpLiveView } from "../shared/types";
import { CdpBrowserClient, isValidCdpPort, requestCdpJson, requestCdpTargets } from "./cdp-client";
import { CdpTargetListEntry } from "./internal-types";

// 截图比较“贵”：连一个临时 WebSocket、抓一帧 JPEG。给它单独的超时，失败只降级成
// “有标签页、无截图”，绝不让实时观测整块挂掉。
const SCREENSHOT_CONNECT_TIMEOUT = 3000;
const SCREENSHOT_COMMAND_TIMEOUT = 4000;

interface CaptureLiveViewOptions {
  screenshot?: boolean;
  // 指定要展示/截图的标签页；缺省优先选择浏览器的活动标签页。
  targetId?: string;
}

// 对一个正在以 CDP 运行的 Profile 端口，抓一份“当前在飞哪”的实时快照：
// 打开的标签页（标题 / URL / favicon）+ 主标签页的一帧画面缩略图。
// 所有失败都被收敛进返回结构里（error / screenshotError），调用方永远拿到一个对象。
export async function captureCdpLiveView(port: number, options: CaptureLiveViewOptions = {}): Promise<CdpLiveView> {
  const capturedAt = new Date().toISOString();
  const base: CdpLiveView = {
    port,
    capturedAt,
    tabCount: 0,
    tabs: [],
    primaryTitle: null,
    primaryUrl: null,
    screenshot: null,
    screenshotError: null,
    error: null
  };

  if (!isValidCdpPort(port)) {
    return { ...base, error: "CDP 端口无效。" };
  }

  let targets: CdpTargetListEntry[];
  try {
    targets = await requestCdpTargets(port);
  } catch (error) {
    return { ...base, error: `读取 CDP 标签页失败：${describeError(error)}` };
  }

  const pageTargets = targets.filter((target) => target.type === "page" && Boolean(target.webSocketDebuggerUrl));
  const requested = pageTargets.find((target) => target.id === options.targetId);
  const activeId = !requested && pageTargets.length > 1 ? await findActivePageTarget(port).catch(() => null) : null;
  const selected = requested || pageTargets.find((target) => target.id === activeId);
  let active = selected || pageTargets[0] || null;

  let screenshot: string | null = null;
  let screenshotError: string | null = null;

  if (options.screenshot) {
    // Older Chromium versions may not expose the active tab. Restored/discarded
    // pages can report Internal error until rendered: try another live page only
    // in automatic mode, never substitute an explicitly selected/active page.
    const candidates = selected ? [selected] : pageTargets.slice(0, 5);
    for (const candidate of candidates) {
      try {
        screenshot = await captureTargetScreenshot(candidate.webSocketDebuggerUrl!);
        active = candidate;
        screenshotError = null;
        break;
      } catch (error) {
        const detail = describeError(error);
        screenshotError = detail === "Internal error"
          ? "此标签页尚未生成画面，页面恢复后会自动重试。"
          : `暂时无法获取画面：${detail}`;
        if (detail !== "Internal error") break;
      }
    }
  }

  const tabs: CdpLiveTab[] = pageTargets.map((target) => ({
    targetId: target.id || "",
    title: (target.title || "").trim() || "(无标题)",
    url: target.url || "",
    faviconUrl: target.faviconUrl || null,
    primary: Boolean(active && target.id === active.id)
  }));

  return {
    ...base,
    tabCount: tabs.length,
    tabs,
    primaryTitle: active ? (active.title || "").trim() || "(无标题)" : null,
    primaryUrl: active?.url || null,
    screenshot,
    screenshotError
  };
}

interface TargetInfo {
  targetId: string;
  type: string;
  subtype?: string;
  url?: string;
  browserContextId?: string;
  embedderData?: { tabActive?: boolean };
}

async function findActivePageTarget(port: number): Promise<string | null> {
  // Use the same authenticated Gateway observer as the capture, without claiming
  // an Agent session, activating a tab, or changing native window focus.
  const version = await requestCdpJson<{ webSocketDebuggerUrl: string }>(port, "/json/version");
  const client = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, SCREENSHOT_CONNECT_TIMEOUT);
  try {
    const result = await client.send<{ targetInfos?: TargetInfo[] }>("Target.getTargets", {
      filter: [{ type: "tab" }, { type: "page" }, { exclude: true }]
    }, 1500);
    const targets = result.targetInfos || [];
    for (const tab of targets.filter(target => target.type === "tab" && target.embedderData?.tabActive)) {
      const pages = targets.filter(target => target.type === "page" && !target.subtype &&
        target.url === tab.url && target.browserContextId === tab.browserContextId);
      // Duplicate URLs cannot identify a unique page. Leave selection automatic.
      if (pages.length === 1) return pages[0].targetId;
    }
    return null;
  } finally {
    client.close();
  }
}

async function captureTargetScreenshot(webSocketDebuggerUrl: string): Promise<string> {
  const client = await CdpBrowserClient.connect(webSocketDebuggerUrl, SCREENSHOT_CONNECT_TIMEOUT);
  try {
    const result = await client.send<{ data?: string }>(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 45, captureBeyondViewport: false },
      SCREENSHOT_COMMAND_TIMEOUT
    );
    const data = result?.data;
    if (!data) {
      throw new Error("CDP 没有返回截图数据。");
    }
    return `data:image/jpeg;base64,${data}`;
  } finally {
    client.close();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
