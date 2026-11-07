const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { isFixtureEntry, fixtureState, validateReady, faultCases, postReadyFaultSource, postReadyCases } = loadCli('scripts/e2e/desktop-notice-runtime.ts');
const harness = import('../scripts/verify-desktop-notice.mjs');

test('notice runtime is inert under Node import, and supports Electron default-app ESM entry', () => {
  assert.equal(isFixtureEntry(['electron', __filename], __filename, '42.3.3', 'browser'), true);
  assert.equal(isFixtureEntry(['node', __filename], __filename, undefined, undefined), false);
  assert.equal(isFixtureEntry(['electron', __filename + '.other'], __filename, '42.3.3', 'browser'), false);
  assert.equal(isFixtureEntry(['electron', __filename], __filename, '42.3.3', 'renderer'), false);
});

test('default/check never requests GUI; unsupported or combined mode flags are refused', async () => {
  const { parseOptions } = await harness;
  assert.deepEqual(parseOptions([]), { run: false, suite: 'startup' }); assert.deepEqual(parseOptions(['--check']), { run: false, suite: 'startup' });
  assert.deepEqual(parseOptions(['--run']), { run: true, suite: 'startup' });
  assert.deepEqual(parseOptions(['--run', '--case', 'post-ready']), { run: true, suite: 'post-ready' });
  assert.deepEqual(parseOptions(['--case', 'post-ready', '--check']), { run: false, suite: 'post-ready' });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--force'], ['--assisted-foreground'], ['--case'], ['--case', 'other'], ['--case', 'post-ready', '--case', 'post-ready']]) assert.throws(() => parseOptions(args));
});

test('copied asset faults alter only their owned JavaScript payload', async () => {
  const { fixtureAsset, noticeCases } = await harness;
  assert.deepEqual(noticeCases.slice(1), [...faultCases]);
  for (const kind of noticeCases) for (const name of ['desktop-control.html', 'desktop.css']) assert.equal(fixtureAsset(kind, name, 'original'), 'original');
  assert.equal(fixtureAsset('normal', 'desktop-control.js', 'original'), 'original');
  assert.equal(fixtureAsset('missing-preload', 'desktop-control.js', 'original'), 'original');
  assert.equal(fixtureAsset('missing-js', 'desktop-control.js', 'original'), undefined);
  assert.match(fixtureAsset('script-throw', 'desktop-control.js', 'original'), /^throw new Error/);
  assert.equal(fixtureAsset('no-ack', 'desktop-control.js', 'original'), '');
  assert.throws(() => fixtureAsset('normal', '../shared.js', 'original'));
});

test('simulated state is visibly named as a fixture and generation changes independently', () => {
  const first = fixtureState('nonce', 'first', 'arming'), next = fixtureState('nonce', 'second', 'ready');
  assert.match(first.session.name, /^notice-fixture-/); assert.match(first.session.window.title, /模拟会话/);
  assert.equal(first.session.state, 'paused'); assert.equal(next.session.state, 'active');
  assert.notEqual(first.inputObservation.generation, next.inputObservation.generation);
  assert.equal(fixtureState('nonce', '', 'idle').session, null);
});

test('fixture handshake rejects missing, extra and malformed readiness fields', () => {
  const valid = { generation: 'g1', documentNonce: '1cec77a4-1582-4ab7-a1d8-c972c6cda96b' };
  assert.deepEqual(validateReady(valid), valid);
  for (const value of [null, {}, { ...valid, generation: '' }, { ...valid, generation: 'x'.repeat(129) }, { ...valid, other: true }, { ...valid, documentNonce: 'other' }]) assert.throws(() => validateReady(value));
});

function completed() {
  return { nonce: 'nonce', pid: 10, startedUtcTicks: '123', realDesktopService: false, realObserver: false, realDriver: false,
    hooksInstalled: false, inputInjected: false, ok: true, readyCount: 2, windowsDestroyed: true, controls: [],
    messages: ['first', 'second'].map(generation => ({ case: 'normal', type: 'notice-ready', generation, documentNonce: '1cec77a4-1582-4ab7-a1d8-c972c6cda96b' })),
    cases: [{ case: 'normal-first', expectedReady: true, ready: true },
      { case: 'normal-reuse', expectedReady: true, ready: true, sameWindow: true, sameDocumentNonce: true, hiddenBetween: true },
      ...faultCases.map(name => ({ case: name, expectedReady: false, ready: false, code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE', windowDestroyed: true, elapsedMs: 5001 }))] };
}
test('acceptance requires each expected outcome, same-document re-ACK and all windows destroyed', async () => {
  const { assertRuntimeResult } = await harness, identity = { pid: 10, startedUtcTicks: '123' };
  assert.doesNotThrow(() => assertRuntimeResult(completed(), 'nonce', identity));
  for (const change of [value => { value.readyCount = 3; }, value => { value.cases[2].ready = true; },
    value => { value.cases[1].sameDocumentNonce = false; }, value => { value.cases[1].sameWindow = false; },
    value => { value.windowsDestroyed = false; }, value => { value.cases[2].windowDestroyed = false; },
    value => { value.cases.find(item => item.case === 'no-ack').elapsedMs = 10; }, value => { value.controls.push('takeover'); },
    value => { value.realDesktopService = true; }, value => { value.startedUtcTicks = '456'; },
    value => { value.messages.pop(); }, value => { value.messages.push({ case: 'no-ack', type: 'notice-ready' }); }]) {
    const value = completed(); change(value); assert.throws(() => assertRuntimeResult(value, 'nonce', identity));
  }
});

test('post-ready faults are deferred main-world failures and never a rejected executeJavaScript return', () => {
  const vm = require('node:vm');
  for (const name of postReadyCases) {
    let callback, rejected; const context = { window: {}, setTimeout(fn) { callback = fn; }, console: { log() {} },
      Promise: { reject(error) { rejected = error; } } };
    assert.equal(vm.runInNewContext(postReadyFaultSource(name), context), true);
    assert.equal(context.window.__noticeFixtureFaultFired, undefined);
    if (name.endsWith('throw')) assert.throws(callback, /Owned post-ready script failure/);
    else { callback(); assert.match(rejected.message, /Owned post-ready rejection/); }
    assert.equal(context.window.__noticeFixtureFaultFired, true);
  }
  assert.throws(() => postReadyFaultSource('other'));
});

test('post-ready acceptance distinguishes automatic revocation from harness cleanup', async () => {
  const { assertPostReadyResult } = await harness, identity = { pid: 10, startedUtcTicks: '123' };
  const value = { ...completed(), suite: 'post-ready', cases: postReadyCases.map(name => ({ case: name, expectedReady: true, ready: true,
    faultScheduled: true, windowDestroyed: true, postFault: { faultFired: true, automaticallyDestroyed: true, authorityRevoked: true,
      phase: 'paused', unavailableCallback: true, unavailableMessage: true } })) };
  assert.doesNotThrow(() => assertPostReadyResult(value, 'nonce', identity));
  for (const field of ['faultFired', 'automaticallyDestroyed', 'authorityRevoked', 'unavailableCallback', 'unavailableMessage']) {
    const failed = structuredClone(value); failed.cases[0].postFault[field] = false;
    assert.throws(() => assertPostReadyResult(failed, 'nonce', identity));
  }
  const stillReady = structuredClone(value); stillReady.cases[1].postFault.phase = 'ready'; assert.throws(() => assertPostReadyResult(stillReady, 'nonce', identity));
});
