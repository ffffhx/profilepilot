import { mkdirSync } from "node:fs";
import os from "node:os";
import {
  assertConfiguredAgentAccessAllowedSync,
  findConfiguredAgentBrowserProfileByPortSync
} from "./agent-browser-lease";
import {
  BROWSER_GATEWAY_PROTOCOL_VERSION,
  ensureBrowserGatewayDaemon,
  requestBrowserGateway,
  type GatewayControlRequest,
  type GatewayControlResponse
} from "./browser-gateway-client";
import type { GatewayDriverKind } from "./browser-gateway-control";
import { ensureProfileBifrostProxy } from "./bifrost-proxy";
import { waitForCdp } from "./cdp-client";
import { loadUnpackedExtensionsOverCdp } from "./cdp-page";
import { getDirectChromeCommand } from "./chrome-launch";
import { getMigratedExtensionLaunchPlan } from "./migrated-extension-launch";

export interface GatewayDriverProfileView {
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

export type GatewayDriverRequester = (
  request: GatewayControlRequest,
  options?: { homeDir?: string; timeoutMs?: number }
) => Promise<GatewayControlResponse>;

export type GatewayDriverDaemonEnsurer = (
  options: { homeDir: string }
) => Promise<GatewayControlResponse>;

export type GatewayDriverProfileEnsurer = (
  publicPort: number,
  status: GatewayControlResponse,
  env: NodeJS.ProcessEnv,
  homeDir: string
) => Promise<GatewayControlResponse>;

export interface GatewayDriverEndpointContext {
  publicPort: number;
  sessionId: string;
  daemonInstanceId: string;
  daemonPid?: number;
  driverKind: GatewayDriverKind;
  driverLabel: string;
  agent?: string;
  project?: string;
  branch?: string;
}

export interface GatewayDriverRuntimeDependencies {
  request?: GatewayDriverRequester;
  ensureGatewayDaemon?: GatewayDriverDaemonEnsurer;
  ensureProfileRunning?: GatewayDriverProfileEnsurer;
}

export function gatewayDriverProfiles(
  response: GatewayControlResponse
): GatewayDriverProfileView[] {
  const state = response.state;
  if (!state || typeof state !== "object") return [];
  const profiles = (state as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const profile = value as Record<string, unknown>;
    const publicPort = validPort(profile.publicPort);
    return publicPort ? [{ ...profile, publicPort } as GatewayDriverProfileView] : [];
  });
}

export function findConfiguredGatewayProfileByPortSync(
  publicPort: number,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME || os.homedir()
) {
  return findConfiguredAgentBrowserProfileByPortSync(publicPort, env, homeDir);
}

export async function ensurePersistentDriverGatewayProtocol(
  status: GatewayControlResponse,
  input: {
    homeDir: string;
    driverLabel: string;
    request?: GatewayDriverRequester;
    ensureGatewayDaemon?: GatewayDriverDaemonEnsurer;
  }
): Promise<GatewayControlResponse> {
  const current = Number(status.protocolVersion);
  if (!Number.isFinite(current) || current === BROWSER_GATEWAY_PROTOCOL_VERSION) return status;
  const request = input.request || requestBrowserGateway;
  const ensureGatewayDaemon = input.ensureGatewayDaemon || ensureBrowserGatewayDaemon;
  const upgraded = await ensureGatewayDaemon({ homeDir: input.homeDir });
  const actual = Number(upgraded.protocolVersion);
  if (actual !== BROWSER_GATEWAY_PROTOCOL_VERSION) {
    throw gatewayDriverError(
      "GATEWAY_PROTOCOL_INCOMPATIBLE",
      `当前 Gateway 协议为 v${current}，${input.driverLabel} 持久交接需要 v${BROWSER_GATEWAY_PROTOCOL_VERSION}；请先结束旧 Gateway 中仍在运行的 Profile，再重试`
    );
  }
  return request({ action: "status" }, { homeDir: input.homeDir, timeoutMs: 800 });
}

export async function ensureConfiguredGatewayProfileRunning(
  publicPort: number,
  status: GatewayControlResponse,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME || os.homedir()
): Promise<GatewayControlResponse> {
  const configured = assertConfiguredAgentAccessAllowedSync(publicPort, env, homeDir);
  const activePorts = Array.isArray(status.ports) ? status.ports.map(Number) : [];
  if (activePorts.includes(publicPort)) return status;

  if (!configured) {
    const managedPorts = Array.isArray(status.managedPorts) ? status.managedPorts.map(Number) : [];
    if (managedPorts.includes(publicPort)) {
      throw gatewayDriverError(
        "GATEWAY_PROFILE_NOT_RUNNING",
        `Gateway 管理的 Profile ${publicPort} 当前未启动`
      );
    }
    throw gatewayDriverError(
      "GATEWAY_PROFILE_NOT_CONFIGURED",
      `ProfilePilot 没有找到绑定到端口 ${publicPort} 的 Profile`
    );
  }

  const executable = getDirectChromeCommand(env);
  if (!executable) {
    throw gatewayDriverError("CHROME_NOT_FOUND", "找不到可供 Gateway 启动的 Chrome 二进制");
  }
  mkdirSync(configured.userDataDir, { recursive: true });
  const launchPlan = await getMigratedExtensionLaunchPlan(configured.profile);
  const bifrostArgs = configured.profile.bifrostProxy
    ? await ensureProfileBifrostProxy(configured.profile.id, configured.profile.bifrostProxy, env)
    : [];
  await requestBrowserGateway({
    action: "launch-profile",
    profileId: configured.profileId,
    profileName: configured.profileName,
    publicPort,
    agentAccessDisabled: configured.profile.agentAccessDisabled === true,
    executable,
    args: [
      `--user-data-dir=${configured.userDataDir}`,
      "--no-first-run",
      ...bifrostArgs,
      ...launchPlan.launchArgs
    ]
  }, { homeDir, timeoutMs: 8_000 });
  await waitForCdp(publicPort, 6_000, homeDir);
  if (launchPlan.runtimeLoadPaths.length) {
    await loadUnpackedExtensionsOverCdp(publicPort, launchPlan.runtimeLoadPaths, homeDir);
  }
  return requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 1_500 });
}

export async function acquireGatewayDriverEndpoint(
  context: GatewayDriverEndpointContext,
  options: {
    homeDir?: string;
    timeoutMs?: number;
    ensureReady?: boolean;
    env?: NodeJS.ProcessEnv;
  } & GatewayDriverRuntimeDependencies = {}
): Promise<{ webSocketUrl: string; connectionActive: boolean; response: GatewayControlResponse }> {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const request = options.request || requestBrowserGateway;
  const ensureGatewayDaemon = options.ensureGatewayDaemon || ensureBrowserGatewayDaemon;
  const ensureProfileRunning = options.ensureProfileRunning || ensureConfiguredGatewayProfileRunning;

  if (options.ensureReady !== false) {
    let status: GatewayControlResponse;
    try {
      status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
    } catch {
      await ensureGatewayDaemon({ homeDir });
      status = await request({ action: "status" }, { homeDir, timeoutMs: 800 });
    }
    status = await ensurePersistentDriverGatewayProtocol(status, {
      homeDir,
      driverLabel: context.driverLabel,
      request,
      ensureGatewayDaemon
    });
    await ensureProfileRunning(context.publicPort, status, env, homeDir);
  }

  const response = await request({
    action: "acquire",
    publicPort: context.publicPort,
    sessionId: context.sessionId,
    daemonInstanceId: context.daemonInstanceId,
    daemonPid: context.daemonPid,
    driverKind: context.driverKind,
    driverLabel: context.driverLabel,
    agent: context.agent,
    project: context.project,
    branch: context.branch
  }, { homeDir, timeoutMs: options.timeoutMs || 3_000 });
  const webSocketUrl = typeof response.webSocketUrl === "string"
    ? response.webSocketUrl.trim()
    : "";
  if (!isWebSocketUrl(webSocketUrl)) {
    throw gatewayDriverError("GATEWAY_INVALID_RESPONSE", "Gateway 没有返回有效的 WebSocket Ticket");
  }
  return {
    webSocketUrl,
    connectionActive: response.connectionActive === true,
    response
  };
}

export function gatewayDriverError(
  code: string,
  message: string
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function validPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
