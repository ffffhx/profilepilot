const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { WindowsInputBroker } = loadCli('src/main/desktop/input-broker.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');

const target = { id: 'a'.repeat(32), title: 'Owned fake', process: 'fixture', pid: 12, className: 'Form' };
const other = { ...target, id: 'b'.repeat(32), pid: 34 };
const version = 'c'.repeat(32);
const cmd = (method, extra = {}) => ({ action: 'desktop', method, session: 'observer-test', ...extra });
const action = (extra = {}) => cmd('action', { requestId: randomUUID(), params: { version, ref: 'e1', kind: 'invoke' }, ...extra });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const returnExpectation = state => ({ session: state.session.name, generation: state.inputObservation.generation, revision: state.session.revision });
test('a UI return for an old owner cannot arm its paused successor', async () => {
  const f = fixture();
  try {
    await f.claim(); f.service.control('takeover'); const previous = returnExpectation(f.service.status());
    f.service.control('stop');
    await f.service.execute(cmd('claim', { session: 'successor', windowId: other.id })); f.service.control('takeover');
    const before = f.service.status(), arms = f.observer.arms.length, drivers = f.drivers.length;
    await assert.rejects(f.service.resume(previous), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.deepEqual(f.service.status(), before); assert.equal(f.observer.arms.length, arms); assert.equal(f.drivers.length, drivers);
  } finally { await f.service.close(); }
});
test('a second takeover invalidates a UI return even within the same input generation', async () => {
  const f = fixture();
  try {
    await f.claim(); f.service.control('takeover'); const old = returnExpectation(f.service.status());
    f.advance(1); f.service.control('takeover'); const current = f.service.status();
    assert.equal(current.inputObservation.generation, old.generation);
    const arms = f.observer.arms.length;
    await assert.rejects(f.service.resume(old), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.observer.arms.length, arms); assert.deepEqual(f.service.status(), current);
    const resumed = await f.service.resume(returnExpectation(current));
    assert.equal(resumed.session.state, 'active'); assert.equal(f.observer.arms.length, arms + 1);
  } finally { await f.service.close(); }
});

for (const [win32Error, code, reason] of [
  [183, 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', 'instance_in_use'],
  [5, 'DESKTOP_INPUT_OBSERVER_ACCESS_UNAVAILABLE', 'instance_access_denied'],
  [6, 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE', 'instance_gate_failed']
]) test('broker startup diagnostic reaches paused service and actionable CLI receipt: ' + win32Error, async () => {
  for (const exitFirst of [false, true]) {
    class Input extends EventEmitter { writable = true; destroyed = false; writableLength = 0; writes = []; write(text) { this.writes.push(text); return true; } end(text) { if (text) this.writes.push(text); this.writable = false; } }
    const child = new EventEmitter(); child.stdin = new Input(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    let broker, output = '', calls = 0;
    const f = fixture({ observerFactory(onPause) { broker = new WindowsInputBroker({ onPause, spawn: () => child, createEpoch: () => 'startup-epoch' }); return {
      arm: (generation, marker) => broker.arm(generation, marker), disarm: generation => broker.disarm(generation), snapshot: () => broker.snapshot(), detach() {}
    }; } });
    try {
      const cli = runDesktopCli(['claim', '--session', 'observer-test', '--window', target.id], async command => {
        calls++;
        try { return { ok: true, result: await f.service.execute(command) }; }
        catch (error) { return { ok: false, error: { code: error.code, message: error.message, details: error.details } }; }
      }, { stdout: { write: value => { output += value; } }, stderr: { write() {} } });
      await turn(); if (exitFirst) child.emit('exit', 2);
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'startup-failure', stage: 'instance-gate', win32Error }) + '\n'));
      child.emit('close', 2);
      assert.equal(await cli, 75); assert.equal(calls, 1);
      const response = JSON.parse(output); assert.equal(response.code, code); assert.ok(response.message.includes('观察锁'));
      assert.deepEqual(response.details, { inputObserver: { stage: 'instance-gate', win32Error } });
      assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.service.status().inputObservation.reason, reason);
      assert.equal(f.inputs().length, 0); assert.equal(child.stdin.writes.some(text => /SET|ARM/.test(text)), false);
      await assert.rejects(f.read(), { code: 'DESKTOP_USER_IN_CONTROL' });
      assert.equal(broker.snapshot().pendingGeneration, null);
    } finally { await f.service.close(); const done = broker.dispose(); child.emit('close', 2); await done; }
  }
});

test('service validates startup details and matching code, never an arbitrary error.reason', async () => {
  const valid = { stage: 'instance-gate', win32Error: 183 };
  for (const fields of [
    { reason: 'private-owner-path' },
    { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', reason: 'instance_in_use' },
    { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', details: { inputObserver: { ...valid, win32Error: 5 } } },
    { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', details: { inputObserver: { ...valid, ownerPath: 'private' } } },
    { code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', details: { inputObserver: valid, private: true } }
  ]) {
    const f = fixture(); f.observer.hook = request => request.reject(Object.assign(new Error('private'), fields));
    try {
      await assert.rejects(f.claim(), error => { assert.equal(error.code, 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE'); assert.equal(error.details, undefined); assert.equal(error.reason, undefined); return true; });
      assert.equal(f.service.status().inputObservation.reason, 'unavailable'); assert.equal(f.inputs().length, 0);
    } finally { await f.service.close(); }
  }
  const f = fixture(); f.observer.hook = request => request.reject(Object.assign(new Error('private'), {
    code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', reason: 'private-owner-path', details: { inputObserver: valid }
  }));
  try {
    await assert.rejects(f.claim(), error => { assert.equal(error.code, 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY'); assert.equal(error.reason, undefined); assert.ok(!error.message.includes('private')); return true; });
    assert.equal(f.service.status().inputObservation.reason, 'instance_in_use');
  } finally { await f.service.close(); }
});

test('startup pause labels require the matching bounded frame', async () => {
  for (const startupFailure of [undefined, { type: 'startup-failure', stage: 'instance-gate', win32Error: 5 },
    { type: 'startup-failure', stage: 'instance-gate', win32Error: 183, private: true }]) {
    const f = fixture();
    try { await f.claim(); f.observer.pause({ reason: 'instance_in_use', startupFailure }); assert.equal(f.service.status().inputObservation.reason, 'unavailable'); }
    finally { await f.service.close(); }
  }
});

test('conditional completion refuses an observer pause even before the service receives its callback', async () => {
  const f = fixture();
  try {
    await f.claim();
    assert.equal(f.service.status().session.state, 'active');
    f.observer.desktop = { ...f.observer.desktop, phase: 'paused', reason: 'physical_input', certainty: 'observed' };
    await assert.rejects(f.service.execute(cmd('complete', { requireActive: true })), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session.state, 'paused');
    assert.equal(f.service.status().inputObservation.reason, 'physical_input');
    await assert.rejects(f.service.execute(cmd('claim', { session: 'next', windowId: target.id })), { code: 'DESKTOP_CONTROL_BUSY' });
    await f.service.execute(cmd('release')); assert.equal(f.service.status().session, null);
  } finally { await f.service.close(); }
});

test('conditional completion remains an immediate cancellation of an active pending read', async () => {
  const pending = deferred(); let reading = false;
  const f = fixture({ request(operation) { if (operation === 'window.observe') { reading = true; return pending.promise; } } });
  try {
    await f.claim(); const read = f.read(); const rejected = assert.rejects(read, { code: 'DESKTOP_USER_IN_CONTROL' });
    await turn(); assert.equal(reading, true);
    const completed = f.service.execute(cmd('complete', { requireActive: true }));
    assert.equal(f.service.status().session, null, 'No await between current observation validation and end');
    assert.equal((await completed).session, null);
    pending.resolve({ windowId: target.id, version, elements: [] }); await rejected;
  } finally { pending.resolve({ windowId: target.id, version, elements: [] }); await f.service.close(); }
});

test('automatic admission pauses report their actual cause instead of a user takeover', async () => {
  for (const status of ['occupied', 'unknown', 'throws']) {
    let denied = false;
    const f = fixture({ admission: async () => {
      if (denied && status === 'throws') throw new Error('private discovery failure');
      return { status: denied ? status : 'unmanaged', reason: 'fixture', matches: [], gaps: [] };
    } });
    try {
      await f.claim(); denied = true;
      await assert.rejects(f.read(), { code: status === 'occupied' ? 'DESKTOP_CONTROL_OCCUPIED' : 'DESKTOP_CONTROL_STATE_UNKNOWN' });
      const state = f.service.status(); assert.equal(state.session.state, 'paused');
      assert.equal(state.inputObservation.reason, status === 'occupied' ? 'control_occupied' : 'control_state_unknown');
      assert.equal(state.inputObservation.certainty, 'unknown');
      assert.ok(state.inputObservation.message.length > 0); assert.ok(!state.inputObservation.message.includes('private'));
    } finally { await f.service.close(); }
  }
});

test('operation failures explain paused state without overwriting an already observed takeover', async () => {
  for (const [code, reason] of [['DESKTOP_OUTCOME_UNKNOWN', 'outcome_unknown'], ['DESKTOP_DESKTOP_LOCKED', 'desktop_locked'],
    ['DESKTOP_DRIVER_STOP_UNCONFIRMED', 'driver_stop_unconfirmed'], ['DESKTOP_INPUT_FAILED', 'outcome_unknown'], ['DESKTOP_FOCUS_CHANGED', 'outcome_unknown']]) {
    const f = fixture({ request(operation) { if (operation === 'window.action') throw Object.assign(new Error('private provider text'), { code }); } });
    try {
      await f.claim(); await assert.rejects(f.service.execute(action()));
      assert.equal(f.service.status().inputObservation.reason, reason);
      assert.equal(f.service.status().inputObservation.certainty, 'unknown');
      assert.ok(!f.service.status().inputObservation.message.includes('private'));
    } finally { await f.service.close(); }
  }
  const f = fixture({ request(operation, _params, _driver, { observer }) {
    if (operation === 'window.action') { observer.pause(); throw Object.assign(new Error('late failure'), { code: 'DESKTOP_OUTCOME_UNKNOWN' }); }
  } });
  try {
    await f.claim(); await assert.rejects(f.service.execute(action()));
    assert.equal(f.service.status().inputObservation.reason, 'physical_input');
    assert.equal(f.service.status().inputObservation.certainty, 'observed');
  } finally { await f.service.close(); }
});

test('a failed pending action cannot renew an expired lease before its timer callback runs', async () => {
  const pending = deferred();
  const f = fixture({ request(operation) { if (operation === 'window.action') return pending.promise; } });
  try {
    await f.claim(); const command = action(), result = f.service.execute(command);
    const rejected = assert.rejects(result, { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    await turn(); f.advance(300001);
    pending.reject(Object.assign(new Error('unconfirmed input'), { code: 'DESKTOP_OUTCOME_UNKNOWN' }));
    await rejected; assert.equal(f.service.status().session, null);
    assert.equal((await f.service.execute(cmd('receipt', { requestId: command.requestId }))).state, 'failed');
  } finally { pending.reject(new Error('cleanup')); await f.service.close(); }
});

test('notice failures pause current control without replacing or renewing an existing pause', async () => {
  const f = fixture();
  try {
    await f.claim(); f.service.noticeUnavailable();
    const first = f.service.status(); assert.equal(first.inputObservation.reason, 'notice_unavailable');
    assert.equal(first.inputObservation.certainty, 'unknown');
    f.advance(1000); f.service.noticeUnavailable(); assert.deepEqual(f.service.status(), first);
    await f.service.execute(cmd('resume')); f.observer.pause();
    const physical = f.service.status(); f.advance(1000); f.service.noticeUnavailable();
    assert.deepEqual(f.service.status(), physical);
    f.advance(300001); f.service.noticeUnavailable(); assert.equal(f.service.status().session, null);
  } finally { await f.service.close(); }
});

test('notice failure during ARM prevents a late acknowledgement from activating control', async () => {
  const f = fixture(); f.observer.auto = false;
  try {
    const pending = f.claim(), rejected = assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    await turn(); assert.equal(f.service.status().inputObservation.phase, 'arming');
    f.service.noticeUnavailable(); assert.equal(f.service.status().inputObservation.reason, 'notice_unavailable');
    f.observer.ack(); await rejected; assert.equal(f.service.status().session.state, 'paused');
  } finally { await f.service.close(); }
});
class Observer {
  connected = true; epoch = 'epoch'; desktop = null; arms = []; disarms = []; detached = 0; auto = true; hook;
  constructor(onPause, trace) { this.onPause = onPause; this.trace = trace; }
  snapshot() { return { connected: this.connected, epoch: this.epoch, desktop: this.desktop && { ...this.desktop } }; }
  arm(generation, marker) {
    const previous = this.desktop?.phase === 'ready' ? this.desktop.generation : undefined;
    this.desktop = { generation, epoch: this.epoch, phase: 'arming', ...(previous ? { previousGeneration: previous } : {}) };
    const request = { generation, marker, ...deferred() }; this.arms.push(request); this.trace.push('arm');
    if (this.hook) this.hook(request); else if (this.auto) this.ack(request);
    return request.promise;
  }
  ack(request = this.arms.at(-1), patch = {}) {
    const value = { epoch: this.epoch, generation: request.generation, phase: 'ready', sequence: '0', ...patch };
    this.desktop = value; request.resolve({ ...value });
  }
  pause(extra = {}) {
    const event = { epoch: this.epoch, generation: this.desktop?.generation, reason: 'physical_input', certainty: 'observed', ...extra };
    if (this.desktop && (this.desktop.generation === event.generation || this.desktop.previousGeneration === event.generation)) this.desktop = { ...this.desktop, phase: 'paused', reason: event.reason, certainty: event.certainty };
    this.onPause(event);
  }
  disarm(generation) { this.trace.push('disarm'); this.disarms.push(generation); if (this.desktop?.generation === generation) this.desktop = null; }
  detach() { this.trace.push('detach'); this.detached++; }
}
for (const synchronous of [true, false]) test('notice provider errors pause before observer ARM, including synchronous throws: ' + synchronous, async () => {
  const f = fixture({ prepareControlNotice() { if (synchronous) throw new Error('no UI'); return Promise.reject(new Error('no UI')); } });
  try {
    await assert.rejects(f.claim(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    assert.equal(f.observer.arms.length, 0); assert.equal(f.service.busy, false);
    assert.equal(f.service.status().inputObservation.reason, 'notice_unavailable'); assert.equal(f.inputs().length, 0);
  } finally { await f.service.close(); }
});

for (const cancellation of ['takeover', 'stop', 'expire', 'close']) test('service cancels UI provider that ignores AbortSignal: ' + cancellation, async () => {
  const pending = deferred(); let signal;
  const f = fixture({ prepareControlNotice(value) { signal = value; return pending.promise; } });
  try {
    const claim = assert.rejects(f.claim(), { code: 'DESKTOP_USER_IN_CONTROL' }); await turn();
    if (cancellation === 'expire') { f.advance(300001); f.service.status(); }
    else if (cancellation === 'close') await f.service.close();
    else f.service.control(cancellation);
    await claim; assert.equal(signal.aborted, true); assert.equal(f.service.busy, false); assert.equal(f.observer.arms.length, 0);
    pending.resolve(); await turn(); assert.equal(f.observer.arms.length, 0); assert.equal(f.inputs().length, 0);
  } finally { pending.resolve(); await f.service.close(); }
});

test('synchronous UI cancellation followed by a throw retains user takeover', async () => {
  let f;
  f = fixture({ prepareControlNotice() { f.service.control('takeover'); throw new Error('late UI failure'); } });
  try {
    await assert.rejects(f.claim(), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().inputObservation.reason, 'user_takeover'); assert.equal(f.observer.arms.length, 0);
  } finally { await f.service.close(); }
});

function fixture(options = {}) {
  const drivers = [], calls = [], changes = [], trace = []; let service, observer, now = 100;
  const createDriver = () => {
    const driver = { id: drivers.length, inputMarker: options.noMarker ? undefined : (drivers.length + 1).toString(16).padStart(16, '0'), closed: false,
      close() { this.closed = true; trace.push('close:' + this.id); options.onClose?.(this, service); },
      async request(operation, params) {
        assert.equal(this.closed, false, 'closed fake driver reused'); calls.push({ operation, driver: this.id, params });
        if (options.request) { const result = options.request(operation, params, this, { service, observer }); if (result !== undefined) return result; }
        if (operation === 'windows') return { windows: [target, other] };
        if (operation === 'diagnostics') return { pure: true };
        if (operation === 'window.action') return { executed: true };
        return { windowId: target.id, version, truncated: false, elements: [], image: operation === 'window.screenshot' ? { coordinateInputAvailable: true, data: 'fake' } : null };
      } };
    drivers.push(driver); return driver;
  };
  service = new DesktopService({ platform: options.platform || 'win32', available: () => true, now: () => now, driver: createDriver,
    capture: options.capture, admission: options.admission, prepareControlNotice: options.prepareControlNotice,
    ...(options.noObserver ? {} : { inputObserver: callback => {
      if (options.observerFactory) return options.observerFactory(callback);
      observer = new Observer(callback, trace); return observer;
    } }),
    onChanged: value => { trace.push('changed:' + value.inputObservation.phase); changes.push(value); options.changed?.(value, service); }
  });
  return { service, get observer() { return observer; }, drivers, calls, changes, trace, advance: milliseconds => { now += milliseconds; },
    claim: () => service.execute(cmd('claim', { windowId: target.id })), read: () => service.execute(cmd('observe')),
    inputs: () => calls.filter(value => value.operation === 'window.action') };
}

test('without an observer control fails closed while catalog, doctor, preview and receipts remain read-only', async () => {
  const f = fixture({ noObserver: true });
  try {
    assert.equal(f.service.status().inputObservation.phase, 'unavailable');
    assert.equal((await f.service.windows()).windows.length, 2); await f.service.preview(target.id); await f.service.execute(cmd('doctor'));
    await assert.rejects(f.claim(), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
    await assert.rejects(f.service.resume(), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
    await assert.rejects(f.service.execute(cmd('receipt', { requestId: randomUUID() })), { code: 'DESKTOP_RECEIPT_UNAVAILABLE' });
    assert.equal(f.service.status().session, null); assert.equal(f.inputs().length, 0);
  } finally { f.service.close(); }
});
test('test bypass is explicit, needs an injected driver and is absent on an ordinary instance', async () => {
  assert.throws(() => new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true }), { code: 'DESKTOP_BAD_REQUEST' });
  const service = new DesktopService({ platform: 'win32', available: () => true, allowUnobservedTestDriver: true,
    driver: () => ({ close() {}, async request() { return { windows: [target] }; } }) });
  try { await service.execute(cmd('claim', { windowId: target.id })); assert.equal(service.status().inputObservation.unobservedTestDriver, true); }
  finally { service.close(); }
});
test('macOS does not instantiate an observer factory or issue Windows requests', async () => {
  let factories = 0; const f = fixture({ platform: 'darwin', observerFactory() { factories++; throw new Error('must not run'); } });
  try { await assert.rejects(f.claim(), { code: 'DESKTOP_PLATFORM_UNAVAILABLE' }); assert.equal(factories, 0); assert.equal(f.calls.length, 0); }
  finally { f.service.close(); }
});
test('claim reserves a paused arming owner and serializes concurrent transitions until its actual marker ACK', async () => {
  const f = fixture(); f.observer.auto = false;
  try {
    const pending = f.claim(); await turn(); const status = f.service.status();
    assert.equal(status.session.state, 'paused'); assert.equal(status.inputObservation.phase, 'arming');
    assert.equal(f.observer.arms[0].marker, f.drivers[1].inputMarker);
    await assert.rejects(f.service.resume(), { code: 'DESKTOP_BUSY' });
    await assert.rejects(f.claim(), { code: 'DESKTOP_BUSY' });
    await assert.rejects(f.service.execute(action()), { code: 'DESKTOP_INPUT_OBSERVER_PENDING' });
    f.observer.ack(); assert.equal((await pending).session.state, 'active'); assert.equal(f.service.status().inputObservation.phase, 'ready');
    assert.equal(f.inputs().length, 0);
  } finally { f.service.close(); }
});
test('missing driver marker and failed ARM never activate the owner', async () => {
  for (const noMarker of [true, false]) {
    const f = fixture({ noMarker });
    if (!noMarker) f.observer.hook = request => request.reject(Object.assign(new Error('unavailable'), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' }));
    try { await assert.rejects(f.claim(), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' }); assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers[1].closed, true); }
    finally { f.service.close(); }
  }
});
test('synchronous pause inside arm and late ACK cannot restore ownership', async () => {
  const f = fixture(); f.observer.hook = request => { f.observer.pause(); f.observer.ack(request); };
  try { await assert.rejects(f.claim(), { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.inputs().length, 0); }
  finally { f.service.close(); }
});
test('fresh observer snapshot is required even when the ARM promise itself resolved ready', async () => {
  const f = fixture(); f.observer.hook = request => { f.observer.ack(request); f.observer.desktop = { ...f.observer.desktop, phase: 'paused', reason: 'external_input', certainty: 'observed' }; };
  try { await assert.rejects(f.claim(), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' }); assert.equal(f.service.status().session.state, 'paused'); }
  finally { f.service.close(); }
});
for (const mode of ['takeover', 'stop', 'close', 'expire']) test('pending ARM cannot undo ' + mode, async () => {
  const f = fixture(); f.observer.auto = false;
  try {
    const pending = f.claim(); await turn();
    if (mode === 'close') f.service.close(); else if (mode === 'expire') { f.advance(300001); f.service.status(); } else f.service.control(mode);
    f.observer.ack(); await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session?.state === 'active', false); assert.equal(f.inputs().length, 0);
  } finally { f.service.close(); }
});
test('return delegates to asynchronous resume and requires a fresh read after the new marker is armed', async () => {
  const f = fixture();
  try {
    await f.claim(); f.service.control('takeover'); f.observer.auto = false;
    const pending = f.service.control('return'); assert.equal(typeof pending.then, 'function'); await turn();
    assert.equal(f.service.status().inputObservation.phase, 'arming'); assert.notEqual(f.observer.arms[0].marker, f.observer.arms[1].marker);
    f.observer.ack(); await pending;
    await assert.rejects(f.service.execute(action()), { code: 'DESKTOP_FRESH_OBSERVATION_REQUIRED' });
    await f.read(); assert.equal((await f.service.execute(action())).executed, true);
  } finally { f.service.close(); }
});
test('UIA actions also reject a silent loss of observer readiness before dispatch', async () => {
  for (const params of [{ kind: 'invoke', ref: 'e1' }, { kind: 'set_value', ref: 'e1', value: 'test' }, { kind: 'focus', ref: 'e1' }]) {
    const f = fixture();
    try { await f.claim(); f.observer.desktop.phase = 'paused'; await assert.rejects(f.service.execute(action({ params: { version, ...params } })), { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.inputs().length, 0); }
    finally { f.service.close(); }
  }
});
test('select rotates driver and revision while prior-generation activity can pause its pending rearm', async () => {
  const f = fixture();
  try {
    await f.claim(); const old = f.observer.arms[0].generation, revision = f.service.owner.revision;
    f.observer.auto = false; const selecting = f.service.execute(cmd('select', { windowId: other.id })); await turn();
    assert.ok(f.service.owner.revision > revision); assert.equal(f.drivers[1].closed, true); assert.equal(f.service.status().inputObservation.phase, 'arming');
    f.observer.pause({ generation: old }); f.observer.ack();
    await assert.rejects(selecting, { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers[2].closed, true);
  } finally { f.service.close(); }
});
test('read recovery leaves observation pending and re-arms only on the next explicit read', async () => {
  const f = fixture({ request(operation, _params, driver) { if (operation === 'window.observe' && driver.id === 1) throw Object.assign(new Error('read'), { code: 'DESKTOP_READ_INTERRUPTED' }); } });
  try {
    await f.claim(); const revision = f.service.owner.revision;
    await assert.rejects(f.read(), { code: 'DESKTOP_READ_INTERRUPTED' }); assert.equal(f.observer.arms.length, 1);
    assert.ok(f.service.owner.revision > revision); assert.equal(f.service.status().session.state, 'active'); assert.equal(f.service.status().inputObservation.phase, 'pending');
    await assert.rejects(f.service.execute(action()), { code: 'DESKTOP_INPUT_OBSERVER_PENDING' });
    assert.equal(f.observer.disarms.length, 0); await f.read(); assert.equal(f.observer.arms.length, 2);
    assert.equal(f.service.status().inputObservation.phase, 'ready'); assert.equal((await f.service.execute(action())).executed, true);
  } finally { f.service.close(); }
});
test('old observer remains able to stop a pending read-recovery driver before any rearm', async () => {
  const f = fixture({ request(operation, _params, driver) { if (operation === 'window.observe' && driver.id === 1) throw Object.assign(new Error('read'), { code: 'DESKTOP_READ_INTERRUPTED' }); } });
  try { await f.claim(); await assert.rejects(f.read()); f.observer.pause(); await assert.rejects(f.read(), { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.observer.arms.length, 1); assert.equal(f.drivers[2].closed, true); }
  finally { f.service.close(); }
});
test('automatic read recovery cannot turn a silently paused or disconnected observer into a fresh ARM', async () => {
  for (const mode of ['paused', 'disconnected']) {
    const f = fixture({ request(operation, _params, driver) { if (operation === 'window.observe' && driver.id === 1) throw Object.assign(new Error('read'), { code: 'DESKTOP_READ_INTERRUPTED' }); } });
    try {
      await f.claim(); await assert.rejects(f.read());
      if (mode === 'paused') f.observer.desktop.phase = 'paused'; else f.observer.connected = false;
      await assert.rejects(f.read(), { code: 'DESKTOP_USER_IN_CONTROL' });
      assert.equal(f.observer.arms.length, 1); assert.equal(f.service.status().session.state, 'paused');
    } finally { f.service.close(); }
  }
});
test('successful select uses the replacement marker and requires a fresh observation for its new window', async () => {
  const f = fixture();
  try {
    await f.claim(); const selected = await f.service.execute(cmd('select', { windowId: other.id }));
    assert.equal(selected.session.window.id, other.id); assert.equal(selected.inputObservation.phase, 'ready');
    assert.equal(f.observer.arms[1].marker, f.drivers[2].inputMarker);
    await assert.rejects(f.service.execute(action()), { code: 'DESKTOP_FRESH_OBSERVATION_REQUIRED' });
    await f.read(); assert.equal(f.calls.filter(call => call.operation === 'window.observe').at(-1).params.windowId, other.id);
    assert.equal((await f.service.execute(action())).executed, true);
  } finally { f.service.close(); }
});
test('wait timeout retires a pending read and requires rearm before another explicit observation', async () => {
  const f = fixture({ request(operation, _params, driver) { if (operation === 'window.observe' && driver.id === 1) return new Promise(() => {}); } });
  try {
    await f.claim(); const waited = await f.service.execute(cmd('wait', { condition: { name: 'done' }, timeoutMs: 100, intervalMs: 100 }));
    assert.equal(waited.timedOut, true); assert.equal(f.service.status().inputObservation.phase, 'pending'); assert.equal(f.observer.arms.length, 1);
    await assert.rejects(f.service.execute(action()), { code: 'DESKTOP_INPUT_OBSERVER_PENDING' }); await f.read(); assert.equal(f.observer.arms.length, 2);
  } finally { f.service.close(); }
});
test('pause invalidates coordinates and state before close/disarm and only then notifies', async () => {
  const states = []; const f = fixture({ onClose(driver, service) { if (driver.id === 1) states.push({ state: service.status().session?.state, coordinate: service.owner?.coordinateVersion }); } });
  try {
    await f.claim(); await f.service.execute(cmd('screenshot')); assert.equal(f.service.owner.coordinateVersion, version); f.trace.length = 0;
    f.observer.pause(); assert.deepEqual(states.at(-1), { state: 'paused', coordinate: undefined });
    assert.deepEqual(f.trace, ['close:1', 'disarm', 'changed:paused']); assert.equal(f.service.status().inputObservation.reason, 'physical_input');
  } finally { f.service.close(); }
});
for (const observeAfter of [false, true]) test('confirmed action outcome survives observer pause and receipt replay, observeAfter=' + observeAfter, async () => {
  const f = fixture({ request(operation, _params, _driver, context) { if (operation === 'window.action') { context.observer.pause(); return { executed: true }; } } });
  try {
    await f.claim(); const request = action({ observeAfter }), result = await f.service.execute(request);
    assert.equal(result.executed, true); assert.equal(result.requiresObservation, true); assert.equal(f.service.status().session.state, 'paused');
    assert.deepEqual(await f.service.execute(request), result); assert.equal(f.inputs().length, 1);
    const receipt = await f.service.execute(cmd('receipt', { requestId: request.requestId })); assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.result.executed, true);
  } finally { f.service.close(); }
});
test('pause during asynchronous capture prevents a late screenshot from restoring coordinate authority', async () => {
  const image = deferred(); const f = fixture({ capture: () => image.promise });
  try { await f.claim(); const pending = f.service.execute(cmd('screenshot')); await turn(); f.observer.pause(); image.resolve({ coordinateInputAvailable: true }); await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.service.owner.coordinateVersion, undefined); }
  finally { f.service.close(); }
});
test('stale generation events cannot pause a later explicit resume and close only detaches its observer lease', async () => {
  const f = fixture();
  try {
    await f.claim(); const old = f.observer.arms[0].generation; f.service.control('takeover'); await f.service.resume(); await f.read();
    f.observer.pause({ generation: old }); assert.equal(f.service.status().session.state, 'active'); assert.equal((await f.service.execute(action())).executed, true);
    f.service.close(); assert.equal(f.observer.detached, 1); assert.equal(f.observer.desktop, null); f.service.close(); assert.equal(f.observer.detached, 1);
  } finally { f.service.close(); }
});
test('real broker fake transport ACK plus activity in one chunk cannot activate the service owner', async () => {
  class Input extends EventEmitter { writable = true; destroyed = false; writableLength = 0; write() { return true; } end() { this.writable = false; } }
  const child = new EventEmitter(); child.stdin = new Input(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const chunk = (...values) => child.stdout.emit('data', Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n'));
  let broker;
  const f = fixture({ observerFactory(onPause) { broker = new WindowsInputBroker({ onPause, spawn: () => child, createEpoch: () => 'broker-epoch' }); return {
    arm: (generation, marker) => broker.arm(generation, marker), disarm: generation => broker.disarm(generation), snapshot: () => broker.snapshot(), detach() {}
  }; } });
  try {
    const pending = f.claim(); await turn(); chunk({ type: 'status', status: 'ready', pid: 0 }, { type: 'status', status: 'sync-complete', activeCount: 0 });
    const generation = broker.snapshot().desktop.generation;
    chunk({ type: 'desktop-armed', epoch: 'broker-epoch', generation, sequence: '0' },
      { type: 'input-activity', epoch: 'broker-epoch', generation, sequence: '1', kind: 'keyboard', injected: false });
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.inputs().length, 0);
  } finally { f.service.close(); const done = broker.dispose(); child.emit('close', 0); await done; }
});
