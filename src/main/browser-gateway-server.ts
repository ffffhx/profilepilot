import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  BrowserGatewayControlError,
  BrowserGatewayControlPlane,
  type GatewayConnectionIdentity,
  type GatewayControlEvent
} from "./browser-gateway-control";
import type { GatewayCdpBackend } from "./browser-gateway-transport";
import { GatewayWebSocketPeer } from "./browser-gateway-websocket";

const RAW_ALLOWED_PREFIXES = ["DOM.", "Emulation.", "Input.", "Page.", "Runtime.", "Target.", "Network."];
// These Target methods either create a CDP channel whose nested commands are
// invisible to the Gateway, open a privileged browser-level CDP session, or
// escape the managed Profile's target set. Keep this policy shared by the
// Agent WebSocket and raw-cdp entry points so neither path can bypass it.
const AGENT_DENIED_TARGET_METHODS = new Set([
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Target.openDevTools",
  "Target.sendMessageToTarget",
  "Target.setRemoteLocations"
]);
// agent-browser applies a synthetic viewport to every connected page. That is
// useful in a managed/headless browser, but a real Chrome Profile has a native
// window that the user can reveal at any time. Forwarding these commands leaves
// the page rendered into an emulated rectangle (with outerWidth/outerHeight=0),
// so the rest of the native Chrome content area becomes blank and fixed overlays
// can be positioned outside the visible window. Keep the real Profile's viewport
// authoritative while returning a compatible empty success response to the Agent.
const AGENT_VIRTUALIZED_VIEWPORT_METHODS = new Set([
  "Browser.setContentsSize",
  "Browser.setWindowBounds",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setVisibleSize"
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
const MAX_PENDING_REQUESTS = 10_000;
const MAX_PARKED_EVENTS = 20_000;
const MAX_PARKED_EVENT_BYTES = 16 * 1024 * 1024;

interface GatewayRoute {
  publicPort: number;
  backend: GatewayCdpBackend;
  server: Server;
  connections: Set<GatewayConnection>;
  pending: Map<number, PendingRequest>;
  targetBySession: Map<string, string>;
  targetByCdpSession: Map<string, GatewayCdpSessionBinding>;
  internalCdpSessionIds: Set<string>;
  trustedAttachTargets: Map<string, number>;
  targetIntentBySession: Map<string, number>;
  targetCommitIntentBySession: Map<string, number>;
  nextBackendId: number;
  nextTargetIntent: number;
  removeBackendMessage: () => void;
  removeBackendClose: () => void;
}

interface GatewayConnection {
  id: string;
  identity: GatewayConnectionIdentity;
  peer: GatewayWebSocketPeer;
  targetSessionId?: string;
  childSessionIds: Set<string>;
  pendingAttachTargets: Map<string, number>;
  autoAttachEnabled: boolean;
  autoAttachIntent: number;
  // Playwright CLI / Chrome DevTools MCP 都是长驻驱动。用户接管时保留
  // WebSocket 和 CDP session，但封锁新命令与事件流；交还后原地恢复。
  quiescing: boolean;
  parked: boolean;
  parkedEvents: string[];
  parkedEventBytes: number;
}

interface GatewayCdpSessionBinding {
  targetId: string;
  connectionId: string;
  agentSessionId: string;
}

interface PendingRequest {
  kind: "client" | "raw";
  downstreamId?: number;
  connection?: GatewayConnection;
  resolve?: (result: unknown) => void;
  reject?: (error: Error) => void;
  timer?: NodeJS.Timeout;
  method?: string;
  params?: Record<string, unknown>;
  clientSessionId?: string;
  targetIntent?: number;
  autoAttachIntent?: number;
  previousAutoAttachEnabled?: boolean;
  internalAttachTargetId?: string;
  connectionClosed?: boolean;
}

export interface BrowserGatewayServerOptions {
  internalSecret: string;
  host?: string;
  onBackendClose?: (publicPort: number, error?: Error) => void;
  onAgentConnectionChange?: (publicPort: number, active: boolean) => void;
  onAgentTargetChange?: (publicPort: number) => void;
}

export interface GatewayAgentTarget {
  targetId: string;
  title: string;
  url: string;
}

export class BrowserGatewayServer {
  private readonly routes = new Map<number, GatewayRoute>();
  private readonly host: string;

  constructor(
    readonly control: BrowserGatewayControlPlane,
    private readonly options: BrowserGatewayServerOptions
  ) {
    this.host = options.host || "127.0.0.1";
  }

  async registerBackend(input: { publicPort: number; backend: GatewayCdpBackend }): Promise<void> {
    if (this.routes.has(input.publicPort)) {
      throw new Error(`Gateway port ${input.publicPort} is already registered`);
    }
    const server = http.createServer((request, response) => {
      void this.handleHttp(input.publicPort, request, response);
    });
    const route: GatewayRoute = {
      publicPort: input.publicPort,
      backend: input.backend,
      server,
      connections: new Set(),
      pending: new Map(),
      targetBySession: new Map(),
      targetByCdpSession: new Map(),
      internalCdpSessionIds: new Set(),
      trustedAttachTargets: new Map(),
      targetIntentBySession: new Map(),
      targetCommitIntentBySession: new Map(),
      nextBackendId: 1,
      nextTargetIntent: 1,
      removeBackendMessage: () => undefined,
      removeBackendClose: () => undefined
    };
    route.removeBackendMessage = input.backend.onMessage((message) => this.handleBackendMessage(route, message));
    route.removeBackendClose = input.backend.onClose((error) => this.handleBackendClose(route, error));
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(route, request, socket as Socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.host, port: input.publicPort });
    });
    this.routes.set(input.publicPort, route);
  }

  async unregisterBackend(publicPort: number, closeBackend = true): Promise<void> {
    const route = this.routes.get(publicPort);
    if (!route) return;
    this.routes.delete(publicPort);
    for (const connection of route.connections) connection.peer.close(1012, "gateway route closed");
    route.connections.clear();
    this.rejectPending(route, new Error("Gateway route closed"));
    route.removeBackendMessage();
    route.removeBackendClose();
    if (closeBackend) route.backend.close();
    await new Promise<void>((resolve) => {
      route.server.close(() => resolve());
      route.server.closeAllConnections?.();
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.routes.keys()].map((port) => this.unregisterBackend(port)));
  }

  hasActiveAgentConnection(publicPort: number, sessionId: string, daemonInstanceId: string): boolean {
    const route = this.routes.get(publicPort);
    return Boolean(route && [...route.connections].some((connection) =>
      connection.identity.kind === "agent" &&
      connection.identity.sessionId === sessionId &&
      connection.identity.daemonInstanceId === daemonInstanceId
    ));
  }

  async quiesceAgentSession(publicPort: number, sessionId: string, timeoutMs = 5_000): Promise<boolean> {
    const route = this.routes.get(publicPort);
    if (!route) return true;
    const connections = [...route.connections].filter((connection) =>
      connection.identity.kind === "agent" && connection.identity.sessionId === sessionId
    );
    if (!connections.length) return true;
    for (const connection of connections) connection.quiescing = true;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const hasPending = [...route.pending.values()].some((pending) =>
        pending.kind === "client" && pending.connection && connections.includes(pending.connection)
      );
      if (!hasPending) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    for (const connection of connections) connection.quiescing = false;
    return false;
  }

  cancelAgentQuiesce(publicPort: number, sessionId: string): void {
    const route = this.routes.get(publicPort);
    if (!route) return;
    for (const connection of route.connections) {
      if (connection.identity.kind === "agent" && connection.identity.sessionId === sessionId && !connection.parked) {
        connection.quiescing = false;
      }
    }
  }

  registeredPorts(): number[] {
    return [...this.routes.keys()].sort((a, b) => a - b);
  }

  async getAgentTarget(publicPort: number, sessionId: string, timeoutMs = 5_000): Promise<GatewayAgentTarget | null> {
    const route = this.routes.get(publicPort);
    if (!route) return null;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const targetId = route.targetBySession.get(sessionId);
      if (!targetId) return null;
      const committedIntent = route.targetCommitIntentBySession.get(sessionId);
      const remaining = Math.max(1, deadline - Date.now());
      const result = await this.sendRaw(route, "Target.getTargets", {}, remaining) as {
        targetInfos?: Array<Record<string, unknown>>;
      };
      const target = (result.targetInfos || []).find((candidate) => candidate.targetId === targetId);
      if (target?.type === "page") {
        return {
          targetId,
          title: typeof target.title === "string" ? target.title : "",
          url: typeof target.url === "string" ? target.url : ""
        };
      }
      if (route.targetBySession.get(sessionId) === targetId) {
        this.clearCommittedSessionTarget(route, sessionId, targetId, committedIntent);
        return null;
      }
      // The Agent selected a newer logical tab while Target.getTargets was in
      // flight. Retry that new mapping instead of clearing it with stale data.
    }
    return null;
  }

  async activateAgentTarget(
    publicPort: number,
    sessionId: string,
    controlGeneration: number,
    timeoutMs = 5_000
  ): Promise<GatewayAgentTarget> {
    const route = this.requireRoute(publicPort);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = await this.getAgentTarget(publicPort, sessionId, timeoutMs);
      if (!target) {
        const error = new Error("当前 Agent 还没有可显示的目标标签页") as Error & { code?: string };
        error.code = "AGENT_TARGET_NOT_FOUND";
        throw error;
      }
      this.assertActiveSession(publicPort, sessionId, controlGeneration);
      if (route.targetBySession.get(sessionId) !== target.targetId) continue;
      await this.activateTargetTrusted(route, target.targetId, timeoutMs);
      return target;
    }
    const error = new Error("Agent 正在切换标签页，请重试显示最新页面") as Error & { code?: string };
    error.code = "AGENT_TARGET_CHANGED";
    throw error;
  }

  async activateDelegatedAgentTarget(
    publicPort: number,
    sessionId: string,
    controlGeneration: number,
    timeoutMs = 5_000
  ): Promise<GatewayAgentTarget> {
    const route = this.requireRoute(publicPort);
    const targetId = route.targetBySession.get(sessionId);
    if (!targetId) {
      const error = new Error("当前 Agent 还没有可显示的目标标签页") as Error & { code?: string };
      error.code = "AGENT_TARGET_NOT_FOUND";
      throw error;
    }
    const result = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const target = (result.targetInfos || []).find((candidate) => candidate.targetId === targetId);
    if (!target || target.type !== "page") {
      this.clearSessionTarget(route, sessionId);
      const error = new Error(`页面 Target ${targetId} 不存在`) as Error & { code?: string };
      error.code = "AGENT_TARGET_NOT_FOUND";
      throw error;
    }

    // This check is intentionally immediately adjacent to sendRaw(). The daemon
    // serializes control transitions for a Session, and sendRaw synchronously
    // writes the trusted activation before yielding back to the event loop.
    this.assertDelegatedSession(publicPort, sessionId, controlGeneration);
    await this.activateTargetTrusted(route, targetId, timeoutMs);
    return {
      targetId,
      title: typeof target.title === "string" ? target.title : "",
      url: typeof target.url === "string" ? target.url : ""
    };
  }

  clearAgentTarget(publicPort: number, sessionId: string): void {
    const route = this.routes.get(publicPort);
    if (route) this.clearSessionTarget(route, sessionId);
  }

  handleControlEvent(event: GatewayControlEvent): void {
    if (event.type !== "connections-revoked") return;
    const route = this.routes.get(event.profile.publicPort);
    if (!route) return;
    for (const connection of [...route.connections]) {
      if (
        connection.identity.kind === "agent" &&
        connection.identity.profileId === event.profile.profileId
      ) {
        const resumable = event.profile.driverKind === "playwright-cli" ||
          event.profile.driverKind === "chrome-devtools-mcp";
        if (resumable && event.reason === "user_takeover") {
          connection.quiescing = false;
          connection.parked = true;
          connection.parkedEvents = [];
          connection.parkedEventBytes = 0;
          continue;
        }
        if (
          resumable &&
          event.reason === "user-return" &&
          event.profile.sessionStatus === "active" &&
          event.profile.ownership === "agent" &&
          event.profile.ownerSessionId === connection.identity.sessionId &&
          event.profile.daemonInstanceId === connection.identity.daemonInstanceId
        ) {
          connection.identity.controlGeneration = event.profile.controlGeneration;
          connection.quiescing = false;
          connection.parked = false;
          const buffered = connection.parkedEvents;
          connection.parkedEvents = [];
          connection.parkedEventBytes = 0;
          for (const message of buffered) connection.peer.sendText(message);
          continue;
        }
        connection.peer.close(4003, event.reason);
      }
    }
  }

  async callRaw(input: {
    publicPort: number;
    sessionId: string;
    daemonInstanceId: string;
    method: string;
    params?: Record<string, unknown>;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    if (!isRawCdpMethodAllowed(input.method)) {
      const error = new Error(`Raw CDP method denied: ${input.method}`) as Error & { code?: string };
      error.code = "RAW_CDP_METHOD_DENIED";
      throw error;
    }
    const profile = this.control.getProfile(input.publicPort);
    if (!profile) throw new Error(`Gateway port ${input.publicPort} is not registered`);
    const identity: GatewayConnectionIdentity = {
      sessionId: input.sessionId,
      profileId: profile.profileId,
      publicPort: input.publicPort,
      daemonInstanceId: input.daemonInstanceId,
      controlGeneration: profile.controlGeneration,
      kind: "agent"
    };
    const assertCurrent = (): void => {
      this.control.assertConnectionCanSend(identity);
    };
    assertCurrent();
    const route = this.requireRoute(input.publicPort);
    const timeoutMs = input.timeoutMs || 15_000;
    if (AGENT_VIRTUALIZED_VIEWPORT_METHODS.has(input.method)) {
      return {};
    }
    if (input.method === "Target.createTarget") {
      const intent = this.beginSessionTargetIntent(route, input.sessionId);
      try {
        const result = await this.sendRaw(
          route,
          input.method,
          agentBackgroundTargetParams(input.params),
          timeoutMs
        ) as Record<string, unknown> | null;
        assertCurrent();
        const targetId = typeof result?.targetId === "string" ? result.targetId : "";
        if (targetId) this.setSessionTargetIfCurrentIntent(route, input.sessionId, targetId, intent);
        else this.retireSessionTargetIntent(route, input.sessionId, intent);
        return result;
      } catch (error) {
        this.retireSessionTargetIntent(route, input.sessionId, intent);
        throw error;
      }
    }
    if (input.method === "Target.activateTarget") {
      const targetId = typeof input.params?.targetId === "string"
        ? input.params.targetId
        : typeof input.targetId === "string" ? input.targetId : "";
      const intent = this.beginSessionTargetIntent(route, input.sessionId);
      try {
        await this.assertPageTarget(route, targetId, timeoutMs);
        assertCurrent();
        this.setSessionTargetIfCurrentIntent(route, input.sessionId, targetId, intent);
        return {};
      } catch (error) {
        this.retireSessionTargetIntent(route, input.sessionId, intent);
        throw error;
      }
    }
    if (!rawMethodNeedsTarget(input.method)) {
      const intent = input.method === "Target.attachToTarget"
        ? this.beginSessionTargetIntent(route, input.sessionId)
        : undefined;
      let result: unknown;
      try {
        result = input.method === "Target.attachToTarget"
          ? await this.attachInternalTarget(
              route,
              typeof input.params?.targetId === "string" ? input.params.targetId : "",
              timeoutMs,
              input.params
            )
          : input.method === "Target.detachFromTarget" && typeof input.params?.sessionId === "string"
            ? await this.detachInternalTarget(route, input.params.sessionId, timeoutMs)
            : await this.sendRaw(route, input.method, input.params || {}, timeoutMs);
      } catch (error) {
        if (intent !== undefined) this.retireSessionTargetIntent(route, input.sessionId, intent);
        throw error;
      }
      try {
        assertCurrent();
      } catch (error) {
        const attachedSessionId = result && typeof result === "object" && "sessionId" in result && typeof result.sessionId === "string"
          ? result.sessionId
          : "";
        if (input.method === "Target.attachToTarget" && attachedSessionId) {
          await this.detachInternalTarget(route, attachedSessionId, Math.min(timeoutMs, 2_000)).catch(() => undefined);
        }
        if (intent !== undefined) this.retireSessionTargetIntent(route, input.sessionId, intent);
        throw error;
      }
      if (input.method === "Target.attachToTarget") {
        const targetId = typeof input.params?.targetId === "string" ? input.params.targetId : "";
        if (targetId && intent !== undefined) {
          this.setSessionTargetIfCurrentIntent(route, input.sessionId, targetId, intent);
        } else if (intent !== undefined) {
          this.retireSessionTargetIntent(route, input.sessionId, intent);
        }
      }
      return result;
    }
    const targetId = input.targetId || await this.resolveDefaultPageTarget(route, timeoutMs, input.sessionId);
    assertCurrent();
    const intent = this.beginSessionTargetIntent(route, input.sessionId);
    if (input.method === "Page.bringToFront") {
      try {
        await this.assertPageTarget(route, targetId, timeoutMs);
        assertCurrent();
        this.setSessionTargetIfCurrentIntent(route, input.sessionId, targetId, intent);
        return {};
      } catch (error) {
        this.retireSessionTargetIntent(route, input.sessionId, intent);
        throw error;
      }
    }
    let attached: { sessionId?: unknown };
    try {
      attached = await this.attachInternalTarget(route, targetId, timeoutMs) as { sessionId?: unknown };
    } catch (error) {
      this.retireSessionTargetIntent(route, input.sessionId, intent);
      throw error;
    }
    const targetSessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!targetSessionId) {
      this.retireSessionTargetIntent(route, input.sessionId, intent);
      throw new Error("Target.attachToTarget did not return sessionId");
    }
    let targetCommitted = false;
    try {
      assertCurrent();
      this.setSessionTargetIfCurrentIntent(route, input.sessionId, targetId, intent);
      targetCommitted = route.targetCommitIntentBySession.get(input.sessionId) === intent;
      const result = await this.sendRaw(route, input.method, input.params || {}, timeoutMs, targetSessionId);
      assertCurrent();
      return result;
    } catch (error) {
      if (!targetCommitted) this.retireSessionTargetIntent(route, input.sessionId, intent);
      throw error;
    } finally {
      await this.detachInternalTarget(route, targetSessionId, Math.min(timeoutMs, 2_000)).catch(() => undefined);
    }
  }

  async loadUnpackedExtension(input: {
    publicPort: number;
    sessionId: string;
    daemonInstanceId: string;
    extensionPath: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    const profile = this.control.getProfile(input.publicPort);
    if (!profile) throw new Error(`Gateway port ${input.publicPort} is not registered`);
    const identity: GatewayConnectionIdentity = {
      sessionId: input.sessionId,
      profileId: profile.profileId,
      publicPort: input.publicPort,
      daemonInstanceId: input.daemonInstanceId,
      controlGeneration: profile.controlGeneration,
      kind: "agent"
    };
    this.control.assertConnectionCanSend(identity);
    return this.sendRaw(
      this.requireRoute(input.publicPort),
      "Extensions.loadUnpacked",
      { path: input.extensionPath },
      input.timeoutMs || 15_000
    );
  }

  private async resolveDefaultPageTarget(route: GatewayRoute, timeoutMs: number, sessionId: string): Promise<string> {
    const affinity = route.targetBySession.get(sessionId);
    if (affinity) return affinity;
    const result = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const target = (result.targetInfos || []).find((candidate) => candidate.type === "page" && typeof candidate.targetId === "string");
    if (!target?.targetId) {
      const error = new Error("当前没有可供 Raw CDP 操作的页面") as Error & { code?: string };
      error.code = "RAW_CDP_TARGET_NOT_FOUND";
      throw error;
    }
    return String(target.targetId);
  }

  private async handleHttp(publicPort: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.isInternalRequest(request)) {
      writeJson(response, 401, { error_code: "GATEWAY_TICKET_REQUIRED", message: "需要 ProfilePilot Gateway Ticket" });
      return;
    }
    const url = new URL(request.url || "/", `http://${this.host}:${publicPort}`);
    if (url.pathname === "/json/version") {
      const issued = this.control.issueInternalTicket(publicPort);
      writeJson(response, 200, {
        Browser: "ProfilePilot Gateway",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${this.host}:${publicPort}/devtools/browser/gateway?ticket=${encodeURIComponent(issued.ticket)}`
      });
      return;
    }
    if (url.pathname === "/json/list" || url.pathname === "/json") {
      try {
        const result = await this.sendRaw(this.requireRoute(publicPort), "Target.getTargets", {}, 5_000) as {
          targetInfos?: Array<Record<string, unknown>>;
        };
        const targets = (result.targetInfos || []).map((target) => {
          const targetId = String(target.targetId || "");
          const issued = this.control.issueInternalTicket(publicPort);
          return {
            id: targetId,
            type: target.type,
            title: target.title,
            url: target.url,
            webSocketDebuggerUrl: targetId
              ? `ws://${this.host}:${publicPort}/devtools/page/${encodeURIComponent(targetId)}?ticket=${encodeURIComponent(issued.ticket)}`
              : undefined
          };
        });
        writeJson(response, 200, targets);
      } catch (error) {
        writeJson(response, 502, gatewayErrorPayload(error));
      }
      return;
    }
    const activate = url.pathname.match(/^\/json\/activate\/([^/]+)$/);
    if (activate) {
      try {
        await this.sendRaw(this.requireRoute(publicPort), "Target.activateTarget", {
          targetId: decodeURIComponent(activate[1])
        }, 5_000);
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Target activated");
      } catch (error) {
        writeJson(response, 502, gatewayErrorPayload(error));
      }
      return;
    }
    const close = url.pathname.match(/^\/json\/close\/([^/]+)$/);
    if (close) {
      try {
        await this.sendRaw(this.requireRoute(publicPort), "Target.closeTarget", {
          targetId: decodeURIComponent(close[1])
        }, 5_000);
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Target is closing");
      } catch (error) {
        writeJson(response, 502, gatewayErrorPayload(error));
      }
      return;
    }
    writeJson(response, 404, { error_code: "GATEWAY_ROUTE_NOT_FOUND" });
  }

  private async handleUpgrade(route: GatewayRoute, request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(request.url || "/", `http://${this.host}:${route.publicPort}`);
    const pageMatch = url.pathname.match(/^\/devtools\/page\/([^/]+)$/);
    if (url.pathname !== "/devtools/browser/gateway" && !pageMatch) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const ticket = url.searchParams.get("ticket");
    if (!ticket) {
      rejectUpgrade(socket, 401, "Gateway Ticket Required");
      return;
    }
    let identity: GatewayConnectionIdentity;
    try {
      identity = this.control.consumeTicket(ticket);
      if (identity.publicPort !== route.publicPort) {
        throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 端口不匹配");
      }
    } catch (error) {
      rejectUpgrade(socket, controlErrorStatus(error), JSON.stringify(gatewayErrorPayload(error)));
      return;
    }
    if (pageMatch && identity.kind !== "internal") {
      rejectUpgrade(socket, 403, "Page endpoints are internal-only");
      return;
    }
    if (
      identity.kind === "agent" &&
      this.hasActiveAgentConnection(route.publicPort, identity.sessionId, identity.daemonInstanceId)
    ) {
      rejectUpgrade(socket, 409, JSON.stringify({
        source: "ProfilePilot Gateway",
        error_code: "SESSION_DAEMON_DUPLICATE",
        hard_stop: true,
        message: `Session ${identity.sessionId} 已有活跃 Gateway 连接`
      }));
      return;
    }
    let targetSessionId: string | undefined;
    if (pageMatch) {
      try {
        const attached = await this.attachInternalTarget(
          route,
          decodeURIComponent(pageMatch[1]),
          5_000
        ) as { sessionId?: unknown };
        targetSessionId = typeof attached.sessionId === "string" ? attached.sessionId : undefined;
        if (!targetSessionId) throw new Error("Target.attachToTarget did not return sessionId");
      } catch (error) {
        rejectUpgrade(socket, 502, JSON.stringify(gatewayErrorPayload(error)));
        return;
      }
    }
    let peer: GatewayWebSocketPeer;
    try {
      peer = GatewayWebSocketPeer.accept(request, socket, head);
    } catch {
      rejectUpgrade(socket, 400, "Invalid WebSocket Upgrade");
      return;
    }
    const connection: GatewayConnection = {
      id: randomUUID(),
      identity,
      peer,
      targetSessionId,
      childSessionIds: new Set(),
      pendingAttachTargets: new Map(),
      autoAttachEnabled: false,
      autoAttachIntent: 0,
      quiescing: false,
      parked: false,
      parkedEvents: [],
      parkedEventBytes: 0
    };
    route.connections.add(connection);
    if (identity.kind === "agent") {
      this.options.onAgentConnectionChange?.(route.publicPort, true);
    }
    peer.onText = (message) => {
      void this.handleClientMessage(route, connection, message).catch(() => {
        connection.peer.close(1011, "Gateway command failed");
      });
    };
    peer.onClose = () => {
      route.connections.delete(connection);
      if (connection.identity.kind === "agent") {
        this.options.onAgentConnectionChange?.(route.publicPort, false);
      }
      for (const [id, pending] of route.pending) {
        if (pending.connection !== connection) continue;
        if (pending.internalAttachTargetId) {
          pending.connectionClosed = true;
          pending.timer = setTimeout(() => {
            if (route.pending.get(id) !== pending) return;
            route.pending.delete(id);
            this.decrementCount(route.trustedAttachTargets, pending.internalAttachTargetId as string);
          }, 2_000);
          continue;
        }
        route.pending.delete(id);
        if (pending.targetIntent !== undefined) {
          this.retireSessionTargetIntent(
            route,
            connection.identity.sessionId,
            pending.targetIntent
          );
        }
      }
      const childSessionIds = [...connection.childSessionIds];
      for (const sessionId of childSessionIds) this.unbindCdpSession(route, sessionId);
      for (const sessionId of childSessionIds) {
        if (route.internalCdpSessionIds.has(sessionId)) {
          void this.detachInternalTarget(route, sessionId, 2_000).catch(() => undefined);
        } else {
          void this.sendRaw(route, "Target.detachFromTarget", { sessionId }, 2_000).catch(() => undefined);
        }
      }
      if (connection.targetSessionId) {
        void this.detachInternalTarget(route, connection.targetSessionId, 2_000).catch(() => undefined);
      }
      if (connection.autoAttachEnabled) {
        void this.sendRaw(route, "Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true
        }, 2_000).catch(() => undefined);
      }
    };
  }

  private async handleClientMessage(route: GatewayRoute, connection: GatewayConnection, text: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      connection.peer.close(1007, "invalid CDP JSON");
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    const downstreamId = typeof message.id === "number" ? message.id : undefined;
    if (downstreamId === undefined) {
      // CDP commands require an id. Forwarding id-less Agent messages would let
      // activation commands bypass the virtual response path below.
      if (connection.identity.kind === "agent") {
        connection.peer.close(1007, "Agent CDP request id is required");
      } else {
        route.backend.send(text);
      }
      return;
    }
    const clientSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (connection.quiescing || connection.parked) {
      this.sendClientResponse(connection, downstreamId, {
        error: {
          code: -32000,
          message: connection.parked
            ? "AGENT_USER_IN_CONTROL: 用户正在操作浏览器，请等待 ProfilePilot 交还控制权"
            : "AGENT_HANDOFF_IN_PROGRESS: ProfilePilot 正在安全接管浏览器"
        }
      }, clientSessionId);
      return;
    }
    try {
      this.control.assertConnectionCanSend(connection.identity);
    } catch (error) {
      connection.peer.close(4003, errorCode(error));
      return;
    }
    if (connection.identity.kind === "agent") {
      const cdpSessionId = clientSessionId || "";
      const detachedSessionId = method === "Target.detachFromTarget" && typeof params.sessionId === "string"
        ? params.sessionId
        : "";
      if (
        (cdpSessionId && !this.connectionOwnsCdpSession(route, connection, cdpSessionId)) ||
        (detachedSessionId && !this.connectionOwnsCdpSession(route, connection, detachedSessionId))
      ) {
        this.sendClientResponse(connection, downstreamId, {
          error: { code: -32000, message: "CDP Session 不属于当前 Agent 连接" }
        }, clientSessionId);
        return;
      }
    }
    if (route.pending.size >= MAX_PENDING_REQUESTS) {
      connection.peer.close(1013, "too many pending CDP requests");
      return;
    }
    let targetIntent: number | undefined;
    if (connection.identity.kind === "agent") {
      if (AGENT_DENIED_TARGET_METHODS.has(method)) {
        const message = method === "Target.sendMessageToTarget"
          ? "Target.sendMessageToTarget is disabled; use flattened CDP sessions"
          : `${method} is disabled by ProfilePilot Gateway`;
        this.sendClientResponse(connection, downstreamId, {
          error: { code: -32601, message }
        }, clientSessionId);
        return;
      }
      if (AGENT_VIRTUALIZED_VIEWPORT_METHODS.has(method)) {
        this.sendClientResponse(connection, downstreamId, { result: {} }, clientSessionId);
        return;
      }
      if (method === "Page.bringToFront" || method === "Target.activateTarget") {
        targetIntent = this.beginSessionTargetIntent(route, connection.identity.sessionId);
        try {
          const targetId = method === "Target.activateTarget"
            ? typeof params.targetId === "string" ? params.targetId : ""
            : this.targetForCdpSession(route, connection, message);
          await this.assertPageTarget(route, targetId, 5_000);
          this.control.assertConnectionCanSend(connection.identity);
          this.setSessionTargetIfCurrentIntent(
            route,
            connection.identity.sessionId,
            targetId,
            targetIntent
          );
          this.sendClientResponse(connection, downstreamId, { result: {} }, clientSessionId);
        } catch (error) {
          this.retireSessionTargetIntent(route, connection.identity.sessionId, targetIntent);
          this.sendClientResponse(connection, downstreamId, {
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error || "Target activation failed")
            }
          }, clientSessionId);
        }
        return;
      }
      if (method === "Target.createTarget") {
        message = { ...message, params: agentBackgroundTargetParams(params) };
        targetIntent = this.beginSessionTargetIntent(route, connection.identity.sessionId);
      } else if (method === "Target.attachToTarget") {
        // Flattened sessions keep every command visible to the Gateway instead
        // of tunnelling opaque payloads through Target.sendMessageToTarget.
        message = { ...message, params: { ...params, flatten: true } };
        targetIntent = this.beginSessionTargetIntent(route, connection.identity.sessionId);
      } else if (method === "Target.setAutoAttach") {
        message = { ...message, params: { ...params, flatten: true } };
      }
    }
    const attachTargetId = connection.identity.kind === "agent" && method === "Target.attachToTarget" && typeof params.targetId === "string"
      ? params.targetId
      : "";
    if (attachTargetId) this.incrementConnectionAttachTarget(connection, attachTargetId);
    const internalAttachTargetId = connection.identity.kind === "internal" && method === "Target.attachToTarget" && typeof params.targetId === "string"
      ? params.targetId
      : "";
    if (internalAttachTargetId) this.incrementCount(route.trustedAttachTargets, internalAttachTargetId);
    let autoAttachIntent: number | undefined;
    let previousAutoAttachEnabled: boolean | undefined;
    if (
      connection.identity.kind === "agent" &&
      method === "Target.setAutoAttach" &&
      typeof params.autoAttach === "boolean"
    ) {
      previousAutoAttachEnabled = connection.autoAttachEnabled;
      autoAttachIntent = ++connection.autoAttachIntent;
      connection.autoAttachEnabled = params.autoAttach;
    }
    const backendId = route.nextBackendId++;
    route.pending.set(backendId, {
      kind: "client",
      downstreamId,
      connection,
      method: method || undefined,
      clientSessionId,
      params: message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params as Record<string, unknown>
        : undefined,
      targetIntent,
      autoAttachIntent,
      previousAutoAttachEnabled,
      internalAttachTargetId: internalAttachTargetId || undefined
    });
    try {
      route.backend.send(JSON.stringify({
        ...message,
        id: backendId,
        ...(connection.targetSessionId ? { sessionId: connection.targetSessionId } : {})
      }));
    } catch (error) {
      route.pending.delete(backendId);
      if (attachTargetId) this.decrementConnectionAttachTarget(connection, attachTargetId);
      if (internalAttachTargetId) this.decrementCount(route.trustedAttachTargets, internalAttachTargetId);
      if (targetIntent !== undefined) {
        this.retireSessionTargetIntent(route, connection.identity.sessionId, targetIntent);
      }
      if (autoAttachIntent !== undefined && connection.autoAttachIntent === autoAttachIntent) {
        connection.autoAttachEnabled = previousAutoAttachEnabled === true;
      }
      throw error;
    }
  }

  private handleBackendMessage(route: GatewayRoute, text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const backendId = typeof message.id === "number" ? message.id : undefined;
    if (backendId === undefined) {
      for (const connection of route.connections) {
        const eventSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
        if (connection.targetSessionId && eventSessionId !== connection.targetSessionId) continue;
        if (connection.identity.kind === "agent" && connection.parked) {
          if (eventSessionId && !this.connectionOwnsCdpSession(route, connection, eventSessionId)) continue;
          this.trackTargetEventForConnection(route, connection, message);
          if (!this.connectionOwnsTargetSessionEvent(route, connection, message)) continue;
          if (!this.bufferParkedEvent(connection, text)) {
            connection.peer.close(1013, "parked CDP event buffer exceeded");
          }
          continue;
        }
        try {
          this.control.assertConnectionCanSend(connection.identity);
          if (connection.identity.kind === "agent") {
            if (eventSessionId && !this.connectionOwnsCdpSession(route, connection, eventSessionId)) continue;
            this.trackTargetEventForConnection(route, connection, message);
            if (!this.connectionOwnsTargetSessionEvent(route, connection, message)) continue;
          }
          if (connection.targetSessionId) {
            const { sessionId: _sessionId, ...pageEvent } = message;
            connection.peer.sendText(JSON.stringify(pageEvent));
          } else {
            connection.peer.sendText(text);
          }
        } catch {
          connection.peer.close(4003, "CONTROL_GENERATION_STALE");
        }
      }
      this.handleTargetEvent(route, message);
      return;
    }
    const pending = route.pending.get(backendId);
    if (!pending) return;
    route.pending.delete(backendId);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.kind === "client" && pending.connection && pending.downstreamId !== undefined) {
      const result = message.result && typeof message.result === "object"
        ? message.result as Record<string, unknown>
        : null;
      const attachedSessionId = typeof result?.sessionId === "string" ? result.sessionId : "";
      const requestedTargetId = typeof pending.params?.targetId === "string" ? pending.params.targetId : "";
      if (pending.method === "Target.attachToTarget" && requestedTargetId) {
        this.decrementConnectionAttachTarget(pending.connection, requestedTargetId);
      }
      if (pending.internalAttachTargetId) {
        this.decrementCount(route.trustedAttachTargets, pending.internalAttachTargetId);
      }
      if (
        message.error &&
        pending.autoAttachIntent !== undefined &&
        pending.connection.autoAttachIntent === pending.autoAttachIntent
      ) {
        pending.connection.autoAttachEnabled = pending.previousAutoAttachEnabled === true;
      }
      if (message.error && pending.targetIntent !== undefined) {
        this.retireSessionTargetIntent(
          route,
          pending.connection.identity.sessionId,
          pending.targetIntent
        );
      }
      if (pending.connectionClosed) {
        if (!message.error && pending.internalAttachTargetId && attachedSessionId) {
          route.internalCdpSessionIds.add(attachedSessionId);
          void this.detachInternalTarget(route, attachedSessionId, 2_000).catch(() => undefined);
        }
        return;
      }
      try {
        this.control.assertConnectionCanSend(pending.connection.identity);
      } catch (error) {
        if (pending.targetIntent !== undefined) {
          this.retireSessionTargetIntent(
            route,
            pending.connection.identity.sessionId,
            pending.targetIntent
          );
        }
        if (pending.method === "Target.attachToTarget" && attachedSessionId) {
          if (pending.connection.identity.kind === "internal") {
            route.internalCdpSessionIds.add(attachedSessionId);
            void this.detachInternalTarget(route, attachedSessionId, 2_000).catch(() => undefined);
          } else {
            this.unbindCdpSession(route, attachedSessionId);
            void this.sendRaw(route, "Target.detachFromTarget", { sessionId: attachedSessionId }, 2_000).catch(() => undefined);
          }
        }
        if (pending.connection.parked || pending.connection.quiescing) {
          this.sendClientResponse(pending.connection, pending.downstreamId, {
            error: { code: -32000, message: `${errorCode(error)}: ProfilePilot 已暂停该驱动连接` }
          }, pending.clientSessionId);
        } else {
          pending.connection.peer.close(4003, errorCode(error));
        }
        return;
      }
      if (!message.error) {
        const createdTargetId = typeof result?.targetId === "string" ? result.targetId : "";
        if (
          pending.connection.identity.kind === "internal" &&
          pending.method === "Target.attachToTarget" &&
          attachedSessionId
        ) {
          route.internalCdpSessionIds.add(attachedSessionId);
          pending.connection.childSessionIds.add(attachedSessionId);
        }
        if (
          pending.connection.identity.kind === "agent" &&
          pending.method === "Target.attachToTarget" &&
          requestedTargetId &&
          attachedSessionId
        ) {
          if (attachedSessionId) {
            this.bindCdpSession(route, pending.connection, attachedSessionId, requestedTargetId);
          }
          if (pending.targetIntent !== undefined) {
            this.setSessionTargetIfCurrentIntent(
              route,
              pending.connection.identity.sessionId,
              requestedTargetId,
              pending.targetIntent
            );
          }
        } else if (
          pending.connection.identity.kind === "agent" &&
          pending.method === "Target.createTarget" &&
          createdTargetId
        ) {
          if (pending.targetIntent !== undefined) {
            this.setSessionTargetIfCurrentIntent(
              route,
              pending.connection.identity.sessionId,
              createdTargetId,
              pending.targetIntent
            );
          }
        } else if (
          pending.connection.identity.kind === "agent" &&
          pending.targetIntent !== undefined &&
          (pending.method === "Target.attachToTarget" || pending.method === "Target.createTarget")
        ) {
          this.retireSessionTargetIntent(
            route,
            pending.connection.identity.sessionId,
            pending.targetIntent
          );
        }
        if (pending.method === "Target.detachFromTarget" && typeof pending.params?.sessionId === "string") {
          const detachedSessionId = pending.params.sessionId;
          route.internalCdpSessionIds.delete(detachedSessionId);
          for (const candidate of route.connections) candidate.childSessionIds.delete(detachedSessionId);
          this.unbindCdpSession(route, detachedSessionId);
        }
      }
      const { sessionId: _sessionId, ...downstream } = message;
      this.sendClientResponse(pending.connection, pending.downstreamId, downstream, pending.clientSessionId);
      return;
    }
    if (message.error) {
      const detail = typeof message.error === "object" && message.error && "message" in message.error
        ? String((message.error as { message?: unknown }).message || "CDP command failed")
        : "CDP command failed";
      pending.reject?.(new Error(detail));
    } else {
      pending.resolve?.(message.result);
    }
  }

  private sendClientResponse(
    connection: GatewayConnection,
    downstreamId: number,
    payload: Record<string, unknown>,
    clientSessionId?: string
  ): void {
    connection.peer.sendText(JSON.stringify({
      ...payload,
      id: downstreamId,
      ...(clientSessionId ? { sessionId: clientSessionId } : {})
    }));
  }

  private handleBackendClose(route: GatewayRoute, error?: Error): void {
    for (const connection of route.connections) connection.peer.close(1011, "Chrome backend disconnected");
    route.connections.clear();
    this.rejectPending(route, error || new Error("Chrome backend disconnected"));
    if (this.routes.get(route.publicPort) === route) {
      this.options.onBackendClose?.(route.publicPort, error);
    }
  }

  private setSessionTarget(route: GatewayRoute, sessionId: string, targetId: string): void {
    if (route.targetBySession.get(sessionId) === targetId) return;
    route.targetBySession.set(sessionId, targetId);
    this.options.onAgentTargetChange?.(route.publicPort);
  }

  private beginSessionTargetIntent(route: GatewayRoute, sessionId: string): number {
    const intent = route.nextTargetIntent++;
    route.targetIntentBySession.set(sessionId, intent);
    return intent;
  }

  private setSessionTargetIfCurrentIntent(
    route: GatewayRoute,
    sessionId: string,
    targetId: string,
    intent: number
  ): void {
    if (route.targetIntentBySession.get(sessionId) !== intent) return;
    route.targetCommitIntentBySession.set(sessionId, intent);
    this.setSessionTarget(route, sessionId, targetId);
  }

  private retireSessionTargetIntent(route: GatewayRoute, sessionId: string, intent: number): void {
    if (route.targetIntentBySession.get(sessionId) !== intent) return;
    const committedIntent = route.targetCommitIntentBySession.get(sessionId);
    if (committedIntent === undefined) route.targetIntentBySession.delete(sessionId);
    else route.targetIntentBySession.set(sessionId, committedIntent);
  }

  private clearCommittedSessionTarget(
    route: GatewayRoute,
    sessionId: string,
    expectedTargetId: string,
    expectedCommitIntent?: number
  ): void {
    if (route.targetBySession.get(sessionId) !== expectedTargetId) return;
    if (route.targetCommitIntentBySession.get(sessionId) !== expectedCommitIntent) return;
    route.targetBySession.delete(sessionId);
    route.targetCommitIntentBySession.delete(sessionId);
    if (route.targetIntentBySession.get(sessionId) === expectedCommitIntent) {
      route.targetIntentBySession.delete(sessionId);
    }
    this.options.onAgentTargetChange?.(route.publicPort);
  }

  private clearSessionTarget(route: GatewayRoute, sessionId: string): void {
    route.targetIntentBySession.delete(sessionId);
    route.targetCommitIntentBySession.delete(sessionId);
    if (!route.targetBySession.delete(sessionId)) return;
    this.options.onAgentTargetChange?.(route.publicPort);
  }

  private bindCdpSession(
    route: GatewayRoute,
    connection: GatewayConnection,
    cdpSessionId: string,
    targetId: string
  ): void {
    const previous = route.targetByCdpSession.get(cdpSessionId);
    if (previous) {
      const previousConnection = [...route.connections].find((candidate) => candidate.id === previous.connectionId);
      previousConnection?.childSessionIds.delete(cdpSessionId);
    }
    route.targetByCdpSession.set(cdpSessionId, {
      targetId,
      connectionId: connection.id,
      agentSessionId: connection.identity.sessionId
    });
    connection.childSessionIds.add(cdpSessionId);
  }

  private unbindCdpSession(route: GatewayRoute, cdpSessionId: string): void {
    const binding = route.targetByCdpSession.get(cdpSessionId);
    if (!binding) return;
    route.targetByCdpSession.delete(cdpSessionId);
    const connection = [...route.connections].find((candidate) => candidate.id === binding.connectionId);
    connection?.childSessionIds.delete(cdpSessionId);
  }

  private handleTargetEvent(route: GatewayRoute, message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : null;
    if (!params) return;
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        route.internalCdpSessionIds.delete(params.sessionId);
        for (const connection of route.connections) connection.childSessionIds.delete(params.sessionId);
        this.unbindCdpSession(route, params.sessionId);
      }
      return;
    }
    if (method === "Target.targetDestroyed" && typeof params.targetId === "string") {
      for (const [sessionId, binding] of route.targetByCdpSession) {
        if (binding.targetId === params.targetId) this.unbindCdpSession(route, sessionId);
      }
      for (const [sessionId, targetId] of route.targetBySession) {
        if (targetId === params.targetId) {
          this.clearCommittedSessionTarget(
            route,
            sessionId,
            targetId,
            route.targetCommitIntentBySession.get(sessionId)
          );
        }
      }
      return;
    }
    if (method !== "Target.targetInfoChanged") return;
    const info = params.targetInfo && typeof params.targetInfo === "object" && !Array.isArray(params.targetInfo)
      ? params.targetInfo as Record<string, unknown>
      : null;
    if (!info || typeof info.targetId !== "string") return;
    if ([...route.targetBySession.values()].includes(info.targetId)) {
      this.options.onAgentTargetChange?.(route.publicPort);
    }
  }

  private trackTargetEventForConnection(
    route: GatewayRoute,
    connection: GatewayConnection,
    message: Record<string, unknown>
  ): void {
    if (message.method !== "Target.attachedToTarget") return;
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : null;
    const cdpSessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    const targetInfo = params?.targetInfo && typeof params.targetInfo === "object" && !Array.isArray(params.targetInfo)
      ? params.targetInfo as Record<string, unknown>
      : null;
    const targetId = typeof targetInfo?.targetId === "string" ? targetInfo.targetId : "";
    if (!cdpSessionId || !targetId) return;
    if (route.internalCdpSessionIds.has(cdpSessionId)) return;
    if ((route.trustedAttachTargets.get(targetId) || 0) > 0) return;
    if (!connection.autoAttachEnabled && !connection.pendingAttachTargets.has(targetId)) return;
    this.bindCdpSession(route, connection, cdpSessionId, targetId);
  }

  private connectionOwnsCdpSession(
    route: GatewayRoute,
    connection: GatewayConnection,
    cdpSessionId: string
  ): boolean {
    const binding = route.targetByCdpSession.get(cdpSessionId);
    return Boolean(
      binding &&
      binding.connectionId === connection.id &&
      binding.agentSessionId === connection.identity.sessionId
    );
  }

  private connectionOwnsTargetSessionEvent(
    route: GatewayRoute,
    connection: GatewayConnection,
    message: Record<string, unknown>
  ): boolean {
    if (message.method !== "Target.attachedToTarget" && message.method !== "Target.detachedFromTarget") {
      return true;
    }
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : null;
    const cdpSessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    return Boolean(cdpSessionId && this.connectionOwnsCdpSession(route, connection, cdpSessionId));
  }

  private targetForCdpSession(
    route: GatewayRoute,
    connection: GatewayConnection,
    message: Record<string, unknown>
  ): string {
    const cdpSessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const binding = cdpSessionId ? route.targetByCdpSession.get(cdpSessionId) : undefined;
    if (
      binding &&
      binding.connectionId === connection.id &&
      binding.agentSessionId === connection.identity.sessionId
    ) {
      return binding.targetId;
    }
    const error = new Error("无法确定 Page.bringToFront 对应的页面；CDP Session 尚未绑定 Target") as Error & { code?: string };
    error.code = "AGENT_TARGET_NOT_FOUND";
    throw error;
  }

  private async assertPageTarget(route: GatewayRoute, targetId: string, timeoutMs: number): Promise<void> {
    if (!targetId) {
      const error = new Error("缺少可激活的页面 Target") as Error & { code?: string };
      error.code = "AGENT_TARGET_NOT_FOUND";
      throw error;
    }
    const result = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const target = (result.targetInfos || []).find((candidate) => candidate.targetId === targetId);
    if (!target || target.type !== "page") {
      const error = new Error(`页面 Target ${targetId} 不存在`) as Error & { code?: string };
      error.code = "AGENT_TARGET_NOT_FOUND";
      throw error;
    }
  }

  private assertDelegatedSession(publicPort: number, sessionId: string, controlGeneration: number): void {
    const profile = this.control.getProfile(publicPort);
    if (
      !profile ||
      profile.ownerSessionId !== sessionId ||
      profile.sessionStatus !== "active" ||
      profile.ownership !== "user" ||
      profile.controlGeneration !== controlGeneration
    ) {
      throw new BrowserGatewayControlError(
        "CONTROL_GENERATION_STALE",
        "用户接管状态已经变化，取消显示旧的 Agent 标签页"
      );
    }
  }

  private assertActiveSession(publicPort: number, sessionId: string, controlGeneration: number): void {
    const profile = this.control.getProfile(publicPort);
    if (
      !profile ||
      profile.ownerSessionId !== sessionId ||
      profile.sessionStatus !== "active" ||
      profile.controlGeneration !== controlGeneration
    ) {
      throw new BrowserGatewayControlError(
        "CONTROL_GENERATION_STALE",
        "Agent Session 已经变化，取消显示旧的标签页"
      );
    }
  }

  private async activateTargetTrusted(route: GatewayRoute, targetId: string, timeoutMs: number): Promise<void> {
    await this.sendRaw(route, "Target.activateTarget", { targetId }, timeoutMs);
    const attached = await this.attachInternalTarget(route, targetId, timeoutMs) as { sessionId?: unknown };
    const cdpSessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!cdpSessionId) throw new Error("Target.attachToTarget did not return sessionId");
    try {
      // Older Agent connections may already have installed a device metrics
      // override before this Gateway version started virtualizing viewport
      // setters. Clear it at the trusted reveal boundary so the tab immediately
      // fills its real Chrome window again.
      await this.sendRaw(route, "Emulation.clearDeviceMetricsOverride", {}, timeoutMs, cdpSessionId);
      // This is intentionally a real Page.bringToFront. Only ProfilePilot's
      // trusted user reveal/handoff path reaches this helper; Agent paths are
      // virtualized before they can call Chrome.
      await this.sendRaw(route, "Page.bringToFront", {}, timeoutMs, cdpSessionId);
    } finally {
      await this.detachInternalTarget(route, cdpSessionId, Math.min(timeoutMs, 2_000)).catch(() => undefined);
    }
  }

  private async attachInternalTarget(
    route: GatewayRoute,
    targetId: string,
    timeoutMs: number,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!targetId) throw new Error("Target.attachToTarget 缺少 targetId");
    this.incrementCount(route.trustedAttachTargets, targetId);
    try {
      const result = await this.sendRaw(
        route,
        "Target.attachToTarget",
        { ...params, targetId, flatten: true },
        timeoutMs
      ) as Record<string, unknown> | null;
      const cdpSessionId = typeof result?.sessionId === "string" ? result.sessionId : "";
      if (cdpSessionId) route.internalCdpSessionIds.add(cdpSessionId);
      return result;
    } finally {
      this.decrementCount(route.trustedAttachTargets, targetId);
    }
  }

  private async detachInternalTarget(
    route: GatewayRoute,
    cdpSessionId: string,
    timeoutMs: number
  ): Promise<unknown> {
    try {
      return await this.sendRaw(route, "Target.detachFromTarget", { sessionId: cdpSessionId }, timeoutMs);
    } finally {
      route.internalCdpSessionIds.delete(cdpSessionId);
    }
  }

  private incrementConnectionAttachTarget(connection: GatewayConnection, targetId: string): void {
    this.incrementCount(connection.pendingAttachTargets, targetId);
  }

  private decrementConnectionAttachTarget(connection: GatewayConnection, targetId: string): void {
    this.decrementCount(connection.pendingAttachTargets, targetId);
  }

  private incrementCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) || 0) + 1);
  }

  private decrementCount(map: Map<string, number>, key: string): void {
    const next = (map.get(key) || 0) - 1;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }

  private sendRaw(
    route: GatewayRoute,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string
  ): Promise<unknown> {
    const id = route.nextBackendId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        route.pending.delete(id);
        reject(new Error(`CDP call ${method} timed out`));
      }, timeoutMs);
      route.pending.set(id, { kind: "raw", resolve, reject, timer });
      try {
        route.backend.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        route.pending.delete(id);
        reject(error);
      }
    });
  }

  private rejectPending(route: GatewayRoute, error: Error): void {
    for (const pending of route.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject?.(error);
    }
    route.pending.clear();
  }

  private bufferParkedEvent(connection: GatewayConnection, message: string): boolean {
    const bytes = Buffer.byteLength(message);
    if (
      connection.parkedEvents.length >= MAX_PARKED_EVENTS ||
      connection.parkedEventBytes + bytes > MAX_PARKED_EVENT_BYTES
    ) {
      return false;
    }
    connection.parkedEvents.push(message);
    connection.parkedEventBytes += bytes;
    return true;
  }

  private requireRoute(publicPort: number): GatewayRoute {
    const route = this.routes.get(publicPort);
    if (!route) throw new Error(`Gateway route ${publicPort} is not registered`);
    return route;
  }

  private isInternalRequest(request: IncomingMessage): boolean {
    return request.headers["x-profilepilot-internal"] === this.options.internalSecret;
  }
}

export function isRawCdpMethodAllowed(method: string): boolean {
  const normalized = String(method || "").trim();
  return Boolean(
    normalized &&
      !RAW_DENIED_METHODS.has(normalized) &&
      RAW_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function rawMethodNeedsTarget(method: string): boolean {
  return !method.startsWith("Target.");
}

function agentBackgroundTargetParams(params?: Record<string, unknown>): Record<string, unknown> {
  const { focus: _focus, ...rest } = params || {};
  return { ...rest, background: true };
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  const body = Buffer.from(message);
  socket.end([
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${body.length}`,
    "\r\n"
  ].join("\r\n") + message);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function gatewayErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof BrowserGatewayControlError) {
    return { source: "ProfilePilot Gateway", error_code: error.code, hard_stop: true, message: error.message };
  }
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return {
    source: "ProfilePilot Gateway",
    error_code: typeof candidate?.code === "string" ? candidate.code : "GATEWAY_ERROR",
    message: typeof candidate?.message === "string" ? candidate.message : String(error || "Gateway error")
  };
}

function errorCode(error: unknown): string {
  return error instanceof BrowserGatewayControlError ? error.code : "GATEWAY_ERROR";
}

function controlErrorStatus(error: unknown): number {
  if (!(error instanceof BrowserGatewayControlError)) return 500;
  if (error.code === "AGENT_USER_IN_CONTROL") return 423;
  if (error.code === "PROFILE_LEASE_CONFLICT" || error.code === "SESSION_DAEMON_DUPLICATE") return 409;
  return 401;
}
