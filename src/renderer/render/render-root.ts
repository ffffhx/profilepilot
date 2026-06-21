import { isBusyAction, renderToastBody } from "../busy";
import { renderConfirmModal } from "../confirm";
import { renderAccountSyncPanel } from "./account-sync";
import { renderExtensionMigrationPanel } from "./extensions";
import { renderAgentBrowserSetupModal, renderAgentConfigModal, renderCdpModal, renderExtensionMigrationModal, renderNewModal, renderRenameModal } from "./modals";
import { renderDetails, renderEmpty, renderExternalDetails, renderProfilesPanel } from "./profiles";
import { appRoot, store } from "../state";
import { escapeHtml, renderBusyBanner, renderButtonLabel } from "../util";

export function render(): void {
  if (!store.state) {
    appRoot.innerHTML = '<div class="app-loading">Loading...</div>';
    return;
  }

  const profiles = store.state.profiles || [];
  const selected = profiles.find((profile) => profile.id === store.selectedId) || null;
  const selectedExternal =
    (store.state.externalInstances || []).find((instance) => instance.userDataDir === store.selectedExternalDir) || null;
  const runningNames = store.state.runningProfiles.map((profile) => profile.name).join("、");
  const currentLabel = store.state.runningProfiles.length ? runningNames : "无";
  const currentNote = store.state.runningProfiles.length
    ? `${store.state.runningProfiles.length} 个 Profile 正在运行`
    : "当前没有正在运行的 Profile";
  const refreshing = isBusyAction("refresh");
  const busyHasEmbeddedProgress = store.busyState?.key === "account-sync" || store.busyState?.key === "migrate-extensions";

  appRoot.className = "";
  appRoot.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div class="brand-lockup">
          <img class="brand-mark" src="./assets/profilepilot-mark.svg" alt="" />
          <div class="brand-copy">
            <p class="eyebrow">Browser Profile Desk</p>
            <h1>ProfilePilot</h1>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="${refreshing ? "loading" : ""}" data-action="refresh" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(refreshing, "刷新", "刷新中…")}
          </button>
          <button type="button" class="primary" data-action="new-profile" ${store.busy ? "disabled" : ""}>新建独立 Profile</button>
        </div>
      </header>

      ${busyHasEmbeddedProgress ? "" : renderBusyBanner()}

      <section class="status-grid" aria-label="Profile status">
        <div class="status-item current">
          <span class="status-label">当前运行</span>
          <strong class="status-value">${escapeHtml(currentLabel)}</strong>
          <span class="status-note">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Profiles</span>
          <strong class="status-value">${profiles.length}</strong>
          <span class="status-note">本机所有可管理的 Chrome Profile</span>
        </div>
        <div class="status-item">
          <span class="status-label">运行中</span>
          <strong class="status-value">${store.state.runningProfiles.length}</strong>
          <span class="status-note">可以点击“显示”拉到屏幕最前面</span>
        </div>
      </section>

      ${renderAccountSyncPanel(profiles)}
      ${renderExtensionMigrationPanel(profiles)}

      <main class="layout">
        <section>
          <div class="section-head">
            <h2>Profiles</h2>
            <span class="count">${profiles.length}</span>
          </div>
          ${
            profiles.length || (store.state.externalInstances?.length ?? 0)
              ? renderProfilesPanel(profiles, store.state.externalInstances || [])
              : renderEmpty()
          }
        </section>
        ${selectedExternal ? renderExternalDetails(selectedExternal) : renderDetails(selected)}
      </main>
    </div>
    ${store.modal?.kind === "new" ? renderNewModal() : ""}
    ${store.modal?.kind === "rename" ? renderRenameModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "cdp" ? renderCdpModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "agent-config" ? renderAgentConfigModal(store.modal.profileId, store.modal.portSuggestion) : ""}
    ${store.modal?.kind === "agent-browser-setup" ? renderAgentBrowserSetupModal(store.modal.portSuggestion) : ""}
    ${store.modal?.kind === "extension-migration" ? renderExtensionMigrationModal(profiles) : ""}
    ${store.modal?.kind === "confirm" ? renderConfirmModal(store.modal) : ""}
    ${store.toast ? `<div class="toast ${store.toastKind === "error" ? "error" : ""}" role="status">${renderToastBody(store.toast)}</div>` : ""}
  `;
}
