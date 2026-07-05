import { isBusyAction } from "../busy";
import { store } from "../state";
import { AccountSyncRecord, AccountSyncResult, AccountSyncSkippedItem, PublicProfile } from "../types";
import { escapeHtml, formatDate, profileStatusLabel, renderButtonLabel, renderDiffItem, renderOperationProgress, sourceLabel } from "../util";
import { renderExtensionDetail } from "./extensions";

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
          <h2>同步</h2>
          <span class="section-subtitle block mt-1 text-muted font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">Account + Extensions</span>
        </div>
        <button type="button" class="primary agent-browser-cta" data-action="open-agent-browser-setup" ${store.busy ? "disabled" : ""}>
          ⚡ 一键造 Agent 浏览器
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

      ${partAccount ? renderAccountDetail(sourceProfile, targetProfile, accountSyncRecord) : ""}

      ${partExtensions ? renderExtensionDetail(sourceProfile) : ""}
    </section>
  `;
}

// 「账号明细」区块：与下方「插件明细」结构对称——左侧标题+说明，右侧差异扫描按钮，
// 下面依次是差异预览和最近一次同步结果。
function renderAccountDetail(
  sourceProfile: PublicProfile | null,
  targetProfile: PublicProfile | null,
  accountSyncRecord: AccountSyncRecord | null
): string {
  const scanning = store.accountSyncDiffLoading;

  return `
    <div class="account-detail mt-7 pt-5 border-solid border-t border-line">
      <div class="account-detail-head flex items-end justify-between gap-3 flex-wrap [row-gap:8px]">
        <div class="min-w-0">
          <strong>账号明细</strong>
          <span class="block mt-1 text-muted text-[12px] leading-[1.45]">${escapeHtml(accountSyncNote(sourceProfile, targetProfile, accountSyncRecord))}</span>
        </div>
        <button type="button" class="${scanning ? "loading" : ""}" data-action="scan-account-diff" ${store.busy || scanning || !sourceProfile || !targetProfile ? "disabled" : ""}>
          ${renderButtonLabel(scanning, "扫描账号差异", "扫描中…")}
        </button>
      </div>
      ${renderAccountSyncDiffPreview()}
      ${store.accountSyncResult ? renderAccountSyncResult(store.accountSyncResult) : ""}
    </div>
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

export function renderAccountSyncDiffPreview(): string {
  if (store.accountSyncDiffLoading) {
    return `
      <div class="diff-preview compact" aria-live="polite">
        <div class="diff-preview-head">
          <strong>账号差异预览</strong>
          <span><span class="inline-spinner" aria-hidden="true"></span> 正在比对源与目标的账号数据…</span>
        </div>
      </div>
    `;
  }

  const diff = store.accountSyncDiff;
  if (!diff) {
    return "";
  }

  const collapsed = store.accountSyncDiffCollapsed;
  const changedItems = diff.items.filter((item) => item.status !== "same");
  const visibleItems = changedItems.slice(0, 8);
  const statusText =
    diff.summary.changedCount || diff.summary.targetMissingCount
      ? `${diff.summary.syncableCount} 项待同步`
      : "源与目标的可同步账号数据当前一致。";

  return `
    <div class="diff-preview compact ${collapsed ? "collapsed" : ""}">
      <div class="diff-preview-head">
        <strong>账号差异预览</strong>
        <div class="diff-preview-head-actions">
          <span>${escapeHtml(statusText)}</span>
          <button type="button" class="diff-more-button muted" data-action="toggle-account-diff-preview" aria-expanded="${collapsed ? "false" : "true"}">
            ${collapsed ? "展开预览" : "收起预览"}
          </button>
        </div>
      </div>
      ${
        collapsed
          ? ""
          : `<div class="diff-summary-grid account-diff-summary">
        <div>
          <span>待同步</span>
          <strong>${diff.summary.syncableCount}</strong>
        </div>
        <div>
          <span>有变化</span>
          <strong>${diff.summary.changedCount}</strong>
        </div>
        <div>
          <span>目标缺少</span>
          <strong>${diff.summary.targetMissingCount}</strong>
        </div>
        <div>
          <span>源缺少</span>
          <strong>${diff.summary.sourceMissingCount}</strong>
        </div>
        <div>
          <span>已一致</span>
          <strong>${diff.summary.sameCount}</strong>
        </div>
      </div>
      ${
        visibleItems.length
          ? `<div class="diff-item-list">
              ${visibleItems.map((item) => renderDiffItem(item.label, item.reason, item.status)).join("")}
              ${changedItems.length > visibleItems.length ? `<span>还有 ${changedItems.length - visibleItems.length} 项有差异。</span>` : ""}
            </div>`
          : ""
      }`
      }
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
