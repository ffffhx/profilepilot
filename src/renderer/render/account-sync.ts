import { isBusyAction } from "../busy";
import { store } from "../state";
import { AccountSyncRecord, AccountSyncResult, AccountSyncSkippedItem, PublicProfile } from "../types";
import { escapeHtml, formatDate, profileStatusLabel, renderButtonLabel, renderOperationProgress, sourceLabel } from "../util";

export function renderAccountSyncPanel(profiles: PublicProfile[]): string {
  const sourceId = store.accountSyncSourceId || profiles[0]?.id || "";
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const targetId =
    store.accountSyncTargetId && store.accountSyncTargetId !== sourceId
      ? store.accountSyncTargetId
      : profiles.find((profile) => profile.id !== sourceId)?.id || "";
  const targetProfile = profiles.find((profile) => profile.id === targetId) || null;
  const runningBlocker = targetProfile?.running ? targetProfile : null;
  const canSync = Boolean(sourceProfile && targetProfile && sourceProfile.id !== targetProfile.id);
  const syncingAccount = isBusyAction("account-sync");
  const accountSyncRecord =
    store.state?.accountSyncRecords.find((record) => record.sourceProfileId === sourceId && record.targetProfileId === targetId) ||
    null;
  const syncButtonLabel = "同步";
  const syncingLabel = runningBlocker ? "关闭并同步中…" : "同步中…";
  const launchLabel = runningBlocker ? "同步后重新启动并恢复标签页" : "同步后启动目标";
  const cancelRequested = Boolean(syncingAccount && store.busyState?.cancelRequested);
  const pausedAccountSync = Boolean(syncingAccount && store.busyState?.paused);

  return `
    <section class="account-sync-panel" data-account-sync aria-busy="${syncingAccount ? "true" : "false"}">
      <div class="section-head">
        <div>
          <h2>账号同步</h2>
          <span class="section-subtitle">Account session</span>
        </div>
        <button type="button" class="primary agent-browser-cta" data-action="open-agent-browser-setup" ${store.busy ? "disabled" : ""}>
          ⚡ 一键造 Agent 浏览器
        </button>
      </div>

      <div class="account-sync-layout grid grid-cols-[minmax(420px,1fr)_minmax(360px,auto)] gap-4 items-end mt-[14px] ${syncingAccount ? "syncing" : ""}">
        <div class="account-sync-fields grid grid-cols-[repeat(2,minmax(210px,1fr))] gap-3 min-w-0">
          <div class="field compact">
            <span class="picker-label" id="account-sync-source-label">源 Profile</span>
            ${renderAccountSyncPicker("source", profiles, sourceId)}
          </div>
          <div class="field compact">
            <span class="picker-label" id="account-sync-target-label">目标 Profile</span>
            ${renderAccountSyncPicker("target", profiles, targetId, sourceId)}
          </div>
        </div>

        <div class="account-sync-controls grid gap-2.5 justify-items-end min-w-0">
          <div class="account-sync-options flex items-center justify-end gap-2.5 min-w-0 flex-wrap [row-gap:6px]">
            <label class="check-control account-sync-launch self-end">
              <input type="checkbox" data-launch-synced-profile ${store.launchSyncedProfile ? "checked" : ""} ${store.busy ? "disabled" : ""} />
              <span>${launchLabel}</span>
            </label>
          </div>

          <div class="account-sync-actions flex items-center justify-end gap-2.5 min-w-0 flex-nowrap">
            <button type="button" class="primary ${syncingAccount ? "loading" : ""}" data-action="sync-account" ${store.busy || !canSync ? "disabled" : ""}>
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

      <div class="account-sync-note mt-2.5 text-muted text-[12px] font-semibold leading-[1.45]">
        ${escapeHtml(accountSyncNote(sourceProfile, targetProfile, accountSyncRecord))}
      </div>

      ${renderAccountSyncScopeToggle()}
      ${store.accountSyncScopeExpanded ? renderAccountSyncScope() : ""}

      ${store.accountSyncResult ? renderAccountSyncResult(store.accountSyncResult) : ""}
    </section>
  `;
}

export function renderAccountSyncLoading(sourceProfile: PublicProfile | null, targetProfile: PublicProfile | null): string {
  const sourceName = sourceProfile?.name || "源 Profile";
  const targetName = targetProfile?.name || "目标 Profile";
  return renderOperationProgress("account-sync", `账号同步：${sourceName} 到 ${targetName}`);
}

export function accountSyncNote(
  sourceProfile: PublicProfile | null,
  targetProfile: PublicProfile | null,
  accountSyncRecord: AccountSyncRecord | null
): string {
  if (!sourceProfile || !targetProfile) {
    return "至少需要两个 Profile 才能同步账号。";
  }

  if (accountSyncRecord) {
    return `上次已在 ${formatDate(accountSyncRecord.syncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。再次同步会重新覆盖目标，不会重复叠加。`;
  }

  if (sourceProfile.running) {
    return "目标 Profile 的登录态会被源 Profile 覆盖。";
  }

  return `会用 ${sourceProfile.name} 的登录态覆盖 ${targetProfile.name} 的登录态。`;
}

export function renderAccountSyncScope(): string {
  const syncedItems = [
    "Google 登录态、Cookie、头像和账号身份状态",
    "站点会话数据：Local/Session Storage、IndexedDB、Service Worker、WebStorage",
    "账号与同步数据：Accounts、Sync Data、Sync App Settings、Trusted Vault",
    "书签、历史记录、下载记录、快捷方式、常用网站和网站图标",
    "浏览器设置和主题：Preferences、Secure Preferences，以及 Local State 中的登录字段"
  ];
  const excludedItems = [
    "打开的标签页或窗口",
    "保存的密码库 Login Data、证书、系统钥匙串权限",
    "扩展安装列表、启停状态、安装包本体和可单独识别的插件数据（需要插件请用「插件同步」）",
    "尚未落盘的数据"
  ];

  return `
    <div class="account-sync-scope" aria-label="账号同步范围">
      ${renderAccountSyncScopeGroup("会同步", syncedItems)}
      ${renderAccountSyncScopeGroup("不会同步", excludedItems)}
    </div>
  `;
}

export function renderAccountSyncScopeToggle(): string {
  return `
    <div class="account-sync-scope-toggle">
      <button type="button" class="diff-more-button" data-action="toggle-account-sync-scope" aria-expanded="${store.accountSyncScopeExpanded ? "true" : "false"}">
        ${store.accountSyncScopeExpanded ? "收起同步范围" : "查看同步范围"}
      </button>
    </div>
  `;
}

export function renderAccountSyncScopeGroup(title: string, items: string[]): string {
  return `
    <div class="account-sync-scope-group">
      <strong>${escapeHtml(title)}</strong>
      <ul>
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

export function renderAccountSyncResult(result: AccountSyncResult): string {
  const restoreText = result.restoredTargetTabs
    ? `已恢复目标 Profile 的 ${result.restoredTargetTabs} 个原标签页。`
    : result.launchedTarget
      ? "目标 Profile 已启动。"
      : "目标 Profile 已更新。";
  return `
    <div class="account-sync-result">
      <div class="result-complete">
        <strong>账号同步完成</strong>
        <span>${escapeHtml(restoreText)}</span>
      </div>
      <div class="migration-result-grid account-sync-result-grid">
        <div>
          <span>已同步</span>
          <strong>${result.copiedItems.length}</strong>
        </div>
        <div>
          <span>跳过</span>
          <strong>${result.skippedItems.length}</strong>
        </div>
        <div>
          <span>目标启动</span>
          <strong>${result.launchedTarget ? "是" : "否"}</strong>
        </div>
        <div>
          <span>恢复页签</span>
          <strong>${result.restoredTargetTabs}</strong>
        </div>
      </div>
      ${result.skippedItems.length ? renderAccountSyncSkippedItems(result.skippedItems) : ""}
    </div>
  `;
}

export function renderAccountSyncSkippedItems(items: AccountSyncSkippedItem[]): string {
  return `
    <div class="skipped-list">
      <span>未复制项目</span>
      ${items
        .slice(0, 8)
        .map((item) => `<span><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.reason)}</span>`)
        .join("")}
      ${items.length > 8 ? `<span>还有 ${items.length - 8} 项未复制。</span>` : ""}
    </div>
  `;
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
