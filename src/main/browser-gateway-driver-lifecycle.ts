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
  GatewayProfileBinding
} from "./browser-gateway-control";
import { writeGatewayDriverNoticeSync } from "./agent-control-notice";

export type GatewayDriverSessionStopReason =
  | "reconnect-exhausted"
  | "electron-detached"
  | "agent-access-disabled";

export interface BrowserGatewayDriverLifecycle {
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
  return new AgentBrowserGatewayDriverLifecycle(homeDir);
}

class AgentBrowserGatewayDriverLifecycle implements BrowserGatewayDriverLifecycle {
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
    if (!sessionId) return;
    retireAgentBrowserSessionSync(sessionId, profile.daemonPid, this.homeDir);
    releaseAgentBrowserProfileLeasesForSessionSync(sessionId, this.homeDir);
    clearAgentBrowserControlWaitStateSync(sessionId, undefined, this.homeDir);
    clearAgentBrowserCommandStateSync(sessionId, undefined, this.homeDir);
    clearBrowserGatewayDaemonIdentity(sessionId, this.homeDir);
    if (reason === "reconnect-exhausted") {
      writeGatewayDriverNoticeSync(this.homeDir, sessionId, profile, "exhausted");
    }
  }
}
