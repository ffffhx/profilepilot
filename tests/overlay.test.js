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

const TEST_TIMEOUT_MS = 3000;

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
      await delay(100);
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
      await delay(100);
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
            type: "function_call",
            name: "shell",
            arguments: JSON.stringify({ command: "cat /tmp/agent-browser-cdp/SKILL.md" })
          }
        }
      }
    ]);

    const tailer = startTailer(`cx-${uuid}`, {});
    try {
      await waitForActivity(tailer, (value) => value.agent === "Codex", "Codex pseudo command session");
      await delay(100);
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
  await delay(25);

  assert.equal(stopCalls.length, 0);
});

function startTailer(session, base) {
  const tailer = new SessionTailer(session, base, () => {});
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
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const activity = tailer.getActivity();
    if (predicate(activity)) {
      return activity;
    }
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(tailer.getActivity())}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
