import type { AgentActivity, CdpClientInfo } from "../shared/types";
import { CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo } from "./cdp-client";
import type { CdpTargetListEntry } from "./internal-types";
import { agentOverlayBootstrapScript } from "./overlay-script";
import { isRecord, stringValue } from "./fs-util";
import { SessionTailer, type SessionTailerBase } from "./session-tail";

const BINDING_NAME = "__ppAgentOverlaySignal";
const PAGE_CONNECT_TIMEOUT = 3000;
const PUSH_INTERVAL_MS = 2000;
const TAKEN_OVER_KEEPALIVE_MS = 7000;

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
  session?: string;
  agent?: string;
}

interface AgentOverlayManagerOptions {
  onStop: (request: AgentOverlayStopRequest) => Promise<void>;
}

type OverlayState = "active" | "takenOver";

interface OverlayPayload {
  state: OverlayState;
  profileName: string;
  agent: string | null;
  project: string | null;
  session: string | null;
  sessionTitle: string | null;
  currentAction: string | null;
  currentStep: string | null;
  nextStep: string | null;
  todoDone: number | null;
  todoTotal: number | null;
  lastMessage: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  sessions: OverlaySessionPayload[];
}

interface AgentOverlayPayloadInput {
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
  client: CdpBrowserClient | null;
  connecting: boolean;
  closing: boolean;
  scriptIdentifier?: string;
  lastPayloadText: string;
  lastPushAt: number;
}

interface PortOverlay {
  port: number;
  profileId: string;
  profileName: string;
  clients: CdpClientInfo[];
  pages: Map<string, PageOverlay>;
  browserClient: CdpBrowserClient | null;
  browserConnecting: boolean;
  syncing: boolean;
  takeoverInFlight: boolean;
  takenOverUntil: number;
  lastPayload: OverlayPayload | null;
  sessionStartedAt: Map<string, string>;
}

export class AgentOverlayManager {
  private readonly ports = new Map<number, PortOverlay>();
  private readonly tailers = new Map<string, SessionTailer>();
  private readonly script = agentOverlayBootstrapScript();

  constructor(private readonly options: AgentOverlayManagerOptions) {}

  sync(input: AgentOverlaySyncInput): void {
    if (!input.enabled) {
      this.stopAllTailers();
      for (const state of this.ports.values()) {
        this.teardownPort(state);
      }
      this.ports.clear();
      return;
    }

    const now = Date.now();
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
          takeoverInFlight: false,
          takenOverUntil: 0,
          lastPayload: null,
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
    if (state.syncing) {
      return;
    }
    state.syncing = true;
    try {
      const targets = await requestCdpTargets(state.port).catch(() => null);
      if (!targets) {
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
        const page = state.pages.get(targetId);
        if (page) {
          page.url = target.url || page.url;
          continue;
        }
        void this.connectPage(state, targetId, target).catch(() => undefined);
      }
    } finally {
      state.syncing = false;
    }
  }

  private async ensureTargetObserver(state: PortOverlay): Promise<void> {
    if (state.browserClient || state.browserConnecting) {
      return;
    }
    state.browserConnecting = true;
    try {
      const version = await requestCdpVersionInfo(state.port).catch(() => null);
      const webSocketDebuggerUrl = version?.webSocketDebuggerUrl;
      if (!webSocketDebuggerUrl) {
        return;
      }
      const client = await CdpBrowserClient.connect(webSocketDebuggerUrl, PAGE_CONNECT_TIMEOUT);
      if (this.ports.get(state.port) !== state) {
        client.close();
        return;
      }
      state.browserClient = client;
      client.onEvent = (method, params) => {
        this.handleBrowserEvent(state, method, params);
      };
      client.onDisconnect = () => {
        if (state.browserClient === client) {
          state.browserClient = null;
        }
      };
      await client.send("Target.setDiscoverTargets", { discover: true }, 5000);
    } catch {
      this.teardownTargetObserver(state);
    } finally {
      state.browserConnecting = false;
    }
  }

  private handleBrowserEvent(state: PortOverlay, method: string, params: unknown): void {
    if (!method.startsWith("Target.target")) {
      return;
    }
    if (isRecord(params) && isRecord(params.targetInfo) && stringValue(params.targetInfo.type) !== "page") {
      return;
    }
    void this.syncPortTargets(state).catch(() => undefined);
  }

  private async connectPage(state: PortOverlay, targetId: string, target: CdpTargetListEntry): Promise<void> {
    const webSocketDebuggerUrl = target.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl) {
      return;
    }

    const page: PageOverlay = {
      targetId,
      url: target.url || "",
      client: null,
      connecting: true,
      closing: false,
      lastPayloadText: "",
      lastPushAt: 0
    };
    state.pages.set(targetId, page);

    try {
      const client = await CdpBrowserClient.connect(webSocketDebuggerUrl, PAGE_CONNECT_TIMEOUT);
      if (state.pages.get(targetId) !== page) {
        client.close();
        return;
      }
      page.client = client;
      client.onEvent = (method, params) => {
        this.handlePageEvent(state, page, method, params);
      };
      client.onDisconnect = () => {
        if (state.pages.get(targetId) === page) {
          state.pages.delete(targetId);
        }
      };

      await client.send("Page.enable", {}, 5000);
      const addScript = await client.send<{ identifier?: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: this.script },
        5000
      );
      page.scriptIdentifier = addScript.identifier;
      await client.send("Runtime.enable", {}, 5000);
      await client.send("Runtime.addBinding", { name: BINDING_NAME }, 5000);
      await client.send("Runtime.evaluate", { expression: this.script, awaitPromise: false }, 5000);
      page.connecting = false;
      await this.pushPageUpdate(state, page, true);
    } catch {
      state.pages.delete(targetId);
      page.client?.close();
    } finally {
      page.connecting = false;
    }
  }

  private handlePageEvent(state: PortOverlay, _page: PageOverlay, method: string, params: unknown): void {
    if (method !== "Runtime.bindingCalled" || !isRecord(params) || stringValue(params.name) !== BINDING_NAME) {
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
    if (action === "stop") {
      const session = stringValue(payload.session) || undefined;
      void this.handleStopSignal(state, session).catch(() => undefined);
    }
  }

  private async handleStopSignal(state: PortOverlay, requestedSession?: string): Promise<void> {
    if (state.takeoverInFlight || Date.now() < state.takenOverUntil) {
      return;
    }
    const drivers = this.findStopDrivers(state, requestedSession);
    if (!drivers.length) {
      return;
    }

    state.takeoverInFlight = true;
    let stoppedCount = 0;
    let firstError: unknown = null;
    try {
      for (const driver of drivers) {
        try {
          await this.options.onStop({
            port: state.port,
            profileId: state.profileId,
            profileName: state.profileName,
            pid: driver.pid,
            session: driver.session,
            agent: inferAgentName(driver)
          });
          stoppedCount += 1;
        } catch (error) {
          firstError = firstError || error;
        }
      }
      if (!stoppedCount) {
        throw firstError instanceof Error ? firstError : new Error("没有可停止的 AI 驱动连接。");
      }
      state.takenOverUntil = Date.now() + TAKEN_OVER_KEEPALIVE_MS;
      state.lastPayload = {
        ...this.payloadForPort(state),
        state: "takenOver"
      };
      await this.pushPortUpdate(state, true);
    } finally {
      state.takeoverInFlight = false;
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

  private async pushPortUpdate(state: PortOverlay, force = false): Promise<void> {
    await Promise.all([...state.pages.values()].map((page) => this.pushPageUpdate(state, page, force).catch(() => undefined)));
  }

  private async pushPageUpdate(state: PortOverlay, page: PageOverlay, force = false): Promise<void> {
    if (!page.client || page.connecting || page.closing) {
      return;
    }
    const payload = this.payloadForPort(state);
    const text = safeJson(payload);
    const now = Date.now();
    if (!force && page.lastPayloadText === text && now - page.lastPushAt < PUSH_INTERVAL_MS) {
      return;
    }
    try {
      await page.client.send(
        "Runtime.evaluate",
        { expression: `window.__ppAgentOverlayUpdate && window.__ppAgentOverlayUpdate(${text})`, awaitPromise: false },
        3000
      );
      page.lastPayloadText = text;
      page.lastPushAt = now;
      state.lastPayload = payload;
    } catch {
      await this.teardownPage(state, page).catch(() => undefined);
    }
  }

  private payloadForPort(state: PortOverlay): OverlayPayload {
    const takenOver = state.takenOverUntil > Date.now();
    return buildAgentOverlayPayload({
      state: takenOver ? "takenOver" : "active",
      profileName: state.profileName,
      clients: state.clients,
      lastPayload: state.lastPayload,
      activityForClient: (client) => this.activityForClient(client),
      startedAtForClient: (client) => this.startedAtForClient(state, client)
    });
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

  private teardownPort(state: PortOverlay): void {
    this.teardownTargetObserver(state);
    for (const page of [...state.pages.values()]) {
      void this.teardownPage(state, page).catch(() => undefined);
    }
    state.pages.clear();
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
    const client = page.client;
    if (!client) {
      return;
    }
    if (page.scriptIdentifier) {
      await client
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.scriptIdentifier }, 2000)
        .catch(() => undefined);
    }
    await client
      .send(
        "Runtime.evaluate",
        { expression: "window.__ppAgentOverlayTeardown && window.__ppAgentOverlayTeardown()", awaitPromise: false },
        2000
      )
      .catch(() => undefined);
    client.close();
  }
}

export function buildAgentOverlayPayload(input: AgentOverlayPayloadInput): OverlayPayload {
  if (!input.clients.length && input.lastPayload) {
    return normalizeOverlayPayload({
      ...input.lastPayload,
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
    state: payload.state === "takenOver" ? "takenOver" : "active",
    profileName: nullableString(payload.profileName) || "",
    agent: nullableString(payload.agent),
    project: nullableString(payload.project),
    session: nullableString(payload.session),
    sessionTitle: nullableString(payload.sessionTitle),
    currentAction: nullableString(payload.currentAction),
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

function nullableNumber(value: number | null | undefined): number | null {
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
  if (target.type !== "page" || !target.webSocketDebuggerUrl) {
    return false;
  }
  const url = target.url || "";
  return !/^(chrome|devtools|chrome-extension|edge|about:chrome|view-source:chrome):/i.test(url);
}

function targetKey(target: CdpTargetListEntry): string {
  return target.id || target.webSocketDebuggerUrl || "";
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
