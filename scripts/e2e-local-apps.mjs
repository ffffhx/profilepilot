import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const cdpPort = await availablePort();
let inspectPort = await availablePort(); while (inspectPort === cdpPort) inspectPort = await availablePort();
let project;
const app = await launchProfilePilotE2e({ name: 'local Electron apps', prepareFixture: async ({ fixtureRoot }) => {
  project = path.join(fixtureRoot, 'Electron 项目 with spaces'); await mkdir(project);
  await writeFile(path.join(project, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(project, 'user-data'))});
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  for (const title of ['本地应用测试窗口', '设置窗口']) {
    const win = new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>'+title+'</title><h1>'+title+'</h1>'));
  }
  console.log('ELECTRON_READY 中文 '+process.env.LOCAL_APP_TEST);
});
`);
} });
let id;
let nativeServer;
try {
  const d = app.driver;
  const assertBackgroundWindows = async () => {
    const { all } = await d.windows();
    assert.ok(all.length > 0);
    assert.ok(all.every(window => !window.visible && !window.focused), 'Background acceptance must never display or focus its main or debugger windows');
  };
  await assertBackgroundWindows();
  const waitForDiagnostic = async text => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await d.evaluate(`window.localApps.logs(${JSON.stringify(id)}).then(text => text.includes(${JSON.stringify(text)}))`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Missing application diagnostic: ${text}`);
  };
  if ((await d.query('button[data-action="dismiss-onboarding"]')).exists) await d.domClick('button[data-action="dismiss-onboarding"]');
  // The new IPC surface must not be available to another workspace.
  assert.match(await d.evaluate(`window.localApps.list().then(()=>"unexpected",error=>error.message)`), /本地应用工作区/);
  await d.domClick('[data-workspace-trigger]'); await d.domClick('[data-workspace="local-apps"]');
  await d.waitFor('.empty-state h2');
  assert.equal((await d.query('[data-workspace-trigger]')).text.trim(), '本地应用');
  const results = path.join(repoRoot, 'test-results', 'local-apps'); await mkdir(results, { recursive: true });
  const screenshot = async name => { await d.screenshot(); await new Promise(resolve => setTimeout(resolve, 250)); await writeFile(path.join(results, name), Buffer.from((await d.screenshot()).pngBase64, 'base64')); };
  await screenshot('empty.png');
  await d.domClick('.app-topbar [data-action="add"]');
  await d.domInput('[name="name"]', '桌面笔记 · 开发版');
  await d.domInput('[name="cwd"]', project);
  await d.domClick('[data-electron-command]');
  assert.match(await d.evaluate('document.querySelector("[name=command]").value'), /\{cdpPort\}/);
  const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  await d.domInput('[name="command"]', `${quote(electronPath)} --remote-debugging-port={cdpPort} --inspect={inspectPort} main.cjs`);
  await d.domInput('[name="cdpPort"]', String(cdpPort));
  await d.domInput('[name="inspectPort"]', String(inspectPort));
  await d.domClick('[data-environment] summary'); await d.domInput('[name="environment"]', 'LOCAL_APP_TEST=connected');
  await screenshot('add-app.png');
  await d.domClick('.app-form [type="submit"]');
  await d.waitFor('.detail-heading h2', state => state.text.includes('桌面笔记'));
  id = await d.evaluate('window.localApps.list().then(apps=>apps[0].id)');
  await d.domClick('[data-action="start"]');
  await d.waitFor('.badge', state => state.text.includes('运行中'), { timeoutMs: 20000 });
  await d.waitFor('.target-row', state => state.count === 3, { timeoutMs: 20000 });
  await waitForDiagnostic('ELECTRON_READY 中文 connected');
  assert.equal((await d.query('[data-action="edit"]')).disabled, true);
  await screenshot('running.png');
  await d.domClick('[data-action="debug"][data-kind="renderer"]');
  await d.waitFor('[data-action="stop"]', state => !state.disabled);
  await d.domClick('[data-action="debug"][data-kind="main"]');
  await waitForDiagnostic('Debugger attached.');
  await assertBackgroundWindows();
  await d.domClick('[data-action="debug"][data-kind="renderer"]');
  await assertBackgroundWindows();
  // Reopen the workspace while its app is still running.
  await d.domClick('[data-workspace-trigger]'); await d.domClick('[data-workspace="agent"]');
  await d.waitFor('#task-app');
  await d.domClick('[data-workspace-trigger]'); await d.domClick('[data-workspace="local-apps"]');
  await d.waitFor('.target-row', state => state.count === 3);
  // An open form must survive periodic connection refreshes.
  await d.domClick('.app-topbar [data-action="add"]');
  await d.domInput('[name="name"]', '未保存的输入');
  await d.domInput('[name="mode"]', 'attach');
  await d.domInput('[name="cdpPort"]', String(cdpPort));
  await new Promise(resolve => setTimeout(resolve, 2700));
  assert.equal(await d.evaluate('document.querySelector("[name=name]").value'), '未保存的输入');
  await d.domClick('.app-form [type="submit"]');
  await d.waitFor('.form-error', state => state.text.includes('已分配'));
  await d.domClick('[data-cancel]');
  await d.domClick('[data-action="restart"]');
  await d.waitFor('.target-row', state => state.count === 3, { timeoutMs: 20000 });
  await d.waitFor('[data-action="stop"]', state => !state.disabled);
  await d.domClick('[data-action="stop"]');
  await d.waitFor('.badge', state => state.text.includes('已停止'), { timeoutMs: 20000 });
  await d.domClick('[data-action="edit"]');
  await d.domInput('[name="name"]', '已编辑的项目'); await d.domClick('.app-form [type="submit"]');
  await d.waitFor('.detail-heading h2', state => state.text === '已编辑的项目');
  await d.domClick('[data-action="remove"]'); await d.waitFor('.task-confirm');
  await d.domClick('[data-confirm-action]'); await d.waitFor('.empty-state h2');
  id = undefined;
  nativeServer = net.createServer(socket => socket.end());
  await new Promise(resolve => nativeServer.listen(0, '127.0.0.1', resolve));
  await d.domClick('.app-topbar [data-action="add"]');
  await d.domInput('[name="name"]', '后台服务测试'); await d.domInput('[name="mode"]', 'service');
  await d.domInput('[name="cwd"]', project); await d.domInput('[name="command"]', 'exit 9');
  await d.domInput('[name="servicePort"]', String(nativeServer.address().port));
  await d.domInput('[name="serviceProcess"]', process.execPath);
  await d.domClick('.app-form [type="submit"]');
  await d.waitFor('.badge', state => state.text.includes('运行中'));
  assert.equal((await d.query('[data-action="stop"]')).exists, false);
  assert.equal((await d.query('[data-action="debug"]')).exists, false);
  await screenshot('native-service.png');
  await d.domClick('[data-action="remove"]'); await d.domClick('[data-confirm-action]');
  await d.waitFor('.empty-state h2'); assert.equal(nativeServer.listening, true);
  console.log('PASS local apps: workspace navigation, IPC origin, real Electron multi-window and main debugging, launch/restart/stop, native service configuration, listener status, and removal without stopping the service.');
  await assertBackgroundWindows();
} finally {
  if (nativeServer) await new Promise(resolve => nativeServer.close(resolve));
  if (id) {
    await app.driver.evaluate(`location.href='./local-apps.html'`).catch(() => {});
    await app.driver.waitFor('.app-topbar').catch(() => {});
    await app.driver.evaluate(`window.localApps.stop(${JSON.stringify(id)})`).catch(() => {});
  }
  await app.stop({ removeFixture: false });
  assert.ok(path.resolve(app.fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  // Windows IME helpers can retain their own logs in the fixture HOME after
  // Electron exits. Don't block completed checks on recursive retry backoffs.
  await rm(app.fixtureRoot, { recursive: true, force: true, maxRetries: 0 }).catch(error => {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
}
