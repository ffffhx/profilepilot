import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const app = await launchProfilePilotE2e({
  prepareFixture: async ({ dataDir }) => writeFile(path.join(dataDir, "profiles.json"), JSON.stringify({
    profiles: [{ id: "rename-fixture", name: "Before", dirName: "rename-fixture", createdAt: "2026-09-22T00:00:00.000Z", lastLaunchedAt: null, fixedCdpPort: 9229 }]
  }))
});
try {
  const { driver } = app;
  await driver.waitFor('[data-action="toggle-profile-menu"][data-id="isolated:rename-fixture"]');
  await driver.domClick('[data-action="toggle-profile-menu"][data-id="isolated:rename-fixture"]');
  await driver.domClick('[data-action="rename-profile"]');
  await driver.domInput('#profile-rename', 'After 一次保存');
  const savingValue = await driver.evaluate(`(() => {
    document.querySelector('[data-rename-form] button[type="submit"]').click();
    return document.querySelector('#profile-rename')?.value;
  })()`);
  assert.equal(savingValue, 'After 一次保存', 'busy rendering must not revert the name to its old value');
  await driver.waitFor('[data-rename-form]', value => !value.exists);
  await driver.waitFor('[data-profile-row][data-id="isolated:rename-fixture"]', value => value.text?.includes('After 一次保存'));
  const registry = JSON.parse(await readFile(path.join(app.dataDir, 'profiles.json'), 'utf8'));
  assert.equal(registry.profiles[0].name, 'After 一次保存');
  console.log('PASS: one submit persists the name and closes the modal');
} finally {
  await app.stop();
}
