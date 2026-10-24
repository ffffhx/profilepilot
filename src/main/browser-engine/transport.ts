import type { ConnectOverCDPTransport } from "playwright-core";
import { EngineError } from "./arguments";

/** One authenticated Gateway socket shared by Playwright and engine commands.
 * IDs are remapped so neither caller can consume the other's responses.
 * This avoids Target.attachToBrowserTarget, which Gateway deliberately denies.
 */
export class EngineTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private sequence = 0;
  private forwarded = new Map<number, number>();
  private targets = new Map<string, string>();
  private observations = new Map<string, string | undefined>();
  private listeners = new Set<(event: any)=>void>();
  private ownSessions = new Set<string>();
  private attaching = new Set<string>();
  onEvent(listener:(event:any)=>void):()=>void { this.listeners.add(listener);return()=>this.listeners.delete(listener); }
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { this.close(); return; }
      let own = this.ownSessions.has(message.sessionId);
      if(message.method==='Target.attachedToTarget' && (own || this.attaching.has(message.params.targetInfo.targetId))) {
        this.ownSessions.add(message.params.sessionId);own=true;
      }
      if(message.method==='Target.detachedFromTarget' && this.ownSessions.delete(message.params.sessionId))own=true;
      if(message.method)for(const listener of this.listeners)listener(message);
      if (message.method === "Target.attachedToTarget") this.targets.set(message.params.sessionId, message.params.targetInfo.targetId);
      if (message.method === "Target.detachedFromTarget") this.targets.delete(message.params.sessionId);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new EngineError(message.error.message, "BROWSER_CDP_ERROR")) : pending.resolve(message.result);
        return;
      }
      if(own)return;
      if (typeof message.id === "number") {
        const original = this.forwarded.get(message.id);
        if (original === undefined) return;
        this.forwarded.delete(message.id); message.id = original;
      }
      // Native WebSocket can deliver several CDP frames in one task. Playwright
      // installs frame listeners in promise continuations after getFrameTree;
      // drain those microtasks before delivering the following context event.
      // Its own WebSocket transport uses the same per-message task boundary.
      setImmediate(() => this.onmessage?.(message));
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new EngineError("Gateway disconnected", "BROWSER_DISCONNECTED")); }
      this.pending.clear(); this.forwarded.clear();
      setImmediate(() => this.onclose?.("Gateway disconnected"));
    });
  }
  static async connect(endpoint: string): Promise<EngineTransport> {
    if (endpoint.startsWith("http")) {
      const response = await fetch(endpoint.replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new EngineError(`CDP discovery returned HTTP ${response.status}`);
      const version = await response.json() as { webSocketDebuggerUrl?: string };
      if (!version.webSocketDebuggerUrl) throw new EngineError("Missing CDP WebSocket URL");
      endpoint = version.webSocketDebuggerUrl;
    }
    const socket = new WebSocket(endpoint);
    const transport = new EngineTransport(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new EngineError("Gateway connection timed out", "BROWSER_CONNECT_TIMEOUT")); }, 15000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new EngineError("Gateway connection failed", "BROWSER_CONNECT_FAILED")); }, { once: true });
    });
    return transport;
  }
  send(message: object): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new EngineError("Gateway disconnected", "BROWSER_DISCONNECTED");
    const input = message as { id: number };
    const command = message as { method?: string; sessionId?: string; params?: unknown };
    if (command.sessionId && /^Runtime\.(evaluate|callFunctionOn)$/.test(command.method || "")) {
      const params = JSON.stringify(command.params);
      for (const marker of this.observations.keys()) if (params.includes(marker))
        this.observations.set(marker, this.targets.get(command.sessionId));
    }
    const id = ++this.sequence;
    this.forwarded.set(id, input.id);
    this.socket.send(JSON.stringify({ ...message, id }));
  }
  async identifyTarget(marker: string, evaluate: () => Promise<unknown>): Promise<string> {
    this.observations.set(marker, undefined);
    try {
      await evaluate();
      const target = this.observations.get(marker);
      if (!target) throw new EngineError("Could not identify the selected browser target", "BROWSER_TARGET_UNAVAILABLE");
      return target;
    } finally { this.observations.delete(marker); }
  }
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new EngineError("Gateway disconnected", "BROWSER_DISCONNECTED"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new EngineError(`CDP ${method} timed out`, "BROWSER_CDP_TIMEOUT")); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async attachDebug(targetId:string):Promise<string> {
    this.attaching.add(targetId);
    try { const result=await this.request('Target.attachToTarget',{targetId,flatten:true});this.ownSessions.add(result.sessionId);return result.sessionId; }
    finally { this.attaching.delete(targetId); }
  }
  close(): void { this.socket.close(); }
}
