const test = require('node:test');
const assert = require('node:assert/strict');
const harness = import('../scripts/verify-desktop-lease-expiry.mjs');
const round = { session: 'lease-own', requestId: 'original-id', windowId: 'window-own' };
function state(mode = 'active') {
  return { session: { name: round.session, window: { pid: 100 }, state: mode, expiresAt: 301010 },
    inputObservation: { available: true, phase: mode === 'active' ? 'ready' : 'paused', epoch: 'epoch', generation: 'generation',
      ...(mode === 'paused' ? { reason: 'user_takeover', certainty: 'observed', message: 'Paused by user' } : {}) } };
}
const timing = { commandStart: 1000, commandEnd: 1100, wallNow: 1200, monoNow: 200 };
async function anchor(mode = 'active') {
  return (await harness).createLeaseAnchor(state(mode), { session: round.session, pid: 100, mode }, timing);
}

test('lease harness import is inert and default/check modes cannot request a shorter lease', async () => {
  const { parseOptions, LEASE_MS } = await harness;
  assert.equal(LEASE_MS, 300000);
  assert.deepEqual(parseOptions([]), { run: false }); assert.deepEqual(parseOptions(['--check']), { run: false });
  assert.deepEqual(parseOptions(['--run']), { run: true });
  for (const args of [['--run', '--run'], ['--run', '--check'], ['--ttl', '1000'], ['--run', '--duration', '1000'], ['--force'], ['--clock', 'future']]) assert.throws(() => parseOptions(args));
});

test('idle guard accepts only exact status, target doctor and the original concrete receipt', async () => {
  const { assertIdleCommand } = await harness;
  for (const command of [['status'], ['doctor', '--window', round.windowId], ['receipt', '--session', round.session, '--request-id', round.requestId]]) {
    assert.doesNotThrow(() => assertIdleCommand(command, round));
  }
  for (const method of ['claim', 'observe', 'screenshot', 'wait', 'action', 'select', 'handoff', 'resume', 'complete', 'release', 'windows']) {
    assert.throws(() => assertIdleCommand([method, '--session', round.session], round));
  }
  for (const command of [['status', '--session', round.session], ['doctor'], ['doctor', '--window', 'other'],
    ['receipt', '--session', 'other', '--request-id', round.requestId], ['receipt', '--session', round.session, '--request-id', 'other'],
    ['receipt', '--session', round.session, '--request-id', round.requestId, '--observe']]) assert.throws(() => assertIdleCommand(command, round));
});

test('lease anchor is the real response deadline granted during the final setup command', async () => {
  const { createLeaseAnchor } = await harness;
  assert.equal((await anchor()).expiresAt, 301010);
  const expected = { session: round.session, pid: 100, mode: 'active' };
  for (const expiry of [1010, 300999, 301101, NaN, 301010.5]) {
    const value = state(); value.session.expiresAt = expiry; assert.throws(() => createLeaseAnchor(value, expected, timing));
  }
  assert.throws(() => createLeaseAnchor(state(), expected, { ...timing, wallNow: 40000 }));
});

test('paused anchor requires the explicit observed handoff and never accepts an unknown failure pause', async () => {
  const { createLeaseAnchor } = await harness; assert.equal((await anchor('paused')).input.reason, 'user_takeover');
  const expected = { session: round.session, pid: 100, mode: 'paused' };
  for (const mutate of [value => { value.inputObservation.reason = 'physical_input'; }, value => { value.inputObservation.certainty = 'unknown'; },
    value => { value.inputObservation.phase = 'arming'; }, value => { value.inputObservation.unobservedTestDriver = true; }]) {
    const value = state('paused'); mutate(value); assert.throws(() => createLeaseAnchor(value, expected, timing));
  }
});

test('read polling cannot silently renew, change owner, change helper generation or resume a pause', async () => {
  const { assertLeaseSample } = await harness;
  for (const mode of ['active', 'paused']) {
    const fixed = await anchor(mode); assert.equal(assertLeaseSample(state(mode), fixed, 12000, 11000), 'waiting');
    for (const mutate of [value => { value.session.expiresAt++; }, value => { value.session.name = 'other'; },
      value => { value.session.window.pid++; }, value => { value.session.state = mode === 'active' ? 'paused' : 'active'; },
      value => { value.inputObservation.generation = 'replacement'; }, value => { value.inputObservation.reason = 'physical_input'; }]) {
      const value = state(mode); mutate(value); assert.throws(() => assertLeaseSample(value, fixed, 12000, 11000));
    }
  }
});

test('expiry distinguishes early owner loss, elapsed expiry and a wall-clock jump', async () => {
  const { assertLeaseSample } = await harness, fixed = await anchor();
  const expired = { session: null, inputObservation: { phase: 'idle' } };
  assert.throws(() => assertLeaseSample(expired, fixed, 10000, 9000));
  assert.equal(assertLeaseSample(expired, fixed, fixed.expiresAt, fixed.expiresAt - 1000), 'expired');
  assert.throws(() => assertLeaseSample({ ...expired, inputObservation: { phase: 'ready' } }, fixed, fixed.expiresAt, fixed.expiresAt - 1000));
  assert.throws(() => assertLeaseSample(expired, fixed, fixed.expiresAt, 10000), /Wall clock/);
  assert.throws(() => assertLeaseSample(state(), fixed, fixed.expiresAt + 2000, fixed.expiresAt + 1000), /survived/);
});

function receipt() {
  return { session: round.session, requestId: round.requestId, state: 'succeeded', historical: true, requiresObservation: true,
    receivedAt: 1000, completedAt: 1100, result: { executed: true, observation: { version: 'old', elements: [] } } };
}
test('receipt evidence requires the same historical successful action including stable timestamps and result', async () => {
  const { assertHistoricalReceipt } = await harness, original = receipt();
  assert.doesNotThrow(() => assertHistoricalReceipt(receipt(), round, original));
  for (const mutate of [value => { value.requestId = 'other'; }, value => { value.session = 'other'; }, value => { value.state = 'pending'; },
    value => { value.completedAt++; }, value => { value.historical = false; }, value => { value.requiresObservation = false; },
    value => { value.result.executed = false; }, value => { value.result.observation.version = 'fresh'; }]) {
    const value = receipt(); mutate(value); assert.throws(() => assertHistoricalReceipt(value, round, original));
  }
});

test('expired probes use a new action ID and exact original replay, plus session-scoped resume', async () => {
  const { expiredProbeCommands, assertExpiredResponse } = await harness;
  assert.deepEqual(expiredProbeCommands(round, 'original.json', 'reject.json', 'new-id'), [
    ['action', '--session', round.session, '--params-file', 'reject.json', '--request-id', 'new-id', '--observe'],
    ['action', '--session', round.session, '--params-file', 'original.json', '--request-id', round.requestId, '--observe'],
    ['resume', '--session', round.session]
  ]);
  assert.throws(() => expiredProbeCommands(round, 'original.json', 'reject.json', round.requestId));
  assert.doesNotThrow(() => assertExpiredResponse({ ok: false, code: 'DESKTOP_SESSION_ENDED' }));
  for (const value of [{ ok: true, code: 'DESKTOP_SESSION_ENDED' }, { ok: false, code: 'DESKTOP_BAD_REQUEST' },
    { ok: false, code: 'DESKTOP_STALE_OBSERVATION' }, { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }]) assert.throws(() => assertExpiredResponse(value));
});

test('fresh fixture evidence catches a mutate-then-restore replay and refuses changed identity', async () => {
  const { assertFixtureUnchanged } = await harness;
  const baseline = { nonce: 'nonce', pid: 100, startedUtcTicks: '123', hwnd: '456', value: 'owned', changes: 1, sequence: 2 };
  assert.doesNotThrow(() => assertFixtureUnchanged({ ...baseline, sequence: 3 }, baseline));
  for (const change of [{ sequence: 2 }, { value: 'overwritten' }, { changes: 3 }, { pid: 101 }, { startedUtcTicks: '124' }, { nonce: 'other' }, { hwnd: '457' }]) {
    assert.throws(() => assertFixtureUnchanged({ ...baseline, sequence: 3, ...change }, baseline));
  }
});

test('normal exact-process exit avoids forcing; every fallback fails acceptance even if it reports original exit', async () => {
  const { confirmFixtureExit } = await harness; let calls = 0;
  const normal = await confirmFixtureExit(async () => ({ ok: true, originalExited: true }), async () => { calls++; });
  assert.equal(normal.ok, true); assert.equal(normal.forced, false); assert.equal(calls, 0);
  const reused = await confirmFixtureExit(async () => ({ ok: true, originalExited: true, replacementUntouched: true }), async () => { calls++; });
  assert.equal(reused.ok, true); assert.equal(calls, 0);
  for (const wait of [async () => ({ ok: true, originalExited: false, timedOut: true }), async () => { throw new Error('wait failed'); },
    async () => ({ ok: false, originalExited: true }), async () => ({ ok: true, originalExited: true, forced: true })]) {
    const result = await confirmFixtureExit(wait, async () => ({ ok: true, originalExited: true }));
    assert.equal(result.ok, false); assert.equal(result.forced, true);
  }
  const failed = await confirmFixtureExit(async () => ({}), async () => { throw new Error('identity changed'); });
  assert.equal(failed.ok, false); assert.equal(failed.fallbackError, 'identity changed');
});

test('cleanup never releases another owner and may release only its own failed or paused round', async () => {
  const { cleanupSessionDecision } = await harness;
  assert.equal(cleanupSessionDecision({ session: null }, round.session), 'none');
  for (const mode of ['active', 'paused']) assert.equal(cleanupSessionDecision(state(mode), round.session), 'release-owned');
  assert.equal(cleanupSessionDecision(state(), undefined), 'leave-other-owner');
  const other = state(); other.session.name = 'other'; assert.equal(cleanupSessionDecision(other, round.session), 'leave-other-owner');
});
