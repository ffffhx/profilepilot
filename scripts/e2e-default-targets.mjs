import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const execute = promisify(execFile);
const app = await launchProfilePilotE2e({ readySelector: '[data-profile-row]', prepareFixture: async ({ dataDir }) => {
  await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: ['work', 'personal'].map(id => ({
    id, name: id === 'work' ? '工作浏览器' : '个人浏览器', dirName: id, createdAt: '2026-11-08T00:00:00.000Z', lastLaunchedAt: null
  })) }));
} });
try {
  const d = app.driver;
  const cli = async () => JSON.parse((await execute(process.execPath, ['dist/main/profilepilot-cli.cjs', 'browser', 'default', '--json'], { cwd: repoRoot, env: { ...process.env, CPM_DATA_DIR: app.dataDir }, windowsHide: true })).stdout).result;
  await d.waitFor('[data-action="toggle-profile-menu"][data-id="isolated:work"]');
  await d.domClick('[data-action="toggle-profile-menu"][data-id="isolated:work"]');
  await d.domClick('[data-action="set-default-profile"][data-id="isolated:work"]');
  await d.waitFor('[data-id="isolated:work"] .agent-default-badge');
  assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'default-profile.json'), 'utf8')).id, 'isolated:work');
  assert.equal((await cli()).saved.id, 'isolated:work');
  await d.domClick('[data-action="toggle-profile-menu"][data-id="isolated:personal"]');
  await d.domClick('[data-action="set-default-profile"][data-id="isolated:personal"]');
  await d.waitFor('[data-id="isolated:personal"] .agent-default-badge');
  assert.equal((await d.query('.agent-default-badge')).count, 1);
  const output = path.join(repoRoot, 'artifacts', 'default-targets'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.waitFor('[data-action="clear-default-profile"]', item => !item.disabled);
  await d.domClick('[data-action="clear-default-profile"]');
  await d.waitFor('.agent-default-badge', item => !item.exists);
  assert.equal((await cli()).saved, null);
  await d.evaluate(`window.workspaceHost.navigate('./tools.html'); true`, { target: 'shell' });
  await d.waitFor('.tools-workspace');
  assert.equal((await d.query('[data-action="open-control-preferences"], #tools-control-preferences')).count, 0);
  await writeFile(path.join(output, 'tools.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  console.log('PASS: default Profile set/switch/clear, shared CLI settings, and simplified tools page');
} finally { await app.stop(); }

const missing = await launchProfilePilotE2e({ readySelector: '[data-profile-row]', prepareFixture: async ({ dataDir }) => {
  await writeFile(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: [{ id: 'other', name: '其他浏览器', dirName: 'other', createdAt: '2026-11-08T00:00:00.000Z', lastLaunchedAt: null }] }));
  await writeFile(path.join(dataDir, 'default-profile.json'), JSON.stringify({ id: 'isolated:removed', name: '已移除的默认浏览器' }));
} });
try {
  await missing.driver.waitFor('.default-target-note', item => item.text?.includes('当前不可用'));
  assert.equal((await missing.driver.query('[data-profile-row].selected')).count, 0, 'a missing default cannot select the first other Profile');
  await missing.driver.waitFor('[data-action="clear-default-profile"]', item => !item.disabled);
  await missing.driver.domClick('[data-action="clear-default-profile"]');
  await missing.driver.waitFor('.default-target-note', item => item.text?.includes('设置默认 Profile'));
  console.log('PASS: missing default remains explicit until the user clears it');
} finally { await missing.stop(); }
