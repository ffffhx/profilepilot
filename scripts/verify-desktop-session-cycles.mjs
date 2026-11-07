import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { sessionCycleFixtureLifecycle } from './e2e/desktop-session-cycle-lifecycle.mjs';

const args = process.argv.slice(2);
assert.equal(process.platform, 'win32');
let run = false, cycles = 20, cyclesSpecified = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run' && !run) run = true;
  else if (args[i] === '--cycles' && !cyclesSpecified) { cyclesSpecified = true; assert.match(args[++i] || '', /^\d+$/); cycles = Number(args[i]); }
  else assert.fail('Use --run [--cycles 1..500], or no arguments for compile-only.');
}
assert.ok(cycles >= 1 && cycles <= 500);
const fixtureLifetimeMinutes = cycles > 50 ? 120 : 30;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-cycles-'));
const output = path.join(root, '.tools/desktop-verification', path.basename(home));
await mkdir(output, { recursive: true });
const executable = path.join(home, 'DesktopSessionCycleFixture.exe'), base = path.join(home, 'fixture');
const identityExecutable = path.join(home, 'CycleIdentity.exe');
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/r:System.Management.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-session-cycle-fixture.cs')],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/platform:x64', `/out:${identityExecutable}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
    path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
if (!run) { console.log(JSON.stringify({ ok: true, mode: 'compile-only', output, guiStarted: false })); process.exit(0); }
await assertDesktopAcceptanceWindow();
const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
const nonce = randomBytes(16).toString('hex');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const hashes = { cli: await digest(path.join(root, 'dist/main/profilepilot-cli.cjs')),
  desktop: await digest(path.join(root, 'dist/native/ProfilePilot.Desktop.exe')),
  observer: await digest(path.join(root, 'dist/native/ProfilePilot.InputObserver.exe')),
  sampler: await digest(path.join(root, 'dist/native/ProfilePilot.WindowsSampler.exe')),
  harness: await digest(fileURLToPath(import.meta.url)), fixture: await digest(executable),
  fixtureLifecycle: await digest(path.join(root, 'scripts/e2e/desktop-session-cycle-lifecycle.mjs')) };
const report = { ok: false, startedAt: new Date().toISOString(), cyclesRequested: cycles, fixtureLifetimeMinutes, cycles: [], cleanup: {}, samplingUnstableCount: 0, samplingUnstable: [],
  hashes,
  scope: 'Actual ordinary App, sequential claim/read/complete on one non-activating owned WinForms window; no input actions.',
  limitations: ['OS metrics are sampled and include unrelated App background work; they are not exact JS retained-heap accounting.',
    'Only direct desktop, input-observer and windows-sampler runtime children are counted; one catalog worker is intentionally retained by the App.',
    'No physical input, autonomous foreground activation, mixed DPI, macOS, or long-duration leak proof.'] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, fixtureIdentity, heartbeat, session, appIdentity, catalog;
const versions = new Set(), epochs = new Set(), generations = new Set(), ownerIdentities = new Set();
async function cli(parameters, expectedExitCode = 0) {
  const start = performance.now();
  try {
    const result = await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...parameters, '--json'],
      env, cwd: root, expectedExitCode, timeoutMs: 70000 });
    return { response: result.response, elapsedMs: performance.now() - start };
  } catch (error) {
    // Preserve failed latency too. Do not serialize full arguments or retry a
    // failed control request just to obtain a successful timing sample.
    error.elapsedMs = performance.now() - start;
    error.method = parameters[0] === 'desktop' ? parameters[1] : parameters[0];
    throw error;
  }
}
async function desktop(parameters, expected) { return cli(['desktop', ...parameters], expected); }
async function poll(read, accept, label, timeout = 10000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (Date.now() >= deadline) break;
      if (accept(value)) return value;
    }
    catch (error) { if (!['ENOENT', 'SAMPLE_UNSTABLE'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw Object.assign(new Error(label + ' timed out'), { last: value });
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inspect = parameters => JSON.parse(execFileSync(identityExecutable, parameters, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
const fixtureLifecycle = sessionCycleFixtureLifecycle({ nonce, executable, sha256: hashes.fixture, lifetimeMinutes: fixtureLifetimeMinutes }, {
  launch: () => launchWindowsUserProcess(executable, [base, nonce, String(fixtureLifetimeMinutes)], root),
  ready: () => poll(() => json(base + '.ready.json'), () => true, 'owned fixture ready'),
  inspect: pid => inspect(['--inspect', String(pid)]),
  requestClose: () => writeFile(base + '.close', nonce),
  closed: () => poll(() => json(base + '.closed.json'), () => true, 'owned fixture close'),
  wait: (value, ms) => inspect(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, String(ms)]),
  force: value => inspect(['--cleanup-owned', String(value.pid), value.startedUtcTicks, value.executable, value.sha256, String(value.parentPid)])
});
const key = child => child.metrics.pid + ':' + child.metrics.startedUtcTicks;
function sample() {
  let raw;
  try { raw = execFileSync(executable, ['--sample', String(report.app.pid),
      path.join(root, 'node_modules/electron/dist/electron.exe'), ...(appIdentity ? [appIdentity.startedUtcTicks] : [])],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }); }
  catch (error) {
    let detail; try { detail = JSON.parse(error.stdout); } catch {}
    if (detail?.code === 'SAMPLE_UNSTABLE') {
      report.samplingUnstableCount++;
      if (report.samplingUnstable.length < 32) report.samplingUnstable.push({ at: new Date().toISOString(), detail });
      throw Object.assign(new Error(detail.message), { code: detail.code, sampleFailure: detail });
    }
    throw Object.assign(new Error('Native process sample execution failed', { cause: error }),
      { code: 'SAMPLE_EXECUTION_ERROR', ...(detail ? { sampleFailure: detail } : {}) });
  }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) {
    throw Object.assign(new Error('Native process sample returned invalid JSON', { cause: error }), { code: 'SAMPLE_PROTOCOL_ERROR' });
  }
  assert.equal(value.ok, true);
  const expectedHashes = { desktop: hashes.desktop, 'input-observer': hashes.observer, 'windows-sampler': hashes.sampler };
  for (const child of value.children) {
    assert.ok(Object.hasOwn(expectedHashes, child.kind), 'Unknown native child kind');
    assert.equal(child.sha256, expectedHashes[child.kind], 'Native child differs from the pinned build');
  }
  return value;
}
async function persist() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
function assertActive(state) {
  assert.equal(state.session?.name, session); assert.equal(state.session.state, 'active');
  assert.equal(state.session.window.pid, fixture.pid); assert.equal(state.inputObservation.phase, 'ready');
  assert.notEqual(state.inputObservation.unobservedTestDriver, true);
}
try {
  const runtime = (await cli(['status'])).response; assert.equal(runtime.ok, true);
  assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
  report.app = { pid: runtime.data.pid, startedAt: runtime.data.build.startedAt, buildId: runtime.data.build.buildId };
  const manifest = await json(path.join(root, 'dist/main/control-build.json'));
  assert.equal(manifest.buildId, report.app.buildId);
  assert.equal(manifest.cliSha256, hashes.cli);
  assert.equal(manifest.components['dist/native/ProfilePilot.Desktop.exe'], hashes.desktop);
  assert.equal(manifest.components['dist/native/ProfilePilot.InputObserver.exe'], hashes.observer);
  assert.equal(manifest.components['dist/native/ProfilePilot.WindowsSampler.exe'], hashes.sampler);
  report.appIdentity = JSON.parse(execFileSync(identityExecutable, ['--inspect', String(report.app.pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  assert.equal(report.appIdentity.ok, true);
  assert.equal(report.appIdentity.integrityRid, 8192); assert.equal(report.appIdentity.elevated, false); assert.equal(report.appIdentity.uiAccess, false);
  assert.equal(path.resolve(report.appIdentity.executable).toLowerCase(), path.join(root, 'node_modules/electron/dist/electron.exe').toLowerCase());
  assert.equal(report.appIdentity.sha256, await digest(path.join(root, 'node_modules/electron/dist/electron.exe')));
  assert.equal((await desktop(['status'])).response.result.session, null);
  appIdentity = (await poll(sample, () => true, 'stable initial process sample')).app; report.initialApp = appIdentity;
  assert.equal(appIdentity.startedUtcTicks, report.appIdentity.startedUtcTicks);
  await writeFile(base + '.heartbeat', nonce);
  heartbeat = setInterval(() => { void writeFile(base + '.heartbeat', nonce).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
  fixture = await fixtureLifecycle.launch();
  const confirmedFixture = await fixtureLifecycle.confirm();
  fixtureIdentity = report.fixtureIdentity = confirmedFixture.identity;
  const ready = report.fixture = confirmedFixture.ready;
  const target = (await desktop(['windows'])).response.result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === ready.hwnd);
  assert.ok(target);
  const baseline = report.baseline = await poll(sample, () => true, 'stable baseline process sample');
  assert.equal(baseline.children.filter(value => value.kind === 'input-observer').length, 0, 'No other browser observer subscription may be present');
  assert.equal(baseline.children.filter(value => value.kind === 'windows-sampler').length, 0, 'No completed admission sampler may remain');
  assert.equal(baseline.children.length, 1, 'Exactly one warmed catalog helper expected'); catalog = key(baseline.children[0]);
  for (let index = 0; index < cycles; index++) {
    await assertDesktopAcceptanceWindow();
    assert.equal((await desktop(['status'])).response.result.session, null);
    session = 'cycles-' + randomUUID();
    const record = { index, session, startedAt: new Date().toISOString() }; report.cycles.push(record);
    const claim = await desktop(['claim', '--session', session, '--window', target.id]); assertActive(claim.response.result);
    record.claimMs = claim.elapsedMs;
    const input = claim.response.result.inputObservation;
    assert.ok(!epochs.has(input.epoch) && !generations.has(input.generation)); epochs.add(input.epoch); generations.add(input.generation);
    record.epoch = input.epoch; record.generation = input.generation;
    const observation = await desktop(['observe', '--session', session]); record.observeMs = observation.elapsedMs;
    assert.ok(observation.response.result.elements.some(value => value.name === 'Cycle fixture ' + nonce));
    assert.ok(!versions.has(observation.response.result.version)); versions.add(observation.response.result.version);
    record.version = observation.response.result.version; record.elementCount = observation.response.result.elements.length;
    const capture = await desktop(['screenshot', '--session', session, '--image-only', '--output', path.join(output, 'cycle-' + index + '.jpg')]);
    record.imageMs = capture.elapsedMs; record.image = capture.response.result.image;
    assert.ok(record.image.width > 0 && record.image.height > 0); assert.equal(capture.response.result.elements.length, 0);
    assert.ok(!versions.has(capture.response.result.version)); versions.add(capture.response.result.version);
    assertActive((await desktop(['status'])).response.result);
    const active = record.active = await poll(sample, () => true, 'stable active process sample');
    const owners = active.children.filter(value => value.kind === 'desktop' && key(value) !== catalog);
    assert.equal(active.children.filter(value => value.kind === 'input-observer').length, 1);
    assert.equal(active.children.filter(value => value.kind === 'windows-sampler').length, 0, 'Successful reads must retire their sampler before returning');
    assert.equal(owners.length, 1); assert.equal(active.children.length, 3);
    assert.ok(!ownerIdentities.has(key(owners[0]))); ownerIdentities.add(key(owners[0]));
    const completed = await desktop(['complete', '--session', session, '--require-active']); assert.equal(completed.response.result.session, null);
    record.completeMs = completed.elapsedMs;
    const ended = await desktop(['observe', '--session', session], 75); assert.equal(ended.response.code, 'DESKTOP_SESSION_ENDED');
    record.retired = await poll(sample, value => value.children.length === 1 && key(value.children[0]) === catalog, 'native owner and observer retirement');
    assert.equal((await desktop(['status'])).response.result.session, null);
    record.ok = true; record.finishedAt = new Date().toISOString(); session = undefined; await persist();
    console.log(JSON.stringify({ cycle: index + 1, of: cycles, observeMs: record.observeMs, imageMs: record.imageMs,
      appHandles: record.retired.app.handles, nativeChildren: record.retired.children.length }));
  }
  report.finalSample = await poll(sample, () => true, 'stable final process sample');
  const finalRuntime = (await cli(['status'])).response;
  assert.equal(finalRuntime.data.pid, report.app.pid);
  assert.equal(finalRuntime.data.build.buildId, report.app.buildId);
  assert.equal(finalRuntime.data.build.startedAt, report.app.startedAt);
  assert.equal(await digest(path.join(root, 'dist/main/profilepilot-cli.cjs')), hashes.cli, 'CLI changed during verification');
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, code: error.code, response: error.response, last: error.last,
    sampleFailure: error.sampleFailure, method: error.method, elapsedMs: error.elapsedMs };
  try { report.failureStatus = (await desktop(['status'])).response; } catch (statusError) { report.failureStatusError = statusError.message; }
  process.exitCode = 1;
}
finally {
  try {
    const state = (await desktop(['status'])).response.result;
    if (session && state.session?.name === session) await desktop(['release', '--session', session]);
    report.cleanup.session = (await desktop(['status'])).response.result.session;
    assert.equal(report.cleanup.session, null);
    if (catalog) report.cleanup.native = await poll(sample, value => value.children.length === 1 && key(value.children[0]) === catalog, 'final native retirement');
  } catch (error) { report.cleanup.sessionError = error.message; report.ok = false; process.exitCode = 1; }
  if (fixtureLifecycle.attempted) {
    try {
      const result = report.cleanup.fixtureLifecycle = await fixtureLifecycle.cleanup();
      report.cleanup.fixtureReceipt = result.receipt; report.cleanup.fixtureExit = result.exit;
      report.cleanup.fixtureStopped = result.exit?.originalExited === true;
      if (result.identity) report.fixtureIdentity = result.identity;
      if (result.exit?.forcedAttempts.length) report.cleanup.forcedFixtureExit = result.exit.forcedAttempts;
      if (!result.ok) { report.ok = false; process.exitCode = 1; }
    } catch (error) { report.cleanup.fixtureError = error.message; report.ok = false; process.exitCode = 1; }
  }
  clearInterval(heartbeat); if (report.cleanup.heartbeatError) { report.ok = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), cycles: report.cycles.filter(value => value.ok).length }));
}
