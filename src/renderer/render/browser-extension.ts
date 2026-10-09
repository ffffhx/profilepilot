import { store } from "../state";
import { escapeHtml, renderButtonLabel } from "../util";

function extensionPresentation() {
  const profiles = (store.state?.profiles || []).filter(profile => profile.source === "native");
  const profilesPending = !store.state && !store.profileLoadError;
  const profilePlaceholder = profilesPending ? "正在读取系统 Chrome Profile…" : store.profileLoadError ? "Profile 读取失败，请重试" : "尚未发现系统 Chrome Profile";
  const selected = profiles.find(profile => profile.id === store.nativeExtensionProfileId) || profiles[0];
  const browser = store.nativeExtensionBrowsers?.find(browser => browser.profileId === selected?.id);
  const installation = store.nativeExtensionInstallations?.find(item => item.profileId === selected?.id);
  const authorization = store.nativeExtensionAuthorization?.profileId === selected?.id ? store.nativeExtensionAuthorization : null;
  const ready = Boolean(browser?.connected && browser.taskTabs && !store.nativeExtensionError);
  const loading = store.nativeExtensionLoading;
  const unknown = !store.nativeExtensionBrowsers || Boolean(store.nativeExtensionError);
  const status = profilesPending ? "正在读取系统 Chrome Profile…" : loading ? "检测中…" : unknown ? "连接状态待检测" : !selected ? profilePlaceholder
    : browser?.connected ? !browser.taskTabs ? "已连接 · 请更新或重新加载扩展"
      : browser.ownerSessionId ? browser.ownership === "agent" ? "已连接 · 任务使用中" : "已连接 · 已停止操作"
      : "已连接 · 可使用当前页"
    : browser ? "已配对 · 尚未连接" : "尚未连接";
  const message = ready ? "连接已就绪，可在 Agent 中选择这个 Profile，或通过 ppilot browser 使用。"
    : installation?.message || (authorization ? Date.parse(authorization.expiresAt) <= Date.now()
      ? "连接请求已过期，请重新点击安装并连接。"
      : "请在已打开的 Chrome 页面完成安装与授权，连接状态会自动更新。" : "");

  const pending = profilesPending || loading || unknown;
  const tone = store.nativeExtensionError || store.profileLoadError ? "blocked" : pending ? "pending" : ready ? "ready" : "blocked";
  return { profiles, profilesPending, profilePlaceholder, selected, browser, ready, loading, status, message, tone };
}

export function renderBrowserExtensionPanel(): string {
  const { profiles, profilesPending, profilePlaceholder, selected, browser, ready, loading, status, message, tone } = extensionPresentation();

  return `<section class="browser-extension-panel ${tone}" aria-labelledby="browser-extension-title" data-tools-search="ProfilePilot 浏览器扩展 Chrome 连接 Profile 安装">
    <div class="tools-extension-main">
      <span class="tools-extension-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4H5a1 1 0 0 0-1 1v4a3 3 0 1 1 0 6v4a1 1 0 0 0 1 1h4a3 3 0 1 1 6 0h4a1 1 0 0 0 1-1v-4a3 3 0 1 0 0-6V5a1 1 0 0 0-1-1h-4a3 3 0 1 0-6 0Z"/></svg></span>
      <div class="tools-extension-copy">
        <div class="tools-extension-title"><strong id="browser-extension-title">ProfilePilot 浏览器扩展</strong><span class="tools-inline-status" title="${escapeHtml(status)}">${tone === "pending" ? "检测中" : tone === "ready" ? "已连接" : "待连接"}</span></div>
        <div class="tools-extension-profile"><label for="tools-native-profile">当前使用：</label>
        <select id="tools-native-profile" ${!profiles.length || store.busy ? "disabled" : ""}>
          ${profiles.length ? profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === selected?.id ? "selected" : ""}>${escapeHtml(profile.name)} · ${escapeHtml(profile.dirName)}</option>`).join("") : `<option value="">${profilePlaceholder}</option>`}
        </select>
        </div>
        <p>复用当前页面与登录状态，随时开始任务</p>
      </div>
      <div class="browser-extension-controls">
        <button type="button" data-action="refresh-browser-extension" ${loading || store.busy ? "disabled" : ""}>${renderButtonLabel(Boolean(loading), "检测连接", "检测中…")}</button>
        <button type="button" data-action="connect-browser-extension" ${!selected || store.busy || loading ? "disabled" : ""}>${ready ? "重新连接" : browser?.connected ? "更新并连接" : browser ? "重新连接" : "安装并连接"}</button>
        <button type="button" data-action="open-browser-extension-folder" ${store.busy ? "disabled" : ""}>打开扩展目录</button>
      </div>
    </div>
    ${store.nativeExtensionError ? `<p class="browser-extension-error" role="alert">${escapeHtml(store.nativeExtensionError)}</p>` : ""}
    ${store.profileLoadError ? `<p class="browser-extension-error" role="alert">${escapeHtml(store.profileLoadError)}</p>` : ""}
    ${message && !ready ? `<p class="browser-extension-note" role="status">${escapeHtml(message)}</p>` : ""}
    <details id="tools-extension-help" class="tools-extension-help"><summary>连接说明</summary>
      <p class="browser-extension-status" role="status">${escapeHtml(status)}</p>
      <p>连接日常 Chrome 的已有页面与登录态，供 Agent 和 ppilot browser CLI 使用；也能在扩展侧边栏发起任务、附上选中文字并继续对话。</p>
      ${message && ready ? `<p>${escapeHtml(message)}</p>` : ""}
      <p>${profilesPending ? "正在读取浏览器信息，其他配套工具可先行配置。" : store.profileLoadError ? "点击“检测连接”重试。" : profiles.length ? "按安装页指引加载扩展并授权连接。手动安装时，在 chrome://extensions 中开启开发者模式，选择“加载未打包的扩展程序”，使用上方打开的固定目录。" : "请先打开系统 Chrome，然后点击“检测连接”重新发现 Profile。"}</p>
    </details>
  </section>`;
}
