import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { loadTsModule } = require("./helpers/load-ts-module.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("writeJsonFileAtomic uses UUID temp names, fsyncs handle, and leaves zero temp files under concurrency", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-atomic-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let syncCalls = 0;
  const seenTmpNames = new Set();
  const realOpen = fs.promises.open.bind(fs.promises);

  const fsStub = {
    ...fs,
    promises: {
      ...fs.promises,
      async open(filePath, flags, mode) {
        seenTmpNames.add(path.basename(String(filePath)));
        const handle = await realOpen(filePath, flags, mode);
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => {
          syncCalls += 1;
          return origSync();
        };
        return handle;
      }
    }
  };

  const fsUtil = loadTsModule("src/main/fs-util.ts", {
    stubs: { "node:fs": fsStub }
  });

  const target = path.join(dir, "profiles.json");
  await Promise.all(
    Array.from({ length: 12 }, (_, idx) => fsUtil.writeJsonFileAtomic(target, { index: idx, ok: true }))
  );

  assert.equal(syncCalls, 12, "every atomic write must fsync before rename");
  assert.equal(seenTmpNames.size, 12, "concurrent writes on the same millisecond must use distinct UUID temp names");
  for (const name of seenTmpNames) {
    assert.match(name, /^profiles\.json\.tmp-\d+-[0-9a-f-]{36}$/i);
  }
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(parsed.ok, true);
  assert.deepEqual(fs.readdirSync(dir), ["profiles.json"], "no .tmp-* files may remain");
});

test("writeJsonFileAtomic retries Windows EPERM/EACCES/EBUSY renames and cleans up temp files on failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-atomic-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const realRename = fs.promises.rename.bind(fs.promises);
  const transientCodes = ["EPERM", "EACCES", "EBUSY"];
  let renameAttempts = 0;
  let forcePermanentFailure = false;

  const fsStub = {
    ...fs,
    promises: {
      ...fs.promises,
      async rename(fromPath, toPath) {
        renameAttempts += 1;
        if (forcePermanentFailure) {
          throw Object.assign(new Error("locked forever"), { code: "EPERM" });
        }
        if (renameAttempts <= transientCodes.length) {
          const code = transientCodes[renameAttempts - 1];
          throw Object.assign(new Error(`transient ${code}`), { code });
        }
        return realRename(fromPath, toPath);
      }
    }
  };

  const fsUtil = loadTsModule("src/main/fs-util.ts", {
    stubs: { "node:fs": fsStub }
  });

  const target = path.join(dir, "state.json");
  await fsUtil.writeJsonFileAtomic(target, { saved: "after-retries" });
  assert.equal(renameAttempts, 4, "3 transient errors + 1 successful rename");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { saved: "after-retries" });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);

  // Exceeding bounded retry limit (1 initial + 4 retries = 5 attempts) rethrows and removes temp file.
  renameAttempts = 0;
  forcePermanentFailure = true;
  await assert.rejects(
    () => fsUtil.writeJsonFileAtomic(target, { saved: "never" }),
    (err) => err?.code === "EPERM"
  );
  assert.equal(renameAttempts, 5, "bounded at 4 retries (5 total attempts)");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { saved: "after-retries" }, "original file stays intact");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"], "failed atomic write must clean up leftover .tmp-* file");
});

test("global-instructions normalizes Windows backslashes and quotes usernames containing spaces in CLAUDE.md", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-claude-space-"));
  const spacedHome = path.join(root, "Users", "Alice Smith");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const instructions = loadTsModule("src/main/global-instructions.ts", {
    stubs: { "node:os": { homedir: () => spacedHome } }
  });

  assert.equal(
    instructions.formatClaudeInstructionReference("C:\\Users\\dev\\.codex\\AGENTS.md"),
    "@C:/Users/dev/.codex/AGENTS.md"
  );
  assert.equal(
    instructions.formatClaudeInstructionReference("C:\\Users\\Alice Smith\\.codex\\AGENTS.md"),
    '@"C:/Users/Alice Smith/.codex/AGENTS.md"'
  );

  const snapshot = await instructions.ensureClaudeInstructionShell();
  const claude = snapshot.files.find((f) => f.id === "claude-memory");
  assert.equal(claude.exists, true);
  assert.equal(claude.isReferenceShell, true);
  assert.doesNotMatch(claude.content, /\\/, "Windows backslashes must be normalized in CLAUDE.md");
  assert.match(claude.content, /@"[^"]*Alice Smith\/\.codex\/AGENTS\.md"/);
});

test("ShutdownCoordinator keeps browser-connection alive until tasks-save-and-handoff finishes and supports ordered tiers", async () => {
  const { ShutdownCoordinator } = loadTsModule("src/main/shutdown-coordinator.ts");
  const events = [];
  const handoffDone = deferred();
  let transportOpenDuringHandoff = false;
  let transportOpen = true;

  const coordinator = new ShutdownCoordinator({
    stages: [
      {
        name: "tasks-save-and-handoff",
        async run() {
          events.push("tasks:start");
          await handoffDone.promise;
          transportOpenDuringHandoff = transportOpen;
          events.push("tasks:done");
        }
      },
      {
        name: "browser-connection",
        async run() {
          events.push("browser:start");
          transportOpen = false;
          events.push("browser:done");
        }
      },
      {
        name: "final-audit",
        order: 2,
        run() {
          events.push("audit:done");
        }
      }
    ],
    log() {},
    requestQuit: () => events.push("quit"),
    forceExit: () => events.push("forced")
  });

  coordinator.beforeQuit({ preventDefault() {} }, "test");
  await flush();
  assert.deepEqual(events, ["tasks:start"], "browser-connection must wait while task handoff is in flight");
  assert.equal(transportOpen, true);

  handoffDone.resolve();
  await flush();
  await flush();
  await flush();

  assert.equal(transportOpenDuringHandoff, true);
  assert.deepEqual(events, ["tasks:start", "tasks:done", "browser:start", "browser:done", "audit:done", "quit"]);
  assert.equal(coordinator.clean, true);
  coordinator.didQuit();
});

test("windowsPowerShellBrowserLauncherContent forwards JS expressions and > safely without cmd.exe redirection", { skip: process.platform !== "win32" }, (t) => {
  const { windowsPowerShellBrowserLauncherContent } = loadTsModule("src/main/shell-integration.ts");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-ab-ps1-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, "bin dir");
  const workDir = path.join(root, "work");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const wrapperPath = path.join(binDir, "profilepilot-agent-browser-wrapper.cjs");
  fs.writeFileSync(
    wrapperPath,
    "console.log(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1], session: process.env.AGENT_BROWSER_SESSION, main: require.main === module }));\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(binDir, "agent-browser.ps1"),
    windowsPowerShellBrowserLauncherContent(
      { wrapperPath, wrapperSignature: "PROFILEPILOT_AGENT_BROWSER_WRAPPER" },
      process.execPath
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(binDir, "agent-browser.cmd"), "@echo CMD_SHOULD_NOT_RUN\r\n@exit /b 88\r\n", "utf8");

  const psExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const cmd = "agent-browser eval '({id}, e.outerHTML)' '1 > 0 && 2 < 3 | 0' '' '中文 参数'; exit $LASTEXITCODE";
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    CLAUDE_CODE_SESSION_ID: "session-uuid-1"
  };
  delete env.AGENT_BROWSER_SESSION;
  delete env.PROFILEPILOT_SESSION;

  const res = spawnSync(
    psExe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(cmd, "utf16le").toString("base64")],
    { cwd: workDir, env, encoding: "utf8", windowsHide: true }
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.main, true);
  assert.equal(out.entry, wrapperPath);
  assert.equal(out.session, "cc-session-uuid-1");
  assert.deepEqual(out.argv, ["eval", "({id}, e.outerHTML)", "1 > 0 && 2 < 3 | 0", "", "中文 参数"]);
  assert.deepEqual(fs.readdirSync(workDir), [], "no 0-byte redirection files may be created in cwd");
});
