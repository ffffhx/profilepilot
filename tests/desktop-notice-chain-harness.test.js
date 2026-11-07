const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const policies = loadCli('scripts/e2e/desktop-notice-chain-main.ts');
const nonce = 'a'.repeat(32), generation = 'g1', epoch = 'e1';
const envelope = (action, extra = {}) => ({ action, nonce, id: 'a1234567-1234-4123-8123-123456789012', expiresAt: 2000, ...extra });
const fault = () => envelope('fault', { epoch, generation, version: 'v1', webContentsId: 13, documentNonce: 'doc1' });
function facts() {
  return { attempted: false, browserFactoryCalls: 0, session: 'owned', target: { pid: 20, hwnd: '30' },
    status: { session: { name: 'owned', state: 'active', window: { id: 'window1', pid: 20, nativeHandle: '30' } }, inputObservation: { phase: 'ready', epoch, generation } },
    runtime: { browserPids: [], desktop: { phase: 'ready', epoch, generation } },
    lastObservation: { version: 'v1', windowId: 'window1' }, toolbar: { webContentsId: 13, documentNonce: 'doc1', exactOwnedFile: true, visible: true, destroyed: false },
    ownerDriverStopConfirmed: false, observerExited: false };
}
function after() {
  const f = facts(); return { nonce, status: { ...f.status, session: { ...f.status.session, state: 'paused' }, inputObservation: { phase: 'paused', epoch, generation, reason: 'notice_unavailable', certainty: 'unknown' } },
    faultAttempted: true, faultScheduled: true, browserFactoryCalls: 0, spawnCount: 1, runtime: { browserPids: [], stopConfirmed: true, desktop: null },
    observer: { exited: true, closed: true }, drivers: [{ roles: ['catalog'], stopConfirmed: false, exited: false, closed: false }, { roles: ['owner'], stopConfirmed: true, exited: true, closed: true }],
    toolbar: { destroyed: true }, events: [{ kind: 'fault-fired', case: 'throw', sequence: 1 }, { kind: 'service-state', reason: 'notice_unavailable', generation, sequence: 2 }] };
}
const expected = { nonce, session: 'owned', case: 'throw', generation, epoch };

test('notice chain import is a pure policy surface and does not launch Electron', () => {
  assert.equal(typeof policies.validateNoticeChainFault, 'function');
  assert.equal(typeof policies.validateNoticeChainEvidence, 'function');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-notice-chain-main.ts'), 'utf8');
  assert.match(source, /process\.versions\.electron && \(process as any\)\.type === 'browser'/);
  assert.match(source, /service = registerDesktop\(\{ inputObserver: runtime\.observeDesktop, admission:/);
  assert.doesNotMatch(source, /new DesktopService|new DesktopWorker|allowUnobservedTestDriver|startProfilePilotManagementServer|service\.control\(|service\.noticeUnavailable\(/);
});

test('notice chain options default to check and one explicit fault case', async () => {
  const { parseNoticeChainArgs } = await import('../scripts/verify-desktop-notice-chain.mjs');
  assert.deepEqual(parseNoticeChainArgs([]), { run: false, kind: 'throw' });
  assert.deepEqual(parseNoticeChainArgs(['--run', '--case', 'rejection']), { run: true, kind: 'rejection' });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--case'], ['--case', 'other'], ['--case', 'throw', '--case', 'rejection'], ['--assisted-foreground']]) assert.throws(() => parseNoticeChainArgs(args));
});

test('bundle location preserves production IPC public preload and native resolution', async () => {
  const { noticeChainLayout } = await import('../scripts/verify-desktop-notice-chain.mjs');
  const home = path.resolve('owned-home'), layout = noticeChainLayout(home);
  assert.equal(layout.entry, path.join(home, 'dist/main/desktop/main.cjs')); assert.equal(layout.public, path.join(home, 'public'));
  assert.equal(layout.preload, path.join(home, 'dist/desktop-preload.js')); assert.equal(layout.desktop, path.join(home, 'dist/native/ProfilePilot.Desktop.exe'));
  assert.equal(layout.observer, path.join(home, 'dist/native/ProfilePilot.InputObserver.exe'));
});

test('private envelope rejects stale foreign or additional commands before execution', () => {
  for (const value of [envelope('inspect'), envelope('close'), fault(), envelope('desktop', { command: { action: 'desktop', method: 'status' } })]) policies.validateNoticeChainRequest(value, nonce, 1000);
  for (const patch of [{ nonce: 'b'.repeat(32) }, { action: 'kill' }, { expiresAt: 1000 }, { expiresAt: 91001 }, { id: 'bad' }, { arbitrary: true }])
    assert.throws(() => policies.validateNoticeChainRequest({ ...envelope('inspect'), ...patch }, nonce, 1000));
  for (const method of ['resume', 'handoff', 'preview', 'screenshot']) assert.throws(() => policies.validateNoticeChainRequest(envelope('desktop', { command: { action: 'desktop', method } }), nonce, 1000));
  assert.throws(() => policies.validateNoticeChainRequest(envelope('desktop', { command: { action: 'desktop', method: 'action', params: { kind: 'click' } } }), nonce, 1000));
  assert.throws(() => policies.validateNoticeChainRequest(envelope('desktop', { command: { action: 'desktop', method: 'observe', screenshot: true } }), nonce, 1000));
});

test('fault admission requires the current active owner observer generation and exact document', () => {
  policies.validateNoticeChainFault(fault(), facts());
  const changes = [f => f.attempted = true, f => f.browserFactoryCalls++, f => f.runtime.browserPids.push(50), f => f.status.session.state = 'paused',
    f => f.status.session.name = 'other', f => f.status.session.window.pid++, f => f.status.inputObservation.phase = 'arming',
    f => f.status.inputObservation.generation = 'old', f => f.status.inputObservation.epoch = 'old', f => f.runtime.desktop.phase = 'paused',
    f => f.lastObservation.version = 'old', f => f.lastObservation.windowId = 'other', f => f.toolbar.exactOwnedFile = false,
    f => f.toolbar.documentNonce = 'old', f => f.toolbar.webContentsId++, f => f.toolbar.destroyed = true,
    f => f.toolbar.visible = false, f => f.ownerDriverStopConfirmed = true, f => f.observerExited = true];
  for (const mutate of changes) { const f = facts(); mutate(f); assert.throws(() => policies.validateNoticeChainFault(fault(), f)); }
});

test('main-world fault source schedules exactly one explicit owned throw or rejection', () => {
  for (const kind of ['throw', 'rejection']) {
    let callback, rejected = 0; const messages = [];
    const returned = vm.runInNewContext(policies.noticeChainFaultSource(kind, nonce), {
      setTimeout(fn, ms) { assert.equal(ms, 0); assert.equal(callback, undefined); callback = fn; },
      console: { log: value => messages.push(value) }, Promise: { reject: () => { rejected++; } }
    });
    assert.equal(returned, true); assert.deepEqual(messages, []);
    if (kind === 'throw') assert.throws(() => callback(), /Owned notice chain throw/); else callback();
    assert.equal(rejected, kind === 'rejection' ? 1 : 0); assert.deepEqual(messages, ['notice-chain-fault:' + nonce + ':' + kind]);
  }
  assert.throws(() => policies.noticeChainFaultSource('kill', nonce)); assert.throws(() => policies.noticeChainFaultSource('throw', "'invalid"));
});

test('evidence requires the real notice pause and confirmed native retirement, not arbitrary user pause', () => {
  policies.validateNoticeChainEvidence(after(), expected);
  const changes = [v => v.status.inputObservation.reason = 'user_takeover', v => v.status.inputObservation.reason = 'disconnected',
    v => v.status.inputObservation.generation = 'old', v => v.status.inputObservation.epoch = 'old', v => v.faultScheduled = false,
    v => v.spawnCount++, v => v.runtime.stopConfirmed = false, v => v.runtime.desktop = { phase: 'ready' },
    v => v.observer.exited = false, v => v.observer.closed = false, v => v.drivers[1].stopConfirmed = false,
    v => v.drivers[1].exited = false, v => v.toolbar.destroyed = false, v => v.events[1].sequence = 0,
    v => v.events[0].case = 'rejection', v => v.runtime.browserPids.push(50)];
  for (const mutate of changes) { const value = after(); mutate(value); assert.throws(() => policies.validateNoticeChainEvidence(value, expected)); }
});

const identity = { pid: 20, parentPid: 10, startedUtcTicks: '639280000000000000', executable: 'C:\\owned\\fixture.exe', sha256: 'a'.repeat(64), integrityRid: 8192, elevated: false, uiAccess: false };
test('normal original-process exit requires no fallback termination', async () => {
  const { retireNoticeChainOwned } = await import('../scripts/verify-desktop-notice-chain.mjs');
  const result = await retireNoticeChainOwned(identity, { wait: () => ({ originalExited: true }), force: () => assert.fail('No force needed') });
  assert.equal(result.ok, true); assert.deepEqual(result.forcedAttempts, []);
});
test('any forced fallback remains failed even after the exact original exits', async () => {
  const { retireNoticeChainOwned } = await import('../scripts/verify-desktop-notice-chain.mjs');
  let waits = 0, forces = 0;
  const result = await retireNoticeChainOwned(identity, { wait: () => ({ originalExited: ++waits > 1 }), force: actual => { assert.equal(actual, identity); forces++; return { originalExited: true, forced: true }; } });
  assert.equal(forces, 1); assert.equal(result.originalExited, true); assert.equal(result.ok, false); assert.equal(result.forcedAttempts[0].attempted, true);
});
test('wait error preserves cause but does not skip full-identity fallback cleanup', async () => {
  const { retireNoticeChainOwned } = await import('../scripts/verify-desktop-notice-chain.mjs');
  let waits = 0, forces = 0;
  const result = await retireNoticeChainOwned(identity, { wait: () => { if (!waits++) throw new Error('wait unavailable'); return { originalExited: true }; }, force: () => { forces++; throw new Error('force receipt lost'); } });
  assert.equal(forces, 1); assert.equal(result.ok, false); assert.equal(result.originalExited, true);
  assert.deepEqual(result.errors.map(value => value.message), ['wait unavailable', 'force receipt lost']);
});
test('partial identity does not authorize forced cleanup', async () => {
  const { retireNoticeChainOwned } = await import('../scripts/verify-desktop-notice-chain.mjs');
  const result = await retireNoticeChainOwned({ pid: 20 }, { wait: () => ({ originalExited: false }), force: () => assert.fail('Missing birth/hash/parent must refuse force') });
  assert.equal(result.ok, false); assert.equal(result.forcedAttempts[0].attempted, false);
});
