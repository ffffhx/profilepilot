import { isBusyAction } from "../busy";
import { proxyServerUsesPort } from "../proxy";
import { store } from "../state";
import { AgentActivity, BifrostRuleDestination, BifrostSnapshot, CdpClientInfo, ExternalChromeInstance, ProfileReadinessReceipt, PublicProfile, SystemProxyRoute } from "../types";
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
          <col class="profile-col-route" />
          <col class="profile-col-connection" />
          <col class="profile-col-activity" />
          <col class="profile-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>Profile</th>
            <th>Status</th>
            <th>Proxy Route</th>
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
  const agentSettingsSaving = isBusyAction("save-agent-settings", { profileId: profile.id });
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
            <span class="profile-name-badges">
              ${
                profile.source === "isolated"
                  ? `<button type="button" class="agent-access-toggle ${profile.agentAccessDisabled ? "blocked" : "allowed"} ${agentSettingsSaving ? "loading" : ""}" data-action="toggle-agent-access" data-id="${profile.id}" aria-pressed="${profile.agentAccessDisabled ? "true" : "false"}" aria-label="${profile.agentAccessDisabled ? `允许 Agent 连接 ${escapeHtml(profile.name)}` : `禁止 Agent 连接 ${escapeHtml(profile.name)}`}" title="${profile.agentAccessDisabled ? "当前禁止 Agent 连接；点击允许" : "当前允许 Agent 连接；点击禁止"}" ${store.busy ? "disabled" : ""}>
                      ${renderButtonLabel(agentSettingsSaving, profile.agentAccessDisabled ? "NO AGENT" : "AGENT ON", "…")}
                    </button>`
                  : ""
              }
              ${profile.isDefault ? '<span class="native-badge inline-flex items-center justify-center border-solid border border-warn-line rounded-full px-2 py-[3px] bg-warn-soft text-warn-bright font-mono text-[10px] font-semibold tracking-[0.06em]">DEFAULT</span>' : ""}
              ${profile.quickLaunchSlot ? `<span class="slot-badge" title="全局快捷键 ⌘⌥${profile.quickLaunchSlot} 直启">⌘⌥${profile.quickLaunchSlot}</span>` : ""}
            </span>
          </span>
        </div>
      </td>
      <td>
        <span class="state-pill inline-flex items-center justify-center min-w-[58px] border-solid border border-line-strong rounded-full px-[9px] py-1 bg-transparent text-muted font-mono text-[11px] font-semibold tracking-[0.06em] ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td>
        ${renderProfileProxyRoute(profile)}
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
        : control.driverState === "reconnecting"
          ? "浏览器驱动重连中"
          : control.driverState === "connecting"
            ? "浏览器驱动连接中"
            : control.driverState === "disconnected" ? "Agent 已离线" : "Agent 已绑定";
      const tooltip = control.ownership === "user"
        ? control.pendingUserAction
          ? `等待用户完成：${control.pendingUserAction}；Agent Session 仍保留`
          : "浏览器控制权属于用户；Agent Session 仍保留，等待交还"
        : control.driverState === "reconnecting"
          ? `Gateway 仍保留 Agent Session，正在等待驱动重连${Number.isInteger(control.reconnectAttempt) ? `（${control.reconnectAttempt}/3）` : ""}`
          : control.driverState === "connecting"
            ? "Gateway 已保留 Agent Session，正在建立驱动连接"
            : control.driverState === "disconnected"
              ? "驱动连接已断开；可释放 Profile 后启动新 Session"
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
    const stoppedUserSession = !profile.running && occupancy.ownership === "user";
    const label = stoppedUserSession ? "Session 残留" : occupancy.ownership === "user" ? "用户已接管" : "Agent 已绑定";
    const tooltip = stoppedUserSession
      ? "Profile 未运行，当前不存在可由用户接管的浏览器；这是待回收的残留 Session"
      : occupancy.ownership === "user"
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

  if (profile.agentAccessDisabled) {
    return '<span class="profile-activity-empty agent-disabled">Agent 已禁用</span>';
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
  const stoppedUserSession = !profile.running && occupancy.ownership === "user";
  const label = stoppedUserSession ? "Session 残留" : occupancy.ownership === "user" ? "用户已接管" : "Agent 已绑定";
  const tip = stoppedUserSession
    ? "Profile 未运行，当前不存在可由用户接管的浏览器；这是待回收的残留 Session"
    : occupancy.ownership === "user"
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
    : control.driverState === "reconnecting"
      ? "浏览器驱动重连中"
      : control.driverState === "connecting"
        ? "浏览器驱动连接中"
        : control.driverState === "disconnected" ? "Agent 已离线" : "Agent 已绑定";
  const tip = control.ownership === "user"
    ? control.pendingUserAction
      ? `等待用户完成：${control.pendingUserAction}；Agent Session 仍保留`
      : "浏览器控制权属于用户；Agent Session 仍保留，等待交还"
    : control.driverState === "reconnecting"
      ? `Gateway 仍保留 Agent Session，正在等待驱动重连${Number.isInteger(control.reconnectAttempt) ? `（${control.reconnectAttempt}/3）` : ""}`
      : control.driverState === "connecting"
        ? "Gateway 已保留 Agent Session，正在建立驱动连接"
        : control.driverState === "disconnected"
          ? "驱动连接已断开；可释放 Profile 后启动新 Session"
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
  // 主操作只给「显示/启动」；详情与删除收进「更多」菜单。
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
        <span class="menu-anchor profile-menu-action relative inline-flex">
          <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-label="更多" title="更多" aria-expanded="${subMenuOpen ? "true" : "false"}" ${store.busy ? "disabled" : ""}>⋮</button>
          ${
            subMenuOpen
              ? `
                <div class="action-menu absolute top-[calc(100%+6px)] right-0 z-40 grid w-40 overflow-visible border-solid border border-line-strong rounded-lg bg-panel-raise [box-shadow:var(--shadow)] p-[5px]" role="menu">
                  ${renderProfileDetailsMenuItem(profile.id)}
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
  const bifrostSaving = isBusyAction("save-bifrost-proxy", { profileId: profile.id });
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
              ${renderProfileDetailsMenuItem(profile.id)}
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
              ${
                profile.source === "isolated"
                  ? `<button type="button" class="${profile.bifrostProxy || profile.upstreamProxy || profile.directConnection ? "menu-info" : ""} ${bifrostSaving ? "loading" : ""}" data-action="configure-bifrost-proxy" data-id="${profile.id}" ${store.busy ? "disabled" : ""}>
                      ${renderButtonLabel(bifrostSaving, proxyMenuLabel(profile), "保存中…")}
                    </button>`
                  : ""
              }
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

function renderProfileDetailsMenuItem(profileId: string): string {
  return `<button type="button" data-action="open-profile-details" data-id="${escapeHtml(profileId)}" title="查看连接信息、标签页与实时画面" ${store.busy ? "disabled" : ""}>查看详情</button>`;
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
      <td colspan="6">
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
        <span class="profile-route-track external action-tooltip" data-tooltip="外部实例不由 ProfilePilot 管理，无法判断它使用的代理规则" aria-label="外部实例不由 ProfilePilot 管理，无法判断它使用的代理规则" tabindex="0">
          <span class="profile-route-signal" aria-hidden="true"></span>
          <span class="profile-route-copy">
            <strong>外部管理</strong>
            <small>代理规则未知</small>
          </span>
        </span>
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
        <div class="detail-row">
          <span>窗口前台</span>
          <strong>${escapeHtml(windowActivationLabel(profile.windowActivation))}</strong>
          <small class="detail-note">窗口前台状态与 Agent/User 逻辑控制权分开计算；后台自动化不会因此抢焦点。</small>
        </div>
        ${
          profile.source === "isolated"
            ? `<div class="detail-row ${profile.agentAccessDisabled ? "detail-row-agent-blocked" : ""}">
                <span>Agent 访问</span>
                <strong>${profile.agentAccessDisabled ? "禁止连接" : "允许连接"}</strong>
                <small class="detail-note">${profile.agentAccessDisabled ? "Gateway 会拒绝所有 Agent 连接；手动使用不受影响。" : "Agent 可通过 ProfilePilot Gateway 连接。"}</small>
              </div>
              <div class="detail-row">
                <span>AI 选择提示</span>
                <strong>${escapeHtml(profile.name)}</strong>
                <small class="detail-note">Profile 名称会直接提供给 AI，用来匹配当前任务。</small>
              </div>`
            : ""
        }
        ${renderListeningPortsDetail(profile)}
        ${renderConnectionDetail(profile)}
        ${renderBifrostProxyDetail(profile)}
      </div>
      ${includeLiveView ? renderLiveViewSection(profile) : ""}
    </aside>
  `;
}

export type BifrostRouteState = "ok" | "stale" | "down" | "unknown";

// 分流入口三态：ok=Bifrost 在跑且端口绑定归属本 Profile；stale=在跑但端口未绑或归属不符
// （启动 Profile 时会自动重绑）；down=Bifrost 未运行/未安装；unknown=还没拿到快照。
export function bifrostRouteState(profile: PublicProfile, snapshot: BifrostSnapshot | null | undefined): BifrostRouteState {
  const config = profile.bifrostProxy;
  if (!config || !snapshot) {
    return "unknown";
  }
  if (!snapshot.installed || !snapshot.running) {
    return "down";
  }
  const binding = snapshot.ports.find((entry) => entry.port === config.listenerPort);
  if (!binding) {
    return "stale";
  }
  // 绑定名用的是注册表里的原始 id；PublicProfile.id 带 isolated: 前缀，需要剥掉再比对。
  const rawId = profile.id.startsWith("isolated:") ? profile.id.slice("isolated:".length) : profile.id;
  return binding.name === `profilepilot:${rawId}` ? "ok" : "stale";
}

export function bifrostRouteStateTitle(profile: PublicProfile, state: BifrostRouteState): string {
  const addr = `127.0.0.1:${profile.bifrostProxy?.listenerPort}`;
  if (state === "ok") {
    return `Bifrost 独立分流生效中 · ${addr}`;
  }
  if (state === "stale") {
    return `Bifrost 在运行，但 ${addr} 未绑定到此 Profile；启动时会自动重绑`;
  }
  if (state === "down") {
    return "Bifrost 未运行或未安装；带分流启动会失败，可在提示里选择本次直连启动";
  }
  return `Bifrost 独立分流 · ${addr}`;
}

function bifrostRouteStateLabel(state: BifrostRouteState): string {
  if (state === "ok") return "独立分流生效中";
  if (state === "stale") return "等待端口重绑";
  if (state === "down") return "服务不可用";
  return "正在读取状态";
}

function renderBifrostRouteMapping(detail: string): string {
  const [source, ...targetParts] = detail.split(" → ");
  if (!targetParts.length) {
    return `<span class="route-tip-mapping-text">${escapeHtml(detail)}</span>`;
  }
  const roleMatch = source.match(/^(前端|后端)(?:（(.+)）)? · (.+)$/);
  const scope = roleMatch?.[2] || "";
  const sourceLabel = roleMatch?.[3] || source;
  const target = targetParts.join(" → ");
  const headerMatch = target.match(/^(x-tt-env(?:-fe)?) · (.+)$/i);
  const headerKey = headerMatch?.[1] || "";
  // 旧规则的映射描述没有显式角色，但 x-tt-env-fe 已经明确代表前端泳道。
  // 在展示层补齐“前端”，避免要求用户重建已有 Bifrost 规则。
  const role = roleMatch?.[1] || (headerKey.toLowerCase() === "x-tt-env-fe" ? "前端" : "");
  const targetLabel = headerMatch?.[2] || target;
  const targetKind = targetLabel.startsWith("localhost")
    ? "local"
    : targetLabel.startsWith("PPE")
      ? "ppe"
      : targetLabel.startsWith("BOE")
        ? "boe"
        : "other";
  return `
    ${role ? `<span class="route-tip-role ${role === "前端" ? "frontend" : "backend"}">${role}</span>` : ""}
    ${scope ? `<span class="route-tip-scope">${escapeHtml(scope)}</span>` : ""}
    <span class="route-tip-mapping-text route-tip-mapping-source">${escapeHtml(sourceLabel)}</span>
    <span class="route-tip-mapping-arrow" aria-hidden="true">→</span>
    ${headerKey ? `<code class="route-tip-header-key">${escapeHtml(headerKey)}</code>` : ""}
    <span class="route-tip-mapping-text route-tip-mapping-target target-${targetKind}">${escapeHtml(targetLabel)}</span>
  `;
}

// Profile 专属网络路径的「更多」菜单文案。
export function proxyMenuLabel(profile: PublicProfile): string {
  if (profile.bifrostProxy) {
    return `代理分流 · Bifrost :${profile.bifrostProxy.listenerPort}`;
  }
  if (profile.upstreamProxy) {
    const port = profile.upstreamProxy.server.match(/:(\d{2,5})(?:\D|$)/)?.[1];
    const kind = upstreamProxyKind(profile.upstreamProxy.server, store.bifrostSnapshot);
    const provider = kind === "bifrost" ? "Bifrost" : kind === "clash" ? "Clash Verge" : "指定代理";
    return `代理分流 · ${provider}${port ? ` :${port}` : ""}`;
  }
  if (profile.directConnection) {
    return "代理分流 · 直接联网";
  }
  return "代理分流";
}

type ProxyProviderKind = "bifrost" | "clash" | "custom";

interface BifrostMainRuleDisplay {
  label: string;
  mainRules: NonNullable<BifrostSnapshot["mainRules"]>;
  mainDestination: BifrostRuleDestination | null;
}

interface SystemProxyDisplay {
  label: string;
  tone: "system-proxy-active" | "system-proxy-direct" | "system-proxy-unknown";
  routes: SystemProxyRoute[];
  providerKind: Exclude<ProxyProviderKind, "custom"> | null;
  providerLabel: string | null;
  mainRules: NonNullable<BifrostSnapshot["mainRules"]>;
  mainDestination: BifrostRuleDestination | null;
}

function systemProxyPrimaryRoutes(snapshot: BifrostSnapshot | null | undefined): SystemProxyRoute[] {
  const routes = snapshot?.systemProxy?.routes || [];
  return (["https", "http"] as const)
    .map((protocol) => routes.find((route) => route.protocol === protocol))
    .filter((route): route is SystemProxyRoute => Boolean(route));
}

function systemProxyKindLabel(kind: SystemProxyRoute["kind"]): string {
  if (kind === "direct") return "DIRECT";
  if (kind === "http") return "HTTP";
  if (kind === "https") return "HTTPS";
  if (kind === "socks4") return "SOCKS4";
  if (kind === "socks5") return "SOCKS5";
  if (kind === "quic") return "QUIC";
  return "代理";
}

function renderSystemRuleDestination(label: string): string {
  return label.split(" + ").map((part) => {
    const kind = part.startsWith("本地")
      ? "local"
      : part.startsWith("PPE")
        ? "ppe"
        : part.startsWith("BOE")
          ? "boe"
          : "other";
    return `<span class="system-rule-destination ${kind}">${escapeHtml(part)}</span>`;
  }).join('<span class="system-rule-separator">+</span>');
}

function bifrostMainRuleDisplay(snapshot: BifrostSnapshot | null | undefined): BifrostMainRuleDisplay {
  const mainRules = snapshot?.mainRules || [];
  const mainDestination = snapshot?.mainRuleDestination || null;
  return {
    label: mainDestination
      ? `启用规则 · ${mainDestination.label}`
      : mainRules.length
        ? `${mainRules.length} 份规则启用 · 按域名与路径匹配`
        : snapshot?.running
          ? "无启用规则 · 未命中直连"
          : "规则状态不可用",
    mainRules,
    mainDestination
  };
}

function systemProxyDisplay(snapshot: BifrostSnapshot | null | undefined): SystemProxyDisplay {
  const systemProxy = snapshot?.systemProxy;
  const routes = systemProxyPrimaryRoutes(snapshot);
  if (!systemProxy) {
    return {
      label: "正在读取系统代理…",
      tone: "system-proxy-unknown",
      routes,
      providerKind: null,
      providerLabel: null,
      mainRules: [],
      mainDestination: null
    };
  }
  if (systemProxy.mode === "direct") {
    return {
      label: "未启用 · DIRECT",
      tone: "system-proxy-direct",
      routes,
      providerKind: null,
      providerLabel: null,
      mainRules: [],
      mainDestination: null
    };
  }
  const primary = routes.find((route) => route.kind !== "direct" && route.endpoint);
  if (!primary?.endpoint) {
    return {
      label: "状态未知",
      tone: "system-proxy-unknown",
      routes,
      providerKind: null,
      providerLabel: null,
      mainRules: [],
      mainDestination: null
    };
  }
  const port = Number(primary.endpoint.match(/:(\d{1,5})$/)?.[1]);
  const loopback = /^(?:127\.0\.0\.1|localhost|\[?::1\]?):/i.test(primary.endpoint);
  const isBifrost = Boolean(loopback && port === (snapshot?.mainPort || 9900));
  const isClash = Boolean(loopback && port === 7897);
  // Bifrost 的主规则只描述它自己的主监听端口。系统代理指向 Clash 等其他
  // 入口时，展示这些规则会把两条互不相干的链路错误拼接在一起。
  const mainRuleDisplay = isBifrost ? bifrostMainRuleDisplay(snapshot) : null;
  const mainRules = mainRuleDisplay?.mainRules || [];
  const mainDestination = mainRuleDisplay?.mainDestination || null;
  const endpoint = loopback && port ? `:${port}` : primary.endpoint;
  return {
    label: isBifrost
      ? mainRuleDisplay?.label || "规则状态不可用"
      : isClash
        ? "规则由 Clash 决定"
        : `${systemProxyKindLabel(primary.kind)} · ${endpoint}`,
    tone: "system-proxy-active",
    routes,
    providerKind: isBifrost ? "bifrost" : isClash ? "clash" : null,
    providerLabel: isBifrost ? `Bifrost ${endpoint}` : isClash ? `Clash Verge ${endpoint}` : null,
    mainRules,
    mainDestination
  };
}

function renderSystemProxyTooltip(
  display: SystemProxyDisplay,
  modeNote = "此 Profile 未配置独立分流"
): string {
  const rows = display.routes.map((route) => `
    <span class="route-tip-row system-proxy-tip-route">
      <span class="route-tip-tag">${route.protocol.toUpperCase()}</span>
      <span class="route-tip-value">
        <span class="system-proxy-tip-kind">${systemProxyKindLabel(route.kind)}</span>
        ${route.endpoint ? `
          <span class="route-tip-mapping-arrow" aria-hidden="true">→</span>
          <span class="route-tip-mapping-target">${escapeHtml(route.endpoint)}</span>
        ` : ""}
      </span>
    </span>
  `).join("");
  const mappingRows = (display.mainDestination?.details || []).slice(0, 6).map((detail) => `
    <span class="route-tip-row route-tip-mapping">
      <span class="route-tip-tag">映射</span>
      <span class="route-tip-value">${renderBifrostRouteMapping(detail)}</span>
    </span>
  `).join("");
  const hiddenMappingCount = Math.max(0, (display.mainDestination?.details.length || 0) - 6);
  const ruleItems = display.mainRules.map((rule) => `
    <span class="system-proxy-rule-item">
      <span class="system-proxy-rule-name">${escapeHtml(rule.name)}</span>
      <button
        type="button"
        class="system-proxy-rule-disable"
        data-action="disable-bifrost-rule"
        data-rule-name="${escapeHtml(rule.name)}"
        data-rule-count="${rule.ruleCount}"
        aria-label="停用 Bifrost 规则 ${escapeHtml(rule.name)}"
        title="停用这条 Bifrost 主代理规则"
      >停用</button>
    </span>
  `).join("");
  return `
    <span class="route-tip-card system-proxy-tip-card" role="tooltip">
      <span class="route-tip-scroll" role="region" aria-label="代理路由详情">
        <span class="route-tip-scroll-content">
          <span class="route-tip-head">
            <span class="route-tip-status system"><i aria-hidden="true"></i>${escapeHtml(display.providerLabel || "系统代理 · Chrome 正在跟随")}</span>
            <code>${display.routes.find((route) => route.endpoint)?.endpoint ? escapeHtml(display.routes.find((route) => route.endpoint)?.endpoint || "") : "系统设置"}</code>
          </span>
          ${rows || `
            <span class="route-tip-row">
              <span class="route-tip-tag">状态</span>
              <span class="route-tip-value">正在读取实际代理路由…</span>
            </span>
          `}
          ${display.mainDestination ? `
            <span class="route-tip-row system-proxy-main-destination">
              <span class="route-tip-tag">生效</span>
              <span class="route-tip-value destination-${display.mainDestination.kind}">${renderSystemRuleDestination(display.mainDestination.label)}</span>
            </span>
          ` : ""}
          ${mappingRows}
          ${hiddenMappingCount ? `
            <span class="route-tip-row system-proxy-more-mappings">
              <span class="route-tip-tag">更多</span>
              <span class="route-tip-value">还有 ${hiddenMappingCount} 条按域名或路径匹配</span>
            </span>
          ` : ""}
          ${display.providerKind === "bifrost" ? `
            <span class="route-tip-row system-proxy-rule-list">
              <span class="route-tip-tag">规则</span>
              <span class="route-tip-value route-tip-horizontal-scroll" tabindex="0" aria-label="已启用规则，可左右滚动查看完整内容">
                <span class="route-tip-horizontal-scroll-content">
                  <span class="system-proxy-rule-count">${display.mainRules.length} 份启用</span>
                  ${ruleItems}
                </span>
              </span>
            </span>
            <span class="route-tip-row system-proxy-direct-fallback">
              <span class="route-tip-tag">兜底</span>
              <span class="route-tip-value">未命中规则 → 直连原目标</span>
            </span>
          ` : ""}
          <span class="route-tip-row system-proxy-tip-note">
            <span class="route-tip-tag">方式</span>
            <span class="route-tip-value">${escapeHtml(modeNote)}</span>
          </span>
        </span>
      </span>
    </span>
  `;
}

export function renderProfileProxyRoute(profile: PublicProfile): string {
  if (profile.source === "native") {
    const display = systemProxyDisplay(store.bifrostSnapshot);
    const tooltip = [
      "系统 Chrome Profile 跟随系统代理设置，不支持单独配置",
      ...display.routes.map((route) =>
        `${route.protocol.toUpperCase()}：${systemProxyKindLabel(route.kind)}${route.endpoint ? ` ${route.endpoint}` : ""}`
      ),
      display.mainDestination ? `启用规则去向：${display.mainDestination.label}` : "",
      display.mainRules.length ? `启用规则：${display.mainRules.map((rule) => rule.name).join(" · ")}` : "",
      display.providerKind === "bifrost" ? "未命中规则：直连原目标" : ""
    ].filter(Boolean).join("\n");
    return `
      <span class="profile-route-track system ${display.tone}${display.providerKind ? ` provider-${display.providerKind}` : ""} action-tooltip structured-tooltip" aria-label="${escapeHtml(tooltip)}" tabindex="0">
        <span class="profile-route-signal" aria-hidden="true"></span>
        <span class="profile-route-copy">
          <strong>${escapeHtml(display.providerLabel || "系统代理")}</strong>
          <small${display.mainDestination ? ' class="system-rule-summary"' : ""}>${display.mainDestination ? `启用规则 · ${renderSystemRuleDestination(display.mainDestination.label)}` : escapeHtml(display.label)}</small>
        </span>
        ${renderSystemProxyTooltip(display, "系统 Chrome Profile 跟随系统代理，不支持单独配置")}
      </span>
    `;
  }
  if (profile.source !== "isolated") {
    return `
      <span class="profile-route-track native action-tooltip" data-tooltip="系统 Chrome Profile 不支持单独配置代理分流" aria-label="系统 Chrome Profile 不支持单独配置代理分流" tabindex="0">
        <span class="profile-route-signal" aria-hidden="true"></span>
        <span class="profile-route-copy">
          <strong>Chrome 设置</strong>
          <small>不可单独配置</small>
        </span>
      </span>
    `;
  }
  if (profile.directConnection) {
    return renderDirectConnectionRoute();
  }
  if (profile.upstreamProxy) {
    return renderUpstreamProxyRoute(profile);
  }
  if (!profile.bifrostProxy) {
    const display = systemProxyDisplay(store.bifrostSnapshot);
    const tooltip = [
      "未配置 Profile 专属分流，Chrome 跟随系统代理设置",
      ...display.routes.map((route) =>
        `${route.protocol.toUpperCase()}：${systemProxyKindLabel(route.kind)}${route.endpoint ? ` ${route.endpoint}` : ""}`
      ),
      display.mainDestination ? `启用规则去向：${display.mainDestination.label}` : "",
      display.mainRules.length ? `启用规则：${display.mainRules.map((rule) => rule.name).join(" · ")}` : "",
      display.providerKind === "bifrost" ? "未命中规则：直连原目标" : ""
    ].filter(Boolean).join("\n");
    return `
      <span class="profile-route-track system ${display.tone}${display.providerKind ? ` provider-${display.providerKind}` : ""} action-tooltip structured-tooltip" aria-label="${escapeHtml(tooltip)}" tabindex="0">
        <span class="profile-route-signal" aria-hidden="true"></span>
        <span class="profile-route-copy">
          <strong>${escapeHtml(display.providerLabel || "系统代理")}</strong>
          <small${display.mainDestination ? ' class="system-rule-summary"' : ""}>${display.mainDestination ? `启用规则 · ${renderSystemRuleDestination(display.mainDestination.label)}` : escapeHtml(display.label)}</small>
        </span>
        ${renderSystemProxyTooltip(display)}
      </span>
    `;
  }

  const config = profile.bifrostProxy;
  const state = bifrostRouteState(profile, store.bifrostSnapshot);
  const disabledRules = new Set(config.disabledRules || []);
  const disabledGroupRules = new Set(config.disabledGroupRules || []);
  const ruleReferences = [
    ...config.rules.map((ref) => ({ kind: "local" as const, ref, disabled: disabledRules.has(ref) })),
    ...config.groupRules.map((ref) => ({ kind: "group" as const, ref, disabled: disabledGroupRules.has(ref) }))
  ];
  const activeRuleReferences = ruleReferences.filter((rule) => !rule.disabled);
  const pausedRuleReferences = ruleReferences.filter((rule) => rule.disabled);
  const ruleNames = activeRuleReferences.map((rule) => rule.ref);
  const displayRules = activeRuleReferences.length
    ? activeRuleReferences.map((rule) => rule.ref.split("/").filter(Boolean).at(-1) || rule.ref).join(" · ")
    : "Default 规则";
  const fullRules = activeRuleReferences.length ? ruleNames.join(" · ") : "Default 规则";
  const pausedRules = pausedRuleReferences.map((rule) => rule.ref).join(" · ");
  const canRemoveRule = activeRuleReferences.length > 1;
  const ruleItems = ruleReferences.map((rule) => `
    <span class="profile-bifrost-rule-item ${rule.disabled ? "disabled" : "enabled"}">
      <span class="profile-bifrost-rule-name">${escapeHtml(rule.ref)}</span>
      <button
        type="button"
        class="${rule.disabled ? "profile-bifrost-rule-enable" : "profile-bifrost-rule-remove"}"
        data-action="${rule.disabled ? "enable-profile-bifrost-rule" : "remove-profile-bifrost-rule"}"
        data-id="${escapeHtml(profile.id)}"
        data-rule-kind="${rule.kind}"
        data-rule-ref="${escapeHtml(rule.ref)}"
        aria-label="在 ${escapeHtml(profile.name)} 中${rule.disabled ? "启用" : "停用"} Bifrost 规则 ${escapeHtml(rule.ref)}"
        title="${rule.disabled ? "仅在此 Profile 中重新启用" : canRemoveRule ? "仅在此 Profile 中停用" : "专属分流至少需要保留一条启用规则"}"
        ${!rule.disabled && !canRemoveRule ? "disabled" : ""}
      >${rule.disabled ? "启用" : "停用"}</button>
    </span>
  `).join("");
  const destination = bifrostProfileDestination(profile, store.bifrostSnapshot);
  const displayDestination = destination?.label || displayRules;
  const destinationClass = destination ? ` destination-${destination.kind}` : "";
  const tooltip = [
    bifrostRouteStateTitle(profile, state),
    destination ? `去向：${destination.label}` : "",
    ...(destination?.details || []),
    `启用规则：${fullRules}`,
    pausedRules ? `已停用：${pausedRules}` : ""
  ].filter(Boolean).join("\n");
  const statusLabel = bifrostRouteStateLabel(state);
  const endpoint = `127.0.0.1:${config.listenerPort}`;
  const mappingRows = (destination?.details || []).map((detail) => `
    <span class="route-tip-row route-tip-mapping">
      <span class="route-tip-tag">映射</span>
      <span class="route-tip-value">${renderBifrostRouteMapping(detail)}</span>
    </span>
  `).join("");
  return `
    <span class="profile-route-track bifrost ${state}${destinationClass} action-tooltip structured-tooltip" aria-label="${escapeHtml(tooltip)}" tabindex="0">
      <span class="profile-route-signal" aria-hidden="true"></span>
      <span class="profile-route-copy">
        <strong>Bifrost <em>:${config.listenerPort}</em></strong>
        <small>${escapeHtml(displayDestination)}</small>
      </span>
      <span class="route-tip-card" role="tooltip">
        <span class="route-tip-scroll" role="region" aria-label="Bifrost 路由详情">
          <span class="route-tip-scroll-content">
            <span class="route-tip-head">
              <span class="route-tip-status ${state}"><i aria-hidden="true"></i>Bifrost · ${escapeHtml(statusLabel)}</span>
              <code>${escapeHtml(endpoint)}</code>
            </span>
            ${destination ? `
              <span class="route-tip-row route-tip-destination">
                <span class="route-tip-tag">去向</span>
                <span class="route-tip-value destination-${destination.kind}">${escapeHtml(destination.label)}</span>
              </span>
            ` : ""}
            ${mappingRows}
            <span class="route-tip-row route-tip-rules">
              <span class="route-tip-tag">规则</span>
              <span class="route-tip-value route-tip-horizontal-scroll" tabindex="0" aria-label="Bifrost 规则，可左右滚动查看完整内容">
                <span class="route-tip-horizontal-scroll-content">
                  ${ruleItems || `<span class="profile-bifrost-rule-name">${escapeHtml(fullRules)}</span>`}
                </span>
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  `;
}

export interface BifrostProfileDestination {
  kind: "local" | "ppe" | "boe" | "mixed" | "other";
  label: string;
  details: string[];
}

export function bifrostProfileDestination(
  profile: PublicProfile,
  snapshot: BifrostSnapshot | null | undefined
): BifrostProfileDestination | null {
  if (!profile.bifrostProxy || !snapshot?.ruleDestinations) return null;
  const disabledRules = new Set(profile.bifrostProxy.disabledRules || []);
  const disabledGroupRules = new Set(profile.bifrostProxy.disabledGroupRules || []);
  const keys = [
    ...profile.bifrostProxy.rules
      .filter((rule) => !disabledRules.has(rule))
      .map((rule) => `local:${rule}`),
    ...profile.bifrostProxy.groupRules
      .filter((rule) => !disabledGroupRules.has(rule))
      .map((rule) => `group:${rule}`)
  ];
  const destinations = keys
    .map((key) => snapshot.ruleDestinations?.[key])
    .filter((destination): destination is BifrostRuleDestination => Boolean(destination));
  if (!destinations.length) return null;
  const kinds = [...new Set(destinations.map((destination) => destination.kind))];
  return {
    kind: kinds.length === 1 ? kinds[0] : "mixed",
    label: [...new Set(destinations.map((destination) => destination.label))].join(" + "),
    details: [...new Set(destinations.flatMap((destination) => destination.details))].slice(0, 16)
  };
}

// 直连上游代理的可达性两态：绿=TCP 可达；红=不可达/未探到；unknown=还没拿到快照。
export type UpstreamRouteState = "ok" | "down" | "unknown";

function upstreamProxyKind(server: string, snapshot: BifrostSnapshot | null | undefined): ProxyProviderKind {
  if (proxyServerUsesPort(server, snapshot?.mainPort || 9900)) return "bifrost";
  if (proxyServerUsesPort(server, 7897)) return "clash";
  return "custom";
}

export function upstreamRouteState(profile: PublicProfile, snapshot: BifrostSnapshot | null | undefined): UpstreamRouteState {
  const config = profile.upstreamProxy;
  if (!config || !snapshot) {
    return "unknown";
  }
  const reachable = snapshot.upstreamHealth?.[config.server];
  if (reachable === undefined) {
    return "unknown";
  }
  return reachable ? "ok" : "down";
}

export function renderUpstreamProxyRoute(profile: PublicProfile): string {
  const config = profile.upstreamProxy;
  if (!config) {
    return "";
  }
  const state = upstreamRouteState(profile, store.bifrostSnapshot);
  const stateClass = state === "unknown" ? "" : ` ${state}`;
  const port = config.server.match(/:(\d{2,5})(?:\D|$)/)?.[1] || "up";
  const kind = upstreamProxyKind(config.server, store.bifrostSnapshot);
  const provider = kind === "bifrost" ? "Bifrost" : kind === "clash" ? "Clash Verge" : "指定代理";
  const mainRuleDisplay = kind === "bifrost" ? bifrostMainRuleDisplay(store.bifrostSnapshot) : null;
  const routeNote = mainRuleDisplay
    ? mainRuleDisplay.label
    : kind === "clash"
      ? "规则由 Clash 决定"
      : "规则由目标代理决定";
  const tooltipNote = kind === "clash" ? "具体规则由 Clash Verge 决定" : routeNote;
  const reachableTitle = kind === "bifrost"
    ? "Bifrost 主入口可达"
    : kind === "clash"
      ? "直连 Clash 可达"
      : "指定代理可达";
  const unreachableTitle = kind === "bifrost"
    ? "Bifrost 主入口不可达"
    : kind === "clash"
      ? "直连 Clash 不可达"
      : "指定代理不可达";
  const recovery = kind === "bifrost"
    ? "确认 Bifrost 已开启并监听该端口"
    : kind === "clash"
      ? "确认 Clash 已开启并监听该端口"
      : "确认代理服务已开启并监听该端口";
  const title = state === "ok"
    ? `${reachableTitle} · ${config.server}`
    : state === "down"
      ? `${unreachableTitle} · ${config.server}（${recovery}）`
      : `${provider} · ${config.server}`;
  const tooltip = kind === "bifrost"
    ? [
        title,
        mainRuleDisplay?.mainDestination ? `启用规则去向：${mainRuleDisplay.mainDestination.label}` : "",
        mainRuleDisplay?.mainRules.length ? `启用规则：${mainRuleDisplay.mainRules.map((rule) => rule.name).join(" · ")}` : "没有启用规则",
        "未命中规则：直连原目标",
        `所有使用 :${port} 的 Profile 共享这些规则`
      ].filter(Boolean).join("\n")
    : `${title}\n${tooltipNote}`;
  const endpoint = config.server.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  const bifrostTooltip = kind === "bifrost" && mainRuleDisplay
    ? renderSystemProxyTooltip({
        label: mainRuleDisplay.label,
        tone: state === "down" ? "system-proxy-unknown" : "system-proxy-active",
        routes: [
          { protocol: "https", kind: "http", endpoint },
          { protocol: "http", kind: "http", endpoint }
        ],
        providerKind: "bifrost",
        providerLabel: `Bifrost :${port}`,
        mainRules: mainRuleDisplay.mainRules,
        mainDestination: mainRuleDisplay.mainDestination
      }, `此 Profile 显式连接主入口；所有使用 :${port} 的 Profile 共享这些规则`)
    : "";
  const routeNoteHtml = mainRuleDisplay?.mainDestination
    ? `启用规则 · ${renderSystemRuleDestination(mainRuleDisplay.mainDestination.label)}`
    : escapeHtml(routeNote);
  return `
    <span class="profile-route-track upstream provider-${kind}${stateClass} action-tooltip${kind === "bifrost" ? " structured-tooltip" : ""}"${kind === "bifrost" ? "" : ` data-tooltip="${escapeHtml(tooltip)}"`} aria-label="${escapeHtml(tooltip)}" tabindex="0">
      <span class="profile-route-signal" aria-hidden="true"></span>
      <span class="profile-route-copy">
        <strong>${provider} <em>:${escapeHtml(port)}</em></strong>
        <small${mainRuleDisplay?.mainDestination ? ' class="system-rule-summary"' : ""}>${routeNoteHtml}</small>
      </span>
      ${bifrostTooltip}
    </span>
  `;
}

export function renderDirectConnectionRoute(): string {
  const tooltip = "直接联网\nChrome 已显式绕过系统代理，不连接 Bifrost 或 Clash";
  return `
    <span class="profile-route-track direct action-tooltip" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}" tabindex="0">
      <span class="profile-route-signal" aria-hidden="true"></span>
      <span class="profile-route-copy">
        <strong>直接联网</strong>
        <small>已绕过所有代理</small>
      </span>
    </span>
  `;
}

export function renderBifrostProxyDetail(profile: PublicProfile): string {
  if (profile.source !== "isolated") {
    return "";
  }
  if (profile.directConnection) {
    return `
      <div class="detail-row bifrost-detail-row">
        <span>代理分流</span>
        <strong>直接联网 <em class="bifrost-route-state ok">已配置</em></strong>
        <code class="path-box compact">--no-proxy-server</code>
        <small class="detail-note">启动 Chrome 时显式绕过系统代理，不连接 Bifrost 或 Clash。</small>
      </div>
    `;
  }
  if (profile.upstreamProxy) {
    const state = upstreamRouteState(profile, store.bifrostSnapshot);
    const kind = upstreamProxyKind(profile.upstreamProxy.server, store.bifrostSnapshot);
    const provider = kind === "bifrost" ? "Bifrost 主入口" : kind === "clash" ? "Clash Verge" : "指定代理";
    const stateOwner = kind === "bifrost" ? "Bifrost" : kind === "clash" ? "Clash" : "代理";
    const stateLabel = state === "ok"
      ? kind === "custom" ? "代理可达" : `${stateOwner} 可达`
      : state === "down"
        ? kind === "custom" ? "代理不可达" : `${stateOwner} 不可达`
        : "状态未知";
    const bypass = profile.upstreamProxy.bypassList;
    const mainRuleDisplay = kind === "bifrost" ? bifrostMainRuleDisplay(store.bifrostSnapshot) : null;
    const routeNote = kind === "bifrost"
      ? `${mainRuleDisplay?.label || "规则状态不可用"}${mainRuleDisplay?.mainRules.length ? `；规则：${mainRuleDisplay.mainRules.map((rule) => rule.name).join(" · ")}` : ""}。所有使用该主入口的 Profile 共享这些规则。`
      : kind === "clash"
        ? "整体流量交给 Clash mixed 入口。"
        : "整体流量交给这个代理，具体规则由目标服务决定。";
    return `
      <div class="detail-row bifrost-detail-row">
        <span>代理分流</span>
        <strong>${provider} <em class="bifrost-route-state ${state}">${stateLabel}</em></strong>
        <code class="path-box compact">${escapeHtml(profile.upstreamProxy.server)}</code>
        <small class="detail-note">${bypass ? `Bypass：${escapeHtml(bypass)}` : routeNote}</small>
      </div>
    `;
  }
  const config = profile.bifrostProxy;
  if (!config) {
    const display = systemProxyDisplay(store.bifrostSnapshot);
    return `
      <div class="detail-row detail-row-disabled">
        <span>代理分流</span>
        <strong>${escapeHtml(display.providerLabel || "跟随系统代理")}</strong>
        <code class="path-box compact">${escapeHtml(display.label)}</code>
        <small class="detail-note">可在“更多 → 代理分流”中选择 Bifrost、Clash 或直接联网。</small>
      </div>
    `;
  }
  const disabledRules = new Set(config.disabledRules || []);
  const disabledGroupRules = new Set(config.disabledGroupRules || []);
  const activeRuleNames = [
    ...config.rules.filter((rule) => !disabledRules.has(rule)),
    ...config.groupRules.filter((rule) => !disabledGroupRules.has(rule))
  ];
  const pausedRuleNames = [
    ...config.rules.filter((rule) => disabledRules.has(rule)),
    ...config.groupRules.filter((rule) => disabledGroupRules.has(rule))
  ];
  const state = bifrostRouteState(profile, store.bifrostSnapshot);
  const stateLabel = state === "ok"
    ? "分流生效中"
    : state === "stale"
      ? "待重绑 · 启动时自动恢复"
      : state === "down"
        ? "Bifrost 未运行"
        : "状态未知";
  return `
    <div class="detail-row bifrost-detail-row">
      <span>Bifrost 分流</span>
      <strong>127.0.0.1:${config.listenerPort} <em class="bifrost-route-state ${state}" title="${escapeHtml(bifrostRouteStateTitle(profile, state))}">${stateLabel}</em></strong>
      <code class="path-box compact">${escapeHtml(activeRuleNames.join(" · "))}</code>
      <small class="detail-note">${
        pausedRuleNames.length
          ? `已停用：${escapeHtml(pausedRuleNames.join(" · "))}。`
          : ""
      }启动前自动恢复专属入口；Default 规则始终一并生效。</small>
    </div>
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
        ${renderReadinessPanel(profile)}
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

function renderReadinessPanel(profile: PublicProfile): string {
  const receipt = store.profileReadiness[profile.id] || null;
  const loading = store.profileReadinessLoading[profile.id] === true;
  if (!receipt) {
    return `
      <section class="readiness-panel loading" aria-label="Readiness receipt">
        <div class="readiness-panel-head">
          <div>
            <span>Readiness receipt</span>
            <strong>${loading ? "正在逐层核验…" : "尚未生成"}</strong>
          </div>
          <button type="button" data-action="refresh-profile-readiness" data-id="${escapeHtml(profile.id)}" ${loading ? "disabled" : ""}>
            ${renderButtonLabel(loading, "开始检查", "检查中…")}
          </button>
        </div>
      </section>
    `;
  }
  const statusLabel = receipt.overall === "ready"
    ? "可以开工"
    : receipt.overall === "blocked"
      ? "存在阻塞"
      : "需要补证据";
  const ownership = receipt.checks.find((check) => check.id === "ownership");
  const foreground = receipt.checks.find((check) => check.id === "foreground");
  const userOwns = profile.gatewayControl?.ownership === "user" && profile.gatewayControl.sessionStatus === "active";
  return `
    <section class="readiness-panel ${receipt.overall}" aria-label="Readiness receipt">
      <div class="readiness-panel-head">
        <div class="readiness-verdict">
          <span>Readiness receipt · ${escapeHtml(formatDate(receipt.generatedAt))}</span>
          <strong><i aria-hidden="true"></i>${escapeHtml(statusLabel)}</strong>
          <small>${receipt.blockerCodes.length
            ? `${receipt.blockerCodes.length} 个阻塞 · ${receipt.blockerCodes.join(" · ")}`
            : receipt.unknownCodes.length
              ? `${receipt.unknownCodes.length} 项尚待验证`
              : "所有必需检查均有可复核证据"}</small>
        </div>
        <div class="readiness-actions">
          ${userOwns ? `<button type="button" class="solid" data-action="return-agent-control" data-id="${escapeHtml(profile.id)}" ${store.busy ? "disabled" : ""}>交还 Agent</button>` : ""}
          <button type="button" data-action="copy-profile-readiness" data-id="${escapeHtml(profile.id)}">复制 JSON</button>
          <button type="button" class="${loading ? "loading" : ""}" data-action="refresh-profile-readiness" data-id="${escapeHtml(profile.id)}" ${loading ? "disabled" : ""}>
            ${renderButtonLabel(loading, "重新检查", "检查中…")}
          </button>
        </div>
      </div>
      <div class="readiness-control-axis" aria-label="控制权与前台状态">
        <span><em>逻辑控制权</em><strong>${escapeHtml(ownership?.actual || "未知")}</strong></span>
        <span><em>窗口前台</em><strong>${escapeHtml(foreground?.actual || windowActivationLabel(profile.windowActivation))}</strong></span>
      </div>
      <div class="readiness-checks">
        ${receipt.checks.map((check) => `
          <article class="readiness-check ${check.status}">
            <span class="readiness-check-state" aria-hidden="true"></span>
            <div>
              <small>${escapeHtml(check.code)}</small>
              <strong>${escapeHtml(check.label)}</strong>
              <p>${escapeHtml(check.actual)}</p>
              ${check.expected ? `<dl><dt>期望</dt><dd>${escapeHtml(check.expected)}</dd></dl>` : ""}
              ${check.evidence ? `<dl><dt>证据</dt><dd>${escapeHtml(check.evidence)}</dd></dl>` : ""}
              ${check.action ? `<aside>${escapeHtml(check.action)}</aside>` : ""}
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function windowActivationLabel(value: PublicProfile["windowActivation"]): string {
  if (value === "foreground") return "前台";
  if (value === "background") return "后台";
  if (value === "not_running") return "未运行";
  return "无法确认";
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
