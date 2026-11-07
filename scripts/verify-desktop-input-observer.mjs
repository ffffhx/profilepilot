import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';

// Default/--check only compiles. --run installs real global hooks in a unique
// owned Medium helper, so execution is gated and must be serialized by the user.
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every(value => value === '--check' || value === '--run'), 'Use --check (default) or --run.');
const run = args.includes('--run');
if (process.platform !== 'win32') throw new Error('Windows x64 observer acceptance only; macOS input guard is unchanged.');
if (run) await assertDesktopAcceptanceWindow();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'pp-input-observer-lifecycle-'));
const output = path.join(root, '.tools', 'desktop-verification', path.basename(home));
await mkdir(output, { recursive: true });
const nativeSource = path.join(root, 'native', 'input-observer-win.cs');
const coordinatorSource = path.join(root, 'scripts', 'e2e', 'desktop-input-observer-coordinator.cs');
const helper = path.join(home, 'InputObserverOwned.exe'), coordinator = path.join(home, 'InputObserverCoordinator.exe');
const coordinatorReport = path.join(output, 'coordinator.json');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compile = (source, executable) => execFileSync(path.join(framework, 'csc.exe'), [
  '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/optimize+', '/warnaserror+',
  `/out:${executable}`, '/r:System.Web.Extensions.dll', source
], { cwd: root, windowsHide: true, timeout: 20000, stdio: 'pipe' });
compile(nativeSource, helper); compile(coordinatorSource, coordinator);
const sourceSha256 = createHash('sha256').update(await readFile(nativeSource)).digest('hex');
if (!run) {
  console.log(JSON.stringify({ ok: true, mode: 'compile-only', helper, coordinator, sourceSha256, hookStarted: false, awaitingRealAcceptance: true }));
} else {
  const report = { ok: false, mode: 'no-input-lifecycle', startedUtc: new Date().toISOString(), sourceSha256,
    helper, coordinator, coordinatorReport, cleanup: {}, injectionPerformed: false, windowsCreated: false,
    limitations: ['This directly tests a new isolated native helper, not the running ProfilePilot App.',
      'The harness installs hooks only under --run. It does not inject input or prove physical-event provenance.',
      'Process exit confirms helper termination; explicit successful unhook calls and continuous OS hook delivery are not independently observable here.'] };
  let owned, result;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    owned = await launchWindowsUserProcess(coordinator, ['--run-native-lifecycle', helper, coordinatorReport], root);
    report.launch = owned;
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(coordinatorReport, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (result?.completedUtc) break;
      await delay(100);
    }
    assert.ok(result?.completedUtc, 'Native lifecycle coordinator did not complete within 70 seconds.');
    report.result = result;
    assert.equal(result.coordinatorPid, owned.pid);
    assert.equal(result.coordinatorIntegrity?.rid, 8192);
    assert.equal(result.coordinatorIntegrity?.elevated, false);
    assert.equal(result.cleanupJobAttached, true);
    assert.equal(result.ok, true, result.failure || 'Native lifecycle matrix failed.');
    assert.equal(result.cases.length, 5);
    for (const value of result.children) {
      assert.equal(value.executable, helper); assert.equal(value.integrity?.rid, 8192);
      assert.equal(value.integrity?.elevated, false); assert.equal(value.exitConfirmed, true);
      assert.equal(value.exitCode, 0); assert.equal(value.cleanupKilled, undefined);
      assert.ok(value.exitElapsedMs <= 2500); assert.equal(value.cleanupExitConfirmed, true);
      if (value.case.startsWith('blocked-stdout-')) assert.equal(value.stdoutPipeSaturated, true);
    }
    report.ok = true;
  } catch (error) { report.failure = error.message; process.exitCode = 1; }
  finally {
    // Unique executable paths and PID checks restrict fallback cleanup to this
    // run. The coordinator job also kills its descendants if it is interrupted.
    try { result = JSON.parse(await readFile(coordinatorReport, 'utf8')); } catch { }
    const cleanupErrors = [];
    if (owned) try { terminateOwnedWindowsProcess(owned.pid, coordinator); report.cleanup.coordinatorStopped = true; } catch (error) { cleanupErrors.push(error.message); }
    for (const value of result?.children || []) {
      if (value.executable !== helper || !Number.isSafeInteger(value.pid)) { cleanupErrors.push('Owned helper receipt identity mismatch.'); continue; }
      try { terminateOwnedWindowsProcess(value.pid, helper); } catch (error) { cleanupErrors.push(error.message); }
    }
    report.cleanup.childrenStopped = cleanupErrors.length === 0;
    if (cleanupErrors.length) { report.cleanup.errors = cleanupErrors; report.ok = false; process.exitCode = 1; }
    report.completedUtc = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), injectionPerformed: false, windowsCreated: false }));
  }
}
