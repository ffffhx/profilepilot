import { isBusyAction } from "../busy";
import { store } from "../state";
import { ExternalChromeInstance, PublicProfile } from "../types";
import { NATIVE_CDP_UNSUPPORTED_NOTE, cdpLaunchButtonTitle, closeButtonTitle, deleteButtonTitle, escapeHtml, focusButtonTitle, formatDate, launchButtonTitle, listeningPortsNote, profileStatusLabel, renderButtonLabel, sourceDetail } from "../util";

interface ProfileRootGroup {
  key: string;
  label: string;
  userDataDir: string;
  profiles: PublicProfile[];
}

// 受管 Profile 表格与外部实例放进同一个框：它们本质都是 Profile，只是
// 来源不同；外部实例仍只读（仅显示/关闭），用框内分隔段和类型标签区分。
export function renderProfilesPanel(profiles: PublicProfile[], externalInstances: ExternalChromeInstance[]): string {
  const profileGroups = groupProfilesByUserDataDir(profiles);

  return `
    <div class="profiles-table-wrap overflow-visible border-solid border border-line rounded-xl bg-panel [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
      <table class="profiles-table w-full border-collapse table-fixed">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>CDP 地址</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${profileGroups.map(renderProfileRootGroup).join("")}
          ${externalInstances.length ? renderExternalRows(externalInstances) : ""}
        </tbody>
      </table>
    </div>
  `;
}

export function groupProfilesByUserDataDir(profiles: PublicProfile[]): ProfileRootGroup[] {
  const groups: ProfileRootGroup[] = [];
  const indexByKey = new Map<string, number>();

  profiles.forEach((profile) => {
    const key = `${profile.source}:${profile.userDataDir}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      groups[existingIndex].profiles.push(profile);
      return;
    }

    indexByKey.set(key, groups.length);
    groups.push({
      key,
      label: profile.source === "native" ? "系统 Chrome User Data" : "ProfilePilot User Data",
      userDataDir: profile.userDataDir,
      profiles: [profile]
    });
  });

  return groups;
}

export function renderProfileRootGroup(group: ProfileRootGroup): string {
  const countLabel = group.profiles.length === 1 ? "1 Profile" : `${group.profiles.length} Profiles`;
  return (
    renderProfileRootRow(group.label, group.userDataDir, countLabel) +
    group.profiles.map((profile, index) => renderProfileRow(profile, index === group.profiles.length - 1)).join("")
  );
}

export function renderProfileRootRow(label: string, pathLabel: string, countLabel: string): string {
  return `
    <tr class="table-group-row profile-root-row">
      <td colspan="4">
        <div class="profile-root-content">
          <span class="profile-root-label"><span class="profile-root-node" aria-hidden="true"></span>${escapeHtml(label)}</span>
          ${renderPathTooltip(pathLabel, pathLabel, "profile-root-path-tip")}
          <span class="count">${escapeHtml(countLabel)}</span>
        </div>
      </td>
    </tr>
  `;
}

export function renderProfileRow(profile: PublicProfile, lastInGroup = false): string {
  const selected = profile.id === store.selectedId;
  const pathKind = profile.source === "native" ? "Profile Dir" : "Profile Data";
  const pathLabel = profile.source === "native" ? profile.dirName : profileDataLabel(profile);
  const fullPath = profile.profileDataPath;
  return `
    <tr class="profile-child-row ${lastInGroup ? "last-in-group" : ""} ${selected ? "selected" : ""}" data-action="select" data-id="${profile.id}" data-profile-row tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td class="profile-name-cell">
        <span class="tree-branch" aria-hidden="true"></span>
        <div class="profile-pick w-full min-h-[auto] py-1 px-0.5 text-left">
          <span class="profile-name-line flex items-center gap-2 min-w-0">
            <span class="status-dot w-[9px] h-[9px] flex-[0_0_auto] rounded-full bg-line-strong ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
            <span class="profile-name block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-[650] leading-[1.25]">${escapeHtml(profile.name)}</span>
            ${profile.isDefault ? '<span class="native-badge inline-flex items-center justify-center border-solid border border-warn-line rounded-full px-2 py-[3px] bg-warn-soft text-warn-bright font-mono text-[10px] font-semibold tracking-[0.06em]">Default</span>' : ""}
          </span>
          <span class="profile-path-line">
            <span>${pathKind}</span>
            ${renderPathTooltip(pathLabel, fullPath, "profile-path-tip")}
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill inline-flex items-center justify-center min-w-[58px] border-solid border border-line-strong rounded-full px-[9px] py-1 bg-transparent text-muted font-mono text-[11px] font-semibold tracking-[0.06em] ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td>
        ${renderProfileCdpCell(profile)}
      </td>
      <td>
        ${renderProfileActions(profile)}
      </td>
    </tr>
  `;
}

function renderPathTooltip(label: string, fullPath: string, className: string): string {
  const escapedFullPath = escapeHtml(fullPath);
  return `<span class="action-tooltip path-tooltip ${className}" data-tooltip="${escapedFullPath}" title="${escapedFullPath}"><code>${escapeHtml(label)}</code></span>`;
}

export function profileDataLabel(profile: PublicProfile): string {
  const root = profile.userDataDir.replace(/\/+$/, "");
  const dataPath = profile.profileDataPath.replace(/\/+$/, "");
  if (dataPath === root) {
    return ".";
  }
  if (dataPath.startsWith(`${root}/`)) {
    return dataPath.slice(root.length + 1);
  }
  return profile.profileDataPath;
}

// 表格里直接展示该 Profile 的 CDP 连接地址：正在以 CDP 运行时显示实时地址（live）；
// 绑定了固定端口但未运行时显示该端口地址（bound · 待启动）；系统 Profile 不支持（off）。
export function renderProfileCdpCell(profile: PublicProfile): string {
  if (profile.cdpUrl) {
    return cdpChip("live", stripScheme(profile.cdpUrl), profile.cdpUrl, null);
  }
  if (profile.source === "native") {
    return cdpChip("off", "不支持", null, null);
  }
  if (profile.fixedCdpPort) {
    const url = `http://127.0.0.1:${profile.fixedCdpPort}`;
    return cdpChip("bound", `127.0.0.1:${profile.fixedCdpPort}`, url, "待启动");
  }
  return cdpChip("off", "未开启", null, null);
}

// CDP 状态芯片：前导指示灯 + 地址 + 可选状态标签，沿用全局信号灯语言。
// live=实时(绿) / bound=已绑定待启动(蓝) / stale=声明端口未响应(琥珀) / off=无(灰)。
export function cdpChip(
  kind: "live" | "bound" | "stale" | "off",
  addr: string,
  fullTitle: string | null,
  tag: string | null
): string {
  const chip = `<span class="cdp-cell inline-flex items-center gap-2 max-w-full overflow-hidden border-solid border border-line rounded-md px-[9px] py-1 bg-panel-soft text-muted font-mono text-[12px] font-semibold tabular-nums ${kind}"><span class="cdp-addr overflow-hidden text-ellipsis whitespace-nowrap">${escapeHtml(addr)}</span>${tag ? `<em class="cdp-tag flex-[0_0_auto] not-italic text-[10px] font-semibold tracking-[0.12em] uppercase opacity-[0.85]">${escapeHtml(tag)}</em>` : ""}</span>`;
  // 地址会随窗口变窄省略，外层套用全局 HUD 提示气泡（action-tooltip）展示完整地址；
  // 气泡用宿主元素的 ::after/::before，不与 cdp-cell::before 的信号灯冲突。
  if (!fullTitle) {
    return chip;
  }
  return `<span class="action-tooltip cdp-tip max-w-full min-w-0" data-tooltip="${escapeHtml(fullTitle)}">${chip}</span>`;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
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
  const miniPinnedBusy = isBusyAction("mini-pin", { profileId: profile.id });
  const miniPinDisabled = store.busy || (!profile.pinnedToMini && (store.state?.miniProfileIds.length || 0) >= 3);

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
      <span class="menu-anchor relative inline-flex">
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu absolute top-[calc(100%+6px)] right-0 z-40 grid w-40 overflow-visible border-solid border border-line-strong rounded-lg bg-panel-raise [box-shadow:var(--shadow)] p-[5px]" role="menu">
              <button type="button" class="${openingFolder ? "loading" : ""}" data-action="open-folder" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(openingFolder, "打开目录", "打开中…")}
              </button>
              <button type="button" class="${renaming ? "loading" : ""}" data-action="rename-profile" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(renaming, "修改名称", "保存中…")}
              </button>
              <button type="button" class="${miniPinnedBusy ? "loading" : ""}" data-action="${profile.pinnedToMini ? "unpin-mini-profile" : "pin-mini-profile"}" data-id="${profile.id}" ${miniPinDisabled ? "disabled" : ""}>
                ${renderButtonLabel(miniPinnedBusy, profile.pinnedToMini ? "取消悬浮窗固定" : "固定到悬浮窗", "保存中…")}
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
      <td colspan="4">
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
        <div class="profile-pick w-full min-h-[auto] py-1 px-0.5 text-left">
          <span class="profile-name-line flex items-center gap-2 min-w-0">
            <span class="status-dot w-[9px] h-[9px] flex-[0_0_auto] rounded-full bg-line-strong running"></span>
            <span class="profile-name block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-[650] leading-[1.25]">${escapeHtml(instance.label)}</span>
            ${instance.headless ? '<span class="source-pill inline-flex items-center justify-center min-w-[46px] border-solid border border-line-strong rounded-full px-[9px] py-1 bg-transparent text-muted font-mono text-[11px] font-semibold whitespace-nowrap warn">无头</span>' : ""}
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill inline-flex items-center justify-center min-w-[58px] border-solid border border-line-strong rounded-full px-[9px] py-1 bg-transparent text-muted font-mono text-[11px] font-semibold tracking-[0.06em] running">运行中</span>
      </td>
      <td>
        ${
          instance.cdpUrl
            ? cdpChip("live", stripScheme(instance.cdpUrl), instance.cdpUrl, null)
            : instance.cdpPort
              ? cdpChip("stale", `127.0.0.1:${instance.cdpPort}`, `http://127.0.0.1:${instance.cdpPort}`, "未响应")
              : cdpChip("off", "未开启", null, null)
        }
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
    <aside class="details border-solid border border-line rounded-xl bg-[linear-gradient(180deg,var(--panel),var(--panel-soft))] p-[18px] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
      <div class="detail-title flex items-center justify-between gap-3 mb-[18px] pb-3 border-solid border-b border-line">
        <h2>${escapeHtml(instance.label)}</h2>
        <span class="detail-status text-muted font-mono text-[11px] tracking-[0.08em] running">运行中</span>
      </div>
      <div class="detail-list grid gap-[14px]">
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
      <aside class="details border-solid border border-line rounded-xl bg-[linear-gradient(180deg,var(--panel),var(--panel-soft))] p-[18px] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
        <div class="detail-title flex items-center justify-between gap-3 mb-[18px] pb-3 border-solid border-b border-line">
          <h2>详情</h2>
        </div>
        <div class="detail-list grid gap-[14px]">
          <div class="detail-row">
            <span>状态</span>
            <strong>未选择</strong>
          </div>
        </div>
      </aside>
    `;
  }

  return `
    <aside class="details border-solid border border-line rounded-xl bg-[linear-gradient(180deg,var(--panel),var(--panel-soft))] p-[18px] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
      <div class="detail-title flex items-center justify-between gap-3 mb-[18px] pb-3 border-solid border-b border-line">
        <h2>${escapeHtml(profile.name)}</h2>
        <span class="detail-status text-muted font-mono text-[11px] tracking-[0.08em] ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </div>
      <div class="detail-list grid gap-[14px]">
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
        ${renderProfilePathDetails(profile)}
      </div>
    </aside>
  `;
}

export function renderProfilePathDetails(profile: PublicProfile): string {
  const userDataNote =
    profile.source === "native"
      ? "这一层是系统 Chrome 的父级 User Data 目录；Default、test 等系统个人资料共享这一层。"
      : "ProfilePilot 启动 Chrome 时把 --user-data-dir 指向这一层；固定 CDP 端口绑定这个运行实例。";
  const profileDataLabel = profile.source === "native" ? "Profile 子目录" : "Chrome Profile 数据目录";
  const profileDataNote =
    profile.source === "native"
      ? "当前行对应的 Chrome 个人资料子目录。"
      : "Chrome 在这个独立 User Data 目录下存放实际浏览数据的位置。";

  return `
    <div class="detail-row">
      <span>用户数据目录</span>
      <code class="path-box">${escapeHtml(profile.userDataDir)}</code>
      <small class="detail-note">${escapeHtml(userDataNote)}</small>
    </div>
    <div class="detail-row">
      <span>${profileDataLabel}</span>
      <code class="path-box">${escapeHtml(profile.profileDataPath)}</code>
      <small class="detail-note">${escapeHtml(profileDataNote)}</small>
    </div>
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
