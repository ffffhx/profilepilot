import { CdpLiveTab, CdpLiveView } from "../shared/types";
import { CdpBrowserClient, isValidCdpPort, requestCdpTargets } from "./cdp-client";
import { CdpTargetListEntry } from "./internal-types";

// 截图比较“贵”：连一个临时 WebSocket、抓一帧 JPEG。给它单独的超时，失败只降级成
// “有标签页、无截图”，绝不让实时观测整块挂掉。
const SCREENSHOT_CONNECT_TIMEOUT = 3000;
const SCREENSHOT_COMMAND_TIMEOUT = 4000;

interface CaptureLiveViewOptions {
  screenshot?: boolean;
  // 指定要展示/截图的标签页（targetId）；缺省用 /json/list 的第一个 page。
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
  // 选中要展示/截图的标签：优先调用方指定的 targetId（用户在 Cockpit 里点的那个），否则用第一个。
  const active = (options.targetId && pageTargets.find((target) => target.id === options.targetId)) || pageTargets[0] || null;
  const tabs: CdpLiveTab[] = pageTargets.map((target) => ({
    targetId: target.id || "",
    title: (target.title || "").trim() || "(无标题)",
    url: target.url || "",
    faviconUrl: target.faviconUrl || null,
    // 标记当前正在展示（被截图）的那个标签，前端据此高亮。
    primary: Boolean(active && target.id === active.id)
  }));

  let screenshot: string | null = null;
  let screenshotError: string | null = null;

  if (options.screenshot && active?.webSocketDebuggerUrl) {
    try {
      screenshot = await captureTargetScreenshot(active.webSocketDebuggerUrl);
    } catch (error) {
      screenshotError = describeError(error);
    }
  }

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
