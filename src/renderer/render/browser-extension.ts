import { store } from "../state";
import { escapeHtml, renderButtonLabel } from "../util";
import { nativeConnectionPresentation, nativeInstallationMessage } from "../native-connection-presentation";

function extensionPresentation() {
  const profiles = (store.state?.profiles || []).filter(profile => profile.source === "native");
  const profilesPending = !store.state && !store.profileLoadError;
  const profilePlaceholder = profilesPending ? "正在读取系统 Chrome Profile…" : store.profileLoadError ? "Profile 读取失败，请重试" : "尚未发现系统 Chrome Profile";
  const selected = profiles.find(profile => profile.id === store.nativeExtensionProfileId) || profiles[0];
  const browser = store.nativeExtensionBrowsers?.find(browser => browser.profileId === selected?.id);
  const installation = store.nativeExtensionInstallations?.find(item => item.profileId === selected?.id);
  const authorization = store.nativeExtensionAuthorization?.profileId === selected?.id ? store.nativeExtensionAuthorization : null;
  const loading = store.nativeExtensionLoading;
  const service = store.nativeExtensionService;
  let presentation = nativeConnectionPresentation(browser, service);
  if (installation) presentation = { ...presentation, message: nativeInstallationMessage(installation, browser, service) };
  else if (!browser?.connected && authorization && (!service || service.status === "connected" || service.status === "idle")) {
    presentation = { ...presentation, message: Date.parse(authorization.expiresAt) <= Date.now()
      ? "连接请求已过期，请重新点击连接按钮。"
      : "请在已打开的 Chrome 页面完成安装与授权，连接状态会自动更新。" };
  }
  if (store.nativeExtensionError || store.profileLoadError) presentation = { label: "检测失败", status: "连接状态检测失败", message: "无法确认当前连接状态，请点击“检测连接”重试。", tone: "blocked", ready: false };
  else if (profilesPending || loading || !store.nativeExtensionBrowsers) presentation = { label: "检测中…", status: profilesPending ? profilePlaceholder : "正在检测扩展连接…", message: "正在读取浏览器信息，其他配套工具可先行配置。", tone: "pending", ready: false };
  else if (!selected) presentation = { label: "未发现 Profile", status: profilePlaceholder, message: "请先打开系统 Chrome，然后点击“检测连接”重新发现 Profile。", tone: "blocked", ready: false };
  const updateRequired = Boolean(browser?.connected && !browser.taskTabs && browser.extensionVersion && Array.isArray(browser.capabilities));
  return { profiles, profilesPending, selected, browser, loading, updateRequired, ...presentation };
}

export function renderBrowserExtensionPanel(): string {
  const { profiles, profilesPending, selected, browser, ready, loading, updateRequired, label, status, message, tone } = extensionPresentation();

  return `<section class="browser-extension-panel ${tone}" aria-labelledby="browser-extension-title" data-tools-search="ProfilePilot 浏览器扩展 Chrome 连接 Profile 安装">
    <div class="tools-extension-main">
      <span class="tools-extension-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4H5a1 1 0 0 0-1 1v4a3 3 0 1 1 0 6v4a1 1 0 0 0 1 1h4a3 3 0 1 1 6 0h4a1 1 0 0 0 1-1v-4a3 3 0 1 0 0-6V5a1 1 0 0 0-1-1h-4a3 3 0 1 0-6 0Z"/></svg></span>
      <div class="tools-extension-copy">
        <div class="tools-extension-title"><strong id="browser-extension-title">ProfilePilot 浏览器扩展</strong><span class="tools-inline-status" role="status" title="${escapeHtml(status)}">${escapeHtml(label)}</span></div>
        <p>${selected ? `当前 Profile：${escapeHtml(selected.name)}。连接此 Chrome 的已有页面与登录态。` : "控制系统默认 Profile 时，需要安装此浏览器扩展。"}</p>
      </div>
      <div class="browser-extension-controls">
        <button type="button" class="tools-extension-refresh" data-action="refresh-browser-extension" aria-label="${loading ? "检测中…" : "检测连接"}" aria-busy="${Boolean(loading)}" ${loading || store.busy ? "disabled" : ""}>
          ${renderButtonLabel(Boolean(loading), "检测连接", "检测中…")}
        </button>
        <button type="button" data-action="${updateRequired ? "open-browser-extension-folder" : "connect-browser-extension"}" ${!selected || store.busy || loading ? "disabled" : ""}>${updateRequired ? "打开更新目录" : browser ? "重新连接" : "安装并连接"}</button>
        ${updateRequired ? "" : `<button type="button" data-action="open-browser-extension-folder" ${store.busy ? "disabled" : ""}>打开扩展目录</button>`}
      </div>
    </div>
    ${store.nativeExtensionError ? `<p class="browser-extension-error" role="alert">${escapeHtml(store.nativeExtensionError)}</p>` : ""}
    ${store.profileLoadError ? `<p class="browser-extension-error" role="alert">${escapeHtml(store.profileLoadError)}</p>` : ""}
    ${store.nativeExtensionService?.error ? `<p class="browser-extension-error" role="alert">${escapeHtml(store.nativeExtensionService.error)}</p>` : ""}
    ${message && !ready ? `<p class="browser-extension-note" role="status">${escapeHtml(message)}</p>` : ""}
    <details id="tools-extension-help" class="tools-extension-help"><summary>连接说明</summary>
      <p class="browser-extension-status" role="status">${escapeHtml(status)}</p>
      <p>连接日常 Chrome 的已有页面与登录态，供 Agent 和 ppilot browser CLI 使用；也能在扩展侧边栏发起任务、附上选中文字并继续对话。</p>
      ${message && ready ? `<p>${escapeHtml(message)}</p>` : ""}
      <p>${profilesPending ? "正在读取浏览器信息，其他配套工具可先行配置。" : store.profileLoadError ? "点击“检测连接”重试。" : profiles.length ? "按安装页指引加载扩展并授权连接。手动安装时，在 chrome://extensions 中开启开发者模式，选择“加载未打包的扩展程序”，使用上方打开的固定目录。" : "请先打开系统 Chrome，然后点击“检测连接”重新发现 Profile。"}</p>
    </details>
  </section>`;
}
