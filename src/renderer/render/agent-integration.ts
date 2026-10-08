import { store } from "../state";
import { profilePilotSetupState } from "../../shared/profilepilot-setup";
import type {
  AgentIntegrationDiagnostic,
  AgentSkillDiagnostic,
  AgentToolDiagnostic,
  AgentWrapperDiagnostic,
  BrowserDriverKind
} from "../types";
import { escapeHtml, renderButtonLabel } from "../util";
import { renderBrowserExtensionPanel, renderBrowserExtensionSummary } from "./browser-extension";

const TOOL_ORDER: BrowserDriverKind[] = ["agent-browser", "playwright-cli", "chrome-devtools-mcp"];

const TOOL_COPY: Record<BrowserDriverKind, { label: string; description: string }> = {
  "agent-browser": {
    label: "agent-browser",
    description: "面向 Agent 的浏览器操作 CLI，继续使用 open、snapshot、click 等原生命令。"
  },
  "playwright-cli": {
    label: "Playwright CLI",
    description: "微软提供的 Playwright 命令行工具，通过受控 attach 接入真实 Chrome。"
  },
  "chrome-devtools-mcp": {
    label: "Chrome DevTools MCP",
    description: "作为 MCP Server 接入真实 Chrome；只检测已经安装的本机 CLI。"
  }
};

function installedToolCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.tools.filter((tool) => tool.availability === "installed").length || 0;
}

function installedWrapperCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.wrappers.filter(wrapperReady).length || 0;
}

function installedSkillCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return unifiedSkill(diagnostic)?.installed ? 1 : 0;
}

function unifiedSkill(diagnostic: AgentIntegrationDiagnostic | null): AgentSkillDiagnostic | null {
  return diagnostic?.skills.find(skill => skill.key === "profilepilot") || diagnostic?.managementCli?.skill || null;
}

function renderToolsStatusSummary(diagnostic: AgentIntegrationDiagnostic | null): string {
  const pending = store.agentIntegrationLoading || !diagnostic;
  const setup = profilePilotSetupState(diagnostic);
  const status = pending ? "正在检测安装状态" : setup.status;
  return `<section class="tools-status-summary" aria-label="配套工具状态概览">
    ${renderBrowserExtensionSummary()}
    <div class="tools-status-item ${pending ? "pending" : setup.ready ? "ready" : "blocked"}">
      <span class="tools-status-mark" aria-hidden="true">${pending ? "…" : setup.ready ? "✓" : "!"}</span>
      <div><strong>ProfilePilot CLI ${status}</strong><small>命令工具与 Agent 使用指引</small></div>
    </div>
  </section>`;
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
      ${renderToolsStatusSummary(diagnostic)}
      ${renderBrowserExtensionPanel()}
      <div class="tools-overview-grid">
        ${renderManagementCliPanel(diagnostic, pending)}
        ${renderGatewayOverview(diagnostic, pending)}
        ${renderControlPreferences(diagnostic, pending)}
      </div>
      <details id="tools-connection-diagnostics" class="tools-diagnostics">
        <summary><span class="tools-help-icon" aria-hidden="true">?</span><span>需要帮助？查看连接诊断</span><span class="tools-diagnostic-arrow" aria-hidden="true">›</span></summary>
        <div class="tools-disclosure-body">
          <div class="agent-section-heading"><div><strong>连接诊断</strong><p>安装统一 CLI，再确认目标 Profile 的扩展或 Gateway 连接。</p></div>
            <button type="button" data-action="refresh-agent-integration" ${pending ? "disabled" : ""}>${renderButtonLabel(pending, "重新检测", "检测中…")}</button>
          </div>
          ${diagnostic?.inspectedAt ? `<p class="tools-inspected-at">最近检测：${escapeHtml(new Date(diagnostic.inspectedAt).toLocaleString())}</p>` : ""}
          ${renderSessionBridge(diagnostic)}
          ${renderInputGuardPermissionCard("integration")}
        </div>
      </details>
    </section>`;
}

function overviewIcon(kind: "skill" | "cli" | "gateway" | "preferences"): string {
  const paths = {
    skill: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    cli: '<path d="m6 7 5 5-5 5m8 0h5"/>',
    gateway: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="m10.5 7.5-4 9m7-9 4 9M8 19h8"/>',
    preferences: '<path d="m10 3-.6 2.1-2 .9-2-.5-2 3.5 1.5 1.6v2.3L3.4 15l2 3.5 2-.5 2 .9.6 2.1h4l.6-2.1 2-.9 2 .5 2-3.5-1.5-1.6v-2.3L20.6 9l-2-3.5-2 .5-2-.9L14 3Z"/><circle cx="12" cy="12" r="3"/>'
  };
  return `<span class="tools-overview-icon ${kind}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg></span>`;
}

function renderBundledInstructions(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const skill = unifiedSkill(diagnostic);
  const installed = Boolean(skill?.installed);
  const external = installed && !skill?.managed;
  const stale = installed && skill?.managed && !skill.upToDate;
  const partial = Boolean(skill?.installedTargetCount) && !installed;
  const status = pending ? "检测中" : external ? "已安装 · 外部管理" : stale ? "需要更新" : installed ? "已安装" : partial ? "部分安装" : "未安装";
  const tone = pending ? "pending" : installed && !stale ? "ready" : "blocked";
  return `
      <section id="tools-guide-details" aria-label="Agent 使用指引">
        ${renderSetupStage({
          index: "02", label: "Agent 使用指引（随 CLI 安装）", status, tone,
          detail: `共享 Agent / Codex / Claude · ${skill?.installedTargetCount || 0}/${skill?.targetCount || 3} 个目录`,
          actions: ""
        })}
        ${skill?.targets.map(target => `<p class="tools-guide-target"><strong>${escapeHtml(target.label)}</strong> · ${target.installed ? !target.managed ? "外部维护" : target.upToDate ? "已更新" : "待更新" : "待安装"}<code class="tools-path">${escapeHtml(target.path)}</code></p>`).join("") || ""}
        <p>指引以 <code>SKILL.md</code> 供 Agent 读取，与 CLI 同步更新。个人偏好 <code>local/browser-routing.md</code> 在更新和移除时保留。</p>
        ${skill?.targets.some(target => target.installed && !target.managed) || external ? '<p>外部维护的指引会保留；如版本不同，请通过原工具更新后重新检测。</p>' : ""}
        ${skill?.error ? `<p class="tools-diagnostic-error" role="alert">${escapeHtml(skill.error)}</p>` : ""}
        ${skill?.legacySkillPaths?.length ? `<p>检测到旧版指引；安装时会备份并迁移本工具管理的版本，外部版本保留。</p>` : ""}
      </section>`;
}

function renderManagementCliPanel(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const cli = diagnostic?.managementCli || null;
  const setup = profilePilotSetupState(diagnostic);
  const status = pending ? "检测中" : setup.status;
  const cliReady = Boolean(cli?.installed && cli.upToDate && diagnostic?.shellIntegration.installed);
  const cliStatus = pending ? "检测中" : cliReady ? "已就绪" : cli?.installed && !cli.upToDate ? "需要更新" : cli?.installed ? "终端连接待修复" : "未安装";
  const action = setup.ready ? "检查 / 更新" : setup.needsUpdate ? "更新 ProfilePilot CLI" : setup.hasParts ? "修复 ProfilePilot CLI" : "安装 ProfilePilot CLI";
  return `
    <details id="tools-cli-details" class="tools-overview-card tools-cli-card ${pending ? "pending" : setup.ready ? "ready" : "blocked"}" data-tools-search="ProfilePilot CLI ppilot browser phone Skill Agent 使用指引 扩展 Gateway 终端 命令 安装">
      <summary class="tools-overview-summary">
        ${overviewIcon("cli")}
        <span class="tools-overview-copy"><span class="tools-overview-title"><strong id="management-cli-title">ProfilePilot CLI</strong><em>${status}</em></span>
          <span class="tools-overview-line"><small>命令工具与 Agent 使用指引，一次安装，一起更新</small><button type="button" data-action="install-profilepilot-cli" ${pending ? "disabled" : ""}>${pending ? "检测中…" : action}</button></span>
        </span>
      </summary>
      <div class="tools-disclosure-body">
        <p><code>ppilot</code> 提供浏览器、手机、Profile 管理与 Agent 对话命令。安装时同时配置命令工具和随附指引，无需分别安装 Skill。</p>
        ${renderSetupStage({
          index: "01", label: "命令工具（ppilot）", status: cliStatus,
          tone: pending ? "pending" : cliReady ? "ready" : "blocked",
          detail: cli?.installed ? cli.launcherPath : "包含浏览器与手机控制入口，以及内置驱动",
          actions: pending ? "" : '<button type="button" data-action="copy-agent-command" data-command="ppilot --help">复制帮助命令</button>'
        })}
        ${renderBundledInstructions(diagnostic, pending)}
        <div class="agent-management-cli-example"><code>ppilot browser status</code><span>扩展连接：独立浏览器服务自动启动，无需保持桌面应用打开。</span></div>
        <div class="agent-management-cli-example"><code>ppilot browser --cdp PORT snapshot -i</code><span>Gateway 连接：PORT 为目标的 Agent 逻辑端口。Agent 会话自动识别，手动使用时添加 <code>--session 任务名</code>。</span></div>
        <div class="agent-management-cli-example"><code>ppilot browser --help</code><span>查看两种连接的命令。旧 agent-browser 命令继续兼容。</span></div>
        <div class="agent-management-cli-example"><code>ppilot phone --help</code><span>查看手机连接、控制会话与 ADB 接入命令。</span></div>
        <div class="agent-management-cli-example"><code>ppilot profile list --json</code><span>删除必须显式添加 <code>--yes</code>；系统 Profile 的管理操作只读。</span></div>
        <div class="agent-management-cli-example"><code>ppilot chat --profile "Profile 名称"</code><span>任务与桌面同步；使用 <code>ppilot --help</code> 查看脚本调用和恢复任务的命令。</span></div>
        ${cli?.error ? `<p class="tools-diagnostic-error" role="alert">${escapeHtml(cli.error)}</p>` : ""}
        ${diagnostic?.shellIntegration.error ? `<p class="tools-diagnostic-error" role="alert">${escapeHtml(diagnostic.shellIntegration.error)}</p>` : ""}
        ${setup.hasParts ? `<div class="agent-stage-actions"><button type="button" class="danger-ghost" data-action="remove-profilepilot-cli" ${pending ? "disabled" : ""}>移除 CLI 与随附指引</button><span class="agent-external-note">个人偏好和外部维护的指引会保留。</span></div>` : ""}
      </div>
    </details>`;
}

function renderGatewayOverview(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const readyCount = diagnostic && unifiedSkill(diagnostic)?.installed && diagnostic.shellIntegration.installed
    ? TOOL_ORDER.filter(key => diagnostic.tools.some(tool => tool.key === key && tool.availability === "installed") && wrapperReady(diagnostic.wrappers.find(wrapper => wrapper.key === key))).length : 0;
  const status = pending ? "检测中" : readyCount ? `${readyCount} 套可用` : "可选";
  return `<details id="tools-gateway-details" class="tools-overview-card tools-gateway-card ${pending ? "pending" : readyCount ? "ready" : "blocked"}" data-tools-search="Gateway agent-browser Playwright CLI Chrome DevTools MCP Wrapper 会话">
    <summary class="tools-overview-summary">
      ${overviewIcon("gateway")}
      <span class="tools-overview-copy"><span class="tools-overview-title"><strong id="agent-tools-title">其他工具兼容</strong><em>${status}</em></span>
        <span class="tools-overview-line"><small>已有 agent-browser、Playwright、MCP</small><span class="tools-card-action">查看配置</span></span>
      </span>
    </summary>
    <div class="tools-disclosure-body">
      <div class="agent-section-heading"><div><strong>已有工具的兼容接入</strong><p>使用 ppilot browser CLI 无需配置此处。仅在保留其他工具的原命令时，安装对应的兼容 Wrapper。</p></div><span>${diagnostic ? `工具 ${installedToolCount(diagnostic)}/3 · Wrapper ${installedWrapperCount(diagnostic)} · Skill ${installedSkillCount(diagnostic)}` : "等待检测"}</span></div>
      <div class="agent-tool-grid agent-setup-grid">${TOOL_ORDER.map(key => renderToolSetupCard(key, diagnostic, pending)).join("")}</div>
      ${renderSessionBridge(diagnostic)}
    </div>
  </details>`;
}

function renderControlPreferences(diagnostic: AgentIntegrationDiagnostic | null, pending: boolean): string {
  const skill = unifiedSkill(diagnostic);
  const canEdit = !pending && Boolean(skill?.installedTargetCount);
  return `<details id="tools-control-preferences" class="tools-overview-card tools-preferences-card" data-tools-search="控制偏好 浏览器 手机 安卓 Profile 设备 连接方式 browser phone 编辑">
    <summary class="tools-overview-summary">
      ${overviewIcon("preferences")}
      <span class="tools-overview-copy"><span class="tools-overview-title"><strong>控制偏好</strong></span>
        <span class="tools-overview-line"><small>浏览器与手机的使用规则</small><button type="button" data-action="open-control-preferences" ${canEdit ? "" : "disabled"}>编辑偏好</button></span>
      </span>
    </summary>
    <div class="tools-disclosure-body"><p>分别设置浏览器的 Profile 与连接方式、手机的设备与控制模式，以及操作前的确认规则。个人偏好会随 Agent 使用指引读取，更新 CLI 时保留。</p>
      <p>${canEdit ? "点击“编辑偏好”，在浏览器和手机两个 Tab 中查看、编辑并保存。" : "先安装 ProfilePilot CLI，再编辑个人控制偏好。"}</p>
    </div>
  </details>`;
}
function renderToolSetupCard(
  key: BrowserDriverKind,
  diagnostic: AgentIntegrationDiagnostic | null,
  pending: boolean
): string {
  const copy = TOOL_COPY[key];
  const tool = diagnostic?.tools.find((item) => item.key === key) || null;
  const wrapper = diagnostic?.wrappers.find((item) => item.key === key) || null;
  const skill = unifiedSkill(diagnostic);
  const toolReady = tool?.availability === "installed";
  const wrapperInstalled = wrapperReady(wrapper);
  const skillInstalled = Boolean(skill?.installed);
  const sessionReady = Boolean(diagnostic?.shellIntegration.installed);
  const complete = toolReady && wrapperInstalled && skillInstalled && sessionReady;
  const overall = pending
    ? "检测中"
    : complete
      ? "接入就绪"
      : !toolReady
        ? "先安装工具"
        : !wrapperInstalled
          ? "待装 Wrapper"
          : !skillInstalled ? "待配置使用指引" : "待修复会话";

  return `
    <article class="agent-tool-card agent-setup-card ${pending ? "pending" : complete ? "ready" : toolReady ? "installed" : "missing"}">
      <header>
        <span class="agent-tool-light" aria-hidden="true"></span>
        <strong>${escapeHtml(copy.label)}</strong>
        <em>${overall}</em>
      </header>
      <p>${escapeHtml(copy.description)}</p>
      <div class="agent-setup-stages">
        ${renderToolStage(key, tool, pending)}
        ${renderWrapperStage(key, wrapper, toolReady, pending)}
      </div>
      <div class="agent-toolchain-result ${pending ? "pending" : complete ? "ready" : "blocked"}">
        <span>${pending ? "检测中" : complete ? "已就绪" : "下一步"}</span>
        <strong>${pending ? "正在确认本机工具状态" : complete ? "这套工具可以使用" : nextActionLabel(toolReady, wrapperInstalled, skillInstalled, sessionReady)}</strong>
      </div>
    </article>
  `;
}

function renderToolStage(key: BrowserDriverKind, tool: AgentToolDiagnostic | null, pending: boolean): string {
  const installed = tool?.availability === "installed";
  const failed = tool?.availability === "error";
  const status = pending ? "检测中" : installed ? "已安装" : failed ? "检测失败" : "未安装";
  const detail = installed
    ? tool?.version || tool?.executablePath || "版本已确认"
    : failed
      ? tool?.error || "无法执行版本检测"
      : "需要先安装真实 CLI";
  return renderSetupStage({
    index: "01",
    label: "真实工具",
    status,
    tone: pending ? "pending" : installed ? "ready" : "blocked",
    detail,
    actions: !pending && tool && !installed
      ? `<button type="button" data-action="copy-agent-command" data-command="${escapeHtml(tool.installCommand)}">复制安装命令</button>`
      : ""
  });
}

function renderWrapperStage(
  key: BrowserDriverKind,
  wrapper: AgentWrapperDiagnostic | null,
  toolReady: boolean,
  pending: boolean
): string {
  const installed = wrapperReady(wrapper);
  const partial = Boolean(wrapper?.wrapperInstalled || wrapper?.launcherInstalled) && !installed;
  const status = pending ? "检测中" : installed ? "已安装" : partial ? "安装不完整" : "未安装";
  const detail = installed
    ? `已写入 ${wrapper?.launcherPath || "~/.profilepilot/bin"}`
    : partial
      ? "启动器或 Wrapper 文件缺失"
      : toolReady
        ? "内置于 ProfilePilot，可一键安装"
        : "安装真实工具后开放";
  const primaryLabel = installed ? "验证 / 重装" : partial ? "修复 Wrapper" : "安装 Wrapper";
  const actions = pending
    ? ""
    : `
      <button type="button" data-action="install-agent-wrapper" data-tool="${key}" ${toolReady ? "" : "disabled"}>${primaryLabel}</button>
      ${installed || partial ? `<button type="button" class="danger-ghost" data-action="remove-agent-wrapper" data-tool="${key}">移除</button>` : ""}
    `;
  return renderSetupStage({
    index: "02",
    label: "Wrapper",
    status,
    tone: pending ? "pending" : installed ? "ready" : "blocked",
    detail,
    actions
  });
}

function renderSetupStage(input: {
  index: string;
  label: string;
  status: string;
  tone: "ready" | "blocked" | "pending";
  detail: string;
  actions: string;
}): string {
  return `
    <section class="agent-setup-stage ${input.tone}">
      <div class="agent-stage-index">${input.index}</div>
      <div class="agent-stage-copy">
        <div><strong>${escapeHtml(input.label)}</strong><em>${escapeHtml(input.status)}</em></div>
        <small title="${escapeHtml(input.detail)}">${escapeHtml(input.detail)}</small>
        ${input.actions ? `<div class="agent-stage-actions">${input.actions}</div>` : ""}
      </div>
    </section>
  `;
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

function nextActionLabel(tool: boolean, wrapper: boolean, skill: boolean, session: boolean): string {
  if (!tool) return "先安装真实工具";
  if (!wrapper) return "下一步：安装 Wrapper";
  if (!skill) return "下一步：安装 ProfilePilot CLI（含使用指引）";
  if (!session) return "下一步：修复会话识别";
  return "新开 Agent 会话后生效";
}
