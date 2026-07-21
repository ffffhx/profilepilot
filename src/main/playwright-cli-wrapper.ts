#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_GATEWAY_PROTOCOL_VERSION,
  clearBrowserGatewayDaemonIdentity,
  ensureBrowserGatewayDaemon,
  readOrCreateBrowserGatewayDaemonIdentity,
  requestBrowserGateway,
  type GatewayControlRequest,
  type GatewayControlResponse
} from "./browser-gateway-client";
import { findConfiguredAgentBrowserProfileByPortSync } from "./agent-browser-lease";
import { ensureConfiguredGatewayProfileRunning } from "./agent-browser-wrapper";

const SAFE_SESSION_RE = /^[A-Za-z0-9._:-]{1,240}$/;
const TERMINAL_COMMANDS = new Set(["close", "detach", "delete-data"]);
const GLOBAL_COMMANDS = new Set(["list", "close-all", "kill-all", "install", "install-browser"]);
const GATEWAY_TIMEOUT_MS = 3_000;

export const PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE = 75;
export const PROFILEPILOT_PLAYWRIGHT_CLI_USAGE_EXIT_CODE = 64;

export interface PlaywrightCliInvocation {
  command?: string;
  commandIndex?: number;
  explicitSession?: string;
  cdpEndpoint?: string;
  cdpPort?: number;
}

export interface PlaywrightCliCommand {
  executable: string;
}

export interface PlaywrightCliSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export interface PlaywrightCliSessionState {
  version: 1;
  playwrightSession: string;
  gatewaySessionId: string;
  publicPort: number;
  daemonInstanceId: string;
  daemonPid?: number;
  cwd: string;
  updatedAt: string;
}

interface GatewayProfileView {
  publicPort: number;
  ownerSessionId?: string;
  daemonInstanceId?: string;
  ownership?: "agent" | "user";
  sessionStatus?: "active" | "stopped";
  connectionActive?: boolean;
  profileId?: string;
  profileName?: string;
  pendingUserAction?: string;
}

interface PlaywrightCliRunOptions {
  cwd?: string;
  forwardOutput?: boolean;
}

type GatewayRequester = (
  request: GatewayControlRequest,
  options?: { homeDir?: string; timeoutMs?: number }
) => Promise<GatewayControlResponse>;

export interface PlaywrightCliWrapperDependencies {
  command?: PlaywrightCliCommand;
  request?: GatewayRequester;
  run?: (
    command: PlaywrightCliCommand,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: PlaywrightCliRunOptions
  ) => Promise<PlaywrightCliSpawnResult>;
  discoverDaemonPid?: (session: string, endpoint?: string) => number | undefined;
  ensureGatewayDaemon?: (options: { homeDir: string }) => Promise<GatewayControlResponse>;
  ensureProfileRunning?: (
    publicPort: number,
    status: GatewayControlResponse,
    env: NodeJS.ProcessEnv,
    homeDir: string
  ) => Promise<GatewayControlResponse>;
}

export function parsePlaywrightCliInvocation(args: string[]): PlaywrightCliInvocation {
  let command: string | undefined;
  let commandIndex: number | undefined;
  let explicitSession: string | undefined;
  let cdpEndpoint: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-s" || arg === "--s" || arg === "--session") {
      explicitSession = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("-s=") || arg.startsWith("--s=")) {
      explicitSession = arg.slice(arg.indexOf("=") + 1);
      continue;
    }
    if (arg.startsWith("--session=")) {
      explicitSession = arg.slice("--session=".length);
      continue;
    }
    if (arg === "--cdp") {
      cdpEndpoint = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--cdp=")) {
      cdpEndpoint = arg.slice("--cdp=".length);
      continue;
    }
    if (!command && arg !== "--" && !arg.startsWith("-")) {
      command = arg;
      commandIndex = index;
    }
  }

  return {
    command,
    commandIndex,
    explicitSession,
    cdpEndpoint,
    cdpPort: cdpEndpoint ? loopbackCdpPort(cdpEndpoint) : undefined
  };
}

export function sessionFromPlaywrightCliArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const invocation = parsePlaywrightCliInvocation(args);
  return safeSession(invocation.explicitSession) || safeSession(env.PLAYWRIGHT_CLI_SESSION);
}

export function defaultProfilePilotPlaywrightSession(cwd = process.cwd()): string {
  return `pw-${shortHash(path.resolve(cwd), 16)}`;
}

export function playwrightCliStateRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, ".profilepilot", "playwright-cli");
}

export function playwrightCliSessionStatePath(
  playwrightSession: string,
  cwd = process.cwd(),
  homeDir = os.homedir()
): string {
  const session = requiredSafeSession(playwrightSession, "Playwright Session");
  const workspace = shortHash(path.resolve(cwd), 16);
  const readable = session.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return path.join(playwrightCliStateRoot(homeDir), workspace, `${readable}-${shortHash(session, 8)}.json`);
}

export function readPlaywrightCliSessionState(
  playwrightSession: string,
  cwd = process.cwd(),
  homeDir = os.homedir()
): PlaywrightCliSessionState | null {
  const filePath = playwrightCliSessionStatePath(playwrightSession, cwd, homeDir);
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PlaywrightCliSessionState>;
    const gatewaySessionId = safeSession(parsed.gatewaySessionId);
    const publicPort = validPort(parsed.publicPort);
    const daemonInstanceId = safeSession(parsed.daemonInstanceId);
    if (
      parsed.version !== 1 ||
      parsed.playwrightSession !== playwrightSession ||
      !gatewaySessionId ||
      !publicPort ||
      !daemonInstanceId ||
      typeof parsed.cwd !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      playwrightSession,
      gatewaySessionId,
      publicPort,
      daemonInstanceId,
      ...(positivePid(parsed.daemonPid) ? { daemonPid: positivePid(parsed.daemonPid) as number } : {}),
      cwd: parsed.cwd,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export function writePlaywrightCliSessionState(
  state: PlaywrightCliSessionState,
  homeDir = os.homedir()
): string {
  const filePath = playwrightCliSessionStatePath(state.playwrightSession, state.cwd, homeDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
  return filePath;
}

export function clearPlaywrightCliSessionState(
  playwrightSession: string,
  cwd = process.cwd(),
  homeDir = os.homedir()
): void {
  rmSync(playwrightCliSessionStatePath(playwrightSession, cwd, homeDir), { force: true });
}

export function rewritePlaywrightCliAttachArgs(
  args: string[],
  playwrightSession: string,
  webSocketUrl: string
): string[] {
  requiredSafeSession(playwrightSession, "Playwright Session");
  if (!isWebSocketUrl(webSocketUrl)) {
    throw wrapperError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回有效的 WebSocket Ticket");
  }
  const rewritten = removeSessionOptions(args);
  let replaced = false;
  for (let index = 0; index < rewritten.length; index += 1) {
    const arg = rewritten[index];
    if (arg === "--cdp") {
      if (index + 1 < rewritten.length) rewritten[index + 1] = webSocketUrl;
      else rewritten.push(webSocketUrl);
      replaced = true;
      break;
    }
    if (arg.startsWith("--cdp=")) {
      rewritten[index] = `--cdp=${webSocketUrl}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) rewritten.push(`--cdp=${webSocketUrl}`);
  return [`-s=${playwrightSession}`, ...rewritten];
}

export function ensurePlaywrightCliSessionArg(args: string[], playwrightSession: string): string[] {
  requiredSafeSession(playwrightSession, "Playwright Session");
  return [`-s=${playwrightSession}`, ...removeSessionOptions(args)];
}

export function resolveRealPlaywrightCli(
  env: NodeJS.ProcessEnv = process.env,
  selfPath = process.argv[1] || ""
): PlaywrightCliCommand | null {
  const explicit = nonEmpty(env.PROFILEPILOT_PLAYWRIGHT_CLI_REAL);
  if (explicit && isExecutableFile(explicit)) return { executable: explicit };

  const self = realpathOrInput(selfPath);
  const managedLauncher = realpathOrInput(
    env.PROFILEPILOT_PLAYWRIGHT_CLI_LAUNCHER ||
      path.join(env.HOME || os.homedir(), ".profilepilot", "bin", "playwright-cli")
  );
  for (const candidate of executableCandidatesOnPath("playwright-cli", env)) {
    const real = realpathOrInput(candidate);
    if (real === self || real === managedLauncher) continue;
    return { executable: candidate };
  }
  return null;
}

export function spawnRealPlaywrightCli(
  command: PlaywrightCliCommand,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: PlaywrightCliRunOptions = {}
): Promise<PlaywrightCliSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, args, {
      cwd: options.cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let error: (Error & { code?: string }) | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.forwardOutput !== false) process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.forwardOutput !== false) process.stderr.write(text);
    });
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (value) => {
      error = value;
    });
    child.once("close", (status, signal) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve({ status, signal, stdout, stderr, error });
    });
  });
}

export function discoverPlaywrightCliDaemonPid(session: string, endpoint?: string): number | undefined {
  if (process.platform === "win32") return undefined;
  const safe = safeSession(session);
  if (!safe) return undefined;
  try {
    const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 1_000
    });
    const matches = output.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match || !match[2].includes("cliDaemon.js")) return [];
      if (endpoint && !match[2].includes(endpoint)) return [];
      const tokens = match[2].split(/\s+/);
      if (!tokens.includes(safe)) return [];
      const pid = positivePid(match[1]);
      return pid ? [pid] : [];
    });
    return matches.sort((left, right) => right - left)[0];
  } catch {
    return undefined;
  }
}

export async function runPlaywrightCliWrapper(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PlaywrightCliWrapperDependencies = {}
): Promise<number> {
  const homeDir = env.HOME || os.homedir();
  const cwd = env.PWD || process.cwd();
  const request = dependencies.request || requestBrowserGateway;
  const runner = dependencies.run || spawnRealPlaywrightCli;
  const discoverDaemonPid = dependencies.discoverDaemonPid || discoverPlaywrightCliDaemonPid;
  const ensureGatewayDaemon = dependencies.ensureGatewayDaemon || ensureBrowserGatewayDaemon;
  const ensureProfileRunning = dependencies.ensureProfileRunning || ensureConfiguredGatewayProfileRunning;
  const invocation = parsePlaywrightCliInvocation(args);
  const command = invocation.command;
  const explicitSession = invocation.explicitSession || env.PLAYWRIGHT_CLI_SESSION;
  const validExplicitSession = safeSession(explicitSession);
  const invalidExplicitSession = Boolean(explicitSession && !validExplicitSession);
  const playwrightSession = validExplicitSession || defaultProfilePilotPlaywrightSession(cwd);
  const state = invalidExplicitSession
    ? null
    : readPlaywrightCliSessionState(playwrightSession, cwd, homeDir);

  if (command === "profilepilot") {
    if (invalidExplicitSession) {
      process.stderr.write(formatPlaywrightCliWrapperError(
        wrapperError("PROFILEPILOT_INVALID_SESSION", `无效的 Playwright Session：${explicitSession}`)
      ));
      return PROFILEPILOT_PLAYWRIGHT_CLI_USAGE_EXIT_CODE;
    }
    return handleProfilePilotCommand(args, invocation, state, homeDir, request);
  }

  const realCommand = dependencies.command || resolveRealPlaywrightCli(env);
  if (!realCommand) {
    process.stderr.write("[ProfilePilot] 未找到真实 playwright-cli 可执行文件。\n");
    return 127;
  }

  if (command === "attach" && invocation.cdpPort) {
    const configured = findConfiguredAgentBrowserProfileByPortSync(invocation.cdpPort, env, homeDir);
    let status: GatewayControlResponse;
    try {
      status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
    } catch (error) {
      if (persistedGatewayHasPort(homeDir, invocation.cdpPort)) {
        process.stderr.write(formatPlaywrightCliWrapperError(error));
        return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
      }
      if (!configured) {
        return resultExitCode(await runner(realCommand, args, env, { cwd, forwardOutput: true }));
      }
      try {
        await ensureGatewayDaemon({ homeDir });
        status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
      } catch (gatewayError) {
        process.stderr.write(formatPlaywrightCliWrapperError(gatewayError));
        return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
      }
    }
    try {
      status = await requirePersistentDriverGatewayProtocol(
        status,
        homeDir,
        request,
        ensureGatewayDaemon
      );
    } catch (error) {
      process.stderr.write(formatPlaywrightCliWrapperError(error));
      return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
    }
    if (!gatewayProfiles(status).some((item) => item.publicPort === invocation.cdpPort) && configured) {
      try {
        status = await ensureProfileRunning(invocation.cdpPort, status, env, homeDir);
      } catch (error) {
        process.stderr.write(formatPlaywrightCliWrapperError(error));
        return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
      }
    }
    const profile = gatewayProfiles(status).find((item) => item.publicPort === invocation.cdpPort);
    if (profile) {
      if (invalidExplicitSession) {
        process.stderr.write(formatPlaywrightCliWrapperError(
          wrapperError("PROFILEPILOT_INVALID_SESSION", `无效的 Playwright Session：${explicitSession}`)
        ));
        return PROFILEPILOT_PLAYWRIGHT_CLI_USAGE_EXIT_CODE;
      }
      if (state && state.publicPort !== invocation.cdpPort) {
        process.stderr.write(formatPlaywrightCliWrapperError(wrapperError(
          "SESSION_ALREADY_BOUND",
          `Playwright Session ${playwrightSession} 已绑定端口 ${state.publicPort}；请先运行 playwright-cli -s=${playwrightSession} profilepilot release`
        )));
        return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
      }
      return runManagedAttach({
        args,
        env,
        cwd,
        homeDir,
        publicPort: invocation.cdpPort,
        playwrightSession,
        gatewaySessionId: gatewaySessionFromEnv(env, playwrightSession),
        realCommand,
        request,
        runner,
        discoverDaemonPid
      });
    }
    if (state) {
      process.stderr.write(formatPlaywrightCliWrapperError(wrapperError(
        "SESSION_ALREADY_BOUND",
        `Playwright Session ${playwrightSession} 仍由 ProfilePilot 管理；连接其它 CDP 前请先 release`
      )));
      return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
    }
    return resultExitCode(await runner(realCommand, args, env, { cwd, forwardOutput: true }));
  }

  if (!state || !command || GLOBAL_COMMANDS.has(command) || args.includes("--help") || args.includes("-h")) {
    return resultExitCode(await runner(realCommand, args, env, { cwd, forwardOutput: true }));
  }

  if (TERMINAL_COMMANDS.has(command)) {
    const result = await runner(
      realCommand,
      ensurePlaywrightCliSessionArg(args, state.playwrightSession),
      env,
      { cwd, forwardOutput: true }
    );
    try {
      await releaseManagedPlaywrightSession(state, homeDir, request);
    } catch (error) {
      process.stderr.write(formatPlaywrightCliWrapperError(error));
      return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
    }
    return resultExitCode(result);
  }

  try {
    await ensureManagedPlaywrightConnection({
      state,
      env,
      homeDir,
      request,
      runner,
      realCommand,
      discoverDaemonPid
    });
  } catch (error) {
    process.stderr.write(formatPlaywrightCliWrapperError(error));
    return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
  }

  const result = await runner(
    realCommand,
    ensurePlaywrightCliSessionArg(args, state.playwrightSession),
    env,
    { cwd, forwardOutput: true }
  );
  if (resultExitCode(result) !== 0) {
    try {
      const status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
      const profile = profileForState(status, state);
      if (profile?.ownership === "user" && profile.sessionStatus === "active") {
        process.stderr.write(formatPlaywrightCliWrapperError(wrapperError(
          "AGENT_USER_IN_CONTROL",
          "命令执行期间用户接管了浏览器；不要重试，等待 ProfilePilot 交还控制权"
        )));
        return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
      }
    } catch {
      // Keep the real CLI exit status when Gateway cannot refine the failure.
    }
  }
  return resultExitCode(result);
}

async function requirePersistentDriverGatewayProtocol(
  status: GatewayControlResponse,
  homeDir: string,
  request: GatewayRequester,
  ensureGatewayDaemon: NonNullable<PlaywrightCliWrapperDependencies["ensureGatewayDaemon"]>
): Promise<GatewayControlResponse> {
  const current = Number(status.protocolVersion);
  if (!Number.isFinite(current) || current === BROWSER_GATEWAY_PROTOCOL_VERSION) return status;
  const upgraded = await ensureGatewayDaemon({ homeDir });
  const actual = Number(upgraded.protocolVersion);
  if (actual !== BROWSER_GATEWAY_PROTOCOL_VERSION) {
    throw wrapperError(
      "GATEWAY_PROTOCOL_INCOMPATIBLE",
      `当前 Gateway 协议为 v${current}，Playwright CLI 持久交接需要 v${BROWSER_GATEWAY_PROTOCOL_VERSION}；请先结束旧 Gateway 中仍在运行的 Profile，再重试`
    );
  }
  return request({ action: "status" }, { homeDir, timeoutMs: 800 });
}

export function formatPlaywrightCliWrapperError(error: unknown): string {
  const candidate = error as { code?: string; message?: string; detail?: unknown } | null;
  const code = candidate?.code || "GATEWAY_ERROR";
  const userControl = code === "AGENT_USER_IN_CONTROL";
  return `${JSON.stringify({
    source: "ProfilePilot Gateway",
    tool: "playwright-cli",
    error_code: code,
    hard_stop: true,
    message: candidate?.message || String(error || "Gateway error"),
    action: userControl
      ? "停手：用户正在操作浏览器，不要重试或绕过 Gateway；交还后下一条 playwright-cli 命令会自动重连。"
      : "停手：不要绕过 Gateway 直连 Chrome；检查 ProfilePilot Session 状态后再继续。"
  }, null, 2)}\n`;
}

async function runManagedAttach(options: {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir: string;
  publicPort: number;
  playwrightSession: string;
  gatewaySessionId: string;
  realCommand: PlaywrightCliCommand;
  request: GatewayRequester;
  runner: NonNullable<PlaywrightCliWrapperDependencies["run"]>;
  discoverDaemonPid: NonNullable<PlaywrightCliWrapperDependencies["discoverDaemonPid"]>;
}): Promise<number> {
  const daemonInstanceId = readOrCreateBrowserGatewayDaemonIdentity(options.gatewaySessionId, options.homeDir);
  const provisional: PlaywrightCliSessionState = {
    version: 1,
    playwrightSession: options.playwrightSession,
    gatewaySessionId: options.gatewaySessionId,
    publicPort: options.publicPort,
    daemonInstanceId,
    cwd: options.cwd,
    updatedAt: new Date().toISOString()
  };
  try {
    const acquired = await acquirePlaywrightGatewayEndpoint(provisional, process.pid, options.homeDir, options.request);
    const launchArgs = rewritePlaywrightCliAttachArgs(
      options.args,
      options.playwrightSession,
      acquired.webSocketUrl
    );
    const result = await options.runner(options.realCommand, launchArgs, options.env, {
      cwd: options.cwd,
      forwardOutput: true
    });
    const exitCode = resultExitCode(result);
    if (exitCode !== 0) {
      await stopGatewaySessionIfOwned(provisional, options.homeDir, options.request).catch(() => undefined);
      clearBrowserGatewayDaemonIdentity(options.gatewaySessionId, options.homeDir);
      return exitCode;
    }
    const daemonPid = pidFromPlaywrightOutput(result.stdout) ||
      options.discoverDaemonPid(options.playwrightSession, acquired.webSocketUrl);
    const confirmed = await confirmPlaywrightGatewayConnection(
      provisional,
      daemonPid,
      options.homeDir,
      options.request
    );
    if (!confirmed) {
      throw wrapperError("GATEWAY_CONNECT_FAILED", "Playwright daemon 已启动，但 Gateway 未观察到有效连接");
    }
    writePlaywrightCliSessionState({
      ...provisional,
      ...(daemonPid ? { daemonPid } : {}),
      updatedAt: new Date().toISOString()
    }, options.homeDir);
    return 0;
  } catch (error) {
    await stopGatewaySessionIfOwned(provisional, options.homeDir, options.request).catch(() => undefined);
    clearBrowserGatewayDaemonIdentity(options.gatewaySessionId, options.homeDir);
    process.stderr.write(formatPlaywrightCliWrapperError(error));
    return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
  }
}

async function ensureManagedPlaywrightConnection(options: {
  state: PlaywrightCliSessionState;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  request: GatewayRequester;
  runner: NonNullable<PlaywrightCliWrapperDependencies["run"]>;
  realCommand: PlaywrightCliCommand;
  discoverDaemonPid: NonNullable<PlaywrightCliWrapperDependencies["discoverDaemonPid"]>;
}): Promise<void> {
  let status = await options.request({ action: "status" }, {
    homeDir: options.homeDir,
    timeoutMs: 800
  });
  let profile = profileForState(status, options.state);
  assertManagedProfileCanRun(profile, options.state);
  if (profile?.connectionActive === true) return;

  await withSessionReconnectLock(options.state, options.homeDir, async () => {
    status = await options.request({ action: "status" }, {
      homeDir: options.homeDir,
      timeoutMs: 800
    });
    profile = profileForState(status, options.state);
    assertManagedProfileCanRun(profile, options.state);
    if (profile?.connectionActive === true) return;

    const acquired = await acquirePlaywrightGatewayEndpoint(
      options.state,
      options.state.daemonPid,
      options.homeDir,
      options.request
    );
    const attachArgs = [
      `-s=${options.state.playwrightSession}`,
      "--json",
      "attach",
      `--cdp=${acquired.webSocketUrl}`
    ];
    const attach = await options.runner(options.realCommand, attachArgs, options.env, {
      cwd: options.state.cwd,
      forwardOutput: false
    });
    if (resultExitCode(attach) !== 0) {
      throw wrapperError(
        "GATEWAY_RECONNECT_FAILED",
        `控制权已交还，但 Playwright 自动重连失败：${attach.stderr.trim() || `退出码 ${resultExitCode(attach)}`}`
      );
    }
    const daemonPid = pidFromPlaywrightOutput(attach.stdout) ||
      options.discoverDaemonPid(options.state.playwrightSession, acquired.webSocketUrl);
    const connected = await confirmPlaywrightGatewayConnection(
      options.state,
      daemonPid,
      options.homeDir,
      options.request
    );
    if (!connected) {
      throw wrapperError("GATEWAY_RECONNECT_FAILED", "Playwright 已重新 attach，但 Gateway 未观察到有效连接");
    }
    options.state.daemonPid = daemonPid;
    options.state.updatedAt = new Date().toISOString();
    writePlaywrightCliSessionState(options.state, options.homeDir);
    process.stderr.write(
      "[ProfilePilot] 浏览器控制权已交还，Playwright CLI 已自动重连；旧页面引用可能失效，请以最新 snapshot 为准。\n"
    );
  });
}

async function acquirePlaywrightGatewayEndpoint(
  state: PlaywrightCliSessionState,
  daemonPid: number | undefined,
  homeDir: string,
  request: GatewayRequester
): Promise<{ webSocketUrl: string; connectionActive: boolean }> {
  const acquireRequest = {
    action: "acquire" as const,
    publicPort: state.publicPort,
    sessionId: state.gatewaySessionId,
    daemonInstanceId: state.daemonInstanceId,
    daemonPid,
    agent: inferAgentFromSession(state.gatewaySessionId),
    project: path.basename(state.cwd) || state.cwd,
    driverKind: "playwright-cli",
    driverLabel: "Playwright CLI"
  } as GatewayControlRequest & { driverKind: "playwright-cli"; driverLabel: "Playwright CLI" };
  const response = await request(acquireRequest, { homeDir, timeoutMs: GATEWAY_TIMEOUT_MS });
  const webSocketUrl = typeof response.webSocketUrl === "string" ? response.webSocketUrl.trim() : "";
  if (!isWebSocketUrl(webSocketUrl)) {
    throw wrapperError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回有效的 WebSocket Ticket");
  }
  return { webSocketUrl, connectionActive: response.connectionActive === true };
}

async function confirmPlaywrightGatewayConnection(
  state: PlaywrightCliSessionState,
  daemonPid: number | undefined,
  homeDir: string,
  request: GatewayRequester
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const acquired = await acquirePlaywrightGatewayEndpoint(state, daemonPid, homeDir, request);
    if (acquired.connectionActive) return true;
    await delay(50 * (attempt + 1));
  }
  return false;
}

async function handleProfilePilotCommand(
  args: string[],
  invocation: PlaywrightCliInvocation,
  state: PlaywrightCliSessionState | null,
  homeDir: string,
  request: GatewayRequester
): Promise<number> {
  const action = invocation.commandIndex === undefined ? undefined : args[invocation.commandIndex + 1];
  if (!state) {
    process.stderr.write(formatPlaywrightCliWrapperError(wrapperError(
      "GATEWAY_SESSION_NOT_FOUND",
      "这个 Playwright Session 尚未绑定 ProfilePilot Profile"
    )));
    return PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE;
  }
  try {
    if (action === "status") {
      const status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
      process.stdout.write(`${JSON.stringify({
        source: "ProfilePilot Gateway",
        tool: "playwright-cli",
        session: state.playwrightSession,
        gateway_session: state.gatewaySessionId,
        cdp_port: state.publicPort,
        profile: profileForState(status, state)
      }, null, 2)}\n`);
      return 0;
    }
    if (action === "release") {
      await releaseManagedPlaywrightSession(state, homeDir, request);
      process.stdout.write(`${JSON.stringify({ source: "ProfilePilot Gateway", action: "release", released: true }, null, 2)}\n`);
      return 0;
    }
    if (action === "complete") {
      await request({ action: "control", sessionId: state.gatewaySessionId, command: "complete" }, {
        homeDir,
        timeoutMs: GATEWAY_TIMEOUT_MS
      });
      clearPlaywrightCliSessionState(state.playwrightSession, state.cwd, homeDir);
      clearBrowserGatewayDaemonIdentity(state.gatewaySessionId, homeDir);
      process.stdout.write(`${JSON.stringify({ source: "ProfilePilot Gateway", action: "complete", completed: true }, null, 2)}\n`);
      return 0;
    }
    if (action === "handoff") {
      const reason = optionValue(args, "--reason");
      if (!reason) throw wrapperError("PROFILEPILOT_REASON_REQUIRED", "handoff 必须通过 --reason 说明等待用户完成的操作");
      await request({
        action: "control",
        sessionId: state.gatewaySessionId,
        command: "takeover",
        pendingUserAction: reason,
        revealAgentTarget: true
      }, { homeDir, timeoutMs: 10_000 });
      process.stdout.write(`${JSON.stringify({ source: "ProfilePilot Gateway", action: "handoff", pending_user_action: reason }, null, 2)}\n`);
      return 0;
    }
    if (action === "resume") {
      await request({ action: "control", sessionId: state.gatewaySessionId, command: "return" }, {
        homeDir,
        timeoutMs: GATEWAY_TIMEOUT_MS
      });
      process.stdout.write(`${JSON.stringify({ source: "ProfilePilot Gateway", action: "resume", reconnect_on_next_command: true }, null, 2)}\n`);
      return 0;
    }
    throw wrapperError(
      "PROFILEPILOT_UNKNOWN_ACTION",
      "用法：playwright-cli profilepilot <status|handoff|resume|complete|release>"
    );
  } catch (error) {
    process.stderr.write(formatPlaywrightCliWrapperError(error));
    return action ? PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE : PROFILEPILOT_PLAYWRIGHT_CLI_USAGE_EXIT_CODE;
  }
}

async function releaseManagedPlaywrightSession(
  state: PlaywrightCliSessionState,
  homeDir: string,
  request: GatewayRequester
): Promise<void> {
  const status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
  const profile = profileForState(status, state);
  if (profile?.ownerSessionId === state.gatewaySessionId) {
    await request({
      action: "control",
      sessionId: state.gatewaySessionId,
      command: "stop"
    }, { homeDir, timeoutMs: GATEWAY_TIMEOUT_MS });
  }
  clearPlaywrightCliSessionState(state.playwrightSession, state.cwd, homeDir);
  clearBrowserGatewayDaemonIdentity(state.gatewaySessionId, homeDir);
}

async function stopGatewaySessionIfOwned(
  state: PlaywrightCliSessionState,
  homeDir: string,
  request: GatewayRequester
): Promise<void> {
  const status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
  const profile = profileForState(status, state);
  if (profile?.ownerSessionId !== state.gatewaySessionId) return;
  await request({ action: "control", sessionId: state.gatewaySessionId, command: "stop" }, {
    homeDir,
    timeoutMs: GATEWAY_TIMEOUT_MS
  });
}

function assertManagedProfileCanRun(
  profile: GatewayProfileView | undefined,
  state: PlaywrightCliSessionState
): void {
  if (!profile) {
    throw wrapperError("GATEWAY_PROFILE_NOT_FOUND", `ProfilePilot 端口 ${state.publicPort} 已不可用`);
  }
  if (profile.sessionStatus !== "active" || profile.ownerSessionId !== state.gatewaySessionId) {
    throw wrapperError("AGENT_TASK_STOPPED", `Session ${state.gatewaySessionId} 已结束；需要重新 attach 才能继续`);
  }
  if (profile.ownership === "user") {
    throw wrapperError(
      "AGENT_USER_IN_CONTROL",
      profile.pendingUserAction
        ? `用户正在操作浏览器：${profile.pendingUserAction}`
        : "用户正在操作浏览器"
    );
  }
}

async function withSessionReconnectLock<T>(
  state: PlaywrightCliSessionState,
  homeDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const statePath = playwrightCliSessionStatePath(state.playwrightSession, state.cwd, homeDir);
  const lockPath = `${statePath}.reconnect.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The winning process released the lock between checks.
      }
      if (Date.now() >= deadline) {
        throw wrapperError("GATEWAY_RECONNECT_BUSY", "等待另一个 Playwright 命令完成自动重连超时");
      }
      await delay(50);
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function gatewayProfiles(status: GatewayControlResponse): GatewayProfileView[] {
  const state = status.state && typeof status.state === "object"
    ? status.state as { profiles?: unknown }
    : null;
  if (!Array.isArray(state?.profiles)) return [];
  return state.profiles.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const profile = value as Record<string, unknown>;
    const publicPort = validPort(profile.publicPort);
    if (!publicPort) return [];
    return [{ ...profile, publicPort } as GatewayProfileView];
  });
}

function profileForState(
  status: GatewayControlResponse,
  state: PlaywrightCliSessionState
): GatewayProfileView | undefined {
  return gatewayProfiles(status).find((profile) =>
    profile.publicPort === state.publicPort &&
    (profile.ownerSessionId === state.gatewaySessionId || profile.sessionStatus === "stopped")
  );
}

function gatewaySessionFromEnv(env: NodeJS.ProcessEnv, playwrightSession: string): string {
  const explicit = nonEmpty(env.PROFILEPILOT_SESSION) || nonEmpty(env.PROFILEPILOT_PLAYWRIGHT_SESSION);
  if (explicit) return requiredSafeSession(explicit, "ProfilePilot Session");
  const codex = nonEmpty(env.CODEX_THREAD_ID);
  if (codex) return normalizedAgentSession(codex, "cx");
  const claude = nonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (claude) return normalizedAgentSession(claude, "cc");
  return playwrightSession;
}

function normalizedAgentSession(value: string, prefix: "cx" | "cc"): string {
  if (value.startsWith(`${prefix}-`) && safeSession(value)) return value;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 220);
  const candidate = `${prefix}-${normalized}`;
  return safeSession(candidate) || `${prefix}-${shortHash(value, 24)}`;
}

function removeSessionOptions(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-s" || arg === "--s" || arg === "--session") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-s=") || arg.startsWith("--s=") || arg.startsWith("--session=")) continue;
    result.push(arg);
  }
  return result;
}

function optionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return nonEmpty(args[index + 1]);
    if (args[index].startsWith(`${name}=`)) return nonEmpty(args[index].slice(name.length + 1));
  }
  return undefined;
}

function loopbackCdpPort(value: string): number | undefined {
  if (/^\d+$/.test(value.trim())) return validPort(value);
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]") return undefined;
    const defaultPort = url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
    return validPort(url.port || defaultPort);
  } catch {
    return undefined;
  }
}

function pidFromPlaywrightOutput(output: string): number | undefined {
  try {
    const parsed = JSON.parse(output) as { pid?: unknown };
    return positivePid(parsed.pid);
  } catch {
    const match = output.match(/\bpid\s+(\d+)\b/i);
    return positivePid(match?.[1]);
  }
}

function persistedGatewayHasPort(homeDir: string, publicPort: number): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(homeDir, ".profilepilot", "gateway", "state.json"), "utf8")
    ) as { profiles?: Array<{ publicPort?: unknown }> };
    return Array.isArray(parsed.profiles) && parsed.profiles.some((profile) => Number(profile.publicPort) === publicPort);
  } catch {
    return false;
  }
}

function executableCandidatesOnPath(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH || env.Path || env.path || "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const seen = new Set<string>();
  return directories.flatMap((directory) => extensions.flatMap((extension) => {
    const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
    const real = realpathOrInput(candidate);
    if (seen.has(real) || !isExecutableFile(candidate)) return [];
    seen.add(real);
    return [candidate];
  }));
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== "win32") accessSync(filePath, fsConstants.X_OK);
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

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function safeSession(value: unknown): string | undefined {
  const session = typeof value === "string" ? value.trim() : "";
  return SAFE_SESSION_RE.test(session) ? session : undefined;
}

function requiredSafeSession(value: string, label: string): string {
  const session = safeSession(value);
  if (!session) throw wrapperError("PROFILEPILOT_INVALID_SESSION", `无效的 ${label}：${value}`);
  return session;
}

function validPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function positivePid(value: unknown): number | undefined {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function inferAgentFromSession(session: string): string | undefined {
  if (session.startsWith("cx-")) return "Codex";
  if (session.startsWith("cc-")) return "Claude Code";
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function resultExitCode(result: PlaywrightCliSpawnResult): number {
  if (result.error?.code === "ENOENT") return 127;
  if (result.error) return 1;
  if (typeof result.status === "number") return result.status;
  if (!result.signal) return 1;
  return 128 + ((os.constants.signals as Record<string, number>)[result.signal] || 0);
}

function wrapperError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  void runPlaywrightCliWrapper().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(formatPlaywrightCliWrapperError(error));
      process.exitCode = 1;
    }
  );
}
