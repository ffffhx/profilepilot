const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('window state harness defaults to compilation and requires an explicit bounded case', async () => {
  const { windowStateOptions } = await import('../scripts/verify-desktop-window-state.mjs');
  assert.deepEqual(windowStateOptions([]), { run: false, kind: 'basic' });
  assert.deepEqual(windowStateOptions(['--check']), { run: false, kind: 'basic' });
  assert.deepEqual(windowStateOptions(['--run', '--case', 'reject-restore']), { run: true, kind: 'reject-restore' });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--case', 'unknown'], ['--case'], ['--resume'], ['--case', 'basic', '--case', 'basic']])
    assert.throws(() => windowStateOptions(args));
});
test('a normal API response alone cannot make the real window-state harness pass', async () => {
  const { verifyWindowStateResult } = await import('../scripts/verify-desktop-window-state.mjs');
  const result = { executed: true, requiresObservation: true, windowState: { requested: 'normal', confirmed: true,
    after: { uia: { visualState: 'normal', nativeHandle: '123' }, placementAvailable: true, showCommand: 1 }, foregroundBefore: '9', foregroundAfter: '9' } };
  const fixture = { state: 'normal', minimized: false, maximized: false, hwnd: '123', currentHwnd: '123' };
  assert.doesNotThrow(() => verifyWindowStateResult('restore', result, fixture));
  for (const change of [value => { value.windowState.confirmed = false; }, value => { value.windowState.after.uia.visualState = 'minimized'; },
    value => { value.windowState.after.placementAvailable = false; }, value => { value.windowState.after.showCommand = 3; },
    value => { value.windowState.after.uia.nativeHandle = '999'; }, value => { delete value.windowState; }]) {
    const altered = structuredClone(result); change(altered); assert.throws(() => verifyWindowStateResult('restore', altered, fixture));
  }
  for (const change of [{ state: 'minimized', minimized: true }, { currentHwnd: '999' }, { maximized: true }])
    assert.throws(() => verifyWindowStateResult('restore', result, { ...fixture, ...change }));
});
test('window-state real entry gates before OS queries, never resumes, and requires normal owned cleanup', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/verify-desktop-window-state.mjs'), 'utf8');
  assert.ok(source.indexOf('if (!options.run)') < source.indexOf('await assertDesktopAcceptanceWindow()'));
  assert.ok(source.indexOf('await assertDesktopAcceptanceWindow()') < source.indexOf("const id = args"));
  assert.doesNotMatch(source, /desktop\(\[['"]resume/);
  assert.match(source, /retireNoticeChainOwned\(pinned, io\)/);
  assert.match(source, /\['--wait-owned-exit', String\(value.pid\), value.startedUtcTicks, String\(ms\)\]/);
  assert.match(source, /if \(!result.ok\) report.ok = false/);
  assert.match(source, /fixture = await fixtureLifecycle.launch\(\)/);
  assert.match(source, /if \(fixtureLifecycle.attempted\)/);
  assert.match(source, /sameIdentity\(appBefore.identity, current.identity\)/);
  assert.match(source, /runtime|input-observer/);
  const fixture = fs.readFileSync(path.resolve(__dirname, '../scripts/e2e/desktop-window-state-fixture.cs'), 'utf8');
  assert.doesNotMatch(fixture, /SendInput|AttachThreadInput|SetForegroundWindow|ShowWindow\(/);
  assert.match(fixture, /originalHwndGone=!IsWindow\(initial\)/);
});
function ownedLifecycleIo(change = {}) {
  const nonce = 'a'.repeat(32), expected = { nonce, executable: 'C:\\owned\\WindowStateFixture.exe', sha256: 'b'.repeat(64) };
  const identity = { ok: true, pid: 1234, parentPid: 4567, startedUtcTicks: '639289105934552999', executable: expected.executable, sha256: expected.sha256, integrityRid: 8192, elevated: false, uiAccess: false };
  const ready = { nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks, hwnd: '123', currentHwnd: '123' };
  const calls = [], state = { alive: false };
  const io = {
    launch: async () => { calls.push('launch'); state.alive = true; throw new Error('launcher finally failed after starting owned process'); },
    ready: async () => { calls.push('ready'); return ready; },
    inspect: async pid => { calls.push('inspect:' + pid); assert.equal(state.alive, true); return identity; },
    requestClose: async () => { calls.push('nonce-close:' + nonce); state.alive = false; },
    closed: async () => { calls.push('receipt'); return { ...ready, originalHwndGone: !state.alive, reason: 'requested' }; },
    wait: async value => { calls.push('wait:' + value.pid); assert.deepEqual(value, identity); return { ok: true, originalExited: !state.alive }; },
    force: async value => { calls.push('force:' + value.pid); assert.deepEqual(value, identity); state.alive = false; return { ok: true, originalExited: true, forced: true }; },
    ...change
  };
  return { expected, identity, ready, calls, state, io };
}
test('launcher side effect followed by throw still closes nonce fixture and confirms exact original exit', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const f = ownedLifecycleIo(), lifecycle = windowStateFixtureLifecycle(f.expected, f.io);
  let fixture, failure, cleanup;
  try { fixture = await lifecycle.launch(); } catch (error) { failure = error; }
  finally { cleanup = await lifecycle.cleanup(); }
  assert.equal(fixture, undefined, 'Counterexample must throw before the return PID is assigned');
  assert.match(failure.message, /launcher finally failed/); assert.equal(lifecycle.attempted, true);
  assert.equal(cleanup.identityRecovered, true); assert.deepEqual(cleanup.identity, f.identity);
  assert.equal(cleanup.ok, true); assert.equal(cleanup.exit.originalExited, true); assert.deepEqual(cleanup.exit.forcedAttempts, []); assert.equal(f.state.alive, false);
  assert.deepEqual(f.calls, ['launch', 'ready', 'inspect:1234', 'nonce-close:' + f.expected.nonce, 'receipt', 'wait:1234']);
});
test('failed identity recovery still sends the private nonce close but never performs a bare-PID cleanup', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  for (const defect of ['ready-missing', 'nonce', 'birth', 'hash', 'parent', 'elevation']) {
    const f = ownedLifecycleIo();
    if (defect === 'ready-missing') f.io.ready = async () => { throw new Error('owned ready receipt absent'); };
    if (defect === 'nonce') f.ready.nonce = 'c'.repeat(32);
    if (defect === 'birth') f.io.inspect = async () => ({ ...f.identity, startedUtcTicks: '639289105934553000' });
    if (defect === 'hash') f.io.inspect = async () => ({ ...f.identity, sha256: 'c'.repeat(64) });
    if (defect === 'parent') f.io.inspect = async () => ({ ...f.identity, parentPid: 0 });
    if (defect === 'elevation') f.io.inspect = async () => ({ ...f.identity, elevated: true });
    const lifecycle = windowStateFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
    const result = await lifecycle.cleanup(); assert.equal(result.ok, false, defect); assert.equal(result.closeRequested, true, defect);
    assert.equal(f.state.alive, false, defect); assert.ok(result.errors.some(error => error.stage === 'identity'), defect);
    assert.equal(f.calls.some(value => value.startsWith('wait:') || value.startsWith('force:')), false, defect);
  }
});
test('a fully verified force fallback remains failed acceptance after launcher error', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const f = ownedLifecycleIo(); f.io.requestClose = async () => { f.calls.push('nonce-close'); };
  f.io.closed = async () => { throw new Error('no close receipt'); };
  const lifecycle = windowStateFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch(), /launcher finally failed/);
  const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.exit.ok, false); assert.equal(result.exit.originalExited, true);
  assert.equal(result.exit.forcedAttempts.length, 1); assert.equal(result.exit.forcedAttempts[0].attempted, true); assert.equal(f.state.alive, false);
  assert.ok(f.calls.includes('force:1234')); assert.ok(result.errors.some(value => value.stage === 'close-receipt'));
});
test('readiness and close-write failures remain visible without skipping verified exit cleanup', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const f = ownedLifecycleIo(); f.io.requestClose = async () => { f.calls.push('nonce-close-failed'); throw new Error('close file denied'); };
  f.io.closed = async () => { throw new Error('receipt absent'); };
  const lifecycle = windowStateFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
  const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.closeRequested, false);
  assert.ok(result.errors.some(value => value.stage === 'request-close')); assert.ok(result.exit.forcedAttempts.length === 1); assert.equal(f.state.alive, false);
});
test('a fixture that was never attempted performs no cleanup I/O', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const f = ownedLifecycleIo(); const result = await windowStateFixtureLifecycle(f.expected, f.io).cleanup();
  assert.equal(result.ok, true); assert.equal(result.attempted, false); assert.deepEqual(f.calls, []);
});
test('normal launch retains its pinned identity and does not need recovery readiness', async () => {
  const { windowStateFixtureLifecycle } = await import('../scripts/verify-desktop-window-state.mjs');
  const f = ownedLifecycleIo(); f.io.launch = async () => { f.state.alive = true; return { pid: f.identity.pid }; };
  const lifecycle = windowStateFixtureLifecycle(f.expected, f.io); await lifecycle.launch(); lifecycle.pin(f.identity);
  const result = await lifecycle.cleanup(); assert.equal(result.ok, true); assert.equal(result.identityRecovered, false);
  assert.equal(f.calls.includes('ready'), false); assert.equal(f.calls.includes('inspect:1234'), false); assert.equal(f.state.alive, false);
});
