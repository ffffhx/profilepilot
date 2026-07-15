import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { GatewayControlEvent } from "./browser-gateway-control";

const DEFAULT_TIMEOUT_MS = 3_000;
export const BROWSER_GATEWAY_PROTOCOL_VERSION = 5;

export type GatewayControlRequest =
  | { action: "ping" }
  | { action: "subscribe" }
  | {
      action: "launch-profile";
      profileId: string;
      profileName: string;
      publicPort: number;
      executable: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      action: "acquire";
      publicPort: number;
      sessionId: string;
      daemonInstanceId: string;
      daemonPid?: number;
      restartNonce?: string;
      agent?: string;
      project?: string;
    }
  | {
      action: "control";
      sessionId: string;
      command: "takeover" | "complete" | "return" | "stop";
      pendingUserAction?: string;
    }
  | { action: "prepare-daemon-restart"; sessionId: string; daemonInstanceId: string }
  | {
      action: "raw-cdp";
      publicPort: number;
      sessionId: string;
      daemonInstanceId: string;
      method: string;
      params?: Record<string, unknown>;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      action: "load-unpacked-extension";
      publicPort: number;
      sessionId: string;
      daemonInstanceId: string;
      extensionPath: string;
    }
  | { action: "status" }
  | { action: "activate-agent-target"; publicPort: number }
  | { action: "unregister-profile"; publicPort: number; closeChrome?: boolean }
  | { action: "shutdown" };

export interface GatewayControlResponse {
  ok: boolean;
  error_code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface GatewayEventMessage {
  ok: true;
  event: "gateway-control";
  sequence: number;
  at: string;
  controlEvent: GatewayControlEvent;
}

export interface GatewayEventSubscription {
  ready: Promise<void>;
  close(): void;
}

export function browserGatewayRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, ".profilepilot", "gateway");
}

export function browserGatewaySocketPath(homeDir = os.homedir()): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\profilepilot-browser-gateway"
    : path.join(browserGatewayRoot(homeDir), "control.sock");
}

export function browserGatewaySecretPath(homeDir = os.homedir()): string {
  return path.join(browserGatewayRoot(homeDir), "internal.secret");
}

export function browserGatewayDaemonIdentityPath(sessionId: string, homeDir = os.homedir()): string {
  const safeSession = safeGatewayId(sessionId, "sessionId");
  return path.join(browserGatewayRoot(homeDir), "agent-daemons", `${safeSession}.id`);
}

export function readOrCreateBrowserGatewayDaemonIdentity(sessionId: string, homeDir = os.homedir()): string {
  const filePath = browserGatewayDaemonIdentityPath(sessionId, homeDir);
  try {
    const current = readFileSync(filePath, "utf8").trim();
    if (current) return safeGatewayId(current, "daemonInstanceId");
  } catch {
    // Create atomically below.
  }
  const value = `daemon-${randomUUID()}`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    try {
      const winner = readFileSync(filePath, "utf8").trim();
      if (winner) return safeGatewayId(winner, "daemonInstanceId");
    } catch {
      // Surface the original atomic-write failure.
    }
    throw error;
  }
  return value;
}

export function clearBrowserGatewayDaemonIdentity(sessionId: string, homeDir = os.homedir()): void {
  rmSync(browserGatewayDaemonIdentityPath(sessionId, homeDir), { force: true });
}

export function readBrowserGatewayInternalSecret(homeDir = os.homedir()): string | null {
  try {
    const value = readFileSync(browserGatewaySecretPath(homeDir), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function requestBrowserGateway(
  request: GatewayControlRequest,
  options: { homeDir?: string; timeoutMs?: number } = {}
): Promise<GatewayControlResponse> {
  const homeDir = options.homeDir || os.homedir();
  const socketPath = browserGatewaySocketPath(homeDir);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: GatewayControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as GatewayControlResponse);
    };
    const timer = setTimeout(() => finish(gatewayClientError("GATEWAY_TIMEOUT", "连接 ProfilePilot Gateway 超时")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(gatewayClientError("GATEWAY_UNAVAILABLE", error.message)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        finish(gatewayClientError("GATEWAY_RESPONSE_TOO_LARGE", "Gateway 响应过大"));
        return;
      }
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, boundary)) as GatewayControlResponse;
        if (!response.ok) {
          finish(gatewayClientError(response.error_code || "GATEWAY_ERROR", response.message || "Gateway 请求失败", response));
        } else {
          finish(undefined, response);
        }
      } catch (error) {
        finish(gatewayClientError("GATEWAY_INVALID_RESPONSE", error instanceof Error ? error.message : String(error)));
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

// Gateway 控制事件使用独立的长连接订阅，不和一次一请求的控制 RPC 混用。
// 自动重连由上层状态协调器负责，这里只保证一条连接内按 NDJSON 顺序交付。
export function subscribeBrowserGatewayEvents(
  handlers: {
    onEvent: (message: GatewayEventMessage) => void;
    onDisconnect?: (error?: Error) => void;
  },
  options: { homeDir?: string; timeoutMs?: number } = {}
): GatewayEventSubscription {
  const homeDir = options.homeDir || os.homedir();
  const socket = net.createConnection(browserGatewaySocketPath(homeDir));
  let buffer = "";
  let closedByCaller = false;
  let disconnected = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(() => {
    const error = gatewayClientError("GATEWAY_TIMEOUT", "订阅 ProfilePilot Gateway 事件超时");
    readyReject(error);
    socket.destroy(error);
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

  const notifyDisconnected = (error?: Error): void => {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(timer);
    if (!closedByCaller) handlers.onDisconnect?.(error);
  };

  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(`${JSON.stringify({ action: "subscribe" })}\n`));
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      socket.destroy(gatewayClientError("GATEWAY_RESPONSE_TOO_LARGE", "Gateway 事件消息过大"));
      return;
    }
    while (true) {
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) break;
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as GatewayControlResponse & {
          event?: string;
          controlEvent?: GatewayControlEvent;
          sequence?: number;
          at?: string;
        };
        if (!message.ok) {
          throw gatewayClientError(message.error_code || "GATEWAY_ERROR", message.message || "Gateway 订阅失败", message);
        }
        if (message.event === "subscribed") {
          clearTimeout(timer);
          readyResolve();
          continue;
        }
        if (message.event === "gateway-control" && message.controlEvent) {
          handlers.onEvent(message as GatewayEventMessage);
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        readyReject(normalized);
        socket.destroy(normalized);
        return;
      }
    }
  });
  socket.once("error", (error) => {
    readyReject(error);
    notifyDisconnected(error);
  });
  socket.once("close", () => notifyDisconnected());

  return {
    ready,
    close(): void {
      closedByCaller = true;
      clearTimeout(timer);
      socket.destroy();
    }
  };
}

export async function ensureBrowserGatewayDaemon(options: {
  homeDir?: string;
  runtimePath?: string;
  daemonScriptPath?: string;
  timeoutMs?: number;
} = {}): Promise<GatewayControlResponse> {
  const homeDir = options.homeDir || os.homedir();
  let incompatiblePid: number | null = null;
  try {
    const current = await requestBrowserGateway({ action: "ping" }, { homeDir, timeoutMs: 500 });
    if (current.shuttingDown !== true && current.protocolVersion === BROWSER_GATEWAY_PROTOCOL_VERSION) return current;
    if (current.shuttingDown !== true) {
      const activePorts = Array.isArray(current.ports) ? current.ports.map(Number).filter(Number.isFinite) : [];
      // Pipe 由旧 Gateway 独占；强制升级会连带关闭正在使用的 Chrome。先保持兼容运行，
      // UI 通过 state.json 文件事件实时刷新，等所有受管 Profile 自然关闭后再换 daemon。
      if (activePorts.length) {
        return { ...current, protocolUpgradeDeferred: true };
      }
      incompatiblePid = positivePid(current.pid);
      await requestBrowserGateway({ action: "shutdown" }, { homeDir, timeoutMs: 1_000 }).catch(() => undefined);
    }
  } catch {
    // Continue with a fresh daemon.
  }
  if (incompatiblePid) {
    const shutdownDeadline = Date.now() + 3_000;
    while (Date.now() < shutdownDeadline) {
      await delay(50);
      try {
        const current = await requestBrowserGateway({ action: "ping" }, { homeDir, timeoutMs: 250 });
        if (positivePid(current.pid) !== incompatiblePid) break;
      } catch {
        break;
      }
    }
  }
  const root = browserGatewayRoot(homeDir);
  mkdirSync(root, { recursive: true });
  const runtimePath = options.runtimePath || process.execPath;
  const daemonScriptPath = options.daemonScriptPath || path.join(__dirname, "browser-gateway-daemon.js");
  const child = spawn(runtimePath, [daemonScriptPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: homeDir,
      ELECTRON_RUN_AS_NODE: "1",
      PROFILEPILOT_GATEWAY_HOME: homeDir
    }
  });
  child.unref();
  const deadline = Date.now() + (options.timeoutMs || 5_000);
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    await delay(50);
    try {
      const current = await requestBrowserGateway({ action: "ping" }, { homeDir, timeoutMs: 500 });
      if (current.shuttingDown !== true && current.protocolVersion === BROWSER_GATEWAY_PROTOCOL_VERSION) return current;
      lastError = gatewayClientError("GATEWAY_SHUTTING_DOWN", "ProfilePilot Gateway 正在退出");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : gatewayClientError("GATEWAY_UNAVAILABLE", "无法启动 ProfilePilot Gateway");
}

export function gatewayHttpHeaders(homeDir = os.homedir()): Record<string, string> {
  const secret = readBrowserGatewayInternalSecret(homeDir);
  return secret ? { "x-profilepilot-internal": secret } : {};
}

function gatewayClientError(code: string, message: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const error = new Error(message) as Error & { code: string; detail?: unknown };
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeGatewayId(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(trimmed)) {
    throw gatewayClientError("GATEWAY_INVALID_ID", `无效的 ${label}`);
  }
  return trimmed;
}

function positivePid(value: unknown): number | null {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
