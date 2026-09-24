import http from "node:http";
import type { GatewayCdpBackend } from "./browser-gateway-transport";

// Electron keeps its own process lifetime. Closing this transport only detaches
// Gateway; it never sends Browser.close or terminates the application.
export class ElectronCdpTransport implements GatewayCdpBackend {
  private messages = new Set<(message: string) => void>();
  private closes = new Set<(error?: Error) => void>();
  private closed = false;
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      if (typeof event.data === "string") for (const listener of this.messages) listener(event.data);
    });
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish(new Error("Electron 调试连接已断开。")));
  }
  static async connect(port: number): Promise<ElectronCdpTransport> {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Electron 调试端口无效。");
    const advertised = await new Promise<string>((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/json/version", agent: false }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("Electron 调试端口未就绪。")); return; }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; if (text.length > 64 * 1024) request.destroy(new Error("Electron 调试响应过大。")); });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(text);
            if (typeof value.webSocketDebuggerUrl !== "string") throw new Error("此端口没有 Electron 界面调试入口。");
            resolve(value.webSocketDebuggerUrl);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error("Electron 调试连接超时。")), 1500);
      request.once("error", reject); request.once("close", () => clearTimeout(timer));
    });
    const url = new URL(advertised);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || Number(url.port) !== port || url.username || url.password || !url.pathname.startsWith("/devtools/browser/")) {
      throw new Error("只允许连接指定本机端口的 Electron 界面调试入口。");
    }
    url.hostname = "127.0.0.1";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => fail(), 1500);
      const fail = () => { clearTimeout(timer); socket.close(); reject(new Error("无法连接 Electron 界面调试入口。")); };
      socket.addEventListener("error", fail, { once: true });
      socket.addEventListener("open", () => {
        clearTimeout(timer); socket.removeEventListener("error", fail);
        resolve(new ElectronCdpTransport(socket));
      }, { once: true });
    });
  }
  async browserPid(): Promise<number | undefined> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { off(); resolve(undefined); }, 1000);
      const off = this.onMessage(message => {
        try {
          const response = JSON.parse(message);
          if (response.id !== -1) return;
          clearTimeout(timer); off();
          const pid = response.result?.processInfo?.find((item: { type: string }) => item.type === "browser")?.id;
          resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : undefined);
        } catch { /* Ignore unrelated events. */ }
      });
      this.send(JSON.stringify({ id: -1, method: "SystemInfo.getProcessInfo" }));
    });
  }
  send(message: string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error("Electron 调试连接已断开。");
    this.socket.send(message);
  }
  close(): void { this.socket.close(); this.finish(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
    this.messages.clear(); this.closes.clear();
  }
}
