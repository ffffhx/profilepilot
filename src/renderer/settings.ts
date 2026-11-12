import type { StartupSettings } from "../shared/startup-settings";
import type { AppUpdateState } from '../shared/app-update';
import { profileApi } from "./api";
import { workspaceSwitcher, workspaceIdentityBar, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { onWorkspaceVisibilityChanged, workspaceHidden } from "./workspace-lifecycle";
import { experimentalAgentEnabled, setExperimentalAgentEnabled, experimentalProxyRoutingEnabled, setExperimentalProxyRoutingEnabled, onExperimentalFeaturesChanged } from "./experimental-features";

const root = document.getElementById("settings")!;
root.innerHTML = `${workspaceSwitcher("settings")}${workspaceIdentityBar()}
  <header class="settings-header"><h1>设置</h1><p>管理 ProfilePilot 的全局偏好</p></header>
  <main class="global-settings">
    <section aria-labelledby="app-update-heading">
      <h2 id="app-update-heading">版本与更新</h2>
      <div class="setting-card"><div class="setting-row">
        <div class="setting-copy"><h3 id="app-version">ProfilePilot</h3><p id="app-update-status" role="status">读取版本中…</p></div>
        <button type="button" class="settings-update-button" id="app-update-button">检查更新</button>
      </div></div>
    </section>
    <section aria-labelledby="startup-heading">
      <h2 id="startup-heading">启动</h2>
      <div class="setting-card">
        <div class="setting-row">
          <div class="setting-copy"><h3 id="startup-label">开机自启动</h3><p id="startup-description">登录系统后自动启动 ProfilePilot</p></div>
          <div class="setting-control">
            <span id="startup-status" role="status" aria-live="polite">读取中…</span>
            <button type="button" class="setting-switch" role="switch" data-action="toggle-startup" aria-checked="false" aria-labelledby="startup-label" aria-describedby="startup-description startup-status startup-note" disabled></button>
          </div>
        </div>
        <p id="startup-note" class="setting-note" role="status" hidden></p>
      </div>
      <button type="button" class="settings-refresh" data-action="refresh-startup">刷新状态</button>
    </section>
    <section id="experimental-features" aria-labelledby="experimental-heading">
      <h2 id="experimental-heading">实验性功能</h2>
      <div class="setting-card">
        <div class="setting-row">
          <div class="setting-copy"><h3 id="experimental-agent-label">Agent（实验性）</h3><p id="experimental-agent-description">任务与对话功能仍在完善，默认隐藏。开启后在左侧显示 Agent。</p></div>
          <div class="setting-control">
            <span id="experimental-agent-status" role="status" aria-live="polite"></span>
            <button type="button" class="setting-switch" role="switch" data-action="toggle-experimental-agent" aria-checked="false" aria-labelledby="experimental-agent-label" aria-describedby="experimental-agent-description experimental-agent-status experimental-agent-note"></button>
          </div>
        </div>
        <p id="experimental-agent-note" class="setting-note" role="alert" hidden></p>
      </div>
      <div class="setting-card">
        <div class="setting-row">
          <div class="setting-copy"><h3 id="experimental-proxy-routing-label">代理分流（实验性）</h3><p id="experimental-proxy-routing-description">为独立 Profile 配置代理与分流规则，默认隐藏。开启后在 Profile 的更多菜单中显示“代理分流”。</p></div>
          <div class="setting-control">
            <span id="experimental-proxy-routing-status" role="status" aria-live="polite"></span>
            <button type="button" class="setting-switch" role="switch" data-action="toggle-experimental-proxy-routing" aria-checked="false" aria-labelledby="experimental-proxy-routing-label" aria-describedby="experimental-proxy-routing-description experimental-proxy-routing-status experimental-proxy-routing-note"></button>
          </div>
        </div>
        <p id="experimental-proxy-routing-note" class="setting-note" role="alert" hidden></p>
      </div>
    </section>
  </main>`;

async function renderAppUpdate(): Promise<void> {
  try {
    const state: AppUpdateState = await window.appUpdate.status();
    document.getElementById('app-version')!.textContent = `ProfilePilot ${state.version} · ${state.channel === 'development' ? '开发版' : '正式版'}${state.commit ? ` · ${state.commit.slice(0, 8)}` : ''}`;
    document.getElementById('app-update-status')!.textContent = state.error || (state.channel === 'development' ? '使用本地代码构建，线上正式版不会覆盖此版本。'
      : state.phase === 'downloading' ? `正在下载 ${Math.floor(state.percent || 0)}%` : state.phase === 'checking' ? '正在检查更新…'
      : state.phase === 'downloaded' ? '更新已下载，可以安装并重启。' : state.nextVersion ? `发现新版本 ${state.nextVersion}` : '自动检查新版本，由你选择安装时间。');
    const button = document.getElementById('app-update-button') as HTMLButtonElement;
    button.disabled = ['checking', 'downloading', 'installing'].includes(state.phase);
    button.textContent = state.channel === 'development' ? '开发版说明' : state.phase === 'downloaded' ? '安装更新' : '检查更新';
  } catch (error) { document.getElementById('app-update-status')!.textContent = String(error); }
}
document.getElementById('app-update-button')!.addEventListener('click', () => void window.appUpdate.open().finally(renderAppUpdate));
void renderAppUpdate();
const updateTimer = setInterval(() => { if (!document.hidden) void renderAppUpdate(); }, 1500);
window.addEventListener('pagehide', () => clearInterval(updateTimer), { once: true });

const experiments = [
  { name: "agent", enabled: experimentalAgentEnabled, set: setExperimentalAgentEnabled },
  { name: "proxy-routing", enabled: experimentalProxyRoutingEnabled, set: setExperimentalProxyRoutingEnabled }
];
function renderExperiments(): void {
  for (const experiment of experiments) {
    const enabled = experiment.enabled();
    root.querySelector(`[data-action="toggle-experimental-${experiment.name}"]`)!.setAttribute("aria-checked", String(enabled));
    const label = document.getElementById(`experimental-${experiment.name}-status`)!;
    label.textContent = enabled ? "已开启" : "已关闭";
    label.dataset.state = enabled ? "enabled" : "disabled";
  }
}
for (const experiment of experiments) {
  root.querySelector(`[data-action="toggle-experimental-${experiment.name}"]`)!.addEventListener("click", () => {
    const notice = document.getElementById(`experimental-${experiment.name}-note`)!;
    try { experiment.set(!experiment.enabled()); notice.hidden = true; }
    catch { notice.textContent = "未能保存设置，请重试。"; notice.hidden = false; }
    renderExperiments();
  });
}
onExperimentalFeaturesChanged(renderExperiments);
renderExperiments();

const toggle = root.querySelector<HTMLButtonElement>('[data-action="toggle-startup"]')!;
const refresh = root.querySelector<HTMLButtonElement>('[data-action="refresh-startup"]')!;
const status = document.getElementById("startup-status")!;
const note = document.getElementById("startup-note")!;
let settings: StartupSettings | undefined;
let busy: "read" | "save" | undefined;
let error = "";

function render(): void {
  const issue = error || settings?.error || "";
  status.textContent = busy ? busy === "save" ? "保存中…" : "读取中…"
    : !settings ? "读取失败" : !settings.supported ? "不可用"
    : issue ? "状态待确认" : settings.requiresApproval ? "待系统允许" : settings.enabled ? "已开启" : "已关闭";
  status.dataset.state = issue ? "error" : settings?.requiresApproval ? "approval" : settings?.enabled ? "enabled" : "disabled";
  toggle.setAttribute("aria-checked", String(settings?.enabled === true));
  toggle.disabled = Boolean(busy || error || !settings?.supported);
  refresh.disabled = Boolean(busy);
  note.textContent = issue || (settings?.requiresApproval ? "请在 macOS 系统设置的「登录项」中允许 ProfilePilot 自启动。" : "");
  note.hidden = !note.textContent;
}

async function update(enabled?: boolean): Promise<void> {
  if (busy) return;
  busy = enabled === undefined ? "read" : "save";
  error = "";
  render();
  try {
    settings = await (enabled === undefined ? profileApi().getStartupSettings() : profileApi().setStartupEnabled(enabled));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy = undefined;
    render();
  }
}

toggle.addEventListener("click", () => { if (settings?.supported) void update(!settings.enabled); });
refresh.addEventListener("click", () => void update());
onWorkspaceVisibilityChanged(() => { if (!workspaceHidden()) void update(); });
window.addEventListener("focus", () => { if (!workspaceHidden()) void update(); });
// The shell owns native focus while this page is embedded in its iframe.
if (window.parent !== window) window.parent.addEventListener("focus", () => { if (!workspaceHidden()) void update(); });
refreshWorkspaceSwitcher();
void update();
