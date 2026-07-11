import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface GatewayCdpBackend {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

export interface ChromePipeLaunchOptions {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// Chrome --remote-debugging-pipe 使用 fd3/fd4 传输以 NUL 分隔的 JSON CDP 消息。
// Gateway 是 Pipe 的唯一持有者；外部 Agent 只连接 Gateway WebSocket。
export class ChromePipeTransport implements GatewayCdpBackend {
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;

  private constructor(
    readonly child: ChildProcess,
    private readonly writePipe: Writable,
    private readonly readPipe: Readable
  ) {
    readPipe.on("data", (chunk: Buffer | string) => this.handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readPipe.once("error", (error) => this.finish(error));
    readPipe.once("close", () => this.finish());
    writePipe.once("error", (error) => this.finish(error));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.finish(new Error(`Chrome Pipe process exited (${detail})`));
    });
  }

  static launch(options: ChromePipeLaunchOptions): ChromePipeTransport {
    const args = options.args.filter((arg) => !arg.startsWith("--remote-debugging-port"));
    if (!args.includes("--remote-debugging-pipe")) {
      args.push("--remote-debugging-pipe");
    }
    const child = spawn(options.executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: false,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
    });
    // Chrome can be chatty on stderr; leaving an unread pipe eventually blocks the child.
    child.stderr?.resume();
    const writePipe = child.stdio[3] as Writable | null;
    const readPipe = child.stdio[4] as Readable | null;
    if (!writePipe || !readPipe || typeof writePipe.write !== "function" || typeof readPipe.on !== "function") {
      child.kill("SIGKILL");
      throw new Error("无法建立 Chrome remote-debugging-pipe");
    }
    return new ChromePipeTransport(child, writePipe as Writable, readPipe as Readable);
  }

  send(message: string): void {
    if (this.closed || !this.writePipe.writable) {
      throw new Error("Chrome Pipe 已关闭");
    }
    this.writePipe.write(`${message}\0`);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writePipe.end();
    } catch {
      // Pipe may already be gone.
    }
    try {
      this.readPipe.destroy();
    } catch {
      // Same.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    this.notifyClose();
  }

  private handleData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (true) {
      const boundary = this.pending.indexOf(0);
      if (boundary < 0) return;
      const frame = this.pending.subarray(0, boundary);
      this.pending = this.pending.subarray(boundary + 1);
      if (!frame.length) continue;
      const message = frame.toString("utf8");
      for (const listener of this.messageListeners) listener(message);
    }
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.notifyClose(error);
  }

  private notifyClose(error?: Error): void {
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.messageListeners.clear();
  }
}
