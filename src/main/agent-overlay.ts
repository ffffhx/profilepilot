import type { AgentActivity, AgentControlNoticeReason, CdpClientInfo, Ownership } from "../shared/types";
import { CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo } from "./cdp-client";
import type { CdpTargetListEntry, CdpVersionInfo } from "./internal-types";
import { agentOverlayBootstrapScript } from "./overlay-script";
import { isRecord, stringValue } from "./fs-util";
import {
  MacInputGuard,
  type InputGuardClick,
  type InputGuardController,
  type InputGuardWindowBounds
} from "./input-guard";
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
  browserPids?: number[];
  headless?: boolean;
  // true 表示当前驱动仍连着 CDP，但已经收到用户接管 notice，不能据此把控制权误判回 Agent。
  controlPaused?: boolean;
  // 用户接管已经稳定，但对应 wait-control 进程在宽限期后仍不存在或已经退出。
  agentOffline?: boolean;
  controlSince?: string;
  clients: CdpClientInfo[];
}

export interface AgentOverlaySyncInput {
  enabled: boolean;
  ports: AgentOverlayPortInput[];
  // 仍在运行但没有 Agent owner 的端口。用于 App 重启后清掉上次异常中断遗留的页面浮层。
  inactivePorts?: number[];
}

export interface AgentOverlayStopRequest {
  port: number;
  profileId: string;
  profileName: string;
  pid: number;
  pids?: number[];
  session?: string;
  agent?: string;
  reason?: AgentControlNoticeReason;
  stopAll?: boolean;
}

export interface AgentOverlayResumeRequest {
  port: number;
  profileId: string;
  profileName: string;
  pid: number;
  pids?: number[];
  session?: string;
  agent?: string;
  resumeAll?: boolean;
}

export interface AgentOverlayCompleteRequest {
  port: number;
  profileId: string;
  profileName: string;
  pid: number;
  pids?: number[];
  session: string;
  agent?: string;
}

export interface AgentOverlayRevealRequest {
  port: number;
  profileId: string;
  profileName: string;
}

interface AgentOverlayManagerOptions {
  locale?: OverlayLocale;
  onStop: (request: AgentOverlayStopRequest) => Promise<void>;
  onResume?: (request: AgentOverlayResumeRequest) => Promise<void>;
  onComplete?: (request: AgentOverlayCompleteRequest) => Promise<void>;
  onReveal?: (request: AgentOverlayRevealRequest) => void;
  now?: () => number;
  requestTargets?: (port: number) => Promise<CdpTargetListEntry[]>;
  requestVersionInfo?: (port: number) => Promise<CdpVersionInfo>;
  connectBrowser?: (webSocketDebuggerUrl: string, timeoutMs: number) => Promise<OverlayBrowserClient>;
  inputGuard?: InputGuardController;
}

// 底层 overlay 状态（时间窗驱动的实现细节）：active＝AI 在驱动；takenOver＝用户刚接管、
// 处于 7 秒保留窗口内。对外表达统一收敛到下面 payload 的 ownership 三值枚举，state 只留作内部映射源。
type OverlayState = "active" | "takenOver";
type InputGuardState = "starting" | "active" | "unavailable";

interface OverlayPayload {
  locale: OverlayLocale;
  state: OverlayState;
  // 归属三值枚举（借鉴 ego-lite），对外的单一真相：由底层 state + 是否有 agent 驱动映射而来。
  // active→agent；takenOver（用户接管保留窗口内）→agentDelegatedToUser；无 agent→user。
  ownership: Ownership;
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
  inputGuardState: InputGuardState;
  handoffPending: boolean;
  agentOffline: boolean;
  controlSince: string | null;
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
  inputGuardState?: InputGuardState;
  handoffPending?: boolean;
  agentOffline?: boolean;
  controlSince?: string;
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
  terminalMarkerCleared: boolean;
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
  browserPids: number[];
  headless: boolean;
  clients: CdpClientInfo[];
  pages: Map<string, PageOverlay>;
  browserClient: OverlayBrowserClient | null;
  browserConnecting: boolean;
  syncing: boolean;
  targetSyncRequested: boolean;
  alive: boolean;
  takeoverInFlight: boolean;
  handoffPending: boolean;
  agentOffline: boolean;
  controlSince?: string;
  delegatedToUser: boolean;
  delegationGraceUntil: number;
  takenOverUntil: number;
  lastPayload: OverlayPayload | null;
  stopError: string | null;
  sessionStartedAt: Map<string, string>;
  targetCache: { targets: CdpTargetListEntry[]; expiresAt: number } | null;
  targetRequest: Promise<CdpTargetListEntry[] | null> | null;
  targetCacheGeneration: number;
}

interface GuardProbeResult {
  action: "takeover" | "stop";
  signature: string;
}

interface GuardPageCandidate extends GuardProbeResult {
  page: PageOverlay;
  contextId: number;
  windowId: number;
}

interface CdpBrowserWindowResult {
  windowId?: number;
  bounds?: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    windowState?: string;
  };
}

export class AgentOverlayManager {
  private readonly ports = new Map<number, PortOverlay>();
  private readonly tailers = new Map<string, SessionTailer>();
  private readonly completionInFlight = new Set<string>();
  private readonly completedSessions = new Set<string>();
  private readonly cleanedInactivePorts = new Set<number>();
  private readonly script = agentOverlayBootstrapScript();
  private readonly inputGuard: InputGuardController;
  private guardClickChain: Promise<void> = Promise.resolve();
  private inputGuardState: InputGuardState = "starting";
  private disposed = false;

  constructor(private readonly options: AgentOverlayManagerOptions) {
    this.inputGuard = options.inputGuard || new MacInputGuard({
      onClick: (click) => {
        this.guardClickChain = this.guardClickChain
          .then(() => this.handleInputGuardClick(click))
          .catch((error) => {
            console.warn("[ProfilePilot] Input Guard 点击命中失败", error);
          });
      },
      onStatus: (message) => {
        if (message.status === "tap-create-failed" || message.status === "tap-disabled") {
          console.warn(`[ProfilePilot] Input Guard ${message.status}${message.pid ? ` (pid ${message.pid})` : ""}`);
        }
        const nextState =
          message.status === "guard-active"
            ? "active"
            : message.status === "guard-unavailable" || message.status === "accessibility-access-denied"
              ? "unavailable"
              : null;
        if (nextState && this.inputGuardState !== nextState) {
          this.inputGuardState = nextState;
          void this.pushAllUpdates();
        }
      }
    });
  }

  sync(input: AgentOverlaySyncInput): void {
    if (this.disposed) {
      return;
    }
    if (!input.enabled) {
      this.cleanedInactivePorts.clear();
      this.inputGuard.sync([]);
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
        state.browserPids = normalizeBrowserPids(next.browserPids);
        state.headless = Boolean(next.headless);
        state.clients = next.clients;
        state.agentOffline = Boolean(next.agentOffline);
        state.controlSince = next.controlSince;
        this.syncSessionStarts(state, now);
        this.syncDelegatedControl(state, Boolean(next.controlPaused), now);
        continue;
      }
      const completedSessionStillShown = state.clients.some(
        (client) => Boolean(client.session) && this.completedSessions.has(client.session as string)
      );
      if (!completedSessionStillShown && state.takenOverUntil > now) {
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
          browserPids: normalizeBrowserPids(next.browserPids),
          headless: Boolean(next.headless),
          clients: next.clients,
          pages: new Map(),
          browserClient: null,
          browserConnecting: false,
          syncing: false,
          targetSyncRequested: false,
          alive: true,
          takeoverInFlight: false,
          handoffPending: false,
          agentOffline: Boolean(next.agentOffline),
          controlSince: next.controlSince,
          delegatedToUser: Boolean(next.controlPaused),
          delegationGraceUntil: 0,
          takenOverUntil: next.controlPaused ? now + TAKEN_OVER_KEEPALIVE_MS : 0,
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
        state.browserPids = normalizeBrowserPids(next.browserPids);
        state.headless = Boolean(next.headless);
        state.clients = next.clients;
        state.agentOffline = Boolean(next.agentOffline);
        state.controlSince = next.controlSince;
        this.syncSessionStarts(state, now);
        this.syncDelegatedControl(state, Boolean(next.controlPaused), now);
      }
    }

    this.syncInputGuard();
    this.syncTailers();
    this.syncInactivePortCleanup(input.inactivePorts || []);
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
    this.cleanedInactivePorts.clear();
    this.inputGuard.sync([]);
    await this.inputGuard.dispose();
    this.stopAllTailers();
    const states = [...this.ports.values()];
    this.ports.clear();
    await Promise.allSettled(states.map((state) => this.teardownPort(state)));
  }

  private syncInputGuard(): void {
    if (this.disposed) {
      this.inputGuard.sync([]);
      return;
    }
    const pids = [...this.ports.values()]
      .filter((state) => this.isInputGuardPort(state))
      .flatMap((state) => state.browserPids || []);
    if (!pids.length) {
      this.inputGuardState = "starting";
    }
    this.inputGuard.sync(pids);
  }

  private syncInactivePortCleanup(ports: number[]): void {
    if (this.disposed) {
      this.cleanedInactivePorts.clear();
      return;
    }
    const inactive = new Set(
      ports.filter((port) => Number.isSafeInteger(port) && port > 0 && !this.ports.has(port))
    );
    for (const port of [...this.cleanedInactivePorts]) {
      if (!inactive.has(port)) {
        this.cleanedInactivePorts.delete(port);
      }
    }
    for (const port of inactive) {
      if (this.cleanedInactivePorts.has(port)) {
        continue;
      }
      this.cleanedInactivePorts.add(port);
      void this.cleanupInactivePortOverlays(port).then((cleaned) => {
        if (!cleaned) {
          this.cleanedInactivePorts.delete(port);
        }
      }).catch(() => {
        this.cleanedInactivePorts.delete(port);
      });
    }
  }

  private async cleanupInactivePortOverlays(port: number): Promise<boolean> {
    const requestTargets = this.options.requestTargets || requestCdpTargets;
    const connect = this.options.connectBrowser || CdpBrowserClient.connect;
    let targets: CdpTargetListEntry[];
    try {
      targets = await requestTargets(port);
    } catch {
      return false;
    }

    await Promise.allSettled(
      targets.filter(isInjectableTarget).map(async (target) => {
        if (!target.webSocketDebuggerUrl) {
          return;
        }
        const client = await connect(target.webSocketDebuggerUrl, PAGE_CONNECT_TIMEOUT);
        try {
          await client.send("Runtime.enable", {}, 2500);
          await client.send("Page.enable", {}, 2500);
          const frameTree = await client.send<{ frameTree?: unknown }>("Page.getFrameTree", {}, 2500);
          const tree = isRecord(frameTree.frameTree) ? frameTree.frameTree : null;
          const frame = tree && isRecord(tree.frame) ? tree.frame : null;
          const frameId = frame ? stringValue(frame.id) : "";
          if (!frameId) {
            return;
          }
          const context = await client.send<{ executionContextId?: number }>(
            "Page.createIsolatedWorld",
            { frameId, worldName: OVERLAY_WORLD_NAME },
            2500
          );
          const contextId = numberValue(context.executionContextId);
          if (contextId === null) {
            return;
          }
          await client.send(
            "Runtime.evaluate",
            {
              expression: 'try { sessionStorage.setItem("__ppAgentOverlayTerminalStopUntil", String(Number.MAX_SAFE_INTEGER)); } catch {} globalThis.__ppAgentOverlayTeardown && globalThis.__ppAgentOverlayTeardown()',
              awaitPromise: false,
              contextId
            },
            2500
          );
        } finally {
          client.close();
        }
      })
    );
    return true;
  }

  private isInputGuardPort(state: PortOverlay): boolean {
    return (
      this.isActivePort(state) &&
      !state.headless &&
      !state.delegatedToUser &&
      state.clients.length > 0 &&
      (state.browserPids || []).length > 0 &&
      state.takenOverUntil <= this.now()
    );
  }

  private syncDelegatedControl(state: PortOverlay, controlPaused: boolean, now: number): void {
    if (controlPaused) {
      if (!state.delegatedToUser) {
        state.delegatedToUser = true;
        state.takenOverUntil = Math.max(state.takenOverUntil, now + TAKEN_OVER_KEEPALIVE_MS);
        state.lastPayload = null;
      }
      return;
    }
    // onStop 完成前可能已有一轮 getState 在途；给它一个很短的陈旧快照保护窗，避免刚接管
    // 就被旧的 controlPaused=false 结果重新加锁。真正的 resume 会在保护窗后稳定恢复。
    if (!state.delegatedToUser || now < state.delegationGraceUntil) {
      return;
    }
    state.delegatedToUser = false;
    state.delegationGraceUntil = 0;
    state.takenOverUntil = 0;
    state.lastPayload = null;
  }

  private async handleInputGuardClick(click: InputGuardClick): Promise<void> {
    if (this.disposed) {
      return;
    }
    const states = [...this.ports.values()].filter(
      (state) => this.isInputGuardPort(state) && (state.browserPids || []).includes(click.pid)
    );
    for (const state of states) {
      if (!this.isInputGuardPort(state) || !state.browserClient) {
        continue;
      }
      // Docked DevTools splits the outer window's non-page area between top and bottom.
      // Without a native content-view frame that mapping is ambiguous, so this click is
      // deliberately ignored instead of risking a false takeover.
      const targets = await this.targetsForPort(state);
      if (!targets || targets.some((target) => (stringValue(target.url) || "").startsWith("devtools://"))) {
        continue;
      }

      const candidates = (
        await Promise.all(
          [...state.pages.values()].map((page) => this.probeInputGuardPage(state, page, click).catch(() => null))
        )
      ).filter((candidate): candidate is GuardPageCandidate => candidate !== null);
      if (!candidates.length) {
        continue;
      }

      // Multiple native windows can share identical bounds when stacked. CDP cannot map
      // its windowId to CGWindowID directly, so ambiguous stacked windows fail closed.
      const windowIds = new Set(candidates.map((candidate) => candidate.windowId));
      const actions = new Set(candidates.map((candidate) => candidate.action));
      if (windowIds.size !== 1 || actions.size !== 1) {
        continue;
      }

      const candidate = candidates[0];
      if (await this.activateInputGuardCandidate(state, candidate, click)) {
        return;
      }
    }
  }

  private async probeInputGuardPage(
    state: PortOverlay,
    page: PageOverlay,
    click: InputGuardClick
  ): Promise<GuardPageCandidate | null> {
    const client = state.browserClient;
    if (!client || !this.isInputGuardPort(state) || !this.isActivePage(state, page) || !page.sessionId) {
      return null;
    }
    const browserWindow = await client.send<CdpBrowserWindowResult>(
      "Browser.getWindowForTarget",
      { targetId: page.targetId },
      2500
    );
    const windowId = positiveIntegerValue(browserWindow.windowId);
    if (
      !windowId ||
      browserWindow.bounds?.windowState === "minimized" ||
      !cdpWindowMatchesInputGuardBounds(browserWindow.bounds, click.window)
    ) {
      return null;
    }

    const payload = safeJson(inputGuardClickPayload(click));
    for (const contextId of this.contextIdsForPage(page)) {
      let result: { result?: { value?: unknown } };
      try {
        result = await client.send(
          "Runtime.evaluate",
          {
            expression: `globalThis.__ppAgentOverlayGuardProbe ? globalThis.__ppAgentOverlayGuardProbe(${payload}) : null`,
            awaitPromise: false,
            returnByValue: true,
            contextId
          },
          2500,
          page.sessionId
        );
      } catch {
        continue;
      }
      const value = result.result?.value;
      if (!isRecord(value)) {
        continue;
      }
      const action = stringValue(value.action);
      const signature = stringValue(value.signature);
      if ((action === "takeover" || action === "stop") && signature) {
        return { page, contextId, windowId, action, signature };
      }
    }
    return null;
  }

  private async activateInputGuardCandidate(
    state: PortOverlay,
    candidate: GuardPageCandidate,
    click: InputGuardClick
  ): Promise<boolean> {
    const client = state.browserClient;
    const sessionId = candidate.page.sessionId;
    if (
      !client ||
      !sessionId ||
      !this.isInputGuardPort(state) ||
      !this.isActivePage(state, candidate.page) ||
      !candidate.page.isolatedContextIds.has(candidate.contextId)
    ) {
      return false;
    }
    const payload = safeJson(inputGuardClickPayload(click));
    const signature = safeJson(candidate.signature);
    const result = await client.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression: `Boolean(globalThis.__ppAgentOverlayGuardActivate && globalThis.__ppAgentOverlayGuardActivate(${payload}, ${signature}))`,
        awaitPromise: false,
        returnByValue: true,
        contextId: candidate.contextId
      },
      2500,
      sessionId
    );
    return result.result?.value === true;
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
        this.completedSessions.delete(session);
        continue;
      }
      tailer.updateBase(base);
    }

    for (const [session, base] of wanted) {
      if (this.tailers.has(session)) {
        continue;
      }
      const tailer = new SessionTailer(session, base, () => {
        void this.handleSessionTailerUpdate(session).catch((error) => {
          console.warn(`[ProfilePilot] 自动交还 Session ${session} 失败`, error);
        });
      });
      this.tailers.set(session, tailer);
      tailer.start();
    }
  }

  private async handleSessionTailerUpdate(session: string): Promise<void> {
    const tailer = this.tailers.get(session);
    if (!tailer || tailer.getControlPhase() !== "completed" || !this.options.onComplete) {
      if (tailer?.getControlPhase() === "active") {
        this.completedSessions.delete(session);
      }
      await this.pushAllUpdates();
      return;
    }
    if (this.completedSessions.has(session) || this.completionInFlight.has(session)) {
      return;
    }

    const match = [...this.ports.values()]
      .map((state) => ({
        state,
        drivers: uniqueClientsByPid(
          state.clients.filter(
            (client) => client.session === session && client.label.toLowerCase().startsWith("agent-browser")
          )
        )
      }))
      .find((candidate) => candidate.drivers.length > 0);
    if (!match) {
      await this.pushAllUpdates();
      return;
    }

    this.completionInFlight.add(session);
    try {
      const driver = match.drivers[0];
      // 先在仍然可用的 internal CDP observer 上同步拆掉当前页和未来页面的浮层，
      // 再让 onComplete 关闭 Gateway Session。否则 Session 先断开后只剩无法清理的旧 DOM。
      await this.suspendPageBootstrapScripts(match.state);
      try {
        await this.options.onComplete({
          port: match.state.port,
          profileId: match.state.profileId,
          profileName: match.state.profileName,
          pid: driver.pid,
          pids: match.drivers.map((client) => client.pid),
          session,
          agent: inferAgentName(driver)
        });
      } catch (error) {
        if (this.isActivePort(match.state)) {
          await this.rebuildPortPages(match.state);
        }
        throw error;
      }

      // 完成是终态：onComplete 已关闭 Gateway Session、daemon 和 Profile 租约。
      // 立即移除对应客户端与控制框，不再进入 delegated/user takeover 状态。
      tailer.stop();
      this.tailers.delete(session);
      this.completedSessions.delete(session);
      for (const state of this.ports.values()) {
        if (!state.clients.some((client) => client.session === session)) {
          continue;
        }
        state.clients = state.clients.filter((client) => client.session !== session);
        state.delegatedToUser = false;
        state.agentOffline = false;
        state.controlSince = undefined;
        state.delegationGraceUntil = 0;
        state.takenOverUntil = 0;
        state.stopError = null;
        state.lastPayload = null;
        if (!state.clients.length) {
          this.ports.delete(state.port);
          await this.teardownPort(state);
          continue;
        }
        await this.pushPortUpdate(state, true);
      }
      this.syncInputGuard();
      this.syncTailers();
    } finally {
      this.completionInFlight.delete(session);
    }
  }

  private stopAllTailers(): void {
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    this.tailers.clear();
    this.completedSessions.clear();
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
      // Target discovery plus our explicit attachPage path is deliberately the only attach owner.
      // Browser-wide auto-attach can race attachPage, register two future-document scripts for one
      // target, and leave an untracked script that resurrects the overlay after Session stop.
      void this.syncPortTargets(state).catch(() => undefined);
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
      recoveringContext: false,
      terminalMarkerCleared: false
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
      if (!page.terminalMarkerCleared) {
        await client.send(
          "Runtime.evaluate",
          {
            expression: 'try { sessionStorage.removeItem("__ppAgentOverlayTerminalStopUntil"); } catch {}',
            awaitPromise: false
          },
          5000,
          sessionId
        );
        if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
          return;
        }
        page.terminalMarkerCleared = true;
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
      const reason = agentControlReasonValue(payload.reason) || "user_stop";
      void this.handleStopSignal(state, session, reason).catch(() => undefined);
      return;
    }
    if (action === "resume") {
      const session = stringValue(payload.session) || undefined;
      void this.handleResumeSignal(state, session).catch(() => undefined);
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

  private async handleStopSignal(
    state: PortOverlay,
    requestedSession?: string,
    reason: AgentControlNoticeReason = "user_stop"
  ): Promise<void> {
    if (
      !this.isActivePort(state) ||
      state.takeoverInFlight ||
      (state.delegatedToUser && reason !== "user_stop") ||
      (!state.delegatedToUser && this.now() < state.takenOverUntil)
    ) {
      return;
    }
    const drivers = this.findStopDrivers(state, requestedSession);
    if (!drivers.length) {
      return;
    }

    state.takeoverInFlight = true;
    state.handoffPending = reason === "user_takeover";
    if (state.handoffPending) {
      state.lastPayload = null;
      await this.pushPortUpdate(state, true);
    }
    const terminalStop = reason === "user_stop" || reason === "user_disconnect";
    if (terminalStop) {
      // Gateway stop / daemon retirement can take long enough for the user to refresh the page.
      // Revoke the future-document bootstrap first so a refresh cannot resurrect the control box
      // while the authoritative Session stop is still settling.
      await this.suspendPageBootstrapScripts(state);
    }
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
          reason,
          stopAll
        });
      } catch (error) {
        firstError = error;
      }
      if (firstError) {
        if (terminalStop && this.isActivePort(state)) {
          await this.rebuildPortPages(state);
        }
        state.stopError = this.stopErrorMessage(drivers.length, 0, firstError);
        state.handoffPending = false;
        state.takenOverUntil = 0;
        state.lastPayload = {
          ...this.payloadForPort(state),
          state: "active",
          stopError: state.stopError
        };
        await this.pushPortUpdate(state, true);
        console.warn("[ProfilePilot] Agent overlay control handoff failed", firstError);
        return;
      }
      if (!this.isActivePort(state)) {
        return;
      }
      if (reason === "user_stop" || reason === "user_disconnect") {
        const stoppedPids = new Set(drivers.map((client) => client.pid));
        for (const driver of drivers) {
          if (driver.session) {
            this.completedSessions.delete(driver.session);
            this.completionInFlight.delete(driver.session);
          }
        }
        state.clients = state.clients.filter((client) => !stoppedPids.has(client.pid));
        state.stopError = null;
        state.handoffPending = false;
        state.agentOffline = false;
        state.controlSince = undefined;
        state.delegatedToUser = false;
        state.delegationGraceUntil = 0;
        state.takenOverUntil = 0;
        state.lastPayload = null;
        if (!state.clients.length) {
          this.ports.delete(state.port);
          await this.teardownPort(state);
          this.syncInputGuard();
          this.syncTailers();
          return;
        }
        this.syncInputGuard();
        this.syncTailers();
        await this.pushPortUpdate(state, true);
        return;
      }
      state.stopError = null;
      state.handoffPending = false;
      const takenOverAt = this.now();
      state.agentOffline = false;
      state.controlSince = new Date(takenOverAt).toISOString();
      state.delegatedToUser = reason === "user_takeover";
      state.delegationGraceUntil = state.delegatedToUser ? takenOverAt + 1500 : 0;
      state.takenOverUntil = takenOverAt + TAKEN_OVER_KEEPALIVE_MS;
      this.syncInputGuard();
      state.lastPayload = {
        ...this.payloadForPort(state),
        state: "takenOver"
      };
      await this.pushPortUpdate(state, true);
    } finally {
      if (this.ports.get(state.port) === state) {
        state.takeoverInFlight = false;
        state.handoffPending = false;
      }
    }
  }

  private async handleResumeSignal(state: PortOverlay, requestedSession?: string): Promise<void> {
    if (
      !this.isActivePort(state) ||
      state.takeoverInFlight ||
      !state.delegatedToUser ||
      state.agentOffline ||
      !this.options.onResume
    ) {
      return;
    }
    const drivers = this.findStopDrivers(state, requestedSession);
    if (!drivers.length) {
      return;
    }

    const controlSince = state.controlSince;
    state.takeoverInFlight = true;
    // 先重新启用点击保护，再发 CONTROL_RETURNED；等待中的 Agent 醒来时浏览器已经重新上锁。
    state.delegatedToUser = false;
    state.agentOffline = false;
    state.controlSince = undefined;
    state.delegationGraceUntil = 0;
    state.takenOverUntil = 0;
    state.lastPayload = null;
    this.syncInputGuard();
    try {
      const resumeAll = !requestedSession && drivers.length > 1;
      const driver = drivers[0];
      await this.options.onResume({
        port: state.port,
        profileId: state.profileId,
        profileName: state.profileName,
        pid: driver.pid,
        pids: resumeAll ? undefined : drivers.map((client) => client.pid),
        session: resumeAll ? undefined : requestedSession || driver.session,
        agent: resumeAll ? undefined : inferAgentName(driver),
        resumeAll
      });
      if (!this.isActivePort(state)) {
        return;
      }
      state.stopError = null;
      await this.pushPortUpdate(state, true);
    } catch (error) {
      state.delegatedToUser = true;
      state.agentOffline = false;
      state.controlSince = controlSince || new Date(this.now()).toISOString();
      state.takenOverUntil = this.now() + TAKEN_OVER_KEEPALIVE_MS;
      this.syncInputGuard();
      state.stopError = error instanceof Error ? error.message : "交还 Agent 失败。";
      state.lastPayload = null;
      await this.pushPortUpdate(state, true);
      throw error;
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
    if (total <= 1) {
      return (this.options.locale ?? "en") === "zh"
        ? `操作失败，请重试${detail}`
        : `Action failed. Try again${detail}`;
    }
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
        const result = await client.send<{ result?: { type?: string } }>(
          "Runtime.evaluate",
          {
            expression: `globalThis.__ppAgentOverlayUpdate && globalThis.__ppAgentOverlayUpdate(${text})`,
            awaitPromise: false,
            returnByValue: true,
            contextId
          },
          3000,
          sessionId
        );
        if (!this.isActivePage(state, page) || state.browserClient !== client || page.sessionId !== sessionId) {
          return;
        }
        // 心跳过期会主动 teardown 并删除更新函数。Chrome 对缺失函数返回 undefined，
        // 这不是传输错误；把它当成需要重建 isolated world，下一次更新即可恢复真实状态。
        if (result.result?.type === "undefined") {
          continue;
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
    const takenOver = state.delegatedToUser || state.takenOverUntil > this.now();
    const payload = buildAgentOverlayPayload({
      locale: this.options.locale ?? "en",
      state: takenOver ? "takenOver" : "active",
      profileName: state.profileName,
      clients: state.clients,
      lastPayload: state.lastPayload,
      activityForClient: (client) => this.activityForClient(client),
      startedAtForClient: (client) => this.startedAtForClient(state, client),
      inputGuardState: this.inputGuardState,
      handoffPending: state.handoffPending,
      agentOffline: state.agentOffline,
      controlSince: state.controlSince,
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

  private async suspendPageBootstrapScripts(state: PortOverlay): Promise<void> {
    const client = state.browserClient;
    if (!client) {
      return;
    }
    const pages = [...state.pages.values()];
    await Promise.allSettled(
      pages.map((page) => {
        const sessionId = page.sessionId;
        if (!sessionId) {
          return Promise.resolve();
        }
        return client.send(
          "Runtime.evaluate",
          {
            expression: 'try { sessionStorage.setItem("__ppAgentOverlayTerminalStopUntil", String(Number.MAX_SAFE_INTEGER)); } catch {}',
            awaitPromise: false
          },
          2000,
          sessionId
        );
      })
    );
    await Promise.allSettled(
      pages.map(async (page) => {
        const sessionId = page.sessionId;
        const identifier = page.scriptIdentifier;
        if (!sessionId || !identifier) {
          return;
        }
        await client.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
          2000,
          sessionId
        );
        if (page.scriptIdentifier === identifier) {
          page.scriptIdentifier = undefined;
        }
      })
    );
    await Promise.allSettled(
      pages.flatMap((page) => {
        const sessionId = page.sessionId;
        if (!sessionId) {
          return [];
        }
        return this.contextIdsForPage(page).map((contextId) =>
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
        );
      })
    );
  }

  private async rebuildPortPages(state: PortOverlay): Promise<void> {
    const pages = [...state.pages.values()];
    await Promise.allSettled(pages.map((page) => this.teardownPage(state, page)));
    if (this.isActivePort(state)) {
      this.invalidateTargetCache(state);
      await this.syncPortTargets(state);
    }
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
      profileName: input.profileName,
      inputGuardState: input.inputGuardState,
      handoffPending: input.handoffPending,
      agentOffline: input.agentOffline,
      controlSince: input.controlSince
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
    currentAction: nullableString(activity.currentAction || (primary ? "AI 正在控制浏览器" : undefined)),
    targetUrl: nullableString(activityTargetUrl(activity)),
    currentStep: nullableString(activity.currentStep),
    nextStep: nullableString(activity.nextStep),
    todoDone: nullableNumber(activity.todoDone),
    todoTotal: nullableNumber(activity.todoTotal),
    lastMessage: nullableString(activity.lastMessage),
    updatedAt: nullableString(primary ? activity.updatedAt || primary.lastActive || new Date(now).toISOString() : undefined),
    inputGuardState: input.inputGuardState,
    handoffPending: input.handoffPending,
    agentOffline: input.agentOffline,
    controlSince: input.controlSince
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
  const state: OverlayState = payload.state === "takenOver" ? "takenOver" : "active";
  return {
    locale: normalizeOverlayLocale(payload.locale),
    state,
    ownership: ownershipForState(state, payload),
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
    sessions: Array.isArray(payload.sessions) ? payload.sessions.map(normalizeOverlaySessionPayload) : [],
    inputGuardState:
      payload.inputGuardState === "active" || payload.inputGuardState === "unavailable" ? payload.inputGuardState : "starting",
    handoffPending: payload.handoffPending === true,
    agentOffline: payload.agentOffline === true,
    controlSince: nullableString(payload.controlSince)
  };
}

function normalizeOverlayLocale(value: string | null | undefined): OverlayLocale {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// 把底层 state（active/takenOver 时间窗）+ 是否有 agent 驱动，映射成对外的三值归属枚举：
// 无 agent（无会话且无 agent 名）→ user；用户接管保留窗口内（takenOver）→ agentDelegatedToUser；
// 其余（AI 正在驱动）→ agent。ownership 是对外单一真相，底层时间窗机制保持不变。
function ownershipForState(state: OverlayState, payload: Partial<OverlayPayload>): Ownership {
  const hasAgent = Boolean(payload.agent) || (Array.isArray(payload.sessions) && payload.sessions.length > 0);
  if (!hasAgent) {
    return "user";
  }
  return state === "takenOver" ? "agentDelegatedToUser" : "agent";
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

function positiveIntegerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeBrowserPids(value: number[] | undefined): number[] {
  return [...new Set((value || []).filter((pid) => Number.isInteger(pid) && pid > 0))].sort(
    (left, right) => left - right
  );
}

function inputGuardClickPayload(click: InputGuardClick): {
  displayScale: number;
  window: InputGuardWindowBounds;
  down: { x: number; y: number };
  up: { x: number; y: number };
} {
  return {
    displayScale: click.displayScale,
    window: click.window,
    down: click.down,
    up: click.up
  };
}

function cdpWindowMatchesInputGuardBounds(
  bounds: CdpBrowserWindowResult["bounds"],
  nativeBounds: InputGuardWindowBounds
): boolean {
  const left = numberValue(bounds?.left);
  const top = numberValue(bounds?.top);
  const width = numberValue(bounds?.width);
  const height = numberValue(bounds?.height);
  if (left === null || top === null || width === null || height === null || width <= 0 || height <= 0) {
    return false;
  }
  const epsilon = 4;
  return (
    Math.abs(left - nativeBounds.x) <= epsilon &&
    Math.abs(top - nativeBounds.y) <= epsilon &&
    Math.abs(width - nativeBounds.width) <= epsilon &&
    Math.abs(height - nativeBounds.height) <= epsilon
  );
}

function agentControlReasonValue(value: unknown): AgentControlNoticeReason | null {
  return value === "user_takeover" || value === "agent_complete" || value === "user_stop" || value === "user_disconnect" || value === "user_return" ? value : null;
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
  // Extension-owned pages are regular CDP page targets and support the same isolated-world
  // bootstrap as web pages. Keep browser-owned WebUI / DevTools surfaces excluded.
  return !/^(chrome|devtools|edge|about:chrome|view-source:chrome):/i.test(url);
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
