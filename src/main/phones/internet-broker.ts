import { randomUUID } from "node:crypto";

export interface InternetCommand {
  id: string;
  connectionId: string;
  method: string;
  body: unknown;
  expiresAt: number;
}
export interface InternetFault extends Error {
  code: string;
  actionOutcome: "not-executed" | "unknown";
}
export function internetFault(code: string, message: string, dispatched = false): InternetFault {
  return Object.assign(new Error(message), { code, actionOutcome: dispatched ? "unknown" as const : "not-executed" as const });
}

const methods = new Set([
  "sync", "start", "pause", "resume", "stop", "action", "screenshot-chunk", "unattended",
  "accessibility-recovery", "package-inspect", "package-launch", "package-install", "package-install-status",
  "package-install-cancel", "package-install-receipt", "wake"
]);
type Job = {
  command: InternetCommand;
  dispatched: boolean;
  timer: ReturnType<typeof setTimeout>;
  finish(error?: InternetFault, value?: unknown): void;
};
type Waiter = { finish(command: InternetCommand | null): void };
type Channel = {
  connectionId: string;
  jobs: Map<string, Job>;
  // Receipt identifiers only: responses and screen contents are not retained.
  completed: Set<string>;
  waiter?: Waiter;
};
interface Options {
  now?: () => number;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
  maxPending?: number;
}

/**
 * Authenticated phone connections pull commands from their owning desktop.
 * Authentication is the HTTPS endpoint's responsibility. A poll is transport
 * availability, never a session heartbeat, input permission or automatic resume.
 */
export class InternetPhoneBroker {
  private channels = new Map<string, Channel>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: Options = {}) { this.now = options.now || Date.now; }

  connect(id: string, connectionId: string): { replaced: boolean } {
    if (this.closed) throw internetFault("PHONE_SERVICE_UNAVAILABLE", "外网控制服务已关闭。");
    const old = this.channels.get(id);
    if (old?.connectionId === connectionId) return { replaced: false };
    if (old) this.disconnect(id);
    this.channels.set(id, { connectionId, jobs: new Map(), completed: new Set() });
    return { replaced: !!old };
  }
  connection(id: string): string | undefined { return this.channels.get(id)?.connectionId; }

  private channel(id: string, connectionId?: string): Channel {
    const channel = this.channels.get(id);
    if (!channel || connectionId !== undefined && channel.connectionId !== connectionId)
      throw internetFault("PHONE_CONNECTION_REQUIRED", "外网连接已改变，请重新核对手机状态。");
    return channel;
  }
  private take(channel: Channel): InternetCommand | null {
    for (const job of channel.jobs.values()) {
      if (job.dispatched) continue;
      if (job.command.expiresAt <= this.now()) {
        job.finish(internetFault("PHONE_REQUEST_EXPIRED", "外网请求在发送前已过期。"));
        continue;
      }
      job.dispatched = true;
      return structuredClone(job.command);
    }
    return null;
  }

  request(id: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!methods.has(method)) return Promise.reject(internetFault("PHONE_OPERATION_UNSUPPORTED", "此操作不支持外网控制连接。"));
    let channel: Channel;
    let copied: unknown;
    try {
      channel = this.channel(id);
      if (signal?.aborted) throw internetFault("PHONE_CANCELLED", "外网请求已取消，尚未发送。");
      const encoded = JSON.stringify(body);
      if (!encoded || Buffer.byteLength(encoded) > 65536) throw internetFault("PHONE_INVALID_REQUEST", "外网控制请求过大或无效。");
      copied = JSON.parse(encoded);
      if (channel.jobs.size >= (this.options.maxPending ?? 16)) throw internetFault("PHONE_TARGET_BUSY", "手机有过多待确认请求，请先核对结果。");
    } catch (error) { return Promise.reject(error); }
    const timeout = this.options.requestTimeoutMs ?? 10000;
    return new Promise((resolve, reject) => {
      const command: InternetCommand = { id: randomUUID(), connectionId: channel.connectionId, method, body: copied, expiresAt: this.now() + timeout };
      let finished = false;
      const abort = () => job.finish(internetFault("PHONE_CANCELLED", "外网请求已取消，请核对已发送操作的结果。", job.dispatched));
      const job: Job = {
        command, dispatched: false,
        timer: setTimeout(() => job.finish(internetFault(job.dispatched ? "PHONE_EXECUTION_UNCERTAIN" : "PHONE_REQUEST_EXPIRED",
          job.dispatched ? "手机尚未确认操作结果；不会自动重放。" : "手机尚未接收请求，请检查外网连接。", job.dispatched)), timeout),
        finish: (error, value) => {
          if (finished) return;
          finished = true; clearTimeout(job.timer); signal?.removeEventListener("abort", abort);
          channel.jobs.delete(command.id);
          if (!error) {
            channel.completed.add(command.id);
            while (channel.completed.size > 256) channel.completed.delete(channel.completed.values().next().value!);
          }
          if (error) reject(error); else resolve(value);
        }
      };
      channel.jobs.set(command.id, job);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (channel.waiter) channel.waiter.finish(this.take(channel));
    });
  }

  poll(id: string, connectionId: string, signal?: AbortSignal): Promise<InternetCommand | null> {
    let channel: Channel;
    try {
      channel = this.channel(id, connectionId);
      if (signal?.aborted) return Promise.resolve(null);
      if (channel.waiter) throw internetFault("PHONE_TARGET_BUSY", "同一外网连接已有等待请求。");
      const command = this.take(channel);
      if (command) return Promise.resolve(command);
    } catch (error) { return Promise.reject(error); }
    return new Promise(resolve => {
      let finished = false;
      const abort = () => waiter.finish(null);
      const timer = setTimeout(() => waiter.finish(null), this.options.pollTimeoutMs ?? 20000);
      const waiter: Waiter = { finish: command => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (channel.waiter === waiter) channel.waiter = undefined;
        resolve(command);
      } };
      channel.waiter = waiter;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  respond(id: string, connectionId: string, requestId: string, value: unknown): void {
    const channel = this.channel(id, connectionId);
    if (channel.completed.has(requestId)) return; // A lost HTTP acknowledgement does not repeat input.
    const job = channel.jobs.get(requestId);
    if (!job || !job.dispatched) throw internetFault("PHONE_RECEIPT_UNKNOWN", "请求已结束或尚未发送，不能用此回执恢复控制。");
    const encoded = JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw internetFault("PHONE_INVALID_RESPONSE", "手机响应过大或无效。");
    job.finish(undefined, JSON.parse(encoded));
  }

  disconnect(id: string, connectionId?: string): void {
    const channel = this.channels.get(id);
    if (!channel || connectionId !== undefined && channel.connectionId !== connectionId) return;
    this.channels.delete(id);
    channel.waiter?.finish(null);
    for (const job of [...channel.jobs.values()]) job.finish(internetFault("PHONE_DISCONNECTED", "手机外网连接已断开；不会恢复会话或重放指令。", job.dispatched));
  }
  close(): void {
    this.closed = true;
    for (const id of [...this.channels.keys()]) this.disconnect(id);
  }
}
