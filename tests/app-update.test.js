const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {AppUpdateManager} = require('../dist/main/app-update-manager');
const {changeKind} = require('../scripts/development-runtime.cjs');
class Updater extends EventEmitter {
  checks = 0; downloads = 0; installs = 0;
  async checkForUpdates() { this.checks++; this.emit('update-available', {version: '0.1.42', releaseNotes: 'Fix'}); }
  async downloadUpdate() { this.downloads++; this.emit('download-progress', {percent: 50}); this.emit('update-downloaded'); }
  quitAndInstall() { this.installs++; }
}
test('development does not construct/contact an updater or offer installation', async () => {
  const manager = new AppUpdateManager('0.1.0', 'abc');
  assert.equal((await manager.check()).phase, 'development');
  assert.equal((await manager.download()).phase, 'development');
  assert.equal(manager.requestInstall(), false);
  assert.throws(() => manager.finishInstall());
});
test('checking never downloads; install waits for confirmation and clean shutdown', async () => {
  const updater = new Updater(), manager = new AppUpdateManager('0.1.0', '', updater);
  await Promise.all([manager.check(), manager.check()]);
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(manager.requestInstall(), false);
  await manager.download();
  await manager.check();
  assert.equal(updater.checks, 1, 'a ready download survives automatic checks');
  assert.equal(manager.state.phase, 'downloaded');
  assert.equal(manager.requestInstall(), true);
  assert.equal(updater.installs, 0);
  manager.finishInstall();
  assert.equal(updater.installs, 1);
});
test('failed transfers report errors and cannot install', async () => {
  const updater = new Updater(), manager = new AppUpdateManager('0.1.0', '', updater);
  await manager.check();
  updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await manager.download();
  assert.equal(manager.state.error, 'checksum mismatch');
  assert.equal(manager.requestInstall(), false);
});
test('development watches source and ignores its own CSS output on Windows and macOS', () => {
  assert.equal(changeKind('public/app.css'), null);
  assert.equal(changeKind('public\\app.css'), null);
  assert.equal(changeKind('src/renderer/main.ts'), 'renderer');
  assert.equal(changeKind('src/main/profilepilot-cli.ts'), 'backend');
  assert.equal(changeKind('native/desktop/windows.cs'), 'backend');
  assert.equal(changeKind('skills/profilepilot/SKILL.md'), 'backend');
});
