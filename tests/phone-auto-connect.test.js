const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { groupPhoneDevices } = loadCli('src/shared/phone-devices.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auto-wifi-'));
  const h = { root, now: 100000, usb: true, wifi: false, address: '192.168.1.9:41000', serial: 'KNOWN', fail: false, reachable: true, calls: [], probes: [], services: null, connection: 'device' };
  const instances = [];
  h.create = () => {
    const service = new PhonesService({ root, apkPath: '', now: () => h.now,
      probeWireless: async address => { h.probes.push(address); if (h.probeHook) await h.probeHook(); return { reachable: h.reachable, reason: '' }; },
      adb: { run: async (args, timeout, input, signal) => {
        h.calls.push(args);
        if (args[0] === 'devices') return (h.usb ? `KNOWN ${h.connection} model:Phone\n` : '') + (h.wifi ? `${h.address} device model:Phone` : '');
        if (args[0] === 'mdns') return h.services ?? `adb-KNOWN-xyz _adb-tls-connect._tcp ${h.address}`;
        if (args[0] === 'connect') {
          if (h.connectHook) return h.connectHook(signal);
          if (h.fail) return 'failed to authenticate';
          h.wifi = true; return `connected to ${args[1]}`;
        }
        if (args[3] === "'getprop' 'ro.serialno'") return args[1] === 'KNOWN' ? 'KNOWN' : h.serial;
        if (args[3] === "'pm' 'path' 'io.github.profilepilot.phone'") return '';
        throw new Error('Unexpected command: ' + args.join(' '));
      } }
    });
    instances.push(service); return service;
  };
  h.connects = () => h.calls.filter(args => args[0] === 'connect');
  h.offline = async service => { h.usb = false; h.wifi = false; await service.refresh(); };
  t.after(async () => { for (const service of instances) await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('USB is discovered automatically; verified basic devices reconnect over Wi-Fi after an app restart', async t => {
  const h = fixture(t), first = h.create();
  assert.equal((await first.refresh()).devices[0].connection, 'device');
  await first.reconnectWireless(); assert.equal(h.connects().length, 0, 'USB already suffices');
  assert.equal(fs.existsSync(path.join(h.root, 'devices.json')), false, 'no companion credentials created');
  await first.close(); h.usb = false;
  const next = h.create(); await next.refresh(); await next.reconnectWireless();
  const groups = groupPhoneDevices(next.snapshot().devices);
  assert.equal(groups.length, 1); assert.equal(groups[0].device.id, h.address);
  assert.equal(groups[0].device.connection, 'device'); assert.equal(groups[0].device.state, null);
  assert.equal(groups[0].device.basic, undefined);
  assert.ok(!h.calls.some(args => ['pair', 'install', 'forward'].includes(args[0]) || args.includes('install') || args.join(' ').includes("'am' 'start'")));
  assert.equal(fs.existsSync(path.join(h.root, 'devices.json')), false);
});

test('regular service polling reconnects without opening a dialog or clicking connect', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  service.startPolling();
  for (let i = 0; i < 100 && !h.wifi; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.wifi, true); await service.reconnectWireless();
  assert.equal(service.snapshot().devices.find(d => d.id === h.address).connection, 'device');
});

test('recovery only uses fresh connection endpoints for the known phone, never pairing ports or stale saved IPs', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  h.services = 'adb-OTHER-x _adb-tls-connect._tcp 192.168.1.3:42000\nadb-KNOWN-x _adb-tls-pairing._tcp 192.168.1.9:43000';
  await service.reconnectWireless(); assert.equal(h.connects().length, 0); assert.equal(h.probes.length, 0);
  h.services = null; h.now += 10000; await service.reconnectWireless(); assert.equal(h.connects().length, 1);
  await h.offline(service); h.now += 10000; h.address = '192.168.1.8:45000';
  await service.reconnectWireless(); assert.deepEqual(h.connects().map(args => args[1]), ['192.168.1.9:41000', '192.168.1.8:45000']);
});

test('failed or unreachable endpoints are throttled and new ports can recover immediately on the next scan', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  h.fail = true;
  await Promise.all([service.reconnectWireless(), service.reconnectWireless()]);
  assert.equal(h.connects().length, 1);
  h.now += 10000; await service.reconnectWireless(); assert.equal(h.connects().length, 1);
  h.now += 50000; await service.reconnectWireless(); assert.equal(h.connects().length, 2);
  h.now += 10000; h.address = '192.168.1.9:41001'; h.reachable = false;
  await service.reconnectWireless(); assert.equal(h.connects().length, 2);
  h.now += 10000; h.address = '192.168.1.9:41002'; h.reachable = true; h.fail = false;
  await service.reconnectWireless(); assert.equal(h.connects().length, 3);
});

test('authorization and paused sessions are respected; recovered transport never resumes a disconnected basic session', async t => {
  const h = fixture(t), service = h.create(); await service.refresh();
  h.connection = 'unauthorized'; await service.refresh(); await service.reconnectWireless();
  assert.equal(h.connects().length, 0);
  h.connection = 'device'; await service.refresh(); await service.basicStart('KNOWN', 'view', 'Test', '');
  service.basicControl('KNOWN', 'pause'); await service.reconnectWireless(); assert.equal(h.connects().length, 0);
  await h.offline(service); await service.reconnectWireless();
  assert.equal(h.connects().length, 1);
  assert.equal(service.snapshot().devices.find(d => d.id === 'KNOWN').basic.phase, 'disconnected');
  assert.equal(service.snapshot().devices.find(d => d.id === h.address).basic, undefined);
  assert.equal(groupPhoneDevices(service.snapshot().devices)[0].device.id, h.address, 'a disconnected session cannot hide the recovered transport');
});

test('same-model phones with a different hardware identity are not merged on recovery', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  h.serial = 'OTHER'; await service.reconnectWireless();
  const groups = groupPhoneDevices(service.snapshot().devices);
  assert.equal(groups.length, 2); assert.equal(groups.find(g => g.device.id === 'KNOWN').device.connection, 'missing');
  assert.ok(groups.every(g => !g.device.state && !g.device.basic));
});

test('USB arriving during network discovery cancels the unnecessary Wi-Fi attempt', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  h.probeHook = async () => { h.usb = true; await service.refresh(); };
  await service.reconnectWireless(); assert.equal(h.connects().length, 0);
  assert.equal(service.snapshot().devices[0].connection, 'device');
});

test('closing the service aborts an in-flight reconnect and does not issue further device commands', async t => {
  const h = fixture(t), service = h.create(); await service.refresh(); await h.offline(service);
  let arrived; const started = new Promise(resolve => { arrived = resolve; });
  h.connectHook = signal => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); arrived(); });
  const reconnect = service.reconnectWireless(); await started;
  await service.refresh(); // A stalled Wi-Fi attempt must not block device status polling.
  const before = h.calls.length;
  await service.close(); await reconnect;
  assert.equal(h.calls.length, before);
  await service.reconnectWireless(); assert.equal(h.calls.length, before);
});
