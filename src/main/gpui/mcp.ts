import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ToolResult {
  isError?: boolean; structuredContent?: unknown;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}
export interface GpuiBackend {
  start(): Promise<void>; call(name: string, args?: Record<string, unknown>): Promise<ToolResult>; close(): void;
  tools?(): Promise<Array<{ name: string; inputSchema: Record<string, unknown>; description?: string }>>;
}
export const gpuiError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A private, persistent MCP transport per target. No shell and no request replay. */
export class GpuiMcpClient implements GpuiBackend {
  private child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private starting?: Promise<void>;
  private closed = false;
  constructor(private executable: string, private options: { timeoutMs?: number; maxBytes?: number; args?: string[]; onClose?: () => void } = {}) {}
  start(): Promise<void> {
    return this.starting ||= this.initialize();
  }
  private async initialize() {
    if (this.closed) throw gpuiError('GPUI_DISCONNECTED', 'GPUI 后端连接已关闭。');
    const child = this.child = spawn(this.executable, this.options.args || [], { shell: false, windowsHide: true, stdio: 'pipe' });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (bytes: Buffer) => {
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > (this.options.maxBytes ?? 32 * 1024 * 1024)) { this.fail(gpuiError('GPUI_PROTOCOL_ERROR', 'GPUI 后端响应超过大小限制。')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.jsonrpc !== '2.0') throw new Error('protocol');
          if (message.id === undefined) continue;
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(gpuiError('GPUI_BACKEND_ERROR', String(message.error.message || 'GPUI 后端失败。').slice(0, 2000)));
          else pending.resolve(message.result);
        } catch { this.fail(gpuiError('GPUI_PROTOCOL_ERROR', 'GPUI 后端返回了无效的 MCP 消息。')); return; }
      }
    });
    // Drain diagnostics without exposing bridge tokens or unbounded application logs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail(gpuiError('GPUI_DISCONNECTED', 'GPUI 后端输入通道已断开。')));
    child.once('error', () => this.fail(gpuiError('GPUI_BACKEND_UNAVAILABLE', '无法启动 GPUI 后端，请检查后端路径。')));
    child.once('exit', () => this.fail(gpuiError('GPUI_DISCONNECTED', 'GPUI 后端已退出；先核对状态，不要重复输入。')));
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'profilepilot', version: '0.1.0' } });
    if (!result?.capabilities?.tools) { this.close(); throw gpuiError('GPUI_PROTOCOL_ERROR', '后端未声明 MCP tools 能力。'); }
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  private send(value: unknown) {
    if (!this.child || this.closed) throw gpuiError('GPUI_DISCONNECTED', 'GPUI 后端已断开。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(gpuiError('GPUI_DISCONNECTED', 'GPUI 后端已断开。'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(gpuiError('GPUI_OUTCOME_UNKNOWN', 'GPUI 请求超时，结果待核查；不会自动重试。')), this.options.timeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.fail(error as Error); }
    });
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.start();
    const result = await this.request('tools/call', { name, arguments: args });
    if (!result || typeof result !== 'object') throw gpuiError('GPUI_PROTOCOL_ERROR', 'GPUI 工具返回值无效。');
    if (result.isError) throw gpuiError('GPUI_TOOL_FAILED', result.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').slice(0, 2000) || 'GPUI 工具执行失败。');
    return result;
  }
  async tools(): Promise<Array<{ name: string; inputSchema: Record<string, unknown>; description?: string }>> {
    await this.start();
    const tools: Array<{ name: string; inputSchema: Record<string, unknown>; description?: string }> = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw gpuiError('GPUI_PROTOCOL_ERROR', '后端未返回有效工具 schema。');
      for (const tool of result.tools) {
        if (typeof tool?.name !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw gpuiError('GPUI_PROTOCOL_ERROR', '后端工具 schema 格式无效。');
        tools.push({ name: tool.name, inputSchema: tool.inputSchema, ...(typeof tool.description === 'string' ? { description: tool.description.slice(0, 4000) } : {}) });
      }
      if (!result.nextCursor) return tools;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw gpuiError('GPUI_PROTOCOL_ERROR', '后端工具 schema 分页游标无效。');
      const nextCursor: string = result.nextCursor;
      cursor = nextCursor; cursors.add(nextCursor);
    }
    throw gpuiError('GPUI_PROTOCOL_ERROR', '后端工具 schema 超出分页上限。');
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.child?.kill(); this.options.onClose?.();
  }
  close() { this.fail(gpuiError('GPUI_INTERRUPTED', 'GPUI 连接已关闭；在途操作可能已生效，请核对。')); }
}

export function toolData<T = any>(result: ToolResult): T {
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find(item => item.type === 'text')?.text;
  try { return JSON.parse(text || 'null') as T; }
  catch { throw gpuiError('GPUI_PROTOCOL_ERROR', 'GPUI 工具没有返回可解析的数据。'); }
}
