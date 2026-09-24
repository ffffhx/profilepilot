import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  BrowserGatewayControlError,
  BrowserGatewayControlPlane,
  type GatewayAgentTargetChange,
  type GatewayConnectionIdentity,
  type GatewayControlEvent
} from "./browser-gateway-control";
import type { GatewayCdpBackend } from "./browser-gateway-transport";
import { GatewayWebSocketPeer } from "./browser-gateway-websocket";
import {
  AGENT_DENIED_TARGET_METHODS,
  AGENT_VIRTUALIZED_VIEWPORT_METHODS,
  chromiumDownloadParams,
  GATEWAY_DEVICE_PRESETS,
  isAgentTargetActivityMethod,
  isAgentTargetInteractionMethod,
  isRawCdpMethodAllowed
} from "./browser-gateway-policy";

export {
  GATEWAY_DEVICE_PRESETS,
  isRawCdpMethodAllowed
} from "./browser-gateway-policy";
const MAX_PENDING_REQUESTS = 10_000;
const MAX_PARKED_EVENTS = 20_000;
const MAX_PARKED_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXTENSION_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_EXTENSION_VERIFY_TIMEOUT_MS = 10_000;
const DEFAULT_EXTENSION_VERIFY_INTERVAL_MS = 250;

export interface GatewayDeviceEmulation {
  preset: string;
  targetId: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  maxTouchPoints: number;
  userAgent: string;
  platform: string;
}

interface GatewayDeviceEmulationState extends GatewayDeviceEmulation {
  sessionId: string;
  daemonInstanceId: string;
  cdpSessionId: string;
}

interface GatewayRoute {
  publicPort: number;
  kind: "browser" | "electron";
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
  agentCleanupBySession: Map<string, Promise<void>>;
  deviceEmulationBySession: Map<string, GatewayDeviceEmulationState>;
  internalCleanupPromises: Set<Promise<void>>;
  previouslyConnectedAgentSessions: Set<string>;
  targetLifecycleVersion: number;
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
  autoAttachSessionId?: string;
  autoAttachIntent: number;
  reconnecting: boolean;
  // Playwright CLI / Chrome DevTools MCP 都是长驻驱动。用户接管时保留
  // WebSocket 和 CDP session，但封锁新命令与事件流；交还后原地恢复。
  quiescing: boolean;
  parked: boolean;
  parkedEvents: string[];
  parkedEventBytes: number;
  agentCdpGeneration: number;
  lastAgentCdpAt?: string;
  lastAgentCdpMethod?: string;
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
  previousAutoAttachSessionId?: string;
  internalAttachTargetId?: string;
  connectionClosed?: boolean;
}

export interface BrowserGatewayServerOptions {
  internalSecret: string;
  host?: string;
  onBackendClose?: (publicPort: number, error?: Error) => void;
  onAgentConnectionChange?: (
    publicPort: number,
    active: boolean,
    identity: GatewayConnectionIdentity
  ) => void;
  onAgentTargetChange?: (publicPort: number, change?: GatewayAgentTargetChange) => void;
}

export interface GatewayAgentTarget {
  targetId: string;
  title: string;
  url: string;
}

export interface GatewayAgentActivity {
  generation: number;
  lastCdpAt: string | null;
  lastCdpMethod: string | null;
}

export class BrowserGatewayServer {
  private readonly routes = new Map<number, GatewayRoute>();
  private readonly preservedDeviceHandoffs = new Set<string>();
  private readonly host: string;

  constructor(
    readonly control: BrowserGatewayControlPlane,
    private readonly options: BrowserGatewayServerOptions
  ) {
    this.host = options.host || "127.0.0.1";
  }

  async registerBackend(input: { publicPort: number; backend: GatewayCdpBackend; kind?: "browser" | "electron" }): Promise<void> {
    if (this.routes.has(input.publicPort)) {
      throw new Error(`Gateway port ${input.publicPort} is already registered`);
    }
    const server = http.createServer((request, response) => {
      void this.handleHttp(input.publicPort, request, response);
    });
    const route: GatewayRoute = {
      publicPort: input.publicPort,
      kind: input.kind || "browser",
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
      agentCleanupBySession: new Map(),
      deviceEmulationBySession: new Map(),
      internalCleanupPromises: new Set(),
      previouslyConnectedAgentSessions: new Set(),
      targetLifecycleVersion: 0,
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
    await this.clearAllDeviceEmulations(route);
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

  getAgentActivity(
    publicPort: number,
    sessionId: string,
    daemonInstanceId: string
  ): GatewayAgentActivity | null {
    const route = this.routes.get(publicPort);
    const connection = route && [...route.connections].find((candidate) => (
      candidate.identity.kind === "agent" &&
      candidate.identity.sessionId === sessionId &&
      candidate.identity.daemonInstanceId === daemonInstanceId
    ));
    if (!connection) return null;
    return {
      generation: connection.agentCdpGeneration,
      lastCdpAt: connection.lastAgentCdpAt || null,
      lastCdpMethod: connection.lastAgentCdpMethod || null
    };
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

  disconnectAgentSession(publicPort: number, sessionId: string, reason = "agent command did not quiesce"): number {
    const route = this.routes.get(publicPort);
    if (!route) return 0;
    const connections = [...route.connections].filter((connection) =>
      connection.identity.kind === "agent" && connection.identity.sessionId === sessionId
    );
    // A Chrome request can occasionally remain pending forever even though the
    // driver is otherwise idle. Once the graceful deadline expires, closing the
    // driver transport is the only safe way to detach its CDP sessions before
    // allowing physical user input. The Gateway Session itself remains active,
    // so returning control can reconnect the driver normally.
    for (const connection of connections) connection.peer.close(4003, reason);
    return connections.length;
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
      if (target && (target.type === "page" || route.kind === "electron" && target.type === "webview")) {
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
    timeoutMs = 5_000,
    preserveDeviceEmulation = false
  ): Promise<GatewayAgentTarget> {
    const route = this.requireRoute(publicPort);
    const targetId = route.targetBySession.get(sessionId);
    if (!targetId) {
      const error = new Error("当前 Agent 没有可精确确认的目标标签页；为避免显示无关页面，ProfilePilot 已拒绝自动切页") as Error & { code?: string };
      error.code = "GATEWAY_AGENT_TARGET_MISMATCH";
      throw error;
    }
    const result = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const target = (result.targetInfos || []).find((candidate) => candidate.targetId === targetId);
    if (!target || !(target.type === "page" || route.kind === "electron" && target.type === "webview")) {
      this.clearSessionTarget(route, sessionId);
      const error = new Error(`目标页面 ${targetId} 已不存在；为避免显示无关页面，ProfilePilot 已拒绝自动切页`) as Error & { code?: string };
      error.code = "GATEWAY_AGENT_TARGET_MISMATCH";
      throw error;
    }

    // This check is intentionally immediately adjacent to sendRaw(). The daemon
    // serializes control transitions for a Session, and sendRaw synchronously
    // writes the trusted activation before yielding back to the event loop.
    this.assertDelegatedSession(publicPort, sessionId, controlGeneration);
    await this.activateTargetTrusted(route, targetId, timeoutMs, preserveDeviceEmulation);
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

  prepareDeviceEmulationUserHandoff(publicPort: number, sessionId: string): boolean {
    const route = this.routes.get(publicPort);
    if (!route?.deviceEmulationBySession.has(sessionId)) return false;
    this.preservedDeviceHandoffs.add(deviceHandoffKey(publicPort, sessionId));
    return true;
  }

  cancelDeviceEmulationUserHandoff(publicPort: number, sessionId: string): void {
    this.preservedDeviceHandoffs.delete(deviceHandoffKey(publicPort, sessionId));
  }

  handleControlEvent(event: GatewayControlEvent): void {
    if (event.type !== "connections-revoked") return;
    const route = this.routes.get(event.profile.publicPort);
    if (!route) return;
    const preserveDeviceEmulation =
      event.reason === "user_takeover" &&
      Boolean(event.profile.ownerSessionId) &&
      this.preservedDeviceHandoffs.delete(
        deviceHandoffKey(event.profile.publicPort, event.profile.ownerSessionId as string)
      );
    if (event.reason !== "user-return" && !preserveDeviceEmulation) {
      void this.clearAllDeviceEmulations(route);
    }
    if (event.reason === "user-return") {
      // Takeover rendering and overlay work use short-lived trusted page
      // attachments. Finish those before a replacement agent-browser daemon
      // creates its own page session; otherwise their delayed detach events can
      // invalidate the new daemon's primary session.
      for (const connection of [...route.connections]) {
        if (connection.identity.kind === "internal") {
          connection.peer.close(4003, "user-return");
        }
      }
    }
    for (const connection of [...route.connections]) {
      if (
        connection.identity.kind === "agent" &&
        connection.identity.profileId === event.profile.profileId
      ) {
        // All supported Gateway drivers are safe to keep physically connected
        // while parked: commands are rejected before reaching Chrome and browser
        // events are buffered until control returns.
        const resumable = event.profile.driverKind === "agent-browser" ||
          event.profile.driverKind === "playwright-cli" ||
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
    if (route.kind === "electron" && input.method === "Target.createTarget") {
      throw new Error("Electron 自动化仅操作已有窗口；请从应用中打开新窗口。");
    }
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
        if (targetId) this.setSessionTargetIfCurrentIntent(
          route,
          input.sessionId,
          targetId,
          intent,
          "raw-cdp:Target.createTarget"
        );
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
        this.setSessionTargetIfCurrentIntent(
          route,
          input.sessionId,
          targetId,
          intent,
          "raw-cdp:Target.activateTarget"
        );
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
          this.setSessionTargetIfCurrentIntent(
            route,
            input.sessionId,
            targetId,
            intent,
            "raw-cdp:Target.attachToTarget"
          );
        } else if (intent !== undefined) {
          this.retireSessionTargetIntent(route, input.sessionId, intent);
        }
      }
      return result;
    }
    const configuredTargetId =
      input.targetId || route.targetBySession.get(input.sessionId);
    const targetId =
      configuredTargetId ||
      (await this.resolveDefaultPageTarget(route, timeoutMs, input.sessionId));
    if (configuredTargetId && input.method !== "Page.bringToFront") {
      await this.assertPageTarget(route, targetId, timeoutMs);
    }
    assertCurrent();
    const intent = this.beginSessionTargetIntent(route, input.sessionId);
    if (input.method === "Page.bringToFront") {
      try {
        await this.assertPageTarget(route, targetId, timeoutMs);
        assertCurrent();
        this.setSessionTargetIfCurrentIntent(
          route,
          input.sessionId,
          targetId,
          intent,
          "raw-cdp:Page.bringToFront"
        );
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
      this.setSessionTargetIfCurrentIntent(
        route,
        input.sessionId,
        targetId,
        intent,
        `raw-cdp:${input.method}`
      );
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
    extensionVersion?: string;
    timeoutMs?: number;
    verificationTimeoutMs?: number;
    verificationIntervalMs?: number;
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
    const route = this.requireRoute(input.publicPort);
    try {
      return await this.sendRaw(
        route,
        "Extensions.loadUnpacked",
        { path: input.extensionPath },
        input.timeoutMs || DEFAULT_EXTENSION_LOAD_TIMEOUT_MS
      );
    } catch (error) {
      const candidate = error as Error & { code?: unknown; method?: unknown };
      if (candidate.code !== "CDP_CALL_TIMEOUT" || candidate.method !== "Extensions.loadUnpacked") {
        throw error;
      }
      const verified = await this.waitForLoadedUnpackedExtension(
        route,
        identity,
        input.extensionPath,
        input.extensionVersion,
        input.verificationTimeoutMs || DEFAULT_EXTENSION_VERIFY_TIMEOUT_MS,
        input.verificationIntervalMs || DEFAULT_EXTENSION_VERIFY_INTERVAL_MS
      );
      if (!verified) throw error;
      return {
        id: verified.id,
        recoveredFromTimeout: true
      };
    }
  }

  async triggerExtensionAction(input: {
    publicPort: number;
    sessionId: string;
    daemonInstanceId: string;
    extensionId: string;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<{
    extensionId: string;
    targetId: string;
    actionTargetId: string;
  }> {
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
    const extensionId = String(input.extensionId || "").trim();
    if (!/^[a-p]{32}$/.test(extensionId)) {
      const error = new Error("扩展 ID 格式无效") as Error & { code?: string };
      error.code = "EXTENSION_ID_INVALID";
      throw error;
    }
    const extensions = await this.sendRaw(route, "Extensions.getExtensions", {}, timeoutMs) as {
      extensions?: Array<Record<string, unknown>>;
    };
    const extension = (extensions.extensions || []).find(
      (candidate) => candidate.id === extensionId && candidate.enabled !== false
    );
    if (!extension) {
      const error = new Error(`扩展 ${extensionId} 未加载或未启用`) as Error & { code?: string };
      error.code = "EXTENSION_NOT_AVAILABLE";
      throw error;
    }
    const pageTargetId = input.targetId || await this.resolveDefaultPageTarget(
      route,
      timeoutMs,
      input.sessionId
    );
    const targetId = await this.resolveExtensionTabTarget(route, pageTargetId, timeoutMs);
    this.control.assertConnectionCanSend(identity);
    await this.sendRaw(route, "Target.activateTarget", { targetId }, timeoutMs);
    this.control.assertConnectionCanSend(identity);
    await this.sendRaw(route, "Extensions.triggerAction", {
      id: extensionId,
      targetId
    }, timeoutMs);
    this.control.assertConnectionCanSend(identity);
    this.setSessionTarget(route, input.sessionId, pageTargetId, "extension:trigger-action");
    return {
      extensionId,
      targetId: pageTargetId,
      actionTargetId: targetId
    };
  }

  async controlDeviceEmulation(input: {
    publicPort: number;
    sessionId: string;
    daemonInstanceId: string;
    command: "emulate" | "clear" | "status";
    preset?: string;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<GatewayDeviceEmulation | null> {
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
    if (input.command === "status") {
      return publicDeviceEmulation(route.deviceEmulationBySession.get(input.sessionId));
    }
    if (input.command === "clear") {
      return this.clearDeviceEmulationState(route, input.sessionId, input.timeoutMs);
    }

    const presetName = String(input.preset || "").trim().toLowerCase();
    const preset = GATEWAY_DEVICE_PRESETS[presetName];
    if (!preset) {
      const error = new Error(
        `Unsupported device preset: ${input.preset || "(empty)"}; supported: ${Object.keys(GATEWAY_DEVICE_PRESETS).join(", ")}`
      ) as Error & { code?: string };
      error.code = "DEVICE_PRESET_NOT_SUPPORTED";
      throw error;
    }
    const timeoutMs = input.timeoutMs || 15_000;
    const targetId = input.targetId || await this.resolveDefaultPageTarget(
      route,
      timeoutMs,
      input.sessionId
    );
    await this.assertPageTarget(route, targetId, timeoutMs);
    this.control.assertConnectionCanSend(identity);
    await this.clearDeviceEmulationState(route, input.sessionId, timeoutMs);

    const attached = await this.attachInternalTarget(route, targetId, timeoutMs) as {
      sessionId?: unknown;
    };
    const cdpSessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!cdpSessionId) {
      throw new Error("Target.attachToTarget did not return sessionId");
    }
    try {
      this.control.assertConnectionCanSend(identity);
      await this.sendRaw(route, "Emulation.setDeviceMetricsOverride", {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        screenWidth: preset.width,
        screenHeight: preset.height,
        positionX: 0,
        positionY: 0,
        screenOrientation: {
          type: "portraitPrimary",
          angle: 0
        }
      }, timeoutMs, cdpSessionId);
      await this.sendRaw(route, "Emulation.setUserAgentOverride", {
        userAgent: preset.userAgent,
        platform: preset.platform
      }, timeoutMs, cdpSessionId);
      await this.sendRaw(route, "Emulation.setTouchEmulationEnabled", {
        enabled: preset.maxTouchPoints > 0,
        maxTouchPoints: preset.maxTouchPoints
      }, timeoutMs, cdpSessionId);
      this.control.assertConnectionCanSend(identity);
      const state: GatewayDeviceEmulationState = {
        preset: presetName,
        targetId,
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        maxTouchPoints: preset.maxTouchPoints,
        userAgent: preset.userAgent,
        platform: preset.platform,
        sessionId: input.sessionId,
        daemonInstanceId: input.daemonInstanceId,
        cdpSessionId
      };
      route.deviceEmulationBySession.set(input.sessionId, state);
      this.setSessionTarget(route, input.sessionId, targetId, "device-emulation:emulate");
      return publicDeviceEmulation(state);
    } catch (error) {
      await this.resetAndDetachDeviceSession(route, cdpSessionId, timeoutMs);
      throw error;
    }
  }

  async clearDeviceEmulationForSession(
    publicPort: number,
    sessionId: string,
    timeoutMs = 5_000
  ): Promise<GatewayDeviceEmulation | null> {
    const route = this.routes.get(publicPort);
    if (!route) return null;
    return this.clearDeviceEmulationState(route, sessionId, timeoutMs);
  }

  private async resolveDefaultPageTarget(route: GatewayRoute, timeoutMs: number, sessionId: string): Promise<string> {
    const affinity = route.targetBySession.get(sessionId);
    if (affinity) return affinity;
    const result = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const target = (result.targetInfos || []).find((candidate) => (candidate.type === "page" || route.kind === "electron" && candidate.type === "webview") && typeof candidate.targetId === "string");
    if (!target?.targetId) {
      const error = new Error("当前没有可供 Raw CDP 操作的页面") as Error & { code?: string };
      error.code = "RAW_CDP_TARGET_NOT_FOUND";
      throw error;
    }
    return String(target.targetId);
  }

  private async resolveExtensionTabTarget(
    route: GatewayRoute,
    requestedTargetId: string,
    timeoutMs: number
  ): Promise<string> {
    const pagesResult = await this.sendRaw(route, "Target.getTargets", {}, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const page = (pagesResult.targetInfos || []).find(
      (candidate) => candidate.targetId === requestedTargetId && candidate.type === "page"
    );
    const tabsResult = await this.sendRaw(route, "Target.getTargets", {
      filter: [{ type: "tab" }]
    }, timeoutMs) as {
      targetInfos?: Array<Record<string, unknown>>;
    };
    const tabs = (tabsResult.targetInfos || []).filter(
      (candidate) => candidate.type === "tab" && typeof candidate.targetId === "string"
    );
    const requestedTab = tabs.find((candidate) => candidate.targetId === requestedTargetId);
    if (requestedTab?.targetId) return String(requestedTab.targetId);
    if (!page) {
      const error = new Error(`页面或标签页 Target ${requestedTargetId} 不存在`) as Error & { code?: string };
      error.code = "AGENT_TARGET_NOT_FOUND";
      throw error;
    }
    const matchingTabs = tabs.filter((candidate) =>
      candidate.browserContextId === page.browserContextId &&
      candidate.url === page.url
    );
    const tab = matchingTabs.find(
      (candidate) => (candidate.embedderData as Record<string, unknown> | undefined)?.tabActive === true
    ) || matchingTabs[0];
    if (!tab?.targetId) {
      const error = new Error(`无法把页面 Target ${requestedTargetId} 映射到所属标签页`) as Error & { code?: string };
      error.code = "EXTENSION_TAB_TARGET_NOT_FOUND";
      throw error;
    }
    return String(tab.targetId);
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
    const reconnecting = identity.kind === "agent" &&
      route.previouslyConnectedAgentSessions.has(identity.sessionId);
    if (identity.kind === "agent") {
      const cleanup = route.agentCleanupBySession.get(identity.sessionId);
      if (cleanup) {
        await cleanup;
        try {
          this.control.assertConnectionCanSend(identity);
        } catch (error) {
          rejectUpgrade(socket, controlErrorStatus(error), JSON.stringify(gatewayErrorPayload(error)));
          return;
        }
      }
      if (reconnecting) {
        await this.waitForInternalConnectionsToSettle(route, 5_000);
      }
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
      reconnecting,
      quiescing: false,
      parked: false,
      parkedEvents: [],
      parkedEventBytes: 0,
      agentCdpGeneration: 0
    };
    route.connections.add(connection);
    if (identity.kind === "agent") {
      this.options.onAgentConnectionChange?.(route.publicPort, true, identity);
    }
    peer.onText = (message) => {
      void this.handleClientMessage(route, connection, message).catch(() => {
        connection.peer.close(1011, "Gateway command failed");
      });
    };
    peer.onClose = () => {
      route.connections.delete(connection);
      if (connection.identity.kind === "agent") {
        route.previouslyConnectedAgentSessions.add(connection.identity.sessionId);
        this.options.onAgentConnectionChange?.(route.publicPort, false, connection.identity);
      }
      const cleanupActions: Array<() => Promise<unknown>> = [];
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
          cleanupActions.push(() => this.detachInternalTarget(route, sessionId, 2_000));
        } else {
          cleanupActions.push(() => this.sendRaw(route, "Target.detachFromTarget", { sessionId }, 2_000));
        }
      }
      if (connection.targetSessionId) {
        cleanupActions.push(() => this.detachInternalTarget(route, connection.targetSessionId as string, 2_000));
      }
      const resetsAutoAttach = connection.autoAttachEnabled;
      if (cleanupActions.length > 0 || resetsAutoAttach) {
        const cleanup = (async () => {
          if (resetsAutoAttach) {
            await this.sendRaw(route, "Target.setAutoAttach", {
              autoAttach: false,
              waitForDebuggerOnStart: false,
              flatten: true
            }, 2_000, connection.autoAttachSessionId).catch(() => undefined);
            await this.waitForTargetLifecycleQuiet(route, 50, 500);
          }
          await Promise.allSettled(cleanupActions.map((cleanupAction) => cleanupAction()));
        })();
        if (connection.identity.kind === "agent") {
          const sessionId = connection.identity.sessionId;
          route.agentCleanupBySession.set(sessionId, cleanup);
          void cleanup.finally(() => {
            if (route.agentCleanupBySession.get(sessionId) === cleanup) {
              route.agentCleanupBySession.delete(sessionId);
            }
          });
        } else {
          route.internalCleanupPromises.add(cleanup);
          void cleanup.finally(() => route.internalCleanupPromises.delete(cleanup));
        }
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
    const clientSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
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
      connection.agentCdpGeneration += 1;
      connection.lastAgentCdpAt = new Date().toISOString();
      connection.lastAgentCdpMethod = method || "<missing-method>";
    }
    if (route.pending.size >= MAX_PENDING_REQUESTS) {
      connection.peer.close(1013, "too many pending CDP requests");
      return;
    }
    let targetIntent: number | undefined;
    if (connection.identity.kind === "agent") {
      if (AGENT_DENIED_TARGET_METHODS.has(method) || route.kind === "electron" && ["Target.createTarget", "Browser.close"].includes(method)) {
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
      if (
        clientSessionId &&
        method !== "Page.bringToFront" &&
        isAgentTargetActivityMethod(method) &&
        (
          !route.targetBySession.has(connection.identity.sessionId) ||
          isAgentTargetInteractionMethod(method)
        )
      ) {
        const targetId = this.targetForCdpSession(route, connection, message);
        const activityIntent = this.beginSessionTargetIntent(route, connection.identity.sessionId);
        this.setSessionTargetIfCurrentIntent(
          route,
          connection.identity.sessionId,
          targetId,
          activityIntent,
          `agent-cdp:${method}`
        );
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
            targetIntent,
            `agent-cdp:${method}`
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
        if (connection.reconnecting) {
          // The old daemon's scoped Auto-Attach controller has already been
          // disabled during the reconnect barrier. Reinstalling it immediately
          // makes Chromium replace the freshly attached primary session, while
          // agent-browser keeps using the pre-replacement id. The replacement
          // daemon already attached its working page explicitly, so this setup
          // call is redundant and can be acknowledged without touching Chrome.
          this.sendClientResponse(connection, downstreamId, { result: {} }, clientSessionId);
          return;
        }
        message = { ...message, params: { ...params, flatten: true } };
      }
    }
    if (method === "Browser.setDownloadBehavior") message = { ...message, params: chromiumDownloadParams(params) };
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
    let previousAutoAttachSessionId: string | undefined;
    if (
      connection.identity.kind === "agent" &&
      method === "Target.setAutoAttach" &&
      typeof params.autoAttach === "boolean"
    ) {
      previousAutoAttachEnabled = connection.autoAttachEnabled;
      previousAutoAttachSessionId = connection.autoAttachSessionId;
      autoAttachIntent = ++connection.autoAttachIntent;
      connection.autoAttachEnabled = params.autoAttach;
      connection.autoAttachSessionId = params.autoAttach ? clientSessionId : undefined;
    }
    if (
      connection.identity.kind === "agent" &&
      method === "Input.dispatchMouseEvent" &&
      params.type === "mousePressed"
    ) {
      this.queueOverlayAvoidance(
        route,
        connection.targetSessionId || clientSessionId,
        params
      );
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
      previousAutoAttachSessionId,
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
        connection.autoAttachSessionId = previousAutoAttachSessionId;
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
        pending.connection.autoAttachSessionId = pending.previousAutoAttachSessionId;
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
              pending.targetIntent,
              "agent-cdp-response:Target.attachToTarget"
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
              pending.targetIntent,
              "agent-cdp-response:Target.createTarget"
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
    route.deviceEmulationBySession.clear();
    for (const connection of route.connections) connection.peer.close(1011, "Chrome backend disconnected");
    route.connections.clear();
    this.rejectPending(route, error || new Error("Chrome backend disconnected"));
    if (this.routes.get(route.publicPort) === route) {
      this.options.onBackendClose?.(route.publicPort, error);
    }
  }

  private setSessionTarget(
    route: GatewayRoute,
    sessionId: string,
    targetId: string,
    source = "gateway:unspecified"
  ): void {
    const previousTargetId = route.targetBySession.get(sessionId);
    if (previousTargetId === targetId) return;
    route.targetBySession.set(sessionId, targetId);
    this.options.onAgentTargetChange?.(route.publicPort, {
      sessionId,
      previousTargetId: previousTargetId || null,
      targetId,
      source
    });
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
    intent: number,
    source = "gateway:intent-commit"
  ): void {
    if (route.targetIntentBySession.get(sessionId) !== intent) return;
    route.targetCommitIntentBySession.set(sessionId, intent);
    this.setSessionTarget(route, sessionId, targetId, source);
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
    expectedCommitIntent?: number,
    source = "gateway:committed-target-cleared"
  ): void {
    if (route.targetBySession.get(sessionId) !== expectedTargetId) return;
    if (route.targetCommitIntentBySession.get(sessionId) !== expectedCommitIntent) return;
    route.targetBySession.delete(sessionId);
    route.targetCommitIntentBySession.delete(sessionId);
    if (route.targetIntentBySession.get(sessionId) === expectedCommitIntent) {
      route.targetIntentBySession.delete(sessionId);
    }
    this.options.onAgentTargetChange?.(route.publicPort, {
      sessionId,
      previousTargetId: expectedTargetId,
      targetId: null,
      source
    });
  }

  private clearSessionTarget(route: GatewayRoute, sessionId: string, source = "gateway:session-target-cleared"): void {
    route.targetIntentBySession.delete(sessionId);
    route.targetCommitIntentBySession.delete(sessionId);
    const previousTargetId = route.targetBySession.get(sessionId);
    if (!route.targetBySession.delete(sessionId)) return;
    this.options.onAgentTargetChange?.(route.publicPort, {
      sessionId,
      previousTargetId: previousTargetId || null,
      targetId: null,
      source
    });
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
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      route.targetLifecycleVersion += 1;
    }
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : null;
    if (!params) return;
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        this.handleDeviceEmulationSessionDetached(route, params.sessionId);
        route.internalCdpSessionIds.delete(params.sessionId);
        for (const connection of route.connections) connection.childSessionIds.delete(params.sessionId);
        this.unbindCdpSession(route, params.sessionId);
      }
      return;
    }
    if (method === "Target.targetDestroyed" && typeof params.targetId === "string") {
      for (const [sessionId, state] of route.deviceEmulationBySession) {
        if (state.targetId === params.targetId) route.deviceEmulationBySession.delete(sessionId);
      }
      for (const [sessionId, binding] of route.targetByCdpSession) {
        if (binding.targetId === params.targetId) this.unbindCdpSession(route, sessionId);
      }
      for (const [sessionId, targetId] of route.targetBySession) {
        if (targetId === params.targetId) {
          this.clearCommittedSessionTarget(
            route,
            sessionId,
            targetId,
            route.targetCommitIntentBySession.get(sessionId),
            "chrome-event:Target.targetDestroyed"
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

  private async waitForTargetLifecycleQuiet(
    route: GatewayRoute,
    quietMs: number,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let observedVersion = route.targetLifecycleVersion;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, quietMs));
      if (route.targetLifecycleVersion === observedVersion) return;
      observedVersion = route.targetLifecycleVersion;
    }
  }

  private async waitForInternalConnectionsToSettle(
    route: GatewayRoute,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hasInternalConnection = [...route.connections].some(
        (connection) => connection.identity.kind === "internal"
      );
      if (!hasInternalConnection && route.internalCleanupPromises.size === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        if (
          ![...route.connections].some((connection) => connection.identity.kind === "internal") &&
          route.internalCleanupPromises.size === 0
        ) {
          return;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
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
    if (!target || !(target.type === "page" || route.kind === "electron" && target.type === "webview")) {
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

  private async activateTargetTrusted(
    route: GatewayRoute,
    targetId: string,
    timeoutMs: number,
    preserveDeviceEmulation = false
  ): Promise<void> {
    await this.sendRaw(route, "Target.activateTarget", { targetId }, timeoutMs);
    const attached = await this.attachInternalTarget(route, targetId, timeoutMs) as { sessionId?: unknown };
    const cdpSessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!cdpSessionId) throw new Error("Target.attachToTarget did not return sessionId");
    try {
      // Older Agent connections may already have installed a device metrics
      // override before this Gateway version started virtualizing viewport
      // setters. Clear it at the trusted reveal boundary so the tab immediately
      // fills its real Chrome window again.
      if (!preserveDeviceEmulation) {
        await this.sendRaw(route, "Emulation.clearDeviceMetricsOverride", {}, timeoutMs, cdpSessionId);
      }
      // This is intentionally a real Page.bringToFront. Only ProfilePilot's
      // trusted user reveal/handoff path reaches this helper; Agent paths are
      // virtualized before they can call Chrome.
      await this.sendRaw(route, "Page.bringToFront", {}, timeoutMs, cdpSessionId);
    } finally {
      await this.detachInternalTarget(route, cdpSessionId, Math.min(timeoutMs, 2_000)).catch(() => undefined);
    }
  }

  private async clearAllDeviceEmulations(route: GatewayRoute): Promise<void> {
    await Promise.allSettled(
      [...route.deviceEmulationBySession.keys()].map((sessionId) =>
        this.clearDeviceEmulationState(route, sessionId, 2_000)
      )
    );
  }

  private async clearDeviceEmulationState(
    route: GatewayRoute,
    sessionId: string,
    timeoutMs = 5_000
  ): Promise<GatewayDeviceEmulation | null> {
    const state = route.deviceEmulationBySession.get(sessionId);
    if (!state) return null;
    route.deviceEmulationBySession.delete(sessionId);
    await this.resetAndDetachDeviceState(route, state, timeoutMs);
    return publicDeviceEmulation(state);
  }

  private async resetAndDetachDeviceState(
    route: GatewayRoute,
    state: GatewayDeviceEmulationState,
    timeoutMs: number
  ): Promise<void> {
    let cdpSessionId = state.cdpSessionId;
    if (!cdpSessionId || !route.internalCdpSessionIds.has(cdpSessionId)) {
      const attached = await this.attachInternalTarget(
        route,
        state.targetId,
        timeoutMs
      ).catch(() => null) as { sessionId?: unknown } | null;
      cdpSessionId = typeof attached?.sessionId === "string" ? attached.sessionId : "";
    }
    if (!cdpSessionId) return;
    await this.resetAndDetachDeviceSession(route, cdpSessionId, timeoutMs);
  }

  private async resetAndDetachDeviceSession(
    route: GatewayRoute,
    cdpSessionId: string,
    timeoutMs: number
  ): Promise<void> {
    await this.sendRaw(
      route,
      "Emulation.clearDeviceMetricsOverride",
      {},
      timeoutMs,
      cdpSessionId
    ).catch(() => undefined);
    await this.sendRaw(
      route,
      "Emulation.setUserAgentOverride",
      { userAgent: "" },
      timeoutMs,
      cdpSessionId
    ).catch(() => undefined);
    await this.sendRaw(
      route,
      "Emulation.setTouchEmulationEnabled",
      { enabled: false },
      timeoutMs,
      cdpSessionId
    ).catch(() => undefined);
    await this.detachInternalTarget(
      route,
      cdpSessionId,
      Math.min(timeoutMs, 2_000)
    ).catch(() => undefined);
  }

  private handleDeviceEmulationSessionDetached(route: GatewayRoute, cdpSessionId: string): void {
    for (const state of route.deviceEmulationBySession.values()) {
      if (state.cdpSessionId === cdpSessionId) {
        state.cdpSessionId = "";
        queueMicrotask(() => {
          void this.reapplyDetachedDeviceEmulation(route, state);
        });
      }
    }
  }

  private async reapplyDetachedDeviceEmulation(
    route: GatewayRoute,
    state: GatewayDeviceEmulationState
  ): Promise<void> {
    const current = route.deviceEmulationBySession.get(state.sessionId);
    if (current !== state || current.cdpSessionId) return;
    const profile = this.control.getProfile(route.publicPort);
    if (
      !profile ||
      profile.ownerSessionId !== state.sessionId ||
      profile.daemonInstanceId !== state.daemonInstanceId ||
      profile.sessionStatus !== "active" ||
      profile.ownership !== "agent"
    ) {
      return;
    }
    await this.controlDeviceEmulation({
      publicPort: route.publicPort,
      sessionId: state.sessionId,
      daemonInstanceId: state.daemonInstanceId,
      command: "emulate",
      preset: state.preset,
      targetId: state.targetId,
      timeoutMs: 5_000
    }).catch(() => undefined);
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

  private async waitForLoadedUnpackedExtension(
    route: GatewayRoute,
    identity: GatewayConnectionIdentity,
    extensionPath: string,
    extensionVersion: string | undefined,
    timeoutMs: number,
    intervalMs: number
  ): Promise<{ id: string } | null> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      this.control.assertConnectionCanSend(identity);
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const result = await this.sendRaw(
          route,
          "Extensions.getExtensions",
          {},
          Math.min(5_000, remaining)
        ) as {
          extensions?: Array<{
            id?: unknown;
            path?: unknown;
            version?: unknown;
            enabled?: unknown;
          }>;
        };
        const match = (result.extensions || []).find((extension) =>
          typeof extension.id === "string" &&
          typeof extension.path === "string" &&
          sameFilesystemPath(extension.path, extensionPath) &&
          extension.enabled !== false &&
          (!extensionVersion || extension.version === extensionVersion)
        );
        if (match && typeof match.id === "string") {
          return { id: match.id };
        }
      } catch (error) {
        const candidate = error as Error & { code?: unknown };
        if (candidate.code !== "CDP_CALL_TIMEOUT") throw error;
      }
      const delayMs = Math.min(Math.max(1, intervalMs), Math.max(0, deadline - Date.now()));
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
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
        const error = new Error(`CDP call ${method} timed out`) as Error & {
          code?: string;
          method?: string;
        };
        error.code = "CDP_CALL_TIMEOUT";
        error.method = method;
        reject(error);
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

  private queueOverlayAvoidance(
    route: GatewayRoute,
    sessionId: string | undefined,
    params: Record<string, unknown>
  ): void {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!sessionId || !Number.isFinite(x) || !Number.isFinite(y) || route.pending.size >= MAX_PENDING_REQUESTS - 1) {
      return;
    }
    // Keep this in the same backend command queue as the click, but do not await
    // its response. Chrome receives the tiny hit-test/evasion script first, so
    // the click itself incurs no extra network round trip.
    const expression = `(() => {
      const host = document.getElementById("__pp-agent-overlay");
      if (!host) return false;
      const target = (document.elementsFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)}) || []).find((element) =>
        element !== host &&
        element.id !== "__pp-agent-overlay" &&
        !(typeof element.closest === "function" && element.closest("#__pp-agent-overlay,[data-pp-ui]"))
      );
      const rect = target && typeof target.getBoundingClientRect === "function"
        ? target.getBoundingClientRect()
        : { left: ${JSON.stringify(x)}, top: ${JSON.stringify(y)}, right: ${JSON.stringify(x + 1)}, bottom: ${JSON.stringify(y + 1)}, width: 1, height: 1 };
      host.dispatchEvent(new CustomEvent("__pp-agent-overlay-avoid", {
        detail: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        }
      }));
      return true;
    })()`;
    void this.sendRaw(
      route,
      "Runtime.evaluate",
      { expression, awaitPromise: false, returnByValue: false },
      750,
      sessionId
    ).catch(() => undefined);
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

function publicDeviceEmulation(
  state: GatewayDeviceEmulationState | undefined
): GatewayDeviceEmulation | null {
  if (!state) return null;
  return {
    preset: state.preset,
    targetId: state.targetId,
    width: state.width,
    height: state.height,
    deviceScaleFactor: state.deviceScaleFactor,
    mobile: state.mobile,
    maxTouchPoints: state.maxTouchPoints,
    userAgent: state.userAgent,
    platform: state.platform
  };
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    let resolved: string;
    try {
      resolved = realpathSync(value);
    } catch {
      resolved = path.resolve(value);
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function deviceHandoffKey(publicPort: number, sessionId: string): string {
  return `${publicPort}:${sessionId}`;
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
