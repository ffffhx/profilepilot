const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsInputBroker } = loadCli('src/main/desktop/input-broker.ts');
const { WindowsBrowserInputGuard } = loadCli('src/main/desktop/browser-input-guard.ts');
const { MacInputGuard } = loadCli('src/main/input-guard.ts');
const { AgentOverlayManager } = loadCli('src/main/agent-overlay.ts');

// All child processes, streams and clocks are fake. No native helper, GUI,
// Electron connection, process sampler, real input or OS hook is started.
class Clock {
  now = 0; next = 0; tasks = new Map();
  setTimeout(callback, milliseconds) { const id = ++this.next; this.tasks.set(id, { at: this.now + milliseconds, callback }); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  tick(milliseconds) {
    const end = this.now + milliseconds;
    for (let count = 0; count < 1000; count++) {
      const item = [...this.tasks].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!item) { this.now = end; return; }
      this.now = item[1].at; this.tasks.delete(item[0]); item[1].callback();
    }
    throw new Error('Unbounded timer loop');
  }
}
class Input extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0; writes = []; blocked = false;
  write(line, _encoding, callback) { this.writes.push(line); callback?.(); return !this.blocked; }
  end(line) { this.writes.push(line); this.writable = false; }
}
class Child extends EventEmitter {
  stdin = new Input(); stdout = new PassThrough(); stderr = new PassThrough();
  message(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  kill() { return true; }
  close() { this.emit('exit', 0); this.emit('close', 0); }
}
function setup() {
  const clock = new Clock(), children = [], pauses = []; let epoch = 0;
  const broker = new WindowsInputBroker({ clock, createEpoch: () => 'e' + ++epoch, onPause: value => pauses.push(value),
    spawn: () => { const child = new Child(); children.push(child); return child; },
    startupTimeoutMs: 100, armTimeoutMs: 100, browserConfigTimeoutMs: 80, drainTimeoutMs: 60, stopTimeoutMs: 20, killTimeoutMs: 20, restartDelayMs: 10 });
  const child = () => children.at(-1), emit = value => child().message(value);
  const status = (value, extra = {}) => emit({ type: 'status', status: value, ...extra });
  const guard = id => {
    const clicks = [], statuses = [];
    const controller = new WindowsBrowserInputGuard({ broker, subscriptionId: id, clock, healthRetryMs: 20,
      onClick: value => clicks.push(value), onStatus: value => statuses.push(value) });
    return { controller, clicks, statuses, health: () => statuses.filter(value => value.status.startsWith('guard-')).at(-1) };
  };
  const confirm = pids => { for (const pid of pids) status('tap-active', { pid }); status('sync-complete', { activeCount: pids.length }); };
  const close = async () => { const pending = broker.dispose(); child()?.close(); await pending; };
  return { clock, children, pauses, broker, child, emit, status, guard, confirm, close };
}
const mouse = (phase, patch = {}) => ({ type: 'mouse', pid: 12, phase, button: 0, x: 30, y: 40, windowId: 99,
  timestamp: phase === 'down' ? 1000 : 2000, displayScale: 1.25, window: { x: 0, y: 0, width: 200, height: 100 }, ...patch });

test('adapter construction is inert and union health is computed for each subscription', async () => {
  const f = setup(), a = f.guard('a'), b = f.guard('b'); assert.equal(f.children.length, 0);
  a.controller.sync([12]); b.controller.sync([34]); f.status('ready');
  assert.equal(a.health().status, 'guard-unavailable'); assert.equal(b.health().status, 'guard-unavailable');
  f.confirm([12, 34]);
  for (const value of [a, b]) {
    assert.equal(value.health().status, 'guard-active'); assert.equal(value.health().activeCount, 1);
    assert.equal(value.statuses.filter(status => status.status === 'sync-complete').at(-1).activeCount, 1);
  }
  a.controller.dispose(); b.controller.dispose(); await f.close();
});

test('global activeCount alone cannot manufacture PID protection', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready');
  f.status('sync-complete', { activeCount: 1 });
  assert.equal(a.health().status, 'guard-unavailable'); assert.equal(f.broker.snapshot().browserProtection.verified, false);
  assert.equal(f.broker.snapshot().transport.state, 'stopping'); await f.close();
});

test('protection commits before sync-complete and late overlapping subscribers reuse same-epoch evidence', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const b = f.guard('b'); b.controller.sync([12]); assert.equal(b.health().status, 'guard-active');
  const receipts = [];
  const raw = f.broker.browser('raw', { onLegacyMessage: message => { if (message.status === 'sync-complete') receipts.push(f.broker.snapshot().browserProtection); } });
  raw.sync([12]); f.status('sync-complete', { activeCount: 1 }); f.status('sync-complete', { activeCount: 1 });
  assert.ok(receipts.every(value => value.verified && value.activePids.join(',') === '12'));
  assert.equal(f.broker.snapshot().browserProtection.pendingConfigurations, 0);
  a.controller.dispose(); assert.equal(b.health().status, 'guard-active'); await f.close();
});

test('pending SET never confirms new PIDs and configuration timeout retires without retry accumulation', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready');
  f.clock.tick(79); assert.equal(f.child().stdin.writes.filter(line => line.startsWith('SET')).length, 1);
  assert.equal(a.health().status, 'guard-unavailable'); assert.equal(f.broker.snapshot().browserProtection.pendingConfigurations, 1);
  f.clock.tick(1); assert.equal(f.broker.snapshot().transport.state, 'stopping'); assert.equal(f.broker.snapshot().browserProtection.verified, false);
  await f.close();
});

test('a new PID stays unavailable while an unchanged confirmed subscriber remains healthy', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const b = f.guard('b'); b.controller.sync([34]);
  assert.equal(a.health().status, 'guard-active'); assert.equal(b.health().status, 'guard-unavailable');
  f.status('tap-active', { pid: 34 }); assert.equal(b.health().status, 'guard-unavailable');
  f.status('sync-complete', { activeCount: 2 }); assert.equal(b.health().status, 'guard-active'); await f.close();
});

test('failed PID health retries only after a completed configuration and preserves other subscribers', async () => {
  const f = setup(), a = f.guard('a'), b = f.guard('b'); a.controller.sync([12]); b.controller.sync([34]); f.status('ready');
  f.status('tap-active', { pid: 12 }); f.status('tap-create-failed', { pid: 34 }); f.status('sync-complete', { activeCount: 1 });
  assert.equal(a.health().status, 'guard-active'); assert.equal(b.health().status, 'guard-unavailable');
  f.clock.tick(20); assert.equal(f.child().stdin.writes.at(-1), 'SET 12 34\n');
  const writes = f.child().stdin.writes.length; f.clock.tick(20); assert.equal(f.child().stdin.writes.length, writes);
  f.status('tap-active', { pid: 34 }); f.status('sync-complete', { activeCount: 2 });
  assert.equal(b.health().status, 'guard-active'); assert.equal(f.children.length, 1); await f.close();
});

test('one removed PID revokes its subscription immediately without borrowing another PID health', async () => {
  const f = setup(), a = f.guard('a'), b = f.guard('b'); a.controller.sync([12]); b.controller.sync([34]); f.status('ready'); f.confirm([12, 34]);
  f.status('tap-removed', { pid: 12 }); assert.equal(a.health().status, 'guard-unavailable'); assert.equal(b.health().status, 'guard-active');
  assert.deepEqual(f.broker.snapshot().browserProtection.activePids, [34]); await f.close();
});

test('down/up pairing matches the existing Mac policy for valid and rejected geometry', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const macClicks = []; const mac = new MacInputGuard({ platform: 'linux', onClick: value => macClicks.push(value) });
  const cases = [
    [{}, {}], [{}, { windowId: 100 }], [{}, { timestamp: 999 }], [{}, { timestamp: 2_000_001_001 }],
    [{}, { displayScale: 1.5 }], [{}, { window: { x: 1, y: 0, width: 200, height: 100 } }],
    [{}, { window: { x: 0.75, y: 0, width: 200, height: 100 } }], [{}, { window: null }],
    [{ window: { x: 0, y: 0, width: 0, height: 100 } }, {}], [{ button: 1 }, { button: 1 }],
    [{ button: 2 }, { button: 2 }], [{ windowId: 0 }, { windowId: 0 }], [{}, { x: null }]
  ];
  for (const [down, up] of cases) for (const message of [mouse('down', down), mouse('up', up)]) {
    f.emit(message); mac.handleStdout(JSON.stringify(message) + '\n');
  }
  assert.deepEqual(a.clicks, macClicks); assert.equal(a.clicks.length, 2); mac.dispose(); await f.close();
});

test('unconfirmed PID, stale up, unrelated PID and sync boundaries cannot produce a click', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready');
  f.emit(mouse('down')); f.confirm([12]); f.emit(mouse('up')); assert.equal(a.clicks.length, 0);
  f.emit(mouse('down', { pid: 34 })); f.emit(mouse('up', { pid: 34 })); assert.equal(a.clicks.length, 0);
  f.emit(mouse('down')); a.controller.sync([12]); f.status('sync-complete', { activeCount: 1 }); f.emit(mouse('up'));
  assert.equal(a.clicks.length, 0); await f.close();
});

test('helper replacement clears gestures and PID evidence while old-child status cannot change new health', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]); f.emit(mouse('down'));
  const old = f.child(); old.close(); f.clock.tick(10); f.status('ready');
  assert.equal(a.health().status, 'guard-unavailable'); f.confirm([12]);
  old.message({ type: 'status', status: 'tap-removed', pid: 12 }); old.message({ type: 'status', status: 'sync-complete', activeCount: 0 });
  assert.equal(a.health().status, 'guard-active'); f.emit(mouse('up')); assert.equal(a.clicks.length, 0); await f.close();
});

test('dispose removes only its browser lease and never stops an armed desktop or another subscriber', async () => {
  const f = setup(), a = f.guard('a'), b = f.guard('b'); a.controller.sync([12]); b.controller.sync([34]); f.status('ready'); f.confirm([12, 34]);
  const ready = f.broker.arm('desktop', '1234'); f.emit({ type: 'desktop-armed', epoch: 'e1', generation: 'desktop', sequence: '0' }); await ready;
  a.controller.dispose(); assert.equal(f.child().stdin.writes.at(-1), 'SET 34\n');
  b.controller.dispose(); assert.equal(f.child().stdin.writes.at(-1), 'SET\n');
  assert.equal(f.child().stdin.writable, true); assert.equal(f.broker.snapshot().desktop.phase, 'ready');
  a.controller.sync([99]); assert.deepEqual(f.broker.snapshot().browserPids, []); await f.close();
});

test('queued removal cannot be undone by an older sync receipt while re-addition is still pending', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const b = f.guard('b'); b.controller.sync([34]); // SET 12 34 pending
  a.controller.sync([]); // SET 34 pending; revoke 12 now
  a.controller.sync([12]); // SET 12 34 pending
  f.status('tap-active', { pid: 34 }); f.status('sync-complete', { activeCount: 2 });
  assert.equal(a.health().status, 'guard-unavailable');
  f.status('tap-removed', { pid: 12 }); f.status('sync-complete', { activeCount: 1 });
  assert.equal(a.health().status, 'guard-unavailable');
  f.status('tap-active', { pid: 12 }); f.status('sync-complete', { activeCount: 2 });
  assert.equal(a.health().status, 'guard-active'); await f.close();
});

test('overlay factory receives the existing click chain and health callbacks without starting its default guard', async () => {
  let callbacks, calls = 0; const syncs = [], clicks = []; let disposed = 0;
  const manager = new AgentOverlayManager({ onStop: async () => {}, inputGuardFactory: value => {
    callbacks = value; calls++; return { sync: pids => syncs.push(pids), dispose: () => { disposed++; } };
  } });
  manager.handleInputGuardClick = async value => { clicks.push(value); };
  callbacks.onClick({ marker: 'first' }); callbacks.onClick({ marker: 'second' }); await manager.guardClickChain;
  callbacks.onStatus({ type: 'status', status: 'guard-active' }); assert.equal(manager.inputGuardState, 'active');
  callbacks.onStatus({ type: 'status', status: 'guard-unavailable' }); assert.equal(manager.inputGuardState, 'unavailable');
  assert.deepEqual(clicks, [{ marker: 'first' }, { marker: 'second' }]); assert.equal(calls, 1);
  manager.sync({ enabled: false, ports: [] }); await manager.dispose(); assert.equal(disposed, 1); assert.ok(syncs.every(value => value.length === 0));
});

test('explicit overlay guard retains precedence and omitted factory retains the old default path', async () => {
  let disposed = 0;
  const manager = new AgentOverlayManager({ onStop: async () => {}, inputGuard: { sync() {}, dispose() { disposed++; } }, inputGuardFactory() { throw new Error('must not run'); } });
  await manager.dispose(); assert.equal(disposed, 1);
  const legacy = new AgentOverlayManager({ onStop: async () => {} });
  assert.equal(legacy.inputGuard.constructor.name, 'MacInputGuard'); await legacy.dispose(); // No nonempty sync => no child.
});

test('ProfileManager forwards the optional factory without collecting state or starting maintenance', async () => {
  const { ProfileManager } = loadCli('src/main/profile-manager.ts');
  let callbacks, disposed = 0;
  const manager = new ProfileManager(require('node:path').resolve(__dirname, 'unused-pure-fixture'), {}, {
    inputGuardFactory(value) { callbacks = value; return { sync() {}, dispose() { disposed++; } }; }
  });
  assert.equal(typeof callbacks.onClick, 'function'); assert.equal(typeof callbacks.onStatus, 'function');
  await manager.agentOverlayManager.dispose(); assert.equal(disposed, 1);
});

test('a SET queued behind stdin backpressure is not acknowledged by an earlier configuration receipt', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  f.child().stdin.blocked = true; a.controller.sync([12]);
  const b = f.guard('b'); b.controller.sync([34]);
  assert.equal(f.child().stdin.writes.at(-1), 'SET 12\n');
  f.status('sync-complete', { activeCount: 1 });
  assert.equal(b.health().status, 'guard-unavailable'); assert.equal(f.broker.snapshot().browserProtection.pendingConfigurations, 1);
  f.clock.tick(20); assert.equal(f.child().stdin.writes.at(-1), 'SET 12\n');
  f.child().stdin.blocked = false; f.child().stdin.emit('drain'); assert.equal(f.child().stdin.writes.at(-1), 'SET 12 34\n');
  f.status('tap-active', { pid: 34 }); f.status('sync-complete', { activeCount: 2 }); assert.equal(b.health().status, 'guard-active');
  await f.close();
});

test('unacknowledged SET history is bounded and snapshot mutation cannot forge health', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const snapshot = f.broker.snapshot().browserProtection; snapshot.activePids.push(999); snapshot.verified = false;
  assert.deepEqual(f.broker.snapshot().browserProtection.activePids, [12]); assert.equal(f.broker.snapshot().browserProtection.verified, true);
  for (let count = 0; count < 64; count++) a.controller.sync([12]);
  assert.equal(f.broker.snapshot().browserProtection.pendingConfigurations, 64);
  assert.throws(() => a.controller.sync([12]), /send_failed/);
  assert.equal(f.broker.snapshot().browserProtection.verified, false); assert.equal(f.broker.snapshot().transport.state, 'stopping'); await f.close();
});

test('empty browser subscription does not turn the overlay idle state into a health failure', async () => {
  const f = setup(), a = f.guard('a'); a.controller.sync([]); assert.equal(a.statuses.length, 0);
  a.controller.sync([12]); f.status('ready'); f.confirm([12]);
  const before = a.statuses.filter(value => value.status.startsWith('guard-')).length;
  a.controller.sync([]);
  assert.equal(a.statuses.filter(value => value.status.startsWith('guard-')).length, before);
  await f.close();
});
