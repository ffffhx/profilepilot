#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentControlNotice } from "../shared/types";
import {
  clearAgentBrowserControlWaitStateSync,
  clearAgentBrowserCommandStateSync,
  readAgentBrowserDaemonPidSync,
  readAgentBrowserSessionActivitySync,
  writeAgentBrowserControlWaitStateSync,
  writeAgentBrowserCommandStateSync,
  writeAgentBrowserSessionActivitySync
} from "./agent-browser-session";
import {
  acquireAgentBrowserProfileLeaseSync,
  findConfiguredAgentBrowserProfileByPortSync,
  findAvailableAgentBrowserProfileCandidatesSync,
  findAgentBrowserProfileLeaseForSessionSync,
  releaseAgentBrowserProfileLeaseSync,
  releaseAgentBrowserProfileLeasesForSessionSync,
  resolveAgentBrowserProfileTargetSync,
  retireAgentBrowserSessionSync,
  retireReplacedAgentBrowserLeaseOwnerSync,
  setAgentBrowserProfileLeasesDelegatedSync,
  type AcquireAgentBrowserProfileLeaseResult,
  type AgentBrowserProfileLease
} from "./agent-browser-lease";
import {
  clearBrowserGatewayDaemonIdentity,
  ensureBrowserGatewayDaemon,
  readOrCreateBrowserGatewayDaemonIdentity,
  requestBrowserGateway,
  type GatewayControlResponse
} from "./browser-gateway-client";
import { waitForCdp, requestCdpVersionInfo } from "./cdp-client";
import { loadUnpackedExtensionsOverCdp } from "./cdp-page";
import { getDirectChromeCommand } from "./chrome-launch";
import { getMigratedExtensionLaunchPlan } from "./migrated-extension-launch";

const HARD_STOP_CODES = new Set(["AGENT_USER_IN_CONTROL", "AGENT_TASK_STOPPED"]);
const NOTICE_BYPASS_COMMANDS = new Set([
  "auth",
  "completion",
  "completions",
  "doctor",
  "help",
  "install",
  "session",
  "sessions",
  "skills",
  "upgrade",
  "version"
]);
const OPTIONS_WITH_VALUES = new Set([
  "--browser",
  "--browser-path",
  "--cdp",
  "--config",
  "--format",
  "--log-level",
  "--output",
  "--params",
  "--profile",
  "--profile-dir",
  "--reason",
  "--session",
  "--timeout",
  "--target",
  "--user-data-dir",
  "--viewport"
]);
const SAFE_SESSION_RE = /^[A-Za-z0-9._-]+$/;

export const PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE = 75;
export const PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE = 64;
export const PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE = 75;

interface AgentBrowserLeaseContext {
  cdpPort: number;
  session: string;
  acquisition: Extract<AcquireAgentBrowserProfileLeaseResult, { ok: true }>;
}

export interface ProfilePilotNoticeMatch {
  path: string;
  notice: AgentControlNotice;
}

export function sessionFromAgentBrowserArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      const value = args[index + 1];
      return safeSessionName(value);
    }
    if (arg.startsWith("--session=")) {
      return safeSessionName(arg.slice("--session=".length));
    }
  }
  return safeSessionName(env.AGENT_BROWSER_SESSION);
}

export function agentBrowserCommandName(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (!arg.includes("=") && OPTIONS_WITH_VALUES.has(option)) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

export function shouldCheckProfilePilotNotice(args: string[]): boolean {
  const command = agentBrowserCommandName(args);
  return Boolean(command && !NOTICE_BYPASS_COMMANDS.has(command));
}

export function cdpPortFromAgentBrowserArgs(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cdp") {
      return parseCdpPortValue(args[index + 1]);
    }
    if (arg.startsWith("--cdp=")) {
      return parseCdpPortValue(arg.slice("--cdp=".length));
    }
  }

  const positionals = positionalArgs(args);
  if (positionals[0] === "connect") {
    return parseCdpPortValue(positionals[1]);
  }
  return undefined;
}

export function profilePilotNoticePaths(homeDir: string, session: string): string[] {
  return [
    path.join(homeDir, ".agent-browser", `${session}.profilepilot-control.json`),
    path.join(homeDir, ".profilepilot", "agent-control", `${session}.json`)
  ];
}

export function clearProfilePilotNoticesForSession(
  session: string,
  homeDir = os.homedir(),
  onlyReason?: AgentControlNotice["reason"]
): string[] {
  const safeSession = safeSessionName(session);
  if (!safeSession) {
    return [];
  }
  const paths = profilePilotNoticePaths(homeDir, safeSession);
  const cleared: string[] = [];
  for (const filePath of paths) {
    if (onlyReason) {
      try {
        const notice = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
        if (notice.reason !== onlyReason) {
          continue;
        }
      } catch {
        continue;
      }
    }
    rmSync(filePath, { force: true });
    cleared.push(filePath);
  }
  return cleared;
}

export function findActiveProfilePilotNotice(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): ProfilePilotNoticeMatch | null {
  if (!shouldCheckProfilePilotNotice(args)) {
    return null;
  }
  const session = sessionFromAgentBrowserArgs(args, env);
  if (!session) {
    return null;
  }
  const homeDir = env.HOME || os.homedir();
  for (const filePath of profilePilotNoticePaths(homeDir, session)) {
    const notice = readActiveNotice(filePath, now);
    if (notice) {
      return { path: filePath, notice };
    }
  }
  return null;
}

export function formatHardStopNotice(match: ProfilePilotNoticeMatch): string {
  const notice = match.notice;
  return `${JSON.stringify(
    {
      source: "ProfilePilot",
      error_code: notice.code,
      hard_stop: true,
      reason: notice.reason,
      ownership: notice.ownership,
      message: notice.message,
      action: notice.action,
      profile_id: notice.profileId,
      profile_name: notice.profileName,
      session: notice.session,
      session_title: notice.sessionTitle,
      agent: notice.agent,
      notice_path: match.path,
      expires_at: notice.expiresAt
    },
    null,
    2
  )}\n`;
}

export function consumeProfilePilotReturnNotice(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): ProfilePilotNoticeMatch | null {
  if (!shouldCheckProfilePilotNotice(args)) {
    return null;
  }
  const session = sessionFromAgentBrowserArgs(args, env);
  if (!session) {
    return null;
  }
  const homeDir = env.HOME || os.homedir();
  const paths = profilePilotNoticePaths(homeDir, session);
  for (const filePath of paths) {
    const notice = readActiveReturnNotice(filePath, now);
    if (!notice) {
      continue;
    }
    for (const candidate of paths) {
      rmSync(candidate, { force: true });
    }
    return { path: filePath, notice };
  }
  return null;
}

export function formatControlReturnedNotice(match: ProfilePilotNoticeMatch): string {
  const notice = match.notice;
  return `${JSON.stringify(
    {
      source: "ProfilePilot",
      event_code: notice.code,
      hard_stop: false,
      reason: notice.reason,
      ownership: notice.ownership,
      message: notice.message,
      action: notice.action,
      profile_id: notice.profileId,
      profile_name: notice.profileName,
      session: notice.session,
      session_title: notice.sessionTitle,
      agent: notice.agent,
      notice_path: match.path,
      at: notice.at
    },
    null,
    2
  )}\n`;
}

export function resolveRealAgentBrowser(env: NodeJS.ProcessEnv = process.env, selfPath = process.argv[1] || ""): string | null {
  const explicit = env.PROFILEPILOT_AGENT_BROWSER_REAL;
  if (explicit && isExecutableFile(explicit)) {
    return explicit;
  }

  let output = "";
  try {
    output = execFileSync("which", ["-a", "agent-browser"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    output = "";
  }

  const self = realpathOrInput(selfPath);
  const managedLauncher = realpathOrInput(
    env.PROFILEPILOT_AGENT_BROWSER_LAUNCHER || path.join(env.HOME || os.homedir(), ".profilepilot", "bin", "agent-browser")
  );
  const seen = new Set<string>();
  for (const candidate of output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const real = realpathOrInput(candidate);
    if (seen.has(real) || real === self || real === managedLauncher) {
      continue;
    }
    seen.add(real);
    if (path.basename(candidate) === "agent-browser" && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  // npx 安装的 agent-browser 外层是 Node 脚本，但包内带与平台匹配的原生 CLI。
  // ProfilePilot 的 shell wrapper 本身可由 Electron 的 Node runtime 启动，因此这里直接
  // 找原生 CLI，避免用户还必须全局安装一份 node/npm 才能让控制协议生效。
  for (const candidate of cachedNativeAgentBrowserCandidates(env.HOME || os.homedir())) {
    const real = realpathOrInput(candidate);
    if (real !== self && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function cachedNativeAgentBrowserCandidates(homeDir: string): string[] {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === "win32"
    ? `agent-browser-${platform}-${arch}.exe`
    : `agent-browser-${platform}-${arch}`;
  const roots = [
    path.join(homeDir, ".npm", "_npx"),
    path.join(homeDir, ".npm", "_cacache", "tmp"),
    path.join(homeDir, ".cache", "npm", "_npx")
  ];
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(root, name, "node_modules", "agent-browser", "bin", binaryName);
      try {
        candidates.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
      } catch {
        // Not an agent-browser npx cache entry.
      }
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).map((candidate) => candidate.path);
}

export async function runAgentBrowserWrapper(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const internalExitCode = await runProfilePilotInternalCommand(args, env);
  if (internalExitCode !== null) {
    return internalExitCode;
  }

  emitControlReturnedNotice(args, env);
  const before = findActiveProfilePilotNotice(args, env);
  if (before) {
    process.stderr.write(formatHardStopNotice(before));
    return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
  }

  const lease = acquireProfileLeaseForCommand(args, env);
  if (lease && !lease.ok) {
    process.stderr.write(formatProfileLeaseConflict(lease.lease, sessionFromAgentBrowserArgs(args, env), args, env));
    return PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE;
  }
  const leaseContext = lease?.ok ? lease.context : null;
  if (leaseContext?.acquisition.replacedLease) {
    const retired = retireReplacedAgentBrowserLeaseOwnerSync(
      leaseContext.acquisition.replacedLease,
      env.HOME || os.homedir()
    );
    if (!retired) {
      releaseAgentBrowserProfileLeaseSync(
        leaseContext.cdpPort,
        leaseContext.session,
        env.HOME || os.homedir()
      );
      process.stderr.write(formatProfileLeaseReclaimFailure(leaseContext.acquisition.replacedLease, leaseContext.session));
      return PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE;
    }
  }

  const realAgentBrowser = resolveRealAgentBrowser(env);
  if (!realAgentBrowser) {
    releaseNewProfileLeaseAfterFailure(leaseContext, env);
    process.stderr.write("[ProfilePilot] 未找到真实 agent-browser 可执行文件。\n");
    return 127;
  }

  let realArgs = args;
  try {
    realArgs = await prepareGatewayTransport(realAgentBrowser, args, env, leaseContext?.cdpPort);
  } catch (error) {
    releaseNewProfileLeaseAfterFailure(leaseContext, env);
    process.stderr.write(formatGatewayFailure(error, args, env));
    return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
  }

  writeSessionActivityIfBrowserOperation(args, env, leaseContext?.cdpPort);
  const commandState = beginBrowserCommandState(args, env, leaseContext?.cdpPort);
  const result = await spawnRealAgentBrowser(realAgentBrowser, realArgs, env, commandState);
  if (commandState) {
    clearAgentBrowserCommandStateSync(commandState.session, commandState.commandId, commandState.homeDir);
  }
  const exitCode = typeof result.status === "number" ? result.status : result.signal ? 1 : 0;
  // 用户可能在真实命令执行期间点击接管。先检查 notice，再续租和登记活动；否则一个刚完成的
  // 成功命令会把 Profile 租约重新抢回来，而且 Agent 要到下一条命令才知道用户已接管。
  acknowledgeRequestedTakeover(args, env);
  emitControlReturnedNotice(args, env);
  const after = findActiveProfilePilotNotice(args, env);
  if (after) {
    process.stderr.write(formatHardStopNotice(after));
    return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
  }
  if (leaseContext && !result.error && exitCode === 0 && !result.signal) {
    renewProfileLeaseAfterSuccess(leaseContext, args, env);
  } else {
    releaseNewProfileLeaseAfterFailure(leaseContext, env);
  }
  writeSessionActivityIfBrowserOperation(args, env, leaseContext?.cdpPort);
  if (result.error) {
    process.stderr.write(`[ProfilePilot] 启动真实 agent-browser 失败：${result.error.message}\n`);
    return errorExitCode(result.error);
  }

  return exitCode;
}

interface BrowserCommandStateContext {
  commandId: string;
  session: string;
  command: string;
  cdpPort?: number;
  startedAt: string;
  homeDir: string;
}

interface SpawnedAgentBrowserResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error & { code?: string };
}

function beginBrowserCommandState(
  args: string[],
  env: NodeJS.ProcessEnv,
  resolvedCdpPort?: number
): BrowserCommandStateContext | null {
  if (!shouldCheckProfilePilotNotice(args)) {
    return null;
  }
  const session = sessionFromAgentBrowserArgs(args, env);
  const command = agentBrowserCommandName(args);
  if (!session || !command) {
    return null;
  }
  const context: BrowserCommandStateContext = {
    commandId: `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`,
    session,
    command,
    cdpPort: resolvedCdpPort || cdpPortFromAgentBrowserArgs(args),
    startedAt: new Date().toISOString(),
    homeDir: env.HOME || os.homedir()
  };
  writeAgentBrowserCommandStateSync({
    commandId: context.commandId,
    session,
    command,
    wrapperPid: process.pid,
    cdpPort: context.cdpPort,
    phase: "running",
    startedAt: context.startedAt
  }, context.homeDir);
  return context;
}

function spawnRealAgentBrowser(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  commandState: BrowserCommandStateContext | null
): Promise<SpawnedAgentBrowserResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SpawnedAgentBrowserResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(executable, args, { env, stdio: "inherit" });
    } catch (error) {
      finish({ status: null, signal: null, error: error as Error & { code?: string } });
      return;
    }
    if (commandState && typeof child.pid === "number" && child.pid > 0) {
      writeAgentBrowserCommandStateSync({
        commandId: commandState.commandId,
        session: commandState.session,
        command: commandState.command,
        wrapperPid: process.pid,
        childPid: child.pid,
        cdpPort: commandState.cdpPort,
        phase: "running",
        startedAt: commandState.startedAt
      }, commandState.homeDir);
    }
    child.once("error", (error) => {
      finish({ status: null, signal: null, error: error as Error & { code?: string } });
    });
    child.once("close", (status, signal) => {
      finish({ status, signal });
    });
  });
}

function emitControlReturnedNotice(args: string[], env: NodeJS.ProcessEnv): void {
  const returned = consumeProfilePilotReturnNotice(args, env);
  if (returned) {
    process.stderr.write(formatControlReturnedNotice(returned));
  }
}

export function formatProfileLeaseConflict(
  lease: AgentBrowserProfileLease,
  requestedSession?: string,
  originalArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): string {
  const homeDir = env.HOME || os.homedir();
  const candidates = findAvailableAgentBrowserProfileCandidatesSync({
    excludedPort: lease.cdpPort,
    requestedSession
  }, homeDir);
  const alternatives = candidates.slice(0, 5).map((candidate) => {
    const retryArgs = replaceCdpPortInAgentBrowserArgs(originalArgs, candidate.cdpPort);
    return {
      profile_id: candidate.profileId,
      profile_name: candidate.profileName,
      cdp_port: candidate.cdpPort,
      project_tag: candidate.projectTag || null,
      already_owned_by_session: candidate.alreadyOwnedBySession,
      requires_start: !candidate.running,
      retry_args: retryArgs,
      command: formatAgentBrowserCommand(retryArgs)
    };
  });
  const recommended = alternatives[0] || null;
  const action = recommended
    ? `停手：不要重试端口 ${lease.cdpPort}，也不要自动切换 Profile。先告知用户当前占用情况，并征得同意后再执行 recommended_command；该命令会${recommended.requires_start ? "让 Gateway 启动并连接" : "把原操作切到"}「${recommended.profile_name}」的 CDP ${recommended.cdp_port}。`
    : `停手：不要重试端口 ${lease.cdpPort}；当前没有空闲 Profile，请让用户启动或释放另一个 Profile。`;
  return `${JSON.stringify(
    {
      source: "ProfilePilot",
      error_code: "PROFILE_ALREADY_IN_USE",
      // 切换 Profile 会改变登录态和窗口，因此即使存在候选，也必须先停手征得用户同意。
      hard_stop: true,
      blocked_profile_hard_stop: true,
      retryable_with_alternative_profile: Boolean(recommended),
      requires_user_confirmation: Boolean(recommended),
      message: `${lease.profileName} 已被另一个 agent-browser Session 占用`,
      action,
      auto_switch_allowed: false,
      auto_switch_strategy: null,
      recommended_profile_id: recommended?.profile_id || null,
      recommended_profile_name: recommended?.profile_name || null,
      recommended_cdp_port: recommended?.cdp_port || null,
      recommended_command: recommended?.command || null,
      available_candidate_count: candidates.length,
      alternatives,
      profile_id: lease.profileId,
      profile_name: lease.profileName,
      cdp_port: lease.cdpPort,
      requested_session: requestedSession || null,
      owner_session: lease.session,
      owner_agent: lease.agent || null,
      owner_project: lease.project || null,
      acquired_at: lease.acquiredAt,
      updated_at: lease.updatedAt,
      expires_at: lease.expiresAt
    },
    null,
    2
  )}\n`;
}

export function replaceCdpPortInAgentBrowserArgs(args: string[], cdpPort: number): string[] {
  const next = [...args];
  for (let index = 0; index < next.length; index += 1) {
    const arg = next[index];
    if (arg === "--cdp") {
      if (index + 1 < next.length) {
        next[index + 1] = String(cdpPort);
      } else {
        next.push(String(cdpPort));
      }
      return next;
    }
    if (arg.startsWith("--cdp=")) {
      next[index] = `--cdp=${cdpPort}`;
      return next;
    }
  }
  const positionals = positionalArgIndices(next);
  if (positionals.length >= 2 && next[positionals[0]] === "connect") {
    next[positionals[1]] = String(cdpPort);
    return next;
  }
  return ["--cdp", String(cdpPort), ...next];
}

function formatAgentBrowserCommand(args: string[]): string {
  return ["agent-browser", ...args].map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatProfileLeaseReclaimFailure(lease: AgentBrowserProfileLease, requestedSession: string): string {
  return `${JSON.stringify(
    {
      source: "ProfilePilot",
      error_code: "PROFILE_LEASE_RECLAIM_FAILED",
      hard_stop: true,
      message: `${lease.profileName} 的旧 agent-browser daemon 无法安全结束`,
      action: "停手：请在 ProfilePilot 中手动结束旧连接，再重试当前命令。",
      profile_id: lease.profileId,
      profile_name: lease.profileName,
      cdp_port: lease.cdpPort,
      requested_session: requestedSession,
      owner_session: lease.session
    },
    null,
    2
  )}\n`;
}

function acquireProfileLeaseForCommand(
  args: string[],
  env: NodeJS.ProcessEnv
): { ok: true; context: AgentBrowserLeaseContext } | { ok: false; lease: AgentBrowserProfileLease } | null {
  if (!shouldCheckProfilePilotNotice(args)) {
    return null;
  }
  const session = sessionFromAgentBrowserArgs(args, env);
  if (!session) {
    return null;
  }
  const homeDir = env.HOME || os.homedir();
  const existingLease = findAgentBrowserProfileLeaseForSessionSync(session, homeDir);
  const activity = readAgentBrowserSessionActivitySync(session, homeDir);
  const cdpPort = cdpPortFromAgentBrowserArgs(args) || existingLease?.cdpPort || activity?.cdpPort;
  const command = agentBrowserCommandName(args);
  if (!cdpPort || !command) {
    return null;
  }
  const target = resolveAgentBrowserProfileTargetSync(cdpPort, env, homeDir);
  const acquisition = acquireAgentBrowserProfileLeaseSync({
    cdpPort,
    session,
    holderPid: process.pid,
    daemonPid: readAgentBrowserDaemonPidSync(homeDir, session),
    profileId: target.profileId,
    profileName: target.profileName,
    agent: inferAgentFromSession(session),
    project: projectFromEnv(env),
    command
  }, homeDir);
  if (!acquisition.ok) {
    return { ok: false, lease: acquisition.lease };
  }
  return { ok: true, context: { cdpPort, session, acquisition } };
}

function renewProfileLeaseAfterSuccess(
  context: AgentBrowserLeaseContext,
  args: string[],
  env: NodeJS.ProcessEnv
): void {
  const homeDir = env.HOME || os.homedir();
  const target = resolveAgentBrowserProfileTargetSync(context.cdpPort, env, homeDir);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: context.cdpPort,
    session: context.session,
    holderPid: process.pid,
    daemonPid: readAgentBrowserDaemonPidSync(homeDir, context.session),
    profileId: target.profileId,
    profileName: target.profileName,
    agent: inferAgentFromSession(context.session),
    project: projectFromEnv(env),
    command: agentBrowserCommandName(args)
  }, homeDir);
  // agent-browser 一个命名 Session 只持有一个 daemon；成功切到新端口后释放该 Session
  // 在旧 Profile 上的租约，避免顺序切换 Profile 后留下无主锁。
  releaseAgentBrowserProfileLeasesForSessionSync(context.session, homeDir, context.cdpPort);
}

function releaseNewProfileLeaseAfterFailure(context: AgentBrowserLeaseContext | null, env: NodeJS.ProcessEnv): void {
  if (!context || context.acquisition.status === "renewed") {
    return;
  }
  releaseAgentBrowserProfileLeaseSync(context.cdpPort, context.session, env.HOME || os.homedir());
}

async function runProfilePilotInternalCommand(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<number | null> {
  const positionals = positionalArgs(args);
  if (positionals[0] !== "profilepilot") {
    return null;
  }
  const action = positionals[1];
  if (action !== "handoff" && action !== "wait-control" && action !== "complete" && action !== "resume" && action !== "release" && action !== "status" && action !== "cdp") {
    process.stderr.write("[ProfilePilot] 用法：agent-browser profilepilot <status|handoff|wait-control|complete|resume|release|cdp>\n");
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }

  const session = sessionFromAgentBrowserArgs(args, env);
  if (!session) {
    process.stderr.write(`[ProfilePilot] 找不到 AGENT_BROWSER_SESSION，无法执行 ${action}。\n`);
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }
  const homeDir = env.HOME || os.homedir();
  if (action === "cdp") {
    return runGatewayRawCdp(args, session, env, homeDir);
  }
  if (action === "status") {
    try {
      const response = await requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 3_000 });
      const profile = gatewayProfiles(response).find((candidate) => candidate.ownerSessionId === session) || null;
      process.stdout.write(`${JSON.stringify({
        source: "ProfilePilot Gateway",
        ok: true,
        gateway_pid: response.pid || null,
        session,
        profile
      }, null, 2)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(formatGatewayFailure(error, args, env));
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
  }
  if (action === "wait-control") {
    return waitForProfilePilotControl(session, homeDir, waitTimeoutFromArgs(args));
  }
  if (action === "release") {
    const daemonPid = readAgentBrowserDaemonPidSync(homeDir, session);
    const retired = retireAgentBrowserSessionSync(session, daemonPid, homeDir);
    if (!retired) {
      process.stderr.write(`[ProfilePilot] 无法安全结束 Session ${session} 的 agent-browser daemon。\n`);
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
    const releasedPorts = releaseAgentBrowserProfileLeasesForSessionSync(session, homeDir);
    const clearedNotices = clearProfilePilotNoticesForSession(session, homeDir);
    clearAgentBrowserControlWaitStateSync(session, undefined, homeDir);
    clearAgentBrowserCommandStateSync(session, undefined, homeDir);
    await controlGatewaySessionIfManaged(session, "stop", homeDir);
    clearBrowserGatewayDaemonIdentity(session, homeDir);
    process.stdout.write(`${JSON.stringify({
      source: "ProfilePilot",
      ok: true,
      action: "release",
      ownership: "user",
      session,
      daemonPid: daemonPid || null,
      releasedPorts,
      clearedNotices,
      message: "Agent Session 已关闭，浏览器控制权已交还用户"
    }, null, 2)}\n`);
    return 0;
  }

  const handoffReason = action === "handoff"
    ? normalizedHandoffReason(optionValue(args, "--reason"))
    : undefined;
  if (action === "handoff" && !handoffReason) {
    process.stderr.write("[ProfilePilot] handoff 必须通过 --reason 说明等待用户完成的操作。\n");
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }

  const context = resolveProfilePilotControlContext(session, env, homeDir);
  if (!context) {
    process.stderr.write(`[ProfilePilot] 找不到 Session ${session} 对应的 Profile，无法执行 ${action}。\n`);
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }

  if (action === "handoff") {
    const pendingUserAction = handoffReason as string;
    if (!await isGatewaySessionManaged(session, homeDir)) {
      process.stderr.write(`${JSON.stringify({
        source: "ProfilePilot",
        error_code: "GATEWAY_PROFILE_NOT_FOUND",
        hard_stop: true,
        session,
        message: "当前 Session 没有受 ProfilePilot Gateway 管理的 Profile，无法安全交给用户",
        action: "停止浏览器操作并检查 agent-browser profilepilot status；不要用 complete 代替 handoff"
      }, null, 2)}\n`);
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
    const requested = makeWrapperHandoffNotice(
      context,
      pendingUserAction,
      nextControlVersion(session, homeDir),
      "requested"
    );
    writeProfilePilotControlNoticeSync(session, requested, homeDir);
    try {
      await controlGatewaySessionIfManaged(session, "takeover", homeDir, pendingUserAction);
      setAgentBrowserProfileLeasesDelegatedSync(session, true, homeDir);
      const quiesced = makeWrapperHandoffNotice(
        context,
        pendingUserAction,
        requested.controlVersion + 1,
        "quiesced"
      );
      writeProfilePilotControlNoticeSync(session, quiesced, homeDir);
      process.stdout.write(`${JSON.stringify({
        source: "ProfilePilot",
        ok: true,
        action: "handoff",
        ownership: "user",
        session,
        profile_id: context.profileId,
        profile_name: context.profileName,
        pending_user_action: pendingUserAction,
        control_version: quiesced.controlVersion,
        message: "浏览器控制权已交给用户；Agent Session 和 Profile 租约继续保留"
      }, null, 2)}\n`);
      return 0;
    } catch (error) {
      setAgentBrowserProfileLeasesDelegatedSync(session, false, homeDir);
      clearProfilePilotNoticesForSession(session, homeDir);
      throw error;
    }
  }

  if (action === "complete") {
    const gatewayProfile = await gatewaySessionProfile(session, homeDir);
    const pendingNotice = readAnyProfilePilotControlNotice(session, homeDir);
    const pendingUserAction = normalizedHandoffReason(
      pendingNotice?.reason === "user_takeover" ? pendingNotice.pendingUserAction : undefined
    ) || normalizedHandoffReason(
      typeof gatewayProfile?.pendingUserAction === "string" ? gatewayProfile.pendingUserAction : undefined
    );
    const userStillHasControl = gatewayProfile?.sessionStatus === "active" && gatewayProfile.ownership === "user";
    if (pendingNotice?.reason === "user_takeover" || pendingUserAction || userStillHasControl) {
      process.stderr.write(`${JSON.stringify({
        source: "ProfilePilot",
        error_code: "PROFILEPILOT_PENDING_USER_ACTION",
        hard_stop: true,
        session,
        profile_id: context.profileId,
        profile_name: context.profileName,
        pending_user_action: pendingUserAction || "用户正在操作浏览器",
        message: "任务仍在等待用户操作，不能 complete 并释放 Session",
        action: "保留当前 Session；用户完成后执行 resume 并重新 snapshot。只有用户明确放弃任务时才执行 release"
      }, null, 2)}\n`);
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
    const gatewayManaged = Boolean(gatewayProfile);
    if (gatewayManaged) {
      const requested = makeWrapperControlNotice(
        context,
        "agent_complete",
        nextControlVersion(session, homeDir),
        "requested"
      );
      writeProfilePilotControlNoticeSync(session, requested, homeDir);
    }
    await controlGatewaySessionIfManaged(session, "complete", homeDir);
    // 兼容仍在持有 Chrome pipe 的旧 Gateway：旧版本把 complete 当成临时接管，
    // 再发 stop 才能真正清掉 owner。新 Gateway 已在 complete 时停止，此调用会安全跳过。
    await controlGatewaySessionIfManaged(session, "stop", homeDir);
    const daemonPid = readAgentBrowserDaemonPidSync(homeDir, session);
    const retired = retireAgentBrowserSessionSync(session, daemonPid, homeDir);
    const releasedPorts = releaseAgentBrowserProfileLeasesForSessionSync(session, homeDir);
    const clearedNotices = clearProfilePilotNoticesForSession(session, homeDir);
    clearAgentBrowserControlWaitStateSync(session, undefined, homeDir);
    clearAgentBrowserCommandStateSync(session, undefined, homeDir);
    clearBrowserGatewayDaemonIdentity(session, homeDir);
    if (!retired) {
      process.stderr.write(`[ProfilePilot] Session ${session} 已从 Gateway 和 Profile 租约释放，但残留 agent-browser daemon 无法安全结束。\n`);
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
    process.stdout.write(`${JSON.stringify({
      source: "ProfilePilot",
      ok: true,
      action: "complete",
      ownership: "user",
      session,
      profile_id: context.profileId,
      profile_name: context.profileName,
      daemon_pid: daemonPid || null,
      released_ports: releasedPorts,
      cleared_notices: clearedNotices,
      message: "Agent 已完成当前任务，Session 和 Profile 租约已释放"
    }, null, 2)}\n`);
    return 0;
  }

  // resume 只允许由一次显式的“继续/交还 Agent”触发。先重新启用 Input Guard 所依赖的
  // 排它租约，再发布返回事件，防止事件先到而用户仍有一小段可点击窗口。
  setAgentBrowserProfileLeasesDelegatedSync(session, false, homeDir);
  try {
    await controlGatewaySessionIfManaged(session, "return", homeDir);
    const notice = makeWrapperControlNotice(context, "user_return", nextControlVersion(session, homeDir));
    writeProfilePilotControlNoticeSync(session, notice, homeDir);
    process.stdout.write(`${JSON.stringify({
      source: "ProfilePilot",
      ok: true,
      action: "resume",
      ownership: notice.ownership,
      session,
      profile_id: notice.profileId,
      profile_name: notice.profileName,
      control_version: notice.controlVersion,
      message: notice.message
    }, null, 2)}\n`);
  } catch (error) {
    setAgentBrowserProfileLeasesDelegatedSync(session, true, homeDir);
    await controlGatewaySessionIfManaged(session, "takeover", homeDir).catch(() => undefined);
    throw error;
  }
  return 0;
}

export async function prepareGatewayTransport(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  resolvedCdpPort?: number
): Promise<string[]> {
  if (!shouldCheckProfilePilotNotice(args)) return args;
  const sessionId = sessionFromAgentBrowserArgs(args, env);
  const publicPort = resolvedCdpPort || cdpPortFromAgentBrowserArgs(args);
  if (!sessionId || !publicPort) return args;
  const homeDir = env.HOME || os.homedir();
  let status: GatewayControlResponse | null = null;
  try {
    status = await requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 800 });
  } catch (error) {
    if (persistedGatewayOwnsPort(homeDir, publicPort)) throw error;
    const configured = findConfiguredAgentBrowserProfileByPortSync(publicPort, env, homeDir);
    if (!configured) {
      if (await isReachableLegacyCdp(publicPort, homeDir)) return args;
      throw gatewayWrapperError(
        "GATEWAY_PROFILE_NOT_CONFIGURED",
        `ProfilePilot 没有找到绑定到端口 ${publicPort} 的 Profile`
      );
    }
    await ensureBrowserGatewayDaemon({ homeDir });
    status = await requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 800 });
  }
  const initiallyActivePorts = Array.isArray(status.ports) ? status.ports.map(Number) : [];
  if (
    !initiallyActivePorts.includes(publicPort) &&
    !findConfiguredAgentBrowserProfileByPortSync(publicPort, env, homeDir) &&
    await isReachableLegacyCdp(publicPort, homeDir)
  ) {
    return args;
  }
  assertSessionIsNotBoundToAnotherGatewayProfile(status, sessionId, publicPort);
  status = await ensureConfiguredGatewayProfileRunning(publicPort, status, env, homeDir);
  const profiles = gatewayProfiles(status);
  const activePorts = Array.isArray(status.ports) ? status.ports.map(Number) : [];
  if (!activePorts.includes(publicPort)) {
    throw gatewayWrapperError("GATEWAY_PROFILE_NOT_RUNNING", `Gateway 管理的 Profile ${publicPort} 当前未启动`);
  }
  if (!profiles.some((profile) => Number(profile.publicPort) === publicPort)) {
    throw gatewayWrapperError("GATEWAY_PROFILE_NOT_RUNNING", `Gateway 端口 ${publicPort} 缺少有效 Profile 绑定`);
  }

  const daemonInstanceId = readOrCreateBrowserGatewayDaemonIdentity(sessionId, homeDir);
  const acquire = await requestBrowserGateway({
    action: "acquire",
    publicPort,
    sessionId,
    daemonInstanceId,
    daemonPid: readAgentBrowserDaemonPidSync(homeDir, sessionId),
    agent: inferAgentFromSession(sessionId),
    project: projectFromEnv(env)
  }, { homeDir, timeoutMs: 3_000 });
  const webSocketUrl = typeof acquire.webSocketUrl === "string" ? acquire.webSocketUrl : "";
  if (!webSocketUrl) throw gatewayWrapperError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回 WebSocket Ticket");
  const command = agentBrowserCommandName(args);
  if (command === "connect") {
    return replaceConnectTarget(stripCdpOption(args), webSocketUrl);
  }
  if (acquire.connectionActive !== true) {
    const connected = await spawnRealAgentBrowser(executable, ["--session", sessionId, "connect", webSocketUrl], env, null);
    if (connected.error || connected.signal || connected.status !== 0) {
      // Parallel commands may both observe an initially disconnected daemon. If the other
      // command won the connect race, the failed duplicate connect is harmless.
      const retry = await requestBrowserGateway({
        action: "acquire",
        publicPort,
        sessionId,
        daemonInstanceId,
        daemonPid: readAgentBrowserDaemonPidSync(homeDir, sessionId),
        agent: inferAgentFromSession(sessionId),
        project: projectFromEnv(env)
      }, { homeDir, timeoutMs: 3_000 });
      if (retry.connectionActive !== true) {
        throw connected.error || gatewayWrapperError(
          "GATEWAY_CONNECT_FAILED",
          `agent-browser 无法连接 Gateway（退出码 ${connected.status ?? "unknown"}）`
        );
      }
    }
    // The first acquire happens before agent-browser has created its daemon PID file.
    // Confirm the live connection once more so Gateway becomes the complete source of
    // truth for both connectionActive and daemonPid; otherwise the UI must (correctly)
    // refuse to infer a real Agent from a lease alone.
    const confirmed = await requestBrowserGateway({
      action: "acquire",
      publicPort,
      sessionId,
      daemonInstanceId,
      daemonPid: readAgentBrowserDaemonPidSync(homeDir, sessionId),
      agent: inferAgentFromSession(sessionId),
      project: projectFromEnv(env)
    }, { homeDir, timeoutMs: 3_000 });
    if (confirmed.connectionActive !== true) {
      throw gatewayWrapperError("GATEWAY_CONNECT_FAILED", "agent-browser daemon 已启动，但 Gateway 未观察到有效连接");
    }
  }
  return stripCdpOption(args);
}

function assertSessionIsNotBoundToAnotherGatewayProfile(
  status: GatewayControlResponse,
  sessionId: string,
  requestedPort: number
): void {
  const binding = gatewayProfiles(status).find(
    (profile) => profile.ownerSessionId === sessionId && Number(profile.publicPort) !== requestedPort
  );
  if (!binding) return;
  const boundPort = Number(binding.publicPort);
  throw gatewayWrapperError(
    "SESSION_ALREADY_BOUND",
    `当前 Session 已绑定端口 ${Number.isSafeInteger(boundPort) ? boundPort : "unknown"}，不能同时驱动端口 ${requestedPort}`
  );
}

export async function ensureConfiguredGatewayProfileRunning(
  publicPort: number,
  status: GatewayControlResponse,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME || os.homedir()
): Promise<GatewayControlResponse> {
  const activePorts = Array.isArray(status.ports) ? status.ports.map(Number) : [];
  if (activePorts.includes(publicPort)) return status;

  const configured = findConfiguredAgentBrowserProfileByPortSync(publicPort, env, homeDir);
  if (!configured) {
    const managedPorts = Array.isArray(status.managedPorts) ? status.managedPorts.map(Number) : [];
    if (managedPorts.includes(publicPort)) {
      throw gatewayWrapperError("GATEWAY_PROFILE_NOT_RUNNING", `Gateway 管理的 Profile ${publicPort} 当前未启动`);
    }
    throw gatewayWrapperError(
      "GATEWAY_PROFILE_NOT_CONFIGURED",
      `ProfilePilot 没有找到绑定到端口 ${publicPort} 的 Profile`
    );
  }

  const executable = getDirectChromeCommand(env);
  if (!executable) {
    throw gatewayWrapperError("CHROME_NOT_FOUND", "找不到可供 Gateway 启动的 Chrome 二进制");
  }
  mkdirSync(configured.userDataDir, { recursive: true });
  const launchPlan = await getMigratedExtensionLaunchPlan(configured.profile);
  await requestBrowserGateway({
    action: "launch-profile",
    profileId: configured.profileId,
    profileName: configured.profileName,
    publicPort,
    executable,
    args: [
      `--user-data-dir=${configured.userDataDir}`,
      "--no-first-run",
      ...launchPlan.launchArgs
    ]
  }, { homeDir, timeoutMs: 8_000 });
  await waitForCdp(publicPort, 6_000, homeDir);
  if (launchPlan.runtimeLoadPaths.length) {
    await loadUnpackedExtensionsOverCdp(publicPort, launchPlan.runtimeLoadPaths, homeDir);
  }
  return requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 1_500 });
}

async function isReachableLegacyCdp(publicPort: number, homeDir: string): Promise<boolean> {
  try {
    await requestCdpVersionInfo(publicPort, homeDir);
    return true;
  } catch {
    return false;
  }
}

function stripCdpOption(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cdp") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cdp=")) continue;
    next.push(arg);
  }
  return next;
}

function replaceConnectTarget(args: string[], webSocketUrl: string): string[] {
  const next = [...args];
  const indices = positionalArgIndices(next);
  if (indices.length >= 2 && next[indices[0]] === "connect") {
    next[indices[1]] = webSocketUrl;
    return next;
  }
  return ["connect", webSocketUrl];
}

async function controlGatewaySessionIfManaged(
  sessionId: string,
  command: "takeover" | "complete" | "return" | "stop",
  homeDir: string,
  pendingUserAction?: string
): Promise<boolean> {
  if (!await isGatewaySessionManaged(sessionId, homeDir)) return false;
  await requestBrowserGateway({
    action: "control",
    sessionId,
    command,
    ...(pendingUserAction ? { pendingUserAction } : {})
  }, { homeDir, timeoutMs: 3_000 });
  return true;
}

async function isGatewaySessionManaged(sessionId: string, homeDir: string): Promise<boolean> {
  return Boolean(await gatewaySessionProfile(sessionId, homeDir));
}

async function gatewaySessionProfile(
  sessionId: string,
  homeDir: string
): Promise<Record<string, unknown> | null> {
  let status: GatewayControlResponse;
  try {
    status = await requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 800 });
  } catch (error) {
    if (persistedGatewayOwnsSession(homeDir, sessionId)) throw error;
    return null;
  }
  return gatewayProfiles(status).find((profile) => profile.ownerSessionId === sessionId) || null;
}

async function runGatewayRawCdp(
  args: string[],
  sessionId: string,
  env: NodeJS.ProcessEnv,
  homeDir: string
): Promise<number> {
  const positionals = positionalArgs(args);
  if (positionals[2] === "capabilities") {
    process.stdout.write(`${JSON.stringify({
      source: "ProfilePilot Gateway",
      ok: true,
      command: "agent-browser profilepilot cdp call <Method> [--target <targetId>] [--params '<JSON>' | --params-stdin]",
      allowed_domains: ["DOM", "Emulation", "Input", "Page", "Runtime", "Target", "Network"],
      target_scoped_methods: "未传 --target 时自动选择当前 page 并临时 attach",
      denied_examples: ["Browser.close", "Network.getAllCookies", "Storage.clearDataForOrigin", "Target.closeTarget"]
    }, null, 2)}\n`);
    return 0;
  }
  if (positionals[2] !== "call" || !positionals[3]) {
    process.stderr.write("[ProfilePilot] 用法：agent-browser profilepilot cdp call <Method> [--target <targetId>] [--params '<JSON>' | --params-stdin]\n");
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }
  const context = resolveProfilePilotControlContext(sessionId, env, homeDir);
  if (!context?.cdpPort) {
    process.stderr.write(`[ProfilePilot] 找不到 Session ${sessionId} 对应的 Gateway Profile。\n`);
    return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
  }
  let params: Record<string, unknown> = {};
  let paramsText = optionValue(args, "--params");
  if (!paramsText && args.includes("--params-stdin")) {
    try {
      paramsText = await readLimitedStdin();
    } catch (error) {
      process.stderr.write(formatGatewayFailure(error, args, env));
      return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
    }
  }
  if (paramsText) {
    try {
      const parsed = JSON.parse(paramsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("params must be an object");
      params = parsed as Record<string, unknown>;
    } catch (error) {
      process.stderr.write(`[ProfilePilot] --params 必须是 JSON 对象：${error instanceof Error ? error.message : String(error)}\n`);
      return PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE;
    }
  }
  try {
    const response = await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: context.cdpPort,
      sessionId,
      daemonInstanceId: readOrCreateBrowserGatewayDaemonIdentity(sessionId, homeDir),
      method: positionals[3],
      params,
      targetId: optionValue(args, "--target")
    }, { homeDir, timeoutMs: 20_000 });
    process.stdout.write(`${JSON.stringify({ source: "ProfilePilot Gateway", ok: true, method: positionals[3], result: response.result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(formatGatewayFailure(error, args, env));
    return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
  }
}

async function readLimitedStdin(maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (process.stdin.isTTY) {
    throw gatewayWrapperError("GATEWAY_STDIN_REQUIRED", "--params-stdin 需要从标准输入传入 JSON 对象");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw gatewayWrapperError("GATEWAY_PARAMS_TOO_LARGE", "Raw CDP 参数超过 4MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function optionValue(args: string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) return args[index + 1];
    if (args[index].startsWith(`${option}=`)) return args[index].slice(option.length + 1);
  }
  return undefined;
}

function gatewayProfiles(response: GatewayControlResponse): Array<Record<string, unknown>> {
  const state = response.state;
  if (!state || typeof state !== "object") return [];
  const profiles = (state as { profiles?: unknown }).profiles;
  return Array.isArray(profiles) ? profiles.filter((profile): profile is Record<string, unknown> => Boolean(profile && typeof profile === "object")) : [];
}

function persistedGatewayOwnsPort(homeDir: string, publicPort: number): boolean {
  return persistedGatewayProfiles(homeDir).some((profile) => Number(profile.publicPort) === publicPort);
}

function persistedGatewayOwnsSession(homeDir: string, sessionId: string): boolean {
  return persistedGatewayProfiles(homeDir).some((profile) => profile.ownerSessionId === sessionId);
}

function persistedGatewayProfiles(homeDir: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(homeDir, ".profilepilot", "gateway", "state.json"), "utf8"));
    return Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function gatewayWrapperError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function formatGatewayFailure(error: unknown, args: string[], env: NodeJS.ProcessEnv): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return `${JSON.stringify({
    source: "ProfilePilot Gateway",
    error_code: typeof candidate?.code === "string" ? candidate.code : "GATEWAY_ERROR",
    hard_stop: true,
    message: typeof candidate?.message === "string" ? candidate.message : String(error || "Gateway error"),
    session: sessionFromAgentBrowserArgs(args, env) || null,
    cdp_port: cdpPortFromAgentBrowserArgs(args) || null,
    action: "停手：不要绕过 Gateway 直连 Chrome CDP；先恢复 ProfilePilot Gateway 或交还控制权。"
  }, null, 2)}\n`;
}

interface ProfilePilotControlContext {
  session: string;
  cdpPort: number;
  profileId: string;
  profileName: string;
  pid: number;
  label: string;
  sessionTitle?: string;
  agent?: string;
}

function resolveProfilePilotControlContext(
  session: string,
  env: NodeJS.ProcessEnv,
  homeDir: string
): ProfilePilotControlContext | null {
  const existing = readAnyProfilePilotControlNotice(session, homeDir);
  const lease = findAgentBrowserProfileLeaseForSessionSync(session, homeDir);
  const activity = readAgentBrowserSessionActivitySync(session, homeDir);
  const cdpPort = lease?.cdpPort || activity?.cdpPort;
  if (!cdpPort && !existing) {
    return null;
  }
  const target = cdpPort ? resolveAgentBrowserProfileTargetSync(cdpPort, env, homeDir) : null;
  const pid = lease?.daemonPid || activity?.daemonPid || existing?.pid || lease?.holderPid || activity?.pid || process.pid;
  const project = lease?.project || activity?.project || existing?.sessionTitle;
  return {
    session,
    cdpPort: cdpPort || 0,
    profileId: lease?.profileId || existing?.profileId || target?.profileId || `cdp-${cdpPort}`,
    profileName: lease?.profileName || existing?.profileName || target?.profileName || `Chrome ${cdpPort}`,
    pid,
    label: existing?.label || `agent-browser (${session})`,
    sessionTitle: project,
    agent: lease?.agent || activity?.agent || existing?.agent || inferAgentFromSession(session)
  };
}

function makeWrapperControlNotice(
  context: ProfilePilotControlContext,
  reason: "agent_complete" | "user_return",
  controlVersion: number,
  handoffState: AgentControlNotice["handoffState"] = reason === "agent_complete" ? "quiesced" : undefined
): AgentControlNotice {
  const agentComplete = reason === "agent_complete";
  const notice: AgentControlNotice = {
    version: 1,
    controlVersion,
    code: agentComplete ? "AGENT_USER_IN_CONTROL" : "AGENT_CONTROL_RETURNED",
    reason,
    ownership: agentComplete ? "agentDelegatedToUser" : "agent",
    message: agentComplete
      ? "Agent 已完成当前任务，正在释放 Session 和 Profile"
      : "用户已将浏览器控制权交还 Agent",
    action: agentComplete
      ? "停手：当前任务已完成，ProfilePilot 正在关闭 Agent Session 并释放 Profile；不要重试或重新连接"
      : "控制权已恢复：重新 snapshot 后再继续，不要复用接管前的元素引用",
    hardStop: agentComplete,
    profileId: context.profileId,
    profileName: context.profileName,
    pid: context.pid,
    label: context.label,
    session: context.session,
    at: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z"
  };
  if (handoffState) {
    notice.handoffState = handoffState;
  }
  if (context.sessionTitle) {
    notice.sessionTitle = context.sessionTitle;
  }
  if (context.agent) {
    notice.agent = context.agent;
  }
  return notice;
}

function makeWrapperHandoffNotice(
  context: ProfilePilotControlContext,
  pendingUserAction: string,
  controlVersion: number,
  handoffState: NonNullable<AgentControlNotice["handoffState"]>
): AgentControlNotice {
  const notice: AgentControlNotice = {
    version: 1,
    controlVersion,
    code: "AGENT_USER_IN_CONTROL",
    reason: "user_takeover",
    ownership: "agentDelegatedToUser",
    handoffState,
    pendingUserAction,
    message: `等待用户完成：${pendingUserAction}`,
    action: "停手：Session 和 Profile 仍保留；等待用户明确完成后再 resume，重新 snapshot 后继续",
    hardStop: true,
    profileId: context.profileId,
    profileName: context.profileName,
    pid: context.pid,
    label: context.label,
    session: context.session,
    at: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z"
  };
  if (context.sessionTitle) notice.sessionTitle = context.sessionTitle;
  if (context.agent) notice.agent = context.agent;
  return notice;
}

function readAnyProfilePilotControlNotice(session: string, homeDir: string): AgentControlNotice | null {
  let newest: AgentControlNotice | null = null;
  for (const filePath of profilePilotNoticePaths(homeDir, session)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
      if (!parsed || parsed.version !== 1 || parsed.session !== session || typeof parsed.reason !== "string") {
        continue;
      }
      const notice = parsed as AgentControlNotice;
      const version = Number.isSafeInteger(notice.controlVersion) ? notice.controlVersion : 0;
      const newestVersion = newest && Number.isSafeInteger(newest.controlVersion) ? newest.controlVersion : 0;
      if (!newest || version >= newestVersion) {
        newest = notice;
      }
    } catch {
      // 尝试镜像路径。
    }
  }
  return newest;
}

function nextControlVersion(session: string, homeDir: string): number {
  const current = readAnyProfilePilotControlNotice(session, homeDir);
  const version = current && Number.isSafeInteger(current.controlVersion) ? current.controlVersion : 0;
  return Math.max(0, version) + 1;
}

function writeProfilePilotControlNoticeSync(
  session: string,
  notice: AgentControlNotice,
  homeDir: string
): void {
  for (const filePath of profilePilotNoticePaths(homeDir, session)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(notice, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, filePath);
  }
}

function acknowledgeRequestedTakeover(args: string[], env: NodeJS.ProcessEnv): void {
  const session = sessionFromAgentBrowserArgs(args, env);
  if (!session) return;
  const homeDir = env.HOME || os.homedir();
  const current = readAnyProfilePilotControlNotice(session, homeDir);
  if (
    !current ||
    current.reason !== "user_takeover" ||
    current.hardStop !== true ||
    current.handoffState !== "requested"
  ) {
    return;
  }
  const quiesced: AgentControlNotice = {
    ...current,
    controlVersion: Math.max(0, Number(current.controlVersion) || 0) + 1,
    handoffState: "quiesced",
    at: new Date().toISOString()
  };
  setAgentBrowserProfileLeasesDelegatedSync(session, true, homeDir);
  writeProfilePilotControlNoticeSync(session, quiesced, homeDir);
}

async function waitForProfilePilotControl(
  session: string,
  homeDir: string,
  timeoutMs?: number
): Promise<number> {
  const initial = consumeWaitableControlState(session, homeDir);
  if (initial !== null) {
    return initial;
  }

  const directories = [...new Set(profilePilotNoticePaths(homeDir, session).map((filePath) => path.dirname(filePath)))];
  directories.forEach((directory) => mkdirSync(directory, { recursive: true }));
  writeAgentBrowserControlWaitStateSync(session, process.pid, homeDir);
  try {
    return await new Promise<number>((resolve) => {
      const watchers = new Map<string, FSWatcher>();
      let timer: NodeJS.Timeout | null = null;
      let done = false;
      const finish = (code: number): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        for (const watcher of watchers.values()) {
          try {
            watcher.close();
          } catch {
            // watcher may already be closed.
          }
        }
        watchers.clear();
        resolve(code);
      };
      const check = (): void => {
        const code = consumeWaitableControlState(session, homeDir);
        if (code !== null) finish(code);
      };
      const armWatcher = (directory: string): void => {
        if (done || watchers.has(directory)) return;
        try {
          const watcher = watch(directory, (_event, filename) => {
            if (!filename || String(filename).includes(session)) check();
          });
          watchers.set(directory, watcher);
          watcher.once("error", () => {
            watchers.delete(directory);
            try {
              watcher.close();
            } catch {
              // The replacement watcher below becomes the new durable subscription.
            }
            if (!done) {
              check();
              setImmediate(() => armWatcher(directory));
            }
          });
        } catch {
          // 如果目录 watcher 短暂创建失败，重试计时器本身必须保活；否则两个目录都失败时
          // wait-control 会在没有任何活动句柄的情况下提前退出，留下“用户无法交还”的假等待。
          if (!done) setTimeout(() => armWatcher(directory), 250);
        }
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          process.stderr.write(`${JSON.stringify({
            source: "ProfilePilot",
            error_code: "PROFILEPILOT_CONTROL_WAIT_TIMEOUT",
            hard_stop: false,
            session,
            message: "等待用户交还浏览器控制权超时；控制状态未被改变"
          }, null, 2)}\n`);
          finish(124);
        }, timeoutMs);
        timer.unref?.();
      }
      directories.forEach(armWatcher);
      // Close the initial-read → waiter-state → watch-registration race.
      check();
    });
  } finally {
    clearAgentBrowserControlWaitStateSync(session, process.pid, homeDir);
  }
}

function consumeWaitableControlState(session: string, homeDir: string): number | null {
  const current = readAnyProfilePilotControlNotice(session, homeDir);
  if (!current) {
    process.stdout.write(`${JSON.stringify({
      source: "ProfilePilot",
      event_code: "AGENT_CONTROL_ALREADY_AVAILABLE",
      hard_stop: false,
      ownership: "agent",
      session,
      message: "Agent 已持有浏览器控制权"
    }, null, 2)}\n`);
    return 0;
  }
  if (current.reason === "user_return" && current.ownership === "agent" && current.hardStop === false) {
    clearProfilePilotNoticesForSession(session, homeDir);
    process.stdout.write(formatControlReturnedNotice({
      path: profilePilotNoticePaths(homeDir, session)[0],
      notice: current
    }));
    return 0;
  }
  if (current.reason === "user_stop" || current.reason === "user_disconnect") {
    process.stderr.write(formatHardStopNotice({
      path: profilePilotNoticePaths(homeDir, session)[0],
      notice: current
    }));
    return PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE;
  }
  return null;
}

function waitTimeoutFromArgs(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = arg === "--timeout" ? args[index + 1] : arg.startsWith("--timeout=") ? arg.slice(10) : undefined;
    if (value === undefined) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(24 * 60 * 60_000, Math.max(1_000, Math.round(seconds * 1_000)));
    }
  }
  // No business timeout: a user may keep control for hours. An explicit --timeout remains
  // available only for diagnostics and embedding environments that impose their own deadline.
  return undefined;
}

function writeSessionActivityIfBrowserOperation(args: string[], env: NodeJS.ProcessEnv, resolvedCdpPort?: number): void {
  if (!shouldCheckProfilePilotNotice(args)) {
    return;
  }
  const session = sessionFromAgentBrowserArgs(args, env);
  const cdpPort = resolvedCdpPort || cdpPortFromAgentBrowserArgs(args);
  const command = agentBrowserCommandName(args);
  if (!session || !cdpPort || !command) {
    return;
  }
  const homeDir = env.HOME || os.homedir();
  try {
    writeAgentBrowserSessionActivitySync({
      session,
      command,
      cdpPort,
      pid: process.pid,
      daemonPid: readAgentBrowserDaemonPidSync(homeDir, session),
      cwd: env.PWD || process.cwd()
    }, homeDir);
  } catch {
    // 租约只服务 ProfilePilot 的可见化；失败时不能影响 agent-browser 本身。
  }
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

function projectFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const cwd = typeof env.PWD === "string" && env.PWD.trim() ? env.PWD : "";
  return cwd ? path.basename(cwd) || cwd : undefined;
}

function readActiveNotice(filePath: string, now: number): AgentControlNotice | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
    if (!parsed || parsed.hardStop !== true || typeof parsed.code !== "string" || !HARD_STOP_CODES.has(parsed.code)) {
      return null;
    }
    // agent_complete 只在正在收敛/释放的短窗口内阻止并发命令；旧版本遗留的
    // quiesced 完成 notice 不能继续把已经释放的 Session 永久锁住。
    if (parsed.reason === "agent_complete" && parsed.handoffState !== "requested") {
      return null;
    }
    const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return null;
    }
    return parsed as AgentControlNotice;
  } catch {
    return null;
  }
}

function readActiveReturnNotice(filePath: string, now: number): AgentControlNotice | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
    if (
      !parsed ||
      parsed.code !== "AGENT_CONTROL_RETURNED" ||
      parsed.reason !== "user_return" ||
      parsed.ownership !== "agent" ||
      parsed.hardStop !== false
    ) {
      return null;
    }
    const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return null;
    }
    return parsed as AgentControlNotice;
  } catch {
    return null;
  }
}

function safeSessionName(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return SAFE_SESSION_RE.test(trimmed) ? trimmed : undefined;
}

function normalizedHandoffReason(value: string | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized ? normalized.slice(0, 240) : undefined;
}

function positionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (!arg.includes("=") && OPTIONS_WITH_VALUES.has(option)) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function positionalArgIndices(args: string[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      for (let rest = index + 1; rest < args.length; rest += 1) {
        indices.push(rest);
      }
      break;
    }
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (!arg.includes("=") && OPTIONS_WITH_VALUES.has(option)) {
        index += 1;
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      indices.push(index);
    }
  }
  return indices;
}

function parseCdpPortValue(value: string | undefined): number | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535) {
    return numeric;
  }
  try {
    const url = new URL(raw);
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpathOrInput(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function errorExitCode(error: Error & { code?: string }): number {
  return error.code === "ENOENT" ? 127 : 1;
}

if (require.main === module) {
  void runAgentBrowserWrapper().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ProfilePilot] agent-browser wrapper 执行失败：${message}\n`);
      process.exitCode = 1;
    }
  );
}
