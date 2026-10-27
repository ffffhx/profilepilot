const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { PhoneCloud } = loadCli('src/main/phones/cloud.ts');
const { phonePresentation } = loadCli('src/shared/phone-presentation.ts');
const { phoneList } = loadCli('src/shared/phone-list.ts');
const token = () => randomBytes(32).toString('hex');
const report = () => ({ deviceId: randomUUID(), name: 'Test phone', permissions: { overlay: false, notifications: false, accessibility: false }, readiness: { unlocked: true, computerConnected: false, usbConnected: false, wifiConnected: false, developerOptions: 'disabled', usbDebugging: 'disabled', wirelessDebugging: 'disabled', accessibilityService: 'disabled' } });
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-registration-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('LAN addition persists, deduplicates stable App identity, and never invokes ADB or grants a session', async t => {
  const root = temporary(t); let now = 1000, adbCalls = 0;
  const app = { id: randomUUID(), deviceId: randomUUID(), name: 'Phone <&>', ip: '192.168.1.2', version: 'new', variant: 'debug', wirelessDebugging: 'disabled' };
  const options = { root, apkPath: '', now: () => now, discoverNearbyApps: async () => ({ apps: [app], appError: '' }), adb: { run: async () => { adbCalls++; throw Error('No ADB'); } } };
  const service = new PhonesService(options); t.after(() => service.close());
  assert.throws(() => service.addNearby(app.id), /过期/);
  await service.discoverDevices(); const added = service.addNearby(app.id);
  assert.equal(added.state, null); assert.equal(added.connection, 'missing'); assert.equal(adbCalls, 0);
  assert.equal(phonePresentation(added).canPreview, false);
  assert.equal(phoneList(service.snapshot().devices).items[0].status, '已添加 · 未连接控制');
  app.id = randomUUID(); app.ip = '192.168.1.9'; await service.discoverDevices(); service.addNearby(app.id);
  assert.equal(service.snapshot().devices.length, 1);
  await service.rename(added.id, 'My phone');
  const restarted = new PhonesService(options); t.after(() => restarted.close());
  assert.equal(restarted.snapshot().devices[0].name, 'My phone');
  assert.equal(restarted.snapshot().devices[0].registration.address, app.ip);
  now += 30001; assert.throws(() => service.addNearby(app.id), /过期/);
  restarted.forgetRegistered(added.id); assert.equal(restarted.snapshot().devices.length, 0);
});

test('legacy transient discovery IDs cannot become permanent device identities', async t => {
  const app = { id: randomUUID(), name: 'Old phone', ip: '192.168.1.2', version: 'old', variant: 'debug', wirelessDebugging: 'disabled' };
  const service = new PhonesService({ root: temporary(t), apkPath: '', discoverNearbyApps: async () => ({ apps: [app], appError: '' }), adb: { run: async () => '' } });
  t.after(() => service.close()); await service.discoverDevices();
  assert.throws(() => service.addNearby(app.id), /更新手机/);
});

async function relay(t) {
  const { createStatusServer } = await import('../services/phone-status/server.mjs');
  let now = Date.now(); const server = createStatusServer({ now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { advance: ms => now += ms, call: (action, id, credential, extra = {}) => fetch(url + '/v1/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + credential }, body: JSON.stringify({ id, ...extra }) }), request: (endpoint, init) => fetch(url + new URL(endpoint).pathname, init) };
}

test('device code adds across networks once, retries lost responses, separates authority and revokes', async t => {
  const r = await relay(t), id = randomUUID(), writer = token(), data = report(), reader = token();
  const created = await (await r.call('device-code-create', id, writer, { report: data })).json();
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{12}$/);
  const add = credential => r.call('device-code-add', randomUUID(), credential, { code: created.code });
  const first = await add(reader); assert.equal(first.status, 200);
  const value = await first.json(); assert.equal(value.id, id); assert.deepEqual(value.report, data);
  assert.equal((await add(reader)).status, 200, 'same reader can recover a lost response');
  assert.equal((await add(token())).status, 409, 'another computer cannot reuse the code');
  assert.equal((await r.call('status', id, writer)).status, 401);
  assert.equal((await r.call('report', id, reader, { report: data })).status, 401);
  assert.equal((await r.call('device-code-revoke', id, reader)).status, 401);
  assert.equal((await r.call('device-code-create', id, token(), { report: data })).status, 409);
  assert.equal((await (await r.call('report', id, writer, { report: data })).json()).paired, true);
  r.advance(600001); assert.equal((await add(reader)).status, 404);
  assert.equal((await r.call('status', id, reader)).status, 200, 'bound device survives code expiration');
  assert.equal((await r.call('device-code-revoke', id, writer)).status, 200);
  assert.equal((await r.call('status', id, reader)).status, 404);
});

test('unclaimed code expires and device-code guessing is limited', async t => {
  const r = await relay(t), id = randomUUID(), writer = token(), data = report();
  const created = await (await r.call('device-code-create', id, writer, { report: data })).json();
  r.advance(600001);
  assert.equal((await r.call('device-code-add', randomUUID(), token(), { code: created.code })).status, 404);
  assert.equal((await r.call('report', id, writer, { report: data })).status, 404);
  for (let i = 0; i < 11; i++) assert.equal((await r.call('device-code-add', randomUUID(), token(), { code: 'AAAAAAAAAAAA' })).status, 404);
  assert.equal((await r.call('device-code-add', randomUUID(), token(), { code: 'AAAAAAAAAAAA' })).status, 429);
});

test('desktop code registration survives restart and LAN/code routes merge without a control session', async t => {
  const root = temporary(t), r = await relay(t), data = report(), id = randomUUID();
  const code = (await (await r.call('device-code-create', id, token(), { report: data })).json()).code;
  let loseResponse = true;
  const request = async (url, init) => { const response = await r.request(url, init); if (url.endsWith('device-code-add') && loseResponse) { loseResponse = false; throw Error('Lost response'); } return response; };
  const cloud = new PhoneCloud(root, () => {}, request); t.after(() => cloud.close());
  await assert.rejects(cloud.addCode(code, 'https://example.test'), /Lost response/);
  const added = await cloud.addCode(code.toLowerCase().replace(/(.{4})(?!$)/g, '$1-'), 'https://example.test');
  assert.equal(added.connection, 'missing'); assert.equal(added.state, null);
  assert.equal(added.registration.deviceId, data.deviceId);
  cloud.rename(added.id, 'My remote phone'); await cloud.refresh(); assert.equal(cloud.devices()[0].name, 'My remote phone');
  const app = { id: randomUUID(), deviceId: data.deviceId, name: data.name, ip: '192.168.1.2', version: 'new', variant: 'debug', wirelessDebugging: 'disabled' };
  const service = new PhonesService({ root, apkPath: '', discoverNearbyApps: async () => ({ apps: [app], appError: '' }), adb: { run: async () => '' } });
  t.after(() => service.close()); await service.discoverDevices(); service.addNearby(app.id);
  const devices = service.snapshot().devices;
  assert.equal(devices.length, 1); assert.equal(devices[0].name, 'My remote phone');
  assert.equal(devices[0].registration.deviceId, data.deviceId);
  assert.equal(devices[0].state, null); assert.equal(phonePresentation(devices[0]).canPreview, false);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'status-channels.json'), 'utf8'), /permissions|readiness|sessionId/);
});
