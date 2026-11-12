const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { DefaultTargetStore } = loadCli('src/main/default-targets.ts');
const { defaultPhoneStatus } = loadCli('src/shared/default-targets.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const { runBrowserCli } = loadCli('src/main/browser-cli.ts');

function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-default-target-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function output() {
  let stdout = '', stderr = '';
  return { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, read: () => ({ stdout, stderr }) };
}
const device = (id, hardwareId, connection = 'device') => ({ id, hardwareId, connection, name: 'Same model', transport: 'wifi' });

test('UI defaults survive restart and browser CLI reads the same file without connecting', async t => {
  const directory = root(t), settings = new DefaultTargetStore(directory);
  assert.equal(settings.profile(), null);
  settings.setProfile({ id: 'native:Profile 2', name: '工作浏览器' });
  settings.setPhone({ id: 'usb-1', name: '手机', hardwareId: 'HW-1' });
  assert.equal(new DefaultTargetStore(directory).profile().id, 'native:Profile 2');
  const io = output();
  assert.equal(await runBrowserCli(['default', '--json'], io, { CPM_DATA_DIR: directory }, {
    extension: () => { throw new Error('must not connect'); }, gateway: () => { throw new Error('must not connect'); }
  }), 0);
  assert.equal(JSON.parse(io.read().stdout).result.saved.id, 'native:Profile 2');
  settings.setProfile(null);
  assert.equal(new DefaultTargetStore(directory).profile(), null);
  assert.equal(new DefaultTargetStore(directory).phone().hardwareId, 'HW-1');
  fs.writeFileSync(path.join(directory, 'default-profile.json'), 'broken');
  assert.throws(() => settings.profile(), /无法读取/);
  settings.setProfile(null);
  assert.equal(settings.profile(), null, 'explicit clear can repair corrupt settings');
});

test('phone defaults follow verified hardware, never model names or reused Wi-Fi addresses', () => {
  const saved = { id: '192.168.1.8:40000', name: 'My phone', hardwareId: 'HW-1' };
  const sameAddressWrongPhone = device(saved.id, 'HW-2');
  const newAddress = device('192.168.1.9:41000', 'HW-1');
  assert.equal(defaultPhoneStatus([sameAddressWrongPhone, newAddress], saved).deviceId, newAddress.id);
  assert.deepEqual(defaultPhoneStatus([sameAddressWrongPhone], saved), { saved, deviceId: null, available: false });
  assert.equal(defaultPhoneStatus([newAddress, device('other', 'HW-2')], saved).deviceId, newAddress.id);
  assert.equal(defaultPhoneStatus([device('old', 'HW-1', 'offline'), device('other', 'HW-2')], saved).available, false);
});

test('phone default alias stops offline and explicit targets never consult the default', async () => {
  const calls = [], saved = { id: 'wanted', name: 'My phone' };
  let available = false;
  const dispatch = async command => {
    calls.push(command);
    return { version: 1, id: 'test', ok: true, data: command.method === 'default' ? { saved, deviceId: 'wanted', available } : {} };
  };
  const offline = output();
  assert.notEqual(await runPhoneCli(['start', '--device', 'default'], dispatch, offline), 0);
  assert.deepEqual(calls.map(c => c.method), ['default']);
  assert.match(offline.read().stderr, /未连接/);
  calls.length = 0;
  assert.equal(await runPhoneCli(['readiness', '--device', 'explicit'], dispatch, output()), 0);
  assert.deepEqual(calls.map(c => c.method), ['readiness']);
  assert.equal(calls[0].params.id, 'explicit');
  calls.length = 0; available = true;
  assert.equal(await runPhoneCli(['readiness', '--device', 'default'], dispatch, output()), 0);
  assert.deepEqual(calls.map(c => c.method), ['default', 'readiness']);
  assert.equal(calls[1].params.id, 'wanted');
});

test('default commands query, set and clear without starting a control session', async () => {
  const calls = [], dispatch = async command => { calls.push(command); return { version: 1, id: 't', ok: true, data: {} }; };
  for (const args of [['default'], ['default', '--device', 'phone-1'], ['default', '--clear']])
    assert.equal(await runPhoneCli(args, dispatch, output()), 0);
  assert.deepEqual(calls.map(c => c.params), [{}, { id: 'phone-1' }, { id: null }]);
  assert.ok(calls.every(c => c.method === 'default'));
  assert.notEqual(await runPhoneCli(['default', '--clear', '--device', 'phone-1'], dispatch, output()), 0);
  assert.equal(calls.length, 3);
});
