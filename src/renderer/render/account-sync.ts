import { isBusyAction } from "../busy";
import { store } from "../state";
import { PublicProfile } from "../types";
import { escapeHtml, formatDate, profileStatusLabel, renderButtonLabel, renderOperationProgress, sourceLabel } from "../util";

// 合并同步面板：账号登录态 + 插件共用一对源/目标 Profile，
// 默认两项都同步，也可以只勾其中一项。
export function renderSyncPanel(profiles: PublicProfile[]): string {
  const sourceId = store.accountSyncSourceId || profiles[0]?.id || "";
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const targetId =
    store.accountSyncTargetId && store.accountSyncTargetId !== sourceId
      ? store.accountSyncTargetId
      : profiles.find((profile) => profile.id !== sourceId)?.id || "";
  const targetProfile = profiles.find((profile) => profile.id === targetId) || null;
  const runningBlocker = targetProfile?.running ? targetProfile : null;
  const partAccount = store.syncAccountPart;
  const partExtensions = store.syncExtensionsPart;
  const canSync = Boolean(sourceProfile && targetProfile && sourceProfile.id !== targetProfile.id) && (partAccount || partExtensions);
  const syncingAccount = isBusyAction("account-sync");
  const syncButtonLabel = "同步";
  const syncingLabel = runningBlocker ? "关闭并同步中…" : "同步中…";
  const launchLabel = runningBlocker ? "同步后重新启动并恢复标签页" : "同步后启动目标";
  const cancelRequested = Boolean(syncingAccount && store.busyState?.cancelRequested);
  const pausedAccountSync = Boolean(syncingAccount && store.busyState?.paused);

  return `
    <section class="account-sync-panel" data-account-sync aria-busy="${syncingAccount ? "true" : "false"}">
      <div class="section-head">
        <div>
          <h2>同步</h2>
          <span class="section-subtitle block mt-1 text-muted text-[12px] leading-[1.45]">同步登录态与插件，并按需启动目标 Profile</span>
        </div>
        <button type="button" class="primary agent-browser-cta" data-action="open-agent-browser-setup" ${store.busy ? "disabled" : ""}>
          创建 Agent 浏览器
        </button>
      </div>

      <div class="account-sync-layout grid grid-cols-[minmax(420px,1fr)_minmax(360px,auto)] gap-4 items-end mt-[14px] ${syncingAccount ? "syncing" : ""}">
        <div class="account-sync-fields grid grid-cols-[repeat(2,minmax(210px,1fr))] gap-3 min-w-0">
          <div class="field grid gap-2 my-[18px] compact">
            <span class="picker-label" id="account-sync-source-label">源 Profile</span>
            ${renderAccountSyncPicker("source", profiles, sourceId)}
          </div>
          <div class="field grid gap-2 my-[18px] compact">
            <span class="picker-label" id="account-sync-target-label">目标 Profile</span>
            ${renderAccountSyncPicker("target", profiles, targetId, sourceId)}
          </div>
        </div>

        <div class="account-sync-controls grid gap-2.5 justify-items-end min-w-0">
          <div class="account-sync-options flex items-center justify-end gap-2.5 min-w-0 flex-wrap [row-gap:6px]">
            <label class="check-control self-end">
              <input type="checkbox" data-sync-part-account ${partAccount ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>账号登录态</span>
            </label>
            <label class="check-control self-end">
              <input type="checkbox" data-sync-part-extensions ${partExtensions ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>插件</span>
            </label>
            <label class="check-control account-sync-launch self-end">
              <input type="checkbox" data-launch-synced-profile ${store.launchSyncedProfile ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>${launchLabel}</span>
            </label>
          </div>

          <div class="account-sync-actions flex items-center justify-end gap-2.5 min-w-0 flex-nowrap">
            <button type="button" class="primary ${syncingAccount ? "loading" : ""}" data-action="run-sync" ${store.busy || !canSync ? "disabled" : ""}>
              ${renderButtonLabel(syncingAccount, syncButtonLabel, syncingLabel)}
            </button>
            ${
              syncingAccount
                ? `<button type="button" class="action-button account-sync-pause ${pausedAccountSync ? "accent" : "cdp"}" data-action="toggle-account-sync-pause" ${cancelRequested ? "disabled" : ""}>
                    ${pausedAccountSync ? "继续同步" : "暂停同步"}
                  </button>
                  <button type="button" class="action-button warn account-sync-cancel ${cancelRequested ? "loading" : ""}" data-action="cancel-account-sync" ${cancelRequested ? "disabled" : ""}>
                    ${renderButtonLabel(cancelRequested, "终止同步", "正在终止…")}
                  </button>`
                : ""
            }
          </div>
        </div>
      </div>

      ${syncingAccount ? renderAccountSyncLoading(sourceProfile, targetProfile) : ""}
    </section>
  `;
}

export function renderAccountSyncLoading(sourceProfile: PublicProfile | null, targetProfile: PublicProfile | null): string {
  const sourceName = sourceProfile?.name || "源 Profile";
  const targetName = targetProfile?.name || "目标 Profile";
  return renderOperationProgress("account-sync", `账号同步：${sourceName} 到 ${targetName}`);
}

export function renderAccountSyncPicker(
  kind: "source" | "target",
  profiles: PublicProfile[],
  selectedProfileId: string,
  excludedProfileId?: string
): string {
  const options = profiles.filter((profile) => profile.id !== excludedProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || null;
  const disabled = store.busy || (kind === "source" ? !profiles.length : profiles.length < 2);
  const expanded = store.accountSyncMenuOpen === kind && options.length > 0 && !disabled;
  const labelId = `account-sync-${kind}-label`;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-account-sync-select="${kind}">
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-account-sync-menu"
        data-kind="${kind}"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="${labelId}"
        ${disabled ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${expanded ? renderAccountSyncMenu(kind, options, selectedProfileId, labelId) : ""}
    </div>
  `;
}

export function renderAccountSyncMenu(
  kind: "source" | "target",
  options: PublicProfile[],
  selectedProfileId: string,
  labelId: string
): string {
  return `
    <div class="profile-select-menu" role="listbox" aria-labelledby="${labelId}">
      ${options.map((profile) => renderAccountSyncOption(kind, profile, selectedProfileId)).join("")}
    </div>
  `;
}

export function renderAccountSyncOption(kind: "source" | "target", profile: PublicProfile, selectedProfileId: string): string {
  const selected = profile.id === selectedProfileId;

  return `
    <button
      type="button"
      class="profile-select-option ${selected ? "selected" : ""}"
      data-action="select-account-sync-profile"
      data-kind="${kind}"
      data-id="${escapeHtml(profile.id)}"
      role="option"
      aria-selected="${selected ? "true" : "false"}"
      ${store.busy ? "disabled" : ""}
    >
      <span class="profile-select-option-main">
        <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
        <strong>${escapeHtml(profile.name)}</strong>
        ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
      </span>
      <span class="profile-select-option-meta">
        ${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${formatDate(profile.lastLaunchedAt)}
      </span>
    </button>
  `;
}
