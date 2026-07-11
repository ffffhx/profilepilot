const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MacInputGuard, parseInputGuardOutputLine } = require("../dist/main/input-guard.js");
const {
  ensureInputGuardCompanion,
  inputGuardBuildInfoPath,
  inputGuardExecutablePath,
  launchInputGuardCompanion
} = require("../dist/main/input-guard-companion.js");

test("Input Guard re-enables taps disabled by either macOS condition", () => {
  const source = readFileSync(path.join(__dirname, "..", "native", "input-guard.c"), "utf8");
  const callback = source.slice(source.indexOf("static CGEventRef guard_callback"), source.indexOf("static CGEventMask guarded_event_mask"));
  assert.match(callback, /kCGEventTapDisabledByTimeout \|\| type == kCGEventTapDisabledByUserInput/);
  assert.match(callback, /CGEventTapEnable\(entry->tap, true\)/);
  assert.doesNotMatch(callback, /emit_status\("tap-disabled"/);
});

test("Input Guard checks Accessibility without prompting unless explicitly requested", () => {
  const source = readFileSync(path.join(__dirname, "..", "native", "input-guard.c"), "utf8");
  assert.match(source, /AXIsProcessTrusted\(\)/);
  assert.match(source, /--request-accessibility/);
  assert.match(source, /check_accessibility_access\(true\)/);
  assert.match(source, /check_accessibility_access\(false\)/);
  assert.match(source, /AXIsProcessTrustedWithOptions/);
  assert.match(source, /kAXTrustedCheckOptionPrompt/);
  assert.match(source, /accessibility-access-denied/);
  assert.match(source, /check_accessibility_access\(false\);[\s\S]*emit_status\("ready"/);
});

test("Input Guard build prefers its stable local signing identity", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "scripts", "build-input-guard.mjs"),
    "utf8"
  );
  assert.match(source, /ProfilePilot Input Guard Local Signing/);
  assert.match(source, /input-guard-signing\.keychain-db/);
  assert.match(source, /signingIdentity\?\.fingerprint \|\| "ad-hoc"/);
  assert.match(source, /signingIdentity\?\.fingerprint \|\| "-"/);
  assert.match(source, /withTemporaryKeychainSearchPath/);

  const setupSource = readFileSync(
    path.join(__dirname, "..", "scripts", "setup-input-guard-signing.mjs"),
    "utf8"
  );
  assert.match(setupSource, /"-p",\s*"codeSign"/);
  assert.match(setupSource, /basicConstraints = critical,CA:TRUE/);
  assert.match(setupSource, /removeKeychainFromSearchList/);
  assert.doesNotMatch(setupSource, /-p",\s*"ssl/);
});

test("Input Guard companion preserves an installed build until the native build id changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profilepilot-input-guard-"));
  const sourceAppPath = path.join(root, "source", "ProfilePilot Input Guard.app");
  const installAppPath = path.join(root, "home", "Applications", "ProfilePilot Input Guard.app");
  const writeSource = (buildId, executable) => {
    mkdirSync(path.dirname(inputGuardExecutablePath(sourceAppPath)), { recursive: true });
    mkdirSync(path.dirname(inputGuardBuildInfoPath(sourceAppPath)), { recursive: true });
    writeFileSync(inputGuardExecutablePath(sourceAppPath), executable);
    writeFileSync(inputGuardBuildInfoPath(sourceAppPath), JSON.stringify({ buildId }));
  };

  try {
    writeSource("native-v1", "first binary");
    const installedExecutable = ensureInputGuardCompanion({ sourceAppPath, installAppPath });
    assert.equal(installedExecutable, inputGuardExecutablePath(installAppPath));
    assert.equal(readFileSync(installedExecutable, "utf8"), "first binary");

    writeSource("native-v1", "rebuilt but equivalent helper");
    ensureInputGuardCompanion({ sourceAppPath, installAppPath });
    assert.equal(readFileSync(installedExecutable, "utf8"), "first binary");

    writeSource("native-v2", "updated native helper");
    ensureInputGuardCompanion({ sourceAppPath, installAppPath });
    assert.equal(readFileSync(installedExecutable, "utf8"), "updated native helper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Input Guard parses native mouse messages with window geometry", () => {
  assert.deepEqual(
    parseInputGuardOutputLine(
      JSON.stringify({
        type: "mouse",
        pid: 120,
        phase: "down",
        button: 0,
        x: 350.25,
        y: 740.5,
        windowId: 88,
        timestamp: 1000,
        displayScale: 2,
        window: { x: 0, y: 38, width: 1512, height: 867 }
      })
    ),
    {
      type: "mouse",
      pid: 120,
      phase: "down",
      button: 0,
      x: 350.25,
      y: 740.5,
      windowId: 88,
      timestamp: 1000,
      displayScale: 2,
      window: { x: 0, y: 38, width: 1512, height: 867 }
    }
  );
  assert.equal(parseInputGuardOutputLine("not-json"), null);
  assert.equal(
    parseInputGuardOutputLine(JSON.stringify({ type: "mouse", pid: 120, phase: "up", button: 0 })),
    null
  );
});

test("Input Guard reports healthy only after every requested pid has an active tap", () => {
  const statuses = [];
  const guard = new MacInputGuard({
    platform: "linux",
    onClick: () => {},
    onStatus: (message) => statuses.push(message.status)
  });
  guard.sync([120]);
  guard.handleStdout(`${JSON.stringify({ type: "status", status: "tap-create-failed", pid: 120 })}\n`);
  guard.handleStdout(`${JSON.stringify({ type: "status", status: "sync-complete", activeCount: 0 })}\n`);
  assert.equal(statuses.at(-1), "guard-unavailable");

  guard.handleStdout(`${JSON.stringify({ type: "status", status: "tap-active", pid: 120 })}\n`);
  guard.handleStdout(`${JSON.stringify({ type: "status", status: "sync-complete", activeCount: 1 })}\n`);
  assert.equal(statuses.at(-1), "guard-active");
  guard.dispose();
});

test("Input Guard emits a click only when down/up stay in the same unmoved window", () => {
  const clicks = [];
  const guard = new MacInputGuard({ platform: "linux", onClick: (click) => clicks.push(click) });
  const base = {
    type: "mouse",
    pid: 120,
    button: 0,
    windowId: 88,
    displayScale: 2,
    window: { x: 0, y: 38, width: 1512, height: 867 }
  };
  guard.handleStdout(`${JSON.stringify({ ...base, phase: "down", x: 700, y: 780, timestamp: 1_000 })}\n`);
  guard.handleStdout(`${JSON.stringify({ ...base, phase: "up", x: 702, y: 781, timestamp: 2_000 })}\n`);
  assert.equal(clicks.length, 1);
  assert.deepEqual(clicks[0].down, { x: 700, y: 780 });
  assert.deepEqual(clicks[0].up, { x: 702, y: 781 });

  guard.handleStdout(`${JSON.stringify({ ...base, phase: "down", x: 700, y: 780, timestamp: 3_000 })}\n`);
  guard.handleStdout(
    `${JSON.stringify({
      ...base,
      phase: "up",
      x: 702,
      y: 781,
      timestamp: 4_000,
      window: { ...base.window, x: 100 }
    })}\n`
  );
  assert.equal(clicks.length, 1);

  guard.handleStdout(`${JSON.stringify({ ...base, phase: "down", x: 700, y: 780, timestamp: 5_000 })}\n`);
  guard.handleStdout(
    `${JSON.stringify({ ...base, phase: "up", x: 702, y: 781, timestamp: 6_000, displayScale: 1 })}\n`
  );
  assert.equal(clicks.length, 1);
});

test("Input Guard native helper accepts SET commands and reports failed unknown pids", { skip: process.platform !== "darwin" }, async () => {
  const helper = path.join(__dirname, "..", "dist", "native", "profilepilot-input-guard");
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes('"status":"ready"')) {
      child.stdin.write("SET 2147480000\nQUIT\n");
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Input Guard helper timed out: ${output}`));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Input Guard helper exited ${code}`));
    });
  });
  assert.match(output, /"status":"ready"/);
  assert.match(output, /"status":"tap-create-failed"/);
  assert.match(output, /"status":"sync-complete"/);
});

test("Input Guard companion launches independently through LaunchServices and a private socket", { skip: process.platform !== "darwin" }, async () => {
  const helper = path.join(
    __dirname,
    "..",
    "dist",
    "native",
    "ProfilePilot Input Guard.app",
    "Contents",
    "MacOS",
    "ProfilePilot Input Guard"
  );
  const child = launchInputGuardCompanion(helper);
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes('"status":"ready"') && !output.includes('"status":"sync-complete"')) {
      child.stdin.write("SET 2147480000\nQUIT\n");
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Input Guard companion timed out: ${output}`));
    }, 8000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Input Guard companion exited ${code}`));
    });
  });
  assert.match(output, /"status":"ready"/);
  assert.match(output, /"status":"tap-create-failed"/);
  assert.match(output, /"status":"sync-complete"/);
});
