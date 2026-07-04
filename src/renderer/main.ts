import { profileApi } from "./api";
import { activateBusyStep, busyStepsKey, emphasizeName, focusProfileFromUi, setToast, updateBusyProgressDom, updateBusyState, withBusy } from "./busy";
import { closeModalFromUi, executeConfirmIntent } from "./confirm";
import { clampCloneCount } from "./render/clone-pool";
import { isExtensionMigrationActionItem } from "./render/extensions";
import { focusLiveTab, openLiveZoom, refreshLiveViewNow, requestLiveViewNow, startLiveViewLoop, toggleLiveScreenshot } from "./render/live-view";
import { render } from "./render/render-root";
import { invalidateExtensionMigrationDiff, loadState, refreshExtensionMigrationDiff, refreshGlobalInstructions, repairClaudeInstructionShell, saveGlobalInstruction, setMigrationSource } from "./state-actions";
import { appRoot, store } from "./state";
import { deleteButtonTitle, escapeHtml, formatErrorMessage } from "./util";

profileApi().onOperationProgress((progress) => {
  if (!store.busyState || store.busyState.key !== progress.key) {
    return;
  }
  if (progress.profileId && store.busyState.profileId && progress.profileId !== store.busyState.profileId) {
    return;
  }

  const previousStepIndex = store.busyState.stepIndex;
  const previousStepCount = store.busyState.stepCount;
  const previousPaused = store.busyState.paused;
  const previousStepsKey = busyStepsKey(store.busyState.steps);
  const nextSteps = progress.step ? activateBusyStep(store.busyState.steps || [], progress.step) : store.busyState.steps;
  const activeStepIndex = progress.step
    ? nextSteps?.findIndex((step) => step.label === progress.step)
    : -1;

  store.busyState = {
    ...store.busyState,
    message: progress.message || store.busyState.message,
    stepIndex: activeStepIndex !== undefined && activeStepIndex >= 0 ? activeStepIndex + 1 : progress.stepIndex || store.busyState.stepIndex,
    stepCount: nextSteps?.length || progress.stepCount || store.busyState.stepCount,
    steps: nextSteps,
    paused: progress.paused ?? store.busyState.paused
  };

  const nextStepsKey = busyStepsKey(store.busyState.steps);
  if (
    previousStepIndex !== store.busyState.stepIndex ||
    previousStepCount !== store.busyState.stepCount ||
    previousPaused !== store.busyState.paused ||
    previousStepsKey !== nextStepsKey ||
    !updateBusyProgressDom()
  ) {
    render();
  }
});

appRoot.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const hadOpenProfileMenu = Boolean(store.openProfileMenuId);
  const hadMigrationSourceMenu = store.migrationSourceMenuOpen;
  const hadAccountSyncMenu = Boolean(store.accountSyncMenuOpen);
  if (store.openProfileMenuId && !target?.closest("[data-profile-actions]")) {
    store.openProfileMenuId = null;
  }
  if (store.migrationSourceMenuOpen && !target?.closest("[data-migration-source-select]")) {
    store.migrationSourceMenuOpen = false;
  }
  const hadMigrationTargetMenu = store.migrationTargetMenuOpen;
  if (store.migrationTargetMenuOpen && !target?.closest("[data-migration-target-select]")) {
    store.migrationTargetMenuOpen = false;
  }
  if (store.accountSyncMenuOpen && !target?.closest(`[data-account-sync-select="${store.accountSyncMenuOpen}"]`)) {
    store.accountSyncMenuOpen = null;
  }
  const hadClonePoolMenu = store.clonePoolMenuOpen;
  if (store.clonePoolMenuOpen && !target?.closest("[data-clone-pool-select]")) {
    store.clonePoolMenuOpen = false;
  }

  const actionTarget = target?.closest<HTMLElement>("[data-action]");
  if (!actionTarget || !store.state) {
    if (
      (hadOpenProfileMenu && !store.openProfileMenuId) ||
      (hadMigrationSourceMenu && !store.migrationSourceMenuOpen) ||
      (hadMigrationTargetMenu && !store.migrationTargetMenuOpen) ||
      (hadAccountSyncMenu && !store.accountSyncMenuOpen) ||
      (hadClonePoolMenu && !store.clonePoolMenuOpen)
    ) {
      render();
    }
    return;
  }

  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id || null;
  if (action !== "toggle-profile-menu" && actionTarget.closest("[data-profile-actions]")) {
    store.openProfileMenuId = null;
  }

  if (action === "toggle-migration-source-menu") {
    store.migrationSourceMenuOpen = !store.migrationSourceMenuOpen;
    store.accountSyncMenuOpen = null;
    store.openProfileMenuId = null;
    render();
    return;
  }

  if (action === "select-migration-source" && id) {
    setMigrationSource(id);
    store.migrationSourceMenuOpen = false;
    render();
    return;
  }

  if (action === "toggle-migration-target-menu") {
    store.migrationTargetMenuOpen = !store.migrationTargetMenuOpen;
    render();
    return;
  }

  if (action === "select-migration-target" && id) {
    store.migrationTargetId = id;
    store.migrationTargetMenuOpen = false;
    store.extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
    return;
  }

  if (action === "toggle-account-sync-menu") {
    const kind = actionTarget.dataset.kind === "target" ? "target" : "source";
    store.accountSyncMenuOpen = store.accountSyncMenuOpen === kind ? null : kind;
    store.migrationSourceMenuOpen = false;
    store.openProfileMenuId = null;
    render();
    return;
  }

  if (action === "select-account-sync-profile" && id) {
    if (actionTarget.dataset.kind === "target") {
      store.accountSyncTargetId = id;
    } else {
      store.accountSyncSourceId = id;
      if (store.accountSyncTargetId === store.accountSyncSourceId) {
        store.accountSyncTargetId = store.state.profiles.find((profile) => profile.id !== store.accountSyncSourceId)?.id || null;
      }
    }
    store.accountSyncResult = null;
    store.accountSyncMenuOpen = null;
    render();
    return;
  }

  if (action === "toggle-clone-pool-menu") {
    store.clonePoolMenuOpen = !store.clonePoolMenuOpen;
    store.accountSyncMenuOpen = null;
    store.migrationSourceMenuOpen = false;
    store.migrationTargetMenuOpen = false;
    store.openProfileMenuId = null;
    render();
    return;
  }

  if (action === "select-clone-pool-source" && id) {
    store.clonePoolSourceId = id;
    store.clonePoolMenuOpen = false;
    render();
    return;
  }

  if (action === "clone-profiles") {
    const sourceId =
      store.clonePoolSourceId && store.state.profiles.some((profile) => profile.id === store.clonePoolSourceId)
        ? store.clonePoolSourceId
        : store.state.profiles[0]?.id || null;
    const sourceProfile = store.state.profiles.find((profile) => profile.id === sourceId) || null;
    if (!sourceProfile) {
      setToast("先选择一个源 Profile", "error");
      return;
    }
    const count = clampCloneCount(store.clonePoolCount);
    store.modal = {
      kind: "confirm",
      returnTo: "clone-pool",
      intent: {
        kind: "clone-profiles",
        sourceProfileId: sourceProfile.id,
        count,
        namePrefix: sourceProfile.name,
        includeExtensions: store.clonePoolIncludeExtensions,
        launchAfter: store.clonePoolLaunchAfter,
        setAgentEndpoint: store.clonePoolSetEndpoint
      }
    };
    render();
    return;
  }

  if (action === "refresh-clones" && id) {
    const sourceProfile = store.state.profiles.find((profile) => profile.id === id);
    if (!sourceProfile) {
      return;
    }
    if (!store.state.profiles.some((profile) => profile.clonedFromProfileId === id)) {
      setToast("这个源还没有副本", "error");
      return;
    }
    store.modal = { kind: "confirm", returnTo: "clone-pool", intent: { kind: "refresh-clones", sourceProfileId: id } };
    render();
    return;
  }

  if (action === "launch-clones" && id) {
    const idleClones = store.state.profiles.filter(
      (profile) => profile.source === "isolated" && profile.clonedFromProfileId === id && !profile.running
    );
    if (!idleClones.length) {
      setToast("没有可启动的空闲副本", "error");
      return;
    }
    void withBusy(
      async () => {
        const result = await profileApi().launchClones(id);
        store.state = result.state;
        setToast(
          result.failed.length
            ? `已启动 ${result.launched.length} 个副本，${result.failed.length} 个失败`
            : `已批量启动 ${result.launched.length} 个副本`,
          result.failed.length ? "error" : "normal"
        );
      },
      undefined,
      { key: "launch-clones", message: "正在批量启动副本…" }
    );
    return;
  }

  if (action === "reset-clone" && id) {
    const clone = store.state.profiles.find((profile) => profile.id === id);
    if (!clone) {
      return;
    }
    if (!clone.clonedFromProfileId) {
      setToast("这个 Profile 不是副本，没有可重置回去的源", "error");
      return;
    }
    store.modal = { kind: "confirm", returnTo: "clone-pool", intent: { kind: "reset-clone", profileId: id } };
    render();
    return;
  }

  if (action === "set-clone-tag" && id) {
    const clone = store.state.profiles.find((profile) => profile.id === id);
    if (!clone) {
      return;
    }
    store.modal = { kind: "clone-tag", profileId: id };
    render();
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>("#clone-tag");
      input?.focus();
      input?.select();
    }, 0);
    return;
  }

  if (action === "recycle-clones") {
    const days = Number.isFinite(store.clonePoolRecycleDays) ? Math.max(0, Math.round(store.clonePoolRecycleDays)) : 7;
    const candidates = store.state.profiles.filter(
      (profile) => profile.source === "isolated" && profile.clonedFromProfileId && !profile.running
    );
    if (!candidates.length) {
      setToast("当前没有空闲副本可清理", "error");
      return;
    }
    store.modal = { kind: "confirm", returnTo: "clone-pool", intent: { kind: "recycle-clones", days } };
    render();
    return;
  }

  if (action === "new-profile") {
    store.modal = { kind: "new" };
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#profile-name")?.focus(), 0);
    return;
  }

  if (action === "close-modal") {
    if (event.target === actionTarget || actionTarget.tagName === "BUTTON") {
      if (store.modal?.kind === "global-instructions" && store.editingGlobalInstructionId) {
        setToast("先保存或取消当前编辑", "error");
        return;
      }
      closeModalFromUi();
    }
    return;
  }

  if (action === "open-mini-window") {
    void profileApi().showMiniWindow().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "show-main-window") {
    void profileApi().showMainWindow().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "toggle-mini-expanded") {
    store.miniExpanded = !store.miniExpanded;
    store.miniScrollTop = 0;
    store.openProfileMenuId = null;
    render();
    return;
  }

  if (action === "open-global-instructions") {
    store.modal = { kind: "global-instructions" };
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
    store.openProfileMenuId = null;
    store.migrationSourceMenuOpen = false;
    store.migrationTargetMenuOpen = false;
    store.accountSyncMenuOpen = null;
    render();
    void refreshGlobalInstructions().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "refresh-global-instructions") {
    if (store.editingGlobalInstructionId) {
      setToast("先保存或取消当前编辑", "error");
      return;
    }
    void refreshGlobalInstructions().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "select-global-instruction" && id) {
    if (store.editingGlobalInstructionId && store.editingGlobalInstructionId !== id) {
      setToast("先保存或取消当前编辑", "error");
      return;
    }
    const file = store.globalInstructions?.files.find((item) => item.id === id);
    if (file) {
      store.activeGlobalInstructionId = file.id;
      render();
    }
    return;
  }

  if (action === "edit-global-instruction") {
    const file = store.globalInstructions?.files.find((item) => item.id === store.activeGlobalInstructionId);
    if (!file) {
      setToast("没有可编辑的全局指令文件", "error");
      return;
    }
    if (!file.editable) {
      setToast("CLAUDE.md 是引用壳，请编辑 AGENTS.md", "error");
      return;
    }

    store.editingGlobalInstructionId = file.id;
    store.globalInstructionDraft = file.content;
    render();
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-global-instruction-editor]")?.focus(), 0);
    return;
  }

  if (action === "cancel-global-instruction-edit") {
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
    render();
    return;
  }

  if (action === "save-global-instruction") {
    const file = store.globalInstructions?.files.find((item) => item.id === store.editingGlobalInstructionId);
    const fileName = file?.fileName || "全局指令";
    void saveGlobalInstruction()
      .then(() => setToast(`已保存 ${fileName}`))
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "repair-global-instruction-shell") {
    void repairClaudeInstructionShell()
      .then(() => setToast("已恢复 CLAUDE.md 引用壳"))
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "copy-global-instruction") {
    const file = store.globalInstructions?.files.find((item) => item.id === store.activeGlobalInstructionId);
    if (!file?.content) {
      setToast("当前文件没有可复制的内容", "error");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setToast("当前环境不能直接复制，请手动选中文本复制", "error");
      return;
    }

    void navigator.clipboard
      .writeText(file.content)
      .then(() => setToast(`已复制 ${file.fileName}`))
      .catch(() => setToast("复制失败，请手动选中文本复制", "error"));
    return;
  }

  if (action === "open-global-instruction") {
    const file = store.globalInstructions?.files.find((item) => item.id === store.activeGlobalInstructionId);
    if (!file?.exists) {
      setToast("当前文件不存在", "error");
      return;
    }

    void profileApi()
      .openPath(file.path)
      .then(() => setToast(`已打开 ${file.fileName}`))
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }


  if (action === "confirm-modal-action" && store.modal?.kind === "confirm") {
    executeConfirmIntent(store.modal.intent);
    return;
  }

  if (action === "toggle-account-sync-scope") {
    store.accountSyncScopeExpanded = !store.accountSyncScopeExpanded;
    render();
    return;
  }

  if (action === "toggle-extension-scan-preview") {
    store.extensionScanPreviewCollapsed = !store.extensionScanPreviewCollapsed;
    render();
    return;
  }

  if (action === "sync-account") {
    const sourceId = store.accountSyncSourceId;
    const targetId = store.accountSyncTargetId;
    const sourceProfile = store.state.profiles.find((profile) => profile.id === sourceId);
    const targetProfile = store.state.profiles.find((profile) => profile.id === targetId);
    if (!sourceId || !targetId || !sourceProfile || !targetProfile || sourceId === targetId) {
      setToast("请选择两个不同的 Profile", "error");
      return;
    }
    const shouldCloseTarget = targetProfile.running;
    const existingRecord =
      store.state.accountSyncRecords.find((record) => record.sourceProfileId === sourceId && record.targetProfileId === targetId) ||
      null;
    store.modal = {
      kind: "confirm",
      intent: {
        kind: "account-sync",
        sourceProfileId: sourceId,
        targetProfileId: targetId,
        shouldCloseTarget,
        existingRecordSyncedAt: existingRecord?.syncedAt || null,
        launchTarget: store.launchSyncedProfile
      }
    };
    render();
    return;
  }

  if (action === "cancel-account-sync") {
    const activeBusyState = store.busyState;
    if (!activeBusyState || activeBusyState.key !== "account-sync") {
      return;
    }

    updateBusyState({
      cancelRequested: true,
      message: "正在终止同步…未完成的临时数据会在下次同步前恢复或清理。"
    });

    void profileApi()
      .cancelOperation({ key: "account-sync", profileId: activeBusyState.profileId })
      .then((cancelled) => {
        if (!cancelled) {
          setToast("同步已经结束，未找到可终止的任务。", "error");
        }
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "toggle-account-sync-pause") {
    const activeBusyState = store.busyState;
    if (!activeBusyState || activeBusyState.key !== "account-sync" || activeBusyState.cancelRequested) {
      return;
    }

    const nextPaused = !activeBusyState.paused;
    updateBusyState({
      paused: nextPaused,
      message: nextPaused ? "正在暂停同步…当前文件复制完成后会停住。" : "正在继续同步…"
    });

    void profileApi()
      .controlOperation({
        key: "account-sync",
        profileId: activeBusyState.profileId,
        action: nextPaused ? "pause" : "resume"
      })
      .then((controlled) => {
        if (!controlled) {
          updateBusyState({
            paused: !nextPaused,
            message: "同步已经结束，未找到可控制的任务。"
          });
          setToast("同步已经结束，未找到可控制的任务。", "error");
        }
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "scan-extensions") {
    const sourceId = store.migrationSourceId;
    if (!sourceId) {
      setToast("先选择源 Profile", "error");
      return;
    }

    void withBusy(async () => {
      const scan = await profileApi().scanProfileExtensions(sourceId);
      store.extensionScan = scan;
      store.selectedExtensionIds = new Set(scan.extensions.map((extension) => extension.id));
      store.extensionScanPreviewCollapsed = false;
      store.extensionMigrationResult = null;
      invalidateExtensionMigrationDiff();
    }, "已扫描插件", {
      key: "scan-extensions",
      message: "正在扫描源 Profile 插件…"
    });
    return;
  }

  if (action === "select-all-extensions") {
    const activeScan = store.extensionScan?.profileId === store.migrationSourceId ? store.extensionScan : null;
    if (!activeScan) {
      return;
    }

    const allSelected = activeScan.extensions.every((extension) => store.selectedExtensionIds.has(extension.id));
    store.selectedExtensionIds = allSelected ? new Set() : new Set(activeScan.extensions.map((extension) => extension.id));
    invalidateExtensionMigrationDiff();
    render();
    if (store.modal?.kind === "extension-migration") {
      void refreshExtensionMigrationDiff();
    }
    return;
  }

  if (action === "migrate-extensions") {
    const activeScan = store.extensionScan?.profileId === store.migrationSourceId ? store.extensionScan : null;
    if (!store.migrationSourceId || !activeScan) {
      setToast("先扫描源 Profile 的插件", "error");
      return;
    }

    const selectedCount = activeScan.extensions.filter((extension) => store.selectedExtensionIds.has(extension.id)).length;
    if (!selectedCount) {
      setToast("先选择要同步的插件", "error");
      return;
    }

    const targetId =
      store.migrationTargetId && store.migrationTargetId !== store.migrationSourceId
        ? store.migrationTargetId
        : store.state.profiles.find((profile) => profile.id !== store.migrationSourceId)?.id || null;
    if (!targetId) {
      setToast("没有可用的目标 Profile", "error");
      return;
    }

    store.migrationTargetId = targetId;
    store.migrationTargetMenuOpen = false;
    store.modal = { kind: "extension-migration" };
    render();
    void refreshExtensionMigrationDiff();
    window.setTimeout(
      () => document.querySelector<HTMLButtonElement>("[data-migration-target-select] .profile-select-trigger")?.focus(),
      0
    );
    return;
  }

  if (action === "delete-extension") {
    const profileId = store.extensionScan?.profileId || store.migrationSourceId;
    const extensionId = actionTarget.dataset.extensionId;
    const extension = store.extensionScan?.extensions.find((item) => item.id === extensionId);
    if (!profileId || !extensionId || !extension) {
      setToast("请先扫描并选择要删除的插件", "error");
      return;
    }

    const profile = store.state.profiles.find((item) => item.id === profileId);
    if (!profile) {
      setToast("没有找到这个 Profile", "error");
      return;
    }
    if (profile.running) {
      setToast("删除插件前请先关闭这个 Profile，然后刷新列表。", "error");
      return;
    }
    store.modal = {
      kind: "confirm",
      intent: {
        kind: "delete-extension",
        profileId,
        extensionId
      }
    };
    render();
    return;
  }

  if (action === "open-target-extensions-page") {
    const profileId = actionTarget.dataset.profileId;
    if (!profileId) {
      setToast("没有找到目标 Profile", "error");
      return;
    }

    void withBusy(async () => {
      store.state = await profileApi().openProfileExtensionsPage(profileId);
      store.selectedId = profileId;
    }, "已打开目标扩展页", {
      key: "open-extensions-page",
      message: "正在打开目标 Profile 的扩展程序页面…",
      profileId
    });
    return;
  }

  if (action === "open-manual-extension-folder") {
    const targetPath = actionTarget.dataset.path;
    if (!targetPath) {
      setToast("没有找到插件目录", "error");
      return;
    }

    void withBusy(() => profileApi().openPath(targetPath), "已打开插件目录", {
      key: "open-extension-folder",
      message: "正在打开插件目录…"
    });
    return;
  }

  if (action === "copy-manual-extension-path") {
    const targetPath = actionTarget.dataset.path;
    if (!targetPath) {
      setToast("没有找到插件目录", "error");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setToast("当前环境不能直接复制，请手动选中路径复制", "error");
      return;
    }

    void navigator.clipboard
      .writeText(targetPath)
      .then(() => setToast("已复制插件目录路径"))
      .catch(() => setToast("复制失败，请手动选中路径复制", "error"));
    return;
  }

  if (action === "refresh") {
    void withBusy(() => loadState(), "已刷新", {
      key: "refresh",
      message: "正在刷新 Profile 状态…"
    });
    return;
  }

  if (action === "refresh-live-view") {
    refreshLiveViewNow();
    return;
  }

  if (action === "toggle-live-screenshot") {
    toggleLiveScreenshot();
    return;
  }

  if (action === "focus-live-tab") {
    const targetId = actionTarget.dataset.targetId;
    if (targetId && store.selectedId) {
      focusLiveTab(store.selectedId, targetId);
    }
    return;
  }

  if (action === "copy-live-url") {
    const url = actionTarget.dataset.url;
    if (!url) {
      setToast("没有可复制的链接", "error");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setToast("当前环境不能直接复制，请手动选中复制", "error");
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => setToast("已复制当前标签页链接"))
      .catch(() => setToast("复制失败，请手动选中复制", "error"));
    return;
  }

  if (action === "toggle-profile-menu" && id) {
    store.openProfileMenuId = store.openProfileMenuId === id ? null : id;
    store.selectedId = id;
    render();
    return;
  }

  if ((action === "pin-mini-profile" || action === "unpin-mini-profile") && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    const pinned = action === "pin-mini-profile";
    void withBusy(async () => {
      store.state = await profileApi().setMiniProfilePinned(id, pinned);
    }, pinned ? `已固定 ${emphasizeName(profile.name)} 到悬浮窗` : `已取消 ${emphasizeName(profile.name)} 的悬浮窗固定`, {
      key: "mini-pin",
      message: pinned ? `正在固定 ${profile.name}…` : `正在取消固定 ${profile.name}…`,
      profileId: id
    });
    return;
  }

  if (action === "rename-profile" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }

    store.modal = { kind: "rename", profileId: id };
    render();
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>("#profile-rename");
      input?.focus();
      input?.select();
    }, 0);
    return;
  }

  if (action === "select" && id) {
    store.selectedId = id;
    store.selectedExternalDir = null;
    render();
    requestLiveViewNow(id);
    return;
  }

  if (action === "select-external") {
    const dir = actionTarget.dataset.dir;
    if (dir) {
      store.selectedExternalDir = dir;
      store.selectedId = null;
      render();
    }
    return;
  }

  if (action === "launch" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (profile?.running) {
      setToast(`${emphasizeName(profile.name)} 已经在运行中`);
      return;
    }
    void withBusy(() => profileApi().launchProfile(id), `已启动 ${emphasizeName(profile?.name || "Profile")}`, {
      key: "launch-profile",
      message: `正在启动 ${profile?.name || "Profile"}…`,
      profileId: id
    });
    return;
  }

  if ((action === "mini-focus-profile" || action === "mini-launch" || action === "mini-launch-cdp") && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      setToast("这个 Profile 已不存在", "error");
      return;
    }

    store.openProfileMenuId = null;

    if (action === "mini-focus-profile") {
      if (!profile.running) {
        setToast(`${emphasizeName(profile.name)} 当前未运行`);
        return;
      }
      void focusProfileFromUi(profile);
      return;
    }

    if (action === "mini-launch") {
      if (profile.running) {
        setToast(`${emphasizeName(profile.name)} 已经在运行中`);
        return;
      }
      void withBusy(async () => {
        store.state = await profileApi().launchProfile(id);
      }, `已启动 ${emphasizeName(profile.name)}`, {
        key: "launch-profile",
        message: `正在启动 ${profile.name}…`,
        profileId: id
      });
      return;
    }

    if (action === "mini-launch-cdp") {
      if (profile.source !== "isolated") {
        setToast("系统 Profile 不支持端口式 CDP 启动", "error");
        return;
      }
      if (profile.running) {
        setToast(profile.cdpUrl ? `${emphasizeName(profile.name)} 已开启 CDP：${profile.cdpUrl}` : `先关闭 ${emphasizeName(profile.name)}，再以 CDP 模式启动`, profile.cdpUrl ? "normal" : "error");
        return;
      }
      void withBusy(async () => {
        const port = profile.fixedCdpPort ?? (await profileApi().suggestCdpPort(9223)).port;
        store.state = await profileApi().launchProfileWithCdp(id, port);
      }, `已以 CDP 启动 ${emphasizeName(profile.name)}`, {
        key: "launch-cdp",
        message: `正在以 CDP 启动 ${profile.name}…`,
        profileId: id
      });
      return;
    }

    return;
  }

  if (action === "launch-cdp" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (profile.source !== "isolated") {
      setToast("系统 Profile 不支持端口式 CDP 启动，请使用“连接”接入已运行系统 Chrome", "error");
      return;
    }
    if (profile.running) {
      setToast(profile.cdpUrl ? `${emphasizeName(profile.name)} 已开启 CDP：${profile.cdpUrl}` : `先关闭 ${emphasizeName(profile.name)}，再以 CDP 模式启动`, profile.cdpUrl ? "normal" : "error");
      return;
    }

    // 默认预填一个端口：优先用该 Profile 绑定的固定端口，否则取当前所有已用
    // CDP 端口里最大的 +1（选不选随用户，但要先给到一个合理默认值）。
    const usedPorts: number[] = [];
    for (const item of store.state.profiles) {
      for (const port of [item.cdpPort, item.fixedCdpPort, item.agentConfigPort]) {
        if (port) {
          usedPorts.push(port);
        }
      }
    }
    for (const instance of store.state.externalInstances || []) {
      if (instance.cdpPort) {
        usedPorts.push(instance.cdpPort);
      }
    }
    const preferredPort = profile.fixedCdpPort ?? (usedPorts.length ? Math.max(...usedPorts) + 1 : 9222);
    void profileApi()
      .suggestCdpPort(preferredPort)
      .then((portSuggestion) => {
        store.modal = { kind: "cdp", profileId: id, portSuggestion };
        render();
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>("#cdp-port");
          input?.focus();
          input?.select();
        }, 0);
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "open-agent-browser-setup") {
    if (!store.state.profiles.length) {
      setToast("还没有可用的 Profile 作为登录态来源", "error");
      return;
    }
    // 默认源：系统默认 Profile → 第一个已登录 Profile → 第一个。
    if (!store.clonePoolSourceId || !store.state.profiles.some((profile) => profile.id === store.clonePoolSourceId)) {
      const defaultSource =
        store.state.profiles.find((profile) => profile.source === "native" && profile.isDefault) ||
        store.state.profiles.find((profile) => profile.userName) ||
        store.state.profiles[0];
      store.clonePoolSourceId = defaultSource?.id || null;
    }
    store.clonePoolMenuOpen = false;
    store.modal = { kind: "clone-pool" };
    render();
    return;
  }

  if (action === "write-agent-config" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile || profile.source !== "isolated") {
      setToast("只有工具独立 Profile 才能设为 Agent 调试端点", "error");
      return;
    }
    const preferredPort = profile.cdpPort ?? profile.fixedCdpPort ?? 9223;
    if (profile.cdpPort) {
      store.modal = { kind: "agent-config", profileId: id, portSuggestion: null };
      render();
      window.setTimeout(() => document.querySelector<HTMLInputElement>("#agent-port")?.focus(), 0);
      return;
    }
    void profileApi()
      .suggestCdpPort(preferredPort)
      .then((portSuggestion) => {
        store.modal = { kind: "agent-config", profileId: id, portSuggestion };
        render();
        window.setTimeout(() => document.querySelector<HTMLInputElement>("#agent-port")?.focus(), 0);
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "clear-agent-config" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    void withBusy(() => profileApi().clearAgentBrowserConfig(id), `已从 AGENTS.md 移除 ${emphasizeName(profile?.name || "Profile")} 的 Agent 配置，并保持 CLAUDE.md 引用壳`, {
      key: "agent-config",
      message: "正在移除 Agent 配置…",
      profileId: id
    });
    return;
  }

  if (action === "focus-external" || action === "close-external") {
    const dir = actionTarget.dataset.dir;
    const instance = store.state.externalInstances?.find((item) => item.userDataDir === dir);
    if (!dir || !instance) {
      setToast("这个外部实例已不在运行");
      return;
    }

    if (action === "focus-external") {
      if (instance.headless) {
        setToast(`${emphasizeName(instance.label)} 是无头实例，没有可见窗口，无法显示`, "error");
        return;
      }
      void withBusy(async () => {
        store.state = await profileApi().focusExternalInstance(dir);
      }, `已显示 ${emphasizeName(instance.label)}`, {
        key: "focus-external",
        message: `正在显示 ${instance.label}…`,
        profileId: dir
      });
    } else {
      void withBusy(async () => {
        store.state = await profileApi().closeExternalInstance(dir);
      }, `已关闭 ${emphasizeName(instance.label)}`, {
        key: "close-external",
        message: `正在关闭 ${instance.label}…`,
        profileId: dir
      });
    }
    return;
  }

  if (action === "focus-profile" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${emphasizeName(profile.name)} 当前未运行`);
      return;
    }

    store.selectedId = id;
    requestLiveViewNow(id);
    void focusProfileFromUi(profile);
    return;
  }

  if (action === "close-profile" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${emphasizeName(profile.name)} 当前未运行`);
      return;
    }

    store.modal = {
      kind: "confirm",
      intent: {
        kind: "profile",
        action: "close",
        profileId: id
      }
    };
    render();
    return;
  }

  if (action === "open-folder" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);

    void withBusy(() => profileApi().openProfileFolder(id), "已打开目录", {
      key: "open-folder",
      message: `正在打开 ${profile?.name || "Profile"} 的目录…`,
      profileId: id
    });
    return;
  }

  if (action === "delete" && id) {
    const profile = store.state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.deletable) {
      setToast(deleteButtonTitle(profile), "error");
      return;
    }
    if (profile.running) {
      setToast(`删除 ${emphasizeName(profile.name)} 会先关闭浏览器，请确认`);
    }

    store.modal = {
      kind: "confirm",
      intent: {
        kind: "profile",
        action: "delete",
        profileId: id
      }
    };
    render();
  }
});

appRoot.addEventListener("change", (event) => {
  const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target || !store.state) {
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-launch-synced-profile]")) {
    store.launchSyncedProfile = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-clone-pool-count]")) {
    store.clonePoolCount = clampCloneCount(Number(target.value));
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-clone-pool-include-ext]")) {
    store.clonePoolIncludeExtensions = target.checked;
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-clone-pool-launch]")) {
    store.clonePoolLaunchAfter = target.checked;
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-clone-pool-set-endpoint]")) {
    store.clonePoolSetEndpoint = target.checked;
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-clone-pool-recycle-days]")) {
    const parsed = Math.round(Number(target.value));
    store.clonePoolRecycleDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-extension-select]")) {
    const extensionId = target.dataset.extensionId;
    if (!extensionId) {
      return;
    }
    if (target.checked) {
      store.selectedExtensionIds.add(extensionId);
    } else {
      store.selectedExtensionIds.delete(extensionId);
    }
    store.extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    render();
    if (store.modal?.kind === "extension-migration") {
      void refreshExtensionMigrationDiff();
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-include-extension-data]")) {
    store.includeExtensionData = target.checked;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-extension-only-changed]")) {
    store.extensionSyncOnlyChanged = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-open-install-pages]")) {
    store.openInstallPages = target.checked;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
  }
});

appRoot.addEventListener("input", (event) => {
  const target = event.target instanceof HTMLTextAreaElement ? event.target : null;
  if (!target?.matches("[data-global-instruction-editor]")) {
    return;
  }

  store.globalInstructionDraft = target.value;
  const count = document.querySelector("[data-global-instruction-draft-count]");
  if (count) {
    count.textContent = `${target.value.length} 字符`;
  }
});

appRoot.addEventListener("dblclick", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) {
    return;
  }

  if (target.closest("[data-live-zoom-frame]")) {
    closeModalFromUi();
    return;
  }

  const liveScreen = target.closest<HTMLElement>("[data-live-zoom-profile-id]");
  if (!liveScreen) {
    return;
  }

  event.preventDefault();
  const profileId = liveScreen.dataset.liveZoomProfileId || null;
  openLiveZoom(profileId);
  render();
  requestLiveViewNow(profileId);
});

appRoot.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && store.modal?.kind === "live-zoom") {
    closeModalFromUi();
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  const liveScreen = target?.closest<HTMLElement>("[data-live-zoom-profile-id]");
  if (liveScreen && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    const profileId = liveScreen.dataset.liveZoomProfileId || null;
    openLiveZoom(profileId);
    render();
    requestLiveViewNow(profileId);
    return;
  }

  if (event.key === "Escape" && (store.migrationSourceMenuOpen || store.migrationTargetMenuOpen || store.accountSyncMenuOpen)) {
    store.migrationSourceMenuOpen = false;
    store.migrationTargetMenuOpen = false;
    store.accountSyncMenuOpen = null;
    render();
    return;
  }

  const row = target?.closest<HTMLElement>("[data-profile-row]");
  if (!row || !store.state || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }

  event.preventDefault();
  const id = row.dataset.id;
  if (id) {
    store.selectedId = id;
    render();
    requestLiveViewNow(id);
  }
});

appRoot.addEventListener("submit", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const createForm = target?.closest<HTMLFormElement>("[data-create-form]");
  const renameForm = target?.closest<HTMLFormElement>("[data-rename-form]");
  const cdpForm = target?.closest<HTMLFormElement>("[data-cdp-form]");
  const agentConfigForm = target?.closest<HTMLFormElement>("[data-agent-config-form]");
  const agentBrowserForm = target?.closest<HTMLFormElement>("[data-agent-browser-form]");
  const extensionMigrationForm = target?.closest<HTMLFormElement>("[data-extension-migration-form]");
  const cloneTagForm = target?.closest<HTMLFormElement>("[data-clone-tag-form]");
  if (!createForm && !renameForm && !cdpForm && !agentConfigForm && !agentBrowserForm && !extensionMigrationForm && !cloneTagForm) {
    return;
  }

  event.preventDefault();

  if (cloneTagForm) {
    const profileId = cloneTagForm.dataset.profileId;
    const profile = store.state?.profiles.find((item) => item.id === profileId);
    if (!profileId || !profile) {
      return;
    }
    const data = new FormData(cloneTagForm);
    const tag = String(data.get("tag") || "").trim();
    // 标签弹窗是从副本池弹窗里打开的，保存后回到副本池而不是回主页。
    store.modal = { kind: "clone-pool" };
    void withBusy(
      async () => {
        store.state = await profileApi().setProfileTag(profileId, tag);
        store.selectedId = profileId;
      },
      tag ? `已给 ${emphasizeName(profile.name)} 设置标签「${tag}」` : `已清除 ${emphasizeName(profile.name)} 的标签`,
      { key: "set-clone-tag", message: "正在保存标签…", profileId }
    );
    return;
  }

  if (agentBrowserForm) {
    const sourceId = agentBrowserForm.dataset.sourceId;
    if (!sourceId) {
      return;
    }
    const data = new FormData(agentBrowserForm);
    const name = String(data.get("name") || "").trim();
    const port = Number(String(data.get("port") || "").trim());
    if (!name) {
      setToast("请填写 Agent Profile 名称", "error");
      return;
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setToast("调试端口必须是 1024-65535 之间的整数", "error");
      return;
    }
    store.modal = null;
    const includeExtensions = data.has("includeExtensions");
    void withBusy(
      async () => {
        const result = await profileApi().setupAgentBrowser({
          sourceProfileId: sourceId,
          targetName: name,
          port,
          includeExtensions
        });
        store.state = result.state;
        const extensionCount =
          (result.extensionResult?.copiedExtensions.length || 0) +
          (result.extensionResult?.loadedLocalExtensions.length || 0);
        setToast(
          includeExtensions && result.extensionResult
            ? `Agent 浏览器已就绪：agent-browser connect ${result.port}，已同步 ${extensionCount} 个插件`
            : `Agent 浏览器已就绪：agent-browser connect ${result.port}`
        );
      },
      undefined,
      { key: "setup-agent-browser", message: "正在准备 Agent 浏览器…" }
    );
    return;
  }

  if (agentConfigForm) {
    const profileId = agentConfigForm.dataset.profileId;
    const profile = store.state?.profiles.find((item) => item.id === profileId);
    if (!profileId || !profile) {
      return;
    }
    const data = new FormData(agentConfigForm);
    const parsedPort = Number(String(data.get("port") || "").trim());
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      setToast("调试端口必须是 1024-65535 之间的整数", "error");
      return;
    }
    store.modal = null;
    void withBusy(
      () => profileApi().setAgentBrowserConfig(profileId, parsedPort),
      `已写入全局 AGENTS.md：Agent 优先连接 ${emphasizeName(profile.name)}（端口 ${parsedPort}），CLAUDE.md 保持引用壳`,
      { key: "agent-config", message: "正在写入 Agent 配置…", profileId }
    );
    return;
  }

  if (extensionMigrationForm) {
    const sourceId = store.migrationSourceId;
    const activeScan = store.extensionScan?.profileId === sourceId ? store.extensionScan : null;
    const data = new FormData(extensionMigrationForm);
    const targetProfileId = String(data.get("targetProfileId") || "").trim();
    let extensionIds = activeScan?.extensions
      .filter((extension) => store.selectedExtensionIds.has(extension.id))
      .map((extension) => extension.id) || [];
    const originallySelectedCount = extensionIds.length;

    if (!sourceId || !activeScan) {
      setToast("先扫描源 Profile 的插件", "error");
      return;
    }
    if (!targetProfileId || targetProfileId === sourceId) {
      setToast("请选择一个不同的目标 Profile", "error");
      return;
    }
    if (!extensionIds.length) {
      setToast("先选择要同步的插件", "error");
      return;
    }

    store.includeExtensionData = data.has("includeData");
    store.openInstallPages = data.has("openInstallPages");
    store.extensionSyncOnlyChanged = data.has("onlyChanged");
    const sourceProfile = store.state?.profiles.find((profile) => profile.id === sourceId) || null;
    const targetProfile = store.state?.profiles.find((profile) => profile.id === targetProfileId) || null;
    if (!targetProfile) {
      setToast("没有找到目标 Profile", "error");
      return;
    }
    const shouldCloseSource = Boolean(store.includeExtensionData && sourceProfile?.running);

    if (store.extensionSyncOnlyChanged) {
      if (store.extensionMigrationDiffLoading || !store.extensionMigrationDiff) {
        setToast("插件差异还在检查，请稍后再同步。", "error");
        void refreshExtensionMigrationDiff();
        return;
      }

      const selectedActionIds = new Set(store.extensionMigrationDiff.items.filter(isExtensionMigrationActionItem).map((item) => item.id));
      extensionIds = extensionIds.filter((extensionId) => selectedActionIds.has(extensionId));
      if (!extensionIds.length) {
        setToast("当前没有需要同步的变更插件。", "normal");
        render();
        return;
      }
    }

    const shouldCloseTarget = targetProfile.running;
    store.migrationTargetId = targetProfileId;
    store.modal = {
      kind: "confirm",
      returnTo: "extension-migration",
      intent: {
        kind: "extension-migration",
        sourceProfileId: sourceId,
        targetProfileId,
        extensionIds,
        selectedCount: originallySelectedCount,
        includeData: store.includeExtensionData,
        openInstallPages: store.openInstallPages,
        onlyChanged: store.extensionSyncOnlyChanged,
        shouldCloseTarget,
        shouldCloseSource
      }
    };
    render();
    return;
  }

  if (cdpForm) {
    const profileId = cdpForm.dataset.profileId;
    if (!profileId) {
      return;
    }

    const profile = store.state?.profiles.find((item) => item.id === profileId);
    const data = new FormData(cdpForm);
    const rawPort = String(data.get("port") || "").trim();
    let port: number | null = null;
    if (rawPort) {
      const parsedPort = Number(rawPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
        setToast("CDP 端口必须是 1024-65535 之间的整数", "error");
        return;
      }
      port = parsedPort;
    }

    store.modal = null;
    void withBusy(() => profileApi().launchProfileWithCdp(profileId, port), `已以 CDP 启动 ${emphasizeName(profile?.name || "Profile")}`, {
      key: "launch-cdp",
      message: `正在以 CDP 启动 ${profile?.name || "Profile"}…`,
      profileId
    });
    return;
  }

  if (renameForm) {
    const profileId = renameForm.dataset.profileId;
    const profile = store.state?.profiles.find((item) => item.id === profileId);
    if (!profileId || !profile) {
      return;
    }

    const data = new FormData(renameForm);
    const name = String(data.get("name") || "").trim();

    void withBusy(async () => {
      const nextState = await profileApi().renameProfile(profileId, name);
      store.state = nextState;
      store.selectedId = profileId;
      store.modal = null;
    }, `已改名为 ${name}`, {
      key: "rename-profile",
      message: "正在保存名称…",
      profileId
    });
    return;
  }

  const data = new FormData(createForm as HTMLFormElement);
  const name = String(data.get("name") || "").trim();

  void withBusy(async () => {
    const nextState = await profileApi().createProfile(name);
    store.state = nextState;
    store.selectedId = store.state.profiles[0]?.id || null;
    store.modal = null;
  }, `已创建 ${name}`, {
    key: "create-profile",
    message: `正在创建 ${name}…`
  });
});

if (store.viewMode === "mini") {
  render();
}

loadState().catch((error: unknown) => {
  appRoot.innerHTML = `<div class="app-loading p-8 text-muted font-mono text-[13px] tracking-[0.08em] uppercase">${escapeHtml(formatErrorMessage(error))}</div>`;
});

if (store.viewMode === "mini") {
  let lastMiniScrollAt = 0;
  let miniPanelTransitionId = 0;
  let miniPanelClosing = false;
  let suppressMiniClick = false;
  let miniDragState: {
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    dragging: boolean;
  } | null = null;
  const miniDragThreshold = 4;
  const miniPanelAnimationMs = 180;
  let miniPanelAnimationTimer: number | null = null;
  const clearMiniPanelAnimation = (): void => {
    if (miniPanelAnimationTimer !== null) {
      window.clearTimeout(miniPanelAnimationTimer);
      miniPanelAnimationTimer = null;
    }
    document.body.classList.remove("mini-expanding", "mini-collapsing");
  };
  const markMiniPanelAnimation = (className: "mini-expanding" | "mini-collapsing"): void => {
    clearMiniPanelAnimation();
    // Force the class transition to start from a clean frame after repeated quick toggles.
    void document.body.offsetWidth;
    document.body.classList.add(className);
    miniPanelAnimationTimer = window.setTimeout(() => {
      miniPanelAnimationTimer = null;
      document.body.classList.remove(className);
    }, miniPanelAnimationMs + 80);
  };
  const applyMiniPanelOpen = (open: boolean): void => {
    if (store.miniPanelOpen === open) {
      return;
    }

    store.miniPanelOpen = open;
    if (!open) {
      store.openProfileMenuId = null;
    }
    render();
  };
  const setMiniPanelOpen = (open: boolean): void => {
    if (store.miniPanelOpen === open && !miniPanelClosing) {
      return;
    }

    if (!open) {
      if (!store.miniPanelOpen || miniPanelClosing) {
        return;
      }

      const transitionId = ++miniPanelTransitionId;
      miniPanelClosing = true;
      store.openProfileMenuId = null;
      render();
      markMiniPanelAnimation("mini-collapsing");
      // 收起时让 mini-collapsing 一直保留到下面 .then 里渲染出 dock 再清除：
      // 取消“安全兜底”自动移除，否则它会在窗口已缩小、dock 还没渲染出来之前抢先摘掉这个类，
      // shell 的 opacity 从 0 弹回 1，被裁进 80px 窗口里闪出一个方框。
      if (miniPanelAnimationTimer !== null) {
        window.clearTimeout(miniPanelAnimationTimer);
        miniPanelAnimationTimer = null;
      }
      window.setTimeout(() => {
        if (miniPanelTransitionId !== transitionId) {
          return;
        }
        void profileApi()
          .setMiniWindowPanelOpen(false)
          .then(() => {
            if (miniPanelTransitionId !== transitionId) {
              return;
            }

            miniPanelClosing = false;
            // 先渲染出 dock（替换掉 shell），再清除动画类，
            // 避免清除动画的瞬间 shell 以 opacity:1 在 64px 窗口里闪一下。
            applyMiniPanelOpen(false);
            clearMiniPanelAnimation();
          })
          .catch((error: unknown) => {
            if (miniPanelTransitionId === transitionId) {
              miniPanelClosing = false;
              clearMiniPanelAnimation();
            }
            setToast(formatErrorMessage(error), "error");
          });
      }, miniPanelAnimationMs);
      return;
    }

    const transitionId = ++miniPanelTransitionId;
    miniPanelClosing = false;
    clearMiniPanelAnimation();
    void profileApi()
      .setMiniWindowPanelOpen(true)
      .then(() => {
        if (miniPanelTransitionId === transitionId) {
          markMiniPanelAnimation("mini-expanding");
          applyMiniPanelOpen(true);
        }
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  };
  const markMiniScroll = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const list = target?.closest<HTMLElement>(".mini-profile-list");
    if (list) {
      lastMiniScrollAt = Date.now();
      store.miniScrollTop = list.scrollTop;
    }
  };
  const isMiniDragTarget = (target: Element | null): boolean => {
    if (!target?.closest(".mini-root")) {
      return false;
    }

    if (target.closest(".mini-profile-menu")) {
      return false;
    }

    // 折叠态的圆 logo 整块可拖拽（它本身是按钮）。
    if (target.closest(".mini-logo-dock")) {
      return true;
    }

    // 展开态里点按钮（查看更多 / 收起 / 展开 / 行操作 / ⋯）只能是点击，不应触发拖拽——
    // 否则拖拽的 start/end 会关闭并重建覆盖窗，导致面板瞬间失焦被收起。
    if (target.closest("button")) {
      return false;
    }

    return true;
  };
  const sendMiniDrag = (screenX: number, screenY: number, phase: "start" | "move" | "end"): void => {
    void profileApi().dragMiniWindow(screenX, screenY, phase).catch(() => {
      // Dragging is best-effort; failures should not interrupt normal mini controls.
    });
  };
  const finishMiniDrag = (event: PointerEvent): void => {
    if (!miniDragState || miniDragState.pointerId !== event.pointerId) {
      return;
    }

    if (miniDragState.dragging) {
      suppressMiniClick = true;
      event.preventDefault();
      event.stopPropagation();
    }
    sendMiniDrag(event.screenX, event.screenY, "end");
    miniDragState = null;
    document.body.classList.remove("mini-dragging");
  };

  appRoot.addEventListener(
    "click",
    (event) => {
      if (!suppressMiniClick) {
        return;
      }

      suppressMiniClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true }
  );
  appRoot.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (!isMiniDragTarget(target)) {
        return;
      }

      miniDragState = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        dragging: false
      };
      try {
        target?.setPointerCapture(event.pointerId);
      } catch {
        // Some SVG children cannot capture; pointer events still work while inside the window.
      }
      sendMiniDrag(event.screenX, event.screenY, "start");
    },
    { capture: true }
  );
  appRoot.addEventListener(
    "pointermove",
    (event) => {
      if (!miniDragState || miniDragState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.screenX - miniDragState.startScreenX;
      const deltaY = event.screenY - miniDragState.startScreenY;
      if (!miniDragState.dragging && Math.hypot(deltaX, deltaY) < miniDragThreshold) {
        return;
      }

      miniDragState.dragging = true;
      document.body.classList.add("mini-dragging");
      event.preventDefault();
      event.stopPropagation();
      sendMiniDrag(event.screenX, event.screenY, "move");
    },
    { capture: true }
  );
  appRoot.addEventListener("pointerup", finishMiniDrag, { capture: true });
  appRoot.addEventListener("pointercancel", finishMiniDrag, { capture: true });
  appRoot.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target?.closest<HTMLElement>('[data-action="toggle-mini-panel"]');
      if (!toggle) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setMiniPanelOpen(!store.miniPanelOpen);
    },
    { capture: true }
  );
  appRoot.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && store.miniPanelOpen) {
      setMiniPanelOpen(false);
    }
  });
  profileApi().onMiniWindowPanelOpenChanged((open) => {
    if (!open) {
      if (miniPanelClosing || !store.miniPanelOpen) {
        return;
      }

      setMiniPanelOpen(false);
      return;
    }

    miniPanelTransitionId += 1;
    miniPanelClosing = false;
    markMiniPanelAnimation("mini-expanding");
    applyMiniPanelOpen(true);
  });
  appRoot.addEventListener("wheel", markMiniScroll, { passive: true });
  appRoot.addEventListener("scroll", markMiniScroll, { capture: true, passive: true });

  window.setInterval(() => {
    if (!store.busy && !miniDragState && Date.now() - lastMiniScrollAt > 900) {
      void loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    }
  }, 2500);
}

// 主窗口轻量轮询：让“驱动中 / 运行状态 / CDP 地址”等实时刷新。
// 跳过条件：正忙、窗口隐藏（切到悬浮窗）、有弹窗、或页面上有下拉菜单展开——避免打断正在进行的操作或输入。
if (store.viewMode === "main") {
  startLiveViewLoop();

  window.setInterval(() => {
    if (store.busy || document.hidden || store.modal) {
      return;
    }
    if (
      store.openProfileMenuId ||
      store.migrationSourceMenuOpen ||
      store.migrationTargetMenuOpen ||
      store.accountSyncMenuOpen ||
      store.clonePoolMenuOpen
    ) {
      return;
    }

    void loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }, 3000);
}
