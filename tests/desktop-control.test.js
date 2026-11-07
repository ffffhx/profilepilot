const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const target = { id: 'a'.repeat(32), title: 'Fixture', process: 'fixture', pid: 1, className: 'Form' };
const version = 'b'.repeat(32);
function fixture(overrides = {}) {
  let now = 100, inputs = 0;
  const drivers = [];
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, now: () => now, driver: () => {
    let closed = false;
    const driver = { close() { closed = true; }, async request(op, params) {
      assert.equal(closed, false, 'stopped driver was reused');
      if (overrides.request) return overrides.request(op, params);
      if (op === 'windows') return { windows: [target] };
      if (op === 'window.observe') return { windowId: target.id, version, elements: [] };
      if (op === 'window.screenshot') return { windowId: target.id, version, image: { data: 'image' }, elements: [] };
      if (op === 'window.action') { inputs++; return { executed: true }; }
    } }; drivers.push(driver); return driver;
  } });
  return { service, drivers, get inputs() { return inputs; }, advance(ms) { now += ms; } };
}
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'test', ...extra });
const claim = service => service.execute(command('claim', { windowId: target.id }));

test('desktop has one owner; handoff blocks input, completion cannot silently restart', async () => {
  const f = fixture();
  try {
    await claim(f.service);
    await assert.rejects(f.service.execute(command('claim', { session: 'other', windowId: target.id })), { code: 'DESKTOP_CONTROL_BUSY' });
    await f.service.execute(command('handoff'));
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_USER_IN_CONTROL' });
    await assert.rejects(claim(f.service), { code: 'DESKTOP_USER_IN_CONTROL' });
    await f.service.execute(command('resume'));
    assert.equal((await f.service.execute(command('observe'))).version, version);
    await f.service.execute(command('complete'));
    await assert.rejects(claim(f.service), { code: 'DESKTOP_SESSION_ENDED' });
  } finally { f.service.close(); }
});
test('action receipts prevent duplicate input and reject changed arguments', async () => {
  const f = fixture();
  try {
    await claim(f.service);
    const action = command('action', { requestId: randomUUID(), params: { version, ref: 'e1', kind: 'invoke' } });
    await f.service.execute(action); await f.service.execute(action);
    assert.equal(f.inputs, 1);
    await assert.rejects(f.service.execute({ ...action, params: { ...action.params, kind: 'toggle' } }), { code: 'DESKTOP_REQUEST_CHANGED' });
  } finally { f.service.close(); }
});

test('conditional completion preserves a takeover that happened after the caller last read status', async () => {
  const f = fixture();
  try {
    await claim(f.service);
    assert.equal(f.service.status().session.state, 'active');
    f.service.control('takeover');
    await assert.rejects(f.service.execute(command('complete', { requireActive: true })), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session.state, 'paused');
    await assert.rejects(f.service.execute(command('claim', { session: 'next', windowId: target.id })), { code: 'DESKTOP_CONTROL_BUSY' });
    await f.service.execute(command('release'));
    assert.equal(f.service.status().session, null);
  } finally { await f.service.close(); }
});

test('conditional completion ends an active task and never revives a stopped one', async () => {
  const f = fixture();
  try {
    await claim(f.service);
    assert.equal((await f.service.execute(command('complete', { requireActive: true }))).session, null);
    await assert.rejects(f.service.execute(command('complete', { requireActive: true })), { code: 'DESKTOP_SESSION_ENDED' });
    await assert.rejects(claim(f.service), { code: 'DESKTOP_SESSION_ENDED' });
  } finally { await f.service.close(); }
});

test('CLI conditional completion flag is forwarded only for complete', async () => {
  let called = 0, output = '';
  const io = { stdout: { write: value => { output += value; } }, stderr: { write() {} } };
  const request = async command => { called++; assert.equal(command.requireActive, true); return { ok: true, data: { session: null } }; };
  assert.equal(await runDesktopCli(['complete', '--session', 'test', '--require-active'], request, io), 0);
  assert.equal(called, 1);
  for (const method of ['release', 'resume', 'handoff', 'claim', 'observe', 'status']) {
    assert.equal(await runDesktopCli([method, '--session', 'test', '--require-active'], request, io), 2);
  }
  assert.equal(called, 1);
});
test('expired lease ends the session; status polls do not renew it', async () => {
  const f = fixture();
  try { await claim(f.service); f.advance(299999); assert.ok(f.service.status().session); f.advance(2); assert.equal(f.service.status().session, null); await assert.rejects(claim(f.service), { code: 'DESKTOP_SESSION_ENDED' }); }
  finally { f.service.close(); }
});
test('a user stop during claim cannot grant ownership after the stop', async () => {
  let resolve;
  const f = fixture({ request: () => new Promise(done => { resolve = done; }) });
  try {
    const pending = claim(f.service); await new Promise(done => setImmediate(done));
    f.service.control('stop'); resolve({ windows: [target] });
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session, null);
  } finally { f.service.close(); }
});
test('handoff between window enumeration and observation cannot dispatch another read', async () => {
  let resolve, calls = 0;
  const f = fixture({ request: async op => {
    calls++;
    if (calls === 1) return { windows: [target] };
    return new Promise(done => { resolve = done; });
  } });
  try {
    await claim(f.service);
    const pending = f.service.execute(command('observe')); await new Promise(done => setImmediate(done));
    f.service.control('takeover'); resolve({ windows: [target] });
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' }); assert.equal(calls, 2);
  } finally { f.service.close(); }
});
test('unknown input outcome pauses ownership and keeps the rejected receipt', async () => {
  let inputs = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    inputs++; throw Object.assign(new Error('unknown'), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  } });
  try {
    await claim(f.service);
    const action = command('action', { requestId: randomUUID(), params: { version, ref: 'e1', kind: 'invoke' } });
    await assert.rejects(f.service.execute(action), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    assert.equal(f.service.status().session.state, 'paused');
    await assert.rejects(f.service.execute(action), { code: 'DESKTOP_OUTCOME_UNKNOWN' }); assert.equal(inputs, 1);
    await f.service.control('return');
    await assert.rejects(f.service.execute(action), { code: 'DESKTOP_OUTCOME_UNKNOWN' }); assert.equal(inputs, 1);
  } finally { f.service.close(); }
});
test('macOS reports unsupported without starting a native Windows driver', async () => {
  const service = new DesktopService({ platform: 'darwin', driver: () => ({ close() {}, request() { throw new Error('must not run'); } }) });
  try { assert.equal(service.status().supported, false); await assert.rejects(service.execute(command('windows')), { code: 'DESKTOP_PLATFORM_UNAVAILABLE' }); }
  finally { service.close(); }
});
test('desktop CLI preserves Unicode JSON and uses ProfilePilot management; invalid parameters never dispatch', async () => {
  const calls = []; let output = '';
  const io = { stdout: { write: value => output += value }, stderr: { write() {} } };
  const request = async command => { calls.push(command); return { ok: true, data: { executed: true } }; };
  const value = '你好 & $() ` "';
  assert.equal(await runDesktopCli(['action', '--session', 'task', '--params-stdin'], request, io, Readable.from([JSON.stringify({ version, ref: 'e1', kind: 'set_value', value })])), 0);
  assert.equal(calls[0].action, 'desktop'); assert.equal(calls[0].params.value, value); assert.ok(calls[0].requestId);
  for (const args of [['claim'], ['windows', '--window', target.id], ['action', '--session', 'task']]) assert.equal(await runDesktopCli(args, request, io), 2);
  assert.equal(calls.length, 1);
});
for (const coordinateInputAvailable of [false, undefined, null, 'true']) test(`coordinate input requires an explicit true map permission: ${String(coordinateInputAvailable)}`, async () => {
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true,
    capture: async (_window, image) => ({ ...image, coordinateInputAvailable }),
    driver: () => ({ close() {}, async request(op) {
      if (op === 'windows') return { windows: [target] };
      if (op === 'window.screenshot') return { version, image: { data: 'image' } };
      throw new Error('Coordinate input must not reach the driver');
    } })
  });
  try {
    await claim(service); await service.execute(command('screenshot'));
    for (const kind of ['click', 'double_click', 'move', 'drag', 'wheel']) {
      await assert.rejects(service.execute(command('action', { requestId: randomUUID(), params: { kind, version, x: 10, y: 10, ...(kind === 'drag' ? { toX: 20, toY: 20 } : {}), ...(kind === 'wheel' ? { deltaY: -120 } : {}) } })), { code: 'DESKTOP_SCREENSHOT_REQUIRED' });
    }
  } finally { service.close(); }
});

test('action with observation returns a next version; receipt lookup never repeats input or reads', async () => {
  let reads = 0, inputs = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.action') { inputs++; return { executed: true, requiresObservation: true }; }
    if (op === 'window.observe') { reads++; return { version, elements: [] }; }
  } });
  try {
    await claim(f.service);
    const action = command('action', { observeAfter: true, requestId: randomUUID(), params: { version, kind: 'invoke', ref: 'e1' } });
    const result = await f.service.execute(action);
    assert.equal(result.executed, true); assert.equal(result.requiresObservation, false); assert.equal(result.observation.version, version);
    assert.deepEqual(await f.service.execute(action), result);
    assert.equal(inputs, 1); assert.equal(reads, 1);
    await assert.rejects(f.service.execute({ ...action, observeAfter: false }), { code: 'DESKTOP_REQUEST_CHANGED' });
  } finally { f.service.close(); }
});

test('successful input followed by failed observation is explicit and cannot be replayed', async () => {
  let inputs = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.action') { inputs++; return { executed: true }; }
    throw Object.assign(new Error('provider timed out'), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  } });
  try {
    await claim(f.service);
    const action = command('action', { observeAfter: true, requestId: randomUUID(), params: { version, kind: 'invoke', ref: 'e1' } });
    const result = await f.service.execute(action);
    assert.equal(result.executed, true); assert.equal(result.requiresObservation, true); assert.equal(result.observationError.code, 'DESKTOP_OUTCOME_UNKNOWN');
    assert.equal(f.service.status().session.state, 'paused');
    assert.deepEqual(await f.service.execute(action), result); assert.equal(inputs, 1);
  } finally { f.service.close(); }
});

test('handoff after confirmed input prevents the optional read without losing executed outcome', async () => {
  let inputs = 0, reads = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.action') { inputs++; f.service.control('takeover'); return { executed: true }; }
    reads++; throw new Error('must not observe after handoff');
  } });
  try {
    await claim(f.service);
    const result = await f.service.execute(command('action', { observeAfter: true, requestId: randomUUID(), params: { version, kind: 'invoke', ref: 'e1' } }));
    assert.equal(result.executed, true); assert.equal(result.observationError.code, 'DESKTOP_USER_IN_CONTROL');
    assert.equal(inputs, 1); assert.equal(reads, 0);
  } finally { f.service.close(); }
});

test('late handoff after the post-observation discards its refs but preserves confirmed input', async () => {
  let inputs = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.action') { inputs++; return { executed: true }; }
    if (op === 'window.observe') {
      queueMicrotask(() => queueMicrotask(() => f.service.control('takeover')));
      return { version, elements: [] };
    }
  } });
  try {
    await claim(f.service);
    const action = command('action', { observeAfter: true, requestId: randomUUID(), params: { version, kind: 'invoke', ref: 'e1' } });
    const result = await f.service.execute(action);
    assert.equal(result.executed, true); assert.equal(result.requiresObservation, true); assert.equal(result.observation, undefined);
    assert.equal(result.observationError.code, 'DESKTOP_USER_IN_CONTROL');
    assert.deepEqual(await f.service.execute(action), result); assert.equal(inputs, 1);
  } finally { f.service.close(); }
});

for (const code of ['DESKTOP_INPUT_FAILED', 'DESKTOP_FOCUS_CHANGED']) test(`${code} is reconciled as partial input, pauses ownership, and retains receipt`, async () => {
  let inputs = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    inputs++; throw Object.assign(new Error(code), { code });
  } });
  try {
    await claim(f.service);
    const action = command('action', { requestId: randomUUID(), params: { version, kind: 'press_key', keys: ['CTRL', 'A'] } });
    await assert.rejects(f.service.execute(action), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    assert.equal(f.service.status().session.state, 'paused');
    await assert.rejects(f.service.execute(action), { code: 'DESKTOP_OUTCOME_UNKNOWN' }); assert.equal(inputs, 1);
  } finally { f.service.close(); }
});

test('closing a service cancels queued catalog work and cannot create a replacement helper', async () => {
  let release, calls = 0;
  const f = fixture({ request: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = f.service.windows(), queued = f.service.windows();
  const results = Promise.allSettled([first, queued]);
  await new Promise(resolve => setImmediate(resolve));
  f.service.close(); release({ windows: [target] });
  for (const result of await results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'DESKTOP_SERVICE_UNAVAILABLE'); }
  assert.equal(calls, 1); assert.equal(f.drivers.length, 1); assert.equal(f.service.status().available, false);
  await assert.rejects(f.service.execute(command('claim', { windowId: target.id })), { code: 'DESKTOP_SERVICE_UNAVAILABLE' });
});

test('image-only screenshots use the image operation and preserve a usable version', async () => {
  const calls = [];
  const f = fixture({ request: async (op, params) => {
    calls.push({ op, params });
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.screenshot') return { version, image: { data: 'image', coordinateInputAvailable: true }, elements: [], gaps: ['uia_skipped'] };
    if (op === 'window.action') return { executed: true };
    throw new Error('Unexpected UIA observation');
  } });
  try {
    await claim(f.service);
    await f.service.execute(command('screenshot', { screenshotOnly: true }));
    assert.equal(calls.find(call => call.op === 'window.screenshot').params.screenshotOnly, true);
    assert.equal((await f.service.execute(command('action', { requestId: randomUUID(), params: { version, kind: 'drag', x: 1, y: 2, toX: 3, toY: 4 } }))).executed, true);
  } finally { f.service.close(); }
});

test('CLI scopes new flags and rejects malformed drag/wheel before dispatch', async () => {
  const calls = []; const io = { stdout: { write() {} }, stderr: { write() {} } };
  const request = async command => { calls.push(command); return { ok: true, data: {} }; };
  assert.equal(await runDesktopCli(['screenshot', '--session', 'task', '--image-only'], request, io), 0);
  assert.equal(calls[0].screenshotOnly, true);
  const action = params => runDesktopCli(['action', '--session', 'task', '--params-stdin', '--observe'], request, io, Readable.from([JSON.stringify({ version, ...params })]));
  assert.equal(await action({ kind: 'wheel', x: 1, y: 2, deltaY: -120 }), 0); assert.equal(calls[1].observeAfter, true);
  for (const params of [{ kind: 'drag', x: 1, y: 2 }, { kind: 'wheel', x: 1, y: 2, deltaY: 0 }, { kind: 'wheel', x: 1, y: 2, deltaY: 1201 }, { kind: 'move' }]) assert.equal(await action(params), 2);
  assert.equal(await runDesktopCli(['observe', '--session', 'task', '--image-only'], request, io), 2);
  assert.equal(calls.length, 2);
});

test('doctor can inspect a paused target without input, ownership changes, or lease renewal', async () => {
  const calls = [];
  const f = fixture({ request: async (operation, params) => {
    calls.push({ operation, params });
    if (operation === 'windows') return { windows: [target] };
    if (operation === 'diagnostics') return { source: { pid: 20, integrity: { label: 'medium' } }, interactiveDesktop: true, target: { windowId: target.id } };
    throw new Error('Doctor must not dispatch input or reobserve the owner');
  } });
  try {
    await claim(f.service); f.service.control('takeover');
    const expiresAt = f.service.status().session.expiresAt;
    f.advance(1000);
    const result = await f.service.execute({ action: 'desktop', method: 'doctor', windowId: target.id });
    assert.equal(result.target.windowId, target.id); assert.equal(result.source.integrity.label, 'medium');
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.service.status().session.expiresAt, expiresAt);
    assert.deepEqual(calls.map(call => call.operation), ['windows', 'windows', 'diagnostics']);
  } finally { f.service.close(); }
});

test('CLI doctor needs no session and action failures preserve native diagnostic evidence', async () => {
  let output = ''; const calls = [];
  const io = { stdout: { write(value) { output += value; } }, stderr: { write() {} } };
  const request = async command => { calls.push(command); return { ok: true, data: { interactiveDesktop: true } }; };
  assert.equal(await runDesktopCli(['doctor', '--window', target.id], request, io), 0);
  assert.equal(calls[0].method, 'doctor'); assert.equal(calls[0].session, undefined); assert.equal(calls[0].windowId, target.id);
  const details = { cause: 'FOREGROUND_NOT_CONFIRMED', diagnostics: { source: { pid: 20 }, target: { pid: 21 }, activation: { apiAccepted: false } } };
  output = '';
  assert.equal(await runDesktopCli(['action', '--session', 'test', '--params-stdin'], async () => ({ ok: false, error: { code: 'DESKTOP_FOCUS_REQUIRED', message: 'foreground required', details } }), io, Readable.from([JSON.stringify({ kind: 'click', version, x: 2, y: 3 })])), 75);
  assert.deepEqual(JSON.parse(output).details, details);
});

test('CLI fresh-read and observer-pending refusals use control-state exit 75 without retrying input', async () => {
  for (const code of ['DESKTOP_FRESH_OBSERVATION_REQUIRED', 'DESKTOP_INPUT_OBSERVER_PENDING']) {
    let output = '', calls = 0; const requestId = randomUUID();
    const io = { stdout: { write(value) { output += value; } }, stderr: { write() {} } };
    const request = async () => { calls++; return { ok: false, error: { code, message: 'Check control state before continuing.' } }; };
    assert.equal(await runDesktopCli(['action', '--session', 'test', '--params-stdin', '--request-id', requestId], request, io,
      Readable.from([JSON.stringify({ kind: 'invoke', ref: 'e1', version })])), 75);
    assert.equal(calls, 1); assert.equal(JSON.parse(output).code, code); assert.equal(JSON.parse(output).requestId, requestId);
  }
});

test('an interrupted read prepares a fresh driver without retrying, renewing or returning control', async () => {
  let reads = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (++reads === 1) throw Object.assign(new Error('read stopped'), { code: 'DESKTOP_READ_INTERRUPTED' });
    return { version, elements: [] };
  } });
  try {
    await claim(f.service);
    const expiresAt = f.service.status().session.expiresAt;
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_READ_INTERRUPTED' });
    assert.equal(reads, 1); assert.equal(f.drivers.length, 3);
    assert.equal(f.service.status().session.state, 'active'); assert.equal(f.service.status().session.expiresAt, expiresAt);
    assert.equal((await f.service.execute(command('observe'))).version, version); assert.equal(reads, 2);
  } finally { f.service.close(); }
});

test('confirmed input with an interrupted optional read retains its receipt and needs only a fresh read', async () => {
  let inputs = 0, reads = 0;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    if (op === 'window.action') { inputs++; return { executed: true }; }
    if (++reads === 1) throw Object.assign(new Error('read stopped'), { code: 'DESKTOP_READ_INTERRUPTED' });
    return { version, elements: [] };
  } });
  try {
    await claim(f.service);
    const input = command('action', { requestId: randomUUID(), observeAfter: true, params: { version, ref: 'e1', kind: 'invoke' } });
    const result = await f.service.execute(input);
    assert.equal(result.executed, true); assert.equal(result.observationError.code, 'DESKTOP_READ_INTERRUPTED');
    assert.equal(f.service.status().session.state, 'active'); assert.equal(f.drivers.length, 3);
    assert.deepEqual(await f.service.execute(input), result); assert.equal(inputs, 1); assert.equal(reads, 1);
    assert.equal((await f.service.execute(command('observe'))).version, version); assert.equal(reads, 2);
  } finally { f.service.close(); }
});

for (const intervention of ['takeover', 'stop', 'close', 'expire']) test(`read recovery cannot override ${intervention}`, async () => {
  let rejectRead;
  const f = fixture({ request: async op => {
    if (op === 'windows') return { windows: [target] };
    return new Promise((_, reject) => { rejectRead = reject; });
  } });
  try {
    await claim(f.service);
    const pending = f.service.execute(command('observe')); await new Promise(resolve => setImmediate(resolve));
    if (intervention === 'close') f.service.close();
    else if (intervention === 'expire') f.advance(300001);
    else f.service.control(intervention);
    const drivers = f.drivers.length;
    rejectRead(Object.assign(new Error('read stopped'), { code: 'DESKTOP_READ_INTERRUPTED' }));
    await assert.rejects(pending, { code: 'DESKTOP_READ_INTERRUPTED' });
    assert.equal(f.drivers.length, drivers);
    if (intervention === 'takeover') assert.equal(f.service.status().session.state, 'paused');
    else assert.equal(f.service.status().session, null);
  } finally { f.service.close(); }
});
