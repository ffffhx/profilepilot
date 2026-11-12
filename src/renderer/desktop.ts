import type { DesktopStatus, DesktopWindow, DesktopReturnExpectation } from '../shared/desktop';
import { workspaceIdentityBar, workspaceSwitcher, refreshWorkspaceSwitcher } from './workspace-switcher';
import { pcControlTabs } from './pc-control';
import { onWorkspaceVisibilityChanged } from './workspace-lifecycle';
import { followDesktopStatus } from './desktop-status';
import { taskIcon } from './task-icons';
import { renderButtonLabel, setButtonLoading } from './button-label';

const root = document.getElementById('desktop')!;
const api = window.desktopControl;
root.innerHTML = `${workspaceSwitcher('desktop')}${workspaceIdentityBar()}
  <div class="desktop-shell">
    <header class="desktop-header pc-control-header"><div class="pc-control-brand"><h1>控制台</h1><p>查看 Windows 窗口，让 Agent 操作本机桌面</p></div><div class="pc-control-actions"><button id="desktop-refresh">${renderButtonLabel(false, '刷新窗口', '刷新中…')}</button></div></header>
    ${pcControlTabs('desktop')}
    <div id="desktop-session" hidden><div class="desktop-session-summary"><span></span><p id="desktop-pause-reason" hidden></p></div><button data-control="takeover">接管</button><button data-control="return">交还控制</button><button data-control="stop">停止</button></div>
    <p id="desktop-error" role="alert" hidden></p>
    <main class="desktop-layout">
      <section class="desktop-panel"><h2>当前桌面窗口 <span id="desktop-count"></span></h2><div id="desktop-windows" aria-busy="true"><p class="desktop-empty" role="status">正在读取窗口…</p></div></section>
      <section class="desktop-panel"><h2>窗口预览</h2><div class="desktop-detail"><h3 id="desktop-selected">选择一个窗口</h3><div id="desktop-preview"><div class="desktop-preview-empty">${taskIcon('desktop')}<p>选择列表中的窗口，查看画面和控制方式。</p></div></div>
        <div class="desktop-help"><label for="desktop-mode">控制模式</label><select id="desktop-mode"><option value="background">仅后台语义操作</option><option value="interactive">前台交互</option></select><p id="desktop-mode-help">你可以继续使用其他应用；使用目标应用时任务会暂停。后台模式不移动鼠标、不模拟按键、不主动切换前台。</p><p id="desktop-command-hint">先选择当前窗口，再复制 CLI 示例。</p><code id="desktop-command" hidden></code><p>控制时会显示桌面提示条，你可以随时接管或停止。</p></div>
      </div></section>
    </main>
  </div>`;
refreshWorkspaceSwitcher();
const element = (id: string) => document.getElementById(id)!;
let selected = '', previewVersion = 0, busy = false;
let windowsLoaded = false;
let currentStatus: DesktopStatus | undefined;
let availabilityEpoch = 0;
let exampleSession = 'desktop-' + crypto.randomUUID();
let returnExpectation: DesktopReturnExpectation | undefined;
let controlStateKey = '';
function error(cause?: unknown) {
  const node = element('desktop-error'); node.hidden = !cause;
  const message = cause instanceof Error ? cause.message : String(cause || '');
  node.textContent = message.replace(/^(?:Error:\s*)?Error invoking remote method '[^'\r\n]{1,128}':\s*(?:Error:\s*)?/, '');
}
function updateCommand() {
  (element('desktop-mode') as HTMLSelectElement).disabled = !!currentStatus?.session || !selected;
  element('desktop-mode-help').textContent = (element('desktop-mode') as HTMLSelectElement).value === 'background'
    ? '你可以继续使用其他应用；使用目标应用时任务会暂停。后台模式不移动鼠标、不模拟按键、不主动切换前台。'
    : '前台交互可能切换窗口、移动鼠标或发送按键；检测到你的键盘鼠标操作时会暂停。';
  const command = element('desktop-command'), hint = element('desktop-command-hint');
  command.hidden = !selected || currentStatus?.available !== true;
  if (command.hidden) {
    command.textContent = ''; hint.textContent = '先选择当前窗口，再复制 CLI 示例。';
  } else if (currentStatus?.session) {
    command.textContent = 'ppilot desktop status';
    hint.textContent = '当前已有桌面任务，请先检查状态。';
  } else {
    command.textContent = `ppilot desktop claim --session ${exampleSession} --window ${selected} --mode ${(element('desktop-mode') as HTMLSelectElement).value}`;
    hint.textContent = '每个新任务需换任务名；刷新窗口或重新选择可更新示例。';
  }
}
function clearSelection(message: string) {
  selected = ''; previewVersion++;
  element('desktop-selected').textContent = '选择一个窗口';
  element('desktop-preview').textContent = message;
  updateCommand();
}
function windowListMessage(message: string) {
  const note = document.createElement('p'); note.className = 'desktop-empty'; note.setAttribute('role', 'status'); note.textContent = message;
  element('desktop-windows').replaceChildren(note);
}
function status(state: DesktopStatus) {
  if (currentStatus?.available !== state.available) availabilityEpoch++;
  if (currentStatus?.session && !state.session) exampleSession = 'desktop-' + crypto.randomUUID();
  currentStatus = state;
  const session = state.session, container = element('desktop-session');
  controlStateKey = JSON.stringify([session?.name, session?.revision, session?.state, state.inputObservation?.generation, state.inputObservation?.phase]);
  returnExpectation = session?.state === 'paused' && state.inputObservation?.generation && Number.isSafeInteger(session.revision)
    ? { session: session.name, generation: state.inputObservation.generation, revision: session.revision } : undefined;
  const preparing = state.inputObservation?.phase === 'arming';
  const label = preparing ? '正在准备控制' : state.inputObservation?.phase === 'pending' ? '等待重新读取窗口' : session?.state === 'active' ? '正在控制' : '已暂停';
  container.hidden = !session;
  container.querySelector('span')!.textContent = session ? `${session.name} · ${session.mode === 'background' ? '后台语义' : '前台交互'} · ${label} · ${session.window.title}` : '';
  (element('desktop-mode') as HTMLSelectElement).disabled = !!session;
  if (session) (element('desktop-mode') as HTMLSelectElement).value = session.mode || 'interactive';
  const explanation = element('desktop-pause-reason');
  explanation.textContent = session?.state === 'paused' ? state.inputObservation?.message || '' : '';
  explanation.hidden = !explanation.textContent;
  container.querySelector<HTMLButtonElement>('[data-control="takeover"]')!.hidden = session?.state !== 'active';
  container.querySelector<HTMLButtonElement>('[data-control="return"]')!.hidden = preparing || !returnExpectation;
  if (!state.available) {
    windowListMessage(state.reason || '桌面控制暂不可用');
    element('desktop-count').textContent = '';
    clearSelection(state.reason || '桌面控制暂不可用');
  }
  updateCommand();
}
async function select(window: DesktopWindow) {
  if (currentStatus?.available !== true) return;
  if (!currentStatus.session) exampleSession = 'desktop-' + crypto.randomUUID();
  selected = window.id; const revision = ++previewVersion;
  for (const button of element('desktop-windows').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.window === selected));
  element('desktop-selected').textContent = window.title;
  updateCommand();
  element('desktop-preview').textContent = '正在获取窗口画面…'; error();
  try {
    const observed = await api.preview(window.id);
    if (revision !== previewVersion) return;
    if (!observed.image) throw new Error('这个窗口暂时无法截图。');
    const image = new Image(); image.alt = window.title + '的窗口截图';
    image.src = `data:${observed.image.mimeType};base64,${observed.image.data}`;
    element('desktop-preview').replaceChildren(image);
  } catch (cause) { if (revision === previewVersion) { element('desktop-preview').textContent = '无法获取窗口画面，请刷新后重试。'; error(cause); } }
}
async function refresh(renewExample = false) {
  if (busy) return; busy = true;
  const refreshButton = element('desktop-refresh') as HTMLButtonElement; refreshButton.disabled = true; setButtonLoading(refreshButton, true);
  element('desktop-windows').setAttribute('aria-busy', 'true');
  try {
    const state = await statusFeed.refresh();
    if (!state) { if (!windowsLoaded) windowListMessage('窗口列表读取失败，请点击上方“刷新窗口”重试。'); return; }
    error();
    if (!state.available || currentStatus?.available !== true) return;
    const epoch = availabilityEpoch;
    const result = await api.windows();
    if (epoch !== availabilityEpoch || currentStatus?.available !== true) return;
    windowsLoaded = true;
    if (renewExample && !currentStatus.session) exampleSession = 'desktop-' + crypto.randomUUID();
    updateCommand();
    element('desktop-count').textContent = String(result.windows.length) + (result.truncated ? '（部分窗口）' : '');
    const buttons = result.windows.map(window => {
      const button = document.createElement('button'); button.className = 'desktop-window'; button.dataset.window = window.id;
      button.setAttribute('aria-current', String(selected === window.id));
      const title = document.createElement('strong'); title.textContent = window.title; title.title = window.title;
      const process = document.createElement('small');
      process.textContent = [window.process, window.pid, ...(window.enabled === false ? ['暂不接收输入'] : []), ...(window.minimized === true ? ['已最小化'] : [])].join(' · ');
      button.append(title, process); button.onclick = () => void select(window); return button;
    });
    element('desktop-windows').replaceChildren(...buttons);
    if (!buttons.length) windowListMessage('当前没有可读取的窗口。打开目标应用后刷新窗口。');
    if (selected && !result.windows.some(window => window.id === selected)) {
      clearSelection('当前列表中未找到该窗口，请刷新后重新选择。');
    }
  } catch (cause) { error(cause); if (!windowsLoaded) windowListMessage('窗口列表读取失败，请点击上方“刷新窗口”重试。'); }
  finally { busy = false; refreshButton.disabled = false; setButtonLoading(refreshButton, false); element('desktop-windows').setAttribute('aria-busy', 'false'); }
}
element('desktop-refresh').onclick = () => void refresh(true);
element('desktop-mode').onchange = () => {
  updateCommand();
};
for (const button of root.querySelectorAll<HTMLButtonElement>('[data-control]')) button.onclick = async () => {
  const action = button.dataset.control as 'takeover' | 'return' | 'stop', expected = returnExpectation;
  if (action === 'return' && !expected) { await statusFeed.refresh(); return; }
  const context = controlStateKey; error();
  try {
    if (action === 'return') await api.control(action, expected!); else await api.control(action);
    await statusFeed.refresh(); if (context === controlStateKey) error();
  } catch (cause) { if (context === controlStateKey) error(cause); }
};
// Keep the selected console's control state current even while another app
// covers it: window capture can still expose this page in the background.
const statusFeed = followDesktopStatus(api, status, error);
const refreshStatus = () => { if (window.workspacePane?.active !== false) void statusFeed.refresh(); };
const statusTimer = setInterval(refreshStatus, 1500);
window.addEventListener('pagehide', () => { clearInterval(statusTimer); statusFeed.dispose(); }, { once: true });
onWorkspaceVisibilityChanged(refreshStatus);
void refresh();
