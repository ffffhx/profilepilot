const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsInputBroker } = loadCli('src/main/desktop/input-broker.ts');

// Every process, stream and timer here is fake. No helper path, spawn(), hook,
// desktop sampler, management endpoint or native executable is used.
class FakeClock {
  now = 0; next = 0; timers = new Map();
  setTimeout(callback, milliseconds) { const id = ++this.next; this.timers.set(id, { at: this.now + milliseconds, callback }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  tick(milliseconds) {
    const until = this.now + milliseconds;
    for (let count = 0; count < 1000; count++) {
      const entry = [...this.timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) { this.now = until; return; }
      this.now = entry[1].at; this.timers.delete(entry[0]); entry[1].callback();
    }
    throw new Error('Unexpected timer loop');
  }
}
class FakeInput extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0;
  writes = []; callbacks = []; blocked = false; failWrite = false; failEnd = false;
  write(text, _encoding, callback) {
    if (this.failWrite) throw new Error('private-write-details');
    this.writes.push(text); this.callbacks.push(callback); return !this.blocked;
  }
  end(text) { if (this.failEnd) throw new Error('private-end-details'); if (text) this.writes.push(text); this.writable = false; }
}
class FakeChild extends EventEmitter {
  stdin = new FakeInput(); stdout = new PassThrough(); stderr = new PassThrough(); kills = 0;
  kill() { this.kills++; return true; }
  message(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  bytes(value) { this.stdout.emit('data', Buffer.from(value)); }
  close() { this.emit('exit', 0); this.emit('close', 0); }
}
const marker = 'fedcba9876543210';
function fixture(options = {}) {
  const clock = new FakeClock(), children = [], pauses = []; let epoch = 0;
  const broker = new WindowsInputBroker({ clock, createEpoch: () => 'epoch-' + ++epoch,
    spawn: () => { const child = new FakeChild(); children.push(child); return child; },
    onPause: event => pauses.push(event), startupTimeoutMs: 100, armTimeoutMs: 100, drainTimeoutMs: 50,
    stopTimeoutMs: 30, killTimeoutMs: 30, restartDelayMs: 10, ...options });
  const child = () => children.at(-1);
  const ready = () => child().message({ type: 'status', status: 'ready', pid: 0 });
  const ack = (generation = 'g1', fields = {}) => child().message({ type: 'desktop-armed', epoch: broker.snapshot().transport.epoch, generation, sequence: '0', ...fields });
  const activity = (generation = 'g1', fields = {}) => child().message({ type: 'input-activity', epoch: broker.snapshot().transport.epoch, generation, sequence: '1', kind: 'keyboard', injected: false, ...fields });
  const arm = async (generation = 'g1', value = marker) => {
    const promise = broker.arm(generation, value); if (broker.snapshot().transport.state === 'starting') ready(); ack(generation); await promise;
  };
  const close = async () => { const pending = broker.dispose(); child()?.close(); await pending; };
  return { broker, clock, children, pauses, child, ready, ack, activity, arm, close };
}
const mouse = pid => ({ type: 'mouse', pid, phase: 'down', button: 0, x: 10, y: 20,
  windowId: 99, timestamp: 2000, displayScale: 1.25, window: { x: 0, y: 0, width: 500, height: 300 } });
const startupFailure = win32Error => ({ type: 'startup-failure', stage: 'instance-gate', win32Error });

for (const [win32Error, reason, code] of [
  [183, 'instance_in_use', 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY'],
  [5, 'instance_access_denied', 'DESKTOP_INPUT_OBSERVER_ACCESS_UNAVAILABLE'],
  [6, 'instance_gate_failed', 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE'],
  [0xffffffff, 'instance_gate_failed', 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE']
]) test('bounded startup failure survives late frames and close: ' + win32Error, async () => {
  const f = fixture(), statuses = [], legacy = [];
  f.broker.browser('browser', { onStatus: value => statuses.push(value), onLegacyMessage: value => legacy.push(value) });
  const rejected = assert.rejects(f.broker.arm('g1', marker), error => {
    assert.equal(error.code, code); assert.equal(error.reason, reason);
    assert.deepEqual(error.details, { inputObserver: { stage: 'instance-gate', win32Error } }); return true;
  });
  const child = f.child(); child.message(startupFailure(win32Error)); await rejected;
  assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].reason, reason);
  assert.deepEqual(f.pauses[0].startupFailure, startupFailure(win32Error));
  assert.equal(f.broker.snapshot().transport.reason, reason);
  assert.equal(child.stdin.writes.some(text => /SET|ARM/.test(text)), false);
  // A callback or snapshot consumer cannot mutate the retained diagnostic.
  f.broker.snapshot().transport.startupFailure.win32Error = 99;
  statuses.at(-1).startupFailure.win32Error = 100;
  child.message(startupFailure(5)); child.message({ type: 'status', status: 'ready' }); child.emit('error', new Error('private'));
  child.close(); child.message(startupFailure(6)); child.emit('close', 0);
  assert.deepEqual(f.broker.snapshot().transport, { state: 'stopped', epoch: 'epoch-1', reason, startupFailure: startupFailure(win32Error) });
  assert.equal(f.broker.snapshot().stopConfirmed, true); assert.equal(legacy.length, 0);
  f.clock.tick(1000); assert.equal(f.children.length, 1); assert.equal(f.pauses.length, 1); await f.close();
});

test('startup exit-first drains split diagnostic despite closing stdin, without sending configuration or ARM', async () => {
  const f = fixture(), rejected = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY' });
  const child = f.child(), bytes = Buffer.from(JSON.stringify(startupFailure(183)) + '\n');
  child.bytes(bytes.subarray(0, 19)); child.emit('exit', 2); child.stdin.emit('close');
  child.stdin.emit('error', new Error('EPIPE private')); child.stderr.emit('error', new Error('tail'));
  assert.equal(f.pauses.length, 0); assert.equal(f.broker.snapshot().transport.state, 'starting');
  child.bytes(bytes.subarray(19)); child.stdout.emit('end'); child.emit('close', 2); await rejected;
  assert.deepEqual(child.stdin.writes, []); assert.equal(child.kills, 0);
  assert.equal(f.broker.snapshot().transport.reason, 'instance_in_use'); await f.close();
});

for (const ending of ['end', 'close', 'deadline', 'ready']) test('startup exit without diagnostic fails boundedly, no SET or ARM: ' + ending, async () => {
  const f = fixture(), rejected = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  const child = f.child(); child.emit('exit', 2);
  if (ending === 'end') child.stdout.emit('end');
  else if (ending === 'close') child.emit('close', 2);
  else if (ending === 'ready') f.ready();
  else f.clock.tick(100);
  await rejected; assert.equal(f.pauses.length, 1); assert.deepEqual(child.stdin.writes, []);
  assert.equal(f.broker.snapshot().transport.startupFailure, undefined);
  child.emit('close', 2); assert.equal(child.kills, 0); await f.close();
});

test('startup diagnostic rejects extra fields, wrong stage and malformed DWORD', async () => {
  for (const message of [ { ...startupFailure(183), ownerPath: 'private' }, { ...startupFailure(183), stage: 'hook' },
    ...[-1, 0x100000000, 1.5, '183', null, true].map(win32Error => startupFailure(win32Error)), { type: 'startup-failure', stage: 'instance-gate' } ]) {
    const f = fixture(), rejected = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
    f.child().message(message); await rejected; assert.equal(f.pauses[0].reason, 'protocol_error');
    assert.equal(f.broker.snapshot().transport.startupFailure, undefined); await f.close();
  }
});

test('startup failure after ready is a protocol failure; stderr never supplies diagnostics', async () => {
  const f = fixture(); await f.arm();
  f.child().stderr.emit('data', Buffer.from('INPUT_OBSERVER_INSTANCE_UNAVAILABLE:183\n' + JSON.stringify(startupFailure(183))));
  assert.equal(f.broker.snapshot().desktop.phase, 'ready');
  f.child().message(startupFailure(183)); assert.equal(f.pauses[0].reason, 'protocol_error');
  assert.equal(f.broker.snapshot().transport.startupFailure, undefined); await f.close();
});

test('browser retry waits for failed child close and does not carry startup failure or desktop demand into a new epoch', async () => {
  const f = fixture(); f.broker.browser('browser').sync([42]);
  const rejected = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY' });
  const old = f.child(); old.message(startupFailure(183)); await rejected;
  f.clock.tick(10); assert.equal(f.children.length, 1); old.close(); f.clock.tick(10);
  assert.equal(f.children.length, 2); assert.equal(f.broker.snapshot().transport.startupFailure, undefined);
  old.message(startupFailure(5)); f.ready();
  assert.deepEqual(f.child().stdin.writes, ['SET 42\n']); assert.equal(f.broker.snapshot().desktop, null);
  assert.equal(f.pauses.length, 1); await f.close();
});

test('stop-unconfirmed adds its barrier state without losing the first startup diagnostic', async () => {
  const f = fixture(), rejected = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY' });
  f.child().message(startupFailure(183)); await rejected; f.clock.tick(60);
  assert.equal(f.broker.snapshot().transport.reason, 'stop_unconfirmed');
  assert.deepEqual(f.broker.snapshot().transport.startupFailure, startupFailure(183));
  f.child().close(); f.child().message(startupFailure(5)); f.clock.tick(1000);
  assert.equal(f.broker.snapshot().stopConfirmed, false); assert.equal(f.children.length, 1);
  assert.deepEqual(f.broker.snapshot().transport.startupFailure, startupFailure(183));
  await assert.rejects(f.broker.dispose(), { code: 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED' });
});

test('broker construction and empty subscriptions never start a process', async () => {
  assert.throws(() => new WindowsInputBroker({ onPause() {} }), /Explicit spawn/);
  const f = fixture(); const browser = f.broker.browser('a'); browser.sync([]); browser.dispose();
  assert.equal(f.children.length, 0); assert.equal(f.broker.snapshot().transport.state, 'stopped'); await f.close();
});

test('browser PID union is deduplicated, bounded across subscribers and updated independently', async () => {
  const f = fixture(), a = f.broker.browser('a'), b = f.broker.browser('b');
  a.sync([30, 10, 30]); b.sync([20, 30]); assert.equal(f.children.length, 1);
  f.ready(); assert.equal(f.child().stdin.writes[0], 'SET 10 20 30\n');
  a.dispose(); assert.equal(f.child().stdin.writes.at(-1), 'SET 20 30\n');
  assert.deepEqual(f.broker.snapshot().browserPids, [20, 30]);
  const c = f.broker.browser('c'); b.sync(Array.from({ length: 256 }, (_, index) => index + 1));
  assert.throws(() => c.sync([257]), /browser_pid_union_limit/);
  assert.equal(f.broker.snapshot().browserPids.length, 256);
  assert.throws(() => f.broker.browser('b'), /invalid_browser_subscription/);
  assert.throws(() => c.sync([0]), /invalid_browser_pids/); await f.close();
});

test('desktop arm waits for native ready, command delivery, and matching epoch/generation acknowledgement', async () => {
  const f = fixture(); const pending = f.broker.arm('g1', 'F'); let resolved = false;
  void pending.then(() => { resolved = true; });
  assert.deepEqual(f.child().stdin.writes, []); f.ready();
  assert.deepEqual(f.child().stdin.writes, ['SET\n', 'ARM epoch-1 g1 000000000000000f\n']);
  f.ack('old'); f.ack('g1', { epoch: 'old' }); await Promise.resolve(); assert.equal(resolved, false);
  f.ack(); assert.equal((await pending).phase, 'ready');
  assert.equal(f.broker.snapshot().desktop.generation, 'g1'); await f.close();
});

test('browser sync empty cannot stop desktop, and desktop disarm cannot stop browser', async () => {
  const f = fixture(), browser = f.broker.browser('a'); browser.sync([42]); f.ready(); await f.arm();
  browser.sync([]); assert.equal(f.child().stdin.writable, true); assert.equal(f.broker.snapshot().desktop.phase, 'ready');
  browser.sync([43]); f.broker.disarm('g1');
  assert.equal(f.child().stdin.writes.at(-1), 'DISARM epoch-1 g1\n'); assert.equal(f.child().stdin.writable, true);
  assert.deepEqual(f.broker.snapshot().browserPids, [43]);
  browser.dispose(); assert.equal(f.child().stdin.writes.at(-1), 'SET\nQUIT\n'); await f.close();
});

test('legacy mouse/status events are validated and scoped without cloning click pairing', async () => {
  const f = fixture(), seenA = [], seenB = [], statuses = [];
  f.broker.browser('a', { onLegacyMessage: message => seenA.push(message), onStatus: status => statuses.push(status) }).sync([12]);
  f.broker.browser('b', { onLegacyMessage: message => seenB.push(message) }).sync([34]);
  f.ready(); f.child().message(mouse(12)); f.child().message({ type: 'status', status: 'tap-active', pid: 34 });
  assert.equal(seenA.filter(message => message.type === 'mouse').length, 1);
  assert.equal(seenB.filter(message => message.type === 'mouse').length, 0);
  assert.equal(seenA.some(message => message.pid === 34), false);
  assert.equal(seenB.some(message => message.pid === 34), true);
  assert.ok(statuses.some(value => value.state === 'ready')); await f.close();
});

test('split UTF-8 lines and multiple CRLF frames remain bounded and discard unknown legacy fields', async () => {
  const f = fixture(), seen = [];
  f.broker.browser('a', { onLegacyMessage: message => seen.push(message) }).sync([12]); f.ready();
  const bytes = Buffer.from(JSON.stringify({ ...mouse(12), ignored: '中文🧪' }) + '\r\n');
  for (const byte of bytes) f.child().bytes([byte]);
  f.child().bytes(JSON.stringify({ type: 'status', status: 'tap-active', pid: 12 }) + '\n' + JSON.stringify({ type: 'status', status: 'sync-complete', activeCount: 1 }) + '\n');
  assert.equal(seen.filter(value => value.type === 'mouse').length, 1);
  assert.ok(!JSON.stringify(seen).includes('中文')); assert.equal(f.broker.snapshot().transport.state, 'ready'); await f.close();
});

test('physical activity before arm acknowledgement pauses once and cannot be revived by a late acknowledgement', async () => {
  const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker)); f.ready(); f.activity(); await pending;
  f.ack(); assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].reason, 'physical_input');
  assert.equal(f.broker.snapshot().desktop.phase, 'paused'); f.child().close(); f.clock.tick(1000);
  assert.equal(f.children.length, 1, 'Desktop demand never restarts itself'); await f.close();
});

test('known injected markers remain recognized across explicitly armed generations', async () => {
  const f = fixture(), browser = f.broker.browser('a'); browser.sync([12]); f.ready(); await f.arm();
  f.broker.disarm('g1'); await f.arm('g2', '1234');
  f.activity('g2', { injected: true, marker }); assert.equal(f.pauses.length, 0);
  f.activity('g2', { injected: true, marker: '99', sequence: '2' });
  assert.equal(f.pauses[0].reason, 'external_input'); assert.equal(f.child().stdin.writable, true); await f.close();
});

test('helper exit pauses desktop and only browser demand restarts with SET, never ARM', async () => {
  const f = fixture(), browser = f.broker.browser('a'); browser.sync([12]); f.ready(); await f.arm();
  f.child().emit('exit', 1); assert.equal(f.pauses[0].reason, 'helper_exited');
  f.clock.tick(10); assert.equal(f.children.length, 1, 'Wait for stream/process close confirmation');
  f.child().emit('close', 1); f.clock.tick(10); assert.equal(f.children.length, 2);
  f.ready(); assert.deepEqual(f.child().stdin.writes, ['SET 12\n']);
  assert.equal(f.broker.snapshot().desktop.phase, 'paused');
  await assert.rejects(f.broker.arm('g1', marker), /generation_cannot_be_reused/);
  await f.arm('g2', '2345'); assert.equal(f.broker.snapshot().desktop.phase, 'ready'); await f.close();
});

test('late stdout, malformed bytes, stream errors, drain and close from an old child cannot affect its successor', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready(); const old = f.child();
  old.close(); f.clock.tick(10); f.ready(); await f.arm();
  old.bytes('{private-old-junk'); old.stdout.emit('error', new Error('old')); old.stderr.emit('error', new Error('old'));
  old.stdin.emit('error', new Error('old')); old.stdin.emit('drain'); old.close();
  assert.equal(f.pauses.length, 0); assert.equal(f.broker.snapshot().desktop.phase, 'ready'); await f.close();
});

test('startup and arm deadlines reject promptly and never automatically resume a desktop', async () => {
  for (const ready of [false, true]) {
    const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker));
    if (ready) f.ready(); f.clock.tick(100); await pending;
    assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].certainty, 'unknown');
    f.child().close(); f.clock.tick(1000); assert.equal(f.children.length, 1); await f.close();
  }
});

test('unknown, malformed, invalid UTF-8 and oversized stdout fail closed without reflecting private content', async () => {
  for (const bytes of ['{private-secret}\n', '[]\n', '{"type":"private-secret"}\n', '{"type":"status","status":"private-secret"}\n',
    '{"type":"mouse","pid":12}\n', Buffer.from([0xff, 10]), 'x'.repeat(2049), Buffer.alloc(65537)]) {
    const f = fixture(); await f.arm(); f.child().bytes(bytes);
    assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].certainty, 'unknown');
    assert.ok(!JSON.stringify([f.pauses, f.broker.snapshot()]).includes('private-secret')); await f.close();
  }
});

test('unknown desktop event fields pause through the shared observer schema', async () => {
  const f = fixture(); await f.arm(); f.activity('g1', { text: 'never-export-this' });
  assert.equal(f.pauses[0].reason, 'protocol_error'); assert.ok(!JSON.stringify(f.pauses).includes('never-export')); await f.close();
});

test('backpressure waits for drain without replaying already accepted writes', async () => {
  const f = fixture(); const pending = f.broker.arm('g1', marker); f.child().stdin.blocked = true; f.ready();
  assert.deepEqual(f.child().stdin.writes, ['SET\n']);
  f.child().stdin.blocked = false; f.child().stdin.emit('drain');
  assert.deepEqual(f.child().stdin.writes, ['SET\n', 'ARM epoch-1 g1 ' + marker + '\n']);
  f.ack(); await pending; f.clock.tick(50); assert.equal(f.pauses.length, 0); await f.close();
});

test('an acknowledgement for an ARM still stuck behind backpressure cannot manufacture readiness', async () => {
  const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker)); f.child().stdin.blocked = true; f.ready(); f.ack();
  await pending; assert.equal(f.pauses[0].reason, 'protocol_error'); await f.close();
});

test('drain timeout, write throw, asynchronous write failure and broken stdin all pause', async () => {
  for (const mode of ['drain', 'throw', 'callback', 'stdin-error']) {
    const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker));
    if (mode === 'drain') f.child().stdin.blocked = true;
    if (mode === 'throw') f.child().stdin.failWrite = true;
    f.ready();
    if (mode === 'drain') f.clock.tick(50);
    if (mode === 'callback') f.child().stdin.callbacks.at(-1)(new Error('private-write-details'));
    if (mode === 'stdin-error') f.child().stdin.emit('error', new Error('private-write-details'));
    await pending; assert.equal(f.pauses.length, 1);
    assert.notEqual(f.broker.snapshot().transport.state, 'ready'); assert.ok(!JSON.stringify(f.pauses).includes('private-write-details')); await f.close();
  }
});

test('bounded queued SET updates cannot accumulate without limit during backpressure', async () => {
  const f = fixture(), browser = f.broker.browser('a'); browser.sync([1]); f.ready(); await f.arm();
  f.child().stdin.blocked = true;
  for (let index = 0; index < 10 && f.broker.snapshot().transport.state === 'ready'; index++) {
    browser.sync(Array.from({ length: 256 }, (_, offset) => 4000000000 + index * 256 + offset));
  }
  assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].reason, 'overflow');
  assert.notEqual(f.broker.snapshot().transport.state, 'ready'); await f.close();
});

test('spawn failure rejects an explicit arm, while browser demand alone can retry', async () => {
  let attempts = 0; const clock = new FakeClock(), pauses = [], children = [];
  const f = fixture({ clock, spawn() { attempts++; if (attempts === 1) throw new Error('private-spawn'); const child = new FakeChild(); children.push(child); return child; }, onPause: event => pauses.push(event) });
  await assert.rejects(f.broker.arm('g1', marker)); assert.equal(pauses.length, 1); clock.tick(1000); assert.equal(attempts, 1);
  f.broker.browser('a').sync([12]); assert.equal(attempts, 2);
  children[0].message({ type: 'status', status: 'ready' }); assert.deepEqual(children[0].stdin.writes, ['SET 12\n']);
  const closed = f.broker.dispose(); children[0].close(); await closed;
});

test('a new explicit arm waits for the previous child to retire before spawning another', async () => {
  const f = fixture(); await f.arm(); f.broker.disarm('g1');
  const next = f.broker.arm('g2', '1234'); assert.equal(f.children.length, 1);
  f.child().close(); assert.equal(f.children.length, 2); f.ready(); f.ack('g2'); await next;
  assert.equal(f.broker.snapshot().desktop.generation, 'g2'); await f.close();
});

test('late generation acknowledgements and disarms cannot remove the latest explicit arm', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready();
  const old = assert.rejects(f.broker.arm('g1', marker), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
  f.broker.disarm('g1');
  const next = f.broker.arm('g2', '2345'); await old;
  f.ack('g1'); f.broker.disarm('g1'); assert.equal(f.broker.snapshot().pendingGeneration, 'g2'); f.ack('g2'); await next; await f.close();
});

test('stdout EOF, child error and stderr stream error pause and retire without replay', async () => {
  for (const event of ['stdout-end', 'child-error', 'stderr-error']) {
    const f = fixture(); await f.arm();
    if (event === 'stdout-end') f.child().stdout.emit('end');
    if (event === 'child-error') f.child().emit('error', new Error('private-error'));
    if (event === 'stderr-error') f.child().stderr.emit('error', new Error('private-error'));
    assert.equal(f.pauses.length, 1); await f.close();
  }
});

test('dispose waits for confirmed close; grace timeout escalates only the owned fake child', async () => {
  const f = fixture(); await f.arm(); const pending = f.broker.dispose(); let resolved = false;
  void pending.then(() => { resolved = true; }); await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(f.child().stdin.writes.at(-1), 'SET\nQUIT\n');
  f.clock.tick(30); assert.equal(f.child().kills, 1); assert.equal(resolved, false);
  f.child().close(); await pending; assert.equal(f.clock.timers.size, 0);
});

test('unconfirmed retirement latches unavailable and never spawns or recovers from a late close', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready(); await f.arm();
  const disposed = assert.rejects(f.broker.dispose(), { code: 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED' });
  f.clock.tick(60); await disposed;
  assert.equal(f.broker.snapshot().stopConfirmed, false); assert.equal(f.broker.snapshot().transport.reason, 'stop_unconfirmed');
  f.child().close(); f.clock.tick(1000); assert.equal(f.children.length, 1);
  await assert.rejects(f.broker.arm('g2', marker));
});

test('invalid arm values do not spawn and callback exceptions cannot interrupt another subscriber or cleanup', async () => {
  const f = fixture({ onPause() { throw new Error('consumer failure'); } });
  for (const [generation, value] of [['invalid generation', marker], ['g1', '0'], ['g1', 'z'], ['g1', '1'.repeat(17)]]) await assert.rejects(f.broker.arm(generation, value));
  assert.equal(f.children.length, 0);
  f.broker.browser('bad', { onStatus() { throw new Error('bad'); }, onLegacyMessage() { throw new Error('bad'); } }).sync([12]);
  const seen = []; f.broker.browser('good', { onLegacyMessage: value => seen.push(value) }).sync([12]);
  f.ready(); await f.arm(); f.child().message(mouse(12)); f.activity();
  assert.ok(seen.some(value => value.type === 'mouse')); await f.close();
});

test('old helper ARM rejection fails readiness rather than being mistaken for supported observation', async () => {
  const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker)); f.ready();
  f.child().message({ type: 'status', status: 'invalid-command', pid: 0 }); await pending;
  assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].reason, 'unavailable'); await f.close();
});

test('an explicit startup failure is unavailable, without waiting for a ready message', async () => {
  const f = fixture(); const pending = assert.rejects(f.broker.arm('g1', marker));
  f.child().message({ type: 'status', status: 'hook-create-failed', pid: 0 }); await pending;
  assert.equal(f.pauses[0].reason, 'unavailable'); await f.close();
});

test('same arm is idempotent only with its original marker and never after a pause', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready();
  const one = f.broker.arm('g1', marker), two = f.broker.arm('g1', marker); assert.equal(one, two);
  await assert.rejects(f.broker.arm('g1', '1234')); f.ack(); await one;
  const writes = f.child().stdin.writes.length;
  assert.equal((await f.broker.arm('g1', marker)).phase, 'ready'); assert.equal(f.child().stdin.writes.length, writes);
  f.activity(); await assert.rejects(f.broker.arm('g1', marker)); await f.close();
});

test('malformed desktop protocol also retires a browser-only helper; restart preserves only browser demand', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready();
  f.child().message({ type: 'input-activity' }); assert.equal(f.broker.snapshot().transport.state, 'stopping');
  f.child().close(); f.clock.tick(10); f.ready();
  assert.deepEqual(f.child().stdin.writes, ['SET 12\n']); assert.equal(f.pauses.length, 0); await f.close();
});

test('unconfirmed old helper blocks a newer explicit arm even before broker disposal', async () => {
  const f = fixture(); await f.arm(); f.broker.disarm('g1');
  const next = assert.rejects(f.broker.arm('g2', '1234'));
  f.clock.tick(60); await next; assert.equal(f.children.length, 1); assert.equal(f.broker.snapshot().stopConfirmed, false);
  await assert.rejects(f.broker.arm('g3', marker), { code: 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED' });
  await assert.rejects(f.broker.dispose(), { code: 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED' });
  f.child().close(); assert.equal(f.children.length, 1);
});

test('consumer mutation cannot alter another browser callback or the pause cleanup identity', async () => {
  const f = fixture({ onPause(event) { event.epoch = 'other'; event.certainty = 'observed'; } }), seen = [];
  f.broker.browser('a', { onLegacyMessage(value) { if (value.type === 'mouse') { value.pid = 999; value.window.x = 999; } } }).sync([12]);
  f.broker.browser('b', { onLegacyMessage: value => seen.push(value) }).sync([12]);
  f.ready(); await f.arm(); f.child().message(mouse(12));
  assert.equal(seen.at(-1).pid, 12); assert.equal(seen.at(-1).window.x, 0);
  f.child().bytes('{broken\n'); assert.equal(f.broker.snapshot().transport.state, 'stopping');
  assert.equal(f.broker.snapshot().desktop.reason, 'protocol_error'); await f.close();
});

test('failed-spawn children with missing stdin or stdout reject arm and still consume late lifecycle events', async () => {
  for (const missing of ['stdin', 'stdout']) {
    const child = new FakeChild(); child[missing] = null;
    const f = fixture({ spawn: () => child });
    await assert.rejects(f.broker.arm('g1', marker));
    assert.equal(f.pauses.length, 1); assert.equal(f.pauses[0].reason, 'unavailable');
    assert.doesNotThrow(() => child.emit('error', new Error('late private spawn error')));
    child.close(); assert.equal(f.broker.snapshot().stopConfirmed, true); await f.broker.dispose();
    assert.equal(f.clock.timers.size, 0);
  }
});

test('same-child old-generation malformed event bodies cannot affect a newer arm', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready(); await f.arm(); await f.arm('g2', '1234');
  for (const type of ['desktop-armed', 'input-activity', 'observer-fault']) {
    f.child().message({ type, epoch: 'epoch-1', generation: 'g1', text: 'obsolete-private-field', sequence: false });
  }
  assert.equal(f.pauses.length, 0); assert.equal(f.broker.snapshot().desktop.phase, 'ready');
  assert.equal(f.broker.snapshot().desktop.generation, 'g2'); await f.close();
});

test('a replacement child treats an old driver marker as external and never silently remains ready', async () => {
  const f = fixture(); f.broker.browser('browser').sync([10]); f.ready(); await f.arm();
  f.child().close(); f.clock.tick(10); f.ready();
  assert.deepEqual(f.child().stdin.writes, ['SET 10\n']);
  await f.arm('g2', '123456789abcdef0');
  f.activity('g2', { injected: true, marker });
  assert.equal(f.broker.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses.at(-1).reason, 'external_input');
  const arms = f.child().stdin.writes.filter(line => line.startsWith('ARM '));
  f.clock.tick(100); assert.equal(f.child().stdin.writes.filter(line => line.startsWith('ARM ')).length, arms.length);
  await f.close();
});

test('explicitly abandoned unacknowledged marker cannot grant trust in a newer generation', async () => {
  const f = fixture(); f.broker.browser('a').sync([12]); f.ready(); const first = f.broker.arm('g1', marker);
  const rejected = assert.rejects(first, { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
  f.broker.disarm('g1');
  const second = f.broker.arm('g2', '123456789abcdef0'); f.ack('g2'); await second; await rejected;
  f.activity('g2', { injected: true, marker });
  assert.equal(f.broker.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses.at(-1).reason, 'external_input');
  await f.close();
});

test('a different pending ARM cannot be silently superseded with an unconditional replacement', async () => {
  const f = fixture();
  const first = f.broker.arm('g1', marker); f.ready();
  const writes = [...f.child().stdin.writes];
  await assert.rejects(f.broker.arm('g2', '1234'), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
  assert.deepEqual(f.child().stdin.writes, writes);
  assert.equal(f.broker.snapshot().pendingGeneration, 'g1');
  f.ack('g1'); await first;
  await f.arm('g2', '1234');
  assert.ok(f.child().stdin.writes.some(line => line.startsWith('REARM epoch-1 g1 g2 ')));
  await f.close();
});
