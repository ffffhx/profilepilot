// Owns an isolated Herdr instance only. Production GPUI registration/bridge paints the badge.
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { registerGpui } = require('../../dist/main/gpui/ipc');
const { WindowsInputRuntime } = require('../../dist/main/desktop/input-runtime');
const { GpuiMcpClient, toolData } = require('../../dist/main/gpui/mcp');

const root = path.resolve(__dirname, '../..');
const home = process.env.PROFILEPILOT_GPUI_PREVIEW_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ppgpui-'));
const herdr = process.env.PROFILEPILOT_GPUI_TEST_APP || path.join(process.env.LOCALAPPDATA, 'Programs/herdr-app/herdr-app.exe');
const appHome = path.join(home, 'app');
fs.mkdirSync(appHome, { recursive: true });
app.setPath('userData', path.join(home, 'electron'));
app.on('window-all-closed', () => {});
let targetProcess, service, runtime, inspection, closing = false;
const cases = [], resultFile = path.join(home, 'result.json');
const env = { ...process.env, HERDR_APP_HOME: appHome, HERDR_GPUI_DEBUG: '1', HC_SESSION: 'ppgpui-' + process.pid };
const consentPreview = process.env.PROFILEPILOT_GPUI_CONSENT_PREVIEW === '1';
const save = extra => fs.writeFileSync(resultFile, JSON.stringify({ pid: process.pid, platform: process.platform,
  targetPid: targetProcess?.pid, appHome, physicalInputInjected: false, cases, ...extra }, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Fixture condition timed out'); await delay(100); }
}
async function close() {
  if (closing) return; closing = true;
  service?.close(); inspection?.close(); await runtime?.dispose();
  // The child handle was created here; never signal a discovered or user-owned process.
  targetProcess?.kill(); app.quit();
}
const deadline = setTimeout(() => { save({ ok: false, error: 'Native preview startup deadline exceeded' }); void close(); }, 60000);

app.whenReady().then(async () => {
  // This is the requested visible target preview, not a helper/console window.
  targetProcess = spawn(herdr, [], { env, cwd: home, windowsHide: false, stdio: 'ignore' });
  targetProcess.once('error', error => { save({ ok: false, error: error.message }); void close(); });
  runtime = new WindowsInputRuntime();
  service = registerGpui({ directory: path.join(home, 'sessions'), guardFactory: runtime.browserGuard,
    openPanel: async () => { throw new Error('The isolated preview has no management window.'); } });
  let target;
  await until(async () => { target = (await service.apps()).apps.find(item => item.pid === targetProcess.pid); return !!target; });
  const execute = (method, extra = {}) => service.execute({ action: 'gpui', method, session: 'embedded-preview', ...extra });
  await execute('claim', { target: target.target_id });
  assert.equal(service.status().sessions[0].indicator, 'embedded', JSON.stringify(service.status()));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  cases.push('production claim creates no Electron popup');
  inspection = new GpuiMcpClient(path.join(root, 'dist/native/gpui/gpui-mcp.exe'));
  await inspection.call('select_app', { target_id: target.target_id });
  const annotations = async () => toolData(await inspection.call('list_annotations'));
  const activeAnnotations = await annotations();
  fs.writeFileSync(path.join(home, 'annotations-active.json'), JSON.stringify(activeAnnotations, null, 2));
  assert.match(JSON.stringify(activeAnnotations), /ProfilePilot.*控制中/);
  const tree = await execute('snapshot');
  fs.writeFileSync(path.join(home, 'tree.json'), JSON.stringify(tree.tree, null, 2));
  const screenshot = path.join(home, 'active.png');
  execFileSync(herdr, ['shot', screenshot], { env, windowsHide: true, timeout: 10000 });
  cases.push('target application paints the active indicator in its own frame');

  let current = service.status().sessions[0];
  await service.control('takeover', current.name, current.revision);
  await until(async () => /已暂停/.test(JSON.stringify(await annotations())));
  await assert.rejects(execute('resume'), { code: 'GPUI_PAUSED' });
  cases.push('pause updates the embedded label and CLI cannot resume it');
  if (consentPreview) {
    // Lifecycle testing is scoped to the child created by this fixture.
    assert.equal(target.pid, targetProcess.pid);
    const pauseId = service.status().sessions[0].pauseId;
    await execute('return-control', { pauseId });
    assert.equal(service.status().sessions[0].inputGuard, 'active');
    await execute('snapshot');
    await assert.rejects(execute('return-control', { pauseId }), { code: 'GPUI_STALE_CONTROL' });
    current = service.status().sessions[0];
    await service.control('takeover', current.name, current.revision);
    await assert.rejects(execute('return-control', { pauseId }), { code: 'GPUI_STALE_CONTROL' });
    cases.push('explicit CLI return restores the native guard once; replay and later takeover reject the old pause ID');
  }
  current = service.status().sessions[0];
  await service.control('stop', current.name, current.revision);
  assert.doesNotMatch(JSON.stringify(await annotations()), /profilepilot-control-/);
  cases.push('stop removes only the owned indicator');

  // A new owned acceptance session for the visible preview. Never restores a user task.
  await execute('claim', { target: target.target_id });
  await delay(250);
  execFileSync(herdr, ['shot', screenshot], { env, windowsHide: true, timeout: 10000 });
  let consentScreenshot;
  if (consentPreview) {
    const area = screen.getPrimaryDisplay().workArea;
    const preview = new BrowserWindow({ title: 'ProfilePilot · 聊天授权验收预览', width: Math.min(1180, area.width), height: Math.min(850, area.height), x: area.x, y: area.y,
      show: false, webPreferences: { preload: path.join(root, 'dist/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    // The production page/IPC are used, with an isolated service and test target.
    await preview.loadFile(path.join(root, 'public/gpui.html'));
    await until(() => preview.webContents.executeJavaScript("!!document.querySelector('#gpui-chat-return')?.textContent.includes('通过 CLI 恢复当前会话')"));
    await until(() => preview.webContents.executeJavaScript("!document.querySelector('#gpui-apps')?.textContent.includes('正在发现')"));
    preview.show();
    await delay(300);
    await preview.webContents.executeJavaScript("document.querySelector('#gpui-chat-return').scrollIntoView({block:'center',behavior:'instant'})");
    await delay(200);
    consentScreenshot = path.join(home, 'consent-preview.png');
    fs.writeFileSync(consentScreenshot, (await preview.webContents.capturePage()).toPNG());
    cases.push('production GPUI page renders chat authorization status in an independent visible preview');
  }
  clearTimeout(deadline);
  save({ ok: true, preview: true, screenshot, consentScreenshot, target, state: service.status() });
  const timer = setInterval(() => { if (fs.existsSync(path.join(home, 'close'))) { clearInterval(timer); void close(); } }, 1000);
  setTimeout(() => void close(), 30 * 60 * 1000).unref();
}).catch(error => { save({ ok: false, error: error.stack, state: service?.status() }); void close(); });
