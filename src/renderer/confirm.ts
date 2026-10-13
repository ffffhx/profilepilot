export { renderConfirmModal, confirmModalView, extensionMigrationConfirmDataLine } from "./render/confirm";
import { profileApi } from "./api";
import { leaveControlPreferences } from "./control-preferences";
import { accountSyncProgressStepsForTarget, emphasizeName, extensionSyncProgressStepsForProfiles, pendingBusySteps, setToast, withBusy } from "./busy";
import { invalidateView as render } from "./view-events";
import { invalidateExtensionMigrationDiff, loadState } from "./state-actions";
import { store } from "./state";
import type { PublicProfile, TakeoverAgentConnectionsResponse } from "../shared/types";
import type { ConfirmIntent } from "./types";
import { formatErrorMessage, isWindowsNativeAgentTemplate, prettyCdpClientLabel, profileAgentControlClients } from "./util";

export function closeModalFromUi(): void {
  if (store.modal?.kind === "control-preferences") {
    leaveControlPreferences("close");
    return;
  }
  if (store.modal?.kind === "live-zoom" && store.modal.returnTo === "profile-details") {
    store.modal = { kind: "profile-details", profileId: store.modal.profileId };
  } else if (store.modal?.kind === "confirm" && store.modal.returnTo === "extension-migration") {
    store.modal = { kind: "extension-migration" };
  } else if (store.modal?.kind === "confirm" && store.modal.returnTo === "clone-pool") {
    store.modal = { kind: "clone-pool" };
  } else if (store.modal?.kind === "clone-tag") {
    // 标签弹窗是从副本池弹窗打开的，取消后回到副本池。
    store.modal = { kind: "clone-pool" };
  } else {
    store.modal = null;
  }
  store.migrationTargetMenuOpen = false;
  render();
}

export function executeConfirmIntent(intent: ConfirmIntent): void {
  if (intent.kind === "disable-bifrost-rule") {
    executeDisableBifrostRuleConfirm(intent);
    return;
  }

  if (intent.kind === "remove-profile-bifrost-rule") {
    executeRemoveProfileBifrostRuleConfirm(intent);
    return;
  }

  if (intent.kind === "profile") {
    executeProfileConfirm(intent);
    return;
  }

  if (intent.kind === "close-profile-for-bifrost") {
    executeCloseProfileForBifrostConfirm(intent);
    return;
  }

  if (intent.kind === "profile-sync") {
    executeProfileSyncConfirm(intent);
    return;
  }

  if (intent.kind === "delete-extension") {
    executeDeleteExtensionConfirm(intent);
    return;
  }

  if (intent.kind === "clone-profiles") {
    executeCloneProfilesConfirm(intent);
    return;
  }

  if (intent.kind === "refresh-clones") {
    executeRefreshClonesConfirm(intent);
    return;
  }

  if (intent.kind === "reset-clone") {
    executeResetCloneConfirm(intent);
    return;
  }


  if (intent.kind === "disconnect-client") {
    executeDisconnectClientConfirm(intent);
    return;
  }

  if (intent.kind === "agent-takeover") {
    executeAgentTakeoverConfirm(intent);
    return;
  }

  if (intent.kind === "bifrost-bypass-launch") {
    executeBifrostBypassLaunchConfirm(intent);
    return;
  }

  executeExtensionMigrationConfirm(intent);
}

export function executeDisableBifrostRuleConfirm(
  intent: Extract<ConfirmIntent, { kind: "disable-bifrost-rule" }>
): void {
  store.modal = null;
  render();

  void withBusy(
    async () => {
      store.bifrostSnapshot = await profileApi().disableBifrostRule(intent.ruleName);
    },
    `已停用规则 ${emphasizeName(intent.ruleName)}`,
    {
      key: "disable-bifrost-rule",
      message: `正在停用规则 ${intent.ruleName}…`
    }
  );
}

export function executeRemoveProfileBifrostRuleConfirm(
  intent: Extract<ConfirmIntent, { kind: "remove-profile-bifrost-rule" }>
): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  const config = profile?.bifrostProxy;
  const references = config ? [...config.rules, ...config.groupRules] : [];
  const selectedRules = intent.ruleKind === "local" ? config?.rules : config?.groupRules;
  const disabledRules = new Set(config?.disabledRules || []);
  const disabledGroupRules = new Set(config?.disabledGroupRules || []);
  const selectedDisabledRules = intent.ruleKind === "local" ? disabledRules : disabledGroupRules;
  const activeRuleCount = references.length - disabledRules.size - disabledGroupRules.size;
  store.modal = null;

  if (!profile || !config || !selectedRules?.includes(intent.ruleRef) || selectedDisabledRules.has(intent.ruleRef)) {
    render();
    setToast("这条专属分流规则已停用或不存在", "error");
    return;
  }
  if (activeRuleCount <= 1) {
    render();
    setToast("专属分流至少需要保留一条启用规则", "error");
    return;
  }

  render();
  const nextConfig = {
    kind: "bifrost" as const,
    listenerPort: config.listenerPort,
    rules: [...config.rules],
    groupRules: [...config.groupRules],
    disabledRules: intent.ruleKind === "local"
      ? [...disabledRules, intent.ruleRef]
      : [...disabledRules],
    disabledGroupRules: intent.ruleKind === "group"
      ? [...disabledGroupRules, intent.ruleRef]
      : [...disabledGroupRules]
  };
  void withBusy(
    async () => {
      store.state = await profileApi().setProfileProxy(profile.id, nextConfig);
    },
    `已在 ${emphasizeName(profile.name)} 中停用规则 ${emphasizeName(intent.ruleRef)}`,
    {
      key: "remove-profile-bifrost-rule",
      message: `正在更新 ${profile.name} 的专属分流…`,
      profileId: profile.id
    }
  );
}

export function executeBifrostBypassLaunchConfirm(intent: Extract<ConfirmIntent, { kind: "bifrost-bypass-launch" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  store.modal = null;

  if (!profile) {
    render();
    setToast("这个 Profile 已不存在", "error");
    return;
  }

  void withBusy(
    async () => {
      store.state = intent.cdpPort !== null
        ? await profileApi().launchProfileWithCdp(intent.profileId, intent.cdpPort, { bypassProxy: true })
        : await profileApi().launchProfile(intent.profileId, { bypassProxy: true });
    },
    `已直连启动 ${emphasizeName(profile.name)}（本次不走 Bifrost 分流）`,
    {
      key: intent.cdpPort !== null ? "launch-cdp" : "launch-profile",
      message: `正在直连启动 ${profile.name}…`,
      profileId: intent.profileId
    }
  );
}

export function executeBifrostStartAndLaunch(
  intent: Extract<ConfirmIntent, { kind: "bifrost-bypass-launch" }>
): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  store.modal = null;

  if (!profile) {
    render();
    setToast("这个 Profile 已不存在", "error");
    return;
  }

  void withBusy(
    async () => {
      const api = profileApi();
      store.state = intent.cdpPort !== null
        ? await api.launchProfileWithCdp(intent.profileId, intent.cdpPort, { startBifrost: true })
        : await api.launchProfile(intent.profileId, { startBifrost: true });
      store.bifrostSnapshot = await api.getBifrostSnapshot().catch(() => store.bifrostSnapshot);
    },
    `已启动 Bifrost，并通过专属分流启动 ${emphasizeName(profile.name)}`,
    {
      key: intent.cdpPort !== null ? "launch-cdp" : "launch-profile",
      message: `正在启动 Bifrost、恢复分流并启动 ${profile.name}…`,
      profileId: intent.profileId
    }
  );
}

export function executeAgentTakeoverConfirm(intent: Extract<ConfirmIntent, { kind: "agent-takeover" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  const clients = profile ? profileAgentControlClients(profile) : [];
  store.modal = null;

  if (!profile || !clients.length) {
    render();
    setToast("这个 Profile 现在没有可接管的 AI 连接", "error");
    return;
  }

  void withBusy(
    async () => {
      const result = await profileApi().takeoverAgentConnections(intent.profileId);
      store.state = result.state;
      if (!result.targetCount) {
        throw new Error("这个 Profile 现在没有可接管的 AI 连接");
      }
      if (!result.allStopped) {
        throw new Error(takeoverResultError(result));
      }
    },
    `已接管 ${emphasizeName(profile.name)}；执行面已静默，可以安全操作`,
    {
      key: "agent-takeover",
      message: `正在封锁 ${profile.name} 的新命令，并等待当前命令收敛…`,
      profileId: intent.profileId
    }
  );
}

function takeoverResultError(result: TakeoverAgentConnectionsResponse): string {
  const firstFailure = result.failures[0];
  const suffix = firstFailure ? `：${firstFailure.error}` : "";
  if (result.successCount > 0) {
    return `只暂停了 ${result.successCount}/${result.targetCount} 条 AI 连接，${result.failureCount} 条未暂停${suffix}`;
  }
  return `没有暂停任何 AI 连接${suffix}`;
}

export function executeDisconnectClientConfirm(intent: Extract<ConfirmIntent, { kind: "disconnect-client" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  const client = profile?.cdpClients.find((item) => item.pid === intent.pid);
  store.modal = null;

  if (!profile || !client) {
    render();
    setToast("这个驱动连接已经不在了", "error");
    return;
  }

  const tool = client.agent || prettyCdpClientLabel(client.label);
  void withBusy(
    async () => {
      store.state = await profileApi().disconnectCdpClient(intent.profileId, intent.pid);
    },
    `已结束 ${emphasizeName(tool)} 的驱动连接`,
    { key: "disconnect-client", message: `正在结束 ${tool} 的连接…`, profileId: intent.profileId }
  );
}

export function executeCloneProfilesConfirm(intent: Extract<ConfirmIntent, { kind: "clone-profiles" }>): void {
  const source = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state?.platform, source || null);
  // 保持副本池弹窗开着，过程中显示进度，完成后直接看到新副本列表。
  store.modal = { kind: "clone-pool" };
  if (!source) {
    render();
    setToast("没有找到源 Profile", "error");
    return;
  }

  void withBusy(
    async () => {
      const result = await profileApi().cloneProfiles({
        sourceProfileId: intent.sourceProfileId,
        count: intent.count,
        namePrefix: intent.namePrefix,
        includeExtensions: intent.includeExtensions,
        launchAfter: intent.launchAfter
      });
      store.state = result.state;
      store.clonePoolSourceId = intent.sourceProfileId;
      setToast(
        windowsNativeTemplate
          ? `已创建 ${result.created.length} 个 Agent 浏览器，请首次启动后分别登录`
          : `已克隆 ${result.created.length} 个副本，登录状态请在目标网站验证`
      );
    },
    undefined,
    { key: "clone-profiles", message: `正在克隆 ${intent.count} 份…` }
  );
}

export function executeRefreshClonesConfirm(intent: Extract<ConfirmIntent, { kind: "refresh-clones" }>): void {
  const source = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state?.platform, source || null);
  store.modal = { kind: "clone-pool" };
  if (!source) {
    render();
    setToast("没有找到源 Profile", "error");
    return;
  }

  void withBusy(
    async () => {
      const result = await profileApi().refreshClones(intent.sourceProfileId);
      store.state = result.state;
      store.clonePoolSourceId = intent.sourceProfileId;
      setToast(
        `已${windowsNativeTemplate ? "更新" : "刷新"} ${result.refreshedCount} 个副本${windowsNativeTemplate ? "的书签模板" : "数据"}${result.skippedCount ? `，跳过 ${result.skippedCount} 个` : ""}`
      );
    },
    undefined,
    { key: "refresh-clones", message: windowsNativeTemplate ? "正在更新副本书签模板…" : "正在刷新副本数据…" }
  );
}

export function executeResetCloneConfirm(intent: Extract<ConfirmIntent, { kind: "reset-clone" }>): void {
  const clone = store.state?.profiles.find((profile) => profile.id === intent.profileId);
  const source = clone?.clonedFromProfileId
    ? store.state?.profiles.find((profile) => profile.id === clone.clonedFromProfileId) || null
    : null;
  const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state?.platform, source);
  store.modal = { kind: "clone-pool" };
  if (!clone) {
    render();
    setToast("没有找到这个副本", "error");
    return;
  }

  void withBusy(
    async () => {
      const result = await profileApi().resetClone(intent.profileId);
      store.state = result.state;
      store.selectedId = intent.profileId;
    },
    windowsNativeTemplate
      ? `已更新 ${emphasizeName(clone.name)} 的书签模板`
      : `已重置 ${emphasizeName(clone.name)} 的 Profile 数据`,
    { key: "reset-clone", message: `正在${windowsNativeTemplate ? "更新" : "重置"} ${clone.name}…`, profileId: intent.profileId }
  );
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

export function executeCloseProfileForBifrostConfirm(
  intent: Extract<ConfirmIntent, { kind: "close-profile-for-bifrost" }>
): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  store.modal = null;

  if (!profile) {
    render();
    return;
  }

  if (!profile.running) {
    store.modal = {
      kind: "bifrost-proxy",
      profileId: profile.id,
      snapshot: store.bifrostSnapshot
    };
    render();
    return;
  }

  void withBusy(
    async () => {
      store.state = await profileApi().closeProfile(profile.id);
      let snapshot = store.bifrostSnapshot;
      try {
        snapshot = await profileApi().getBifrostSnapshot();
        store.bifrostSnapshot = snapshot;
      } catch {
        // 关闭 Profile 已成功时，读取 Bifrost 快照失败不应阻断用户继续编辑已保存的分流配置。
      }
      store.modal = {
        kind: "bifrost-proxy",
        profileId: profile.id,
        snapshot
      };
    },
    `已关闭 ${emphasizeName(profile.name)}，现在可以配置独立分流`,
    {
      key: "close-profile",
      message: `正在关闭 ${profile.name} 并准备分流设置…`,
      profileId: profile.id
    }
  );
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

export function executeProfileSyncConfirm(intent: Extract<ConfirmIntent, { kind: "profile-sync" }>): void {
  const sourceProfile = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const targetProfile = store.state?.profiles.find((profile) => profile.id === intent.targetProfileId);
  store.modal = null;

  if (!sourceProfile || !targetProfile) {
    render();
    setToast("请选择两个不同的 Profile", "error");
    return;
  }

  // 只同步账号时沿用 syncAccount 自带的“同步后启动 + 恢复标签页”；
  // 带插件阶段时改为最后统一启动，避免账号阶段刚启动目标、插件阶段又要关闭它。
  const launchViaAccountSync = intent.syncAccount && !intent.syncExtensions && intent.launchTarget;

  void (async () => {
    if (intent.syncAccount) {
      let accountDone = false;
      const progressSteps = accountSyncProgressStepsForTarget(targetProfile);
      await withBusy(async () => {
        const result = await profileApi().syncAccount({
          sourceProfileId: intent.sourceProfileId,
          targetProfileId: intent.targetProfileId,
          launchTarget: launchViaAccountSync,
          onlyChanged: false
        });
        store.accountSyncResult = result;
        // 同步完成后源目标已一致，之前扫出的差异作废。
        store.accountSyncDiff = null;
        store.state = result.state;
        store.selectedId = result.targetProfileId;
        accountDone = true;
      }, launchViaAccountSync
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
      // 账号阶段失败或被终止时，不再继续插件和启动阶段。
      if (!accountDone) {
        return;
      }
    }

    if (intent.syncExtensions) {
      let extensionsDone = false;
      const progressSteps = extensionSyncProgressStepsForProfiles(sourceProfile, targetProfile, false);
      await withBusy(async () => {
        // 已在插件明细里扫描过就尊重勾选结果；没扫描过则自动扫描并同步全部插件。
        const hadScan = store.extensionScan?.profileId === intent.sourceProfileId;
        const scan = hadScan ? store.extensionScan! : await profileApi().scanProfileExtensions(intent.sourceProfileId);
        const extensionIds = hadScan
          ? scan.extensions.filter((extension) => store.selectedExtensionIds.has(extension.id)).map((extension) => extension.id)
          : scan.extensions.map((extension) => extension.id);
        if (!hadScan) {
          store.migrationSourceId = intent.sourceProfileId;
          store.extensionScan = scan;
          store.selectedExtensionIds = new Set(extensionIds);
        }
        if (!extensionIds.length) {
          extensionsDone = true;
          return;
        }
        const result = await profileApi().migrateExtensions({
          sourceProfileId: intent.sourceProfileId,
          targetProfileId: intent.targetProfileId,
          extensionIds,
          includeData: store.includeExtensionData,
          openInstallPages: false,
          onlyChanged: false
        });
        store.extensionMigrationResult = result;
        invalidateExtensionMigrationDiff();
        store.state = result.state;
        store.selectedId = result.targetProfileId;
        extensionsDone = true;
      }, "插件同步完成", {
        key: "migrate-extensions",
        message: "正在同步插件…",
        profileId: intent.targetProfileId,
        stepIndex: 1,
        stepCount: progressSteps.length,
        steps: pendingBusySteps(progressSteps)
      });
      if (!extensionsDone) {
        return;
      }
    }

    if (intent.launchTarget && !launchViaAccountSync) {
      await withBusy(async () => {
        store.state = await profileApi().launchProfile(intent.targetProfileId);
        store.selectedId = intent.targetProfileId;
      }, `已启动 ${emphasizeName(targetProfile.name)}`, {
        key: "launch-profile",
        message: `正在启动 ${targetProfile.name}…`,
        profileId: intent.targetProfileId
      });
    }
  })();
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
