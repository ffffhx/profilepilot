import type { AgentActivity, CdpClientInfo } from "../shared/types";
import { CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo } from "./cdp-client";
import type { CdpTargetListEntry, CdpVersionInfo } from "./internal-types";
import { agentOverlayBootstrapScript } from "./overlay-script";
import { isRecord, stringValue } from "./fs-util";
import { SessionTailer, type SessionTailerBase } from "./session-tail";

const BINDING_NAME = "__ppAgentOverlaySignal";
const OVERLAY_WORLD_NAME = "__ppAgentOverlayWorld";
const PAGE_CONNECT_TIMEOUT = 3000;
const PUSH_INTERVAL_MS = 2000;
const TAKEN_OVER_KEEPALIVE_MS = 7000;
const CONTEXT_RECOVERY_COOLDOWN_MS = 3000;
const TARGET_CACHE_TTL_MS = 1500;

export type OverlayLocale = "zh" | "en";

export interface AgentOverlayPortInput {
  port: number;
  profileId: string;
  profileName: string;
  clients: CdpClientInfo[];
}

export interface AgentOverlaySyncInput {
  enabled: boolean;
  ports: AgentOverlayPortInput[];
}

export interface AgentOverlayStopRequest {
  port: number;
  profileId: string;
  profileName: string;
  pid: number;
  pids?: number[];
  session?: string;
  agent?: string;
  stopAll?: boolean;
}

export interface AgentOverlayRevealRequest {
  port: number;
  profileId: string;
  profileName: string;
}

interface AgentOverlayManagerOptions {
  locale?: OverlayLocale;
  onStop: (request: AgentOverlayStopRequest) => Promise<void>;
  onReveal?: (request: AgentOverlayRevealRequest) => void;
  now?: () => number;
  requestTargets?: (port: number) => Promise<CdpTargetListEntry[]>;
  requestVersionInfo?: (port: number) => Promise<CdpVersionInfo>;
  connectBrowser?: (webSocketDebuggerUrl: string, timeoutMs: number) => Promise<OverlayBrowserClient>;
}

type OverlayState = "active" | "takenOver";

interface OverlayPayload {
  locale: OverlayLocale;
  state: OverlayState;
  profileName: string;
  agent: string | null;
  project: string | null;
  session: string | null;
  sessionTitle: string | null;
  currentAction: string | null;
  targetUrl: string | null;
  currentStep: string | null;
  nextStep: string | null;
  todoDone: number | null;
  todoTotal: number | null;
  lastMessage: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  sessions: OverlaySessionPayload[];
  stopError?: string | null;
}

interface AgentOverlayPayloadInput {
  locale?: OverlayLocale;
  state: "active" | "takenOver";
  profileName: string;
  clients: CdpClientInfo[];
  lastPayload?: OverlayPayload | null;
  activityForClient?: (client: CdpClientInfo) => AgentActivity;
  startedAtForClient?: (client: CdpClientInfo) => string | undefined;
  now?: number;
}

interface OverlaySessionPayload {
  agent: string | null;
  project: string | null;
  session: string | null;
  sessionTitle: string | null;
  lastActive: string | null;
  startedAt: string | null;
}

interface OverlaySessionRow {
  client: CdpClientInfo;
  activity: AgentActivity;
  startedAt?: string;
}

interface PageOverlay {
  targetId: string;
  url: string;
  sessionId: string | null;
  attachPending: boolean;
  connecting: boolean;
  closing: boolean;
  scriptIdentifier?: string;
  mainFrameId?: string;
  activeContextId?: number;
  isolatedContextIds: Set<number>;
  lastPayloadText: string;
  lastPushAt: number;
  lastContextRecoveryAt: number;
  recoveringContext: boolean;
}

interface OverlayBrowserClient {
  onEvent: ((method: string, params: unknown, sessionId?: string) => void) | null;
  onDisconnect: (() => void) | null;
  send<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<T>;
  close(): void;
}

interface PortOverlay {
  port: number;
  profileId: string;
  profileName: string;
  clients: CdpClientInfo[];
  pages: Map<string, PageOverlay>;
  browserClient: OverlayBrowserClient | null;
  browserConnecting: boolean;
  syncing: boolean;
  targetSyncRequested: boolean;
  alive: boolean;
  takeoverInFlight: boolean;
  takenOverUntil: number;
  lastPayload: OverlayPayload | null;
  stopError: string | null;
  sessionStartedAt: Map<string, string>;
  targetCache: { targets: CdpTargetListEntry[]; expiresAt: number } | null;
  targetRequest: Promise<CdpTargetListEntry[] | null> | null;
  targetCacheGeneration: number;
}

export class AgentOverlayManager {
  private readonly ports = new Map<number, PortOverlay>();
  private readonly tailers = new Map<string, SessionTailer>();
  private readonly script = agentOverlayBootstrapScript();
  private disposed = false;

  constructor(private readonly options: AgentOverlayManagerOptions) {}

  sync(input: AgentOverlaySyncInput): void {
    if (this.disposed) {
      return;
    }
    if (!input.enabled) {
      this.stopAllTailers();
      for (const state of this.ports.values()) {
        void this.teardownPort(state);
      }
      this.ports.clear();
      return;
    }

    const now = this.now();
    const wanted = new Map(input.ports.map((port) => [port.port, port]));
    for (const [port, state] of [...this.ports]) {
      const next = wanted.get(port);
      if (next) {
        state.profileId = next.profileId;
        state.profileName = next.profileName;
        state.clients = next.clients;
        this.syncSessionStarts(state, now);
        if (state.clients.length && state.takenOverUntil > now) {
          // 用户接管后 7 秒内保留 takenOver overlay；但 agent-browser 同会话或新会话重连即恢复 active。
          state.takenOverUntil = 0;
          state.lastPayload = null;
        }
        continue;
      }
      if (state.takenOverUntil > now) {
        state.clients = [];
        continue;
      }
      this.ports.delete(port);
      this.teardownPort(state);
    }

    for (const next of wanted.values()) {
      let state = this.ports.get(next.port);
      if (!state) {
        state = {
          port: next.port,
          profileId: next.profileId,
          profileName: next.profileName,
          clients: next.clients,
          pages: new Map(),
          browserClient: null,
          browserConnecting: false,
          syncing: false,
          targetSyncRequested: false,
          alive: true,
          takeoverInFlight: false,
          takenOverUntil: 0,
          lastPayload: null,
          stopError: null,
          targetCache: null,
          targetRequest: null,
          targetCacheGeneration: 0,
          sessionStartedAt: new Map()
        };
        this.syncSessionStarts(state, now);
        this.ports.set(next.port, state);
      } else {
        state.profileId = next.profileId;
        state.profileName = next.profileName;
        state.clients = next.clients;
        this.syncSessionStarts(state, now);
        if (state.clients.length && state.takenOverUntil > now) {
          // 7 秒 keepalive 只覆盖无人接手的窗口；重连成功后下一次 push 会回到 active。
          state.takenOverUntil = 0;
          state.lastPayload = null;
        }
      }
    }

    this.syncTailers();
    for (const state of this.ports.values()) {
      void this.ensureTargetObserver(state).catch(() => undefined);
      void this.syncPortTargets(state).catch(() => undefined);
      void this.pushPortUpdate(state).catch(() => undefined);
    }
  }

  getActivity(clients: CdpClientInfo[]): AgentActivity | null {
    const primary = orderedClientsByActivity(clients)[0];
    return primary ? this.activityForClient(primary) : null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopAllTailers();
    const states = [...this.ports.values()];
    this.ports.clear();
    await Promise.allSettled(states.map((state) => this.teardownPort(state)));
  }

  private syncTailers(): void {
    const wanted = new Map<string, SessionTailerBase>();
    for (const state of this.ports.values()) {
      for (const client of state.clients) {
        if (!client.session) {
          continue;
        }
        wanted.set(client.session, {
          agent: inferAgentName(client),
          project: client.project,
          sessionTitle: client.title
        });
      }
    }

    for (const [session, tailer] of [...this.tailers]) {
      const base = wanted.get(session);
      if (!base) {
        tailer.stop();
        this.tailers.delete(session);
        continue;
      }
      tailer.updateBase(base);
    }

    for (const [session, base] of wanted) {
      if (this.tailers.has(session)) {
        continue;
      }
      const tailer = new SessionTailer(session, base, () => {
        void this.pushAllUpdates().catch(() => undefined);
      });
      tailer.start();
      this.tailers.set(session, tailer);
    }
  }

  private stopAllTailers(): void {
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    this.tailers.clear();
  }

  private async syncPortTargets(state: PortOverlay): Promise<void> {
    if (!this.isActivePort(state)) {
      return;
    }
    if (state.syncing) {
      state.targetSyncRequested = true;
      return;
    }
    state.syncing = true;
    try {
      const targets = await this.targetsForPort(state);
      if (!this.isActivePort(state)) {
        return;
      }
      if (!targets) {
        this.invalidateTargetCache(state);
        for (const page of [...state.pages.values()]) {
          void this.teardownPage(state, page).catch(() => undefined);
        }
        return;
      }

      const wanted = new Map<string, CdpTargetListEntry>();
      for (const target of targets) {
        if (!isInjectableTarget(target)) {
          continue;
        }
        const key = targetKey(target);
        if (key) {
          wanted.set(key, target);
        }
      }

      for (const [targetId, page] of [...state.pages]) {
        if (!wanted.has(targetId)) {
          void this.teardownPage(state, page).catch(() => undefined);
        }
      }

      for (const [targetId, target] of wanted) {
        if (!this.isActivePort(state)) {
          return;
        }
        const page = state.pages.get(targetId);
        if (page) {
          page.url = target.url || page.url;
          void this.attachPage(state, page).catch(() => undefined);
          continue;
        }
        void this.connectPage(state, targetId, target).catch(() => undefined);
      }
    } finally {
      if (this.ports.get(state.port) === state) {
        state.syncing = false;
        if (state.targetSyncRequested) {
          state.targetSyncRequested = false;
          void this.syncPortTargets(state).catch(() => undefined);
        }
      }
    }
  }

  private async ensureTargetObserver(state: PortOverlay): Promise<void> {
    if (!this.isActivePort(state) || state.browserClient || state.browserConnecting) {
      return;
    }
    state.browserConnecting = true;
    try {
      const version = await (this.options.requestVersionInfo || requestCdpVersionInfo)(state.port).catch(() => null);
      if (!this.isActivePort(state)) {
        return;
      }
      const webSocketDebuggerUrl = version?.webSocketDebuggerUrl;
      if (!webSocketDebuggerUrl) {
        return;
      }
      const client = await (this.options.connectBrowser || CdpBrowserClient.connect)(webSocketDebuggerUrl, PAGE_CONNECT_TIMEOUT);
      if (!this.isActivePort(state)) {
        client.close();
        return;
      }
      state.browserClient = client;
      this.invalidateTargetCache(state);
      client.onEvent = (method, params, sessionId) => {
        this.handleBrowserEvent(state, method, params, sessionId);
      };
      client.onDisconnect = () => {
        if (state.browserClient === client) {
          state.browserClient = null;
          this.invalidateTargetCache(state);
          for (const page of state.pages.values()) {
            page.sessionId = null;
            page.attachPending = false;
            page.connecting = false;
            page.scriptIdentifier = undefined;
            page.mainFrameId = undefined;
            page.activeContextId = undefined;
            page.isolatedContextIds.clear();
          }
        }
      };
      await client.send("Target.setDiscoverTargets", { discover: true }, 5000);
      if (!this.isActivePort(state) || state.browserClient !== client) {
        return;
      }
      await client.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        5000
      );
    } catch {
      this.teardownTargetObserver(state);
    } finally {
      if (this.ports.get(state.port) === state) {
        state.browserConnecting = false;
      }
    }
  }

  private handleBrowserEvent(state: PortOverlay, method: string, params: unknown, sessionId?: string): void {
    if (!this.isActivePort(state)) {
      return;
    }
    if (
      method === "Runtime.bindingCalled" ||
      method === "Runtime.executionContextCreated" ||
      method === "Runtime.executionContextDestroyed" ||
      method === "Runtime.executionContextsCleared" ||
      method === "Page.frameNavigated"
    ) {
      const page = this.pageForSession(state, sessionId);
      if (page) {
        this.handlePageEvent(state, page, method, params);
      }
      return;
    }

    if (method === "Target.attachedToTarget") {
      this.handleAttachedToTarget(state, params);
      return;
    }

    if (method === "Target.detachedFromTarget") {
      this.handleDetachedFromTarget(state, params);
      return;
    }

    if (!method.startsWith("Target.target")) {
      return;
    }
    this.invalidateTargetCache(state);

    if (method === "Target.targetDestroyed" && isRecord(params)) {
      const targetId = stringValue(params.targetId);
      const page = targetId ? state.pages.get(targetId) : null;
      if (page) {
        void this.teardownPage(state, page).catch(() => undefined);
      }
      return;
    }

    if (isRecord(params) && isRecord(params.targetInfo)) {
      const targetInfo = params.targetInfo;
      if (stringValue(targetInfo.type) !== "page") {
        return;
      }
      const targetId = stringValue(targetInfo.targetId) || stringValue(targetInfo.id);
      const page = targetId ? state.pages.get(targetId) : null;
      if (page) {
        page.url = stringValue(targetInfo.url) || page.url;
      }
    }
    void this.syncPortTargets(state).catch(() => undefined);
  }

  private async connectPage(state: PortOverlay, targetId: string, target: CdpTargetListEntry): Promise<void> {
    if (!this.isActivePort(state)) {
      return;
    }
    const page = this.upsertPage(state, targetId, target.url || "");
    await this.attachPage(state, page);
  }

  private handleAttachedToTarget(state: PortOverlay, params: unknown): void {
    if (!this.isActivePort(state)) {
      return;
    }
    if (!isRecord(params) || !isRecord(params.targetInfo)) {
      return;
    }
    const sessionId = stringValue(params.sessionId);
    const targetInfo = params.targetInfo;
    if (!sessionId || stringValue(targetInfo.type) !== "page") {
      return;
    }
    const targetId = stringValue(targetInfo.targetId) || stringValue(targetInfo.id);
    if (!targetId || !isInjectableTargetInfo(targetInfo)) {
      return;
    }

    const page = this.upsertPage(state, targetId, stringValue(targetInfo.url) || "");
    if (page.sessionId && page.sessionId !== sessionId) {
      page.connecting = false;
      page.scriptIdentifier = undefined;
      page.lastPayloadText = "";
      page.mainFrameId = undefined;
      page.activeContextId = undefined;
      page.isolatedContextIds.clear();
    }
    page.sessionId = sessionId;
    page.attachPending = false;
    void this.initializePageSession(state, page, sessionId).catch(() => undefined);
  }

  private handleDetachedFromTarget(state: PortOverlay, params: unknown): void {
    if (!this.isActivePort(state)) {
      return;
    }
    if (!isRecord(params)) {
      return;
    }
    const sessionId = stringValue(params.sessionId);
    const page = this.pageForSession(state, sessionId || undefined);
    if (!page) {
      return;
    }
    page.sessionId = null;
    page.attachPending = false;
    page.connecting = false;
    page.scriptIdentifier = undefined;
    page.mainFrameId = undefined;
    page.activeContextId = undefined;
    page.isolatedContextIds.clear();
    page.lastPayloadText = "";
    void this.syncPortTargets(state).catch(() => undefined);
  }

  private upsertPage(state: PortOverlay, targetId: string, url: string): PageOverlay {
    const existing = state.pages.get(targetId);
    if (existing) {
      existing.url = url || existing.url;
      return existing;
    }
    const page: PageOverlay = {
      targetId,
      url,
      sessionId: null,
      attachPending: false,
      connecting: false,
      closing: false,
      isolatedContextIds: new Set(),
      lastPayloadText: "",
      lastPushAt: 0,
      lastContextRecoveryAt: 0,
      recoveringContext: false
    };
    state.pages.set(targetId, page);
    return page;
  }

  private async attachPage(state: PortOverlay, page: PageOverlay): Promise<void> {
    const client = state.browserClient;
    if (!this.isActivePage(state, page) || !client || state.browserConnecting || page.sessionId || page.attachPending || page.connecting || page.closing) {
      return;
    }
    page.attachPending = true;
    try {
      const result = await client.send<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
        5000
      );
      const sessionId = result.sessionId;
      if (!sessionId) {
        return;
      }
      if (!this.isActivePage(state, page)) {
        await client.send("Target.detachFromTarget", { sessionId }, 2000).catch(() => undefined);
        return;
      }
      page.sessionId = sessionId;
      await this.initializePageSession(state, page, sessionId);
    } catch {
      // Auto-attach may have won the race, or the target may have disappeared.
    } finally {
      if (state.pages.get(page.targetId) === page) {
        page.attachPending = false;
      }
    }
  }

  private async initializePageSession(state: PortOverlay, page: PageOverlay, sessionId: string): Promise<void> {
    const client = state.browserClient;
    if (!this.isActivePage(state, page) || !client || page.connecting || page.closing || page.sessionId !== sessionId) {
      return;
    }
    page.connecting = true;
    try {
      await client.send("Runtime.enable", {}, 5000, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      await client.send("Page.enable", {}, 5000, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      await client.send("Runtime.addBinding", { name: BINDING_NAME, executionContextName: OVERLAY_WORLD_NAME }, 5000, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      const addScript = await client.send<{ identifier?: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: this.script, worldName: OVERLAY_WORLD_NAME },
        5000,
        sessionId
      );
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      page.scriptIdentifier = addScript.identifier;
      page.mainFrameId = await this.mainFrameIdForSession(client, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      const context = await client.send<{ executionContextId?: number }>(
        "Page.createIsolatedWorld",
        { frameId: page.mainFrameId, worldName: OVERLAY_WORLD_NAME },
        5000,
        sessionId
      );
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      const contextId = numberValue(context.executionContextId);
      if (contextId === null) {
        throw new Error("Chrome did not create an overlay isolated world.");
      }
      this.rememberIsolatedContext(page, contextId, page.mainFrameId);
      await client.send("Runtime.evaluate", { expression: this.script, awaitPromise: false, contextId }, 5000, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      page.connecting = false;
      await this.pushPageUpdate(state, page, true);
    } catch {
      if (this.isActivePage(state, page) && page.sessionId === sessionId) {
        page.sessionId = null;
        page.scriptIdentifier = undefined;
        page.lastPayloadText = "";
      }
    } finally {
      if (state.pages.get(page.targetId) === page) {
        page.connecting = false;
      }
    }
  }

  private pageForSession(state: PortOverlay, sessionId?: string): PageOverlay | null {
    if (!sessionId) {
      return null;
    }
    for (const page of state.pages.values()) {
      if (page.sessionId === sessionId) {
        return page;
      }
    }
    return null;
  }

  private async mainFrameIdForSession(client: OverlayBrowserClient, sessionId: string): Promise<string> {
    const result = await client.send<{ frameTree?: unknown }>("Page.getFrameTree", {}, 5000, sessionId);
    const frameTree = isRecord(result.frameTree) ? result.frameTree : null;
    const frame = frameTree && isRecord(frameTree.frame) ? frameTree.frame : null;
    const frameId = frame ? stringValue(frame.id) : "";
    if (!frameId) {
      throw new Error("Chrome did not expose the page main frame.");
    }
    return frameId;
  }

  private handlePageEvent(state: PortOverlay, page: PageOverlay, method: string, params: unknown): void {
    if (method === "Runtime.executionContextCreated") {
      this.handleExecutionContextCreated(page, params);
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const contextId = isRecord(params) ? numberValue(params.executionContextId) : null;
      if (contextId !== null) {
        page.isolatedContextIds.delete(contextId);
        if (page.activeContextId === contextId) {
          page.activeContextId = undefined;
        }
      }
      return;
    }
    if (method === "Runtime.executionContextsCleared") {
      page.isolatedContextIds.clear();
      page.activeContextId = undefined;
      return;
    }
    if (method === "Page.frameNavigated") {
      this.handleFrameNavigated(page, params);
      return;
    }
    if (method !== "Runtime.bindingCalled" || !isRecord(params) || stringValue(params.name) !== BINDING_NAME) {
      return;
    }
    if (!this.isTrustedBindingCall(page, params)) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(stringValue(params.payload) || "{}");
    } catch {
      return;
    }
    if (!isRecord(payload)) {
      return;
    }
    const action = stringValue(payload.action);
    if (action === "hide") {
      return;
    }
    if (action === "reveal") {
      this.options.onReveal?.({ port: state.port, profileId: state.profileId, profileName: state.profileName });
      return;
    }
    if (action === "stop") {
      const session = stringValue(payload.session) || undefined;
      void this.handleStopSignal(state, session).catch(() => undefined);
    }
  }

  private handleExecutionContextCreated(page: PageOverlay, params: unknown): void {
    if (!isRecord(params) || !isRecord(params.context)) {
      return;
    }
    const context = params.context;
    if (stringValue(context.name) !== OVERLAY_WORLD_NAME) {
      return;
    }
    const contextId = numberValue(context.id);
    if (contextId === null) {
      return;
    }
    const auxData = isRecord(context.auxData) ? context.auxData : null;
    const frameId = auxData ? stringValue(auxData.frameId) || undefined : undefined;
    if (!page.mainFrameId || frameId !== page.mainFrameId) {
      return;
    }
    this.rememberIsolatedContext(page, contextId, frameId);
  }

  private handleFrameNavigated(page: PageOverlay, params: unknown): void {
    if (!isRecord(params) || !isRecord(params.frame)) {
      return;
    }
    const frame = params.frame;
    const parentId = stringValue(frame.parentId);
    const frameId = stringValue(frame.id);
    if (!parentId && frameId) {
      page.mainFrameId = frameId;
      page.activeContextId = undefined;
      page.isolatedContextIds.clear();
      page.lastPayloadText = "";
      page.lastPushAt = 0;
    }
  }

  private rememberIsolatedContext(page: PageOverlay, contextId: number, frameId?: string): void {
    if (!page.mainFrameId || frameId !== page.mainFrameId) {
      return;
    }
    page.isolatedContextIds.add(contextId);
    if (!page.activeContextId || frameId === page.mainFrameId) {
      page.activeContextId = contextId;
    }
  }

  private isTrustedBindingCall(page: PageOverlay, params: Record<string, unknown>): boolean {
    const contextId = numberValue(params.executionContextId);
    return contextId !== null && page.isolatedContextIds.has(contextId);
  }

  private async handleStopSignal(state: PortOverlay, requestedSession?: string): Promise<void> {
    if (!this.isActivePort(state) || state.takeoverInFlight || this.now() < state.takenOverUntil) {
      return;
    }
    const drivers = this.findStopDrivers(state, requestedSession);
    if (!drivers.length) {
      return;
    }

    state.takeoverInFlight = true;
    let firstError: unknown = null;
    const stopAll = !requestedSession && drivers.length > 1;
    try {
      try {
        const driver = drivers[0];
        await this.options.onStop({
          port: state.port,
          profileId: state.profileId,
          profileName: state.profileName,
          pid: driver.pid,
          pids: stopAll ? undefined : drivers.map((client) => client.pid),
          session: stopAll ? undefined : requestedSession || driver.session,
          agent: stopAll ? undefined : inferAgentName(driver),
          stopAll
        });
      } catch (error) {
        firstError = error;
      }
      if (firstError) {
        if (!stopAll) {
          throw firstError instanceof Error ? firstError : new Error("没有可停止的 AI 驱动连接。");
        }
        state.stopError = this.stopErrorMessage(drivers.length, 0, firstError);
        state.takenOverUntil = 0;
        state.lastPayload = {
          ...this.payloadForPort(state),
          state: "active",
          stopError: state.stopError
        };
        await this.pushPortUpdate(state, true);
        if (firstError) {
          console.warn("[ProfilePilot] Agent overlay stop-all failed", firstError);
        }
        return;
      }
      if (!this.isActivePort(state)) {
        return;
      }
      state.stopError = null;
      state.takenOverUntil = this.now() + TAKEN_OVER_KEEPALIVE_MS;
      state.lastPayload = {
        ...this.payloadForPort(state),
        state: "takenOver"
      };
      await this.pushPortUpdate(state, true);
    } finally {
      if (this.ports.get(state.port) === state) {
        state.takeoverInFlight = false;
      }
    }
  }

  private findStopDrivers(state: PortOverlay, requestedSession?: string): CdpClientInfo[] {
    const primary = state.clients[0];
    const agentBrowser = state.clients.filter((client) => client.label === "agent-browser");
    if (requestedSession) {
      const exact = uniqueClientsByPid(agentBrowser.filter((client) => client.session === requestedSession));
      if (exact.length) {
        return exact;
      }
      const sessionClient = state.clients.find((client) => client.session === requestedSession);
      return sessionClient ? [sessionClient] : [];
    }

    if (this.sessionRowsForPort(state).length >= 2) {
      const drivers = uniqueClientsByPid(agentBrowser);
      return drivers.length ? drivers : uniqueClientsByPid(state.clients);
    }

    return uniqueClientsByPid([agentBrowser[0] || primary].filter(Boolean) as CdpClientInfo[]);
  }

  private async pushAllUpdates(): Promise<void> {
    await Promise.all([...this.ports.values()].map((state) => this.pushPortUpdate(state).catch(() => undefined)));
  }

  private async targetsForPort(state: PortOverlay): Promise<CdpTargetListEntry[] | null> {
    const now = this.now();
    if (state.targetCache && state.targetCache.expiresAt > now) {
      return state.targetCache.targets;
    }
    if (state.targetRequest) {
      return state.targetRequest;
    }
    const requestTargets = this.options.requestTargets || requestCdpTargets;
    const generation = state.targetCacheGeneration || 0;
    const request = requestTargets(state.port)
      .then((targets) => {
        if (!this.isActivePort(state)) {
          return null;
        }
        if (state.targetCacheGeneration === generation) {
          state.targetCache = { targets, expiresAt: this.now() + TARGET_CACHE_TTL_MS };
        }
        return targets;
      })
      .catch(() => {
        if (this.isActivePort(state)) {
          this.invalidateTargetCache(state);
        }
        return null;
      })
      .finally(() => {
        if (this.ports.get(state.port) === state && state.targetRequest === request) {
          state.targetRequest = null;
        }
      });
    state.targetRequest = request;
    return state.targetRequest;
  }

  private invalidateTargetCache(state: PortOverlay): void {
    state.targetCache = null;
    state.targetRequest = null;
    state.targetCacheGeneration = (state.targetCacheGeneration || 0) + 1;
  }

  private stopErrorMessage(total: number, stopped: number, error: unknown): string {
    const detail = error instanceof Error && error.message ? `：${error.message}` : "";
    if ((this.options.locale ?? "en") === "zh") {
      return `部分停止失败，请重试（已停止 ${stopped}/${total}）${detail}`;
    }
    return `Some sessions failed to stop. Try again (${stopped}/${total} stopped)${detail}`;
  }

  private async pushPortUpdate(state: PortOverlay, force = false): Promise<void> {
    if (!this.isActivePort(state)) {
      return;
    }
    await Promise.all([...state.pages.values()].map((page) => this.pushPageUpdate(state, page, force).catch(() => undefined)));
  }

  private async pushPageUpdate(state: PortOverlay, page: PageOverlay, force = false): Promise<void> {
    const client = state.browserClient;
    const sessionId = page.sessionId;
    if (!this.isActivePage(state, page) || !client || !sessionId || page.connecting || page.closing) {
      return;
    }
    const payload = this.payloadForPort(state);
    const text = safeJson(payload);
    const now = this.now();
    if (!force && page.lastPayloadText === text && now - page.lastPushAt < PUSH_INTERVAL_MS) {
      return;
    }
    const contextIds = this.contextIdsForPage(page);
    if (!contextIds.length) {
      return;
    }
    let pushed = false;
    for (const contextId of contextIds) {
      try {
        await client.send(
          "Runtime.evaluate",
          {
            expression: `globalThis.__ppAgentOverlayUpdate && globalThis.__ppAgentOverlayUpdate(${text})`,
            awaitPromise: false,
            contextId
          },
          3000,
          sessionId
        );
        if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
          return;
        }
        pushed = true;
      } catch {
        page.isolatedContextIds.delete(contextId);
        if (page.activeContextId === contextId) {
          page.activeContextId = undefined;
        }
      }
    }
    if (pushed) {
      page.lastPayloadText = text;
      page.lastPushAt = now;
      state.lastPayload = payload;
    } else {
      await this.recoverPageContext(state, page, sessionId, now).catch(() => undefined);
    }
  }

  private async recoverPageContext(state: PortOverlay, page: PageOverlay, sessionId: string, now: number): Promise<void> {
    const client = state.browserClient;
    if (
      !this.isActivePage(state, page) ||
      !client ||
      page.sessionId !== sessionId ||
      page.connecting ||
      page.closing ||
      page.recoveringContext ||
      now - page.lastContextRecoveryAt < CONTEXT_RECOVERY_COOLDOWN_MS
    ) {
      return;
    }

    page.recoveringContext = true;
    page.lastContextRecoveryAt = now;
    try {
      if (!page.mainFrameId) {
        page.mainFrameId = await this.mainFrameIdForSession(client, sessionId);
        if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
          return;
        }
      }
      const context = await client.send<{ executionContextId?: number }>(
        "Page.createIsolatedWorld",
        { frameId: page.mainFrameId, worldName: OVERLAY_WORLD_NAME },
        5000,
        sessionId
      );
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      const contextId = numberValue(context.executionContextId);
      if (contextId === null) {
        return;
      }
      this.rememberIsolatedContext(page, contextId, page.mainFrameId);
      await client.send("Runtime.evaluate", { expression: this.script, awaitPromise: false, contextId }, 5000, sessionId);
      if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
        return;
      }
      page.lastPayloadText = "";
      await this.pushPageUpdate(state, page, true);
    } finally {
      if (state.pages.get(page.targetId) === page) {
        page.recoveringContext = false;
      }
    }
  }

  private contextIdsForPage(page: PageOverlay): number[] {
    const ids = [...page.isolatedContextIds];
    if (page.activeContextId && page.isolatedContextIds.has(page.activeContextId)) {
      return [page.activeContextId, ...ids.filter((id) => id !== page.activeContextId)];
    }
    return ids;
  }

  private payloadForPort(state: PortOverlay): OverlayPayload {
    const takenOver = state.takenOverUntil > this.now();
    const payload = buildAgentOverlayPayload({
      locale: this.options.locale ?? "en",
      state: takenOver ? "takenOver" : "active",
      profileName: state.profileName,
      clients: state.clients,
      lastPayload: state.lastPayload,
      activityForClient: (client) => this.activityForClient(client),
      startedAtForClient: (client) => this.startedAtForClient(state, client),
      now: this.now()
    });
    if (!state.stopError) {
      return payload;
    }
    return {
      ...payload,
      stopError: state.stopError
    };
  }

  private syncSessionStarts(state: PortOverlay, now: number): void {
    const activeKeys = new Set<string>();
    const startedAt = new Date(now).toISOString();
    for (const client of state.clients) {
      const key = clientSessionKey(client);
      activeKeys.add(key);
      if (!state.sessionStartedAt.has(key)) {
        state.sessionStartedAt.set(key, startedAt);
      }
    }
    for (const key of [...state.sessionStartedAt.keys()]) {
      if (!activeKeys.has(key)) {
        state.sessionStartedAt.delete(key);
      }
    }
  }

  private sessionRowsForPort(state: PortOverlay): OverlaySessionRow[] {
    return sessionRowsForClients(
      state.clients,
      (client) => this.activityForClient(client),
      (client) => this.startedAtForClient(state, client)
    );
  }

  private startedAtForClient(state: PortOverlay, client: CdpClientInfo): string | undefined {
    return state.sessionStartedAt.get(clientSessionKey(client));
  }

  private activityForClient(client: CdpClientInfo): AgentActivity {
    if (client.session) {
      const tailed = this.tailers.get(client.session)?.getActivity();
      if (tailed) {
        return {
          agent: inferAgentName(client),
          project: client.project,
          session: client.session,
          sessionTitle: client.title,
          ...tailed
        };
      }
    }
    return {
      agent: inferAgentName(client),
      project: client.project,
      session: client.session,
      sessionTitle: client.title,
      updatedAt: client.lastActive
    };
  }

  private async teardownPort(state: PortOverlay): Promise<void> {
    state.alive = false;
    this.invalidateTargetCache(state);
    const pages = [...state.pages.values()];
    state.pages.clear();
    await Promise.allSettled(pages.map((page) => this.teardownPage(state, page)));
    this.teardownTargetObserver(state);
  }

  private teardownTargetObserver(state: PortOverlay): void {
    const client = state.browserClient;
    state.browserClient = null;
    state.browserConnecting = false;
    client?.close();
  }

  private async teardownPage(state: PortOverlay, page: PageOverlay): Promise<void> {
    if (page.closing) {
      return;
    }
    page.closing = true;
    state.pages.delete(page.targetId);
    const client = state.browserClient;
    const sessionId = page.sessionId;
    if (!client || !sessionId) {
      return;
    }
    if (page.scriptIdentifier) {
      await client
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.scriptIdentifier }, 2000, sessionId)
        .catch(() => undefined);
    }
    await Promise.allSettled(
      this.contextIdsForPage(page).map((contextId) =>
        client.send(
          "Runtime.evaluate",
          {
            expression: "globalThis.__ppAgentOverlayTeardown && globalThis.__ppAgentOverlayTeardown()",
            awaitPromise: false,
            contextId
          },
          2000,
          sessionId
        )
      )
    );
    await client.send("Runtime.removeBinding", { name: BINDING_NAME }, 2000, sessionId).catch(() => undefined);
    page.isolatedContextIds.clear();
    page.activeContextId = undefined;
    await client.send("Target.detachFromTarget", { sessionId }, 2000).catch(() => undefined);
  }

  private isActivePort(state: PortOverlay): boolean {
    return !this.disposed && state.alive && this.ports.get(state.port) === state;
  }

  private isActivePage(state: PortOverlay, page: PageOverlay): boolean {
    return this.isActivePort(state) && state.pages.get(page.targetId) === page && !page.closing;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export function buildAgentOverlayPayload(input: AgentOverlayPayloadInput): OverlayPayload {
  if (!input.clients.length && input.lastPayload) {
    return normalizeOverlayPayload({
      ...input.lastPayload,
      locale: input.locale ?? input.lastPayload.locale,
      state: input.state === "takenOver" ? "takenOver" : input.lastPayload.state,
      profileName: input.profileName
    });
  }

  const activityForClient = input.activityForClient || baseActivityForClient;
  const startedAtForClient = input.startedAtForClient || (() => undefined);
  const sessionRows = sessionRowsForClients(input.clients, activityForClient, startedAtForClient);
  const primary = sessionRows[0]?.client || orderedClientsByActivity(input.clients)[0];
  const activity = primary ? activityForClient(primary) : {};
  const now = input.now ?? Date.now();
  const startedAt = earliestStartedAt(sessionRows.map((row) => row.startedAt)) || (primary ? startedAtForClient(primary) : undefined);

  return normalizeOverlayPayload({
    locale: input.locale,
    state: input.state,
    profileName: input.profileName,
    startedAt,
    sessions: sessionRows.map((row) => ({
      agent: nullableString(row.activity.agent || inferAgentName(row.client)),
      project: nullableString(row.activity.project || row.client.project),
      session: nullableString(row.activity.session || row.client.session),
      sessionTitle: nullableString(row.activity.sessionTitle || row.client.title),
      lastActive: nullableString(row.client.lastActive || row.activity.updatedAt),
      startedAt: nullableString(row.startedAt)
    })),
    agent: nullableString(activity.agent || (primary ? inferAgentName(primary) : undefined)),
    project: nullableString(activity.project || primary?.project),
    session: nullableString(activity.session || primary?.session),
    sessionTitle: nullableString(activity.sessionTitle || primary?.title),
    currentAction: nullableString(activity.currentAction || (primary ? "AI 正在操作浏览器" : undefined)),
    targetUrl: nullableString(activityTargetUrl(activity)),
    currentStep: nullableString(activity.currentStep),
    nextStep: nullableString(activity.nextStep),
    todoDone: nullableNumber(activity.todoDone),
    todoTotal: nullableNumber(activity.todoTotal),
    lastMessage: nullableString(activity.lastMessage),
    updatedAt: nullableString(primary ? activity.updatedAt || primary.lastActive || new Date(now).toISOString() : undefined)
  });
}

export function isAgentOverlayClient(client: CdpClientInfo): boolean {
  return Boolean(client.agent) || client.label === "agent-browser" || client.label === "Codex" || client.label === "Claude Code";
}

function sessionRowsForClients(
  clients: CdpClientInfo[],
  activityForClient: (client: CdpClientInfo) => AgentActivity,
  startedAtForClient: (client: CdpClientInfo) => string | undefined
): OverlaySessionRow[] {
  const seen = new Set<string>();
  const rows: OverlaySessionRow[] = [];
  for (const client of orderedClientsByActivity(clients)) {
    const key = clientSessionKey(client);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      client,
      activity: activityForClient(client),
      startedAt: startedAtForClient(client)
    });
  }
  return rows;
}

function orderedClientsByActivity(clients: CdpClientInfo[]): CdpClientInfo[] {
  return [...clients].sort(compareClientsByActivity);
}

function compareClientsByActivity(left: CdpClientInfo, right: CdpClientInfo): number {
  const leftLastActive = lastActiveTimestamp(left);
  const rightLastActive = lastActiveTimestamp(right);
  const leftHasLastActive = Number.isFinite(leftLastActive);
  const rightHasLastActive = Number.isFinite(rightLastActive);
  if (leftHasLastActive && rightHasLastActive && leftLastActive !== rightLastActive) {
    return rightLastActive - leftLastActive;
  }
  if (leftHasLastActive !== rightHasLastActive) {
    return leftHasLastActive ? -1 : 1;
  }
  if (left.pid !== right.pid) {
    return left.pid - right.pid;
  }
  return 0;
}

function lastActiveTimestamp(client: CdpClientInfo): number {
  const timestamp = client.lastActive ? Date.parse(client.lastActive) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function baseActivityForClient(client: CdpClientInfo): AgentActivity {
  return {
    agent: inferAgentName(client),
    project: client.project,
    session: client.session,
    sessionTitle: client.title,
    updatedAt: client.lastActive
  };
}

function normalizeOverlayPayload(payload: Partial<OverlayPayload>): OverlayPayload {
  return {
    locale: normalizeOverlayLocale(payload.locale),
    state: payload.state === "takenOver" ? "takenOver" : "active",
    profileName: nullableString(payload.profileName) || "",
    agent: nullableString(payload.agent),
    project: nullableString(payload.project),
    session: nullableString(payload.session),
    sessionTitle: nullableString(payload.sessionTitle),
    currentAction: nullableString(payload.currentAction),
    targetUrl: nullableString(payload.targetUrl),
    currentStep: nullableString(payload.currentStep),
    nextStep: nullableString(payload.nextStep),
    todoDone: nullableNumber(payload.todoDone),
    todoTotal: nullableNumber(payload.todoTotal),
    lastMessage: nullableString(payload.lastMessage),
    updatedAt: nullableString(payload.updatedAt),
    startedAt: nullableString(payload.startedAt),
    sessions: Array.isArray(payload.sessions) ? payload.sessions.map(normalizeOverlaySessionPayload) : []
  };
}

function normalizeOverlayLocale(value: string | null | undefined): OverlayLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function normalizeOverlaySessionPayload(payload: Partial<OverlaySessionPayload>): OverlaySessionPayload {
  return {
    agent: nullableString(payload.agent),
    project: nullableString(payload.project),
    session: nullableString(payload.session),
    sessionTitle: nullableString(payload.sessionTitle),
    lastActive: nullableString(payload.lastActive),
    startedAt: nullableString(payload.startedAt)
  };
}

function nullableString(value: string | null | undefined): string | null {
  return value ? value : null;
}

function activityTargetUrl(activity: AgentActivity): string | undefined {
  const value = (activity as { targetUrl?: unknown }).targetUrl;
  return typeof value === "string" ? value : undefined;
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inferAgentName(client: CdpClientInfo): string | undefined {
  if (client.agent) {
    return client.agent;
  }
  if (client.session?.startsWith("cc-")) {
    return "Claude Code";
  }
  if (client.session?.startsWith("cx-")) {
    return "Codex";
  }
  return client.label || undefined;
}

function clientSessionKey(client: CdpClientInfo): string {
  return client.session ? `session:${client.session}` : `client:${client.label}:${client.pid}`;
}

function uniqueClientsByPid(clients: CdpClientInfo[]): CdpClientInfo[] {
  const seen = new Set<number>();
  const result: CdpClientInfo[] = [];
  for (const client of clients) {
    if (seen.has(client.pid)) {
      continue;
    }
    seen.add(client.pid);
    result.push(client);
  }
  return result;
}

function earliestStartedAt(values: Array<string | undefined>): string | undefined {
  let earliest: string | undefined;
  let earliestTs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const ts = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ts) && ts < earliestTs) {
      earliest = value;
      earliestTs = ts;
    }
  }
  return earliest;
}

function isInjectableTarget(target: CdpTargetListEntry): boolean {
  if (target.type !== "page" || !target.id) {
    return false;
  }
  return isInjectableUrl(target.url || "");
}

function isInjectableTargetInfo(targetInfo: Record<string, unknown>): boolean {
  if (stringValue(targetInfo.type) !== "page") {
    return false;
  }
  return isInjectableUrl(stringValue(targetInfo.url) || "");
}

function isInjectableUrl(url: string): boolean {
  return !/^(chrome|devtools|chrome-extension|edge|about:chrome|view-source:chrome):/i.test(url);
}

function targetKey(target: CdpTargetListEntry): string {
  return target.id || "";
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
