const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { PhoneWirelessDiscoveryMonitor, wirelessDiscoveryPresentation } = loadCli('src/renderer/phone-wireless-discovery.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const found = { services: [{ name: 'adb-TABLET-xyz', kind: 'connect', address: '192.168.0.101:38201', reachable: true }], error: '' };

test('homepage discovers the selected offline tablet, throttles polling, and expires stale results', async () => {
  const calls = []; let now = 0, changes = 0;
  const monitor = new PhoneWirelessDiscoveryMonitor(async id => { calls.push(id); return found; }, () => changes++, () => now);
  monitor.update('TABLET', false);
  assert.equal(calls.length, 0, 'hidden workspace does not scan');
  monitor.update('TABLET', true);
  assert.equal(monitor.state.checking, true);
  await flush();
  assert.deepEqual(calls, ['TABLET']); assert.equal(changes, 1);
  assert.equal(wirelessDiscoveryPresentation(monitor.state, false).label, '已发现 · 待连接');
  now = 9999; monitor.update('TABLET', true); assert.equal(calls.length, 1);
  now = 10000; monitor.update('TABLET', true); await flush(); assert.equal(calls.length, 2);
  now = 40001; monitor.update('TABLET', false);
  assert.equal(monitor.state.result, undefined, 'stale reachability must not remain visible');
  monitor.update('', true); assert.equal(calls.length, 2, 'a connected device or emulator has no discovery target');
});

test('switching devices during discovery discards the old result and does not overlap scans', async () => {
  const calls = []; let resolveFirst;
  const monitor = new PhoneWirelessDiscoveryMonitor(id => {
    calls.push(id);
    return calls.length === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ services: [], error: '' });
  }, () => {});
  monitor.update('TABLET', true);
  monitor.update('OTHER', true);
  assert.equal(calls.length, 1);
  resolveFirst(found); await flush();
  assert.equal(monitor.state.result, undefined, 'tablet discovery cannot label another phone');
  monitor.update('OTHER', true); await flush();
  assert.deepEqual(calls, ['TABLET', 'OTHER']);
  assert.deepEqual(monitor.state.result.services, []);
});

test('disconnect and reconnect invalidates an in-flight discovery even for the same device', async () => {
  let resolve;
  const monitor = new PhoneWirelessDiscoveryMonitor(() => new Promise(done => { resolve = done; }), () => {});
  monitor.update('TABLET', true); monitor.update('', true); monitor.update('TABLET', false);
  resolve(found); await flush();
  assert.equal(monitor.state.result, undefined);
});

test('discovery failure replaces old results and retries only after the polling interval', async () => {
  let now = 0, calls = 0;
  const monitor = new PhoneWirelessDiscoveryMonitor(async () => { if (++calls === 1) return found; throw new Error('unavailable'); }, () => {}, () => now);
  monitor.update('TABLET', true); await flush();
  now = 10000; monitor.update('TABLET', true); await flush();
  assert.deepEqual(monitor.state.result.services, []);
  assert.equal(wirelessDiscoveryPresentation(monitor.state, false).label, '发现暂不可用');
  monitor.update('TABLET', true); assert.equal(calls, 2);
});

test('discovery, pairing, reachability and phone-reported readiness remain distinct from a connection', () => {
  assert.equal(wirelessDiscoveryPresentation({ checking: true }, false).label, '正在查找');
  assert.equal(wirelessDiscoveryPresentation({ checking: false, result: found }, false).label, '已发现 · 待连接');
  const result = { ...found, services: [{ ...found.services[0], kind: 'pairing' }] };
  assert.equal(wirelessDiscoveryPresentation({ checking: false, result }, false).label, '等待配对');
  result.services[0].reachable = false;
  assert.equal(wirelessDiscoveryPresentation({ checking: false, result }, true).label, '发现但不可达');
  result.services = [];
  assert.equal(wirelessDiscoveryPresentation({ checking: false, result }, true).label, '已开启 · 待连接');
  assert.equal(wirelessDiscoveryPresentation({ checking: false, result }, false).label, '未连接');
});
