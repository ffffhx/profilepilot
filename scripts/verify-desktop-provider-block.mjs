import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { windowStateFixtureLifecycle } from './verify-desktop-window-state.mjs';

export function providerBlockOptions(args) {
  let mode, kind = 'deadline', seenCase = false;
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--run'].includes(args[i]) && !mode) mode = args[i];
    else if (args[i] === '--case' && !seenCase) { seenCase = true; kind = args[++i]; }
    else throw new Error('Use [--check | --run] [--case deadline | conditional_complete]');
  }
  assert.ok(['deadline', 'conditional_complete'].includes(kind)); return { run: mode === '--run', kind };
}
export function verifyProviderBaseline(observation, expected) {
  assert.equal(observation.windowId, expected.windowId); assert.equal(observation.truncated, false);
  assert.deepEqual(observation.gaps, []); assert.ok(typeof observation.version === 'string' && observation.version);
  const roots = observation.elements.filter(value => value.parent === -1);
  assert.equal(roots.length, 1); assert.equal(roots[0].role, 'Window'); assert.equal(roots[0].name, expected.rootName); assert.equal(roots[0].password, false);
  assert.equal(roots[0].truncatedFields?.includes('name'), false, 'Explicit untruncated name evidence is required');
  assert.equal(observation.elements.filter(value => value.name === expected.rootName && value.role === 'Window').length, 1);
  assert.equal(observation.elements.filter(value => value.name === 'Provider getter ' + expected.nonce).length, 1);
  return roots[0].reference;
}
export function verifyProviderMarker(value, expected, marker, source) {
  for (const key of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'runId']) assert.equal(value[key], expected[key], key);
  assert.equal(value.marker, marker); assert.equal(value.source, source); assert.equal(value.entries, 1);
  assert.match(value.counter, /^[1-9]\d*$/); assert.ok(Number.isSafeInteger(value.frequency) && value.frequency > 0);
  assert.ok(Number.isSafeInteger(value.getterThreadId) && value.getterThreadId > 0);
  assert.ok(Number.isFinite(Date.parse(value.utc)));
  if (marker === 'entered') { assert.equal(value.getterActive, true); assert.equal(value.returned, 0); }
  if (marker === 'returned') { assert.equal(value.getterActive, false); assert.equal(value.returned, 1); }
}
export function verifyProviderPending(value, expected) {
  for (const key of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'runId']) assert.equal(value[key], expected[key], key);
  assert.equal(value.phase, 'entered'); assert.equal(value.getterActive, true); assert.equal(value.entries, 1); assert.equal(value.returned, 0);
}
// The same flow runs against fake I/O in pure tests and the actual App below.
// An early successful/failed UIA response is not accepted as blocking coverage.
export async function runProviderBlockCase(options, io, record = {}) {
  assert.ok(['deadline', 'conditional_complete'].includes(options.kind));
  const timeoutMs = options.kind === 'deadline' ? 4000 : 20000;
  record.timeoutMs = timeoutMs; record.kind = options.kind;
  record.armed = await io.arm();
  for (const key of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'runId']) assert.equal(record.armed[key], options.expected[key]);
  assert.equal(record.armed.phase, 'armed'); assert.equal(record.armed.entries, 0); assert.equal(record.armed.getterActive, false);
  const waiting = io.startWait(timeoutMs); // non-async factory: preserve the in-flight request
  record.entered = await io.entered(waiting, Math.min(timeoutMs, 8000));
  verifyProviderMarker(record.entered, options.expected, 'entered', 'accessible-name-getter');
  record.enteredObservedMs = waiting.enteredObservedMs;
  assert.ok(Number.isFinite(record.enteredObservedMs) && record.enteredObservedMs >= 0 && record.enteredObservedMs < Math.min(timeoutMs, 8000), 'Entry must be observed before the scenario deadline');
  assert.ok(Date.parse(record.entered.utc) >= waiting.dispatchedUtc, 'Getter entry predates the actual wait dispatch');
  assert.equal(waiting.settled, false, 'UIA/CLI returned before a pending provider call was established');
  record.pendingAtEntry = await io.pending(); verifyProviderPending(record.pendingAtEntry, options.expected);
  assert.equal(waiting.settled, false, 'Provider returned before the case trigger');
  if (options.kind === 'conditional_complete') {
    record.completeDispatchedAt = io.now();
    // A plain release can end an already-paused owner. Receiving a delayed
    // wait error after that release cannot establish what cancelled the wait.
    // The existing App command checks active synchronously before ending it.
    record.complete = await io.completeSession(); assert.equal(record.complete.response.ok, true); assert.equal(record.complete.response.result.session, null);
  }
  record.wait = await waiting.result;
  assert.equal(record.wait.exitCode, 75, 'Early match/transport failure is not provider-block coverage');
  if (options.kind === 'deadline') {
    const result = record.wait.response.result;
    assert.equal(record.wait.response.ok, true); assert.equal(result.timedOut, true); assert.equal(result.matched, false);
    assert.equal(result.attempts, 1); assert.equal(result.requiresObservation, true);
    assert.equal(result.observation, undefined, 'Any completed observation makes this a different scenario');
    assert.deepEqual(result.matchedReferences, []);
  } else {
    assert.equal(record.wait.response.ok, false); assert.equal(record.wait.response.code, 'DESKTOP_USER_IN_CONTROL');
    assert.ok(waiting.settledAt >= record.completeDispatchedAt, 'Wait settled before conditional CLI completion');
  }
  // The independent watcher can answer while the actual getter is blocked.
  record.pendingAfterWait = await io.pending(); verifyProviderPending(record.pendingAfterWait, options.expected);
  record.statusAfterWait = await io.status();
  const verifyStatus = response => {
    assert.equal(response.response.ok, true);
    if (options.kind !== 'deadline') { assert.equal(response.response.result.session, null); return; }
    const status = response.response.result;
    assert.equal(status.session?.name, options.session); assert.equal(status.session.state, 'active');
    assert.equal(status.session.revision, options.before.session.revision + 1);
    assert.equal(status.inputObservation.phase, 'pending');
    assert.equal(status.inputObservation.epoch, options.before.inputObservation.epoch);
    assert.equal(status.inputObservation.generation, options.before.inputObservation.generation);
  };
  verifyStatus(record.statusAfterWait);
  record.ownerExit = await io.waitOwnerExit(); assert.equal(record.ownerExit.ok, true); assert.equal(record.ownerExit.originalExited, true);
  record.pendingAfterOwnerExit = await io.pending(); verifyProviderPending(record.pendingAfterOwnerExit, options.expected);
  record.statusAfterOwnerExit = await io.status(); verifyStatus(record.statusAfterOwnerExit);
  if (options.kind === 'deadline') {
    record.cleanupReleaseDispatchedAt = io.now(); record.cleanupRelease = await io.releaseSession();
    assert.equal(record.cleanupRelease.response.ok, true); assert.equal(record.cleanupRelease.response.result.session, null);
  }
  record.observerExit = await io.waitObserverExit(); assert.equal(record.observerExit.ok, true); assert.equal(record.observerExit.originalExited, true);
  record.pendingBeforeProviderRelease = await io.pending(); verifyProviderPending(record.pendingBeforeProviderRelease, options.expected);
  // Only after the old worker and observer have exited may the harness release
  // the provider. Otherwise a successful exit could simply be a normal return.
  await io.releaseProvider(); record.released = await io.released(); record.returned = await io.returned();
  verifyProviderMarker(record.released, options.expected, 'released', 'explicit-release');
  verifyProviderMarker(record.returned, options.expected, 'returned', 'accessible-name-getter');
  assert.equal(record.entered.frequency, record.released.frequency); assert.equal(record.entered.frequency, record.returned.frequency);
  assert.ok(BigInt(record.entered.counter) < BigInt(record.released.counter));
  assert.ok(BigInt(record.released.counter) < BigInt(record.returned.counter));
  record.ok = true; return record;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export async function pollProviderFile(read, accept, label, timeoutMs = 10000, { now = () => performance.now(), delay = sleep } = {}) {
  const deadline = now() + timeoutMs; let last;
  do {
    try { last = await read(); if (now() >= deadline) break; if (accept(last)) return last; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(20);
  } while (now() < deadline);
  throw Object.assign(new Error(label + ' timed out'), { last });
}
const poll = pollProviderFile;
export async function verifyDesktopProviderBlock(options) {
  assert.equal(process.platform, 'win32', 'This provider fixture is Windows only.');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-provider-block-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const fixtureExe = path.join(home, 'ProviderBlock.exe'), identityExe = path.join(home, 'Identity.exe'), samplerExe = path.join(home, 'Sample.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = (file, source, refs, target = 'exe') => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/target:' + target,
    '/out:' + file, ...refs.map(value => '/r:' + value + '.dll'), path.join(root, source)], { windowsHide: true, timeout: 30000 });
  compile(fixtureExe, 'scripts/e2e/desktop-provider-block-fixture.cs', ['System.Web.Extensions', 'System.Drawing', 'System.Windows.Forms', 'Accessibility'], 'winexe');
  compile(identityExe, 'scripts/e2e/desktop-observer-fault-identity.cs', ['System.Web.Extensions', 'System.Management']);
  compile(samplerExe, 'scripts/e2e/desktop-session-cycle-fixture.cs', ['System.Web.Extensions', 'System.Management', 'System.Drawing', 'System.Windows.Forms']);
  const report = { ok: false, mode: options.run ? 'run' : 'compile-only', case: options.kind, home, output, startedAt: new Date().toISOString(), checks: [], cleanup: {},
    scope: 'Actual Medium ProfilePilot App CLI with one nonce-owned nonactivating WinForms accessibility Name getter.',
    physicalInputInjected: false, automaticRecovery: false, sources: [
      'https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.control.createaccessibilityinstance',
      'https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.accessibleobject.name',
      'https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_transactiontimeout',
      'https://learn.microsoft.com/en-us/previous-versions/windows/win32/win7appqual/preventing-hangs-in-windows-applications'
    ], limitations: [
      'conditional_complete exercises CLI complete --require-active; it is not a toolbar Stop click or physical user takeover. An already-paused owner must be rejected.',
      'A getter entry is directly recorded, but its calling process is not attributed by this fixture. Early UIA return fails this scenario.',
      'This is one WinForms provider property call, not a promise that arbitrary third-party providers block forever. OS/UIA timeouts and ghosting are not disabled.',
      'Exact PID/birth/path/hash is captured before blocking. Independent handle-based waits establish original process exit; this does not prove cooperative cancellation or natural worker exit.',
      'Production may terminate its blocked worker after its cancellation grace period. Harness-forced fixture cleanup always fails acceptance.',
      'Only owned input counters and native lifecycle are checked. No keyboard/pointer action, screenshot, foreground activation, macOS, or physical hardware coverage.'
    ] };
  report.hashes = { fixture: await digest(fixtureExe), identity: await digest(identityExe), sampler: await digest(samplerExe), harness: await digest(fileURLToPath(import.meta.url)) };
  const persist = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (!options.run) { report.ok = true; report.guiStarted = false; report.osSampled = false; await persist(); return report; }
  // First permission-sensitive operation. Compile-only never queries the OS,
  // connects to an App, starts a window, or installs a hook.
  await assertDesktopAcceptanceWindow();
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const base = path.join(home, 'fixture'), nonce = randomBytes(16).toString('hex'), session = 'provider-block-' + randomUUID(), runId = randomUUID();
  Object.assign(report, { nonce, session, runId }); let app, fixture, heartbeat, catalog, owner, observer, waiting;
  const id = args => JSON.parse(execFileSync(identityExe, args, { windowsHide: true, timeout: 12000, encoding: 'utf8' }));
  function identity(value, executable, hash) {
    assert.equal(value.ok, true); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid) && value.parentPid > 0);
    assert.match(value.startedUtcTicks, /^[1-9]\d{15,18}$/); assert.equal(path.resolve(value.executable).toLowerCase(), path.resolve(executable).toLowerCase());
    assert.equal(value.sha256, hash); assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false); return value;
  }
  const sameIdentity = (a, b) => { for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'executable', 'sha256']) assert.equal(a[key], b[key]); };
  async function cli(args, expectedExitCode = 0) {
    const started = performance.now();
    try { return { ...await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...args, '--json'], env, cwd: root, timeoutMs: 70000, expectedExitCode }), elapsedMs: performance.now() - started }; }
    catch (error) { error.elapsedMs = performance.now() - started; error.method = args[0] === 'desktop' ? args[1] : args[0]; throw error; }
  }
  const desktop = (args, expected) => cli(['desktop', ...args], expected);
  const status = () => desktop(['status']);
  async function preflight() {
    const runtime = (await cli(['status'])).response.data, build = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(runtime.build.buildId, build.buildId); assert.equal(path.resolve(runtime.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
    assert.equal(build.cliSha256, await digest(path.join(root, 'dist/main/profilepilot-cli.cjs')));
    for (const name of ['Desktop', 'InputObserver', 'WindowsSampler']) assert.equal(build.components[`dist/native/ProfilePilot.${name}.exe`], await digest(path.join(root, `dist/native/ProfilePilot.${name}.exe`)));
    const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
    const current = { pid: runtime.pid, build: runtime.build, identity: identity(id(['--inspect', String(runtime.pid)]), electron, await digest(electron)) };
    if (app) { sameIdentity(app.identity, current.identity); assert.equal(app.build.buildId, current.build.buildId); assert.equal(app.build.startedAt, current.build.startedAt); }
    assert.equal((await status()).response.result.session, null); return current;
  }
  async function sample() {
    const value = JSON.parse(execFileSync(samplerExe, ['--sample', String(app.pid), app.identity.executable, app.identity.startedUtcTicks], { windowsHide: true, encoding: 'utf8', timeout: 12000 }));
    assert.equal(value.ok, true); assert.equal(value.app.startedUtcTicks, app.identity.startedUtcTicks);
    const names = { desktop: 'Desktop', 'input-observer': 'InputObserver', 'windows-sampler': 'WindowsSampler' };
    for (const child of value.children) { assert.ok(names[child.kind]); assert.equal(child.sha256, await digest(path.join(root, `dist/native/ProfilePilot.${names[child.kind]}.exe`))); }
    return value;
  }
  const childKey = child => child.metrics.pid + ':' + child.metrics.startedUtcTicks;
  function pinChild(child) {
    const value = identity(id(['--inspect', String(child.metrics.pid)]), child.executable, child.sha256);
    assert.equal(value.parentPid, app.pid); assert.equal(value.startedUtcTicks, child.metrics.startedUtcTicks);
    const directory = path.join(os.tmpdir(), `profilepilot-${child.kind}-runtime`);
    assert.equal(path.resolve(path.dirname(value.executable)).toLowerCase(), path.resolve(directory).toLowerCase());
    assert.equal(path.basename(value.executable).toLowerCase(), value.sha256 + '.exe'); return value;
  }
  const fixtureLifecycle = windowStateFixtureLifecycle({ nonce, executable: fixtureExe, sha256: report.hashes.fixture }, {
    launch: () => launchWindowsUserProcess(fixtureExe, [base, nonce], root),
    ready: () => poll(() => json(base + '.ready.json'), value => value.nonce === nonce, 'owned cleanup ready', 3000),
    inspect: pid => id(['--inspect', String(pid)]), requestClose: () => writeFile(base + '.close', nonce),
    closed: () => poll(() => json(base + '.closed.json'), value => value.nonce === nonce, 'owned close receipt'),
    wait: (value, ms) => id(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, String(ms)]),
    force: value => id(['--cleanup-owned', String(value.pid), value.startedUtcTicks, value.executable, value.sha256, String(value.parentPid)])
  });
  const waitOriginal = value => id(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, '5000']);
  try {
    app = report.appBefore = await preflight(); report.initialSample = await sample();
    assert.equal(report.initialSample.children.filter(child => child.kind === 'input-observer').length, 0, 'A shared browser observer may not be disturbed');
    await writeFile(base + '.heartbeat', nonce); heartbeat = setInterval(() => { void writeFile(base + '.heartbeat', nonce).catch(error => { report.heartbeatError = error.message; }); }, 1000); heartbeat.unref();
    fixture = await fixtureLifecycle.launch(); const fixtureIdentity = report.fixtureIdentity = fixtureLifecycle.pin(identity(id(['--inspect', String(fixture.pid)]), fixtureExe, report.hashes.fixture));
    const ready = report.ready = await poll(() => json(base + '.ready.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'fixture readiness');
    assert.equal(ready.startedUtcTicks, fixtureIdentity.startedUtcTicks); assert.equal(ready.hwnd, ready.currentHwnd); assert.equal(ready.nonactivating, true);
    assert.equal(ready.foregroundBefore, ready.foregroundAfter, 'Fixture startup must not steal foreground');
    const target = report.target = (await desktop(['windows'])).response.result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === ready.hwnd && value.title === ready.rootName); assert.ok(target);
    report.catalogSample = await sample(); assert.equal(report.catalogSample.children.length, 1); assert.equal(report.catalogSample.children[0].kind, 'desktop'); catalog = report.catalogSample.children[0];
    report.claim = await desktop(['claim', '--session', session, '--window', target.id]);
    report.baseline = (await desktop(['observe', '--session', session])).response.result;
    report.rootReference = verifyProviderBaseline(report.baseline, { nonce, windowId: target.id, rootName: ready.rootName });
    const before = report.activeBefore = (await status()).response.result;
    assert.equal(before.session?.name, session); assert.equal(before.session.state, 'active'); assert.equal(before.inputObservation.phase, 'ready'); assert.notEqual(before.inputObservation.unobservedTestDriver, true);
    report.activeSample = await sample(); const owners = report.activeSample.children.filter(child => child.kind === 'desktop' && childKey(child) !== childKey(catalog));
    const observers = report.activeSample.children.filter(child => child.kind === 'input-observer');
    assert.equal(report.activeSample.children.length, 3); assert.equal(owners.length, 1); assert.equal(observers.length, 1);
    owner = report.owner = pinChild(owners[0]); observer = report.observer = pinChild(observers[0]);
    const expected = { nonce, pid: fixture.pid, startedUtcTicks: fixtureIdentity.startedUtcTicks, hwnd: ready.hwnd, runId };
    const state = () => { const after = Date.now(); return poll(() => json(base + '.state.json'), value => value.nonce === nonce && value.pid === fixture.pid && Date.parse(value.capturedAt) >= after, 'fresh watcher state', 2000); };
    report.inputBefore = await state();
    const marker = suffix => poll(() => json(base + suffix + '.json'), value => value.nonce === nonce && value.runId === runId, suffix + ' marker', 3000);
    report.trial = {};
    await runProviderBlockCase({ kind: options.kind, expected, session, before }, {
      now: () => performance.now(),
      arm: async () => { await writeFile(base + '.arm.json', JSON.stringify({ nonce, id: runId, expiresAt: Date.now() + 10000 })); return marker('.armed'); },
      startWait: timeoutMs => {
        waiting = { settled: false, dispatchedAt: performance.now(), dispatchedUtc: Date.now() };
        waiting.result = desktop(['wait', '--session', session, '--name', ready.rootName, '--role', 'Window', '--timeout-ms', String(timeoutMs), '--interval-ms', '250'], null)
          .then(value => { waiting.settled = true; waiting.settledAt = performance.now(); waiting.value = value; return value; }, error => { waiting.settled = true; waiting.settledAt = performance.now(); waiting.error = error; throw error; });
        void waiting.result.catch(() => {}); return waiting;
      },
      entered: async (request, timeoutMs) => {
        const value = await poll(async () => { assert.equal(request.settled, false, 'Wait settled before entering the provider'); return json(base + '.entered.json'); }, item => item.nonce === nonce && item.runId === runId, 'provider getter entry', timeoutMs);
        request.enteredObservedMs = performance.now() - request.dispatchedAt; return value;
      },
      pending: state, status, releaseSession: () => desktop(['release', '--session', session]),
      completeSession: () => desktop(['complete', '--session', session, '--require-active'], null),
      waitOwnerExit: () => waitOriginal(owner), waitObserverExit: () => waitOriginal(observer),
      releaseProvider: () => writeFile(base + '.release', nonce + ':' + runId), released: () => marker('.released'), returned: () => marker('.returned')
    }, report.trial);
    report.inputAfter = await state(); assert.equal(report.inputAfter.keyboard, report.inputBefore.keyboard); assert.equal(report.inputAfter.pointer, report.inputBefore.pointer);
    report.checks.push('A real Name getter stayed pending through the wait result and the original owner worker exit');
    report.checks.push(options.kind === 'deadline' ? 'Wait deadline returned no observation, retired its old worker, and left the observer generation pending without automatic rearm' : 'Conditional CLI complete --require-active ended an active owner while its provider was pending; the wait was cancelled and the original worker and observer exited');
    report.checks.push('The provider was explicitly released only after original worker and observer exit evidence; no input was issued'); report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, response: error.response, outcome: error.outcome, method: error.method, elapsedMs: error.elapsedMs, last: error.last };
    if (waiting?.value) report.waitEvidence = waiting.value;
  } finally {
    const clean = async (name, action) => { try { report.cleanup[name] = await action(); } catch (error) { report.cleanup[name + 'Error'] = { message: error.message, code: error.code, response: error.response }; report.ok = false; } };
    if (app) await clean('session', async () => {
      const current = (await status()).response.result;
      if (current.session?.name === session) report.cleanup.release = await desktop(['release', '--session', session]);
      const result = (await status()).response.result; assert.equal(result.session, null); return result;
    });
    if (waiting) await clean('wait', async () => { try { return await waiting.result; } catch (error) { throw error; } });
    // These are read-only exit checks. Never kill an App-owned helper ourselves.
    for (const [name, value] of [['ownerExit', owner], ['observerExit', observer]]) if (value) await clean(name, () => {
      const result = waitOriginal(value); assert.equal(result.ok, true); assert.equal(result.originalExited, true); return result;
    });
    if (fixtureLifecycle.attempted) await clean('fixture', async () => {
      const result = await fixtureLifecycle.cleanup(); if (!result.ok) report.ok = false;
      if (result.identity) report.fixtureIdentity = result.identity;
      if (result.receipt?.getterPending !== false) report.ok = false; return result;
    });
    clearInterval(heartbeat); if (report.heartbeatError) report.ok = false;
    if (app) await clean('appAfter', async () => {
      const current = await preflight(); report.cleanup.nativeSample = await sample();
      const remaining = report.cleanup.nativeSample.children;
      if (catalog) { assert.equal(remaining.length, 1); assert.equal(childKey(remaining[0]), childKey(catalog)); assert.equal(remaining[0].sha256, catalog.sha256); }
      else assert.equal(remaining.filter(child => child.kind === 'input-observer').length, 0);
      return current;
    });
    report.finishedAt = new Date().toISOString(); await persist();
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDesktopProviderBlock(providerBlockOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: result.ok, mode: result.mode, case: result.case, output: result.output, checks: result.checks, error: result.error }));
  if (!result.ok) process.exitCode = 1;
}
