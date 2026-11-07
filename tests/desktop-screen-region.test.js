const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Script } = require('node:vm');

test('screen-region runner requires explicit run and bounded foreground wait', async () => {
  const { parseScreenRegionArgs } = await import('../scripts/verify-desktop-screen-region.mjs');
  assert.deepEqual(parseScreenRegionArgs([]), { run: false, diagnoseOnly: false, cover: false, ppilotFocus: false, waitMs: 0 });
  assert.equal(parseScreenRegionArgs(['--run', '--diagnose-only']).diagnoseOnly, true);
  assert.equal(parseScreenRegionArgs(['--run', '--wait-for-foreground-ms', '30000']).waitMs, 30000);
  assert.equal(parseScreenRegionArgs(['--run', '--ppilot-focus']).ppilotFocus, true);
  for (const args of [['--diagnose-only'], ['--cover'], ['--ppilot-focus'], ['--run', '--check'], ['--run', '--run'], ['--run', '--wait-for-foreground-ms', '30001'], ['--run', '--diagnose-only', '--cover'], ['--run', '--diagnose-only', '--ppilot-focus'], ['--run', '--ppilot-focus', '--wait-for-foreground-ms', '1000']]) assert.throws(() => parseScreenRegionArgs(args));
});

test('standalone region policy fails closed without sampling any desktop', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screen-region-pure-'));
  const executable = path.join(directory, 'RegionTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/main:DesktopScreenRegionTests', `/out:${executable}`,
    '/r:System.Drawing.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-screen-region-probe.cs'),
    path.join(__dirname, 'helpers/desktop-screen-region-tests.cs')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(result.ok, true); assert.equal(result.noOSCalls, true); assert.equal(result.checks.length, 28); t.diagnostic(result.checks.join('; '));
});

test('owned fixture and probe contain no activation, protection repair or alternate capture path', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-screen-region-fixture.cjs'), 'utf8');
  new Script(fixture);
  assert.match(fixture, /aria-label="ProfilePilot focus ' \+ config\.nonce/);
  assert.doesNotMatch(fixture, /on(?:click|focus)=/);
  assert.doesNotMatch(fixture, /\.(?:focus|setOpacity|setContentProtection|setAlwaysOnTop)\s*\(/);
  const probe = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-screen-region-probe.cs'), 'utf8');
  assert.doesNotMatch(probe, /extern\s+\w+\s+(?:SetForegroundWindow|SetWindowDisplayAffinity|SetWindowLongPtr|SendInput|PrintWindow|SetWindowsHookEx)\b/);
  assert.match(probe, /BitBlt\(dest,0,0,before\.client\.width,before\.client\.height,screen,before\.client\.x,before\.client\.y,RasterOperation\)/);
});

test('owned fixture records readiness and forces accessibility only for explicit ppilot focus', async t => {
  const { EventEmitter } = require('node:events');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-screen-region-fixture.cjs'), 'utf8');
  for (const explicit of [undefined, false, true]) await t.test(String(explicit), async () => {
    const home = path.resolve('fake-screen-region-home'), nonce = 'a'.repeat(32), written = new Map(), calls = [];
    const config = { home, nonce, gate: 'fake-gate', identity: 'fake-identity', ppilotFocus: explicit };
    let enabled = false;
    const app = new EventEmitter();
    Object.assign(app, { setPath() {}, whenReady: () => Promise.resolve(), isAccessibilitySupportEnabled: () => enabled,
      setAccessibilitySupportEnabled: value => { calls.push(value); enabled = value; app.emit('accessibility-support-changed', {}, value); },
      exit: () => assert.fail('Unexpected fixture failure'), quit() {} });
    class FakeWindow extends EventEmitter {
      constructor() {
        super(); this.webContents = new EventEmitter();
        this.webContents.loadURL = undefined;
        this.webContents.executeJavaScript = async () => ({ dummyHasDocumentFocus: false, markers: [] });
      }
      async loadURL() { this.webContents.emit('dom-ready'); this.webContents.emit('did-finish-load'); this.emit('ready-to-show'); }
      getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(123n); return b; }
      getBounds() { return { x: 0, y: 0, width: 800, height: 500 }; }
      getContentBounds() { return this.getBounds(); }
      isDestroyed() { return false; }
      isVisible() { return true; }
      isFocused() { return false; }
      showInactive() {}
    }
    const fakeFs = {
      readFileSync: file => { assert.equal(file, 'config'); return JSON.stringify(config); }, existsSync: () => false,
      writeFileSync: (file, value) => written.set(file, JSON.parse(value)),
      renameSync: (from, to) => { written.set(to, written.get(from)); written.delete(from); }
    };
    new Script(source).runInNewContext({ Buffer, Date, JSON, Promise, process: { argv: ['node', 'fixture', 'config'], pid: 20, versions: {}, on() {} },
      setInterval: () => 1, clearInterval() {}, require: name => {
        if (name === 'node:fs') return fakeFs;
        if (name === 'node:path') return path;
        if (name === 'node:child_process') return { execFileSync: () => JSON.stringify({ ok: true, ...fullIdentity(20) }), spawn: () => assert.fail('No probe from startup') };
        if (name === 'electron') return { app, BrowserWindow: FakeWindow, screen: { dipToScreenRect: (_window, rect) => rect } };
        assert.fail('Unexpected fixture dependency ' + name);
      } });
    for (let i = 0; i < 20 && !written.has(path.join(home, 'ready.json')); i++) await Promise.resolve();
    const ready = written.get(path.join(home, 'ready.json'));
    assert.ok(ready, JSON.stringify([...written.entries()]));
    assert.deepEqual(calls, explicit === true ? [true] : []);
    assert.equal(ready.accessibility.forcedForFixture, explicit === true);
    assert.equal(ready.accessibility.supportEnabled, explicit === true);
    const events = ready.lifecycle.map(value => value.event);
    for (const name of ['app-ready', 'window-created', 'load-start', 'dom-ready', 'did-finish-load', 'ready-to-show', 'load-resolved', 'shown-inactive', 'fixture-ready']) assert.ok(events.includes(name), name);
    assert.ok(events.indexOf('window-created') < events.indexOf('dom-ready'));
    assert.ok(events.indexOf('dom-ready') < events.indexOf('fixture-ready'));
    assert.ok(ready.lifecycle.every((value, index) => value.sequence === index + 1 && Number.isFinite(value.at)));
    assert.ok(written.has(path.join(home, 'lifecycle.json')), 'Readiness evidence survives before/without a later state read');
  });
});

test('missing ready still requests nonce close, recovers boot identity and confirms original exit', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const events = [], boot = { nonce: 'n', pid: 10, identity: { pid: 10, startedUtcTicks: '100' } };
  const result = await cleanupScreenRegionOwned({ nonce: 'n', requestClose: () => events.push('close'),
    recoverBoot: () => { events.push('recover'); return boot; },
    waitExit: id => { assert.equal(id, boot.identity); events.push('wait-original'); return { originalExited: true }; },
    forceExit: () => assert.fail('unneeded force'), readClosed: () => ({ nonce: 'n', pid: 10, activeProbe: false, probes: [] }) });
  assert.equal(result.ok, true); assert.deepEqual(events, ['close', 'recover', 'wait-original']);
});

test('cleanup does not force parent before its bounded probe watchdog can finish', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  let calls = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: { pid: 10 } }, requestClose() {},
    waitExit: (id, ms) => { assert.equal(ms, 10000); return { originalExited: ++calls === 2 }; }, forceExit: () => assert.fail('premature parent kill'),
    readClosed: () => ({ nonce: 'n', pid: 10, activeProbe: false, probes: [{ pid: 11, exitObserved: true, closeObserved: true }] }),
    readProbeIdentity: () => { throw new Error('child exited before identity'); } });
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(result.probes[0].originalChildExitObserved, true);
});

test('unclean parent exit still cleans exact registered probe and cannot claim clean shutdown', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const waited = [];
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: { pid: 10 } }, requestClose() {},
    waitExit: id => { waited.push(id.pid); return { originalExited: true }; }, forceExit: () => assert.fail('unneeded force'),
    readClosed: () => { throw new Error('no clean receipt'); },
    readProbeEvents: () => ({ nonce: 'n', pid: 10, probes: [{ pid: 11 }] }),
    readProbeIdentity: () => ({ pid: 11, startedUtcTicks: '101' }) });
  assert.equal(result.ok, false); assert.deepEqual(waited, [10, 11]); assert.equal(result.probes[0].originalExited, true);
});

const fullIdentity = pid => ({ pid, parentPid: 9, startedUtcTicks: '638000000000000000', executable: 'C:\\owned\\fixture.exe',
  sha256: 'a'.repeat(64), integrityRid: 8192, elevated: false, uiAccess: false });
const cleanReceipt = probes => ({ nonce: 'n', pid: 10, activeProbe: false, probes });

test('forced fixture shutdown remains failed even with confirmed exit and a clean receipt', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const identity = fullIdentity(10); let waits = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity }, requestClose() {},
    waitExit: () => ({ originalExited: ++waits > 2 }), forceExit: id => { assert.equal(id, identity); return { originalExited: true, forced: true }; },
    readClosed: () => cleanReceipt([]) });
  assert.equal(result.ok, false); assert.equal(result.fixture.originalExited, true);
  assert.equal(result.forcedAttempts.length, 1); assert.equal(result.forcedAttempts[0].pid, 10); assert.equal(result.forcedAttempts[0].result.forced, true);
});

test('forced probe shutdown is recorded and cannot turn into a passing acceptance', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const child = fullIdentity(11); let childWaits = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: fullIdentity(10) }, requestClose() {},
    waitExit: id => ({ originalExited: id.pid === 10 || ++childWaits > 1 }), forceExit: id => { assert.equal(id, child); return { originalExited: true, forced: true }; },
    readClosed: () => cleanReceipt([{ pid: 11, exitObserved: true, closeObserved: true }]), readProbeIdentity: () => child });
  assert.equal(result.ok, false); assert.equal(result.probes[0].originalExited, true);
  assert.equal(result.forcedAttempts.length, 1); assert.equal(result.forcedAttempts[0].pid, 11);
});

test('fixture wait error is retained while exact-identity fallback still runs', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const identity = fullIdentity(10), forced = []; let waits = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity }, requestClose() {},
    waitExit: () => { if (!waits++) throw Object.assign(new Error('original wait access failure'), { code: 'EACCES' }); return { originalExited: true }; },
    forceExit: id => { forced.push(id); return { originalExited: true, forced: true }; }, readClosed: () => cleanReceipt([]) });
  assert.deepEqual(forced, [identity]); assert.equal(result.ok, false); assert.equal(result.fixture.originalExited, true);
  assert.match(result.error, /original wait access failure/); assert.equal(result.errors[0].code, 'EACCES');
});

test('probe wait and forced-cleanup errors preserve the first cause and still recheck exit', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  let childWaits = 0, forced = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: fullIdentity(10) }, requestClose() {},
    waitExit: id => { if (id.pid === 11 && !childWaits++) throw new Error('original child wait failure'); return { originalExited: true }; },
    forceExit: id => { assert.equal(id.pid, 11); forced++; throw new Error('cleanup receipt lost'); },
    readClosed: () => cleanReceipt([{ pid: 11, exitObserved: true, closeObserved: true }]), readProbeIdentity: () => fullIdentity(11) });
  assert.equal(forced, 1); assert.equal(childWaits, 2); assert.equal(result.ok, false); assert.equal(result.probes[0].originalExited, true);
  assert.equal(result.error, 'original child wait failure'); assert.ok(result.errors.some(error => error.message === 'cleanup receipt lost'));
  assert.equal(result.forcedAttempts[0].error, 'cleanup receipt lost');
});

test('incomplete identity cannot authorize fallback termination after a wait failure', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  let waits = 0;
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: { pid: 10, startedUtcTicks: '100' } }, requestClose() {},
    waitExit: () => { if (!waits++) throw new Error('first wait failed'); return { originalExited: true }; },
    forceExit: () => assert.fail('partial identity cannot authorize termination'), readClosed: () => cleanReceipt([]) });
  assert.equal(result.ok, false); assert.equal(result.error, 'first wait failed');
  assert.equal(result.forcedAttempts.length, 1); assert.equal(result.forcedAttempts[0].forceAttempted, false);
  assert.match(result.forcedAttempts[0].error, /Full process\/parent identity required/);
});

test('multiple fallback attempts remain individually visible after all originals exit', async () => {
  const { cleanupScreenRegionOwned } = await import('../scripts/verify-desktop-screen-region.mjs');
  const waits = new Map(), forced = [];
  const result = await cleanupScreenRegionOwned({ nonce: 'n', boot: { pid: 10, identity: fullIdentity(10) }, requestClose() {},
    waitExit: id => { const n = (waits.get(id.pid) || 0) + 1; waits.set(id.pid, n); return { originalExited: n > (id.pid === 10 ? 2 : 1) }; },
    forceExit: id => { forced.push(id.pid); return { originalExited: true, forced: true }; },
    readClosed: () => cleanReceipt([{ pid: 11 }, { pid: 12 }]), readProbeIdentity: record => fullIdentity(record.pid) });
  assert.equal(result.ok, false); assert.deepEqual(forced, [10, 11, 12]);
  assert.deepEqual(result.forcedAttempts.map(value => value.pid), [10, 11, 12]);
  assert.ok(result.forcedAttempts.every(value => value.forceAttempted && value.result.originalExited));
  assert.ok(result.probes.every(value => value.originalExited));
});

function focusFake(overrides = {}) {
  const nonce = 'c'.repeat(32), target = { id: 'owned-window', pid: 20, nativeHandle: '222', title: 'ProfilePilot screen region ' + nonce };
  const options = { nonce, session: 'owned-session', requestId: 'one-focus-request', buildId: 'b'.repeat(64), appEntry: 'C:\\repo\\dist\\main\\entry.js',
    expectedAppExecutable: fullIdentity(10).executable, expectedAppSha256: fullIdentity(10).sha256,
    fixture: { pid: 20, hwnd: '222', title: target.title, identity: fullIdentity(20) } };
  const ctx = { calls: [], owner: null, foreground: '999', params: null, target, options };
  function status() { return { session: ctx.owner ? { ...ctx.owner, window: target } : null, inputObservation: { phase: ctx.owner?.state === 'active' ? 'ready' : ctx.owner ? 'paused' : 'idle' } }; }
  const io = {
    gate: async () => {},
    appStatus: async () => ({ ok: true, data: { pid: 10, build: { buildId: options.buildId, entry: options.appEntry, startedAt: '2026-10-29T00:00:00Z' } } }),
    identity: async pid => fullIdentity(pid),
    writeParams: async params => { ctx.params = params; return 'C:\\owned\\params.json'; },
    desktop: async args => {
      ctx.calls.push(args);
      if (overrides[args[0]]) { const response = await overrides[args[0]](ctx, args); if (response !== undefined) return response; }
      switch (args[0]) {
        case 'status': return { ok: true, result: status() };
        case 'windows': return { ok: true, result: { windows: [target] } };
        case 'doctor': return { ok: true, result: { target: { pid: 20, hwnd: '222', integrity: { rid: 8192, elevated: false } }, foreground: { hwnd: ctx.foreground }, status: status() } };
        case 'claim': ctx.owner = { name: options.session, state: 'active' }; return { ok: true, result: status() };
        case 'observe': return { ok: true, result: { windowId: target.id, version: 'd'.repeat(32), elements: [{ name: 'ProfilePilot focus ' + nonce, role: 'Button', reference: 'button-current', enabled: true, offscreen: false }] } };
        case 'action': ctx.foreground = '222'; return { ok: true, result: { executed: true } };
        case 'complete': assert.ok(args.includes('--require-active')); assert.equal(ctx.owner?.state, 'active'); ctx.owner = null; return { ok: true, result: status() };
        case 'release': assert.equal(ctx.owner?.name, options.session); ctx.owner = null; return { ok: true, result: status() };
        case 'receipt': return { ok: true, result: { historical: true, state: 'succeeded' } };
        default: assert.fail('Unexpected operation ' + args[0]);
      }
    }
  };
  return { ctx, options, io };
}

test('explicit ppilot preparation sends one fresh focus and conditionally completes its own session', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake(); const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, true); assert.equal(result.actionDispatchCount, 1);
  assert.equal(result.foregroundChanged, true); assert.equal(result.targetIsForeground, true);
  assert.equal(result.completedRequireActive, true); assert.equal(result.cleanup.ownedSessionGone, true);
  assert.deepEqual(fake.ctx.params, { version: 'd'.repeat(32), ref: 'button-current', kind: 'focus' });
  assert.deepEqual(fake.ctx.calls.filter(args => ['claim', 'action', 'complete'].includes(args[0])).map(args => args[0]), ['claim', 'action', 'complete']);
  assert.ok(!fake.ctx.calls.some(args => ['resume', 'screenshot', 'release'].includes(args[0])));
});

test('existing App session blocks preparation without claiming or releasing anyone', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake(); fake.ctx.owner = { name: 'other-task', state: 'active' };
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, false); assert.equal(result.failure.stage, 'preflight');
  assert.equal(fake.ctx.owner.name, 'other-task'); assert.deepEqual(fake.ctx.calls.map(args => args[0]), ['status']);
});

test('current build mismatch fails before App desktop control is requested', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake(); const original = fake.io.appStatus;
  fake.io.appStatus = async () => { const response = await original(); response.data.build.buildId = 'old'; return response; };
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, false); assert.match(result.failure.message, /current local control build/); assert.deepEqual(fake.ctx.calls, []);
});

test('missing nonce focus button releases only the owned claim and never substitutes another control', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const observation = { windowId: 'owned-window', version: 'd'.repeat(32), gaps: ['depth_limit'], elements: [{ role: 'Button', name: 'not our nonce', reference: 'foreign' }] };
  const fake = focusFake({ observe: () => ({ ok: true, result: observation }) });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, false); assert.equal(result.cleanup.ownedSessionGone, true);
  assert.deepEqual(result.observation, observation, 'Complete UIA evidence must survive a failed button assertion');
  assert.equal(result.focusButtonMatchCount, 0);
  assert.equal(fake.ctx.calls.filter(args => args[0] === 'release').length, 1); assert.ok(!fake.ctx.calls.some(args => args[0] === 'action'));
});

test('lost focus reply reads a receipt and releases but never replays or resumes', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ action: () => { throw Object.assign(new Error('reply deadline'), { outcome: 'unknown' }); } });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, true); assert.equal(result.outcome, 'focus_failed_or_unknown');
  assert.equal(result.failure.outcome, 'unknown'); assert.equal(result.cleanup.ownedSessionGone, true);
  for (const name of ['claim', 'action', 'receipt', 'release']) assert.equal(fake.ctx.calls.filter(args => args[0] === name).length, 1);
  assert.ok(!fake.ctx.calls.some(args => ['resume', 'complete'].includes(args[0])));
});

test('user takeover after focus prevents completion and does not automatically resume', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ action: ctx => { ctx.owner.state = 'paused'; } });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.completedRequireActive, false); assert.equal(result.cleanup.ownedSessionGone, true);
  assert.ok(!fake.ctx.calls.some(args => ['resume', 'complete'].includes(args[0])));
  assert.equal(fake.ctx.calls.filter(args => args[0] === 'action').length, 1);
});

test('conditional completion refusal remains a failure and only releases its paused session', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ complete: (ctx, args) => { assert.ok(args.includes('--require-active')); ctx.owner.state = 'paused'; return { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }; } });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.completedRequireActive, false); assert.equal(result.failure.code, 'DESKTOP_USER_IN_CONTROL');
  assert.equal(fake.ctx.calls.filter(args => args[0] === 'complete').length, 1); assert.equal(fake.ctx.calls.filter(args => args[0] === 'release').length, 1);
});

test('successful UIA focus is not mistaken for actual foreground ownership', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ action: () => ({ ok: true, result: { executed: true } }) });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.completedRequireActive, true); assert.equal(result.foregroundChanged, false); assert.equal(result.targetIsForeground, false);
  assert.equal(result.outcome, 'focus_executed_without_target_foreground'); assert.equal(result.actionDispatchCount, 1);
});

test('lost claim reply reconciles the unique session without a second claim or input', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ claim: ctx => { ctx.owner = { name: ctx.options.session, state: 'active' }; throw new Error('claim reply lost'); } });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, false); assert.equal(result.cleanup.ownedSessionGone, true);
  assert.equal(fake.ctx.calls.filter(args => args[0] === 'claim').length, 1); assert.equal(fake.ctx.calls.filter(args => args[0] === 'release').length, 1);
});

test('a different successor session is never released during focus cleanup', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ action: ctx => { ctx.owner = { name: 'successor', state: 'active' }; return { ok: false, code: 'DESKTOP_SESSION_ENDED' }; } });
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.cleanup.ownedSessionGone, true); assert.equal(fake.ctx.owner.name, 'successor');
  assert.ok(!fake.ctx.calls.some(args => ['release', 'resume', 'complete'].includes(args[0])));
});

test('initial App executable, hash, parent and birth must match the pinned repository runtime', async t => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  for (const [field, value] of [['executable', 'C:\\other\\electron.exe'], ['sha256', 'f'.repeat(64)], ['parentPid', 0], ['startedUtcTicks', 'unknown']]) {
    await t.test(field, async () => {
      const fake = focusFake(); fake.io.identity = async pid => ({ ...fullIdentity(pid), ...(pid === 10 ? { [field]: value } : {}) });
      const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
      assert.equal(result.actualAppFocusAttempted, false); assert.equal(result.failure.stage, 'preflight'); assert.deepEqual(fake.ctx.calls, []);
    });
  }
});

test('a gate closure immediately before action is not reported as a dispatched focus', async () => {
  const { attemptScreenRegionPpilotFocus } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake(); let afterParams = 0;
  fake.io.gate = async () => { if (fake.ctx.params && ++afterParams >= 2) throw new Error('acceptance deferred'); };
  const result = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(result.actualAppFocusAttempted, false); assert.equal(result.actionDispatchCount, 0);
  assert.ok(!fake.ctx.calls.some(args => args[0] === 'action')); assert.equal(result.cleanup.ownedSessionGone, true);
});

test('failed ppilot preparation cannot switch to independent observation even when target is foreground', async t => {
  const { attemptScreenRegionPpilotFocus, observeScreenRegionAfterPreparation } = await import('../scripts/verify-desktop-screen-region.mjs');
  const cases = {
    takeover: { action: ctx => { ctx.owner.state = 'paused'; ctx.foreground = '222'; } },
    unknown_action: { action: ctx => { ctx.foreground = '222'; throw Object.assign(new Error('unknown action result'), { outcome: 'unknown' }); } },
    unknown_claim: { claim: ctx => { ctx.owner = { name: ctx.options.session, state: 'active' }; ctx.foreground = '222'; throw Object.assign(new Error('unknown claim result'), { outcome: 'unknown' }); } },
    refused_claim: { claim: ctx => { ctx.foreground = '222'; return { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }; } },
    observer_lost: { action: ctx => { ctx.owner.state = 'paused'; ctx.foreground = '222'; return { ok: false, code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' }; } }
  };
  for (const [name, overrides] of Object.entries(cases)) await t.test(name, async () => {
    const fake = focusFake(overrides), preparation = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
    assert.ok(preparation.failure); assert.equal(preparation.cleanup.ownedSessionGone, true);
    const calls = [], inputBefore = fake.ctx.calls.filter(args => args[0] === 'action').length;
    await assert.rejects(observeScreenRegionAfterPreparation({ ppilotFocus: true, preparation, hwnd: '222', waitMs: 0, cover: true,
      diagnosis: { result: { before: { foreground: '222' } } } }, {
      observe: async action => { calls.push(action); return { result: { before: { foreground: '222' }, status: action === 'capture' ? 'captured' : 'diagnosed' } }; },
      cover: async () => { calls.push('cover'); return {}; }
    }), /ppilot preparation did not complete successfully/);
    assert.deepEqual(calls, [], 'No independent diagnosis, capture or cover may follow the failed preparation');
    assert.equal(fake.ctx.calls.filter(args => args[0] === 'action').length, inputBefore, 'No extra input or replay after failure');
    assert.ok(!fake.ctx.calls.some(args => args[0] === 'resume'));
  });
});

test('successful conditional completion without foreground permits only the ordinary qualification result', async () => {
  const { attemptScreenRegionPpilotFocus, observeScreenRegionAfterPreparation } = await import('../scripts/verify-desktop-screen-region.mjs');
  const fake = focusFake({ action: () => ({ ok: true, result: { executed: true } }) });
  const preparation = await attemptScreenRegionPpilotFocus(fake.options, fake.io);
  assert.equal(preparation.completedRequireActive, true); assert.equal(preparation.targetIsForeground, false);
  const calls = [];
  const result = await observeScreenRegionAfterPreparation({ ppilotFocus: true, preparation, hwnd: '222', waitMs: 0, cover: true }, {
    observe: async action => { calls.push(action); return { result: { before: { foreground: '999' }, status: action === 'capture' ? 'not_captured' : 'diagnosed', captureAttempted: false } }; },
    cover: () => assert.fail('A non-foreground target must not receive a cover')
  });
  assert.deepEqual(calls, ['diagnose', 'capture']); assert.equal(result.captured.result.captureAttempted, false);
  assert.equal(fake.ctx.calls.filter(args => args[0] === 'action').length, 1);
});

test('missing conditional completion cannot enter observation even without an explicit failure object', async () => {
  const { observeScreenRegionAfterPreparation } = await import('../scripts/verify-desktop-screen-region.mjs');
  const io = { observe: () => assert.fail('No native calls'), cover: () => assert.fail('No cover') };
  await assert.rejects(observeScreenRegionAfterPreparation({ ppilotFocus: true, preparation: { cleanup: { ownedSessionGone: true }, completedRequireActive: false } }, io), /did not complete successfully/);
  await assert.rejects(observeScreenRegionAfterPreparation({ ppilotFocus: false, preparation: { failure: { code: 'DESKTOP_USER_IN_CONTROL' } } }, io), /cannot be bypassed/);
});
