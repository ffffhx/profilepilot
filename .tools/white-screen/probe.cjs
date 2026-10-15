const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'profilepilot-white-'));
  env.WHITE_FIXTURE = fixture;
  let holder;
  if (process.argv.includes('--shared-cache')) holder = require('node:child_process').spawn(electron, [__filename, '--holder'], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true, env, stdio: 'inherit'
  });
  setTimeout(() => {
  const child = require('node:child_process').spawn(electron, [__filename], {
    cwd: path.resolve(__dirname, '../..'), windowsHide: true,
    env, stdio: 'inherit'
  });
  child.on('exit', code => { holder?.kill(); process.exit(code ?? 1); });
  }, holder ? 2000 : 0);
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const root = path.resolve(__dirname, '../..');
  const fixture = process.env.WHITE_FIXTURE;
  app.setPath('userData', fixture);
  if (process.argv.includes('--holder')) {
    app.disableHardwareAcceleration();
    app.whenReady().then(() => { console.log('HOLDER_READY', electron.safeStorage.isEncryptionAvailable()); });
    setTimeout(() => app.exit(0), 25000);
    return;
  }
  const timer = setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 20000);
  app.whenReady().then(async () => {
    for (const channel of ['phones:request', 'mobile:request']) ipcMain.handle(channel, () => ({devices: [], adbAvailable: true}));
    const win = new BrowserWindow({show: false, width: 1120, height: 760, webPreferences: {
      preload: path.join(root, 'dist/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false
    }});
    win.webContents.on('console-message', event => console.log('CONSOLE', event.level, event.message));
    win.webContents.on('preload-error', (_event, _file, error) => console.log('PRELOAD', String(error)));
    win.webContents.on('did-fail-load', (_event, code, desc, _url, main) => console.log('LOADFAILED', code, desc, main));
    require(path.join(root, 'dist/main/workspace-shell.js')).protectWorkspaceShell(win);
    await win.loadFile(path.join(root, 'public/workspace.html'));
    await new Promise(resolve => setTimeout(resolve, 2500));
    console.log('DOM', await win.webContents.executeJavaScript('JSON.stringify({title:document.title, body:document.body.innerText, html:document.documentElement.outerHTML.slice(0,1600), bridge:!!window.profileManager, host:!!window.workspaceHost, frames:document.querySelectorAll("iframe").length})'));
    fs.writeFileSync(path.join(fixture, 'workspace.png'), (await win.webContents.capturePage()).toPNG());
    console.log('ARTIFACT', fixture);
    clearTimeout(timer);
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
