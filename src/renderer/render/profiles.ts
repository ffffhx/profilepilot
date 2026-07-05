import { isBusyAction } from "../busy";
import { store } from "../state";
import { ExternalChromeInstance, PublicProfile } from "../types";
import { renderLiveViewSection } from "./live-view";
import { NATIVE_CDP_UNSUPPORTED_NOTE, cdpLaunchButtonTitle, cdpPortLabel, cdpSessionText, deleteButtonTitle, escapeHtml, focusButtonTitle, formatDate, formatRelativeTime, launchButtonTitle, listeningPortsNote, liveAddrLabel, prettyCdpClientLabel, profileStatusLabel, renderButtonLabel, sourceDetail } from "../util";

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
  // 各组 user-data-dir 的公共前缀（如 /Users/x/Library/Application Support）相同，根行里省略不显示。
  const commonPrefix = commonPathPrefix(profileGroups.map((group) => group.userDataDir));

  return `
    <div class="profiles-table-wrap overflow-visible border-solid border border-line rounded-xl bg-panel [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
      <table class="profiles-table w-full border-collapse table-fixed">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>CDP 地址</th>
            <th>连接</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${profileGroups.map((group) => renderProfileRootGroup(group, commonPrefix)).join("")}
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

export function renderProfileRootGroup(group: ProfileRootGroup, commonPrefix = ""): string {
  const countLabel = group.profiles.length === 1 ? "1 Profile" : `${group.profiles.length} Profiles`;
  return (
    renderProfileRootRow(group.userDataDir, commonPrefix, countLabel) +
    group.profiles.map((profile, index) => renderProfileRow(profile, index === group.profiles.length - 1)).join("")
  );
}

// 根行只展示 user-data-dir 去掉组间公共前缀后的尾部 + 右侧 Profile 计数；名称标签不再展示。
// hover 路径仍提示完整 user-data-dir。
export function renderProfileRootRow(userDataDir: string, commonPrefix: string, countLabel: string): string {
  const tail = rootDisplayPath(userDataDir, commonPrefix);
  return `
    <tr class="table-group-row profile-root-row">
      <td colspan="5">
        <div class="profile-root-content">
          <span class="profile-root-head">
            <span class="profile-root-node" aria-hidden="true"></span>
            ${renderPathTooltip(tail, userDataDir, "profile-root-path-tip")}
          </span>
          <span class="count">${escapeHtml(countLabel)}</span>
        </div>
      </td>
    </tr>
  `;
}

// 计算一组路径的最长公共目录前缀（按 / 分段）。少于两个路径时无公共前缀。
export function commonPathPrefix(paths: string[]): string {
  const cleaned = paths.filter(Boolean).map((path) => path.replace(/\/+$/, ""));
  if (cleaned.length < 2) {
    return "";
  }
  const split = cleaned.map((path) => path.split("/"));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i += 1) {
    if (!split.every((segments) => segments[i] === first[i])) {
      break;
    }
  }
  return first.slice(0, i).join("/");
}

function rootDisplayPath(userDataDir: string, commonPrefix: string): string {
  let tail = userDataDir;
  if (commonPrefix && userDataDir.startsWith(commonPrefix)) {
    tail = userDataDir.slice(commonPrefix.length).replace(/^\/+/, "");
  }
  if (!tail) {
    // 兜底（单组等情况）：去掉 Application Support / .config 样板前缀。
    tail = userDataDir.replace(/^.*\/Application Support\//, "").replace(/^.*\/\.config\//, "");
  }
  return tail || userDataDir;
}

export function renderProfileRow(profile: PublicProfile, lastInGroup = false): string {
  const selected = profile.id === store.selectedId;
  // isolated：显示独立数据目录名（如 test03-00064815，即去掉公共前缀后“不一样”的那段），hover 看完整 user-data-dir；
  // native：仍显示 Chrome 个人资料子目录名（Default 等）。
  const isNative = profile.source === "native";
  const pathKind = isNative ? "Profile Dir" : "数据目录";
  const pathLabel = profile.dirName;
  const fullPath = isNative ? profile.profileDataPath : profile.userDataDir;
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
        ${renderProfileConnectionCell(profile)}
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

// 表格里直接展示该 Profile 的 CDP 连接地址：正在以 CDP 运行时显示实时地址（live）；
// 绑定了固定端口但未运行时显示该端口地址（bound · 待启动）；系统 Profile 不支持（off）。
export function renderProfileCdpCell(profile: PublicProfile): string {
  if (profile.cdpUrl) {
    return cdpChip("live", cdpPortLabel(profile.cdpUrl), profile.cdpUrl, null);
  }
  if (profile.source === "native") {
    return cdpChip("off", "不支持", null, null);
  }
  if (profile.fixedCdpPort) {
    const url = `http://127.0.0.1:${profile.fixedCdpPort}`;
    return cdpChip("bound", `:${profile.fixedCdpPort}`, url, "待启动");
  }
  return cdpChip("off", "未开启", null, null);
}

// CDP 状态芯片：前导指示灯 + 地址 + 可选状态标签，沿用全局信号灯语言。
// live=实时(绿) / bound=已绑定待启动(蓝) / stale=声明端口未响应(琥珀) / off=无(灰)。
export function cdpChip(
  kind: "live" | "attached" | "bound" | "stale" | "off",
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

// 「连接」列：显示该 Profile 的 CDP 是否正被外部工具（agent-browser 等）持久连接驱动。
// 驱动中=有工具长连接；空闲=CDP 已开但无人连；—=未开 CDP。
export function renderProfileConnectionCell(profile: PublicProfile): string {
  const pill = renderConnPill(profile);
  // 运行中且 CDP 可读时，在连接状态下方挂一行“当前停在哪个域名/IP”的航点摘要（可点击切换）。
  if (!profile.running || !profile.livePrimaryUrl) {
    return pill;
  }
  const label = liveAddrLabel(profile);
  const tabs = profile.liveTabCount && profile.liveTabCount > 1 ? ` · ${profile.liveTabCount} 标签` : "";
  // 只显示当前页域名；hover 给完整 URL（含路径）。tooltip 挂在外层 .conn-live-tip 上，
  // 否则会被 conn-live 自身的 overflow:hidden（用于截断长地址）连同 ::after 气泡一起裁掉。
  const tip = profile.livePrimaryUrl || label;
  return `<span class="conn-cell-stack">${pill}<span class="conn-live-tip action-tooltip" data-tooltip="${escapeHtml(tip)}"><span class="conn-live" title="${escapeHtml(tip)}">▸ ${escapeHtml(`${label}${tabs}`)}</span></span></span>`;
}

// 当前页的完整地址提示：优先“域名（IP）”，否则完整 IP/域名，再不行退回完整 URL。
function renderConnPill(profile: PublicProfile): string {
  if (profile.cdpClients.length) {
    const clientText = profile.cdpClients.map((client) => `${client.label}(${client.pid})`).join("、");
    const extra = profile.cdpClients.length > 1 ? ` ×${profile.cdpClients.length}` : "";
    // tooltip 补上首个连接的会话身份与最近活动，一眼看出是哪个 session、是否还活着。
    const primary = profile.cdpClients[0];
    const sessionDesc = [cdpSessionText(primary), formatRelativeTime(primary.lastActive)].filter(Boolean).join(" · ");
    const tip = sessionDesc ? `驱动中：${clientText} · ${sessionDesc}` : `驱动中：${clientText}`;
    // 药丸末尾挂个 ✕：结束首个驱动连接（多条连接时其余去详情页逐条断）。
    const disconnect = `<button type="button" class="conn-disconnect" data-action="disconnect-client" data-id="${escapeHtml(profile.id)}" data-pid="${primary.pid}" ${store.busy ? "disabled" : ""} title="结束这条驱动连接，不影响 Chrome" aria-label="结束驱动连接">✕</button>`;
    return `<span class="conn-pill attached action-tooltip" data-tooltip="${escapeHtml(tip)}"><span class="conn-dot" aria-hidden="true"></span><span class="conn-label">驱动中${extra}</span>${disconnect}</span>`;
  }
  if (profile.cdpUrl) {
    return `<span class="conn-pill idle action-tooltip" data-tooltip="CDP 已开启，当前没有工具连接"><span class="conn-dot" aria-hidden="true"></span><span class="conn-label">空闲</span></span>`;
  }
  return `<span class="conn-pill none">—</span>`;
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
      <span class="menu-anchor relative inline-flex">
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu absolute top-[calc(100%+6px)] right-0 z-40 grid w-40 overflow-visible border-solid border border-line-strong rounded-lg bg-panel-raise [box-shadow:var(--shadow)] p-[5px]" role="menu">
              <button type="button" class="menu-accent ${launchingCdp ? "loading" : ""}" data-action="launch-cdp" data-id="${profile.id}" title="${escapeHtml(cdpLaunchButtonTitle(profile))}" ${cdpLaunchDisabled ? "disabled" : ""}>
                ${renderButtonLabel(launchingCdp, "CDP 启动", "启动中…")}
              </button>
              <button type="button" class="menu-warn ${closing ? "loading" : ""}" data-action="close-profile" data-id="${profile.id}" ${store.busy || !profile.running ? "disabled" : ""}>
                ${renderButtonLabel(closing, "关闭", "关闭中…")}
              </button>
              <button type="button" class="${openingFolder ? "loading" : ""}" data-action="open-folder" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(openingFolder, "打开目录", "打开中…")}
              </button>
              <button type="button" class="${renaming ? "loading" : ""}" data-action="rename-profile" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                ${renderButtonLabel(renaming, "修改名称", "保存中…")}
              </button>
              <button type="button" class="${miniPinnedBusy ? "loading" : ""}" data-action="${profile.pinnedToMini ? "unpin-mini-profile" : "pin-mini-profile"}" data-id="${profile.id}" ${miniPinDisabled ? "disabled" : ""}>
                ${renderButtonLabel(miniPinnedBusy, profile.pinnedToMini ? "取消悬浮窗固定" : "固定到悬浮窗", "保存中…")}
              </button>
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
      <td colspan="5">
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
            ? cdpChip("live", cdpPortLabel(instance.cdpUrl), instance.cdpUrl, null)
            : instance.cdpPort
              ? cdpChip("stale", `:${instance.cdpPort}`, `http://127.0.0.1:${instance.cdpPort}`, "未响应")
              : cdpChip("off", "未开启", null, null)
        }
      </td>
      <td>
        <span class="conn-pill none action-tooltip" data-tooltip="外部实例由其他工具自管，不在本工具的连接监测范围内">—</span>
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
      </div>
      ${renderLiveViewSection(profile)}
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

  return cdpRow + renderCdpClientsDetail(profile);
}

// 显示当前正持久连接该 CDP 端口的驱动工具（agent-browser / Playwright / DevTools 等）。
export function renderCdpClientsDetail(profile: PublicProfile): string {
  if (!profile.cdpUrl) {
    return "";
  }

  const attached = profile.cdpClients.length > 0;
  const value = attached
    ? `驱动中 · ${profile.cdpClients.map((client) => `${client.label}(${client.pid})`).join("、")}`
    : "当前没有工具连接";

  // 首个连接的会话身份行：哪个项目 / 哪个会话在驱动 + 最近活动时间（区分活会话与残留连接）。
  const primary = attached ? profile.cdpClients[0] : undefined;
  const sessionText = primary ? cdpSessionText(primary) : "";
  const sessionAge = primary ? formatRelativeTime(primary.lastActive) : "";
  const sessionRow =
    sessionText || sessionAge
      ? `<small class="detail-session">⇁ ${escapeHtml(sessionText)}${
          sessionAge ? `<span class="detail-session-age">${escapeHtml(sessionAge)}</span>` : ""
        }</small>`
      : "";

  // 每条连接给一个「结束连接」按钮：对该客户端进程发信号断开，不动 Chrome。
  const disconnecting = isBusyAction("disconnect-client", { profileId: profile.id });
  const disconnectRow = attached
    ? `<div class="detail-session-actions">${profile.cdpClients
        .map((client) => {
          const tool = client.agent || prettyCdpClientLabel(client.label);
          return `<button type="button" class="action-button warn ${disconnecting ? "loading" : ""}" data-action="disconnect-client" data-id="${escapeHtml(profile.id)}" data-pid="${client.pid}" ${store.busy ? "disabled" : ""} title="结束这条驱动连接，不影响 Chrome">结束 ${escapeHtml(tool)} 连接</button>`;
        })
        .join("")}</div>`
    : "";

  return `
    <div class="detail-row${attached ? " detail-row-attached" : ""}">
      <span>Agent 连接</span>
      <strong>${escapeHtml(value)}</strong>
      ${sessionRow}
      ${disconnectRow}
      <small class="detail-note">检测连到本机 CDP 端口的持久连接；有工具保持长连接（如 agent-browser）时会标为“驱动中”。会话行显示是哪个项目/会话在驱动，以及它最近一次活动时间——很久没动的多半是残留连接，可用「结束连接」断开它（不影响 Chrome）。</small>
    </div>
  `;
}

