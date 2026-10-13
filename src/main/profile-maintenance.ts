import type { AppState, CdpClientInfo } from "../shared/types";
import { updateAgentBrowserProfileLeaseTargetSync, writeAgentBrowserRuntimeProfilesSync } from "./agent-browser-lease";
import type { AgentOverlayManager } from "./agent-overlay";
import { refreshPortOwners, syncContentionObservers } from "./cdp-contention";
import { agentBrowserRuntimeProfilesFromPublicProfiles, makeExternalProfileId, shouldAutoDisconnectStaleAgentBrowserClient, uniqueCdpClientsByPid } from "./profile-connections";
import { profileOverlayInput } from "./profile-overlay";
import type { CollectedProfileState } from "./profile-state";

interface ProfileMaintenanceInput {
  repairRegistry(): Promise<void>;
  collect(): Promise<CollectedProfileState>;
  disconnect(client: CdpClientInfo): Promise<void>;
  overlay: Pick<AgentOverlayManager, "sync" | "dispose">;
}

/** Owns writes and long-lived connections. A status read never starts this work. */
export class ProfileRuntimeMaintenance {
  private inFlight: Promise<AppState> | null = null;
  private pending = false;
  private stopping = false;

  constructor(private readonly input: ProfileMaintenanceInput) {}

  refresh(): Promise<AppState> {
    if (this.stopping) return Promise.reject(new Error("Profile runtime maintenance has stopped"));
    this.pending = true;
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async run(): Promise<AppState> {
    let collected: CollectedProfileState;
    do {
      this.pending = false;
      await this.input.repairRegistry();
      collected = await this.input.collect();
      if (this.stopping) break;
      if (await this.disconnectStaleClients(collected.state)) {
        // Re-read occupancy and connections after cleanup; never alter a snapshot
        // that another reader or window might still be using.
        collected = await this.input.collect();
      }
      if (this.stopping) break;
      this.syncRuntimeFiles(collected.state);
      syncContentionObservers(collected.state.profiles
        .filter(profile => profile.cdpUrl && profile.cdpPort !== null)
        .map(profile => profile.cdpPort as number));
      for (const profile of collected.state.profiles) {
        if (profile.cdpPort !== null) refreshPortOwners(profile.cdpPort, profile.cdpClients);
      }
      const overlay = await profileOverlayInput(collected.state, collected.gatewayStatus);
      if (!this.stopping) this.input.overlay.sync(overlay);
    } while (this.pending && !this.stopping);
    return collected.state;
  }

  private async disconnectStaleClients(state: AppState): Promise<boolean> {
    const candidates = uniqueCdpClientsByPid([
      ...state.profiles.flatMap(profile => profile.cdpClients),
      ...state.externalInstances.flatMap(instance => instance.cdpClients || [])
    ].filter(client => shouldAutoDisconnectStaleAgentBrowserClient(client)));
    const results = await Promise.all(candidates.map(async client => {
      try { await this.input.disconnect(client); return true; }
      catch { return false; } // Keep failed clients available for a manual disconnect.
    }));
    return results.some(Boolean);
  }

  private syncRuntimeFiles(state: AppState): void {
    for (const profile of state.profiles) {
      const port = profile.cdpPort ?? (profile.source === "isolated" ? profile.fixedCdpPort : null);
      if (port !== null) updateAgentBrowserProfileLeaseTargetSync(port, { profileId: profile.id, profileName: profile.name });
    }
    for (const instance of state.externalInstances) {
      if (instance.cdpPort !== null) updateAgentBrowserProfileLeaseTargetSync(instance.cdpPort, {
        profileId: makeExternalProfileId(instance.userDataDir), profileName: instance.label
      });
    }
    writeAgentBrowserRuntimeProfilesSync(agentBrowserRuntimeProfilesFromPublicProfiles(state.profiles));
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await this.inFlight?.catch(() => undefined);
    syncContentionObservers([]);
    await this.input.overlay.dispose();
  }
}
