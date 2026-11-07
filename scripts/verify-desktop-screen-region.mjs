import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { assertDesktopAcceptanceWindow, desktopAcceptanceWindowFile } from './e2e/desktop-acceptance-window.mjs';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { evaluateWgcMarkerEvidence } from './e2e/wgc-fixture-source.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseScreenRegionArgs(args) {
  const flags = new Set(); let waitMs = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assert.ok(['--check', '--run', '--diagnose-only', '--cover', '--ppilot-focus', '--wait-for-foreground-ms'].includes(arg) && !flags.has(arg), 'Unknown/duplicate screen-region argument');
    flags.add(arg);
    if (arg === '--wait-for-foreground-ms') { assert.match(args[++i] || '', /^\d+$/); waitMs = Number(args[i]); assert.ok(waitMs <= 30000); }
  }
  assert.ok(!(flags.has('--check') && flags.has('--run')));
  assert.ok(flags.has('--run') || !(flags.has('--diagnose-only') || flags.has('--cover') || flags.has('--ppilot-focus') || flags.has('--wait-for-foreground-ms')), 'Observation options require explicit --run');
  assert.ok(!flags.has('--diagnose-only') || !(flags.has('--cover') || flags.has('--ppilot-focus') || waitMs), 'Diagnosis does not need foreground preparation or cover');
  assert.ok(!flags.has('--ppilot-focus') || !waitMs, 'Do not mix ppilot focus evidence with a separate foreground preparation wait');
  return { run: flags.has('--run'), diagnoseOnly: flags.has('--diagnose-only'), cover: flags.has('--cover'), ppilotFocus: flags.has('--ppilot-focus'), waitMs };
}
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function poll(read, accept, label, timeout = 12000) {
  const deadline = Date.now() + timeout; let last;
  do {
    try { last = await read(); if (accept(last)) return last; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  } while (Date.now() < deadline);
  throw Object.assign(new Error(label + ' deadline'), { last });
}
async function atomic(file, value) { await writeFile(file + '.tmp', JSON.stringify(value)); await rename(file + '.tmp', file); }
// Explicit, one-shot actual App preparation. Injected I/O keeps every failure
// path testable without a real App, hook, process query or focus operation.
export async function attemptScreenRegionPpilotFocus(options, io) {
  const record = { requested: true, session: options.session, requestId: options.requestId, actualAppFocusAttempted: false,
    actionDispatchCount: 0, outcome: 'not_attempted', foregroundChanged: null, cleanup: {}, calls: [] };
  let app, appIdentity, target, claimAttempted = false, completed = false, stage = 'preflight';
  const fail = (message, response) => { throw Object.assign(new Error(message), { response, code: response?.code }); };
  async function desktop(args) {
    // Session cleanup and cached receipt/status reads remain possible if the
    // local GUI gate closes while a request is in flight.
    if (!['status', 'receipt', 'release', 'complete'].includes(args[0])) await io.gate();
    if (args[0] === 'action') { record.actualAppFocusAttempted = true; record.actionDispatchCount++; }
    const response = await io.desktop(args); record.calls.push({ operation: args[0], ok: response?.ok, code: response?.code }); return response;
  }
  function ok(response, label) { if (response?.ok !== true) fail(label, response); return response.result; }
  function sameIdentity(actual, expected) {
    for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'sha256']) assert.equal(actual[key], expected[key], 'Process identity changed: ' + key);
    assert.equal(path.win32.normalize(actual.executable).toLowerCase(), path.win32.normalize(expected.executable).toLowerCase());
    assert.equal(actual.integrityRid, 8192); assert.equal(actual.elevated, false); assert.equal(actual.uiAccess, false);
  }
  async function currentApp() {
    const response = await io.appStatus(); assert.equal(response.ok, true); const value = response.data;
    assert.equal(value.build?.buildId, options.buildId, 'Running App differs from the current local control build');
    assert.equal(path.win32.normalize(value.build.entry).toLowerCase(), path.win32.normalize(options.appEntry).toLowerCase());
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
    if (app) { assert.equal(value.pid, app.pid); assert.equal(value.build.startedAt, app.build.startedAt); sameIdentity(await io.identity(value.pid), appIdentity); }
    return value;
  }
  function active(status) {
    assert.equal(status.session?.name, options.session); assert.equal(status.session.state, 'active', 'User takeover or observer loss prevents completion');
    assert.equal(status.session.window.pid, options.fixture.pid); assert.equal(status.session.window.nativeHandle, options.fixture.hwnd);
    assert.equal(status.inputObservation.phase, 'ready'); assert.notEqual(status.inputObservation.unobservedTestDriver, true);
  }
  try {
    await io.gate(); app = await currentApp(); appIdentity = await io.identity(app.pid);
    assert.equal(appIdentity.pid, app.pid); assert.equal(appIdentity.integrityRid, 8192); assert.equal(appIdentity.elevated, false); assert.equal(appIdentity.uiAccess, false);
    assert.ok(Number.isSafeInteger(appIdentity.parentPid) && appIdentity.parentPid > 0, 'Original App parent PID is required');
    assert.match(appIdentity.startedUtcTicks || '', /^[1-9]\d{15,18}$/, 'Original App birth ticks are required');
    assert.ok(typeof options.expectedAppExecutable === 'string' && path.win32.isAbsolute(options.expectedAppExecutable));
    assert.match(options.expectedAppSha256 || '', /^[a-f0-9]{64}$/);
    assert.equal(path.win32.normalize(appIdentity.executable).toLowerCase(), path.win32.normalize(options.expectedAppExecutable).toLowerCase(), 'App executable differs from this repository Electron');
    assert.equal(appIdentity.sha256, options.expectedAppSha256, 'App executable bytes differ from this repository Electron');
    sameIdentity(await io.identity(options.fixture.pid), options.fixture.identity);
    record.app = { ...app, identity: appIdentity }; record.buildId = options.buildId;
    const initial = record.initialStatus = ok(await desktop(['status']), 'App desktop status failed');
    assert.equal(initial.session, null, 'An existing desktop session must not be displaced');
    const windows = ok(await desktop(['windows']), 'App window enumeration failed').windows;
    const matches = windows.filter(value => value.pid === options.fixture.pid && value.nativeHandle === options.fixture.hwnd && value.title === options.fixture.title);
    assert.equal(matches.length, 1, 'Exactly one original owned HWND is required'); target = record.target = matches[0];
    record.before = ok(await desktop(['doctor', '--window', target.id]), 'Pre-focus doctor failed');
    assert.equal(record.before.target.pid, options.fixture.pid); assert.equal(record.before.target.hwnd, options.fixture.hwnd);
    assert.equal(record.before.target.integrity.rid, 8192); assert.equal(record.before.target.integrity.elevated, false);
    await currentApp(); stage = 'claim'; claimAttempted = true;
    active(ok(await desktop(['claim', '--session', options.session, '--window', target.id]), 'Owned claim failed'));
    stage = 'observe';
    const observed = await desktop(['observe', '--session', options.session]);
    if (observed?.ok !== true) record.observationResponse = observed;
    // Retain the entire fresh tree before any identity/button assertion. A
    // missing accessibility subtree is evidence, not a reason to discard it.
    const observation = record.observation = ok(observed, 'Fresh owned observation failed');
    assert.equal(observation.windowId, target.id); assert.match(observation.version, /^[a-f0-9]{32}$/);
    const buttons = observation.elements.filter(value => value.role === 'Button' && value.name === 'ProfilePilot focus ' + options.nonce && value.enabled !== false && value.offscreen !== true);
    record.focusButtonMatchCount = buttons.length;
    assert.equal(buttons.length, 1, 'Exactly one enabled owned nonce focus button is required'); assert.ok(buttons[0].reference);
    record.focusButton = buttons[0];
    const params = { version: observation.version, ref: buttons[0].reference, kind: 'focus' };
    const paramsFile = await io.writeParams(params);
    await currentApp(); sameIdentity(await io.identity(options.fixture.pid), options.fixture.identity); await io.gate();
    stage = 'action';
    // One request only. An error/timeout never causes focus, claim or resume to replay.
    record.action = await desktop(['action', '--session', options.session, '--params-file', paramsFile, '--request-id', options.requestId]);
    ok(record.action, 'Owned focus action failed'); assert.equal(record.action.result.executed, true);
    stage = 'evidence';
    record.after = ok(await desktop(['doctor', '--window', target.id]), 'Post-focus doctor failed');
    record.afterStatus = ok(await desktop(['status']), 'Post-focus status failed');
    record.foregroundChanged = record.before.foreground.hwnd !== record.after.foreground.hwnd;
    record.targetIsForeground = record.after.foreground.hwnd === options.fixture.hwnd;
    active(record.afterStatus); await currentApp(); stage = 'complete';
    record.completion = await desktop(['complete', '--session', options.session, '--require-active']);
    assert.equal(ok(record.completion, 'Conditional completion failed').session, null); completed = true;
    record.outcome = record.targetIsForeground ? 'focus_executed_target_foreground' : 'focus_executed_without_target_foreground';
  } catch (error) {
    record.failure = { stage, message: error.message, code: error.code, response: error.response, outcome: error.outcome };
    record.outcome = stage === 'action' ? 'focus_failed_or_unknown' : 'preparation_failed';
    if (record.actualAppFocusAttempted && target) {
      // These are evidence reads, not recovery or a replay. A receipt may be
      // unavailable after a lost request; that never establishes non-execution.
      for (const [key, args] of [['receipt', ['receipt', '--session', options.session, '--request-id', options.requestId]], ['after', ['doctor', '--window', target.id]], ['afterStatus', ['status']]]) {
        try { const response = await desktop(args); record[key + 'Response'] = response; if (response.ok) record[key] = response.result; }
        catch (failure) { record[key + 'Error'] = failure.message; }
      }
      if (record.after?.foreground && record.before?.foreground) { record.foregroundChanged = record.after.foreground.hwnd !== record.before.foreground.hwnd; record.targetIsForeground = record.after.foreground.hwnd === options.fixture.hwnd; }
    }
  } finally {
    if (claimAttempted) {
      try {
        await currentApp();
        const status = ok(await desktop(['status']), 'Cleanup status failed'); record.cleanup.before = status;
        if (status.session?.name === options.session) record.cleanup.release = await desktop(['release', '--session', options.session]);
        if (record.cleanup.release) ok(record.cleanup.release, 'Owned session release failed');
        const after = ok(await desktop(['status']), 'Cleanup confirmation failed'); record.cleanup.after = after;
        assert.notEqual(after.session?.name, options.session, 'Owned session remains live'); record.cleanup.ownedSessionGone = true;
      } catch (error) { record.cleanup.error = error.message; }
    } else record.cleanup.ownedSessionGone = true;
  }
  record.completedRequireActive = completed;
  return record;
}
// Keep the complete post-preparation route in one injectable function. Tests
// exercise the same diagnose/cover/capture control flow used by --run.
export async function observeScreenRegionAfterPreparation(options, io) {
  let diagnosis = options.diagnosis;
  assert.ok(!options.preparation || options.ppilotFocus, 'A preparation result cannot be bypassed by switching observation route');
  if (options.ppilotFocus) {
    assert.equal(options.preparation?.cleanup?.ownedSessionGone, true, 'Temporary App session cleanup must be confirmed before independent capture');
    // Successful cleanup does not authorize a new route after takeover, lost
    // observation or an unknown action/claim. Stop before ANY independent
    // diagnose/capture or cover command, even if the HWND is now foreground.
    if (options.preparation.failure || options.preparation.cleanup.error || options.preparation.completedRequireActive !== true) {
      throw Object.assign(new Error('ppilot preparation did not complete successfully; independent observation stopped'), {
        code: options.preparation.failure?.code || 'SCREEN_REGION_PPILOT_PREPARATION_FAILED'
      });
    }
    diagnosis = await io.observe('diagnose');
  }
  const now = io.now || Date.now, pause = io.delay || delay;
  const deadline = now() + options.waitMs;
  while (diagnosis.result.before.foreground !== options.hwnd && now() < deadline) { await pause(250); diagnosis = await io.observe('diagnose'); }
  let cover;
  if (options.cover && diagnosis.result.before.foreground === options.hwnd) cover = await io.cover();
  const captured = await io.observe('capture');
  return { diagnosis, cover, captured };
}
// Injectable cleanup so a missing ready reply cannot silently skip an owned
// process. This is also tested with fakes; importing it never starts a process.
export async function cleanupScreenRegionOwned(io) {
  const cleanup = { forcedAttempts: [], errors: [] }; let boot = io.boot;
  function failure(stage, pid, error) {
    const item = { stage, pid, message: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) };
    cleanup.errors.push(item); cleanup.error ??= item.message; return item;
  }
  async function retire(identity, kind, waits) {
    const result = { pid: identity.pid, originalExited: false, waits: [] };
    for (const milliseconds of waits) {
      try {
        const waited = await io.waitExit(identity, milliseconds);
        assert.equal(typeof waited?.originalExited, 'boolean', 'Invalid original-exit evidence');
        result.waits.push({ milliseconds, result: waited }); Object.assign(result, waited);
        if (waited.originalExited) return result;
      } catch (error) {
        result.waits.push({ milliseconds, error: failure(kind + ':wait', identity.pid, error) });
        break; // A failed wait must not suppress safe cleanup of a known identity.
      }
    }
    // Record the fallback before invoking anything: a lost response or a failed
    // identity recheck must not disappear from the acceptance evidence.
    const attempt = { kind, pid: identity.pid, identity: { ...identity }, forceAttempted: false };
    cleanup.forcedAttempts.push(attempt); result.forcedAttemptIndex = cleanup.forcedAttempts.length - 1;
    try {
      assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0, 'Full process/parent identity required for forced cleanup');
      assert.match(identity.startedUtcTicks || '', /^[1-9]\d{15,18}$/);
      assert.ok(typeof identity.executable === 'string' && path.win32.isAbsolute(identity.executable), 'Absolute original executable required for forced cleanup');
      assert.match(identity.sha256 || '', /^[a-f0-9]{64}$/);
      assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
      // The real adapter rechecks PID, birth, executable/hash, parent and token
      // inside the existing identity helper immediately before terminating.
      attempt.forceAttempted = true;
      attempt.result = await io.forceExit(identity);
      if (attempt.result?.originalExited === true) result.originalExited = true;
    } catch (error) { attempt.error = failure(kind + ':force', identity.pid, error).message; }
    // Force can throw after termination but before its receipt reaches us.
    // Preserve that failure while still obtaining the latest exit evidence.
    try {
      const waited = await io.waitExit(identity, 5000);
      assert.equal(typeof waited?.originalExited, 'boolean', 'Invalid post-cleanup exit evidence');
      result.waits.push({ milliseconds: 5000, afterForcedAttempt: true, result: waited });
      if (waited.originalExited) Object.assign(result, waited);
    } catch (error) { result.waits.push({ milliseconds: 5000, afterForcedAttempt: true, error: failure(kind + ':post-force-wait', identity.pid, error) }); }
    if (!result.originalExited) failure(kind + ':unconfirmed-exit', identity.pid, new Error('Original ' + kind + ' exit unconfirmed'));
    return result;
  }
  try { await io.requestClose(); } catch (error) { cleanup.closeRequestError = failure('close-request', boot?.pid, error).message; }
  if (!boot) {
    try { boot = await io.recoverBoot(); } catch (error) { cleanup.identityUnavailable = error.message; }
  }
  if (!boot) return { ...cleanup, ok: false };
  cleanup.recoveredBoot = boot;
  // A live probe has a 12 s watchdog. Give the fixture time to collect that
  // original child's exit/close before considering a forced parent shutdown.
  cleanup.fixture = await retire(boot.identity, 'fixture', [10000, 10000]);
  let records = [];
  try {
    const closed = await io.readClosed();
    assert.equal(closed.nonce, io.nonce); assert.equal(closed.pid, boot.pid); assert.equal(closed.activeProbe, false);
    assert.ok(Array.isArray(closed.probes) && closed.probes.length <= 128);
    cleanup.closed = closed; records = closed.probes;
  } catch (error) {
    cleanup.closedReceiptError = error.message;
    try { const last = await io.readProbeEvents(); assert.equal(last.nonce, io.nonce); assert.equal(last.pid, boot.pid); assert.ok(Array.isArray(last.probes) && last.probes.length <= 128); records = last.probes; }
    catch (fallback) { cleanup.probeRegistryError = fallback.message; }
  }
  cleanup.probes = [];
  for (const record of records) {
    try {
      if (record.spawnFailed && !record.pid && record.closeObserved) { cleanup.probes.push({ id: record.id, neverSpawned: true }); continue; }
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
      let id;
      try { id = await io.readProbeIdentity(record, boot); }
      catch (error) {
        // A child can exit before producing its identity receipt. Its parent's
        // original ChildProcess events are sufficient only in a clean receipt.
        if (cleanup.closed && record.exitObserved && record.closeObserved) { cleanup.probes.push({ pid: record.pid, originalChildExitObserved: true }); continue; }
        throw error;
      }
      cleanup.probes.push(await retire(id, 'probe', [10000]));
    } catch (error) { cleanup.probes.push({ pid: record.pid, error: failure('probe:identity', record.pid, error).message }); }
  }
  cleanup.ok = Boolean(cleanup.fixture?.originalExited && cleanup.closed && cleanup.errors.length === 0 && cleanup.forcedAttempts.length === 0);
  return cleanup;
}
export async function compileScreenRegion(directory) {
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  const probe = path.join(directory, 'DesktopScreenRegionProbe.exe'), identity = path.join(directory, 'ObserverFaultIdentity.exe'), pure = path.join(directory, 'DesktopScreenRegionTests.exe');
  const source = path.join(root, 'scripts/e2e/desktop-screen-region-probe.cs');
  const common = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/r:System.Drawing.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll'];
  const compile = args => execFileSync(compiler, args, { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  compile([...common, `/out:${probe}`, source]);
  compile([...common, `/out:${identity}`, path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')]);
  compile([...common, '/main:DesktopScreenRegionTests', `/out:${pure}`, source, path.join(root, 'tests/helpers/desktop-screen-region-tests.cs')]);
  const checks = JSON.parse(execFileSync(pure, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(checks.ok, true);
  const fixture = path.join(root, 'scripts/e2e/desktop-screen-region-fixture.cjs');
  new Script(await readFile(fixture, 'utf8'), { filename: fixture });
  return { probe, identity, fixture, pure, checks, hashes: { probe: sha(await readFile(probe)), fixture: sha(await readFile(fixture)), source: sha(await readFile(source)) } };
}
export async function verifyScreenRegion(options) {
  assert.equal(process.platform, 'win32', 'This Windows-only prototype does not change macOS capture.');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-screen-region-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const compiled = await compileScreenRegion(home);
  await writeFile(path.join(output, 'compile.json'), JSON.stringify({ mode: 'compile-and-pure-tests', ...compiled, guiStarted: false, desktopSampled: false }, null, 2));
  if (!options.run) return { ok: true, mode: 'compile-and-pure-tests', output, checks: compiled.checks, guiStarted: false, desktopSampled: false };
  await assertDesktopAcceptanceWindow();
  const nonce = randomBytes(16).toString('hex');
  const electron = createRequire(import.meta.url)('electron');
  const config = { home, nonce, gate: desktopAcceptanceWindowFile, probe: compiled.probe, identity: compiled.identity, ppilotFocus: options.ppilotFocus === true };
  const configFile = path.join(home, 'config.json'); await writeFile(configFile, JSON.stringify(config), { flag: 'wx' });
  const report = { ok: false, mode: options.diagnoseOnly ? 'owned-medium-screen-region-diagnosis' : 'owned-medium-screen-region-observation',
    startedAt: new Date().toISOString(), nonce, home, output, versions: { node: process.version, os: os.release() }, hashes: compiled.hashes,
    coordinateInputAvailable: false, captureValidated: false, foregroundMutationAttempted: false, affinityMutationAttempted: false,
    styleMutationAttempted: false, actualAppTested: false, actualAppCaptureTested: false,
    ppilotFocusRequested: options.ppilotFocus === true, actualAppFocusAttempted: false, probes: [], checks: [], cleanup: {}, limitations: [
      'Only an owned Medium Electron fixture is sampled; this is not the production App capture path.',
      'The image contains capturable screen composition within the client rectangle, potentially including other windows and overlays.',
      'Pre/post observations cannot prove an atomic frame or absence of transient overlays, display changes or protected-content exclusions.',
      'Only one fully containing monitor and the recorded local DPI/color environment are covered. Input coordinates remain unauthorized.',
      'The probe and fixture never activate or change protection/style. Explicit --ppilot-focus attempts one actual App UIA focus; that App may run its normal input observer for this temporary session.',
      'Only --ppilot-focus explicitly enables accessibility in the owned Electron fixture; this does not validate ordinary Chromium accessibility defaults.',
      'No direct pointer/keyboard injection or browser attachment occurs; independent capture remains unqualified for input coordinates.'
    ] };
  let launched, launchAttempted = false, boot, heartbeat;
  async function send(action) {
    const id = randomUUID(); await atomic(path.join(home, 'command.json'), { nonce, id, action });
    const reply = await poll(() => readJson(path.join(home, 'response.json')), v => v.id === id, 'owned ' + action, 20000);
    assert.equal(reply.nonce, nonce); assert.equal(reply.ok, true, reply.error); return reply.result;
  }
  function identityCall(args) {
    const value = JSON.parse(execFileSync(compiled.identity, args, { windowsHide: true, encoding: 'utf8', timeout: 16000 }));
    assert.equal(value.ok, true, value.error); return value;
  }
  function validateBoot(value) {
    assert.equal(value.nonce, nonce); if (launched) assert.equal(value.pid, launched.pid);
    assert.equal(value.identity.pid, value.pid); assert.equal(value.identity.integrityRid, 8192);
    assert.equal(value.identity.elevated, false); assert.equal(value.identity.uiAccess, false);
    assert.equal(path.resolve(value.identity.executable).toLowerCase(), path.resolve(electron).toLowerCase());
    assert.match(value.identity.startedUtcTicks, /^[1-9]\d+$/); return value;
  }
  async function observe(action) {
    await assertDesktopAcceptanceWindow();
    const value = await send(action); report.probes.push(value);
    assert.equal(value.result.nonce, nonce); assert.equal(value.result.ok, true, JSON.stringify(value.result));
    assert.equal(value.result.source, 'screen-region-gdi-prototype'); assert.equal(value.result.coordinateInputAvailable, false);
    assert.equal(value.child.exitObserved, true); assert.equal(value.child.closeObserved, true); assert.equal(value.child.exitCode, 0);
    assert.equal(value.result.probeToken.rid, 8192); assert.equal(value.result.probeToken.elevated, false); assert.equal(value.result.probeToken.uiAccess, false);
    assert.equal(value.result.before.pid, boot.pid); assert.equal(value.result.before.startedUtcTicks, boot.identity.startedUtcTicks);
    return value;
  }
  try {
    await writeFile(path.join(home, 'heartbeat'), nonce);
    heartbeat = setInterval(() => { void writeFile(path.join(home, 'heartbeat'), nonce).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000); heartbeat.unref();
    await assertDesktopAcceptanceWindow(); launchAttempted = true;
    launched = await launchWindowsUserProcess(electron, [compiled.fixture, configFile], root);
    boot = validateBoot(await poll(() => readJson(path.join(home, 'boot.json')), value => value.nonce === nonce, 'owned boot'));
    report.boot = boot;
    const ready = report.ready = await poll(async () => {
      try { const failure = await readJson(path.join(home, 'failure.json')); throw new Error('Fixture startup: ' + failure.error); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return readJson(path.join(home, 'ready.json'));
    }, value => value.nonce === nonce && value.pid === boot.pid, 'owned ready');
    assert.equal(ready.title, 'ProfilePilot screen region ' + nonce);
    console.log(JSON.stringify({ event: 'screen-region-ready', output, nonce, pid: boot.pid, hwnd: ready.hwnd, noAutomaticActivation: true, waitForForegroundMs: options.waitMs }));
    let diagnosis = await observe('diagnose');
    assert.equal(diagnosis.result.status, 'diagnosed'); assert.equal(diagnosis.result.captureAttempted, false); assert.equal(diagnosis.result.image, undefined);
    report.checks.push('Original Medium Chromium affinity, layered flag, DWM, geometry and foreground recorded without screen sampling');
    if (!options.diagnoseOnly) {
      if (options.ppilotFocus) {
        const build = await readJson(path.join(root, 'dist/main/control-build.json'));
        assert.match(build.buildId, /^[a-f0-9]{64}$/);
        const entry = path.join(root, 'dist/main/profilepilot-cli.cjs');
        assert.equal(sha(await readFile(entry)), build.cliSha256, 'Local CLI does not match the current build manifest');
        const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
        const cli = async args => (await runDesktopCliProcess({ entry, args: [...args, '--json'], env, cwd: root, timeoutMs: 70000, expectedExitCode: null })).response;
        const requestId = randomUUID(), session = 'screen-region-focus-' + randomUUID();
        report.ppilotFocus = await attemptScreenRegionPpilotFocus({ nonce, session, requestId,
          buildId: build.buildId, appEntry: path.join(root, 'dist/main/entry.js'), expectedAppExecutable: electron, expectedAppSha256: sha(await readFile(electron)),
          fixture: { ...ready, identity: boot.identity } }, {
          gate: () => assertDesktopAcceptanceWindow(), appStatus: () => cli(['status']), desktop: args => cli(['desktop', ...args]),
          identity: pid => identityCall(['--inspect', String(pid)]),
          writeParams: async params => { const file = path.join(home, 'ppilot-focus-' + requestId + '.json'); await writeFile(file, JSON.stringify(params), { flag: 'wx' }); return file; }
        });
        report.actualAppFocusAttempted = report.ppilotFocus.actualAppFocusAttempted;
        report.foregroundMutationAttempted = report.actualAppFocusAttempted;
        report.actualAppFocusOutcome = report.ppilotFocus.outcome;
        report.actualAppForegroundChanged = report.ppilotFocus.foregroundChanged;
      }
      const observation = await observeScreenRegionAfterPreparation({ ppilotFocus: options.ppilotFocus, preparation: report.ppilotFocus,
        diagnosis, hwnd: ready.hwnd, waitMs: options.waitMs, cover: options.cover }, {
        observe, cover: async () => { report.cover = await send('cover'); return report.cover; }
      });
      const captured = observation.captured;
      report.captureStatus = captured.result.status;
      if (captured.result.status === 'captured') {
        const image = captured.result.image;
        assert.equal(image.source, 'screen-region-gdi-prototype'); assert.equal(image.coordinateInputAvailable, false);
        assert.equal(image.width, captured.result.sourceScreenRect.width); assert.equal(image.height, captured.result.sourceScreenRect.height);
        const bytes = await readFile(image.path); assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]); assert.equal(sha(bytes), image.sha256);
        await copyFile(image.path, path.join(output, 'client.png'));
        const evidence = evaluateWgcMarkerEvidence(captured.result.decoded, captured.before.page, captured.before.webContentsPhysicalBounds, captured.result.sourceScreenRect);
        report.visualEvidence = evidence;
        if (!options.cover) assert.equal(evidence.matches, true, JSON.stringify(evidence));
        else {
          assert.ok(report.cover?.cover && report.cover.cover.focused === false);
          assert.equal(captured.result.before.foreground, ready.hwnd, 'Owned cover must not activate');
          assert.equal(evidence.matches, false, 'Covered marker must not masquerade as target-only pixels');
          const overlay = captured.result.decoded.cover, expected = report.cover.cover.physicalBounds, source = captured.result.sourceScreenRect;
          assert.ok(overlay.count >= 1000, 'Known overlay color must actually be present');
          assert.ok(Math.abs(source.x + overlay.x - (expected.x + expected.width / 2)) <= 3);
          assert.ok(Math.abs(source.y + overlay.y - (expected.y + expected.height / 2)) <= 3);
        }
        report.captureValidated = true; report.checks.push(options.cover ? 'Owned nonactivating overlay appears in composited client pixels' : 'Direct client PNG dimensions and known marker coordinates agree');
      } else {
        assert.ok(['not_captured', 'state_changed'].includes(captured.result.status)); assert.equal(captured.result.image, undefined);
        report.checks.push('Unqualified or changing state returned no image and no coordinate authority');
      }
    }
    report.ok = (options.diagnoseOnly || report.captureValidated) && (!options.ppilotFocus || (!report.ppilotFocus.failure && report.ppilotFocus.completedRequireActive));
  } catch (error) { report.error = { message: error.message, code: error.code }; }
  finally {
    // Always request nonce close, even if launch/ready failed. Boot evidence is
    // recovered independently; missing ready never skips original process cleanup.
    if (launchAttempted) {
      const cleaned = await cleanupScreenRegionOwned({ nonce, boot,
        requestClose: () => atomic(path.join(home, 'command.json'), { nonce, id: randomUUID(), action: 'close' }),
        recoverBoot: async () => validateBoot(await poll(() => readJson(path.join(home, 'boot.json')), value => value.nonce === nonce, 'cleanup boot identity', 12000)),
        waitExit: (id, ms) => identityCall(['--wait-owned-exit', String(id.pid), id.startedUtcTicks, String(ms)]),
        forceExit: id => identityCall(['--cleanup-owned', String(id.pid), id.startedUtcTicks, id.executable, id.sha256, String(id.parentPid)]),
        readClosed: () => readJson(path.join(home, 'closed.json')),
        readProbeEvents: () => readJson(path.join(home, 'probe-events.json')),
        readProbeIdentity: async (record, original) => {
          assert.equal(path.dirname(path.resolve(record.identityFile)).toLowerCase(), home.toLowerCase());
          const id = await readJson(record.identityFile); assert.equal(id.nonce, nonce); assert.equal(id.pid, record.pid); assert.equal(id.parentPid, original.pid);
          assert.equal(path.resolve(id.executable).toLowerCase(), compiled.probe.toLowerCase()); assert.equal(id.sha256, compiled.hashes.probe);
          assert.equal(id.integrityRid, 8192); assert.equal(id.elevated, false); assert.equal(id.uiAccess, false); assert.match(id.startedUtcTicks, /^[1-9]\d+$/); return id;
        } });
      report.cleanup = { ...report.cleanup, ...cleaned }; if (!report.boot && cleaned.recoveredBoot) report.boot = cleaned.recoveredBoot;
      if (!cleaned.ok) report.ok = false;
    }
    if (heartbeat) clearInterval(heartbeat);
    report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await verifyScreenRegion(parseScreenRegionArgs(process.argv.slice(2))); console.log(JSON.stringify({ ok: result.ok, mode: result.mode, output: result.output, captureStatus: result.captureStatus, captureValidated: result.captureValidated, checks: result.checks, error: result.error, cleanupError: result.cleanup?.error })); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
