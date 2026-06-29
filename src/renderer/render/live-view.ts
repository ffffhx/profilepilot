import { profileApi } from "../api";
import { LiveViewEntry, store } from "../state";
import { CdpLiveTab, CdpLiveView, PublicProfile } from "../types";
import { escapeHtml, formatErrorMessage, hostOf } from "../util";

// 实时观测刷新节奏：和主轮询(3s)错开一点，专门盯当前选中的那一个在飞的 Profile。
const LIVE_VIEW_INTERVAL_MS = 2500;

let liveViewTimer: number | null = null;

// 只有“工具独立 + 正在运行 + 有 CDP 端口”的 Profile 才能被观测（系统 Profile 没有端口式 CDP）。
export function liveViewEligible(profile: PublicProfile): boolean {
  return profile.source === "isolated" && profile.running && profile.cdpPort != null;
}

// 详情侧栏里的实时观测区块。外层带 data-live-view=profileId，轮询时只换内部 body，
// 不触发全量 render，避免截图和滚动跳动。不满足条件返回空串（系统 / 未运行 / 无 CDP）。
export function renderLiveViewSection(profile: PublicProfile): string {
  if (!liveViewEligible(profile)) {
    return "";
  }
  return `<section class="live-view" data-live-view="${escapeHtml(profile.id)}">${renderLiveViewBody(profile)}</section>`;
}

// 启动独立的观测循环（仅主窗口）。跳过条件与主轮询一致：忙 / 隐藏 / 有弹窗。
export function startLiveViewLoop(): void {
  if (liveViewTimer !== null) {
    return;
  }
  liveViewTimer = window.setInterval(() => {
    if (store.viewMode !== "main" || store.busy || document.hidden || store.modal) {
      return;
    }
    const profile = currentLiveProfile();
    if (profile) {
      void fetchLiveView(profile);
    }
  }, LIVE_VIEW_INTERVAL_MS);
}

// 选中一个 Profile 时立刻拉一帧，给即时反馈，不必等下一个轮询周期。
export function requestLiveViewNow(profileId: string | null): void {
  if (!profileId || !store.state) {
    return;
  }
  const profile = store.state.profiles.find((item) => item.id === profileId);
  if (profile && liveViewEligible(profile)) {
    void fetchLiveView(profile);
  }
}

export function refreshLiveViewNow(): void {
  requestLiveViewNow(store.selectedId);
}

export function toggleLiveScreenshot(): void {
  store.liveViewShowScreenshot = !store.liveViewShowScreenshot;
  if (store.selectedId) {
    // 先反映按钮态（截图开/关），再按新设置重新拉一帧。
    updateLiveViewDom(store.selectedId);
    requestLiveViewNow(store.selectedId);
  }
}

// 点 Cockpit 标签列表里的某一项：把浏览器真正切到那个标签，并让实时画面切到它。
export function focusLiveTab(profileId: string, targetId: string): void {
  if (!store.state || !targetId) {
    return;
  }
  const profile = store.state.profiles.find((item) => item.id === profileId);
  if (!profile || !liveViewEligible(profile) || profile.cdpPort == null) {
    return;
  }
  store.liveActiveTab[profileId] = targetId;
  // 只切 Cockpit 查看的标签：在后台直接抓它的画面，不激活浏览器标签——
  // 这样浏览器窗口纹丝不动、零抢焦点（CDP 的 activateTarget 必然抢前台，故不用）。
  void fetchLiveView(profile);
}

function currentLiveProfile(): PublicProfile | null {
  if (!store.state || !store.selectedId) {
    return null;
  }
  const profile = store.state.profiles.find((item) => item.id === store.selectedId);
  return profile && liveViewEligible(profile) ? profile : null;
}

function ensureEntry(profileId: string): LiveViewEntry {
  const existing = store.liveView[profileId];
  if (existing) {
    return existing;
  }
  const entry: LiveViewEntry = { data: null, loading: false, error: null, fetchedAt: 0 };
  store.liveView[profileId] = entry;
  return entry;
}

async function fetchLiveView(profile: PublicProfile): Promise<void> {
  const port = profile.cdpPort;
  if (port == null) {
    return;
  }

  const entry = ensureEntry(profile.id);
  if (entry.loading) {
    return;
  }
  entry.loading = true;
  updateLiveViewDom(profile.id);

  try {
    const data = await profileApi().getCdpLiveView(port, {
      screenshot: store.liveViewShowScreenshot,
      targetId: store.liveActiveTab[profile.id]
    });
    store.liveView[profile.id] = { data, loading: false, error: data.error, fetchedAt: Date.now() };
  } catch (error) {
    // 端口刚关 / 浏览器退出等：保留上一帧画面，只把错误标出来。
    store.liveView[profile.id] = {
      data: store.liveView[profile.id]?.data || null,
      loading: false,
      error: formatErrorMessage(error),
      fetchedAt: Date.now()
    };
  }
  updateLiveViewDom(profile.id);
}

function updateLiveViewDom(profileId: string): void {
  const container = document.querySelector<HTMLElement>(`[data-live-view="${CSS.escape(profileId)}"]`);
  if (!container) {
    return;
  }
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return;
  }
  container.innerHTML = renderLiveViewBody(profile);
}

function renderLiveViewBody(profile: PublicProfile): string {
  const entry = store.liveView[profile.id];
  const data = entry?.data || null;
  const loading = Boolean(entry?.loading);
  const showShot = store.liveViewShowScreenshot;
  const head = renderLiveHead(loading, showShot);

  if (!data) {
    const hint = loading ? `连接 127.0.0.1:${profile.cdpPort}…` : "点「刷新」开始观测";
    return (
      head +
      `<div class="live-view-stage"><div class="live-screen ${loading ? "loading" : "empty"}"><span class="live-screen-scan" aria-hidden="true"></span><span class="live-screen-hint">${escapeHtml(hint)}</span></div></div>`
    );
  }

  if (data.error) {
    return (
      head +
      `<div class="live-view-stage">
        <div class="live-screen error">
          <span class="live-screen-hint">观测中断</span>
          <span class="live-screen-sub">${escapeHtml(data.error)}</span>
        </div>
      </div>` +
      renderLiveMeta(data, entry)
    );
  }

  return head + renderLiveScreen(data, showShot) + renderLiveTabs(data) + renderLiveMeta(data, entry);
}

function renderLiveHead(loading: boolean, showShot: boolean): string {
  return `
    <div class="live-view-head">
      <span class="live-view-kicker"><span class="live-pulse ${loading ? "loading" : ""}" aria-hidden="true"></span>Cockpit · 实时画面</span>
      <div class="live-view-actions">
        <button type="button" class="live-view-toggle ${showShot ? "on" : ""}" data-action="toggle-live-screenshot" title="${showShot ? "关闭画面截图（更省资源）" : "开启画面截图"}">画面</button>
        <button type="button" class="live-view-refresh ${loading ? "loading" : ""}" data-action="refresh-live-view" title="立即刷新这一帧">刷新</button>
      </div>
    </div>
  `;
}

function renderLiveScreen(data: CdpLiveView, showShot: boolean): string {
  const host = data.primaryUrl ? hostOf(data.primaryUrl) : "";
  const flag = host ? `<span class="live-screen-flag">▸ ${escapeHtml(host)}</span>` : "";

  if (!showShot) {
    return `<div class="live-view-stage"><div class="live-screen muted"><span class="live-screen-hint">画面已关闭</span>${flag}</div></div>`;
  }

  if (data.screenshot) {
    return `
      <div class="live-view-stage">
        <div class="live-screen">
          <img class="live-screen-img" src="${escapeHtml(data.screenshot)}" alt="当前页面画面" />
          ${flag}
        </div>
      </div>
    `;
  }

  const hint = data.screenshotError ? "画面抓取失败" : data.tabCount ? "等待画面…" : "没有打开的标签页";
  return `<div class="live-view-stage"><div class="live-screen empty"><span class="live-screen-scan" aria-hidden="true"></span><span class="live-screen-hint">${escapeHtml(hint)}</span>${flag}</div></div>`;
}

function renderLiveTabs(data: CdpLiveView): string {
  if (!data.tabCount) {
    return `<div class="live-tabs-empty">浏览器在运行，但当前没有打开的标签页。</div>`;
  }
  return `<ul class="live-tabs">${data.tabs.map(renderLiveTab).join("")}</ul>`;
}

function renderLiveTab(tab: CdpLiveTab): string {
  const host = tab.url ? hostOf(tab.url) : "";
  const favicon = tab.faviconUrl
    ? `<img class="live-tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="" onerror="this.remove()" />`
    : `<span class="live-tab-favicon empty" aria-hidden="true"></span>`;
  const copyButton = tab.url
    ? `<button type="button" class="live-tab-action" data-action="copy-live-url" data-url="${escapeHtml(tab.url)}" title="复制链接">复制</button>`
    : "";
  // 整行可点：切到这个标签（激活浏览器里的它 + 画面切过去）；复制按钮单独处理，不触发切换。
  const focusAttrs = tab.targetId
    ? ` data-action="focus-live-tab" data-target-id="${escapeHtml(tab.targetId)}" role="button" title="切到这个标签页（激活并查看画面）"`
    : "";
  return `
    <li class="live-tab ${tab.primary ? "primary" : ""}"${focusAttrs}>
      ${favicon}
      <span class="live-tab-copy">
        <span class="live-tab-title">${escapeHtml(tab.title)}</span>
        <span class="live-tab-host">${escapeHtml(host || tab.url || "")}</span>
      </span>
      ${copyButton}
    </li>
  `;
}

function renderLiveMeta(data: CdpLiveView, entry: LiveViewEntry | undefined): string {
  const time = entry?.fetchedAt ? new Date(entry.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  return `
    <div class="live-view-meta">
      <span>127.0.0.1:${escapeHtml(String(data.port))}</span>
      <span>${escapeHtml(String(data.tabCount))} 标签</span>
      ${time ? `<span>更新于 ${escapeHtml(time)}</span>` : ""}
    </div>
  `;
}

