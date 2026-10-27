import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const remoteError = (code: string, message = code) => Object.assign(new Error(message), { code });
const idPattern = /^[a-f0-9]{32}$/;
export interface RemoteSession {
  session: string; leaseToken: string; deviceId: string; name: string; expiresAt: number; leaseSeconds: number;
}
export class RemoteSessionStore {
  readonly directory: string;
  constructor(home = os.homedir()) { this.directory = path.join(home, ".profilepilot", "remote", "sessions"); }
  private file(id: string) {
    if (!idPattern.test(id)) throw remoteError("REMOTE_INVALID_SESSION", "请使用 connect 返回的会话 ID。");
    return path.join(this.directory, `${id}.json`);
  }
  async read(id: string): Promise<RemoteSession> {
    try {
      const file = this.file(id), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error();
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.session !== id || !/^[a-f0-9]{64}$/.test(value.leaseToken)) throw new Error();
      return value;
    } catch { throw remoteError("REMOTE_SESSION_NOT_FOUND", "本机没有这个 CLI 会话；请列出 sessions 或重新 connect。"); }
  }
  async save(value: RemoteSession) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(value.session), temporary = `${file}.${randomBytes(8).toString("hex")}`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async remove(id: string) { await fs.unlink(this.file(id)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
  async list() {
    const names = await fs.readdir(this.directory).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    const sessions = [];
    for (const name of names) if (/^[a-f0-9]{32}\.json$/.test(name)) {
      const { leaseToken: _token, ...visible } = await this.read(name.slice(0, -5));
      sessions.push({ ...visible, lastKnownExpiresAt: visible.expiresAt });
    }
    return { sessions, note: "这里列出本机保存的 CLI 会话；使用 status 核对后台状态。应用重启或租约过期后需重新连接。" };
  }
}

export class RemoteControlConnection {
  private socket?: net.Socket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async start(session?: RemoteSession) {
    const file = this.env.PROFILEPILOT_REMOTE_ENDPOINT || (process.platform === "win32" && this.env.LOCALAPPDATA
      ? path.join(this.env.LOCALAPPDATA, "ClipRelay", "ai-endpoint.json") : "");
    if (!file) throw remoteError("REMOTE_PLATFORM_UNAVAILABLE", "当前远控后台由 Windows ClipRelay 提供。请在已安装应用的 Windows 电脑运行此命令。");
    let endpoint: any;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
      endpoint = JSON.parse(await fs.readFile(file, "utf8"));
    } catch { throw remoteError("REMOTE_APP_NOT_RUNNING", "未找到 ClipRelay 后台连接。请安装或启动 ClipRelay 应用；无需配置 MCP。"); }
    if (endpoint.protocol !== 1 || typeof endpoint.address !== "string" || !/^[a-f0-9]{64}$/.test(endpoint.token)
      || process.platform === "win32" && !/^\\\\\.\\pipe\\ClipRelay-AI-[a-f0-9]{32}$/.test(endpoint.address))
      throw remoteError("REMOTE_INVALID_ENDPOINT");
    const socket = this.socket = net.createConnection(endpoint.address);
    socket.setEncoding("utf8");
    let buffer = "";
    const fail = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(remoteError("REMOTE_OUTCOME_UNKNOWN", "连接中断；先观察状态，不要重放结果未知的操作。")); }
      this.pending.clear();
    };
    socket.on("error", fail); socket.on("close", fail);
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) { socket.destroy(); return; }
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); let value: any;
        try { value = JSON.parse(line); } catch { socket.destroy(); return; }
        const pending = this.pending.get(value.id); if (!pending) continue;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.ok) pending.resolve(value.result);
        else pending.reject(Object.assign(remoteError(value.code || "REMOTE_FAILED"), { requestId: value.requestId }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(remoteError("REMOTE_APP_NOT_RUNNING")); }, 5000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(remoteError("REMOTE_APP_NOT_RUNNING", "ClipRelay 后台连接不可用，请确认应用正在运行。")); });
    });
    const hello = await this.call({ token: endpoint.token, client: "cli", ...(session ? { session: session.session, leaseToken: session.leaseToken } : {}) });
    if (hello.cliLeaseProtocol !== 1) throw remoteError("REMOTE_UPDATE_REQUIRED", "请更新 ClipRelay 应用到支持 CLI 会话的版本。");
  }
  call(message: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(remoteError("REMOTE_OUTCOME_UNKNOWN", "操作超时；先观察状态，不要重放结果未知的操作。")); }, 75000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ id, ...message }) + "\n");
    });
  }
  close() { this.socket?.destroy(); }
}
