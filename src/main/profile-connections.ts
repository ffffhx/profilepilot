import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentControlNotice, AgentControlNoticeReason, AgentTakeoverEvent, BrowserDriverKind, CdpClientInfo, GatewayProfileControlState, PublicProfile, TakeoverAgentConnectionsResult } from "../shared/types";
import { type AgentBrowserRuntimeProfile } from "./agent-browser-lease";
import { readActiveAgentBrowserControlWaitStateSync } from "./agent-browser-session";
import { isAgentOverlayClient } from "./agent-overlay";
import { ProfilePilotSignal, SIGNAL_CATALOG } from "./agent-signals";
import { type GatewayControlResponse } from "./browser-gateway-client";
import { isRecord, writeJsonFileAtomic } from "./fs-util";
import { RuntimeProfile } from "./internal-types";
import { resolveCanonicalSessionIdentity } from "./session-identity";

const AGENT_CONTROL_WAITER_OFFLINE_GRACE_MS = 30_000;
const AGENT_BROWSER_STALE_DISCONNECT_MS = 2 * 60_000;
const TAKEOVER_HISTORY_LIMIT = 50;
const EXTERNAL_PROFILE_ID_PREFIX = "external:";
export function makeExternalProfileId(userDataDir: string): string {
  return `${EXTERNAL_PROFILE_ID_PREFIX}${userDataDir}`;
}

export function externalUserDataDirFromProfileId(profileId: string): string | null {
  return profileId.startsWith(EXTERNAL_PROFILE_ID_PREFIX)
    ? profileId.slice(EXTERNAL_PROFILE_ID_PREFIX.length)
    : null;
}

export function filterCdpDriverClients(
  clients: CdpClientInfo[],
  ownerPids: number[],
  selfPids: Set<number>
): CdpClientInfo[] {
  const owners = new Set(ownerPids);
  return clients.filter((client) => !owners.has(client.pid) && !selfPids.has(client.pid));
}

export function normalizeSessionFilter(session: string | undefined): string | undefined {
  const value = typeof session === "string" ? session.trim() : "";
  return value || undefined;
}

export function normalizePidFilter(pids: number[] | undefined): Set<number> | null {
  if (!Array.isArray(pids)) {
    return null;
  }
  const values = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return values.length ? new Set(values) : null;
}

export function normalizeAgentControlNoticeReason(reason: AgentControlNoticeReason | undefined): AgentControlNoticeReason | undefined {
  return reason === "user_takeover" || reason === "agent_complete" || reason === "user_stop" || reason === "user_disconnect" || reason === "user_return" ? reason : undefined;
}

export function isAgentDrivenCdpClient(client: CdpClientInfo): boolean {
  const label = client.label.toLowerCase();
  return Boolean(
    client.driverKind ||
      client.agent ||
      client.project ||
      client.session ||
      client.title ||
      label.startsWith("agent-browser") ||
      label === "codex" ||
      label === "claude code"
  );
}

export function isManagedBrowserDriverClient(client: CdpClientInfo): boolean {
  const label = client.label.toLowerCase();
  return Boolean(
    client.driverKind === "agent-browser" ||
      label.startsWith("agent-browser")
  );
}

export function shouldAutoDisconnectStaleAgentBrowserClient(client: CdpClientInfo, now = Date.now()): boolean {
  if (!client.label.toLowerCase().startsWith("agent-browser")) {
    return false;
  }

  if (typeof client.note === "string" && /残留连接|近期无活跃会话/.test(client.note)) {
    return true;
  }

  return false;
}

export function shouldTerminateAgentControlReason(reason: AgentControlNoticeReason): boolean {
  return reason === "user_stop" || reason === "user_disconnect";
}

export function safeAgentBrowserSessionName(session: string | undefined): string {
  const value = typeof session === "string" ? session.trim() : "";
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : "";
}

export function makeAgentControlNotice(
  target: { profileId: string; profileName: string },
  client: CdpClientInfo,
  reason: AgentControlNoticeReason = "user_takeover",
  at = new Date().toISOString(),
  options: { controlVersion?: number; handoffState?: AgentControlNotice["handoffState"] } = {}
): AgentControlNotice {
  const normalizedReason = normalizeAgentControlNoticeReason(reason) || "user_takeover";
  const code = normalizedReason === "user_takeover" || normalizedReason === "agent_complete"
    ? ProfilePilotSignal.AGENT_USER_IN_CONTROL
    : normalizedReason === "user_return"
      ? ProfilePilotSignal.AGENT_CONTROL_RETURNED
      : ProfilePilotSignal.AGENT_TASK_STOPPED;
  const signal = normalizedReason === "agent_complete"
    ? {
        message: "Agent 已完成当前任务，正在释放 Session 和 Profile",
        action: "停手：当前任务已完成，ProfilePilot 正在关闭 Agent Session 并释放 Profile；不要重试或重新连接",
        hardStop: true
      }
    : SIGNAL_CATALOG[code];
  // 控制权不能靠时间自动恢复；所有状态都持续到下一次显式转换或 Session 结束。
  const expiresAt = "9999-12-31T23:59:59.999Z";
  const notice: AgentControlNotice = {
    version: 1,
    controlVersion: Number.isSafeInteger(options.controlVersion) && Number(options.controlVersion) > 0
      ? Number(options.controlVersion)
      : 1,
    code,
    reason: normalizedReason,
    ownership: normalizedReason === "user_takeover" || normalizedReason === "agent_complete" ? "agentDelegatedToUser" : normalizedReason === "user_return" ? "agent" : "user",
    message: signal.message,
    action: signal.action,
    hardStop: signal.hardStop,
    profileId: target.profileId,
    profileName: target.profileName,
    pid: client.pid,
    label: client.label,
    at,
    expiresAt
  };
  if (options.handoffState) {
    notice.handoffState = options.handoffState;
  }
  if (client.session) {
    notice.session = client.session;
  }
  if (client.title) {
    notice.sessionTitle = client.title;
  }
  const agent = client.agent || inferAgentNameForTakeover(client);
  if (agent) {
    notice.agent = agent;
  }
  return notice;
}

export function agentControlNoticePaths(homeDir: string, session: string | undefined, pid: number): string[] {
  const safeSession = safeAgentBrowserSessionName(session);
  const key = safeSession || `pid-${pid}`;
  const paths = [path.join(homeDir, ".profilepilot", "agent-control", `${key}.json`)];
  if (safeSession) {
    paths.push(path.join(homeDir, ".agent-browser", `${safeSession}.profilepilot-control.json`));
  }
  return paths;
}

export async function areAllAgentControlClientsPaused(
  clients: CdpClientInfo[],
  homeDir = os.homedir(),
  now = Date.now()
): Promise<boolean> {
  return (await agentControlStatusForClients(clients, homeDir, now)).paused;
}

export interface AgentControlClientsStatus {
  paused: boolean;
  agentOffline: boolean;
  controlSince?: string;
  pendingUserAction?: string;
}

export async function agentControlStatusForClients(
  clients: CdpClientInfo[],
  homeDir = os.homedir(),
  now = Date.now()
): Promise<AgentControlClientsStatus> {
  const clientsByOwner = new Map<string, CdpClientInfo[]>();
  for (const client of clients) {
    if (!Number.isSafeInteger(client.pid) || client.pid <= 0) {
      continue;
    }
    const session = safeAgentBrowserSessionName(client.session);
    const ownerKey = session ? `session:${session}` : `pid:${client.pid}`;
    const group = clientsByOwner.get(ownerKey) || [];
    group.push(client);
    clientsByOwner.set(ownerKey, group);
  }
  if (!clientsByOwner.size) {
    return { paused: false, agentOffline: false };
  }

  const states = await Promise.all(
    [...clientsByOwner].map(async ([ownerKey, group]) => {
      const session = ownerKey.startsWith("session:") ? ownerKey.slice("session:".length) : "";
      const pid = group[0].pid;
      const paths = new Set<string>([
        path.join(homeDir, ".profilepilot", "agent-control", `pid-${pid}.json`)
      ]);
      for (const client of group) {
        for (const filePath of agentControlNoticePaths(homeDir, client.session, pid)) {
          paths.add(filePath);
        }
      }
      for (const filePath of paths) {
        const notice = await readActiveAgentControlNotice(filePath, { pid, session: session || undefined }, now);
        if (notice) {
          return { notice, group };
        }
      }
      return { notice: null, group };
    })
  );
  const paused = states.every((state) => state.notice !== null);
  if (!paused) {
    return { paused: false, agentOffline: false };
  }
  const notices = states.map((state) => state.notice as AgentControlNotice);
  const controlSince = notices
    .map((notice) => notice.at)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const agentOffline = states.every(({ notice, group }) => {
    if (!notice || notice.reason !== "user_takeover" || notice.handoffState === "requested") {
      return false;
    }
    const delegatedAt = Date.parse(notice.at);
    if (!Number.isFinite(delegatedAt) || now - delegatedAt < AGENT_CONTROL_WAITER_OFFLINE_GRACE_MS) {
      return false;
    }
    const session = safeAgentBrowserSessionName(notice.session || group.find((client) => client.session)?.session);
    return Boolean(session) && !readActiveAgentBrowserControlWaitStateSync(session, homeDir);
  });
  const pendingUserAction = notices
    .map((notice) => typeof notice.pendingUserAction === "string" ? notice.pendingUserAction.replace(/\s+/g, " ").trim() : "")
    .find(Boolean);
  return {
    paused: true,
    agentOffline,
    controlSince,
    ...(pendingUserAction ? { pendingUserAction } : {})
  };
}

export async function readActiveAgentControlNotice(
  filePath: string,
  expectedOwner: { pid: number; session?: string },
  now: number
): Promise<AgentControlNotice | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) {
      return null;
    }
    const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
    if (
      value.hardStop !== true ||
      value.reason !== "user_takeover" ||
      value.ownership !== "agentDelegatedToUser" ||
      value.handoffState === "requested" ||
      (expectedOwner.session
        ? value.session !== expectedOwner.session
        : value.pid !== expectedOwner.pid) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now
    ) {
      return null;
    }
    return value as unknown as AgentControlNotice;
  } catch {
    return null;
  }
}

export async function writeAgentControlNoticeFile(filePath: string, notice: AgentControlNotice): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, notice);
}

export function inferAgentNameForTakeover(client: CdpClientInfo): string | undefined {
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

export function uniqueCdpClientsByPid(clients: CdpClientInfo[]): CdpClientInfo[] {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

export function takeoverFailureMessage(result: TakeoverAgentConnectionsResult): string {
  const firstFailure = result.failures[0];
  const suffix = firstFailure ? `：${firstFailure.error}` : "";
  if (result.successCount > 0) {
    return `只停止了 ${result.successCount}/${result.targetCount} 条 AI 驱动连接${suffix}`;
  }
  return `没有停止任何 AI 驱动连接${suffix}`;
}

export function normalizeTakeoverHistory(input: unknown): AgentTakeoverEvent[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(normalizeTakeoverEvent)
    .filter((event): event is AgentTakeoverEvent => Boolean(event))
    .slice(-TAKEOVER_HISTORY_LIMIT);
}

export function normalizeTakeoverEvent(input: unknown): AgentTakeoverEvent | null {
  if (!isRecord(input)) {
    return null;
  }
  const profileId = stringField(input.profileId);
  const profileName = stringField(input.profileName);
  const at = stringField(input.at);
  if (!profileId || !profileName || !at) {
    return null;
  }

  const event: AgentTakeoverEvent = { profileId, profileName, at };
  const session = stringField(input.session);
  const sessionTitle = stringField(input.sessionTitle);
  const agent = stringField(input.agent);
  if (session) {
    event.session = session;
  }
  if (sessionTitle) {
    event.sessionTitle = sessionTitle;
  }
  if (agent) {
    event.agent = agent;
  }
  return event;
}

export function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function gatewayProfilesFromResponse(response: GatewayControlResponse): Array<Record<string, unknown>> {
  const state = response.state;
  if (!isRecord(state) || !Array.isArray(state.profiles)) return [];
  return state.profiles.filter((profile): profile is Record<string, unknown> => isRecord(profile));
}

export function gatewayManagedPortSet(response: GatewayControlResponse | null): Set<number> {
  if (!response) return new Set();
  const values = [
    ...(Array.isArray(response.managedPorts) ? response.managedPorts : []),
    ...(Array.isArray(response.ports) ? response.ports : [])
  ];
  return new Set(
    values
      .map(Number)
      .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535)
  );
}

export function compatibilityCdpPorts(
  ports: number[],
  response: GatewayControlResponse | null
): number[] {
  const managed = gatewayManagedPortSet(response);
  return [...new Set(ports)]
    .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535 && !managed.has(port))
    .sort((a, b) => a - b);
}

export function agentBrowserRuntimeProfilesFromPublicProfiles(
  profiles: Array<Pick<PublicProfile,
    "id" | "name" | "source" | "running" | "cdpPort" | "fixedCdpPort" |
    "clonedFromProfileId" | "projectTag" | "agentAccessDisabled" | "lastLaunchedAt"
  >>
): AgentBrowserRuntimeProfile[] {
  return profiles
    .filter((profile) =>
      profile.cdpPort !== null ||
      (profile.source === "isolated" && !profile.running && profile.fixedCdpPort !== null)
    )
    .map((profile) => ({
      profileId: profile.id,
      profileName: profile.name,
      cdpPort: (profile.cdpPort ?? profile.fixedCdpPort) as number,
      source: profile.source,
      clonedFromProfileId: profile.clonedFromProfileId || undefined,
      projectTag: profile.projectTag || undefined,
      agentAccessDisabled: profile.agentAccessDisabled,
      lastLaunchedAt: profile.lastLaunchedAt || undefined,
      running: profile.running && profile.cdpPort !== null
    }));
}

export function stripManagedCdpRuntimeMetadata(
  runtime: Map<string, RuntimeProfile>,
  managedPorts: Set<number>
): void {
  if (!managedPorts.size) return;
  for (const profile of runtime.values()) {
    if (profile.cdpPort !== null && managedPorts.has(profile.cdpPort)) {
      profile.cdpPort = null;
    }
    profile.listeningPorts = profile.listeningPorts.filter((port) => !managedPorts.has(port));
  }
}

export function gatewayControlsByPort(response: GatewayControlResponse | null): Map<number, GatewayProfileControlState> {
  const result = new Map<number, GatewayProfileControlState>();
  if (!response) return result;
  const activePorts = new Set(Array.isArray(response.ports) ? response.ports.map(Number) : []);
  for (const profile of gatewayProfilesFromResponse(response)) {
    const publicPort = Number(profile.publicPort);
    if (!activePorts.has(publicPort) || !Number.isSafeInteger(publicPort) || publicPort <= 0) continue;
    const ownership = profile.ownership === "agent" || profile.ownership === "user" ? profile.ownership : null;
    const sessionStatus = profile.sessionStatus === "active" || profile.sessionStatus === "stopped"
      ? profile.sessionStatus
      : null;
    const agentHealth = profile.agentHealth === "online" || profile.agentHealth === "waiting" || profile.agentHealth === "offline"
      ? profile.agentHealth
      : null;
    if (!ownership || !sessionStatus || !agentHealth) continue;
    const driverState = profile.driverState === "disconnected" ||
      profile.driverState === "connecting" ||
      profile.driverState === "connected" ||
      profile.driverState === "reconnecting" ||
      profile.driverState === "parked"
      ? profile.driverState
      : sessionStatus === "stopped"
        ? "disconnected"
        : ownership === "user"
          ? "parked"
          : profile.connectionActive === true
            ? "connected"
            : "reconnecting";
    const ownerSessionId = stringField(profile.ownerSessionId) || null;
    const pendingUserAction = stringField(profile.pendingUserAction) || (
      ownership === "user" && sessionStatus === "active" && ownerSessionId
        ? pendingUserActionFromControlNoticeSync(ownerSessionId)
        : null
    );
    result.set(publicPort, {
      publicPort,
      ownership,
      sessionStatus,
      agentHealth,
      driverState,
      reconnectAttempt: nonNegativeInteger(profile.reconnectAttempt),
      reconnectDeadlineAt: stringField(profile.reconnectDeadlineAt) || null,
      connectionActive: profile.connectionActive === true,
      ownerSessionId,
      daemonInstanceId: stringField(profile.daemonInstanceId) || null,
      daemonPid: positiveInteger(profile.daemonPid),
      driverKind: gatewayDriverKind(profile.driverKind),
      driverLabel: stringField(profile.driverLabel) || null,
      agent: stringField(profile.agent) || null,
      project: stringField(profile.project) || null,
      branch: stringField(profile.branch) || null,
      agentTarget: gatewayAgentTarget(profile.agentTarget),
      pendingUserAction,
      updatedAt: stringField(profile.updatedAt) || new Date().toISOString()
    });
  }
  return result;
}

export function gatewayAgentTarget(value: unknown): GatewayProfileControlState["agentTarget"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  const targetId = stringField(target.targetId);
  if (!targetId) return null;
  return {
    targetId,
    title: stringField(target.title) || "",
    url: stringField(target.url) || ""
  };
}

export function gatewayDriverKind(value: unknown): BrowserDriverKind | null {
  return value === "agent-browser"
    ? value
    : null;
}

export async function enrichCdpClientSessionIdentities(clients: CdpClientInfo[]): Promise<void> {
  const bySession = new Map<string, CdpClientInfo[]>();
  for (const client of clients) {
    if (!client.session) continue;
    const group = bySession.get(client.session) || [];
    group.push(client);
    bySession.set(client.session, group);
  }
  await Promise.all(
    [...bySession.entries()].map(async ([session, sessionClients]) => {
      const identity = await resolveCanonicalSessionIdentity(session);
      if (!identity) return;
      for (const client of sessionClients) {
        client.canonicalSessionId = identity.canonicalSessionId;
        client.sessionRepresentations = identity.representations;
        client.sessionDiagnostics = identity.diagnostics;
      }
    })
  );
}

export function pendingUserActionFromControlNoticeSync(
  sessionId: string,
  homeDir = os.homedir()
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const paths = [
    path.join(homeDir, ".profilepilot", "agent-control", `${sessionId}.json`),
    path.join(homeDir, ".agent-browser", `${sessionId}.profilepilot-control.json`)
  ];
  for (const filePath of paths) {
    try {
      const notice = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
      if (
        notice.reason === "user_takeover" &&
        notice.ownership === "agentDelegatedToUser" &&
        typeof notice.pendingUserAction === "string" &&
        notice.pendingUserAction.trim()
      ) {
        return notice.pendingUserAction.replace(/\s+/g, " ").trim().slice(0, 240);
      }
    } catch {
      // Try the mirrored notice path.
    }
  }
  return null;
}

export function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function gatewayControlClient(control: GatewayProfileControlState): CdpClientInfo | null {
  if (control.sessionStatus !== "active" || !control.ownerSessionId || !control.daemonPid) return null;
  const label = control.driverLabel || browserDriverLabel(control.driverKind);
  return {
    pid: control.daemonPid,
    label,
    driverKind: control.driverKind || undefined,
    agent: control.agent || undefined,
    project: control.project || undefined,
    branch: control.branch || undefined,
    title: `${label} Gateway Session`,
    session: control.ownerSessionId,
    lastActive: control.updatedAt,
    note: control.ownership === "user"
      ? control.pendingUserAction
        ? `ProfilePilot Gateway：等待用户操作“${control.pendingUserAction}”，Session 仍保留`
        : "ProfilePilot Gateway：Session 仍保留，但浏览器控制权当前属于用户"
      : "ProfilePilot Gateway：当前 Session 是此 Profile 的唯一 Agent 控制者"
  };
}

export function browserDriverLabel(kind: BrowserDriverKind | null | undefined): string {
  return "agent-browser";
}

export function gatewayConnectedClients(control: GatewayProfileControlState): CdpClientInfo[] {
  if (!control.connectionActive || control.ownership !== "agent") return [];
  const client = gatewayControlClient(control);
  return client ? [client] : [];
}

export function mergeGatewayControlClient(
  clients: CdpClientInfo[],
  control: GatewayProfileControlState
): CdpClientInfo[] {
  const client = gatewayControlClient(control);
  if (!client) return clients;
  if (clients.some((candidate) => candidate.session === client.session)) return clients;
  return [client, ...clients];
}

export function gatewayOverlayClients(profile: PublicProfile): CdpClientInfo[] {
  if (!profile.gatewayControl || profile.gatewayControl.sessionStatus !== "active") {
    return profile.cdpClients.filter(isAgentOverlayClient);
  }
  return mergeGatewayControlClient(profile.cdpClients, profile.gatewayControl).filter(isAgentOverlayClient);
}

export function gatewayOverlayControl(
  control: GatewayProfileControlState,
  homeDir = os.homedir(),
  now = Date.now()
): {
  paused: boolean;
  agentOffline: boolean;
  controlSince: string | undefined;
  pendingUserAction: string | undefined;
} {
  const paused = control.ownership === "user";
  const session = safeAgentBrowserSessionName(control.ownerSessionId || undefined);
  const delegatedAt = Date.parse(control.updatedAt || "");
  const waiterOffline = Boolean(
    paused &&
    control.sessionStatus === "active" &&
    control.driverKind === "agent-browser" &&
    session &&
    Number.isFinite(delegatedAt) &&
    now - delegatedAt >= AGENT_CONTROL_WAITER_OFFLINE_GRACE_MS &&
    !readActiveAgentBrowserControlWaitStateSync(session, homeDir)
  );
  return {
    paused,
    agentOffline: waiterOffline || (control.driverState
      ? control.driverState === "disconnected"
      : control.agentHealth === "offline"),
    controlSince: control.updatedAt || undefined,
    pendingUserAction: control.pendingUserAction || undefined
  };
}

export function persistedGatewayOwnsSession(sessionId: string, homeDir = os.homedir()): boolean {
  try {
    const parsed = JSON.parse(
      require("node:fs").readFileSync(path.join(homeDir, ".profilepilot", "gateway", "state.json"), "utf8")
    );
    return Array.isArray(parsed?.profiles) && parsed.profiles.some(
      (profile: unknown) => isRecord(profile) && profile.ownerSessionId === sessionId
    );
  } catch {
    return false;
  }
}
