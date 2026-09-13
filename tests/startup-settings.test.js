const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { StartupSettingsManager, startupLoginItemOptions } = require("../dist/main/startup-settings.js");

const windows = { platform: "win32", isPackaged: false,
  executablePath: "C:\\项目 空间\\node_modules\\electron\\electron.exe", appPath: "C:\\项目 空间\\ProfilePilot" };

function fixture(t, environment = windows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pp-startup-"));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "startup-settings.json");
  const native = { openAtLogin: false, executableWillLaunchAtLogin: false };
  const writes = [], reads = [];
  const api = {
    getLoginItemSettings(options) { reads.push(options); return { ...native }; },
    setLoginItemSettings(settings) {
      writes.push(settings);
      native.openAtLogin = settings.openAtLogin;
      native.executableWillLaunchAtLogin = settings.enabled;
    }
  };
  const restart = () => new StartupSettingsManager(file, api, environment);
  return { file, native, writes, reads, api, restart, manager: restart() };
}

test("Windows login entry passes raw paths for Electron to quote and includes the project only in development", () => {
  assert.deepEqual(startupLoginItemOptions(windows), {
    name: "ProfilePilot", path: windows.executablePath, args: ["C:\\项目 空间\\ProfilePilot"]
  });
  assert.deepEqual(startupLoginItemOptions({ ...windows, isPackaged: true }), {
    name: "ProfilePilot", path: windows.executablePath, args: []
  });
  assert.deepEqual(startupLoginItemOptions({ ...windows, appPath: "C:\\项目 空间\\" }).args,
    ["C:\\项目 空间\\"]);
});

test("default-on applies once, and explicit opt-out survives an application restart", t => {
  const f = fixture(t);
  assert.equal(f.manager.initialize().enabled, true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.reads.at(-1), { path: `"${windows.executablePath}"`, args: [windows.appPath] },
    "the lookup parses a command line, so quote the executable but keep argument values unchanged");
  assert.equal(f.restart().initialize().enabled, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.manager.setEnabled(false).enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { enabled: false });
  assert.equal(f.restart().initialize().enabled, false);
  assert.equal(f.writes.length, 2, "restarting must not register the app again");
  assert.equal(f.manager.setEnabled(true).enabled, true);
});

test("Windows startup approval is checked for this app, and an OS opt-out is respected", t => {
  const f = fixture(t);
  f.manager.initialize();
  f.native.launchItems = [{ name: "Other Electron App", enabled: true, scope: "user", args: [] },
    { name: "ProfilePilot", enabled: false, scope: "user", args: [windows.appPath] }];
  assert.equal(f.restart().initialize().enabled, false);
  assert.equal(f.writes.length, 1, "do not override a user's Task Manager choice");
  delete f.native.launchItems;
  f.native.executableWillLaunchAtLogin = false;
  assert.equal(f.manager.get().enabled, false);
});

test("Windows named entries work without an AppUserModelID match and reject another project's arguments", t => {
  const f = fixture(t);
  f.native.launchItems = [{ name: "ProfilePilot", enabled: true, scope: "user", args: [windows.appPath] }];
  assert.equal(f.native.openAtLogin, false, "Electron only uses AppUserModelID for this legacy field");
  assert.equal(f.manager.get().enabled, true);
  f.native.launchItems[0].args = ["C:\\some-other-project"];
  assert.equal(f.manager.get().enabled, false);
  f.native.launchItems = [];
  assert.equal(f.manager.get().enabled, false);
});

test("macOS uses its application bundle and reports approval still required", t => {
  const f = fixture(t, { ...windows, platform: "darwin", isPackaged: true });
  f.native.status = "requires-approval";
  f.api.setLoginItemSettings = settings => { f.writes.push(settings); };
  const settings = f.manager.initialize();
  assert.equal(settings.enabled, true);
  assert.equal(settings.requiresApproval, true);
  assert.equal(settings.error, null);
  assert.equal(f.writes[0].path, undefined);
  assert.equal(f.writes[0].args, undefined);
});

test("macOS development and unsupported platforms never register generic Electron or write preferences", t => {
  for (const platform of ["darwin", "linux"]) {
    const f = fixture(t, { ...windows, platform });
    assert.equal(f.manager.initialize().supported, false);
    assert.equal(f.manager.setEnabled(true).supported, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.reads.length, 0);
    assert.equal(fs.existsSync(f.file), false);
  }
});

test("failed OS writes and silent failures are visible and never reapply the default", t => {
  const f = fixture(t);
  f.manager.initialize();
  f.api.setLoginItemSettings = () => { throw new Error("permission denied"); };
  assert.match(f.manager.setEnabled(false).error, /permission denied/);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).enabled, false);
  f.restart().initialize();
  assert.equal(f.writes.length, 1);
  f.api.setLoginItemSettings = () => {};
  assert.match(f.manager.setEnabled(false).error, /系统未应用/);
});

test("corrupt preferences and invalid IPC values cannot turn startup on", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "broken-json");
  assert.ok(f.manager.initialize().error);
  assert.equal(fs.readFileSync(f.file, "utf8"), "broken-json");
  assert.throws(() => f.manager.setEnabled("false"), /布尔值/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.manager.setEnabled(false).error, null, "an explicit choice can repair invalid preferences");
});

test("a preferences write failure does not change system login items", t => {
  const f = fixture(t);
  const blockedParent = path.join(path.dirname(f.file), "not-a-directory");
  fs.writeFileSync(blockedParent, "file");
  const manager = new StartupSettingsManager(path.join(blockedParent, "settings.json"), f.api, windows);
  assert.ok(manager.setEnabled(true).error);
  assert.equal(f.writes.length, 0);
});
