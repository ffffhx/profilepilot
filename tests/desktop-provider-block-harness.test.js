const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../scripts/verify-desktop-provider-block.mjs');

test('provider block defaults to compile-only and names CLI cancellation precisely', async () => {
  const { providerBlockOptions } = await load();
  assert.deepEqual(providerBlockOptions([]), { run: false, kind: 'deadline' });
  assert.deepEqual(providerBlockOptions(['--check', '--case', 'conditional_complete']), { run: false, kind: 'conditional_complete' });
  assert.deepEqual(providerBlockOptions(['--run']), { run: true, kind: 'deadline' });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--case'], ['--case', 'stop'], ['--case', 'explicit_release'], ['--case', 'deadline', '--case', 'deadline'], ['--resume']]) assert.throws(() => providerBlockOptions(args));
});
const expected = { nonce: 'a'.repeat(32), pid: 123, startedUtcTicks: '639289105934552999', hwnd: '456', runId: 'ceadf744-73a8-49ed-b747-2db082855055' };
function marker(mark) {
  return { ...expected, marker: mark, source: mark === 'released' ? 'explicit-release' : 'accessible-name-getter', entries: 1,
    counter: { entered: '100', released: '200', returned: '300' }[mark], frequency: 10000000, getterThreadId: 123, utc: '2026-10-30T00:00:00.000Z',
    getterActive: mark !== 'returned', returned: mark === 'returned' ? 1 : 0 };
}
function pending() { return { ...expected, phase: 'entered', getterActive: true, entries: 1, returned: 0 }; }
function fake(kind = 'deadline') {
  const events = [], before = { session: { name: 'owned', state: 'active', revision: 2 }, inputObservation: { epoch: 'e1', generation: 'g1', phase: 'ready' } };
  const response = kind === 'deadline' ? { exitCode: 75, response: { ok: true, result: { timedOut: true, matched: false, attempts: 1, requiresObservation: true, matchedReferences: [] } } }
    : { exitCode: 75, response: { ok: false, code: 'DESKTOP_USER_IN_CONTROL' } };
  let sessionReleased = false, clock = 1;
  const waiting = { settled: false, enteredObservedMs: 20, dispatchedUtc: Date.parse('2026-10-30T00:00:00.000Z'), get result() { events.push('wait-result'); this.settled = true; this.settledAt = ++clock; return Promise.resolve(response); } };
  const io = {
    now: () => ++clock,
    arm: async () => { events.push('arm'); return { ...expected, phase: 'armed', entries: 0, getterActive: false }; },
    startWait: timeout => { events.push('wait:' + timeout); return waiting; },
    entered: async () => { events.push('entered'); return marker('entered'); },
    pending: async () => { events.push('pending'); return pending(); },
    status: async () => { events.push('status'); return { response: { ok: true, result: sessionReleased ? { session: null } : { ...before, session: { ...before.session, revision: 3 }, inputObservation: { ...before.inputObservation, phase: 'pending' } } } }; },
    releaseSession: async () => { events.push('release-session'); sessionReleased = true; return { response: { ok: true, result: { session: null } } }; },
    completeSession: async () => { events.push('complete-active'); sessionReleased = true; return { response: { ok: true, result: { session: null } } }; },
    waitOwnerExit: async () => { events.push('owner-exit'); return { ok: true, originalExited: true }; },
    waitObserverExit: async () => { events.push('observer-exit'); return { ok: true, originalExited: true }; },
    releaseProvider: async () => { events.push('release-provider'); },
    released: async () => { events.push('released'); return marker('released'); },
    returned: async () => { events.push('returned'); return marker('returned'); }
  };
  return { options: { kind, before, expected, session: 'owned' }, io, events, waiting, response, record: {} };
}

test('baseline must prove a unique untruncated root match and actual getter element', async () => {
  const { verifyProviderBaseline } = await load();
  const opts = { nonce: expected.nonce, windowId: 'w1', rootName: 'unique root' };
  const snapshot = { windowId: 'w1', version: 'v1', truncated: false, gaps: [], elements: [
    { reference: 'r1', parent: -1, role: 'Window', name: 'unique root', truncatedFields: [], password: false },
    { reference: 'r2', parent: 0, name: 'Provider getter ' + expected.nonce, truncatedFields: [], password: false }
  ] };
  assert.equal(verifyProviderBaseline(snapshot, opts), 'r1');
  const withTitleBar = structuredClone(snapshot);
  withTitleBar.elements.push({ reference: 'r3', parent: 0, role: 'TitleBar', name: 'unique root', truncatedFields: [], password: false });
  assert.equal(verifyProviderBaseline(withTitleBar, opts), 'r1', 'Native title bars legitimately repeat their root caption');
  for (const mutate of [value => value.elements.pop(), value => { value.elements[0].truncatedFields = ['name']; },
    value => { delete value.elements[0].truncatedFields; }, value => { value.truncated = true; }, value => { value.gaps = ['time_limit']; },
    value => { value.windowId = 'other'; }, value => { value.elements[0].password = true; },
    value => { value.elements[0].role = 'TitleBar'; },
    value => { value.elements.push({ ...value.elements[0], reference: 'r3', parent: 0 }); }]) {
    const value = structuredClone(snapshot); mutate(value); assert.throws(() => verifyProviderBaseline(value, opts));
  }
});
test('deadline confirms the old worker and observer exit while the provider is still blocked', async () => {
  const { runProviderBlockCase } = await load(); const f = fake();
  const result = await runProviderBlockCase(f.options, f.io, f.record); assert.equal(result.ok, true);
  assert.deepEqual(f.events, ['arm', 'wait:4000', 'entered', 'pending', 'wait-result', 'pending', 'status', 'owner-exit', 'pending', 'status', 'release-session', 'observer-exit', 'pending', 'release-provider', 'released', 'returned']);
});
test('conditional_complete requires active ownership before interpreting the wait result', async () => {
  const { runProviderBlockCase } = await load(); const f = fake('conditional_complete');
  assert.equal((await runProviderBlockCase(f.options, f.io, f.record)).ok, true);
  assert.deepEqual(f.events, ['arm', 'wait:20000', 'entered', 'pending', 'complete-active', 'wait-result', 'pending', 'status', 'owner-exit', 'pending', 'status', 'observer-exit', 'pending', 'release-provider', 'released', 'returned']);
});
test('UIA returning before entry or the trigger cannot count as a blocked provider test', async () => {
  const { runProviderBlockCase } = await load();
  for (const where of ['entry', 'trigger']) {
    const f = fake();
    if (where === 'entry') f.io.entered = async () => { f.waiting.settled = true; return marker('entered'); };
    else f.io.pending = async () => { f.waiting.settled = true; return pending(); };
    await assert.rejects(runProviderBlockCase(f.options, f.io, f.record));
    assert.equal(f.record.ok, undefined); assert.ok(!f.events.includes('release-provider')); assert.ok(!f.events.includes('release-session'));
  }
});
test('pre-dispatch, late or unacknowledged provider entry cannot make the scenario pass', async () => {
  const { runProviderBlockCase } = await load();
  for (const mutate of [f => { f.waiting.enteredObservedMs = 4000; }, f => { f.waiting.enteredObservedMs = NaN; },
    f => { f.waiting.dispatchedUtc += 1; }, f => { f.io.arm = async () => ({ ...expected, phase: 'entered', entries: 1, getterActive: true }); },
    f => { f.io.arm = async () => ({ ...expected, runId: 'different', phase: 'armed', entries: 0, getterActive: false }); }]) {
    const f = fake(); mutate(f); await assert.rejects(runProviderBlockCase(f.options, f.io, f.record));
    assert.equal(f.record.ok, undefined); assert.ok(!f.events.includes('release-provider')); assert.ok(!f.events.includes('release-session'));
  }
});
test('a timeout alone, completed observation or later retry never establishes blocking coverage', async () => {
  const { runProviderBlockCase } = await load();
  for (const mutate of [value => { value.exitCode = 0; }, value => { value.response.ok = false; value.response.code = 'DESKTOP_HELPER_TIMEOUT'; },
    value => { value.response.result.observation = { elements: [] }; }, value => { value.response.result.attempts = 2; },
    value => { value.response.result.matched = true; }, value => { value.response.result.matchedReferences = ['root']; },
    value => { value.response.result.requiresObservation = false; }]) {
    const f = fake(); mutate(f.response); await assert.rejects(runProviderBlockCase(f.options, f.io, f.record)); assert.equal(f.record.ok, undefined);
    assert.ok(!f.events.includes('release-provider')); assert.ok(!f.events.includes('owner-exit'));
  }
});
test('provider return or deadman release before worker exit fails rather than masking cancellation', async () => {
  const { runProviderBlockCase } = await load();
  for (const after of [2, 3, 4]) {
    const f = fake(); let calls = 0; f.io.pending = async () => ++calls === after ? { ...pending(), phase: 'returned', getterActive: false, returned: 1 } : pending();
    await assert.rejects(runProviderBlockCase(f.options, f.io, f.record)); assert.equal(f.record.ok, undefined); assert.ok(!f.events.includes('release-provider'));
  }
});
test('no original exit evidence prevents provider release and a PASS', async () => {
  const { runProviderBlockCase } = await load();
  for (const name of ['waitOwnerExit', 'waitObserverExit']) for (const response of [{ ok: true, originalExited: false, timedOut: true }, { ok: false, originalExited: true }]) {
    const f = fake(); f.io[name] = async () => response;
    await assert.rejects(runProviderBlockCase(f.options, f.io, f.record)); assert.ok(!f.events.includes('release-provider')); assert.equal(f.record.ok, undefined);
  }
});
test('unexpected paused successor, rearm or missing revision is not accepted after deadline', async () => {
  const { runProviderBlockCase } = await load();
  for (const change of [{ state: 'paused' }, { name: 'successor' }, { revision: 2 }]) {
    const f = fake(), original = f.io.status; f.io.status = async () => { const status = await original(); Object.assign(status.response.result.session, change); return status; };
    await assert.rejects(runProviderBlockCase(f.options, f.io)); assert.ok(!f.events.includes('release-provider'));
  }
  for (const change of [{ phase: 'ready' }, { epoch: 'new' }, { generation: 'new' }]) {
    const f = fake(), original = f.io.status; f.io.status = async () => { const status = await original(); Object.assign(status.response.result.inputObservation, change); return status; };
    await assert.rejects(runProviderBlockCase(f.options, f.io)); assert.ok(!f.events.includes('release-provider'));
  }
});
test('a takeover observed after original worker exit remains a failed scenario', async () => {
  const { runProviderBlockCase } = await load(); const f = fake(), original = f.io.status; let reads = 0;
  f.io.status = async () => { const status = await original(); if (++reads === 2) status.response.result.session.state = 'paused'; return status; };
  await assert.rejects(runProviderBlockCase(f.options, f.io, f.record)); assert.equal(f.record.ok, undefined);
  assert.ok(f.events.includes('owner-exit')); assert.ok(!f.events.includes('release-session')); assert.ok(!f.events.includes('release-provider'));
});
test('explicit cancellation distinguishes control abort from unrelated errors or early completion', async () => {
  const { runProviderBlockCase } = await load();
  for (const code of ['DESKTOP_CONTROL_STATE_UNKNOWN', 'DESKTOP_HELPER_TIMEOUT', 'DESKTOP_CLI_TIMEOUT', 'DESKTOP_SESSION_ENDED']) {
    const f = fake('conditional_complete'); f.response.response.code = code;
    await assert.rejects(runProviderBlockCase(f.options, f.io)); assert.ok(!f.events.includes('release-provider'));
  }
  const f = fake('conditional_complete'); Object.defineProperty(f.waiting, 'result', { get() { f.waiting.settledAt = 0; return Promise.resolve(f.response); } });
  await assert.rejects(runProviderBlockCase(f.options, f.io)); assert.ok(!f.events.includes('release-provider'));
});
test('real Service delayed cancellation counterexample distinguishes unsafe plain release from conditional completion', async () => {
  const { runProviderBlockCase } = await load();
  const { DesktopService } = require('./cli-test-build.cjs').loadCli('src/main/desktop/service.ts');
  for (const interrupt of ['unsafe-legacy-release', 'takeover', 'observer-loss', 'none']) {
    const f = fake('conditional_complete'), trace = [];
    const target = { id: 'a'.repeat(32), title: 'Owned pure provider', process: 'fixture', pid: 12, className: 'Form' };
    let backend, backendValue, reading = false, onPause, observed;
    const service = new DesktopService({ platform: 'win32', available: () => true,
      driver: () => ({ inputMarker: '0000000000000001', close() { trace.push('driver-closed'); },
        async request(operation) {
          if (operation === 'windows') return { windows: [target] };
          assert.equal(operation, 'window.observe'); reading = true; trace.push('real-service-observe-pending'); return new Promise(() => {});
        } }),
      inputObserver: callback => { onPause = callback; return {
        arm: async generation => (observed = { generation, epoch: 'epoch', phase: 'ready', sequence: '0' }),
        disarm(generation) { if (observed?.generation === generation) observed = null; },
        snapshot: () => ({ connected: true, epoch: 'epoch', desktop: observed && { ...observed } }), detach() {}
      }; }
    });
    const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'owned', ...extra });
    const envelope = async promise => { try { return { exitCode: 0, response: { ok: true, result: await promise } }; }
      catch (error) { return { exitCode: 75, response: { ok: false, code: error.code } }; } };
    try {
      f.options.before = await service.execute(command('claim', { windowId: target.id }));
      f.io.startWait = timeoutMs => {
        trace.push('wait-dispatched'); backend = envelope(service.execute(command('wait', { condition: { name: 'root' }, timeoutMs, intervalMs: 250 })))
          .then(value => { backendValue = value; trace.push('backend-wait-settled'); return value; });
        // The real backend is allowed to settle, while transport intentionally
        // withholds its result until the harness later reads waiting.result.
        Object.defineProperty(f.waiting, 'result', { get() { return backend.then(value => { f.waiting.settled = true; f.waiting.settledAt = Number.MAX_SAFE_INTEGER; trace.push('cli-result-delivered'); return value; }); } });
        return f.waiting;
      };
      f.io.entered = async () => { await new Promise(resolve => setImmediate(resolve)); assert.equal(reading, true); return marker('entered'); };
      let pendingReads = 0;
      f.io.pending = async () => {
        if (++pendingReads === 1 && interrupt !== 'none') {
          if (interrupt === 'takeover' || interrupt === 'unsafe-legacy-release') service.control('takeover');
          else { const event = { epoch: 'epoch', generation: observed.generation, reason: 'disconnected', certainty: 'unknown' }; observed = { ...observed, phase: 'paused' }; onPause(event); }
          await backend; assert.equal(backendValue.response.code, 'DESKTOP_USER_IN_CONTROL');
          assert.equal(f.waiting.settled, false); assert.equal(service.status().session.state, 'paused'); trace.push('backend-paused-before-complete');
        }
        return pending();
      };
      f.io.completeSession = () => {
        trace.push('conditional-complete');
        // Keep the original false-PASS counterexample reproducible. Only this
        // test adapter deliberately substitutes the old unsafe plain release.
        return envelope(service.execute(interrupt === 'unsafe-legacy-release' ? command('release') : command('complete', { requireActive: true })));
      };
      f.io.status = async () => ({ response: { ok: true, result: service.status() } });
      if (interrupt === 'none' || interrupt === 'unsafe-legacy-release') {
        assert.equal((await runProviderBlockCase(f.options, f.io, f.record)).ok, true);
        assert.equal(service.status().session, null);
        if (interrupt === 'none') assert.ok(trace.indexOf('conditional-complete') < trace.indexOf('backend-wait-settled'));
        else assert.ok(trace.indexOf('backend-paused-before-complete') < trace.indexOf('conditional-complete'), 'Legacy release erases an already-paused owner and falsely passes');
      } else {
        await assert.rejects(runProviderBlockCase(f.options, f.io, f.record));
        assert.equal(f.record.complete.response.code, 'DESKTOP_USER_IN_CONTROL'); assert.equal(f.record.ok, undefined);
        assert.equal(service.status().session.state, 'paused'); assert.ok(!f.events.includes('release-provider'));
        assert.ok(trace.indexOf('backend-wait-settled') < trace.indexOf('conditional-complete')); assert.ok(!trace.includes('cli-result-delivered'));
      }
    } finally { await service.close(); if (backend) await backend; }
  }
});
test('markers must match nonce, birth, handle, run and monotonic release ordering', async () => {
  const { runProviderBlockCase, verifyProviderMarker } = await load();
  for (const key of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'runId', 'source']) {
    const value = marker('entered'); value[key] = 'different'; assert.throws(() => verifyProviderMarker(value, expected, 'entered', 'accessible-name-getter'));
  }
  const f = fake(); f.io.returned = async () => ({ ...marker('returned'), counter: '150' });
  await assert.rejects(runProviderBlockCase(f.options, f.io, f.record)); assert.equal(f.record.ok, undefined);
  const g = fake(); g.io.released = async () => ({ ...marker('released'), source: 'getter_deadman' });
  await assert.rejects(runProviderBlockCase(g.options, g.io, g.record)); assert.equal(g.record.ok, undefined);
});
test('failed startup keeps nonce cleanup even when launch created the fixture before throwing', async () => {
  // This exact lifecycle is imported by the new runner; exercise its state,
  // rather than relying only on a source regexp for the attempted flag.
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const calls = [], expectedFixture = { nonce: expected.nonce, executable: 'C:\\owned\\ProviderBlock.exe', sha256: 'b'.repeat(64) };
  const value = { ok: true, pid: expected.pid, startedUtcTicks: expected.startedUtcTicks, parentPid: 222, executable: expectedFixture.executable, sha256: expectedFixture.sha256, integrityRid: 8192, elevated: false, uiAccess: false };
  let alive = false;
  const life = windowStateFixtureLifecycle(expectedFixture, {
    launch: async () => { alive = true; throw new Error('launcher handshake failed'); },
    ready: async () => ({ ...expected, currentHwnd: expected.hwnd }), inspect: async () => value,
    requestClose: async () => { calls.push('nonce-close'); alive = false; },
    closed: async () => ({ ...expected, originalHwndGone: true, reason: 'requested', getterPending: false }),
    wait: async identity => { assert.deepEqual(identity, value); calls.push('wait-exact-original'); return { ok: true, originalExited: !alive }; },
    force: async () => { calls.push('force'); assert.fail('Normal close must suffice'); }
  });
  await assert.rejects(life.launch()); const result = await life.cleanup(); assert.equal(result.ok, true); assert.equal(result.identityRecovered, true);
  assert.deepEqual(calls, ['nonce-close', 'wait-exact-original']); assert.equal(alive, false);
});
test('compile-only entry precedes all real I/O and has no activation or input alternative', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-desktop-provider-block.mjs'), 'utf8');
  assert.ok(source.indexOf('if (!options.run)') < source.indexOf('await assertDesktopAcceptanceWindow()'));
  assert.ok(source.indexOf('await assertDesktopAcceptanceWindow()') < source.indexOf('const id = args'));
  assert.match(source, /if \(fixtureLifecycle.attempted\)/);
  assert.match(source, /completeSession: \(\) => desktop\(\['complete', '--session', session, '--require-active'\], null\)/);
  assert.doesNotMatch(source, /desktop\(\[['"](?:resume|action|screenshot|preview)/);
  const fixture = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-provider-block-fixture.cs'), 'utf8');
  assert.doesNotMatch(fixture, /SendInput|AttachThreadInput|SetForegroundWindow|SetWindowsHookEx|ShowWindow\(/);
  assert.match(fixture, /public override string Name/); assert.match(fixture, /gate\.WaitOne\(\)/);
  assert.ok(fixture.indexOf('Release(source);getterReturned.WaitOne(2000)') < fixture.indexOf('form.BeginInvoke'));
});
test('file polling cannot publish a ready marker returned after its original deadline', async () => {
  const { pollProviderFile } = await load(); let time = 0, accepted = 0;
  await assert.rejects(pollProviderFile(async () => { time = 11; return { ready: true }; }, () => { accepted++; return true; }, 'late file', 10,
    { now: () => time, delay: async ms => { time += ms; } }), error => { assert.equal(error.last.ready, true); assert.match(error.message, /timed out/); return true; });
  assert.equal(accepted, 0);
  let reads = 0; time = 0;
  const result = await pollProviderFile(async () => {
    if (++reads === 1) throw Object.assign(new Error('not yet'), { code: 'ENOENT' });
    if (reads === 2) throw new SyntaxError('partial JSON'); return { ready: true };
  }, value => value.ready, 'retry private file', 100, { now: () => time, delay: async ms => { time += ms; } });
  assert.equal(result.ready, true); assert.equal(reads, 3);
  await assert.rejects(pollProviderFile(async () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }, () => true, 'denied', 100), { code: 'EPERM' });
});
