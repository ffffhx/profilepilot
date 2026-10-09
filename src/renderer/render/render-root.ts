import { workspaceSwitcher, workspaceIdentityBar, refreshWorkspaceSwitcher } from "../workspace-switcher";
import { pcControlTabs } from "../pc-control";
import { positionProfileMenu } from "../profile-menu-layout";
import { refreshSelectedBrowserPreview } from "./live-view";
import { isBusyAction, renderToastBody } from "../busy";
import { renderConfirmModal } from "../confirm";
import { renderControlPreferencesModal } from "../control-preferences";
import { renderSyncPanel } from "./account-sync";
import { renderAgentIntegrationPanel, renderOnboardingModal } from "./agent-integration";
import { renderClonePoolModal } from "./clone-pool";
import { renderLiveZoomModal } from "./live-view";
import { renderMini } from "./mini";
import { renderBrowserInspector } from "./browser-workspace";
import { renderBifrostProxyModal, renderCdpModal, renderCloneTagModal, renderExtensionMigrationModal, renderGlobalInstructionsModal, renderNewModal, renderRenameModal } from "./modals";
import { renderEmpty, renderExternalDetailsModal, renderProfileDetailsModal, renderProfilesPanel } from "./profiles";
import { appRoot, store } from "../state";
import { escapeHtml, renderBusyBanner, renderButtonLabel } from "../util";

// 上一次写入的主视图 HTML。事件快照或低频校准若内容没变就跳过整段 DOM 重建，
// 避免把用户正 hover 的节点换掉，导致 tooltip / :hover 状态闪烁。
let lastMainHtml = "";
function renderToast(): void {
  let toast = document.getElementById("app-toast");
  if (!store.toast) {
    toast?.remove();
    return;
  }
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.className = `toast fixed right-[18px] bottom-[18px] z-20 max-w-[min(420px,calc(100vw-36px))] border-solid border border-accent-line rounded-lg bg-[#0a1411] text-[#dcfff1] px-[14px] py-3 [box-shadow:0_18px_50px_rgba(2,6,9,0.7),var(--glow-accent)] ${store.toastKind === "error" ? "error" : ""}`;
  const body = renderToastBody(store.toast);
  if (toast.innerHTML !== body) toast.innerHTML = body;
}

export function render(): void {
  if (store.viewMode === "mini") {
    lastMainHtml = "";
    renderMini();
    return;
  }

  document.body.classList.remove("mini-mode", "mini-panel-open");
  // Toast has its own DOM lifetime. Showing/dismissing it must not rebuild a
  // form whose unsubmitted values and focus live in the current document.
  renderToast();

  if (!store.state && store.workspace !== "tools") {
    lastMainHtml = "";
    appRoot.innerHTML = '<div class="app-loading p-8 text-muted font-mono text-[13px] tracking-[0.04em]">正在载入…</div>';
    return;
  }

  const profiles = store.state?.profiles || [];
  const profileDetailsId = store.modal?.kind === "profile-details" ? store.modal.profileId : null;
  const externalDetailsDir = store.modal?.kind === "external-details" ? store.modal.userDataDir : null;
  const profileDetailsProfile = profileDetailsId
    ? profiles.find((profile) => profile.id === profileDetailsId) || null
    : null;
  const externalDetailsInstance = externalDetailsDir
    ? (store.state?.externalInstances || []).find((instance) => instance.userDataDir === externalDetailsDir) || null
    : null;
  const runningProfiles = store.state?.runningProfiles || [];
  const runningNames = runningProfiles.map((profile) => profile.name).join("、");
  const currentLabel = runningProfiles.length ? runningNames : "无";
  const currentNote = runningProfiles.length
    ? `${runningProfiles.length} 个 Profile 正在运行`
    : "当前没有正在运行的 Profile";
  const refreshing = isBusyAction("refresh");
  const busyHasEmbeddedProgress = store.busyState?.key === "account-sync" || store.busyState?.key === "migrate-extensions";

  if (store.selectedExternalDir && !store.state?.externalInstances.some(instance => instance.userDataDir === store.selectedExternalDir)) store.selectedExternalDir = null;
  if (!store.selectedExternalDir && profiles.length && !profiles.some(profile => profile.id === store.selectedId)) store.selectedId = profiles[0].id;
  const html = `
    ${workspaceSwitcher(store.workspace === "tools" ? "tools" : "browser")}
    ${workspaceIdentityBar()}
    ${store.workspace === "tools" ? `
    <div class="shell tools-workspace">
      <a class="skip-link" href="#main-content">跳到配套工具</a>
      <header class="app-header">
        <div class="browser-workspace-brand"><h1>配套工具</h1><p>连接浏览器，准备 Agent 工作环境</p></div>
        <div class="header-actions">
          <button type="button" data-action="open-onboarding">连接指南</button>
          <button class="primary" type="button" data-action="refresh-agent-integration" ${store.agentIntegrationLoading ? "disabled" : ""}>检查更新</button>
        </div>
      </header>
      ${renderBusyBanner()}
      <main id="main-content">${renderAgentIntegrationPanel()}</main>
    </div>` : !store.state ? "" : `
    <div class="shell browser-workspace">
      <a class="skip-link" href="#main-content">跳到 Profile 列表</a>
      <header class="app-header pc-control-header">
        <div class="pc-control-brand"><h1>PC 控制</h1><p>管理浏览器与桌面应用</p></div>
        <div class="header-actions">
          <button type="button" data-action="refresh" ${store.busy ? "disabled" : ""}>${renderButtonLabel(refreshing, "刷新", "刷新中…")}</button>
          <button type="button" data-action="open-onboarding" aria-label="浏览器使用指南">···</button>
        </div>
      </header>
      ${pcControlTabs("browser")}
      ${busyHasEmbeddedProgress ? "" : renderBusyBanner()}
      <section class="browser-status-strip sr-only" aria-label="Profile 状态概览">
        <span>已管理 <strong>${profiles.length}</strong></span><span>运行中 <strong>${runningProfiles.length}</strong></span>
        <span class="browser-current">${escapeHtml(currentNote)}</span>
      </section>
      <main id="main-content" class="browser-registry-layout">
        <section class="profiles-section">
          <div class="profiles-section-head"><h2>Profiles</h2></div>
          ${profiles.length || store.state.externalInstances.length ? renderProfilesPanel(profiles, store.state.externalInstances) : renderEmpty()}
        </section>
        ${renderBrowserInspector(profiles.find(profile=>profile.id === store.selectedId), store.state.externalInstances.find(instance=>instance.userDataDir === store.selectedExternalDir))}
      </main>
      ${renderSyncPanel(profiles)}
    </div>`}
    ${store.modal?.kind === "new" ? renderNewModal() : ""}
    ${store.modal?.kind === "rename" ? renderRenameModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "cdp" ? renderCdpModal(store.modal.profileId, store.modal.portSuggestion) : ""}
    ${store.modal?.kind === "bifrost-proxy" ? renderBifrostProxyModal(store.modal.profileId, store.modal.snapshot) : ""}
    ${store.modal?.kind === "clone-pool" ? renderClonePoolModal(profiles) : ""}
    ${store.modal?.kind === "clone-tag" ? renderCloneTagModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "global-instructions" ? renderGlobalInstructionsModal() : ""}
    ${store.modal?.kind === "control-preferences" ? renderControlPreferencesModal() : ""}
    ${store.modal?.kind === "onboarding" ? renderOnboardingModal() : ""}
    ${
      store.modal?.kind === "profile-details"
        ? renderProfileDetailsModal(profileDetailsProfile)
        : ""
    }
    ${
      store.modal?.kind === "external-details"
        ? renderExternalDetailsModal(externalDetailsInstance)
        : ""
    }
    ${store.modal?.kind === "live-zoom" ? renderLiveZoomModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "extension-migration" ? renderExtensionMigrationModal(profiles) : ""}
    ${store.modal?.kind === "confirm" ? renderConfirmModal(store.modal) : ""}
  `;

  // 内容没变就别重刷 DOM：避免状态快照把正 hover 的节点换掉，造成 tooltip / :hover 闪烁。
  if (lastMainHtml === html) {
    return;
  }
  lastMainHtml = html;
  // Preserve an unsaved rename across busy/status/toast renders of the same form.
  const renameForm = appRoot.querySelector<HTMLFormElement>("[data-rename-form]");
  const renameInput = renameForm?.querySelector<HTMLInputElement>("#profile-rename");
  const renameDraft = store.modal?.kind === "rename" && renameForm?.dataset.profileId === store.modal.profileId
    ? renameInput?.value : undefined;
  const expandedTools = [...appRoot.querySelectorAll<HTMLDetailsElement>(".tools-workspace details[id][open]")].map(node => node.id);
  const preferencesInput = appRoot.querySelector<HTMLTextAreaElement>("#control-preferences-editor");
  const preferencesFocus = preferencesInput && store.modal?.kind === "control-preferences" && preferencesInput.dataset.domain === store.modal.activeTab && document.activeElement === preferencesInput
    ? { start: preferencesInput.selectionStart, end: preferencesInput.selectionEnd, direction: preferencesInput.selectionDirection, scroll: preferencesInput.scrollTop } : null;
  const preferencesLocationOpen = appRoot.querySelector<HTMLDetailsElement>(".control-preferences-location")?.open;
  appRoot.className = "";
  appRoot.innerHTML = html;
  refreshWorkspaceSwitcher();
  refreshSelectedBrowserPreview();
  positionProfileMenu();
  expandedTools.forEach(id => { const node = document.getElementById(id); if (node instanceof HTMLDetailsElement) node.open = true; });
  if (preferencesLocationOpen) {
    const location = appRoot.querySelector<HTMLDetailsElement>(".control-preferences-location");
    if (location) location.open = true;
  }
  if (preferencesFocus) {
    const input = appRoot.querySelector<HTMLTextAreaElement>("#control-preferences-editor");
    if (input && !input.disabled) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(preferencesFocus.start, preferencesFocus.end, preferencesFocus.direction);
      input.scrollTop = preferencesFocus.scroll;
    }
  }
  if (renameDraft !== undefined) {
    const input = appRoot.querySelector<HTMLInputElement>("#profile-rename");
    if (input) input.value = renameDraft;
  }
}
