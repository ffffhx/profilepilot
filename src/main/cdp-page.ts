import { CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo } from "./cdp-client";
import { sleep } from "./fs-util";
import { CdpTargetListEntry } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export async function openInspectablePageOverCdp(port: number, url: string): Promise<CdpBrowserClient> {
  let target = await firstPageTarget(port);
  if (!target) {
    const version = await requestCdpVersionInfo(port);
    if (!version.webSocketDebuggerUrl) {
      throw new ProfileManagerError("临时 Chrome 没有返回 browser WebSocket 地址。", "CDP_NOT_READY");
    }
    const browserClient = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, 3000);
    try {
      await browserClient.send("Target.createTarget", { url: "about:blank" }, 5000);
    } finally {
      browserClient.close();
    }
    target = await waitForFirstPageTarget(port, 5000);
  }

  if (!target.webSocketDebuggerUrl) {
    throw new ProfileManagerError("临时 Chrome 页面没有返回 WebSocket 地址。", "CDP_NOT_READY");
  }

  const pageClient = await CdpBrowserClient.connect(target.webSocketDebuggerUrl, 5000);
  try {
    await pageClient.send("Page.enable", {}, 5000);
    await pageClient.send("Page.navigate", { url }, 5000);
    await waitForPageUrl(port, url, 5000);
    await sleep(500);
    return pageClient;
  } catch (error) {
    pageClient.close();
    throw error;
  }
}

export async function firstPageTarget(port: number): Promise<CdpTargetListEntry | null> {
  const targets = await requestCdpTargets(port).catch(() => []);
  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl) || null;
}

export async function waitForFirstPageTarget(port: number, timeoutMs: number): Promise<CdpTargetListEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await firstPageTarget(port);
    if (target) {
      return target;
    }
    await sleep(100);
  }
  throw new ProfileManagerError("临时 Chrome 没有创建可调试页面。", "CDP_NOT_READY");
}

export async function waitForPageUrl(port: number, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await requestCdpTargets(port).catch(() => []);
    if (targets.some((target) => target.type === "page" && target.url === url)) {
      return;
    }
    await sleep(100);
  }
}

export async function snapshotRestorableTabUrls(port: number): Promise<string[]> {
  const targets = await requestCdpTargets(port);
  return targets
    .filter((target) => target.type === "page")
    .map((target) => target.url || "")
    .filter(isRestorableTabUrl);
}

export function isRestorableTabUrl(url: string): boolean {
  const trimmed = url.trim();
  if (
    !trimmed ||
    trimmed === "about:blank" ||
    trimmed.startsWith("chrome://newtab") ||
    trimmed.startsWith("chrome://new-tab-page") ||
    trimmed.startsWith("devtools://") ||
    trimmed.startsWith("chrome-error://")
  ) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "file:", "chrome:", "chrome-extension:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function appendUniqueExtraUrls(baseUrls: string[], extraUrls: string[]): string[] {
  const urls = [...baseUrls];
  const seen = new Set(baseUrls);
  for (const url of extraUrls) {
    if (!seen.has(url)) {
      urls.push(url);
      seen.add(url);
    }
  }
  return urls;
}

export async function bringCdpPageToFront(port: number): Promise<boolean> {
  let target = await firstPageTarget(port);
  if (!target) {
    const version = await requestCdpVersionInfo(port);
    if (!version.webSocketDebuggerUrl) {
      return false;
    }
    const browserClient = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, 3000);
    try {
      await browserClient.send("Target.createTarget", { url: "about:blank" }, 5000);
    } finally {
      browserClient.close();
    }
    target = await waitForFirstPageTarget(port, 5000).catch(() => null);
  }

  if (!target?.webSocketDebuggerUrl) {
    return false;
  }

  const pageClient = await CdpBrowserClient.connect(target.webSocketDebuggerUrl, 3000);
  try {
    await pageClient.send("Page.bringToFront", {}, 5000);
    return true;
  } finally {
    pageClient.close();
  }
}

export async function loadUnpackedExtensionsOverCdp(port: number, extensionPaths: string[]): Promise<void> {
  if (!extensionPaths.length) {
    return;
  }

  const version = await requestCdpVersionInfo(port);
  if (!version.webSocketDebuggerUrl) {
    throw new ProfileManagerError("目标 Profile 的 CDP 没有返回 browser WebSocket 地址。", "CDP_NOT_READY");
  }

  const client = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, 5000);
  try {
    for (const extensionPath of extensionPaths) {
      await client.send("Extensions.loadUnpacked", { path: extensionPath }, 15000);
    }
  } finally {
    client.close();
  }
}
