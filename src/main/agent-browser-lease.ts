import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentBrowserProfileOccupancy, StoredProfile } from "../shared/types";

const SAFE_SESSION_RE = /^[A-Za-z0-9._-]+$/;
const LEASE_VERSION = 1;
const LEASE_FILE_RE = /^cdp-(\d+)\.json$/;
const MUTEX_STALE_MS = 5_000;
const MUTEX_WAIT_MS = 2_000;
const MUTEX_POLL_MS = 10;
const RUNTIME_SNAPSHOT_VERSION = 1;
const RUNTIME_SNAPSHOT_MAX_AGE_MS = 30_000;
const RUNTIME_SNAPSHOT_HEARTBEAT_MS = 10_000;
const GATEWAY_STATE_VERSION = 1;

// 首条 connect 命令执行期间还不一定已经生成 daemon pid，只给一个短暂的 pending 窗口；
// 命令成功后会带 daemon pid 续成常规租约。常规租约每条浏览器命令都会续期。
export const AGENT_BROWSER_PROFILE_LEASE_PENDING_TTL_MS = 90_000;
export const AGENT_BROWSER_PROFILE_LEASE_TTL_MS = 30 * 60_000;

export interface AgentBrowserProfileLease {
  version: 1;
  cdpPort: number;
  profileId: string;
  profileName: string;
  session: string;
  agent?: string;
  project?: string;
  command?: string;
  holderPid: number;
  daemonPid?: number;
  // 临时交给用户时仍由原 Session 保留排它绑定；只有显式交还或结束 Session 才改变。
  delegatedToUser?: boolean;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AcquireAgentBrowserProfileLeaseInput {
  cdpPort: number;
  session: string;
  holderPid: number;
  daemonPid?: number;
  profileId?: string;
  profileName?: string;
  agent?: string;
  project?: string;
  command?: string;
}

export interface AgentBrowserRuntimeProfile {
  profileId: string;
  profileName: string;
  cdpPort: number;
  source?: string;
  clonedFromProfileId?: string;
  projectTag?: string;
  lastLaunchedAt?: string;
  // false 表示已登记但尚未启动；推荐命令会交给 Gateway 自动启动。
  running: boolean;
}

export interface AgentBrowserProfileCandidate extends AgentBrowserRuntimeProfile {
  alreadyOwnedBySession: boolean;
}

export interface ConfiguredAgentBrowserProfile {
  profileId: string;
  profileName: string;
  cdpPort: number;
  profile: StoredProfile;
  registryPath: string;
  userDataDir: string;
}

interface AgentBrowserRuntimeProfileSnapshot {
  version: 1;
  updatedAt: string;
  profiles: AgentBrowserRuntimeProfile[];
}

export type AcquireAgentBrowserProfileLeaseResult =
  | {
      ok: true;
      status: "acquired" | "renewed" | "reclaimed";
      lease: AgentBrowserProfileLease;
      replacedLease?: AgentBrowserProfileLease;
    }
  | {
      ok: false;
      status: "conflict";
      lease: AgentBrowserProfileLease;
    };

export function agentBrowserProfileLeaseDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".profilepilot", "profile-leases");
}

export function agentBrowserProfileLeasePath(homeDir: string, cdpPort: number): string {
  return path.join(agentBrowserProfileLeaseDir(homeDir), `cdp-${cdpPort}.json`);
}

export function agentBrowserRuntimeProfilesPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".profilepilot", "runtime-profiles.json");
}

export function writeAgentBrowserRuntimeProfilesSync(
  profilesInput: AgentBrowserRuntimeProfile[],
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserRuntimeProfileSnapshot {
  const profiles = normalizeRuntimeProfiles(profilesInput);
  const filePath = agentBrowserRuntimeProfilesPath(homeDir);
  const previous = readAgentBrowserRuntimeProfilesSync(homeDir);
  if (
    previous &&
    JSON.stringify(previous.profiles) === JSON.stringify(profiles) &&
    now - Date.parse(previous.updatedAt) < RUNTIME_SNAPSHOT_HEARTBEAT_MS
  ) {
    return previous;
  }
  const snapshot: AgentBrowserRuntimeProfileSnapshot = {
    version: RUNTIME_SNAPSHOT_VERSION,
    updatedAt: new Date(now).toISOString(),
    profiles
  };
  writeJsonFileAtomicSync(filePath, snapshot);
  return snapshot;
}

export function readAgentBrowserRuntimeProfilesSync(
  homeDir = os.homedir()
): AgentBrowserRuntimeProfileSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(agentBrowserRuntimeProfilesPath(homeDir), "utf8")) as Partial<AgentBrowserRuntimeProfileSnapshot>;
    if (parsed.version !== RUNTIME_SNAPSHOT_VERSION || typeof parsed.updatedAt !== "string" || !Array.isArray(parsed.profiles)) {
      return null;
    }
    return {
      version: RUNTIME_SNAPSHOT_VERSION,
      updatedAt: parsed.updatedAt,
      profiles: normalizeRuntimeProfiles(parsed.profiles)
    };
  } catch {
    return null;
  }
}

export function findAvailableAgentBrowserProfileCandidatesSync(
  input: {
    excludedPort: number;
    requestedSession?: string;
  },
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserProfileCandidate[] {
  const snapshot = readAgentBrowserRuntimeProfilesSync(homeDir);
  const updatedAt = snapshot ? Date.parse(snapshot.updatedAt) : Number.NaN;
  if (!snapshot || !Number.isFinite(updatedAt) || now - updatedAt > RUNTIME_SNAPSHOT_MAX_AGE_MS) {
    return [];
  }
  const requestedSession = safeSessionName(input.requestedSession);
  return snapshot.profiles
    .filter((profile) => profile.cdpPort !== input.excludedPort)
    .map((profile): AgentBrowserProfileCandidate | null => {
      const occupancy = readActiveAgentBrowserProfileOccupancySync(profile.cdpPort, homeDir, now);
      const alreadyOwnedBySession = Boolean(occupancy && requestedSession && occupancy.session === requestedSession);
      if (occupancy && !alreadyOwnedBySession) {
        return null;
      }
      return { ...profile, alreadyOwnedBySession };
    })
    .filter((profile): profile is AgentBrowserProfileCandidate => Boolean(profile))
    // CDP 端口就是用户定义的 Profile 槽位顺序。冲突后严格从小到大推荐，
    // 例如 9223 被占用时依次尝试 9224、9225，而不让副本组/项目标签打乱顺序。
    .sort((a, b) => a.cdpPort - b.cdpPort);
}

export function readActiveAgentBrowserProfileOccupancySync(
  cdpPort: number,
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserProfileOccupancy | null {
  const lease = readAgentBrowserProfileLeaseSync(cdpPort, homeDir);
  if (!lease || !isAgentBrowserProfileLeaseActive(lease, now, homeDir)) return null;
  return {
    cdpPort: lease.cdpPort,
    profileId: lease.profileId,
    profileName: lease.profileName,
    session: lease.session,
    ownership: lease.delegatedToUser ? "user" : "agent",
    agent: lease.agent || null,
    project: lease.project || null,
    command: lease.command || null,
    holderPid: lease.holderPid,
    daemonPid: lease.daemonPid || null,
    updatedAt: lease.updatedAt
  };
}

export function acquireAgentBrowserProfileLeaseSync(
  input: AcquireAgentBrowserProfileLeaseInput,
  homeDir = os.homedir(),
  now = Date.now()
): AcquireAgentBrowserProfileLeaseResult {
  const cdpPort = normalizePort(input.cdpPort);
  const session = safeSessionName(input.session);
  const holderPid = normalizePid(input.holderPid);
  if (!cdpPort || !session || !holderPid) {
    throw new Error("invalid agent-browser profile lease input");
  }

  return withLeaseMutexSync(homeDir, cdpPort, () => {
    const leasePath = agentBrowserProfileLeasePath(homeDir, cdpPort);
    const existing = readAgentBrowserProfileLeaseFileSync(leasePath);
    if (existing && existing.session !== session && isAgentBrowserProfileLeaseActive(existing, now, homeDir)) {
      return { ok: false, status: "conflict", lease: existing };
    }

    const sameOwner = existing?.session === session;
    const target = resolveAgentBrowserProfileTargetSync(cdpPort, process.env, homeDir);
    const daemonPid = normalizePid(input.daemonPid) || (sameOwner ? existing?.daemonPid : undefined);
    const at = new Date(now).toISOString();
    const lease: AgentBrowserProfileLease = {
      version: LEASE_VERSION,
      cdpPort,
      profileId: nonEmptyString(input.profileId) || (sameOwner ? existing?.profileId : undefined) || target.profileId,
      profileName: nonEmptyString(input.profileName) || (sameOwner ? existing?.profileName : undefined) || target.profileName,
      session,
      holderPid,
      acquiredAt: sameOwner && existing ? existing.acquiredAt : at,
      updatedAt: at,
      expiresAt: new Date(now + (daemonPid ? AGENT_BROWSER_PROFILE_LEASE_TTL_MS : AGENT_BROWSER_PROFILE_LEASE_PENDING_TTL_MS)).toISOString()
    };
    if (daemonPid) {
      lease.daemonPid = daemonPid;
    }
    const agent = nonEmptyString(input.agent) || inferAgentFromSession(session) || (sameOwner ? existing?.agent : undefined);
    if (agent) {
      lease.agent = agent;
    }
    const project = nonEmptyString(input.project) || (sameOwner ? existing?.project : undefined);
    if (project) {
      lease.project = project;
    }
    const command = nonEmptyString(input.command) || (sameOwner ? existing?.command : undefined);
    if (command) {
      lease.command = command;
    }

    writeJsonFileAtomicSync(leasePath, lease);
    if (!existing) {
      return { ok: true, status: "acquired", lease };
    }
    if (sameOwner) {
      return { ok: true, status: "renewed", lease };
    }
    return { ok: true, status: "reclaimed", lease, replacedLease: existing };
  });
}

export function readAgentBrowserProfileLeaseSync(
  cdpPort: number,
  homeDir = os.homedir()
): AgentBrowserProfileLease | null {
  const port = normalizePort(cdpPort);
  return port ? readAgentBrowserProfileLeaseFileSync(agentBrowserProfileLeasePath(homeDir, port)) : null;
}

export function findAgentBrowserProfileLeaseForSessionSync(
  sessionInput: string,
  homeDir = os.homedir()
): AgentBrowserProfileLease | null {
  const session = safeSessionName(sessionInput);
  if (!session) {
    return null;
  }
  let names: string[] = [];
  try {
    names = readdirSync(agentBrowserProfileLeaseDir(homeDir));
  } catch {
    return null;
  }
  return names
    .map((name) => {
      const match = name.match(LEASE_FILE_RE);
      return match ? readAgentBrowserProfileLeaseFileSync(path.join(agentBrowserProfileLeaseDir(homeDir), name)) : null;
    })
    .filter((lease): lease is AgentBrowserProfileLease => Boolean(lease && lease.session === session))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

export function releaseAgentBrowserProfileLeaseSync(
  cdpPort: number,
  sessionInput: string,
  homeDir = os.homedir()
): boolean {
  const port = normalizePort(cdpPort);
  const session = safeSessionName(sessionInput);
  if (!port || !session) {
    return false;
  }
  return withLeaseMutexSync(homeDir, port, () => {
    const leasePath = agentBrowserProfileLeasePath(homeDir, port);
    const lease = readAgentBrowserProfileLeaseFileSync(leasePath);
    if (!lease || lease.session !== session) {
      return false;
    }
    rmSync(leasePath, { force: true });
    return true;
  });
}

export function releaseAgentBrowserProfileLeasesForSessionSync(
  sessionInput: string,
  homeDir = os.homedir(),
  exceptPort?: number
): number[] {
  const session = safeSessionName(sessionInput);
  if (!session) {
    return [];
  }
  let names: string[] = [];
  try {
    names = readdirSync(agentBrowserProfileLeaseDir(homeDir));
  } catch {
    return [];
  }
  const released: number[] = [];
  for (const name of names) {
    const match = name.match(LEASE_FILE_RE);
    const port = match ? normalizePort(Number(match[1])) : undefined;
    if (!port || port === exceptPort) {
      continue;
    }
    if (releaseAgentBrowserProfileLeaseSync(port, session, homeDir)) {
      released.push(port);
    }
  }
  return released;
}

export function setAgentBrowserProfileLeasesDelegatedSync(
  sessionInput: string,
  delegatedToUser: boolean,
  homeDir = os.homedir(),
  now = Date.now()
): number[] {
  const session = safeSessionName(sessionInput);
  if (!session) {
    return [];
  }
  let names: string[] = [];
  try {
    names = readdirSync(agentBrowserProfileLeaseDir(homeDir));
  } catch {
    return [];
  }
  const updated: number[] = [];
  for (const name of names) {
    const match = name.match(LEASE_FILE_RE);
    const port = match ? normalizePort(Number(match[1])) : undefined;
    if (!port) continue;
    withLeaseMutexSync(homeDir, port, () => {
      const leasePath = agentBrowserProfileLeasePath(homeDir, port);
      const lease = readAgentBrowserProfileLeaseFileSync(leasePath);
      if (!lease || lease.session !== session) return;
      writeJsonFileAtomicSync(leasePath, {
        ...lease,
        delegatedToUser,
        updatedAt: new Date(now).toISOString(),
        expiresAt: delegatedToUser
          ? "9999-12-31T23:59:59.999Z"
          : new Date(now + AGENT_BROWSER_PROFILE_LEASE_TTL_MS).toISOString()
      });
      updated.push(port);
    });
  }
  return updated;
}

export function updateAgentBrowserProfileLeaseTargetSync(
  cdpPort: number,
  target: { profileId: string; profileName: string },
  homeDir = os.homedir()
): boolean {
  const port = normalizePort(cdpPort);
  const profileId = nonEmptyString(target.profileId);
  const profileName = nonEmptyString(target.profileName);
  if (!port || !profileId || !profileName) {
    return false;
  }
  const snapshot = readAgentBrowserProfileLeaseSync(port, homeDir);
  if (!snapshot || (snapshot.profileId === profileId && snapshot.profileName === profileName)) {
    return false;
  }
  return withLeaseMutexSync(homeDir, port, () => {
    const leasePath = agentBrowserProfileLeasePath(homeDir, port);
    const lease = readAgentBrowserProfileLeaseFileSync(leasePath);
    if (!lease || (lease.profileId === profileId && lease.profileName === profileName)) {
      return false;
    }
    writeJsonFileAtomicSync(leasePath, { ...lease, profileId, profileName });
    return true;
  });
}

// 过期租约被新 Session 回收时，在真正启动新 agent-browser 命令前结束旧 Session 的 daemon，
// 避免“租约文件已换主，但旧 CDP socket 仍实际连着”的短路。
export function retireReplacedAgentBrowserLeaseOwnerSync(
  lease: AgentBrowserProfileLease,
  homeDir = os.homedir()
): boolean {
  return retireAgentBrowserSessionSync(lease.session, lease.daemonPid, homeDir);
}

export function retireAgentBrowserSessionSync(
  sessionInput: string,
  knownDaemonPid?: number,
  homeDir = os.homedir()
): boolean {
  const session = safeSessionName(sessionInput);
  if (!session) {
    return true;
  }
  const agentBrowserDir = path.join(homeDir, ".agent-browser");
  const pidPath = path.join(agentBrowserDir, `${session}.pid`);
  const pidFromFile = readPidFileSync(pidPath);
  const daemonPid = normalizePid(knownDaemonPid) || pidFromFile;

  if (daemonPid && isProcessAlive(daemonPid)) {
    // pid 文件指向了别的 daemon，或 PID 已被非 agent-browser 进程复用时绝不误杀。
    if ((pidFromFile && pidFromFile !== daemonPid) || !isAgentBrowserProcess(daemonPid)) {
      return true;
    }
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // 进程刚好退出，按已回收处理。
    }
    if (!waitUntilProcessGoneSync(daemonPid, 1_500)) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // 同上。
      }
      if (!waitUntilProcessGoneSync(daemonPid, 500)) {
        return false;
      }
    }
  }

  if (!pidFromFile || !daemonPid || pidFromFile === daemonPid) {
    rmSync(pidPath, { force: true });
    rmSync(path.join(agentBrowserDir, `${session}.sock`), { force: true });
  }
  for (const activityPath of agentBrowserSessionActivityPaths(homeDir, session)) {
    rmSync(activityPath, { force: true });
  }
  return true;
}

export function isAgentBrowserProfileLeaseActive(
  lease: AgentBrowserProfileLease,
  now = Date.now(),
  homeDir = os.homedir()
): boolean {
  if (lease.delegatedToUser) {
    // 委托给用户的租约没有时间过期，但 Gateway 才是当前 Profile↔Session 所有权的权威。
    // Gateway 进程活着且状态文件有效时，如果该端口已没有 active owner，说明这是上一次
    // Gateway 生命周期遗留的 lease；继续永久保留会把所有备用 Profile 逐渐耗尽。
    // Gateway 不可用时保持保守：仍视为 active，避免仅凭缺文件抢走用户正在操作的 Profile。
    const gatewayOwnership = readGatewayActiveOwnershipSync(lease.cdpPort, homeDir);
    if (gatewayOwnership !== undefined) {
      return gatewayOwnership !== null;
    }
    return true;
  }
  if (isProcessAlive(lease.holderPid)) {
    return true;
  }
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return false;
  }
  return lease.daemonPid ? isProcessAlive(lease.daemonPid) : true;
}

interface GatewayActiveOwnership {
  ownerSessionId: string;
  publicPort: number;
}

// undefined = Gateway 权威不可用，null = Gateway 明确表示此端口没有 active owner。
function readGatewayActiveOwnershipSync(
  cdpPort: number,
  homeDir: string
): GatewayActiveOwnership | null | undefined {
  const gatewayDir = path.join(homeDir, ".profilepilot", "gateway");
  const daemonPid = readPidFileSync(path.join(gatewayDir, "daemon.pid"));
  if (!daemonPid || !isProcessAlive(daemonPid)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path.join(gatewayDir, "state.json"), "utf8")) as {
      version?: unknown;
      profiles?: Array<{
        publicPort?: unknown;
        ownerSessionId?: unknown;
        sessionStatus?: unknown;
      }>;
    };
    if (parsed.version !== GATEWAY_STATE_VERSION || !Array.isArray(parsed.profiles)) {
      return undefined;
    }
    const active = parsed.profiles.find(
      (profile) =>
        Number(profile.publicPort) === cdpPort &&
        profile.sessionStatus === "active" &&
        safeSessionName(typeof profile.ownerSessionId === "string" ? profile.ownerSessionId : undefined) !== undefined
    );
    const ownerSessionId = active
      ? safeSessionName(typeof active.ownerSessionId === "string" ? active.ownerSessionId : undefined)
      : undefined;
    return active && ownerSessionId ? { ownerSessionId, publicPort: cdpPort } : null;
  } catch {
    return undefined;
  }
}

export function resolveAgentBrowserProfileTargetSync(
  cdpPort: number,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): { profileId: string; profileName: string } {
  const fallback = { profileId: `cdp:${cdpPort}`, profileName: `CDP :${cdpPort}` };
  const configured = findConfiguredAgentBrowserProfileByPortSync(cdpPort, env, homeDir);
  return configured
    ? { profileId: configured.profileId, profileName: configured.profileName }
    : fallback;
}

export function findConfiguredAgentBrowserProfileByPortSync(
  cdpPortInput: number,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): ConfiguredAgentBrowserProfile | null {
  const cdpPort = normalizePort(cdpPortInput);
  if (!cdpPort) return null;
  for (const registryPath of profileRegistryCandidates(env, homeDir)) {
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { profiles?: StoredProfile[] };
      const profile = parsed.profiles?.find((item) => {
        const port = normalizePort(Number(item.fixedCdpPort)) || normalizePort(Number(item.lastCdpPort));
        return port === cdpPort;
      });
      const id = nonEmptyString(profile?.id);
      const name = nonEmptyString(profile?.name);
      const dirName = nonEmptyString(profile?.dirName);
      if (!id || !name || !dirName || !profile) continue;
      const profilesRoot = path.resolve(path.dirname(registryPath), "profiles");
      const userDataDir = path.resolve(profilesRoot, dirName);
      if (userDataDir !== profilesRoot && !userDataDir.startsWith(`${profilesRoot}${path.sep}`)) continue;
      return {
        profileId: `isolated:${id}`,
        profileName: name,
        cdpPort,
        profile,
        registryPath,
        userDataDir
      };
    } catch {
      // 尝试下一个兼容数据目录。
    }
  }
  return null;
}

function readAgentBrowserProfileLeaseFileSync(filePath: string): AgentBrowserProfileLease | null {
  try {
    return normalizeLease(JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentBrowserProfileLease>);
  } catch {
    return null;
  }
}

function normalizeLease(input: Partial<AgentBrowserProfileLease>): AgentBrowserProfileLease | null {
  const cdpPort = normalizePort(Number(input.cdpPort));
  const session = safeSessionName(input.session);
  const holderPid = normalizePid(Number(input.holderPid));
  const profileId = nonEmptyString(input.profileId);
  const profileName = nonEmptyString(input.profileName);
  const acquiredAt = nonEmptyString(input.acquiredAt);
  const updatedAt = nonEmptyString(input.updatedAt);
  const expiresAt = nonEmptyString(input.expiresAt);
  if (input.version !== LEASE_VERSION || !cdpPort || !session || !holderPid || !profileId || !profileName || !acquiredAt || !updatedAt || !expiresAt) {
    return null;
  }
  const lease: AgentBrowserProfileLease = {
    version: LEASE_VERSION,
    cdpPort,
    profileId,
    profileName,
    session,
    holderPid,
    acquiredAt,
    updatedAt,
    expiresAt
  };
  const daemonPid = normalizePid(Number(input.daemonPid));
  if (daemonPid) lease.daemonPid = daemonPid;
  if (input.delegatedToUser === true) lease.delegatedToUser = true;
  const agent = nonEmptyString(input.agent);
  if (agent) lease.agent = agent;
  const project = nonEmptyString(input.project);
  if (project) lease.project = project;
  const command = nonEmptyString(input.command);
  if (command) lease.command = command;
  return lease;
}

function withLeaseMutexSync<T>(homeDir: string, cdpPort: number, action: () => T): T {
  const dir = agentBrowserProfileLeaseDir(homeDir);
  const lockPath = path.join(dir, `cdp-${cdpPort}.lock`);
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + MUTEX_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if (isStaleMutex(lockPath)) {
        const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
          continue;
        } catch {
          // 另一个进程先释放/回收了锁，继续正常等待。
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Profile lease mutex timeout for CDP ${cdpPort}`);
      }
      sleepSync(MUTEX_POLL_MS);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function profileRegistryCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const roots: string[] = [];
  if (nonEmptyString(env.CPM_DATA_DIR)) {
    roots.push(env.CPM_DATA_DIR as string);
  }
  if (process.platform === "darwin") {
    roots.push(
      path.join(homeDir, "Library", "Application Support", "Codex Chrome Profile Manager"),
      path.join(homeDir, "Library", "Application Support", "ProfilePilot")
    );
  } else if (process.platform === "win32") {
    const appData = env.APPDATA || homeDir;
    roots.push(path.join(appData, "Codex Chrome Profile Manager"), path.join(appData, "ProfilePilot"));
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    roots.push(path.join(config, "codex-chrome-profile-manager"), path.join(config, "profilepilot"));
  }
  return [...new Set(roots)].map((root) => path.join(root, "profiles.json"));
}

function normalizeRuntimeProfiles(input: unknown[]): AgentBrowserRuntimeProfile[] {
  const profiles: AgentBrowserRuntimeProfile[] = [];
  const seenPorts = new Set<number>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Partial<AgentBrowserRuntimeProfile>;
    const profileId = nonEmptyString(candidate.profileId);
    const profileName = nonEmptyString(candidate.profileName);
    const cdpPort = normalizePort(Number(candidate.cdpPort));
    if (!profileId || !profileName || !cdpPort || seenPorts.has(cdpPort)) {
      continue;
    }
    seenPorts.add(cdpPort);
    const profile: AgentBrowserRuntimeProfile = {
      profileId,
      profileName,
      cdpPort,
      // 兼容升级前没有 running 字段的短时快照：旧快照只包含运行中 Profile。
      running: candidate.running !== false
    };
    const source = nonEmptyString(candidate.source);
    if (source) profile.source = source;
    const clonedFromProfileId = nonEmptyString(candidate.clonedFromProfileId);
    if (clonedFromProfileId) profile.clonedFromProfileId = clonedFromProfileId;
    const projectTag = nonEmptyString(candidate.projectTag);
    if (projectTag) profile.projectTag = projectTag;
    const lastLaunchedAt = nonEmptyString(candidate.lastLaunchedAt);
    if (lastLaunchedAt) profile.lastLaunchedAt = lastLaunchedAt;
    profiles.push(profile);
  }
  return profiles.sort((a, b) => a.cdpPort - b.cdpPort);
}

function agentBrowserSessionActivityPaths(homeDir: string, session: string): string[] {
  return [
    path.join(homeDir, ".profilepilot", "agent-sessions", `${session}.json`),
    path.join(homeDir, ".agent-browser", `${session}.profilepilot-session.json`)
  ];
}

function readPidFileSync(filePath: string): number | undefined {
  try {
    return normalizePid(Number(readFileSync(filePath, "utf8").trim()));
  } catch {
    return undefined;
  }
}

function isAgentBrowserProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /agent-browser/i.test(command);
  } catch {
    return false;
  }
}

function waitUntilProcessGoneSync(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    sleepSync(25);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isStaleMutex(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= MUTEX_STALE_MS;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizePort(value: number): number | undefined {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}

function normalizePid(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeSessionName(value: string | undefined): string | undefined {
  const trimmed = nonEmptyString(value);
  return trimmed && SAFE_SESSION_RE.test(trimmed) ? trimmed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferAgentFromSession(session: string): string | undefined {
  if (session.startsWith("cc-")) return "Claude Code";
  if (session.startsWith("cx-")) return "Codex";
  return undefined;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}
