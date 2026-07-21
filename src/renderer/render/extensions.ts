import { store } from "../state";
import { ExtensionMigrationDiffItem, ProfileExtensionInfo, PublicProfile } from "../types";
import { escapeHtml, formatDate, profileStatusLabel, renderDiffItem, sourceLabel } from "../util";

export function renderMigrationTargetPicker(profiles: PublicProfile[], targetId: string, excludedProfileId?: string): string {
  const options = profiles.filter((profile) => profile.id !== excludedProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === targetId) || null;
  const expanded = store.migrationTargetMenuOpen && options.length > 0 && !store.busy;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-migration-target-select>
      <input type="hidden" name="targetProfileId" value="${escapeHtml(selectedProfile?.id || "")}" />
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-migration-target-menu"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="migration-target-label"
        ${store.busy || !options.length ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${
        expanded
          ? `<div class="profile-select-menu" role="listbox" aria-labelledby="migration-target-label">
              ${options.map((profile) => renderMigrationTargetOption(profile, targetId)).join("")}
            </div>`
          : ""
      }
    </div>
  `;
}

export function renderMigrationTargetOption(profile: PublicProfile, targetId: string): string {
  const selected = profile.id === targetId;

  return `
    <button
      type="button"
      class="profile-select-option ${selected ? "selected" : ""}"
      data-action="select-migration-target"
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

export function plannedExtensionMigrationExtensions(selectedExtensions: ProfileExtensionInfo[]): ProfileExtensionInfo[] | null {
  if (!store.extensionSyncOnlyChanged) {
    return selectedExtensions;
  }
  if (!store.extensionMigrationDiff) {
    return null;
  }

  const actionIds = new Set(
    store.extensionMigrationDiff.items
      .filter(isExtensionMigrationActionItem)
      .map((item) => item.id)
  );
  return selectedExtensions.filter((extension) => actionIds.has(extension.id));
}

export function isExtensionMigrationActionItem(item: ExtensionMigrationDiffItem): boolean {
  return (
    item.status === "missing" ||
    item.status === "version_changed" ||
    item.status === "data_changed" ||
    item.status === "manual_load_required" ||
    item.willOpenInstallPage
  );
}

export function renderExtensionMigrationDiffPreview(context: "modal" | "panel" = "modal"): string {
  const variantClass = context === "modal" ? "modal-diff-preview" : "compact";
  if (store.extensionMigrationDiffLoading) {
    return `
      <div class="diff-preview ${variantClass}" aria-live="polite">
        <div class="diff-preview-head">
          <strong>插件差异预览</strong>
          <span><span class="inline-spinner" aria-hidden="true"></span> 正在检查插件差异…</span>
        </div>
      </div>
    `;
  }

  if (!store.extensionMigrationDiff) {
    if (context === "panel") {
      return "";
    }
    return `
      <div class="diff-preview ${variantClass}">
        <div class="diff-preview-head">
          <strong>插件差异预览</strong>
          <span>选择目标或同步选项后会检查本次差异。</span>
        </div>
      </div>
    `;
  }

  const changedItems = store.extensionMigrationDiff.items.filter(isExtensionMigrationActionItem);
  const visibleItems = (changedItems.length ? changedItems : store.extensionMigrationDiff.items).slice(0, 5);
  const syncableCount = changedItems.length;
  const modeText = store.extensionSyncOnlyChanged ? "已一致插件会跳过" : "已关闭，仅用于预览；同步时会重新覆盖可同步插件";

  return `
    <div class="diff-preview ${variantClass}">
      <div class="diff-preview-head">
        <strong>插件差异预览</strong>
        <span>${escapeHtml(modeText)}</span>
      </div>
      <div class="diff-summary-grid extension-diff-summary">
        <div>
          <span>待处理</span>
          <strong>${syncableCount}</strong>
        </div>
        <div>
          <span>目标缺少</span>
          <strong>${store.extensionMigrationDiff.summary.missingCount}</strong>
        </div>
        <div>
          <span>有变化</span>
          <strong>${store.extensionMigrationDiff.summary.changedCount}</strong>
        </div>
        <div>
          <span>持久写入</span>
          <strong>${store.extensionMigrationDiff.items.filter((item) => item.willCopyLocally).length}</strong>
        </div>
        <div>
          <span>需手动</span>
          <strong>${store.extensionMigrationDiff.summary.manualLoadCount}</strong>
        </div>
        <div>
          <span>安装页</span>
          <strong>${store.extensionMigrationDiff.summary.needsInstallPageCount}</strong>
        </div>
        <div>
          <span>已一致</span>
          <strong>${store.extensionMigrationDiff.summary.sameCount}</strong>
        </div>
      </div>
      ${
        visibleItems.length
          ? `<div class="diff-item-list">
              ${visibleItems.map((item) => renderDiffItem(item.name, item.reason, item.status)).join("")}
              ${changedItems.length > visibleItems.length ? `<span>还有 ${changedItems.length - visibleItems.length} 个插件会处理。</span>` : ""}
              ${store.extensionMigrationDiff.summary.unsupportedCount ? `<span>${store.extensionMigrationDiff.summary.unsupportedCount} 个插件没有可自动同步的插件目录。</span>` : ""}
            </div>`
          : ""
      }
    </div>
  `;
}
