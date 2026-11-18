import type { AppState, GatewayProfileControlState } from "../shared/types";
import { AgentOverlayManager, isAgentOverlayClient } from "./agent-overlay";
import { type GatewayControlResponse } from "./browser-gateway-client";
import { agentControlStatusForClients, gatewayControlClient, gatewayControlsByPort, gatewayOverlayClients, gatewayOverlayControl, gatewayProfilesFromResponse, makeExternalProfileId, positiveInteger } from "./profile-connections";

function collectControlledTargetIds(
  control: GatewayProfileControlState | null | undefined,
  rawProfile?: Record<string, unknown>
): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      ids.add(value.trim());
    }
  };
  add(control?.agentTarget?.targetId);
  if (rawProfile && typeof rawProfile === "object") {
    add(rawProfile.targetId);
    const rawAgentTarget = rawProfile.agentTarget;
    if (rawAgentTarget && typeof rawAgentTarget === "object") {
      add((rawAgentTarget as Record<string, unknown>).targetId);
    }
    const sessions = rawProfile.sessions;
    if (sessions && typeof sessions === "object") {
      for (const entry of Object.values(sessions as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const record = entry as Record<string, unknown>;
        add(record.targetId);
        if (record.agentTarget && typeof record.agentTarget === "object") {
          add((record.agentTarget as Record<string, unknown>).targetId);
        }
      }
    }
  }
  return [...ids];
}

export async function profileOverlayInput(state: AppState, gatewayStatus: GatewayControlResponse | null): Promise<Parameters<AgentOverlayManager["sync"]>[0]> {
    const { profiles, externalInstances } = state;
    const gatewayControlByPort = gatewayControlsByPort(gatewayStatus);
    const rawGatewayProfileByPort = new Map<number, Record<string, unknown>>();
    for (const rawProfile of gatewayProfilesFromResponse(gatewayStatus || { ok: true })) {
      const port = Number(rawProfile.publicPort);
      if (Number.isInteger(port) && port > 0) {
        rawGatewayProfileByPort.set(port, rawProfile);
      }
    }
    const profileAgentOverlayCandidates = await Promise.all(
      profiles
        .filter((profile) => profile.cdpPort !== null && profile.cdpUrl)
        .map(async (profile) => {
          const port = profile.cdpPort as number;
          const clients = gatewayOverlayClients(profile);
          const effectiveGatewayControl = profile.gatewayControl || gatewayControlByPort.get(port) || null;
          const control = effectiveGatewayControl
            ? gatewayOverlayControl(effectiveGatewayControl)
            : await agentControlStatusForClients(clients);
          const rawProfile = rawGatewayProfileByPort.get(port);
          return {
            port,
            profileId: profile.id,
            profileName: profile.name,
            headless: false,
            browserPids: profile.browserPids || [],
            controlPaused: control.paused,
            pendingUserAction: effectiveGatewayControl?.pendingUserAction || control.pendingUserAction,
            agentOffline: control.agentOffline,
            driverReconnecting: Boolean(
              effectiveGatewayControl &&
              (effectiveGatewayControl.driverState === "connecting" || effectiveGatewayControl.driverState === "reconnecting")
            ),
            controlSince: control.controlSince,
            agentTarget: effectiveGatewayControl?.agentTarget || null,
            ...(effectiveGatewayControl
              ? { controlledTargetIds: collectControlledTargetIds(effectiveGatewayControl, rawProfile) }
              : {}),
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
          controlledTargetIds: collectControlledTargetIds(control, profile),
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
