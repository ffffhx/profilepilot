import { store } from "../state";
import type {
  AgentIntegrationDiagnostic,
  AgentSkillDiagnostic,
  AgentToolDiagnostic,
  AgentWrapperDiagnostic,
  BrowserDriverKind,
  PublicProfile
} from "../types";
import { escapeHtml, renderButtonLabel } from "../util";

const TOOL_ORDER: BrowserDriverKind[] = ["agent-browser", "playwright-cli", "chrome-devtools-mcp"];

const TOOL_COPY: Record<BrowserDriverKind, { label: string; description: string; skillLabel: string }> = {
  "agent-browser": {
    label: "agent-browser",
    description: "面向 Agent 的浏览器操作 CLI，继续使用 open、snapshot、click 等原生命令。",
    skillLabel: "agent-browser-cdp"
  },
  "playwright-cli": {
    label: "Playwright CLI",
    description: "微软提供的 Playwright 命令行工具，通过受控 attach 接入真实 Chrome。",
    skillLabel: "playwright-cli-profilepilot"
  },
  "chrome-devtools-mcp": {
    label: "Chrome DevTools MCP",
    description: "作为 MCP Server 接入真实 Chrome；只检测已经安装的本机 CLI。",
    skillLabel: "chrome-devtools-mcp-profilepilot"
  }
};

function signalTone(ok: boolean, pending = false): "ready" | "blocked" | "pending" {
  return pending ? "pending" : ok ? "ready" : "blocked";
}

function signalNode(label: string, detail: string, tone: "ready" | "blocked" | "pending"): string {
  const stateLabel = tone === "ready" ? "就绪" : tone === "pending" ? "检测中" : "待配置";
  return `
    <div class="agent-signal-node ${tone}">
      <span class="agent-signal-light" aria-hidden="true"></span>
      <span class="agent-signal-copy">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
      <span class="agent-signal-state">${stateLabel}</span>
    </div>
  `;
}

function installedToolCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.tools.filter((tool) => tool.availability === "installed").length || 0;
}

function installedWrapperCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.wrappers.filter(wrapperReady).length || 0;
}

function installedSkillCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  return diagnostic?.skills.filter((skill) => skill.installed).length || 0;
}

function readyToolchainCount(diagnostic: AgentIntegrationDiagnostic | null): number {
  if (!diagnostic?.shellIntegration.installed) return 0;
  return TOOL_ORDER.filter((key) => {
    const tool = diagnostic.tools.find((item) => item.key === key);
    const wrapper = diagnostic.wrappers.find((item) => item.key === key);
    const skill = diagnostic.skills.find((item) => item.key === key);
    return tool?.availability === "installed" && wrapperReady(wrapper) && Boolean(skill?.installed);
  }).length;
}

export function renderAgentAccessDock(_profiles: PublicProfile[]): string {
  const diagnostic = store.agentIntegrationDiagnostic;
  const tools = installedToolCount(diagnostic);
  const wrappers = installedWrapperCount(diagnostic);
  const skills = installedSkillCount(diagnostic);
  const ready = readyToolchainCount(diagnostic);
  const pending = store.agentIntegrationLoading;

  return `
    <section class="agent-access-dock" aria-labelledby="agent-access-title">
      <div class="agent-access-intro">
        <span class="agent-access-eyebrow">Agent Access</span>
        <h2 id="agent-access-title">按工具接入 Agent</h2>
        <p>真实 CLI、Wrapper 和配套 Skill 分别检测；只安装你实际使用的那一套。</p>
        <div class="agent-access-actions">
          <button type="button" class="primary" data-action="open-agent-integration">管理 Agent 工具</button>
          <button type="button" class="agent-guide-link" data-action="open-onboarding">新手引导</button>
        </div>
      </div>
      <div class="agent-signal-chain" aria-label="Agent 工具接入状态">
        ${signalNode("真实工具", diagnostic ? `${tools}/3 已安装` : "等待检测", signalTone(tools > 0, pending))}
        <span class="agent-signal-wire ${tools > 0 ? "active" : ""}" aria-hidden="true"></span>
        ${signalNode("Wrapper", diagnostic ? `${wrappers} 个已接入` : "按工具独立安装", signalTone(wrappers > 0, pending))}
        <span class="agent-signal-wire ${wrappers > 0 ? "active" : ""}" aria-hidden="true"></span>
        ${signalNode("配套 Skill", diagnostic ? `${skills} 个已安装` : "让 Agent 遵守接管协议", signalTone(skills > 0, pending))}
      </div>
      <div class="agent-access-meter agent-ready-count" aria-label="完整接入数量">
        <span>${ready}</span>
        <small>READY</small>
      </div>
    </section>
  `;
}

export function renderOnboardingModal(): string {
  return `
    <div class="modal-backdrop app-modal-backdrop onboarding-backdrop" data-action="dismiss-onboarding">
      <section class="modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="onboarding-head">
          <div>
            <span class="modal-kicker">First Flight</span>
            <h2 id="onboarding-title">选一套工具，完成三层接入</h2>
          </div>
          <button type="button" class="modal-icon-close" data-action="dismiss-onboarding" aria-label="关闭新手引导">×</button>
        </div>
        <p class="onboarding-lead">不要求安装全部工具。每种工具都按相同顺序独立准备，互不影响。</p>
        <div class="onboarding-route" aria-label="接入顺序">
          <article>
            <span>01</span>
            <div><strong>安装真实工具</strong><p>只认本机已经安装且能够返回版本号的 CLI；缺少时复制安装命令。</p></div>
          </article>
          <i aria-hidden="true"></i>
          <article>
            <span>02</span>
            <div><strong>安装对应 Wrapper</strong><p>Wrapper 随 ProfilePilot 提供，一次只启用当前工具的受控启动器。</p></div>
          </article>
          <i aria-hidden="true"></i>
          <article>
            <span>03</span>
            <div><strong>安装配套 Skill</strong><p>让 Codex 和 Claude 理解 Gateway、用户接管与任务结束规则。</p></div>
          </article>
        </div>
        ${renderInputGuardPermissionCard("onboarding")}
        <div class="onboarding-safety-note">
          <span>CONTROL RULE</span>
          <p>用户接管浏览器时，Wrapper 会硬停 Agent；配套 Skill 会要求 Agent 等待，而不是绕过保护。</p>
        </div>
        <div class="modal-actions onboarding-actions">
          <button type="button" data-action="dismiss-onboarding">稍后再说</button>
          <button type="button" class="primary" data-action="start-agent-integration">开始配置</button>
        </div>
      </section>
    </div>
  `;
}

export function renderAgentIntegrationModal(_profiles: PublicProfile[]): string {
  const diagnostic = store.agentIntegrationDiagnostic;
  const loading = store.agentIntegrationLoading || store.busy;
  const toolCount = installedToolCount(diagnostic);
  const wrapperCount = installedWrapperCount(diagnostic);
  const skillCount = installedSkillCount(diagnostic);

  return `
    <div class="modal-backdrop app-modal-backdrop" data-action="close-modal">
      <section class="modal agent-integration-modal" role="dialog" aria-modal="true" aria-labelledby="agent-integration-title">
        <div class="agent-integration-head">
          <div>
            <span class="modal-kicker">Agent Tooling</span>
            <h2 id="agent-integration-title">Agent 工具接入</h2>
            <p>每种工具独立完成“真实 CLI → Wrapper → Skill”。只配置你要使用的工具。</p>
          </div>
          <button type="button" class="modal-icon-close" data-action="close-modal" aria-label="关闭 Agent 工具接入">×</button>
        </div>

        ${renderManagementCliPanel(diagnostic, loading || !diagnostic)}

        <section class="agent-tools-panel agent-setup-panel" aria-labelledby="agent-tools-title">
          <div class="agent-section-heading">
            <div><span>TOOL CHAINS</span><strong id="agent-tools-title">逐工具配置</strong></div>
            <div class="agent-section-status">
              ${diagnostic ? `<span>工具 ${toolCount}/3 · Wrapper ${wrapperCount} · Skill ${skillCount}</span>` : ""}
              <button type="button" class="compact ${loading ? "loading" : ""}" data-action="refresh-agent-integration" ${loading ? "disabled" : ""}>
                ${renderButtonLabel(loading, "重新检测", "检测中…")}
              </button>
            </div>
          </div>
          <div class="agent-tool-grid agent-setup-grid">
            ${TOOL_ORDER.map((key) => renderToolSetupCard(key, diagnostic, loading || !diagnostic)).join("")}
          </div>
          ${renderSessionBridge(diagnostic)}
        </section>

        ${renderInputGuardPermissionCard("integration")}
      </section>
    </div>
  `;
}

function renderManagementCliPanel(
  diagnostic: AgentIntegrationDiagnostic | null,
  pending: boolean
): string {
  const cli = diagnostic?.managementCli || null;
  const skill = cli?.skill || null;
  const cliPartial = Boolean(cli?.bundleInstalled || cli?.launcherInstalled) && !cli?.installed;
  const cliStale = Boolean(cli?.installed && !cli.upToDate);
  const skillInstalled = Boolean(skill?.installed);
  const externalSkill = skillInstalled && !skill?.managed;
  const skillStale = skillInstalled && Boolean(skill?.managed) && !skill?.upToDate;
  const ready = Boolean(cli?.installed && skillInstalled && diagnostic?.shellIntegration.installed);
  const cliStatus = pending
    ? "检测中"
    : cliStale
      ? "需要更新"
      : cli?.installed
        ? "已安装"
        : cliPartial
          ? "安装不完整"
          : "未安装";
  const skillStatus = pending
    ? "检测中"
    : externalSkill
      ? "已安装 · 外部管理"
      : skillStale
        ? "需要更新"
        : skillInstalled
          ? "已安装"
          : "未安装";

  return `
    <section class="agent-management-cli ${ready ? "ready" : "pending"}" aria-labelledby="management-cli-title">
      <div class="agent-management-cli-head">
        <div>
          <span>PROFILE MANAGEMENT CLI</span>
          <strong id="management-cli-title">让 Agent 管理 Profile</strong>
          <p>独立的 <code>profilepilot</code> 命令通过本机受保护 Socket 执行查询、创建、重命名、启动、停止和删除。</p>
        </div>
        <em>${ready ? "READY" : "SETUP"}</em>
      </div>
      <div class="agent-management-cli-stages">
        ${renderSetupStage({
          index: "01",
          label: "管理 CLI",
          status: cliStatus,
          tone: pending ? "pending" : cli?.installed ? "ready" : "blocked",
          detail: cli?.installed
            ? cli.launcherPath
            : cliPartial
              ? "CLI 文件不完整，可一键修复"
              : "ProfilePilot 内置，可独立安装",
          actions: pending
            ? ""
            : `
              <button type="button" data-action="install-profilepilot-cli">${cliStale ? "更新 CLI" : cliPartial ? "修复 CLI" : cli?.installed ? "验证 / 重装" : "安装管理 CLI"}</button>
              ${cli?.installed || cliPartial ? `<button type="button" class="danger-ghost" data-action="remove-profilepilot-cli">移除</button>` : ""}
            `
        })}
        ${renderSetupStage({
          index: "02",
          label: "管理 Skill",
          status: skillStatus,
          tone: pending ? "pending" : skillInstalled ? "ready" : "blocked",
          detail: skillInstalled
            ? `${skill?.skillId || "profilepilot-cli"} · ${skill?.installedTargetCount || 0}/${skill?.targetCount || 3} 个 Agent 目录`
            : cli?.installed
              ? "让 Codex / Claude 安全执行 Profile 增删改查"
              : "安装管理 CLI 后开放",
          actions: pending
            ? ""
            : `
              ${externalSkill
                ? `<span class="agent-external-note">由现有 Skill 管理器提供</span>`
                : `<button type="button" data-action="install-profilepilot-cli-skill" ${cli?.installed ? "" : "disabled"}>${skillStale ? "更新 Skill" : skillInstalled ? "重新安装" : "安装管理 Skill"}</button>`}
              ${skill?.managedTargetCount ? `<button type="button" class="danger-ghost" data-action="remove-profilepilot-cli-skill">移除本工具安装</button>` : ""}
            `
        })}
      </div>
      <div class="agent-management-cli-example">
        <code>profilepilot profile list --json</code>
        <span>删除必须显式添加 <code>--yes</code>；系统 Profile 只读。</span>
      </div>
    </section>
  `;
}

function renderToolSetupCard(
  key: BrowserDriverKind,
  diagnostic: AgentIntegrationDiagnostic | null,
  pending: boolean
): string {
  const copy = TOOL_COPY[key];
  const tool = diagnostic?.tools.find((item) => item.key === key) || null;
  const wrapper = diagnostic?.wrappers.find((item) => item.key === key) || null;
  const skill = diagnostic?.skills.find((item) => item.key === key) || null;
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
          : "待装 Skill";

  return `
    <article class="agent-tool-card agent-setup-card ${complete ? "ready" : toolReady ? "installed" : "missing"}">
      <header>
        <span class="agent-tool-light" aria-hidden="true"></span>
        <strong>${escapeHtml(copy.label)}</strong>
        <em>${overall}</em>
      </header>
      <p>${escapeHtml(copy.description)}</p>
      <div class="agent-setup-stages">
        ${renderToolStage(key, tool, pending)}
        ${renderWrapperStage(key, wrapper, toolReady, pending)}
        ${renderSkillStage(key, skill, wrapperInstalled, pending)}
      </div>
      <div class="agent-toolchain-result ${complete ? "ready" : "blocked"}">
        <span>${complete ? "READY" : "NEXT"}</span>
        <strong>${complete ? "这套工具可以使用" : nextActionLabel(toolReady, wrapperInstalled, skillInstalled)}</strong>
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

function renderSkillStage(
  key: BrowserDriverKind,
  skill: AgentSkillDiagnostic | null,
  wrapperInstalled: boolean,
  pending: boolean
): string {
  const installed = Boolean(skill?.installed);
  const partial = Boolean(skill?.installedTargetCount) && !installed;
  const external = installed && !skill?.managed;
  const stale = installed && skill?.managed && !skill.upToDate;
  const status = pending
    ? "检测中"
    : external
      ? "已安装 · 外部管理"
      : stale
        ? "需要更新"
        : installed
          ? "已安装"
          : partial
            ? "部分安装"
            : "未安装";
  const detail = installed
    ? `${skill?.skillId || TOOL_COPY[key].skillLabel} · ${skill?.installedTargetCount || 0}/${skill?.targetCount || 3} 个 Agent 目录`
    : partial
      ? `${skill?.installedTargetCount || 0}/${skill?.targetCount || 3} 个 Agent 目录可见`
      : wrapperInstalled
        ? `安装 ${skill?.skillId || TOOL_COPY[key].skillLabel}`
        : "安装 Wrapper 后开放";
  const canInstall = wrapperInstalled && !external;
  const actionLabel = stale ? "更新 Skill" : partial ? "补齐 Skill" : installed ? "重新安装" : "安装 Skill";
  const actions = pending
    ? ""
    : `
      ${external ? `<span class="agent-external-note">由现有 Skill 管理器提供</span>` : `<button type="button" data-action="install-agent-skill" data-tool="${key}" ${canInstall ? "" : "disabled"}>${actionLabel}</button>`}
      ${skill?.managedTargetCount ? `<button type="button" class="danger-ghost" data-action="remove-agent-skill" data-tool="${key}">移除本工具安装</button>` : ""}
    `;
  return renderSetupStage({
    index: "03",
    label: "配套 Skill",
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
      <span>SESSION BRIDGE</span>
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

function nextActionLabel(tool: boolean, wrapper: boolean, skill: boolean): string {
  if (!tool) return "先安装真实工具";
  if (!wrapper) return "下一步：安装 Wrapper";
  if (!skill) return "下一步：安装配套 Skill";
  return "新开 Agent 会话后生效";
}
