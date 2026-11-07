import type { GpuiApp, GpuiStatus } from '../shared/gpui';
import { workspaceIdentityBar, workspaceSwitcher, refreshWorkspaceSwitcher } from './workspace-switcher';
import { pcControlTabs } from './pc-control';

const api = window.gpuiControl;
document.getElementById('gpui')!.innerHTML = `${workspaceSwitcher('gpui') + workspaceIdentityBar()}
  <div class="gpui-shell"><header class="gpui-header"><div><h1>控制台</h1><p class="muted">查看 GPUI 应用实例、连接和控制状态</p></div><button id="gpui-refresh">刷新连接</button></header>
  ${pcControlTabs('gpui')}
  <p id="gpui-error" role="alert" hidden></p>
  <div class="gpui-panels"><section class="gpui-panel"><h2>可连接的应用</h2><div id="gpui-apps"><p class="muted">正在发现…</p></div></section>
    <section class="gpui-panel"><h2>控制会话</h2><div id="gpui-sessions"></div></section>
  </div><section class="gpui-panel gpui-card"><h2>调试后端</h2><p id="gpui-backend" class="muted"></p><button id="gpui-configure">选择后端</button><p class="muted">应用需要接入 gpui-mcp 调试桥。控制状态显示在目标窗口右下角，不另开弹窗。可在此页或托盘接管、停止。</p><p class="muted">点击目标窗口会自动暂停。键盘输入前请先点击接管；暂停后只有你明确交还控制才能恢复。</p></section>
  <p id="gpui-chat-return" class="muted">你也可以在聊天中明确告诉 Agent“交还控制，继续调试”，由 Agent 通过 CLI 恢复当前会话，无需再回此页点击。</p>
  </div>`;
refreshWorkspaceSwitcher();
const get = (id: string) => document.getElementById(id)!;
function error(cause?: unknown) {
  const element = get('gpui-error'); element.hidden = !cause;
  element.textContent = cause ? String(cause instanceof Error ? cause.message : cause).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '';
}
function text(tag: string, value: string, className?: string) {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className; return element;
}
function render(state: GpuiStatus) {
  const list = get('gpui-sessions'); list.replaceChildren();
  if (!state.sessions.length) list.append(text('p', '当前没有控制会话', 'muted'));
  for (const session of state.sessions) {
    const card = text('article', '', 'gpui-card'), title = text('h3', session.app.app_name);
    title.append(text('span', { preparing: '准备连接', active: 'Agent 控制中', paused: '用户控制 / 已暂停' }[session.state], 'gpui-state ' + session.state));
    card.append(title, text('p', session.name + ' · PID ' + session.app.pid, 'muted'));
    if (session.reason) card.append(text('p', session.reason));
    if (session.indicator === 'unavailable') card.append(text('p', '窗口内标识暂不可用：' + (session.indicatorReason || '请检查应用调试桥。'), 'muted'));
    const controls = text('div', '', 'gpui-actions');
    for (const [action, label] of [['takeover', '接管'], ['return', '交还控制'], ['stop', '停止']] as const) {
      if (action === 'return' && session.state !== 'paused' || action === 'takeover' && session.state === 'paused') continue;
      const button = text('button', label) as HTMLButtonElement;
      button.onclick = async () => { button.disabled = true; try { error(); render(await api.control(action, session.name, session.revision)); } catch (cause) { error(cause); } finally { button.disabled = false; } };
      controls.append(button);
    }
    card.append(controls); list.append(card);
  }
  get('gpui-backend').textContent = state.backend || '尚未配置。请选择本机 gpui-mcp 可执行文件。';
}
function apps(items: GpuiApp[]) {
  const list = get('gpui-apps'); list.replaceChildren();
  if (!items.length) list.append(text('p', '没有发现已接入调试桥的应用。请启动应用的调试构建，然后刷新。', 'muted'));
  for (const app of items) {
    const card = text('article', '', 'gpui-card');
    card.append(text('h3', app.app_name), text('p', app.app_id + ' · PID ' + app.pid, 'muted'), text('code', 'ppilot gpui claim --target ' + app.target_id + ' --session gpui-' + app.pid));
    list.append(card);
  }
}
async function refresh() {
  try { error(); render(await api.status()); apps((await api.apps()).apps); } catch (cause) { error(cause); get('gpui-apps').textContent = '连接暂不可用，请检查后端与应用调试桥。'; }
}
get('gpui-refresh').onclick = refresh;
get('gpui-configure').onclick = async () => { try { const state = await api.configure(); if (state) await refresh(); } catch (cause) { error(cause); } };
const unsubscribe = api.onChanged(render);
window.addEventListener('pagehide', unsubscribe, { once: true });
void refresh();
