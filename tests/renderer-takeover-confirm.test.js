const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

test("renderer takeover confirm view summarizes only AI-driven clients", () => {
  const { confirm } = loadConfirmHarness({
    profiles: [
      profile({
        cdpClients: [
          cdpClient({ pid: 101, label: "agent-browser-darwin-arm64", project: "profilepilot" }),
          cdpClient({ pid: 202, label: "Claude Code", agent: "Claude Code" }),
          cdpClient({ pid: 303, label: "Google Chrome" })
        ]
      })
    ]
  });

  const view = confirm.confirmModalView({ kind: "agent-takeover", profileId: "p1" });

  assert.equal(view.title, "接管 Work");
  assert.deepEqual(view.body, [
    "会暂停 2 条 AI 浏览器会话，让它们收到用户接管的 hard-stop notice。",
    "Chrome 窗口和 agent-browser daemon 都会保留；接管后你可以直接手动操作这个浏览器。"
  ]);
  assert.deepEqual(view.summary, [
    { label: "Profile", value: "Work" },
    { label: "AI 连接", value: "2 条" },
    { label: "工具", value: "agent-browser、Claude Code" },
    { label: "CDP", value: "http://127.0.0.1:9223" }
  ]);
});

test("renderer Bifrost rule confirm explains the global impact without deleting the rule", () => {
  const { confirm } = loadConfirmHarness();
  const view = confirm.confirmModalView({
    kind: "disable-bifrost-rule",
    ruleName: "FlowPD-FE-BotStudio",
    ruleCount: 24
  });

  assert.equal(view.title, "停用 FlowPD-FE-BotStudio");
  assert.equal(view.confirmLabel, "停用规则");
  assert.equal(view.tone, "warn");
  assert.deepEqual(view.body, [
    "会从 Bifrost 主代理（系统代理入口）停用这份规则，所有跟随系统代理的 Chrome Profile 会立即受影响。",
    "规则不会被删除；Profile 专属临时端口使用显式规则绑定，不受主代理启用状态影响。"
  ]);
  assert.deepEqual(view.summary, [
    { label: "规则", value: "FlowPD-FE-BotStudio" },
    { label: "包含", value: "24 条匹配" },
    { label: "影响", value: "系统代理 · Bifrost 主端口" }
  ]);
});

test("renderer clone confirm explains the Windows native lightweight template", () => {
  const source = profile({ id: "native:Default", name: "系统默认 Profile", source: "native", running: true });
  const { confirm, store } = loadConfirmHarness({ profiles: [source] });
  store.state.platform = "win32";

  const view = confirm.confirmModalView({
    kind: "clone-profiles",
    sourceProfileId: source.id,
    count: 2,
    namePrefix: source.name,
    includeExtensions: true,
    launchAfter: false
  });

  assert.equal(view.kicker, "创建 Agent 浏览器");
  assert.match(view.body[0], /只从「系统默认 Profile」复制书签与插件/);
  assert.match(view.body[1], /App-Bound Encryption/);
  assert.match(view.body[1], /首次启动后登录一次/);
  assert.equal(view.body.some((line) => typeof line === "object" && line.tone === "danger"), false);
  assert.deepEqual(view.summary[1], { label: "模式", value: "Windows 轻量模板" });
  assert.deepEqual(view.summary[2], { label: "登录", value: "创建后手动登录" });

  const html = confirm.renderConfirmModal({
    kind: "confirm",
    intent: {
      kind: "clone-profiles",
      sourceProfileId: source.id,
      count: 2,
      namePrefix: source.name,
      includeExtensions: true,
      launchAfter: false
    }
  });
  assert.match(html, /class="modal confirm-modal confirm-dialog tone-primary"/);
  assert.doesNotMatch(html, /class="modal confirm-modal confirm-dialog primary"/);
});

test("renderer clone confirm still restarts a running Windows isolated source", () => {
  const source = profile({ id: "isolated:work", name: "Agent Work", source: "isolated", running: true });
  const { confirm, store } = loadConfirmHarness({ profiles: [source] });
  store.state.platform = "win32";

  const view = confirm.confirmModalView({
    kind: "clone-profiles",
    sourceProfileId: source.id,
    count: 1,
    namePrefix: source.name,
    includeExtensions: false,
    launchAfter: false
  });

  assert.deepEqual(view.body[1], {
    text: "Windows 正在使用源 Agent Work。开始克隆前会先关闭它以释放 Cookie 等数据文件，结束后会自动重新打开。",
    tone: "danger"
  });
  assert.deepEqual(view.summary[1], { label: "源运行状态", value: "先关闭，完成后恢复" });
});

test("renderer clone confirm keeps macOS online-copy behavior unchanged", () => {
  const source = profile({ id: "native:Default", name: "系统默认 Profile", source: "native", running: true });
  const { confirm, store } = loadConfirmHarness({ profiles: [source] });
  store.state.platform = "darwin";

  const view = confirm.confirmModalView({
    kind: "clone-profiles",
    sourceProfileId: source.id,
    count: 2,
    namePrefix: source.name,
    includeExtensions: false,
    launchAfter: false
  });

  assert.equal(view.body.some((line) => typeof line === "object" && line.tone === "danger"), false);
  assert.equal(view.summary.some((item) => item.label === "源运行状态"), false);
});

test("renderer Bifrost launch recovery offers one-click daemon start before direct fallback", () => {
  const configured = profile({
    name: "套餐升降配本地",
    bifrostProxy: {
      listenerPort: 18892,
      rules: ["codex-plan-change"],
      groupRules: []
    }
  });
  const { confirm } = loadConfirmHarness({ profiles: [configured] });
  const intent = {
    kind: "bifrost-bypass-launch",
    profileId: "p1",
    cdpPort: 9224,
    errorMessage: "[BIFROST_NOT_RUNNING] Bifrost 当前未运行。"
  };
  const view = confirm.confirmModalView(intent);
  const html = confirm.renderConfirmModal({ kind: "confirm", intent });

  assert.equal(view.title, "恢复分流并启动 套餐升降配本地");
  assert.equal(view.confirmLabel, "本次直连启动");
  assert.deepEqual(view.summary, [
    { label: "Profile", value: "套餐升降配本地" },
    { label: "分流入口", value: "127.0.0.1:18892" },
    { label: "继续方式", value: "代理注入 · CDP :9224" }
  ]);
  assert.match(html, /data-action="confirm-modal-action"[^>]*>[\s\S]*本次直连启动/);
  assert.match(html, /data-action="start-bifrost-and-launch"[^>]*>启动 Bifrost 并继续<\/button>/);
});

test("renderer one-click Bifrost recovery preserves CDP mode and requests proxy startup", async () => {
  const configured = profile({
    name: "套餐升降配本地",
    bifrostProxy: {
      listenerPort: 18892,
      rules: ["codex-plan-change"],
      groupRules: []
    }
  });
  const nextState = appState([{ ...configured, running: true, cdpPort: 9224 }]);
  const nextSnapshot = { running: true, ports: [{ port: 18892 }] };
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    profiles: [configured],
    launchState: nextState,
    launchSnapshot: nextSnapshot
  });

  confirm.executeBifrostStartAndLaunch({
    kind: "bifrost-bypass-launch",
    profileId: "p1",
    cdpPort: 9224,
    errorMessage: "[BIFROST_NOT_RUNNING] Bifrost 当前未运行。"
  });
  await waitForBusy();

  assert.deepEqual(calls.launchProfileWithCdpArgs, [["p1", 9224, { startBifrost: true }]]);
  assert.equal(store.state, nextState);
  assert.equal(store.bifrostSnapshot, nextSnapshot);
  assert.deepEqual(calls.busyStates, [{
    key: "launch-cdp",
    message: "正在启动 Bifrost、恢复分流并启动 套餐升降配本地…",
    profileId: "p1"
  }]);
  assert.deepEqual(calls.toasts, [{
    message: "已启动 Bifrost，并通过专属分流启动 <套餐升降配本地>",
    kind: "normal"
  }]);
});

test("renderer disable Bifrost rule confirm refreshes the proxy snapshot", async () => {
  const nextSnapshot = { running: true, mainRules: [] };
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    disableSnapshot: nextSnapshot
  });

  confirm.executeDisableBifrostRuleConfirm({
    kind: "disable-bifrost-rule",
    ruleName: "FlowPD-FE-BotStudio",
    ruleCount: 24
  });
  await waitForBusy();

  assert.deepEqual(calls.disableRuleArgs, ["FlowPD-FE-BotStudio"]);
  assert.equal(store.bifrostSnapshot, nextSnapshot);
  assert.equal(store.modal, null);
  assert.deepEqual(calls.busyStates, [
    {
      key: "disable-bifrost-rule",
      message: "正在停用规则 FlowPD-FE-BotStudio…"
    }
  ]);
  assert.deepEqual(calls.toasts, [
    { message: "已停用规则 <FlowPD-FE-BotStudio>", kind: "normal" }
  ]);
});

test("renderer explains why a running Profile must close before proxy injection", () => {
  const { confirm } = loadConfirmHarness();
  const view = confirm.confirmModalView({ kind: "close-profile-for-bifrost", profileId: "p1" });

  assert.equal(view.title, "关闭 Work 并继续配置");
  assert.equal(view.confirmLabel, "关闭后继续配置");
  assert.match(view.body[0], /刷新网页可以重发请求/);
  assert.match(view.body[0], /不能改变已经启动的 Chrome 进程/);
  assert.match(view.body[1], /不会修改 Bifrost、Clash 或系统代理/);
});

test("renderer closes a running Profile and returns to its Bifrost settings", async () => {
  const stoppedState = appState([profile({ running: false, pids: [] })]);
  const nextSnapshot = { running: true, ports: [] };
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    closeState: stoppedState,
    launchSnapshot: nextSnapshot
  });

  confirm.executeCloseProfileForBifrostConfirm({ kind: "close-profile-for-bifrost", profileId: "p1" });
  await waitForBusy();

  assert.deepEqual(calls.closeProfileArgs, ["p1"]);
  assert.equal(store.state, stoppedState);
  assert.deepEqual(store.modal, {
    kind: "bifrost-proxy",
    profileId: "p1",
    snapshot: nextSnapshot
  });
  assert.deepEqual(calls.toasts, [{
    message: "已关闭 <Work>，现在可以配置独立分流",
    kind: "normal"
  }]);
});

test("renderer dedicated Bifrost rule confirm explains its Profile-only scope", () => {
  const configured = profile({
    name: "9223端口profile",
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
      groupRules: []
    }
  });
  const { confirm } = loadConfirmHarness({ profiles: [configured] });
  const view = confirm.confirmModalView({
    kind: "remove-profile-bifrost-rule",
    profileId: "p1",
    ruleKind: "local",
    ruleRef: "FlowPD-FE-BotStudio-BOE"
  });

  assert.equal(view.title, "在 9223端口profile 中停用 FlowPD-FE-BotStudio-BOE");
  assert.equal(view.confirmLabel, "仅在此 Profile 停用");
  assert.deepEqual(view.body, [
    "会将这条规则标记为已停用，并从 9223端口profile 的 Bifrost 专属入口 :18888 生效集合中移除；它仍保留在列表中，可随时重新启用。",
    "入口端口保持不变，确认后立即热更新，无需重启 Chrome。",
    "这不会停用或删除 Bifrost 中的规则，也不会影响主代理或其他 Profile。"
  ]);
  assert.deepEqual(view.summary, [
    { label: "Profile", value: "9223端口profile" },
    { label: "专属入口", value: "127.0.0.1:18888" },
    { label: "规则", value: "FlowPD-FE-BotStudio-BOE" },
    { label: "范围", value: "仅此 Profile" }
  ]);
});

test("renderer pauses one dedicated Bifrost rule while retaining it for re-enable", async () => {
  const configured = profile({
    name: "9223端口profile",
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
      groupRules: []
    }
  });
  const nextState = appState([
    profile({
      ...configured,
      bifrostProxy: {
        listenerPort: 18888,
        rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
        groupRules: [],
        disabledRules: ["FlowPD-FE-BotStudio-BOE"]
      }
    })
  ]);
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    profiles: [configured],
    profileProxyState: nextState
  });

  confirm.executeRemoveProfileBifrostRuleConfirm({
    kind: "remove-profile-bifrost-rule",
    profileId: "p1",
    ruleKind: "local",
    ruleRef: "FlowPD-FE-BotStudio-BOE"
  });
  await waitForBusy();

  assert.deepEqual(calls.setProfileProxyArgs, [
    [
      "p1",
      {
        kind: "bifrost",
        listenerPort: 18888,
        rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
        groupRules: [],
        disabledRules: ["FlowPD-FE-BotStudio-BOE"],
        disabledGroupRules: []
      }
    ]
  ]);
  assert.equal(store.state, nextState);
  assert.deepEqual(calls.busyStates, [
    {
      key: "remove-profile-bifrost-rule",
      message: "正在更新 9223端口profile 的专属分流…",
      profileId: "p1"
    }
  ]);
  assert.deepEqual(calls.toasts, [
    {
      message: "已在 <9223端口profile> 中停用规则 <FlowPD-FE-BotStudio-BOE>",
      kind: "normal"
    }
  ]);
});

test("renderer executeAgentTakeoverConfirm stops the whole profile without filters", async () => {
  const nextState = appState([
    profile({
      name: "Work stopped",
      cdpClients: []
    })
  ]);
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    profiles: [
      profile({
        cdpClients: [
          cdpClient({ pid: 101, label: "agent-browser", session: "codex-one" }),
          cdpClient({ pid: 303, label: "Google Chrome" })
        ]
      })
    ],
    takeoverResponse: takeoverResponse({
      state: nextState,
      targetCount: 1,
      successCount: 1,
      failureCount: 0,
      allStopped: true
    })
  });

  confirm.executeAgentTakeoverConfirm({ kind: "agent-takeover", profileId: "p1" });
  await waitForBusy();

  assert.deepEqual(calls.takeoverArgs, [["p1"]]);
  assert.equal(calls.takeoverArgs[0].length, 1);
  assert.equal(store.modal, null);
  assert.equal(store.state, nextState);
  assert.deepEqual(calls.busyStates, [
    {
      key: "agent-takeover",
      message: "正在封锁 Work 的新命令，并等待当前命令收敛…",
      profileId: "p1"
    }
  ]);
  assert.deepEqual(calls.toasts, [{
    message: "已接管 <Work>；执行面已静默，可以安全操作",
    kind: "normal"
  }]);
});

test("renderer executeAgentTakeoverConfirm reports partial takeover failures", async () => {
  const partialState = appState([profile({ name: "Work partial" })]);
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    profiles: [
      profile({
        cdpClients: [
          cdpClient({ pid: 101, label: "agent-browser" }),
          cdpClient({ pid: 202, label: "Claude Code" }),
          cdpClient({ pid: 303, label: "codex" })
        ]
      })
    ],
    takeoverResponse: takeoverResponse({
      state: partialState,
      targetCount: 3,
      successCount: 1,
      failureCount: 2,
      allStopped: false,
      failures: [
        {
          pid: 202,
          label: "Claude Code",
          agent: "Claude Code",
          error: "permission denied"
        }
      ]
    })
  });

  confirm.executeAgentTakeoverConfirm({ kind: "agent-takeover", profileId: "p1" });
  await waitForBusy();

  assert.deepEqual(calls.takeoverArgs, [["p1"]]);
  assert.equal(store.state, partialState);
  assert.deepEqual(calls.toasts, [
    {
      message: "只暂停了 1/3 条 AI 连接，2 条未暂停：permission denied",
      kind: "error"
    }
  ]);
});

test("renderer executeAgentTakeoverConfirm does not call the API when no AI client remains", async () => {
  const { confirm, store, calls, waitForBusy } = loadConfirmHarness({
    profiles: [
      profile({
        cdpClients: [cdpClient({ pid: 303, label: "Google Chrome" })]
      })
    ]
  });

  confirm.executeAgentTakeoverConfirm({ kind: "agent-takeover", profileId: "p1" });
  await waitForBusy();

  assert.deepEqual(calls.takeoverArgs, []);
  assert.equal(store.modal, null);
  assert.equal(calls.renderCount, 1);
  assert.deepEqual(calls.toasts, [
    {
      message: "这个 Profile 现在没有可接管的 AI 连接",
      kind: "error"
    }
  ]);
});

test("renderer takeover util filters agent-driven CDP clients", () => {
  const { agentDrivenCdpClients, isAgentDrivenCdpClient, profileAgentControlClients } = loadUtilHarness();
  const clients = [
    cdpClient({ pid: 101, label: "agent-browser-linux-x64" }),
    cdpClient({ pid: 202, label: "codex" }),
    cdpClient({ pid: 303, label: "Google Chrome" }),
    cdpClient({ pid: 404, label: "node", project: "profilepilot" }),
    cdpClient({ pid: 505, label: "node", title: "Run renderer tests" })
  ];

  assert.deepEqual(
    agentDrivenCdpClients(clients).map((client) => client.pid),
    [101, 202, 404, 505]
  );
  assert.equal(isAgentDrivenCdpClient(cdpClient({ label: "Chrome" })), false);
  assert.equal(isAgentDrivenCdpClient(cdpClient({ label: "Claude Code" })), true);
  assert.deepEqual(
    profileAgentControlClients(profile({
      gatewayControl: {
        publicPort: 9223,
        ownership: "agent",
        sessionStatus: "active",
        agentHealth: "online",
        connectionActive: false,
        ownerSessionId: "cx-gateway",
        daemonInstanceId: "daemon-one",
        daemonPid: 808,
        agent: "Codex",
        project: "profilepilot",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    })).map((client) => client.session),
    ["cx-gateway"]
  );
});

test("renderer mini takeover requires a second click before executing", async () => {
  const harness = loadMainHarness({
    profile: profile({
      cdpClients: [cdpClient({ pid: 101, label: "agent-browser", project: "profilepilot" })]
    })
  });

  try {
    harness.click({ action: "mini-takeover-agent", id: "p1" });

    assert.equal(harness.store.miniTakeoverConfirmProfileId, "p1");
    assert.deepEqual(harness.calls.executeTakeoverIntents, []);
    assert.deepEqual(harness.calls.toasts, [{ message: "再次点击活动行暂停 AI 并接管浏览器", kind: "normal" }]);
    assert.equal(harness.calls.timers[0].ms, 2800);

    harness.click({ action: "mini-takeover-agent", id: "p1" });

    assert.equal(harness.store.miniTakeoverConfirmProfileId, null);
    assert.deepEqual(harness.calls.clearedTimers, [harness.calls.timers[0].id]);
    assert.deepEqual(harness.calls.executeTakeoverIntents, [{ kind: "agent-takeover", profileId: "p1" }]);
  } finally {
    await harness.cleanup();
  }
});

test("renderer dedicated Bifrost rule action opens a Profile-scoped confirm", async () => {
  const harness = loadMainHarness({
    profile: profile({
      bifrostProxy: {
        listenerPort: 18888,
        rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
        groupRules: []
      }
    })
  });

  try {
    harness.click({
      action: "remove-profile-bifrost-rule",
      id: "p1",
      ruleKind: "local",
      ruleRef: "FlowPD-FE-BotStudio-BOE"
    });

    assert.deepEqual(harness.store.modal, {
      kind: "confirm",
      intent: {
        kind: "remove-profile-bifrost-rule",
        profileId: "p1",
        ruleKind: "local",
        ruleRef: "FlowPD-FE-BotStudio-BOE"
      }
    });
    assert.equal(harness.calls.renders, 1);
  } finally {
    await harness.cleanup();
  }
});

test("renderer locked proxy toggle opens the close-and-configure confirmation", async () => {
  const harness = loadMainHarness({ profile: profile({ running: true }) });

  try {
    harness.click({ action: "prepare-bifrost-proxy", id: "p1" });

    assert.deepEqual(harness.store.modal, {
      kind: "confirm",
      intent: {
        kind: "close-profile-for-bifrost",
        profileId: "p1"
      }
    });
    assert.equal(harness.calls.renders, 1);
  } finally {
    await harness.cleanup();
  }
});

test("renderer enables a paused dedicated Bifrost rule without a confirm dialog", async () => {
  const harness = loadMainHarness({
    profile: profile({
      bifrostProxy: {
        listenerPort: 18888,
        rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
        groupRules: [],
        disabledRules: ["FlowPD-FE-BotStudio-BOE"]
      }
    })
  });

  try {
    harness.click({
      action: "enable-profile-bifrost-rule",
      id: "p1",
      ruleKind: "local",
      ruleRef: "FlowPD-FE-BotStudio-BOE"
    });
    await harness.waitForBusy();

    assert.deepEqual(harness.calls.setProfileProxyArgs, [
      [
        "p1",
        {
          kind: "bifrost",
          listenerPort: 18888,
          rules: ["FlowPD-FE-BotStudio-BOE", "codex-coze-optimize-subs-backend-boe"],
          groupRules: [],
          disabledRules: [],
          disabledGroupRules: []
        }
      ]
    ]);
    assert.equal(harness.store.modal, null);
    assert.deepEqual(harness.calls.busyStates, [
      {
        key: "enable-profile-bifrost-rule",
        message: "正在更新 Work 的专属分流…",
        profileId: "p1"
      }
    ]);
    assert.deepEqual(harness.calls.toasts, [
      {
        message: "已在 <Work> 中启用规则 <FlowPD-FE-BotStudio-BOE>",
        kind: "normal"
      }
    ]);
  } finally {
    await harness.cleanup();
  }
});

function loadConfirmHarness(options = {}) {
  const calls = {
    busyStates: [],
    closeProfileArgs: [],
    disableRuleArgs: [],
    launchProfileArgs: [],
    launchProfileWithCdpArgs: [],
    renderCount: 0,
    setProfileProxyArgs: [],
    takeoverArgs: [],
    toasts: []
  };
  const initialProfiles = options.profiles || [profile({ cdpClients: [cdpClient({ label: "agent-browser" })] })];
  const store = {
    bifrostSnapshot: null,
    state: appState(initialProfiles),
    modal: { kind: "confirm", intent: { kind: "agent-takeover", profileId: "p1" } },
    extensionScan: null,
    selectedExtensionIds: new Set(),
    extensionMigrationDiff: null
  };
  let busyPromise = Promise.resolve();

  const apiStub = {
    profileApi() {
      return {
        async closeProfile(profileId) {
          calls.closeProfileArgs.push(profileId);
          return options.closeState || store.state;
        },
        async disableBifrostRule(ruleName) {
          calls.disableRuleArgs.push(ruleName);
          return options.disableSnapshot || { running: true, mainRules: [] };
        },
        async setProfileProxy(...args) {
          calls.setProfileProxyArgs.push(args);
          return options.profileProxyState || store.state;
        },
        async launchProfile(...args) {
          calls.launchProfileArgs.push(args);
          return options.launchState || store.state;
        },
        async launchProfileWithCdp(...args) {
          calls.launchProfileWithCdpArgs.push(args);
          return options.launchState || store.state;
        },
        async getBifrostSnapshot() {
          return options.launchSnapshot || { running: true, ports: [] };
        },
        async takeoverAgentConnections(...args) {
          calls.takeoverArgs.push(args);
          return options.takeoverResponse || takeoverResponse();
        }
      };
    }
  };
  const busyStub = {
    accountSyncProgressStepsForTarget() {
      return [];
    },
    emphasizeName(name) {
      return `<${name}>`;
    },
    extensionSyncProgressStepsForProfiles() {
      return [];
    },
    pendingBusySteps(labels) {
      return labels.map((label, index) => ({ label, status: index === 0 ? "active" : "pending" }));
    },
    setToast(message, kind = "normal") {
      calls.toasts.push({ message, kind });
    },
    withBusy(work, successMessage, busyState) {
      calls.busyStates.push(busyState);
      busyPromise = (async () => {
        try {
          await work();
          if (successMessage) {
            busyStub.setToast(successMessage);
          }
        } catch (error) {
          busyStub.setToast(error instanceof Error ? error.message : String(error), "error");
        }
      })();
      return busyPromise;
    }
  };
  const renderStub = {
    render() {
      calls.renderCount += 1;
    }
  };

  const confirm = loadTsModule("src/renderer/confirm.ts", {
    stubs: {
      "src/renderer/api.ts": apiStub,
      "src/renderer/busy.ts": busyStub,
      "src/renderer/render/render-root.ts": renderStub,
      "src/renderer/state-actions.ts": {
        invalidateExtensionMigrationDiff() {},
        loadState: async () => {}
      },
      "src/renderer/state.ts": {
        dateFormatter: { format: (date) => date.toISOString() },
        store
      }
    }
  });

  return {
    calls,
    confirm,
    store,
    waitForBusy: () => busyPromise
  };
}

function loadUtilHarness() {
  return loadTsModule("src/renderer/util.ts", {
    stubs: {
      "src/renderer/state.ts": {
        dateFormatter: { format: (date) => date.toISOString() },
        store: { busyState: null }
      }
    }
  });
}

function loadMainHarness({ profile: activeProfile }) {
  const previousGlobals = {
    CSS: global.CSS,
    Element: global.Element,
    HTMLInputElement: global.HTMLInputElement,
    HTMLSelectElement: global.HTMLSelectElement,
    HTMLTextAreaElement: global.HTMLTextAreaElement,
    document: global.document,
    window: global.window
  };
  const calls = {
    busyStates: [],
    clearedTimers: [],
    executeTakeoverIntents: [],
    renders: 0,
    setProfileProxyArgs: [],
    timers: [],
    toasts: []
  };
  let timerId = 0;
  let busyPromise = Promise.resolve();
  const listeners = new Map();
  const appRoot = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    querySelectorAll() {
      return [];
    },
    innerHTML: ""
  };
  const store = {
    accountSyncMenuOpen: null,
    busy: false,
    clonePoolMenuOpen: false,
    migrationTargetMenuOpen: false,
    miniTakeoverConfirmProfileId: null,
    modal: null,
    openProfileMenuId: null,
    state: appState([activeProfile]),
    viewMode: "main"
  };

  class FakeElement {
    constructor(dataset) {
      this.dataset = dataset;
    }

    closest(selector) {
      return selector === "[data-action]" ? this : null;
    }
  }

  global.CSS = { escape: (value) => String(value) };
  global.Element = FakeElement;
  global.HTMLInputElement = class {};
  global.HTMLSelectElement = class {};
  global.HTMLTextAreaElement = class {};
  global.window = {
    clearInterval() {},
    clearTimeout(id) {
      calls.clearedTimers.push(id);
    },
    requestAnimationFrame(callback) {
      return this.setTimeout(callback, 0);
    },
    setInterval() {
      timerId += 1;
      return timerId;
    },
    setTimeout(callback, ms) {
      timerId += 1;
      calls.timers.push({ callback, id: timerId, ms });
      return timerId;
    }
  };
  global.document = {
    addEventListener() {},
    body: {
      classList: {
        add() {},
        remove() {},
        toggle() {}
      },
      offsetWidth: 0
    },
    documentElement: {
      classList: {
        add() {},
        remove() {}
      }
    },
    hidden: false,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  loadTsModule("src/renderer/main.ts", {
    stubs: {
      "src/renderer/api.ts": {
        profileApi() {
          return {
            onStateChanged() {
              return () => {};
            },
            onAgentOverlayReveal() {
              return () => {};
            },
            onAgentTakeover() {
              return () => {};
            },
            onOperationProgress() {
              return () => {};
            },
            async setProfileProxy(...args) {
              calls.setProfileProxyArgs.push(args);
              return store.state;
            }
          };
        }
      },
      "src/renderer/busy.ts": {
        activateBusyStep(steps) {
          return steps;
        },
        busyStepsKey() {
          return "";
        },
        emphasizeName(name) {
          return `<${name}>`;
        },
        focusProfileFromUi: async () => {},
        setToast(message, kind = "normal") {
          calls.toasts.push({ message, kind });
        },
        updateBusyProgressDom() {
          return false;
        },
        updateBusyState() {},
        withBusy(work, successMessage, busyState) {
          calls.busyStates.push(busyState);
          busyPromise = (async () => {
            await work();
            if (successMessage) {
              calls.toasts.push({ message: successMessage, kind: "normal" });
            }
          })();
          return busyPromise;
        }
      },
      "src/renderer/confirm.ts": {
        closeModalFromUi() {},
        executeAgentTakeoverConfirm(intent) {
          calls.executeTakeoverIntents.push(intent);
        },
        executeConfirmIntent() {}
      },
      "src/renderer/render/clone-pool.ts": {
        clampCloneCount(value) {
          return value;
        }
      },
      "src/renderer/render/extensions.ts": {
        isExtensionMigrationActionItem() {
          return true;
        }
      },
      "src/renderer/render/live-view.ts": {
        focusLiveTab() {},
        openLiveZoom() {},
        refreshLiveViewNow() {},
        requestLiveViewNow() {},
        startLiveViewLoop() {},
        toggleLiveScreenshot() {}
      },
      "src/renderer/render/mini.ts": {
        sortByMiniOrder(profiles) {
          return profiles;
        }
      },
      "src/renderer/render/render-root.ts": {
        render() {
          calls.renders += 1;
        }
      },
      "src/renderer/state-actions.ts": {
        invalidateExtensionMigrationDiff() {},
        loadState: async () => {},
        refreshExtensionMigrationDiff() {},
        refreshGlobalInstructions() {},
        repairClaudeInstructionShell() {},
        saveGlobalInstruction() {},
        setMigrationSource() {}
      },
      "src/renderer/state.ts": {
        appRoot,
        store
      },
      "src/renderer/util.ts": {
        agentDrivenCdpClients(clients) {
          return clients.filter(isAgentDrivenClient);
        },
        profileAgentControlClients(activeProfile) {
          return activeProfile.cdpClients.filter(isAgentDrivenClient);
        },
        deleteButtonTitle() {
          return "";
        },
        escapeHtml(value) {
          return String(value ?? "");
        },
        formatErrorMessage(error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    }
  });

  return {
    calls,
    click(dataset) {
      const clickHandlers = listeners.get("click") || [];
      assert.ok(clickHandlers.length, "expected main click handler to be registered");
      clickHandlers[0]({ target: new FakeElement(dataset) });
    },
    async cleanup() {
      await busyPromise;
      Object.assign(global, previousGlobals);
    },
    store,
    waitForBusy: () => busyPromise
  };
}

function isAgentDrivenClient(client) {
  const label = client.label.toLowerCase();
  return Boolean(
    client.agent ||
      client.project ||
      client.session ||
      client.title ||
      label.startsWith("agent-browser") ||
      label === "codex" ||
      label === "claude code"
  );
}

function takeoverResponse(patch = {}) {
  return {
    allStopped: true,
    failureCount: 0,
    failures: [],
    profileId: "p1",
    profileName: "Work",
    state: appState([profile({ cdpClients: [] })]),
    successCount: 1,
    takeovers: [],
    targetCount: 1,
    ...patch
  };
}

function appState(profiles) {
  return {
    profiles,
    miniProfileIds: [],
    miniProfileOrder: [],
    mainProfileOrder: []
  };
}

function profile(patch = {}) {
  return {
    cdpClients: [],
    gatewayControl: null,
    cdpContention: null,
    cdpPort: 9223,
    cdpUrl: "http://127.0.0.1:9223",
    cloneCount: 0,
    clonedFromName: null,
    clonedFromProfileId: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    deletable: true,
    dirName: "Work",
    fixedCdpPort: null,
    id: "p1",
    isDefault: false,
    lastLaunchedAt: null,
    listeningPorts: [9223],
    livePrimaryUrl: null,
    liveTabCount: null,
    name: "Work",
    path: "/tmp/Work",
    pinnedToMini: false,
    pids: [100],
    profileDataPath: "/tmp/Work/Profile",
    projectTag: null,
    quickLaunchSlot: null,
    running: true,
    source: "isolated",
    userDataDir: "/tmp/Work",
    userName: null,
    agentActivity: null,
    ...patch
  };
}

function cdpClient(patch = {}) {
  return {
    label: "agent-browser",
    pid: 101,
    ...patch
  };
}
