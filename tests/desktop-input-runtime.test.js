const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsInputRuntime, closeInputControl } = loadCli('src/main/desktop/input-runtime.ts');

// In-memory transport only; no native executable, hook or user input is used.
class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); writes = [];
  stdin = new PassThrough();
  constructor() { super(); this.stdin.on('data', data => this.writes.push(data.toString())); }
  kill() { return true; }
  message(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  close() { this.emit('exit', 0); this.emit('close', 0); }
}
function fixture() {
  const children = [], pauses = [];
  const runtime = new WindowsInputRuntime({ createEpoch: () => 'runtime-epoch', spawn: () => { const child = new Child(); children.push(child); return child; } });
  const desktop = runtime.observeDesktop(event => pauses.push(event));
  const child = () => children.at(-1);
  const ready = () => child().message({ type: 'status', status: 'ready' });
  const ack = generation => child().message({ type: 'desktop-armed', epoch: 'runtime-epoch', generation, sequence: '0' });
  const close = async () => { const pending = runtime.dispose(); child()?.close(); await pending; };
  return { runtime, desktop, children, pauses, child, ready, ack, close };
}

function keepBrowser(f) {
  const browser = f.runtime.browserGuard({ onClick() {} });
  browser.sync([42]); f.ready();
  f.child().message({ type: 'status', status: 'tap-active', pid: 42 });
  f.child().message({ type: 'status', status: 'sync-complete', activeCount: 1 });
  return browser;
}

function bindingHistoryEntries(binding) {
  return Object.values(binding).reduce((count, value) => count + (value instanceof Set || value instanceof Map ? value.size : 0), 0);
}

test('App input runtime is lazy and rejects concurrent or detached desktop bindings', async () => {
  const f = fixture(), browser = f.runtime.browserGuard({ onClick() {} });
  browser.sync([]); assert.equal(f.children.length, 0);
  assert.throws(() => f.runtime.observeDesktop(() => {}), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
  f.desktop.detach(); f.desktop.detach();
  await assert.rejects(f.desktop.arm('old', '1234'), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
  assert.throws(() => f.desktop.snapshot(), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
  const replacement = f.runtime.observeDesktop(() => {});
  assert.equal(replacement.snapshot().connected, false);
  replacement.detach(); browser.dispose(); await f.close();
});

test('browser and desktop share one process while desktop detach preserves browser protection', async () => {
  const f = fixture(), statuses = [];
  const browser = f.runtime.browserGuard({ onClick() {}, onStatus: value => statuses.push(value) });
  browser.sync([42]); f.ready();
  f.child().message({ type: 'status', status: 'tap-active', pid: 42 });
  f.child().message({ type: 'status', status: 'sync-complete', activeCount: 1 });
  const armed = f.desktop.arm('g1', 'fedcba9876543210'); f.ack('g1'); await armed;
  assert.equal(f.children.length, 1); assert.equal(f.desktop.snapshot().desktop.phase, 'ready');
  assert.ok(statuses.some(value => value.status === 'guard-active' && value.activeCount === 1));
  f.child().message({ type: 'input-activity', epoch: 'runtime-epoch', generation: 'g1', sequence: '1', kind: 'keyboard', injected: true, marker: 'fedcba9876543210' });
  assert.equal(f.pauses.length, 0);
  f.child().message({ type: 'input-activity', epoch: 'runtime-epoch', generation: 'g1', sequence: '2', kind: 'keyboard', injected: false });
  assert.equal(f.pauses.length, 1); assert.equal(f.desktop.snapshot().desktop.phase, 'paused');
  f.desktop.detach();
  assert.equal(f.runtime.snapshot().transport.state, 'ready');
  assert.deepEqual(f.runtime.snapshot().browserProtection.activePids, [42]);
  assert.equal(f.child().writes.some(value => value.includes('QUIT')), false);
  browser.dispose(); assert.ok(f.child().writes.at(-1).includes('QUIT')); await f.close();
});

test('detaching a pending arm cancels it and late native acknowledgements cannot revive the service', async () => {
  const f = fixture();
  const pending = f.desktop.arm('pending', 'abcd'); f.ready();
  const rejected = assert.rejects(pending, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
  f.desktop.detach(); await rejected;
  f.ack('pending'); assert.equal(f.pauses.length, 0);
  assert.equal(f.runtime.snapshot().transport.state, 'stopping'); await f.close();
});

test('a detached binding cannot disarm, replace or receive activity for its ready successor', async () => {
  const f = fixture(), browser = keepBrowser(f), successorPauses = [];
  try {
    const first = f.desktop.arm('g1', '1234'); f.ack('g1'); await first;
    f.desktop.detach();
    const successor = f.runtime.observeDesktop(event => successorPauses.push(event));
    const next = successor.arm('g2', '5678'); f.ack('g2'); await next;
    const writes = [...f.child().writes];
    f.desktop.disarm('g2'); f.desktop.disarm('g1'); f.desktop.detach();
    await assert.rejects(f.desktop.arm('g3', 'abcd'), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    assert.throws(() => f.desktop.snapshot(), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    assert.equal(successor.snapshot().desktop.phase, 'ready'); assert.deepEqual(f.child().writes, writes);
    f.child().message({ type: 'input-activity', epoch: 'runtime-epoch', generation: 'g2', sequence: '1', kind: 'keyboard', injected: false });
    assert.equal(f.pauses.length, 0); assert.equal(successorPauses.length, 1);
    successor.detach();
  } finally { browser.dispose(); await f.close(); }
});

test('detach cancels a transmitted REARM without ending the shared browser subscription', async () => {
  const f = fixture(), browser = keepBrowser(f);
  try {
    const first = f.desktop.arm('g1', '1234'); f.ack('g1'); await first;
    const pending = f.desktop.arm('g2', '5678');
    const rejected = assert.rejects(pending, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    assert.equal(f.desktop.snapshot().desktop.previousGeneration, 'g1');
    f.desktop.detach(); await rejected;
    const state = f.runtime.snapshot();
    assert.equal(state.pendingGeneration, null); assert.equal(state.desktop, null);
    assert.equal(state.transport.state, 'ready'); assert.deepEqual(state.browserProtection.activePids, [42]);
    assert.ok(f.child().writes.some(line => line.startsWith('REARM runtime-epoch g1 g2 ')));
    assert.equal(f.child().writes.filter(line => line === 'DISARM runtime-epoch g2\n').length, 1);
    f.ack('g2'); assert.equal(f.runtime.snapshot().desktop, null);
  } finally { browser.dispose(); await f.close(); }
});

test('detach reserves the slot against synchronous write callbacks until its cleanup finishes', async () => {
  const f = fixture(), browser = keepBrowser(f), rejections = [], callbackErrors = []; let reentered = 0;
  try {
    const first = f.desktop.arm('g1', '1234'); f.ack('g1'); await first;
    const duringWrite = data => {
      if (!data.toString().startsWith('DISARM ')) return;
      reentered++;
      try {
        assert.throws(() => f.runtime.observeDesktop(() => {}), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
        assert.throws(() => f.desktop.snapshot(), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
        rejections.push(assert.rejects(f.desktop.arm('during-detach', 'ffff'), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' }));
        f.desktop.disarm('g1'); f.desktop.detach();
      } catch (error) { callbackErrors.push(error); }
    };
    f.child().stdin.on('data', duringWrite);
    f.desktop.detach(); await Promise.all(rejections); assert.equal(reentered, 1); assert.deepEqual(callbackErrors, []);
    const successor = f.runtime.observeDesktop(() => {});
    const next = successor.arm('g2', '5678'); f.ack('g2'); await next;
    f.desktop.disarm('g2'); assert.equal(successor.snapshot().desktop.phase, 'ready');
    f.child().stdin.removeListener('data', duringWrite); successor.detach();
  } finally { browser.dispose(); await f.close(); }
});

test('detach cleans both a pending unsent request and its ready predecessor despite retirement callbacks', async () => {
  const f = fixture(), callbackErrors = []; let attempts = 0;
  const watcher = f.runtime.broker.browser('passive-status-watcher', { onStatus(status) {
    if (status.state !== 'stopping') return;
    attempts++;
    try {
      assert.throws(() => f.runtime.observeDesktop(() => {}), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
      f.desktop.disarm('g1'); f.desktop.detach();
    } catch (error) { callbackErrors.push(error); }
  } });
  try {
    const first = f.desktop.arm('g1', '1234'); f.ready(); f.ack('g1'); await first;
    // Hold the transition at the broker's before-send boundary, exposing both
    // live identities without creating any real transport or native process.
    const startArm = f.runtime.broker.startArm;
    f.runtime.broker.startArm = () => {};
    const pending = f.desktop.arm('g2', '5678'); f.runtime.broker.startArm = startArm;
    const rejected = assert.rejects(pending, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    assert.equal(f.runtime.snapshot().pendingGeneration, 'g2'); assert.equal(f.runtime.snapshot().desktop.generation, 'g1');
    f.desktop.detach(); await rejected;
    assert.equal(attempts, 1); assert.equal(f.pauses.length, 0); assert.deepEqual(callbackErrors, []);
    assert.equal(f.runtime.snapshot().pendingGeneration, null); assert.equal(f.runtime.snapshot().desktop, null);
    assert.equal(f.runtime.snapshot().transport.state, 'stopping');
    const replacement = f.runtime.observeDesktop(() => {}); replacement.detach();
  } finally { watcher.dispose(); await f.close(); }
});

test('invalid and BUSY arm requests retain no binding history and cannot cancel the accepted request', async () => {
  const f = fixture(), binding = f.runtime.desktop;
  try {
    const pending = f.desktop.arm('accepted', '1234');
    const rejected = assert.rejects(pending, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    for (let i = 0; i < 1000; i++) {
      await assert.rejects(f.desktop.arm('invalid#' + i, '1234'), { code: 'DESKTOP_BAD_REQUEST' });
      await assert.rejects(f.desktop.arm('busy-' + i, '1234'), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
      f.desktop.disarm('busy-' + i);
    }
    assert.equal(bindingHistoryEntries(binding), 0);
    assert.equal(f.runtime.broker.generations.size, 1); assert.equal(f.runtime.broker.epochs.size, 1);
    assert.equal(f.runtime.snapshot().pendingGeneration, 'accepted');
    f.desktop.detach(); await rejected;
  } finally { await f.close(); }
});

test('failed startup history stays authoritative in the broker across binding replacement', async () => {
  let calls = 0;
  const runtime = new WindowsInputRuntime({ spawn() { calls++; throw new Error('pure fake spawn failure'); } });
  const desktop = runtime.observeDesktop(() => {}), binding = runtime.desktop;
  try {
    for (let i = 0; i < 1000; i++) await assert.rejects(desktop.arm('failed-' + i, '1234'));
    assert.equal(bindingHistoryEntries(binding), 0); assert.equal(runtime.broker.generations.size, 1000);
    desktop.detach(); const replacement = runtime.observeDesktop(() => {});
    await assert.rejects(replacement.arm('failed-0', '1234'), { code: 'DESKTOP_BAD_REQUEST' });
    assert.equal(calls, 1000); assert.equal(runtime.broker.epochs.size, 1000);
    replacement.detach();
  } finally { await runtime.dispose(); }
});

test('runtime disposal waits for process close and permanently refuses new subscribers', async () => {
  const f = fixture(); const armed = f.desktop.arm('g1', '1234'); f.ready(); f.ack('g1'); await armed;
  let completed = false; const pending = f.runtime.dispose().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  assert.throws(() => f.runtime.browserGuard({ onClick() {} }), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  assert.throws(() => f.runtime.observeDesktop(() => {}), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  await assert.rejects(f.desktop.arm('g2', '5678'), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  f.child().close(); await pending; assert.equal(completed, true); await f.runtime.dispose();
});

test('input shutdown releases both subscribers before broker and still attempts every failed stage', async () => {
  const calls = [], failures = [new Error('desktop'), new Error('overlay')];
  await assert.rejects(closeInputControl({
    closeDesktop() { calls.push('desktop'); throw failures[0]; },
    async closeOverlay() { calls.push('overlay-start'); await Promise.resolve(); calls.push('overlay-end'); throw failures[1]; },
    closeRuntime() { calls.push('runtime'); }
  }), error => { assert.deepEqual(error.failures, failures); return true; });
  assert.deepEqual(calls, ['desktop', 'overlay-start', 'overlay-end', 'runtime']);
});
