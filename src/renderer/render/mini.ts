import { profileApi } from "../api";
import { isBusyAction, renderToastBody } from "../busy";
import { appRoot, store } from "../state";
import { PublicProfile } from "../types";
import {
  agentActivityLeadText,
  agentActivityTooltipText,
  cdpPortLabel,
  cdpSessionText,
  contentionNoticeShort,
  escapeHtml,
  formatRelativeTime,
  liveAddrLabel,
  prettyCdpClientLabel,
  renderButtonLabel
} from "../util";

const MINI_PROFILE_LIMIT = 3;

// 读数「工具名 已连接」的悬停说明：第一个客户端的 工具 / 项目 / 会话标题；
// 多连接时每个额外会话补一行（工具 · 项目·标题 · 最近活动）——争用问题的现场就是这些并存的会话。
// 判定有争用时首行给警示。escapeHtml 不动换行，title 属性里的 \n 浏览器会渲染成多行 tooltip。
function cdpClientTooltip(profile: PublicProfile): string {
  const clients = profile.cdpClients;
  const primary = clients[0];
  if (!primary) {
    return "";
  }
  const lines: string[] = [];
  const warning = contentionNoticeShort(profile);
  if (warning) {
    lines.push(warning);
  }
  lines.push(primary.agent || prettyCdpClientLabel(primary.label));
  if (primary.session) {
    lines.push(`会话：${primary.session}`);
  }
  if (primary.project) {
    lines.push(`项目：${primary.project}`);
  }
  if (primary.title) {
    lines.push(`标题：${primary.title}`);
  }
  if (primary.lastActive) {
    lines.push(`最近活动：${formatRelativeTime(primary.lastActive)}`);
  }
  if (primary.note) {
    lines.push(primary.note);
  }
  for (const client of clients.slice(1)) {
    const parts = [client.agent || prettyCdpClientLabel(client.label), cdpSessionText(client), formatRelativeTime(client.lastActive)];
    lines.push(`同时连接：${parts.filter(Boolean).join(" · ")}`);
  }
  // 只有工具名一行时没多少信息，但仍给一个 tooltip 兜底（起码点明是谁）。
  return lines.join("\n");
}

// 头部 logo（纸飞机 mark），与 profilepilot-logo.svg 同源
const MINI_LOGO_MARK = `
  <svg class="mini-mark" viewBox="0 0 36 36" aria-hidden="true">
    <defs>
      <linearGradient id="mini-plane" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#82f5c9" />
        <stop offset="1" stop-color="#2bbd86" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="34" height="34" rx="9" fill="#0c161c" stroke="#38e1a0" stroke-opacity="0.35" />
    <path d="M18 7 L27 30 L18 24.5 L9 30 Z" fill="url(#mini-plane)" />
    <path d="M18 7 L18 24.5 L9 30 Z" fill="#27a877" fill-opacity="0.55" />
  </svg>
`;

const MINI_LOGO_GLYPH = `
  <svg class="mini-logo-glyph" viewBox="0 0 36 36" aria-hidden="true">
    <defs>
      <linearGradient id="mini-glyph-plane" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#82f5c9" />
        <stop offset="1" stop-color="#2bbd86" />
      </linearGradient>
    </defs>
    <path d="M18 7 L27 30 L18 24.5 L9 30 Z" fill="url(#mini-glyph-plane)" />
    <path d="M18 7 L18 24.5 L9 30 Z" fill="#27a877" fill-opacity="0.55" />
  </svg>
`;

// 航点节点：运行中朝右的小机头
const MINI_NODE_PLANE = `<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M1 1 L12 6.5 L1 12 L4 6.5 Z" fill="currentColor" /></svg>`;

// 上一次渲染的展开面板 HTML。定时轮询（2.5s）本会每次整段 innerHTML 重建，把用户正
// hover 的节点换掉，导致 tooltip / 呼吸灯一闪一闪。内容没变时据此跳过重建。
let lastMiniPanelHtml = "";

export function renderMini(): void {
  document.documentElement.classList.add("mini-rendered");
  document.body.classList.add("mini-mode");
  document.body.classList.toggle("mini-panel-open", store.miniPanelOpen);
  const previousScrollTop = store.miniExpanded ? store.miniScrollTop : 0;

  if (!store.miniPanelOpen) {
    // dock 没有动态内容；已经渲染过就不重建，否则每次 render（含 2.5s 轮询）都会
    // 重建 .mini-logo-dock 元素，导致呼吸灯 CSS 动画被重置、看起来一卡一顿。
    lastMiniPanelHtml = "";
    if (!appRoot.querySelector(".mini-logo-dock")) {
      appRoot.className = "mini-root mini-root-collapsed";
      appRoot.innerHTML = `
        <button type="button" class="mini-logo-dock" data-action="toggle-mini-panel" title="展开悬浮窗" aria-label="展开悬浮窗">
          ${MINI_LOGO_GLYPH}
        </button>
      `;
    } else if (appRoot.className !== "mini-root mini-root-collapsed") {
      appRoot.className = "mini-root mini-root-collapsed";
    }
    return;
  }

  if (!store.state) {
    lastMiniPanelHtml = "";
    appRoot.className = "mini-root mini-root-panel";
    appRoot.innerHTML = '<div class="mini-shell"><div class="mini-loading">Loading...</div></div>';
    return;
  }

  const profiles = miniProfiles();
  const pinnedCount = store.state.miniProfileIds.length;
  const totalProfiles = store.state.profiles.length;
  const canExpand = totalProfiles > MINI_PROFILE_LIMIT;
  const visibleCount = Math.min(profiles.length, totalProfiles);
  const refreshing = isBusyAction("refresh");
  const html = `
    <div class="mini-shell">
      <header class="mini-titlebar">
        <div class="mini-brand">
          <button type="button" class="mini-mark-button" data-action="toggle-mini-panel" title="收起为悬浮图标" aria-label="收起为悬浮图标">
            ${MINI_LOGO_MARK}
          </button>
          <div class="mini-brand-text">
            <strong>ProfilePilot</strong>
            <span>${store.miniExpanded ? `${visibleCount}/${totalProfiles} · all` : pinnedCount ? `${visibleCount}/${totalProfiles} · fixed` : `${visibleCount}/${totalProfiles} · auto`}</span>
          </div>
        </div>
        <div class="mini-window-actions">
          <button type="button" class="${store.miniPanelPinned ? "active" : ""}" data-action="toggle-mini-pinned" title="${store.miniPanelPinned ? "取消固定：点击面板外恢复收起为悬浮图标" : "固定面板：点击面板外不再收起为悬浮图标"}" aria-pressed="${store.miniPanelPinned ? "true" : "false"}">
            ${store.miniPanelPinned ? "已固定" : "固定"}
          </button>
          <button type="button" class="${refreshing ? "loading" : ""}" data-action="refresh" title="刷新 Profile 状态" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(refreshing, "刷新", "刷新")}
          </button>
          <button type="button" data-action="toggle-mini-panel" title="收起为悬浮图标">收起</button>
          <button type="button" data-action="show-main-window" title="展开完整控制台">展开</button>
        </div>
      </header>
      <main class="mini-profile-list ${store.miniExpanded ? "expanded" : ""}" aria-label="Mini Profiles">
        ${
          profiles.length
            ? profiles.map(renderMiniProfileCard).join("")
            : '<div class="mini-empty">还没有 Profile</div>'
        }
      </main>
      ${
        canExpand
          ? `<footer class="mini-load-more">
              <button type="button" data-action="toggle-mini-expanded" title="${store.miniExpanded ? "收起 Profile 列表" : "查看更多 Profile"}">
                ${store.miniExpanded ? "收起" : `查看更多 ${totalProfiles - visibleCount} 个 Profile`}
              </button>
            </footer>`
          : ""
      }
      ${store.toast ? `<div class="mini-toast ${store.toastKind === "error" ? "error" : ""}" role="status">${renderToastBody(store.toast)}</div>` : ""}
    </div>
  `;

  // 内容没变就别重刷 DOM（面板已处于展开态时）：避免轮询把正 hover 的节点换掉造成闪烁。
  if (appRoot.className === "mini-root mini-root-panel" && lastMiniPanelHtml === html) {
    return;
  }
  lastMiniPanelHtml = html;
  appRoot.className = "mini-root mini-root-panel";
  appRoot.innerHTML = html;

  if (store.miniExpanded && previousScrollTop > 0) {
    window.requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>(".mini-profile-list");
      if (list) {
        list.scrollTop = previousScrollTop;
      }
    });
  }

  // 内容渲染完后，量出面板真实内容高度，请求主进程把窗口高度自适应（不写死）。
  window.requestAnimationFrame(adjustMiniPanelHeight);
}

// 测量 .mini-shell 的自然内容高度（含 padding/border/gap），通知主进程 resize 窗口。
// 用临时把列表高度收成内容高度 + shell 设为 auto 的方式精确量取，量完即复原（含滚动位置）。
function adjustMiniPanelHeight(): void {
  const shell = appRoot.querySelector<HTMLElement>(".mini-shell");
  if (!shell) {
    return;
  }

  const list = appRoot.querySelector<HTMLElement>(".mini-profile-list");
  const prevShellH = shell.style.height;
  let desired: number;

  if (list) {
    const prevScroll = list.scrollTop;
    const prevListH = list.style.height;
    list.style.height = "0px";
    const listContent = list.scrollHeight;
    list.style.height = `${listContent}px`;
    shell.style.height = "auto";
    desired = shell.offsetHeight;
    shell.style.height = prevShellH;
    list.style.height = prevListH;
    list.scrollTop = prevScroll;
  } else {
    shell.style.height = "auto";
    desired = shell.offsetHeight;
    shell.style.height = prevShellH;
  }

  if (desired > 0) {
    void profileApi().resizeMiniPanel(desired).catch(() => {
      // 高度自适应是尽力而为，失败不影响功能。
    });
  }
}

function miniProfiles(): PublicProfile[] {
  if (!store.state) {
    return [];
  }

  const profiles = sortByMiniOrder(store.state.profiles || []);
  const pinnedProfiles = profiles.filter((profile) => store.state?.miniProfileIds.includes(profile.id));

  if (store.miniExpanded) {
    return profiles;
  }

  return (pinnedProfiles.length ? pinnedProfiles : profiles).slice(0, MINI_PROFILE_LIMIT);
}

// 应用用户拖拽出来的自定义顺序：排序表里的靠前，不在表里的排在后面、保持自然顺序（sort 稳定）。
export function sortByMiniOrder(profiles: PublicProfile[]): PublicProfile[] {
  const order = store.state?.miniProfileOrder || [];
  if (!order.length) {
    return [...profiles];
  }

  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...profiles].sort(
    (a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function renderMiniProfileCard(profile: PublicProfile): string {
  const slot = profile.quickLaunchSlot ?? undefined;
  const port = miniPortInfo(profile);
  const action = miniPrimaryAction(profile);
  const focusing = isBusyAction("focus-profile", { profileId: profile.id });
  const launching = isBusyAction("launch-profile", { profileId: profile.id });
  const launchingCdp = isBusyAction("launch-cdp", { profileId: profile.id });
  const closing = isBusyAction("close-profile", { profileId: profile.id });
  const busyHere = focusing || launching || launchingCdp || closing;
  const busyLabel = focusing
    ? "显示中…"
    : launching
      ? "启动中…"
      : launchingCdp
        ? "CDP 启动中…"
        : closing
          ? "关闭中…"
          : "";
  const liveHost = profile.running && profile.livePrimaryUrl ? liveAddrLabel(profile) : "";
  const driving = profile.running && profile.cdpClients.length > 0;
  // 右侧读数覆盖三个维度：浏览器开没开（图标颜色 + 未启动/已启动字样）、
  // CDP 端口开没开（:端口 / 无 CDP）、有没有工具连着驱动（工具名·已连接/未连接）。
  // 忙碌 > 工具名·已连接 > 端口·未连接 > 已启动·无 CDP > 未启动。
  const cdpPort = profile.cdpUrl ? cdpPortLabel(profile.cdpUrl) : "";
  // 判定有争用时读数带 ⚠（卡片同时加 contention 类转琥珀），提醒去主窗口看详情/分流。
  const contention = driving && Boolean(profile.cdpContention?.level);
  const toolLabel = driving
    ? `${prettyCdpClientLabel(profile.cdpClients[0].label)}${profile.cdpClients.length > 1 ? ` ×${profile.cdpClients.length}` : ""}${contention ? " ⚠" : ""}`
    : "";
  const readout = busyHere
    ? busyLabel
    : driving
      ? `${toolLabel} 已连接`
      : profile.running && profile.cdpUrl
        ? `${cdpPort} · 未连接`
        : port.label;
  // 被连接时在名字右侧跟一段小字：端口 ▸ 正控制哪个页面（域名）。工具名在右侧读数。
  const subLine = !busyHere && driving ? [cdpPort, liveHost].filter(Boolean).join(" ▸ ") : "";
  // 读数悬停 tooltip：这条连接背后是哪个工具的哪个项目/会话（解析得到才显示）。
  const readoutTip = !busyHere && driving ? cdpClientTooltip(profile) : "";
  // 卡片正文可见的会话身份行：哪个项目 / 哪个会话在驱动（解析到才显示）。
  // 文案会截断，但“最近活动”固定在右侧不被吃掉——它是判断“活会话 vs 残留连接”的关键信号。
  const primaryClient = driving ? profile.cdpClients[0] : undefined;
  const sessionText = !busyHere && primaryClient ? cdpSessionText(primaryClient) : "";
  const sessionAge = !busyHere && primaryClient ? formatRelativeTime(primaryClient.lastActive) : "";
  const activityText = profile.agentActivity ? agentActivityLeadText(profile.agentActivity) || "正在操作" : "";
  const activityTip = profile.agentActivity ? agentActivityTooltipText(profile.agentActivity) || activityText : "";
  const takeover = store.miniTakeoverByProfileId[profile.id];
  const takeoverAgent = takeover?.agent || "AI";
  const takeoverText = takeover ? `已接管 · ${takeoverAgent} 已停止操作` : "";
  const takeoverTip = takeover
    ? `${takeover.profileName}\n${takeoverAgent}${takeover.session ? ` · ${takeover.session}` : ""} 已停止操作`
    : "";

  return `
    <article class="mini-profile-card ${port.kind} ${driving ? "driving" : ""} ${contention ? "contention" : ""} ${takeover ? "taken-over" : ""} ${busyHere ? "busy" : ""}" data-id="${profile.id}" draggable="true">
      <button type="button" class="mini-profile-main" data-action="${action}" data-id="${profile.id}" title="${escapeHtml(profile.running ? "显示 Chrome 窗口" : "启动 Profile")}" ${store.busy ? "disabled" : ""}>
        <span class="mini-node ${busyHere ? "loading" : port.kind === "live" ? "plane" : "ring"}" aria-hidden="true">${busyHere ? '<span class="mini-spinner"></span>' : port.kind === "live" ? MINI_NODE_PLANE : ""}</span>
        <span class="mini-profile-text">
          <span class="mini-profile-head">
            ${slot ? `<span class="mini-profile-slot" title="全局快捷键 ⌘⌥${slot} 直启">⌘⌥${slot}</span>` : ""}
            <span class="mini-profile-name">${escapeHtml(profile.name)}</span>
            ${subLine ? `<span class="mini-profile-sub">${escapeHtml(subLine)}</span>` : ""}
          </span>
          ${
            sessionText || sessionAge
              ? `<span class="mini-profile-session"${readoutTip ? ` title="${escapeHtml(readoutTip)}"` : ""}>${sessionText ? `<span class="mini-profile-session-main">${escapeHtml(sessionText)}</span>` : ""}${sessionAge ? `<span class="mini-profile-session-age">${escapeHtml(sessionAge)}</span>` : ""}</span>`
              : ""
          }
          ${
            takeoverText
              ? `<span class="mini-profile-takeover"${takeoverTip ? ` title="${escapeHtml(takeoverTip)}"` : ""}>${escapeHtml(takeoverText)}</span>`
              : activityText
                ? `<span class="mini-profile-agent"${activityTip ? ` title="${escapeHtml(activityTip)}"` : ""}>AI：${escapeHtml(activityText)}</span>`
                : ""
          }
        </span>
        <span class="mini-readout"${takeoverTip ? ` title="${escapeHtml(takeoverTip)}"` : readoutTip ? ` title="${escapeHtml(readoutTip)}"` : ""}>${escapeHtml(takeover ? "已接管" : readout)}</span>
      </button>
      ${
        !busyHere && primaryClient
          ? `<button type="button" class="mini-disconnect" data-action="disconnect-client" data-id="${profile.id}" data-pid="${primaryClient.pid}" ${store.busy ? "disabled" : ""} title="结束这条驱动连接，不影响 Chrome" aria-label="结束驱动连接">✕</button>`
          : ""
      }
    </article>
  `;
}

function miniPrimaryAction(profile: PublicProfile): string {
  if (profile.running) {
    return "mini-focus-profile";
  }

  // 独立 Profile 默认走 CDP 启动（无固定端口时自动挑一个空闲端口）——与主窗口一致。
  if (profile.source === "isolated") {
    return "mini-launch-cdp";
  }

  return "mini-launch";
}

export function miniPortInfo(profile: PublicProfile): {
  kind: "live" | "bound" | "off";
  label: string;
  copyValue: string | null;
} {
  if (profile.cdpUrl) {
    return {
      kind: "live",
      label: profile.cdpUrl.replace(/^https?:\/\//, ""),
      copyValue: profile.cdpUrl
    };
  }

  if (profile.running) {
    return {
      kind: "live",
      label: "已启动 · 无 CDP",
      copyValue: null
    };
  }

  if (profile.source === "isolated" && profile.fixedCdpPort) {
    return {
      kind: "bound",
      label: `:${profile.fixedCdpPort} · 未启动`,
      copyValue: `http://127.0.0.1:${profile.fixedCdpPort}`
    };
  }

  return {
    kind: "off",
    label: "未启动",
    copyValue: null
  };
}
