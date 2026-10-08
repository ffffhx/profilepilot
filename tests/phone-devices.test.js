const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { groupPhoneDevices } = loadCli('src/shared/phone-devices.ts');
const { phoneActive } = loadCli('src/shared/phones.ts');
const phone = (id, changes = {}) => ({ id, name: 'RMX3700', model: 'RMX3700', transport: 'usb', connection: 'device', companion: 'ready', confirmedAt: 1, pending: null, error: '', state: { instanceId: id, phase: 'idle', generation: 0 }, ...changes });

test('disconnected USB selection resolves to the online Wi-Fi route of the same phone', () => {
  const usb = phone('SERIAL', { hardwareId: 'SERIAL', connection: 'missing', companion: 'unavailable', state: { instanceId: 'old-process', phase: 'disconnected', generation: 99 } });
  const wifi = phone('192.168.0.2:40000', { hardwareId: 'SERIAL', transport: 'wifi', state: { instanceId: 'new-process', phase: 'controlling', generation: 2 } });
  const groups = groupPhoneDevices([usb, wifi], usb.id);
  assert.equal(groups.length, 1); assert.equal(groups[0].device, wifi);
  assert.deepEqual(groups[0].routes, [usb, wifi]);
  assert.equal(usb.connection, 'missing');
});
test('identical model names alone never merge separate phones', () => {
  assert.equal(groupPhoneDevices([phone('a'), phone('b')]).length, 2);
  assert.equal(groupPhoneDevices([phone('a', { state: null }), phone('b', { state: null })]).length, 2);
});
test('matching companion instances merge older snapshots without hardware IDs', () => {
  const usb = phone('usb', { state: { instanceId: 'same', phase: 'controlling', generation: 1 } });
  const wifi = phone('wifi', { transport: 'wifi', state: { ...usb.state } });
  const groups = groupPhoneDevices([usb, wifi], wifi.id);
  assert.equal(groups.length, 1); assert.equal(groups[0].device.id, 'wifi');
  assert.equal(groups.filter(group => phoneActive(group.device)).length, 1);
});
test('a partial identity bridges old snapshots but conflicting hardware stays separate', () => {
  const a = phone('a', { hardwareId: 'one', state: { instanceId: 'same' } });
  const b = phone('b', { state: { instanceId: 'same' } });
  assert.equal(groupPhoneDevices([b, a]).length, 1);
  const c = phone('c', { hardwareId: 'two', state: { instanceId: 'same' } });
  assert.equal(groupPhoneDevices([a, b, c]).length, 3);
});
test('new pause/stop generation wins over stale active state on another route', () => {
  const old = phone('usb', { state: { instanceId: 'same', phase: 'controlling', generation: 1 } });
  for (const phase of ['paused', 'stopped']) {
    const latest = phone('wifi', { state: { instanceId: 'same', phase, generation: 2 } });
    const result = groupPhoneDevices([old, latest], old.id)[0].device;
    assert.equal(result, latest); assert.equal(phoneActive(result), false);
  }
});
test('equal live routes keep selection stable and disconnected historical state cannot win', () => {
  const a = phone('a', { hardwareId: 'one' }), b = phone('b', { hardwareId: 'one' });
  assert.equal(groupPhoneDevices([a, b], b.id)[0].device, b);
  assert.equal(groupPhoneDevices([b, a], b.id)[0].device, b);
  b.connection = 'missing'; b.state.phase = 'paused'; b.state.generation = 100;
  assert.equal(groupPhoneDevices([b, a], b.id)[0].device, a);
});
