import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;
const TICKET_VERSION = 1;
const DEFAULT_TICKET_TTL_MS = 15_000;
const RESTART_NONCE_TTL_MS = 15_000;

export type GatewayOwnership = "agent" | "user";
export type GatewaySessionStatus = "active" | "stopped";
export type GatewayAgentHealth = "online" | "waiting" | "offline";
export type GatewayDriverState = "disconnected" | "connecting" | "connected" | "reconnecting" | "parked";
export type GatewayDriverKind = "agent-browser";

export interface GatewaySessionBinding {
  sessionId: string;
  daemonInstanceId: string;
  daemonPid?: number;
  driverKind: GatewayDriverKind;
  driverLabel?: string;
  targetId?: string;
  exclusive?: boolean;
  agent?: string;
  project?: string;
  branch?: string;
  agentHealth: GatewayAgentHealth;
  driverState: GatewayDriverState;
  reconnectAttempt?: number;
  reconnectDeadlineAt?: string;
  lastDisconnectReason?: string;
  controlGeneration: number;
  updatedAt: string;
}

export interface GatewayProfileBinding {
  profileId: string;
  profileName: string;
  publicPort: number;
  chromePid?: number;
  ownerSessionId?: string;
  daemonInstanceId?: string;
  daemonPid?: number;
  driverKind?: GatewayDriverKind;
  driverLabel?: string;
  targetId?: string;
  exclusive?: boolean;
  sessions?: Record<string, GatewaySessionBinding>;
  agent?: string;
  project?: string;
  branch?: string;
  pendingUserAction?: string;
  ownership: GatewayOwnership;
  sessionStatus: GatewaySessionStatus;
  agentHealth: GatewayAgentHealth;
  // Session ownership and the actual driver transport are separate. An Agent-owned
  // Session may remain active while its WebSocket is inside a bounded reconnect window.
  driverState: GatewayDriverState;
  reconnectAttempt?: number;
  reconnectDeadlineAt?: string;
  lastDisconnectReason?: string;
  controlGeneration: number;
  updatedAt: string;
}

export interface GatewayAcquireRequest {
  publicPort: number;
  sessionId: string;
  daemonInstanceId: string;
  daemonPid?: number;
  driverKind?: GatewayDriverKind;
  driverLabel?: string;
  targetId?: string;
  allocateTab?: boolean;
  allowSharedProfile?: boolean;
  exclusive?: boolean;
  agent?: string;
  project?: string;
  branch?: string;
  restartNonce?: string;
}

export interface GatewayTicketClaims {
  version: 1;
  ticketId: string;
  sessionId: string;
  profileId: string;
  publicPort: number;
  daemonInstanceId: string;
  controlGeneration: number;
  targetId?: string;
  issuedAt: number;
  expiresAt: number;
  kind: "agent" | "internal";
}

export interface GatewayConnectionIdentity {
  sessionId: string;
  profileId: string;
  publicPort: number;
  daemonInstanceId: string;
  controlGeneration: number;
  targetId?: string;
  kind: "agent" | "internal";
}

export interface GatewayControlSnapshot {
  version: 1;
  updatedAt: string;
  profiles: GatewayProfileBinding[];
}

interface RestartGrant {
  nonce: string;
  sessionId: string;
  publicPort: number;
  previousDaemonInstanceId: string;
  expiresAt: number;
}

export interface GatewayControlEvent {
  type: "profile-updated" | "connections-revoked" | "connection-updated";
  profile: GatewayProfileBinding;
  reason: string;
  targetChange?: GatewayAgentTargetChange;
}

export interface GatewayAgentTargetChange {
  sessionId: string;
  previousTargetId: string | null;
  targetId: string | null;
  source: string;
}

export class BrowserGatewayControlError extends Error {
  constructor(
    readonly code:
      | "GATEWAY_PROFILE_NOT_FOUND"
      | "GATEWAY_PROFILE_NOT_RUNNING"
      | "GATEWAY_DRIVER_UNSUPPORTED"
      | "PROFILE_LEASE_CONFLICT"
      | "PROFILE_AGENT_ACCESS_DISABLED"
      | "SESSION_ALREADY_BOUND"
      | "SESSION_DAEMON_DUPLICATE"
      | "AGENT_USER_IN_CONTROL"
      | "PENDING_USER_ACTION"
      | "AGENT_TASK_STOPPED"
      | "GATEWAY_TICKET_INVALID"
      | "GATEWAY_TICKET_EXPIRED"
      | "GATEWAY_TICKET_REPLAYED"
      | "CONTROL_GENERATION_STALE"
      | "DAEMON_RESTART_NOT_AUTHORIZED"
      | "GATEWAY_UNAUTHORIZED"
      | "GATEWAY_INVALID_REQUEST"
      | "GATEWAY_INVALID_EXECUTABLE"
      | "INVALID_BROWSER_EXECUTABLE",
    message: string
  ) {
    super(message);
    this.name = "BrowserGatewayControlError";
  }
}

export interface BrowserGatewayControlOptions {
  homeDir?: string;
  statePath?: string;
  secret?: Buffer;
  ticketTtlMs?: number;
  now?: () => number;
  onEvent?: (event: GatewayControlEvent) => void;
}

export class BrowserGatewayControlPlane {
  private readonly profilesByPort = new Map<number, GatewayProfileBinding>();
  private readonly profilePortBySession = new Map<string, number>();
  private readonly consumedTickets = new Map<string, number>();
  private readonly restartGrants = new Map<string, RestartGrant>();
  private readonly secret: Buffer;
  private readonly statePath: string;
  private readonly ticketTtlMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: GatewayControlEvent) => void;

  constructor(options: BrowserGatewayControlOptions = {}) {
    const homeDir = options.homeDir || os.homedir();
    this.statePath = options.statePath || path.join(homeDir, ".profilepilot", "gateway", "state.json");
    this.secret = options.secret || randomBytes(32);
    this.ticketTtlMs = Math.max(1_000, options.ticketTtlMs || DEFAULT_TICKET_TTL_MS);
    this.now = options.now || Date.now;
    this.onEvent = options.onEvent;
    this.load();
  }

  registerProfile(input: {
    profileId: string;
    profileName: string;
    publicPort: number;
    chromePid?: number;
  }): GatewayProfileBinding {
    const profileId = requiredString(input.profileId, "profileId");
    const profileName = requiredString(input.profileName, "profileName");
    const publicPort = validPort(input.publicPort);
    const existing = this.profilesByPort.get(publicPort);
    if (existing && existing.profileId !== profileId && existing.ownerSessionId) {
      throw new BrowserGatewayControlError(
        "PROFILE_LEASE_CONFLICT",
        `端口 ${publicPort} 已绑定 ${existing.profileName}`
      );
    }
    const now = iso(this.now());
    const profile: GatewayProfileBinding = existing
      ? {
          ...existing,
          profileId,
          profileName,
          chromePid: normalizePid(input.chromePid) || existing.chromePid,
          updatedAt: now
        }
      : {
          profileId,
          profileName,
          publicPort,
          chromePid: normalizePid(input.chromePid),
          ownership: "user",
          sessionStatus: "stopped",
          agentHealth: "offline",
          driverState: "disconnected",
          controlGeneration: 1,
          updatedAt: now
        };
    this.profilesByPort.set(publicPort, profile);
    this.persist("register-profile", profile);
    return cloneProfile(profile);
  }

  unregisterProfile(publicPort: number): boolean {
    const port = validPort(publicPort);
    const profile = this.profilesByPort.get(port);
    if (!profile) return false;
    if (profile.ownerSessionId) {
      this.profilePortBySession.delete(profile.ownerSessionId);
    }
    if (profile.sessions) {
      for (const sessionId of Object.keys(profile.sessions)) {
        this.profilePortBySession.delete(sessionId);
      }
    }
    this.profilesByPort.delete(port);
    this.persistSnapshot();
    this.onEvent?.({ type: "connections-revoked", profile: cloneProfile(profile), reason: "profile-unregistered" });
    return true;
  }

  setSessionTarget(sessionIdInput: string, targetIdInput: string | null): void {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const port = this.profilePortBySession.get(sessionId);
    if (port === undefined) return;
    const profile = this.profilesByPort.get(port);
    if (!profile || profile.sessionStatus !== "active") return;
    const targetId = targetIdInput ? optionalString(targetIdInput) : undefined;
    if (profile.ownerSessionId === sessionId) {
      profile.targetId = targetId;
    }
    if (profile.sessions?.[sessionId]) {
      profile.sessions[sessionId].targetId = targetId;
    }
  }

  acquire(request: GatewayAcquireRequest): { ticket: string; claims: GatewayTicketClaims; profile: GatewayProfileBinding } {
    this.pruneEphemeralState();
    const publicPort = validPort(request.publicPort);
    const sessionId = safeId(request.sessionId, "sessionId");
    const daemonInstanceId = safeId(request.daemonInstanceId, "daemonInstanceId");
    const profile = this.requireProfile(publicPort);
    const alreadyBoundPort = this.profilePortBySession.get(sessionId);
    if (alreadyBoundPort !== undefined && alreadyBoundPort !== publicPort) {
      throw new BrowserGatewayControlError(
        "SESSION_ALREADY_BOUND",
        `Session ${sessionId} 已绑定端口 ${alreadyBoundPort}`
      );
    }
    const requestedTargetId = optionalString(request.targetId);
    const existingSecondary = profile.sessions?.[sessionId];
    const isExistingMember = profile.ownerSessionId === sessionId || Boolean(existingSecondary);

    if (profile.sessionStatus === "active" && profile.ownership === "user") {
      if (isExistingMember) {
        throw new BrowserGatewayControlError(
          "AGENT_USER_IN_CONTROL",
          `用户正在操作 ${profile.profileName}`
        );
      }
      throw new BrowserGatewayControlError(
        "PROFILE_LEASE_CONFLICT",
        `${profile.profileName} 当前由用户接管操作中`
      );
    }
    if (profile.sessionStatus === "stopped" && profile.ownerSessionId === sessionId) {
      throw new BrowserGatewayControlError(
        "AGENT_TASK_STOPPED",
        `Session ${sessionId} 已结束`
      );
    }

    const activeOtherSessions = collectActiveSessions(profile).filter((entry) => entry.sessionId !== sessionId);
    const requestedDriverKind = normalizeDriverKind(request.driverKind);

    if (activeOtherSessions.length > 0) {
      const shareRequested = Boolean(requestedTargetId || request.allocateTab || request.allowSharedProfile);
      const anyExclusive = request.exclusive === true || profile.exclusive === true || activeOtherSessions.some((entry) => entry.exclusive === true);
      if (!shareRequested || anyExclusive) {
        throw new BrowserGatewayControlError(
          "PROFILE_LEASE_CONFLICT",
          `${profile.profileName} 已由 Session ${profile.ownerSessionId || activeOtherSessions[0].sessionId} 使用`
        );
      }
      if (requestedTargetId) {
        const tabOwner = activeOtherSessions.find((entry) => entry.targetId && entry.targetId === requestedTargetId);
        if (tabOwner) {
          throw new BrowserGatewayControlError(
            "PROFILE_LEASE_CONFLICT",
            `${profile.profileName} 的标签页 ${requestedTargetId} 已由 Session ${tabOwner.sessionId} 控制`
          );
        }
      }
    }

    const currentMemberDaemonId = profile.ownerSessionId === sessionId
      ? profile.daemonInstanceId
      : existingSecondary?.daemonInstanceId;
    const currentMemberDriverKind = profile.ownerSessionId === sessionId
      ? profile.driverKind
      : existingSecondary?.driverKind;

    if (
      isExistingMember &&
      profile.sessionStatus === "active" &&
      currentMemberDriverKind &&
      currentMemberDriverKind !== requestedDriverKind
    ) {
      throw new BrowserGatewayControlError(
        "SESSION_DAEMON_DUPLICATE",
        `Session ${sessionId} 已由 ${driverLabel(currentMemberDriverKind)} 驱动，请先结束原驱动会话`
      );
    }

    if (
      isExistingMember &&
      currentMemberDaemonId &&
      currentMemberDaemonId !== daemonInstanceId
    ) {
      if (!this.consumeRestartGrant(request.restartNonce, sessionId, publicPort, currentMemberDaemonId)) {
        throw new BrowserGatewayControlError(
          "SESSION_DAEMON_DUPLICATE",
          `Session ${sessionId} 已有 daemon ${currentMemberDaemonId}`
        );
      }
    }

    const now = iso(this.now());

    if (activeOtherSessions.length > 0 && profile.ownerSessionId && profile.ownerSessionId !== sessionId) {
      if (!profile.sessions) {
        profile.sessions = {};
      }
      if (!profile.sessions[profile.ownerSessionId]) {
        profile.sessions[profile.ownerSessionId] = buildPrimarySessionBinding(profile);
      }
      const continuingSecondary = Boolean(existingSecondary && profile.sessionStatus === "active" && profile.ownership === "agent");
      let driverState: GatewayDriverState = existingSecondary?.driverState || "connecting";
      let reconnectAttempt = existingSecondary?.reconnectAttempt;
      if (!continuingSecondary || driverState === "parked" || driverState === "disconnected") {
        driverState = "connecting";
        reconnectAttempt = 1;
      } else if (driverState === "reconnecting" || driverState === "connecting") {
        reconnectAttempt = Math.min(3, Math.max(0, reconnectAttempt || 0) + 1);
      }
      const resolvedTargetId = requestedTargetId || existingSecondary?.targetId;
      const secondaryBinding: GatewaySessionBinding = {
        sessionId,
        daemonInstanceId,
        daemonPid: normalizePid(request.daemonPid),
        driverKind: requestedDriverKind,
        driverLabel: optionalString(request.driverLabel) || driverLabel(requestedDriverKind),
        ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
        ...(request.exclusive === true ? { exclusive: true } : {}),
        agent: optionalString(request.agent),
        project: optionalString(request.project),
        branch: optionalString(request.branch),
        agentHealth: driverState === "connected" ? "online" : "offline",
        driverState,
        reconnectAttempt,
        controlGeneration: profile.controlGeneration,
        updatedAt: now
      };
      profile.sessions[sessionId] = secondaryBinding;
      profile.updatedAt = now;
      this.profilePortBySession.set(sessionId, publicPort);
      this.persist("acquire", profile);
      const claims = this.issueClaims(profile, daemonInstanceId, "agent", sessionId, resolvedTargetId);
      return { ticket: this.signClaims(claims), claims, profile: cloneProfile(profile) };
    }

    const continuingAgentSession = profile.ownerSessionId === sessionId &&
      profile.sessionStatus === "active" &&
      profile.ownership === "agent";
    const resolvedPrimaryTargetId = requestedTargetId ?? (continuingAgentSession ? profile.targetId : undefined);
    const resolvedPrimaryExclusive = request.exclusive === true
      ? true
      : request.exclusive === false
        ? undefined
        : continuingAgentSession
          ? profile.exclusive
          : undefined;
    profile.ownerSessionId = sessionId;
    profile.daemonInstanceId = daemonInstanceId;
    profile.daemonPid = normalizePid(request.daemonPid);
    profile.driverKind = requestedDriverKind;
    profile.driverLabel = optionalString(request.driverLabel) || driverLabel(requestedDriverKind);
    profile.targetId = resolvedPrimaryTargetId;
    profile.exclusive = resolvedPrimaryExclusive;
    profile.agent = optionalString(request.agent);
    profile.project = optionalString(request.project);
    profile.branch = optionalString(request.branch);
    profile.pendingUserAction = undefined;
    profile.ownership = "agent";
    profile.sessionStatus = "active";
    if (!continuingAgentSession || profile.driverState === "parked" || profile.driverState === "disconnected") {
      profile.driverState = "connecting";
      profile.reconnectAttempt = 1;
    } else if (profile.driverState === "reconnecting" || profile.driverState === "connecting") {
      profile.reconnectAttempt = Math.min(3, Math.max(0, profile.reconnectAttempt || 0) + 1);
    }
    profile.agentHealth = profile.driverState === "connected" ? "online" : "offline";
    profile.updatedAt = iso(this.now());
    if (profile.sessions?.[sessionId]) {
      profile.sessions[sessionId] = buildPrimarySessionBinding(profile);
    }
    this.profilePortBySession.set(sessionId, publicPort);
    this.persist("acquire", profile);

    const claims = this.issueClaims(profile, daemonInstanceId, "agent", sessionId, resolvedPrimaryTargetId);
    return { ticket: this.signClaims(claims), claims, profile: cloneProfile(profile) };
  }

  bindAllocatedTarget(
    sessionIdInput: string,
    daemonInstanceIdInput: string,
    targetIdInput: string
  ): { ticket: string; claims: GatewayTicketClaims; profile: GatewayProfileBinding } {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const daemonInstanceId = safeId(daemonInstanceIdInput, "daemonInstanceId");
    const targetId = optionalString(targetIdInput);
    if (!targetId) {
      throw new BrowserGatewayControlError("GATEWAY_INVALID_REQUEST", "缺少 targetId");
    }
    const profile = this.requireSessionProfile(sessionId);
    const activeOthers = collectActiveSessions(profile).filter((entry) => entry.sessionId !== sessionId);
    const owner = activeOthers.find((entry) => entry.targetId && entry.targetId === targetId);
    if (owner) {
      throw new BrowserGatewayControlError(
        "PROFILE_LEASE_CONFLICT",
        `${profile.profileName} 的标签页 ${targetId} 已由 Session ${owner.sessionId} 控制`
      );
    }
    if (profile.ownerSessionId === sessionId) {
      profile.targetId = targetId;
    }
    if (profile.sessions?.[sessionId]) {
      profile.sessions[sessionId].targetId = targetId;
    }
    profile.updatedAt = iso(this.now());
    this.persist("target-allocated", profile);
    const claims = this.issueClaims(profile, daemonInstanceId, "agent", sessionId, targetId);
    return { ticket: this.signClaims(claims), claims, profile: cloneProfile(profile) };
  }

  issueInternalTicket(publicPort: number): { ticket: string; claims: GatewayTicketClaims } {
    const profile = this.requireProfile(validPort(publicPort));
    const claims = this.issueClaims(profile, `internal-${randomUUID()}`, "internal");
    return { ticket: this.signClaims(claims), claims };
  }

  consumeTicket(ticket: string): GatewayConnectionIdentity {
    this.pruneEphemeralState();
    const claims = this.verifyTicket(ticket);
    if (this.consumedTickets.has(claims.ticketId)) {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_REPLAYED", "Gateway Ticket 已被使用");
    }
    this.assertClaimsCurrent(claims);
    this.consumedTickets.set(claims.ticketId, claims.expiresAt);
    return {
      sessionId: claims.sessionId,
      profileId: claims.profileId,
      publicPort: claims.publicPort,
      daemonInstanceId: claims.daemonInstanceId,
      controlGeneration: claims.controlGeneration,
      ...(claims.targetId ? { targetId: claims.targetId } : {}),
      kind: claims.kind
    };
  }

  assertConnectionCanSend(identity: GatewayConnectionIdentity): GatewayProfileBinding {
    const profile = this.requireProfile(identity.publicPort);
    if (profile.profileId !== identity.profileId) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "浏览器控制代次已变化，请重新连接");
    }
    if (identity.kind === "internal") {
      return cloneProfile(profile);
    }
    if (profile.controlGeneration !== identity.controlGeneration) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "浏览器控制代次已变化，请重新连接");
    }
    if (profile.sessionStatus !== "active") {
      throw new BrowserGatewayControlError("AGENT_TASK_STOPPED", "Agent Session 已结束");
    }
    if (profile.ownership !== "agent") {
      throw new BrowserGatewayControlError("AGENT_USER_IN_CONTROL", "用户正在操作浏览器");
    }
    const isPrimary = profile.ownerSessionId === identity.sessionId && profile.daemonInstanceId === identity.daemonInstanceId;
    const secondary = profile.sessions?.[identity.sessionId];
    const isSecondary = Boolean(secondary && secondary.daemonInstanceId === identity.daemonInstanceId);
    if (!isPrimary && !isSecondary) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway 连接所有者已变化");
    }
    return cloneProfile(profile);
  }

  delegateToUser(
    sessionIdInput: string,
    reason: "user_takeover" | "agent_complete",
    pendingUserAction?: string
  ): GatewayProfileBinding {
    if (reason === "agent_complete") {
      const profile = this.requireSessionProfile(sessionIdInput);
      if (
        profile.sessionStatus === "active" &&
        (profile.ownership === "user" || Boolean(profile.pendingUserAction))
      ) {
        throw new BrowserGatewayControlError(
          "PENDING_USER_ACTION",
          profile.pendingUserAction
            ? `仍在等待用户完成：${profile.pendingUserAction}`
            : "用户仍持有浏览器控制权"
        );
      }
      return this.stopSession(sessionIdInput);
    }
    const profile = this.requireSessionProfile(sessionIdInput);
    const now = iso(this.now());
    profile.ownership = "user";
    profile.agentHealth = "waiting";
    profile.driverState = "parked";
    profile.reconnectAttempt = undefined;
    profile.reconnectDeadlineAt = undefined;
    profile.lastDisconnectReason = undefined;
    profile.pendingUserAction = optionalString(pendingUserAction);
    profile.controlGeneration += 1;
    profile.updatedAt = now;
    if (profile.sessions) {
      for (const member of Object.values(profile.sessions)) {
        member.agentHealth = "waiting";
        member.driverState = "parked";
        member.reconnectAttempt = undefined;
        member.reconnectDeadlineAt = undefined;
        member.lastDisconnectReason = undefined;
        member.controlGeneration = profile.controlGeneration;
        member.updatedAt = now;
      }
    }
    this.persist(reason, profile, true);
    return cloneProfile(profile);
  }

  returnToAgent(sessionIdInput: string): GatewayProfileBinding {
    const profile = this.requireSessionProfile(sessionIdInput);
    if (profile.sessionStatus !== "active") {
      throw new BrowserGatewayControlError("AGENT_TASK_STOPPED", "Agent Session 已结束");
    }
    const now = iso(this.now());
    profile.ownership = "agent";
    profile.driverState = "connected";
    profile.agentHealth = "online";
    profile.reconnectAttempt = undefined;
    profile.reconnectDeadlineAt = undefined;
    profile.lastDisconnectReason = undefined;
    profile.pendingUserAction = undefined;
    profile.controlGeneration += 1;
    profile.updatedAt = now;
    if (profile.sessions) {
      for (const member of Object.values(profile.sessions)) {
        member.driverState = "connected";
        member.agentHealth = "online";
        member.reconnectAttempt = undefined;
        member.reconnectDeadlineAt = undefined;
        member.lastDisconnectReason = undefined;
        member.controlGeneration = profile.controlGeneration;
        member.updatedAt = now;
      }
    }
    this.persist("user-return", profile, true);
    return cloneProfile(profile);
  }

  stopSession(sessionIdInput: string, options: { allSessions?: boolean } = {}): GatewayProfileBinding {
    const targetSessionId = safeId(sessionIdInput, "sessionId");
    const profile = this.requireSessionProfile(targetSessionId);
    const now = iso(this.now());

    if (!options.allSessions && profile.sessions) {
      const remainingIds = Object.keys(profile.sessions).filter((id) => id !== targetSessionId);
      if (remainingIds.length > 0) {
        delete profile.sessions[targetSessionId];
        this.profilePortBySession.delete(targetSessionId);
        if (profile.ownerSessionId === targetSessionId) {
          const promoted = profile.sessions[remainingIds[0]];
          profile.ownerSessionId = promoted.sessionId;
          profile.daemonInstanceId = promoted.daemonInstanceId;
          profile.daemonPid = promoted.daemonPid;
          profile.driverKind = promoted.driverKind;
          profile.driverLabel = promoted.driverLabel;
          profile.targetId = promoted.targetId;
          profile.exclusive = promoted.exclusive;
          profile.agent = promoted.agent;
          profile.project = promoted.project;
          profile.branch = promoted.branch;
          profile.agentHealth = promoted.agentHealth;
          profile.driverState = promoted.driverState;
          profile.reconnectAttempt = promoted.reconnectAttempt;
          profile.reconnectDeadlineAt = promoted.reconnectDeadlineAt;
          profile.lastDisconnectReason = promoted.lastDisconnectReason;
        }
        if (Object.keys(profile.sessions).length <= 1 && !profile.targetId) {
          delete profile.sessions;
        }
        profile.updatedAt = now;
        this.persist("session-stopped", profile, false);
        return cloneProfile(profile);
      }
    }

    if (profile.ownerSessionId) {
      this.profilePortBySession.delete(profile.ownerSessionId);
    }
    if (profile.sessions) {
      for (const id of Object.keys(profile.sessions)) {
        this.profilePortBySession.delete(id);
      }
    }
    this.profilePortBySession.delete(targetSessionId);
    profile.ownership = "user";
    profile.sessionStatus = "stopped";
    profile.agentHealth = "offline";
    profile.driverState = "disconnected";
    profile.reconnectAttempt = undefined;
    profile.reconnectDeadlineAt = undefined;
    profile.lastDisconnectReason = undefined;
    profile.controlGeneration += 1;
    profile.ownerSessionId = undefined;
    profile.daemonInstanceId = undefined;
    profile.daemonPid = undefined;
    profile.driverKind = undefined;
    profile.driverLabel = undefined;
    profile.targetId = undefined;
    profile.exclusive = undefined;
    profile.sessions = undefined;
    profile.agent = undefined;
    profile.project = undefined;
    profile.branch = undefined;
    profile.pendingUserAction = undefined;
    profile.updatedAt = now;
    this.persist("session-stopped", profile, true);
    return cloneProfile(profile);
  }

  markAgentReconnecting(
    sessionIdInput: string,
    reconnectDeadlineAt: string,
    reason = "driver-disconnected",
    driverState: "connecting" | "reconnecting" = "reconnecting"
  ): GatewayProfileBinding {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const profile = this.requireSessionProfile(sessionId);
    if (profile.sessionStatus !== "active" || profile.ownership !== "agent") {
      return cloneProfile(profile);
    }
    const now = iso(this.now());
    if (profile.ownerSessionId !== sessionId && profile.sessions?.[sessionId]) {
      const member = profile.sessions[sessionId];
      member.reconnectAttempt = member.driverState === "connecting" ? Math.max(1, member.reconnectAttempt || 0) : 0;
      member.agentHealth = "offline";
      member.driverState = driverState;
      member.reconnectDeadlineAt = reconnectDeadlineAt;
      member.lastDisconnectReason = optionalString(reason);
      member.updatedAt = now;
      profile.updatedAt = now;
      this.persist(driverState === "connecting" ? "driver-connecting" : "driver-reconnecting", profile);
      return cloneProfile(profile);
    }
    const reconnectAttempt = profile.driverState === "connecting"
      ? Math.max(1, profile.reconnectAttempt || 0)
      : 0;
    profile.agentHealth = "offline";
    profile.driverState = driverState;
    profile.reconnectAttempt = reconnectAttempt;
    profile.reconnectDeadlineAt = reconnectDeadlineAt;
    profile.lastDisconnectReason = optionalString(reason);
    profile.updatedAt = now;
    if (profile.sessions?.[sessionId]) {
      profile.sessions[sessionId] = buildPrimarySessionBinding(profile);
    }
    this.persist(driverState === "connecting" ? "driver-connecting" : "driver-reconnecting", profile);
    return cloneProfile(profile);
  }

  markAgentConnected(sessionIdInput: string, daemonInstanceIdInput?: string): GatewayProfileBinding {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const profile = this.requireSessionProfile(sessionId);
    const daemonInstanceId = daemonInstanceIdInput ? safeId(daemonInstanceIdInput, "daemonInstanceId") : undefined;
    if (profile.ownerSessionId !== sessionId && profile.sessions?.[sessionId]) {
      const member = profile.sessions[sessionId];
      if (daemonInstanceId && member.daemonInstanceId !== daemonInstanceId) {
        throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway 连接所有者已变化");
      }
      if (profile.sessionStatus !== "active" || profile.ownership !== "agent") {
        return cloneProfile(profile);
      }
      const now = iso(this.now());
      member.agentHealth = "online";
      member.driverState = "connected";
      member.reconnectAttempt = undefined;
      member.reconnectDeadlineAt = undefined;
      member.lastDisconnectReason = undefined;
      member.updatedAt = now;
      profile.updatedAt = now;
      this.persist("driver-connected", profile);
      return cloneProfile(profile);
    }
    if (daemonInstanceId && profile.daemonInstanceId !== daemonInstanceId) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway 连接所有者已变化");
    }
    if (profile.sessionStatus !== "active" || profile.ownership !== "agent") {
      return cloneProfile(profile);
    }
    const now = iso(this.now());
    profile.agentHealth = "online";
    profile.driverState = "connected";
    profile.reconnectAttempt = undefined;
    profile.reconnectDeadlineAt = undefined;
    profile.lastDisconnectReason = undefined;
    profile.updatedAt = now;
    if (profile.sessions?.[sessionId]) {
      profile.sessions[sessionId] = buildPrimarySessionBinding(profile);
    }
    this.persist("driver-connected", profile);
    return cloneProfile(profile);
  }

  prepareDaemonRestart(sessionIdInput: string, daemonInstanceIdInput: string): string {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const daemonInstanceId = safeId(daemonInstanceIdInput, "daemonInstanceId");
    const profile = this.requireSessionProfile(sessionId);
    const memberDaemonId = profile.ownerSessionId === sessionId
      ? profile.daemonInstanceId
      : profile.sessions?.[sessionId]?.daemonInstanceId;
    if (memberDaemonId !== daemonInstanceId) {
      throw new BrowserGatewayControlError("DAEMON_RESTART_NOT_AUTHORIZED", "当前 daemon 身份不匹配");
    }
    const nonce = randomUUID();
    this.restartGrants.set(nonce, {
      nonce,
      sessionId,
      publicPort: profile.publicPort,
      previousDaemonInstanceId: daemonInstanceId,
      expiresAt: this.now() + RESTART_NONCE_TTL_MS
    });
    if (profile.sessions && Object.keys(profile.sessions).length > 1) {
      profile.updatedAt = iso(this.now());
      this.persist("daemon-restart-prepared", profile, false);
      return nonce;
    }
    profile.controlGeneration += 1;
    profile.updatedAt = iso(this.now());
    this.persist("daemon-restart-prepared", profile, true);
    return nonce;
  }

  getProfile(publicPort: number): GatewayProfileBinding | null {
    const profile = this.profilesByPort.get(validPort(publicPort));
    return profile ? cloneProfile(profile) : null;
  }

  getProfileForSession(sessionIdInput: string): GatewayProfileBinding | null {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const port = this.profilePortBySession.get(sessionId);
    return port === undefined ? null : this.getProfile(port);
  }

  snapshot(): GatewayControlSnapshot {
    return {
      version: STATE_VERSION,
      updatedAt: iso(this.now()),
      profiles: [...this.profilesByPort.values()].sort((a, b) => a.publicPort - b.publicPort).map(cloneProfile)
    };
  }

  private requireProfile(publicPort: number): GatewayProfileBinding {
    const profile = this.profilesByPort.get(publicPort);
    if (!profile) {
      throw new BrowserGatewayControlError("GATEWAY_PROFILE_NOT_FOUND", `Gateway 未注册端口 ${publicPort}`);
    }
    return profile;
  }

  private requireSessionProfile(sessionIdInput: string): GatewayProfileBinding {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const port = this.profilePortBySession.get(sessionId);
    if (port === undefined) {
      throw new BrowserGatewayControlError("GATEWAY_PROFILE_NOT_FOUND", `Session ${sessionId} 未绑定 Profile`);
    }
    return this.requireProfile(port);
  }

  private issueClaims(
    profile: GatewayProfileBinding,
    daemonInstanceId: string,
    kind: "agent" | "internal",
    sessionIdOverride?: string,
    targetId?: string
  ): GatewayTicketClaims {
    const now = this.now();
    return {
      version: TICKET_VERSION,
      ticketId: randomUUID(),
      sessionId: kind === "internal" ? `internal:${process.pid}` : (sessionIdOverride || profile.ownerSessionId as string),
      profileId: profile.profileId,
      publicPort: profile.publicPort,
      daemonInstanceId,
      controlGeneration: profile.controlGeneration,
      ...(targetId ? { targetId } : {}),
      issuedAt: now,
      expiresAt: now + this.ticketTtlMs,
      kind
    };
  }

  private signClaims(claims: GatewayTicketClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyTicket(ticket: string): GatewayTicketClaims {
    const [payload, signature, extra] = String(ticket || "").split(".");
    if (!payload || !signature || extra) {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 格式错误");
    }
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 签名错误");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 签名错误");
    }
    let claims: Partial<GatewayTicketClaims>;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<GatewayTicketClaims>;
    } catch {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 内容错误");
    }
    if (
      claims.version !== TICKET_VERSION ||
      !claims.ticketId ||
      !claims.sessionId ||
      !claims.profileId ||
      !claims.publicPort ||
      !claims.daemonInstanceId ||
      !Number.isSafeInteger(claims.controlGeneration) ||
      !Number.isFinite(claims.issuedAt) ||
      !Number.isFinite(claims.expiresAt) ||
      (claims.kind !== "agent" && claims.kind !== "internal")
    ) {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_INVALID", "Gateway Ticket 字段不完整");
    }
    if ((claims.expiresAt as number) <= this.now()) {
      throw new BrowserGatewayControlError("GATEWAY_TICKET_EXPIRED", "Gateway Ticket 已过期");
    }
    return claims as GatewayTicketClaims;
  }

  private assertClaimsCurrent(claims: GatewayTicketClaims): void {
    const profile = this.requireProfile(claims.publicPort);
    if (profile.profileId !== claims.profileId) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway Ticket 控制代次已失效");
    }
    if (claims.kind === "internal") return;
    if (profile.controlGeneration !== claims.controlGeneration) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway Ticket 控制代次已失效");
    }
    if (profile.sessionStatus !== "active") {
      throw new BrowserGatewayControlError("AGENT_TASK_STOPPED", "Agent Session 已结束");
    }
    if (profile.ownership !== "agent") {
      throw new BrowserGatewayControlError("AGENT_USER_IN_CONTROL", "用户正在操作浏览器");
    }
    const isPrimary = profile.ownerSessionId === claims.sessionId && profile.daemonInstanceId === claims.daemonInstanceId;
    const secondary = profile.sessions?.[claims.sessionId];
    const isSecondary = Boolean(secondary && secondary.daemonInstanceId === claims.daemonInstanceId);
    if (!isPrimary && !isSecondary) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway Ticket 所有者已变化");
    }
  }

  private consumeRestartGrant(
    nonceInput: string | undefined,
    sessionId: string,
    publicPort: number,
    previousDaemonInstanceId: string
  ): boolean {
    const nonce = String(nonceInput || "");
    const grant = this.restartGrants.get(nonce);
    if (!grant) return false;
    this.restartGrants.delete(nonce);
    return (
      grant.expiresAt > this.now() &&
      grant.sessionId === sessionId &&
      grant.publicPort === publicPort &&
      grant.previousDaemonInstanceId === previousDaemonInstanceId
    );
  }

  private pruneEphemeralState(): void {
    const now = this.now();
    for (const [ticketId, expiresAt] of this.consumedTickets) {
      if (expiresAt <= now) this.consumedTickets.delete(ticketId);
    }
    for (const [nonce, grant] of this.restartGrants) {
      if (grant.expiresAt <= now) this.restartGrants.delete(nonce);
    }
  }

  private persist(reason: string, profile: GatewayProfileBinding, revoke = false): void {
    this.persistSnapshot();
    this.onEvent?.({ type: "profile-updated", profile: cloneProfile(profile), reason });
    if (revoke) {
      this.onEvent?.({ type: "connections-revoked", profile: cloneProfile(profile), reason });
    }
  }

  private persistSnapshot(): void {
    writeJsonAtomic(this.statePath, this.snapshot());
  }

  private load(): void {
    let parsed: Partial<GatewayControlSnapshot> | null = null;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<GatewayControlSnapshot>;
    } catch {
      return;
    }
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.profiles)) return;
    for (const candidate of parsed.profiles) {
      if (!isValidProfile(candidate)) continue;
      const profile = normalizeLoadedProfile(candidate);
      this.profilesByPort.set(profile.publicPort, profile);
      if (profile.ownerSessionId && profile.sessionStatus === "active") {
        this.profilePortBySession.set(profile.ownerSessionId, profile.publicPort);
      }
      if (profile.sessions && profile.sessionStatus === "active") {
        for (const memberId of Object.keys(profile.sessions)) {
          this.profilePortBySession.set(memberId, profile.publicPort);
        }
      }
    }
  }
}

function buildPrimarySessionBinding(profile: GatewayProfileBinding): GatewaySessionBinding {
  return {
    sessionId: profile.ownerSessionId as string,
    daemonInstanceId: profile.daemonInstanceId as string,
    daemonPid: profile.daemonPid,
    driverKind: profile.driverKind || "agent-browser",
    driverLabel: profile.driverLabel,
    ...(profile.targetId ? { targetId: profile.targetId } : {}),
    ...(profile.exclusive ? { exclusive: true } : {}),
    agent: profile.agent,
    project: profile.project,
    branch: profile.branch,
    agentHealth: profile.agentHealth,
    driverState: profile.driverState,
    reconnectAttempt: profile.reconnectAttempt,
    reconnectDeadlineAt: profile.reconnectDeadlineAt,
    lastDisconnectReason: profile.lastDisconnectReason,
    controlGeneration: profile.controlGeneration,
    updatedAt: profile.updatedAt
  };
}

function collectActiveSessions(profile: GatewayProfileBinding): Array<{
  sessionId: string;
  daemonInstanceId?: string;
  targetId?: string;
  exclusive?: boolean;
}> {
  if (profile.sessionStatus !== "active") return [];
  const byId = new Map<string, { sessionId: string; daemonInstanceId?: string; targetId?: string; exclusive?: boolean }>();
  if (profile.ownerSessionId) {
    byId.set(profile.ownerSessionId, {
      sessionId: profile.ownerSessionId,
      daemonInstanceId: profile.daemonInstanceId,
      targetId: profile.targetId,
      exclusive: profile.exclusive
    });
  }
  if (profile.sessions) {
    for (const [id, member] of Object.entries(profile.sessions)) {
      byId.set(id, {
        sessionId: id,
        daemonInstanceId: member.daemonInstanceId,
        targetId: member.targetId,
        exclusive: member.exclusive
      });
    }
  }
  return [...byId.values()];
}

function isValidProfile(value: unknown): value is GatewayProfileBinding {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<GatewayProfileBinding>;
  return Boolean(
    input.profileId &&
      input.profileName &&
      Number.isInteger(input.publicPort) &&
      input.publicPort &&
      (input.ownership === "agent" || input.ownership === "user") &&
      (input.sessionStatus === "active" || input.sessionStatus === "stopped") &&
      (input.agentHealth === "online" || input.agentHealth === "waiting" || input.agentHealth === "offline") &&
      (input.driverState === undefined ||
        input.driverState === "disconnected" ||
        input.driverState === "connecting" ||
        input.driverState === "connected" ||
        input.driverState === "reconnecting" ||
        input.driverState === "parked") &&
      Number.isSafeInteger(input.controlGeneration) &&
      input.updatedAt
  );
}

function normalizeLoadedProfile(profile: GatewayProfileBinding): GatewayProfileBinding {
  const normalized = cloneProfile(profile);
  // Old driver bindings must not be restored as agent-browser sessions.
  if (normalized.driverKind !== undefined && normalized.driverKind !== "agent-browser") {
    normalized.ownerSessionId = undefined;
    normalized.daemonInstanceId = undefined;
    normalized.daemonPid = undefined;
    normalized.driverKind = undefined;
    normalized.driverLabel = undefined;
    normalized.pendingUserAction = undefined;
    normalized.ownership = "user";
    normalized.sessionStatus = "stopped";
    normalized.agentHealth = "offline";
    normalized.driverState = "disconnected";
    normalized.controlGeneration += 1;
  }
  if (!normalized.driverState) {
    normalized.driverState = normalized.sessionStatus === "stopped"
      ? "disconnected"
      : normalized.ownership === "user"
        ? "parked"
        : normalized.agentHealth === "online"
          ? "connecting"
          : "reconnecting";
  }
  return normalized;
}

function cloneProfile(profile: GatewayProfileBinding): GatewayProfileBinding {
  return {
    ...profile,
    ...(profile.sessions
      ? {
          sessions: Object.fromEntries(
            Object.entries(profile.sessions).map(([key, value]) => [key, { ...value }])
          )
        }
      : {})
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, filePath);
  } finally {
    rmSync(temp, { force: true });
  }
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new TypeError("Gateway publicPort 必须是 1024-65535 的整数");
  }
  return value;
}

function requiredString(value: string, name: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} 不能为空`);
  return normalized;
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function normalizeDriverKind(value: GatewayDriverKind | undefined): GatewayDriverKind {
  if (value !== undefined && value !== "agent-browser") {
    throw new BrowserGatewayControlError("GATEWAY_DRIVER_UNSUPPORTED", "Gateway 仅支持 agent-browser 驱动。");
  }
  return "agent-browser";
}

function driverLabel(_kind: GatewayDriverKind): string {
  return "agent-browser";
}

function safeId(value: string, name: string): string {
  const normalized = requiredString(value, name);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TypeError(`${name} 格式非法`);
  }
  return normalized;
}

function normalizePid(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
