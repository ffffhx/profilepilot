const RAW_ALLOWED_PREFIXES = [
  "DOM.",
  "Emulation.",
  "Input.",
  "Page.",
  "Runtime.",
  "Target.",
  "Network."
];

// These Target methods either create an opaque CDP channel, open a privileged
// browser session, or escape the managed Profile's target set.
export const AGENT_DENIED_TARGET_METHODS = new Set([
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Target.openDevTools",
  "Target.sendMessageToTarget",
  "Target.setRemoteLocations"
]);

// Native Chrome window geometry remains authoritative. Drivers receive a
// compatible virtual response for commands that would corrupt that geometry.
export const AGENT_VIRTUALIZED_VIEWPORT_METHODS = new Set([
  "Browser.setContentsSize",
  "Browser.setWindowBounds",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
  "Emulation.setVisibleSize"
]);

// Auto-attach initializes every tab. These methods do not prove that the Agent
// intentionally selected a page and therefore do not update the logical target.
const AGENT_PASSIVE_TARGET_METHODS = new Set([
  "Accessibility.disable",
  "Accessibility.enable",
  "DOM.disable",
  "DOM.enable",
  "Log.disable",
  "Log.enable",
  "Network.disable",
  "Network.enable",
  "Network.setBypassServiceWorker",
  "Network.setCacheDisabled",
  "Network.setExtraHTTPHeaders",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.disable",
  "Page.enable",
  "Page.getFrameTree",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.setLifecycleEventsEnabled",
  "Performance.disable",
  "Performance.enable",
  "Runtime.addBinding",
  "Runtime.disable",
  "Runtime.enable",
  "Runtime.removeBinding",
  "Runtime.runIfWaitingForDebugger",
  "Security.disable",
  "Security.enable"
]);

const RAW_DENIED_METHODS = new Set([
  "Browser.close",
  "Browser.setDownloadBehavior",
  "Network.clearBrowserCache",
  "Network.clearBrowserCookies",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Storage.clearDataForOrigin",
  "Storage.getCookies",
  "Target.closeTarget",
  ...AGENT_DENIED_TARGET_METHODS
]);

export interface GatewayDevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  maxTouchPoints: number;
  userAgent: string;
  platform: string;
}

export const GATEWAY_DEVICE_PRESETS: Readonly<Record<string, GatewayDevicePreset>> = Object.freeze({
  "iphone-16-pro": Object.freeze({
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    maxTouchPoints: 5,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone"
  })
});

export function isRawCdpMethodAllowed(method: string): boolean {
  const normalized = String(method || "").trim();
  return Boolean(
    normalized &&
      !RAW_DENIED_METHODS.has(normalized) &&
      RAW_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function isAgentTargetActivityMethod(method: string): boolean {
  if (!method || method.startsWith("Browser.") || method.startsWith("Target.")) {
    return false;
  }
  return !AGENT_PASSIVE_TARGET_METHODS.has(method);
}
