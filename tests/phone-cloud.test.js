const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { phonePresentation } = loadCli('src/shared/phone-presentation.ts');
const { PhoneCloud, statusUrl } = loadCli('src/main/phones/cloud.ts');
const token = () => randomBytes(32).toString('hex');
const report = () => ({ deviceId: randomUUID(), name: 'Test phone', permissions: { overlay: true, notifications: true, accessibility: true }, readiness: { unlocked: true, computerConnected: false, usbConnected: false, wifiConnected: false, developerOptions: 'unconfirmed', usbDebugging: 'unconfirmed', wirelessDebugging: 'unconfirmed', accessibilityService: 'running' } });

test('relay pairs without ADB, separates read/write authority, expires status and revokes access', async t => {
  const { createStatusServer } = await import('../services/phone-status/server.mjs');
  let now = 1000;
  const server = createStatusServer({ now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const id = randomUUID(), reader = token(), writer = token(), pairing = token(), data = report();
  const call = (action, credential, extra = {}) => fetch(url + '/v1/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + credential }, body: JSON.stringify({ id, ...extra }) });
  assert.equal((await call('create', reader, { pairToken: pairing })).status, 200);
  assert.equal((await call('claim', pairing, { writeToken: writer, deviceId: data.deviceId })).status, 200);
  assert.equal((await call('claim', pairing, { writeToken: writer, deviceId: data.deviceId })).status, 200, 'same claim can recover a lost response');
  assert.equal((await call('claim', pairing, { writeToken: token(), deviceId: data.deviceId })).status, 403);
  assert.equal((await call('report', reader, { report: data })).status, 401);
  assert.equal((await call('status', writer)).status, 401);
  assert.equal((await call('report', writer, { report: { ...data, deviceId: randomUUID() } })).status, 403);
  assert.equal((await call('report', writer, { report: data })).status, 200);
  let value = await (await call('status', reader)).json();
  assert.deepEqual(value.report, data); assert.equal(value.ageMs, 0);
  now += 60000;
  value = await (await call('status', reader)).json();
  assert.equal(value.ageMs, 60000);
  assert.equal((await call('revoke', reader)).status, 200);
  assert.equal((await call('report', writer, { report: data })).status, 404);
});

test('expired pairing never authorizes a new phone', async t => {
  const { createStatusServer } = await import('../services/phone-status/server.mjs');
  let now = 0; const server = createStatusServer({ now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const id = randomUUID(), pairing = token();
  const call = (action, credential, extra) => fetch(`http://127.0.0.1:${server.address().port}/v1/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + credential }, body: JSON.stringify({ id, ...extra }) });
  await call('create', token(), { pairToken: pairing }); now = 180001;
  assert.equal((await call('claim', pairing, { writeToken: token(), deviceId: randomUUID() })).status, 403);
});

test('cloud diagnostics remain usable without control and become unknown after 45 seconds', () => {
  const device = { id: 'cloud-' + randomUUID(), name: 'Phone', model: 'Phone', transport: 'cloud', connection: 'missing', companion: 'unavailable', state: null, confirmedAt: null, pending: null, error: '', cloud: { paired: true, report: report(), reportedAt: 1000 } };
  const view = phonePresentation(device, 2000);
  assert.equal(view.known, true); assert.equal(view.permissionsReady, true);
  assert.equal(view.canPreview, false); assert.equal(view.canSetup, false); assert.equal(view.active, false);
  assert.match(view.label, /状态同步在线/);
  assert.ok(view.settings.every(row => row.status === 'unknown' && /待确认/.test(row.value)));
  assert.ok(view.settings.every(row => !/系统限制/.test(row.value) && /未提供.*原因/.test(row.description)));
  const stale = phonePresentation(device, 46000);
  assert.equal(stale.known, false); assert.equal(stale.permissionsReady, false);
  assert.ok(stale.permissions.every(row => row.status === 'unknown'));
});

test('desktop refresh compensates for age, persists only pairing and never grants a session', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-cloud-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const data = report(); let now = 100000, fail = false;
  data.readiness.debugReasons = { developerOptions: 'masked-zero', usbDebugging: 'denied', wirelessDebugging: 'missing' };
  data.readiness.appVersion = '0.2.1';
  const request = async url => {
    if (fail) throw new Error('Offline');
    return new Response(JSON.stringify(url.endsWith('/create') ? { expires: now + 180000 } : { paired: true, report: data, ageMs: 30000 }));
  };
  const cloud = new PhoneCloud(root, () => {}, request, () => now);
  t.after(() => cloud.close());
  await cloud.pair('https://example.test/status'); await cloud.refresh();
  const device = cloud.devices()[0];
  assert.deepEqual(device.cloud.report.readiness.debugReasons, data.readiness.debugReasons);
  assert.equal(device.cloud.report.readiness.appVersion, '0.2.1');
  assert.equal(device.cloud.reportedAt, 70000); assert.equal(device.state, null); assert.equal(device.connection, 'missing');
  assert.equal(phonePresentation(device, now).known, true);
  fail = true; now += 16000; await cloud.refresh();
  assert.equal(phonePresentation(cloud.devices()[0], now).known, false);
  const disk = fs.readFileSync(path.join(root, 'status-channels.json'), 'utf8');
  assert.doesNotMatch(disk, /permissions|readiness|sessionId/);
  assert.throws(() => statusUrl('http://example.test'), /HTTPS/);
  assert.throws(() => statusUrl('https://user:password@example.test'), /HTTPS/);
});

test('remembered phone identity attaches cloud diagnostics after a desktop restart without ADB', async t => {
  const { PhonesService } = loadCli('src/main/phones/service.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-cloud-restart-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const data = report(), channel = { id: randomUUID(), token: token(), url: 'https://example.test/status', name: 'Phone' };
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ usb: { token: token(), hardwareId: 'hardware', model: 'Phone', transport: 'usb' }, '192.168.1.2:12345': { token: token(), hardwareId: 'hardware', statusDeviceId: data.deviceId, model: 'Phone', transport: 'wifi' } }));
  fs.writeFileSync(path.join(root, 'status-channels.json'), JSON.stringify([channel]));
  const service = new PhonesService({ root, apkPath: '', adb: { run: async () => { throw new Error('ADB unavailable'); } } });
  t.after(() => service.close());
  service.cloud.request = async () => new Response(JSON.stringify({ paired: true, report: data, ageMs: 0 }));
  await service.cloud.refresh(); await service.refresh();
  const devices = service.snapshot().devices;
  assert.equal(devices.length, 2, 'cloud identity reuses both saved routes rather than adding another phone');
  for (const device of devices) {
    assert.equal(device.state, null);
    assert.equal(phonePresentation(device).cloudOnline, true);
    assert.equal(phonePresentation(device).canPreview, false);
    assert.equal(phonePresentation(device).canSetup, false);
  }
});
