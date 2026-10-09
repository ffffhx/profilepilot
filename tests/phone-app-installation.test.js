const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { phoneEnhancementPresentation } = loadCli('src/shared/phone-presentation.ts');

test('App inspection is read-only, cached, explicitly refreshable and invalidated on disconnect', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-app-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let output = '', online = true, now = 1000;
  const calls = [];
  const service = new PhonesService({ root, apkPath: '', now: () => now, adb: { run: async args => {
    calls.push(args);
    if (args[0] === 'devices') return online ? 'PHONE device model:Test' : '';
    if (args[3] === "'getprop' 'ro.serialno'") return 'PHONE';
    if (args[3]?.startsWith("'pm' 'path'")) { if (output instanceof Error) throw output; return output; }
    throw new Error('Unexpected device command: ' + JSON.stringify(args));
  } } });
  const get = () => service.snapshot().devices[0];
  await service.refresh();
  assert.equal(get().appInstallation.status, 'missing');
  const count = () => calls.filter(a => a[3]?.startsWith("'pm' 'path'")).length;
  await service.refresh(); assert.equal(count(), 1);
  output = 'package:/data/app/profilepilot/base.apk';
  await service.inspect('PHONE'); assert.equal(get().appInstallation.status, 'installed');
  assert.equal(count(), 2); assert.equal(get().state, null, 'inspection never pairs or starts a session');
  now += 30001; output = new Error('device timed out');
  await service.refresh(); assert.equal(get().appInstallation.status, 'unknown', 'query failures are not missing App');
  output = 'Error: package manager unavailable';
  await service.inspect('PHONE'); assert.equal(get().appInstallation.status, 'unknown');
  online = false; await service.refresh(); assert.equal(get().appInstallation, undefined);
  online = true; output = ''; await service.refresh(); assert.equal(get().appInstallation.status, 'missing');
  assert.ok(calls.every(a => a[0] === 'devices' || a[2] === 'shell' && /^'(getprop|pm)'/.test(a[3])));
});

test('missing App overrides old permission reports; unknown and disabled are distinct', () => {
  const now = Date.now();
  const device = { id: 'PHONE', name: 'Phone', transport: 'usb', connection: 'device', companion: 'unknown', state: null, confirmedAt: null,
    appInstallation: { status: 'missing', checkedAt: now }, cloud: { reportedAt: now, report: { permissions: { accessibility: true, overlay: true, notifications: true } } } };
  let view = phoneEnhancementPresentation(device, now);
  assert.equal(view.installation, 'missing');
  assert.ok(view.permissions.every(row => row.status === 'unknown'));
  assert.equal(view.connected, false);
  device.appInstallation.status = 'installed'; device.cloud = undefined;
  view = phoneEnhancementPresentation(device, now);
  assert.equal(view.installation, 'installed'); assert.equal(view.connected, false);
  assert.ok(view.permissions.every(row => row.status === 'unknown'));
  device.connection = 'missing';
  assert.equal(phoneEnhancementPresentation(device, now).installation, 'unknown', 'offline cached package checks are not current facts');
  assert.equal(phoneEnhancementPresentation(undefined, now).permissions.length, 3);
});
