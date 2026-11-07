const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopInputObserver, inputObserverMessageSchema, pointerInputMarker } = loadCli('src/main/desktop/input-observer.ts');

const marker = 'fedcba9876543210';
const pointerMarker = '0000000076543210';
function fixture() {
  const commands = [], pauses = [];
  const observer = new DesktopInputObserver({ send: command => commands.push(command), onPause: event => pauses.push(event) });
  return { observer, commands, pauses };
}
const ack = (generation = 'g1', epoch = 'e1', sequence = '0') => ({ type: 'desktop-armed', epoch, generation, sequence });
const activity = (fields = {}) => ({ type: 'input-activity', epoch: 'e1', generation: 'g1', sequence: '1', kind: 'keyboard', injected: false, ...fields });
function armed(f, generation = 'g1', epoch = 'e1') {
  f.observer.connect(epoch); f.observer.observeDesktop(generation, marker);
  assert.equal(f.observer.receive(epoch, ack(generation, epoch)), true);
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
}

test('browser subscriptions merge independently and remain while desktop observation stops', () => {
  const f = fixture();
  f.observer.setBrowserSubscription('browser-a', [30, 10, 10]);
  f.observer.setBrowserSubscription('browser-b', [20, 30]);
  assert.equal(f.commands.length, 0);
  armed(f);
  assert.deepEqual(f.observer.snapshot().browserPids, [10, 20, 30]);
  f.observer.removeBrowserSubscription('browser-a');
  assert.deepEqual(f.commands.at(-1).pids, [20, 30]);
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  f.observer.stopDesktop('g1');
  assert.deepEqual(f.commands.at(-1), { type: 'desktop-disarm', epoch: 'e1', generation: 'g1' });
  assert.deepEqual(f.observer.snapshot().browserPids, [20, 30]);
  assert.equal(f.observer.snapshot().connected, true);
});

test('removing the last browser subscriber does not stop an active desktop observer', () => {
  const f = fixture(); armed(f);
  f.observer.setBrowserSubscription('browser', [10]); f.observer.removeBrowserSubscription('browser');
  assert.deepEqual(f.commands.at(-1).pids, []);
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  assert.equal(f.observer.snapshot().connected, true);
  assert.equal(f.pauses.length, 0);
});

test('desktop readiness requires an acknowledgement for both current epoch and generation', () => {
  const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', marker);
  assert.equal(f.observer.snapshot().desktop.phase, 'arming');
  assert.equal(f.observer.receive('old', ack()), false);
  assert.equal(f.observer.receive('e1', ack('old')), false);
  assert.equal(f.observer.receive('e1', ack('g1', 'old')), false);
  assert.equal(f.observer.snapshot().desktop.phase, 'arming');
  f.observer.receive('e1', ack());
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
});

test('only injected activity carrying a registered marker is ignored as self input', () => {
  const f = fixture(); armed(f);
  for (const [index, kind] of ['keyboard', 'pointer', 'button', 'wheel'].entries()) {
    assert.equal(f.observer.receive('e1', activity({ kind, injected: true, marker: (kind === 'keyboard' ? marker : pointerMarker).toUpperCase(), sequence: String(index + 1) })), true);
  }
  assert.equal(f.pauses.length, 0);
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  f.observer.receive('e1', activity({ marker, sequence: '5' }));
  assert.equal(f.pauses[0].reason, 'physical_input', 'a marker alone cannot exempt a physical event');
});

test('unknown injected activity pauses once without being mislabeled physical input', () => {
  for (const extra of [{}, { marker: '0' }, { marker: '0000000000000001' }]) {
    const f = fixture(); armed(f);
    f.observer.receive('e1', activity({ injected: true, ...extra }));
    f.observer.receive('e1', activity({ sequence: '2' }));
    assert.equal(f.pauses.length, 1);
    assert.equal(f.pauses[0].reason, 'external_input');
    assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  }
});

test('physical activity before arm acknowledgement latches pause against a delayed acknowledgement', () => {
  const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', marker);
  f.observer.receive('e1', activity());
  assert.equal(f.observer.receive('e1', ack('g1', 'e1', '2')), false);
  assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses.length, 1);
});

test('each physical event class can pause and no input details leave the callback', () => {
  for (const kind of ['keyboard', 'pointer', 'button', 'wheel']) {
    const f = fixture(); armed(f); f.observer.receive('e1', activity({ kind }));
    assert.deepEqual(f.pauses, [{ epoch: 'e1', generation: 'g1', reason: 'physical_input', certainty: 'observed', kind, sequence: '1' }]);
  }
});

test('late old-generation input, fault, acknowledgement and stop cannot affect a new subscription', () => {
  const f = fixture(); armed(f); f.observer.observeDesktop('g2', marker);
  f.observer.receive('e1', ack('g2'));
  for (const message of [activity({ sequence: '999' }), activity({ vkCode: 'obsolete-private-value' }), ack(), { type: 'observer-fault', epoch: 'e1', generation: 'g1', reason: 'overflow' }]) {
    assert.equal(f.observer.receive('e1', message), false);
  }
  f.observer.stopDesktop('g1');
  assert.equal(f.observer.snapshot().desktop.generation, 'g2');
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  assert.equal(f.pauses.length, 0);
});

test('a ready predecessor is replaced with REARM and its activity pauses the pending successor', () => {
  const f = fixture(); armed(f);
  f.observer.observeDesktop('g2', '123456789abcdef0');
  assert.deepEqual(f.commands.at(-1), { type: 'desktop-rearm', epoch: 'e1', previousGeneration: 'g1', generation: 'g2', marker: '123456789abcdef0' });
  assert.equal(f.observer.snapshot().desktop.previousGeneration, 'g1');
  assert.equal(f.observer.receive('e1', ack()), false, 'old ACK cannot complete the transition');
  assert.equal(f.observer.receive('e1', activity()), true);
  assert.equal(f.pauses[0].generation, 'g2'); assert.equal(f.pauses[0].reason, 'physical_input');
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '1')), false);
  assert.equal(f.observer.snapshot().desktop.phase, 'paused');
});

test('predecessor faults or malformed activity latch unknown pause during a continuous transition', () => {
  for (const message of [
    { type: 'observer-fault', epoch: 'e1', generation: 'g1', reason: 'unavailable' },
    activity({ privateKeyText: 'must not be retained' })
  ]) {
    const f = fixture(); armed(f); f.observer.observeDesktop('g2', marker);
    f.observer.receive('e1', message);
    assert.equal(f.observer.snapshot().desktop.phase, 'paused'); assert.equal(f.pauses[0].certainty, 'unknown');
    assert.equal(f.pauses[0].generation, 'g2'); assert.ok(!JSON.stringify(f.pauses).includes('must not be retained'));
  }
});

test('continuous replacement preserves monotonic sequence and trusts only acknowledged predecessor releases', () => {
  const f = fixture(); armed(f);
  f.observer.receive('e1', activity({ sequence: '10', injected: true, marker }));
  f.observer.observeDesktop('g2', '123456789abcdef0');
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '9')), false);
  assert.equal(f.observer.receive('e1', activity({ sequence: '11', injected: true, marker })), true);
  assert.equal(f.pauses.length, 0);
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '11')), true);
  assert.equal(f.observer.snapshot().desktop.previousGeneration, undefined);
  f.observer.receive('e1', activity({ generation: 'g2', sequence: '12' }));
  assert.equal(f.pauses[0].generation, 'g2');
});

test('duplicate and older activity sequences cannot manufacture a pause', () => {
  const f = fixture(); armed(f);
  f.observer.receive('e1', activity({ sequence: '10', injected: true, marker }));
  for (const sequence of ['9', '10']) assert.equal(f.observer.receive('e1', activity({ sequence })), false);
  assert.equal(f.pauses.length, 0);
  f.observer.receive('e1', activity({ sequence: '11' }));
  assert.equal(f.pauses.length, 1);
});

test('sequence and marker identities remain exact beyond JavaScript safe integers', () => {
  const f = fixture(); armed(f);
  f.observer.receive('e1', activity({ sequence: '9007199254740992', marker, injected: true }));
  f.observer.receive('e1', activity({ sequence: '9007199254740993' }));
  assert.equal(f.pauses[0].sequence, '9007199254740993');
  assert.equal(f.observer.snapshot().desktop.sequence, '9007199254740993');
});

test('an acknowledgement cannot move readiness backwards over already observed own input', () => {
  const f = fixture(); armed(f); f.observer.stopDesktop('g1'); f.observer.observeDesktop('g2', marker);
  f.observer.receive('e1', activity({ generation: 'g2', sequence: '5', marker, injected: true }));
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '4')), false);
  assert.equal(f.observer.snapshot().desktop.phase, 'arming');
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '5')), true);
  assert.equal(f.observer.receive('e1', ack('g2', 'e1', '100')), false);
  assert.equal(f.observer.snapshot().desktop.sequence, '5');
});

test('helper exit and disconnect pause the current generation; reconnect restores only browser configuration', () => {
  for (const reason of ['helper_exited', 'disconnected']) {
    const f = fixture(); f.observer.setBrowserSubscription('browser', [12]); armed(f);
    f.observer.disconnect('e1', reason);
    assert.equal(f.observer.snapshot().connected, false);
    assert.equal(f.pauses[0].reason, reason);
    assert.equal(f.observer.snapshot().desktop.certainty, 'unknown');
    const before = f.commands.length; f.observer.connect('e2');
    assert.deepEqual(f.commands.slice(before).map(command => command.type), ['browser-config']);
    assert.deepEqual(f.commands.at(-1).pids, [12]);
    assert.equal(f.observer.snapshot().desktop.phase, 'paused');
    assert.equal(f.observer.receive('e2', ack('g1', 'e2')), false);
    f.observer.observeDesktop('g2', marker); f.observer.receive('e2', ack('g2', 'e2'));
    assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  }
});

test('replacing a live helper pauses its old subscription without an implicit new arm', () => {
  const f = fixture(); armed(f); const before = f.commands.length;
  f.observer.connect('e2');
  assert.equal(f.pauses[0].reason, 'helper_replaced');
  assert.deepEqual(f.commands.slice(before).map(command => command.type), ['browser-config']);
  f.observer.disconnect('e1'); f.observer.receive('e1', { secret: 'old malformed output' });
  assert.equal(f.observer.snapshot().connected, true);
  assert.equal(f.pauses.length, 1);
});

test('overflow and unavailable faults latch unknown pause until an explicit new generation', () => {
  for (const reason of ['overflow', 'unavailable']) {
    const f = fixture(); armed(f);
    f.observer.receive('e1', { type: 'observer-fault', epoch: 'e1', generation: 'g1', reason });
    f.observer.observeDesktop('g1', marker); f.observer.receive('e1', ack());
    assert.equal(f.observer.snapshot().desktop.phase, 'paused');
    assert.equal(f.pauses[0].certainty, 'unknown');
    assert.equal(f.pauses.length, 1);
  }
});

test('retiring driver markers remain recognized across explicit generations in the same child', () => {
  const f = fixture(); armed(f); f.observer.stopDesktop('g1');
  f.observer.observeDesktop('g2', '123456789abcdef0'); f.observer.receive('e1', ack('g2'));
  f.observer.receive('e1', activity({ generation: 'g2', injected: true, marker: pointerMarker, kind: 'button' }));
  assert.equal(f.pauses.length, 0);
  assert.equal(f.observer.snapshot().desktop.phase, 'ready');
});

test('removed generations cannot be reused or receive late subscription removal', () => {
  const f = fixture(); armed(f); f.observer.stopDesktop('g1');
  assert.throws(() => f.observer.observeDesktop('g1', marker), /cannot be reused/);
  f.observer.observeDesktop('g2', marker); const count = f.commands.length;
  f.observer.stopDesktop('g1');
  assert.equal(f.commands.length, count);
  assert.equal(f.observer.snapshot().desktop.generation, 'g2');
});

test('unexpected or sensitive protocol fields fail closed without leaking their values', () => {
  for (const field of ['vkCode', 'scanCode', 'text', 'character', 'x', 'y', 'globalCoordinates']) {
    const f = fixture(); armed(f);
    const value = activity({ [field]: 'private-secret' });
    assert.equal(inputObserverMessageSchema.safeParse(value).success, false);
    assert.equal(f.observer.receive('e1', value), false);
    assert.equal(f.pauses[0].reason, 'protocol_error');
    assert.equal(JSON.stringify([f.pauses, f.observer.snapshot()]).includes('private-secret'), false);
  }
});

test('malformed numeric and boolean protocol values cannot be coerced into trusted events', () => {
  for (const patch of [{ injected: 'false' }, { sequence: 1 }, { sequence: '-1' }, { sequence: '01' }, { sequence: '1.5' }, { sequence: 'not-a-number' }, { sequence: '' }, { sequence: '18446744073709551616' }, { marker: '1'.repeat(17) }, { marker: 1 }, { kind: 'raw-key' }]) {
    assert.equal(inputObserverMessageSchema.safeParse(activity(patch)).success, false);
  }
  assert.equal(inputObserverMessageSchema.safeParse(activity({ sequence: '18446744073709551615' })).success, true);
});

test('line protocol is bounded in UTF-8 bytes and ignores old helper lines before parsing', () => {
  const f = fixture(); armed(f);
  assert.equal(f.observer.receiveLine('old', '{broken'), false);
  assert.equal(f.pauses.length, 0);
  assert.equal(f.observer.receiveLine('e1', JSON.stringify(activity({ injected: true, marker }))), true);
  assert.equal(f.observer.receiveLine('e1', ' '.repeat(2049)), false);
  assert.equal(f.pauses[0].reason, 'protocol_error');
  const other = fixture(); armed(other);
  assert.equal(other.observer.receiveLine('e1', '{broken'), false);
  assert.equal(other.pauses.length, 1);
  const unicode = fixture(); armed(unicode);
  const largeLine = JSON.stringify({ padding: String.fromCodePoint(0x4e2d).repeat(700) });
  assert.ok(largeLine.length < 2048 && Buffer.byteLength(largeLine) > 2048);
  assert.equal(unicode.observer.receiveLine('e1', largeLine), false);
  assert.equal(unicode.pauses[0].reason, 'protocol_error');
});

test('send failures leave desktop unknown and paused without pretending the helper is connected', () => {
  const commands = [], pauses = []; let fail = false;
  const observer = new DesktopInputObserver({ send(command) { if (fail) throw new Error('private transport details'); commands.push(command); }, onPause: event => pauses.push(event) });
  observer.connect('e1'); fail = true; observer.observeDesktop('g1', marker);
  assert.equal(observer.snapshot().connected, false);
  assert.equal(observer.snapshot().desktop.phase, 'paused');
  assert.deepEqual(pauses, [{ epoch: 'e1', generation: 'g1', reason: 'send_failed', certainty: 'unknown' }]);
});

test('configuration validation and defensive snapshots cannot mutate subscriptions', () => {
  const f = fixture();
  assert.throws(() => f.observer.observeDesktop('g1', marker), /not connected/);
  f.observer.connect('e1');
  for (const pids of [[0], [-1], [1.5], ['1'], [0x100000000]]) assert.throws(() => f.observer.setBrowserSubscription('browser', pids));
  for (const value of ['0', '', 'nothex', '1'.repeat(17)]) assert.throws(() => f.observer.observeDesktop('invalid-marker', value));
  f.observer.setBrowserSubscription('browser', [12]); f.observer.observeDesktop('g1', marker);
  const snapshot = f.observer.snapshot(); snapshot.browserPids.push(999); snapshot.desktop.phase = 'ready';
  assert.deepEqual(f.observer.snapshot().browserPids, [12]);
  assert.equal(f.observer.snapshot().desktop.phase, 'arming');
});

test('already-paused activity remains latched while later helper loss marks its evidence unknown', () => {
  const f = fixture(); armed(f); f.observer.receive('e1', activity()); f.observer.disconnect('e1', 'helper_exited');
  assert.equal(f.pauses.length, 1);
  assert.equal(f.observer.snapshot().desktop.reason, 'physical_input');
  assert.equal(f.observer.snapshot().desktop.certainty, 'unknown');
});

test('replacement child forgets marker trust but cannot reuse prior epochs or generations', () => {
  const f = fixture(); armed(f); f.observer.connect('e2');
  assert.throws(() => f.observer.observeDesktop('g1', marker), /cannot be reused/);
  f.observer.observeDesktop('g2', '123456789abcdef0'); f.observer.receive('e2', ack('g2', 'e2'));
  f.observer.receive('e2', activity({ epoch: 'e2', generation: 'g2', injected: true, marker }));
  assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses.at(-1).reason, 'external_input');
  assert.throws(() => f.observer.connect('e1'), /cannot be reused/);
  f.observer.disconnect('e2'); assert.throws(() => f.observer.connect('e2'), /cannot be reused/);
});

test('a new marker is untrusted until matching registration acknowledgement', () => {
  const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', marker);
  f.observer.receive('e1', activity({ injected: true, marker }));
  assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses[0].reason, 'external_input');
  assert.equal(f.observer.receive('e1', ack()), false);
});

test('an abandoned unacknowledged ARM cannot seed trust for a later generation', () => {
  const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', marker);
  f.observer.stopDesktop('g1'); f.observer.observeDesktop('g2', '123456789abcdef0'); f.observer.receive('e1', ack('g2'));
  f.observer.receive('e1', activity({ generation: 'g2', injected: true, marker }));
  assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  assert.equal(f.pauses[0].reason, 'external_input');
});

test('pointer marker derivation stays nonzero at 32-bit boundaries and rejects invalid source identities', () => {
  for (const [source, expected] of [
    ['fedcba9876543210', '0000000076543210'], ['ffffffffffffffff', '00000000ffffffff'],
    ['fedcba9800000000', '00000000fedcba98'], ['0000000100000000', '0000000000000001'],
    ['0000000080000000', '0000000080000000'], ['1', '0000000000000001']
  ]) assert.equal(pointerInputMarker(source), expected, source);
  for (const source of ['0', '0000000000000000', '', 'nothex', '1'.repeat(17)]) assert.throws(() => pointerInputMarker(source));
});

test('full-width or wrong-high-bit pointer values cannot inherit trust from a matching low word', () => {
  for (const kind of ['pointer', 'button', 'wheel']) for (const external of [marker, '1234567876543210', 'ffffffff76543210']) {
    const f = fixture(); armed(f);
    f.observer.receive('e1', activity({ kind, injected: true, marker: external }));
    assert.equal(f.pauses[0]?.reason, 'external_input', kind + ':' + external);
    assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  }
});

test('keyboard input requires its exact full-width marker and never accepts a pointer alias', () => {
  for (const external of [pointerMarker, '1234567876543210', 'fedcba9800000000']) {
    const f = fixture(); armed(f);
    f.observer.receive('e1', activity({ injected: true, marker: external }));
    assert.equal(f.pauses[0]?.reason, 'external_input', external);
  }
});

test('noninjected pointer events remain physical even when their 32-bit marker matches', () => {
  for (const kind of ['pointer', 'button', 'wheel']) {
    const f = fixture(); armed(f);
    f.observer.receive('e1', activity({ kind, marker: pointerMarker }));
    assert.equal(f.pauses[0]?.reason, 'physical_input'); assert.equal(f.pauses[0]?.kind, kind);
  }
});

test('low-zero source markers use the high-word pointer alias without changing keyboard identity', () => {
  const source = 'fedcba9800000000', pointer = '00000000fedcba98';
  const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', source); f.observer.receive('e1', ack());
  for (const [index, kind] of ['keyboard', 'pointer', 'button', 'wheel'].entries())
    f.observer.receive('e1', activity({ kind, injected: true, marker: kind === 'keyboard' ? source : pointer, sequence: String(index + 1) }));
  assert.equal(f.pauses.length, 0); assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  f.observer.receive('e1', activity({ kind: 'pointer', injected: true, marker: '0', sequence: '5' }));
  assert.equal(f.pauses[0]?.reason, 'external_input');
});

test('pointer trust survives continuous REARM only for acknowledged markers in the same child', () => {
  const f = fixture(); armed(f); f.observer.observeDesktop('g2', '123456789abcdef0');
  f.observer.receive('e1', activity({ kind: 'button', injected: true, marker: pointerMarker }));
  assert.equal(f.pauses.length, 0); assert.equal(f.observer.snapshot().desktop.phase, 'arming');
  f.observer.receive('e1', ack('g2', 'e1', '1'));
  f.observer.receive('e1', activity({ generation: 'g2', kind: 'wheel', injected: true, marker: pointerMarker, sequence: '2' }));
  assert.equal(f.pauses.length, 0); assert.equal(f.observer.snapshot().desktop.phase, 'ready');
  f.observer.connect('e2'); f.observer.observeDesktop('g3', '9876543212345678'); f.observer.receive('e2', ack('g3', 'e2'));
  f.observer.receive('e2', activity({ epoch: 'e2', generation: 'g3', kind: 'button', injected: true, marker: pointerMarker }));
  assert.equal(f.pauses.at(-1)?.reason, 'external_input'); assert.equal(f.observer.snapshot().desktop.phase, 'paused');
});

test('pointer aliases are untrusted before ARM ACK or after an abandoned unacknowledged registration', () => {
  for (const abandoned of [false, true]) {
    const f = fixture(); f.observer.connect('e1'); f.observer.observeDesktop('g1', marker);
    if (abandoned) { f.observer.stopDesktop('g1'); f.observer.observeDesktop('g2', '123456789abcdef0'); f.observer.receive('e1', ack('g2')); }
    f.observer.receive('e1', activity({ generation: abandoned ? 'g2' : 'g1', kind: 'pointer', injected: true, marker: pointerMarker }));
    assert.equal(f.pauses[0]?.reason, 'external_input'); assert.equal(f.observer.snapshot().desktop.phase, 'paused');
  }
});
