#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  BrowserGatewayControlError,
  BrowserGatewayControlPlane,
  type GatewayControlEvent,
  type GatewayProfileBinding
} from "./browser-gateway-control";
import {
  browserGatewayRoot,
  BROWSER_GATEWAY_PROTOCOL_VERSION,
  browserGatewaySecretPath,
  browserGatewaySocketPath,
  type GatewayControlRequest,
  type GatewayControlResponse
} from "./browser-gateway-client";
import { BrowserGatewayServer } from "./browser-gateway-server";
import { ChromePipeTransport } from "./browser-gateway-transport";
import { focusProfileWindow } from "./chrome-launch";
import { validateUnpackedExtensionPath } from "./unpacked-extension";

const MAX_CONTROL_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_HANDOFF_REVEAL_DEADLINE_MS = 5_000;

export interface BrowserGatewayDaemonOptions {
  focusProfileWindow?: (pids: number[], signal?: AbortSignal) => Promise<boolean>;
  handoffRevealDeadlineMs?: number;
}

export class BrowserGatewayDaemon {
  private readonly homeDir: string;
  private readonly root: string;
  private readonly socketPath: string;
  private readonly pidPath: string;
  private readonly lockPath: string;
  private readonly internalSecret: string;
  private readonly managedProfilesPath: string;
  private readonly managedProfiles = new Map<number, { profileId: string; profileName: string }>();
  private readonly control: BrowserGatewayControlPlane;
  private readonly gateway: BrowserGatewayServer;
  private readonly controlServer: net.Server;
  private readonly subscribers = new Set<Socket>();
  private readonly sessionControlQueues = new Map<string, Promise<void>>();
  private readonly focusProfileWindow: (pids: number[], signal?: AbortSignal) => Promise<boolean>;
  private readonly handoffRevealDeadlineMs: number;
  private eventSequence = 0;
  private shuttingDown = false;
  private shutdownRequested = false;

  constructor(
    homeDir = process.env.PROFILEPILOT_GATEWAY_HOME || os.homedir(),
    options: BrowserGatewayDaemonOptions = {}
  ) {
    this.homeDir = homeDir;
    this.root = browserGatewayRoot(homeDir);
    this.socketPath = browserGatewaySocketPath(homeDir);
    this.pidPath = path.join(this.root, "daemon.pid");
    this.lockPath = path.join(this.root, "daemon.lock");
    this.managedProfilesPath = path.join(this.root, "managed-profiles.json");
    this.focusProfileWindow = options.focusProfileWindow || focusProfileWindow;
    this.handoffRevealDeadlineMs = Number.isFinite(options.handoffRevealDeadlineMs) && Number(options.handoffRevealDeadlineMs) > 0
      ? Math.floor(Number(options.handoffRevealDeadlineMs))
      : DEFAULT_HANDOFF_REVEAL_DEADLINE_MS;
    mkdirSync(this.root, { recursive: true });
    this.loadManagedProfiles();
    this.internalSecret = loadOrCreateSecret(browserGatewaySecretPath(homeDir));
    let gatewayRef: BrowserGatewayServer | null = null;
    this.control = new BrowserGatewayControlPlane({
      homeDir,
      onEvent: (event) => {
        gatewayRef?.handleControlEvent(event);
        this.publishControlEvent(event);
      }
    });
    this.gateway = new BrowserGatewayServer(this.control, {
      internalSecret: this.internalSecret,
      onBackendClose: (publicPort) => {
        void this.gateway.unregisterBackend(publicPort, false).finally(() => {
          this.control.unregisterProfile(publicPort);
        });
      },
      onAgentConnectionChange: (publicPort, active) => {
        const profile = this.control.getProfile(publicPort);
        if (profile) {
          if (
            !active &&
            profile.ownership === "agent" &&
            profile.sessionStatus === "active" &&
            profile.ownerSessionId
          ) {
            // Gateway 自己观察连接生命周期并维护 Agent 在线状态；UI 不得再靠
            // daemon pid、waiter 文件或 lease 猜测“在线”。
            this.control.markAgentOffline(profile.ownerSessionId);
            return;
          }
          this.publishControlEvent({
            type: "connection-updated",
            profile,
            reason: active ? "agent-connected" : "agent-disconnected"
          });
        }
      },
      onAgentTargetChange: (publicPort) => {
        const profile = this.control.getProfile(publicPort);
        if (profile) {
          this.publishControlEvent({
            type: "connection-updated",
            profile,
            reason: "agent-target-changed"
          });
        }
      }
    });
    gatewayRef = this.gateway;
    this.controlServer = net.createServer((socket) => this.handleControlSocket(socket));
  }

  async start(): Promise<void> {
    this.acquireDaemonLock();
    if (process.platform !== "win32") rmSync(this.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      this.controlServer.once("error", reject);
      this.controlServer.listen(this.socketPath, () => {
        this.controlServer.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      try {
        // Owner read/write only; the gateway carries browser-control authority.
        require("node:fs").chmodSync(this.socketPath, 0o600);
      } catch {
        // Best effort on filesystems without chmod semantics.
      }
    }
    writeFileSync(this.pidPath, `${process.pid}\n`, { mode: 0o600 });
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const subscriber of this.subscribers) subscriber.destroy();
    this.subscribers.clear();
    await this.gateway.close().catch(() => undefined);
    await new Promise<void>((resolve) => this.controlServer.close(() => resolve()));
    this.cleanupFiles();
  }

  private handleControlSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_CONTROL_REQUEST_BYTES) {
        handled = true;
        writeControlResponse(socket, { ok: false, error_code: "GATEWAY_REQUEST_TOO_LARGE", message: "Gateway 请求过大" });
        return;
      }
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      handled = true;
      try {
        const request = JSON.parse(buffer.slice(0, boundary)) as GatewayControlRequest;
        if (request.action === "subscribe") {
          this.addSubscriber(socket);
          return;
        }
      } catch {
        // 普通请求交给 handleRequest 统一返回结构化解析错误。
      }
      void this.handleRequest(buffer.slice(0, boundary)).then(
        (response) => writeControlResponse(socket, response),
        (error) => writeControlResponse(socket, errorResponse(error))
      );
    });
    socket.once("error", () => undefined);
  }

  private addSubscriber(socket: Socket): void {
    this.subscribers.add(socket);
    socket.write(`${JSON.stringify({ ok: true, event: "subscribed", pid: process.pid, protocolVersion: BROWSER_GATEWAY_PROTOCOL_VERSION })}\n`);
    const remove = (): void => {
      this.subscribers.delete(socket);
    };
    socket.once("close", remove);
    socket.once("error", remove);
  }

  private publishControlEvent(event: GatewayControlEvent): void {
    if (!this.subscribers.size) return;
    const payload = `${JSON.stringify({
      ok: true,
      event: "gateway-control",
      sequence: ++this.eventSequence,
      at: new Date().toISOString(),
      controlEvent: event
    })}\n`;
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.destroyed || !subscriber.writable) {
        this.subscribers.delete(subscriber);
        continue;
      }
      subscriber.write(payload);
    }
  }

  private async handleRequest(text: string): Promise<GatewayControlResponse> {
    const request = JSON.parse(text) as GatewayControlRequest;
    if (this.shutdownRequested && request.action !== "ping" && request.action !== "status" && request.action !== "shutdown") {
      return { ok: false, error_code: "GATEWAY_SHUTTING_DOWN", message: "ProfilePilot Gateway 正在退出" };
    }
    if (request.action === "ping") {
      return { ok: true, protocolVersion: BROWSER_GATEWAY_PROTOCOL_VERSION, pid: process.pid, shuttingDown: this.shutdownRequested, ports: this.gateway.registeredPorts(), managedPorts: [...this.managedProfiles.keys()].sort((a, b) => a - b) };
    }
    if (request.action === "status") {
      const snapshot = this.control.snapshot();
      const profiles = await Promise.all(snapshot.profiles.map(async (profile) => ({
        ...profile,
        connectionActive: Boolean(
          profile.ownerSessionId &&
          profile.daemonInstanceId &&
          this.gateway.hasActiveAgentConnection(
            profile.publicPort,
            profile.ownerSessionId,
            profile.daemonInstanceId
          )
        ),
        agentTarget: profile.ownerSessionId
          ? await this.gateway.getAgentTarget(profile.publicPort, profile.ownerSessionId).catch(() => null)
          : null
      })));
      return {
        ok: true,
        protocolVersion: BROWSER_GATEWAY_PROTOCOL_VERSION,
        pid: process.pid,
        shuttingDown: this.shutdownRequested,
        ports: this.gateway.registeredPorts(),
        managedPorts: [...this.managedProfiles.keys()].sort((a, b) => a - b),
        managedProfiles: [...this.managedProfiles.entries()].map(([publicPort, profile]) => ({ publicPort, ...profile })),
        state: {
          ...snapshot,
          profiles
        }
      };
    }
    if (request.action === "activate-agent-target") {
      const profile = this.control.getProfile(request.publicPort);
      if (!profile?.ownerSessionId || profile.sessionStatus !== "active") {
        return {
          ok: false,
          error_code: "AGENT_TARGET_NOT_FOUND",
          message: "当前 Profile 没有活跃的 Agent Session"
        };
      }
      const expectedSessionId = profile.ownerSessionId;
      const expectedGeneration = profile.controlGeneration;
      return this.withSessionControlLock(expectedSessionId, async () => {
        const current = this.control.getProfile(request.publicPort);
        if (
          !current ||
          current.ownerSessionId !== expectedSessionId ||
          current.sessionStatus !== "active" ||
          current.controlGeneration !== expectedGeneration
        ) {
          throw new BrowserGatewayControlError(
            "CONTROL_GENERATION_STALE",
            "Agent Session 已经变化，请重新点击显示最新标签页"
          );
        }
        const target = await this.gateway.activateAgentTarget(
          request.publicPort,
          expectedSessionId,
          expectedGeneration
        );
        let profileFocused = false;
        let focusError = null;
        try {
          profileFocused = await this.focusGatewayProfile(current);
        } catch (error) {
          // The trusted CDP path has already activated and brought the tab forward.
          // Keep that success visible while reporting that macOS could not confirm
          // the exact Profile window as the frontmost application.
          focusError = error instanceof Error ? error.message : String(error || "显示 Chrome Profile 失败");
        }
        return { ok: true, target, profileFocused, focusError };
      });
    }
    if (request.action === "launch-profile") {
      if (this.gateway.registeredPorts().includes(request.publicPort)) {
        const current = this.control.getProfile(request.publicPort);
        if (current?.profileId !== request.profileId) {
          throw new BrowserGatewayControlError(
            "PROFILE_LEASE_CONFLICT",
            `端口 ${request.publicPort} 已由 ${current?.profileName || "另一个 Profile"} 使用`
          );
        }
        this.managedProfiles.set(request.publicPort, { profileId: request.profileId, profileName: request.profileName });
        this.persistManagedProfiles();
        return { ok: true, alreadyRunning: true, profile: current };
      }
      // A persisted control record without a live route is from a previous Gateway/Chrome
      // lifetime. Never revive its old Agent ownership against a newly launched browser.
      if (this.control.getProfile(request.publicPort)) {
        this.control.unregisterProfile(request.publicPort);
      }
      const transport = ChromePipeTransport.launch({
        executable: request.executable,
        args: request.args,
        env: request.env ? { ...process.env, ...request.env } : process.env,
        cwd: request.cwd
      });
      try {
        this.control.registerProfile({
          profileId: request.profileId,
          profileName: request.profileName,
          publicPort: request.publicPort,
          chromePid: transport.child.pid
        });
        await this.gateway.registerBackend({ publicPort: request.publicPort, backend: transport });
        this.managedProfiles.set(request.publicPort, { profileId: request.profileId, profileName: request.profileName });
        this.persistManagedProfiles();
      } catch (error) {
        transport.close();
        this.control.unregisterProfile(request.publicPort);
        throw error;
      }
      return { ok: true, chromePid: transport.child.pid, profile: this.control.getProfile(request.publicPort) };
    }
    if (request.action === "unregister-profile") {
      await this.gateway.unregisterBackend(request.publicPort, request.closeChrome !== false);
      this.control.unregisterProfile(request.publicPort);
      return { ok: true };
    }
    if (request.action === "acquire") {
      const acquired = this.control.acquire(request);
      return {
        ok: true,
        ticket: acquired.ticket,
        claims: acquired.claims,
        profile: acquired.profile,
        connectionActive: this.gateway.hasActiveAgentConnection(
          request.publicPort,
          request.sessionId,
          request.daemonInstanceId
        ),
        webSocketUrl: `ws://127.0.0.1:${request.publicPort}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`
      };
    }
    if (request.action === "prepare-daemon-restart") {
      return { ok: true, restartNonce: this.control.prepareDaemonRestart(request.sessionId, request.daemonInstanceId) };
    }
    if (request.action === "control") {
      return this.withSessionControlLock(request.sessionId, () => this.handleSessionControl(request));
    }
    if (request.action === "raw-cdp") {
      const result = await this.gateway.callRaw(request);
      return { ok: true, result };
    }
    if (request.action === "load-unpacked-extension") {
      const extension = validateUnpackedExtensionPath(request.extensionPath);
      const result = await this.gateway.loadUnpackedExtension({
        publicPort: request.publicPort,
        sessionId: request.sessionId,
        daemonInstanceId: request.daemonInstanceId,
        extensionPath: extension.path
      });
      return {
        ok: true,
        result,
        extension: {
          path: extension.path,
          name: extension.name,
          version: extension.version,
          manifestVersion: extension.manifestVersion
        }
      };
    }
    if (request.action === "shutdown") {
      this.shutdownRequested = true;
      setImmediate(() => void this.stop().finally(() => process.exit(0)));
      return { ok: true };
    }
    return { ok: false, error_code: "GATEWAY_UNKNOWN_ACTION", message: "未知 Gateway 操作" };
  }

  private async handleSessionControl(
    request: Extract<GatewayControlRequest, { action: "control" }>
  ): Promise<GatewayControlResponse> {
    const sessionProfile = this.control.snapshot().profiles.find(
      (profile) => profile.ownerSessionId === request.sessionId
    );
    const wasAgentControlled = Boolean(
      sessionProfile?.sessionStatus === "active" && sessionProfile.ownership === "agent"
    );
    let executionQuiesced = false;
    if (request.command === "takeover" && wasAgentControlled && sessionProfile) {
      // 先在 Gateway 执行面封锁新命令，再等已发往 Chrome 的命令收敛。
      // 这样 Playwright/MCP 即使没有 agent-browser 的本地 notice，也不会和用户并发操作。
      const quiesced = await this.gateway.quiesceAgentSession(
        sessionProfile.publicPort,
        request.sessionId,
        5_000
      );
      if (!quiesced) {
        const error = new Error("当前浏览器命令在 5 秒内未结束，已取消接管") as Error & { code?: string };
        error.code = "AGENT_COMMAND_BUSY";
        throw error;
      }
      executionQuiesced = true;
    }
    let profile: GatewayProfileBinding;
    try {
      profile = request.command === "takeover"
        ? this.control.delegateToUser(request.sessionId, "user_takeover", request.pendingUserAction)
        : request.command === "complete"
          ? this.control.delegateToUser(request.sessionId, "agent_complete")
          : request.command === "return"
            ? this.control.returnToAgent(request.sessionId)
            : this.control.stopSession(request.sessionId);
    } catch (error) {
      if (executionQuiesced && sessionProfile) {
        this.gateway.cancelAgentQuiesce(sessionProfile.publicPort, request.sessionId);
      }
      throw error;
    }
    if (profile.sessionStatus === "stopped" && sessionProfile) {
      this.gateway.clearAgentTarget(sessionProfile.publicPort, request.sessionId);
    }

    let revealedTarget = null;
    let revealError = null;
    let profileFocused = false;
    let revealAttempted = false;
    if (
      request.command === "takeover" &&
      request.revealAgentTarget === true &&
      wasAgentControlled &&
      sessionProfile
    ) {
      revealAttempted = true;
      try {
        // delegateToUser has already revoked the Agent connection. The trusted
        // activation is pinned to that exact user-owned control generation, and
        // this whole transition is serialized against resume/stop for the Session.
        await this.withHandoffRevealDeadline(async (signal, deadlineAt) => {
          const activationTimeoutMs = Math.max(1, Math.min(1_500, deadlineAt - Date.now()));
          revealedTarget = await this.gateway.activateDelegatedAgentTarget(
            sessionProfile.publicPort,
            request.sessionId,
            profile.controlGeneration,
            activationTimeoutMs
          );
          signal.throwIfAborted();
          profileFocused = await this.focusGatewayProfile(profile, signal);
        });
      } catch (error) {
        // The takeover is already effective and must never be rolled back merely
        // because the target disappeared or macOS could not raise the exact window.
        revealError = error instanceof Error ? error.message : String(error || "显示 Agent 标签页失败");
      }
    }
    return {
      ok: true,
      profile,
      ...(request.revealAgentTarget === true ? {
        handoffTransitioned: wasAgentControlled,
        revealAttempted,
        revealedTarget,
        profileFocused,
        revealError
      } : {})
    };
  }

  private async focusGatewayProfile(profile: GatewayProfileBinding, signal?: AbortSignal): Promise<boolean> {
    if (!profile.chromePid) {
      throw new Error("Gateway 没有记录这个 Chrome Profile 的进程，无法精确带到台前");
    }
    const focused = await this.focusProfileWindow([profile.chromePid], signal);
    if (!focused) {
      throw new Error("macOS 没有确认目标 Chrome Profile 已到台前");
    }
    return true;
  }

  private async withHandoffRevealDeadline<T>(
    operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.handoffRevealDeadlineMs;
    const timeoutError = new Error(
      `自动显示 Agent 标签页超过 ${this.handoffRevealDeadlineMs}ms 截止时间`
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason || timeoutError), { once: true });
    });
    const timer = setTimeout(() => controller.abort(timeoutError), this.handoffRevealDeadlineMs);
    timer.unref?.();
    try {
      return await Promise.race([operation(controller.signal, deadlineAt), aborted]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withSessionControlLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionControlQueues.get(sessionId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionControlQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionControlQueues.get(sessionId) === tail) {
        this.sessionControlQueues.delete(sessionId);
      }
    }
  }

  private acquireDaemonLock(): void {
    try {
      mkdirSync(this.lockPath);
      writeFileSync(this.pidPath, `${process.pid}\n`, { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existingPid = readPid(this.pidPath);
    if (existingPid && isProcessAlive(existingPid)) {
      throw new Error(`ProfilePilot Gateway 已运行（PID ${existingPid}）`);
    }
    if (!existingPid) {
      throw new Error("ProfilePilot Gateway 正在启动");
    }
    rmSync(this.lockPath, { recursive: true, force: true });
    mkdirSync(this.lockPath);
    writeFileSync(this.pidPath, `${process.pid}\n`, { mode: 0o600 });
  }

  private loadManagedProfiles(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.managedProfilesPath, "utf8"));
      if (!Array.isArray(parsed?.profiles)) return;
      for (const candidate of parsed.profiles) {
        const publicPort = Number(candidate?.publicPort);
        const profileId = typeof candidate?.profileId === "string" ? candidate.profileId.trim() : "";
        const profileName = typeof candidate?.profileName === "string" ? candidate.profileName.trim() : "";
        if (Number.isInteger(publicPort) && publicPort >= 1024 && publicPort <= 65535 && profileId && profileName) {
          this.managedProfiles.set(publicPort, { profileId, profileName });
        }
      }
    } catch {
      // First run or a recoverable catalog corruption.
    }
  }

  private persistManagedProfiles(): void {
    const temporary = `${this.managedProfilesPath}.${process.pid}.${Date.now()}.tmp`;
    const profiles = [...this.managedProfiles.entries()]
      .sort(([a], [b]) => a - b)
      .map(([publicPort, profile]) => ({ publicPort, ...profile }));
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`, { mode: 0o600 });
      require("node:fs").renameSync(temporary, this.managedProfilesPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private cleanupFiles(): void {
    if (process.platform !== "win32") rmSync(this.socketPath, { force: true });
    if (readPid(this.pidPath) === process.pid) rmSync(this.pidPath, { force: true });
    rmSync(this.lockPath, { recursive: true, force: true });
  }
}

function writeControlResponse(socket: Socket, response: GatewayControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function errorResponse(error: unknown): GatewayControlResponse {
  if (error instanceof BrowserGatewayControlError) {
    return { ok: false, error_code: error.code, message: error.message, hard_stop: true };
  }
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return {
    ok: false,
    error_code: typeof candidate?.code === "string" ? candidate.code : "GATEWAY_ERROR",
    message: typeof candidate?.message === "string" ? candidate.message : String(error || "Gateway error")
  };
}

function loadOrCreateSecret(filePath: string): string {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (value) return value;
  } catch {
    // Create below.
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function readPid(filePath: string): number | null {
  try {
    const pid = Number(readFileSync(filePath, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

if (require.main === module) {
  const daemon = new BrowserGatewayDaemon();
  const shutdown = (): void => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  void daemon.start().catch((error) => {
    process.stderr.write(`[ProfilePilot Gateway] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
