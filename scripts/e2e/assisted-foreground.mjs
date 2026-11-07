import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDesktopAcceptanceWindow } from './desktop-acceptance-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const assistedFixtureSource = path.join(root, 'scripts/e2e/assisted-foreground-fixture.cs');
// Test setup only. This machine's owned WM_* path discarded upper marker bits
// even with x64 endpoints. The observation does not establish an integrity-level
// cause. Production SendInput and low-level hook markers remain 64-bit.
export function createAssistedForegroundMarker(bytes = randomBytes) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const value = bytes(4);
    assert.ok(Buffer.isBuffer(value) && value.length === 4, 'Expected four random marker bytes.');
    const marker = value.toString('hex');
    if (marker !== '00000000') return '00000000' + marker;
  }
  throw new Error('ASSISTED_RANDOM_MARKER_UNAVAILABLE');
}
export function validateAssistedTarget(value) {
  assert.equal(value.enabled, true, 'Explicit --assisted-foreground is required.');
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  assert.match(value.startedUtcTicks, /^[1-9][0-9]{15,18}$/);
  assert.match(value.hwnd, /^[1-9][0-9]*$/);
  const directory = path.resolve(value.directory), executable = path.resolve(value.executable), fileBase = path.resolve(value.fileBase);
  assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.match(path.basename(directory), /^(pp-desktop-|profilepilot-desktop-|pp-input-markers-)[A-Za-z0-9_-]+$/);
  assert.equal(path.dirname(executable).toLowerCase(), directory.toLowerCase());
  assert.equal(path.dirname(fileBase).toLowerCase(), directory.toLowerCase());
  assert.ok(['DesktopFixture.exe', 'DesktopKeyboardFixture.exe', 'InputMarkerFixture.exe'].includes(path.basename(executable)));
  return { ...value, directory, executable, fileBase };
}
export function compileAssistedPreparer(directory) {
  const executable = path.join(directory, 'AssistedForegroundPreparer.exe');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64',
    '/main:AssistedForegroundPreparer', `/out:${executable}`, '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(root, 'native/desktop/input-delivery.cs'), path.join(root, 'native/desktop/pointer-coordinates.cs'),
    path.join(root, 'scripts/e2e/assisted-foreground-policy.cs'), path.join(root, 'scripts/e2e/assisted-foreground-preparer.cs'), assistedFixtureSource],
  { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  return executable;
}
async function json(file) {
  try { const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768); return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
}

/** One explicit setup attempt. It never retries a click, starts/reconnects an
 * application, elevates the token, or treats prepared focus as product ability. */
export async function prepareAssistedForeground(options) {
  const value = validateAssistedTarget(options);
  await assertDesktopAcceptanceWindow();
  for (const entry of [value.directory, value.executable]) assert.equal((await lstat(entry)).isSymbolicLink(), false);
  const preparer = compileAssistedPreparer(value.directory);
  const nonce = randomBytes(16).toString('hex'), marker = createAssistedForegroundMarker();
  const expected = { directory: value.directory, executable: value.executable, fileBase: value.fileBase,
    pid: value.pid, startedUtcTicks: value.startedUtcTicks, hwnd: value.hwnd, nonce, marker };
  const evidence = { ok: false, assistedForeground: true, productAutonomousActivationProven: false,
    markerBits: 32, markerEvidence: 'owned-window-message-extra-info', lowLevelHookEvidence: false,
    markerCompatibilityBasis: 'Observed WM message path truncation; integrity-level causation is not established.',
    preparerIntegrityRid: null, nonce, marker, targetPid: value.pid, startedAt: new Date().toISOString() };
  const expectedFile = value.fileBase + '.foreground.expected.json';
  const expiresAt = Date.now() + 8000;
  let requested = false;
  try {
    await writeFile(expectedFile, JSON.stringify(expected), { flag: 'wx' });
    await writeFile(value.fileBase + '.foreground.request.json', JSON.stringify({ nonce, marker, expiresAt }), { flag: 'wx' }); requested = true;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const manifest = await json(value.fileBase + '.foreground.manifest.json');
      if (manifest?.nonce === nonce && manifest?.marker === marker) { evidence.manifest = manifest; break; }
      await sleep(20);
    }
    assert.ok(evidence.manifest, 'ASSISTED_MANIFEST_UNAVAILABLE');
    // No shell, runas verb, token duplication, or alternate privileged process.
    try {
      evidence.preparer = JSON.parse(execFileSync(preparer, ['--prepare', expectedFile], {
        windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536
      }));
    } catch (error) {
      evidence.preparer = await json(value.fileBase + '.foreground.preparer.json');
      evidence.processFailure = { code: typeof error.code === 'string' ? error.code : 'PREPARER_FAILED',
        status: error.status ?? null, signal: error.signal ?? null, releaseUnconfirmed: evidence.preparer?.releaseObserved !== true };
    }
    evidence.preparerIntegrityRid = evidence.preparer?.preparerIntegrityRid ?? null;
    evidence.ok = evidence.preparer?.ok === true && evidence.preparer?.foregroundConfirmed === true && evidence.preparer?.releaseObserved === true;
  } catch (error) { evidence.error = /^ASSISTED_[A-Z_]+$/.test(error.message) ? error.message : 'ASSISTED_PREPARATION_FAILED'; }
  finally {
    if (requested) {
      await writeFile(value.fileBase + '.foreground.done', nonce).catch(() => { evidence.restoreSignalFailed = true; });
      const deadline = Math.min(expiresAt + 1000, Date.now() + 2000);
      while (Date.now() < deadline) {
        let receipt;
        try { receipt = await json(value.fileBase + '.foreground.receipt.json'); }
        catch { evidence.restoreReceiptReadFailed = true; break; }
        if (receipt?.nonce === nonce) { evidence.receipt = receipt; if (receipt.topMostRestored === true) break; }
        await sleep(20);
      }
    }
    evidence.topMostRestoredConfirmed = evidence.receipt?.topMostRestored === true;
    evidence.ok = evidence.ok && evidence.topMostRestoredConfirmed;
    evidence.finishedAt = new Date().toISOString();
    await writeFile(value.fileBase + '.foreground.evidence.json', JSON.stringify(evidence, null, 2)).catch(() => { evidence.evidenceWriteFailed = true; evidence.ok = false; });
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--check'], 'This module supports --check only; fixtures opt in explicitly.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-assisted-check-'));
  const executable = compileAssistedPreparer(directory);
  const result = JSON.parse(execFileSync(executable, ['--check'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  console.log(JSON.stringify({ ...result, executable }));
}
