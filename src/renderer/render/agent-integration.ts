import { store } from "../state";
import { profilePilotSetupState } from "../../shared/profilepilot-setup";
import type {
  AgentIntegrationDiagnostic,
  AgentSkillDiagnostic,
  AgentWrapperDiagnostic
} from "../types";
import { escapeHtml, renderButtonLabel } from "../util";
import { renderBrowserExtensionPanel } from "./browser-extension";

function installedWrapperCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.wrappers.filter(wrapperReady).length || 0;
}

function unifiedSkill(diagnostic: AgentIntegrationDiagnostic | null): AgentSkillDiagnostic | null {
  return diagnostic?.skills.find(skill => skill.key === "profilepilot") || diagnostic?.managementCli?.skill || null;
}

export function renderOnboardingModal(): string {
  return `
    <div class="modal-backdrop app-modal-backdrop onboarding-backdrop" data-action="dismiss-onboarding">
      <section class="modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="onboarding-head">
          <div>
            <span class="modal-kicker">First Flight</span>
            <h2 id="onboarding-title">一次安装，准备好 Agent 工具</h2>
          </div>
          <button type="button" class="modal-icon-close" data-action="dismiss-onboarding" aria-label="关闭新手引导">×</button>
        </div>
        <p class="onboarding-lead">安装 ProfilePilot CLI，即可获得命令工具和配套的 Agent 使用指引。</p>
        <div class="onboarding-route" aria-label="接入顺序">
          <article>
            <span>01</span>
            <div><strong>安装 ProfilePilot CLI</strong><p>自动配置命令工具和 Agent 使用指引，一起更新并保留个人控制偏好。</p></div>
          </article>
          <i aria-hidden="true"></i>
          <article>
            <span>02</span>
            <div><strong>选择连接方式</strong><p>ppilot browser 支持扩展和 Gateway 两种连接，浏览器驱动已内置。</p></div>
          </article>
          <i aria-hidden="true"></i>
          <article>
            <span>03</span>
            <div><strong>确认目标 Profile</strong><p>复用所选浏览器的登录态，并遵守会话独占、用户接管和结束规则。</p></div>
          </article>
        </div>
        ${renderInputGuardPermissionCard("onboarding")}
        <div class="onboarding-safety-note">
          <span>CONTROL RULE</span>
          <p>用户接管浏览器时，CLI 会停止 Agent 操作；随附指引会指导 Agent 等待交还控制。</p>
        </div>
        <div class="modal-actions onboarding-actions">
          <button type="button" data-action="dismiss-onboarding">稍后再说</button>
          <button type="button" class="primary" data-action="start-agent-integration">开始配置</button>
        </div>
      </section>
    </div>
  `;
}

export function renderAgentIntegrationPanel(): string {
  const diagnostic = store.agentIntegrationDiagnostic;
  const pending = store.agentIntegrationLoading || store.busy || !diagnostic;
  return `
    <section class="agent-integration-page" aria-labelledby="agent-integration-title">
      <h2 id="agent-integration-title" class="tools-visually-hidden">Agent 工作环境</h2>
      ${renderBrowserExtensionPanel()}
      <div class="tools-overview-grid">
        ${renderManagementCliPanel(diagnostic, pending)}
        <section id="tools-phone-app" class="tools-overview-card" aria-labelledby="tools-phone-app-title">
          <div class="tools-overview-summary">
            <span class="tools-overview-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/></svg></span>
            <span class="tools-overview-copy"><span class="tools-overview-title"><strong id="tools-phone-app-title">ProfilePilot 安卓 App</strong><em>可选安装</em></span>
              <span class="tools-overview-line"><small>基础控制免安装；App 增加控件识别、中文填写、手机端暂停与状态同步</small><a class="tools-phone-link" href="./phones.html">安装与连接</a></span>
            </span>
          </div>
        </section>
        ${renderControlPreferences(diagnostic, pending)}
      </div>
      <details id="tools-connection-diagnostics" class="tools-diagnostics">
        <summary><span class="tools-help-icon" aria-hidden="true">?</span><span>需要帮助？查看连接诊断</span><span class="tools-diagnostic-arrow" aria-hidden="true">›</span></summary>
        <div class="tools-disclosure-body">
          <div class="agent-section-heading"><div><strong>连接诊断</strong><p>安装统一 CLI，再确认目标 Profile 的扩展或 Gateway 连接。</p></div>
            <button type="button" data-action="refresh-agent-integration" ${pending ? "disabled" : ""}>${renderButtonLabel(pending, "重新检测", "检测中…")}</button>
          </div>
          ${diagnostic?.inspectedAt ? `<p class="tools-inspected-at">最近检测：${escapeHtml(new Date(diagnostic.inspectedAt).toLocaleString())}</p>` : ""}
          ${[diagnostic?.managementCli?.error, unifiedSkill(diagnostic)?.error, diagnostic?.shellIntegration.error].filter(Boolean).map(error => `<p class="tools-diagnostic-error" role="alert">${escapeHtml(error!)}</p>`).join("")}
          ${renderSessionBridge(diagnostic)}
          ${renderInputGuardPermissionCard("integration")}
        </div>
      </details>
    </section>`;
}

function overviewIcon(kind: "cli" | "preferences"): string {
  const paths = {
    cli: '<path d="m6 7 5 5-5 5m8 0h5"/>',
    preferences: '<path d="m10 3-.6 2.1-2 .9-2-.5-2 3.5 1.5 1.6v2.3L3.4 15l2 3.5 2-.5 2 .9.6 2.1h4l.6-2.1 2-.9 2 .5 2-3.5-1.5-1.6v-2.3L20.6 9l-2-3.5-2 .5-2-.9L14 3Z"/><circle cx="12" cy="12" r="3"/>'
  };
  return `<span class="tools-overview-icon ${kind}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg></span>`;
}

function renderManagementCliPanel(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const setup = profilePilotSetupState(diagnostic);
  const status = pending ? "检测中" : setup.status;
  const action = setup.ready ? "检查 / 更新" : setup.needsUpdate ? "更新 ProfilePilot CLI" : setup.hasParts ? "修复 ProfilePilot CLI" : "安装 ProfilePilot CLI";
  return `
    <section id="tools-cli-card" aria-labelledby="management-cli-title" class="tools-overview-card tools-cli-card ${pending ? "pending" : setup.ready ? "ready" : "blocked"}" data-tools-search="ProfilePilot CLI ppilot browser electron phone Skill Agent 使用指引 扩展 Gateway 终端 命令 安装">
      <div class="tools-overview-summary">
        ${overviewIcon("cli")}
        <span class="tools-overview-copy"><span class="tools-overview-title"><strong id="management-cli-title">ProfilePilot CLI</strong><em>${status}</em></span>
          <span class="tools-overview-line"><small>命令工具与 Agent 使用指引，一次安装，一起更新</small><button type="button" data-action="install-profilepilot-cli" ${pending ? "disabled" : ""}>${pending ? "检测中…" : action}</button></span>
        </span>
      </div>
    </section>`;
}

function renderControlPreferences(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const skill = unifiedSkill(diagnostic);
  const canEdit = !pending && Boolean(skill?.installedTargetCount);
  return `<section id="tools-control-preferences" aria-labelledby="control-preferences-card-title" class="tools-overview-card tools-preferences-card" data-tools-search="控制偏好 浏览器 Electron 手机 安卓 Profile 设备 连接方式 browser electron phone 编辑">
    <div class="tools-overview-summary">
      ${overviewIcon("preferences")}
      <span class="tools-overview-copy"><span class="tools-overview-title"><strong id="control-preferences-card-title">控制偏好</strong></span>
        <span class="tools-overview-line"><small>浏览器、Electron 应用与手机的使用规则</small><button type="button" data-action="open-control-preferences" ${canEdit ? "" : "disabled"}>编辑偏好</button></span>
      </span>
    </div>
  </section>`;
}
function renderSessionBridge(diagnostic: AgentIntegrationDiagnostic | null): string {
  const wrappers = installedWrapperCount(diagnostic);
  const shell = diagnostic?.shellIntegration;
  const ready = wrappers > 0 && Boolean(shell?.installed);
  const status = ready
    ? `${wrappers} 个 Wrapper 已进入新 Agent 会话的 PATH`
    : wrappers > 0
      ? "Wrapper 已安装，但会话识别需要修复"
      : "安装第一个 Wrapper 时自动启用会话识别";
  return `
    <div class="agent-session-bridge ${ready ? "ready" : wrappers > 0 ? "blocked" : "idle"}">
      <span>Agent 会话识别</span>
      <strong>${escapeHtml(status)}</strong>
      <small>${escapeHtml(shell?.path || (store.state?.platform === "win32" ? "Windows 用户 PATH" : "~/.zshenv"))} · 只对之后新开的 Codex / Claude 会话生效</small>
      ${wrappers > 0 && !shell?.installed ? `<button type="button" data-action="enable-shell-integration">修复会话识别</button>` : ""}
    </div>
  `;
}

function renderInputGuardPermissionCard(context: "onboarding" | "integration"): string {
  const permission = store.agentIntegrationDiagnostic?.inputGuard || null;
  const windows = permission?.platform === "win32";
  const inspecting = store.agentIntegrationLoading && !permission;
  const requesting = store.inputGuardPermissionLoading;
  const state = inspecting || !permission
    ? "pending"
    : !permission.supported
      ? "skipped"
      : permission.granted
        ? "ready"
        : "blocked";
  const title = state === "ready"
    ? "点击保护已授权"
    : state === "skipped"
      ? "当前系统无需授权"
      : state === "pending"
        ? "正在检查点击保护"
        : "等待辅助功能授权";
  const status = state === "ready"
    ? "PROTECTED"
    : state === "skipped"
      ? "NOT REQUIRED"
      : state === "pending"
        ? "CHECKING"
        : "ACTION NEEDED";
  const detail = state === "ready"
    ? "Agent 控制浏览器时，可以拦截受管 Chrome 窗口的鼠标点击、拖动与滚动。"
    : state === "skipped"
      ? windows
        ? "Windows Input Guard 使用系统鼠标钩子，无需额外的辅助功能授权。"
        : "Input Guard 的辅助功能权限只在 macOS 上需要。"
      : state === "pending"
        ? "正在确认 ProfilePilot Input Guard 的 macOS 辅助功能权限。"
        : "不授权不影响 Profile 管理和 Agent 连接，但无法阻止 Agent 操作期间的手动点击。";
  const labelId = `input-guard-permission-${context}`;

  return `
    <section class="input-guard-permission ${context} ${state}" aria-labelledby="${labelId}">
      <div class="input-guard-mark" aria-hidden="true"><span>IG</span></div>
      <div class="input-guard-copy">
        <span>${windows ? "WINDOWS INPUT GUARD" : "MACOS SAFETY CHECKPOINT"}</span>
        <strong id="${labelId}">${title}</strong>
        <p>${detail}</p>
        ${permission?.error ? `<small class="input-guard-error">${escapeHtml(permission.error)}</small>` : ""}
        ${permission?.supported ? `<small>授权对象：<code>${escapeHtml(permission.appName)}</code> · 不读取键盘输入</small>` : ""}
      </div>
      <div class="input-guard-controls">
        <em>${status}</em>
        ${permission?.supported && !permission.granted ? `
          <button type="button" class="primary ${requesting ? "loading" : ""}" data-action="request-input-guard-permission" ${requesting ? "disabled" : ""}>
            ${renderButtonLabel(requesting, "请求辅助功能授权", "正在请求…")}
          </button>
          <button type="button" data-action="open-input-guard-settings" ${requesting ? "disabled" : ""}>打开系统设置</button>
        ` : ""}
        ${permission?.supported ? `
          <button type="button" class="compact" data-action="refresh-agent-integration" ${store.agentIntegrationLoading || requesting ? "disabled" : ""}>重新检测</button>
        ` : ""}
      </div>
    </section>
  `;
}

function wrapperReady(wrapper: AgentWrapperDiagnostic | null | undefined): boolean {
  return Boolean(wrapper?.wrapperInstalled && wrapper.launcherInstalled);
}
