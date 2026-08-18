const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  diagnosticLogPath,
  getDiagnosticLogStats,
  initializeDiagnosticLogging,
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
