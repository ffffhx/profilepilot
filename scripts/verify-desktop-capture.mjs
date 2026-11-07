// --check compiles only. --run uses Medium owned WinForms/probe processes and
// production native source, with no window enumeration, activation or input.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSourceFiles } from './desktop-source-files.mjs';
import { resolveWindowsWinrtReferences } from './windows-winrt-contracts.mjs';
import { assertDesktopAcceptanceWindow, desktopAcceptanceWindowFile } from './e2e/desktop-acceptance-window.mjs';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { classifyExternalGeometryCapture } from './e2e/desktop-capture-evidence.mjs';

const args = process.argv.slice(2), run = args[0] === '--run';
assert.ok(args.length <= 1 && (!args.length || ['--check', '--run'].includes(args[0])), 'Expected --check or --run');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (run) await assertDesktopAcceptanceWindow();
if (process.platform !== 'win32') {
  assert.ok(!run, 'Native Windows capture acceptance is unsupported on this platform.');
  console.log(JSON.stringify({ ok: true, mode: 'check-only', skipped: 'Windows compiler unavailable on this platform', guiStarted: false, captureStarted: false }));
} else {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-capture-'));
  const executable = path.join(home, 'DesktopCaptureFixture.exe');
  let preserveFixtureDirectory = false;
  try {
    const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const winrt = await resolveWindowsWinrtReferences(root, { framework });
    execFileSync(path.join(framework, 'csc.exe'), [
      '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopCaptureFixture', `/out:${executable}`,
      '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
      ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/r:${path.join(framework, 'WPF', file)}`),
      ...winrt.references.map(file => `/r:${file}`), ...desktopSourceFiles.map(file => path.join(root, 'native/desktop', file)),
      path.join(root, 'scripts/e2e/desktop-capture-fixture.cs')
    ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
    if (run) await verify(home, executable);
    else console.log(JSON.stringify({ ok: true, mode: 'compile-only', sourceFiles: desktopSourceFiles, guiStarted: false, captureStarted: false }));
  } catch (error) {
    preserveFixtureDirectory = error.preserveFixtureDirectory === home;
    throw error;
  } finally {
    // mkdtemp owns this directory; check the absolute boundary before deletion.
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('pp-desktop-capture-'));
    if (!preserveFixtureDirectory) await rm(home, { recursive: true, force: true });
  }
}

async function verify(home, executable) {
  await assertDesktopAcceptanceWindow();
  const nonce = randomUUID(), versions = new Set();
  const output = path.join(root, '.tools/desktop-verification', path.basename(home));
  await mkdir(output, { recursive: true });
  const report = { ok: false, startedAt: new Date().toISOString(), osRelease: os.release(),
    mode: 'owned-native-capture', scope: 'Medium WinForms fixture and Medium probe invoke the production native screenshot entry on one manifest HWND only; no window enumeration, UIA traversal, activation, or input.',
    checks: [], captures: [], cleanup: {}, coverage: { staticChecks: { status: 'not_run' }, printCallbacks: { status: 'not_run' }, externalGeometryStress: { status: 'not_run' } }, limitations: [
      'This is a production-source native integration harness; the running App, CLI admission and compositor are not exercised.',
      'Only the recorded local display/scale is covered; no mixed-DPI, multi-monitor, macOS, or arbitrary application claim.',
      'Before/after snapshots reject observed changes; they are not an atomic lock against a change after the last check.',
      'An unavailable affinity query remains unknown, not evidence that capture protection is absent.',
      'Print mutation evidence records the actual message and OS-confirmed redirection; a redirected paint callback is not reported as WM_PRINT.',
      'External geometry stress is probabilistic coverage of an observed rejection, not proof about every possible capture/mutation timing.',
      'A successful read during stress is recorded without declaring guard failure; a bounded series without qualifying rejection remains not covered.'
    ] };
  let fixture, activeProbe, sequence = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitJson(file, accept, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { const value = JSON.parse(await readFile(file, 'utf8')); if (accept(value)) return value; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(40);
    }
    throw new Error(label + ' did not return before its deadline');
  }
  async function reply(id) {
    const value = await waitJson(path.join(home, 'response.json'), value => value.id === id, 'Owned fixture ' + id);
    assert.equal(value.nonce, nonce); assert.equal(value.state.nonce, nonce); assert.equal(value.state.pid, fixture.pid);
    assert.equal(value.error, null, value.error); return value.state;
  }
  async function command(action) {
    const id = String(++sequence);
    await writeFile(path.join(home, 'command.json'), JSON.stringify({ id, nonce, action }));
    return reply(id);
  }
  async function capture(label, state, expected, externalGeometryStress = false) {
    await assertDesktopAcceptanceWindow();
    const manifest = path.join(home, 'manifest-' + sequence + '.json');
    const resultFile = path.join(home, 'capture-' + sequence + '.json');
    await writeFile(manifest, JSON.stringify({ ...state, externalGeometryStress }));
    activeProbe = await launchWindowsUserProcess(executable, ['--capture', desktopAcceptanceWindowFile, manifest, resultFile], root);
    assert.equal(activeProbe.administrator, false);
    const response = await waitJson(resultFile, () => true, 'Owned capture probe ' + label);
    assert.equal(response.workerPid, activeProbe.pid); activeProbe = undefined;
    assert.equal(response.integrity.label, 'medium');
    assert.equal(response.foregroundBefore, response.foregroundAfter, 'Read-only capture must not activate a window');
    const record = { label, state, worker: { pid: response.workerPid, integrity: response.integrity }, elapsedMs: response.elapsedMs,
      foregroundBefore: response.foregroundBefore, foregroundAfter: response.foregroundAfter,
      captureStartedAt: response.captureStartedAt, captureFinishedAt: response.captureFinishedAt };
    report.captures.push(record);
    // Preserve post-capture evidence before any expected-result assertion. An
    // untriggered fixture must not be mistaken for a failed production guard.
    record.response = response.ok ? { ...response, result: { ...response.result,
      image: response.result?.image ? { ...response.result.image, data: undefined } : undefined } } : response;
    const afterState = record.afterState = await command(externalGeometryStress ? 'geometry-stop' : 'state');
    if (externalGeometryStress) {
      const evidence = record.geometryStressEvidence = classifyExternalGeometryCapture(response, afterState);
      if (evidence.status === 'unexpected_failure') throw Object.assign(new Error('External geometry capture returned an unexpected failure: ' + JSON.stringify(record.response)), { code: 'FIXTURE_GEOMETRY_CAPTURE_FAILED' });
      return { afterState, evidence };
    }
    if (state.onPrint) {
      const event = afterState.lastPrintMutation;
      const triggered = afterState.printMutationCount === state.printMutationCount + 1 && event?.action === state.onPrint && afterState.onPrint === '';
      record.printMutationEvidence = { status: triggered ? 'triggered' : 'not_exercised', event,
        beforePrintCount: state.printCount, afterPrintCount: afterState.printCount,
        beforeRedirectedPrintCount: state.redirectedPrintCount, afterRedirectedPrintCount: afterState.redirectedPrintCount };
      if (!triggered) throw Object.assign(new Error(label + ': the owned print mutation did not execute; this capture does not test the guard.'), { code: 'FIXTURE_PRINT_MUTATION_NOT_TRIGGERED' });
      const start = Date.parse(response.captureStartedAt), end = Date.parse(response.captureFinishedAt);
      const mutationStart = Date.parse(event.startedAt), mutationEnd = Date.parse(event.finishedAt);
      if (![start, end, mutationStart, mutationEnd].every(Number.isFinite) || mutationStart < start || mutationEnd > end) {
        record.printMutationEvidence.status = 'outside_capture';
        throw Object.assign(new Error(label + ': the print mutation did not overlap the owned capture request.'), { code: 'FIXTURE_PRINT_MUTATION_OUTSIDE_CAPTURE' });
      }
      if (response.ok && state.onPrint === 'resize' && JSON.stringify(response.result?.image?.captureState?.windowRect) === JSON.stringify(afterState.window)) {
        record.printMutationEvidence.status = 'preceded_capture_snapshot';
        throw Object.assign(new Error(label + ': the capture snapshot already describes the resized window; guard overlap was not established.'), { code: 'FIXTURE_PRINT_MUTATION_BEFORE_SNAPSHOT' });
      }
    }
    if (expected) {
      record.failure = record.response;
      assert.equal(response.ok, false, label + ' must not return a coordinate-enabled stale image');
      assert.equal(response.code, expected.code, JSON.stringify(record.response));
      assert.equal(response.cause, expected.cause, JSON.stringify(record.response));
      assert.equal(response.result, undefined); report.checks.push(label + ': explicit native refusal'); return afterState;
    }
    assert.equal(response.ok, true, JSON.stringify(response));
    const observation = response.result, image = observation.image;
    assert.equal(versions.has(observation.version), false); versions.add(observation.version);
    assert.deepEqual(observation.elements, []); assert.deepEqual(observation.gaps, ['uia_skipped']);
    assert.equal(image.source, 'native-window'); assert.equal(image.mimeType, 'image/jpeg');
    assert.equal(image.physicalPixelsAvailable, true); assert.equal(image.coordinateInputAvailable, true);
    assert.deepEqual(image.captureRect, { x: 0, y: 0, width: state.window.width, height: state.window.height });
    assert.equal(image.windowX, state.window.x); assert.equal(image.windowY, state.window.y);
    assert.equal(image.windowWidth, state.window.width); assert.equal(image.windowHeight, state.window.height);
    assert.deepEqual(image.captureState.windowRect, state.window); assert.deepEqual(image.captureState.clientRect, state.client);
    assert.equal(image.captureState.visible, true); assert.equal(image.captureState.minimized, false);
    assert.ok(['none', 'unknown'].includes(image.captureState.protectionStatus));
    if (image.captureState.displayAffinity === null) assert.equal(image.captureState.protectionStatus, 'unknown');
    const bytes = Buffer.from(image.data, 'base64');
    assert.ok(bytes.length > 1000 && bytes.length <= 2200000); assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
    const file = path.join(output, label + '.jpg'); await writeFile(file, bytes);
    const decoded = JSON.parse(execFileSync(executable, ['--decode-image', file], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
    assert.equal(decoded.format.toLowerCase(), 'b96b3cae-0728-11d3-9d7b-0000f81ef32e');
    assert.equal(decoded.width, image.width); assert.equal(decoded.height, image.height);
    record.image = { ...image, data: undefined, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    record.decoded = decoded;
    record.markerMeasurements = decoded.markers.map((marker, index) => {
      assert.ok(marker.count >= 1000, label + ': missing owned color marker ' + index);
      const measured = { x: image.windowX + marker.x * image.windowWidth / image.width, y: image.windowY + marker.y * image.windowHeight / image.height };
      const expected = { x: state.client.x + state.markers[index].x, y: state.client.y + state.markers[index].y };
      const error = { x: measured.x - expected.x, y: measured.y - expected.y };
      assert.ok(Math.abs(error.x) <= 3 && Math.abs(error.y) <= 3, 'Owned marker/window coordinate disagreement: ' + JSON.stringify(error));
      return { measured, expected, error };
    });
    report.checks.push(label + ': fresh native JPEG, decoded marker dimensions and stable physical metadata');
    return afterState;
  }
  const unavailable = cause => ({ code: 'DESKTOP_SCREENSHOT_UNAVAILABLE', cause });
  try {
    fixture = await launchWindowsUserProcess(executable, ['--fixture', desktopAcceptanceWindowFile, home, nonce], root);
    assert.equal(fixture.administrator, false); report.fixtureLaunch = fixture;
    let state = await reply('ready'); assert.equal(state.integrity.label, 'medium'); report.initialState = state;
    await capture('normal', state);
    for (const [action, cause] of [['hide', 'CAPTURE_WINDOW_HIDDEN'], ['minimize', 'CAPTURE_WINDOW_MINIMIZED'], ['protect', 'CAPTURE_CAPTURE_PROTECTED']]) {
      await command('normal'); state = await command(action);
      if (action === 'protect') { assert.equal(state.protectionSet, true); assert.ok(state.displayAffinity > 0, 'The protection case must establish a readable nonzero affinity'); }
      await capture(action, state, unavailable(cause));
    }
    state = await command('normal'); await capture('restored', state);
    report.coverage.staticChecks = { status: 'passed', checks: [...report.checks] };
    const firstPrintCheck = report.checks.length;
    try {
      state = await command('on-print-resize');
      const printMutations = state.printMutationCount, mutations = state.mutations;
      state = await capture('resize-during-print', state, { code: 'DESKTOP_WINDOW_CHANGED', cause: 'CAPTURE_WINDOW_CHANGED' });
      assert.equal(state.printMutationCount, printMutations + 1); assert.equal(state.mutations, mutations + 1, 'Resize must occur inside an observed print callback');
      assert.notDeepEqual(state.window, report.initialState.window); await capture('resized-fresh', state);
      for (const [action, cause] of [['hide', 'CAPTURE_WINDOW_HIDDEN'], ['minimize', 'CAPTURE_WINDOW_MINIMIZED'], ['protect', 'CAPTURE_CAPTURE_PROTECTED']]) {
        await command('normal'); state = await command('on-print-' + action);
        const mutations = state.mutations;
        const after = await capture(action + '-during-print', state, unavailable(cause));
        assert.equal(after.mutations, mutations + 1, 'The owned state mutation must run within an observed print callback');
      }
      report.coverage.printCallbacks = { status: 'passed', checks: report.checks.slice(firstPrintCheck) };
    } catch (error) {
      if (!String(error.code || '').startsWith('FIXTURE_PRINT_MUTATION_')) throw error;
      report.coverage.printCallbacks = { status: 'not_covered', code: error.code, reason: error.message,
        checks: report.checks.slice(firstPrintCheck), evidenceCapture: report.captures.at(-1)?.label };
    }
    const stress = report.coverage.externalGeometryStress = { status: 'not_covered', maximumAttempts: 6, startBudgetMs: 90000, attempts: [],
      deadlinePolicy: 'No new read starts after the start budget; an already started read retains its finite launcher/probe/reply deadlines.' };
    const startDeadline = Date.now() + stress.startBudgetMs;
    for (let index = 0; index < stress.maximumAttempts && Date.now() < startDeadline; index++) {
      state = await command('normal');
      if (Date.now() >= startDeadline) break;
      const label = 'external-geometry-' + (index + 1);
      const result = await capture(label, state, undefined, true);
      stress.attempts.push({ label, ...result.evidence });
      if (result.evidence.status === 'observed') {
        stress.status = 'passed';
        report.checks.push(label + ': production guard rejected genuinely different geometry during an external timer mutation');
        break;
      }
    }
    if (stress.status !== 'passed') stress.reason = 'No qualifying production geometry rejection was observed within the bounded read attempts.';
    state = await command('normal'); await capture('final-restored', state);
    report.ok = Object.values(report.coverage).every(value => value.status === 'passed');
    report.status = report.ok ? 'passed' : 'partial';
    if (!report.ok) process.exitCode = 75;
  } catch (error) {
    report.status = 'failed'; report.error = error.stack || String(error); report.failureCode = error.code; throw error;
  } finally {
    const cleanupErrors = [];
    if (activeProbe) {
      try { terminateOwnedWindowsProcess(activeProbe.pid, executable); report.cleanup.probeTerminated = true; }
      catch (error) { cleanupErrors.push('probe: ' + error.message); }
    }
    if (fixture) {
      try { await command('close'); report.cleanup.closeAcknowledged = true; }
      catch (error) { report.cleanup.closeError = error.message; }
      try { await delay(100); terminateOwnedWindowsProcess(fixture.pid, executable); report.cleanup.fixtureConfirmedStopped = true; }
      catch (error) { cleanupErrors.push('fixture: ' + error.message); }
    }
    if (cleanupErrors.length) { report.ok = false; report.status = 'failed'; report.cleanup.errors = cleanupErrors; report.cleanup.retainedDirectory = home; }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, status: report.status, report: path.join(output, 'report.json'), coverage: report.coverage, checks: report.checks, cleanup: report.cleanup }));
    if (cleanupErrors.length) throw Object.assign(new Error('Owned capture cleanup was incomplete: ' + cleanupErrors.join('; ')), { preserveFixtureDirectory: home });
  }
}
