// Raw Bridge is a deliberately bounded API, not a forward-compatible CDP
// tunnel. New protocol methods require review before they become callable.
const RAW_ALLOWED_METHODS = new Set([
  "DOM.enable", "DOM.disable", "DOM.getDocument", "DOM.getFlattenedDocument",
  "DOM.describeNode", "DOM.querySelector", "DOM.querySelectorAll", "DOM.getAttributes",
  "DOM.getOuterHTML", "DOM.getBoxModel", "DOM.getContentQuads", "DOM.getNodeForLocation",
  "DOM.requestNode", "DOM.resolveNode", "DOM.requestChildNodes", "DOM.focus",
  "DOM.scrollIntoViewIfNeeded", "DOM.setAttributeValue", "DOM.setAttributesAsText",
  "DOM.removeAttribute", "DOM.setNodeValue", "DOM.setOuterHTML", "DOM.setFileInputFiles",
  "DOM.performSearch", "DOM.getSearchResults", "DOM.discardSearchResults",
  "Emulation.canEmulate", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled", "Emulation.setUserAgentOverride", "Emulation.setVisibleSize",
  "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.dispatchTouchEvent",
  "Input.insertText", "Input.imeSetComposition", "Input.synthesizeTapGesture",
  "Input.synthesizeScrollGesture", "Input.synthesizePinchGesture",
  "Page.enable", "Page.disable", "Page.navigate", "Page.navigateToHistoryEntry", "Page.reload",
  "Page.stopLoading", "Page.getNavigationHistory", "Page.getFrameTree", "Page.getResourceTree",
  "Page.getResourceContent", "Page.searchInResource", "Page.getLayoutMetrics",
  "Page.captureScreenshot", "Page.printToPDF", "Page.bringToFront", "Page.handleJavaScriptDialog",
  "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument",
  "Page.setLifecycleEventsEnabled",
  "Runtime.enable", "Runtime.disable", "Runtime.evaluate", "Runtime.callFunctionOn",
  "Runtime.getProperties", "Runtime.releaseObject", "Runtime.releaseObjectGroup",
  "Runtime.awaitPromise", "Runtime.compileScript", "Runtime.runScript",
  "Runtime.addBinding", "Runtime.removeBinding", "Runtime.runIfWaitingForDebugger",
  "Target.getTargets", "Target.getTargetInfo", "Target.createTarget", "Target.activateTarget",
  "Target.attachToTarget", "Target.detachFromTarget", "Target.setAutoAttach", "Target.setDiscoverTargets",
  "Network.enable", "Network.disable", "Network.getResponseBody", "Network.getRequestPostData",
  "Network.searchInResponseBody", "Network.getCertificate", "Network.getSecurityIsolationStatus",
  "Network.setExtraHTTPHeaders", "Network.setCacheDisabled", "Network.setBypassServiceWorker"
]);

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

// Rust's canonicalize() produces extended Windows paths. Chromium's download
// manager expects a regular drive/UNC path and otherwise cancels the download.
// Preserve the destination; this does not grant additional CDP permissions.
export function chromiumDownloadParams(params: Record<string, unknown>, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  if (platform !== "win32" || typeof params.downloadPath !== "string") return params;
  const value = params.downloadPath;
  if (value.startsWith("\\\\?\\UNC\\")) return { ...params, downloadPath: "\\\\" + value.slice(8) };
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return { ...params, downloadPath: value.slice(4) };
  return params;
}

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

const AGENT_TARGET_INTERACTION_METHODS = new Set([
  "DOM.focus",
  "DOM.setAttributeValue",
  "DOM.setAttributesAsText",
  "DOM.setFileInputFiles",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload"
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
  return normalized === method && RAW_ALLOWED_METHODS.has(normalized);
}

export function isAgentTargetActivityMethod(method: string): boolean {
  if (!method || method.startsWith("Browser.") || method.startsWith("Target.")) {
    return false;
  }
  return !AGENT_PASSIVE_TARGET_METHODS.has(method);
}

export function isAgentTargetInteractionMethod(method: string): boolean {
  return Boolean(
    method && (
      method.startsWith("Input.") ||
      AGENT_TARGET_INTERACTION_METHODS.has(method)
    )
  );
}
