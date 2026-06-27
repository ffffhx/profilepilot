import { profileApi } from "./api";
import { accountSyncProgressStepsForTarget, emphasizeName, extensionSyncProgressStepsForProfiles, pendingBusySteps, setToast, withBusy } from "./busy";
import { render } from "./render/render-root";
import { invalidateExtensionMigrationDiff, loadState } from "./state-actions";
import { store } from "./state";
import { ConfirmBodyLine, ConfirmIntent, ConfirmModalView, ModalState, PublicProfile } from "./types";
import { closeConfirmCopy, deleteConfirmCopy, escapeHtml, formatDate, formatErrorMessage, profileStatusLabel, sourceDetail } from "./util";

export function renderConfirmModal(confirm: Extract<ModalState, { kind: "confirm" }>): string {
  const view = confirmModalView(confirm.intent);
  if (!view) {
    return "";
  }

  const confirmClass = `${view.tone === "primary" ? "solid" : `${view.tone} solid`}`;

  return `
    <div class="modal-backdrop app-modal-backdrop" data-action="close-modal">
      <section class="modal confirm-modal confirm-dialog ${view.tone}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-dialog-head">
          <span class="confirm-dialog-icon" aria-hidden="true"></span>
          <div>
            <span class="modal-kicker inline-flex mb-2 text-accent font-mono text-[11px] font-semibold tracking-[0.18em] uppercase">${escapeHtml(view.kicker)}</span>
            <h2 id="confirm-title">${escapeHtml(view.title)}</h2>
          </div>
        </div>
        <div class="modal-copy mt-[10px] mb-4 mx-0 text-muted text-[14px] leading-[1.6] [overflow-wrap:anywhere] confirm-copy">
          ${view.body
            .map((line) =>
              typeof line === "string"
                ? `<p>${escapeHtml(line)}</p>`
                : `<p class="${line.tone}-line">${escapeHtml(line.text)}</p>`
            )
            .join("")}
        </div>
        <div class="confirm-summary">
          ${view.summary
            .map(
              (item) => `
                <div>
                  <span>${escapeHtml(item.label)}</span>
                  <strong>${escapeHtml(item.value)}</strong>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" data-action="close-modal">取消</button>
          <button type="button" class="${confirmClass}" data-action="confirm-modal-action">
            ${escapeHtml(view.confirmLabel)}
          </button>
        </div>
      </section>
    </div>
  `;
}

export function confirmModalView(intent: ConfirmIntent): ConfirmModalView | null {
  if (!store.state) {
    return null;
  }

  if (intent.kind === "profile") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    if (!profile) {
      return null;
    }
    if (intent.action === "delete-after-chrome-exit") {
      return {
        kicker: "退出 Chrome 后删除",
        title: `退出 Chrome 并删除 ${profile.name}`,
        body: [
          "还有 Chrome 正在运行。删除系统 Chrome Profile 前需要先退出 Chrome，否则本地配置可能仍被占用。",
          {
            text: "同意后 ProfilePilot 会直接退出 Google Chrome，再把这个 Profile 目录移到废纸篓；未保存的网页内容可能会丢失。",
            tone: "danger"
          }
        ],
        confirmLabel: "退出并删除",
        tone: "danger",
        summary: [
          { label: "Profile", value: profile.name },
          { label: "将退出", value: "Google Chrome" },
          { label: "目录", value: profile.dirName }
        ]
      };
    }
    const copy = intent.action === "close" ? closeConfirmCopy(profile) : deleteConfirmCopy(profile);
    return {
      kicker: intent.action === "close" ? "关闭 Profile" : "删除 Profile",
      title: copy.title,
      body: [copy.body],
      confirmLabel: copy.confirmLabel,
      tone: intent.action === "delete" ? "danger" : "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "来源", value: sourceDetail(profile) },
        { label: "状态", value: profileStatusLabel(profile) }
      ]
    };
  }

  if (intent.kind === "account-sync") {
    const sourceProfile = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    const targetProfile = store.state.profiles.find((profile) => profile.id === intent.targetProfileId);
    if (!sourceProfile || !targetProfile) {
      return null;
    }

    const overwriteLine = intent.existingRecordSyncedAt
      ? `上次已在 ${formatDate(intent.existingRecordSyncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。继续会覆盖刷新目标登录态，不会重复叠加。`
      : `${targetProfile.name} 当前登录态会被 ${sourceProfile.name} 的登录态替换。`;
    const closeLine = intent.shouldCloseTarget
      ? `目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标；若勾选重新启动，完成后会恢复能读取到的原标签页。`
      : "同步开始后会写入目标 Profile 的账号数据。";
    const modeLine = "本次会用源 Profile 重新覆盖目标中可同步的账号数据。";

    return {
      kicker: "账号同步确认",
      title: `同步 ${sourceProfile.name} 到 ${targetProfile.name}`,
      body: [closeLine, overwriteLine, modeLine],
      confirmLabel: "同步",
      tone: "warn",
      summary: [
        { label: "源 Profile", value: sourceProfile.name },
        { label: "目标 Profile", value: targetProfile.name },
        { label: "完成后", value: intent.launchTarget ? "启动目标" : "不启动目标" }
      ]
    };
  }

  if (intent.kind === "delete-extension") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    const extension = store.extensionScan?.extensions.find((item) => item.id === intent.extensionId);
    if (!profile || !extension) {
      return null;
    }

    return {
      kicker: "删除插件",
      title: `删除 ${extension.name}`,
      body: [`将从 ${profile.name} 移除这个插件文件和相关配置。此操作只影响这个 Profile。`],
      confirmLabel: "确认删除插件",
      tone: "danger",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "插件", value: extension.name },
        { label: "版本", value: extension.version || "未知" }
      ]
    };
  }

  const sourceProfile = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const targetProfile = store.state.profiles.find((profile) => profile.id === intent.targetProfileId);
  const activeScan = store.extensionScan?.profileId === intent.sourceProfileId ? store.extensionScan : null;
  if (!sourceProfile || !targetProfile || !activeScan) {
    return null;
  }

  const selectedExtensions = activeScan.extensions.filter((extension) => intent.extensionIds.includes(extension.id));
  const selectedWithData = selectedExtensions.filter((extension) => extension.hasLocalData).length;
  const plannedDiffItems = store.extensionMigrationDiff?.items.filter((item) => intent.extensionIds.includes(item.id)) || [];
  const persistCount = plannedDiffItems.length
    ? plannedDiffItems.filter((item) => item.willCopyLocally).length
    : selectedExtensions.filter((extension) => extension.canPersistInstall).length;
  const cdpLoadCount = plannedDiffItems.length ? plannedDiffItems.filter((item) => item.willLoadViaCdp).length : 0;
  const manualLoadCount = plannedDiffItems.length
    ? plannedDiffItems.filter((item) => item.status === "manual_load_required").length
    : selectedExtensions.filter((extension) => extension.installType === "local" && !extension.canPersistInstall).length;
  const plannedCount = intent.extensionIds.length;
  const closeLine = intent.shouldCloseTarget
    ? `目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标，完成后会重新打开，并恢复能读取到的原标签页。`
    : "同步开始后会写入目标 Profile 的插件配置。";
  const sourceCloseLine: ConfirmBodyLine | null = intent.shouldCloseSource
    ? {
        text: `源 ${sourceProfile.name} 正在运行。读取插件数据前需要先关闭它，完成后会重新打开，并恢复能读取到的原标签页。`,
        tone: "danger"
      }
    : null;
  const dataLine = extensionMigrationConfirmDataLine(persistCount, cdpLoadCount, manualLoadCount, intent.includeData);
  const modeLine = intent.onlyChanged
    ? `本次只同步 ${plannedCount} 个变更插件，${Math.max(intent.selectedCount - plannedCount, 0)} 个已一致插件会跳过。`
    : "会重新覆盖所有可同步的已选插件。";

  return {
    kicker: "插件同步确认",
    title: `同步 ${plannedCount} 个插件到 ${targetProfile.name}`,
    body: [closeLine, sourceCloseLine, dataLine, modeLine].filter((line): line is ConfirmBodyLine => Boolean(line)),
    confirmLabel: "同步",
    tone: "warn",
    summary: [
      { label: "源 Profile", value: sourceProfile.name },
      { label: "目标 Profile", value: targetProfile.name },
      { label: "待同步", value: String(plannedCount) },
      { label: "已选插件", value: String(intent.selectedCount) },
      { label: "持久写入", value: String(persistCount) },
      { label: "含数据", value: String(selectedWithData) }
    ]
  };
}

export function extensionMigrationConfirmDataLine(
  persistCount: number,
  cdpLoadCount: number,
  manualLoadCount: number,
  includeData: boolean
): string {
  const dataText = includeData ? "插件配置和插件数据会被源 Profile 覆盖。" : "插件配置会被源 Profile 覆盖，插件数据不会同步。";
  if (persistCount && manualLoadCount) {
    return `${dataText} ${persistCount} 个插件会持久写入目标 Profile，${manualLoadCount} 个仍需要手动加载源目录。`;
  }
  if (persistCount) {
    return `${dataText} ${persistCount} 个插件会持久写入目标 Profile，离开 ProfilePilot 启动也会加载。`;
  }
  if (cdpLoadCount && manualLoadCount) {
    return `${dataText} ${cdpLoadCount} 个本地插件会登记为目标启动时自动加载，${manualLoadCount} 个仍需要手动加载源目录。`;
  }
  if (cdpLoadCount) {
    return `${dataText} ${cdpLoadCount} 个本地插件会登记为目标启动时自动加载。`;
  }
  if (manualLoadCount) {
    return `${dataText} ${manualLoadCount} 个本地未打包插件无法自动加载；会打开目标扩展程序页，请手动加载源插件目录。`;
  }

  return dataText;
}

export function closeModalFromUi(): void {
  if (store.modal?.kind === "confirm" && store.modal.returnTo === "extension-migration") {
    store.modal = { kind: "extension-migration" };
  } else {
    store.modal = null;
  }
  store.migrationTargetMenuOpen = false;
  render();
}

export function executeConfirmIntent(intent: ConfirmIntent): void {
  if (intent.kind === "profile") {
    executeProfileConfirm(intent);
    return;
  }

  if (intent.kind === "account-sync") {
    executeAccountSyncConfirm(intent);
    return;
  }

  if (intent.kind === "delete-extension") {
    executeDeleteExtensionConfirm(intent);
    return;
  }

  executeExtensionMigrationConfirm(intent);
}

export function executeProfileConfirm(intent: Extract<ConfirmIntent, { kind: "profile" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  store.modal = null;

  if (!profile) {
    render();
    return;
  }

  if (intent.action === "close") {
    void withBusy(() => profileApi().closeProfile(profile.id), `已关闭 ${emphasizeName(profile.name)}`, {
      key: "close-profile",
      message: `正在关闭 ${profile.name}…`,
      profileId: profile.id
    });
    return;
  }

  void executeProfileDeleteConfirm(profile, intent.action === "delete-after-chrome-exit");
}

export async function executeProfileDeleteConfirm(profile: PublicProfile, quitChromeBeforeDelete: boolean): Promise<void> {
  if (store.busy) {
    return;
  }

  store.busy = true;
  store.busyState = {
    key: "delete-profile",
    message: quitChromeBeforeDelete
      ? `正在退出 Chrome 并删除 ${profile.name}…`
      : profile.running
        ? `正在关闭并删除 ${profile.name}…`
        : `正在删除 ${profile.name}…`,
    profileId: profile.id
  };
  render();

  try {
    await profileApi().deleteProfile(profile.id, { quitChromeBeforeDelete });
    setToast(
      quitChromeBeforeDelete
        ? `已退出 Chrome 并删除 ${emphasizeName(profile.name)}`
        : profile.running
          ? `已关闭并删除 ${emphasizeName(profile.name)}`
          : `已删除 ${emphasizeName(profile.name)}`
    );
  } catch (error) {
    const message = formatErrorMessage(error);
    if (!quitChromeBeforeDelete && profile.source === "native" && isChromeRunningDeleteError(message)) {
      store.modal = {
        kind: "confirm",
        intent: {
          kind: "profile",
          action: "delete-after-chrome-exit",
          profileId: profile.id
        }
      };
      return;
    }
    setToast(message, "error");
  } finally {
    store.busy = false;
    store.busyState = null;
    await loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }
}

function isChromeRunningDeleteError(message: string): boolean {
  return message.includes("删除 Chrome Profile 前请先退出 Chrome");
}

export function executeAccountSyncConfirm(intent: Extract<ConfirmIntent, { kind: "account-sync" }>): void {
  const sourceProfile = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const targetProfile = store.state?.profiles.find((profile) => profile.id === intent.targetProfileId);
  store.modal = null;

  if (!sourceProfile || !targetProfile) {
    render();
    setToast("请选择两个不同的 Profile", "error");
    return;
  }

  const progressSteps = accountSyncProgressStepsForTarget(targetProfile);
  void withBusy(async () => {
    const result = await profileApi().syncAccount({
      sourceProfileId: intent.sourceProfileId,
      targetProfileId: intent.targetProfileId,
      launchTarget: intent.launchTarget,
      onlyChanged: false
    });
    store.accountSyncResult = result;
    store.state = result.state;
    store.selectedId = result.targetProfileId;
  }, intent.launchTarget
    ? intent.existingRecordSyncedAt
      ? "账号重新同步完成，已启动目标 Profile"
      : "账号同步完成，已启动目标 Profile"
    : intent.existingRecordSyncedAt
      ? "账号重新同步完成"
      : "账号同步完成", {
    key: "account-sync",
    message: intent.shouldCloseTarget ? `正在关闭 ${targetProfile.name} 后同步账号…` : "正在同步账号…",
    profileId: intent.targetProfileId,
    stepIndex: 1,
    stepCount: progressSteps.length,
    steps: pendingBusySteps(progressSteps)
  });
}

export function executeDeleteExtensionConfirm(intent: Extract<ConfirmIntent, { kind: "delete-extension" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  const extension = store.extensionScan?.extensions.find((item) => item.id === intent.extensionId);
  store.modal = null;

  if (!profile || !extension) {
    render();
    setToast("没有找到要删除的插件", "error");
    return;
  }

  void withBusy(async () => {
    const result = await profileApi().deleteProfileExtension(intent.profileId, intent.extensionId);
    store.extensionScan = result.scan;
    store.selectedExtensionIds.delete(intent.extensionId);
    store.extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    store.state = result.state;
    store.selectedId = result.profileId;
  }, `已删除插件 ${emphasizeName(extension.name)}`, {
    key: "delete-extension",
    message: `正在删除插件 ${extension.name}…`,
    profileId: intent.profileId,
    extensionId: intent.extensionId
  });
}

export function executeExtensionMigrationConfirm(intent: Extract<ConfirmIntent, { kind: "extension-migration" }>): void {
  const targetProfile = store.state?.profiles.find((profile) => profile.id === intent.targetProfileId);
  const sourceProfile = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  store.modal = null;

  if (!targetProfile) {
    render();
    setToast("没有找到目标 Profile", "error");
    return;
  }

  store.migrationTargetId = intent.targetProfileId;
  const progressSteps = extensionSyncProgressStepsForProfiles(sourceProfile || null, targetProfile, intent.includeData);

  void withBusy(async () => {
    const result = await profileApi().migrateExtensions({
      sourceProfileId: intent.sourceProfileId,
      targetProfileId: intent.targetProfileId,
      extensionIds: intent.extensionIds,
      includeData: intent.includeData,
      openInstallPages: intent.openInstallPages,
      onlyChanged: intent.onlyChanged
    });
    store.extensionMigrationResult = result;
    invalidateExtensionMigrationDiff();
    store.state = result.state;
    store.selectedId = result.targetProfileId;
  }, "插件同步完成", {
    key: "migrate-extensions",
    message: intent.shouldCloseTarget ? `正在关闭 ${targetProfile.name} 后同步插件…` : "正在同步插件…",
    profileId: intent.targetProfileId,
    stepIndex: 1,
    stepCount: progressSteps.length,
    steps: pendingBusySteps(progressSteps)
  });
}
