const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, mkdtemp, rm, writeFile, appendFile } = require("node:fs/promises");
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

const { AgentOverlayManager, isAgentOverlayClient } = require("../dist/main/agent-overlay.js");
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
  new vm.Script(script);
});

test("agent overlay bootstrap script includes zh/en copy and locale selection", () => {
  const script = agentOverlayBootstrapScript();
  assert.match(script, /OVERLAY_TEXT/);
  assert.match(script, /locale/);
  assert.match(script, /currentLocale/);
  assert.match(script, /navigator\.language/);
  assert.match(script, /AI 正在操作 · /);
  assert.match(script, /AI is operating · /);
  assert.match(script, /已接管，AI 已停止操作/);
  assert.match(script, /Taken over — AI stopped/);
  assert.match(script, /停止并接管/);
  assert.match(script, /Stop & take over/);
  assert.match(script, /再点一次确认接管/);
  assert.match(script, /Click again to confirm/);
  assert.match(script, /在 ProfilePilot 中查看/);
  assert.match(script, /Open in ProfilePilot/);
  assert.match(script, /targetPrefix/);
  assert.match(script, /目标：/);
  assert.match(script, /Target: /);
  assert.match(script, /browser control returned to you/);
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
    payload: JSON.stringify({ action: "stop" })
  });

  await waitFor(() => stopCalls.length, "multi-session stop-all");
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].pid, 42);
  assert.equal(stopCalls[0].pids, undefined);
  assert.equal(stopCalls[0].session, undefined);
  assert.equal(stopCalls[0].stopAll, true);
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
    alive: true,
    takeoverInFlight: false,
    takenOverUntil: 0,
    lastPayload: null,
    sessionStartedAt: new Map(),
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
