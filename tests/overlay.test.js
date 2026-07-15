const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const childProcess = require("node:child_process");
const realExecFile = childProcess.execFile;
childProcess.execFile = function patchedExecFile(file, args, options, callback) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const normalizedCallback = typeof options === "function" ? options : callback;
  if (file === "lsof" && normalizedArgs[0] === "-c" && normalizedArgs[1] === "codex" && normalizedCallback) {
    process.nextTick(() => normalizedCallback(null, { stdout: "", stderr: "" }));
    return { kill() {}, on() {}, once() {} };
  }
  return realExecFile.apply(this, arguments);
};

const {
  AgentOverlayManager,
  isAgentOverlayClient,
  isAgentOverlayInjectableUrl
} = require("../dist/main/agent-overlay.js");
const { agentOverlayBootstrapScript } = require("../dist/main/overlay-script.js");
const { SessionTailer, describeAgentBrowserCommand } = require("../dist/main/session-tail.js");

const WAIT_TIMEOUT_MS = 10000;
const WAIT_INTERVAL_MS = 10;
const TAILER_POLL_INTERVAL_MS = 10;

test("SessionTailer parses Claude TodoWrite statuses", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createClaudeSession(home, uuid, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              input: {
                todos: [
                  { status: "completed", content: "Open the page" },
                  { status: "done", content: "Read initial state" },
                  { status: "in_progress", activeForm: "Testing the overlay parser" },
                  { status: "pending", content: "Report findings" }
                ]
              }
            }
          ]
        }
      }
    ]);

    const tailer = startTailer(`cc-${uuid}`, { project: "pilot", sessionTitle: "Claude run" });
    try {
      const activity = await waitForActivity(tailer, (value) => value.todoTotal === 4, "Claude todos");
      assert.equal(activity.agent, "Claude Code");
      assert.equal(activity.project, "pilot");
      assert.equal(activity.sessionTitle, "Claude run");
      assert.equal(activity.currentStep, "Testing the overlay parser");
      assert.equal(activity.nextStep, "Report findings");
      assert.equal(activity.todoDone, 2);
      assert.equal(activity.todoTotal, 4);
      assert.ok(activity.updatedAt);
    } finally {
      tailer.stop();
    }
  });
});

test("SessionTailer parses Claude Bash agent-browser commands", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createClaudeSession(home, uuid, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: {
                command: "/usr/local/bin/agent-browser --cdp http://127.0.0.1:9222 open https://example.com/path"
              }
            }
          ]
        }
      }
    ]);

    const tailer = startTailer(`cc-${uuid}`, {});
    try {
      const activity = await waitForActivity(
        tailer,
        (value) => value.currentAction === "打开 example.com",
        "Claude Bash command"
      );
      assert.equal(activity.currentAction, "打开 example.com");
      assert.equal(activity.targetUrl, "example.com/path");
    } finally {
      tailer.stop();
    }
  });
});

test("SessionTailer parses Claude assistant text", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createClaudeSession(home, uuid, [
      {
        type: "assistant",
        message: {
          content: "I inspected the page and found the overlay state."
        }
      }
    ]);

    const tailer = startTailer(`cc-${uuid}`, {});
    try {
      const activity = await waitForActivity(
        tailer,
        (value) => value.lastMessage === "I inspected the page and found the overlay state.",
        "Claude assistant text"
      );
      assert.equal(activity.lastMessage, "I inspected the page and found the overlay state.");
    } finally {
      tailer.stop();
    }
  });
});

test("SessionTailer marks Claude end_turn completed and a later user turn active", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    const file = await createClaudeSession(home, uuid, [
      { type: "user", message: { content: "Open the browser" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn"
        }
      }
    ]);

    const tailer = startTailer(`cc-${uuid}`, {});
    try {
      await waitFor(() => tailer.getControlPhase() === "completed", "Claude completed turn");
      await appendFile(file, `${JSON.stringify({ type: "user", message: { content: "Continue" } })}\n`, "utf8");
      await waitFor(() => tailer.getControlPhase() === "active", "Claude next active turn");
    } finally {
      tailer.stop();
    }
  });
});

test("SessionTailer ignores bad, half, empty, and missing Claude session input", async () => {
  await withTempHome(async (home) => {
    const emptyUuid = randomUUID();
    await createClaudeSession(home, emptyUuid, []);
    const emptyTailer = startTailer(`cc-${emptyUuid}`, {});
    try {
      const emptyActivity = await waitForActivity(
        emptyTailer,
        (value) => value.agent === "Claude Code",
        "empty Claude session"
      );
      assert.equal(emptyActivity.lastMessage, undefined);
      assert.equal(emptyActivity.currentAction, undefined);
      assert.equal(emptyActivity.todoTotal, undefined);
    } finally {
      emptyTailer.stop();
    }

    const partialUuid = randomUUID();
    const partialEntry = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Half line completed" }] }
    });
    const splitIndex = Math.floor(partialEntry.length / 2);
    const partialFile = await createClaudeRawSession(
      home,
      partialUuid,
      `not json\n${partialEntry.slice(0, splitIndex)}`
    );
    const partialTailer = startTailer(`cc-${partialUuid}`, {});
    try {
      await waitForActivity(partialTailer, (value) => value.agent === "Claude Code", "partial Claude session");
      assert.equal(partialTailer.getActivity().lastMessage, undefined);

      await appendFile(partialFile, `${partialEntry.slice(splitIndex)}\n`, "utf8");
      const completedActivity = await waitForActivity(
        partialTailer,
        (value) => value.lastMessage === "Half line completed",
        "completed Claude partial line"
      );
      assert.equal(completedActivity.lastMessage, "Half line completed");
    } finally {
      partialTailer.stop();
    }

    const missingTailer = startTailer(`cc-${randomUUID()}`, { project: "missing-project" });
    try {
      const missingActivity = missingTailer.getActivity();
      assert.equal(missingActivity.project, "missing-project");
      assert.equal(missingActivity.agent, undefined);
      assert.equal(missingActivity.lastMessage, undefined);
      assert.equal(missingActivity.currentStep, undefined);
    } finally {
      missingTailer.stop();
    }
  });
});

test("SessionTailer parses Codex rollout messages, function calls, and update_plan", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createCodexSession(home, uuid, [
      {
        type: "event_msg",
        payload: { type: "task_started" }
      },
      {
        type: "session_meta",
        payload: { cwd: "/tmp/profilepilot" }
      },
      {
        type: "response_item",
        payload: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I am checking the browser now." }]
          }
        }
      },
      {
        type: "response_item",
        payload: {
          item: {
            type: "function_call",
            name: "shell",
            arguments: JSON.stringify({ command: "agent-browser click \"Save changes\"" })
          }
        }
      },
      {
        type: "response_item",
        payload: {
          item: {
            type: "function_call",
            name: "update_plan",
            arguments: JSON.stringify({
              plan: [
                { status: "completed", step: "Open settings" },
                { status: "in_progress", step: "Verify overlay payload" },
                { status: "pending", step: "Write summary" }
              ]
            })
          }
        }
      },
      {
        type: "event_msg",
        payload: { type: "task_complete" }
      }
    ]);

    const tailer = startTailer(`cx-${uuid}`, { project: "profilepilot", sessionTitle: "Codex run" });
    try {
      const activity = await waitForActivity(
        tailer,
        (value) =>
          value.lastMessage === "I am checking the browser now." &&
          value.currentAction === "点击「Save changes」" &&
          value.todoTotal === 3,
        "Codex rollout"
      );
      assert.equal(activity.agent, "Codex");
      assert.equal(activity.project, "profilepilot");
      assert.equal(activity.sessionTitle, "Codex run");
      assert.equal(activity.lastMessage, "I am checking the browser now.");
      assert.equal(activity.currentAction, "点击「Save changes」");
      assert.equal(activity.currentStep, "Verify overlay payload");
      assert.equal(activity.nextStep, "Write summary");
      assert.equal(activity.todoDone, 1);
      assert.equal(activity.todoTotal, 3);
      assert.equal(tailer.getControlPhase(), "completed");
    } finally {
      tailer.stop();
    }
  });
});

test("agent-browser command descriptions cover browser actions", () => {
  assert.equal(
    describeAgentBrowserCommand("/opt/bin/agent-browser --cdp http://127.0.0.1:9222 open https://docs.example.test/path"),
    "打开 docs.example.test"
  );
  assert.equal(describeAgentBrowserCommand("agent-browser click \"Log in\""), "点击「Log in」");
  assert.equal(describeAgentBrowserCommand("agent-browser fill \"#email\" user@example.test"), "填写输入框");
  assert.equal(describeAgentBrowserCommand("agent-browser type \"hello\""), "填写输入框");
  assert.equal(describeAgentBrowserCommand("agent-browser screenshot --full-page"), "截图");
  assert.equal(describeAgentBrowserCommand("agent-browser snapshot"), "读取页面结构");
});

test("Codex command detection ignores agent-browser-cdp file paths", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createCodexSession(home, uuid, [
      {
        type: "response_item",
        payload: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "No browser command here." }]
          }
        }
      },
      {
        type: "response_item",
        payload: {
          item: {
            type: "function_call",
            name: "shell",
            arguments: JSON.stringify({ command: "cat /tmp/agent-browser-cdp/SKILL.md" })
          }
        }
      }
    ]);

    const tailer = startTailer(`cx-${uuid}`, {});
    try {
      await waitForActivity(
        tailer,
        (value) => value.lastMessage === "No browser command here.",
        "Codex pseudo command session"
      );
      assert.equal(tailer.getActivity().currentAction, undefined);
    } finally {
      tailer.stop();
    }
  });
});

test("agent overlay bootstrap script has static safety hooks and valid syntax", () => {
  const script = agentOverlayBootstrapScript();
  assert.match(script, /__ppAgentOverlayInstalled/);
  assert.match(script, /aria-hidden/);
  assert.match(script, /__ppAgentOverlaySignal/);
  assert.match(script, /window\.__ppAgentOverlayUpdate/);
  assert.match(script, /window\.__ppAgentOverlayTeardown/);
  assert.match(script, /OVERLAY_HEARTBEAT_TIMEOUT_MS = 75000/);
  assert.match(script, /Date\.now\(\) - lastUpdateReceivedAt > OVERLAY_HEARTBEAT_TIMEOUT_MS/);
  assert.match(script, /window\.__ppAgentOverlayTeardown\?\.\(true\)/);
  assert.match(script, /lastUpdateReceivedAt = Date\.now\(\)/);
  assert.match(script, /clearInterval\(heartbeatTimer\)/);
  assert.doesNotMatch(script, /setTimeout\(cleanup, isReducedMotionPreferred\(\) \? 0 : 180\)/);
  assert.match(script, /if \(!host\) \{[\s\S]*?mount\(\)/);
  assert.match(script, /startHeartbeat\(\);\s*\}\)\(\);$/);
  assert.doesNotMatch(script, /\n  mount\(\);\s*\}\)\(\);$/);
  assert.match(script, /__ppAgentOverlayTerminalStopUntil/);
  assert.match(script, /sessionStorage\.setItem\(TERMINAL_STOP_KEY/);
  assert.match(script, /sessionStorage\.getItem\(TERMINAL_STOP_KEY\)/);
  assert.ok(
    script.indexOf('signal("stop", { stopAll: true, reason: "user_stop" });') < script.indexOf("window.__ppAgentOverlayTeardown ="),
    "terminal stop dispatches the binding before fully tearing down its current overlay"
  );
  new vm.Script(script);
});

test("orphan agent overlay bootstrap stays invisible until a valid payload arrives", () => {
  const script = agentOverlayBootstrapScript();
  let createdElements = 0;
  const pageWindow = {
    sessionStorage: {
      getItem() { return null; },
      removeItem() {}
    }
  };
  pageWindow.top = pageWindow;
  pageWindow.self = pageWindow;
  vm.runInNewContext(script, {
    window: pageWindow,
    sessionStorage: pageWindow.sessionStorage,
    document: {
      documentElement: {},
      createElement() {
        createdElements += 1;
        return {};
      }
    },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    Number,
    JSON,
    Math
  });

  assert.equal(createdElements, 0);
  assert.equal(pageWindow.__ppAgentOverlayInstalled, true);
  assert.equal(typeof pageWindow.__ppAgentOverlayUpdate, "function");
});

test("agent overlay bootstrap is compatible with strict Trusted Types pages", () => {
  const script = agentOverlayBootstrapScript();
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /insertAdjacentHTML|createContextualFragment|DOMParser/);
  assert.doesNotMatch(script, /trustedTypes\.createPolicy/);
  assert.match(script, /const styleNode = overlayNode\("style"\)/);
  assert.match(script, /document\.createElement\(tagName\)/);
  assert.match(script, /styleNode\.textContent = styleText/);
  assert.match(script, /document\.createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.match(script, /shadowRoot\.append\(styleNode, wrapNode, cursorLayerNode\)/);
  new vm.Script(script);
});

test("agent overlay details toggle also works after user takeover", () => {
  const script = agentOverlayBootstrapScript();
  const toggleDetails = script.match(/function toggleDetails\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(script, /detailToggleButton\.addEventListener\("click", toggleDetails\)/);
  assert.match(script, /host\.classList\.toggle\("expanded", expanded\)/);
  assert.doesNotMatch(script, /host\.classList\.toggle\("expanded", !taken && expanded\)/);
  assert.match(toggleDetails, /expanded = !expanded/);
  assert.doesNotMatch(toggleDetails, /isDelegatedToUser/);
});

test("agent overlay progress animation stays compositor-friendly", () => {
  const script = agentOverlayBootstrapScript();
  assert.doesNotMatch(script, /transition:width/);
  assert.doesNotMatch(script, /progressFill\.style\.width/);
  assert.match(script, /progressFill\.style\.transform = "scaleX\(" \+ percent \/ 100 \+ "\)"/);
  assert.match(script, /transform-origin:left center/);
});

test("agent overlay bootstrap script includes zh/en copy and locale selection", () => {
  const script = agentOverlayBootstrapScript();
  assert.match(script, /OVERLAY_TEXT/);
  assert.match(script, /locale/);
  assert.match(script, /currentLocale/);
  assert.match(script, /navigator\.language/);
  assert.match(script, /AI 正在控制 · /);
  assert.match(script, /AI is controlling · /);
  assert.match(script, /已接管，AI 已暂停操作/);
  assert.match(script, /Taken over — AI paused/);
  assert.match(script, /Agent 调试中/);
  assert.match(script, /Agent debugging/);
  assert.match(script, /暂时无法手动点击/);
  assert.match(script, /正在启用点击保护/);
  assert.match(script, /需要给“ProfilePilot Input Guard”开启辅助功能权限/);
  assert.match(script, /Manual clicks are temporarily disabled/);
  assert.match(script, /Agent 任务/);
  assert.match(script, /Agent task/);
  assert.match(script, /查看控制详情/);
  assert.match(script, /Show control details/);
  assert.match(script, /任务空间/);
  assert.match(script, /Task space/);
  assert.match(script, /projectPrefix: "项目"/);
  assert.match(script, /sessionPrefix: "Session"/);
  assert.match(script, /compactSessionId/);
  assert.match(script, /spaceChip\.title = fullTaskSpaceText/);
  assert.match(script, /Hard-stop notice sent/);
  assert.match(script, /接管/);
  assert.match(script, /returnToAgent: "交还 Agent"/);
  assert.match(script, /offlineButton: "Agent 已离线"/);
  assert.match(script, /releaseProfile: "释放 Profile"/);
  assert.match(script, /confirmRelease: "再点一次释放"/);
  assert.match(script, /takeover: "接管"/);
  assert.match(script, /stopSingle: "结束任务"/);
  assert.doesNotMatch(script, /takeover: "Take over"/);
  assert.doesNotMatch(script, /stopSingle: "Stop task"/);
  assert.doesNotMatch(script, /再点一次接管/);
  assert.doesNotMatch(script, /Click again to take over/);
  assert.match(script, /再点一次结束/);
  assert.doesNotMatch(script, /confirmStop: "Click again to stop"/);
  assert.match(script, /在 ProfilePilot 中查看/);
  assert.match(script, /Open in ProfilePilot/);
  assert.match(script, /targetPrefix/);
  assert.match(script, /目标：/);
  assert.match(script, /Target: /);
  assert.match(script, /browser control returned to you/);
});

test("agent overlay bootstrap script exposes fail-closed native Input Guard hit testing", () => {
  const script = agentOverlayBootstrapScript();
  assert.doesNotMatch(script, /class=\\"shield\\"/);
  assert.match(script, /host\.style\.pointerEvents = "none"/);
  assert.doesNotMatch(script, /\.shield\{/);
  assert.doesNotMatch(script, /radial-gradient/);
  assert.match(script, /overlayNode\("div", "status-line"\)/);
  assert.match(script, /overlayNode\("span", "state-chip"\)/);
  assert.match(script, /overlayNode\("span", "space-chip"\)/);
  assert.match(script, /overlayNode\("button", "icon-btn detail-toggle"/);
  assert.match(script, /overlayNode\("div", "details"/);
  assert.doesNotMatch(script, /INPUT_LOCK_EVENTS/);
  assert.doesNotMatch(script, /beforeinput/);
  assert.doesNotMatch(script, /shouldBlockPageInput/);
  assert.match(script, /copy\.lockedTitle/);
  assert.match(script, /compactTaskSpaceText/);
  assert.match(script, /EXPANDED_KEY/);
  assert.match(script, /toggleDetails/);
  assert.match(script, /:host\(.locked\.expanded\) \.details\{/);
  assert.match(script, /:host\(.locked\) \.details\{display:none\}/);
  assert.match(script, /host\.classList\.toggle\("collapsed", taken && collapsed && !offline\)/);
  assert.match(script, /:host\(.locked\.collapsed\) \.panel\{display:grid\}/);
  assert.match(script, /host\.classList\.add\("locked"\)/);
  assert.doesNotMatch(script, /host\.classList\.toggle\("locked", !taken\)/);
  assert.match(script, /const stopLabel = stopConfirming && stopConfirmKind === "stop" \? text\(\)\.confirmStop : isMultiSession\(\) \? text\(\)\.stopAll : text\(\)\.stopSingle/);
  assert.doesNotMatch(script, /stopButton\.textContent = text\(\)\.takenStop/);
  assert.match(script, /signal\("resume", \{ stopAll: false \}\)/);
  assert.match(script, /takeoverButton\.disabled = !hasBinding/);
  assert.match(script, /takeoverButton\.disabled = !hasBinding \|\| pending \|\| offline/);
  assert.match(script, /stopButton\.disabled = !hasBinding/);
  assert.match(script, /const wasDelegatedToUser = isDelegatedToUser\(\)/);
  assert.match(script, /if \(!wasDelegatedToUser\) \{\s*resetStopConfirm\(\)/);
  assert.doesNotMatch(script, /WINDOW_GEOMETRY_SAMPLE_MS/);
  assert.doesNotMatch(script, /window-geometry/);
  assert.doesNotMatch(script, /window-focus/);
  assert.doesNotMatch(script, /window-blur/);
  assert.match(script, /window\.outerWidth/);
  assert.match(script, /window\.visualViewport/);
  assert.match(script, /devicePixelRatio \/ displayScale/);
  assert.match(script, /__ppAgentOverlayGuardProbe/);
  assert.match(script, /__ppAgentOverlayGuardActivate/);
  assert.match(script, /guardActionAtClientPoint/);
  assert.match(script, /Agent 正在后台操作/);
  assert.match(script, /显示 Agent 标签页/);
  assert.match(script, /自动切换标签页/);
  assert.match(script, /role: "switch", "aria-checked": "false"/);
  assert.match(script, /signal\("show-agent-target"\)/);
  assert.match(script, /signal\("set-auto-follow", \{ enabled: !state\.autoFollowAgent \}\)/);
  assert.match(script, /\["showAgentTarget", showAgentTargetButton\]/);
  assert.match(script, /\["toggleAutoFollow", autoFollowButton\]/);
  assert.match(script, /rect\.left \+ inset/);
});

test("AgentOverlayManager arms Input Guard only for active visible Chrome main pids", async () => {
  const syncCalls = [];
  const inputGuard = {
    sync(pids) {
      syncCalls.push([...pids]);
    },
    dispose() {}
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    inputGuard,
    requestVersionInfo: async () => ({})
  });
  manager.sync({
    enabled: true,
    ports: [
      {
        port: 9480,
        profileId: "test-profile",
        profileName: "Test Profile",
        browserPids: [501, 501],
        headless: false,
        clients: [{ pid: 42, label: "agent-browser" }]
      },
      {
        port: 9481,
        profileId: "headless-profile",
        profileName: "Headless Profile",
        browserPids: [777],
        headless: true,
        clients: [{ pid: 43, label: "agent-browser" }]
      }
    ]
  });
  assert.deepEqual(syncCalls.at(-1), [501]);
  manager.sync({ enabled: false, ports: [] });
  assert.deepEqual(syncCalls.at(-1), []);
  await manager.dispose();
});

test("AgentOverlayManager keeps Input Guard off while the same CDP client is paused", async () => {
  let now = 1_000;
  const syncCalls = [];
  const inputGuard = {
    sync(pids) {
      syncCalls.push([...pids]);
    },
    dispose() {}
  };
  const manager = new AgentOverlayManager({
    now: () => now,
    onStop: async () => {},
    inputGuard,
    requestVersionInfo: async () => ({})
  });
  const port = {
    port: 9480,
    profileId: "test-profile",
    profileName: "Test Profile",
    browserPids: [501],
    headless: false,
    clients: [{ pid: 42, label: "agent-browser", session: "cx-one" }]
  };

  manager.sync({ enabled: true, ports: [port] });
  assert.deepEqual(syncCalls.at(-1), [501]);

  manager.sync({ enabled: true, ports: [{ ...port, controlPaused: true }] });
  assert.deepEqual(syncCalls.at(-1), []);
  assert.equal(manager.ports.get(9480).delegatedToUser, true);

  now += 10_000;
  manager.sync({ enabled: true, ports: [{ ...port, controlPaused: true }] });
  assert.deepEqual(syncCalls.at(-1), []);

  manager.sync({ enabled: true, ports: [{ ...port, controlPaused: false }] });
  assert.deepEqual(syncCalls.at(-1), [501]);
  assert.equal(manager.ports.get(9480).delegatedToUser, false);
  await manager.dispose();
});

test("AgentOverlayManager activates only a live probe in the clicked native window", async () => {
  const evaluations = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method, params) {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 9, bounds: { left: 0, top: 38, width: 1512, height: 867, windowState: "normal" } };
      }
      if (method === "Runtime.evaluate") {
        evaluations.push(params.expression);
        if (String(params.expression).includes("__ppAgentOverlayGuardProbe")) {
          return { result: { value: { action: "takeover", signature: "live-layout" } } };
        }
        return { result: { value: true } };
      }
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  const manager = new AgentOverlayManager({ onStop: async () => {}, inputGuard: { sync() {}, dispose() {} } });
  const state = createOverlayState({
    browserPids: [501],
    headless: false,
    browserClient: fakeClient,
    targetCache: { targets: [{ id: "target-1", type: "page", url: "https://example.test" }], expiresAt: Date.now() + 10_000 },
    targetRequest: null,
    targetCacheGeneration: 0
  });
  const page = createOverlayPage({
    sessionId: "session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);

  await manager.handleInputGuardClick({
    pid: 501,
    windowId: 88,
    displayScale: 2,
    window: { x: 0, y: 38, width: 1512, height: 867 },
    down: { x: 700, y: 780 },
    up: { x: 701, y: 780 },
    startedAt: 1_000,
    endedAt: 2_000
  });

  assert.equal(evaluations.length, 2);
  assert.match(evaluations[0], /__ppAgentOverlayGuardProbe/);
  assert.match(evaluations[1], /__ppAgentOverlayGuardActivate/);
});

test("main process keeps agent control UI inside the web page", async () => {
  const source = await readFile(path.join(__dirname, "..", "src", "main", "main.ts"), "utf8");
  assert.match(source, /createProfileManager\(broadcastAgentTakeover, revealAgentOverlayProfile\)/);
  assert.doesNotMatch(source, /createAgentLockWindow/);
  assert.doesNotMatch(source, /agentLockWindows/);
  assert.doesNotMatch(source, /FrontmostAppMonitor/);
  assert.doesNotMatch(source, /frontmost-app-monitor/);
});

test("AgentOverlayManager pure logic handles disabled and empty sync inputs", () => {
  const manager = new AgentOverlayManager({ onStop: async () => {} });
  assert.doesNotThrow(() => manager.sync({ enabled: false, ports: [] }));
  assert.doesNotThrow(() => manager.sync({ enabled: true, ports: [] }));
  assert.equal(manager.getActivity([]), null);

  const client = {
    pid: 42,
    label: "agent-browser",
    project: "profilepilot",
    title: "Overlay tests",
    session: "cx-not-a-real-uuid",
    lastActive: "2026-07-08T00:00:00.000Z"
  };
  assert.deepEqual(manager.getActivity([client]), {
    agent: "Codex",
    project: "profilepilot",
    session: "cx-not-a-real-uuid",
    sessionTitle: "Overlay tests",
    updatedAt: "2026-07-08T00:00:00.000Z"
  });
  assert.equal(isAgentOverlayClient(client), true);
  assert.equal(isAgentOverlayClient({ pid: 43, label: "Chrome" }), false);
});

test("AgentOverlayManager rejects binding stop signals from unknown execution contexts", async () => {
  const stopCalls = [];
  const manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    }
  });
  const client = {
    pid: 42,
    label: "agent-browser",
    project: "profilepilot",
    title: "Overlay tests",
    session: "cx-context-test",
    lastActive: "2026-07-08T00:00:00.000Z"
  };
  const state = {
    port: 9480,
    profileId: "test-profile",
    profileName: "Test Profile",
    clients: [client],
    pages: new Map(),
    browserClient: null,
    browserConnecting: false,
    syncing: false,
    takeoverInFlight: false,
    takenOverUntil: 0,
    lastPayload: null,
    sessionStartedAt: new Map()
  };
  const page = {
    targetId: "target-1",
    url: "https://example.test/",
    sessionId: "session-1",
    attachPending: false,
    connecting: false,
    closing: false,
    activeContextId: 7,
    isolatedContextIds: new Set([7]),
    lastPayloadText: "",
    lastPushAt: 0
  };

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 99,
    payload: JSON.stringify({ action: "stop" })
  });

  assert.equal(stopCalls.length, 0);
});

test("AgentOverlayManager sends a pid-scoped stop request for a sessionless single driver", async () => {
  const stopCalls = [];
  const manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    }
  });
  const state = createOverlayState({
    clients: [
      {
        pid: 42,
        label: "agent-browser",
        project: "profilepilot",
        title: "Sessionless Codex"
      }
    ]
  });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  manager.ports.set(state.port, state);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "stop" })
  });

  await waitFor(() => stopCalls.length, "sessionless pid-scoped stop");
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].pid, 42);
  assert.deepEqual(stopCalls[0].pids, [42]);
  assert.equal(stopCalls[0].session, undefined);
  assert.equal(stopCalls[0].reason, "user_stop");
  assert.equal(stopCalls[0].stopAll, false);
});

test("AgentOverlayManager sends one stop-all request for multi-session takeover", async () => {
  const stopCalls = [];
  const manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    }
  });
  const state = createOverlayState({
    clients: [
      {
        pid: 42,
        label: "agent-browser",
        project: "profilepilot",
        title: "Codex one",
        session: "cx-one"
      },
      {
        pid: 77,
        label: "agent-browser",
        project: "profilepilot",
        title: "Codex two",
        session: "cx-two"
      }
    ]
  });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  manager.ports.set(state.port, state);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "stop", reason: "user_stop" })
  });

  await waitFor(() => stopCalls.length, "multi-session stop-all");
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].pid, 42);
  assert.equal(stopCalls[0].pids, undefined);
  assert.equal(stopCalls[0].session, undefined);
  assert.equal(stopCalls[0].reason, "user_stop");
  assert.equal(stopCalls[0].stopAll, true);
});

test("AgentOverlayManager returns delegated control to the original Agent", async () => {
  const resumeCalls = [];
  const inputGuardSyncs = [];
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    onResume: async (request) => {
      resumeCalls.push(request);
    },
    inputGuard: {
      sync(pids) {
        inputGuardSyncs.push([...pids]);
      },
      dispose() {}
    }
  });
  const state = createOverlayState({
    browserPids: [27371],
    delegatedToUser: true,
    takenOverUntil: Date.now() + 60_000
  });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  manager.ports.set(state.port, state);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "resume", session: "cx-context-test" })
  });

  await waitFor(() => resumeCalls.length, "return control to Agent");
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].pid, 42);
  assert.deepEqual(resumeCalls[0].pids, [42]);
  assert.equal(resumeCalls[0].session, "cx-context-test");
  assert.equal(resumeCalls[0].resumeAll, false);
  assert.equal(state.delegatedToUser, false);
  assert.equal(state.takenOverUntil, 0);
  assert.deepEqual(inputGuardSyncs.at(-1), [27371]);
});

test("AgentOverlayManager refuses return-to-Agent when its waiter is offline but still releases the Session", async () => {
  const resumeCalls = [];
  const stopCalls = [];
  const manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    },
    onResume: async (request) => {
      resumeCalls.push(request);
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({
    delegatedToUser: true,
    agentOffline: true,
    controlSince: "2026-07-10T08:00:00.000Z",
    takenOverUntil: Date.now() + 60_000
  });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  manager.ports.set(state.port, state);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "resume", session: "cx-context-test" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resumeCalls.length, 0);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "stop", reason: "user_stop", session: "cx-context-test" })
  });
  await waitFor(() => stopCalls.length, "release offline Session");
  assert.equal(stopCalls[0].reason, "user_stop");
  assert.equal(manager.ports.has(state.port), false);
});

test("AgentOverlayManager clears the takeover-pending UI when quiescence fails", async () => {
  const manager = new AgentOverlayManager({
    onStop: async () => {
      throw new Error("当前 agent-browser 命令尚未结束");
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState();
  manager.ports.set(state.port, state);

  await manager.handleStopSignal(state, "cx-context-test", "user_takeover");

  assert.equal(state.delegatedToUser, false);
  assert.equal(state.handoffPending, false);
  assert.match(state.stopError, /命令尚未结束/);
  assert.equal(state.lastPayload.handoffPending, false);
});

test("AgentOverlayManager removes a completed Session after releasing its Profile", async () => {
  const completionCalls = [];
  const inputGuardSyncs = [];
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    onComplete: async (request) => {
      completionCalls.push(request);
    },
    inputGuard: {
      sync(pids) {
        inputGuardSyncs.push([...pids]);
      },
      dispose() {}
    }
  });
  const state = createOverlayState({ browserPids: [27371] });
  manager.ports.set(state.port, state);
  manager.tailers.set("cx-context-test", {
    getControlPhase: () => "completed",
    stop() {}
  });

  await manager.handleSessionTailerUpdate("cx-context-test");

  assert.equal(completionCalls.length, 1);
  assert.equal(completionCalls[0].profileId, "test-profile");
  assert.equal(completionCalls[0].session, "cx-context-test");
  assert.deepEqual(completionCalls[0].pids, [42]);
  assert.equal(manager.ports.has(state.port), false);
  assert.equal(manager.tailers.has("cx-context-test"), false);
  assert.equal(state.clients.length, 0);
  assert.equal(state.delegatedToUser, false);
  assert.equal(state.alive, false);
  assert.equal(manager.completedSessions.has("cx-context-test"), false);
  assert.deepEqual(inputGuardSyncs.at(-1), []);

  await manager.handleSessionTailerUpdate("cx-context-test");
  assert.equal(completionCalls.length, 1);

});

test("AgentOverlayManager removes page overlays before completing the Gateway Session", async () => {
  const sequence = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method, params) {
      if (method === "Runtime.evaluate" && String(params.expression).includes("__ppAgentOverlayTeardown")) {
        sequence.push("overlay-teardown");
      } else {
        sequence.push(method);
      }
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    onComplete: async () => {
      sequence.push("onComplete");
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ browserClient: fakeClient });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    scriptIdentifier: "future-document-script",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);
  manager.tailers.set("cx-context-test", {
    getControlPhase: () => "completed",
    stop() {}
  });

  await manager.handleSessionTailerUpdate("cx-context-test");

  assert.deepEqual(sequence.slice(0, 4), [
    "Runtime.evaluate",
    "Page.removeScriptToEvaluateOnNewDocument",
    "overlay-teardown",
    "onComplete"
  ]);
  assert.equal(manager.ports.has(state.port), false);
});

test("AgentOverlayManager tears down stale page UI before closing its internal observer", async () => {
  const sequence = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {
      sequence.push("observer-close");
    },
    async send(method, params) {
      if (method === "Runtime.evaluate" && String(params.expression).includes("__ppAgentOverlayTeardown")) {
        sequence.push("overlay-teardown");
      }
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ browserClient: fakeClient });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);

  manager.sync({ enabled: true, ports: [] });
  await waitFor(() => sequence.includes("observer-close"), "stale overlay observer close");

  assert.equal(manager.ports.has(state.port), false);
  assert.ok(sequence.indexOf("overlay-teardown") < sequence.indexOf("observer-close"));
});

test("AgentOverlayManager cleans stale overlays on an inactive running port once", async () => {
  const methods = [];
  let targetRequests = 0;
  let overlayHostPresent = true;
  const pageClient = {
    onEvent: null,
    onDisconnect: null,
    close() {
      methods.push("close");
    },
    async send(method, params) {
      methods.push(method);
      if (method === "Runtime.enable") {
        this.onEvent?.("Runtime.executionContextCreated", {
          context: { id: 5, name: "__ppAgentOverlayWorld" }
        });
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-1" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        assert.equal(params.worldName, "__ppAgentOverlayWorld");
        return { executionContextId: 7 };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        if (expression.includes('Boolean(document.getElementById')) {
          return { result: { value: overlayHostPresent } };
        }
        if (expression.includes("const teardown")) {
          assert.ok(params.contextId === 5 || params.contextId === 7);
          overlayHostPresent = false;
          return { result: { value: params.contextId === 5 } };
        }
        if (expression.includes('document.getElementById("__pp-agent-overlay")?.remove()')) {
          overlayHostPresent = false;
          return { result: { value: true } };
        }
      }
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    requestTargets: async () => {
      targetRequests += 1;
      return [{
        id: "target-1",
        type: "page",
        url: "https://example.test",
        webSocketDebuggerUrl: "ws://inactive-page"
      }];
    },
    connectBrowser: async () => pageClient,
    inputGuard: { sync() {}, dispose() {} }
  });

  manager.sync({ enabled: true, ports: [], inactivePorts: [9480] });
  await waitFor(() => methods.includes("close"), "inactive port overlay cleanup");
  assert.equal(methods[0], "Runtime.enable");
  assert.equal(methods[1], "Page.enable");
  assert.equal(methods.includes("Page.getFrameTree"), true);
  assert.equal(methods.includes("Page.createIsolatedWorld"), true);
  assert.equal(methods.at(-1), "close");
  assert.equal(overlayHostPresent, false);

  manager.sync({ enabled: true, ports: [], inactivePorts: [9480] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(targetRequests, 1);
});

test("AgentOverlayManager retries inactive overlay cleanup when any target fails", async () => {
  let targetRequests = 0;
  let connectAttempts = 0;
  const pageClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method) {
      if (method === "Runtime.enable") {
        this.onEvent?.("Runtime.executionContextCreated", {
          context: { id: 5, name: "__ppAgentOverlayWorld" }
        });
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: false } };
      }
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    requestTargets: async () => {
      targetRequests += 1;
      return [{
        id: "target-1",
        type: "page",
        url: "https://example.test",
        webSocketDebuggerUrl: "ws://inactive-page"
      }];
    },
    connectBrowser: async () => {
      connectAttempts += 1;
      if (connectAttempts === 1) {
        throw new Error("target disappeared during cleanup");
      }
      return pageClient;
    },
    inputGuard: { sync() {}, dispose() {} }
  });

  manager.sync({ enabled: true, ports: [], inactivePorts: [9480] });
  await waitFor(() => connectAttempts === 1 && !manager.cleanedInactivePorts.has(9480), "failed cleanup retry eligibility");

  manager.sync({ enabled: true, ports: [], inactivePorts: [9480] });
  await waitFor(() => connectAttempts === 2, "inactive overlay cleanup retry");
  assert.equal(targetRequests, 2);
});

test("AgentOverlayManager still allows ending a task after user takeover", async () => {
  const stopCalls = [];
  const manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ delegatedToUser: true, takenOverUntil: Date.now() + 60_000 });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  manager.ports.set(state.port, state);

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 7,
    payload: JSON.stringify({ action: "stop", reason: "user_stop", session: "cx-context-test" })
  });

  await waitFor(() => stopCalls.length, "end task after takeover");
  assert.equal(stopCalls[0].reason, "user_stop");
  assert.equal(stopCalls[0].session, "cx-context-test");
});

test("AgentOverlayManager removes the control box only when the Session ends", async () => {
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ delegatedToUser: true, takenOverUntil: Date.now() + 60_000 });
  manager.ports.set(state.port, state);
  manager.completedSessions.add("cx-context-test");

  await manager.handleStopSignal(state, "cx-context-test", "user_stop");

  assert.equal(manager.ports.has(state.port), false);
  assert.equal(manager.completedSessions.has("cx-context-test"), false);
  assert.equal(state.alive, false);
  assert.equal(state.clients.length, 0);
});

test("AgentOverlayManager revokes page bootstrap before a terminal Session stop settles", async () => {
  const sequence = [];
  let finishStop;
  const stopPending = new Promise((resolve) => {
    finishStop = resolve;
  });
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method) {
      sequence.push(method);
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {
      sequence.push("onStop");
      await stopPending;
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ browserClient: fakeClient });
  const page = createOverlayPage({
    sessionId: "page-session-1",
    scriptIdentifier: "future-document-script",
    activeContextId: 7,
    isolatedContextIds: new Set([7])
  });
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);

  const stopping = manager.handleStopSignal(state, "cx-context-test", "user_stop");
  await waitFor(() => sequence.includes("onStop"), "terminal stop started");

  assert.deepEqual(sequence.slice(0, 4), [
    "Runtime.evaluate",
    "Page.removeScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
    "onStop"
  ]);
  assert.equal(page.scriptIdentifier, undefined);
  assert.equal(manager.ports.has(state.port), true, "Session remains authoritative until onStop succeeds");

  finishStop();
  await stopping;
  assert.equal(manager.ports.has(state.port), false);
  assert.equal(state.alive, false);
});

test("AgentOverlayManager uses target discovery without browser-wide auto-attach", async () => {
  const methods = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method) {
      methods.push(method);
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    requestVersionInfo: async () => ({ webSocketDebuggerUrl: "ws://browser" }),
    requestTargets: async () => [],
    connectBrowser: async () => fakeClient,
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState();
  manager.ports.set(state.port, state);

  await manager.ensureTargetObserver(state);

  assert.equal(methods.includes("Target.setDiscoverTargets"), true);
  assert.equal(methods.includes("Target.setAutoAttach"), false);
  assert.equal(state.browserClient, fakeClient);
  await manager.dispose();
});

test("agent overlay includes every Chrome WebUI page while keeping DevTools separate", () => {
  for (const url of [
    "chrome://newtab/",
    "chrome://new-tab-page/",
    "chrome://settings/",
    "chrome://extensions/",
    "chrome://history/",
    "chrome://downloads/",
    "chrome://flags/",
    "chrome://version/",
    "chrome-untrusted://new-tab-page/",
    "chrome-error://chromewebdata/",
    "view-source:chrome://version/",
    "about:chrome",
    "chrome-extension://abcdefghijklmnop/popup.html",
    "https://example.com/"
  ]) {
    assert.equal(isAgentOverlayInjectableUrl(url), true, `${url} should receive the agent control overlay`);
  }
  assert.equal(
    isAgentOverlayInjectableUrl("devtools://devtools/bundled/devtools_app.html"),
    false,
    "docked DevTools keeps its separate native-window geometry boundary"
  );
});

test("AgentOverlayManager supports injection, takeover, return, and cleanup on Chrome-owned pages", async () => {
  const calls = [];
  const pushedPayloads = [];
  const stopCalls = [];
  const resumeCalls = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method, params = {}, _timeoutMs, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") {
        return { sessionId: `${params.targetId}-session` };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return { identifier: `${sessionId}-overlay-script` };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: `${sessionId}-main-frame` } } };
      }
      if (method === "Page.createIsolatedWorld") {
        assert.equal(params.frameId, `${sessionId}-main-frame`);
        return { executionContextId: sessionId === "chrome-internal-target-session" ? 88 : 77 };
      }
      if (method === "Runtime.evaluate" && String(params.expression).includes("globalThis.__ppAgentOverlayUpdate(")) {
        const expression = String(params.expression);
        const marker = "globalThis.__ppAgentOverlayUpdate(";
        const start = expression.lastIndexOf(marker) + marker.length;
        pushedPayloads.push({
          sessionId,
          payload: JSON.parse(expression.slice(start, expression.lastIndexOf(")")))
        });
      }
      return {};
    }
  };
  const manager = new AgentOverlayManager({
    locale: "zh",
    requestTargets: async () => [
      {
        id: "extension-target",
        type: "page",
        title: "扩展页面",
        url: "chrome-extension://abcdefghijklmnop/popup.html",
        webSocketDebuggerUrl: "ws://extension-target"
      },
      {
        id: "chrome-internal-target",
        type: "page",
        title: "扩展程序",
        url: "chrome://extensions/",
        webSocketDebuggerUrl: "ws://chrome-internal-target"
      }
    ],
    onStop: async (request) => {
      stopCalls.push(request);
    },
    onResume: async (request) => {
      resumeCalls.push(request);
    },
    inputGuard: { sync() {}, dispose() {} }
  });
  const state = createOverlayState({ browserClient: fakeClient });
  manager.ports.set(state.port, state);

  await manager.syncPortTargets(state);

  const page = state.pages.get("extension-target");
  const chromePage = state.pages.get("chrome-internal-target");
  assert.ok(page, "chrome-extension page should be selected for injection");
  assert.ok(chromePage, "chrome:// page should be selected for injection");
  await waitFor(
    () =>
      page.activeContextId === 77 &&
      chromePage.activeContextId === 88 &&
      !page.connecting &&
      !chromePage.connecting &&
      pushedPayloads.length >= 2,
    "Chrome-owned page overlay initialization"
  );
  assert.equal(page.url, "chrome-extension://abcdefghijklmnop/popup.html");
  assert.equal(page.sessionId, "extension-target-session");
  assert.equal(page.activeContextId, 77);
  assert.equal(chromePage.url, "chrome://extensions/");
  assert.equal(chromePage.sessionId, "chrome-internal-target-session");
  assert.equal(chromePage.activeContextId, 88);
  const terminalMarkerClears = () => calls.filter((call) =>
    call.sessionId === "extension-target-session" &&
    call.method === "Runtime.evaluate" &&
    String(call.params.expression).includes('sessionStorage.removeItem("__ppAgentOverlayTerminalStopUntil")')
  ).length;
  assert.equal(terminalMarkerClears(), 1);
  await manager.initializePageSession(state, page, "extension-target-session");
  assert.equal(terminalMarkerClears(), 1, "same Target reinitialization must preserve a terminal stop marker");
  assert.equal(calls.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument"), true);
  assert.equal(pushedPayloads.at(-1).payload.ownership, "agent");

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 77,
    payload: JSON.stringify({ action: "stop", reason: "user_takeover", session: "cx-context-test" })
  });
  await waitFor(() => stopCalls.length === 1 && state.delegatedToUser, "extension page takeover");
  assert.equal(stopCalls[0].reason, "user_takeover");
  assert.equal(pushedPayloads.at(-1).payload.ownership, "agentDelegatedToUser");

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 77,
    payload: JSON.stringify({ action: "resume", session: "cx-context-test" })
  });
  await waitFor(
    () => resumeCalls.length === 1 && !state.delegatedToUser && !state.takeoverInFlight,
    "extension page return to Agent"
  );
  assert.equal(resumeCalls[0].session, "cx-context-test");
  assert.equal(pushedPayloads.at(-1).payload.ownership, "agent");

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 77,
    payload: JSON.stringify({ action: "stop", reason: "user_stop", session: "cx-context-test" })
  });
  await waitFor(() => !manager.ports.has(state.port), "extension page Session cleanup");
  assert.equal(stopCalls.length, 2);
  assert.equal(stopCalls[1].reason, "user_stop");
  assert.equal(state.alive, false);
  assert.equal(calls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"), true);
  assert.equal(calls.some((call) =>
    call.method === "Runtime.evaluate" && String(call.params.expression).includes("__ppAgentOverlayTeardown")
  ), true);
  assert.equal(calls.some((call) => call.method === "Runtime.removeBinding"), true);
  assert.equal(calls.some((call) => call.method === "Target.detachFromTarget"), true);
});

test("AgentOverlayManager rebuilds an isolated world after all known contexts fail and throttles recovery", async () => {
  let now = Date.parse("2026-07-08T00:00:00.000Z");
  let createWorldCalls = 0;
  const updateContexts = [];
  const failingUpdateContexts = new Set([7, 8]);
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        if (String(params.expression).startsWith("globalThis.__ppAgentOverlayUpdate")) {
          updateContexts.push(params.contextId);
          if (failingUpdateContexts.has(params.contextId)) {
            throw new Error(`context ${params.contextId} is gone`);
          }
        }
        return {};
      }
      if (method === "Page.createIsolatedWorld") {
        createWorldCalls += 1;
        assert.equal(params.frameId, "frame-1");
        assert.equal(params.worldName, "__ppAgentOverlayWorld");
        return { executionContextId: 42 };
      }
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  const manager = new AgentOverlayManager({ onStop: async () => {}, now: () => now });
  const state = createOverlayState({ browserClient: fakeClient });
  const page = createOverlayPage({
    sessionId: "session-1",
    mainFrameId: "frame-1",
    activeContextId: 7,
    isolatedContextIds: new Set([7, 8])
  });
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);

  await manager.pushPageUpdate(state, page, true);

  assert.deepEqual(updateContexts, [7, 8, 42]);
  assert.equal(createWorldCalls, 1);
  assert.equal(page.activeContextId, 42);
  assert.equal(page.isolatedContextIds.has(42), true);

  failingUpdateContexts.add(42);
  failingUpdateContexts.add(100);
  page.isolatedContextIds.add(100);
  page.activeContextId = 100;
  now += 1000;
  await manager.pushPageUpdate(state, page, true);

  assert.equal(createWorldCalls, 1);
});

test("AgentOverlayManager builds page-specific no-focus target payloads", () => {
  const manager = new AgentOverlayManager({ onStop: async () => {} });
  const state = createOverlayState({
    agentTarget: {
      targetId: "target-byte-cloud",
      title: "云引擎 - 字节云",
      url: "https://cloud.bytedance.net/engine"
    }
  });
  const byteCloud = createOverlayPage({ targetId: "target-byte-cloud" });
  const bots = createOverlayPage({ targetId: "target-bots" });

  const currentPayload = manager.payloadForPort(state, byteCloud);
  const backgroundPayload = manager.payloadForPort(state, bots);
  assert.equal(currentPayload.agentTargetIsCurrentPage, true);
  assert.equal(backgroundPayload.agentTargetIsCurrentPage, false);
  assert.equal(backgroundPayload.agentTargetTitle, "云引擎 - 字节云");
  assert.equal(backgroundPayload.agentTargetDomain, "cloud.bytedance.net");
  assert.equal(backgroundPayload.autoFollowAgent, false);
});

test("AgentOverlayManager activates only after an explicit target signal and keeps auto-follow off by default", async () => {
  const activations = [];
  const manager = new AgentOverlayManager({
    onStop: async () => {},
    onActivateTarget: async (request) => activations.push(request.port)
  });
  const state = createOverlayState({
    agentTarget: { targetId: "target-byte-cloud", title: "字节云", url: "https://cloud.bytedance.net/" }
  });
  const page = createOverlayPage({ isolatedContextIds: new Set([17]) });
  manager.ports.set(state.port, state);

  assert.equal(state.autoFollowAgent, false);
  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 17,
    payload: JSON.stringify({ action: "show-agent-target" })
  });
  await waitFor(() => activations.length === 1, "explicit Agent target activation");

  manager.handlePageEvent(state, page, "Runtime.bindingCalled", {
    name: "__ppAgentOverlaySignal",
    executionContextId: 17,
    payload: JSON.stringify({ action: "set-auto-follow", enabled: true })
  });
  await waitFor(() => activations.length === 2, "auto-follow activation");
  assert.equal(state.autoFollowAgent, true);

  manager.syncDelegatedControl(state, true, Date.now());
  assert.equal(state.autoFollowAgent, false);
});

test("AgentOverlayManager ignores late attach results after dispose and rolls back the session", async () => {
  const attachResult = deferred();
  const methods = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {
      methods.push("close");
    },
    async send(method, params) {
      methods.push(method);
      if (method === "Target.attachToTarget") {
        return attachResult.promise;
      }
      if (method === "Target.detachFromTarget") {
        assert.deepEqual(params, { sessionId: "late-session" });
        return {};
      }
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  const manager = new AgentOverlayManager({ onStop: async () => {} });
  const state = createOverlayState({ browserClient: fakeClient });
  const page = createOverlayPage();
  state.pages.set(page.targetId, page);
  manager.ports.set(state.port, state);

  const attach = manager.attachPage(state, page);
  assert.equal(page.attachPending, true);
  await manager.dispose();
  attachResult.resolve({ sessionId: "late-session" });
  await attach;

  assert.equal(state.pages.size, 0);
  assert.equal(page.sessionId, null);
  assert.equal(methods.includes("Runtime.enable"), false);
  assert.equal(methods.includes("Runtime.addBinding"), false);
  assert.deepEqual(methods.filter((method) => method === "Target.detachFromTarget"), ["Target.detachFromTarget"]);
});

function createOverlayState(overrides = {}) {
  return {
    port: 9480,
    profileId: "test-profile",
    profileName: "Test Profile",
    browserPids: [],
    headless: false,
    clients: [
      {
        pid: 42,
        label: "agent-browser",
        project: "profilepilot",
        title: "Overlay tests",
        session: "cx-context-test",
        lastActive: "2026-07-08T00:00:00.000Z"
      }
    ],
    pages: new Map(),
    browserClient: null,
    browserConnecting: false,
    syncing: false,
    targetSyncRequested: false,
    alive: true,
    takeoverInFlight: false,
    handoffPending: false,
    delegatedToUser: false,
    agentOffline: false,
    controlSince: undefined,
    delegationGraceUntil: 0,
    takenOverUntil: 0,
    lastPayload: null,
    stopError: null,
    targetCache: null,
    targetRequest: null,
    targetCacheGeneration: 0,
    sessionStartedAt: new Map(),
    agentTarget: null,
    autoFollowAgent: false,
    targetActivationInFlight: false,
    ...overrides
  };
}

function createOverlayPage(overrides = {}) {
  return {
    targetId: "target-1",
    url: "https://example.test/",
    sessionId: null,
    attachPending: false,
    connecting: false,
    closing: false,
    isolatedContextIds: new Set(),
    lastPayloadText: "",
    lastPushAt: 0,
    lastContextRecoveryAt: 0,
    recoveringContext: false,
    terminalMarkerCleared: false,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function startTailer(session, base) {
  const tailer = new SessionTailer(session, base, () => {}, { pollIntervalMs: TAILER_POLL_INTERVAL_MS });
  tailer.start();
  return tailer;
}

async function withTempHome(callback) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "profilepilot-overlay-tests-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await callback(tempHome);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    await rm(tempHome, { recursive: true, force: true });
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createClaudeSession(home, uuid, entries) {
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return createClaudeRawSession(home, uuid, text ? `${text}\n` : "");
}

async function createClaudeRawSession(home, uuid, text) {
  const dir = path.join(home, ".claude", "projects", "-tmp-profilepilot");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  await writeFile(file, text, "utf8");
  return file;
}

async function createCodexSession(home, uuid, entries) {
  const dir = path.join(home, ".codex", "sessions", "2026", "07", "08");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-08T00-00-00-${uuid}.jsonl`);
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(file, text ? `${text}\n` : "", "utf8");
  return file;
}

async function waitForActivity(tailer, predicate, label) {
  const startedAt = Date.now();
  const deadline = startedAt + WAIT_TIMEOUT_MS;
  let lastActivity = tailer.getActivity();
  while (Date.now() < deadline) {
    lastActivity = tailer.getActivity();
    if (predicate(lastActivity)) {
      return lastActivity;
    }
    await delay(WAIT_INTERVAL_MS);
  }
  const elapsed = Date.now() - startedAt;
  assert.fail(`Timed out after ${elapsed}ms waiting for ${label}; last activity: ${JSON.stringify(lastActivity)}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
