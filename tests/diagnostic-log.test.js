const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  diagnosticLogPath,
  diagnosticRuntimeStatePath,
  getDiagnosticLogStats,
  initializeDiagnosticLogging,
  startRuntimeStateTracking,
  stopRuntimeStateTracking,
  readDiagnosticLogs,
  writeDiagnosticLog
} = require("../dist/main/diagnostic-log.js");

test("diagnostic log redacts secrets, rotates files, and reads newest structured entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-logs-"));
  const env = { ...process.env, PROFILEPILOT_LOG_ROOT: path.join(root, "logs") };
  try {
    initializeDiagnosticLogging({ env, appVersion: "test", maxBytes: 600, retainedFiles: 2, captureConsole: false });
    writeDiagnosticLog("info", "test", "redaction", "proxy http://alice:secret@example.com token=visible", {
      authorization: "Bearer private",
      nested: { password: "private", safe: "kept" }
    });
    const redactedContent = fs.readFileSync(diagnosticLogPath(root, env), "utf8");
    assert.doesNotMatch(redactedContent, /alice|secret|visible|Bearer private|"password":"private"/);
    assert.match(redactedContent, /\[REDACTED\]/);
    for (let index = 0; index < 12; index += 1) {
      writeDiagnosticLog("error", "test", "rotation", `failure-${index}`, { padding: "x".repeat(160) });
    }

    const active = diagnosticLogPath(root, env);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(`${active}.1`), true);
    assert.equal(fs.existsSync(`${active}.2`), true);
    assert.equal(fs.existsSync(`${active}.3`), false);
    const allContent = [active, `${active}.1`, `${active}.2`]
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    assert.doesNotMatch(allContent, /Bearer private|"password":"private"/);

    const entries = readDiagnosticLogs({ env, limit: 3, levels: ["error"] });
    assert.equal(entries.length, 3);
    assert.equal(entries.at(-1).message, "failure-11");
    const stats = getDiagnosticLogStats(root, env);
    assert.equal(stats.files, 3);
    assert.ok(stats.bytes > 0);

    startRuntimeStateTracking({ heartbeatMs: 1_000 });
    const runtimePath = diagnosticRuntimeStatePath(root, env);
    let runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    assert.equal(runtime.pid, process.pid);
    assert.equal(runtime.clean_shutdown, false);
    stopRuntimeStateTracking("test-complete");
    runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    assert.equal(runtime.clean_shutdown, true);
    assert.equal(runtime.shutdown_reason, "test-complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("process crash logging records an uncaught main-process exception before Node exits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-crash-log-"));
  const logRoot = path.join(root, "logs");
  const modulePath = path.resolve(__dirname, "../dist/main/diagnostic-log.js");
  try {
    const child = spawnSync(process.execPath, ["-e", `
      const diagnostics = require(${JSON.stringify(modulePath)});
      diagnostics.initializeDiagnosticLogging({ appVersion: "crash-test", captureConsole: false });
      diagnostics.installProcessCrashLogging();
      diagnostics.startRuntimeStateTracking({ heartbeatMs: 1000 });
      throw new Error("diagnostic-crash-marker");
    `], {
      encoding: "utf8",
      env: { ...process.env, PROFILEPILOT_LOG_ROOT: logRoot }
    });
    assert.notEqual(child.status, 0);
    const entries = fs.readFileSync(path.join(logRoot, "profilepilot.log.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const crash = entries.find((entry) => entry.event === "process.uncaught_exception");
    assert.ok(crash);
    assert.match(crash.message, /diagnostic-crash-marker/);
    const runtime = JSON.parse(fs.readFileSync(path.join(logRoot, "runtime-state.json"), "utf8"));
    assert.equal(runtime.clean_shutdown, false);
    assert.equal(runtime.last_failure.event, "process.uncaught_exception");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
