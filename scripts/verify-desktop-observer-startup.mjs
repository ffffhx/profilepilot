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

// Explicit acceptance only. Default/--check compiles isolated test binaries and
// runs the holder's pure self-test; it never starts a fixture or named object.
export function parseOptions(args) {
  let run = false, check = false, mode = 'mutex', hasCase = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' && !run) run = true;
    else if (args[i] === '--check' && !check) check = true;
    else if (args[i] === '--case' && !hasCase) { mode = args[++i]; hasCase = true; }
    else throw new Error('Use [--check | --run] [--case mutex | event]. Each run attempts one holder only.');
  }
  assert.ok(!(run && check), 'Check and run are mutually exclusive');
  assert.ok(['mutex', 'event'].includes(mode), 'Unknown case');
  return { run, mode };
}
const normalized = value => path.resolve(value).toLowerCase();
export function assertOwnedIdentity(identity, { pid, executable, sha256, original }) {
  assert.equal(identity.ok, true); assert.equal(identity.pid, pid);
  assert.equal(normalized(identity.executable), normalized(executable)); assert.equal(identity.sha256, sha256);
  assert.match(identity.startedUtcTicks, /^[1-9][0-9]{0,18}$/);
  assert.ok(Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0);
  assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
  if (original) for (const field of ['pid', 'parentPid', 'startedUtcTicks', 'sha256', 'integrityRid', 'elevated', 'uiAccess']) assert.equal(identity[field], original[field], 'Changed identity: ' + field);
}
export function assertExpectedStartup(response, mode) {
  assert.equal(response.ok, false);
  assert.equal(response.code, mode === 'mutex' ? 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY' : 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE');
  assert.deepEqual(response.details, { inputObserver: { stage: 'instance-gate', win32Error: mode === 'mutex' ? 183 : 6 } });
}
export function assertNoObserverInventory(value) {
  assert.equal(value.ok, true); assert.ok(Number.isSafeInteger(value.sessionId) && value.sessionId >= 0);
  assert.deepEqual(value.gaps, [], 'Unknown legacy PowerShell process prevents acceptance');
  assert.deepEqual(value.candidates, [], 'An existing observer/legacy guard prevents acceptance');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function poll(read, accept, label, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds; let value;
  while (Date.now() < deadline) {
    try { value = await read(); if (accept(value)) return value; }
    catch (error) { if (!['ENOENT', 'SAMPLE_UNSTABLE'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw Object.assign(new Error(label + ' timed out'), { last: value });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args); assert.equal(process.platform, 'win32', 'Windows x64 acceptance only');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-observer-startup-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const reportFile = path.join(output, 'report.json');
  const nonce = randomBytes(16).toString('hex'), holderBase = path.join(home, 'holder-' + nonce), fixtureBase = path.join(home, 'fixture');
  const executable = path.join(home, 'StartupHolder.exe'), identityExe = path.join(home, 'StartupIdentity.exe'), fixtureExe = path.join(home, 'StartupCycleFixture.exe');
  const report = { ok: false, mode: options.run ? 'actual-app' : 'check', case: options.mode, startedAt: new Date().toISOString(), output,
    commands: [], cleanup: {}, namedObjectCreated: false, fixtureStarted: false, inputActionCommandsSent: 0,
    limitations: ['One explicit object competition; no automatic retry or takeover of another instance.',
      'Process inventory covers known ProfilePilot helpers in this Windows session, not arbitrary third-party hooks.',
      'Inventory, management state and named-object acquisition are separate samples. A competing instance may start after preflight and fail against the owned holder.',
      'The CLI checks the selected App owner. Another management root with a paused owner and no live helper is not discoverable through this endpoint; the operator must exclude that condition before --run.',
      'Win32 error 5 remains pure-test coverage; this harness does not claim cross-integrity validation.',
      'Transport stdout/exit ordering is handled by the real App broker; this harness checks its outcome and does not independently instrument that ordering.',
      'No input actions or input injection are issued by this harness; it cannot prove absence of unrelated user input.',
      'The recovery case deliberately asks the real Medium App to install its ordinary observer after the owned holder exits.'] };
  const persist = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const cliEntry = path.join(root, 'dist/main/profilepilot-cli.cjs');
  let appIdentity, fixture, fixtureIdentity, holder, holderIdentity, session, heartbeat, catalog;
  const identities = new Map();
  const nativeKey = value => value.metrics.pid + ':' + value.metrics.startedUtcTicks;
  const execute = (file, parameters) => JSON.parse(execFileSync(file, parameters, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  async function cli(parameters, expectedExitCode = 0) {
    assert.ok(!parameters.includes('action'), 'This acceptance never submits an input action');
    const record = { parameters, startedAt: new Date().toISOString() }; report.commands.push(record);
    const result = await runDesktopCliProcess({ entry: cliEntry, args: [...parameters, '--json'], cwd: root, env, expectedExitCode, timeoutMs: 70000 });
    record.response = result.response; record.exitCode = result.exitCode; record.finishedAt = new Date().toISOString(); return result.response;
  }
  const desktop = (parameters, expected) => cli(['desktop', ...parameters], expected);
  const inspect = pid => execute(identityExe, ['--inspect', String(pid)]);
  const inventory = () => execute(executable, ['--inventory']);
  function sample() {
    try {
      const value = execute(fixtureExe, ['--sample', String(report.app.pid), path.join(root, 'node_modules/electron/dist/electron.exe'), appIdentity.startedUtcTicks]);
      assert.equal(value.ok, true);
      for (const child of value.children) assert.equal(child.sha256, report.artifacts[child.kind === 'desktop'
        ? 'dist/native/ProfilePilot.Desktop.exe' : 'dist/native/ProfilePilot.InputObserver.exe'], 'Native child differs from the pinned build');
      return value;
    }
    catch (error) {
      let value; try { value = JSON.parse(error.stdout); } catch {}
      if (value?.code === 'SAMPLE_UNSTABLE') throw Object.assign(new Error(value.message), { code: value.code });
      throw error;
    }
  }
  function verifyIdentity(value, pid, file, original) { assertOwnedIdentity(value, { pid, executable: file, sha256: identities.get(file), original }); }
  function assertFixtureReceipt(value) {
    assert.equal(value.nonce, nonce); assert.equal(value.pid, fixture.pid); assert.equal(value.startedUtcTicks, fixtureIdentity.startedUtcTicks);
  }
  function assertHolderReceipt(value) {
    assert.equal(value.nonce, nonce); assert.equal(value.mode, options.mode);
    verifyIdentity(value.identity, holder.pid, executable, holderIdentity);
    assert.equal(value.hooksInstalled, false); assert.equal(value.inputInjected, false);
  }
  async function noSession() { const state = (await desktop(['status'])).result; assert.equal(state.session, null, 'An existing desktop session must not be disturbed'); return state; }
  async function idleChildren(label) {
    return poll(sample, value => value.children.length === 1 && nativeKey(value.children[0]) === catalog, label);
  }
  async function confirmExit(pid, ticks, label) {
    return poll(() => execute(executable, ['--check-exit', String(pid), ticks]), value => value.ok === true && value.originalExited === true, label);
  }
  async function closeHolderNormally() {
    const current = inspect(holder.pid); verifyIdentity(current, holder.pid, executable, holderIdentity);
    await writeFile(holderBase + '.close', nonce);
    const closed = await poll(() => json(holderBase + '.closed.json'), value => value.nonce === nonce, 'holder close receipt');
    assertHolderReceipt(closed); assert.equal(closed.ok, true); assert.equal(closed.handleClosed, true); assert.equal(closed.reason, 'requested');
    report.holderClose = closed; report.holderExit = await confirmExit(holder.pid, holderIdentity.startedUtcTicks, 'original holder exit');
    report.cleanup.holderStopped = true;
  }
  try {
    const sourceFiles = ['scripts/e2e/desktop-observer-startup-holder.cs', 'scripts/e2e/desktop-observer-fault-identity.cs', 'scripts/e2e/desktop-session-cycle-fixture.cs'];
    report.sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(root, file)))])));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compile = (outputFile, files, entry, references = []) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/warnaserror+',
      `/out:${outputFile}`, ...(entry ? ['/main:' + entry] : []), '/r:System.Management.dll', '/r:System.Web.Extensions.dll', ...references.map(value => '/r:' + value),
      ...files.map(file => path.join(root, file))], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    compile(executable, sourceFiles.slice(0, 2), 'DesktopObserverStartupHolder');
    compile(identityExe, [sourceFiles[1]]);
    compile(fixtureExe, [sourceFiles[2]], undefined, ['System.Windows.Forms.dll', 'System.Drawing.dll']);
    for (const file of sourceFiles) assert.equal(hash(await readFile(path.join(root, file))), report.sources[file], 'Source changed during compilation');
    for (const file of [executable, identityExe, fixtureExe]) identities.set(file, hash(await readFile(file)));
    report.compiled = Object.fromEntries(identities); report.pure = execute(executable, ['--self-test']);
    assert.equal(report.pure.ok, true); assert.equal(report.pure.namedObjectCreated, false);
    if (!options.run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();

    // No fixture or object is launched before the default real App is pinned,
    // its session is empty, and known observer/legacy processes are absent.
    const runtime = await cli(['status']); assert.equal(runtime.ok, true);
    assert.equal(normalized(runtime.data.build.entry), normalized(path.join(root, 'dist/main/entry.js')));
    report.app = { pid: runtime.data.pid, startedAt: runtime.data.build.startedAt, build: runtime.data.build };
    report.initialStatus = await noSession();
    const manifest = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(runtime.data.build.buildId, manifest.buildId);
    const artifacts = ['dist/main/profilepilot-cli.cjs', 'dist/main/entry.js', 'dist/native/ProfilePilot.InputObserver.exe', 'dist/native/ProfilePilot.Desktop.exe'];
    report.artifacts = Object.fromEntries(await Promise.all(artifacts.map(async file => [file, hash(await readFile(path.join(root, file)))])));
    for (const file of artifacts) assert.equal(report.artifacts[file], manifest.components[file], 'Build artifact mismatch: ' + file);
    assert.equal(manifest.cliSha256, report.artifacts['dist/main/profilepilot-cli.cjs']);
    report.observerBuild = await json(path.join(root, 'dist/native/ProfilePilot.InputObserver.exe.build.json'));
    assert.equal(report.observerBuild.sourceSha256, hash(await readFile(path.join(root, 'native/input-observer-win.cs'))));
    assert.equal(report.observerBuild.outputSha256, report.artifacts['dist/native/ProfilePilot.InputObserver.exe']);
    appIdentity = inspect(report.app.pid); report.appIdentity = appIdentity;
    assertOwnedIdentity(appIdentity, { pid: report.app.pid, executable: path.join(root, 'node_modules/electron/dist/electron.exe'),
      sha256: hash(await readFile(path.join(root, 'node_modules/electron/dist/electron.exe'))) });
    report.preflightInventory = inventory(); assertNoObserverInventory(report.preflightInventory);
    report.preflightSample = sample(); assert.equal(report.preflightSample.children.filter(child => child.kind === 'input-observer').length, 0);

    await writeFile(holderBase + '.heartbeat', nonce); await writeFile(fixtureBase + '.heartbeat', nonce);
    // Content is written once. Touching avoids a truncate/read race that could
    // make the holder mistake its own heartbeat update for a missing nonce.
    heartbeat = setInterval(() => { const now = new Date(); for (const base of [holderBase, fixtureBase]) void utimes(base + '.heartbeat', now, now).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
    holder = await launchWindowsUserProcess(executable, ['--hold', options.mode, holderBase, nonce], home);
    const ready = report.holder = await poll(() => json(holderBase + '.ready.json'), value => value.nonce === nonce, 'holder one-shot gate result');
    // Failure is terminal. Never retry, inspect an alleged owner, or replace it.
    if (!ready.ok) throw Object.assign(new Error('Fixed observer gate was unavailable; no fixture or claim was started'), { code: 'STARTUP_GATE_PREFLIGHT_REJECTED', gateResult: ready });
    holderIdentity = inspect(holder.pid); verifyIdentity(holderIdentity, holder.pid, executable);
    assertHolderReceipt(ready); assert.equal(ready.acquired, true); report.namedObjectCreated = true;
    await noSession(); report.heldInventory = inventory(); assertNoObserverInventory(report.heldInventory);

    fixture = await launchWindowsUserProcess(fixtureExe, [fixtureBase, nonce], home); report.fixtureStarted = true;
    fixtureIdentity = inspect(fixture.pid); verifyIdentity(fixtureIdentity, fixture.pid, fixtureExe); report.fixtureIdentity = fixtureIdentity;
    const fixtureReady = report.fixture = await poll(() => json(fixtureBase + '.ready.json'), value => value.nonce === nonce, 'non-activating fixture ready');
    assertFixtureReceipt(fixtureReady); assert.equal(fixtureReady.administrator, false); assert.equal(fixtureReady.inputInjected, false); assert.equal(fixtureReady.hooksInstalled, false);
    const target = (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === fixtureReady.hwnd); assert.ok(target);
    report.baseline = sample(); assert.equal(report.baseline.children.length, 1); assert.equal(report.baseline.children[0].kind, 'desktop'); catalog = nativeKey(report.baseline.children[0]);
    verifyIdentity(inspect(holder.pid), holder.pid, executable, holderIdentity);
    session = 'observer-startup-failure-' + randomUUID();
    report.failure = await desktop(['claim', '--session', session, '--window', target.id], 75); assertExpectedStartup(report.failure, options.mode);
    const assertPaused = state => {
      assert.equal(state.session?.name, session); assert.equal(state.session.state, 'paused'); assert.equal(state.session.window.pid, fixture.pid);
      assert.equal(state.inputObservation.phase, 'paused'); assert.equal(state.inputObservation.reason, options.mode === 'mutex' ? 'instance_in_use' : 'instance_gate_failed');
      assert.notEqual(state.inputObservation.unobservedTestDriver, true);
    };
    report.failedStatus = (await desktop(['status'])).result; assertPaused(report.failedStatus);
    report.failedRetired = await idleChildren('failed native driver/observer retirement');
    // Observe is read-only but must not silently resume or re-arm a paused owner.
    report.blockedRead = await desktop(['observe', '--session', session], 75); assert.equal(report.blockedRead.code, 'DESKTOP_USER_IN_CONTROL');
    report.stillPaused = (await desktop(['status'])).result; assertPaused(report.stillPaused);
    report.noAutomaticRecovery = sample(); assert.equal(report.noAutomaticRecovery.children.length, 1);
    report.failedRelease = await desktop(['release', '--session', session]); assert.equal(report.failedRelease.result.session, null); session = undefined;
    await closeHolderNormally();
    await assertDesktopAcceptanceWindow(); await noSession();
    report.recoveryInventory = inventory(); assertNoObserverInventory(report.recoveryInventory);
    session = 'observer-startup-recovery-' + randomUUID();
    report.recoveryClaim = await desktop(['claim', '--session', session, '--window', target.id]);
    assert.equal(report.recoveryClaim.result.session.name, session); assert.equal(report.recoveryClaim.result.session.state, 'active');
    assert.equal(report.recoveryClaim.result.inputObservation.phase, 'ready'); assert.notEqual(report.recoveryClaim.result.inputObservation.unobservedTestDriver, true);
    report.recoveryObserve = await desktop(['observe', '--session', session]);
    assert.ok(report.recoveryObserve.result.elements.some(value => value.name === 'Cycle fixture ' + nonce));
    report.recoveryActive = sample(); assert.equal(report.recoveryActive.children.filter(child => child.kind === 'input-observer').length, 1);
    report.recoveryComplete = await desktop(['complete', '--session', session, '--require-active']); assert.equal(report.recoveryComplete.result.session, null); session = undefined;
    report.recoveryRetired = await idleChildren('recovery native retirement'); await noSession();
    // Pin both the running App and files again; a rebuild/restart invalidates
    // this report rather than attributing results to mixed versions.
    const finalRuntime = await cli(['status']);
    assert.equal(finalRuntime.data.pid, report.app.pid); assert.equal(finalRuntime.data.build.startedAt, report.app.startedAt);
    assert.equal(finalRuntime.data.build.buildId, report.app.build.buildId);
    assertOwnedIdentity(inspect(report.app.pid), { pid: report.app.pid, executable: appIdentity.executable, sha256: appIdentity.sha256, original: appIdentity });
    for (const file of artifacts) assert.equal(hash(await readFile(path.join(root, file))), report.artifacts[file]);
    report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, response: error.response, last: error.last, gateResult: error.gateResult };
  } finally {
    if (options.run) {
      if (session) try {
        const state = (await desktop(['status'])).result;
        if (state.session?.name === session) { report.cleanup.release = await desktop(['release', '--session', session]); assert.equal(report.cleanup.release.result.session, null); }
        else assert.equal(state.session, null, 'Another owner appeared; left untouched');
      } catch (error) { report.cleanup.sessionError = error.message; report.ok = false; }
      // Independent cleanup: a failed App request never skips owned fixture or
      // holder shutdown. The captured full identity gates any forced fallback.
      for (const [kind, process, identity, base, file] of [['fixture', fixture, fixtureIdentity, fixtureBase, fixtureExe], ['holder', holder, holderIdentity, holderBase, executable]]) {
        if (!process || report.cleanup[kind + 'Stopped']) continue;
        try {
          if (!identity) {
            // Failed one-shot acquisition normally exits before ready is read.
            const expected = kind === 'holder' ? report.holder?.identity : null;
            assert.ok(expected, 'No captured identity; no process may be forced'); verifyIdentity(expected, process.pid, file);
            report.cleanup[kind + 'Exit'] = await confirmExit(process.pid, expected.startedUtcTicks, 'rejected holder exit');
          } else {
            await writeFile(base + '.close', nonce);
            report.cleanup[kind + 'Exit'] = await confirmExit(process.pid, identity.startedUtcTicks, kind + ' cooperative exit');
          }
          report.cleanup[kind + 'Stopped'] = true;
        } catch (error) {
          report.cleanup[kind + 'Error'] = error.message; report.ok = false;
          if (identity) try {
            report.cleanup[kind + 'Forced'] = execute(identityExe, ['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]);
            assert.equal(report.cleanup[kind + 'Forced'].originalExited, true); report.cleanup[kind + 'Stopped'] = true;
          } catch (failure) { report.cleanup[kind + 'ForcedError'] = failure.message; }
        }
      }
      if (catalog) try { report.cleanup.native = await idleChildren('final native retirement'); }
      catch (error) { report.cleanup.nativeError = error.message; report.ok = false; }
    }
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, case: options.mode, report: reportFile, namedObjectCreated: report.namedObjectCreated, fixtureStarted: report.fixtureStarted }));
  }
  return report;
}

if (process.argv[1] && normalized(process.argv[1]) === normalized(fileURLToPath(import.meta.url))) {
  try { if (!(await main()).ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
