// Default --check parses the shared fixture without starting any process.
// --run exercises the actual development App's CLI screenshot path after the
// shared local acceptance gate. It never sends keyboard or pointer input.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { fixtureSource, evaluateWgcMarkerEvidence } from './e2e/wgc-fixture-source.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';

const args = process.argv.slice(2);
assert.ok(args.length <= 1 && (!args.length || ['--check', '--run', '--run-startup-occluded'].includes(args[0])), 'Expected --check, --run or --run-startup-occluded');
const startupOnly = args[0] === '--run-startup-occluded';
new Script(fixtureSource, { filename: 'owned-wgc-fixture.cjs' });
if (args[0] !== '--run' && !startupOnly) console.log(JSON.stringify({ ok: true, mode: 'check-only', guiStarted: false, captureStarted: false }));
else {
  await assertDesktopAcceptanceWindow();
  assert.equal(process.platform, 'win32', 'Native WGC acceptance requires Windows; macOS is unsupported.');
  await run();
}

async function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-wgc-'));
  const output = path.join(root, '.tools', 'desktop-verification', path.basename(home));
  await mkdir(output, { recursive: true });
  const fixturePath = path.join(home, 'fixture.cjs');
  const commandFile = path.join(home, 'command.json'), responseFile = path.join(home, 'response.json');
  const decoder = path.join(home, 'DesktopImageInspector.exe');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const session = 'wgc-app-' + randomUUID();
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const report = { ok: false, mode: startupOnly ? 'actual-app-wgc-startup-occluded' : 'actual-app-wgc', startedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(),
    scope: 'The running development App claims an unregistered owned Medium Electron fixture and captures it through desktop CLI; no browser connection or input actions.',
    captures: [], checks: [], freshness: [], cleanup: {}, limitations: [
      'Coordinate authority remains false. Candidate bounds and marker measurements are observations only, never authorized input coordinates.',
      'Only the recorded local display and scale are covered; no mixed-DPI, HDR, multi-GPU, macOS, or arbitrary Chromium application claim.',
      'The decoder only reads saved image files. No standalone native capture prototype runs in this acceptance.',
      'Doctor samples the actual App catalog helper; the production screenshot travels through the session worker.',
      'Fresh observation versions and WGC timestamps do not prove new DOM pixels. Freshness cases compare decoded marker positions against the explicitly changed owned DOM revision.',
      'Default-throttling direct and iframe cases are local diagnostics. The fixture capturePage call is a separate owned-window experiment, not a production fallback or an external application capability.',
      'On Windows, document.visibilityState alone does not establish whether an occluded Chromium surface continues painting. Counters, DOM revisions and actual decoded pixels are reported separately.',
      'Startup-occluded targets use show:true before loading their DOM but focusable:false to avoid activation; the production App normally permits focus. A pre-existing owned always-on-top window covers the target bounds throughout initial navigation.',
      'The startup experiment tests a newly created BrowserWindow, not every process/GPU cold-start condition. It uses local data documents instead of the production file workspace and does not diagnose arbitrary blank images.',
      'Removing the owned cover does not prove that another application no longer occludes the target. A separate temporary topmost/showInactive stage records marker recovery and foreground preservation, then restores the owned target layer.'
    ] };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let fixture, target, claimed = false, commandSequence = 0, heartbeat;
  const versions = new Set();
  const frameTimestamps = new Map();

  async function cli(args, expected = 0, timeoutMs = 70000) {
    try {
      return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...args, '--json'],
        env, timeoutMs, expectedExitCode: expected })).response;
    } catch (error) {
      report.lastFailure = { args, code: error.code, outcome: error.outcome, exitCode: error.exitCode, response: error.response, timeoutMs: error.timeoutMs };
      throw error;
    }
  }
  const desktop = (args, expected, timeoutMs) => cli(['desktop', ...args], expected, timeoutMs);
  async function poll(read, accept, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await read(Math.max(1, deadline - Date.now())); if (accept(last)) return last; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(40);
    }
    throw new Error(label + ' timed out: ' + JSON.stringify(last));
  }
  async function waitReply(id) {
    const reply = await poll(async () => JSON.parse(await readFile(responseFile, 'utf8')), value => value.id === id, 'owned fixture reply ' + id, 30000);
    assert.ok(!reply.error, reply.error); assert.equal(reply.state.pid, fixture.pid);
    return reply.state;
  }
  async function command(action) {
    const id = String(++commandSequence);
    await writeFile(commandFile, JSON.stringify({ id, action })); return waitReply(id);
  }
  async function select(state, first = false) {
    target = await poll(async remaining => (await desktop(['windows'], 0, remaining)).result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === state.hwnd), Boolean, 'exact owned Electron HWND');
    assert.ok(target.className.startsWith('Chrome_WidgetWin'), 'Exercise the Chromium-specific WGC production path');
    assert.equal(target.title, 'ProfilePilot WGC owned fixture');
    if (first) claimed = true; // Clean up our exact task even if the claim reply is lost.
    await desktop([first ? 'claim' : 'select', '--session', session, '--window', target.id]);
  }
  async function doctor() {
    const value = (await desktop(['doctor', '--window', target.id])).result;
    assert.equal(value.source.integrity.rid, 8192, 'The actual App catalog helper must run at Medium integrity');
    assert.equal(value.source.integrity.elevated, false);
    assert.equal(value.target.pid, fixture.pid); assert.equal(value.target.hwnd, target.nativeHandle);
    assert.equal(value.target.integrity.rid, 8192, 'The fixture must run at Medium integrity');
    assert.equal(value.target.integrity.elevated, false);
    return value;
  }
  async function capture(label, state, imageOnly = false, diagnosticOnly = false) {
    // Refresh this fixture's read-only state and its watchdog before each
    // capture; two bounded App reads must not share an old 90 s heartbeat.
    const refreshed = await command('normal');
    assert.equal(refreshed.hwnd, state.hwnd); state = refreshed;
    const before = await doctor();
    const file = path.join(output, label + '.jpg');
    const observation = (await desktop(['screenshot', '--session', session, '--output', file, ...(imageOnly ? ['--image-only'] : [])])).result;
    const image = observation.image;
    const record = { label, imageOnly, target, state, before, observation: { ...observation, elements: undefined }, elementCount: observation.elements.length };
    report.captures.push(record);
    assert.equal(observation.windowId, target.id);
    assert.match(observation.version, /^[a-f0-9]{32}$/); assert.ok(!versions.has(observation.version), 'Each capture provides a fresh version'); versions.add(observation.version);
    assert.equal(image.source, 'windows-graphics-capture', 'The App compositor must not replace the native WGC result');
    assert.equal(image.coordinateInputAvailable, false, 'Unqualified WGC origin must never enable coordinate input');
    assert.equal(image.captureRect, undefined, 'Candidate bounds must not be promoted to captureRect');
    assert.equal(image.captureFallback, undefined, 'This acceptance must use successful WGC, not a fallback');
    assert.equal(image.mimeType, 'image/jpeg'); assert.equal(path.resolve(image.path), file);
    assert.ok(image.width > 0 && image.height > 0 && Math.max(image.width, image.height) <= 1600);
    assert.deepEqual([image.windowX, image.windowY, image.windowWidth, image.windowHeight], before.target.bounds, 'Image outer bounds match an independent App doctor read');
    const diagnostic = image.captureDiagnostics;
    assert.ok(diagnostic); assert.equal(diagnostic.status, 'captured_unmapped');
    assert.equal(diagnostic.geometryStatus, 'stable_dimensions_match_origin_unvalidated'); assert.equal(diagnostic.colorMode, 'SDR-BGRA8');
    assert.match(diagnostic.frameTimestampTicks, /^\d+$/); assert.ok(BigInt(diagnostic.frameTimestampTicks) > 0n);
    const previousTimestamp = frameTimestamps.get(state.hwnd);
    record.frameTimestampEvidence = { value: diagnostic.frameTimestampTicks, previous: previousTimestamp,
      advanced: previousTimestamp === undefined ? null : BigInt(diagnostic.frameTimestampTicks) > BigInt(previousTimestamp), provesDomFreshness: false };
    frameTimestamps.set(state.hwnd, diagnostic.frameTimestampTicks);
    assert.ok(Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0);
    const candidate = diagnostic.candidateCaptureRect;
    assert.ok(candidate && [candidate.X, candidate.Y, candidate.Width, candidate.Height].every(Number.isInteger));
    assert.ok(candidate.X >= 0 && candidate.Y >= 0 && candidate.Width > 0 && candidate.Height > 0);
    assert.ok(candidate.X + candidate.Width <= image.windowWidth && candidate.Y + candidate.Height <= image.windowHeight);
    assert.equal(candidate.Width, diagnostic.contentWidth); assert.equal(candidate.Height, diagnostic.contentHeight);
    const scale = Math.min(1, 1600 / Math.max(diagnostic.contentWidth, diagnostic.contentHeight));
    assert.ok(Math.abs(image.width - diagnostic.contentWidth * scale) <= 1 && Math.abs(image.height - diagnostic.contentHeight * scale) <= 1);
    if (imageOnly) {
      assert.deepEqual(observation.elements, []); assert.equal(observation.truncated, false);
      assert.ok(observation.gaps.includes('uia_skipped'));
    }
    const bytes = await readFile(file);
    assert.ok(bytes.length > 1000 && bytes.length <= 2200000);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
    record.sha256 = createHash('sha256').update(bytes).digest('hex');
    // The existing inspector exits before any WinForms/DPI/keyboard code. It
    // only decodes this owned file, irrespective of the orchestration token.
    const decoded = JSON.parse(execFileSync(decoder, ['--inspect-image', file], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
    record.decoded = decoded;
    assert.equal(decoded.format.toLowerCase(), 'b96b3cae-0728-11d3-9d7b-0000f81ef32e');
    assert.equal(decoded.width, image.width); assert.equal(decoded.height, image.height);
    const content = state.webContentsPhysicalBounds;
    assert.ok(Math.abs(content.width - state.page.width * state.page.dpr) <= 2 && Math.abs(content.height - state.page.height * state.page.dpr) <= 2);
    record.visualEvidence = evaluateWgcMarkerEvidence(decoded, state.page, content, {
      x: image.windowX + candidate.X, y: image.windowY + candidate.Y, width: diagnostic.contentWidth, height: diagnostic.contentHeight });
    record.candidateMeasurements = record.visualEvidence.measurements;
    record.after = await doctor();
    assert.deepEqual(record.after.target.bounds, before.target.bounds, 'Capture must not move or resize the fixture');
    assert.equal(record.after.foreground.hwnd, before.foreground.hwnd, 'Read-only capture must not activate a window');
    if (record.visualEvidence.matches) report.checks.push(label + ': actual App WGC bytes, disabled coordinates, current decoded markers and bounded candidate geometry');
    else if (!diagnosticOnly) assert.fail(label + ': ' + record.visualEvidence.classification + ': ' + JSON.stringify(record.visualEvidence));
    return record;
  }

  async function freshness(mode, initialState) {
    const startupOccluded = mode.startsWith('startup-occluded');
    let state = initialState || await command(mode);
    assert.equal(state.configuration.backgroundThrottlingOption, 'omitted');
    assert.equal(state.configuration.effectiveBackgroundThrottling, true);
    if (!initialState) await select(state);
    const evidence = { mode, startupEvidence: state.startupEvidence, stages: [], pageCapture: null, passed: false };
    report.freshness.push(evidence);
    if (startupOccluded) {
      assert.equal(state.configuration.showAtConstruction, true);
      assert.equal(state.configuration.focusableOption, false);
      assert.equal(state.startupEvidence.targetCreatedAfterVisibleCover, true);
      assert.equal(state.startupEvidence.loadStartedWhileCovered, true);
      assert.equal(state.covered, true); assert.equal(state.visible, true);
      const events = state.startupEvidence.events.map(event => event.event);
      const sequence = ['cover-visible-before-target', 'target-created-visible', 'target-load-started-under-cover', 'target-load-completed'].map(event => events.indexOf(event));
      assert.ok(sequence.every((value, index) => value >= 0 && (!index || value > sequence[index - 1])), 'Cover must precede target creation and its first DOM navigation');
      assert.equal(state.pageCapture, undefined, 'No owned capturePage may prewarm the startup baseline');
    }
    async function sample(label) {
      const record = await capture(mode + '-' + label, state, true, true);
      evidence.stages.push({ label, revision: record.state.page.contentRevision, covered: record.state.covered,
        animationFrames: record.state.page.animationFrames, timers: record.state.page.timers,
        visibilityState: record.state.page.visibilityState, visualEvidence: record.visualEvidence,
        frameTimestampEvidence: record.frameTimestampEvidence, sha256: record.sha256, exposure: record.state.exposure,
        alwaysOnTop: record.state.alwaysOnTop, focused: record.state.focused });
      return record;
    }
    await sample(startupOccluded ? 'startup-covered-baseline' : 'visible-baseline');
    if (!startupOccluded) state = await command('cover');
    assert.equal(state.covered, true);
    for (const revision of startupOccluded ? [1] : [1, 2]) {
      state = await command('mutate'); assert.equal(state.page.contentRevision, revision);
      await sample('covered-revision-' + revision);
    }
    // No wake or generic paint request occurs before the WGC-only samples.
    // This separate comparator can only access the fixture's own BrowserWindow.
    const beforeWake = await doctor();
    state = await command('capture-page');
    evidence.pageCapture = { ...state.pageCapture, before: beforeWake, after: await doctor() };
    assert.deepEqual(evidence.pageCapture.after.target.bounds, beforeWake.target.bounds);
    assert.equal(evidence.pageCapture.after.foreground.hwnd, beforeWake.foreground.hwnd, 'Owned capturePage must not activate a window');
    assert.equal(state.covered, true); assert.equal(state.visible, true); assert.equal(state.minimized, false);
    if (state.pageCapture.ok) {
      const source = path.resolve(state.pageCapture.path);
      assert.equal(path.dirname(source).toLowerCase(), path.resolve(home).toLowerCase(), 'Read only this fixture capture artifact');
      assert.match(path.basename(source), /^capture-page-\d+\.jpg$/);
      const destination = path.join(output, mode + '-owned-capture-page.jpg');
      const bytes = await readFile(source); await writeFile(destination, bytes, { flag: 'wx' });
      const decoded = JSON.parse(execFileSync(decoder, ['--inspect-image', destination], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
      evidence.pageCapture.artifact = destination;
      evidence.pageCapture.decoded = decoded;
      evidence.pageCapture.visualEvidence = evaluateWgcMarkerEvidence(decoded, state.page, state.webContentsPhysicalBounds, state.webContentsPhysicalBounds);
      evidence.pageCapture.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    await sample('covered-after-capture-page');
    if (!startupOccluded) {
      state = await command('mutate'); assert.equal(state.page.contentRevision, 3);
      await sample('covered-new-revision-after-capture-page');
    }
    state = await command('uncover'); assert.equal(state.covered, false);
    await sample('owned-cover-removed');
    if (startupOccluded) {
      const beforeExposure = await doctor(), originalLayer = state.alwaysOnTop;
      evidence.topmostRecovery = { before: beforeExposure, originalLayer, layerRestored: false };
      try {
        state = await command('expose-topmost');
        assert.equal(state.alwaysOnTop, true); assert.equal(state.focused, false);
        const recovery = await sample('topmost-unfocused-recovery');
        state = await command('mutate'); assert.equal(state.page.contentRevision, 2);
        const newRevision = await sample('topmost-new-revision');
        evidence.topmostRecovery.currentMarkersRecovered = recovery.visualEvidence.matches;
        evidence.topmostRecovery.newRevisionMatches = newRevision.visualEvidence.matches;
        evidence.topmostRecovery.visibilityState = newRevision.state.page.visibilityState;
        evidence.topmostRecovery.animationFramesAdvanced = newRevision.state.page.animationFrames > recovery.state.page.animationFrames;
        evidence.topmostRecovery.after = await doctor();
        assert.equal(evidence.topmostRecovery.after.foreground.hwnd, beforeExposure.foreground.hwnd, 'Topmost owned exposure must not activate a window');
        assert.deepEqual(evidence.topmostRecovery.after.target.bounds, beforeExposure.target.bounds);
      } finally {
        state = await command('restore-layer');
        evidence.topmostRecovery.restoredState = state;
        assert.equal(state.alwaysOnTop, originalLayer, 'Restore the owned target layer after exposure');
        assert.equal(state.focused, false);
        evidence.topmostRecovery.layerRestored = true;
      }
    }
    evidence.passed = evidence.stages.every(stage => stage.visualEvidence.matches);
    evidence.conclusion = evidence.passed ? 'all_recorded_wgc_markers_match_current_dom' : 'wgc_current_dom_not_proven_for_every_stage';
  }

  try {
    const runtime = await cli(['status']); assert.equal(runtime.ok, true);
    assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase(), 'Use the actual development App from this checkout');
    report.appBuild = { pid: runtime.data.pid, buildId: runtime.data.build.buildId, startedAt: runtime.data.build.startedAt };
    const status = (await desktop(['status'])).result;
    assert.equal(status.available, true); assert.equal(status.session, null, 'Do not replace an existing desktop task');
    execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', `/out:${decoder}`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-fixture.cs'), path.join(root, 'scripts/e2e/assisted-foreground-fixture.cs')], { windowsHide: true, timeout: 30000 });
    await writeFile(fixturePath, fixtureSource);
    await writeFile(path.join(home, 'heartbeat'), new Date().toISOString());
    heartbeat = setInterval(() => { void writeFile(path.join(home, 'heartbeat'), new Date().toISOString()).catch(error => {
      report.cleanup.heartbeatError = error.message;
    }); }, 2000); heartbeat.unref();
    fixture = await launchWindowsUserProcess(electron, [fixturePath, path.join(home, 'owned-user-data'), home, ...(startupOnly ? ['startup-occluded'] : [])], root);
    assert.equal(fixture.administrator, false); report.fixtureLaunch = fixture;
    let state = await waitReply('ready'); report.initialState = state;
    await select(state, true);
    if (!startupOnly) {
      await capture('normal', state);
      await capture('image-only', state, true);
      state = await command('cover'); assert.equal(state.covered, true);
      await capture('covered', state, true);
      await command('uncover');
      state = await command('frameless'); await select(state);
      await capture('frameless', state, true);
      await freshness('default-throttle');
      await freshness('default-throttle-iframe');
    }
    await freshness('startup-occluded', startupOnly ? state : undefined);
    await freshness('startup-occluded-iframe');
    await desktop(['complete', '--session', session]);
    report.cleanup.session = (await desktop(['status'])).result.session;
    assert.notEqual(report.cleanup.session?.name, session); claimed = false;
    report.ok = report.freshness.every(value => value.passed);
    if (!report.ok) { report.error = { code: 'WGC_FRESHNESS_NOT_PROVEN', message: 'One or more owned DOM revisions did not appear in the actual WGC pixels. Diagnostic comparators are preserved; no production workaround was applied.' }; process.exitCode = 1; }
  } catch (error) {
    report.error = { message: error.message, code: error.code, stack: error.stack }; process.exitCode = 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const cleanup = await Promise.allSettled([
      (async () => {
        if (!claimed) return;
        let releaseError;
        try {
          // The service checks this unguessable task name. Releasing our exact
          // task is safe even if status is unavailable or the claim reply died.
          const response = await desktop(['release', '--session', session], null, 15000);
          report.cleanup.release = response;
          if (!response.ok && response.code !== 'DESKTOP_SESSION_ENDED') throw new Error('Owned WGC session release failed: ' + JSON.stringify(response));
        } catch (error) { releaseError = error; report.cleanup.releaseError = error.message; }
        // Try confirmation even when release failed; neither operation can
        // prevent the separate owned fixture cleanup from completing.
        report.cleanup.session = (await desktop(['status'], 0, 15000)).result.session;
        assert.notEqual(report.cleanup.session?.name, session, 'Owned WGC session is still active after cleanup');
        if (releaseError) throw releaseError;
      })(),
      (async () => {
        if (!fixture) return;
        try { await writeFile(commandFile, JSON.stringify({ id: 'shutdown-' + randomUUID(), action: 'quit' })); }
        catch (error) { report.cleanup.fixtureQuitError = error.message; }
        // A failed quit-file write must still reach the owned-executable check
        // and termination fallback. This script owns no management server.
        await delay(500); terminateOwnedWindowsProcess(fixture.pid, electron);
        report.cleanup.fixtureStopped = true;
      })()
    ]);
    cleanup.forEach((result, index) => {
      if (result.status === 'rejected') {
        report.cleanup[index === 0 ? 'sessionError' : 'fixtureError'] = result.reason?.message || String(result.reason);
        report.ok = false; process.exitCode = 1;
      }
    });
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), captures: report.captures.length, cleanup: report.cleanup }, null, 2));
  }
}
