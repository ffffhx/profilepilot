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

export interface GatewayProfileBinding {
  profileId: string;
  profileName: string;
  publicPort: number;
  chromePid?: number;
  ownerSessionId?: string;
  daemonInstanceId?: string;
  daemonPid?: number;
  agent?: string;
  project?: string;
  ownership: GatewayOwnership;
  sessionStatus: GatewaySessionStatus;
  agentHealth: GatewayAgentHealth;
  controlGeneration: number;
  updatedAt: string;
}

export interface GatewayAcquireRequest {
  publicPort: number;
  sessionId: string;
  daemonInstanceId: string;
  daemonPid?: number;
  agent?: string;
  project?: string;
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
}

export class BrowserGatewayControlError extends Error {
  constructor(
    readonly code:
      | "GATEWAY_PROFILE_NOT_FOUND"
      | "PROFILE_LEASE_CONFLICT"
      | "SESSION_ALREADY_BOUND"
      | "SESSION_DAEMON_DUPLICATE"
      | "AGENT_USER_IN_CONTROL"
      | "AGENT_TASK_STOPPED"
      | "GATEWAY_TICKET_INVALID"
      | "GATEWAY_TICKET_EXPIRED"
      | "GATEWAY_TICKET_REPLAYED"
      | "CONTROL_GENERATION_STALE"
      | "DAEMON_RESTART_NOT_AUTHORIZED",
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
    this.profilesByPort.delete(port);
    this.persistSnapshot();
    this.onEvent?.({ type: "connections-revoked", profile: cloneProfile(profile), reason: "profile-unregistered" });
    return true;
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
    if (profile.ownerSessionId && profile.ownerSessionId !== sessionId) {
      throw new BrowserGatewayControlError(
        "PROFILE_LEASE_CONFLICT",
        `${profile.profileName} 已由 Session ${profile.ownerSessionId} 使用`
      );
    }
    if (profile.sessionStatus === "active" && profile.ownership === "user" && profile.ownerSessionId === sessionId) {
      throw new BrowserGatewayControlError(
        "AGENT_USER_IN_CONTROL",
        `用户正在操作 ${profile.profileName}`
      );
    }
    if (profile.sessionStatus === "stopped" && profile.ownerSessionId === sessionId) {
      throw new BrowserGatewayControlError(
        "AGENT_TASK_STOPPED",
        `Session ${sessionId} 已结束`
      );
    }

    if (
      profile.ownerSessionId === sessionId &&
      profile.daemonInstanceId &&
      profile.daemonInstanceId !== daemonInstanceId
    ) {
      if (!this.consumeRestartGrant(request.restartNonce, sessionId, publicPort, profile.daemonInstanceId)) {
        throw new BrowserGatewayControlError(
          "SESSION_DAEMON_DUPLICATE",
          `Session ${sessionId} 已有 daemon ${profile.daemonInstanceId}`
        );
      }
    }

    profile.ownerSessionId = sessionId;
    profile.daemonInstanceId = daemonInstanceId;
    profile.daemonPid = normalizePid(request.daemonPid);
    profile.agent = optionalString(request.agent);
    profile.project = optionalString(request.project);
    profile.ownership = "agent";
    profile.sessionStatus = "active";
    profile.agentHealth = "online";
    profile.updatedAt = iso(this.now());
    this.profilePortBySession.set(sessionId, publicPort);
    this.persist("acquire", profile);

    const claims = this.issueClaims(profile, daemonInstanceId, "agent");
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
    if (
      profile.ownerSessionId !== identity.sessionId ||
      profile.daemonInstanceId !== identity.daemonInstanceId
    ) {
      throw new BrowserGatewayControlError("CONTROL_GENERATION_STALE", "Gateway 连接所有者已变化");
    }
    return cloneProfile(profile);
  }

  delegateToUser(sessionIdInput: string, reason: "user_takeover" | "agent_complete"): GatewayProfileBinding {
    if (reason === "agent_complete") {
      // 任务完成是终态：不能像用户临时接管那样继续保留 active owner。
      // 关闭 Gateway Session 后，Profile 才能立即被其它任务重新选择。
      return this.stopSession(sessionIdInput);
    }
    const profile = this.requireSessionProfile(sessionIdInput);
    profile.ownership = "user";
    profile.agentHealth = "waiting";
    profile.controlGeneration += 1;
    profile.updatedAt = iso(this.now());
    this.persist(reason, profile, true);
    return cloneProfile(profile);
  }

  returnToAgent(sessionIdInput: string): GatewayProfileBinding {
    const profile = this.requireSessionProfile(sessionIdInput);
    if (profile.sessionStatus !== "active") {
      throw new BrowserGatewayControlError("AGENT_TASK_STOPPED", "Agent Session 已结束");
    }
    profile.ownership = "agent";
    profile.agentHealth = "online";
    profile.controlGeneration += 1;
    // 交还后旧 daemon 连接已经被接管动作吊销，允许同一个 daemon 重新申请 Ticket。
    profile.updatedAt = iso(this.now());
    this.persist("user-return", profile, true);
    return cloneProfile(profile);
  }

  stopSession(sessionIdInput: string): GatewayProfileBinding {
    const profile = this.requireSessionProfile(sessionIdInput);
    const sessionId = profile.ownerSessionId as string;
    profile.ownership = "user";
    profile.sessionStatus = "stopped";
    profile.agentHealth = "offline";
    profile.controlGeneration += 1;
    profile.ownerSessionId = undefined;
    profile.daemonInstanceId = undefined;
    profile.daemonPid = undefined;
    profile.agent = undefined;
    profile.project = undefined;
    profile.updatedAt = iso(this.now());
    this.profilePortBySession.delete(sessionId);
    this.persist("session-stopped", profile, true);
    return cloneProfile(profile);
  }

  markAgentOffline(sessionIdInput: string): GatewayProfileBinding {
    const profile = this.requireSessionProfile(sessionIdInput);
    profile.agentHealth = "offline";
    profile.updatedAt = iso(this.now());
    this.persist("agent-offline", profile);
    return cloneProfile(profile);
  }

  prepareDaemonRestart(sessionIdInput: string, daemonInstanceIdInput: string): string {
    const sessionId = safeId(sessionIdInput, "sessionId");
    const daemonInstanceId = safeId(daemonInstanceIdInput, "daemonInstanceId");
    const profile = this.requireSessionProfile(sessionId);
    if (profile.daemonInstanceId !== daemonInstanceId) {
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
    kind: "agent" | "internal"
  ): GatewayTicketClaims {
    const now = this.now();
    return {
      version: TICKET_VERSION,
      ticketId: randomUUID(),
      sessionId: kind === "internal" ? `internal:${process.pid}` : profile.ownerSessionId as string,
      profileId: profile.profileId,
      publicPort: profile.publicPort,
      daemonInstanceId,
      controlGeneration: profile.controlGeneration,
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
    if (
      profile.ownerSessionId !== claims.sessionId ||
      profile.daemonInstanceId !== claims.daemonInstanceId
    ) {
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
      const profile = cloneProfile(candidate);
      this.profilesByPort.set(profile.publicPort, profile);
      if (profile.ownerSessionId && profile.sessionStatus === "active") {
        this.profilePortBySession.set(profile.ownerSessionId, profile.publicPort);
      }
    }
  }
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
      Number.isSafeInteger(input.controlGeneration) &&
      input.updatedAt
  );
}

function cloneProfile(profile: GatewayProfileBinding): GatewayProfileBinding {
  return { ...profile };
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
