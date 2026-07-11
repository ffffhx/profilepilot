import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentBrowserSessionActivity, CdpClientInfo } from "../shared/types";

const SAFE_SESSION_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_COMMAND_ID_RE = /^[A-Za-z0-9._-]+$/;
const SESSION_ACTIVITY_TTL_MS = 30 * 60_000;

export interface AgentBrowserCommandState {
  version: 1;
  commandId: string;
  session: string;
  command: string;
  wrapperPid: number;
  childPid?: number;
  cdpPort?: number;
  phase: "running" | "draining";
  startedAt: string;
  updatedAt: string;
}

export interface AgentBrowserControlWaitState {
  version: 1;
  session: string;
  pid: number;
  startedAt: string;
}

export function safeAgentBrowserSessionName(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return SAFE_SESSION_RE.test(trimmed) ? trimmed : undefined;
}

export function agentBrowserSessionActivityPaths(homeDir: string, session: string): string[] {
  return [
    path.join(homeDir, ".profilepilot", "agent-sessions", `${session}.json`),
    path.join(homeDir, ".agent-browser", `${session}.profilepilot-session.json`)
  ];
}

export function makeAgentBrowserSessionActivity(
  input: {
    session: string;
    command: string;
    cdpPort: number;
    pid: number;
    cwd?: string;
    daemonPid?: number;
  },
  now = Date.now()
): AgentBrowserSessionActivity {
  const at = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_ACTIVITY_TTL_MS).toISOString();
  const activity: AgentBrowserSessionActivity = {
    version: 1,
    session: input.session,
    command: input.command,
    cdpPort: input.cdpPort,
    pid: input.pid,
    updatedAt: at,
    expiresAt
  };
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : undefined;
  if (cwd) {
    activity.cwd = cwd;
    activity.project = path.basename(cwd) || cwd;
  }
  const daemonPid = input.daemonPid;
  if (typeof daemonPid === "number" && Number.isSafeInteger(daemonPid) && daemonPid > 0) {
    activity.daemonPid = daemonPid;
  }
  const agent = inferAgentFromSession(input.session);
  if (agent) {
    activity.agent = agent;
  }
  return activity;
}

export function writeAgentBrowserSessionActivitySync(
  input: {
    session: string;
    command: string;
    cdpPort: number;
    pid: number;
    cwd?: string;
    daemonPid?: number;
  },
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserSessionActivity {
  const safeSession = safeAgentBrowserSessionName(input.session);
  if (!safeSession || !isValidTcpPort(input.cdpPort)) {
    throw new Error("invalid agent-browser session activity");
  }
  const activity = makeAgentBrowserSessionActivity({ ...input, session: safeSession }, now);
  for (const filePath of agentBrowserSessionActivityPaths(homeDir, safeSession)) {
    writeJsonFileAtomicSync(filePath, activity);
  }
  return activity;
}

export function readAgentBrowserDaemonPidSync(homeDir: string, session: string): number | undefined {
  const safeSession = safeAgentBrowserSessionName(session);
  if (!safeSession) {
    return undefined;
  }
  const pidPath = path.join(homeDir, ".agent-browser", `${safeSession}.pid`);
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function agentBrowserCommandStatePath(homeDir: string, session: string, commandId?: string): string {
  const root = path.join(homeDir, ".profilepilot", "agent-commands");
  return commandId
    ? path.join(root, session, `${commandId}.json`)
    : path.join(root, `${session}.json`);
}

function agentBrowserCommandStateDir(homeDir: string, session: string): string {
  return path.join(homeDir, ".profilepilot", "agent-commands", session);
}

export function agentBrowserControlWaitStatePath(homeDir: string, session: string): string {
  return path.join(homeDir, ".profilepilot", "agent-waiters", `${session}.json`);
}

export function writeAgentBrowserControlWaitStateSync(
  sessionInput: string,
  pid = process.pid,
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserControlWaitState {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session || !isValidPid(pid)) {
    throw new Error("invalid agent-browser control waiter state");
  }
  const state: AgentBrowserControlWaitState = {
    version: 1,
    session,
    pid,
    startedAt: new Date(now).toISOString()
  };
  writeJsonFileAtomicSync(agentBrowserControlWaitStatePath(homeDir, session), state);
  return state;
}

export function readActiveAgentBrowserControlWaitStateSync(
  sessionInput: string,
  homeDir = os.homedir()
): AgentBrowserControlWaitState | null {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session) {
    return null;
  }
  const filePath = agentBrowserControlWaitStatePath(homeDir, session);
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentBrowserControlWaitState>;
    const pid = Number(parsed.pid);
    const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
    if (parsed.version !== 1 || parsed.session !== session || !isValidPid(pid) || !startedAt || !isProcessAlive(pid)) {
      rmSync(filePath, { force: true });
      return null;
    }
    return { version: 1, session, pid, startedAt };
  } catch {
    rmSync(filePath, { force: true });
    return null;
  }
}

export function clearAgentBrowserControlWaitStateSync(
  sessionInput: string,
  pid?: number,
  homeDir = os.homedir()
): boolean {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session) {
    return false;
  }
  const filePath = agentBrowserControlWaitStatePath(homeDir, session);
  if (isValidPid(pid)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentBrowserControlWaitState>;
      if (Number(parsed.pid) !== pid) {
        return false;
      }
    } catch {
      return false;
    }
  }
  rmSync(filePath, { force: true });
  return true;
}

export function writeAgentBrowserCommandStateSync(
  input: Omit<AgentBrowserCommandState, "version" | "updatedAt">,
  homeDir = os.homedir(),
  now = Date.now()
): AgentBrowserCommandState {
  const session = safeAgentBrowserSessionName(input.session);
  if (!session || !SAFE_COMMAND_ID_RE.test(input.commandId) || !input.command || !isValidPid(input.wrapperPid)) {
    throw new Error("invalid agent-browser command state");
  }
  const state: AgentBrowserCommandState = {
    version: 1,
    commandId: input.commandId,
    session,
    command: input.command,
    wrapperPid: input.wrapperPid,
    phase: input.phase,
    startedAt: input.startedAt,
    updatedAt: new Date(now).toISOString()
  };
  if (isValidPid(input.childPid)) {
    state.childPid = input.childPid;
  }
  if (typeof input.cdpPort === "number" && isValidTcpPort(input.cdpPort)) {
    state.cdpPort = input.cdpPort;
  }
  writeJsonFileAtomicSync(agentBrowserCommandStatePath(homeDir, session, input.commandId), state);
  return state;
}

export function readActiveAgentBrowserCommandStateSync(
  sessionInput: string,
  homeDir = os.homedir()
): AgentBrowserCommandState | null {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session) {
    return null;
  }
  const paths = [agentBrowserCommandStatePath(homeDir, session)];
  try {
    paths.push(
      ...readdirSync(agentBrowserCommandStateDir(homeDir, session))
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(agentBrowserCommandStateDir(homeDir, session), name))
    );
  } catch {
    // No per-command directory yet; still probe the legacy single-file path.
  }
  const active: AgentBrowserCommandState[] = [];
  for (const filePath of paths) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentBrowserCommandState>;
      const state = normalizeAgentBrowserCommandState(parsed);
      if (state?.session === session && isProcessAlive(state.wrapperPid)) {
        active.push(state);
      } else {
        rmSync(filePath, { force: true });
      }
    } catch {
      rmSync(filePath, { force: true });
    }
  }
  return active.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

export function clearAgentBrowserCommandStateSync(
  sessionInput: string,
  commandId?: string,
  homeDir = os.homedir()
): boolean {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session) {
    return false;
  }
  if (commandId) {
    if (!SAFE_COMMAND_ID_RE.test(commandId)) {
      return false;
    }
    rmSync(agentBrowserCommandStatePath(homeDir, session, commandId), { force: true });
    // Compatibility with a wrapper installed before per-command state files existed.
    const legacyPath = agentBrowserCommandStatePath(homeDir, session);
    try {
      const legacy = normalizeAgentBrowserCommandState(
        JSON.parse(readFileSync(legacyPath, "utf8")) as Partial<AgentBrowserCommandState>
      );
      if (legacy?.commandId === commandId) {
        rmSync(legacyPath, { force: true });
      }
    } catch {
      // No legacy state.
    }
    return true;
  }
  rmSync(agentBrowserCommandStatePath(homeDir, session), { force: true });
  rmSync(agentBrowserCommandStateDir(homeDir, session), { recursive: true, force: true });
  return true;
}

export async function waitForAgentBrowserCommandSettled(
  sessionInput: string,
  homeDir = os.homedir(),
  timeoutMs = 35_000
): Promise<boolean> {
  const session = safeAgentBrowserSessionName(sessionInput);
  if (!session || !readActiveAgentBrowserCommandStateSync(session, homeDir)) {
    return true;
  }

  const directory = agentBrowserCommandStateDir(homeDir, session);
  const rootDirectory = path.dirname(directory);
  mkdirSync(directory, { recursive: true });
  return new Promise<boolean>((resolve) => {
    const watchers: FSWatcher[] = [];
    let done = false;
    const finish = (settled: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // watcher may already be closed.
        }
      }
      resolve(settled);
    };
    const check = (): void => {
      if (!readActiveAgentBrowserCommandStateSync(session, homeDir)) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref?.();
    for (const watchPath of [directory, rootDirectory]) {
      try {
        const watcher = watch(watchPath, () => check());
        watcher.on("error", () => {
          // The timeout remains the conservative fallback if the native watch becomes unavailable.
        });
        watchers.push(watcher);
      } catch {
        // Keep the other watcher alive. The root watcher covers the legacy single-file wrapper.
      }
    }
    // Close the read→watch race: an exit between the first probe and watcher creation is observed here.
    check();
  });
}

// wrapper 需要在后续 snapshot/click 等未重复携带 --cdp 的命令里，恢复这个 Session
// 最近连接的端口并继续做 Profile 租约校验。这里故意不按 expiresAt 过滤：过期记录只用于
// 找回端口，真正能否继续由租约锁重新仲裁，不能因为活动记录过期就绕过排他检查。
export function readAgentBrowserSessionActivitySync(
  session: string,
  homeDir = os.homedir()
): AgentBrowserSessionActivity | null {
  const safeSession = safeAgentBrowserSessionName(session);
  if (!safeSession) {
    return null;
  }
  for (const filePath of agentBrowserSessionActivityPaths(homeDir, safeSession)) {
    try {
      const activity = normalizeAgentBrowserSessionActivity(
        JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentBrowserSessionActivity>
      );
      if (activity) {
        return activity;
      }
    } catch {
      // 尝试镜像路径。
    }
  }
  return null;
}

export async function readActiveAgentBrowserSessionActivityClientsByPort(
  ports: number[],
  homeDir = os.homedir(),
  now = Date.now()
): Promise<Map<number, CdpClientInfo[]>> {
  const result = new Map<number, CdpClientInfo[]>();
  const portSet = new Set(ports.filter(isValidTcpPort));
  if (!portSet.size) {
    return result;
  }

  const activityDir = path.join(homeDir, ".profilepilot", "agent-sessions");
  let names: string[] = [];
  try {
    names = await readdir(activityDir);
  } catch {
    return result;
  }

  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(activityDir, name);
        const activity = await readActiveAgentBrowserSessionActivity(filePath, now);
        if (!activity || !portSet.has(activity.cdpPort)) {
          if (activity === null) {
            await rm(filePath, { force: true }).catch(() => undefined);
          }
          return;
        }
        const client = clientFromAgentBrowserSessionActivity(activity);
        if (!client) {
          return;
        }
        const clients = result.get(activity.cdpPort) || [];
        clients.push(client);
        result.set(activity.cdpPort, clients);
      })
  );

  return result;
}

async function readActiveAgentBrowserSessionActivity(
  filePath: string,
  now: number
): Promise<AgentBrowserSessionActivity | null | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<AgentBrowserSessionActivity>;
    const activity = normalizeAgentBrowserSessionActivity(parsed);
    if (!activity) {
      return null;
    }
    const expiresAt = Date.parse(activity.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now ? activity : null;
  } catch {
    return undefined;
  }
}

function normalizeAgentBrowserSessionActivity(input: Partial<AgentBrowserSessionActivity>): AgentBrowserSessionActivity | null {
  if (!input || input.version !== 1) {
    return null;
  }
  const session = safeAgentBrowserSessionName(input.session);
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : "";
  const cdpPort = Number(input.cdpPort);
  const pid = Number(input.pid);
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : "";
  const expiresAt = typeof input.expiresAt === "string" ? input.expiresAt : "";
  if (!session || !command || !isValidTcpPort(cdpPort) || !Number.isSafeInteger(pid) || pid <= 0 || !updatedAt || !expiresAt) {
    return null;
  }
  const activity: AgentBrowserSessionActivity = {
    version: 1,
    session,
    command,
    cdpPort,
    pid,
    updatedAt,
    expiresAt
  };
  if (typeof input.cwd === "string" && input.cwd.trim()) {
    activity.cwd = input.cwd;
  }
  if (typeof input.project === "string" && input.project.trim()) {
    activity.project = input.project;
  }
  if (typeof input.agent === "string" && input.agent.trim()) {
    activity.agent = input.agent;
  }
  const daemonPid = Number(input.daemonPid);
  if (Number.isSafeInteger(daemonPid) && daemonPid > 0) {
    activity.daemonPid = daemonPid;
  }
  return activity;
}

function normalizeAgentBrowserCommandState(input: Partial<AgentBrowserCommandState>): AgentBrowserCommandState | null {
  const session = safeAgentBrowserSessionName(input.session);
  const commandId = typeof input.commandId === "string" && input.commandId ? input.commandId : "";
  const command = typeof input.command === "string" && input.command ? input.command : "";
  const wrapperPid = Number(input.wrapperPid);
  const startedAt = typeof input.startedAt === "string" ? input.startedAt : "";
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : "";
  const phase = input.phase === "draining" ? "draining" : input.phase === "running" ? "running" : null;
  if (input.version !== 1 || !session || !commandId || !command || !isValidPid(wrapperPid) || !startedAt || !updatedAt || !phase) {
    return null;
  }
  const state: AgentBrowserCommandState = {
    version: 1,
    commandId,
    session,
    command,
    wrapperPid,
    phase,
    startedAt,
    updatedAt
  };
  const childPid = Number(input.childPid);
  if (isValidPid(childPid)) state.childPid = childPid;
  const cdpPort = Number(input.cdpPort);
  if (isValidTcpPort(cdpPort)) state.cdpPort = cdpPort;
  return state;
}

function clientFromAgentBrowserSessionActivity(activity: AgentBrowserSessionActivity): CdpClientInfo | null {
  const pid = activity.daemonPid || activity.pid;
  const project = activity.project || (activity.cwd ? path.basename(activity.cwd) || activity.cwd : undefined);
  const agent = activity.agent || inferAgentFromSession(activity.session);
  return {
    pid,
    label: "agent-browser",
    agent,
    project,
    title: `agent-browser ${activity.command}`,
    session: activity.session,
    lastActive: activity.updatedAt,
    note: "ProfilePilot session 活动：最近一次 agent-browser 浏览器命令登记的会话租约，按 Session 保持可见化"
  };
}

function inferAgentFromSession(session: string): string | undefined {
  if (session.startsWith("cc-")) {
    return "Claude Code";
  }
  if (session.startsWith("cx-")) {
    return "Codex";
  }
  return undefined;
}

function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, filePath);
  try {
    unlinkSync(tempPath);
  } catch {
    // renameSync already moved it in the normal path.
  }
}

function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
