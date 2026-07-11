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
  "Target.closeTarget"
]);
const MAX_PENDING_REQUESTS = 10_000;

interface GatewayRoute {
  publicPort: number;
  backend: GatewayCdpBackend;
  server: Server;
  connections: Set<GatewayConnection>;
  pending: Map<number, PendingRequest>;
  targetBySession: Map<string, string>;
  nextBackendId: number;
  removeBackendMessage: () => void;
  removeBackendClose: () => void;
}

interface GatewayConnection {
  id: string;
  identity: GatewayConnectionIdentity;
  peer: GatewayWebSocketPeer;
  targetSessionId?: string;
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
}

export interface BrowserGatewayServerOptions {
  internalSecret: string;
  host?: string;
  onBackendClose?: (publicPort: number, error?: Error) => void;
  onAgentConnectionChange?: (publicPort: number, active: boolean) => void;
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
      nextBackendId: 1,
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

  registeredPorts(): number[] {
    return [...this.routes.keys()].sort((a, b) => a - b);
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
    this.control.assertConnectionCanSend(identity);
    const route = this.requireRoute(input.publicPort);
    const timeoutMs = input.timeoutMs || 15_000;
    if (!rawMethodNeedsTarget(input.method)) {
      return this.sendRaw(route, input.method, input.params || {}, timeoutMs);
    }
    const targetId = input.targetId || await this.resolveDefaultPageTarget(route, timeoutMs, input.sessionId);
    const attached = await this.sendRaw(route, "Target.attachToTarget", { targetId, flatten: true }, timeoutMs) as {
      sessionId?: unknown;
    };
    const targetSessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!targetSessionId) throw new Error("Target.attachToTarget did not return sessionId");
    try {
      return await this.sendRaw(route, input.method, input.params || {}, timeoutMs, targetSessionId);
    } finally {
      await this.sendRaw(route, "Target.detachFromTarget", { sessionId: targetSessionId }, Math.min(timeoutMs, 2_000)).catch(() => undefined);
    }
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
        const attached = await this.sendRaw(route, "Target.attachToTarget", {
          targetId: decodeURIComponent(pageMatch[1]),
          flatten: true
        }, 5_000) as { sessionId?: unknown };
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
    const connection: GatewayConnection = { id: randomUUID(), identity, peer, targetSessionId };
    route.connections.add(connection);
    if (identity.kind === "agent") {
      this.options.onAgentConnectionChange?.(route.publicPort, true);
    }
    peer.onText = (message) => this.handleClientMessage(route, connection, message);
    peer.onClose = () => {
      route.connections.delete(connection);
      if (connection.identity.kind === "agent") {
        this.options.onAgentConnectionChange?.(route.publicPort, false);
      }
      for (const [id, pending] of route.pending) {
        if (pending.connection === connection) route.pending.delete(id);
      }
      if (connection.targetSessionId) {
        void this.sendRaw(route, "Target.detachFromTarget", { sessionId: connection.targetSessionId }, 2_000).catch(() => undefined);
      }
    };
  }

  private handleClientMessage(route: GatewayRoute, connection: GatewayConnection, text: string): void {
    try {
      this.control.assertConnectionCanSend(connection.identity);
    } catch (error) {
      connection.peer.close(4003, errorCode(error));
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      connection.peer.close(1007, "invalid CDP JSON");
      return;
    }
    const downstreamId = typeof message.id === "number" ? message.id : undefined;
    if (downstreamId === undefined) {
      route.backend.send(text);
      return;
    }
    if (route.pending.size >= MAX_PENDING_REQUESTS) {
      connection.peer.close(1013, "too many pending CDP requests");
      return;
    }
    const backendId = route.nextBackendId++;
    route.pending.set(backendId, {
      kind: "client",
      downstreamId,
      connection,
      method: typeof message.method === "string" ? message.method : undefined,
      params: message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params as Record<string, unknown>
        : undefined
    });
    route.backend.send(JSON.stringify({
      ...message,
      id: backendId,
      ...(connection.targetSessionId ? { sessionId: connection.targetSessionId } : {})
    }));
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
        try {
          this.control.assertConnectionCanSend(connection.identity);
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
      return;
    }
    const pending = route.pending.get(backendId);
    if (!pending) return;
    route.pending.delete(backendId);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.kind === "client" && pending.connection && pending.downstreamId !== undefined) {
      if (!message.error) {
        const requestedTargetId = typeof pending.params?.targetId === "string" ? pending.params.targetId : "";
        const result = message.result && typeof message.result === "object"
          ? message.result as Record<string, unknown>
          : null;
        const createdTargetId = typeof result?.targetId === "string" ? result.targetId : "";
        if (
          (pending.method === "Target.attachToTarget" || pending.method === "Target.activateTarget") &&
          requestedTargetId
        ) {
          route.targetBySession.set(pending.connection.identity.sessionId, requestedTargetId);
        } else if (pending.method === "Target.createTarget" && createdTargetId) {
          route.targetBySession.set(pending.connection.identity.sessionId, createdTargetId);
        }
      }
      const { sessionId: _sessionId, ...downstream } = message;
      pending.connection.peer.sendText(JSON.stringify({ ...downstream, id: pending.downstreamId }));
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

  private handleBackendClose(route: GatewayRoute, error?: Error): void {
    for (const connection of route.connections) connection.peer.close(1011, "Chrome backend disconnected");
    route.connections.clear();
    this.rejectPending(route, error || new Error("Chrome backend disconnected"));
    if (this.routes.get(route.publicPort) === route) {
      this.options.onBackendClose?.(route.publicPort, error);
    }
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
