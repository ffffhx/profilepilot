import { store } from "../state";
import type { ConfirmBodyLine, ConfirmIntent, ConfirmModalView, ModalState } from "../types";
import { cdpClientToolSummary, cdpSessionText, closeConfirmCopy, deleteConfirmCopy, escapeHtml, formatDate, formatRelativeTime, isWindowsNativeAgentTemplate, prettyCdpClientLabel, profileAgentControlClients, profileStatusLabel, sourceDetail } from "../util";

export function renderConfirmModal(confirm: Extract<ModalState, { kind: "confirm" }>): string {
  const view = confirmModalView(confirm.intent);
  if (!view) {
    return "";
  }

  const confirmClass = `${view.tone === "primary" ? "solid" : `${view.tone} solid`}`;
  const canStartBifrost =
    confirm.intent.kind === "bifrost-bypass-launch" &&
    /\[BIFROST_NOT_RUNNING\]/.test(confirm.intent.errorMessage);

  return `
    <div class="modal-backdrop app-modal-backdrop" data-action="close-modal">
      <section class="modal confirm-modal confirm-dialog tone-${view.tone}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
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
          ${
            canStartBifrost
              ? '<button type="button" class="solid" data-action="start-bifrost-and-launch">启动 Bifrost 并继续</button>'
              : ""
          }
        </div>
      </section>
    </div>
  `;
}

export function confirmModalView(intent: ConfirmIntent): ConfirmModalView | null {
  if (!store.state) {
    return null;
  }

  if (intent.kind === "disable-bifrost-rule") {
    return {
      kicker: "停用 Bifrost 规则",
      title: `停用 ${intent.ruleName}`,
      body: [
        "会从 Bifrost 主代理（系统代理入口）停用这份规则，所有跟随系统代理的 Chrome Profile 会立即受影响。",
        "规则不会被删除；Profile 专属临时端口使用显式规则绑定，不受主代理启用状态影响。"
      ],
      confirmLabel: "停用规则",
      tone: "warn",
      summary: [
        { label: "规则", value: intent.ruleName },
        { label: "包含", value: `${intent.ruleCount} 条匹配` },
        { label: "影响", value: "系统代理 · Bifrost 主端口" }
      ]
    };
  }

  if (intent.kind === "remove-profile-bifrost-rule") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    if (!profile?.bifrostProxy) {
      return null;
    }
    return {
      kicker: "停用专属分流规则",
      title: `在 ${profile.name} 中停用 ${intent.ruleRef}`,
      body: [
        `会将这条规则标记为已停用，并从 ${profile.name} 的 Bifrost 专属入口 :${profile.bifrostProxy.listenerPort} 生效集合中移除；它仍保留在列表中，可随时重新启用。`,
        profile.running
          ? "入口端口保持不变，确认后立即热更新，无需重启 Chrome。"
          : "配置会立即保存，并在下次启动这个 Profile 时按剩余规则恢复绑定。",
        "这不会停用或删除 Bifrost 中的规则，也不会影响主代理或其他 Profile。"
      ],
      confirmLabel: "仅在此 Profile 停用",
      tone: "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "专属入口", value: `127.0.0.1:${profile.bifrostProxy.listenerPort}` },
        { label: "规则", value: intent.ruleRef },
        { label: "范围", value: "仅此 Profile" }
      ]
    };
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

  if (intent.kind === "close-profile-for-bifrost") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    if (!profile) {
      return null;
    }
    return {
      kicker: "关闭后配置分流",
      title: `关闭 ${profile.name} 并继续配置`,
      body: [
        "独立代理分流依赖 Chrome 启动参数。刷新网页可以重发请求，但不能改变已经启动的 Chrome 进程所使用的代理入口。",
        "确认后只会关闭这个 Profile，并自动返回分流设置；不会修改 Bifrost、Clash 或系统代理。未保存的网页内容可能会丢失。"
      ],
      confirmLabel: "关闭后继续配置",
      tone: "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "当前状态", value: "运行中" },
        { label: "下一步", value: "返回分流配置" }
      ]
    };
  }

  if (intent.kind === "profile-sync") {
    const sourceProfile = store.state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    const targetProfile = store.state.profiles.find((profile) => profile.id === intent.targetProfileId);
    if (!sourceProfile || !targetProfile) {
      return null;
    }

    const parts = [intent.syncAccount ? "Profile 数据" : null, intent.syncExtensions ? "插件" : null]
      .filter(Boolean)
      .join(" + ");
    const body: string[] = [];
    if (intent.shouldCloseTarget) {
      body.push(`目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标${intent.launchTarget ? "，完成后会重新启动" : ""}。`);
    }
    if (intent.syncAccount) {
      body.push(
        intent.existingRecordSyncedAt
          ? `上次已在 ${formatDate(intent.existingRecordSyncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。继续会覆盖刷新可迁移数据，不会重复叠加；登录状态仍需在目标网站验证。`
          : `${targetProfile.name} 的可迁移 Profile 数据会被 ${sourceProfile.name} 覆盖；登录状态仍需在目标网站验证。`
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
    const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state.platform, source);
    const willRestartSource = store.state.platform === "win32" && source.running && !windowsNativeTemplate;
    return {
      kicker: windowsNativeTemplate ? "创建 Agent 浏览器" : "批量克隆确认",
      title: windowsNativeTemplate
        ? `从 ${source.name} 创建 ${intent.count} 个 Agent 浏览器`
        : `克隆 ${source.name} 为 ${intent.count} 份`,
      body: [
        windowsNativeTemplate
          ? `会新建 ${intent.count} 个独立 Profile，只从「${source.name}」复制书签${intent.includeExtensions ? "与插件" : ""}，不会复制 Cookie、站点数据或缓存；各分配一个固定 CDP 端口。`
          : `会新建 ${intent.count} 个隔离副本，逐个从 ${source.name} 复制可迁移的 Profile 数据${intent.includeExtensions ? "并同步插件" : ""}，各分配一个独立的固定 CDP 端口。登录状态仍需在目标网站验证。`,
        windowsNativeTemplate
          ? "Windows 原生 Chrome 使用 App-Bound Encryption，登录 Cookie 不能在独立目录中复用。请在每个 Agent 浏览器首次启动后登录一次，之后持续复用它。"
          : null,
        willRestartSource
          ? {
              text: `Windows 正在使用源 ${source.name}。开始克隆前会先关闭它以释放 Cookie 等数据文件，结束后会自动重新打开。`,
              tone: "danger"
            }
          : null,
        intent.launchAfter ? "创建完成后会逐个以 CDP 模式启动。" : "创建完成后不会自动启动，可稍后在副本池里批量启动。",
        windowsNativeTemplate ? "轻量模板不会扫描或复制浏览器缓存。" : "复制时间取决于 Profile 数据量；缓存目录不会复制。"
      ].filter((line): line is ConfirmBodyLine => Boolean(line)),
      confirmLabel: `${windowsNativeTemplate ? "创建" : "克隆"} ${intent.count} 份`,
      tone: "primary",
      summary: [
        { label: "源 Profile", value: source.name },
        ...(willRestartSource ? [{ label: "源运行状态", value: "先关闭，完成后恢复" }] : []),
        ...(windowsNativeTemplate
          ? [
              { label: "模式", value: "Windows 轻量模板" },
              { label: "登录", value: "创建后手动登录" }
            ]
          : []),
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
    const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state.platform, source);
    return {
      kicker: windowsNativeTemplate ? "更新轻量模板" : "刷新副本数据",
      title: `${windowsNativeTemplate ? "更新" : "刷新"} ${source.name} 的 ${clones.length} 个副本`,
      body: [
        windowsNativeTemplate
          ? `会以 ${source.name} 为准，只更新全部副本的书签；不会覆盖各副本自己的 Cookie、站点数据或登录状态。`
          : `会以 ${source.name} 为准，把全部副本的可迁移 Profile 数据增量刷新一遍；登录状态仍需在目标网站验证。`,
        runningCount
          ? `其中 ${runningCount} 个副本正在运行，刷新前会先关闭它们（不会自动重开）。`
          : windowsNativeTemplate ? "副本会逐个写入最新书签模板。" : "副本会逐个写入最新 Profile 数据。"
      ],
      confirmLabel: windowsNativeTemplate ? "更新模板" : "刷新数据",
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
    const windowsNativeTemplate = isWindowsNativeAgentTemplate(store.state.platform, source || null);
    return {
      kicker: windowsNativeTemplate ? "更新轻量模板" : "重置副本",
      title: `${windowsNativeTemplate ? "更新" : "重置"} ${clone.name}`,
      body: [
        windowsNativeTemplate
          ? `会以源 ${source?.name || "Profile"} 为准更新书签，不会覆盖 ${clone.name} 自己的登录状态或站点数据。`
          : source
            ? `会以源 ${source.name} 为准，重新覆盖 ${clone.name} 的可迁移 Profile 数据；登录状态仍需在目标网站验证。`
            : "会以记录的源为准，重新覆盖这个副本的可迁移 Profile 数据。",
        clone.running
          ? `副本正在运行，${windowsNativeTemplate ? "更新" : "重置"}前会先关闭它。`
          : windowsNativeTemplate ? "只更新书签模板，不会清空本地浏览数据。" : "不会清空目标中未包含在同步范围内的数据。"
      ],
      confirmLabel: windowsNativeTemplate ? "更新模板" : "重置数据",
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

  if (intent.kind === "bifrost-bypass-launch") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    if (!profile) {
      return null;
    }
    return {
      kicker: "Bifrost 分流不可用",
      title: `恢复分流并启动 ${profile.name}`,
      body: [
        { text: intent.errorMessage, tone: "danger" },
        /\[BIFROST_NOT_RUNNING\]/.test(intent.errorMessage)
          ? "可以让 ProfilePilot 立即启动 Bifrost、恢复这个 Profile 的专属分流入口，然后继续启动 Chrome。"
          : "请先修复 Bifrost（安装 CLI / 释放端口）再正常启动。",
        "如果暂时不需要分流，也可以本次直连启动；已保存的代理配置不会改变。"
      ],
      confirmLabel: "本次直连启动",
      tone: "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "分流入口", value: profile.bifrostProxy ? `127.0.0.1:${profile.bifrostProxy.listenerPort}` : "—" },
        { label: "继续方式", value: intent.cdpPort !== null ? `代理注入 · CDP :${intent.cdpPort}` : "代理注入启动" }
      ]
    };
  }

  if (intent.kind === "agent-takeover") {
    const profile = store.state.profiles.find((item) => item.id === intent.profileId);
    const clients = profile ? profileAgentControlClients(profile) : [];
    if (!profile || !clients.length) {
      return null;
    }
    return {
      kicker: "接管浏览器",
      title: `接管 ${profile.name}`,
      body: [
        `会暂停 ${clients.length} 条 AI 浏览器会话，让它们收到用户接管的 hard-stop notice。`,
        "Chrome 窗口和 agent-browser daemon 都会保留；接管后你可以直接手动操作这个浏览器。"
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
