import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';

export const LEASE_MS = 300_000;
export function parseOptions(args) {
  assert.ok(args.length === 0 || args.length === 1 && ['--check', '--run'].includes(args[0]), 'Use [--check | --run]; no TTL or clock overrides.');
  return { run: args[0] === '--run' };
}
export function assertIdleCommand(parameters, round) {
  const allowed = [['status'], ['doctor', '--window', round.windowId],
    ['receipt', '--session', round.session, '--request-id', round.requestId]];
  assert.ok(allowed.some(value => JSON.stringify(value) === JSON.stringify(parameters)), 'Lease measurement permits only exact status/doctor/historical receipt reads');
}
export function createLeaseAnchor(status, expected, timing) {
  const { session, pid, mode } = expected;
  assert.equal(status.session?.name, session); assert.equal(status.session.window.pid, pid);
  assert.equal(status.session.state, mode);
  assert.equal(status.inputObservation.phase, mode === 'active' ? 'ready' : 'paused');
  assert.notEqual(status.inputObservation.unobservedTestDriver, true);
  if (mode === 'paused') {
    assert.equal(status.inputObservation.reason, 'user_takeover'); assert.equal(status.inputObservation.certainty, 'observed');
  }
  const expiresAt = status.session.expiresAt;
  assert.ok(Number.isSafeInteger(expiresAt));
  assert.ok(expiresAt >= timing.commandStart + LEASE_MS && expiresAt <= timing.commandEnd + LEASE_MS,
    'The actual App must grant its unchanged five-minute production lease during the final setup command');
  assert.ok(expiresAt - timing.wallNow > 270_000 && expiresAt - timing.wallNow <= LEASE_MS, 'Setup left too little of the real lease to measure');
  return { ...expected, expiresAt, wallNow: timing.wallNow, monoNow: timing.monoNow,
    input: structuredClone(status.inputObservation) };
}
export function assertLeaseSample(status, anchor, wallNow, monoNow) {
  assert.ok(Math.abs((wallNow - anchor.wallNow) - (monoNow - anchor.monoNow)) <= 2000, 'Wall clock moved relative to the monotonic clock; lease evidence is inconclusive');
  if (status.session === null) {
    assert.ok(wallNow >= anchor.expiresAt, 'Owner ended before the recorded deadline');
    assert.equal(status.inputObservation.phase, 'idle'); return 'expired';
  }
  assert.equal(status.session.name, anchor.session, 'Owner changed; stop without restoring control');
  assert.equal(status.session.window.pid, anchor.pid); assert.equal(status.session.state, anchor.mode, 'Unexpected pause/resume; stop without restoring control');
  assert.equal(status.session.expiresAt, anchor.expiresAt, 'A read changed the lease');
  assert.deepEqual(status.inputObservation, anchor.input, 'Input observer state changed during idle measurement');
  assert.ok(wallNow < anchor.expiresAt + 2000, 'Owner survived beyond the deadline allowance'); return 'waiting';
}
export function assertHistoricalReceipt(receipt, round, original) {
  assert.equal(receipt.session, round.session); assert.equal(receipt.requestId, round.requestId);
  assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.historical, true); assert.equal(receipt.requiresObservation, true);
  assert.equal(receipt.result?.executed, true);
  if (original) assert.deepEqual(receipt, original, 'Historical receipt changed or was re-executed');
}
export function assertExpiredResponse(response) {
  assert.equal(response.ok, false); assert.equal(response.code, 'DESKTOP_SESSION_ENDED');
}
export function expiredProbeCommands(round, originalFile, rejectedFile, freshRequestId) {
  assert.notEqual(freshRequestId, round.requestId);
  return [
    ['action', '--session', round.session, '--params-file', rejectedFile, '--request-id', freshRequestId, '--observe'],
    ['action', '--session', round.session, '--params-file', originalFile, '--request-id', round.requestId, '--observe'],
    ['resume', '--session', round.session]
  ];
}
export function assertFixtureUnchanged(state, baseline) {
  for (const name of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'value', 'changes']) assert.equal(state[name], baseline[name], 'Owned fixture changed: ' + name);
  assert.ok(state.sequence > baseline.sequence, 'A fresh fixture snapshot is required');
}
export async function confirmFixtureExit(wait, force) {
  let waited, waitError;
  try { waited = await wait(); } catch (error) { waitError = error.message; }
  if (waited?.ok === true && waited.originalExited === true && waited.forced !== true) return { ok: true, waited, forced: false };
  // The fallback only receives the previously captured full fixture identity.
  // Even if it races with natural exit, using it fails this acceptance run.
  let fallback, fallbackError;
  try { fallback = await force(); } catch (error) { fallbackError = error.message; }
  return { ok: false, waited, waitError, fallback, fallbackError, forced: true };
}
export function cleanupSessionDecision(status, ownedSession) {
  if (status.session === null) return 'none';
  return ownedSession && status.session?.name === ownedSession ? 'release-owned' : 'leave-other-owner';
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const childKey = child => child.metrics.pid + ':' + child.metrics.startedUtcTicks;
async function poll(read, accept, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs; let value;
  while (performance.now() < deadline) {
    try { value = await read(); if (accept(value)) return value; }
    catch (error) { if (!['ENOENT', 'SAMPLE_UNSTABLE'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw Object.assign(new Error(label + ' timed out'), { last: value });
}

export async function main(args = process.argv.slice(2)) {
  const { run } = parseOptions(args); assert.equal(process.platform, 'win32');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-lease-')), nonce = randomBytes(16).toString('hex');
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const reportFile = path.join(output, 'report.json'), base = path.join(home, 'fixture');
  const executable = path.join(home, 'DesktopLeaseFixture.exe'), identityExe = path.join(home, 'LeaseIdentity.exe');
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe'), cliEntry = path.join(root, 'dist/main/profilepilot-cli.cjs');
  const report = { ok: false, mode: run ? 'real-five-minute-lease' : 'compile-only', startedAt: new Date().toISOString(),
    fixtureStarted: false, productionLeaseMs: LEASE_MS, rounds: [], commands: [], cleanup: {}, samplingUnstable: [],
    scope: 'Two actual five-minute App leases, active and explicit handoff-paused, with UIA set_value only on an owned Medium fixture before each idle period.',
    limitations: ['No fake clock, shortened product TTL, physical input, hook installation by the fixture, foreground activation, or automatic recovery.',
      'Normal App observer hooks are created only by the two explicit product claims.',
      'Expiry can be triggered by the product timer or its ordinary status/toolbar polling; this does not isolate the timer mechanism.',
      'Sampled child identities establish observed retirement, not an atomic process census; one catalog helper is intentionally retained.',
      'After the explicit handoff the observer is retired; unrelated physical activity cannot be inferred from an unchanged paused status.',
      'Only the current Windows environment is tested, with no macOS or mixed-DPI claim.'] };
  const persist = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  let fixture, fixtureIdentity, appIdentity, heartbeat, session, catalog, phase = 'setup', round, cleanupEnabled = false, fixtureIdentityVerified = false;
  const identity = parameters => JSON.parse(execFileSync(identityExe, parameters, { encoding: 'utf8', windowsHide: true, timeout: 12000 }));
  async function cli(parameters, expectedExitCode = 0) {
    if (phase === 'idle') {
      assert.equal(parameters[0], 'desktop'); assertIdleCommand(parameters.slice(1), round);
    }
    const record = { phase, parameters, startedWall: Date.now(), startedMono: performance.now() }; report.commands.push(record);
    try {
      const value = await runDesktopCliProcess({ entry: cliEntry, args: [...parameters, '--json'], cwd: root, env, expectedExitCode, timeoutMs: 70000 });
      record.response = value.response; record.exitCode = value.exitCode; return record;
    } catch (error) {
      record.error = { message: error.message, code: error.code, response: error.response, outcome: error.outcome }; throw error;
    } finally { record.finishedWall = Date.now(); record.finishedMono = performance.now(); }
  }
  const desktop = (parameters, expected) => cli(['desktop', ...parameters], expected);
  async function fixtureState() {
    try { const failure = await json(base + '.failure.json'); throw Object.assign(new Error('Owned fixture failed'), { fixtureFailure: failure }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = await json(base + '.state.json');
    assert.equal(value.nonce, nonce); assert.equal(value.pid, fixture.pid); assert.equal(value.startedUtcTicks, fixtureIdentity.startedUtcTicks);
    assert.ok(Math.abs(Date.now() - Date.parse(value.capturedAt)) < 5000, 'Fixture snapshot is stale'); return value;
  }
  function sample() {
    let raw;
    try { raw = execFileSync(executable, ['--sample', String(report.app.pid), electron, appIdentity.startedUtcTicks],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }); }
    catch (error) {
      let detail; try { detail = JSON.parse(error.stdout); } catch {}
      if (detail?.code === 'SAMPLE_UNSTABLE') {
        if (report.samplingUnstable.length < 32) report.samplingUnstable.push({ at: new Date().toISOString(), detail });
        throw Object.assign(new Error(detail.message), { code: detail.code });
      }
      if (detail) error.sampleFailure = detail; throw error;
    }
    const value = JSON.parse(raw); assert.equal(value.ok, true);
    for (const child of value.children) assert.equal(child.sha256, report.hashes[child.kind === 'desktop' ? 'desktop' : 'observer'], 'Actual native bytes differ from the running build manifest');
    return value;
  }
  async function onlyCatalog() {
    return poll(sample, value => value.children.length === 1 && childKey(value.children[0]) === catalog, 'Native owner and observer retirement');
  }
  function waitRetired(children) {
    return children.map(child => {
      const result = identity(['--wait-owned-exit', String(child.metrics.pid), child.metrics.startedUtcTicks, '5000']);
      assert.equal(result.ok, true); assert.equal(result.originalExited, true, 'Original native child did not retire');
      assert.notEqual(result.forced, true); return { child, result };
    });
  }
  try {
    const sources = ['scripts/verify-desktop-lease-expiry.mjs', 'scripts/e2e/desktop-lease-fixture.cs',
      'scripts/e2e/desktop-session-cycle-fixture.cs', 'scripts/e2e/desktop-observer-fault-identity.cs',
      'scripts/e2e/desktop-cli.mjs', 'scripts/e2e/windows-user-process.mjs'];
    report.sources = Object.fromEntries(await Promise.all(sources.map(async file => [file, await digest(path.join(root, file))])));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:DesktopLeaseFixture', `/out:${executable}`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
      path.join(root, 'scripts/e2e/desktop-lease-fixture.cs'), path.join(root, 'scripts/e2e/desktop-session-cycle-fixture.cs')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${identityExe}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
      path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    report.hashes = { fixture: await digest(executable), identity: await digest(identityExe) };
    if (!run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    Object.assign(report.hashes, { cli: await digest(cliEntry), electron: await digest(electron),
      desktop: await digest(path.join(root, 'dist/native/ProfilePilot.Desktop.exe')),
      observer: await digest(path.join(root, 'dist/native/ProfilePilot.InputObserver.exe')) });
    const runtime = (await cli(['status'])).response; assert.equal(runtime.ok, true);
    assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
    report.app = { pid: runtime.data.pid, buildId: runtime.data.build.buildId, startedAt: runtime.data.build.startedAt };
    const manifest = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(manifest.buildId, report.app.buildId); assert.equal(manifest.cliSha256, report.hashes.cli);
    assert.equal(manifest.components['dist/native/ProfilePilot.Desktop.exe'], report.hashes.desktop);
    assert.equal(manifest.components['dist/native/ProfilePilot.InputObserver.exe'], report.hashes.observer);
    appIdentity = report.appIdentity = identity(['--inspect', String(report.app.pid)]);
    assert.equal(appIdentity.ok, true); assert.equal(appIdentity.integrityRid, 8192); assert.equal(appIdentity.elevated, false); assert.equal(appIdentity.uiAccess, false);
    assert.equal(path.resolve(appIdentity.executable).toLowerCase(), electron.toLowerCase()); assert.equal(appIdentity.sha256, report.hashes.electron);
    assert.equal((await desktop(['status'])).response.result.session, null, 'An existing desktop owner must be left untouched');
    await desktop(['windows']);
    report.baseline = await poll(sample, () => true, 'Stable baseline');
    assert.equal(report.baseline.children.length, 1, 'Require exactly the catalog helper; no existing browser observer or owner');
    assert.equal(report.baseline.children[0].kind, 'desktop'); catalog = childKey(report.baseline.children[0]);
    await writeFile(base + '.heartbeat', nonce);
    heartbeat = setInterval(() => { const now = new Date(); void utimes(base + '.heartbeat', now, now).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
    fixture = await launchWindowsUserProcess(executable, [base, nonce], root); report.fixtureStarted = true; cleanupEnabled = true;
    fixtureIdentity = report.fixtureIdentity = identity(['--inspect', String(fixture.pid)]);
    assert.equal(fixtureIdentity.ok, true); assert.equal(fixtureIdentity.pid, fixture.pid); assert.equal(fixtureIdentity.sha256, report.hashes.fixture);
    assert.equal(path.resolve(fixtureIdentity.executable).toLowerCase(), executable.toLowerCase());
    assert.equal(fixtureIdentity.integrityRid, 8192); assert.equal(fixtureIdentity.elevated, false); assert.equal(fixtureIdentity.uiAccess, false);
    fixtureIdentityVerified = true;
    report.fixture = await poll(() => json(base + '.ready.json'), value => value.pid === fixture.pid && value.nonce === nonce, 'Owned fixture ready');
    assert.equal(report.fixture.startedUtcTicks, fixtureIdentity.startedUtcTicks); assert.equal(report.fixture.ttlMinutes, 30);
    assert.equal(report.fixture.hooksInstalled, false); assert.equal(report.fixture.inputInjected, false);
    const target = (await desktop(['windows'])).response.result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === report.fixture.hwnd); assert.ok(target);
    for (const mode of ['active', 'paused']) {
      await assertDesktopAcceptanceWindow(); phase = 'setup';
      assert.equal((await desktop(['status'])).response.result.session, null);
      const currentBaseline = await onlyCatalog();
      const currentRuntime = (await cli(['status'])).response;
      assert.equal(currentRuntime.data.pid, report.app.pid); assert.equal(currentRuntime.data.build.buildId, report.app.buildId);
      assert.equal(currentRuntime.data.build.startedAt, report.app.startedAt);
      session = 'lease-' + mode + '-' + randomUUID();
      round = { mode, session, windowId: target.id, requestId: randomUUID(), samples: [], startedAt: new Date().toISOString(), baseline: currentBaseline }; report.rounds.push(round);
      const claim = (await desktop(['claim', '--session', session, '--window', target.id])).response.result;
      assert.equal(claim.session?.name, session); assert.equal(claim.session.state, 'active'); assert.equal(claim.inputObservation.phase, 'ready');
      const observed = (await desktop(['observe', '--session', session])).response.result;
      const element = observed.elements.find(value => value.name === 'Lease value' && value.actions.includes('set_value')); assert.ok(element);
      const beforeValue = await fixtureState(), expectedValue = mode + '-' + nonce;
      const actionFile = path.join(home, mode + '-original.json');
      await writeFile(actionFile, JSON.stringify({ version: observed.version, ref: element.reference, kind: 'set_value', value: expectedValue }));
      const actionArgs = ['action', '--session', session, '--params-file', actionFile, '--request-id', round.requestId, '--observe'];
      const setupAction = await desktop(actionArgs); assert.equal(setupAction.response.result.executed, true);
      const afterObserve = setupAction.response.result.observation; assert.ok(afterObserve?.version);
      const afterElement = afterObserve.elements.find(value => value.name === 'Lease value' && value.actions.includes('set_value')); assert.ok(afterElement);
      round.fixtureBaseline = await poll(fixtureState, value => value.value === expectedValue && value.changes === beforeValue.changes + 1, 'UIA value result');
      round.activeSample = await poll(sample, () => true, 'Stable active native sample');
      const ownedChildren = round.activeSample.children.filter(child => childKey(child) !== catalog);
      assert.equal(ownedChildren.length, 2); assert.equal(ownedChildren.filter(child => child.kind === 'desktop').length, 1);
      assert.equal(ownedChildren.filter(child => child.kind === 'input-observer').length, 1);
      let finalSetup = setupAction;
      if (mode === 'paused') finalSetup = await desktop(['handoff', '--session', session]);
      const anchorStatus = (await desktop(['status'])).response.result;
      round.anchor = createLeaseAnchor(anchorStatus, { session, pid: fixture.pid, mode }, {
        commandStart: finalSetup.startedWall, commandEnd: finalSetup.finishedWall, wallNow: Date.now(), monoNow: performance.now() });
      round.receipt = (await desktop(['receipt', '--session', session, '--request-id', round.requestId])).response.result;
      assertHistoricalReceipt(round.receipt, round);
      if (mode === 'paused') { round.handoffRetirement = waitRetired(ownedChildren); round.afterHandoff = await onlyCatalog(); }
      phase = 'idle'; await persist();
      let nextDoctor = 0, nextReceipt = 0, nextSample = 0, expired = false;
      while (!expired) {
        await assertDesktopAcceptanceWindow();
        const now = Date.now();
        const parameters = now >= nextDoctor ? ['doctor', '--window', target.id]
          : now >= nextReceipt ? ['receipt', '--session', session, '--request-id', round.requestId] : ['status'];
        const read = await desktop(parameters); let state;
        if (parameters[0] === 'doctor') { state = read.response.result.status; nextDoctor = Date.now() + 60_000; }
        else if (parameters[0] === 'receipt') { assertHistoricalReceipt(read.response.result, round, round.receipt); nextReceipt = Date.now() + 30_000; }
        else state = read.response.result;
        if (!state) state = (await desktop(['status'])).response.result;
        const wallNow = Date.now(), monoNow = performance.now();
        expired = assertLeaseSample(state, round.anchor, wallNow, monoNow) === 'expired';
        const fixtureNow = await poll(fixtureState, value => value.sequence > round.fixtureBaseline.sequence, 'Fresh idle fixture snapshot');
        assertFixtureUnchanged(fixtureNow, round.fixtureBaseline);
        const measurement = { wallNow, monoNow, remainingMs: round.anchor.expiresAt - wallNow, method: parameters[0], status: state, fixture: fixtureNow };
        round.samples.push(measurement);
        // A process census can straddle the expiry boundary. Avoid comparing
        // a pre-expiry status with post-expiry retirement during its final 15s.
        if (expired || wallNow >= nextSample && wallNow < round.anchor.expiresAt - 15000) {
          measurement.native = expired ? await onlyCatalog() : await poll(sample, () => true, 'Stable lease process sample');
          const expectedKeys = expired || mode === 'paused' ? [catalog] : round.activeSample.children.map(childKey);
          assert.deepEqual(measurement.native.children.map(childKey).sort(), expectedKeys.sort(), 'Native children changed or revived during idle');
          nextSample = wallNow + 30_000;
        }
        await persist();
        console.log(JSON.stringify({ mode, remainingMs: Math.max(0, measurement.remainingMs), phase: state.session?.state || 'expired', expiresAt: round.anchor.expiresAt }));
        if (!expired) await delay(Math.min(10_000, Math.max(100, round.anchor.expiresAt - Date.now() + 100)));
      }
      phase = 'expired'; round.retired = waitRetired(ownedChildren); round.finalNative = await onlyCatalog();
      const freshId = randomUUID(), rejectedFile = path.join(home, mode + '-expired.json');
      await writeFile(rejectedFile, JSON.stringify({ version: afterObserve.version, ref: afterElement.reference, kind: 'set_value', value: 'MUST-NOT-CHANGE-' + nonce }));
      round.expiredProbes = [];
      for (const parameters of expiredProbeCommands(round, actionFile, rejectedFile, freshId)) {
        const result = await desktop(parameters, 75); assertExpiredResponse(result.response); round.expiredProbes.push(result);
        assert.equal((await desktop(['status'])).response.result.session, null);
      }
      round.finalReceipt = (await desktop(['receipt', '--session', session, '--request-id', round.requestId])).response.result;
      assertHistoricalReceipt(round.finalReceipt, round, round.receipt);
      const missing = await desktop(['receipt', '--session', session, '--request-id', freshId], null);
      assert.notEqual(missing.exitCode, 0); assert.equal(missing.response.code, 'DESKTOP_RECEIPT_UNAVAILABLE'); round.rejectedRequestReceipt = missing.response;
      const lastSequence = round.samples.at(-1).fixture.sequence;
      round.finalFixture = await poll(fixtureState, value => value.sequence > lastSequence, 'Fresh post-probe fixture state');
      assertFixtureUnchanged(round.finalFixture, round.fixtureBaseline);
      round.afterProbes = await onlyCatalog(); round.ok = true; round.finishedAt = new Date().toISOString(); session = undefined; await persist();
    }
    phase = 'finished';
    const finalRuntime = (await cli(['status'])).response;
    assert.equal(finalRuntime.data.pid, report.app.pid); assert.equal(finalRuntime.data.build.buildId, report.app.buildId);
    assert.equal(finalRuntime.data.build.startedAt, report.app.startedAt);
    assert.equal(await digest(cliEntry), report.hashes.cli, 'CLI changed during verification');
    report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, response: error.response, last: error.last,
      sampleFailure: error.sampleFailure, fixtureFailure: error.fixtureFailure };
  } finally {
    phase = 'cleanup';
    if (cleanupEnabled) {
      try {
        const state = (await desktop(['status'])).response.result;
        const decision = report.cleanup.sessionDecision = cleanupSessionDecision(state, session);
        if (decision === 'release-owned') await desktop(['release', '--session', session]);
        assert.notEqual(decision, 'leave-other-owner', 'A different owner is present; left untouched');
        report.cleanup.session = (await desktop(['status'])).response.result.session; assert.equal(report.cleanup.session, null);
        if (catalog) report.cleanup.native = await onlyCatalog();
      } catch (error) { report.cleanup.sessionError = error.message; report.ok = false; }
    }
    if (fixture) {
      try {
        await writeFile(base + '.close', nonce);
        const closed = report.cleanup.fixtureReceipt = await poll(() => json(base + '.closed.json'), value => value.pid === fixture.pid && value.nonce === nonce, 'Owned nonce close');
        assert.equal(closed.startedUtcTicks, fixtureIdentity.startedUtcTicks); assert.equal(closed.closeReason, 'nonce_close');
      } catch (error) { report.cleanup.fixtureReceiptError = error.message; report.ok = false; }
      try {
        assert.ok(fixtureIdentityVerified && fixtureIdentity?.ok && fixtureIdentity.pid === fixture.pid, 'No verified full fixture identity; cannot force cleanup');
        report.cleanup.fixtureExit = await confirmFixtureExit(
          () => identity(['--wait-owned-exit', String(fixture.pid), fixtureIdentity.startedUtcTicks, '5000']),
          () => identity(['--cleanup-owned', String(fixture.pid), fixtureIdentity.startedUtcTicks, fixtureIdentity.executable, fixtureIdentity.sha256, String(fixtureIdentity.parentPid)]));
        assert.equal(report.cleanup.fixtureExit.ok, true, 'Forced fallback or unconfirmed fixture exit fails acceptance');
      } catch (error) { report.cleanup.fixtureExitError = error.message; report.ok = false; }
    }
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: reportFile, roundsPassed: report.rounds.filter(value => value.ok).length, fixtureStarted: report.fixtureStarted }));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { if (!(await main()).ok) process.exitCode = 1; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
