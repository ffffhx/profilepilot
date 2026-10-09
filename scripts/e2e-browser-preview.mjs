import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
import { open } from './e2e/lib/native-extension-client.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'pp-preview-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const output = path.join(repoRoot, 'test-results/browser-preview');
let app, client, frames = 0, fail = false, stop = false;
try {
  await mkdir(path.join(root, 'Default'), { recursive: true });
  await writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Daily Chrome', gaia_picture_file_name: 'Google Profile Picture.png' } } } }));
  await writeFile(path.join(root, 'Default/Google Profile Picture.png'), Buffer.from(png, 'base64'));
  await mkdir(output, { recursive: true });
  app = await launchProfilePilotE2e({ name: 'browser live preview', env: { CPM_NATIVE_CHROME_USER_DATA_DIR: root } });
  const d = app.driver;
  const capture = async name => {
    await d.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.join(output, `${name}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  };
  assert.equal(await d.evaluate(`document.querySelectorAll('[data-action="open-agent-browser-setup"]').length`), 1);
  assert.equal(await d.evaluate(`!!document.querySelector('[data-action="new-profile"],.browser-workspace-footer [data-action="open-global-instructions"]')`), false);
  assert.equal(await d.evaluate(`!!document.querySelector('[data-workspace-search]')`, { target: 'shell' }), false);
  await d.waitFor('.profile-avatar img');
  assert.equal(await d.evaluate(`document.querySelector('.profile-avatar img').src`), `data:image/png;base64,${png}`);
  assert.ok((await d.query('.profiles-table thead')).text.includes('端口'));
  assert.ok(await d.evaluate(`document.querySelector('.profiles-table th:nth-child(5)').getBoundingClientRect().width > 20`), 'port column is visible');
  assert.ok(await d.evaluate(`(() => { const cell=document.querySelector('.profile-name-cell');return cell.querySelector('.profile-pick').getBoundingClientRect().left - cell.querySelector('.profile-avatar').getBoundingClientRect().right >= 6; })()`), 'avatar and name have a consistent gap');
  const pair = await d.evaluate(`window.tasks.pairNativeBrowser('native:Default')`);
  const config = JSON.parse(Buffer.from(pair.code.slice(4), 'base64url').toString());
  client = await open(config.port); client.send({ type: 'hello', ...config });
  assert.equal((await client.next()).type, 'welcome');
  client.send({ type: 'state', state: { ownership: 'user', extensionVersion: '0.2.5', capabilities: ['liveView', 'tabs', 'cdp', 'cdpSessions', 'history', 'downloads', 'sidePanel'], taskTabs: true } });
  void (async () => {
    while (!stop) {
      const command = await client.next();
      if (!command.id) continue;
      if (command.method === 'liveView') {
        frames++;
        client.send({ id: command.id, ...(fail ? { error: 'Fixture preview disconnected' } : { result: { port: 0, capturedAt: new Date().toISOString(), tabCount: 1, tabs: [], primaryTitle: `Preview frame ${frames}`, primaryUrl: 'https://fixture.example/', screenshot: `data:image/png;base64,${png}`, screenshotError: null, error: null } }) });
      } else client.send({ id: command.id, result: {} });
    }
  })();
  // Background Electron fixtures do not paint an OS window. Keep document
  // visibility active so this test can exercise the real workspace lifecycle.
  await d.evaluate(`Object.defineProperty(document, 'hidden', { configurable:true, get:()=>false }); true`);
  await d.waitFor('.browser-preview-screen img', state => state.exists, { timeoutMs: 25000 });
  await d.domClick('.browser-preview-screen');
  await d.waitFor('.live-zoom-modal');
  await d.waitFor('.live-zoom-frame img', state => state.exists);
  const first = frames;
  await d.waitFor('#live-zoom-title', state => state.text !== `Preview frame ${first}`, { timeoutMs: 10000 });
  await capture('zoom');
  await d.domClick('.live-zoom-modal [data-action="close-modal"]');
  await d.waitFor('.live-zoom-modal', state => !state.exists);
  const isolated = await d.evaluate(`window.profileManager.createProfile('Preview stopped').then(s=>s.profiles.find(p=>p.name==='Preview stopped'))`);
  await d.waitFor(`[data-profile-row][data-id="${isolated.id}"]`, state => state.exists, { timeoutMs: 15000 });
  await d.domClick(`[data-profile-row][data-id="${isolated.id}"]`);
  await d.waitFor('.browser-preview-empty', state => state.text.includes('启动浏览器'));
  assert.equal(await d.evaluate(`!!document.querySelector('.browser-preview-screen img')`), false, 'no old Profile frame leaks into the selection');
  await d.domClick('[data-profile-row][data-id="native:Default"]');
  await d.waitFor('.browser-preview-screen img');
  await d.domClick('.workspace-link[data-workspace="tools"]');
  await new Promise(resolve => setTimeout(resolve, 500));
  const hiddenFrames = frames;
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(frames, hiddenFrames, 'hidden Browser workspace stops capturing');
  await d.domClick('.workspace-link[data-workspace="browser"]');
  fail = true;
  await d.waitFor('.browser-preview-empty', state => state.text.includes('Fixture preview disconnected'), { timeoutMs: 10000 });
  assert.equal(await d.evaluate(`!!document.querySelector('.browser-preview-screen img')`), false, 'an error never masquerades as a current frame');
  fail = false;
  await d.waitFor('.browser-preview-screen img', state => state.exists, { timeoutMs: 10000 });
  await capture('browser');
  await d.domClick('[data-action="open-agent-browser-setup"]');
  await d.waitFor('.clone-pool-modal');
  assert.equal(await d.evaluate(`!!document.querySelector('[data-action="recycle-clones"],[data-clone-pool-recycle-days]')`), false);
  console.log('PASS real preview IPC, local avatar, single-click zoom, frame refresh, selection, hidden-tab pause, error recovery and simplified actions');
} finally {
  stop = true; client?.close(); await app?.stop();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
}
