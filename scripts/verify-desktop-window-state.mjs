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
import { retireNoticeChainOwned } from './verify-desktop-notice-chain.mjs';

export function windowStateOptions(args) {
  let mode, kind = 'basic', seenCase = false;
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--run'].includes(args[i]) && !mode) mode = args[i];
    else if (args[i] === '--case' && !seenCase) { seenCase = true; kind = args[++i]; }
    else throw new Error('Use [--check | --run] [--case basic | reject-restore]');
  }
  assert.ok(['basic', 'reject-restore'].includes(kind)); return { run: mode === '--run', kind };
}
export function verifyWindowStateResult(kind, result, fixture) {
  const requested = { restore: 'normal', minimize: 'minimized', maximize: 'maximized' }[kind];
  assert.ok(requested); assert.equal(result.executed, true); assert.equal(result.requiresObservation, true);
  assert.equal(result.windowState?.requested, requested); assert.equal(result.windowState.confirmed, true);
  assert.equal(result.windowState.after.uia.visualState, requested); assert.equal(result.windowState.after.placementAvailable, true);
  assert.equal(result.windowState.after.showCommand, { normal: 1, minimized: 2, maximized: 3 }[requested]);
  assert.equal(fixture.state, requested); assert.equal(fixture.minimized, requested === 'minimized'); assert.equal(fixture.maximized, requested === 'maximized');
  assert.equal(fixture.hwnd, fixture.currentHwnd); assert.equal(result.windowState.after.uia.nativeHandle, fixture.hwnd);
  assert.match(result.windowState.foregroundBefore, /^\d+$/); assert.match(result.windowState.foregroundAfter, /^\d+$/);
}
export function windowStateFixtureLifecycle(expected, io) {
  let fixtureAttempted = false, launched, pinned;
  function pin(value, ready) {
    assert.equal(value.ok, true); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid) && value.parentPid > 0);
    assert.match(value.startedUtcTicks, /^[1-9]\d{15,18}$/); assert.ok(path.win32.isAbsolute(value.executable));
    assert.equal(path.win32.resolve(value.executable).toLowerCase(), path.win32.resolve(expected.executable).toLowerCase());
    assert.match(expected.sha256, /^[a-f0-9]{64}$/); assert.equal(value.sha256, expected.sha256);
    assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false);
    if (launched) assert.equal(value.pid, launched.pid);
    if (ready) { assert.equal(value.pid, ready.pid); assert.equal(value.startedUtcTicks, ready.startedUtcTicks); }
    pinned = { ...value }; return pinned;
  }
  return {
    get attempted() { return fixtureAttempted; },
    get identity() { return pinned; },
    pin,
    async launch() {
      assert.equal(fixtureAttempted, false); fixtureAttempted = true;
      // The launcher may start the child, then throw during its handshake or
      // finally cleanup. The attempted flag must survive a missing return PID.
      launched = await io.launch(); return launched;
    },
    async cleanup() {
      const result = { attempted: fixtureAttempted, errors: [], closeRequested: false, identityRecovered: false, ok: !fixtureAttempted };
      if (!fixtureAttempted) return result;
      const failed = (stage, error) => result.errors.push({ stage, message: error.message });
      // Recover the live full identity before asking it to exit. This bounded
      // read uses only the private nonce receipt; no title/process-name search.
      try {
        if (!pinned) {
          const ready = result.ready = await io.ready();
          assert.equal(ready.nonce, expected.nonce); assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
          assert.match(ready.startedUtcTicks, /^[1-9]\d{15,18}$/); assert.match(ready.hwnd, /^[1-9]\d*$/); assert.equal(ready.currentHwnd, ready.hwnd);
          pin(await io.inspect(ready.pid), ready); result.identityRecovered = true;
        }
      } catch (error) { failed('identity', error); }
      // Always issue the nonce close, including identity/readiness failures.
      try { await io.requestClose(); result.closeRequested = true; } catch (error) { failed('request-close', error); }
      try {
        const receipt = result.receipt = await io.closed(); assert.equal(receipt.nonce, expected.nonce);
        assert.equal(receipt.originalHwndGone, true); assert.equal(receipt.reason, 'requested');
        assert.ok(pinned, 'Cannot establish exact fixture identity'); assert.equal(receipt.pid, pinned.pid); assert.equal(receipt.startedUtcTicks, pinned.startedUtcTicks);
      } catch (error) { failed('close-receipt', error); }
      if (pinned) {
        result.identity = pinned;
        try { result.exit = await retireNoticeChainOwned(pinned, io); } catch (error) { failed('exit', error); }
      }
      // No full identity means no force operation. Any force fallback remains
      // a failed acceptance even when it eventually confirms an original exit.
      result.ok = !result.errors.length && result.closeRequested && result.exit?.ok === true;
      return result;
    }
  };
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function poll(read, accept, label, timeout = 12000) {
  const deadline = Date.now() + timeout; let last;
  do {
    try { last = await read(); if (accept(last)) return last; }
    catch (error) { if (!['ENOENT', 'SAMPLE_UNSTABLE'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await sleep(40);
  } while (Date.now() < deadline);
  throw Object.assign(new Error(label + ' timed out'), { last });
}
export async function verifyDesktopWindowState(options) {
  assert.equal(process.platform, 'win32', 'Windows-only verification; no macOS native desktop support.');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-window-state-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const fixtureExe = path.join(home, 'WindowStateFixture.exe'), identityExe = path.join(home, 'OwnedIdentity.exe'), samplerExe = path.join(home, 'Sampler.exe');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const compile = (file, source, references, target = 'exe') => execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/platform:x64', '/target:' + target,
    '/out:' + file, ...references.map(name => '/r:' + name), path.join(root, source)], { windowsHide: true, timeout: 30000 });
  compile(fixtureExe, 'scripts/e2e/desktop-window-state-fixture.cs', ['System.Web.Extensions.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'], 'winexe');
  compile(identityExe, 'scripts/e2e/desktop-observer-fault-identity.cs', ['System.Web.Extensions.dll', 'System.Management.dll']);
  compile(samplerExe, 'scripts/e2e/desktop-session-cycle-fixture.cs', ['System.Web.Extensions.dll', 'System.Management.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll']);
  const report = { ok: false, mode: options.run ? options.kind : 'compile-only', output, startedAt: new Date().toISOString(), checks: [], actions: [], observations: [], preparations: [], cleanup: {},
    scope: 'Actual ProfilePilot App CLI with a pinned nonce-owned Medium WinForms window; UIA-only window-state actions.',
    physicalInputInjected: false, automaticRecovery: false, limitations: [
      'Windows only. No cross-platform, fullscreen, mixed-DPI, or hardware takeover claim.',
      'Fixture setup can change its own window capabilities or reject WM_QUERYOPEN independently; setup is not a product input success.',
      'A confirmed window visual state does not establish foreground ownership or grant coordinates for later input.',
      'WM_QUERYOPEN counts are provider/window messages, not a count of UIA calls. Single UIA dispatch is a source-level constraint.',
      'WinForms pointer WM counts may include messages caused by window movement; they do not identify physical input provenance.'
    ] };
  if (!options.run) { report.ok = true; report.guiStarted = false; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); return report; }
  // This is the first operation that can inspect the desktop or launch a GUI.
  await assertDesktopAcceptanceWindow();
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const base = path.join(home, 'fixture'), nonce = randomBytes(16).toString('hex'), session = 'window-state-' + randomUUID();
  Object.assign(report, { nonce, session }); let fixture, fixtureIdentity, appBefore, heartbeat, target;
  const id = args => JSON.parse(execFileSync(identityExe, args, { windowsHide: true, timeout: 12000, encoding: 'utf8' }));
  function identity(value, expectedExe, expectedHash) {
    assert.equal(value.ok, true); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid) && value.parentPid > 0);
    assert.match(value.startedUtcTicks, /^[1-9]\d{15,18}$/); assert.equal(path.resolve(value.executable).toLowerCase(), path.resolve(expectedExe).toLowerCase());
    assert.equal(value.sha256, expectedHash); assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false); return value;
  }
  const sameIdentity = (before, after) => { for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'executable', 'sha256']) assert.equal(after[key], before[key]); };
  async function cli(args, expectedExitCode = 0) {
    try { return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...args, '--json'], env, expectedExitCode })).response; }
    catch (error) { report.lastFailure = { args, code: error.code, exitCode: error.exitCode, outcome: error.outcome, response: error.response }; throw error; }
  }
  const desktop = (args, expected) => cli(['desktop', ...args], expected);
  async function active() { const value = (await desktop(['status'])).result; assert.equal(value.session?.name, session); assert.equal(value.session.state, 'active'); assert.equal(value.inputObservation.phase, 'ready'); return value; }
  async function observe() { await active(); const value = (await desktop(['observe', '--session', session])).result; report.observations.push(value); await active(); return value; }
  const rootElement = snapshot => { const nodes = snapshot.elements.filter(value => value.parent === -1); assert.equal(nodes.length, 1); assert.equal(nodes[0].state?.window?.status, 'readable'); assert.equal(nodes[0].state.window.nativeHandle, target.nativeHandle); return nodes[0]; };
  const state = () => poll(() => json(base + '.state.json'), value => value.pid === fixture.pid && value.nonce === nonce && value.startedUtcTicks === fixtureIdentity.startedUtcTicks, 'owned state');
  async function prepare(operation, value) {
    await active(); sameIdentity(fixtureIdentity, id(['--inspect', String(fixture.pid)])); const requestId = randomUUID();
    await writeFile(base + '.command.json', JSON.stringify({ nonce, id: requestId, expiresAt: Date.now() + 10000, operation, value }));
    const ack = await poll(() => json(base + '.ack.json'), item => item.nonce === nonce && item.pid === fixture.pid && item.id === requestId, 'owned setup');
    report.preparations.push({ operation, value, ack }); assert.equal(ack.ok, true); assert.equal(ack.state.currentHwnd, target.nativeHandle); await active(); return ack;
  }
  async function action(snapshot, kind, extra = {}, expectedExit = 0, reference = rootElement(snapshot).reference) {
    await active(); const requestId = randomUUID(), params = { version: snapshot.version, ref: reference, kind, ...extra };
    const file = path.join(home, requestId + '.json'); await writeFile(file, JSON.stringify(params));
    const record = { requestId, params }; report.actions.push(record);
    record.response = await desktop(['action', '--session', session, '--request-id', requestId, '--params-file', file], expectedExit);
    if (record.response.code !== 'DESKTOP_INVALID_ARGUMENTS') record.receipt = await desktop(['receipt', '--session', session, '--request-id', requestId]);
    return record.response;
  }
  async function transition(kind, snapshot = undefined) {
    snapshot ||= await observe(); const response = await action(snapshot, kind); assert.equal(response.ok, true);
    const requested = { restore: 'normal', minimize: 'minimized', maximize: 'maximized' }[kind];
    const fixtureState = await poll(state, value => value.state === requested, kind + ' fixture result');
    verifyWindowStateResult(kind, response.result, fixtureState); await active(); report.actions.at(-1).fixtureState = fixtureState; return response;
  }
  async function sample(app) {
    return poll(async () => {
      try { const value = JSON.parse(execFileSync(samplerExe, ['--sample', String(app.pid), app.identity.executable, app.identity.startedUtcTicks], { windowsHide: true, timeout: 12000, encoding: 'utf8' })); assert.equal(value.ok, true); return value; }
      catch (error) { let value; try { value = JSON.parse(error.stdout); } catch {} if (value?.code === 'SAMPLE_UNSTABLE') throw Object.assign(new Error(value.message), { code: value.code }); throw error; }
    }, Boolean, 'stable App sample');
  }
  async function preflight() {
    const value = await cli(['status']); assert.equal(value.ok, true); const app = value.data, build = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(app.build.buildId, build.buildId); assert.equal(path.resolve(app.build.entry), path.join(root, 'dist/main/entry.js'));
    assert.equal(build.cliSha256, await digest(path.join(root, 'dist/main/profilepilot-cli.cjs')));
    assert.equal(build.components['dist/native/ProfilePilot.Desktop.exe'], await digest(path.join(root, 'dist/native/ProfilePilot.Desktop.exe')));
    const executable = path.join(root, 'node_modules/electron/dist/electron.exe');
    const current = { pid: app.pid, build: app.build, identity: identity(id(['--inspect', String(app.pid)]), executable, await digest(executable)) };
    if (appBefore) { assert.equal(current.build.buildId, appBefore.build.buildId); assert.equal(current.build.startedAt, appBefore.build.startedAt); sameIdentity(appBefore.identity, current.identity); }
    assert.equal((await desktop(['status'])).result.session, null); return current;
  }
  const fixtureLifecycle = windowStateFixtureLifecycle({ nonce, executable: fixtureExe, sha256: await digest(fixtureExe) }, {
    launch: () => launchWindowsUserProcess(fixtureExe, [base, nonce], root),
    ready: () => poll(() => json(base + '.ready.json'), value => value.nonce === nonce, 'owned cleanup readiness', 3000),
    inspect: pid => id(['--inspect', String(pid)]),
    requestClose: () => writeFile(base + '.close', nonce),
    closed: () => poll(() => json(base + '.closed.json'), value => value.nonce === nonce, 'fixture close receipt'),
    wait: (value, ms) => id(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, String(ms)]),
    force: value => id(['--cleanup-owned', String(value.pid), value.startedUtcTicks, value.executable, value.sha256, String(value.parentPid)])
  });
  try {
    appBefore = report.appBefore = await preflight(); report.beforeSample = await sample(appBefore);
    assert.equal(report.beforeSample.children.filter(child => child.kind === 'input-observer').length, 0, 'Existing shared observer must not be disturbed');
    await writeFile(base + '.heartbeat', nonce); heartbeat = setInterval(() => { void writeFile(base + '.heartbeat', nonce).catch(error => { report.heartbeatError = error.message; }); }, 2000); heartbeat.unref();
    fixture = await fixtureLifecycle.launch();
    fixtureIdentity = report.fixtureIdentity = identity(id(['--inspect', String(fixture.pid)]), fixtureExe, await digest(fixtureExe));
    fixtureLifecycle.pin(fixtureIdentity);
    report.ready = await poll(() => json(base + '.ready.json'), value => value.pid === fixture.pid && value.nonce === nonce && value.startedUtcTicks === fixtureIdentity.startedUtcTicks, 'owned readiness');
    const windows = (await desktop(['windows'])).result.windows; target = report.target = windows.find(value => value.pid === fixture.pid && value.nativeHandle === report.ready.hwnd && value.title === 'ProfilePilot window-state ' + nonce); assert.ok(target);
    report.catalogSample = await sample(appBefore); assert.equal(report.catalogSample.children.filter(child => child.kind === 'input-observer').length, 0);
    assert.equal(report.catalogSample.children.filter(child => child.kind === 'desktop').length, 1);
    report.claim = await desktop(['claim', '--session', session, '--window', target.id]); await active();
    report.doctor = (await desktop(['doctor', '--window', target.id])).result;
    let snapshot = await observe(); report.initial = rootElement(snapshot); assert.equal(report.initial.state.window.interactionState, 2, 'Provider readiness is required; do not silently relax it');
    report.inputBaseline = await state();
    const child = snapshot.elements.find(value => value.name === 'Window state child ' + nonce); assert.ok(child);
    const rejectedChild = await action(snapshot, 'maximize', {}, null, child.reference); assert.equal(rejectedChild.code, 'DESKTOP_ACTION_UNSUPPORTED');
    const invalid = await action(snapshot, 'maximize', { keys: ['ALT'] }, 2); assert.equal(invalid.code, 'DESKTOP_INVALID_ARGUMENTS');
    await transition('maximize', snapshot); report.checks.push('Child window-state action and unrelated keys are rejected; the unchanged version still authorizes the explicit root action');
    await transition('restore'); await transition('minimize'); await transition('restore');
    await transition('maximize'); await transition('minimize'); await transition('restore');
    report.checks.push('Fresh root actions confirm normal/maximized/minimized through both UIA and Win32; restore after maximized-minimized is Normal');
    snapshot = await observe(); await prepare('canMaximize', false);
    const stale = await action(snapshot, 'maximize', {}, 75); assert.equal(stale.code, 'DESKTOP_ELEMENT_CHANGED');
    snapshot = await observe(); assert.equal(rootElement(snapshot).state.window.canMaximize, false);
    const unsupported = await action(snapshot, 'maximize', {}, null); assert.equal(unsupported.code, 'DESKTOP_ACTION_UNSUPPORTED');
    assert.equal((await state()).state, 'normal'); await prepare('canMaximize', true);
    report.checks.push('External capability change invalidates the old fingerprint; fresh unsupported maximize is rejected without a state change');
    if (options.kind === 'reject-restore') {
      await prepare('denyRestore', true); await transition('minimize'); snapshot = await observe();
      const before = await state(); report.rejectedRestore = await action(snapshot, 'restore', {}, 75);
      assert.equal(report.rejectedRestore.code, 'DESKTOP_OUTCOME_UNKNOWN');
      report.afterRejectedRestore = await state(); assert.equal(report.afterRejectedRestore.state, 'minimized'); assert.ok(report.afterRejectedRestore.queryOpen > before.queryOpen);
      const status = report.paused = (await desktop(['status'])).result; assert.equal(status.session?.name, session); assert.equal(status.session.state, 'paused'); assert.equal(status.inputObservation.reason, 'outcome_unknown');
      await sleep(500); const still = (await desktop(['status'])).result; assert.equal(still.session.state, 'paused'); assert.equal(still.inputObservation.generation, status.inputObservation.generation);
      report.afterPauseInterval = await state(); assert.equal(report.afterPauseInterval.state, 'minimized');
      report.queryOpenDeltaDuringPause = report.afterPauseInterval.queryOpen - report.afterRejectedRestore.queryOpen;
      report.checks.push('A restore attempt reaches the fixture, returns outcome unknown, and remains minimized and paused without automatic resume during the observed interval; WM_QUERYOPEN counts do not prove UIA dispatch count');
    } else {
      snapshot = await observe(); await desktop(['handoff', '--session', session]);
      const requestId = randomUUID(), file = path.join(home, 'paused-action.json'); await writeFile(file, JSON.stringify({ kind: 'minimize', ref: rootElement(snapshot).reference, version: snapshot.version }));
      report.pausedAction = await desktop(['action', '--session', session, '--params-file', file, '--request-id', requestId], 75); assert.equal(report.pausedAction.code, 'DESKTOP_USER_IN_CONTROL');
      assert.equal((await state()).state, 'normal'); assert.equal((await desktop(['status'])).result.session.state, 'paused');
      report.checks.push('Explicit handoff rejects an old window action without changing the owned window or automatically resuming');
    }
    report.finalFixture = await state(); assert.equal(report.finalFixture.value, report.inputBaseline.value); assert.equal(report.finalFixture.keyboardMessages, report.inputBaseline.keyboardMessages); report.ok = true;
  } catch (error) { report.error = { message: error.message, code: error.code, last: error.last }; }
  finally {
    const clean = async (key, run) => { try { report.cleanup[key] = await run(); } catch (error) { report.cleanup[key + 'Error'] = error.message; report.ok = false; } };
    await clean('session', async () => { const current = (await desktop(['status'])).result.session; if (current?.name === session) await desktop(['release', '--session', session]); const after = (await desktop(['status'])).result; assert.notEqual(after.session?.name, session); return after; });
    if (fixtureLifecycle.attempted) {
      await clean('fixtureLifecycle', async () => {
        const result = await fixtureLifecycle.cleanup(); report.cleanup.fixtureReceipt = result.receipt; report.cleanup.fixtureExit = result.exit;
        if (result.identity) report.fixtureIdentity = result.identity;
        if (!result.ok) report.ok = false; return result;
      });
    }
    if (heartbeat) clearInterval(heartbeat); if (report.heartbeatError) report.ok = false;
    if (appBefore) await clean('appAfter', async () => {
      const current = await preflight(); const after = await poll(() => sample(current), value => value.children.filter(child => child.kind === 'input-observer').length === 0 && value.children.filter(child => child.kind === 'desktop').length <= 1, 'owner and observer retirement');
      if (report.catalogSample) { const catalog = report.catalogSample.children.find(child => child.kind === 'desktop'); assert.deepEqual(after.children.filter(child => child.kind === 'desktop').map(child => [child.metrics.pid, child.metrics.startedUtcTicks, child.sha256]), [[catalog.metrics.pid, catalog.metrics.startedUtcTicks, catalog.sha256]]); }
      return { ...current, sample: after };
    });
    report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDesktopWindowState(windowStateOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: result.ok, mode: result.mode, output: result.output, checks: result.checks, error: result.error, cleanup: result.cleanup.fixtureExit?.ok }));
  if (!result.ok) process.exitCode = 1;
}
