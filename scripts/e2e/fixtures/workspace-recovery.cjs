// Isolated Electron fixture. No browser Profiles, phone services or real user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fixture = process.env.WORKSPACE_RECOVERY_FIXTURE;
if (!fixture) throw new Error('Run through scripts/e2e-workspace-recovery.mjs');
const root = path.resolve(__dirname, '../../..');
app.setPath('userData', path.join(fixture, 'electron'));
const { initializeDiagnosticLogging } = require('../../../dist/main/diagnostic-log');
const { installWorkspaceDiagnostics } = require('../../../dist/main/workspace-diagnostics');
const { protectWorkspaceShell } = require('../../../dist/main/workspace-shell');
const { IPC_CHANNELS } = require('../../../dist/shared/ipc');
initializeDiagnosticLogging({ env: { PROFILEPILOT_LOG_ROOT: path.join(fixture, 'logs') }, captureConsole: false });
let mode = 'normal', reloads = 0;
const reports = [];
const brokenScript = path.join(fixture, 'broken-shell.js');
fs.writeFileSync(brokenScript, 'throw new Error("Workspace recovery fixture failure");');
const timer = setTimeout(() => { console.error('workspace recovery fixture timed out'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.endsWith('/dist/browser/workspace-shell.js')) return callback({});
    callback(mode === 'missing' ? { cancel: true } : mode === 'broken' ? { redirectURL: pathToFileURL(brokenScript).href } : {});
  });
  // Only the outer shell is tested; child workspace services remain isolated stubs.
  ipcMain.handle('phones:request', () => ({ devices: [], adbAvailable: true }));
  ipcMain.handle('browser-connection:request', () => ({ profiles: [], connections: [] }));
  ipcMain.handle('profiles:get-initial-state', () => { throw new Error('Fixture has no Profiles'); });
  const window = new BrowserWindow({ show: false, width: 1120, height: 760, webPreferences: {
    preload: path.join(root, 'dist/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false
  }});
  protectWorkspaceShell(window);
  installWorkspaceDiagnostics(window);
  ipcMain.on(IPC_CHANNELS.workspaceStartupFailure, (_, reason) => reports.push(reason));
  ipcMain.on(IPC_CHANNELS.reloadWorkspace, () => { reloads++; mode = 'normal'; window.webContents.reloadIgnoringCache(); });
  const read = expression => window.webContents.executeJavaScript(expression);
  async function until(predicate) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await read(predicate)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Condition not met: ${predicate}`);
  }
  for (const scenario of ['missing', 'broken', 'normal']) {
    mode = scenario;
    await window.loadFile(path.join(root, 'public/workspace.html'));
    if (scenario !== 'normal') {
      await until('!document.getElementById("workspace-startup-retry").hidden');
      assert.equal(await read('document.getElementById("workspace-startup").hidden'), false);
      assert.match(await read('document.getElementById("workspace-startup-status").textContent'), /加载未完成/);
      await read('document.getElementById("workspace-startup-retry").click(); true');
    }
    await until('document.documentElement.dataset.workspaceShellReady === "true"');
    assert.equal(await read('document.getElementById("workspace-startup").hidden'), true);
    assert.equal(await read('Boolean(document.getElementById("workspace-rail"))'), true);
    console.log(`PASS workspace ${scenario}${scenario === 'normal' ? '' : ' -> user retry -> ready'}`);
  }
  assert.equal(reloads, 2);
  assert.ok(reports.includes('script-load'));
  assert.ok(reports.includes('script-error'));
  const log = fs.readFileSync(path.join(fixture, 'logs/profilepilot.log.jsonl'), 'utf8');
  assert.match(log, /Workspace recovery fixture failure/);
  fs.writeFileSync(path.join(fixture, 'recovered.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timer);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
