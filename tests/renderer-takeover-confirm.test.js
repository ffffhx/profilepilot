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
      message: "正在暂停 Work 的 AI 操作…",
      profileId: "p1"
    }
  ]);
  assert.deepEqual(calls.toasts, [{ message: "已接管 <Work>，AI 已暂停", kind: "normal" }]);
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

test("renderer takeover state action loads API history through merge and render", async () => {
  const { actions, calls, store } = loadStateActionsHarness({
    apiHistory: [
      takeoverEvent(3),
      takeoverEvent(1, { profileId: "api-old" })
    ],
    storeHistory: [takeoverEvent(2)]
  });

  await actions.loadTakeoverHistory();

  assert.deepEqual(
    store.agentTakeoverHistory.map((event) => event.profileId),
    ["profile-3", "profile-2", "api-old"]
  );
  assert.equal(calls.renderCount, 1);
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

function loadConfirmHarness(options = {}) {
  const calls = {
    busyStates: [],
    renderCount: 0,
    takeoverArgs: [],
    toasts: []
  };
  const initialProfiles = options.profiles || [profile({ cdpClients: [cdpClient({ label: "agent-browser" })] })];
  const store = {
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

function loadStateActionsHarness({ apiHistory, storeHistory }) {
  const calls = { renderCount: 0 };
  const store = {
    agentTakeoverHistory: storeHistory || [],
    extensionScan: null,
    selectedExtensionIds: new Set()
  };
  const actions = loadTsModule("src/renderer/state-actions.ts", {
    stubs: {
      "src/renderer/api.ts": {
        profileApi() {
          return {
            async getTakeoverHistory() {
              return apiHistory || [];
            }
          };
        }
      },
      "src/renderer/render/render-root.ts": {
        render() {
          calls.renderCount += 1;
        }
      },
      "src/renderer/state.ts": {
        store
      }
    }
  });

  return { actions, calls, store };
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
    clearedTimers: [],
    executeTakeoverIntents: [],
    renders: 0,
    timers: [],
    toasts: []
  };
  let timerId = 0;
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
        withBusy: async () => {}
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
        loadTakeoverHistory: async () => {},
        mergeAgentTakeoverHistory() {},
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
      await Promise.resolve();
      Object.assign(global, previousGlobals);
    },
    store
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

function takeoverEvent(index, patch = {}) {
  return {
    agent: "Codex",
    at: `2026-07-08T12:${String(index).padStart(2, "0")}:00.000Z`,
    profileId: `profile-${index}`,
    profileName: `Profile ${index}`,
    session: `session-${index}`,
    sessionTitle: `Session ${index}`,
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
