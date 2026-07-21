import { isBusyAction } from "../busy";
import { store } from "../state";
import { AgentActivity, CdpClientInfo, ExternalChromeInstance, PublicProfile } from "../types";
import { renderLiveViewSection } from "./live-view";
import { NATIVE_CDP_UNSUPPORTED_NOTE, agentActivityLeadText, agentActivityProgressText, agentActivityTooltipText, agentBrowserOccupancyClient, cdpClientToolSummary, cdpLaunchButtonTitle, cdpPortLabel, cdpSessionText, contentionNotice, contentionNoticeShort, deleteButtonTitle, escapeHtml, focusButtonTitle, formatDate, formatRelativeTime, gatewayControlClient, gatewayUserHasControl, launchButtonTitle, listeningPortsNote, liveAddrLabel, prettyCdpClientLabel, profileAgentBrowserReserved, profileAgentControlClients, profileStatusLabel, profileUserHasControl, renderButtonLabel, sourceDetail, truncateText } from "../util";

interface ConnectionActivityModel {
  cdpClients: CdpClientInfo[];
  agentActivity?: AgentActivity | null;
}

interface ProfileRootGroup {
  key: string;
  label: string;
  userDataDir: string;
  profiles: PublicProfile[];
}

// 受管 Profile 表格与外部实例放进同一个框：它们本质都是 Profile，只是
// 来源不同；外部实例仍只读（仅显示/关闭），用框内分隔段和类型标签区分。
export function renderProfilesPanel(profiles: PublicProfile[], externalInstances: ExternalChromeInstance[]): string {
  const profileGroups = groupProfilesByUserDataDir(sortByMainOrder(profiles));

  return `
    <div class="profiles-table-wrap overflow-visible border-solid border border-line rounded-xl bg-panel [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.35)]">
      <table class="profiles-table w-full border-collapse table-fixed">
        <colgroup>
          <col class="profile-col-name" />
          <col class="profile-col-status" />
          <col class="profile-col-connection" />
          <col class="profile-col-activity" />
          <col class="profile-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>Profile</th>
            <th>Status</th>
            <th>Connection</th>
            <th>Agent Activity</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${profileGroups.map((group) => renderProfileRootGroup(group)).join("")}
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

// 根行（user-data-dir 尾部 + Profile 计数）已不再展示：受管 Profile 直接以扁平顶层行呈现，
// 完整 user-data-dir 仍可在每行的数据目录 hover 提示里看到。
export function renderProfileRootGroup(group: ProfileRootGroup): string {
  return group.profiles
    .map((profile, index) => renderProfileRow(profile, index === 0, index === group.profiles.length - 1))
    .join("");
}

// 应用主窗口 Profile 表格的自定义拖拽排序：列在 mainProfileOrder 里的靠前，
// 未列出的排后面、保持自然顺序（sort 稳定）。语义同悬浮窗的 sortByMiniOrder。
export function sortByMainOrder(profiles: PublicProfile[]): PublicProfile[] {
  const order = store.state?.mainProfileOrder || [];
  if (!order.length) {
    return [...profiles];
  }

  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...profiles].sort(
    (a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

export interface MainProfileGroup {
  key: string;
  memberIds: string[];
}

// 主窗口表格实际渲染出来的「数据目录分组 + 组内成员顺序」，供拖拽排序计算用。
// 每组首个成员即该数据目录的主 Profile（isolated / native），其后是目录内的子 Profile。
export function mainProfileGroups(profiles: PublicProfile[]): MainProfileGroup[] {
  return groupProfilesByUserDataDir(sortByMainOrder(profiles)).map((group) => ({
    key: group.key,
    memberIds: group.profiles.map((profile) => profile.id)
  }));
}

// 纯函数：给定当前分组、被拖 id、落点 id、是否插到落点之前，算出新的完整 id 顺序。
// 两级语义：组首（主 Profile）拖动 → 整组在各数据目录间移动；
// 子 Profile 拖动 → 仅在本目录内移动、且不越过组首（主 Profile 恒为组内首位）。
// 非法落点（落点即自身 / 子行跨目录 / 组首落回本组）返回 null。
export function computeMainReorder(
  groups: MainProfileGroup[],
  draggedId: string,
  targetId: string,
  insertBefore: boolean
): string[] | null {
  if (draggedId === targetId) {
    return null;
  }
  const fromIdx = groups.findIndex((group) => group.memberIds.includes(draggedId));
  const targetGroupIdx = groups.findIndex((group) => group.memberIds.includes(targetId));
  if (fromIdx < 0 || targetGroupIdx < 0) {
    return null;
  }
  const fromGroup = groups[fromIdx];
  const isPrimary = fromGroup.memberIds[0] === draggedId;

  if (isPrimary) {
    if (targetGroupIdx === fromIdx) {
      return null;
    }
    const targetKey = groups[targetGroupIdx].key;
    const remaining = groups.filter((_, idx) => idx !== fromIdx);
    const insertPos = remaining.findIndex((group) => group.key === targetKey);
    const insertAt = insertBefore ? insertPos : insertPos + 1;
    const nextGroups = [...remaining.slice(0, insertAt), fromGroup, ...remaining.slice(insertAt)];
    return nextGroups.flatMap((group) => group.memberIds);
  }

  if (targetGroupIdx !== fromIdx) {
    return null;
  }
  const withoutDragged = fromGroup.memberIds.filter((memberId) => memberId !== draggedId);
  const targetPos = withoutDragged.indexOf(targetId);
  if (targetPos < 0) {
    return null;
  }
  const insertAt = Math.max(1, insertBefore ? targetPos : targetPos + 1);
  const nextMembers = [...withoutDragged.slice(0, insertAt), draggedId, ...withoutDragged.slice(insertAt)];
  const nextGroups = groups.map((group, idx) => (idx === fromIdx ? { ...group, memberIds: nextMembers } : group));
  return nextGroups.flatMap((group) => group.memberIds);
}

export function renderProfileRow(profile: PublicProfile, isFirstInGroup = false, lastInGroup = false): string {
  const selected = profile.id === store.selectedId;
  // 数据目录行已隐藏：一个 user-data-dir 对应一个 CDP、其下可有多个 Profile，
  // 这个映射用户已理清，行内只留名称/徽标；完整路径仍在详情栏可查。
  // 拖拽角色：组首（主 Profile）拖动=整块数据目录一起挪；组内其它（子 Profile）拖动=仅在目录内排序。
  const dragRole = isFirstInGroup ? "primary" : "sub";
  const handleTitle = isFirstInGroup ? "拖拽调整数据目录顺序" : "拖拽在数据目录内排序";
  return `
    <tr class="profile-child-row ${lastInGroup ? "last-in-group" : ""} ${selected ? "selected" : ""}" data-action="select" data-id="${profile.id}" data-profile-row data-drag-role="${dragRole}" tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td class="profile-name-cell">
        <span class="drag-handle" data-drag-handle role="button" tabindex="-1" aria-label="${handleTitle}" title="${handleTitle}">⠿</span>
        <div class="profile-pick w-full min-h-[auto] py-1 px-0.5 text-left">
          <span class="profile-name-line flex items-center gap-2 min-w-0">
            <span class="status-dot w-[9px] h-[9px] flex-[0_0_auto] rounded-full bg-line-strong ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
            <span class="profile-name block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-[650] leading-[1.25]">${escapeHtml(profile.name)}</span>
            ${profile.isDefault ? '<span class="native-badge inline-flex items-center justify-center border-solid border border-warn-line rounded-full px-2 py-[3px] bg-warn-soft text-warn-bright font-mono text-[10px] font-semibold tracking-[0.06em]">DEFAULT</span>' : ""}
            ${profile.quickLaunchSlot ? `<span class="slot-badge" title="全局快捷键 ⌘⌥${profile.quickLaunchSlot} 直启">⌘⌥${profile.quickLaunchSlot}</span>` : ""}
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill inline-flex items-center justify-center min-w-[58px] border-solid border border-line-strong rounded-full px-[9px] py-1 bg-transparent text-muted font-mono text-[11px] font-semibold tracking-[0.06em] ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td>
        ${renderProfilePortCell(profile)}
      </td>
      <td>
        ${renderProfileActivityCell(profile)}
      </td>
      <td>
        ${renderProfileActions(profile)}
      </td>
    </tr>
  `;
}

// 表格里直接展示该 Profile 的 CDP 连接地址：正在以 CDP 运行时显示实时地址（live）；
// 绑定了固定端口但未运行时显示该端口地址（bound · 待启动）；系统 Profile 不支持（off）。
export function renderProfileCdpCell(profile: PublicProfile): string {
  if (profile.cdpUrl) {
    return cdpChip("live", cdpPortLabel(profile.cdpUrl), profile.cdpUrl, null);
  }
  if (profile.source === "native") {
    return cdpChip("off", "不支持 Gateway", null, null);
  }
  if (profile.fixedCdpPort) {
    const url = `http://127.0.0.1:${profile.fixedCdpPort}`;
    return cdpChip("bound", `:${profile.fixedCdpPort}`, url, "待启动");
  }
  return cdpChip("off", "未开启", null, null);
}

// Profile Registry 的 CONNECTION 列只表达端口/Gateway 可用性，驱动者和会话活动
// 单独进入 AGENT ACTIVITY 列。两类信息拆开后，每一行都能共享同一组固定列起点。
export function renderProfilePortCell(profile: PublicProfile): string {
  if (!profile.cdpUrl) {
    return renderProfileCdpCell(profile);
  }
  return cdpChip(
    "live",
    cdpPortLabel(profile.cdpUrl),
    profile.gatewayControl
      ? `ProfilePilot Gateway 逻辑入口 · ${cdpPortLabel(profile.cdpUrl)}`
      : profile.cdpUrl,
    profile.gatewayControl ? "Gateway" : null
  );
}

// Profile Registry 的 AGENT ACTIVITY 列：第一行回答“谁在驱动/谁占有控制权”，
// 第二行只保留项目（或会话身份）与最近活动。空态也占据同一列，保证轨道严格对齐。
export function renderProfileActivityCell(profile: PublicProfile): string {
  const control = profile.gatewayControl;
  if (control?.sessionStatus === "active" && control.ownerSessionId) {
    const activelyDriven = control.ownership === "agent" && control.connectionActive && profile.cdpClients.length > 0;
    if (!activelyDriven) {
      const client = gatewayControlClient(profile);
      const label = control.ownership === "user"
        ? control.pendingUserAction ? "等待用户操作" : "用户已接管"
        : "Agent 已绑定";
      const tooltip = control.ownership === "user"
        ? control.pendingUserAction
          ? `等待用户完成：${control.pendingUserAction}；Agent Session 仍保留`
          : "浏览器控制权属于用户；Agent Session 仍保留，等待交还"
        : "Gateway 已为该 Agent 保留控制权，当前没有活动连接";
      return renderProfileActivityTrack(
        label,
        client ? cdpSessionText(client) : control.ownerSessionId,
        formatRelativeTime(control.updatedAt),
        tooltip,
        control.ownership === "user" ? "user" : "reserved"
      );
    }
  }

  if (profile.agentBrowserOccupancy && !control?.ownerSessionId) {
    const occupancy = profile.agentBrowserOccupancy;
    const client = agentBrowserOccupancyClient(profile);
    const label = occupancy.ownership === "user" ? "用户已接管" : "Agent 已绑定";
    const tooltip = occupancy.ownership === "user"
      ? "Session 仍保留，自动切换不会使用此 Profile；请交还或释放后再复用"
      : "agent-browser Session 仍排他预留此 Profile，自动切换不会使用";
    return renderProfileActivityTrack(
      label,
      client ? cdpSessionText(client) : occupancy.session,
      formatRelativeTime(occupancy.updatedAt),
      tooltip,
      occupancy.ownership === "user" ? "user" : "reserved"
    );
  }

  if (!profile.cdpUrl) {
    return '<span class="profile-activity-empty">—</span>';
  }
  if (!profile.cdpClients.length) {
    return '<span class="profile-activity-empty">空闲</span>';
  }

  const primary = profile.cdpClients[0];
  const tool = primary.agent || prettyCdpClientLabel(primary.label);
  const extra = profile.cdpClients.length > 1 ? ` ×${profile.cdpClients.length}` : "";
  const warning = contentionNoticeShort(profile);
  const activityTooltip = agentActivityTooltipText(profile.agentActivity);
  const tooltip = [warning, activityTooltip, primary.note].filter(Boolean).join(" · ") || `${tool} 正在驱动`;
  const sessionText = primary.project || primary.title || primary.session || "";
  return renderProfileActivityTrack(
    `${tool}${extra} 正在驱动${warning ? " ⚠" : ""}`,
    sessionText,
    formatRelativeTime(primary.lastActive),
    tooltip,
    warning ? "contention" : "driving"
  );
}

function renderProfileActivityTrack(
  label: string,
  sessionText: string,
  age: string,
  tooltip: string,
  tone: "driving" | "contention" | "reserved" | "user"
): string {
  const meta = [sessionText, age].filter(Boolean);
  return `
    <span class="profile-activity-track ${tone}">
      <span class="profile-activity-signal" aria-hidden="true"></span>
      <span class="profile-activity-main action-tooltip" data-tooltip="${escapeHtml(tooltip)}">
        <span class="profile-activity-label">${escapeHtml(label)}</span>
      </span>
      ${meta.length ? `<span class="profile-activity-meta"><span>${escapeHtml(meta[0] || "")}</span>${meta[1] ? `<em>· ${escapeHtml(meta[1])}</em>` : ""}</span>` : ""}
    </span>
  `;
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
    const cdpCell = renderProfileCdpCell(profile);
    return renderAgentBrowserOccupancyCell(profile, cdpCell) || cdpCell;
  }

  const portChip = cdpChip(
    "live",
    cdpPortLabel(profile.cdpUrl),
    profile.gatewayControl
      ? `ProfilePilot Gateway 逻辑入口 · ${cdpPortLabel(profile.cdpUrl)}`
      : profile.cdpUrl,
    profile.gatewayControl ? "Gateway" : null
  );
  const gatewayControlCell = renderGatewayControlCell(profile, portChip);
  if (gatewayControlCell) {
    return gatewayControlCell;
  }
  const occupancyCell = renderAgentBrowserOccupancyCell(profile, portChip);
  if (occupancyCell) {
    return occupancyCell;
  }

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
  return `<span class="conn-cell-stack"><span class="conn-line">${portChip}${renderConnPill(profile)}${renderAgentActivityInline(profile)}</span>${subLine}</span>`;
}

function renderAgentBrowserOccupancyCell(profile: PublicProfile, portChip: string): string {
  // 有活动 Gateway 归属时由 renderGatewayControlCell 展示；这里专门补足旧租约/断连租约，
  // 与自动候选筛选使用同一份 agentBrowserOccupancy，避免误显示“空闲”。
  if (!profile.agentBrowserOccupancy || profile.gatewayControl?.ownerSessionId) return "";
  const occupancy = profile.agentBrowserOccupancy;
  const client = agentBrowserOccupancyClient(profile);
  const label = occupancy.ownership === "user" ? "用户已接管" : "Agent 已绑定";
  const tip = occupancy.ownership === "user"
    ? "Session 仍保留，自动切换不会使用此 Profile；请交还或释放后再复用"
    : "agent-browser Session 仍排他预留此 Profile，自动切换不会使用";
  const sessionText = client ? cdpSessionText(client) : occupancy.session;
  const age = formatRelativeTime(occupancy.updatedAt);
  const subLine = sessionText || age
    ? `<span class="conn-session"><span class="conn-session-main">${escapeHtml(sessionText)}</span>${
        age ? `<span class="conn-session-age">${escapeHtml(age)}</span>` : ""
      }</span>`
    : "";
  return `<span class="conn-cell-stack"><span class="conn-line">${portChip}<span class="conn-pill none action-tooltip" data-tooltip="${escapeHtml(tip)}">${escapeHtml(label)}</span></span>${subLine}</span>`;
}

function renderGatewayControlCell(profile: PublicProfile, portChip: string): string {
  const control = profile.gatewayControl;
  if (!control || control.sessionStatus !== "active" || !control.ownerSessionId) return "";
  // Agent 真正持有长连接时继续走标准“驱动中”样式；这里只覆盖已接管/已绑定但未连接。
  if (control.ownership === "agent" && control.connectionActive) return "";
  const client = gatewayControlClient(profile);
  const sessionText = client ? cdpSessionText(client) : control.ownerSessionId;
  const age = formatRelativeTime(control.updatedAt);
  const label = control.ownership === "user"
    ? control.pendingUserAction ? "等待用户操作" : "用户已接管"
    : "Agent 已绑定";
  const tip = control.ownership === "user"
    ? control.pendingUserAction
      ? `等待用户完成：${control.pendingUserAction}；Agent Session 仍保留`
      : "浏览器控制权属于用户；Agent Session 仍保留，等待交还"
    : "Gateway 已为该 Agent 保留控制权，当前没有活动连接";
  const subLine = sessionText || age
    ? `<span class="conn-session"><span class="conn-session-main">${escapeHtml(sessionText)}</span>${
        age ? `<span class="conn-session-age">${escapeHtml(age)}</span>` : ""
      }</span>`
    : "";
  return `<span class="conn-cell-stack"><span class="conn-line">${portChip}<span class="conn-pill none action-tooltip" data-tooltip="${escapeHtml(tip)}">${escapeHtml(label)}</span></span>${subLine}</span>`;
}

// 「当前停在哪个域名/IP」的航点行（可 hover 看完整 URL）。tooltip 挂在外层 .conn-live-tip，
// 否则会被 conn-live 自身的 overflow:hidden（截断长地址用）连同 ::after 气泡一起裁掉。
function renderConnLiveLine(profile: PublicProfile): string {
  const label = liveAddrLabel(profile);
  const tabs = profile.liveTabCount && profile.liveTabCount > 1 ? ` · ${profile.liveTabCount} 标签` : "";
  const tip = profile.livePrimaryUrl || label;
  return `<span class="conn-live-tip action-tooltip" data-tooltip="${escapeHtml(tip)}"><span class="conn-live" title="${escapeHtml(tip)}">▸ ${escapeHtml(`${label}${tabs}`)}</span></span>`;
}

function activityValue(value?: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hasConnectionAgentActivity(model: ConnectionActivityModel): boolean {
  return Boolean(model.agentActivity) && model.cdpClients.length > 0;
}

function renderAgentActivityInline(profile: ConnectionActivityModel): string {
  if (!hasConnectionAgentActivity(profile)) {
    return "";
  }
  const activity = profile.agentActivity;
  const lead = agentActivityLeadText(activity) || "正在操作";
  const progress = agentActivityProgressText(activity);
  const tooltip = agentActivityTooltipText(activity) || lead;
  const activityKey = [lead, progress, activity?.updatedAt || ""].join("|");
  return `<span class="conn-agent-action-tip action-tooltip" data-tooltip="${escapeHtml(tooltip)}"><span class="conn-agent-action" data-activity-key="${escapeHtml(activityKey)}"><span class="conn-agent-action-text">▸ ${escapeHtml(lead)}</span>${progress ? `<span class="conn-agent-progress">${escapeHtml(progress)}</span>` : ""}</span></span>`;
}

function renderAgentActivityTipRows(profile: ConnectionActivityModel): string {
  if (!hasConnectionAgentActivity(profile) || !profile.agentActivity) {
    return "";
  }
  const activity = profile.agentActivity;
  const action = activityValue(activity.currentAction);
  const progress = agentActivityProgressText(activity);
  const currentStep = activityValue(activity.currentStep);
  const nextStep = activityValue(activity.nextStep);
  const lastMessage = activityValue(activity.lastMessage);
  return [
    action ? `<span class="tip-row tip-activity"><em class="tip-tag">当前动作</em><span>${escapeHtml(action)}</span></span>` : "",
    progress ? `<span class="tip-row tip-activity"><em class="tip-tag">进度</em><span>${escapeHtml(`第 ${progress} 步`)}</span></span>` : "",
    currentStep ? `<span class="tip-row tip-activity"><em class="tip-tag">当前步骤</em><span>${escapeHtml(currentStep)}</span></span>` : "",
    nextStep ? `<span class="tip-row tip-activity"><em class="tip-tag">下一步</em><span>${escapeHtml(nextStep)}</span></span>` : "",
    lastMessage ? `<span class="tip-row tip-activity"><em class="tip-tag">AI 最近说</em><span>${escapeHtml(truncateText(lastMessage, 96))}</span></span>` : ""
  ]
    .filter(Boolean)
    .join("");
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
  const activityRows = renderAgentActivityTipRows(profile);
  // 项目和会话标题分两行展示：项目是「在哪个仓库/目录」，标题是这次会话的抬头，不是一回事，别挤一行。
  // 多会话并存时升级为表格：一会话一行（工具/项目/标题/活动），谁在驱动一眼对齐着看，
  // 而不是只讲第一条、其余折进一句"同时连接"。
  const body =
    clients.length > 1
      ? `${warnRow}${renderConnTipTable(clients)}${activityRows}`
      : [
          warnRow,
          `<span class="tip-row"><em class="tip-tag">工具</em><span class="tip-tool">${escapeHtml(tool)}</span></span>`,
          primary.session ? `<span class="tip-row"><em class="tip-tag">会话</em><span class="tip-project">${escapeHtml(primary.session)}</span></span>` : "",
          primary.project ? `<span class="tip-row"><em class="tip-tag">项目</em><span class="tip-project">${escapeHtml(primary.project)}</span></span>` : "",
          primary.title ? `<span class="tip-row"><em class="tip-tag">标题</em><span class="tip-session">${escapeHtml(primary.title)}</span></span>` : "",
          age ? `<span class="tip-row"><em class="tip-tag">活动</em><span class="tip-age">${escapeHtml(age)}</span></span>` : "",
          primary.note ? `<span class="tip-row"><em class="tip-tag">说明</em><span class="tip-note">${escapeHtml(primary.note)}</span></span>` : "",
          activityRows
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
        <span class="action-tooltip profile-primary-action" data-tooltip="${escapeHtml(tip)}">
          <button type="button" class="action-button accent ${subPrimaryLoading ? "loading" : ""}" data-action="${profile.running ? "focus-profile" : "launch"}" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(subPrimaryLoading, profile.running ? "显示" : "启动", subPrimaryLabel)}
          </button>
        </span>
        ${renderProfileDetailsButton(profile.id)}
        <span class="menu-anchor profile-menu-action relative inline-flex">
          <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-label="更多" title="更多" aria-expanded="${subMenuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>⋮</button>
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
  const takeoverButton = renderAgentTakeoverButton(profile);

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
  const baseIdle = running ? "显示" : "启动";
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

  const hasTakeoverAction = Boolean(takeoverButton);
  const baseActionClass = hasTakeoverAction ? "profile-window-action" : "profile-primary-action";
  const baseVisualLabel = hasTakeoverAction ? "↗" : baseIdle;
  const baseLoadingLabel = hasTakeoverAction ? "" : primaryLoadingLabel;

  return `
    <div class="profile-actions" data-profile-actions>
      ${takeoverButton}
      ${renderProfileDetailsButton(profile.id)}
      <span class="action-tooltip ${baseActionClass}" data-tooltip="${escapeHtml(baseTip)}">
        <button type="button" class="action-button accent ${hasTakeoverAction ? "icon-action" : ""} ${primaryLoading ? "loading" : ""}" data-action="${baseAction}" data-id="${profile.id}" aria-label="${escapeHtml(baseIdle)}" ${store.busy ? "disabled" : ""}>
          ${renderButtonLabel(primaryLoading, baseVisualLabel, baseLoadingLabel)}
        </button>
      </span>
      <span class="menu-anchor profile-menu-action relative inline-flex">
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-label="更多" title="更多" aria-expanded="${menuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>⋮</button>
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

function renderProfileDetailsButton(profileId: string): string {
  return `
    <span class="action-tooltip profile-details-action" data-tooltip="查看连接信息、标签页与实时画面">
      <button type="button" class="action-button details-action" data-action="open-profile-details" data-id="${escapeHtml(profileId)}" aria-label="查看详情" ${store.busy ? "disabled" : ""}>详情</button>
    </span>
  `;
}

function renderAgentTakeoverButton(profile: PublicProfile): string {
  if (gatewayUserHasControl(profile)) {
    return `
      <span class="action-tooltip profile-primary-action" data-tooltip="浏览器控制权当前属于你，可在浏览器控制框中交还 Agent">
        <button type="button" class="action-button warn takeover-action" disabled>✓ 已接管</button>
      </span>
    `;
  }
  if (!profileAgentControlClients(profile).length) {
    return "";
  }
  const takingOver = isBusyAction("agent-takeover", { profileId: profile.id });
  return `
    <span class="action-tooltip profile-primary-action" data-tooltip="暂停 AI 操作，接管浏览器">
      <button type="button" class="action-button warn takeover-action ${takingOver ? "loading" : ""}" data-action="takeover-agent" data-id="${escapeHtml(profile.id)}" ${store.busy ? "disabled" : ""}>
        ${renderButtonLabel(takingOver, "接管", "接管中…")}
      </button>
    </span>
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

function externalConnectionModel(instance: ExternalChromeInstance): ConnectionActivityModel {
  return {
    cdpClients: instance.cdpClients || [],
    agentActivity: instance.agentActivity ?? null
  };
}

function renderExternalConnectionCell(instance: ExternalChromeInstance): string {
  const model = externalConnectionModel(instance);
  const portChip = instance.cdpUrl
    ? cdpChip("live", cdpPortLabel(instance.cdpUrl), instance.cdpUrl, null)
    : instance.cdpPort
      ? cdpChip("stale", `:${instance.cdpPort}`, `http://127.0.0.1:${instance.cdpPort}`, "未响应")
      : cdpChip("off", "未开启", null, null);
  const connection = model.cdpClients.length
    ? `${renderExternalConnPill(instance)}${renderAgentActivityInline(model)}`
    : instance.cdpUrl
      ? '<span class="conn-idle">空闲</span>'
      : '<span class="conn-pill none action-tooltip" data-tooltip="外部实例未检测到可用 CDP 驱动连接">—</span>';
  const primary = model.cdpClients[0];
  const sessionText = primary ? cdpSessionText(primary) : "";
  const age = primary ? formatRelativeTime(primary.lastActive) : "";
  const subLine =
    sessionText || age
      ? `<span class="conn-session"><span class="conn-session-main">${escapeHtml(sessionText)}</span>${
          age ? `<span class="conn-session-age">${escapeHtml(age)}</span>` : ""
        }</span>`
      : "";

  return `<span class="conn-cell-stack"><span class="conn-line">${portChip}${connection}</span>${subLine}</span>`;
}

function renderExternalPortCell(instance: ExternalChromeInstance): string {
  if (instance.cdpUrl) {
    return cdpChip("live", cdpPortLabel(instance.cdpUrl), instance.cdpUrl, null);
  }
  if (instance.cdpPort) {
    return cdpChip("stale", `:${instance.cdpPort}`, `http://127.0.0.1:${instance.cdpPort}`, "未响应");
  }
  return cdpChip("off", "未开启", null, null);
}

function renderExternalActivityCell(instance: ExternalChromeInstance): string {
  const model = externalConnectionModel(instance);
  const primary = model.cdpClients[0];
  if (!primary) {
    return `<span class="profile-activity-empty">${instance.cdpUrl ? "空闲" : "—"}</span>`;
  }
  const tool = primary.agent || prettyCdpClientLabel(primary.label);
  const extra = model.cdpClients.length > 1 ? ` ×${model.cdpClients.length}` : "";
  const tooltip = agentActivityTooltipText(model.agentActivity) || primary.note || `${tool} 正在驱动`;
  return renderProfileActivityTrack(
    `${tool}${extra} 正在驱动`,
    primary.project || primary.title || primary.session || "",
    formatRelativeTime(primary.lastActive),
    tooltip,
    "driving"
  );
}

function renderExternalConnPill(instance: ExternalChromeInstance): string {
  const model = externalConnectionModel(instance);
  const clients = model.cdpClients;
  const primary = clients[0];
  if (!primary) {
    return '<span class="conn-pill none action-tooltip" data-tooltip="当前没有工具连接">—</span>';
  }

  const tool = primary.agent || prettyCdpClientLabel(primary.label);
  const extra = clients.length > 1 ? ` ×${clients.length}` : "";
  const age = formatRelativeTime(primary.lastActive);
  const activityRows = renderAgentActivityTipRows(model);
  const body =
    clients.length > 1
      ? `${renderConnTipTable(clients)}${activityRows}`
      : [
          `<span class="tip-row"><em class="tip-tag">工具</em><span class="tip-tool">${escapeHtml(tool)}</span></span>`,
          primary.session ? `<span class="tip-row"><em class="tip-tag">会话</em><span class="tip-project">${escapeHtml(primary.session)}</span></span>` : "",
          primary.project ? `<span class="tip-row"><em class="tip-tag">项目</em><span class="tip-project">${escapeHtml(primary.project)}</span></span>` : "",
          primary.title ? `<span class="tip-row"><em class="tip-tag">标题</em><span class="tip-session">${escapeHtml(primary.title)}</span></span>` : "",
          age ? `<span class="tip-row"><em class="tip-tag">活动</em><span class="tip-age">${escapeHtml(age)}</span></span>` : "",
          primary.note ? `<span class="tip-row"><em class="tip-tag">说明</em><span class="tip-note">${escapeHtml(primary.note)}</span></span>` : "",
          activityRows
        ]
          .filter(Boolean)
          .join("");
  return `<span class="conn-pill attached"><span class="conn-dot" aria-hidden="true"></span><span class="conn-label">${escapeHtml(`${tool}${extra}`)}</span><span class="conn-tip-card ${clients.length > 1 ? "wide" : ""}" role="tooltip">${body}</span></span>`;
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
        ${renderExternalPortCell(instance)}
      </td>
      <td>
        ${renderExternalActivityCell(instance)}
      </td>
      <td>
        <div class="profile-actions external-profile-actions">
          ${
            instance.headless
              ? ""
              : `<span class="action-tooltip profile-primary-action" data-tooltip="把这个窗口显示到最前面">
            <button type="button" class="action-button accent ${focusing ? "loading" : ""}" data-action="focus-external" data-dir="${escapeHtml(instance.userDataDir)}" ${store.busy ? "disabled" : ""}>
              ${renderButtonLabel(focusing, "显示", "显示中…")}
            </button>
          </span>`
          }
          <span class="action-tooltip profile-details-action" data-tooltip="查看外部实例连接信息">
            <button type="button" class="action-button details-action" data-action="open-external-details" data-dir="${escapeHtml(instance.userDataDir)}" aria-label="查看详情" ${store.busy ? "disabled" : ""}>详情</button>
          </span>
          <span class="action-tooltip profile-window-action" data-tooltip="结束这个外部实例进程">
            <button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-external" data-dir="${escapeHtml(instance.userDataDir)}" ${store.busy ? "disabled" : ""}>
              ${renderButtonLabel(closing, "关闭", "关闭中…")}
            </button>
          </span>
        </div>
      </td>
    </tr>
  `;
}

function renderExternalCdpClientsDetail(instance: ExternalChromeInstance): string {
  if (!instance.cdpUrl) {
    return "";
  }

  const model = externalConnectionModel(instance);
  const clients = model.cdpClients;
  const attached = clients.length > 0;
  const value = attached ? `驱动中 · ${cdpClientToolSummary(clients)}` : "当前没有工具连接";
  const activityDetailCard = renderAgentActivityDetailCard(model);
  const sessionRows = clients
    .map((client, index) => {
      const tool = client.agent || prettyCdpClientLabel(client.label);
      const sessionText = cdpSessionText(client);
      const sessionAge = formatRelativeTime(client.lastActive);
      const main = [tool, sessionText].filter(Boolean).join(" · ");
      if (!main && !sessionAge && !client.note) {
        return index === 0 ? activityDetailCard : "";
      }
      return `<small class="detail-session"${client.note ? ` title="${escapeHtml(client.note)}"` : ""}>⇁ ${escapeHtml(main)}${
        sessionAge ? `<span class="detail-session-age">${escapeHtml(sessionAge)}</span>` : ""
      }${client.note && !sessionText ? `<span class="detail-session-note">${escapeHtml(client.note)}</span>` : ""}</small>${index === 0 ? activityDetailCard : ""}`;
    })
    .join("");

  return `
    <div class="detail-row${attached ? " detail-row-attached" : ""}">
      <span>Agent 连接</span>
      <strong>${escapeHtml(value)}</strong>
      ${sessionRows}
      <small class="detail-note">检测连到此外部实例 CDP 端口的持久连接；外部实例不由 ProfilePilot 管理，仅展示归属与活动。</small>
    </div>
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
        ${renderExternalCdpClientsDetail(instance)}
        <div class="detail-row">
          <span>数据目录</span>
          <code class="path-box">${escapeHtml(instance.userDataDir)}</code>
        </div>
      </div>
    </aside>
  `;
}

export function renderDetails(profile: PublicProfile | null, includeLiveView = true): string {
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
      ${includeLiveView ? renderLiveViewSection(profile) : ""}
    </aside>
  `;
}

export function renderProfileDetailsModal(profile: PublicProfile | null): string {
  if (!profile) {
    return "";
  }
  const liveView = renderLiveViewSection(profile);
  const liveEmpty = profile.source === "native"
    ? "系统 Profile 不支持端口式实时画面。"
    : !profile.running
      ? "启动这个 Profile 后，可在这里查看标签页与实时画面。"
      : "通过 CDP 启动后，可在这里查看标签页与实时画面。";
  return `
    <div class="modal-backdrop profile-details-backdrop" data-action="close-modal">
      <section class="profile-details-modal" role="dialog" aria-modal="true" aria-labelledby="profile-details-title">
        <header class="profile-details-modal-head">
          <div>
            <span>Profile Inspector</span>
            <h2 id="profile-details-title">${escapeHtml(profile.name)}</h2>
          </div>
          <button type="button" data-action="close-modal" data-profile-details-close>关闭</button>
        </header>
        <div class="profile-details-modal-body">
          <div class="profile-details-summary">${renderDetails(profile, false)}</div>
          <section class="profile-details-cockpit" aria-label="实时画面">
            ${liveView || `<div class="profile-details-live-empty"><span>Cockpit</span><strong>暂不可观测</strong><p>${escapeHtml(liveEmpty)}</p></div>`}
          </section>
        </div>
      </section>
    </div>
  `;
}

export function renderExternalDetailsModal(instance: ExternalChromeInstance | null): string {
  if (!instance) {
    return "";
  }
  return `
    <div class="modal-backdrop profile-details-backdrop" data-action="close-modal">
      <section class="profile-details-modal external-details-modal" role="dialog" aria-modal="true" aria-labelledby="external-details-title">
        <header class="profile-details-modal-head">
          <div>
            <span>External Inspector</span>
            <h2 id="external-details-title">${escapeHtml(instance.label)}</h2>
          </div>
          <button type="button" data-action="close-modal" data-profile-details-close>关闭</button>
        </header>
        <div class="profile-details-modal-body single">
          <div class="profile-details-summary">${renderExternalDetails(instance)}</div>
        </div>
      </section>
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

  return cdpRow + renderCdpClientsDetail(profile);
}

// 显示当前正持久连接该 CDP 端口的驱动工具（agent-browser / Playwright / DevTools 等）。
export function renderCdpClientsDetail(profile: PublicProfile): string {
  if (!profile.cdpUrl) {
    return "";
  }

  const occupancyClient = agentBrowserOccupancyClient(profile);
  const reserved = profileAgentBrowserReserved(profile);
  const attached = profile.cdpClients.length > 0;
  const displayClients = attached ? profile.cdpClients : occupancyClient ? [occupancyClient] : [];
  // 汇总行不带 pid（进程细节对用户没信息量）；断连按钮在同名多连接时才用 pid 区分。
  const value = profileUserHasControl(profile)
    ? profile.gatewayControl?.pendingUserAction
      ? `等待用户操作：${profile.gatewayControl.pendingUserAction} · Agent Session 保留`
      : "用户已接管 · Agent Session 保留"
    : reserved && !attached
      ? "Agent 已绑定 · 当前没有活动连接"
      : attached
        ? `驱动中 · ${cdpClientToolSummary(profile.cdpClients)}`
        : "当前没有工具连接";

  // 判定有争用时的警示横幅：说明谁在抢 + 建议分流到副本。
  const warning = contentionNotice(profile);
  const warningRow = warning ? `<small class="detail-contention">${escapeHtml(warning)}</small>` : "";

  // 每条连接一行会话身份：工具 · 项目·标题 + 最近活动时间（区分活会话与残留连接）。
  // 多会话共用一个 Profile 正是争用问题的现场，必须每条都平铺出来，不能只显示第一条。
  const activityDetailCard = renderAgentActivityDetailCard(profile);
  const sessionRows = displayClients
    .map((client, index) => {
      const tool = client.agent || prettyCdpClientLabel(client.label);
      const sessionText = cdpSessionText(client);
      const sessionAge = formatRelativeTime(client.lastActive);
      const main = [tool, sessionText].filter(Boolean).join(" · ");
      if (!main && !sessionAge && !client.note) {
        return index === 0 ? activityDetailCard : "";
      }
      // 归属说明（共享 daemon 推测/归属未知）hover 可见，正文行保持紧凑。
      return `<small class="detail-session"${client.note ? ` title="${escapeHtml(client.note)}"` : ""}>⇁ ${escapeHtml(main)}${
        sessionAge ? `<span class="detail-session-age">${escapeHtml(sessionAge)}</span>` : ""
      }${client.note && !sessionText ? `<span class="detail-session-note">${escapeHtml(client.note)}</span>` : ""}</small>${index === 0 ? activityDetailCard : ""}`;
    })
    .join("");

  // 每条连接给一个「结束连接」按钮：对该客户端进程发信号断开，不动 Chrome。
  // 同名工具（如两个 Claude Code 会话）多连接时补 pid 区分，避免不知道结束的是哪一条。
  const disconnecting = isBusyAction("disconnect-client", { profileId: profile.id });
  const takeoverButton = renderAgentTakeoverButton(profile);
  const toolCounts = new Map<string, number>();
  profile.cdpClients.forEach((client) => {
    const tool = client.agent || prettyCdpClientLabel(client.label);
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  });
  const disconnectRow = attached && !gatewayUserHasControl(profile)
    ? `<div class="detail-session-actions">${takeoverButton}${profile.cdpClients
        .map((client) => {
          const tool = client.agent || prettyCdpClientLabel(client.label);
          const name = (toolCounts.get(tool) || 0) > 1 ? `${tool}(${client.pid})` : tool;
          return `<button type="button" class="action-button warn ${disconnecting ? "loading" : ""}" data-action="disconnect-client" data-id="${escapeHtml(profile.id)}" data-pid="${client.pid}" ${store.busy ? "disabled" : ""} title="结束这条驱动连接，不影响 Chrome">结束 ${escapeHtml(name)} 连接</button>`;
        })
        .join("")}</div>`
    : "";

  return `
    <div class="detail-row${attached || reserved ? " detail-row-attached" : ""}">
      <span>Agent 连接</span>
      <strong>${escapeHtml(value)}</strong>
      ${warningRow}
      ${sessionRows}
      ${disconnectRow}
      ${renderAgentOverlaySettingRow()}
      ${renderShellIntegrationRow(profile)}
      <small class="detail-note">列出连到 CDP 端口的工具连接。“驱动中”表示有工具在控制；每行显示驱动方与最近活动。ProfilePilot 会统一管理 agent-browser、Playwright CLI 和 Chrome DevTools MCP 的接管、交还与结束（不影响 Chrome）。</small>
    </div>
  `;
}

function renderAgentActivityDetailCard(profile: ConnectionActivityModel): string {
  if (!hasConnectionAgentActivity(profile) || !profile.agentActivity) {
    return "";
  }
  const activity = profile.agentActivity;
  const progress = agentActivityProgressText(activity);
  const stepSummary = activityValue(activity.currentStep) || agentActivityLeadText(activity) || "正在操作";
  const action = activityValue(activity.currentAction);
  const nextStep = activityValue(activity.nextStep);
  const lastMessage = activityValue(activity.lastMessage);
  const updated = formatRelativeTime(activity.updatedAt);
  return `
    <div class="agent-activity-card">
      <div class="agent-activity-head">
        <span>AI 活动</span>
        ${updated ? `<em>${escapeHtml(updated)}</em>` : ""}
      </div>
      <div class="agent-activity-progress">
        ${progress ? `<strong>${escapeHtml(progress)}</strong>` : ""}
        <span>${escapeHtml(stepSummary)}</span>
      </div>
      ${nextStep ? `<small><em>下一步</em><span>${escapeHtml(nextStep)}</span></small>` : ""}
      ${action ? `<small><em>最近动作</em><span>${escapeHtml(action)}</span></small>` : ""}
      ${lastMessage ? `<small><em>AI 最近说</em><span>${escapeHtml(truncateText(lastMessage, 120))}</span></small>` : ""}
    </div>
  `;
}

function renderAgentOverlaySettingRow(): string {
  const enabled = store.state?.agentOverlayEnabled !== false;
  const busy = isBusyAction("agent-overlay");
  return `
    <div class="agent-overlay-setting">
      <small class="detail-note">AI 驱动页面时显示操作状态条，可在页面内停止 AI。当前已${enabled ? "开启" : "关闭"}。</small>
      <button type="button" class="overlay-switch ${enabled ? "on" : ""} ${busy ? "loading" : ""}" data-action="toggle-agent-overlay" aria-pressed="${enabled ? "true" : "false"}" ${store.busy ? "disabled" : ""}>
        <span class="overlay-switch-track"><span class="overlay-switch-thumb"></span></span>
        <span>${enabled ? "已开启" : "已关闭"}</span>
      </button>
    </div>
  `;
}

// 会话识别 shell 集成的引导/状态行。只在“有受管浏览器驱动”时出现——
// 这正是归属能力有无差别的现场；没有相关连接时不打扰。
function renderShellIntegrationRow(profile: PublicProfile): string {
  const status = store.state?.shellIntegration;
  if (!status?.supported) {
    return "";
  }
  const hasManagedDriver = profile.cdpClients.some((client) => {
    const label = client.label.toLowerCase();
    return Boolean(
      client.driverKind ||
        label.startsWith("agent-browser") ||
        label.startsWith("playwright") ||
        label.includes("chrome devtools mcp")
    );
  });
  if (!hasManagedDriver) {
    return "";
  }

  const busy = isBusyAction("shell-integration");
  if (!status.installed) {
    return `
      <small class="detail-note">启用「会话识别」后，agent-browser、Playwright CLI 和 Chrome DevTools MCP 都会携带统一的 AI 会话身份（往 ${escapeHtml(status.path)} 写一段可移除的配置，对新开会话生效）。</small>
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
