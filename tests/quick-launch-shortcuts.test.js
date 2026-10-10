const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeQuickLaunchShortcut, normalizeQuickLaunchShortcuts, formatQuickLaunchShortcut, shortcutFromKeyEvent } = require("../dist/shared/quick-launch-shortcut.js");
const { QuickLaunchShortcuts } = require("../dist/main/quick-launch-shortcuts.js");
const { ProfileManager } = require("../dist/main/profile-manager.js");

test("keyboard capture and labels respect Windows and macOS modifiers", () => {
  const key = { code: "KeyK", key: "k", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false };
  assert.equal(shortcutFromKeyEvent(key, "win32"), "Control+Alt+K");
  assert.equal(formatQuickLaunchShortcut("Control+Alt+K", "win32"), "Ctrl+Alt+K");
  assert.equal(shortcutFromKeyEvent({ ...key, key: "˚", ctrlKey: false, metaKey: true }, "darwin"), "Alt+Command+K");
  assert.equal(formatQuickLaunchShortcut("Alt+Command+K", "darwin"), "⌥⌘K");
  assert.equal(shortcutFromKeyEvent({ ...key, code: "Digit1", key: "!", shiftKey: true }, "win32"), "Control+Alt+Shift+1");
  assert.equal(shortcutFromKeyEvent({ ...key, isComposing: true }, "win32"), null);
  assert.equal(normalizeQuickLaunchShortcut("K", "win32"), null);
  assert.equal(normalizeQuickLaunchShortcut("Shift+K", "win32"), null);
  assert.equal(normalizeQuickLaunchShortcut("Control+UnknownKey", "win32"), null);
  assert.equal(normalizeQuickLaunchShortcut("F12", "win32"), "F12");
  assert.equal(normalizeQuickLaunchShortcut("CommandOrControl+Alt+9", "win32"), "Control+Alt+9");
  assert.equal(normalizeQuickLaunchShortcut("CommandOrControl+Alt+9", "darwin"), "Alt+Command+9");
});

test("legacy slots migrate and invalid or duplicate bindings are removed", () => {
  const legacy = { 1: "one", 2: "one", 9: "nine", 10: "invalid" };
  assert.deepEqual({ ...normalizeQuickLaunchShortcuts(undefined, legacy, "win32") }, { one: "Control+Alt+1", nine: "Control+Alt+9" });
  assert.deepEqual({ ...normalizeQuickLaunchShortcuts({ one: "Ctrl+Shift+K", two: "Shift+Control+K", bad: "X" }, legacy, "win32", new Set(["one", "two"])) }, { one: "Control+Shift+K" });
});

function shortcuts() {
  const registered = new Map();
  const launched = [];
  const api = {
    register(key, action) { if (key === "Control+Alt+X" || registered.has(key)) return false; registered.set(key, action); return true; },
    unregister(key) { registered.delete(key); }
  };
  return { service: new QuickLaunchShortcuts(api, id => launched.push(id)), registered, launched };
}

test("rebind and clear release old keys; recording pauses and restores shortcuts", async () => {
  const { service, registered, launched } = shortcuts();
  service.sync({ one: "Control+Alt+1" });
  service.pause(true);
  assert.equal(registered.size, 0);
  service.pause(false);
  registered.get("Control+Alt+1")();
  assert.deepEqual(launched, ["one"]);
  await service.save("one", "Control+Shift+K", async () => {});
  assert.deepEqual([...registered.keys()], ["Control+Shift+K"]);
  await service.save("one", null, async () => {});
  assert.equal(registered.size, 0);
  service.sync({ two: "F8" });
  service.sync({});
  assert.equal(registered.size, 0, "deleting a profile releases its key");
});

test("occupied keys and failed writes preserve the previous binding", async () => {
  const { service, registered } = shortcuts();
  service.sync({ one: "Control+Alt+1" });
  await assert.rejects(service.save("one", "Control+Alt+X", async () => assert.fail("must not persist")), /占用/);
  await assert.rejects(service.save("two", "Control+Alt+1", async () => assert.fail("must not persist")), /其他 Profile/);
  await assert.rejects(service.save("one", "F9", async () => { throw new Error("disk write failed"); }), /disk write failed/);
  assert.deepEqual([...registered.keys()], ["Control+Alt+1"]);
});

test("registry migration, persistence, conflicts and clearing survive reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-shortcut-test-"));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new ProfileManager(directory);
  await manager.ensureStore();
  const file = path.join(directory, "profiles.json");
  await fs.writeFile(file, JSON.stringify({ profiles: [], quickLaunchSlots: { 3: "one" } }));
  manager.getState = async () => ({ profiles: [{ id: "one", name: "First" }, { id: "two", name: "Second" }] });
  assert.equal((await manager.loadRegistry()).quickLaunchShortcuts.one, normalizeQuickLaunchShortcut("CommandOrControl+Alt+3", process.platform));
  await manager.setQuickLaunchShortcut("one", "Control+Shift+K");
  await assert.rejects(manager.setQuickLaunchShortcut("two", "Ctrl+Shift+K"), /First/);
  assert.equal((await manager.loadRegistry()).quickLaunchShortcuts.one, "Control+Shift+K");
  await manager.setQuickLaunchShortcut("one", null);
  const reloaded = new ProfileManager(directory);
  assert.equal(Object.keys((await reloaded.loadRegistry()).quickLaunchShortcuts).length, 0);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).quickLaunchSlots, undefined, "cleared legacy slot must not return on restart");
  await assert.rejects(manager.setQuickLaunchShortcut("one", "A"), /组合键/);
  await assert.rejects(manager.setQuickLaunchShortcut("missing", "F8"), /没有找到/);
});
