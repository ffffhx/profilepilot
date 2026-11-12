import type { NativeBrowserServiceState, NativeBrowserState } from "../shared/browser-connection";

export interface NativeConnectionPresentation {
  label: string;
  status: string;
  message: string;
  tone: "pending" | "ready" | "blocked";
  ready: boolean;
}

/** Connection, compatibility and task control are separate facts. Installation
 * receipts must never override the live connection or imply permission to act. */
export function nativeConnectionPresentation(browser?: NativeBrowserState, service?: NativeBrowserServiceState): NativeConnectionPresentation {
  const result = (label: string, status: string, message: string, tone: NativeConnectionPresentation["tone"] = "blocked", ready = false) => ({ label, status, message, tone, ready });
  if (service?.status === "disconnected") return result("工具端未连接", "工具端与浏览器服务未连接", "ProfilePilot 暂时无法连接本机浏览器服务，尚不能确认扩展是否在线。正在尝试恢复服务连接；可点击“检测连接”查看最新状态。");
  if (service?.status === "connecting") return result("工具端连接中", "正在连接本机浏览器服务", "正在读取浏览器服务状态，暂时无法判断扩展是否已连接。", "pending");
  if (!browser) return result("尚未配对", "尚未配对浏览器扩展", "此 Profile 尚无扩展配对记录。请在对应 Chrome Profile 中完成扩展安装与授权。");
  if (!browser.connected) return result("扩展未连接", "已配对 · 扩展当前未连接", `${service?.status === "connected" ? "工具端服务已连接；" : ""}扩展尚未连上本机浏览器服务，配对记录已保留。请确认对应 Chrome Profile 已打开且扩展已启用；仍未恢复时重新连接。`);
  if (!browser.taskTabs) {
    if (!browser.extensionVersion || !Array.isArray(browser.capabilities)) return result("已连接 · 待就绪", "已连接 · 正在确认扩展能力", "扩展已连上本机浏览器服务，正在等待扩展上报版本与可用能力。", "pending");
    return result("已连接 · 需更新", "已连接 · 请更新或重新加载扩展", "扩展已连上本机浏览器服务，但尚不支持当前控制要求。请加载配套版本并在 Chrome 扩展管理页重新加载扩展。");
  }
  if (browser.controlIssue) return result("已连接 · 操作中断", "已连接 · 浏览器操作中断", `扩展连接正常；${browser.controlIssue.message}`);
  if (browser.pausedByBrowser || browser.ownerSessionId && browser.ownership !== "agent") return result("已连接 · 操作已暂停", "已连接 · 已停止操作", "扩展连接正常，浏览器操作已暂停。只有明确交还控制后，原任务才能继续。", "ready", true);
  if (browser.ownerSessionId) return result("已连接 · 任务使用中", "已连接 · 任务使用中", "扩展连接正常，当前 Profile 正由任务使用。新任务需等待当前任务结束或交接。", "ready", true);
  return result("已连接", "已连接 · 可使用当前页", "连接已就绪，可在 Agent 中选择这个 Profile，或通过 ppilot browser 使用。", "ready", true);
}

export function nativeInstallationMessage(installation: { stage: string; message: string }, browser?: NativeBrowserState, service?: NativeBrowserServiceState): string {
  // A successful installation is historical. Live readiness and service outages
  // take priority over both success receipts and obsolete installation errors.
  if (installation.stage === "connected" || browser?.connected || service?.status === "disconnected" || service?.status === "connecting") {
    return nativeConnectionPresentation(browser, service).message;
  }
  return installation.message;
}
