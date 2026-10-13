import type { AppState } from "../shared/types";
import { AgentOverlayManager, isAgentOverlayClient } from "./agent-overlay";
import { type GatewayControlResponse } from "./browser-gateway-client";
import { agentControlStatusForClients, gatewayControlClient, gatewayControlsByPort, gatewayOverlayClients, gatewayOverlayControl, gatewayProfilesFromResponse, makeExternalProfileId, positiveInteger } from "./profile-connections";
export async function profileOverlayInput(state: AppState, gatewayStatus: GatewayControlResponse | null): Promise<Parameters<AgentOverlayManager["sync"]>[0]> {
    const { profiles, externalInstances } = state;
    const gatewayControlByPort = gatewayControlsByPort(gatewayStatus);
    const profileAgentOverlayCandidates = await Promise.all(
      profiles
        .filter((profile) => profile.cdpPort !== null && profile.cdpUrl)
        .map(async (profile) => {
          const clients = gatewayOverlayClients(profile);
          const control = profile.gatewayControl
            ? gatewayOverlayControl(profile.gatewayControl)
            : await agentControlStatusForClients(clients);
          return {
            port: profile.cdpPort as number,
            profileId: profile.id,
            profileName: profile.name,
            headless: false,
            browserPids: profile.browserPids || [],
            controlPaused: control.paused,
            pendingUserAction: profile.gatewayControl?.pendingUserAction || control.pendingUserAction,
            agentOffline: control.agentOffline,
            driverReconnecting: Boolean(
              profile.gatewayControl &&
              (profile.gatewayControl.driverState === "connecting" || profile.gatewayControl.driverState === "reconnecting")
            ),
            controlSince: control.controlSince,
            agentTarget: profile.gatewayControl?.agentTarget || null,
            clients
          };
        })
    );
    const externalAgentOverlayCandidates = await Promise.all(
      externalInstances
        .filter((instance) => instance.cdpPort !== null)
        .map(async (instance) => {
          const clients = (instance.cdpClients || []).filter(isAgentOverlayClient);
          const control = await agentControlStatusForClients(clients);
          return {
            port: instance.cdpPort as number,
            profileId: makeExternalProfileId(instance.userDataDir),
            profileName: instance.label,
            headless: instance.headless,
            browserPids: [instance.pid],
            controlPaused: control.paused,
            pendingUserAction: control.pendingUserAction,
            agentOffline: control.agentOffline,
            driverReconnecting: false,
            controlSince: control.controlSince,
            agentTarget: null,
            clients
          };
        })
    );
    const localAppOverlayCandidates = gatewayProfilesFromResponse(gatewayStatus || { ok: true })
      .filter(profile => typeof profile.profileId === "string" && profile.profileId.startsWith("local-app:"))
      .flatMap(profile => {
        const port = Number(profile.publicPort);
        const control = gatewayControlByPort.get(port);
        if (!control) return [];
        const state = gatewayOverlayControl(control);
        const client = gatewayControlClient(control);
        return [{
          port, profileId: String(profile.profileId), profileName: String(profile.profileName),
          headless: false, browserPids: positiveInteger(profile.chromePid) ? [Number(profile.chromePid)] : [],
          controlPaused: state.paused, pendingUserAction: state.pendingUserAction,
          agentOffline: state.agentOffline,
          driverReconnecting: control.driverState === "connecting" || control.driverState === "reconnecting",
          controlSince: state.controlSince, agentTarget: control.agentTarget,
          clients: client ? [client] : []
        }];
      });
    const profileAgentOverlayPorts = profileAgentOverlayCandidates.filter((input) => input.clients.length > 0);
    const externalAgentOverlayPorts = externalAgentOverlayCandidates.filter((input) => input.clients.length > 0);
    const agentOverlayPorts = profileAgentOverlayPorts.concat(externalAgentOverlayPorts, localAppOverlayCandidates.filter(input => input.clients.length > 0));
    const activeOverlayPorts = new Set(agentOverlayPorts.map((input) => input.port));
    const inactiveOverlayPorts = [...new Set(
      profileAgentOverlayCandidates
        .concat(externalAgentOverlayCandidates)
        .concat(localAppOverlayCandidates)
        .filter((input) => !input.headless && !activeOverlayPorts.has(input.port))
        .map((input) => input.port)
    )];
    return {
      enabled: state.agentOverlayEnabled,
      ports: agentOverlayPorts,
      inactivePorts: inactiveOverlayPorts
    };
}
