const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProfileManager } = require("../dist/main/profile-manager.js");
const { findConfiguredAgentBrowserProfileByPortSync } = require("../dist/main/agent-browser-lease.js");

test("automation override survives registry reloads and is visible to CLI auto-start without affecting other Profiles", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, "profiles.json");
  const profiles = ["one", "two"].map((id, i) => ({ id, name: id, dirName: id, createdAt: new Date().toISOString(), lastLaunchedAt: null, fixedCdpPort: 19223 + i, agentAccessDisabled: i === 1 }));
  fs.writeFileSync(registryPath, JSON.stringify({ profiles }));
  const manager = Object.assign(Object.create(ProfileManager.prototype), { dataDir: root, profilesDir: path.join(root, "profiles"), registryPath });
  await manager.configureProfileBrowser("isolated:one", true);
  // A subsequent unrelated write normalizes/reloads the registry too.
  await manager.renameProfile("isolated:one", "Renamed");
  const reloaded = await manager.loadRegistry();
  assert.equal(reloaded.profiles[0].hideAutomation, true);
  assert.equal(reloaded.profiles[1].hideAutomation, undefined);
  assert.equal(reloaded.profiles[1].agentAccessDisabled, true);
  const configured = findConfiguredAgentBrowserProfileByPortSync(19223, { CPM_DATA_DIR: root }, root);
  assert.equal(configured.profile.hideAutomation, true);
  assert.equal(configured.profileName, "Renamed");
  assert.equal(configured.userDataDir, path.join(root, "profiles", "one"));
  const before = fs.readFileSync(registryPath, "utf8");
  await assert.rejects(() => manager.configureProfileBrowser("isolated:one", "false"), { code: "PROFILE_BROWSER_SETTINGS_INVALID" });
  await assert.rejects(() => manager.configureProfileBrowser("native:Default", true));
  assert.equal(fs.readFileSync(registryPath, "utf8"), before);
  await manager.configureProfileBrowser("isolated:one", false);
  assert.equal((await manager.loadRegistry()).profiles[0].hideAutomation, undefined);
  assert.equal(findConfiguredAgentBrowserProfileByPortSync(19223, { CPM_DATA_DIR: root }, root).profile.hideAutomation, undefined);
});
