import { profileApi } from "../api";
import { workspaceHidden } from "../workspace-lifecycle";
import { LiveViewEntry, store } from "../state";
import { CdpLiveTab, CdpLiveView, PublicProfile } from "../types";
import { escapeHtml, formatErrorMessage, hostOf } from "../util";

// 只刷新可见工作区选中的 Profile，不抢浏览器焦点。
const LIVE_VIEW_INTERVAL_MS = 2500;

let liveViewTimer: number | null = null;

// 系统 Profile 走已配对扩展，独立 Profile 走自身 CDP。
export function liveViewEligible(profile: PublicProfile): boolean {
  return profile.source === "native"
    ? Boolean(store.nativeExtensionBrowsers?.some(item => item.profileId === profile.id && item.connected))
    : profile.running && profile.cdpPort != null;
}

export function renderBrowserPreview(profile: PublicProfile): string {
  const entry = store.liveView[profile.id];
  const data = entry?.data;
  const eligible = liveViewEligible(profile);
  const error = entry?.error || data?.error || data?.screenshotError;
  const shot = eligible && !error ? data?.screenshot : null;
  const hint = !eligible
    ? profile.source === "native" ? "到配套工具连接扩展后查看画面" : !profile.running ? "启动浏览器后显示实时画面" : "以 CDP 启动后查看画面"
    : error || (data && !data.tabCount ? "没有打开的标签页" : "正在获取画面…");
  const updated = entry?.fetchedAt ? new Date(entry.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  return `<div class="browser-preview-heading"><h3>实时画面</h3>${shot ? '<span>单击放大</span>' : ""}</div>
    ${shot ? `<button type="button" class="browser-preview-screen" data-action="open-live-zoom" data-id="${escapeHtml(profile.id)}" aria-label="放大实时画面"><img src="${escapeHtml(shot)}" alt="${escapeHtml(data?.primaryTitle || "浏览器当前页面")}" /></button>` : `<div class="browser-preview-empty" role="status">${escapeHtml(hint)}</div>`}
    <p class="browser-preview-caption">${shot ? `${escapeHtml(data?.primaryTitle || "当前页面")}<small>更新于 ${escapeHtml(updated)} · 每 2.5 秒刷新</small>` : ""}</p>`;
}

export function refreshSelectedBrowserPreview(): void {
  // Keep image frames out of render-root's HTML comparison. Incoming frames
  // should update this section without rebuilding the Profile list or menus.
  const selected = store.state?.profiles.find(profile => profile.id === store.selectedId);
  if (selected && store.workspace === "browser" && !store.selectedExternalDir) updateLiveViewDom(selected.id);
  const profile = currentLiveProfile();
  if (!profile || !canRefreshLiveView()) return;
  const entry = store.liveView[profile.id];
  if (!entry?.loading && (!entry || Date.now() - entry.fetchedAt >= LIVE_VIEW_INTERVAL_MS)) void fetchLiveView(profile);
}

function canRefreshLiveView(): boolean {
  return store.viewMode === "main" && !store.busy && !workspaceHidden() &&
    (!store.modal || store.modal.kind === "profile-details" || store.modal.kind === "live-zoom");
}

// 详情弹窗里的实时观测区块。外层带 data-live-view=profileId，轮询时只换内部 body，
// 不触发全量 render，避免截图和滚动跳动。不满足条件返回空串（系统 / 未运行 / 无 CDP）。
export function renderLiveViewSection(profile: PublicProfile): string {
  if (!liveViewEligible(profile)) {
    return "";
  }
  return `<section class="live-view" data-live-view="${escapeHtml(profile.id)}">${renderLiveViewBody(profile)}</section>`;
}

// 右侧预览和放大层共用一个循环，仅可见时抓帧。
export function startLiveViewLoop(): void {
  if (liveViewTimer !== null) {
    return;
  }
  liveViewTimer = window.setInterval(() => {
    refreshSelectedBrowserPreview();
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
  requestLiveViewNow(activeLiveProfileId());
}

export function toggleLiveScreenshot(): void {
  store.liveViewShowScreenshot = !store.liveViewShowScreenshot;
  const profileId = activeLiveProfileId();
  if (profileId) {
    // 先反映按钮态（截图开/关），再按新设置重新拉一帧。
    updateLiveViewDom(profileId);
    requestLiveViewNow(profileId);
  }
}

// 点 Cockpit 标签列表里的某一项：只切换弹窗正在观测的标签和实时画面。
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
  const profileId = activeLiveProfileId();
  if (!store.state || !profileId) {
    return null;
  }
  const profile = store.state.profiles.find((item) => item.id === profileId);
  return profile && liveViewEligible(profile) ? profile : null;
}

function activeLiveProfileId(): string | null {
  if (store.modal?.kind === "profile-details" || store.modal?.kind === "live-zoom") {
    return store.modal.profileId;
  }
  return store.workspace === "browser" && !store.selectedExternalDir ? store.selectedId : null;
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
  if (profile.source !== "native" && port == null) {
    return;
  }

  const entry = ensureEntry(profile.id);
  if (entry.loading) {
    return;
  }
  entry.loading = true;
  updateLiveViewDom(profile.id);

  try {
    const targetId = store.liveActiveTab[profile.id] || profile.gatewayControl?.agentTarget?.targetId;
    const data = profile.source === "native" ? await window.tasks.getNativeLiveView(profile.id) : await profileApi().getCdpLiveView(port!, {
      screenshot: store.modal?.kind === "profile-details" ? store.liveViewShowScreenshot : true,
      targetId
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
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return;
  }
  if (container) {
    container.innerHTML = renderLiveViewBody(profile);
  }
  const preview = document.querySelector<HTMLElement>(`[data-browser-preview="${CSS.escape(profileId)}"]`);
  if (preview) {
    const focused = document.activeElement === preview.querySelector('.browser-preview-screen');
    preview.innerHTML = renderBrowserPreview(profile);
    if (focused) preview.querySelector<HTMLButtonElement>('.browser-preview-screen')?.focus({ preventScroll: true });
  }
  updateLiveZoomDom(profileId);
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

  return head + renderLiveScreen(profile.id, data, showShot) + renderLiveTabs(profile.id, data) + renderLiveMeta(data, entry);
}

function renderLiveHead(loading: boolean, showShot: boolean): string {
  return `
    <div class="live-view-head">
      <span class="live-view-kicker"><span class="live-pulse ${loading ? "loading" : ""}" aria-hidden="true"></span>浏览器预览</span>
      <div class="live-view-actions">
        <button type="button" class="live-view-toggle ${showShot ? "on" : ""}" data-action="toggle-live-screenshot" title="${showShot ? "关闭画面截图（更省资源）" : "开启画面截图"}">画面</button>
        <button type="button" class="live-view-refresh ${loading ? "loading" : ""}" data-action="refresh-live-view" title="立即刷新这一帧">刷新</button>
      </div>
    </div>
  `;
}

function renderLiveScreen(profileId: string, data: CdpLiveView, showShot: boolean): string {
  const host = data.primaryUrl ? hostOf(data.primaryUrl) : "";
  const flag = host ? `<span class="live-screen-flag">▸ ${escapeHtml(host)}</span>` : "";

  if (!showShot) {
    return `<div class="live-view-stage"><div class="live-screen muted"><span class="live-screen-hint">画面已关闭</span>${flag}</div></div>`;
  }

  if (data.screenshot) {
    return `
      <div class="live-view-stage">
        <div class="live-screen zoomable" data-action="open-live-zoom" data-id="${escapeHtml(profileId)}" data-live-zoom-profile-id="${escapeHtml(profileId)}" role="button" tabindex="0" aria-label="放大实时画面" title="单击放大实时画面">
          <img class="live-screen-img" src="${escapeHtml(data.screenshot)}" alt="当前页面画面" />
          ${flag}
        </div>
      </div>
    `;
  }

  const hint = data.screenshotError ? "画面抓取失败" : data.tabCount ? "等待画面…" : "没有打开的标签页";
  return `<div class="live-view-stage"><div class="live-screen empty"><span class="live-screen-scan" aria-hidden="true"></span><span class="live-screen-hint">${escapeHtml(hint)}</span>${flag}</div></div>`;
}

export function openLiveZoom(profileId: string | null): void {
  if (!profileId || !store.liveView[profileId]?.data?.screenshot) {
    return;
  }
  store.modal = {
    kind: "live-zoom",
    profileId,
    returnTo: store.modal?.kind === "profile-details" ? "profile-details" : undefined
  };
}

export function renderLiveZoomModal(profileId: string): string {
  return `
    <div class="modal-backdrop live-zoom-backdrop" data-action="close-modal">
      <section class="live-zoom-modal" data-live-zoom-modal="${escapeHtml(profileId)}" role="dialog" aria-modal="true" aria-labelledby="live-zoom-title">
        ${renderLiveZoomContent(profileId)}
      </section>
    </div>
  `;
}

function updateLiveZoomDom(profileId: string): void {
  if (store.modal?.kind !== "live-zoom" || store.modal.profileId !== profileId) {
    return;
  }
  const container = document.querySelector<HTMLElement>(`[data-live-zoom-modal="${CSS.escape(profileId)}"]`);
  if (container) {
    const closeFocused = document.activeElement === container.querySelector('[data-action="close-modal"]');
    container.innerHTML = renderLiveZoomContent(profileId);
    if (closeFocused) container.querySelector<HTMLButtonElement>('[data-action="close-modal"]')?.focus({ preventScroll: true });
  }
}

function renderLiveZoomContent(profileId: string): string {
  const entry = store.liveView[profileId];
  const data = entry?.data || null;
  const profile = store.state?.profiles.find((item) => item.id === profileId);
  const title = data?.primaryTitle || profile?.name || "实时画面";
  const host = data?.primaryUrl ? hostOf(data.primaryUrl) : "";
  const flag = host ? `<span>▸ ${escapeHtml(host)}</span>` : "";
  const port = data?.port ? `<span>127.0.0.1:${escapeHtml(String(data.port))}</span>` : "";
  const tabCount = data?.tabCount !== undefined ? `<span>${escapeHtml(String(data.tabCount))} 标签</span>` : "";

  if (!data?.screenshot || entry?.error || data.error || data.screenshotError || !profile || !liveViewEligible(profile)) {
    return `
      <div class="live-zoom-head">
        <div class="live-zoom-title">
          <span>浏览器预览</span>
          <h2 id="live-zoom-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
        </div>
        <button type="button" data-action="close-modal">关闭</button>
      </div>
      <div class="live-zoom-empty">${escapeHtml(entry?.error || data?.error || data?.screenshotError || "当前没有可放大的画面")}</div>
    `;
  }

  return `
    <div class="live-zoom-head">
      <div class="live-zoom-title">
        <span>浏览器预览</span>
        <h2 id="live-zoom-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
      </div>
      <button type="button" data-action="close-modal">关闭</button>
    </div>
    <div class="live-zoom-frame" data-live-zoom-frame title="双击关闭">
      <img src="${escapeHtml(data.screenshot)}" alt="放大的当前页面画面" />
    </div>
    <div class="live-zoom-meta">
      ${flag}
      ${port}
      ${tabCount}
    </div>
  `;
}

function renderLiveTabs(profileId: string, data: CdpLiveView): string {
  if (!data.tabCount) {
    return `<div class="live-tabs-empty">浏览器在运行，但当前没有打开的标签页。</div>`;
  }
  return `<ul class="live-tabs">${data.tabs.map((tab) => renderLiveTab(profileId, tab)).join("")}</ul>`;
}

function renderLiveTab(profileId: string, tab: CdpLiveTab): string {
  const host = tab.url ? hostOf(tab.url) : "";
  const favicon = tab.faviconUrl
    ? `<img class="live-tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="" onerror="this.remove()" />`
    : `<span class="live-tab-favicon empty" aria-hidden="true"></span>`;
  const copyButton = tab.url
    ? `<button type="button" class="live-tab-action" data-action="copy-live-url" data-url="${escapeHtml(tab.url)}" title="复制链接">复制</button>`
    : "";
  // 整行可点：只切换弹窗正在观测的标签与画面，不把 Chrome 抢到前台；复制按钮单独处理。
  const focusAttrs = tab.targetId
    ? ` data-action="focus-live-tab" data-profile-id="${escapeHtml(profileId)}" data-target-id="${escapeHtml(tab.targetId)}" role="button" tabindex="0" title="在弹窗中查看这个标签页"`
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
