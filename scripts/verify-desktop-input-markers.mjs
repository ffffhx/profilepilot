import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assistedFixtureSource, compileAssistedPreparer, prepareAssistedForeground } from './e2e/assisted-foreground.mjs';

const args = process.argv.slice(2);
assert.ok(args.every(value => ['--check', '--run', '--browser-geometry', '--assisted-foreground'].includes(value)) && !(args.includes('--run') && args.includes('--check')), 'Use --check (default) or --run, optionally --browser-geometry and --assisted-foreground.');
const run = args.includes('--run'), geometry = args.includes('--browser-geometry');
const assistedForeground = args.includes('--assisted-foreground');
if (process.platform !== 'win32') throw new Error('Windows x64 native input-marker acceptance only; macOS is unchanged.');
if (run) await assertDesktopAcceptanceWindow();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'pp-input-markers-'));
const output = path.join(root, '.tools', 'desktop-verification', path.basename(home));
await mkdir(output, { recursive: true });
const helper = path.join(home, 'InputObserverOwned.exe'), fixture = path.join(home, 'InputMarkerFixture.exe');
const nativeSource = path.join(root, 'native', 'input-observer-win.cs');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compile = (source, target, gui = false) => execFileSync(path.join(framework, 'csc.exe'), [
  '/nologo', '/platform:x64', '/codepage:65001', '/optimize+', '/warnaserror+', `/target:${gui ? 'winexe' : 'exe'}`, `/out:${target}`,
  '/r:System.Web.Extensions.dll', ...(gui ? ['/r:System.Windows.Forms.dll', '/r:System.Drawing.dll'] : []), source, ...(gui ? [assistedFixtureSource] : [])
], { cwd: root, windowsHide: true, timeout: 20000, stdio: 'pipe' });
compile(nativeSource, helper); compile(path.join(root, 'scripts/e2e/desktop-input-marker-fixture.cs'), fixture, true);
const sourceSha256 = createHash('sha256').update(await readFile(nativeSource)).digest('hex');
if (!run) {
  if (assistedForeground) compileAssistedPreparer(home);
  console.log(JSON.stringify({ ok: true, mode: 'compile-only', helper, fixture, sourceSha256, hookStarted: false, guiStarted: false, awaitingRealAcceptance: true }));
} else {
  const resultFile = path.join(output, 'fixture.json');
  const report = { ok: false, mode: 'owned-injected-markers', startedUtc: new Date().toISOString(), sourceSha256,
    helper, fixture, fixtureReport: resultFile, geometryRequested: geometry, physicalHardwareCovered: false, assistedForeground, productAutonomousActivationProven: false, cleanup: {} };
  let launched, result;
  try {
    launched = await launchWindowsUserProcess(fixture, ['--run-owned-markers', helper, resultFile, ...(geometry ? ['--browser-geometry'] : []), ...(assistedForeground ? ['--assisted-foreground'] : [])], root);
    report.launch = launched;
    if (assistedForeground) {
      const fileBase = path.join(home, 'assisted-fixture'); let environment;
      const readyBy = Date.now() + 10000;
      while (Date.now() < readyBy) {
        try { environment = JSON.parse(await readFile(fileBase + '.environment.json', 'utf8')); if (environment.pid === launched.pid) break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(environment?.pid, launched.pid, 'Owned marker environment was not confirmed.');
      report.assistedForegroundPreparation = await prepareAssistedForeground({ enabled: true, directory: home, executable: fixture, fileBase,
        pid: launched.pid, startedUtcTicks: environment.startedUtcTicks, hwnd: environment.hwnd });
      assert.equal(report.assistedForegroundPreparation.ok, true, 'Assisted preparation failed; do not start hooks or test input.');
      await writeFile(fileBase + '.foreground.accepted', report.assistedForegroundPreparation.nonce, { flag: 'wx' });
    }
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(resultFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (result?.completedUtc) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(result?.completedUtc, 'Owned marker fixture did not complete within 70 seconds.'); report.result = result;
    assert.equal(result.fixturePid, launched.pid); assert.equal(result.fixtureIntegrity?.rid, 8192);
    assert.equal(result.fixtureIntegrity?.elevated, false); assert.equal(result.cleanupJobAttached, true);
    assert.equal(result.ok, true, result.failure || 'Owned marker acceptance failed.');
    assert.ok(result.checks.some(value => value.name === 'own-marker-ignored'));
    assert.ok(result.checks.some(value => value.name === 'foreign-latches-once-no-same-generation-revival'));
    assert.ok(result.checks.some(value => value.name === 'latched-predecessor-refuses-continuous-rearm'));
    assert.ok(result.checks.some(value => value.name === 'continuous-rearm-retains-marker-and-ignores-old-stop'));
    assert.ok(result.checks.some(value => value.name === 'new-child-old-marker-is-external'));
    assert.equal(result.children.length, 2);
    for (const child of result.children) {
      assert.equal(child.executable, helper); assert.equal(child.integrity?.rid, 8192); assert.equal(child.integrity?.elevated, false);
      assert.equal(child.exitConfirmed, true); assert.equal(child.exitCode, 0); assert.equal(child.cleanupKilled, undefined);
    }
    for (const receipt of result.ownedTestKeyReceipts) { assert.equal(receipt.down, receipt.up); assert.equal(receipt.nonForeground, 0); }
    const windowEvidence = result.windowMessageMarkerEvidence;
    assert.equal(windowEvidence?.source, 'GetMessageExtraInfo'); assert.equal(windowEvidence?.lowLevelHookEvidence, false);
    assert.equal(windowEvidence?.candidateLowWordsDistinct, true); assert.equal(windowEvidence?.overflow, false);
    assert.ok(windowEvidence.events.length > 0 && windowEvidence.events.length <= 16);
    for (const event of windowEvidence.events) {
      assert.match(event.receivedMarker, /^[0-9a-f]{16}$/); assert.match(event.sentMarker, /^[0-9a-f]{16}$/);
      assert.ok(['exact64', 'zero-extended-low32'].includes(event.matchMode));
      assert.equal(event.receivedMarker, event.matchMode === 'exact64' ? event.sentMarker : '00000000' + event.sentMarker.slice(8));
      assert.equal(event.nonForeground, 0);
    }
    report.geometryCovered = result.browserGeometry?.covered === true;
    report.ok = true;
  } catch (error) { report.failure = error.message; process.exitCode = 1; }
  finally {
    try { result = JSON.parse(await readFile(resultFile, 'utf8')); } catch { }
    const errors = [];
    if (launched) try { terminateOwnedWindowsProcess(launched.pid, fixture); report.cleanup.fixtureStopped = true; } catch (error) { errors.push(error.message); }
    for (const child of result?.children || []) {
      if (child.executable !== helper || !Number.isSafeInteger(child.pid)) { errors.push('Owned helper identity mismatch.'); continue; }
      try { terminateOwnedWindowsProcess(child.pid, helper); } catch (error) { errors.push(error.message); }
    }
    report.cleanup.childrenStopped = errors.length === 0;
    if (errors.length) { report.ok = false; report.cleanup.errors = errors; process.exitCode = 1; }
    report.completedUtc = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), geometryCovered: report.geometryCovered === true, physicalHardwareCovered: false }));
  }
}
