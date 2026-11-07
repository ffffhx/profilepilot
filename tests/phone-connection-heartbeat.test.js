const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-connection-'));
  const token = 'a'.repeat(64), id = '192.168.1.9:41000';
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ KNOWN: { token, hardwareId: 'KNOWN' } }));
  const h = { id, now: 100000, serial: 'KNOWN', calls: [],
    state: { protocol: 1, instanceId: 'phone', sessionId: null, generation: 0, phase: 'idle', mode: 'control',
      computer: 'pc', controller: '', task: '', startedAt: null, lastAction: '',
      permissions: { overlay: true, notifications: true, accessibility: true } } };
  h.service = new PhonesService({ root, apkPath: '', now: () => h.now,
    adb: { run: async args => {
      h.calls.push(['adb', ...args]);
      if (args[0] === 'devices') return h.discovery ? h.discovery() : `${id} device model:Phone`;
      if (args[3] === "'getprop' 'ro.serialno'") return h.serial;
      if (args.includes('tcp:0')) return '19000';
      if (args[3]?.includes("'pm' 'path'")) return 'package:/data/app/base.apk';
      return '';
    } }, request: async (port, received, method) => {
      assert.equal(received, token); h.calls.push([method]);
      if (h.request) await h.request();
      if (method === 'pause' || method === 'stop') { h.state.phase = method === 'pause' ? 'paused' : 'stopped'; h.state.generation++; }
      return { ok: true, state: structuredClone(h.state) };
    } });
  t.after(async () => { await h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('a new Wi-Fi endpoint restores an existing physical phone pairing without installing or launching', async t => {
  const h = fixture(t);
  const device = (await h.service.refresh()).devices.find(d => d.id === h.id);
  assert.equal(device.companion, 'ready');
  assert.equal(h.service.saved[h.id].hardwareId, 'KNOWN');
  assert.ok(!h.calls.some(c => c.includes('install') || c.join(' ').includes("'am' 'start'")));
});

test('restored pairing pauses lingering control instead of inheriting its session', async t => {
  const h = fixture(t); h.state.phase = 'controlling'; h.state.sessionId = 'old-session';
  await h.service.refresh(); assert.equal(h.state.phase, 'paused');
  assert.ok(!h.calls.some(c => c[0] === 'start' || c[0] === 'resume'));
});

test('new Wi-Fi endpoints respect a physical phone App disconnect', async t => {
  const h = fixture(t); h.service.appDisconnected.add('hardware:KNOWN');
  await h.service.refresh();
  assert.equal(h.service.saved[h.id], undefined); assert.equal(h.service.routes.size, 0);
});

test('discovering a second transport does not interrupt a controller on the established route', async t => {
  const h = fixture(t); h.discovery = () => 'KNOWN device model:Phone';
  await h.service.refresh(); h.calls.length = 0;
  h.state.phase = 'controlling'; h.state.sessionId = 'current-controller';
  h.discovery = () => `KNOWN device model:Phone\n${h.id} device model:Phone`;
  await h.service.refresh();
  assert.equal(h.service.saved[h.id], undefined); assert.equal(h.state.phase, 'controlling');
  assert.ok(!h.calls.some(c => c[0] === 'pause' || c[0] === 'stop' || c[0] === 'resume'));
});

test('an unrelated or unverified phone never receives saved pairing credentials', async t => {
  for (const serial of ['OTHER', 'unknown', '']) {
    const h = fixture(t); h.serial = serial; await h.service.refresh();
    assert.equal(h.service.saved[h.id], undefined); assert.equal(h.service.routes.size, 0);
  }
});

test('polling keeps heartbeats flowing while ADB discovery stalls beyond the phone lease', async t => {
  const h = fixture(t); await h.service.refresh();
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  h.discovery = () => blocked; h.service.startPolling();
  try {
    for (let i = 0; i < 6; i++) {
      h.now += 2000; t.mock.timers.tick(2000);
      await h.service.pulseConnections();
      assert.equal(h.service.snapshot().devices.find(d => d.id === h.id).confirmedAt, h.now);
    }
  } finally { release(`${h.id} device model:Phone`); await h.service.refresh(); }
});

test('a slow heartbeat is not queued repeatedly and an intentional disconnect stays disconnected', async t => {
  const h = fixture(t); await h.service.refresh(); h.now += 2000;
  let release; h.request = () => new Promise(resolve => { release = resolve; });
  const before = h.calls.filter(c => c[0] === 'sync').length;
  const first = h.service.pulseConnections(), second = h.service.pulseConnections();
  assert.equal(h.calls.filter(c => c[0] === 'sync').length, before + 1);
  h.request = null; release(); await Promise.all([first, second]);
  await h.service.disconnect(h.id); h.now += 2000; await h.service.pulseConnections();
  assert.equal(h.service.routes.size, 0);
});

test('independent heartbeats revoke an expired wrapper even when discovery is blocked', async t => {
  const h = fixture(t); await h.service.refresh();
  h.state.phase = 'controlling'; h.state.sessionId = 'abandoned';
  h.service.wrappers.set(randomUUID(), { id: h.id, instanceId: 'phone', sessionId: 'abandoned', seenAt: h.now - 8001, closing: false, backend: 'app' });
  h.now += 2000; await h.service.pulseConnections();
  for (let i = 0; i < 20 && h.service.wrappers.size; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.phase, 'stopped'); assert.equal(h.service.wrappers.size, 0);
});
