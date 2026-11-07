import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GpuiApp, GpuiSession, GpuiStatus } from '../../shared/gpui';
import type { InputGuardController, InputGuardFactory } from '../input-guard';
import { GpuiMcpClient, gpuiError, toolData, type GpuiBackend } from './mcp';
import type { GpuiIndicator } from './indicator';

const sessionName = z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/);
export const gpuiCommandSchema = z.object({
  action: z.literal('gpui'), method: z.enum(['status', 'list', 'schema', 'configure', 'claim', 'snapshot', 'call', 'handoff', 'return-control', 'resume', 'complete', 'release']),
  session: sessionName.optional(), target: z.string().min(1).max(250).optional(), backend: z.string().max(4096).optional(),
  tool: z.string().min(1).max(100).optional(), params: z.record(z.string(), z.unknown()).optional(), observation: z.string().uuid().optional(),
  pauseId: z.string().uuid().optional()
}).strict();
export type GpuiCommand = z.infer<typeof gpuiCommandSchema>;
const appSchema = z.object({ target_id: z.string().min(1).max(250), app_id: z.string(), app_name: z.string(), pid: z.number().int().positive().safe(), capabilities: z.unknown().optional() });
const readonlyTools = new Set(['ping', 'get_element', 'get_element_bounds', 'find_elements', 'screenshot', 'screenshot_element', 'screenshot_region', 'get_logs', 'get_frame_report', 'get_frame_stats', 'get_performance_report', 'list_app_commands', 'get_text_info', 'get_value', 'get_element_state']);
const inputTools = new Set(['click_element', 'double_click_element', 'hover_element', 'drag_element', 'focus_element', 'keyboard', 'type_text', 'set_text', 'set_value', 'scroll']);
const debugTools = new Set(['highlight_elements', 'clear_highlights', 'record_performance']);
export const gpuiAllowedTools = [...readonlyTools, ...inputTools, ...debugTools];
interface RecordState { view: GpuiSession; client?: GpuiBackend; indicator?: GpuiIndicator; guard?: InputGuardController; busy: boolean; epoch: number; observation?: string; nodes?: Record<string, unknown>; }
export interface GpuiServiceOptions {
  directory: string; defaultBackend?: string; guardFactory?: InputGuardFactory;
  backendFactory?: (executable: string, onClose: () => void) => GpuiBackend;
  onChanged?: (state: GpuiStatus) => void; prepareNotice?: () => Promise<void>;
  occupied?: (pid: number) => boolean;
  indicatorFactory?: (backend: string, app: GpuiApp, unavailable: (error: Error) => void) => GpuiIndicator;
}

export class GpuiService {
  private records = new Map<string, RecordState>();
  private backend?: string;
  private discovery?: GpuiBackend;
  private timer: NodeJS.Timeout;
  private closed = false;
  constructor(private options: GpuiServiceOptions) {
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const file = path.join(options.directory, 'state.json');
    if (fs.existsSync(file)) {
      // Fail closed on corrupt state: do not silently discard a paused owner.
      const saved = z.object({ backend: z.string().optional(), sessions: z.array(z.object({ name: sessionName, app: appSchema })) }).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      this.backend = saved.backend;
      for (const item of saved.sessions) this.records.set(item.name, { view: { ...item, state: 'paused', pauseId: randomUUID(), reason: 'ProfilePilot 已重新启动，请确认后交还控制。', revision: 1, lastUsed: Date.now(), inputGuard: 'unavailable' }, busy: false, epoch: 0 });
    }
    this.backend ||= options.defaultBackend && fs.existsSync(options.defaultBackend) ? options.defaultBackend : undefined;
    this.timer = setInterval(() => {
      for (const record of this.records.values()) if (record.view.state === 'active' && Date.now() - record.view.lastUsed > 300_000) this.pause(record, '闲置超过 5 分钟，已暂停。');
    }, 10_000);
    this.timer.unref();
  }
  status(): GpuiStatus { return { backend: this.backend || null, sessions: [...this.records.values()].map(record => structuredClone(record.view)) }; }
  reserved(pid: number) { return [...this.records.values()].some(record => record.view.app.pid === pid); }
  private publish() {
    const file = path.join(this.options.directory, 'state.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ backend: this.backend, sessions: [...this.records.values()].map(({ view }) => ({ name: view.name, app: view.app })) }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    this.options.onChanged?.(this.status());
  }
  private makeClient(onClose: () => void = () => {}) {
    if (!this.backend || !fs.existsSync(this.backend)) throw gpuiError('GPUI_BACKEND_UNAVAILABLE', '请在 GPUI 应用页面选择 gpui-mcp 后端，或运行 ppilot gpui configure --backend <路径>。');
    return this.options.backendFactory?.(this.backend, onClose) || new GpuiMcpClient(this.backend, { onClose });
  }
  async apps(): Promise<{ apps: GpuiApp[] }> {
    const client = this.discovery ||= this.makeClient(() => { if (this.discovery === client) this.discovery = undefined; });
    const data = toolData(await client.call('list_apps'));
    return { apps: z.array(appSchema).parse(data?.apps) };
  }
  async schemas(tool?: string) {
    if (tool && !gpuiAllowedTools.includes(tool)) throw gpuiError('GPUI_TOOL_UNSUPPORTED', '此工具未接入 ProfilePilot。');
    const client = this.discovery ||= this.makeClient(() => { if (this.discovery === client) this.discovery = undefined; });
    if (!client.tools) throw gpuiError('GPUI_SCHEMA_UNAVAILABLE', '当前后端不提供 tools/list schema；请更新 gpui-mcp。');
    const tools = (await client.tools()).filter(row => gpuiAllowedTools.includes(row.name) && (!tool || row.name === tool));
    if (tool && tools.length !== 1) throw gpuiError('GPUI_SCHEMA_UNAVAILABLE', '当前安装后端未声明此工具的唯一 schema。');
    return { source: 'installed-backend:tools/list', runtimeVerified: true, targetVerified: false,
      tools: tools.map(row => ({ ...row, requiresObservation: !readonlyTools.has(row.name),
        ...(row.name === 'scroll' ? { constraints: ['ProfilePilot 仅接受元素 id，坐标滚动未接入。'] } : {}),
        ...(row.name === 'record_performance' ? { constraints: ['duration_ms 范围为 1–10000。'] } : {}) })) };
  }
  configure(backend: string) {
    if (this.records.size) throw gpuiError('GPUI_OCCUPIED', '请先在应用内停止现有 GPUI 会话，再更换后端。');
    if (!path.isAbsolute(backend) || !fs.statSync(backend).isFile() || process.platform === 'win32' && path.extname(backend).toLowerCase() !== '.exe') throw gpuiError('GPUI_ARGUMENT', '后端必须是本机可执行文件的绝对路径。');
    this.discovery?.close(); this.discovery = undefined; this.backend = backend; this.publish(); return this.status();
  }
  private record(name?: string) {
    const record = name && this.records.get(name);
    if (!record) throw gpuiError('GPUI_SESSION_REQUIRED', '请先 claim，并使用同一 --session。');
    return record;
  }
  private assertActive(record: RecordState) {
    if (record.view.state !== 'active' || record.view.inputGuard !== 'active') throw gpuiError('GPUI_PAUSED', 'GPUI 会话已暂停或尚未就绪；用户明确同意后，使用 return-control --session TASK --pause-id 当前暂停ID 交还控制，或在应用内交还。');
    if (this.options.occupied?.(record.view.app.pid)) { this.pause(record, '目标已被其他入口占用。'); throw gpuiError('GPUI_OCCUPIED', '目标已被其他入口占用。'); }
  }
  private async updateIndicator(record: RecordState) {
    if (!this.options.indicatorFactory || !this.backend) return;
    const unavailable = (error: Error) => {
      if (this.records.get(record.view.name) !== record || this.closed) return;
      record.view.indicator = 'unavailable'; record.view.indicatorReason = error.message; this.publish();
    };
    try {
      record.indicator ||= this.options.indicatorFactory(this.backend, record.view.app, unavailable);
      await record.indicator.setState(record.view.state);
      if (record.view.indicator !== 'unavailable') record.view.indicator = 'embedded';
    } catch (error) { unavailable(error as Error); }
  }
  private async activate(record: RecordState) {
    record.view.pauseId = undefined;
    const epoch = ++record.epoch;
    if (record.view.indicator === 'unavailable') { record.indicator = undefined; record.view.indicator = undefined; record.view.indicatorReason = undefined; }
    record.view.state = 'preparing'; record.view.inputGuard = 'arming'; record.view.revision++; record.view.reason = undefined; this.publish();
    try {
      if (this.options.occupied?.(record.view.app.pid)) throw gpuiError('GPUI_OCCUPIED', '目标已被桌面控制入口占用。');
      await this.options.prepareNotice?.();
      if (record.epoch !== epoch) throw gpuiError('GPUI_INTERRUPTED', '准备期间已接管。');
      const client = record.client = this.makeClient(() => { if (record.epoch === epoch) this.pause(record, '后端连接中断，操作结果需要核查。'); });
      const selected = toolData(await client.call('select_app', { target_id: record.view.app.target_id }));
      const selectedApp = appSchema.parse(selected.selected);
      if (selectedApp.pid !== record.view.app.pid) throw gpuiError('GPUI_TARGET_CHANGED', '目标进程已变化，请停止旧会话后重新发现。');
      const ping = toolData(await client.call('ping'));
      if (ping.protocol_version !== 14) throw gpuiError('GPUI_PROTOCOL_ERROR', '此版本适配 gpui-mcp bridge 协议 14，请核对后端和应用桥版本。');
      await this.updateIndicator(record);
      if (record.epoch !== epoch) throw gpuiError('GPUI_INTERRUPTED', '准备期间已接管。');
      if (!this.options.guardFactory) throw gpuiError('GPUI_GUARD_UNAVAILABLE', '当前系统没有可用的接管观察器。');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(gpuiError('GPUI_GUARD_UNAVAILABLE', '接管观察器未就绪，请检查系统权限。')), 6000);
        const guard = this.options.guardFactory!({
          onClick: () => { if (record.epoch === epoch) this.pause(record, '检测到用户点击目标窗口，已交由用户控制。'); },
          onStatus: status => {
            if (record.epoch !== epoch) { clearTimeout(timer); reject(gpuiError('GPUI_INTERRUPTED', '接管观察已取消。')); return; }
            if (status.status === 'guard-active') { record.view.inputGuard = 'active'; clearTimeout(timer); resolve(); }
            else if (['guard-unavailable', 'helper-exited', 'helper-spawn-failed', 'tap-disabled', 'permission-denied'].includes(status.status)) {
              // The shared broker reports unverified protection while its first
              // PID configuration is being acknowledged. Keep waiting, bounded
              // by the preparation deadline; an active owner still pauses.
              if (status.status === 'guard-unavailable' && record.view.state === 'preparing') return;
              clearTimeout(timer); reject(gpuiError('GPUI_GUARD_UNAVAILABLE', `接管观察器不可用：${status.status}${status.reason ? ' / ' + status.reason : ''}。`));
              if (record.view.state === 'active') this.pause(record, '接管观察器中断，已暂停。');
            }
          }
        });
        record.guard = guard; guard.sync([record.view.app.pid]);
      });
      if (record.epoch !== epoch || this.options.occupied?.(record.view.app.pid)) throw gpuiError('GPUI_INTERRUPTED', '控制权已改变。');
      record.view.state = 'active'; record.view.lastUsed = Date.now(); record.view.revision++;
      await this.updateIndicator(record);
      if (record.epoch !== epoch) throw gpuiError('GPUI_INTERRUPTED', '控制权已改变。');
      this.publish();
    } catch (error) { if (record.epoch === epoch) this.pause(record, (error as Error).message); throw error; }
  }
  private pause(record: RecordState, reason: string) {
    record.view.pauseId = randomUUID();
    record.epoch++; record.view.state = 'paused'; record.view.inputGuard = 'unavailable'; record.view.reason = reason; record.view.revision++;
    record.observation = undefined; record.nodes = undefined;
    const client = record.client, guard = record.guard; record.client = undefined; record.guard = undefined;
    client?.close(); void guard?.dispose();
    if (record.indicator) void this.updateIndicator(record);
    this.publish();
  }
  pauseAll(reason: string) { for (const record of this.records.values()) if (record.view.state !== 'paused') this.pause(record, reason); }
  /** UI control. Revision binds a return to the owner shown in the page. */
  async control(action: 'takeover' | 'return' | 'stop', name: string, revision: number) {
    const record = this.record(name);
    if (record.view.revision !== revision) throw gpuiError('GPUI_STALE_CONTROL', '控制状态已更新，请刷新后再操作。');
    if (action === 'return') { if (record.view.state !== 'paused') throw gpuiError('GPUI_ARGUMENT', '只有暂停会话可以交还。'); await this.activate(record); }
    else { this.pause(record, action === 'stop' ? '用户已停止。' : '用户接管。'); if (action === 'stop') { this.records.delete(name); this.publish(); await record.indicator?.close(); } }
    return this.status();
  }
  async execute(input: unknown): Promise<unknown> {
    if (this.closed) throw gpuiError('GPUI_UNAVAILABLE', 'GPUI 服务正在关闭。');
    const cmd = gpuiCommandSchema.parse(input);
    if (cmd.pauseId && cmd.method !== 'return-control') throw gpuiError('GPUI_ARGUMENT', '--pause-id 仅用于 return-control。');
    if (cmd.method === 'status') return this.status();
    if (cmd.method === 'list') return this.apps();
    if (cmd.method === 'schema') return this.schemas(cmd.tool);
    if (cmd.method === 'configure') { if (!cmd.backend) throw gpuiError('GPUI_ARGUMENT', '缺少 --backend。'); return this.configure(cmd.backend); }
    if (cmd.method === 'claim') {
      const name = sessionName.parse(cmd.session);
      if (this.records.has(name)) throw gpuiError('GPUI_OCCUPIED', '任务名已有会话，请先检查状态。');
      const app = (await this.apps()).apps.find(app => app.target_id === cmd.target);
      if (!app) throw gpuiError('GPUI_TARGET_MISSING', '未找到此实例，请重新 list。应用必须接入 gpui-mcp 调试桥。');
      if (this.records.has(name) || this.reserved(app.pid) || this.options.occupied?.(app.pid)) throw gpuiError('GPUI_OCCUPIED', '这个应用实例已有控制会话。');
      const record: RecordState = { view: { name, app, state: 'preparing', revision: 0, lastUsed: Date.now(), inputGuard: 'arming' }, busy: false, epoch: 0 };
      this.records.set(name, record); this.publish(); await this.activate(record); return this.status();
    }
    const record = this.record(cmd.session);
    if (cmd.method === 'return-control') {
      // An explicit user-directed management action, like the page's Return
      // button. The caller must obtain consent; pauseId prevents stale requests
      // from restoring a later takeover, restarted or recreated session.
      if (!cmd.pauseId) throw gpuiError('GPUI_ARGUMENT', '缺少 --pause-id；先读取 status 中此会话的当前暂停 ID。');
      if (record.view.state !== 'paused' || record.view.pauseId !== cmd.pauseId) throw gpuiError('GPUI_STALE_CONTROL', '暂停状态已变化，旧交还请求无效；请检查状态，不要自动重新交还。');
      if (record.busy) throw gpuiError('GPUI_BUSY', '暂停前的请求尚未结束；请先核查结果再交还控制。');
      await this.activate(record);
      return this.status();
    }
    if (cmd.method === 'handoff') { this.pause(record, 'Agent 已交由用户控制。'); return this.status(); }
    this.assertActive(record);
    if (cmd.method === 'resume') return this.status(); // Compatibility: check only; use explicit return-control to restore a paused owner.
    if (cmd.method === 'complete' || cmd.method === 'release') { this.pause(record, '会话结束。'); this.records.delete(record.view.name); this.publish(); await record.indicator?.close(); return this.status(); }
    if (record.busy) throw gpuiError('GPUI_BUSY', '同一实例已有请求在执行；请等待结果。');
    record.busy = true;
    const epoch = record.epoch, client = record.client!;
    try {
      if (cmd.method === 'snapshot') {
        const tree = toolData(await client.call('get_ui_tree'));
        if (!tree?.nodes || typeof tree.nodes !== 'object' || Array.isArray(tree.nodes)) throw gpuiError('GPUI_PROTOCOL_ERROR', 'GPUI 元素树格式无效。');
        this.assertUnchanged(record, epoch);
        record.observation = randomUUID(); record.nodes = tree.nodes;
        record.view.lastUsed = Date.now();
        return { observation: record.observation, target: record.view.app.target_id, tree };
      }
      if (!cmd.tool || !readonlyTools.has(cmd.tool) && !inputTools.has(cmd.tool) && !debugTools.has(cmd.tool)) throw gpuiError('GPUI_TOOL_UNSUPPORTED', '此工具尚未接入 ppilot；不允许调用选择目标或任意命令工具。');
      const mutating = !readonlyTools.has(cmd.tool), params = cmd.params || {};
      if (mutating) {
        if (!cmd.observation || cmd.observation !== record.observation) throw gpuiError('GPUI_STALE_OBSERVATION', '请重新 snapshot，并传入最新 --observation。');
        if (cmd.tool === 'scroll' && typeof params.id !== 'string') throw gpuiError('GPUI_ARGUMENT', 'scroll 必须使用元素 id；坐标输入暂未接入。');
        if (cmd.tool === 'record_performance' && (typeof params.duration_ms !== 'number' || params.duration_ms < 1 || params.duration_ms > 10000)) throw gpuiError('GPUI_ARGUMENT', '性能采样 duration_ms 应在 1 到 10000 毫秒内。');
        // Validate IDs and layout again immediately before dispatch, then consume the observation.
        const current = toolData(await client.call('get_ui_tree'));
        this.assertUnchanged(record, epoch);
        if (['keyboard', 'type_text'].includes(cmd.tool) && JSON.stringify(record.nodes) !== JSON.stringify(current?.nodes)) {
          record.observation = undefined; throw gpuiError('GPUI_STALE_OBSERVATION', '输入焦点或界面已变化，请重新 snapshot。');
        }
        const ids = ['id', 'from_id', 'to_id'].filter(key => params[key] !== undefined).map(key => params[key]);
        if (Array.isArray(params.ids)) ids.push(...params.ids);
        for (const id of ids) if (typeof id !== 'string' || !record.nodes || !Object.hasOwn(record.nodes, id) || JSON.stringify(record.nodes[id]) !== JSON.stringify(current?.nodes?.[id])) {
          record.observation = undefined; throw gpuiError('GPUI_STALE_OBSERVATION', '目标元素已变化，请重新 snapshot。');
        }
        record.observation = undefined; record.nodes = undefined;
      }
      const result = await client.call(cmd.tool, params);
      this.assertUnchanged(record, epoch); record.view.lastUsed = Date.now();
      return { target: record.view.app.target_id, tool: cmd.tool, result, ...(mutating ? { requiresObservation: true } : {}) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (record.epoch === epoch && !['GPUI_STALE_OBSERVATION', 'GPUI_TOOL_UNSUPPORTED'].includes(code || '')) this.pause(record, '请求未完成或结果待核查：' + (error as Error).message);
      throw error;
    } finally { record.busy = false; }
  }
  private assertUnchanged(record: RecordState, epoch: number) {
    if (record.epoch !== epoch) throw gpuiError('GPUI_INTERRUPTED', '操作期间发生接管；结果需要核查，不要重放。');
    this.assertActive(record);
  }
  close() { this.closed = true; clearInterval(this.timer); this.pauseAll('ProfilePilot 已关闭。'); for (const record of this.records.values()) void record.indicator?.close(); this.discovery?.close(); }
}
