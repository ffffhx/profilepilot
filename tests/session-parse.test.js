const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { chmod, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SessionTailer,
  describeAgentBrowserCommand,
  findAgentBrowserCommand
} = require("../dist/main/session-tail.js");

const TEST_TIMEOUT_MS = 3500;

test("agent-browser detection rejects path-like false positives and unknown verbs", () => {
  assert.equal(findAgentBrowserCommand("cat /tmp/agent-browser-cdp/SKILL.md"), "");
  assert.equal(findAgentBrowserCommand("ls /tmp/agent-browser/"), "");
  assert.equal(findAgentBrowserCommand("echo agent-browser open https://example.test"), "");
  assert.equal(findAgentBrowserCommand("agent-browser --version"), "");
  assert.equal(findAgentBrowserCommand("agent-browser inspect https://example.test"), "");
});

test("agent-browser detection accepts command-token positions with known actions", () => {
  const commands = [
    "agent-browser open https://example.test/path",
    "cd /tmp && agent-browser click \"Save changes\"",
    "printf '{}' | agent-browser snapshot",
    "/usr/local/bin/agent-browser scroll 0 500",
    "true; /opt/homebrew/bin/agent-browser eval \"document.title\""
  ];
  for (const command of commands) {
    assert.equal(findAgentBrowserCommand(command), command);
  }
});

test("agent-browser descriptions cover chained and newer actions", () => {
  assert.equal(
    describeAgentBrowserCommand("agent-browser mouse move 10 20 && agent-browser mouse down"),
    "移动/点击鼠标等 2 步操作"
  );
  assert.equal(describeAgentBrowserCommand("agent-browser press Enter"), "按键 Enter");
  assert.equal(describeAgentBrowserCommand("agent-browser key Escape"), "按键 Escape");
  assert.equal(describeAgentBrowserCommand("agent-browser scroll 0 500"), "滚动页面");
  assert.equal(describeAgentBrowserCommand("agent-browser wait 500"), "等待");
  assert.equal(describeAgentBrowserCommand("agent-browser eval \"document.title\""), "执行脚本");
});

test("SessionTailer filters pure tool receipts from assistant lastMessage", async () => {
  await withTempHome(async (home) => {
    const uuid = randomUUID();
    await createClaudeSession(home, uuid, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "✓ Bash completed\n✗ Previous probe failed\nThe parser now ignores receipt-only lines."
            }
          ]
        }
      }
    ]);

    const tailer = startTailer(`cc-${uuid}`, {});
    try {
      const activity = await waitForActivity(
        tailer,
        (value) => value.lastMessage === "The parser now ignores receipt-only lines.",
        "filtered Claude assistant text"
      );
      assert.equal(activity.lastMessage, "The parser now ignores receipt-only lines.");
    } finally {
      tailer.stop();
    }
  });
});

test("listOpenCodexRollouts times out slow lsof, falls back to sessions, and caches", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "profilepilot-lsof-timeout-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPath = process.env.PATH;
  const previousLog = process.env.LSOF_LOG;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const fakeBin = path.join(tempHome, "bin");
    await mkdir(fakeBin, { recursive: true });
    const lsofLog = path.join(tempHome, "lsof.log");
    const fakeLsof = path.join(fakeBin, "lsof");
    await writeFile(fakeLsof, "#!/bin/sh\necho call >> \"$LSOF_LOG\"\nexec /bin/sleep 5\n", "utf8");
    await chmod(fakeLsof, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath || ""}`;
    process.env.LSOF_LOG = lsofLog;

    const uuid = randomUUID();
    const rollout = await createCodexSession(tempHome, uuid, [
      { type: "session_meta", payload: { cwd: "/tmp/profilepilot" } }
    ]);

    const result = await runNodeProbe(
      `
        const { readFile } = require("node:fs/promises");
        const { performance } = require("node:perf_hooks");
        const {
          __resetSessionContextCachesForTests,
          listOpenCodexRollouts
        } = require("./dist/main/session-context.js");

        (async () => {
          __resetSessionContextCachesForTests();
          const firstStart = performance.now();
          const first = await listOpenCodexRollouts();
          const firstMs = performance.now() - firstStart;
          const secondStart = performance.now();
          const second = await listOpenCodexRollouts();
          const secondMs = performance.now() - secondStart;
          const log = await readFile(process.env.LSOF_LOG, "utf8").catch(() => "");
          console.log(JSON.stringify({
            first,
            second,
            firstMs,
            secondMs,
            lsofCalls: log.trim().split(/\\n/).filter(Boolean).length
          }));
        })().catch((error) => {
          console.error(error && error.stack ? error.stack : error);
          process.exit(1);
        });
      `,
      {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: process.env.PATH,
        LSOF_LOG: lsofLog
      }
    );

    const first = result.first;
    const firstMs = result.firstMs;
    assert.ok(first.includes(rollout), `fallback rollouts did not include ${rollout}`);
    assert.ok(firstMs < TEST_TIMEOUT_MS, `slow lsof was not capped: ${firstMs.toFixed(0)}ms`);

    assert.deepEqual(result.second, first);
    assert.ok(result.secondMs < 200, `cached lookup was too slow: ${result.secondMs.toFixed(0)}ms`);
    assert.equal(result.lsofCalls, 1);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PATH", previousPath);
    restoreEnv("LSOF_LOG", previousLog);
    await rm(tempHome, { recursive: true, force: true });
  }
});

function runNodeProbe(script, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", script],
      { cwd: path.resolve(__dirname, ".."), env, timeout: 7000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (parseError) {
          reject(new Error(`Invalid probe output: ${stdout}\n${stderr}\n${parseError}`));
        }
      }
    );
  });
}

function startTailer(session, base) {
  const tailer = new SessionTailer(session, base, () => {});
  tailer.start();
  return tailer;
}

async function withTempHome(callback) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "profilepilot-session-tests-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
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
  const dir = path.join(home, ".claude", "projects", "-tmp-profilepilot");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(file, text ? `${text}\n` : "", "utf8");
  return file;
}

async function createCodexSession(home, uuid, entries) {
  const dir = path.join(home, ".codex", "sessions", "2026", "07", "09");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-09T00-00-00-${uuid}.jsonl`);
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
