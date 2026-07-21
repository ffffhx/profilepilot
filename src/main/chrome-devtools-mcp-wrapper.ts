#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync
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
import { ensureConfiguredGatewayProfileRunning } from "./agent-browser-wrapper";

const SAFE_SESSION_RE = /^[A-Za-z0-9._:-]{1,240}$/;
const DEFAULT_NPX_PACKAGE = "chrome-devtools-mcp@latest";

export const PROFILEPILOT_CHROME_DEVTOOLS_MCP_HARD_STOP_EXIT_CODE = 75;
export const PROFILEPILOT_CHROME_DEVTOOLS_MCP_USAGE_EXIT_CODE = 64;

export interface ChromeDevtoolsMcpProfilePilotConfig {
  enabled: boolean;
  publicPort?: number;
  sessionId?: string;
  passthroughArgs: string[];
}

export interface ChromeDevtoolsMcpCommand {
  executable: string;
  prefixArgs: string[];
  source: "binary" | "npx";
}

export interface ChromeDevtoolsMcpEndpointContext {
  publicPort: number;
  sessionId: string;
  daemonInstanceId: string;
  daemonPid: number;
  agent?: string;
  project?: string;
}

/**
 * Kept deliberately smaller than the Gateway RPC response. A future stable
 * relay can implement this interface without exposing tickets to this wrapper.
 */
export interface ChromeDevtoolsMcpEndpointProvider {
  getWebSocketUrl(context: ChromeDevtoolsMcpEndpointContext): Promise<string>;
}

export interface ChromeDevtoolsMcpSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error & { code?: string };
}

type GatewayRequester = (
  request: GatewayControlRequest,
  options?: { homeDir?: string; timeoutMs?: number }
) => Promise<GatewayControlResponse>;

type GatewayDaemonEnsurer = (options: { homeDir: string }) => Promise<GatewayControlResponse>;
type GatewayProfileEnsurer = (
  publicPort: number,
  status: GatewayControlResponse,
  env: NodeJS.ProcessEnv,
  homeDir: string
) => Promise<GatewayControlResponse>;

export function parseChromeDevtoolsMcpProfilePilotConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): ChromeDevtoolsMcpProfilePilotConfig {
  let portValue: string | undefined;
  let sessionValue: string | undefined;
  let sawProfilePilotOption = false;
  let sawPortOption = false;
  let sawSessionOption = false;
  const passthroughArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      passthroughArgs.push(...args.slice(index));
      break;
    }
    if (arg === "--profilepilot-port" || arg === "--profilepilot-session") {
      sawProfilePilotOption = true;
      if (arg === "--profilepilot-port") sawPortOption = true;
      else sawSessionOption = true;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw wrapperError(
          "PROFILEPILOT_INVALID_ARGUMENT",
          `${arg} 需要一个值`
        );
      }
      if (arg === "--profilepilot-port") portValue = value;
      else sessionValue = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--profilepilot-port=")) {
      sawProfilePilotOption = true;
      sawPortOption = true;
      portValue = arg.slice("--profilepilot-port=".length);
      continue;
    }
    if (arg.startsWith("--profilepilot-session=")) {
      sawProfilePilotOption = true;
      sawSessionOption = true;
      sessionValue = arg.slice("--profilepilot-session=".length);
      continue;
    }
    passthroughArgs.push(arg);
  }

  if (sawPortOption && !nonEmpty(portValue)) {
    throw wrapperError("PROFILEPILOT_INVALID_ARGUMENT", "--profilepilot-port 需要一个值");
  }
  if (sawSessionOption && !nonEmpty(sessionValue)) {
    throw wrapperError("PROFILEPILOT_INVALID_ARGUMENT", "--profilepilot-session 需要一个值");
  }
  portValue = sawPortOption ? nonEmpty(portValue) : firstEnv(env, [
      "PROFILEPILOT_CHROME_DEVTOOLS_MCP_PORT",
      "PROFILEPILOT_CDP_PORT",
      "PROFILEPILOT_PORT"
    ]);
  sessionValue = sawSessionOption ? nonEmpty(sessionValue) : firstEnv(env, [
      "PROFILEPILOT_CHROME_DEVTOOLS_MCP_SESSION",
      "PROFILEPILOT_SESSION",
      "AGENT_BROWSER_SESSION"
    ]) || inferredAgentSession(env);

  // Session identity is injected into every AI shell, but MCP must stay a
  // transparent launcher until a ProfilePilot port is explicitly selected.
  const configured = sawProfilePilotOption || Boolean(portValue);
  if (!configured) {
    // In ordinary MCP mode the wrapper must be transparent, including retaining
    // the exact array identity semantics expected by argument-level tests.
    return { enabled: false, passthroughArgs: args };
  }
  if (!portValue || !sessionValue) {
    throw wrapperError(
      "PROFILEPILOT_INCOMPLETE_CONFIG",
      "ProfilePilot 模式需要同时提供端口和 Session"
    );
  }
  const publicPort = parsePort(portValue);
  if (!publicPort) {
    throw wrapperError("PROFILEPILOT_INVALID_PORT", `无效的 ProfilePilot 端口：${portValue}`);
  }
  const sessionId = parseSession(sessionValue);
  if (!sessionId) {
    throw wrapperError("PROFILEPILOT_INVALID_SESSION", `无效的 ProfilePilot Session：${sessionValue}`);
  }
  return { enabled: true, publicPort, sessionId, passthroughArgs };
}

export function rewriteChromeDevtoolsMcpWebSocketArgs(args: string[], webSocketUrl: string): string[] {
  const endpoint = nonEmpty(webSocketUrl);
  if (!endpoint || !isWebSocketUrl(endpoint)) {
    throw wrapperError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回有效的 WebSocket Ticket");
  }
  const rewritten: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      rewritten.push(`--wsEndpoint=${endpoint}`, ...args.slice(index));
      return rewritten;
    }
    if (isEndpointOption(arg) || isBrowserUrlOption(arg)) {
      if (!arg.includes("=") && index + 1 < args.length && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    rewritten.push(arg);
  }
  rewritten.push(`--wsEndpoint=${endpoint}`);
  return rewritten;
}

export function resolveRealChromeDevtoolsMcp(
  env: NodeJS.ProcessEnv = process.env,
  selfPath = process.argv[1] || ""
): ChromeDevtoolsMcpCommand | null {
  const explicit = nonEmpty(env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL);
  if (explicit && isExecutableFile(explicit)) {
    return { executable: explicit, prefixArgs: [], source: "binary" };
  }

  const self = realpathOrInput(selfPath);
  const managedLauncher = realpathOrInput(
    env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_LAUNCHER ||
      path.join(env.HOME || os.homedir(), ".profilepilot", "bin", "chrome-devtools-mcp")
  );
  for (const candidate of executableCandidatesOnPath("chrome-devtools-mcp", env)) {
    const real = realpathOrInput(candidate);
    if (real === self || real === managedLauncher) continue;
    return { executable: candidate, prefixArgs: [], source: "binary" };
  }

  const explicitNpx = nonEmpty(env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_NPX);
  const npxCandidates = explicitNpx && isExecutableFile(explicitNpx)
    ? [explicitNpx]
    : executableCandidatesOnPath(process.platform === "win32" ? "npx.cmd" : "npx", env);
  const npx = npxCandidates.find((candidate) => realpathOrInput(candidate) !== self);
  if (!npx) return null;
  const packageSpec = nonEmpty(env.PROFILEPILOT_CHROME_DEVTOOLS_MCP_PACKAGE) || DEFAULT_NPX_PACKAGE;
  return { executable: npx, prefixArgs: ["--yes", packageSpec], source: "npx" };
}

export function createGatewayChromeDevtoolsMcpEndpointProvider(
  options: {
    homeDir?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    request?: GatewayRequester;
    ensureGatewayDaemon?: GatewayDaemonEnsurer;
    ensureProfileRunning?: GatewayProfileEnsurer;
  } = {}
): ChromeDevtoolsMcpEndpointProvider {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const request = options.request || requestBrowserGateway;
  const ensureGatewayDaemon = options.ensureGatewayDaemon || ensureBrowserGatewayDaemon;
  const ensureProfileRunning = options.ensureProfileRunning || ensureConfiguredGatewayProfileRunning;
  return {
    async getWebSocketUrl(context): Promise<string> {
      let status: GatewayControlResponse;
      try {
        status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
      } catch {
        await ensureGatewayDaemon({ homeDir });
        status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
      }
      status = await requirePersistentDriverGatewayProtocol(
        status,
        homeDir,
        request,
        ensureGatewayDaemon
      );
      await ensureProfileRunning(context.publicPort, status, env, homeDir);

      // The current Gateway protocol persists this identity so UI, takeover,
      // completion, and cleanup all operate on the verified driver type.
      const acquireRequest = {
        action: "acquire" as const,
        publicPort: context.publicPort,
        sessionId: context.sessionId,
        daemonInstanceId: context.daemonInstanceId,
        daemonPid: context.daemonPid,
        agent: context.agent,
        project: context.project,
        driverKind: "chrome-devtools-mcp",
        driverLabel: "Chrome DevTools MCP"
      } as GatewayControlRequest & { driverKind: "chrome-devtools-mcp"; driverLabel: "Chrome DevTools MCP" };
      const response = await request(acquireRequest, {
        homeDir,
        timeoutMs: options.timeoutMs || 3_000
      });
      const webSocketUrl = typeof response.webSocketUrl === "string" ? response.webSocketUrl.trim() : "";
      if (!webSocketUrl) {
        throw wrapperError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回 WebSocket Ticket");
      }
      return webSocketUrl;
    }
  };
}

async function requirePersistentDriverGatewayProtocol(
  status: GatewayControlResponse,
  homeDir: string,
  request: GatewayRequester,
  ensureGatewayDaemon: GatewayDaemonEnsurer
): Promise<GatewayControlResponse> {
  const current = Number(status.protocolVersion);
  if (!Number.isFinite(current) || current === BROWSER_GATEWAY_PROTOCOL_VERSION) return status;
  const upgraded = await ensureGatewayDaemon({ homeDir });
  const actual = Number(upgraded.protocolVersion);
  if (actual !== BROWSER_GATEWAY_PROTOCOL_VERSION) {
    throw wrapperError(
      "GATEWAY_PROTOCOL_INCOMPATIBLE",
      `当前 Gateway 协议为 v${current}，Chrome DevTools MCP 持久交接需要 v${BROWSER_GATEWAY_PROTOCOL_VERSION}；请先结束旧 Gateway 中仍在运行的 Profile，再重试`
    );
  }
  return request({ action: "status" }, { homeDir, timeoutMs: 800 });
}

export async function prepareChromeDevtoolsMcpLaunchArgs(
  config: ChromeDevtoolsMcpProfilePilotConfig,
  env: NodeJS.ProcessEnv = process.env,
  endpointProvider?: ChromeDevtoolsMcpEndpointProvider
): Promise<string[]> {
  if (!config.enabled) return config.passthroughArgs;
  const publicPort = config.publicPort as number;
  const sessionId = config.sessionId as string;
  const homeDir = env.HOME || os.homedir();
  const provider = endpointProvider || createGatewayChromeDevtoolsMcpEndpointProvider({ homeDir, env });
  const webSocketUrl = await provider.getWebSocketUrl({
    publicPort,
    sessionId,
    daemonInstanceId: readOrCreateBrowserGatewayDaemonIdentity(sessionId, homeDir),
    daemonPid: process.pid,
    agent: inferAgentFromSession(sessionId),
    project: projectFromEnv(env)
  });
  return rewriteChromeDevtoolsMcpWebSocketArgs(config.passthroughArgs, webSocketUrl);
}

export function spawnChromeDevtoolsMcp(
  command: ChromeDevtoolsMcpCommand,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<SpawnOptions, "cwd"> = {}
): Promise<ChromeDevtoolsMcpSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, [...command.prefixArgs, ...args], {
      cwd: options.cwd,
      env,
      stdio: "inherit"
    });
    let error: (Error & { code?: string }) | undefined;
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
      resolve({ status, signal, error });
    });
  });
}

export async function runChromeDevtoolsMcpWrapper(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    endpointProvider?: ChromeDevtoolsMcpEndpointProvider;
    command?: ChromeDevtoolsMcpCommand;
    request?: GatewayRequester;
    ensureGatewayDaemon?: GatewayDaemonEnsurer;
    ensureProfileRunning?: GatewayProfileEnsurer;
  } = {}
): Promise<number> {
  let config: ChromeDevtoolsMcpProfilePilotConfig;
  try {
    config = parseChromeDevtoolsMcpProfilePilotConfig(args, env);
  } catch (error) {
    process.stderr.write(formatChromeDevtoolsMcpWrapperError(error));
    return PROFILEPILOT_CHROME_DEVTOOLS_MCP_USAGE_EXIT_CODE;
  }

  const command = dependencies.command || resolveRealChromeDevtoolsMcp(env);
  if (!command) {
    process.stderr.write("[ProfilePilot] 未找到真实 chrome-devtools-mcp 或 npx 可执行文件。\n");
    return 127;
  }

  let launchArgs: string[];
  try {
    const endpointProvider = dependencies.endpointProvider || (dependencies.request
      ? createGatewayChromeDevtoolsMcpEndpointProvider({
          homeDir: env.HOME || os.homedir(),
          env,
          request: dependencies.request,
          ensureGatewayDaemon: dependencies.ensureGatewayDaemon,
          ensureProfileRunning: dependencies.ensureProfileRunning
        })
      : undefined);
    launchArgs = await prepareChromeDevtoolsMcpLaunchArgs(config, env, endpointProvider);
  } catch (error) {
    process.stderr.write(formatChromeDevtoolsMcpWrapperError(error));
    return PROFILEPILOT_CHROME_DEVTOOLS_MCP_HARD_STOP_EXIT_CODE;
  }

  const result = await spawnChromeDevtoolsMcp(command, launchArgs, env);
  if (config.enabled && config.sessionId) {
    await releaseChromeDevtoolsMcpGatewaySession(
      config.sessionId,
      env.HOME || os.homedir(),
      dependencies.request || requestBrowserGateway
    ).catch(() => undefined);
  }
  if (result.error) {
    process.stderr.write(`[ProfilePilot] 启动真实 chrome-devtools-mcp 失败：${result.error.message}\n`);
    return result.error.code === "ENOENT" ? 127 : 1;
  }
  if (typeof result.status === "number") return result.status;
  return signalExitCode(result.signal);
}

export function formatChromeDevtoolsMcpWrapperError(error: unknown): string {
  const candidate = error as { code?: string; message?: string } | null;
  return `${JSON.stringify(
    {
      source: "ProfilePilot Gateway",
      error_code: candidate?.code || "GATEWAY_ERROR",
      hard_stop: true,
      tool: "chrome-devtools-mcp",
      message: candidate?.message || String(error || "Gateway error"),
      action: "停手：不要绕过 Gateway 直连 Chrome CDP；先恢复 ProfilePilot Gateway 或交还控制权。"
    },
    null,
    2
  )}\n`;
}

function isEndpointOption(arg: string): boolean {
  return arg === "--wsEndpoint" ||
    arg.startsWith("--wsEndpoint=") ||
    arg === "--ws-endpoint" ||
    arg.startsWith("--ws-endpoint=");
}

function isBrowserUrlOption(arg: string): boolean {
  return arg === "--browserUrl" ||
    arg.startsWith("--browserUrl=") ||
    arg === "--browser-url" ||
    arg.startsWith("--browser-url=");
}

function executableCandidatesOnPath(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH || env.Path || env.path || "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? executableExtensions(command, env.PATHEXT)
    : [""];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      const real = realpathOrInput(candidate);
      if (seen.has(real) || !isExecutableFile(candidate)) continue;
      seen.add(real);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function executableExtensions(command: string, pathExt: string | undefined): string[] {
  if (path.extname(command)) return [""];
  return (pathExt || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
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

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function parseSession(value: string): string | undefined {
  const session = value.trim();
  return SAFE_SESSION_RE.test(session) ? session : undefined;
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = nonEmpty(env[name]);
    if (value) return value;
  }
  return undefined;
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function inferAgentFromSession(session: string): string | undefined {
  if (session.startsWith("cc-")) return "Claude Code";
  if (session.startsWith("cx-")) return "Codex";
  return undefined;
}

function inferredAgentSession(env: NodeJS.ProcessEnv): string | undefined {
  const codex = nonEmpty(env.CODEX_THREAD_ID);
  if (codex) return normalizeAgentSession(codex, "cx");
  const claude = nonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (claude) return normalizeAgentSession(claude, "cc");
  return undefined;
}

function normalizeAgentSession(value: string, prefix: "cx" | "cc"): string {
  if (value.startsWith(`${prefix}-`) && SAFE_SESSION_RE.test(value)) return value;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 220);
  const candidate = `${prefix}-${normalized}`;
  return SAFE_SESSION_RE.test(candidate) ? candidate : `${prefix}-${process.pid}`;
}

async function releaseChromeDevtoolsMcpGatewaySession(
  sessionId: string,
  homeDir: string,
  request: GatewayRequester
): Promise<void> {
  try {
    await request({
      action: "control",
      sessionId,
      command: "stop"
    }, { homeDir, timeoutMs: 3_000 });
  } finally {
    clearBrowserGatewayDaemonIdentity(sessionId, homeDir);
  }
}

function projectFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const cwd = nonEmpty(env.PWD);
  return cwd ? path.basename(cwd) || cwd : undefined;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signals = os.constants.signals as Record<string, number>;
  return 128 + (signals[signal] || 0);
}

function wrapperError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

if (require.main === module) {
  void runChromeDevtoolsMcpWrapper().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(formatChromeDevtoolsMcpWrapperError(error));
      process.exitCode = 1;
    }
  );
}
