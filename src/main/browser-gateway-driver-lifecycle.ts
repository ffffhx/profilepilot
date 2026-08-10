import {
  releaseAgentBrowserProfileLeasesForSessionSync,
  retireAgentBrowserSessionSync
} from "./agent-browser-lease";
import {
  clearAgentBrowserCommandStateSync,
  clearAgentBrowserControlWaitStateSync
} from "./agent-browser-session";
import {
  clearBrowserGatewayDaemonIdentity
} from "./browser-gateway-client";
import type {
  GatewayDriverKind,
  GatewayProfileBinding
} from "./browser-gateway-control";
import { writeGatewayDriverNoticeSync } from "./agent-control-notice";

export type GatewayDriverSessionStopReason =
  | "reconnect-exhausted"
  | "agent-access-disabled";

export interface BrowserGatewayDriverLifecycle {
  connected(profile: GatewayProfileBinding): void;
  reconnecting(profile: GatewayProfileBinding, reconnectDeadlineAt: string): void;
  sessionStopped(
    profile: GatewayProfileBinding,
    reason: GatewayDriverSessionStopReason
  ): void;
}

interface GatewayDriverLifecycleAdapter {
  connected(profile: GatewayProfileBinding): void;
  reconnecting(profile: GatewayProfileBinding, reconnectDeadlineAt: string): void;
  sessionStopped(
    profile: GatewayProfileBinding,
    reason: GatewayDriverSessionStopReason
  ): void;
}

export function createBrowserGatewayDriverLifecycle(
  homeDir: string
): BrowserGatewayDriverLifecycle {
  const defaultAdapter = new DefaultGatewayDriverLifecycleAdapter(homeDir);
  const adapters = new Map<GatewayDriverKind, GatewayDriverLifecycleAdapter>([
    ["agent-browser", new AgentBrowserGatewayDriverLifecycleAdapter(homeDir)],
    ["playwright-cli", defaultAdapter],
    ["chrome-devtools-mcp", defaultAdapter]
  ]);
  const adapterFor = (profile: GatewayProfileBinding): GatewayDriverLifecycleAdapter =>
    adapters.get(profile.driverKind || "agent-browser") || defaultAdapter;

  return {
    connected(profile): void {
      adapterFor(profile).connected(profile);
    },
    reconnecting(profile, reconnectDeadlineAt): void {
      adapterFor(profile).reconnecting(profile, reconnectDeadlineAt);
    },
    sessionStopped(profile, reason): void {
      adapterFor(profile).sessionStopped(profile, reason);
    }
  };
}

class DefaultGatewayDriverLifecycleAdapter implements GatewayDriverLifecycleAdapter {
  constructor(protected readonly homeDir: string) {}

  connected(profile: GatewayProfileBinding): void {
    const sessionId = profile.ownerSessionId;
    if (sessionId) writeGatewayDriverNoticeSync(this.homeDir, sessionId, profile, "connected");
  }

  reconnecting(profile: GatewayProfileBinding, reconnectDeadlineAt: string): void {
    const sessionId = profile.ownerSessionId;
    if (sessionId) {
      writeGatewayDriverNoticeSync(
        this.homeDir,
        sessionId,
        profile,
        "reconnecting",
        reconnectDeadlineAt
      );
    }
  }

  sessionStopped(
    profile: GatewayProfileBinding,
    reason: GatewayDriverSessionStopReason
  ): void {
    const sessionId = profile.ownerSessionId;
    if (sessionId && reason === "reconnect-exhausted") {
      writeGatewayDriverNoticeSync(this.homeDir, sessionId, profile, "exhausted");
    }
  }
}

class AgentBrowserGatewayDriverLifecycleAdapter
  extends DefaultGatewayDriverLifecycleAdapter {
  override sessionStopped(
    profile: GatewayProfileBinding,
    reason: GatewayDriverSessionStopReason
  ): void {
    const sessionId = profile.ownerSessionId;
    if (!sessionId) return;
    retireAgentBrowserSessionSync(sessionId, profile.daemonPid, this.homeDir);
    releaseAgentBrowserProfileLeasesForSessionSync(sessionId, this.homeDir);
    clearAgentBrowserControlWaitStateSync(sessionId, undefined, this.homeDir);
    clearAgentBrowserCommandStateSync(sessionId, undefined, this.homeDir);
    clearBrowserGatewayDaemonIdentity(sessionId, this.homeDir);
    super.sessionStopped(profile, reason);
  }
}
