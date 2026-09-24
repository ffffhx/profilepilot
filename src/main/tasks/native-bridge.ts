import http from "node:http";
import type { Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GatewayWebSocketPeer } from "../browser-gateway-websocket";
import type { NativeBrowserState } from "../../shared/tasks";
import { NativeOnboarding } from "./native-onboarding";
import type { NativeInstallDriver } from "./native-installer";

interface Pairing { token: string; expiresAt: number; }
interface Connection {
  peer: GatewayWebSocketPeer; state: NativeBrowserState; generation: number; lastSeen: number;
  pending: Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
}
interface SecretStore { read(): Record<string, string>; write(value: Record<string, string>): void; }
type NativeEvent = { profileId: string; sessionId?: string; type: "state" | "cdp" | "disconnected"; method?: string; params?: any; state?: NativeBrowserState };
const equalSecret = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const NATIVE_EXTENSION_ID = "gmdaabnoocjlpimglalnbegfdaklfnaj";

// A local authenticated gateway for the extension transport. Pairing is initiated
// by the desktop and confirmed in the actual browser Profile, never inferred from
// cookies or the name of whichever Chrome window happens to be active.
export class NativeBrowserBridge {
  private readonly onboarding = new NativeOnboarding(NATIVE_EXTENSION_ID);
  private readonly server = http.createServer((req, res) => this.onboarding.handle(req, res, this.port));
  private connections = new Map<string, Connection>();
  private pairings = new Map<string, Pairing>();
  private tokens: Record<string, string> = {};
  private listeners = new Set<(event: NativeEvent) => void>();
  private nextId = 0;
  private generation = 0;
  private port = 0;
  private timer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private authorizing = new Map<string, Promise<{ url: string; expiresAt: string }>>();
  constructor(private readonly root: string, private readonly secrets: SecretStore) {
    this.server.on("upgrade", (req, socket, head) => {
      if (req.headers.origin !== `chrome-extension://${NATIVE_EXTENSION_ID}` || req.url !== "/profilepilot" || req.headers.host !== `127.0.0.1:${this.port}`) { socket.destroy(); return; }
      let peer: GatewayWebSocketPeer;
      try { peer = GatewayWebSocketPeer.accept(req, socket as Socket, head); } catch { socket.destroy(); return; }
      const timeout = setTimeout(() => peer.close(4001, "Authentication timeout"), 5000);
      peer.onClose = () => clearTimeout(timeout);
      peer.onText = text => {
        clearTimeout(timeout);
        try { this.authenticate(peer, JSON.parse(text)); } catch { peer.close(4001, "Pairing failed"); }
      };
    });
  }
  start(): Promise<void> {
    return this.starting ||= (async () => {
      this.tokens = this.secrets.read();
      const file = path.join(this.root, "extension-listener.json");
      let preferred = 0;
      if (existsSync(file)) { try { preferred = JSON.parse(readFileSync(file, "utf8")).port; } catch {} }
      if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535) preferred = 0;
      const listen = (port: number) => new Promise<void>((resolve, reject) => {
        const error = (e: Error) => { this.server.off("listening", ready); reject(e); };
        const ready = () => { this.server.off("error", error); resolve(); };
        this.server.once("error", error); this.server.once("listening", ready); this.server.listen(port, "127.0.0.1");
      });
      try { await listen(preferred); } catch { if (!preferred) throw new Error("无法启动扩展连接服务。"); await listen(0); }
      this.port = (this.server.address() as { port: number }).port;
      writeFileSync(file, JSON.stringify({ port: this.port }), { mode: 0o600 });
      this.timer = setInterval(() => {
        for (const c of this.connections.values()) if (Date.now() - c.lastSeen > 45000) c.peer.close(4000, "Extension heartbeat expired");
      }, 15000); this.timer.unref();
    })();
  }
  async pair(profileId: string): Promise<{ code: string; expiresAt: string }> {
    await this.start();
    if (this.connections.get(profileId)?.state.ownerSessionId) throw new Error("请先结束此浏览器上的任务，再重新配对。");
    const pairing = { token: randomBytes(32).toString("hex"), expiresAt: Date.now() + 5 * 60000 };
    this.pairings.set(profileId, pairing);
    const code = Buffer.from(JSON.stringify({ version: 1, port: this.port, profileId, token: pairing.token })).toString("base64url");
    return { code: `PP1.${code}`, expiresAt: new Date(pairing.expiresAt).toISOString() };
  }
  states(): NativeBrowserState[] {
    return [...new Set([...Object.keys(this.tokens), ...this.connections.keys()])].map(profileId => ({
      profileId, connected: false, ownership: "user", ...this.connections.get(profileId)?.state
    }));
  }
  authorize(profileId: string, profileName: string): Promise<{ url: string; expiresAt: string }> {
    const existing = this.authorizing.get(profileId);
    if (existing) return existing;
    const pending = this.onboarding.pending(profileId);
    if (pending) return Promise.resolve(pending);
    const work = (async () => {
      await this.start();
      if (this.connections.get(profileId)?.state.taskTabs) {
        const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
        const url = this.onboarding.create(this.port, "", profileName, expiresAt, profileId);
        this.onboarding.connected(profileId);
        return { url, expiresAt };
      }
      const pairing = await this.pair(profileId);
      return { url: this.onboarding.create(this.port, pairing.code, profileName, pairing.expiresAt, profileId), expiresAt: pairing.expiresAt };
    })();
    this.authorizing.set(profileId, work);
    void work.finally(() => { if (this.authorizing.get(profileId) === work) this.authorizing.delete(profileId); }).catch(() => {});
    return work;
  }
  configureInstallation(driver: NativeInstallDriver, changed: () => void): void { this.onboarding.configure(driver, changed); }
  beginInstallation(url: string): void { this.onboarding.start(url); }
  installationStates() { return this.onboarding.states(); }
  onEvent(listener: (event: NativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: NativeEvent): void { for (const listener of this.listeners) listener(event); }
  private authenticate(peer: GatewayWebSocketPeer, message: any): void {
    if (message?.type !== "hello" || typeof message.profileId !== "string" || !/^native:[^/\\]{1,100}$/.test(message.profileId) || !/^[a-f0-9]{64}$/.test(message.token || "")) throw new Error("Invalid pairing");
    const profileId = message.profileId;
    const pairing = this.pairings.get(profileId);
    const newlyPaired = pairing && pairing.expiresAt > Date.now() && equalSecret(pairing.token, message.token);
    if (!newlyPaired && !equalSecret(this.tokens[profileId] || "", message.token)) throw new Error("Invalid token");
    if (this.connections.has(profileId)) { peer.close(4009, "This Profile already has a connection"); return; }
    if (newlyPaired) {
      const tokens = { ...this.tokens, [profileId]: message.token };
      this.secrets.write(tokens); this.tokens = tokens; this.pairings.delete(profileId);
    }
    const connection: Connection = { peer, state: { profileId, connected: true, ownership: "user" }, generation: ++this.generation, lastSeen: Date.now(), pending: new Map() };
    this.connections.set(profileId, connection);
    peer.onText = text => {
      try { this.receive(connection, JSON.parse(text)); } catch { peer.close(4002, "Invalid message"); }
    };
    peer.onClose = () => {
      if (this.connections.get(profileId) !== connection) return;
      this.connections.delete(profileId);
      for (const p of connection.pending.values()) { clearTimeout(p.timer); p.reject(new Error("扩展连接中断；操作结果需要重新核查。")); }
      connection.pending.clear();
      this.emit({ type: "disconnected", profileId, sessionId: connection.state.ownerSessionId });
    };
    peer.sendText(JSON.stringify({ type: "welcome" }));
    this.emit({ type: "state", profileId, state: connection.state });
  }
  private receive(connection: Connection, message: any): void {
    connection.lastSeen = Date.now();
    const profileId = connection.state.profileId;
    if (message?.type === "heartbeat") { connection.peer.sendText('{"type":"heartbeat"}'); return; }
    if (message?.type === "state") {
      const state = message.state;
      if (!state || !["agent", "user"].includes(state.ownership)) throw new Error("Invalid state");
      connection.state = { profileId, connected: true, taskTabs: state.taskTabs === true, pausedByBrowser: state.pausedByBrowser === true, tabId: Number.isSafeInteger(state.tabId) ? state.tabId : undefined, ownership: state.ownership, ownerSessionId: typeof state.sessionId === "string" ? state.sessionId : undefined,
        tabTitle: typeof state.tabTitle === "string" ? state.tabTitle.slice(0, 300) : undefined, url: typeof state.url === "string" ? state.url.slice(0, 2000) : undefined };
      if (connection.state.taskTabs) this.onboarding.connected(profileId);
      this.emit({ type: "state", profileId, sessionId: connection.state.ownerSessionId, state: connection.state }); return;
    }
    if (message?.type === "cdp" && typeof message.method === "string") {
      this.emit({ type: "cdp", profileId, sessionId: connection.state.ownerSessionId, method: message.method, params: message.params }); return;
    }
    const pending = connection.pending.get(message?.id); if (!pending) return;
    connection.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error).slice(0, 1000)));
    else pending.resolve(message.result);
  }
  async request(profileId: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    const connection = this.connections.get(profileId);
    if (!connection) throw new Error("系统浏览器扩展未连接，请在该 Profile 中打开 ProfilePilot 扩展并连接。");
    const id = ++this.nextId;
    const expiresAt = Date.now() + timeoutMs;
    const step = method === "claim" ? "准备任务标签页" : method === "preview" ? "获取实时画面" : method === "cdp" && params.method === "Runtime.evaluate" ? "读取或操作当前页面" : method === "control" ? "切换浏览器控制权" : "执行浏览器操作";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error(`${step}超时。请检查授权标签页是否已加载，再继续当前任务；已发送的页面操作需要先核查结果。`)); }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer }); connection.peer.sendText(JSON.stringify({ id, method, params, expiresAt }));
    });
  }
  async disconnect(profileId: string): Promise<void> {
    await this.request(profileId, "disconnect").catch(() => {});
    this.connections.get(profileId)?.peer.close(1000, "Disconnected by user");
    delete this.tokens[profileId]; this.pairings.delete(profileId); this.secrets.write(this.tokens);
  }
  close(): void {
    this.onboarding.close();
    clearInterval(this.timer); for (const c of this.connections.values()) c.peer.close(1001, "Desktop closed");
    this.server.close();
  }
}
