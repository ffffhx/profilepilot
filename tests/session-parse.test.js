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
  extractAgentBrowserTargetUrl,
  findAgentBrowserCommand
} = require("../dist/main/session-tail.js");

const WAIT_TIMEOUT_MS = 10000;
const WAIT_INTERVAL_MS = 10;
const TAILER_POLL_INTERVAL_MS = 10;
const SLOW_LSOF_TIMEOUT_ASSERT_MS = 8000;

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

test("agent-browser target URL extraction covers navigation commands", () => {
  assert.equal(
    extractAgentBrowserTargetUrl("agent-browser open https://example.com/path/to/page?tab=ai#state"),
    "example.com/path/to/page?tab=ai#state"
  );
  assert.equal(
    extractAgentBrowserTargetUrl("agent-browser goto 'http://localhost:9510/demo/index.html'"),
    "localhost:9510/demo/index.html"
  );
  assert.equal(
    extractAgentBrowserTargetUrl("/opt/homebrew/bin/agent-browser --cdp http://127.0.0.1:9510 navigate https://docs.example.test/guide"),
    "docs.example.test/guide"
  );
  assert.equal(extractAgentBrowserTargetUrl("agent-browser click \"https://example.com/not-a-navigation\""), undefined);
  assert.equal(extractAgentBrowserTargetUrl("agent-browser open"), undefined);
  assert.equal(extractAgentBrowserTargetUrl("agent-browser goto not-a-url"), undefined);

  const longTarget = extractAgentBrowserTargetUrl(
    `agent-browser open https://example.com/${"nested/".repeat(20)}final`
  );
  assert.equal(longTarget.length, 90);
  assert.match(longTarget, /…$/);
  assert.doesNotMatch(longTarget, /^https?:\/\//);
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
    await writeFile(fakeLsof, "#!/bin/sh\necho call >> \"$LSOF_LOG\"\nexec /bin/sleep 10\n", "utf8");
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
    assert.ok(firstMs < SLOW_LSOF_TIMEOUT_ASSERT_MS, `slow lsof was not capped: ${firstMs.toFixed(0)}ms`);

    assert.deepEqual(result.second, first);
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
      { cwd: path.resolve(__dirname, ".."), env, timeout: 15000, maxBuffer: 1024 * 1024 },
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
  const tailer = new SessionTailer(session, base, () => {}, { pollIntervalMs: TAILER_POLL_INTERVAL_MS });
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
