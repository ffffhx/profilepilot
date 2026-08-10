const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "e2e", "lib", "electron-driver.mjs"),
  "utf8"
);

test("macOS Electron E2E exposes the login keychain while keeping safe storage mocked", () => {
  assert.match(source, /process\.platform === "darwin"/);
  assert.match(source, /await symlink\(/);
  assert.match(source, /path\.join\(os\.homedir\(\), "Library", "Keychains"\)/);
  assert.match(source, /path\.join\(homeDir, "Library", "Keychains"\)/);
  assert.match(source, /electronArgs\.push\("--use-mock-keychain"\)/);
  assert.ok(
    source.indexOf('electronArgs.push("--use-mock-keychain")') <
      source.indexOf("electronArgs.push(repoRoot"),
    "the Chromium switch must precede the Electron app path"
  );
  assert.match(source, /spawn\(electronPath, electronArgs,/);
});
