import { isBusyAction } from "../busy";
import { store } from "../state";
import { ExternalChromeInstance, PublicProfile } from "../types";
import { NATIVE_CDP_UNSUPPORTED_NOTE, cdpLaunchButtonTitle, closeButtonTitle, deleteButtonTitle, escapeHtml, focusButtonTitle, formatDate, launchButtonTitle, listeningPortsNote, profileStatusLabel, renderButtonLabel, sourceDetail } from "../util";

// 受管 Profile 表格与外部实例放进同一个框：它们本质都是 Profile，只是
// 来源不同；外部实例仍只读（仅显示/关闭），用框内分隔段和类型标签区分。
export function renderProfilesPanel(profiles: PublicProfile[], externalInstances: ExternalChromeInstance[]): string {
  return `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${profiles.map(renderProfileRow).join("")}
          ${externalInstances.length ? renderExternalRows(externalInstances) : ""}
        </tbody>
      </table>
    </div>
  `;
}

export function renderProfileRow(profile: PublicProfile): string {
  const selected = profile.id === store.selectedId;
  return `
    <tr class="${selected ? "selected" : ""}" data-action="select" data-id="${profile.id}" data-profile-row tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td>
        <div class="profile-pick">
          <span class="profile-name-line">
            <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
            <span class="profile-name">${escapeHtml(profile.name)}</span>
            ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td>
        ${renderProfileActions(profile)}
      </td>
    </tr>
  `;
}

export function renderProfileActions(profile: PublicProfile): string {
  const menuOpen = store.openProfileMenuId === profile.id;
  const cdpLaunchDisabled = store.busy || profile.running || profile.source !== "isolated";
  const deleteDisabled = store.busy || !profile.deletable;
  const focusing = isBusyAction("focus-profile", { profileId: profile.id });
  const closing = isBusyAction("close-profile", { profileId: profile.id });
  const launching = isBusyAction("launch-profile", { profileId: profile.id });
  const launchingCdp = isBusyAction("launch-cdp", { profileId: profile.id });
  const openingFolder = isBusyAction("open-folder", { profileId: profile.id });
  const renaming = isBusyAction("rename-profile", { profileId: profile.id });
  const deleting = isBusyAction("delete-profile", { profileId: profile.id });
  const agentConfigBusy = isBusyAction("agent-config", { profileId: profile.id });

  return `
    <div class="profile-actions" data-profile-actions>
      ${
        profile.running
          ? `
            <span class="action-tooltip" data-tooltip="${escapeHtml(focusButtonTitle(profile))}">
              <button type="button" class="action-button accent ${focusing ? "loading" : ""}" data-action="focus-profile" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(focusing, "显示", "显示中…")}
              </button>
            </span>
          `
          : `
            <span class="action-tooltip" data-tooltip="${escapeHtml(launchButtonTitle(profile))}">
              <button type="button" class="action-button accent ${launching ? "loading" : ""}" data-action="launch" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(launching, "启动", "启动中…")}
              </button>
            </span>
          `
      }
      <span class="action-tooltip" data-tooltip="${escapeHtml(closeButtonTitle(profile))}">
        <button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-profile" data-id="${profile.id}" ${store.busy || !profile.running ? "disabled" : ""}>
          ${renderButtonLabel(closing, "关闭", "关闭中…")}
        </button>
      </span>
      <span class="action-tooltip" data-tooltip="${escapeHtml(cdpLaunchButtonTitle(profile))}">
        <button type="button" class="action-button cdp ${launchingCdp ? "loading" : ""}" data-action="launch-cdp" data-id="${profile.id}" ${cdpLaunchDisabled ? "disabled" : ""}>
          ${renderButtonLabel(launchingCdp, "CDP启动", "启动中…")}
        </button>
      </span>
      <span class="menu-anchor">
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu" role="menu">
              <button type="button" class="${openingFolder ? "loading" : ""}" data-action="open-folder" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(openingFolder, "打开目录", "打开中…")}
              </button>
              <button type="button" class="${renaming ? "loading" : ""}" data-action="rename-profile" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(renaming, "修改名称", "保存中…")}
              </button>
              ${
                profile.source === "isolated"
                  ? profile.agentConfigPort !== null
                    ? `<button type="button" class="${agentConfigBusy ? "loading" : ""}" data-action="clear-agent-config" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(agentConfigBusy, "移除 Agent 配置", "移除中…")}
              </button>`
                    : `<button type="button" class="${agentConfigBusy ? "loading" : ""}" data-action="write-agent-config" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(agentConfigBusy, "设为 Agent 端点", "处理中…")}
              </button>`
                  : ""
              }
              <span class="action-tooltip" data-tooltip="${escapeHtml(deleteButtonTitle(profile))}">
                <button type="button" class="danger ${deleting ? "loading" : ""}" data-action="delete" data-id="${profile.id}" ${deleteDisabled ? "disabled" : ""}>
                  ${renderButtonLabel(deleting, "删除 Profile", "删除中…")}
                </button>
              </span>
            </div>
          `
          : ""
      }
      </span>
    </div>
  `;
}

export function renderEmpty(): string {
  return `
    <div class="empty-state">
      <strong>还没有 Profile</strong>
      <button type="button" class="primary" data-action="new-profile">新建独立 Profile</button>
    </div>
  `;
}

export function renderExternalRows(instances: ExternalChromeInstance[]): string {
  return `
    <tr class="table-group-row">
      <td colspan="3">
        <span>外部实例 · 其他工具（agent-browser 等）自管，仅支持显示 / 关闭</span>
        <span class="count">${instances.length}</span>
      </td>
    </tr>
    ${instances.map((instance) => renderExternalRow(instance)).join("")}
  `;
}

export function renderExternalRow(instance: ExternalChromeInstance): string {
  const selected = instance.userDataDir === store.selectedExternalDir;
  const focusing = isBusyAction("focus-external", { profileId: instance.userDataDir });
  const closing = isBusyAction("close-external", { profileId: instance.userDataDir });

  return `
    <tr class="external-row ${selected ? "selected" : ""}" data-action="select-external" data-dir="${escapeHtml(instance.userDataDir)}" tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td>
        <div class="profile-pick">
          <span class="profile-name-line">
            <span class="status-dot running"></span>
            <span class="profile-name">${escapeHtml(instance.label)}</span>
            ${instance.headless ? '<span class="source-pill warn">无头</span>' : ""}
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill running">运行中</span>
      </td>
      <td>
        <div class="profile-actions">
          ${
            instance.headless
              ? ""
              : `<span class="action-tooltip" data-tooltip="把这个窗口显示到最前面">
            <button type="button" class="action-button accent ${focusing ? "loading" : ""}" data-action="focus-external" data-dir="${escapeHtml(instance.userDataDir)}" ${store.busy ? "disabled" : ""}>
              ${renderButtonLabel(focusing, "显示", "显示中…")}
            </button>
          </span>`
          }
          <span class="action-tooltip" data-tooltip="结束这个外部实例进程">
            <button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-external" data-dir="${escapeHtml(instance.userDataDir)}" ${store.busy ? "disabled" : ""}>
              ${renderButtonLabel(closing, "关闭", "关闭中…")}
            </button>
          </span>
        </div>
      </td>
    </tr>
  `;
}

export function renderExternalDetails(instance: ExternalChromeInstance): string {
  const cdpRow = instance.cdpUrl
    ? `<div class="detail-row">
        <span>CDP 地址</span>
        <code class="path-box compact accent">${escapeHtml(instance.cdpUrl)}</code>
        <small class="detail-note">由其他工具开启的调试端点，可直接连接，但本工具不接管它的生命周期。</small>
      </div>`
    : `<div class="detail-row">
        <span>CDP 地址</span>
        <strong>${instance.cdpPort !== null ? `声明端口 ${instance.cdpPort}（当前未响应）` : "未开启"}</strong>
      </div>`;

  return `
    <aside class="details">
      <div class="detail-title">
        <h2>${escapeHtml(instance.label)}</h2>
        <span class="detail-status running">运行中</span>
      </div>
      <div class="detail-list">
        <div class="detail-row">
          <span>来源</span>
          <strong>外部实例（其他工具自管）</strong>
          <small class="detail-note">不是 ProfilePilot 创建或管理的 Profile，仅支持显示 / 关闭。</small>
        </div>
        <div class="detail-row">
          <span>浏览器内核</span>
          <strong>${escapeHtml(instance.browser)}</strong>
        </div>
        <div class="detail-row">
          <span>窗口</span>
          <strong>${instance.headless ? "无头模式（无可见窗口）" : "有可见窗口"}</strong>
        </div>
        <div class="detail-row">
          <span>启动时间</span>
          <strong>${formatDate(instance.startedAt)}</strong>
        </div>
        ${cdpRow}
        <div class="detail-row">
          <span>数据目录</span>
          <code class="path-box">${escapeHtml(instance.userDataDir)}</code>
        </div>
      </div>
    </aside>
  `;
}

export function renderDetails(profile: PublicProfile | null): string {
  if (!profile) {
    return `
      <aside class="details">
        <div class="detail-title">
          <h2>详情</h2>
        </div>
        <div class="detail-list">
          <div class="detail-row">
            <span>状态</span>
            <strong>未选择</strong>
          </div>
        </div>
      </aside>
    `;
  }

  return `
    <aside class="details">
      <div class="detail-title">
        <h2>${escapeHtml(profile.name)}</h2>
        <span class="detail-status ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </div>
      <div class="detail-list">
        <div class="detail-row">
          <span>来源</span>
          <strong>${sourceDetail(profile)}</strong>
        </div>
        <div class="detail-row">
          <span>账号</span>
          <strong>${escapeHtml(profile.userName || "未登录")}</strong>
        </div>
        ${renderListeningPortsDetail(profile)}
        ${renderConnectionDetail(profile)}
        <div class="detail-row">
          <span>目录</span>
          <code class="path-box">${escapeHtml(profile.path)}</code>
        </div>
      </div>
    </aside>
  `;
}

export function renderListeningPortsDetail(profile: PublicProfile): string {
  // 独立 Profile 下方已展示 CDP 地址，监听端口属重复信息；
  // 系统 Profile 走 Chrome 授权连接、没有 CDP 行，才在这里展示监听端口。
  if (profile.source !== "native") {
    return "";
  }

  return `
    <div class="detail-row">
      <span>关联进程监听端口</span>
      <strong>${profile.listeningPorts.length ? profile.listeningPorts.join(", ") : "无"}</strong>
      <small class="detail-note">${listeningPortsNote(profile)}</small>
    </div>
  `;
}

export function renderConnectionDetail(profile: PublicProfile): string {
  if (profile.source === "native") {
    return renderSystemChromeConnectionDetail(profile);
  }

  return renderCdpDetail(profile);
}

export function renderSystemChromeConnectionDetail(_profile: PublicProfile): string {
  return `
    <div class="detail-row detail-row-disabled">
      <span>CDP 地址</span>
      <strong>不支持</strong>
      <small class="detail-note">${NATIVE_CDP_UNSUPPORTED_NOTE}</small>
    </div>
  `;
}

export function renderCdpDetail(profile: PublicProfile): string {
  const cdpRow = profile.cdpUrl
    ? `<div class="detail-row">
        <span>CDP 地址</span>
        <code class="path-box compact">${escapeHtml(profile.cdpUrl)}</code>
        <small class="detail-note">AI/browser agent 工具可以通过这个本机地址连接该 Profile。</small>
      </div>`
    : `<div class="detail-row">
        <span>CDP 地址</span>
        <strong>未开启</strong>
        <small class="detail-note">点击“CDP启动”后会显示本机连接地址。</small>
      </div>`;

  return cdpRow + renderAgentConfigDetail(profile);
}

export function renderAgentConfigDetail(profile: PublicProfile): string {
  // 操作入口在「更多」菜单里；这里只展示当前状态。
  if (profile.agentConfigPort !== null) {
    return `
      <div class="detail-row">
        <span>Agent 调试配置</span>
        <strong>已写入全局 AGENTS.md</strong>
        <small class="detail-note">Agent 工具调试浏览器时会优先连接 <code>http://127.0.0.1:${profile.agentConfigPort}</code>（本 Profile，固定端口 ${profile.fixedCdpPort ?? profile.agentConfigPort}）。CLAUDE.md 只引用 AGENTS.md；在「更多」里可移除。</small>
      </div>
    `;
  }

  return `
    <div class="detail-row">
      <span>Agent 调试配置</span>
      <strong>未写入</strong>
      <small class="detail-note">在「更多」里「设为 Agent 端点」后，Agent 工具会优先连接此 Profile 的固定调试端口。</small>
    </div>
  `;
}
