import { readFile } from "node:fs/promises";
import path from "node:path";
import { CdpBrowserClient } from "../cdp-client";
import { nativeChromeUserDataDir } from "../chrome-launch";
import { parseNativeDebugEndpoint } from "../tasks/native-installer";
import type { NativeEvent } from "../tasks/native-bridge";
import { NativeControlError } from "./errors";

export const ALLOWED_BROWSER_PROTOCOLS = new Set(["http:", "https:", "chrome-extension:", "chrome:"]);
export const PRIVILEGED_BROWSER_PROTOCOLS = new Set(["chrome-extension:", "chrome:"]);

export function parseAllowedBrowserUrl(raw: unknown, method = "open"): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new NativeControlError("NATIVE_INVALID_REQUEST", `${method} 需要有效的网址。`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NativeControlError("NATIVE_INVALID_REQUEST", `${method} 需要有效 URL（支持 http/https/chrome-extension/chrome）。`);
  }
  if (!ALLOWED_BROWSER_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    throw new NativeControlError("NATIVE_INVALID_REQUEST", `${method} 只支持不含凭据的 HTTP/HTTPS、chrome-extension:// 或 chrome:// 页面。`);
  }
  return url;
}

export function isPrivilegedBrowserUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    return PRIVILEGED_BROWSER_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export interface BrowserCdpRouterOptions {
  endpoint?: () => Promise<string>;
  connect?: typeof CdpBrowserClient.connect;
  connectTimeoutMs?: number;
}

interface AttachedTarget {
  sessionId: string;
  profileId: string;
  targetId: string;
  pageSessionId: string;
  virtualTabId: number;
  url: string;
  title?: string;
  childSessions: Map<string, { parentSessionId?: string }>;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Keeps one persistent browser-level CDP WebSocket (via Chrome's DevToolsActivePort)
 * alive across sessions and transparently routes chrome-extension:// and chrome://
 * pages through full CDP so NativeBrowser's observe/action/screenshot/cdp work
 * identically to normal HTTP(S) pages without extension debugger restrictions.
 */
export class NativeBrowserCdpRouter {
  private client?: CdpBrowserClient;
  private connecting?: Promise<CdpBrowserClient>;
  private readonly targets = new Map<string, AttachedTarget>();
  private readonly listeners = new Set<(event: NativeEvent) => void>();

  constructor(private readonly options: BrowserCdpRouterOptions = {}) {}

  onEvent(listener: (event: NativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: NativeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Listener errors must not break CDP event dispatch. */ }
    }
  }

  has(sessionId: string): boolean {
    return this.targets.has(sessionId);
  }

  targetInfo(sessionId: string): { targetId: string; url: string; title?: string; tabId: number } | undefined {
    const t = this.targets.get(sessionId);
    if (!t) return undefined;
    return { targetId: t.targetId, url: t.url, title: t.title, tabId: t.virtualTabId };
  }

  isConnected(): boolean {
    return Boolean(this.client);
  }

  private async resolveEndpoint(): Promise<string> {
    try {
      if (this.options.endpoint) return await this.options.endpoint();
      const portFile = path.join(nativeChromeUserDataDir(), "DevToolsActivePort");
      return parseNativeDebugEndpoint(await readFile(portFile, "utf8"));
    } catch (error) {
      if (error instanceof NativeControlError) throw error;
      throw new NativeControlError(
        "NATIVE_EXTENSION_UI_NOT_READY",
        "打开或操作 chrome-extension:// / chrome:// 页面需要浏览器级 CDP。请先在 Chrome 打开 chrome://inspect/#remote-debugging 并开启远程调试后重试。"
      );
    }
  }

  private async ensureClient(): Promise<CdpBrowserClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const connectAttempt = (async () => {
      const endpoint = await this.resolveEndpoint();
      const connectFn = this.options.connect || CdpBrowserClient.connect;
      const timeoutMs = this.options.connectTimeoutMs ?? 60000;
      let client: CdpBrowserClient;
      try {
        client = await connectFn(endpoint, timeoutMs);
      } catch (error) {
        if (error instanceof NativeControlError) throw error;
        throw new NativeControlError(
          "NATIVE_EXTENSION_UI_NOT_READY",
          `无法建立浏览器级 CDP 连接（请在 Chrome 弹出的远程调试授权框中点击允许，或确认 chrome://inspect/#remote-debugging 已开启）：${error instanceof Error ? error.message : String(error)}`
        );
      }
      client.onEvent = (method, params, cdpSessionId) => this.handleCdpEvent(method, params, cdpSessionId);
      client.onDisconnect = () => {
        if (this.client === client) this.client = undefined;
        const dropped = [...this.targets.values()];
        this.targets.clear();
        for (const t of dropped) {
          this.emit({ type: "cdp", profileId: t.profileId, sessionId: t.sessionId, tabId: t.virtualTabId, method: "ProfilePilot.debuggerReconnected" });
        }
      };
      this.client = client;
      return client;
    })();

    this.connecting = connectAttempt;
    try {
      return await connectAttempt;
    } finally {
      if (this.connecting === connectAttempt) this.connecting = undefined;
    }
  }

  private findTargetByCdpSession(cdpSessionId?: string): AttachedTarget | undefined {
    if (!cdpSessionId) return undefined;
    for (const target of this.targets.values()) {
      if (target.pageSessionId === cdpSessionId || target.childSessions.has(cdpSessionId)) return target;
    }
    return undefined;
  }

  private handleCdpEvent(method: string, params: any, cdpSessionId?: string): void {
    if (!cdpSessionId && method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      for (const [sid, t] of this.targets) {
        if (t.pageSessionId === params.sessionId) {
          this.targets.delete(sid);
          this.emit({ type: "cdp", profileId: t.profileId, sessionId: t.sessionId, tabId: t.virtualTabId, method: "ProfilePilot.debuggerReconnected" });
        }
      }
      return;
    }
    const target = this.findTargetByCdpSession(cdpSessionId);
    if (!target) return;

    const relativeSessionId = cdpSessionId === target.pageSessionId ? undefined : cdpSessionId;

    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && typeof params?.sessionId === "string") {
      target.childSessions.set(params.sessionId, { parentSessionId: relativeSessionId });
    } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      const drop = (sid: string) => {
        for (const [child, info] of target.childSessions) {
          if (info.parentSessionId === sid) drop(child);
        }
        target.childSessions.delete(sid);
      };
      drop(params.sessionId);
    } else if (method === "Page.frameNavigated" && !relativeSessionId && params?.frame && !params.frame.parentId && typeof params.frame.url === "string") {
      target.url = params.frame.url;
    } else if (method === "Page.navigatedWithinDocument" && !relativeSessionId && typeof params?.url === "string") {
      target.url = params.url;
    }

    this.emit({
      type: "cdp",
      profileId: target.profileId,
      sessionId: target.sessionId,
      tabId: target.virtualTabId,
      ...(relativeSessionId ? { cdpSessionId: relativeSessionId } : {}),
      method,
      params
    });
  }

  private async waitForSettle(client: CdpBrowserClient, pageSessionId: string, timeoutMs = 4000): Promise<{ url?: string; title?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const evaluated = await client.send<{ result?: { value?: { readyState?: string; url?: string; title?: string } } }>(
          "Runtime.evaluate",
          { expression: "({ readyState: document.readyState, url: location.href, title: document.title })", returnByValue: true },
          2000,
          pageSessionId
        );
        const info = evaluated?.result?.value;
        if (info && info.readyState && info.readyState !== "loading") {
          return { url: info.url, title: info.title };
        }
      } catch {
        // Target may still be initializing its execution context.
      }
      await delay(100);
    }
    return {};
  }

  async open(
    profileId: string,
    sessionId: string,
    url: string,
    virtualTabId: number,
    options: { newTab?: boolean } = {}
  ): Promise<{ targetId: string; url: string; title?: string; transport: "browser-cdp" }> {
    const client = await this.ensureClient();
    const existing = this.targets.get(sessionId);

    if (existing && !options.newTab) {
      try {
        const nav = await client.send<{ frameId?: string; errorText?: string }>("Page.navigate", { url }, 15000, existing.pageSessionId);
        if (nav?.errorText) {
          throw new NativeControlError("NATIVE_BROWSER_ERROR", `导航失败：${nav.errorText}`);
        }
        existing.url = url;
        existing.childSessions.clear();
        const settled = await this.waitForSettle(client, existing.pageSessionId);
        if (settled.url) existing.url = settled.url;
        if (settled.title) existing.title = settled.title;
        this.emit({ type: "cdp", profileId, sessionId, tabId: existing.virtualTabId, method: "ProfilePilot.debuggerReconnected" });
        return { targetId: existing.targetId, url: existing.url, title: existing.title, transport: "browser-cdp" };
      } catch (error) {
        if (error instanceof NativeControlError) throw error;
        // Existing target may have been closed by the user; recreate cleanly below.
        this.targets.delete(sessionId);
      }
    } else if (existing && options.newTab) {
      await this.detach(sessionId);
    }

    let created: { targetId: string };
    try {
      created = await client.send<{ targetId: string }>("Target.createTarget", { url, background: true }, 15000);
    } catch {
      created = await client.send<{ targetId: string }>("Target.createTarget", { url }, 15000);
    }
    if (!created?.targetId) {
      throw new NativeControlError("NATIVE_BROWSER_ERROR", "浏览器级 CDP 未返回新标签页目标。");
    }

    const attached = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: created.targetId, flatten: true },
      15000
    );
    const pageSessionId = attached.sessionId;

    const target: AttachedTarget = {
      sessionId,
      profileId,
      targetId: created.targetId,
      pageSessionId,
      virtualTabId,
      url,
      childSessions: new Map()
    };
    this.targets.set(sessionId, target);

    await client.send("Page.enable", {}, 5000, pageSessionId).catch(() => {});
    const settled = await this.waitForSettle(client, pageSessionId);
    if (settled.url) target.url = settled.url;
    if (settled.title) target.title = settled.title;

    this.emit({ type: "cdp", profileId, sessionId, tabId: target.virtualTabId, method: "ProfilePilot.debuggerReconnected" });
    return { targetId: target.targetId, url: target.url, title: target.title, transport: "browser-cdp" };
  }

  async sendCdp(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
    cdpSessionId?: string,
    timeoutMs = 15000
  ): Promise<any> {
    const target = this.targets.get(sessionId);
    if (!target || !this.client) {
      throw new NativeControlError("NATIVE_DISCONNECTED", "浏览器级 CDP 目标已断开，请重新打开页面。");
    }
    if (method === "ProfilePilot.getFrameSessions") {
      if (cdpSessionId) {
        throw Object.assign(new Error("子 frame 调试会话已失效；请重新发现当前标签页的 frame 并重新观察，不要重放输入。"), { code: "NATIVE_FRAME_SESSION_STALE" });
      }
      return {
        tabId: target.virtualTabId,
        sessions: [...target.childSessions].map(([id, info]) => ({
          sessionId: id,
          ...(info.parentSessionId ? { parentSessionId: info.parentSessionId } : {})
        }))
      };
    }
    if (cdpSessionId && !target.childSessions.has(cdpSessionId)) {
      throw Object.assign(new Error("子 frame 调试会话已失效；请重新发现当前标签页的 frame 并重新观察，不要重放输入。"), { code: "NATIVE_FRAME_SESSION_STALE" });
    }
    const wireSession = cdpSessionId || target.pageSessionId;
    return this.client.send(method, params, timeoutMs, wireSession);
  }

  async handleDialog(sessionId: string, accept: boolean, promptText?: string): Promise<{ handled: true; accept: boolean }> {
    await this.sendCdp(
      sessionId,
      "Page.handleJavaScriptDialog",
      { accept, ...(typeof promptText === "string" ? { promptText } : {}) }
    );
    return { handled: true, accept };
  }

  /** Detach a single session's page target while keeping the persistent browser WebSocket alive. */
  async detach(sessionId: string): Promise<void> {
    const target = this.targets.get(sessionId);
    if (!target) return;
    this.targets.delete(sessionId);
    if (this.client) {
      await this.client.send("Target.detachFromTarget", { sessionId: target.pageSessionId }, 3000).catch(() => {});
    }
    this.emit({ type: "cdp", profileId: target.profileId, sessionId: target.sessionId, tabId: target.virtualTabId, method: "ProfilePilot.debuggerReconnected" });
  }

  /** Close the persistent browser WebSocket on service shutdown. */
  close(): void {
    this.targets.clear();
    if (this.client) {
      this.client.onEvent = null;
      this.client.onDisconnect = null;
      this.client.close();
      this.client = undefined;
    }
  }
}
