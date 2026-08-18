const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

test("release notes are extracted from the matching changelog section", async () => {
  const script = await import(pathToFileURL(path.resolve("scripts/extract-release-notes.mjs")).href);
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const stable = script.extractReleaseNotes(changelog, "v0.1.0");
  assert.match(stable, /^# \[0\.1\.0\] - 2026-06-08/m);
  assert.match(stable, /首个公开版本/);
  assert.doesNotMatch(stable, /结构化诊断日志/);
  const rolling = script.extractReleaseNotes(changelog, "latest");
  assert.match(rolling, /^# \[Unreleased\]/m);
  assert.match(rolling, /profilepilot doctor/);
  assert.throws(() => script.extractReleaseNotes(changelog, "v9.9.9"), /does not contain/);
});
