// Isolated Electron browser-process entry. Never load the ProfilePilot App main.
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const electron = require('electron');
const configFile = process.argv[2];
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const { app } = electron;
let exiting = false;
async function run() {
  if (config.runtime.kind !== 'electron' || process.versions.electron !== config.runtime.electronVersion ||
    Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')) throw new Error('Expected an isolated real Electron browser process');
  // Set all writable runtime paths synchronously before the first await/ready.
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const relative = path.relative(path.resolve(config.home), path.resolve(config.runtime.directories[key]));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Runtime path escaped the owned probe root');
    fs.mkdirSync(config.runtime.directories[key], { recursive: true });
    app.setPath(key, config.runtime.directories[key]);
  }
  const protocol = await import('./desktop-parent-death-protocol.mjs');
  const { assertDesktopAcceptanceWindow } = await import('./desktop-acceptance-window.mjs');
  await assertDesktopAcceptanceWindow();
  await protocol.verifyArtifacts(config.artifacts);
  await app.whenReady();
  const evidence = () => ({ kind: 'electron', processType: process.type,
    versions: { electron: process.versions.electron, node: process.versions.node, uv: process.versions.uv },
    runAsNodePresent: Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),
    windowCount: electron.BrowserWindow.getAllWindows().length, webContentsCount: electron.webContents.getAllWebContents().length,
    directories: Object.fromEntries(['userData', 'sessionData', 'logs', 'crashDumps'].map(key => [key, app.getPath(key)])) });
  protocol.verifyParentRuntime(evidence(), config.runtime);
  const parent = await import(pathToFileURL(path.join(__dirname, 'desktop-parent-death-parent.mjs')).href);
  await parent.runIsolatedDesktopParent(configFile, evidence);
  exiting = true; app.exit(process.exitCode || 0);
}
run().catch(error => {
  try { fs.writeFileSync(config.parentEntryError, JSON.stringify({ nonce: config.nonce, code: error.code || 'ELECTRON_PARENT_FAILED', message: error.message })); }
  finally { if (!exiting) app.exit(1); }
});
