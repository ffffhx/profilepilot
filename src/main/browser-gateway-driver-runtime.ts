import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  assertConfiguredAgentAccessAllowedSync
} from "./agent-browser-lease";
import {
  browserGatewayRoot,
  requestBrowserGateway,
  type GatewayControlResponse
} from "./browser-gateway-client";
import { directConnectionChromeArgs, ensureProfileBifrostProxy, ensureUpstreamProxy } from "./bifrost-proxy";
import { waitForCdp } from "./cdp-client";
import { loadUnpackedExtensionsOverCdp } from "./cdp-page";
import { getDirectChromeCommand } from "./chrome-launch";
import { getMigratedExtensionLaunchPlan } from "./migrated-extension-launch";

export async function ensureConfiguredGatewayProfileRunning(
  publicPort: number,
  status: GatewayControlResponse,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME || os.homedir()
): Promise<GatewayControlResponse> {
  const configured = assertConfiguredAgentAccessAllowedSync(publicPort, env, homeDir);
  assertProtectedElectronPort(publicPort, homeDir);
  const activePorts = Array.isArray(status.ports) ? status.ports.map(Number) : [];
  if (activePorts.includes(publicPort)) return status;
  const electron = managedElectronPorts(homeDir).find(profile => profile.publicPort === publicPort);
  if (electron) {
    await requestBrowserGateway({ action: "reconnect-electron", publicPort }, { homeDir, timeoutMs: 5000 });
    return requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 1500 });
  }

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
  const proxyArgs = configured.profile.bifrostProxy
    ? await ensureProfileBifrostProxy(configured.profile.id, configured.profile.bifrostProxy, env)
    : configured.profile.upstreamProxy
      ? await ensureUpstreamProxy(configured.profile.upstreamProxy)
      : directConnectionChromeArgs(configured.profile.directConnection);
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
      ...(configured.profile.hideAutomation === true ? ["--disable-blink-features=AutomationControlled"] : []),
      ...proxyArgs,
      ...launchPlan.launchArgs
    ]
  }, { homeDir, timeoutMs: 8_000 });
  await waitForCdp(publicPort, 6_000, homeDir);
  if (launchPlan.runtimeLoadPaths.length) {
    await loadUnpackedExtensionsOverCdp(publicPort, launchPlan.runtimeLoadPaths, homeDir);
  }
  return requestBrowserGateway({ action: "status" }, { homeDir, timeoutMs: 1_500 });
}

export function gatewayDriverError(
  code: string,
  message: string
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function managedElectronPorts(homeDir = os.homedir()): Array<{ publicPort: number; electronCdpPort: number }> {
  try {
    const catalog = JSON.parse(readFileSync(path.join(browserGatewayRoot(homeDir), "managed-profiles.json"), "utf8"));
    return (Array.isArray(catalog.profiles) ? catalog.profiles : []).filter((item: { publicPort: number; electronCdpPort: number }) =>
      validPort(item.publicPort) && validPort(item.electronCdpPort));
  } catch { return []; }
}
export function assertProtectedElectronPort(publicPort: number, homeDir = os.homedir()): void {
  const electron = managedElectronPorts(homeDir).find(profile => profile.electronCdpPort === publicPort);
  if (electron) throw gatewayDriverError("ELECTRON_USE_GATEWAY_PORT", `这是 Electron 原始调试端口；请使用受保护的 Agent 端口：--cdp ${electron.publicPort}`);
}

function validPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}
