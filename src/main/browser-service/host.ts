import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { NativeBrowserBridge, NativeEvent } from '../tasks/native-bridge';
import type { NativeInstallDriver } from '../tasks/native-installer';
import { nativeControlError } from '../native-control/errors';
import { BROWSER_SERVICE_VERSION } from './connection';

export class BrowserServiceHost {
  private sequence = 0;
  private clients = new Map<string, ServerResponse>();
  private desktopSessions = new Map<string, Map<string, string>>();
  private ui = new Map<string, { clientId: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private unsubscribe: () => void;
  private heartbeat: NodeJS.Timeout;
  private pendingClaims = 0;
  private stopping = false;
  constructor(private readonly bridge: NativeBrowserBridge, private readonly root: string, private readonly installer: NativeInstallDriver, private readonly shutdown: () => void) {
    bridge.configureService((req, res) => void this.handle(req, res));
    bridge.configureInstallation(installer, () => this.broadcast({ type: 'snapshot', snapshot: this.snapshot(++this.sequence) }));
    bridge.configureUi((profileId, method, params) => this.desktopUi(profileId, method, params));
    this.unsubscribe = bridge.onEvent(event => this.publishEvent(event));
    this.heartbeat = setInterval(() => this.broadcast({ type: 'heartbeat' }), 10000); this.heartbeat.unref();
  }
  private snapshot(sequence = this.sequence) {
    const states = this.bridge.states();
    return { sequence, states, installations: this.bridge.installationStates(), directSessions: states.filter(s => s.ownerSessionId && this.bridge.isDirectSession(s.profileId, s.ownerSessionId)).map(s => `${s.profileId}\n${s.ownerSessionId}`) };
  }
  private publishEvent(event: NativeEvent): void {
    this.broadcast({ type: 'event', sequence: ++this.sequence, event, directSession: Boolean(event.sessionId && this.bridge.isDirectSession(event.profileId, event.sessionId)) });
  }
  private send(res: ServerResponse, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 16 * 1024 * 1024) { res.destroy(); return; }
    res.write(JSON.stringify(value) + '\n');
  }
  private broadcast(value: unknown): void { for (const res of this.clients.values()) this.send(res, value); }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET') {
        const id = new URL(req.url!, 'http://localhost').searchParams.get('client');
        if (!id || !/^[a-f0-9-]{36}$/.test(id) || this.clients.has(id) || this.clients.size >= 4) throw new Error('桌面连接身份无效或连接过多。');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        this.clients.set(id, res); this.desktopSessions.set(id, new Map());
        res.on('close', () => this.detach(id));
        this.send(res, { type: 'snapshot', snapshot: this.snapshot() }); return;
      }
      if (req.method !== 'POST') throw new Error('浏览器服务只接受本地 POST 请求。');
      let bytes = 0; const chunks: Buffer[] = [];
      req.setTimeout(10000, () => req.destroy());
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('请求过大。'); chunks.push(chunk); }
      req.setTimeout(0);
      const { method, args, clientId } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof method !== 'string' || !Array.isArray(args)) throw new Error('浏览器服务请求无效。');
      const result = await this.invoke(method, args, clientId);
      reply(200, { ok: true, result, snapshot: this.snapshot() });
    } catch (error) {
      const failure = nativeControlError(error); reply(400, { ok: false, error: failure.message, code: failure.code });
    }
  }
  private async invoke(method: string, args: any[], clientId?: string): Promise<unknown> {
    if (this.stopping) throw new Error('浏览器服务正在停止。');
    if (method === 'ping') return { service: 'browser', version: BROWSER_SERVICE_VERSION, pid: process.pid, root: this.root };
    if (method === 'snapshot') return this.snapshot();
    if (method === 'pair') return this.bridge.pair(args[0]);
    if (method === 'authorize') {
      const result = await this.bridge.authorize(args[0], typeof args[1] === 'string' ? args[1].slice(0, 200) : args[0]);
      this.bridge.beginInstallation(result.url); return result;
    }
    if (method === 'beginInstallation') { this.bridge.beginInstallation(args[0]); return; }
    if (method === 'prepare') return this.installer.prepare?.();
    if (method === 'revealExtension') return this.installer.revealExtension?.();
    if (method === 'disconnect') return this.bridge.disconnect(args[0]);
    if (method === 'stop') {
      if (this.pendingClaims || this.bridge.hasSessions() || this.bridge.states().some(s => s.ownerSessionId)) throw new Error('仍有浏览器会话，请先 complete 或 release，再停止服务。');
      this.stopping = true; this.bridge.stopAcceptingCommands();
      this.broadcast({ type: 'stopping' });
      setTimeout(this.shutdown, 100); return { stopped: true };
    }
    if (!clientId || !this.clients.has(clientId)) throw new Error('桌面连接已断开，请重新连接浏览器服务。');
    if (method === 'ui-result') {
      const pending = this.ui.get(args[0]);
      if (!pending || pending.clientId !== clientId) throw new Error('任务响应已过期。');
      this.ui.delete(args[0]); clearTimeout(pending.timer);
      args[2] ? pending.reject(new Error(String(args[2]))) : pending.resolve(args[1]); return;
    }
    if (method === 'request') {
      const [profileId, command, params = {}, timeoutMs = 15000] = args;
      if (typeof profileId !== 'string' || typeof command !== 'string' || !params || typeof params !== 'object' || Array.isArray(params) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 310000) throw new Error('扩展请求参数无效。');
      // A desktop connection can only drive its own pp-task-* sessions. The
      // direct CLI namespace remains owned by NativeControlService.
      if (params.sessionId && (typeof params.sessionId !== 'string' || !params.sessionId.startsWith('pp-task-'))) throw new Error('桌面请求不能操作外部 CLI 会话。');
      if (params.sessionId) this.desktopSessions.get(clientId)!.set(profileId, params.sessionId);
      if (command === 'claim') this.pendingClaims++;
      let result;
      try { result = await this.bridge.request(profileId, command, params, timeoutMs); }
      finally { if (command === 'claim') this.pendingClaims--; }
      if (!this.clients.has(clientId) && command === 'claim') {
        // A claim may finish after its desktop disappears. Stop that exact
        // owner without touching any external CLI session.
        await this.pauseDesktopOwner(profileId, params.sessionId);
        throw new Error('桌面连接已断开，浏览器已交还用户。');
      }
      return result;
    }
    throw new Error(`未知浏览器服务方法：${method}`);
  }
  private async pauseDesktopOwner(profileId: string, sessionId: string): Promise<void> {
    const state = this.bridge.states().find(s => s.profileId === profileId);
    if (state?.connected && state.ownerSessionId === sessionId && !this.bridge.isDirectSession(profileId, sessionId)) await this.bridge.request(profileId, 'control', { sessionId, action: 'handoff' }).catch(() => {});
  }
  private detach(clientId: string): void {
    this.clients.delete(clientId);
    for (const [id, pending] of this.ui) if (pending.clientId === clientId) { clearTimeout(pending.timer); pending.reject(new Error('App 已关闭；浏览器服务及 CLI 连接仍可使用。')); this.ui.delete(id); }
    const sessions = this.desktopSessions.get(clientId); this.desktopSessions.delete(clientId);
    for (const [profileId, sessionId] of sessions || []) void this.pauseDesktopOwner(profileId, sessionId);
  }
  private desktopUi(profileId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = [...this.clients].at(-1);
    if (!client) {
      if (method === 'getUiState') return Promise.resolve({ taskServiceAvailable: false });
      if (method === 'setAccess') return Promise.resolve({});
      return Promise.reject(new Error('内置 AI 对话需要启动 ProfilePilot App。浏览器服务已连接，外部 Agent 可通过 CLI 使用。'));
    }
    const [clientId, res] = client, id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ui.delete(id); reject(new Error('App 任务响应超时，请检查任务状态后再操作。')); }, 35000);
      this.ui.set(id, { clientId, resolve: value => resolve({ ...(value as object), taskServiceAvailable: true }), reject, timer });
      this.send(res, { type: 'ui', id, profileId, method, params });
    });
  }
  close(): void {
    clearInterval(this.heartbeat); this.unsubscribe();
    for (const res of this.clients.values()) res.destroy();
    for (const id of [...this.clients.keys()]) this.detach(id);
  }
}
