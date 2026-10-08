export const NATIVE_MIN_EXTENSION_VERSION = "0.2.0";
export const NATIVE_REQUIRED_CAPABILITIES = ["tabs", "cdp", "cdpSessions", "history", "downloads", "sidePanel"] as const;
export const NATIVE_EXTENSION_UPDATE_MESSAGE = "请更新或重新加载 ProfilePilot 扩展至 0.2.0 或更新版本，以启用当前页控制、跨 frame 调试及下载；已有配对会保留。";

interface ExtensionAdvertisement { taskTabs?: unknown; extensionVersion?: unknown; capabilities?: unknown; }

export function nativeProfileAvailability(state?: ExtensionAdvertisement & { connected?: boolean }): { ready: boolean; reason?: string; code?: string } {
  if (!state?.connected) return { ready: false, code: "NATIVE_EXTENSION_DISCONNECTED", reason: "请先连接此 Profile 的 ProfilePilot 扩展，再重试。" };
  if (!nativeExtensionReady(state)) return { ready: false, code: "NATIVE_EXTENSION_UPDATE_REQUIRED", reason: NATIVE_EXTENSION_UPDATE_MESSAGE };
  return { ready: true };
}

// Connection/authentication stays valid for old extensions. Executability needs
// both a compatible release and its advertised protocol, never taskTabs alone.
export function nativeExtensionReady(state: ExtensionAdvertisement): boolean {
  if (state.taskTabs !== true || typeof state.extensionVersion !== "string" || !Array.isArray(state.capabilities)) return false;
  if (!/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(state.extensionVersion)) return false;
  const actual = state.extensionVersion.split(".").map(Number);
  if (actual.some(part => part > 65535)) return false;
  const minimum = NATIVE_MIN_EXTENSION_VERSION.split(".").map(Number);
  const capabilities = state.capabilities;
  let versionMatches = true;
  for (let i = 0; i < 4; i++) {
    const difference = (actual[i] || 0) - (minimum[i] || 0);
    if (difference !== 0) { versionMatches = difference > 0; break; }
  }
  return versionMatches && NATIVE_REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability));
}
