import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const events = new Set(['worker-start', 'worker-ready', 'initialization-failed', 'runtime-error', 'unhandled-rejection',
  'browser-startup', 'extension-installed', 'connect-attempt', 'socket-open', 'authenticated', 'socket-error',
  'socket-close', 'connect-pending', 'heartbeat-checkpoint', 'disconnect-requested', 'reload-requested',
  'popup-unreachable', 'popup-recovered', 'service-start', 'service-stopping', 'transport-connected', 'transport-closed', 'heartbeat-timeout']);
export interface ExtensionConnectionEvent {
  id: string; at: string; instance: string; source: 'worker' | 'popup' | 'service'; event: string;
  port?: number; closeCode?: number; line?: number; column?: number; elapsedMs?: number;
  paired?: boolean; authenticated?: boolean; wasClean?: boolean;
  step?: string; errorName?: string; errorKind?: string; extensionVersion?: string; script?: string;
}
interface StoredEvent extends ExtensionConnectionEvent { targetHash?: string; receivedAt: string; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const maxEvents = 500, maxAge = 7 * 86400000;
const journalPath = (root: string) => path.join(root, 'control-diagnostics', 'extension-connections.json');

/** Strict metadata allowlist: never retain page text, credentials, error messages or stacks. */
export function parseExtensionConnectionEvent(value: unknown): ExtensionConnectionEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as ExtensionConnectionEvent;
  if (!events.has(v.event) || !/^[a-f0-9-]{36}$/i.test(v.id || '') || !/^[a-f0-9-]{36}$/i.test(v.instance || '') ||
      !['worker', 'popup', 'service'].includes(v.source) || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return;
  const row: ExtensionConnectionEvent = { id: v.id, at: new Date(v.at).toISOString(), instance: v.instance, source: v.source, event: v.event };
  for (const key of ['port', 'closeCode', 'line', 'column', 'elapsedMs'] as const)
    if (Number.isSafeInteger(v[key]) && v[key]! >= 0 && v[key]! <= 2147483647) row[key] = v[key];
  for (const key of ['paired', 'authenticated', 'wasClean'] as const) if (typeof v[key] === 'boolean') row[key] = v[key];
  for (const key of ['step', 'errorName', 'errorKind', 'extensionVersion'] as const)
    if (typeof v[key] === 'string' && /^[a-zA-Z0-9_.-]{1,60}$/.test(v[key]!)) row[key] = v[key];
  if (['background.js', 'background-entry.js', 'connection-diagnostics.js', 'popup.js'].includes(v.script || '')) row.script = v.script;
  return row;
}
function load(root: string): StoredEvent[] {
  if (!statSync(root).isDirectory()) throw new Error('Diagnostic root is not a directory');
  const file = journalPath(root);
  if (statSync(file).size > 512 * 1024) throw new Error('Diagnostic journal exceeds its size limit');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.version !== 1 || !Array.isArray(value.events)) throw new Error('Invalid diagnostic journal');
  return value.events.slice(-maxEvents).flatMap((entry: any) => {
    const row = parseExtensionConnectionEvent(entry);
    return row && typeof entry.receivedAt === 'string' && Number.isFinite(Date.parse(entry.receivedAt)) ? [{ ...row,
      receivedAt: new Date(entry.receivedAt).toISOString(),
      ...(typeof entry.targetHash === 'string' && /^[a-f0-9]{16}$/.test(entry.targetHash) ? { targetHash: entry.targetHash } : {}) }] : [];
  });
}
export function readExtensionConnectionDiagnostics(root: string, profileId?: string) {
  let history: StoredEvent[] = [], readError = false;
  try { history = load(root); } catch (error) { readError = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  const target = profileId ? hash(profileId) : undefined;
  history = history.filter(row => Date.now() - Date.parse(row.receivedAt) <= maxAge && (!target || !row.targetHash || row.targetHash === target));
  const descriptions: Record<string, string> = {
    'initialization-failed': '扩展初始化失败；检查 step、错误类型及源码位置。',
    'runtime-error': '扩展代码发生未捕获异常；检查错误类型及源码位置。',
    'unhandled-rejection': '扩展异步操作失败且未处理；检查错误类型及源码位置。',
    'socket-error': '扩展连接本机服务失败；单凭此事件无法确定是否为端口拒绝。',
    'connect-pending': '连接或认证持续未完成；检查 step 和 elapsedMs。',
    'popup-unreachable': '弹窗无法取得后台响应；这不能单独证明后台崩溃。',
    'heartbeat-timeout': '服务未及时收到扩展消息；Chrome 退出、休眠或后台失效均可能造成。'
  };
  return { path: journalPath(root), readError, events: history.slice(-100), maxEvents, maxAgeDays: 7,
    signals: history.filter(row => descriptions[row.event]).slice(-8).map(row => ({ eventId: row.id, at: row.at,
      kind: row.event, detail: descriptions[row.event], historical: true, rootCauseConfirmed: false })),
    evidence: history.length ? 'recorded' : 'not-yet-recorded',
    limitation: '日志是历史证据。后台未执行、Chrome 退出或进程被终止可能无法留下扩展端原因；缺少日志不能证明崩溃。离线时请从扩展弹窗导出连接诊断，并保留 chrome://extensions 的错误。' };
}

/** One writer: the browser service. Keep history across daemon restarts. */
export class ExtensionConnectionJournal {
  private readonly instance = randomUUID();
  private history: StoredEvent[] = [];
  constructor(private readonly root: string) { try { this.history = load(root); } catch { /* First start or unavailable diagnostics. */ } }
  record(event: string, details: Partial<ExtensionConnectionEvent> = {}, profileId?: string): void {
    this.ingest([{ ...details, id: randomUUID(), at: new Date().toISOString(), instance: this.instance, source: 'service', event }], profileId);
  }
  ingest(values: unknown, profileId?: string): void {
    try {
      if (!Array.isArray(values)) return;
      const targetHash = profileId ? hash(profileId) : undefined, receivedAt = new Date().toISOString();
      const seen = new Set(this.history.map(row => `${row.targetHash || ''}:${row.id}`));
      const additions = values.slice(-200).flatMap(value => {
        const row = parseExtensionConnectionEvent(value), key = `${targetHash || ''}:${row?.id}`;
        if (!row || seen.has(key)) return [];
        seen.add(key); return [{ ...row, targetHash, receivedAt }];
      });
      if (!additions.length) return;
      this.history = [...this.history, ...additions].filter(row => Date.now() - Date.parse(row.receivedAt) <= maxAge).slice(-maxEvents);
      const file = journalPath(this.root), temporary = `${file}.${process.pid}.tmp`;
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, events: this.history }), { mode: 0o600 });
      renameSync(temporary, file);
    } catch { /* Diagnostics must never change control, reconnect or replay operations. */ }
  }
}
