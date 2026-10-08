import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { NativeBrowserTransport, NativeBrowserBridge, NativeConnectionState, NativeEvent } from '../tasks/native-bridge';
import type { PreparedNativeExtension } from '../tasks/native-installer';
import { ensureBrowserService } from './launcher';
import { serviceRequest, readBrowserServiceConnection, processAlive, type BrowserServiceConnection } from './connection';

/** Desktop adapter: state is streamed, commands are sent exactly once. Closing
 * this adapter never stops the service or the external CLI's sessions. */
export class BrowserServiceClient implements NativeBrowserTransport {
  private readonly id = randomUUID();
  private connection?: BrowserServiceConnection;
  private stream?: http.ClientRequest;
  private starting?: Promise<void>;
  private closed = false;
  private autoStart = true;
  private retry?: NodeJS.Timeout;
  private sequence = -1;
  private browsers: NativeConnectionState[] = [];
  private installations: ReturnType<NativeBrowserBridge['installationStates']> = [];
  private direct = new Set<string>();
  private listeners = new Set<(event: NativeEvent) => void>();
  private uiHandler?: (profileId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  constructor(private readonly root: string, private readonly changed: () => void = () => {}) {}
  states(): NativeConnectionState[] { return this.browsers.map(state => ({ ...state })); }
  installationStates() { return this.installations; }
  isDirectSession(profileId: string, sessionId: string): boolean { return this.direct.has(`${profileId}\n${sessionId}`); }
  onEvent(listener: (event: NativeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  configureUi(handler: NonNullable<BrowserServiceClient['uiHandler']>): void { this.uiHandler = handler; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('桌面浏览器连接已关闭。'));
    if (this.starting) return this.starting;
    this.starting = this.connect();
    void this.starting.catch(() => { this.starting = undefined; this.scheduleReconnect(); });
    return this.starting;
  }
  private async connect(): Promise<void> {
    const connection = this.autoStart ? await ensureBrowserService(this.root) : readBrowserServiceConnection(this.root);
    if (!connection || connection.service !== 'browser' || !processAlive(connection.pid)) throw new Error('浏览器服务已停止。');
    if (this.closed) throw new Error('桌面浏览器连接已关闭。');
    this.connection = connection; this.sequence = -1;
    await new Promise<void>((resolve, reject) => {
      let ready = false, ended = false, buffer = '';
      const req = http.get({ hostname: '127.0.0.1', port: connection.port, path: `/native-service?client=${this.id}`, headers: { Authorization: `Bearer ${connection.token}` } }, res => {
        if (res.statusCode !== 200) { res.resume(); req.destroy(new Error('浏览器服务拒绝桌面连接。')); return; }
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { req.destroy(new Error('浏览器服务事件过大。')); return; }
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              const message = JSON.parse(line);
              this.receive(message);
              if (!ready && message.type === 'snapshot') { ready = true; resolve(); }
            } catch (error) { req.destroy(error as Error); return; }
          }
        });
        res.on('error', fail); res.on('end', () => fail(new Error('浏览器服务连接已断开。')));
      });
      const fail = (error: Error) => {
        if (ended) return; ended = true;
        if (this.stream === req) {
          this.stream = undefined; this.connection = undefined; this.starting = undefined;
          const previous = this.browsers; this.browsers = previous.map(s => ({ ...s, connected: false }));
          for (const state of previous) if (state.connected) for (const listener of this.listeners) listener({ type: 'disconnected', profileId: state.profileId, sessionId: state.ownerSessionId });
          this.changed(); this.scheduleReconnect();
        }
        if (!ready) reject(error);
      };
      this.stream = req;
      req.setTimeout(25000, () => req.destroy(new Error('浏览器服务心跳超时。')));
      req.on('error', fail); req.on('close', () => fail(new Error('浏览器服务连接已关闭。')));
    });
  }
  private scheduleReconnect(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => {}); }, 2000); this.retry.unref();
  }
  private applySnapshot(snapshot: any): void {
    if (!snapshot || snapshot.sequence < this.sequence) return;
    const previous = this.browsers;
    this.sequence = snapshot.sequence; this.browsers = snapshot.states;
    this.installations = snapshot.installations; this.direct = new Set(snapshot.directSessions);
    for (const state of this.browsers) {
      const old = previous.find(s => s.profileId === state.profileId);
      if (JSON.stringify(old) === JSON.stringify(state)) continue;
      const event: NativeEvent = old?.connected && !state.connected
        ? { type: 'disconnected', profileId: state.profileId, sessionId: old.ownerSessionId }
        : { type: 'state', profileId: state.profileId, sessionId: state.ownerSessionId, state };
      for (const listener of this.listeners) listener(event);
    }
    this.changed();
  }
  private receive(message: any): void {
    if (message.type === 'stopping') this.autoStart = false;
    else if (message.type === 'snapshot') { this.autoStart = true; this.applySnapshot(message.snapshot); }
    else if (message.type === 'event') {
      const event = message.event as NativeEvent;
      const fresh = message.sequence > this.sequence;
      if (fresh) {
        this.sequence = message.sequence;
        if (event.type === 'state' && event.state) this.browsers = [...this.browsers.filter(s => s.profileId !== event.profileId), event.state];
        if (event.type === 'disconnected') this.browsers = this.browsers.map(s => s.profileId === event.profileId ? { ...s, connected: false } : s);
        if (event.sessionId) {
          const key = `${event.profileId}\n${event.sessionId}`;
          message.directSession ? this.direct.add(key) : this.direct.delete(key);
        }
      }
      // CDP events must reach observation/preview subscribers even when a
      // concurrent HTTP response already delivered a newer state snapshot.
      if (fresh || event.type === 'cdp') for (const listener of this.listeners) listener(event);
    } else if (message.type === 'ui') {
      const connection = this.connection;
      if (!connection) return;
      const handle = async () => {
        if (!this.uiHandler) throw new Error('App 任务服务尚未准备好。');
        return this.uiHandler(message.profileId, message.method, message.params);
      };
      void handle().then(value => serviceRequest(connection, 'ui-result', [message.id, value], 20000, this.id), error => serviceRequest(connection, 'ui-result', [message.id, null, String(error.message || error)], 20000, this.id)).catch(() => {});
    }
  }
  private async call(method: string, args: unknown[] = [], timeoutMs = 20000): Promise<any> {
    // An explicit App action may start a stopped service; background polling
    // must respect an explicit CLI stop and only reconnect once it is running.
    this.autoStart = true;
    await this.start();
    if (!this.connection || this.closed) throw new Error('浏览器服务已断开。');
    const response = await serviceRequest(this.connection, method, args, timeoutMs, this.id);
    this.applySnapshot(response.snapshot); return response.result;
  }
  pair(profileId: string): Promise<{ code: string; expiresAt: string }> { return this.call('pair', [profileId]); }
  authorize(profileId: string, profileName: string): Promise<{ url: string; expiresAt: string }> { return this.call('authorize', [profileId, profileName]); }
  beginInstallation(url: string): Promise<void> { return this.call('beginInstallation', [url]); }
  prepare(): Promise<PreparedNativeExtension> { return this.call('prepare'); }
  revealExtension(): Promise<void> { return this.call('revealExtension'); }
  disconnect(profileId: string): Promise<void> { return this.call('disconnect', [profileId]); }
  request(profileId: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    return this.call('request', [profileId, method, params, timeoutMs], timeoutMs + 3000);
  }
  close(): void {
    this.closed = true; clearTimeout(this.retry); this.stream?.destroy(); this.listeners.clear();
  }
}
