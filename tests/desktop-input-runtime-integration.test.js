const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { WindowsInputRuntime, closeInputControl } = loadCli('src/main/desktop/input-runtime.ts');

// The complete production state-machine chain runs against in-memory streams.
// No executable is spawned and no desktop, hook, key or window is inspected.
class Clock {
  next = 0; timers = new Map();
  setTimeout(callback, milliseconds) { const id = ++this.next; this.timers.set(id, { callback, milliseconds }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  run(milliseconds) { for (const [id, timer] of [...this.timers]) if (timer.milliseconds === milliseconds) { this.timers.delete(id); timer.callback(); } }
}
class Input extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0; writes = [];
  write(value) { this.writes.push(value); return true; }
  end(value) { this.writable = false; if (value) this.writes.push(value); }
}
class Child extends EventEmitter {
  stdin = new Input(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { return true; }
  chunk(...values) { this.stdout.emit('data', Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n')); }
  close() { this.emit('exit', 0); this.emit('close', 0); }
}
const target = { id: '1'.repeat(32), title: 'In-memory fixture', pid: 12, process: 'fixture', className: 'Form' };
const version = '2'.repeat(32);
const turn = () => new Promise(resolve => setImmediate(resolve));
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'runtime-integration', ...extra });
function fixture({ interruptRead = false } = {}) {
  const clock = new Clock(), children = [], drivers = [], calls = [], changes = [], trace = [];
  const runtime = new WindowsInputRuntime({ clock, createEpoch: () => 'integration-' + children.length,
    spawn() { const child = new Child(); children.push(child); return child; } });
  const browser = runtime.browserGuard({ onClick() {} });
  const service = new DesktopService({ platform: 'win32', available: () => true, inputObserver: runtime.observeDesktop,
    onChanged(status) { changes.push(status); }, driver() {
      const driver = { index: drivers.length, inputMarker: (drivers.length + 1).toString(16).padStart(16, '0'), closed: false,
        close() { this.closed = true; trace.push('driver:' + this.index); },
        async request(operation) {
          assert.equal(this.closed, false); calls.push({ operation, index: this.index });
          if (operation === 'windows') return { windows: [target] };
          if (operation === 'window.action') return { executed: true };
          if (interruptRead && this.index === 1 && operation === 'window.observe') throw Object.assign(new Error('interrupted'), { code: 'DESKTOP_READ_INTERRUPTED' });
          return { windowId: target.id, version, truncated: false, elements: [] };
        } };
      drivers.push(driver); return driver;
    } });
  const child = () => children.at(-1);
  const envelope = generation => ({ epoch: runtime.snapshot().epoch, generation });
  const ack = generation => ({ type: 'desktop-armed', ...envelope(generation), sequence: '0' });
  const physical = generation => ({ type: 'input-activity', ...envelope(generation), sequence: '1', kind: 'keyboard', injected: false });
  const startBrowser = () => {
    browser.sync([42]); child().chunk({ type: 'status', status: 'ready' },
      { type: 'status', status: 'tap-active', pid: 42 }, { type: 'status', status: 'sync-complete', activeCount: 1 });
  };
  const claim = () => service.execute(command('claim', { windowId: target.id }));
  const activate = async () => { const pending = claim(); await turn(); child().chunk(ack(runtime.snapshot().desktop.generation)); return pending; };
  const close = async () => { service.close(); browser.dispose(); const pending = runtime.dispose(); children.forEach(value => value.close()); await pending; assert.equal(clock.timers.size, 0); };
  return { clock, children, drivers, calls, changes, trace, runtime, service, browser, child, envelope, ack, physical, startBrowser, claim, activate, close };
}

test('runtime chain rejects claim ACK plus physical activity in the same chunk while preserving browser protection', async () => {
  const f = fixture();
  try {
    f.startBrowser(); const pending = f.claim(); await turn(); const generation = f.runtime.snapshot().desktop.generation;
    f.child().chunk(f.ack(generation), f.physical(generation));
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers[1].closed, true);
    assert.equal(f.runtime.snapshot().transport.state, 'ready'); assert.deepEqual(f.runtime.snapshot().browserProtection.activePids, [42]);
    assert.equal(f.child().stdin.writes.some(value => value.includes('QUIT')), false);
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_USER_IN_CONTROL' });
  } finally { await f.close(); }
});

for (const failure of ['activity', 'fault']) test('runtime chain latches predecessor ' + failure + ' during read-recovery REARM', async () => {
  const f = fixture({ interruptRead: true });
  try {
    f.startBrowser(); await f.activate(); const predecessor = f.runtime.snapshot().desktop.generation;
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_READ_INTERRUPTED' });
    const read = f.service.execute(command('observe')); await turn(); const successor = f.runtime.snapshot().desktop.generation;
    assert.notEqual(successor, predecessor);
    assert.ok(f.child().stdin.writes.some(value => value.startsWith('REARM ') && value.includes(predecessor + ' ' + successor)));
    assert.equal(f.child().stdin.writes.some(value => value.startsWith('DISARM ') && value.includes(predecessor)), false);
    const event = failure === 'activity' ? f.physical(predecessor)
      : { type: 'observer-fault', ...f.envelope(predecessor), reason: 'unavailable' };
    f.child().chunk(event, f.ack(successor));
    await assert.rejects(read, { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers[2].closed, true);
    assert.equal(f.child().stdin.writes.some(value => value.startsWith('ARM ') && value.includes(successor)), false);
    assert.equal(f.calls.some(value => value.operation === 'window.observe' && value.index === 2), false);
    assert.equal(f.service.status().inputObservation.certainty, failure === 'activity' ? 'observed' : 'unknown');
    if (failure === 'activity') assert.deepEqual(f.runtime.snapshot().browserProtection.activePids, [42]);
  } finally { await f.close(); }
});

test('runtime chain keeps acknowledged old driver markers across successful continuous read recovery', async () => {
  const f = fixture({ interruptRead: true });
  try {
    f.startBrowser(); await f.activate();
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_READ_INTERRUPTED' });
    const read = f.service.execute(command('observe')); await turn(); const generation = f.runtime.snapshot().desktop.generation;
    f.child().chunk(f.ack(generation)); await read;
    f.child().chunk({ ...f.physical(generation), injected: true, marker: f.drivers[1].inputMarker });
    assert.equal(f.service.status().session.state, 'active');
    f.child().chunk({ ...f.physical(generation), sequence: '2', injected: true, marker: 'fedcba9876543210' });
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.service.status().inputObservation.reason, 'external_input');
  } finally { await f.close(); }
});

test('service close cancels pending runtime ARM without closing the shared browser guard or reviving on late ACK', async () => {
  const f = fixture();
  try {
    f.startBrowser(); const pending = f.claim(); await turn(); const generation = f.runtime.snapshot().desktop.generation;
    f.service.close(); await assert.rejects(pending, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    f.child().chunk(f.ack(generation), f.physical(generation));
    assert.equal(f.service.status().session, null); assert.equal(f.runtime.snapshot().desktop, null);
    assert.deepEqual(f.runtime.snapshot().browserProtection.activePids, [42]);
    assert.equal(f.child().stdin.writes.some(value => value.includes('QUIT')), false);
    assert.equal(f.drivers.every(value => value.closed), true);
  } finally { await f.close(); }
});

test('helper loss closes the active desktop driver and browser restart cannot automatically arm it again', async () => {
  const f = fixture();
  try {
    f.startBrowser(); await f.activate(); const oldChild = f.child(), oldEpoch = f.runtime.snapshot().epoch;
    oldChild.close();
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers[1].closed, true);
    f.clock.run(1000); assert.equal(f.children.length, 2);
    f.child().chunk({ type: 'status', status: 'ready' }, { type: 'status', status: 'tap-active', pid: 42 }, { type: 'status', status: 'sync-complete', activeCount: 1 });
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.child().stdin.writes.some(value => value.startsWith('ARM ')), false);
    const resumed = f.service.resume(); await turn(); const generation = f.runtime.snapshot().desktop.generation;
    f.child().chunk(f.ack(generation)); await resumed;
    oldChild.chunk({ type: 'observer-fault', epoch: oldEpoch, generation, reason: 'unavailable' });
    oldChild.emit('error', new Error('late old child')); assert.equal(f.service.status().session.state, 'active');
  } finally { await f.close(); }
});

test('ordered App shutdown releases desktop drivers and browser subscription before waiting for shared child close', async () => {
  const f = fixture();
  try {
    f.startBrowser(); await f.activate(); let finished = false;
    const closing = closeInputControl({ closeDesktop() { f.trace.push('desktop'); f.service.close(); },
      closeOverlay() { f.trace.push('overlay'); f.browser.dispose(); }, closeRuntime() { f.trace.push('runtime'); return f.runtime.dispose(); }
    }).then(() => { finished = true; });
    await turn(); assert.equal(finished, false); assert.deepEqual(f.trace.slice(-5), ['desktop', 'driver:1', 'driver:0', 'overlay', 'runtime']);
    assert.equal(f.runtime.snapshot().transport.state, 'stopping'); assert.equal(f.child().stdin.writes.at(-1), 'SET\nQUIT\n');
    f.child().close(); await closing; assert.equal(finished, true); assert.equal(f.runtime.snapshot().stopConfirmed, true);
  } finally { await f.close(); }
});
