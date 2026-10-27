const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { discoveryInterfaces, discoveryReply } = loadCli('src/main/phones/lan-discovery.ts');
const adapter = { address: '192.168.8.20', netmask: '255.255.255.0', family: 'IPv4', internal: false };
const nonce = 'a'.repeat(32);
const reply = { protocol: 'profilepilot-discovery-v1', type: 'phone', nonce, id: 'b5547b10-3843-487b-ab31-46ec92cf5854', name: '手机 <&>', version: '0.3.6-dev', variant: 'debug', wirelessDebugging: 'disabled' };
const packet = value => Buffer.from(JSON.stringify(value));
test('Windows and macOS adapter names do not affect LAN selection', () => {
  for (const name of ['Wi-Fi', 'Ethernet', 'en0', 'en7']) {
    assert.deepEqual(discoveryInterfaces({ [name]: [adapter], lo: [{ ...adapter, internal: true }], public: [{ ...adapter, address: '8.8.8.8' }] }), [adapter]);
  }
});
test('an unpaired App with debugging disabled is discoverable without trusting supplied IP or credentials', () => {
  const result = discoveryReply(packet({ ...reply, ip: '8.8.8.8', token: 'secret', hardwareId: 'pretend' }), '192.168.8.9', nonce, [adapter]);
  assert.deepEqual(result, { id: reply.id, name: reply.name, version: reply.version, variant: 'debug', wirelessDebugging: 'disabled', ip: '192.168.8.9' });
});
test('stale, malformed, oversized and off-subnet discovery packets are ignored', () => {
  for (const value of [{ ...reply, nonce: 'b'.repeat(32) }, { ...reply, protocol: 'other' }, { ...reply, type: 'scan' }, { ...reply, wirelessDebugging: 'yes' }, { ...reply, name: 'x'.repeat(101) }, { ...reply, id: 'serial' }]) {
    assert.equal(discoveryReply(packet(value), '192.168.8.9', nonce, [adapter]), undefined);
  }
  assert.equal(discoveryReply(packet(reply), '192.168.9.9', nonce, [adapter]), undefined);
  assert.equal(discoveryReply(Buffer.alloc(2049), '192.168.8.9', nonce, [adapter]), undefined);
  assert.equal(discoveryReply(Buffer.from('{'), '192.168.8.9', nonce, [adapter]), undefined);
});
test('nearby Apps are returned when ADB is unavailable, without refreshing disconnected control routes', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { PhonesService } = loadCli('src/main/phones/service.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lan-test-'));
  const app = discoveryReply(packet(reply), '192.168.8.9', nonce, [adapter]);
  const calls = [];
  const service = new PhonesService({ root, apkPath: '', discoverNearbyApps: async () => ({ apps: [app], appError: '' }),
    adb: { run: async args => { calls.push(args); throw Error('ADB unavailable'); } } });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const found = await service.discoverWireless();
  assert.deepEqual(found.apps, [app]); assert.ok(found.error);
  assert.deepEqual(calls, [['mdns', 'services']], 'App discovery does not depend on ADB devices/companion refresh');
});
