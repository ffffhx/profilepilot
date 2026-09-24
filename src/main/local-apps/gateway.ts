import os from "node:os";
import type { LocalAppAgentState, LocalAppConfig } from "../../shared/local-apps";
import { BROWSER_GATEWAY_PROTOCOL_VERSION, ensureBrowserGatewayDaemon, requestBrowserGateway, type GatewayControlResponse } from "../browser-gateway-client";
import type { GatewayProfileBinding } from "../browser-gateway-control";

export const localAppProfileId = (id: string): string => `local-app:${id}`;

export class LocalAppGateway {
  constructor(private homeDir = os.homedir()) {}
  async status(): Promise<GatewayControlResponse> {
    const ready = await ensureBrowserGatewayDaemon({ homeDir: this.homeDir });
    if (Number(ready.protocolVersion) < BROWSER_GATEWAY_PROTOCOL_VERSION) {
      throw new Error("当前 Gateway 需升级后才能接入 Electron；请先关闭旧 Gateway 中的浏览器，再重新连接。");
    }
    return requestBrowserGateway({ action: "status" }, { homeDir: this.homeDir });
  }
  async attach(config: LocalAppConfig): Promise<void> {
    if (!config.agentPort || !config.cdpPort || config.mode === "service") return;
    await requestBrowserGateway({
      action: "attach-electron", profileId: localAppProfileId(config.id), profileName: config.name,
      publicPort: config.agentPort, backendPort: config.cdpPort
    }, { homeDir: this.homeDir, timeoutMs: 5000 });
  }
  async detach(config: LocalAppConfig): Promise<void> {
    if (!config.agentPort) return;
    try {
      const status = await requestBrowserGateway({ action: "status" }, { homeDir: this.homeDir });
      // Older daemons cannot own Electron routes. Keep ordinary app editing and
      // stopping available while their live Chrome pipes defer the upgrade.
      if (Number(status.protocolVersion) < 16) return;
      await requestBrowserGateway({ action: "detach-electron", profileId: localAppProfileId(config.id), publicPort: config.agentPort }, { homeDir: this.homeDir, timeoutMs: 12000 });
    } catch (error) {
      if ((error as { code?: string }).code !== "GATEWAY_UNAVAILABLE") throw error;
    }
  }
  async activeProfile(config: LocalAppConfig): Promise<GatewayProfileBinding | undefined> {
    if (!config.agentPort) return;
    try { return this.profile(config, await requestBrowserGateway({ action: "status" }, { homeDir: this.homeDir })); }
    catch (error) { if ((error as { code?: string }).code !== "GATEWAY_UNAVAILABLE") throw error; }
  }
  profile(config: LocalAppConfig, status: GatewayControlResponse): GatewayProfileBinding | undefined {
    const profiles = (status.state as { profiles?: GatewayProfileBinding[] } | undefined)?.profiles || [];
    return profiles.find(profile => profile.profileId === localAppProfileId(config.id) && profile.publicPort === config.agentPort);
  }
  state(config: LocalAppConfig, status: GatewayControlResponse): LocalAppAgentState {
    const profile = this.profile(config, status);
    return {
      connected: Boolean(profile && (status.ports as number[] | undefined)?.includes(config.agentPort!)),
      ...(profile?.sessionStatus === "active" && profile.ownerSessionId ? { sessionId: profile.ownerSessionId, ownership: profile.ownership } : {})
    };
  }
}
