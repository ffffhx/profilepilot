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
import {
  createBrowserGatewayDriverLifecycle,
  type BrowserGatewayDriverLifecycle
} from "./browser-gateway-driver-lifecycle";
import { BrowserGatewayServer } from "./browser-gateway-server";
import { ChromePipeTransport } from "./browser-gateway-transport";
import { ElectronCdpTransport } from "./electron-cdp-transport";
import { focusProfileWindow } from "./chrome-launch";
import { validateUnpackedExtensionPath } from "./unpacked-extension";

const MAX_CONTROL_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_HANDOFF_REVEAL_DEADLINE_MS = 5_000;
const DEFAULT_AGENT_COMMAND_QUIESCE_TIMEOUT_MS = 5_000;
// wait-control 醒来后，Agent 还需要完成一次模型调度并重新 snapshot。10 秒在真实工具
// 往返中会把正在恢复的 Session 误判为失联；无 waiter 的 UI 交还已由 ProfileManager
// 拒绝，因此这里可以给有效接收方完整的恢复窗口。
export const DEFAULT_DRIVER_RECONNECT_GRACE_MS = 30_000;

export interface BrowserGatewayDaemonOptions {
  focusProfileWindow?: (pids: number[], signal?: AbortSignal) => Promise<boolean>;
  handoffRevealDeadlineMs?: number;
  agentCommandQuiesceTimeoutMs?: number;
  driverReconnectGraceMs?: number;
  driverLifecycle?: BrowserGatewayDriverLifecycle;
}

interface ManagedGatewayProfile {
  profileId: string;
  profileName: string;
  agentAccessDisabled: boolean;
  electronCdpPort?: number;
}

interface DriverReconnectTimer {
  publicPort: number;
  sessionId: string;
  daemonInstanceId: string;
  timer: NodeJS.Timeout;
}

export class BrowserGatewayDaemon {
  private readonly homeDir: string;
  private readonly root: string;
  private readonly socketPath: string;
  private readonly pidPath: string;
  private readonly lockPath: string;
  private readonly internalSecret: string;
  private readonly managedProfilesPath: string;
  private readonly managedProfiles = new Map<number, ManagedGatewayProfile>();
  private readonly control: BrowserGatewayControlPlane;
  private readonly gateway: BrowserGatewayServer;
  private readonly controlServer: net.Server;
  private readonly subscribers = new Set<Socket>();
  private readonly sessionControlQueues = new Map<string, Promise<void>>();
  private readonly focusProfileWindow: (pids: number[], signal?: AbortSignal) => Promise<boolean>;
  private readonly handoffRevealDeadlineMs: number;
  private readonly agentCommandQuiesceTimeoutMs: number;
  private readonly driverReconnectGraceMs: number;
  private readonly driverLifecycle: BrowserGatewayDriverLifecycle;
  private readonly driverReconnectTimers = new Map<string, DriverReconnectTimer>();
  private eventSequence = 0;
  private shuttingDown = false;
  private shutdownRequested = false;
  private electronRegistration: Promise<unknown> = Promise.resolve();

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
    this.agentCommandQuiesceTimeoutMs = Number.isFinite(options.agentCommandQuiesceTimeoutMs) && Number(options.agentCommandQuiesceTimeoutMs) > 0
      ? Math.floor(Number(options.agentCommandQuiesceTimeoutMs))
      : DEFAULT_AGENT_COMMAND_QUIESCE_TIMEOUT_MS;
    this.driverReconnectGraceMs = Number.isFinite(options.driverReconnectGraceMs) && Number(options.driverReconnectGraceMs) > 0
      ? Math.floor(Number(options.driverReconnectGraceMs))
      : DEFAULT_DRIVER_RECONNECT_GRACE_MS;
    this.driverLifecycle = options.driverLifecycle || createBrowserGatewayDriverLifecycle(homeDir);
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
        this.cancelDriverReconnectForPort(publicPort);
        void this.gateway.unregisterBackend(publicPort, false).finally(() => {
          this.control.unregisterProfile(publicPort);
        });
      },
      onAgentConnectionChange: (publicPort, active, identity) => {
        this.handleAgentConnectionChange(publicPort, active, identity.sessionId, identity.daemonInstanceId);
      },
      onAgentTargetChange: (publicPort, targetChange) => {
        const profile = this.control.getProfile(publicPort);
        if (profile) {
          this.publishControlEvent({
            type: "connection-updated",
            profile,
            reason: "agent-target-changed",
            ...(targetChange ? { targetChange } : {})
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
    for (const reconnect of this.driverReconnectTimers.values()) clearTimeout(reconnect.timer);
    this.driverReconnectTimers.clear();
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
        agentActivity: profile.ownerSessionId && profile.daemonInstanceId
          ? this.gateway.getAgentActivity(
              profile.publicPort,
              profile.ownerSessionId,
              profile.daemonInstanceId
            )
          : null,
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
    if (request.action === "attach-electron" || request.action === "reconnect-electron" || request.action === "detach-electron") {
      const operation = this.electronRegistration.catch(() => undefined).then(async () => {
        if (request.action === "detach-electron") {
          const managed = this.managedProfiles.get(request.publicPort);
          if (!managed) return { ok: true };
          if (!managed.electronCdpPort || managed.profileId !== request.profileId) throw new Error("此端口不属于该 Electron 应用。");
          const profile = this.control.getProfile(request.publicPort);
          if (profile?.ownerSessionId && profile.sessionStatus === "active") {
            await this.withSessionControlLock(profile.ownerSessionId, () => this.handleSessionControl({ action: "control", sessionId: profile.ownerSessionId!, command: "stop" }));
            this.driverLifecycle.sessionStopped(profile, "electron-detached");
          }
          this.cancelDriverReconnectForPort(request.publicPort);
          await this.gateway.unregisterBackend(request.publicPort, true);
          this.control.unregisterProfile(request.publicPort);
          this.managedProfiles.delete(request.publicPort); this.persistManagedProfiles();
          return { ok: true };
        }
        if (request.action === "reconnect-electron") {
          const managed = this.managedProfiles.get(request.publicPort);
          if (!managed?.electronCdpPort) throw new Error("未配置此 Electron Agent 端口。");
          return this.attachElectron({ ...managed, action: "attach-electron", publicPort: request.publicPort, backendPort: managed.electronCdpPort });
        }
        return this.attachElectron(request);
      });
      this.electronRegistration = operation;
      return operation;
    }
    if (request.action === "launch-profile") {
      if ([...this.managedProfiles.entries()].some(([port, profile]) => profile.electronCdpPort && (port === request.publicPort || profile.electronCdpPort === request.publicPort))) {
        throw new BrowserGatewayControlError("PROFILE_LEASE_CONFLICT", "此端口已保留给 Electron 应用，不能用于启动 Chrome。");
      }
      const managedProfile = {
        profileId: request.profileId,
        profileName: request.profileName,
        agentAccessDisabled: request.agentAccessDisabled === true
      };
      if (this.gateway.registeredPorts().includes(request.publicPort)) {
        const current = this.control.getProfile(request.publicPort);
        if (current?.profileId !== request.profileId) {
          throw new BrowserGatewayControlError(
            "PROFILE_LEASE_CONFLICT",
            `端口 ${request.publicPort} 已由 ${current?.profileName || "另一个 Profile"} 使用`
          );
        }
        this.managedProfiles.set(request.publicPort, managedProfile);
        this.persistManagedProfiles();
        const stoppedSessionId = await this.stopAgentSessionIfAccessDisabled(request.publicPort);
        return {
          ok: true,
          alreadyRunning: true,
          profile: this.control.getProfile(request.publicPort),
          stoppedSessionId
        };
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
        this.managedProfiles.set(request.publicPort, managedProfile);
        this.persistManagedProfiles();
      } catch (error) {
        transport.close();
        this.control.unregisterProfile(request.publicPort);
        throw error;
      }
      return { ok: true, chromePid: transport.child.pid, profile: this.control.getProfile(request.publicPort) };
    }
    if (request.action === "update-profile-agent-settings") {
      const managed = this.managedProfiles.get(request.publicPort);
      const current = this.control.getProfile(request.publicPort);
      if (
        (managed && managed.profileId !== request.profileId) ||
        (current && current.profileId !== request.profileId)
      ) {
        throw new BrowserGatewayControlError(
          "PROFILE_LEASE_CONFLICT",
          `端口 ${request.publicPort} 已由 ${current?.profileName || managed?.profileName || "另一个 Profile"} 使用`
        );
      }
      if (!managed && !current) {
        throw new BrowserGatewayControlError(
          "GATEWAY_PROFILE_NOT_RUNNING",
          `Gateway 没有找到端口 ${request.publicPort} 的 Profile`
        );
      }
      this.managedProfiles.set(request.publicPort, {
        profileId: request.profileId,
        profileName: request.profileName,
        agentAccessDisabled: request.agentAccessDisabled === true
      });
      this.persistManagedProfiles();
      const stoppedSessionId = await this.stopAgentSessionIfAccessDisabled(request.publicPort);
      return {
        ok: true,
        profile: this.control.getProfile(request.publicPort),
        stoppedSessionId
      };
    }
    if (request.action === "unregister-profile") {
      this.cancelDriverReconnectForPort(request.publicPort);
      await this.gateway.unregisterBackend(request.publicPort, request.closeChrome !== false);
      this.control.unregisterProfile(request.publicPort);
      this.managedProfiles.delete(request.publicPort);
      this.persistManagedProfiles();
      return { ok: true };
    }
    if (request.action === "acquire") {
      const managed = this.managedProfiles.get(request.publicPort);
      if (managed?.agentAccessDisabled) {
        throw new BrowserGatewayControlError(
          "PROFILE_AGENT_ACCESS_DISABLED",
          `Profile“${managed.profileName}”已禁止 Agent 连接`
        );
      }
      const acquired = this.control.acquire(request);
      const connectionActive = this.gateway.hasActiveAgentConnection(
        request.publicPort,
        request.sessionId,
        request.daemonInstanceId
      );
      if (!connectionActive) {
        this.beginDriverReconnect(acquired.profile, "driver-connect-pending");
      }
      return {
        ok: true,
        ticket: acquired.ticket,
        claims: acquired.claims,
        profile: acquired.profile,
        connectionActive,
        agentActivity: this.gateway.getAgentActivity(
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
    if (request.action === "reconnect-failed") {
      await this.expireDriverReconnect(request.sessionId, request.daemonInstanceId, "driver-retry-exhausted");
      return { ok: true };
    }
    if (request.action === "control") {
      return this.withSessionControlLock(request.sessionId, () => this.handleSessionControl(request));
    }
    if (request.action === "raw-cdp") {
      const result = await this.gateway.callRaw(request);
      return { ok: true, result };
    }
    if (request.action === "device-emulation") {
      return this.withSessionControlLock(request.sessionId, async () => {
        const result = await this.gateway.controlDeviceEmulation(request);
        return {
          ok: true,
          command: request.command,
          active: Boolean(
            request.command === "emulate"
              ? result
              : request.command === "status"
                ? result
                : false
          ),
          deviceEmulation: result
        };
      });
    }
    if (request.action === "load-unpacked-extension") {
      const extension = validateUnpackedExtensionPath(request.extensionPath);
      const result = await this.gateway.loadUnpackedExtension({
        publicPort: request.publicPort,
        sessionId: request.sessionId,
        daemonInstanceId: request.daemonInstanceId,
        extensionPath: extension.path,
        extensionVersion: extension.version
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
    if (request.action === "trigger-extension-action") {
      const result = await this.gateway.triggerExtensionAction(request);
      return {
        ok: true,
        result
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
    const preserveDeviceEmulation = Boolean(
      request.command === "takeover" &&
      request.preserveDeviceEmulation === true &&
      wasAgentControlled &&
      sessionProfile &&
      this.gateway.prepareDeviceEmulationUserHandoff(
        sessionProfile.publicPort,
        request.sessionId
      )
    );
    let executionQuiesced = false;
    let forcedAgentDisconnects = 0;
    if (request.command === "takeover" && wasAgentControlled && sessionProfile) {
      // 先在 Gateway 执行面封锁新命令，再等已发往 Chrome 的命令收敛。
      // 这样任何驱动即使没有本地通知机制，也不会和用户并发操作。
      const quiesced = await this.gateway.quiesceAgentSession(
        sessionProfile.publicPort,
        request.sessionId,
        this.agentCommandQuiesceTimeoutMs
      );
      if (!quiesced) {
        // User takeover has priority after the graceful deadline. A permanently
        // pending CDP request must not keep Input Guard locked forever; closing
        // the driver WebSocket detaches its CDP sessions before ownership flips.
        forcedAgentDisconnects = this.gateway.disconnectAgentSession(
          sessionProfile.publicPort,
          request.sessionId,
          "AGENT_TAKEOVER_QUIESCE_TIMEOUT"
        );
      }
      executionQuiesced = true;
    }
    if (
      request.command !== "return" &&
      !preserveDeviceEmulation &&
      sessionProfile?.sessionStatus === "active" &&
      sessionProfile.ownership === "agent"
    ) {
      await this.gateway.clearDeviceEmulationForSession(
        sessionProfile.publicPort,
        request.sessionId
      );
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
      if (preserveDeviceEmulation && sessionProfile) {
        this.gateway.cancelDeviceEmulationUserHandoff(
          sessionProfile.publicPort,
          request.sessionId
        );
      }
      if (executionQuiesced && sessionProfile) {
        this.gateway.cancelAgentQuiesce(sessionProfile.publicPort, request.sessionId);
      }
      throw error;
    }
    this.cancelDriverReconnect(request.sessionId);
    if (profile.sessionStatus === "stopped" && sessionProfile) {
      this.gateway.clearAgentTarget(sessionProfile.publicPort, request.sessionId);
    } else if (request.command === "return" && profile.ownerSessionId && profile.daemonInstanceId) {
      if (this.gateway.hasActiveAgentConnection(
        profile.publicPort,
        profile.ownerSessionId,
        profile.daemonInstanceId
      )) {
        profile = this.control.markAgentConnected(profile.ownerSessionId, profile.daemonInstanceId);
      } else {
        this.beginDriverReconnect(profile, "control-return");
      }
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
            activationTimeoutMs,
            preserveDeviceEmulation
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
      forcedAgentDisconnects,
      ...(request.revealAgentTarget === true ? {
        handoffTransitioned: wasAgentControlled,
        deviceEmulationPreserved: preserveDeviceEmulation,
        revealAttempted,
        revealedTarget,
        profileFocused,
        revealError
      } : {})
    };
  }

  private handleAgentConnectionChange(
    publicPort: number,
    active: boolean,
    sessionId: string,
    daemonInstanceId: string
  ): void {
    const profile = this.control.getProfile(publicPort);
    if (
      !profile ||
      profile.ownerSessionId !== sessionId ||
      profile.daemonInstanceId !== daemonInstanceId
    ) {
      return;
    }
    if (profile.sessionStatus !== "active" || profile.ownership !== "agent") {
      this.publishControlEvent({
        type: "connection-updated",
        profile,
        reason: active ? "agent-connected" : "agent-disconnected"
      });
      return;
    }
    if (active) {
      const recoveredFromDisconnect = profile.driverState === "reconnecting";
      this.cancelDriverReconnect(sessionId);
      try {
        const connected = this.control.markAgentConnected(sessionId, daemonInstanceId);
        if (recoveredFromDisconnect) {
          this.driverLifecycle.connected(connected);
        }
        this.publishControlEvent({
          type: "connection-updated",
          profile: connected,
          reason: "agent-connected"
        });
      } catch {
        // The connection lost the ownership race; its next command will be rejected.
      }
      return;
    }
    if (this.gateway.hasActiveAgentConnection(publicPort, sessionId, daemonInstanceId)) {
      return;
    }
    this.beginDriverReconnect(profile, "agent-disconnected");
    const reconnecting = this.control.getProfile(publicPort);
    if (reconnecting) {
      this.publishControlEvent({
        type: "connection-updated",
        profile: reconnecting,
        reason: "agent-disconnected"
      });
    }
  }

  private beginDriverReconnect(profile: GatewayProfileBinding, reason: string): void {
    const sessionId = profile.ownerSessionId;
    const daemonInstanceId = profile.daemonInstanceId;
    if (
      !sessionId ||
      !daemonInstanceId ||
      profile.sessionStatus !== "active" ||
      profile.ownership !== "agent"
    ) {
      return;
    }
    const existing = this.driverReconnectTimers.get(sessionId);
    if (existing?.daemonInstanceId === daemonInstanceId && existing.publicPort === profile.publicPort) {
      return;
    }
    if (existing) {
      clearTimeout(existing.timer);
      this.driverReconnectTimers.delete(sessionId);
    }
    const reconnectDeadlineAt = new Date(Date.now() + this.driverReconnectGraceMs).toISOString();
    let reconnecting: GatewayProfileBinding;
    try {
      reconnecting = this.control.markAgentReconnecting(
        sessionId,
        reconnectDeadlineAt,
        reason,
        reason === "driver-connect-pending" ? "connecting" : "reconnecting"
      );
    } catch {
      return;
    }
    if (reconnecting.driverState === "reconnecting") {
      this.driverLifecycle.reconnecting(reconnecting, reconnectDeadlineAt);
    }
    const timer = setTimeout(() => {
      void this.expireDriverReconnect(sessionId, daemonInstanceId, "driver-reconnect-timeout");
    }, this.driverReconnectGraceMs);
    timer.unref?.();
    this.driverReconnectTimers.set(sessionId, {
      publicPort: profile.publicPort,
      sessionId,
      daemonInstanceId,
      timer
    });
  }

  private cancelDriverReconnect(sessionId: string): void {
    const reconnect = this.driverReconnectTimers.get(sessionId);
    if (!reconnect) return;
    clearTimeout(reconnect.timer);
    this.driverReconnectTimers.delete(sessionId);
  }

  private cancelDriverReconnectForPort(publicPort: number): void {
    for (const reconnect of [...this.driverReconnectTimers.values()]) {
      if (reconnect.publicPort === publicPort) this.cancelDriverReconnect(reconnect.sessionId);
    }
  }

  private async expireDriverReconnect(
    sessionId: string,
    daemonInstanceId: string,
    reason: string
  ): Promise<void> {
    await this.withSessionControlLock(sessionId, async () => {
      const profile = this.control.getProfileForSession(sessionId);
      if (
        !profile ||
        profile.daemonInstanceId !== daemonInstanceId ||
        profile.sessionStatus !== "active" ||
        profile.ownership !== "agent"
      ) {
        this.cancelDriverReconnect(sessionId);
        return;
      }
      if (this.gateway.hasActiveAgentConnection(profile.publicPort, sessionId, daemonInstanceId)) {
        this.cancelDriverReconnect(sessionId);
        this.control.markAgentConnected(sessionId, daemonInstanceId);
        return;
      }

      this.cancelDriverReconnect(sessionId);
      const stopped = this.control.stopSession(sessionId);
      this.gateway.clearAgentTarget(profile.publicPort, sessionId);
      this.driverLifecycle.sessionStopped(profile, "reconnect-exhausted");
      this.publishControlEvent({
        type: "connection-updated",
        profile: stopped,
        reason
      });
    });
  }

  private async stopAgentSessionIfAccessDisabled(publicPort: number): Promise<string | null> {
    if (!this.managedProfiles.get(publicPort)?.agentAccessDisabled) return null;
    const profile = this.control.getProfile(publicPort);
    const sessionId = profile?.ownerSessionId;
    if (!profile || !sessionId || profile.sessionStatus !== "active") return null;
    await this.withSessionControlLock(sessionId, async () => {
      const current = this.control.getProfile(publicPort);
      if (
        !current ||
        current.ownerSessionId !== sessionId ||
        current.sessionStatus !== "active"
      ) {
        return;
      }
      await this.handleSessionControl({
        action: "control",
        sessionId,
        command: "stop"
      });
      this.driverLifecycle.sessionStopped(current, "agent-access-disabled");
    });
    return sessionId;
  }

  private async focusGatewayProfile(profile: GatewayProfileBinding, signal?: AbortSignal): Promise<boolean> {
    if (!profile.chromePid) {
      throw new Error("Gateway 没有记录这个 Chrome Profile 的进程，无法精确带到台前");
    }
    const focused = await this.focusProfileWindow([profile.chromePid], signal);
    if (!focused) {
      throw new Error(`${process.platform === "win32" ? "Windows" : "macOS"} 没有确认目标 Chrome Profile 已到台前`);
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
          this.managedProfiles.set(publicPort, {
            profileId,
            profileName,
            agentAccessDisabled: candidate?.agentAccessDisabled === true,
            ...(Number.isInteger(candidate?.electronCdpPort) && candidate.electronCdpPort >= 1024 && candidate.electronCdpPort <= 65535
              ? { electronCdpPort: candidate.electronCdpPort } : {})
          });
        }
      }
    } catch {
      // First run or a recoverable catalog corruption.
    }
  }

  private async attachElectron(request: Extract<GatewayControlRequest, { action: "attach-electron" }>): Promise<GatewayControlResponse> {
    const { publicPort, backendPort, profileId, profileName } = request;
    if (![publicPort, backendPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
      || publicPort === backendPort || !/^local-app:[a-f0-9-]{36}$/i.test(profileId) || !profileName?.trim()) {
      throw new Error("Electron Agent 连接配置无效；Agent 端口必须与应用调试端口不同。");
    }
    for (const [port, managed] of this.managedProfiles) {
      if ((port === publicPort && (managed.profileId !== profileId || managed.electronCdpPort !== backendPort))
        || (port !== publicPort && (managed.profileId === profileId || managed.electronCdpPort === backendPort))
        || port === backendPort || managed.electronCdpPort === publicPort) {
        throw new BrowserGatewayControlError("PROFILE_LEASE_CONFLICT", "应用或端口已有 Gateway 绑定，请先解除原连接。");
      }
    }
    if (this.gateway.registeredPorts().includes(publicPort)) {
      const current = this.control.getProfile(publicPort);
      if (current?.profileId !== profileId) throw new BrowserGatewayControlError("PROFILE_LEASE_CONFLICT", "Agent 端口已被其他应用使用。");
      return { ok: true, alreadyRunning: true, profile: current };
    }
    const transport = await ElectronCdpTransport.connect(backendPort);
    try {
      const chromePid = await transport.browserPid();
      // A new application lifetime never revives the previous Agent's ownership.
      this.control.unregisterProfile(publicPort);
      this.control.registerProfile({ profileId, profileName, publicPort, chromePid });
      await this.gateway.registerBackend({ publicPort, backend: transport, kind: "electron" });
      this.managedProfiles.set(publicPort, { profileId, profileName, agentAccessDisabled: false, electronCdpPort: backendPort });
      this.persistManagedProfiles();
      return { ok: true, profile: this.control.getProfile(publicPort) };
    } catch (error) {
      transport.close(); this.control.unregisterProfile(publicPort); throw error;
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
