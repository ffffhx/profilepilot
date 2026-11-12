import { suggestedCommand } from './control-cli-contract';

export type ControlRoute = 'browser' | 'phone' | 'electron' | 'desktop' | 'gpui';
type RouteState = 'discover' | 'prepare-required' | 'repair-required' | 'available' | 'ready' | 'wait-for-owner' | 'return-control' | 'unsupported';
const selectionPolicy = '优先使用能完成任务的专用 Skill、API 或 CLI。界面任务使用 browser/electron/gpui 的目标入口；原生窗口或这些入口确认无法完成的操作才使用 desktop。';
function guidance(route: ControlRoute, state: RouteState, args: string[], detail: string, extra: Record<string, unknown> = {}) {
  return { recommendedRoute: route, state, readyToObserve: state === 'ready', readyToAct: state === 'ready',
    requiresUser: state === 'return-control', automaticResume: false, automaticReplay: false,
    nextCommand: suggestedCommand(args), detail, selectionPolicy, ...extra };
}

export function unavailableRouting(route: ControlRoute, message: string) {
  return guidance(route, 'repair-required', ['doctor', '--route', route], message, { availableOperations: ['doctor', 'schema'], runtimeVerified: false });
}

/** Catalog rows are connection evidence, never a grant to take over an owner. */
export function electronRouting(app?: any, session?: string) {
  if (!app) return guidance('electron', 'prepare-required', ['electron', 'register', '--help'],
    '未登记不代表 Electron 不可控制。先核查 list --all，确认目标后可通过 register 登记；不得改用其他入口绕过占用。',
    { availableOperations: ['list', 'inspect', 'register'], discoveryCommand: suggestedCommand(['electron', 'list', '--all']) });
  const id = app.id, port = app.port, agent = app.agent;
  const inspect = ['electron', 'inspect', id, ...(session ? ['--session', session] : [])];
  const operations = ['inspect', 'configure', 'connect'];
  if (agent?.sessionId && agent.sessionId !== session) return guidance('electron', 'wait-for-owner', inspect,
    '目标由其他会话占用；等待原任务释放，不能通过 connect、重启或其他入口接管。', { owner: agent.sessionId, availableOperations: ['inspect'] });
  if (agent?.ownership === 'user') return guidance('electron', 'return-control', inspect,
    '用户持有控制权；等待明确交还后，再检查原会话。', { owner: agent.sessionId, availableOperations: ['inspect'] });
  if (app.connection) return guidance('electron', 'repair-required', inspect, '连接流程正在进行，先检查实际结果，不重复 connect。', { availableOperations: ['inspect'] });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return guidance('electron', 'prepare-required', ['electron', 'configure', '--help'],
    '尚无可用 Agent 逻辑端口。检查登记的 renderer/Agent 端口；不能把原始 CDP 端口当作 Agent 端口。', { availableOperations: operations });
  if (app.runtime?.status === 'unknown' || agent?.error) return guidance('electron', 'repair-required', inspect,
    '应用进程或连接证据尚未确定；请处理 inspect 中的具体缺项。', { availableOperations: ['inspect', 'configure'] });
  if (!agent?.connected || !app.debug?.renderer) return guidance('electron', 'prepare-required', ['electron', 'connect', id],
    '已登记；使用受支持的 connect 准备连接。需要重启时仍须确认，不自动结束现有任务。', { availableOperations: operations });
  if (!session) return guidance('electron', 'available', ['electron', 'inspect', id, '--help'],
    '连接可用。提供本任务 --session 后获取准确的观察命令。', { availableOperations: ['inspect'], requiresSession: true, port });
  return guidance('electron', agent?.sessionId === session && agent?.ownership === 'agent' ? 'ready' : 'available',
    ['electron', '--session', session, '--cdp', String(port), 'observe'], '使用此应用的实际逻辑端口；动作仍须最新观察和服务端控制权校验。',
    { availableOperations: ['observe', 'action', 'screenshot', 'status', 'handoff', 'complete'], port });
}

export function desktopRouting(report: any, session?: string, windowId?: string) {
  const status = report?.status || report, owner = status?.session;
  const diagnostic = ['desktop', 'doctor', ...(windowId ? ['--window', windowId] : []), ...(session ? ['--session', session] : [])];
  if (status?.supported === false) return guidance('desktop', 'unsupported', ['desktop', 'schema'], status.reason || '当前平台没有原生桌面驱动。', { availableOperations: ['status', 'schema'] });
  if (!status?.available) return guidance('desktop', 'repair-required', ['doctor', '--route', 'desktop'], status?.reason || '桌面组件不可用。', { availableOperations: ['status'] });
  if (owner && owner.name !== session) return guidance('desktop', 'wait-for-owner', diagnostic, '桌面由其他任务占用；保持现有会话。', { owner: owner.name, availableOperations: ['status', 'doctor'] });
  if (owner?.state === 'paused') return guidance('desktop', 'return-control', diagnostic, '桌面已暂停；等待用户明确交还，不能自动 resume。', { availableOperations: ['status', 'doctor'] });
  if (report?.admission && !['available', 'unmanaged'].includes(report.admission.status)) return guidance('desktop',
    report.admission.status === 'occupied' ? 'wait-for-owner' : 'repair-required', diagnostic,
    '跨入口控制证据尚未允许此窗口；按 admission 的 matches/gaps 处理，不能切换工具绕过。', { availableOperations: ['status', 'doctor'] });
  if (status.inputObservation?.available !== true) return guidance('desktop', 'repair-required', diagnostic,
    '输入接管观察器未就绪；窗口可发现不代表可控制。', { availableOperations: ['status', 'doctor', 'windows'] });
  if (owner && owner.name === session && owner.state === 'active' && status.inputObservation?.phase === 'ready') return guidance('desktop', 'ready',
    ['desktop', 'observe', '--session', session!], '保持原桌面会话；先观察再输入。', { availableOperations: ['observe', 'screenshot', 'action', 'wait', 'receipt', 'handoff', 'complete'] });
  if (owner) return guidance('desktop', 'repair-required', diagnostic, '原会话的输入观察器正在准备或结果待核查；保持原会话，不重新 claim。', { availableOperations: ['status', 'doctor'] });
  if (!windowId || !session) return guidance('desktop', 'discover', ['desktop', 'windows'],
    '仅在操作原生窗口、明确指定 desktop 或专用入口确认不适用时选择此入口；从 windows 取得真实 ID 并指定任务会话。', { availableOperations: ['windows', 'doctor'], requiresSession: !session });
  return guidance('desktop', 'available', ['desktop', 'claim', '--session', session, '--window', windowId],
    '此诊断不取得控制权；claim 会再次检查窗口身份、占用和接管观察器。', { availableOperations: ['claim', 'doctor'] });
}

export function gpuiRouting(status: any, apps: any[], target?: string, session?: string) {
  const own = (status?.sessions || []).find((item: any) => target ? item.app?.target_id === target : session && item.name === session);
  const diagnostic = ['gpui', 'doctor', ...(target ? ['--target', target] : []), ...(session ? ['--session', session] : [])];
  if (own && own.name !== session) return guidance('gpui', 'wait-for-owner', diagnostic, '此 GPUI 实例由其他任务保留；等待原任务释放。', { owner: own.name, availableOperations: ['status', 'doctor'] });
  if (own?.state === 'paused') return guidance('gpui', 'return-control', diagnostic,
    '此会话已暂停；用户在当前对话明确同意后，读取当前 pauseId 并调用 return-control 交还同一会话，无需再次点击应用。', { availableOperations: ['status', 'doctor', 'return-control'], requiresUserConsent: true });
  if (own && (own.state !== 'active' || own.inputGuard !== 'active')) return guidance('gpui', 'prepare-required', diagnostic,
    '当前会话的接管观察器仍在准备；先检查状态，不重新 claim 或自动 resume。', { availableOperations: ['status', 'doctor'] });
  if (!status?.backend) return guidance('gpui', 'prepare-required', ['gpui', 'configure', '--help'],
    '先配置实际 gpui-mcp 后端。GPUI 使用调试桥，不能按 Electron/CDP 连接。', { availableOperations: ['status', 'configure'] });
  if (own && own.name === session) return guidance('gpui', 'ready', ['gpui', 'snapshot', '--session', session!],
    '使用当前实例会话；输入需 snapshot 的新 observation。', { availableOperations: ['snapshot', 'call', 'handoff', 'complete'] });
  if (!target || !apps.some(app => app.target_id === target)) return guidance('gpui', 'discover', ['gpui', 'list'],
    '从已接入调试桥的实例中选择真实 target_id；未发现的应用需要接入桥，不能推断为支持 CDP。', { availableOperations: ['list', 'status'] });
  if (!session) return guidance('gpui', 'available', ['gpui', 'claim', '--help'], '目标已发现；指定本任务 session 后 claim。', { availableOperations: ['claim'], requiresSession: true });
  return guidance('gpui', 'available', ['gpui', 'claim', '--target', target, '--session', session],
    'claim 会检查实例、占用和接管观察器。', { availableOperations: ['claim', 'doctor'] });
}
