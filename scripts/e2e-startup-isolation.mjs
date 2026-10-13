import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e } from './e2e/lib/electron-driver.mjs';

const corrupt = '{task history interrupted before JSON completed';
const app = await launchProfilePilotE2e({
  name: 'desktop feature isolation',
  prepareFixture: async ({ dataDir }) => {
    const root = path.join(dataDir, 'browser-tasks');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'tasks.json'), corrupt);
  }
});
try {
  const d = app.driver;
  await d.waitFor('h1');
  const snapshot = await d.evaluate('window.browserConnection.snapshot()');
  assert.deepEqual(snapshot, { nativeBrowsers: [], nativeInstallations: [] });
  assert.equal('tasks' in snapshot, false);
  await assert.rejects(d.evaluate('window.tasks.snapshot()'), /任务服务初始化失败/);
  await d.domClick('.workspace-link[data-workspace="tools"]');
  await d.waitFor('h1', state => state.text === '配套工具');
  assert.equal((await d.evaluate('window.browserConnection.snapshot()')).nativeBrowsers.length, 0);
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('[role="alert"]', state => state.text.includes('任务服务初始化失败'));
  await d.domClick('.workspace-link[data-workspace="browser"]');
  await d.waitFor('h1');
  assert.ok((await d.evaluate('window.profileManager.getState()')).profiles);
  assert.equal(await readFile(path.join(app.dataDir, 'browser-tasks/tasks.json'), 'utf8'), corrupt);
  console.log('PASS corrupt task history stays intact; desktop/browser/tools remain available and Agent reports the isolated failure.');
} finally { await app.stop(); }
