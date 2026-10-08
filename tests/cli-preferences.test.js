const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CliPreferencesStore, workspaceHistoryKey, containsSecret } = require('./cli-test-build.cjs').loadCli('src/main/cli/preferences.ts');

test("settings/history persist atomically and stay scoped to the workspace", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-pref-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new CliPreferencesStore({ homeDir: root, cwd: path.join(root, "a") });
  const b = new CliPreferencesStore({ homeDir: root, cwd: path.join(root, "b") });
  assert.equal((await a.loadSettings()).theme, "auto");
  await a.saveSettings({ theme: "dark", defaultProfile: "Browser", model: "model-a", apiKey: "must-not-store" });
  assert.equal((await b.loadSettings()).defaultProfile, "Browser");
  assert.equal((await fs.readFile(a.settingsPath, "utf8")).includes("must-not-store"), false);
  await Promise.all([a.appendHistory("first"), a.appendHistory("第二条"), a.appendHistory("last")]);
  await a.appendHistory("last");
  assert.deepEqual(await a.readHistory(), ["first", "第二条", "last"]); assert.deepEqual(await b.readHistory(), []);
  const again = new CliPreferencesStore({ homeDir: root, cwd: path.join(root, "a") });
  assert.deepEqual(await again.readHistory(), ["first", "第二条", "last"]);
  const files = await fs.readdir(path.dirname(a.historyPath)); assert.equal(files.some(file => file.endsWith(".tmp")), false);
  assert.equal(workspaceHistoryKey("C:\\Work\\Project", "win32"), workspaceHistoryKey("c:/work/project", "win32"));
  assert.notEqual(workspaceHistoryKey("/Work/Project", "darwin"), workspaceHistoryKey("/work/project", "darwin"));
});

test("secret entries and disabled history/drafts are never persisted", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-pref-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CliPreferencesStore({ homeDir: root, cwd: root });
  for (const secret of ["password=hunter2", "API_KEY: abc123", "sk-ant-1234567890abcdefghijklmnop", "Authorization: Bearer abcdefghijklmnop", "https://user:password@example.test", "/token xyz"]) {
    assert.equal(containsSecret(secret), true, secret); await store.appendHistory(secret);
  }
  assert.deepEqual(await store.readHistory(), []);
  await store.saveDraft("optional draft"); assert.equal(await store.loadDraft(), "");
  await store.saveSettings({ persistDraft: true }); await store.saveDraft("optional draft"); assert.equal(await store.loadDraft(), "optional draft");
  await store.saveDraft("secret=unsafe"); assert.equal(await store.loadDraft(), "");
  await store.saveSettings({ historyEnabled: false }); await store.appendHistory("disabled"); assert.deepEqual(await store.readHistory(), []);
  await fs.writeFile(store.settingsPath, "bad json"); assert.equal((await store.loadSettings()).theme, "auto");
});

test("mono persists alongside existing auto, dark and light preferences", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-pref-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CliPreferencesStore({ homeDir: root, cwd: root });
  for (const theme of ["mono", "auto", "light", "dark"]) {
    assert.equal((await store.saveSettings({ theme })).theme, theme);
    assert.equal((await new CliPreferencesStore({ homeDir: root, cwd: root }).loadSettings()).theme, theme);
  }
  assert.equal((await store.saveSettings({ theme: "unknown" })).theme, "auto");
});
