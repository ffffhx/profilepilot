// Owned Electron surface only. The capture probe is a separate Medium child.
// This fixture never changes target opacity, affinity, focus or z-order.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { app, BrowserWindow, screen } = require('electron');
let fatal = false;
function fail(error) {
  if (fatal) return; fatal = true;
  try { const candidate = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); fs.writeFileSync(path.join(candidate.home, 'failure.json'), JSON.stringify({ nonce: candidate.nonce, pid: process.pid, error: String(error?.message || error) })); } catch {}
  app.exit(2); // Avoid Electron's uncaught-exception dialog on startup failure.
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^[a-f0-9]{32}$/.test(config.nonce) || !path.isAbsolute(config.home)) throw new Error('Invalid owned config');
const file = name => path.join(config.home, name);
function gate() {
  if (!fs.existsSync(config.gate)) return;
  const value = JSON.parse(fs.readFileSync(config.gate, 'utf8'));
  if (!Number.isFinite(Date.parse(value.notBefore))) throw new Error('Invalid acceptance gate');
  if (Date.now() < Date.parse(value.notBefore)) throw new Error('DESKTOP_ACCEPTANCE_DEFERRED');
}
function write(name, value) { const dest = file(name); fs.writeFileSync(dest + '.tmp', JSON.stringify(value)); fs.renameSync(dest + '.tmp', dest); }
gate();
app.setPath('userData', file('user-data'));
const identity = JSON.parse(execFileSync(config.identity, ['--inspect', String(process.pid)], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
if (!identity.ok || identity.pid !== process.pid || identity.integrityRid !== 8192 || identity.elevated || identity.uiAccess) throw new Error('Owned Medium token required');
write('boot.json', { nonce: config.nonce, pid: process.pid, identity, versions: process.versions });
const lifecycle = [];
const accessibility = { requestedForPpilotFocus: config.ppilotFocus === true, forcedForFixture: false,
  supportEnabledInitially: null, supportEnabled: null };
function mark(event, details) {
  lifecycle.push({ sequence: lifecycle.length + 1, event, at: Date.now(), ...details });
  write('lifecycle.json', { nonce: config.nonce, pid: process.pid, accessibility, lifecycle });
}
app.on('accessibility-support-changed', (_event, enabled) => {
  accessibility.supportEnabled = enabled;
  mark('accessibility-support-changed', { enabled });
});
let target, cover, lastId, closing = false, activeProbe, ready = false;
const probes = [];
const title = 'ProfilePilot screen region ' + config.nonce;
const html = '<!doctype html><meta charset="utf-8"><title>' + title + '</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(243,240,220)}.m{position:absolute;width:48px;height:48px}#green{left:40px;top:55px;background:rgb(33,160,80)}#blue{left:290px;top:140px;background:rgb(34,119,187)}#red{left:540px;top:280px;background:rgb(215,50,70)}</style><div class="m" id="green"></div><div class="m" id="blue"></div><div class="m" id="red"></div><button id="dummy-focus" aria-label="ProfilePilot focus ' + config.nonce + '" style="position:absolute;left:20px;bottom:12px">Owned focus target</button>';
function hwnd(window) { const value = window.getNativeWindowHandle(); return (value.length === 8 ? value.readBigUInt64LE() : BigInt(value.readUInt32LE())).toString(); }
async function state() {
  if (!target || target.isDestroyed()) return { nonce: config.nonce, pid: process.pid, closed: true };
  const page = await target.webContents.executeJavaScript(`({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,contentRevision:0,dummyHasDocumentFocus:document.activeElement?.id==='dummy-focus',markers:['green','blue','red'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,x:r.x+r.width/2,y:r.y+r.height/2}})})`);
  return { nonce: config.nonce, pid: process.pid, hwnd: hwnd(target), title, identity,
    accessibility: { ...accessibility, supportEnabled: app.isAccessibilitySupportEnabled() }, lifecycle: lifecycle.map(value => ({ ...value })),
    bounds: target.getBounds(), webContentsPhysicalBounds: screen.dipToScreenRect(target, target.getContentBounds()),
    visible: target.isVisible(), focused: target.isFocused(), page,
    targetConfiguration: { frame: true, transparent: false, backgroundThrottling: 'default',
      foregroundMutationAttempted: false, affinityMutationAttempted: false, styleMutationAttempted: false },
    cover: cover && !cover.isDestroyed() ? { hwnd: hwnd(cover), bounds: cover.getBounds(), physicalBounds: screen.dipToScreenRect(cover, cover.getContentBounds()), focused: cover.isFocused(), alwaysOnTop: cover.isAlwaysOnTop() } : null };
}
function manifest() {
  return { nonce: config.nonce, pid: process.pid, hwnd: hwnd(target), title,
    startedUtcTicks: identity.startedUtcTicks, executable: identity.executable, sha256: identity.sha256 };
}
function recordProbes() { write('probe-events.json', { nonce: config.nonce, pid: process.pid, probes }); }
async function probe(mode, id) {
  if (activeProbe) throw new Error('Probe already running');
  gate();
  const manifestFile = file('manifest-' + id + '.json'), output = file('result-' + id + '.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest()), { flag: 'wx' });
  const before = await state();
  return new Promise((resolve, reject) => {
    const child = spawn(config.probe, [mode, config.gate, manifestFile, config.nonce, output], { windowsHide: true, stdio: 'ignore' });
    activeProbe = child;
    const record = { id, pid: child.pid, mode, output, identityFile: output + '.identity.json', spawnedAt: Date.now(), exitObserved: false, closeObserved: false };
    probes.push(record); recordProbes();
    child.on('error', error => { record.error = error.message; if (!child.pid) record.spawnFailed = true; recordProbes(); });
    child.on('exit', (code, signal) => { Object.assign(record, { exitObserved: true, exitCode: code, signal, exitedAt: Date.now() }); recordProbes(); });
    child.on('close', (code, signal) => {
      activeProbe = undefined; Object.assign(record, { closeObserved: true, closeCode: code, closeSignal: signal }); recordProbes();
      try {
        const result = JSON.parse(fs.readFileSync(output, 'utf8'));
        if (result.nonce !== config.nonce || result.probePid && result.probePid !== record.pid) throw new Error('Probe identity reply mismatch');
        if (result.probeStartedUtcTicks) record.startedUtcTicks = result.probeStartedUtcTicks;
        recordProbes(); resolve({ before, result, child: { ...record } });
      } catch (error) { reject(error); }
      if (closing) app.quit();
    });
  });
}
function close() {
  if (closing) return; closing = true;
  clearInterval(commands); clearInterval(watchdog);
  if (cover && !cover.isDestroyed()) cover.close();
  if (target && !target.isDestroyed()) target.close();
  // A capture has its own 12 s native watchdog. Keep the parent alive to collect
  // the original ChildProcess exit/close evidence rather than orphaning it.
  if (!activeProbe) app.quit();
}
async function command(value) {
  if (value.nonce !== config.nonce || typeof value.id !== 'string' || !/^[a-f0-9-]{1,64}$/.test(value.id)) throw new Error('Owned command identity mismatch');
  if (value.action === 'close') { write('response.json', { nonce: config.nonce, id: value.id, ok: true, closing: true }); close(); return; }
  if (closing || !ready) throw new Error('Fixture not ready');
  gate();
  let result;
  if (value.action === 'state') result = await state();
  else if (value.action === 'diagnose' || value.action === 'capture') result = await probe(value.action === 'diagnose' ? '--diagnose' : '--capture', value.id);
  else if (value.action === 'cover') {
    if (cover) throw new Error('Cover already exists');
    const rect = target.getContentBounds();
    cover = new BrowserWindow({ x: rect.x + 30, y: rect.y + 40, width: 150, height: 130, frame: false,
      show: false, alwaysOnTop: true, focusable: false, backgroundColor: '#202020', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await cover.loadURL('data:text/html,<body style="margin:0;background:%23202020">Owned overlay</body>');
    cover.showInactive(); result = await state();
  } else throw new Error('Unknown owned command');
  if (!closing) write('response.json', { nonce: config.nonce, id: value.id, ok: true, result });
}
const commands = setInterval(() => {
  try {
    if (!fs.existsSync(file('command.json'))) return;
    const value = JSON.parse(fs.readFileSync(file('command.json'), 'utf8'));
    if (value.id === lastId) return; lastId = value.id;
    // close may interrupt the wait for a probe; ordinary commands remain serial.
    if (activeProbe && value.action !== 'close') throw new Error('Owned probe busy');
    void command(value).catch(error => { write('response.json', { nonce: config.nonce, id: value.id, ok: false, error: error.message }); });
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) write('failure.json', { nonce: config.nonce, pid: process.pid, error: error.message }); }
}, 50);
const watchdog = setInterval(() => {
  try { if (Date.now() - fs.statSync(file('heartbeat')).mtimeMs > 90000) close(); }
  catch { close(); }
}, 1000);
app.on('window-all-closed', () => { if (!activeProbe) app.quit(); });
app.on('will-quit', () => {
  clearInterval(commands); clearInterval(watchdog);
  write('closed.json', { nonce: config.nonce, pid: process.pid, identity, activeProbe: Boolean(activeProbe), probes, accessibility, lifecycle, closedAt: Date.now() });
});
app.whenReady().then(async () => {
  if (closing) return;
  gate();
  accessibility.supportEnabledInitially = app.isAccessibilitySupportEnabled();
  accessibility.supportEnabled = accessibility.supportEnabledInitially;
  mark('app-ready');
  if (config.ppilotFocus === true) {
    // This only makes our explicit focus fixture accessible. Default/diagnose
    // runs retain Chromium's original accessibility configuration.
    accessibility.forcedForFixture = true;
    mark('accessibility-enable-requested');
    app.setAccessibilitySupportEnabled(true);
    accessibility.supportEnabled = app.isAccessibilitySupportEnabled();
    mark('accessibility-enable-returned', { enabled: accessibility.supportEnabled });
  }
  target = new BrowserWindow({ title, width: 800, height: 500, useContentSize: true, show: false,
    transparent: false, backgroundColor: '#f3f0dc', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  mark('window-created');
  target.once('ready-to-show', () => mark('ready-to-show'));
  target.webContents.once('dom-ready', () => mark('dom-ready'));
  target.webContents.once('did-finish-load', () => mark('did-finish-load'));
  mark('load-start');
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  mark('load-resolved');
  if (closing) return;
  target.showInactive(); mark('shown-inactive'); ready = true;
  mark('fixture-ready');
  write('ready.json', await state());
}).catch(error => { write('failure.json', { nonce: config.nonce, pid: process.pid, error: error.message }); close(); });
