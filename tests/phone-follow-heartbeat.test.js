const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-follow-heartbeat-'));
  const id = '192.0.2.20:37001', token = 'c'.repeat(64);
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ [id]: { token } }));
  const h = { id, calls: [], now: 1000, hook: null, discovery: null,
    state: { protocol: 1, instanceId: 'phone-instance', sessionId: null, generation: 0,
      phase: 'idle', mode: 'control', computer: 'pc', controller: '', task: '', startedAt: null,
      lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true } } };
  h.service = new PhonesService({ root, apkPath: path.join(root, 'phone.apk'), computer: 'pc', now: () => h.now,
    adb: { run: async args => {
      h.calls.push(['adb', ...args]);
      if (args[0] === 'devices') { if (h.discovery) await h.discovery.promise; return `${id} device model:Test_Phone`; }
      if (args.includes('tcp:0')) return '18762';
      return '';
    } },
    request: async (port, received, method, body) => {
      assert.equal(received, token);
      h.calls.push([method, body]);
      if (h.hook) { const response = await h.hook(method, body); if (response) return response; }
      if (method === 'start') Object.assign(h.state, { ...body, generation: h.state.generation + 1,
        phase: body.mode === 'view' ? 'viewing' : 'controlling', startedAt: h.now });
      if (method === 'stop') { h.state.generation++; h.state.phase = 'stopped'; }
      if (method === 'pause') { h.state.generation++; h.state.phase = 'paused'; }
      return { ok: true, state: structuredClone(h.state) };
    } });
  t.after(async () => { h.hook = null; h.discovery?.resolve(); await h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Exercise the real service adapter used by GameFollower, not a mock host.
  h.heartbeat = lease => h.service.gameFollower.host.syncWrapper(lease);
  return h;
}

test('follow phone heartbeat bypasses a blocked ADB discovery poll', { timeout: 2000 }, async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'follow');
  h.discovery = deferred();
  const polling = h.service.refresh();
  const before = h.calls.filter(call => call[0] === 'sync').length;
  const device = await h.heartbeat(owner.lease);
  assert.equal(device.state.sessionId, owner.device.state.sessionId);
  assert.equal(device.state.phase, 'controlling');
  assert.equal(h.calls.filter(call => call[0] === 'sync').length, before + 1);
  h.discovery.resolve(); await polling;
});

test('late previous-run heartbeat failure cannot invalidate a newly confirmed phone lease', async t => {
  const h = harness(t), old = await h.service.startWrapper(h.id, 'control', 'Agent', 'old follow');
  const pending = deferred(), entered = deferred(); let first = true;
  h.hook = method => {
    if (method === 'sync' && first) { first = false; entered.resolve(); return pending.promise; }
  };
  const obsolete = h.heartbeat(old.lease);
  const rejected = assert.rejects(obsolete, /已结束或失联/);
  await entered.promise;
  await h.service.stopWrapper(old.lease);
  const next = await h.service.startWrapper(h.id, 'control', 'Agent', 'new follow');
  pending.reject(new Error('late old heartbeat timeout'));
  await rejected;
  const current = h.service.pulseWrapper(next.lease);
  assert.equal(current.state.sessionId, next.device.state.sessionId);
  assert.equal(current.state.phase, 'controlling');
  assert.equal(h.calls.filter(call => call.includes('--remove')).length, 0);
});

test('independent heartbeat reports phone-side revocation without resuming it', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'follow');
  h.state.phase = 'disconnected'; h.state.generation++;
  const device = await h.heartbeat(owner.lease);
  assert.equal(device.state.phase, 'disconnected');
  assert.ok(device.state.generation > owner.device.state.generation);
  assert.throws(() => h.service.pulseWrapper(owner.lease), /已结束或断开/);
  assert.equal(h.calls.filter(call => call[0] === 'resume').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'start').length, 1);
});

test('heartbeat failure still revokes the route when newer evidence is no longer fresh', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'follow');
  const pending = deferred(), entered = deferred(); let first = true;
  h.hook = method => {
    if (method === 'sync' && first) { first = false; entered.resolve(); return pending.promise; }
  };
  const failed = h.heartbeat(owner.lease);
  const rejected = assert.rejects(failed, /heartbeat lost/);
  await entered.promise;
  await h.heartbeat(owner.lease);
  h.now += 1501;
  pending.reject(new Error('heartbeat lost'));
  await rejected;
  assert.equal(h.service.snapshot().devices[0].companion, 'unavailable');
  assert.throws(() => h.service.pulseWrapper(owner.lease), /已结束或断开/);
  assert.equal(h.calls.filter(call => call.includes('--remove')).length, 1);
});
