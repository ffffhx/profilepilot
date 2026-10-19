const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { wirelessCandidates } = loadCli('src/main/phones/wireless.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-port-change-'));
  const old = '192.168.1.9:40000', next = '192.168.1.9:41000';
  const h = { old, next, online: [old], calls: [], scans: 0, now: 1000, serial: 'PHONE', advertisement: old };
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({
    [old]: { token: 'a'.repeat(64), hardwareId: 'PHONE', transport: 'wifi', model: 'Phone' }
  }));
  h.state = { protocol: 1, instanceId: 'companion-instance', sessionId: null, generation: 0,
    phase: 'idle', mode: 'control', computer: 'pc', controller: '', task: '', startedAt: null,
    lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true } };
  h.service = new PhonesService({ root, apkPath: '', now: () => h.now, computer: 'pc',
    probeWireless: async address => ({ reachable: address === next, reason: '端口拒绝连接' }),
    adb: { run: async args => {
      h.calls.push(['adb', ...args]);
      if (args[0] === 'devices') return h.online.map(id => `${id} device model:Phone`).join('\n');
      if (args[0] === 'mdns') { h.scans++; return `adb-PHONE-xyz _adb-tls-connect._tcp ${h.scans > 1 ? next : h.advertisement}`; }
      if (args.includes('tcp:0')) return args[1] === old ? '21001' : '21002';
      if (args[3] === "'getprop' 'ro.serialno'") return h.serial;
      if (args[3]?.startsWith("'pm' 'path'")) return 'package:/app.apk';
      return '';
    } },
    request: async (_port, token, method, body) => {
      assert.equal(token, 'a'.repeat(64)); h.calls.push([method, body]);
      if (method === 'start') Object.assign(h.state, body, { phase: body.mode === 'view' ? 'viewing' : 'controlling', generation: h.state.generation + 1 });
      if (['stop', 'pause', 'resume'].includes(method)) {
        h.state.phase = { stop: 'stopped', pause: 'paused', resume: 'controlling' }[method]; h.state.generation++;
      }
      return { ok: true, state: structuredClone(h.state) };
    }
  });
  t.after(async () => { await h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('Wi-Fi offline and unauthorized errors never ask for USB permission', async t => {
  const h = fixture(t); await h.service.refresh(); h.online = []; await h.service.refresh();
  await assert.rejects(h.service.start(h.old, 'view', 'Codex', 'test'), error => /无线/.test(error.message) && !/USB/.test(error.message));
  h.service.devices.get(h.old).connection = 'unauthorized';
  await assert.rejects(h.service.start(h.old, 'view', 'Codex', 'test'), /无线调试.*配对/);
  h.online = [h.next]; await h.service.refresh();
  h.service.devices.get(h.old).connection = 'offline';
  await assert.rejects(h.service.start(h.old, 'view', 'Codex', 'test'), error => error.message.includes(h.next));
});

test('connect on a former port selects the verified live route without launching or updating the App', async t => {
  const h = fixture(t); await h.service.refresh(); h.online = [h.next]; await h.service.refresh(); h.calls.length = 0;
  const connected = await h.service.prepare(h.old, false);
  assert.equal(connected.id, h.next); assert.equal(connected.companion, 'ready');
  assert.ok(!h.calls.some(call => ['start', 'resume', 'stop'].includes(call[0]) || call.includes('install') || call.some(arg => String(arg).includes("'am' 'start'"))));
});

test('connection-only preparation preserves a manually paused session and fresh start still refuses it', async t => {
  const h = fixture(t); await h.service.refresh();
  await h.service.start(h.old, 'control', 'User', 'manual task'); await h.service.control(h.old, 'pause');
  h.online = [h.next]; await h.service.refresh(); h.calls.length = 0;
  const connected = await h.service.prepare(h.old, false);
  assert.equal(connected.state.phase, 'paused'); assert.equal(connected.state.controller, 'User');
  await assert.rejects(h.service.start(h.next, 'control', 'Codex', 'replacement'), /已有会话/);
  assert.ok(!h.calls.some(call => ['start', 'resume', 'stop', 'pause'].includes(call[0])));
  assert.equal(h.service.snapshot().devices.find(d => d.id === h.old).state, null, 'old transport cannot remain a second owner');
});

test('a newly prepared route pauses lingering control instead of inheriting its input authority', async t => {
  const h = fixture(t); await h.service.refresh();
  const original = await h.service.start(h.old, 'control', 'Codex', 'old task');
  h.online = [h.next]; await h.service.refresh(); h.calls.length = 0;
  const connected = await h.service.prepare(h.old, false);
  assert.equal(connected.state.phase, 'paused');
  assert.equal(connected.state.sessionId, original.state.sessionId);
  assert.equal(h.calls.filter(call => call[0] === 'pause').length, 1);
  assert.ok(!h.calls.some(call => ['start', 'resume', 'action'].includes(call[0])));
  await assert.rejects(h.service.perform({ id: h.next, sessionId: connected.state.sessionId,
    generation: connected.state.generation, requestId: randomUUID(), action: { kind: 'key', key: 'home' } }), /暂停/);
});

test('connection-only preparation leaves an already confirmed active route unchanged', async t => {
  const h = fixture(t); await h.service.refresh();
  const original = await h.service.start(h.old, 'view', 'Codex', 'current task'); h.calls.length = 0;
  const connected = await h.service.prepare(h.old, false);
  assert.equal(connected.state.phase, 'viewing'); assert.equal(connected.state.generation, original.state.generation);
  assert.ok(!h.calls.some(call => ['start', 'resume', 'pause', 'stop'].includes(call[0])));
});

test('closing a failed managed task after a port change ends only its exact owned session', async t => {
  const h = fixture(t), owner = await h.service.startWrapper(h.old, 'control', 'Codex', 'install');
  h.online = []; await h.service.refresh();
  await assert.rejects(h.service.stopWrapper(owner.lease), /无线/);
  h.state.phase = 'paused'; h.state.generation++;
  h.online = [h.next]; await h.service.refresh();
  await h.service.prepare(h.old, false); h.calls.length = 0;
  await h.service.refresh();
  assert.equal(h.state.phase, 'stopped'); assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
  assert.ok(!h.calls.some(call => ['start', 'resume', 'action'].includes(call[0]) || call.includes('install')));
  await assert.rejects(h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'key', key: 'home' }, randomUUID()), /结束|失联/);
  assert.equal(h.service.wrappers.size, 0);
});

test('deferred managed cleanup never ends a replacement session or companion instance', async t => {
  for (const replaceInstance of [false, true]) {
    const h = fixture(t), owner = await h.service.startWrapper(h.old, 'control', 'Codex', 'old task');
    h.online = []; await h.service.refresh(); await assert.rejects(h.service.stopWrapper(owner.lease));
    if (replaceInstance) h.state.instanceId = 'restarted-companion';
    else h.state.sessionId = 'new-user-session';
    h.state.phase = 'paused'; h.state.generation++;
    h.online = [h.next]; await h.service.refresh(); await h.service.prepare(h.next, false); h.calls.length = 0;
    await h.service.refresh();
    assert.equal(h.state.phase, 'paused'); assert.ok(!h.calls.some(call => call[0] === 'stop'));
    assert.equal(h.service.wrappers.size, 0);
  }
});

test('same model on a different physical phone cannot redirect a stale connect request', async t => {
  const h = fixture(t); await h.service.refresh(); h.online = [h.next]; h.serial = 'OTHER'; await h.service.refresh();
  await assert.rejects(h.service.prepare(h.old, false), /无线/);
  assert.equal(h.service.snapshot().devices.find(d => d.id === h.next).companion, 'unknown');
});

test('discovery refreshes unreachable cached advertisements once, without changing ADB or phone state', async t => {
  const h = fixture(t); h.online = [];
  const result = await h.service.discoverWireless(h.old);
  assert.equal(h.scans, 2); assert.deepEqual(result.services.map(s => s.address), [h.next]);
  assert.equal(result.services[0].reachable, true);
  assert.ok(!h.calls.some(call => ['start', 'stop', 'resume'].includes(call[0]) || ['connect', 'kill-server', 'pair', 'install'].includes(call[1])));
});

test('fresh direct App observations supersede old cloud addresses; expired observations do not', () => {
  const route = { id: 'USB', hardwareId: 'PHONE', transport: 'usb', connection: 'device', companion: 'ready', confirmedAt: 2000,
    state: { readiness: { network: { wifiIpv4: ['192.168.1.9'], adbEndpoints: [] } } },
    cloud: { paired: true, reportedAt: 1000, report: { readiness: { network: { wifiIpv4: ['192.168.1.8'], adbEndpoints: [] } } } } };
  const advertisements = ['192.168.1.8:40000', '192.168.1.9:41000'].map(address => ({ name: 'adb-PHONE-xyz', kind: 'connect', address }));
  assert.deepEqual(wirelessCandidates(advertisements, [route], 3000).services.map(s => s.address), ['192.168.1.9:41000']);
  assert.equal(wirelessCandidates(advertisements, [route], 50000).services.length, 2);
  route.connection = 'missing';
  assert.deepEqual(wirelessCandidates(advertisements, [route], 3000).phoneIps, ['192.168.1.8']);
});

test('verified live Wi-Fi endpoint is discoverable even when mDNS reports only its old port', async t => {
  const h = fixture(t); h.online = [h.next];
  const result = await h.service.discoverWireless();
  assert.equal(h.scans, 1);
  assert.equal(result.services[0].address, h.next); assert.equal(result.services[0].source, 'adb');
  assert.equal(result.services[0].reachable, true);
});
