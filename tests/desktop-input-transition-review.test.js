const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsInputBroker } = loadCli('src/main/desktop/input-broker.ts');

// Review evidence only: all child streams and deadlines are fake. Importing the
// broker does not spawn a helper, inspect a desktop or install an input hook.
class FakeClock {
  next = 0; timers = new Map();
  setTimeout(callback, milliseconds) { const id = ++this.next; this.timers.set(id, { callback, milliseconds }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
}
class FakeInput extends EventEmitter {
  writable = true; destroyed = false; writableLength = 0; writes = [];
  write(text) { this.writes.push(text); return true; }
  end(text) { this.writable = false; if (text) this.writes.push(text); }
}
class FakeChild extends EventEmitter {
  stdin = new FakeInput(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { return true; }
  chunk(...messages) { this.stdout.emit('data', Buffer.from(messages.map(message => JSON.stringify(message)).join('\n') + '\n')); }
}
function fixture() {
  const child = new FakeChild(), clock = new FakeClock(), pauses = [];
  const broker = new WindowsInputBroker({ clock, spawn: () => child, createEpoch: () => 'review-epoch', onPause: event => pauses.push(event) });
  return { child, pauses, broker,
    ready() { child.chunk({ type: 'status', status: 'ready', pid: 0 }); },
    ack(generation) { return { type: 'desktop-armed', epoch: 'review-epoch', generation, sequence: '0' }; },
    physical(generation) { return { type: 'input-activity', epoch: 'review-epoch', generation, sequence: '1', kind: 'keyboard', injected: false }; },
    async close() { const done = broker.dispose(); child.emit('close', 0); await done; assert.equal(clock.timers.size, 0); }
  };
}

test('review: ACK and physical activity in one chunk invalidate the resolved ARM snapshot before its continuation', async () => {
  const f = fixture();
  try {
    const pending = f.broker.arm('g1', '1'); f.ready();
    f.child.chunk(f.ack('g1'), f.physical('g1'));
    const acknowledged = await pending;
    assert.equal(acknowledged.phase, 'ready', 'ARM result describes the ACK instant only');
    assert.equal(f.broker.snapshot().desktop.phase, 'paused', 'Service must read current state after awaiting ARM');
    assert.equal(f.pauses.length, 1);
    assert.equal(f.pauses[0].reason, 'physical_input');
  } finally { await f.close(); }
});

test('old-generation physical activity during continuous rearm prevents the replacement generation becoming ready', async () => {
  const f = fixture();
  try {
    const first = f.broker.arm('g1', '1'); f.ready(); f.child.chunk(f.ack('g1')); await first;
    const second = f.broker.arm('g2', '2');
    const rejected = assert.rejects(second, { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
    assert.ok(!f.child.stdin.writes.includes('DISARM review-epoch g1\n'));
    assert.ok(f.child.stdin.writes.includes('REARM review-epoch g1 g2 0000000000000002\n'));
    f.child.chunk(f.physical('g1'), f.ack('g2')); await rejected;
    assert.equal(f.pauses.length, 1, 'Physical activity at the replacement boundary was discarded');
    assert.equal(f.broker.snapshot().desktop.phase, 'paused');
  } finally { await f.close(); }
});

test('continuous rearm requires its own ACK and preserves current state checks after a same-chunk pause', async () => {
  const f = fixture();
  try {
    const first = f.broker.arm('g1', '1'); f.ready(); f.child.chunk(f.ack('g1')); await first;
    const second = f.broker.arm('g2', '2');
    f.child.chunk(f.ack('g1')); assert.equal(f.broker.snapshot().desktop.phase, 'arming');
    f.child.chunk(f.ack('g2'), f.physical('g2'));
    assert.equal((await second).phase, 'ready');
    assert.equal(f.broker.snapshot().desktop.phase, 'paused'); assert.equal(f.pauses[0].generation, 'g2');
  } finally { await f.close(); }
});

test('native refusal of continuity rejects the successor without falling back to an unconditional ARM', async () => {
  const f = fixture();
  try {
    const first = f.broker.arm('g1', '1'); f.ready(); f.child.chunk(f.ack('g1')); await first;
    const rejected = assert.rejects(f.broker.arm('g2', '2'));
    f.child.chunk({ type: 'observer-fault', epoch: 'review-epoch', generation: 'g2', reason: 'unavailable' }); await rejected;
    assert.equal(f.broker.snapshot().desktop.phase, 'paused');
    assert.equal(f.child.stdin.writes.filter(line => /^ARM .*g2 /.test(line)).length, 0);
    assert.equal(f.pauses[0].certainty, 'unknown');
  } finally { await f.close(); }
});
