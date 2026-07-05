import { isBusyAction, renderToastBody } from "../busy";
import { renderConfirmModal } from "../confirm";
import { renderSyncPanel } from "./account-sync";
import { renderClonePoolModal } from "./clone-pool";
import { renderLiveZoomModal } from "./live-view";
import { renderMini } from "./mini";
import { renderCdpModal, renderCloneTagModal, renderExtensionMigrationModal, renderGlobalInstructionsModal, renderNewModal, renderRenameModal } from "./modals";
import { renderDetails, renderEmpty, renderExternalDetails, renderProfilesPanel } from "./profiles";
import { appRoot, store } from "../state";
import { escapeHtml, renderBusyBanner, renderButtonLabel } from "../util";

export function render(): void {
  if (store.viewMode === "mini") {
    renderMini();
    return;
  }

  document.body.classList.remove("mini-mode", "mini-panel-open");

  if (!store.state) {
    appRoot.innerHTML = '<div class="app-loading p-8 text-muted font-mono text-[13px] tracking-[0.08em] uppercase">Loading...</div>';
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
    <div class="shell w-[min(1760px,calc(100vw-clamp(24px,3vw,56px)))] mx-auto my-0 pt-[28px] px-0 pb-[40px]">
      <header class="app-header flex items-start justify-between gap-5 pt-2 px-0 pb-[22px] border-solid border-b border-line">
        <div class="brand-lockup flex items-center gap-4 min-w-0">
          <img class="brand-mark w-[58px] h-[58px] flex-[0_0_auto] rounded-[14px] [box-shadow:0_0_0_1px_rgba(56,225,160,0.25),0_12px_32px_rgba(2,6,9,0.55),var(--glow-accent)]" src="./assets/profilepilot-mark.svg" alt="" />
          <div class="brand-copy min-w-0">
            <p class="eyebrow flex items-center gap-2 mt-0 mb-2 mx-0 text-accent font-mono text-[11px] font-semibold tracking-[0.22em] uppercase">Browser Profile Desk</p>
            <h1>ProfilePilot</h1>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" data-action="open-mini-window" title="切换到悬浮窗">悬浮窗</button>
          <button type="button" data-action="open-global-instructions">全局指令</button>
          <button type="button" class="${refreshing ? "loading" : ""}" data-action="refresh" ${store.busy ? "disabled" : ""}>
            ${renderButtonLabel(refreshing, "刷新", "刷新中…")}
          </button>
          <button type="button" class="primary" data-action="new-profile" ${store.busy ? "disabled" : ""}>新建独立 Profile</button>
        </div>
      </header>

      ${busyHasEmbeddedProgress ? "" : renderBusyBanner()}

      <section class="status-grid grid grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(130px,0.7fr))] gap-px overflow-hidden border-solid border border-line rounded-xl bg-line mt-[22px] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.04),0_18px_44px_rgba(2,6,9,0.4)]" aria-label="Profile status">
        <div class="status-item current relative min-w-0 pt-4 pr-4 pb-4 pl-5 bg-panel">
          <span class="status-label block mb-2 text-muted font-mono text-[11px] font-semibold tracking-[0.16em] uppercase">当前运行</span>
          <strong class="status-value block [overflow-wrap:anywhere] font-display text-[21px] font-semibold tabular-nums tracking-[0.01em]">${escapeHtml(currentLabel)}</strong>
          <span class="status-note block mt-2 [overflow-wrap:anywhere] text-muted text-[12px]">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item relative min-w-0 pt-4 pr-4 pb-4 pl-5 bg-panel">
          <span class="status-label block mb-2 text-muted font-mono text-[11px] font-semibold tracking-[0.16em] uppercase">Profiles</span>
          <strong class="status-value block [overflow-wrap:anywhere] font-display text-[21px] font-semibold tabular-nums tracking-[0.01em]">${profiles.length}</strong>
          <span class="status-note block mt-2 [overflow-wrap:anywhere] text-muted text-[12px]">本机所有可管理的 Chrome Profile</span>
        </div>
        <div class="status-item relative min-w-0 pt-4 pr-4 pb-4 pl-5 bg-panel">
          <span class="status-label block mb-2 text-muted font-mono text-[11px] font-semibold tracking-[0.16em] uppercase">运行中</span>
          <strong class="status-value block [overflow-wrap:anywhere] font-display text-[21px] font-semibold tabular-nums tracking-[0.01em]">${store.state.runningProfiles.length}</strong>
          <span class="status-note block mt-2 [overflow-wrap:anywhere] text-muted text-[12px]">可以点击“显示”拉到屏幕最前面</span>
        </div>
      </section>

      ${renderSyncPanel(profiles)}

      <main class="layout grid grid-cols-[minmax(0,1fr)_minmax(320px,360px)] gap-6 mt-6 items-start">
        <section>
          <div class="section-head flex items-center justify-between gap-[14px] mb-3">
            <h2>Profiles</h2>
            <span class="count border-solid border border-line-strong rounded-full px-2.5 py-1 text-muted font-mono text-[11px] font-semibold tabular-nums">${profiles.length}</span>
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
    ${store.modal?.kind === "cdp" ? renderCdpModal(store.modal.profileId, store.modal.portSuggestion) : ""}
    ${store.modal?.kind === "clone-pool" ? renderClonePoolModal(profiles) : ""}
    ${store.modal?.kind === "clone-tag" ? renderCloneTagModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "global-instructions" ? renderGlobalInstructionsModal() : ""}
    ${store.modal?.kind === "live-zoom" ? renderLiveZoomModal(store.modal.profileId) : ""}
    ${store.modal?.kind === "extension-migration" ? renderExtensionMigrationModal(profiles) : ""}
    ${store.modal?.kind === "confirm" ? renderConfirmModal(store.modal) : ""}
    ${store.toast ? `<div class="toast fixed right-[18px] bottom-[18px] z-20 max-w-[min(420px,calc(100vw-36px))] border-solid border border-accent-line rounded-lg bg-[#0a1411] text-[#dcfff1] px-[14px] py-3 [box-shadow:0_18px_50px_rgba(2,6,9,0.7),var(--glow-accent)] ${store.toastKind === "error" ? "error" : ""}" role="status">${renderToastBody(store.toast)}</div>` : ""}
  `;
}
