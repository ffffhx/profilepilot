import { isBusyAction } from "../busy";
import { store } from "../state";
import { ExternalChromeInstance, PublicProfile } from "../types";
import { renderLiveViewSection } from "./live-view";
import { NATIVE_CDP_UNSUPPORTED_NOTE, cdpClientToolSummary, cdpLaunchButtonTitle, cdpPortLabel, cdpSessionText, contentionNotice, contentionNoticeShort, deleteButtonTitle, escapeHtml, focusButtonTitle, formatDate, formatRelativeTime, launchButtonTitle, listeningPortsNote, liveAddrLabel, prettyCdpClientLabel, profileStatusLabel, renderButtonLabel, sourceDetail } from "../util";

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
    // 隔离目录里的额外子 profile（isolated-sub）与其父隔离 Profile 归到同一组（同一 user-data-dir）。
    const groupSource = profile.source === "isolated-sub" ? "isolated" : profile.source;
    const key = `${groupSource}:${profile.userDataDir}`;
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
      <td colspan="4">
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
            ${profile.quickLaunchSlot ? `<span class="slot-badge" title="全局快捷键 ⌘⌥${profile.quickLaunchSlot} 直启">⌘⌥${profile.quickLaunchSlot}</span>` : ""}
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

// 「连接」列（合并原 CDP 地址列）：一列讲清该 Profile 的 CDP 端点 —— 端口是否可用 + 谁在驱动。
// 驱动中=端口 chip + ◉ 工具名 + 会话行；空闲=端口 chip + 空闲 + 当前页域名；
// 待启动/不支持/未开启=对应 CDP 芯片。✕ 结束连接在行 hover 时右上角浮现，不占列宽。
export function renderProfileConnectionCell(profile: PublicProfile): string {
  // CDP 未就绪（绑定待启动 / 系统不支持 / 未开启）：只显示 CDP 可用性芯片，无驱动信息。
  if (!profile.cdpUrl) {
    return renderProfileCdpCell(profile);
  }

  const portChip = cdpChip("live", cdpPortLabel(profile.cdpUrl), profile.cdpUrl, null);

  // CDP 已开但无人驱动：只显示端口 + 空闲。当前停在哪个页面只在被外部工具驱动时才有意义，
  // 空闲时没人关注，不展示（避免噪音）。
  if (!profile.cdpClients.length) {
    return `<span class="conn-cell-stack"><span class="conn-line">${portChip}<span class="conn-idle">空闲</span></span></span>`;
  }

  // 驱动中：端口 + ◉ 工具名药丸 + 会话身份行「项目 · 最近活动」（解析不到则退回当前页域名）。
  const primary = profile.cdpClients[0];
  const sessionText = cdpSessionText(primary);
  const age = formatRelativeTime(primary.lastActive);
  let subLine = "";
  if (sessionText || age) {
    subLine = `<span class="conn-session"><span class="conn-session-main">${escapeHtml(sessionText)}</span>${
      age ? `<span class="conn-session-age">${escapeHtml(age)}</span>` : ""
    }</span>`;
  } else if (profile.running && profile.livePrimaryUrl) {
    subLine = renderConnLiveLine(profile);
  }
  // 结束连接只放右侧详情栏（renderCdpClientsDetail），列表行里不再挂 ✕，避免遮挡药丸/操作。
  return `<span class="conn-cell-stack"><span class="conn-line">${portChip}${renderConnPill(profile)}</span>${subLine}</span>`;
}

// 「当前停在哪个域名/IP」的航点行（可 hover 看完整 URL）。tooltip 挂在外层 .conn-live-tip，
// 否则会被 conn-live 自身的 overflow:hidden（截断长地址用）连同 ::after 气泡一起裁掉。
function renderConnLiveLine(profile: PublicProfile): string {
  const label = liveAddrLabel(profile);
  const tabs = profile.liveTabCount && profile.liveTabCount > 1 ? ` · ${profile.liveTabCount} 标签` : "";
  const tip = profile.livePrimaryUrl || label;
  return `<span class="conn-live-tip action-tooltip" data-tooltip="${escapeHtml(tip)}"><span class="conn-live" title="${escapeHtml(tip)}">▸ ${escapeHtml(`${label}${tabs}`)}</span></span>`;
}

// ◉ 工具名药丸（脉冲绿点=正在驱动）。只在有驱动连接时调用。
// 脉冲点已表达“正在驱动”，文字直接给更有信息量的工具名（Codex / agent-browser）；
// tooltip 是结构化卡片：警示（如有）/ 工具 / 会话 / 活动，一类信息一行、各有颜色标注——
// pid、完整警示、归属说明这些细节都在详情栏，hover 只回答“谁在驱动、干什么、多久前”。
// 判定有争用（多个会话抢同一 Profile/tab）时药丸转琥珀警示。
function renderConnPill(profile: PublicProfile): string {
  const clients = profile.cdpClients;
  const primary = clients[0];
  const tool = primary.agent || prettyCdpClientLabel(primary.label);
  const extra = clients.length > 1 ? ` ×${clients.length}` : "";
  const warning = contentionNoticeShort(profile);
  const warnRow = warning ? `<span class="tip-row tip-warn">${escapeHtml(warning)}</span>` : "";
  const age = formatRelativeTime(primary.lastActive);
  // 项目和会话标题分两行展示：项目是「在哪个仓库/目录」，标题是这次会话的抬头，不是一回事，别挤一行。
  // 多会话并存时升级为表格：一会话一行（工具/项目/标题/活动），谁在驱动一眼对齐着看，
  // 而不是只讲第一条、其余折进一句"同时连接"。
  const body =
    clients.length > 1
      ? `${warnRow}${renderConnTipTable(clients)}`
      : [
          warnRow,
          `<span class="tip-row"><em class="tip-tag">工具</em><span class="tip-tool">${escapeHtml(tool)}</span></span>`,
          primary.session ? `<span class="tip-row"><em class="tip-tag">会话</em><span class="tip-project">${escapeHtml(primary.session)}</span></span>` : "",
          primary.project ? `<span class="tip-row"><em class="tip-tag">项目</em><span class="tip-project">${escapeHtml(primary.project)}</span></span>` : "",
          primary.title ? `<span class="tip-row"><em class="tip-tag">标题</em><span class="tip-session">${escapeHtml(primary.title)}</span></span>` : "",
          age ? `<span class="tip-row"><em class="tip-tag">活动</em><span class="tip-age">${escapeHtml(age)}</span></span>` : "",
          primary.note ? `<span class="tip-row"><em class="tip-tag">说明</em><span class="tip-note">${escapeHtml(primary.note)}</span></span>` : ""
        ]
          .filter(Boolean)
          .join("");
  return `<span class="conn-pill attached ${warning ? "contention" : ""}"><span class="conn-dot" aria-hidden="true"></span><span class="conn-label">${escapeHtml(`${tool}${extra}${warning ? " ⚠" : ""}`)}</span><span class="conn-tip-card ${clients.length > 1 ? "wide" : ""}" role="tooltip">${body}</span></span>`;
}

// 多会话 tooltip 表格：每条驱动连接一行。列宽由内容定，标题列最多两行截断（完整信息在详情栏）。
function renderConnTipTable(clients: PublicProfile["cdpClients"]): string {
  const rows = clients
    .map((client) => {
      const tool = client.agent || prettyCdpClientLabel(client.label);
      const age = formatRelativeTime(client.lastActive);
      const title = client.title || client.session || "—";
      return `<tr><td class="tip-tool">${escapeHtml(tool)}</td><td class="tip-project">${escapeHtml(client.project || "—")}</td><td class="tip-session"><span class="tip-clamp">${escapeHtml(title)}</span></td><td class="tip-age">${escapeHtml(age || "—")}</td></tr>`;
    })
    .join("");
  return `<table class="conn-tip-table"><thead><tr><th>工具</th><th>项目</th><th>标题</th><th>活动</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderProfileActions(profile: PublicProfile): string {
  // 隔离目录里的额外子 profile：本工具没登记它，同步/克隆/CDP/改名都不适用，
  // 主操作只给「显示/启动」；「更多」菜单只挂一个「删除」（删目录 + 从父目录 Local State 摘除）。
  if (profile.source === "isolated-sub") {
    const focusingSub = isBusyAction("focus-profile", { profileId: profile.id });
    const launchingSub = isBusyAction("launch-profile", { profileId: profile.id });
    const deletingSub = isBusyAction("delete-profile", { profileId: profile.id });
    const tip = profile.running ? focusButtonTitle(profile) : launchButtonTitle(profile);
    const subPrimaryLoading = focusingSub || launchingSub || deletingSub;
    const subPrimaryLabel = deletingSub ? "删除中…" : profile.running ? "显示中…" : "启动中…";
    const subMenuOpen = store.openProfileMenuId === profile.id;
    return `
      <div class="profile-actions" data-profile-actions>
        <span class="action-tooltip" data-tooltip="${escapeHtml(tip)}">
          <button type="button" class="action-button accent ${subPrimaryLoading ? "loading" : ""}" data-action="${profile.running ? "focus-profile" : "launch"}" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(subPrimaryLoading, profile.running ? "显示" : "启动", subPrimaryLabel)}
          </button>
        </span>
        <span class="menu-anchor relative inline-flex">
          <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${subMenuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>更多</button>
          ${
            subMenuOpen
              ? `
                <div class="action-menu absolute top-[calc(100%+6px)] right-0 z-40 grid w-40 overflow-visible border-solid border border-line-strong rounded-lg bg-panel-raise [box-shadow:var(--shadow)] p-[5px]" role="menu">
                  <span class="action-tooltip" data-tooltip="删除这个子 Profile（会先关闭它所在的整个隔离实例）">
                    <button type="button" class="danger ${deletingSub ? "loading" : ""}" data-action="delete" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                      ${renderButtonLabel(deletingSub, "删除子 Profile", "删除中…")}
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

  // 独立 Profile（工具 Profile）未运行时，主按钮默认走 CDP 启动——这才是本工具的核心用途（喂给 agent）；
  // 普通启动挪到「更多」菜单。系统 Profile 不支持端口式 CDP，保持普通启动。
  const running = profile.running;
  const preferCdp = !running && profile.source === "isolated";
  // 有固定端口的独立 Profile：主按钮一键直启到该端口（不弹框，与悬浮窗一致）；
  // 没有固定端口的：走端口选择弹窗（launch-cdp）让用户挑一个。
  const cdpQuick = preferCdp && profile.fixedCdpPort != null;
  // 关闭 / 删除等从「更多」菜单触发的操作，执行时菜单已收起、只剩全屏 disabled，看起来像卡死。
  // 这里把进行中的状态显示到行内始终可见的主按钮上（转圈 + 「关闭中…/删除中…」）。
  const baseTip = running
    ? focusButtonTitle(profile)
    : preferCdp
      ? cdpLaunchButtonTitle(profile)
      : launchButtonTitle(profile);
  const baseAction = running ? "focus-profile" : preferCdp ? (cdpQuick ? "launch-cdp-quick" : "launch-cdp") : "launch";
  const baseIdle = running ? "显示" : preferCdp ? "CDP 启动" : "启动";
  const baseBusy = running ? focusing : preferCdp ? launchingCdp : launching;
  const menuOpBusyLabel = deleting
    ? "删除中…"
    : closing
      ? "关闭中…"
      : renaming
        ? "保存中…"
        : openingFolder
          ? "打开中…"
          : "";
  const primaryLoading = baseBusy || Boolean(menuOpBusyLabel);
  const primaryLoadingLabel = menuOpBusyLabel || (running ? "显示中…" : preferCdp ? "CDP 启动中…" : "启动中…");

  return `
    <div class="profile-actions" data-profile-actions>
      <span class="action-tooltip" data-tooltip="${escapeHtml(baseTip)}">
        <button type="button" class="action-button accent ${primaryLoading ? "loading" : ""}" data-action="${baseAction}" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
          ${renderButtonLabel(primaryLoading, baseIdle, primaryLoadingLabel)}
        </button>
      </span>
      <span class="menu-anchor relative inline-flex">
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu absolute top-[calc(100%+6px)] right-0 z-40 grid w-40 overflow-visible border-solid border border-line-strong rounded-lg bg-panel-raise [box-shadow:var(--shadow)] p-[5px]" role="menu">
              ${
                preferCdp
                  ? `<button type="button" class="${launching ? "loading" : ""}" data-action="launch" data-id="${profile.id}" title="${escapeHtml(launchButtonTitle(profile))}" ${store.busy ? "disabled" : ""}>
                      ${renderButtonLabel(launching, "普通启动（不开 CDP）", "启动中…")}
                    </button>`
                  : `<button type="button" class="menu-accent ${launchingCdp ? "loading" : ""}" data-action="launch-cdp" data-id="${profile.id}" title="${escapeHtml(cdpLaunchButtonTitle(profile))}" ${cdpLaunchDisabled ? "disabled" : ""}>
                      ${renderButtonLabel(launchingCdp, "CDP 启动", "启动中…")}
                    </button>`
              }
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
              ${renderQuickLaunchSlotRow(profile)}
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

// 「更多」菜单里的全局快捷键指派行：下拉选 ⌘⌥1~9 或「无」。
// 选中已被别的 Profile 占用的槽位会顶掉对方（主进程 setQuickLaunchSlot 处理），下拉里用「· 占用」标注。
function renderQuickLaunchSlotRow(profile: PublicProfile): string {
  const current = profile.quickLaunchSlot ?? null;
  // 各槽位当前绑定的 Profile 名，用于标注「已被谁占用」。
  const slotOwners = new Map<number, string>();
  (store.state?.profiles || []).forEach((item) => {
    if (item.quickLaunchSlot) {
      slotOwners.set(item.quickLaunchSlot, item.name);
    }
  });
  const options = [`<option value=""${current === null ? " selected" : ""}>无</option>`];
  for (let slot = 1; slot <= 9; slot += 1) {
    const owner = slotOwners.get(slot);
    const takenByOther = owner && current !== slot ? ` · ${owner}` : "";
    options.push(`<option value="${slot}"${current === slot ? " selected" : ""}>⌘⌥${slot}${escapeHtml(takenByOther)}</option>`);
  }
  return `
    <label class="menu-slot-row">
      <span class="menu-slot-label">全局快捷键</span>
      <select class="menu-slot-select" data-quick-launch-slot data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
        ${options.join("")}
      </select>
    </label>
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
        <span class="conn-cell-stack"><span class="conn-line">
          ${
            instance.cdpUrl
              ? cdpChip("live", cdpPortLabel(instance.cdpUrl), instance.cdpUrl, null)
              : instance.cdpPort
                ? cdpChip("stale", `:${instance.cdpPort}`, `http://127.0.0.1:${instance.cdpPort}`, "未响应")
                : cdpChip("off", "未开启", null, null)
          }
          <span class="conn-pill none action-tooltip" data-tooltip="外部实例由其他工具自管，不在本工具的连接监测范围内">—</span>
        </span></span>
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
  // 汇总行不带 pid（进程细节对用户没信息量）；断连按钮在同名多连接时才用 pid 区分。
  const value = attached ? `驱动中 · ${cdpClientToolSummary(profile.cdpClients)}` : "当前没有工具连接";

  // 判定有争用时的警示横幅：说明谁在抢 + 建议分流到副本。
  const warning = contentionNotice(profile);
  const warningRow = warning ? `<small class="detail-contention">${escapeHtml(warning)}</small>` : "";

  // 每条连接一行会话身份：工具 · 项目·标题 + 最近活动时间（区分活会话与残留连接）。
  // 多会话共用一个 Profile 正是争用问题的现场，必须每条都平铺出来，不能只显示第一条。
  const sessionRows = profile.cdpClients
    .map((client) => {
      const tool = client.agent || prettyCdpClientLabel(client.label);
      const sessionText = cdpSessionText(client);
      const sessionAge = formatRelativeTime(client.lastActive);
      const main = [tool, sessionText].filter(Boolean).join(" · ");
      if (!main && !sessionAge && !client.note) {
        return "";
      }
      // 归属说明（共享 daemon 推测/归属未知）hover 可见，正文行保持紧凑。
      return `<small class="detail-session"${client.note ? ` title="${escapeHtml(client.note)}"` : ""}>⇁ ${escapeHtml(main)}${
        sessionAge ? `<span class="detail-session-age">${escapeHtml(sessionAge)}</span>` : ""
      }${client.note && !sessionText ? `<span class="detail-session-note">${escapeHtml(client.note)}</span>` : ""}</small>`;
    })
    .join("");

  // 每条连接给一个「结束连接」按钮：对该客户端进程发信号断开，不动 Chrome。
  // 同名工具（如两个 Claude Code 会话）多连接时补 pid 区分，避免不知道结束的是哪一条。
  const disconnecting = isBusyAction("disconnect-client", { profileId: profile.id });
  const toolCounts = new Map<string, number>();
  profile.cdpClients.forEach((client) => {
    const tool = client.agent || prettyCdpClientLabel(client.label);
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  });
  const disconnectRow = attached
    ? `<div class="detail-session-actions">${profile.cdpClients
        .map((client) => {
          const tool = client.agent || prettyCdpClientLabel(client.label);
          const name = (toolCounts.get(tool) || 0) > 1 ? `${tool}(${client.pid})` : tool;
          return `<button type="button" class="action-button warn ${disconnecting ? "loading" : ""}" data-action="disconnect-client" data-id="${escapeHtml(profile.id)}" data-pid="${client.pid}" ${store.busy ? "disabled" : ""} title="结束这条驱动连接，不影响 Chrome">结束 ${escapeHtml(name)} 连接</button>`;
        })
        .join("")}</div>`
    : "";

  return `
    <div class="detail-row${attached ? " detail-row-attached" : ""}">
      <span>Agent 连接</span>
      <strong>${escapeHtml(value)}</strong>
      ${warningRow}
      ${sessionRows}
      ${disconnectRow}
      ${renderAgentOverlaySettingRow()}
      ${renderShellIntegrationRow(profile)}
      <small class="detail-note">检测连到本机 CDP 端口的持久连接；有工具保持长连接（如 agent-browser）时会标为“驱动中”。会话行显示是哪个项目/会话在驱动，以及它最近一次活动时间——很久没动的多半是残留连接，可用「结束连接」断开它（不影响 Chrome）。多个活跃会话共用同一 Profile 会互相抢标签页/焦点，建议用「克隆」给第二个会话分一个副本。</small>
    </div>
  `;
}

function renderAgentOverlaySettingRow(): string {
  const enabled = store.state?.agentOverlayEnabled !== false;
  const busy = isBusyAction("agent-overlay");
  return `
    <div class="agent-overlay-setting">
      <small class="detail-note">AI 操作可见化已${enabled ? "开启" : "关闭"}：agent-browser 操作页面时注入状态条，并允许在页面内停止接管。</small>
      <button type="button" class="overlay-switch ${enabled ? "on" : ""} ${busy ? "loading" : ""}" data-action="toggle-agent-overlay" aria-pressed="${enabled ? "true" : "false"}" ${store.busy ? "disabled" : ""}>
        <span class="overlay-switch-track"><span class="overlay-switch-thumb"></span></span>
        <span>${enabled ? "开启" : "关闭"}</span>
      </button>
    </div>
  `;
}

// 会话识别 shell 集成的引导/状态行。只在“有 agent-browser 驱动连接”时出现——
// 这正是归属能力有无差别的现场；没有相关连接时不打扰。
function renderShellIntegrationRow(profile: PublicProfile): string {
  const status = store.state?.shellIntegration;
  if (!status?.supported) {
    return "";
  }
  const hasAgentBrowser = profile.cdpClients.some((client) => client.label.startsWith("agent-browser"));
  if (!hasAgentBrowser) {
    return "";
  }

  const busy = isBusyAction("shell-integration");
  if (!status.installed) {
    return `
      <small class="detail-note">启用「会话识别」后，每个 AI 会话的 agent-browser 自动隔离并携带会话身份——这里就能显示是哪个会话在驱动（往 ${escapeHtml(status.path)} 写一段可移除的配置，对新开会话生效）。</small>
      <div class="detail-session-actions">
        <button type="button" class="action-button accent ${busy ? "loading" : ""}" data-action="enable-shell-integration" ${store.busy ? "disabled" : ""}>${renderButtonLabel(busy, "启用会话识别", "写入中…")}</button>
      </div>
    `;
  }
  if (status.managed) {
    return `
      <small class="detail-note">✓ 会话识别已启用（由本工具写入 ${escapeHtml(status.path)}）。<button type="button" class="detail-inline-link" data-action="remove-shell-integration" ${store.busy ? "disabled" : ""}>移除</button></small>
    `;
  }
  return `<small class="detail-note">✓ 会话识别已启用（${escapeHtml(status.path)} 中手动配置）。</small>`;
}
