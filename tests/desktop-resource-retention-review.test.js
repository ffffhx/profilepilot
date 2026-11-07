// Read-only review of current retention policy. These are characterization
// tests, not claims of a real App/native leak or desired permanent limits.
// All drivers, input pipes and observer timers are fake; no OS/UI calls occur.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { WindowsInputRuntime } = loadCli('src/main/desktop/input-runtime.ts');
const target = { id: 'a'.repeat(32), title: 'Owned pure fixture', pid: 41, process: 'fixture', className: 'Form' };
const turn = () => new Promise(resolve => setImmediate(resolve));
const command = (method, session, extra = {}) => ({ action: 'desktop', method, session, ...extra });

class Clock {
  next = 0; timers = new Map(); peak = 0;
  setTimeout(callback, delay) { const id = ++this.next; this.timers.set(id, { callback, delay }); this.peak = Math.max(this.peak, this.timers.size); return id; }
  clearTimeout(id) { this.timers.delete(id); }
}
function runtimeFixture() {
  const clock = new Clock(); let spawned = 0, exited = 0;
  class Child extends EventEmitter {
    stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = new EventEmitter(); closed = false;
    constructor() {
      super();
      Object.assign(this.stdin, { writable: true, destroyed: false, writableLength: 0,
        write: (text, _encoding, callback) => {
          const parts = text.trim().split(' ');
          queueMicrotask(() => {
            callback?.();
            if (parts[0] === 'SET') {
              const pids = parts.slice(1).map(Number);
              for (const pid of pids) this.message({ type: 'status', status: 'tap-active', pid });
              this.message({ type: 'status', status: 'sync-complete', activeCount: pids.length });
            } else if (parts[0] === 'ARM' || parts[0] === 'REARM') {
              this.message({ type: 'desktop-armed', epoch: parts[1], generation: parts[parts[0] === 'ARM' ? 2 : 3], sequence: '0' });
            }
          });
          return true;
        },
        end: () => queueMicrotask(() => { if (!this.closed) { this.closed = true; exited++; this.emit('exit', 0); this.emit('close', 0); } })
      });
      queueMicrotask(() => this.message({ type: 'status', status: 'ready' }));
    }
    message(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
    kill() { assert.fail('No fake child requires forced cleanup'); }
  }
  const runtime = new WindowsInputRuntime({ clock, createEpoch: () => 'epoch-' + (spawned + 1), spawn: () => { spawned++; return new Child(); } });
  return { runtime, clock, get spawned() { return spawned; }, get exited() { return exited; } };
}
function serviceFixture(runtime, overrides = {}) {
  let created = 0, closed = 0, actions = 0;
  const service = new DesktopService({ platform: 'win32', available: () => true,
    ...(runtime ? { inputObserver: runtime.observeDesktop } : { allowUnobservedTestDriver: true }),
    driver: () => {
      const marker = (++created).toString(16).padStart(16, '0'); let stopConfirmed = false;
      return { inputMarker: marker, get stopConfirmed() { return stopConfirmed; },
        close() { if (!stopConfirmed) { stopConfirmed = true; closed++; } },
        async request(operation, params) {
          assert.equal(stopConfirmed, false);
          if (overrides.request) return overrides.request(operation, params);
          if (operation === 'windows') return { windows: [target] };
          if (operation === 'window.action') { actions++; return { executed: true, requiresObservation: true }; }
          assert.ok(['window.observe', 'window.screenshot'].includes(operation));
          return { windowId: target.id, version: randomUUID().replaceAll('-', ''), elements: [], gaps: [], truncated: false,
            ...(operation === 'window.screenshot' ? { image: { data: 'ZmFrZQ==', mimeType: 'image/jpeg', width: 1, height: 1, coordinateInputAvailable: false } } : {}) };
        }
      };
    } });
  return { service, get created() { return created; }, get closed() { return closed; }, get actions() { return actions; } };
}
const history = (service, runtime) => ({ ended: service.ended.size, receipts: service.receipts.size,
  brokerGenerations: runtime.broker.generations.size, brokerEpochs: runtime.broker.epochs.size,
  observerGenerations: runtime.broker.observer.generations.size, observerEpochs: runtime.broker.observer.epochs.size,
  markers: runtime.broker.observer.markers.size, pointerMarkers: runtime.broker.observer.pointerMarkers.size });

test('completed fake read/image cycles retire live state but retain one name and generation/epoch history per cycle', async t => {
  const f = runtimeFixture(), s = serviceFixture(f.runtime), samples = [];
  try {
    for (let i = 1; i <= 600; i++) {
      const session = 'resource-review-' + i;
      await s.service.execute(command('claim', session, { windowId: target.id }));
      await s.service.execute(command('observe', session));
      const shot = await s.service.execute(command('screenshot', session, { screenshotOnly: true }));
      assert.equal(shot.image.data, 'ZmFrZQ==');
      await s.service.execute(command('complete', session, { requireActive: true }));
      await turn();
      assert.equal(s.service.owner, undefined); assert.equal(s.service.retiringDrivers.size, 0);
      assert.equal(s.service.waiting, undefined); assert.equal(s.service.busy, false);
      assert.equal(f.runtime.broker.child, null); assert.equal(f.runtime.broker.pendingArm, null);
      assert.equal(f.runtime.broker.browserConfigurations.length, 0); assert.equal(f.clock.timers.size, 0);
      if (i === 100 || i === 300 || i === 600) samples.push(history(s.service, f.runtime));
    }
    assert.deepEqual(samples.map(row => row.ended), [100, 300, 600]);
    for (const key of ['brokerGenerations', 'brokerEpochs', 'observerGenerations', 'observerEpochs'])
      assert.deepEqual(samples.map(row => row[key]), [100, 300, 600], key);
    assert.deepEqual(samples.map(row => row.receipts), [0, 0, 0]);
    assert.deepEqual(samples.map(row => row.markers), [1, 1, 1]);
    assert.equal(s.created - s.closed, 1, 'only the catalog remains live');
    assert.equal(f.spawned, 600); assert.equal(f.exited, 600); assert.equal(s.actions, 0);
    await assert.rejects(s.service.execute(command('claim', 'resource-review-1', { windowId: target.id })), { code: 'DESKTOP_SESSION_ENDED' });
    await assert.rejects(f.runtime.broker.arm([...f.runtime.broker.generations.keys()][0], '2'), { code: 'DESKTOP_BAD_REQUEST' });
    t.diagnostic(JSON.stringify({ scope: 'pure object counts, not App/native memory', samples, fakeChildrenExited: f.exited, timerPeak: f.clock.peak }));
  } finally { await s.service.close(); await f.runtime.dispose(); }
  assert.equal(s.created, s.closed); assert.equal(f.clock.timers.size, 0);
});

test('a browser keeping one observer epoch alive retains each acknowledged desktop marker until epoch replacement', async t => {
  const f = runtimeFixture(), desktop = f.runtime.observeDesktop(() => {});
  const browser = f.runtime.broker.browser('owned-fake-browser'); browser.sync([41]); await turn();
  try {
    for (let i = 1; i <= 600; i++) {
      await desktop.arm('shared-generation-' + i, i.toString(16)); desktop.disarm('shared-generation-' + i);
    }
    const broker = f.runtime.broker, observer = broker.observer;
    assert.equal(f.spawned, 1); assert.equal(f.exited, 0);
    assert.equal(broker.generations.size, 600); assert.equal(observer.generations.size, 600);
    assert.equal(broker.epochs.size, 1); assert.equal(observer.epochs.size, 1);
    assert.equal(observer.markers.size, 600); assert.equal(observer.pointerMarkers.size, 600);
    assert.equal(broker.browserConfigurations.length, 0); assert.equal(f.clock.timers.size, 0);
    t.diagnostic(JSON.stringify({ scope: 'pure acknowledged-marker retention, no input', generations: broker.generations.size,
      keyboardMarkers: observer.markers.size, pointerMarkers: observer.pointerMarkers.size, epochs: observer.epochs.size }));
  } finally { desktop.detach(); browser.dispose(); await f.runtime.dispose(); }
  assert.equal(f.runtime.broker.browsers.size, 0); assert.equal(f.runtime.broker.observer.browsers.size, 0);
  assert.equal(f.clock.timers.size, 0); assert.equal(f.exited, 1);
});

test('action receipts retain at most 256 results including optional observations after task completion', async () => {
  const f = serviceFixture(), session = 'receipt-resource-review', requests = [];
  try {
    await f.service.execute(command('claim', session, { windowId: target.id }));
    let observation = await f.service.execute(command('observe', session));
    for (let i = 0; i < 300; i++) {
      const requestId = randomUUID(); requests.push(requestId);
      const result = await f.service.execute(command('action', session, { requestId, observeAfter: true, params: { kind: 'invoke', ref: 'e0', version: observation.version } }));
      observation = result.observation;
      assert.ok(f.service.receipts.size <= 256);
    }
    await f.service.execute(command('complete', session, { requireActive: true }));
    assert.equal(f.service.receipts.size, 256); assert.equal(f.actions, 300); assert.equal(f.service.ended.size, 1);
    await assert.rejects(f.service.execute(command('receipt', session, { requestId: requests[0] })), { code: 'DESKTOP_RECEIPT_UNAVAILABLE' });
    const receipt = await f.service.execute(command('receipt', session, { requestId: requests.at(-1) }));
    assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.historical, true); assert.ok(receipt.result.observation);
    assert.equal(f.actions, 300);
  } finally { await f.service.close(); }
});

test('a blocked catalog accepts every queued preview; stale UI previews are not coalesced by the service', async t => {
  let release, windows = 0, screenshots = 0;
  const stalled = new Promise(resolve => { release = resolve; });
  const f = serviceFixture(undefined, { request: async operation => {
    if (operation === 'windows') { windows++; if (windows === 1) await stalled; return { windows: [target] }; }
    assert.equal(operation, 'window.screenshot'); screenshots++;
    return { windowId: target.id, version: 'b'.repeat(32), elements: [], image: null };
  } });
  try {
    const previews = Array.from({ length: 100 }, () => f.service.preview(target.id));
    await turn(); assert.equal(windows, 1); assert.equal(screenshots, 0);
    release(); await Promise.all(previews);
    assert.equal(windows, 100); assert.equal(screenshots, 100);
    t.diagnostic('100 pending preview calls accepted and later dispatched 100 screenshots; no request cap/coalescing. Fake transport only.');
  } finally { release(); await f.service.close(); }
});
