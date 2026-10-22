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

async function interruptedFollower(t, optIn = true) {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'follow', 'app', optIn);
  const host = h.service.gameFollower.host;
  await host.live(owner.lease, owner.device.state.generation, { op: 'probe' });
  h.hook = method => { if (method === 'follow') throw Object.assign(new Error('TLS transport lost'), { code: 'ECONNRESET' }); };
  await assert.rejects(host.live(owner.lease, owner.device.state.generation,
    { op: 'touch', sequence: 1, points: [{ id: 0, x: 30, y: 40 }], ttlMs: 1200 }), /TLS transport lost/);
  h.hook = null;
  return { h, owner, host };
}

test('opt-in follower repairs only its same route and session without replay, start or resume', async t => {
  const { h, owner, host } = await interruptedFollower(t);
  const before = h.calls.length;
  // A concurrent ordinary poll must not pause this explicitly recovering lease.
  await h.service.refresh();
  const resumed = await host.recoverWrapper(owner.lease, owner.device.state.generation);
  assert.equal(resumed.state.sessionId, owner.device.state.sessionId);
  assert.equal(resumed.state.generation, owner.device.state.generation);
  assert.equal(resumed.state.phase, 'controlling');
  assert.ok(h.calls.slice(before).some(call => call.includes('tcp:0')));
  assert.ok(h.calls.slice(before).some(call => call[0] === 'sync'));
  assert.equal(h.calls.slice(before).some(call => ['follow', 'start', 'resume', 'pause', 'action'].includes(call[0])), false);
});

test('default follower still stops rather than reconciling a lost connection', async t => {
  const { h, owner, host } = await interruptedFollower(t, false);
  await assert.rejects(host.recoverWrapper(owner.lease, owner.device.state.generation), /不能恢复/);
  await h.service.refresh();
  assert.equal(h.state.phase, 'paused');
  assert.equal(h.calls.filter(call => call[0] === 'resume').length, 0);
});

test('recovery rejects phone pause, stop, changed generation, owner, instance or mode', async t => {
  for (const patch of [{ phase: 'paused' }, { phase: 'stopped' }, { phase: 'disconnected' },
    { generation: 99 }, { sessionId: 'different-owner' }, { instanceId: 'restarted-app' }, { mode: 'view' }]) {
    const { h, owner, host } = await interruptedFollower(t);
    Object.assign(h.state, patch);
    await assert.rejects(host.recoverWrapper(owner.lease, owner.device.state.generation), /已改变|有效会话/);
    assert.equal(h.calls.filter(call => call[0] === 'resume').length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'start').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'follow').length, 2);
  }
});

test('expired wrapper and stop during a reconnect cannot inherit the returned live session', async t => {
  const expired = await interruptedFollower(t);
  expired.h.now += 8001;
  await assert.rejects(expired.host.recoverWrapper(expired.owner.lease, expired.owner.device.state.generation), /已结束或失联/);
  const { h, owner, host } = await interruptedFollower(t), entered = deferred(), pending = deferred(); let first = true;
  h.hook = method => { if (method === 'sync' && first) { first = false; entered.resolve(); return pending.promise; } };
  const recovering = host.recoverWrapper(owner.lease, owner.device.state.generation);
  const rejected = assert.rejects(recovering, /取消|失联|已改变/);
  await entered.promise; await h.service.stopWrapper(owner.lease);
  pending.resolve({ ok: true, state: structuredClone(h.state) }); await rejected;
  assert.equal(h.state.phase, 'stopped'); assert.equal(h.calls.filter(call => call[0] === 'resume').length, 0);
});

test('a poll begun before transport loss cannot pause or invalidate the recovered route', async t => {
  for (const lateFailure of [false, true]) {
    const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'follow', 'app', true);
    const host = h.service.gameFollower.host;
    await host.live(owner.lease, owner.device.state.generation, { op: 'probe' });
    const poll = deferred(), entered = deferred(); let first = true;
    h.hook = method => {
      if (method === 'sync' && first) { first = false; entered.resolve(); return poll.promise; }
      if (method === 'follow') throw Error('transport lost');
    };
    const polling = h.service.refresh(); await entered.promise;
    await assert.rejects(host.live(owner.lease, owner.device.state.generation,
      { op: 'touch', sequence: 1, points: [], ttlMs: 1200 }), /transport lost/);
    await host.recoverWrapper(owner.lease, owner.device.state.generation);
    if (lateFailure) poll.reject(new Error('late old poll failure'));
    else poll.resolve({ ok: true, state: structuredClone(h.state) });
    await polling;
    const current = h.service.pulseWrapper(owner.lease);
    assert.equal(current.state.phase, 'controlling'); assert.equal(current.companion, 'ready');
    assert.equal(h.calls.filter(call => call[0] === 'pause').length, 0);
    assert.equal(h.calls.filter(call => call.includes('--remove')).length, 1);
  }
});

test('a late forward after the recovery deadline is removed without installing a route', { timeout: 3500 }, async t => {
  const { h, owner, host } = await interruptedFollower(t), pending = deferred();
  const run = h.service.adb.run; let signal;
  h.service.adb.run = (args, timeout, input, abort) => {
    if (args.includes('tcp:0')) { signal = abort; return pending.promise; }
    return run(args, timeout, input, abort);
  };
  const recovered = host.recoverWrapper(owner.lease, owner.device.state.generation);
  await assert.rejects(recovered, /两秒/); assert.equal(signal.aborted, true);
  pending.resolve('18763'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.routes.has(h.id), false);
  assert.ok(h.calls.some(call => call.includes('--remove') && call.includes('tcp:18763')));
  assert.throws(() => h.service.pulseWrapper(owner.lease), /已结束或断开/);
});
