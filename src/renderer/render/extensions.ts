import { isBusyAction } from "../busy";
import { store } from "../state";
import { ExtensionMigrationCopiedExtension, ExtensionMigrationDiffItem, ExtensionMigrationLoadedExtension, ExtensionMigrationResult, ExtensionMigrationSkippedExtension, ExtensionScanResult, ProfileExtensionInfo, PublicProfile } from "../types";
import { escapeHtml, extensionInstallTypeLabel, formatDate, profileStatusLabel, renderButtonLabel, renderDiffItem, renderOperationProgress, sourceLabel } from "../util";

// 合并同步面板里的「插件明细」区块：与账号同步共用源/目标 Profile。
// 默认整块可不展开操作（一键同步会自动扫描并同步全部插件）；
// 扫描后可勾选只同步部分插件、单独同步所选插件，或删除插件。
export function renderExtensionDetail(sourceProfile: PublicProfile | null): string {
  const sourceId = sourceProfile?.id || "";
  const activeScan = store.extensionScan?.profileId === sourceId ? store.extensionScan : null;
  const selectedCount = activeScan
    ? activeScan.extensions.filter((extension) => store.selectedExtensionIds.has(extension.id)).length
    : 0;
  const allSelected = Boolean(
    activeScan?.extensions.length && activeScan.extensions.every((extension) => store.selectedExtensionIds.has(extension.id))
  );
  const scanning = isBusyAction("scan-extensions");
  const migrating = isBusyAction("migrate-extensions");

  return `
    <div class="extension-detail mt-7 pt-5 border-solid border-t border-line" data-extension-migration aria-busy="${migrating ? "true" : "false"}">
      <div class="extension-detail-head flex items-end justify-between gap-3 flex-wrap [row-gap:8px]">
        <div class="min-w-0">
          <strong>插件明细</strong>
          <span class="block mt-1 text-muted text-[12px] leading-[1.45]">一键同步默认带上源 Profile 的全部插件；扫描差异后可勾选只同步部分插件，或删除插件。</span>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <label class="check-control" title="勾选后差异对比和同步都会带上插件数据（chrome.storage / IndexedDB 等）">
            <input type="checkbox" data-include-extension-data ${store.includeExtensionData ? "checked" : ""} ${store.busy ? "disabled" : ""} />
            <span>包含插件数据</span>
          </label>
          <button type="button" class="${scanning ? "loading" : ""}" data-action="scan-extensions" ${store.busy || !sourceProfile ? "disabled" : ""}>
            ${renderButtonLabel(scanning, "扫描插件差异", "扫描中…")}
          </button>
        </div>
      </div>

      ${migrating ? renderOperationProgress("migrate-extensions", "插件同步进度") : ""}
      ${store.extensionMigrationResult ? renderExtensionMigrationResult(store.extensionMigrationResult) : ""}
      ${activeScan ? renderExtensionMigrationDiffPreview("panel") : ""}
      ${activeScan ? renderExtensionScan(activeScan, selectedCount, allSelected) : ""}
    </div>
  `;
}

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

export function renderExtensionScan(
  scan: ExtensionScanResult,
  selectedCount: number,
  allSelected: boolean
): string {
  if (!scan.extensions.length) {
    return `
      <div class="extension-scan-empty flex items-center justify-between gap-3 mt-[14px] border border-dashed border-line-strong rounded-lg p-[14px] text-muted">
        <strong>${escapeHtml(scan.profileName)}</strong>
        <span>没有扫描到可同步插件。</span>
      </div>
    `;
  }

  return `
    <div class="extension-scan-head flex items-center justify-between gap-[14px] mt-4 mb-2.5 ${store.extensionScanPreviewCollapsed ? "collapsed" : ""}">
      <div>
        <strong>${escapeHtml(scan.profileName)}</strong>
        <span>${scan.extensions.length} 个插件 · 已选 ${selectedCount}</span>
      </div>
      <div class="migration-actions">
        <button type="button" class="diff-more-button muted" data-action="toggle-extension-scan-preview" aria-expanded="${store.extensionScanPreviewCollapsed ? "false" : "true"}">
          ${store.extensionScanPreviewCollapsed ? "展开预览" : "收起预览"}
        </button>
        <button type="button" data-action="select-all-extensions" ${store.busy ? "disabled" : ""}>${allSelected ? "取消全选" : "一键全选"}</button>
      </div>
    </div>
    ${
      store.extensionScanPreviewCollapsed
        ? ""
        : `<div class="extensions-table-wrap">
      <table class="extensions-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>插件</th>
            <th>来源</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${scan.extensions.map(renderExtensionRow).join("")}
        </tbody>
      </table>
    </div>`
    }
  `;
}

export function renderExtensionRow(extension: ProfileExtensionInfo): string {
  const selected = store.selectedExtensionIds.has(extension.id);
  const deleting = isBusyAction("delete-extension", { extensionId: extension.id });

  return `
    <tr>
      <td>
        <input type="checkbox" data-extension-select data-extension-id="${escapeHtml(extension.id)}" ${selected ? "checked" : ""} ${store.busy ? "disabled" : ""} />
      </td>
      <td>
        <strong class="extension-name">${escapeHtml(extension.name)}</strong>
      </td>
      <td>
        <span class="source-pill ${extension.fromWebStore ? "native" : "isolated"}">${extensionInstallTypeLabel(extension)}</span>
      </td>
      <td>
        <button type="button" class="action-button danger ${deleting ? "loading" : ""}" data-action="delete-extension" data-extension-id="${escapeHtml(extension.id)}" ${store.busy ? "disabled" : ""}>
          ${renderButtonLabel(deleting, "删除", "删除中…")}
        </button>
      </td>
    </tr>
  `;
}

export function renderExtensionMigrationResult(result: ExtensionMigrationResult): string {
  const copiedWebStoreCount = result.copiedExtensions.filter((extension) => extension.fromWebStore).length;
  const persistedLocalCount = result.copiedExtensions.filter((extension) => !extension.fromWebStore).length;
  const persistedCount = result.copiedExtensions.length;
  const runtimeLoadCount = result.loadedLocalExtensions.length;
  const autoWrittenCount = result.copiedExtensions.length + result.dataCopies.length + runtimeLoadCount;
  const manualLoadCount = result.manualLoadExtensions.length;
  const hasManualOnlyResult = manualLoadCount > 0 && autoWrittenCount === 0 && result.webStoreInstallUrls.length === 0;
  const title = hasManualOnlyResult ? "插件同步需要手动处理" : "插件同步已处理";
  const restoredTabs = result.restoredTargetTabs + result.restoredSourceTabs;
  let detail = result.openedInstallPages ? "已打开需要手动确认的页面。" : "目标 Profile 已更新。";
  if (persistedCount && manualLoadCount) {
    detail = `已持久写入 ${persistedCount} 个插件；仍有 ${manualLoadCount} 个需要手动处理。`;
  } else if (persistedCount) {
    detail = `已持久写入 ${persistedCount} 个插件。离开 ProfilePilot 正常启动 Chrome 也会加载。`;
  } else if (runtimeLoadCount && manualLoadCount) {
    detail = `已登记 ${runtimeLoadCount} 个本地插件为运行时自动加载；仍有 ${manualLoadCount} 个需要手动处理。`;
  } else if (runtimeLoadCount) {
    detail = `已登记 ${runtimeLoadCount} 个本地插件。目标 Profile 下次由 ProfilePilot 启动时会自动加载。`;
  } else if (manualLoadCount) {
    detail = `下面 ${manualLoadCount} 个本地未打包插件无法自动加载，需要手动选择源目录。`;
  }
  if (restoredTabs) {
    detail = `${detail} 已恢复 ${restoredTabs} 个原标签页。`;
  }

  return `
    <div class="migration-result">
      <div class="result-complete">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
      <div class="migration-result-grid">
        <div>
          <span>已处理</span>
          <strong>${result.selectedCount}</strong>
        </div>
        <div>
          <span>自动写入</span>
          <strong>${autoWrittenCount}</strong>
        </div>
        <div>
          <span>持久写入</span>
          <strong>${persistedCount}</strong>
        </div>
        <div>
          <span>需手动加载</span>
          <strong>${manualLoadCount}</strong>
        </div>
        <div>
          <span>商店插件</span>
          <strong>${copiedWebStoreCount}</strong>
        </div>
        <div>
          <span>恢复页签</span>
          <strong>${restoredTabs}</strong>
        </div>
      </div>
      ${persistedCount ? renderPersistedExtensions(result.copiedExtensions, persistedLocalCount) : ""}
      ${result.loadedLocalExtensions.length ? renderLoadedLocalExtensions(result.loadedLocalExtensions) : ""}
      ${result.manualLoadExtensions.length ? renderManualLoadExtensions(result) : ""}
      ${result.skippedExtensions.length ? renderSkippedExtensions(result.skippedExtensions) : ""}
    </div>
  `;
}

export function renderPersistedExtensions(extensions: ExtensionMigrationCopiedExtension[], localCount: number): string {
  return `
    <div class="loaded-local-panel">
      <strong>已持久写入目标 Profile</strong>
      <div class="loaded-local-list">
        ${extensions
          .map(
            (extension) => `
              <span>
                <strong>${escapeHtml(extension.name)}</strong>
                <code>${escapeHtml(extension.id)}</code>
              </span>
            `
          )
          .join("")}
      </div>
      <small>${localCount ? "本地未打包插件会继续引用源目录；源目录删除或移动后需要重新同步。" : "商店插件包和安装记录已写入目标 Profile。"}</small>
    </div>
  `;
}

export function renderLoadedLocalExtensions(extensions: ExtensionMigrationLoadedExtension[]): string {
  return `
    <div class="loaded-local-panel">
      <strong>已登记为运行时自动加载</strong>
      <div class="loaded-local-list">
        ${extensions
          .map(
            (extension) => `
              <span>
                <strong>${escapeHtml(extension.name)}</strong>
                <code>${escapeHtml(extension.loadedId)}</code>
              </span>
            `
          )
          .join("")}
      </div>
      <small>这是持久写入不可用时的回退路径；只有从 ProfilePilot 启动目标 Profile 时才会加载。</small>
    </div>
  `;
}

export function renderManualLoadExtensions(result: ExtensionMigrationResult): string {
  return `
    <div class="manual-load-panel">
      <div class="manual-load-head">
        <strong>手动加载未打包插件</strong>
        <button type="button" data-action="open-target-extensions-page" data-profile-id="${escapeHtml(result.targetProfileId)}" ${store.busy ? "disabled" : ""}>
          打开目标扩展页
        </button>
      </div>
      <ol class="manual-load-list">
        ${result.manualLoadExtensions
          .map(
            (extension) => `
              <li>
                <div>
                  <strong>${escapeHtml(extension.name)}</strong>
                  <code>${escapeHtml(extension.path)}</code>
                </div>
                <div class="manual-load-actions">
                  <button type="button" data-action="open-manual-extension-folder" data-path="${escapeHtml(extension.path)}" ${store.busy ? "disabled" : ""}>打开目录</button>
                  <button type="button" data-action="copy-manual-extension-path" data-path="${escapeHtml(extension.path)}">复制路径</button>
                </div>
              </li>
            `
          )
          .join("")}
      </ol>
      <small>在目标 Chrome 的 chrome://extensions 中点击“加载未打包的扩展程序”，选择上面的原始目录。这样 Chrome 才会生成和源 Profile 一致的插件 ID。</small>
    </div>
  `;
}

export function renderSkippedExtensions(skippedExtensions: ExtensionMigrationSkippedExtension[]): string {
  return `
    <div class="skipped-list">
      ${skippedExtensions
        .map(
          (extension) =>
            `<span><strong>${escapeHtml(extension.name)}</strong> ${escapeHtml(extension.reason)}</span>`
        )
        .join("")}
    </div>
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
