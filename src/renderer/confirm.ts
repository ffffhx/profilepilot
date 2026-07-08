import { profileApi } from "./api";
import { accountSyncProgressStepsForTarget, emphasizeName, extensionSyncProgressStepsForProfiles, pendingBusySteps, setToast, withBusy } from "./busy";
import { render } from "./render/render-root";
import { invalidateExtensionMigrationDiff, loadState } from "./state-actions";
import { store } from "./state";
import { ConfirmBodyLine, ConfirmIntent, ConfirmModalView, ModalState, PublicProfile, TakeoverAgentConnectionsResponse } from "./types";
import { agentDrivenCdpClients, cdpClientToolSummary, cdpSessionText, closeConfirmCopy, deleteConfirmCopy, escapeHtml, formatDate, formatErrorMessage, formatRelativeTime, prettyCdpClientLabel, profileStatusLabel, sourceDetail } from "./util";

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

  if (intent.kind === "profile-sync") {
    const sourceProfile = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    const targetProfile = store.state.profiles.find((profile) => profile.id === intent.targetProfileId);
    if (!sourceProfile || !targetProfile) {
      return null;
    }

    const parts = [intent.syncAccount ? "账号登录态" : null, intent.syncExtensions ? "插件" : null]
      .filter(Boolean)
      .join(" + ");
    const body: string[] = [];
    if (intent.shouldCloseTarget) {
      body.push(`目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标${intent.launchTarget ? "，完成后会重新启动" : ""}。`);
    }
    if (intent.syncAccount) {
      body.push(
        intent.existingRecordSyncedAt
          ? `上次已在 ${formatDate(intent.existingRecordSyncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。继续会覆盖刷新目标登录态，不会重复叠加。`
          : `${targetProfile.name} 当前登录态会被 ${sourceProfile.name} 的登录态覆盖。`
      );
    }
    if (intent.syncExtensions) {
      const activeScan = store.extensionScan?.profileId === intent.sourceProfileId ? store.extensionScan : null;
      const selectedCount = activeScan
        ? activeScan.extensions.filter((extension) => store.selectedExtensionIds.has(extension.id)).length
        : 0;
      body.push(
        activeScan
          ? `会同步插件明细里已勾选的 ${selectedCount} 个插件到目标。`
          : "会自动扫描源 Profile 的全部插件并同步到目标；无法静默处理的插件会跳过，可稍后在插件明细里手动补齐。"
      );
    }

    return {
      kicker: "同步确认",
      title: `同步 ${sourceProfile.name} 到 ${targetProfile.name}`,
      body,
      confirmLabel: "同步",
      tone: "warn",
      summary: [
        { label: "源 Profile", value: sourceProfile.name },
        { label: "目标 Profile", value: targetProfile.name },
        { label: "同步内容", value: parts },
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

  if (intent.kind === "clone-profiles") {
    const source = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    if (!source) {
      return null;
    }
    return {
      kicker: "批量克隆确认",
      title: `克隆 ${source.name} 为 ${intent.count} 份`,
      body: [
        `会新建 ${intent.count} 个隔离副本，逐个从 ${source.name} 复制登录态${intent.includeExtensions ? "并同步插件" : ""}，各分配一个独立的固定 CDP 端口。`,
        intent.launchAfter ? "克隆完成后会逐个以 CDP 模式启动。" : "克隆完成后不会自动启动，可稍后在副本池里批量启动。",
        "克隆较耗时（每份都要复制账号数据），请耐心等待。"
      ],
      confirmLabel: `克隆 ${intent.count} 份`,
      tone: "primary",
      summary: [
        { label: "源 Profile", value: source.name },
        { label: "份数", value: String(intent.count) },
        { label: "含插件", value: intent.includeExtensions ? "是" : "否" },
        { label: "克隆后启动", value: intent.launchAfter ? "是" : "否" }
      ]
    };
  }

  if (intent.kind === "refresh-clones") {
    const source = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    if (!source) {
      return null;
    }
    const clones = store.state.profiles.filter((profile) => profile.clonedFromProfileId === intent.sourceProfileId);
    const runningCount = clones.filter((clone) => clone.running).length;
    return {
      kicker: "刷新副本登录态",
      title: `刷新 ${source.name} 的 ${clones.length} 个副本`,
      body: [
        `会以 ${source.name} 为准，把它的全部副本登录态增量刷新一遍。`,
        runningCount
          ? `其中 ${runningCount} 个副本正在运行，刷新前会先关闭它们（不会自动重开）。`
          : "副本会逐个写入最新登录态。"
      ],
      confirmLabel: "刷新登录态",
      tone: "warn",
      summary: [
        { label: "源 Profile", value: source.name },
        { label: "副本数", value: String(clones.length) },
        { label: "运行中", value: String(runningCount) }
      ]
    };
  }

  if (intent.kind === "reset-clone") {
    const clone = store.state.profiles.find((profile) => profile.id === intent.profileId);
    if (!clone) {
      return null;
    }
    const source = clone.clonedFromProfileId
      ? store.state.profiles.find((profile) => profile.id === clone.clonedFromProfileId)
      : null;
    return {
      kicker: "重置副本",
      title: `重置 ${clone.name}`,
      body: [
        source
          ? `会以源 ${source.name} 为准，重新覆盖 ${clone.name} 的登录态（全量）。`
          : "会以记录的源为准，重新覆盖这个副本的登录态。",
        clone.running ? "副本正在运行，重置前会先关闭它。" : "重置只覆盖登录态，不会清空本地浏览数据。"
      ],
      confirmLabel: "重置登录态",
      tone: "warn",
      summary: [
        { label: "副本", value: clone.name },
        { label: "源", value: source?.name || clone.clonedFromName || "未知" },
        { label: "状态", value: profileStatusLabel(clone) }
      ]
    };
  }

  if (intent.kind === "disconnect-client") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    const client = profile?.cdpClients.find((item) => item.pid === intent.pid);
    if (!profile || !client) {
      return null;
    }
    const tool = client.agent || prettyCdpClientLabel(client.label);
    const session = cdpSessionText(client);
    const age = formatRelativeTime(client.lastActive);
    return {
      kicker: "结束驱动连接",
      title: `结束 ${tool} 的驱动连接`,
      body: [
        `会向这个客户端进程（PID ${client.pid}）发送结束信号，断开它对 ${profile.name} 的 CDP 连接。Chrome 本身不受影响，不会关闭。`,
        {
          text: "如果这个会话其实还在用，结束后它需要重新连接才能继续；请确认它确实是空挂的再操作。",
          tone: "danger"
        }
      ],
      confirmLabel: "结束连接",
      tone: "warn",
      summary: [
        { label: "工具", value: tool },
        { label: "会话", value: session || "—" },
        { label: "最近活动", value: age || "未知" },
        { label: "PID", value: String(client.pid) }
      ]
    };
  }

  if (intent.kind === "agent-takeover") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    const clients = profile ? agentDrivenCdpClients(profile.cdpClients) : [];
    if (!profile || !clients.length) {
      return null;
    }
    return {
      kicker: "接管浏览器",
      title: `接管 ${profile.name}`,
      body: [
        `会停止 ${clients.length} 条 AI 驱动连接，断开它们对 ${profile.name} 的 CDP 控制。`,
        "Chrome 窗口会保留在原处，不会关闭；接管后你可以直接手动操作这个浏览器。"
      ],
      confirmLabel: "⏹ 接管",
      tone: "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "AI 连接", value: `${clients.length} 条` },
        { label: "工具", value: cdpClientToolSummary(clients) || "AI" },
        { label: "CDP", value: profile.cdpUrl || "未开启" }
      ]
    };
  }

  if (intent.kind === "recycle-clones") {
    const candidates = store.state.profiles.filter(
      (profile) => profile.source === "isolated" && profile.clonedFromProfileId && !profile.running
    );
    return {
      kicker: "清理闲置副本",
      title: `清理 ${intent.days} 天未使用的副本`,
      body: [
        `会把所有副本里、未运行、且最近启动/创建时间早于 ${intent.days} 天前的，移到废纸篓。`,
        "运行中的副本不会被清理；移到废纸篓的目录仍可恢复。"
      ],
      confirmLabel: "清理闲置副本",
      tone: "danger",
      summary: [
        { label: "天数阈值", value: `${intent.days} 天` },
        { label: "当前空闲副本", value: String(candidates.length) }
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
  if (intent.kind === "profile") {
    executeProfileConfirm(intent);
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

  if (intent.kind === "recycle-clones") {
    executeRecycleClonesConfirm(intent);
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

  executeExtensionMigrationConfirm(intent);
}

export function executeAgentTakeoverConfirm(intent: Extract<ConfirmIntent, { kind: "agent-takeover" }>): void {
  const profile = store.state?.profiles.find((item) => item.id === intent.profileId);
  const clients = profile ? agentDrivenCdpClients(profile.cdpClients) : [];
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
    `已接管 ${emphasizeName(profile.name)}`,
    { key: "agent-takeover", message: `正在停止 ${profile.name} 的 AI 操作…`, profileId: intent.profileId }
  );
}

function takeoverResultError(result: TakeoverAgentConnectionsResponse): string {
  const firstFailure = result.failures[0];
  const suffix = firstFailure ? `：${firstFailure.error}` : "";
  if (result.successCount > 0) {
    return `只停止了 ${result.successCount}/${result.targetCount} 条 AI 连接，${result.failureCount} 条未停止${suffix}`;
  }
  return `没有停止任何 AI 连接${suffix}`;
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
      setToast(`已克隆 ${result.created.length} 个副本`);
    },
    undefined,
    { key: "clone-profiles", message: `正在克隆 ${intent.count} 份…` }
  );
}

export function executeRefreshClonesConfirm(intent: Extract<ConfirmIntent, { kind: "refresh-clones" }>): void {
  const source = store.state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
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
        `已刷新 ${result.refreshedCount} 个副本登录态${result.skippedCount ? `，跳过 ${result.skippedCount} 个` : ""}`
      );
    },
    undefined,
    { key: "refresh-clones", message: "正在刷新副本登录态…" }
  );
}

export function executeResetCloneConfirm(intent: Extract<ConfirmIntent, { kind: "reset-clone" }>): void {
  const clone = store.state?.profiles.find((profile) => profile.id === intent.profileId);
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
    `已重置 ${emphasizeName(clone.name)} 的登录态`,
    { key: "reset-clone", message: `正在重置 ${clone.name}…`, profileId: intent.profileId }
  );
}

export function executeRecycleClonesConfirm(intent: Extract<ConfirmIntent, { kind: "recycle-clones" }>): void {
  store.modal = { kind: "clone-pool" };
  void withBusy(
    async () => {
      const result = await profileApi().recycleIdleClones(intent.days);
      store.state = result.state;
      setToast(result.deleted.length ? `已清理 ${result.deleted.length} 个闲置副本` : "没有符合条件的闲置副本");
    },
    undefined,
    { key: "recycle-clones", message: "正在清理闲置副本…" }
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

// 合并同步：按勾选串行执行「账号登录态 → 插件 → 启动目标」。
// 每个阶段沿用各自的 busy key（account-sync / migrate-extensions），
// 这样主进程按 key 上报的进度、暂停/终止按钮都能照常工作。
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
          includeData: false,
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
