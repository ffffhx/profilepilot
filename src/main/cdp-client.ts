import http from "node:http";
import net from "node:net";
import { POSIX_LOCALE_ENV, execFileAsync, isRecord, sleep, stringValue } from "./fs-util";
import { CdpPendingRequest, CdpResponse, CdpTargetListEntry, CdpVersionInfo } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export class CdpBrowserClient {
  private nextId = 1;
  private readonly pending = new Map<number, CdpPendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    this.socket.addEventListener("close", () => {
      this.rejectPending(new Error("CDP 连接已关闭"));
    });
  }

  static connect(url: string, timeoutMs: number): Promise<CdpBrowserClient> {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new ProfileManagerError("当前运行环境没有 WebSocket，无法连接 Chrome CDP。", "CDP_WEBSOCKET_UNAVAILABLE");
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new ProfileManagerError("连接 Chrome CDP 超时。", "CDP_CONNECT_TIMEOUT"));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve(new CdpBrowserClient(socket));
      };
      const handleError = (): void => {
        cleanup();
        reject(new ProfileManagerError("连接 Chrome CDP 失败。", "CDP_CONNECT_FAILED"));
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }

  send<T>(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new ProfileManagerError("Chrome CDP 连接未打开。", "CDP_NOT_CONNECTED"));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProfileManagerError(`Chrome CDP 调用 ${method} 超时。`, "CDP_COMMAND_TIMEOUT"));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });

      try {
        this.socket.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.rejectPending(new Error("CDP 连接已关闭"));
    try {
      this.socket.close();
    } catch {
      // The browser may already be closed.
    }
  }

  private handleMessage(event: MessageEvent): void {
    const message = parseCdpMessage(event.data);
    if (!message || typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      const detail = message.error.message || `CDP error ${message.error.code ?? ""}`.trim();
      pending.reject(new ProfileManagerError(detail, "CDP_COMMAND_FAILED"));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function parseCdpMessage(data: unknown): CdpResponse<unknown> | null {
  try {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    } else {
      text = String(data);
    }

    const parsed = JSON.parse(text);
    return isRecord(parsed) ? (parsed as CdpResponse<unknown>) : null;
  } catch {
    return null;
  }
}

export function parseRemoteDebuggingPort(command: string): number | null {
  const match = command.match(/--remote-debugging-port(?:=|\s+)(\d{1,5})(?:\s|$)/);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  return isValidCdpPort(port) ? port : null;
}

export function makeCdpUrl(port: number | null): string | null {
  return port ? `http://127.0.0.1:${port}` : null;
}

export function normalizeCdpPortInput(portInput?: number | null): number | null {
  if (portInput === undefined || portInput === null) {
    return null;
  }

  const port = Number(portInput);
  if (!isValidCdpPort(port)) {
    throw new ProfileManagerError("CDP 端口必须是 1024-65535 之间的整数。", "INVALID_CDP_PORT");
  }

  return port;
}

export function isValidCdpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export async function findAvailableCdpPort(startPort: number): Promise<number> {
  const firstPort = isValidCdpPort(startPort) ? startPort : 9222;
  for (let port = firstPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new ProfileManagerError("没有找到可用的 CDP 端口。", "NO_CDP_PORT_AVAILABLE");
}

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: "127.0.0.1", port });
  });
}

export async function describePortOwner(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      maxBuffer: 1024 * 1024
    });
    const ownerLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("COMMAND"));
    const match = ownerLine?.match(/^(\S+)\s+(\d+)\s+/);
    if (!match) {
      return null;
    }

    const commandName = match[1];
    const pid = Number(match[2]);
    const label = await processLabelForPid(pid, commandName);
    return `${label} (PID ${pid})`;
  } catch {
    return null;
  }
}

export async function processLabelForPid(pid: number, fallback: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      maxBuffer: 1024 * 1024,
      env: POSIX_LOCALE_ENV
    });
    const command = stdout.trim();
    if (command.includes("Google Chrome.app")) {
      return "Google Chrome";
    }
    if (command.includes("Electron.app")) {
      return "Electron";
    }
    if (command.includes("node")) {
      return "node";
    }
  } catch {
    // Fall through to lsof's command name.
  }

  return fallback;
}

export async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await requestCdpVersion(port);
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }

  const detail = lastError instanceof Error && lastError.message ? `最后一次错误：${lastError.message}` : "";
  throw new ProfileManagerError(
    `Chrome 已启动，但 CDP 没有在 127.0.0.1:${port} 响应。` +
      `如果这个 Profile 已有 Chrome 实例在运行（包括之前 CDP 启动后未关闭的窗口），` +
      `新进程会移交给旧实例导致新端口不生效，请先关闭该 Profile 再重试。${detail}`,
    "CDP_NOT_READY"
  );
}

export function requestCdpVersion(port: number): Promise<void> {
  return requestCdpVersionInfo(port).then(() => undefined);
}

export function requestCdpVersionInfo(port: number): Promise<CdpVersionInfo> {
  return requestCdpJson<unknown>(port, "/json/version").then((parsed) => ({
    webSocketDebuggerUrl: isRecord(parsed) ? stringValue(parsed.webSocketDebuggerUrl) || undefined : undefined
  }));
}

export function requestCdpTargets(port: number): Promise<CdpTargetListEntry[]> {
  return requestCdpJson<unknown>(port, "/json/list").then((parsed) => {
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isRecord).map((target) => ({
      id: stringValue(target.id) || undefined,
      type: stringValue(target.type) || undefined,
      title: stringValue(target.title) || undefined,
      url: stringValue(target.url) || undefined,
      faviconUrl: stringValue(target.faviconUrl) || undefined,
      webSocketDebuggerUrl: stringValue(target.webSocketDebuggerUrl) || undefined
    }));
  });
}

// /json/close/<id> 返回纯文本（"Target is closing"），不能走 JSON 解析，只看状态码。
export function requestCdpCloseTarget(port: number, targetId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: `/json/close/${targetId}`,
        timeout: 700
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode || "unknown"}`));
            return;
          }
          resolve();
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);
  });
}

export function requestCdpJson<T>(port: number, requestPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        timeout: 700
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode || "unknown"}`));
            return;
          }

          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);
  });
}
