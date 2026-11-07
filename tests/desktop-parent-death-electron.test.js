const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../scripts/e2e/desktop-parent-death-protocol.mjs');
const home = 'C:\\Owned\\probe';
const directories = Object.fromEntries(['userData', 'sessionData', 'logs', 'crashDumps'].map(key => [key, home + '\\electron-' + key]));
const expected = { kind: 'electron', home, electronVersion: '42.3.3', directories };
function runtime() { return { kind: 'electron', versions: { electron: '42.3.3', node: '24.15.0', uv: '1.51.0' }, processType: 'browser',
  runAsNodePresent: false, windowCount: 0, webContentsCount: 0, directories: { ...directories } }; }
const identity = { ok: true, pid: 55, parentPid: 44, executable: 'C:\\Owned\\node.exe', sha256: 'a'.repeat(64),
  startedUtcTicks: '639289105934552999', integrityRid: 8192, elevated: false, uiAccess: false };
test('explicit runtime choice preserves node default and never implies run', async () => {
  const { parentDeathOptions } = await load();
  assert.deepEqual(parentDeathOptions(['--parent-runtime', 'electron']), { run: false, runtime: 'electron' });
  assert.deepEqual(parentDeathOptions(['--run', '--parent-runtime', 'electron']), { run: true, runtime: 'electron' });
  assert.deepEqual(parentDeathOptions(['--parent-runtime', 'node', '--check']), { run: false, runtime: 'node' });
  for (const args of [['--parent-runtime'], ['--parent-runtime', 'electron', '--parent-runtime', 'node'], ['--parent-runtime', 'app'],
    ['--run', '--parent-runtime', 'electron', '--check']]) assert.throws(() => parentDeathOptions(args));
});
test('Electron spawn environment deletes every Windows casing without mutating caller environment', async () => {
  const { electronParentEnvironment } = await load();
  const original = { ELECTRON_RUN_AS_NODE: '1', Electron_Run_As_Node: '', PATH: 'owned', OTHER: 'value' };
  assert.deepEqual(electronParentEnvironment(original), { PATH: 'owned', OTHER: 'value' });
  assert.equal(original.ELECTRON_RUN_AS_NODE, '1');
});
test('all Electron writable directories must be absolute children of the nonce probe root', async () => {
  const { verifyProbeDirectory } = await load();
  assert.equal(verifyProbeDirectory(home, directories.userData), directories.userData);
  for (const candidate of [home, home + '\\..\\Other', 'C:\\Owned\\probe-other\\data', 'D:\\Owned\\probe\\data', '..\\data', undefined]) {
    assert.throws(() => verifyProbeDirectory(home, candidate));
  }
});
test('runtime receipt distinguishes real Electron browser process from run-as-node and other builds', async () => {
  const { verifyParentRuntime } = await load();
  assert.equal(verifyParentRuntime(runtime(), expected).versions.electron, '42.3.3');
  for (const change of [value => { delete value.versions.electron; }, value => { value.versions.electron = '41.0.0'; },
    value => { value.runAsNodePresent = true; }, value => { value.processType = 'renderer'; }, value => { value.windowCount = 1; },
    value => { value.webContentsCount = 1; }, value => { value.directories.logs = 'C:\\User\\logs'; }, value => { value.kind = 'node'; },
    value => { value.versions.uv = ''; }]) { const value = runtime(); change(value); assert.throws(() => verifyParentRuntime(value, expected)); }
});
test('runtime receipt is checked together with full parent executable identity', async () => {
  const { verifyProbeParent } = await load();
  const expectedParent = { nonce: 'b'.repeat(32), executable: 'C:\\Owned\\electron.exe', sha256: 'c'.repeat(64), runtime: expected };
  const owned = { ...identity, executable: expectedParent.executable, sha256: expectedParent.sha256 };
  assert.equal(verifyProbeParent({ nonce: expectedParent.nonce, identity: owned, runtime: runtime() }, expectedParent, 55).pid, 55);
  assert.throws(() => verifyProbeParent({ nonce: expectedParent.nonce, identity, runtime: runtime() }, expectedParent, 55));
});
test('bootstrap receipt alone or child pipe close cannot qualify bootstrap retirement before fault', async () => {
  const { verifyBootstrapCompletion } = await load();
  const nonce = 'b'.repeat(32), receipt = { nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks, reason: 'launched', exitCode: 0 };
  const exit = { ok: true, originalExited: true };
  assert.equal(verifyBootstrapCompletion(receipt, identity, nonce, exit).ok, true);
  for (const bad of [{ ok: true, close: true }, { ok: true, originalExited: false }, { ok: false, originalExited: true }]) {
    assert.throws(() => verifyBootstrapCompletion(receipt, identity, nonce, bad));
  }
  for (const patch of [{ reason: 'failed' }, { exitCode: 1 }, { nonce: 'different' }, { pid: 56 }, { startedUtcTicks: '639289105934553000' }]) {
    assert.throws(() => verifyBootstrapCompletion({ ...receipt, ...patch }, identity, nonce, exit));
  }
});
test('Electron entry isolates paths before await, never loads App main, and explicitly exits after cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-parent-death-electron.cjs'), 'utf8');
  assert.ok(source.indexOf('app.setPath(key,') < source.indexOf("await import("));
  assert.match(source, /await parent\.runIsolatedDesktopParent\(configFile, evidence\)/);
  assert.ok(source.indexOf('app.exit(process.exitCode || 0)') > source.indexOf('await parent.runIsolatedDesktopParent'));
  assert.doesNotMatch(source, /new (?:electron\.)?BrowserWindow|loadURL|loadFile|requestSingleInstanceLock|dist\/main\/main|inputObserver|registerManagement/);
});
test('bootstrap must exit before baseline/fault and only bootstrap to Electron is detached', () => {
  const main = fs.readFileSync(path.join(__dirname, '../scripts/verify-desktop-parent-death.mjs'), 'utf8');
  assert.ok(main.indexOf('report.bootstrapAttempted = true') < main.indexOf('bootstrapLaunch = await launchWindowsUserProcess'));
  assert.ok(main.indexOf('report.bootstrapBeforeFault = await bootstrapCompleted()') < main.indexOf('await recoverParent(); await writeFile(config.parentGo'));
  assert.ok(main.indexOf('await recoverParent(); await writeFile(config.parentGo') < main.indexOf('await runParentDeathCase('));
  assert.match(main, /spawnedParentIdentityRecovery/); assert.match(main, /bootstrapIdentityRecovery|if \(!bootstrapIdentity\) await recoverBootstrap/);
  const bootstrap = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-parent-death-bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /env: electronParentEnvironment\(process.env\), detached: true/);
  assert.match(bootstrap, /child\.unref\(\)/); assert.doesNotMatch(bootstrap, /\.kill\(/);
  assert.ok(bootstrap.indexOf('existsSync(config.parentStop)') < bootstrap.indexOf('child = spawn('));
  const parent = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-parent-death-parent.mjs'), 'utf8');
  assert.match(parent, /assert.notEqual\(options.detached, true/);
  assert.match(parent, /helper = spawn\(executable, args, options\)/);
});
