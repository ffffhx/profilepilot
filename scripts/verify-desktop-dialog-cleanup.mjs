import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { retireNoticeChainOwned } from './verify-desktop-notice-chain.mjs';

export const ownedDialogSource = Object.freeze({
  report: '.tools/desktop-verification/pp-desktop-dialogs-U1qhiK/report.json',
  sha256: 'b2e9493dd6892bdfd3855e1ca3e45a85f7469235b42f7be86cd540f2b51c689e',
  nonce: '121dfac23b7bcd9c745a4c9e181e2aee',
  clientGuid: '121dfac2-3b7b-cd9c-745a-4c9e181e2aee',
  priorClearHresult: -2147467259
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => path.win32.resolve(value).toLowerCase();
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function cleanupProbeOptions(args) {
  assert.ok(args.length <= 1 && (!args.length || ['--check', '--run'].includes(args[0])), 'Use --check (default) or --run; no other client GUID or source report is permitted.');
  return { run: args[0] === '--run' };
}
// The immutable report bytes bind this diagnostic to the one previously owned
// client. Structured checks explain that evidence; they never authorize a new
// client or infer that the failed Clear left an empty history.
export function validateOwnedDialogSource(bytes) {
  assert.equal(digest(bytes), ownedDialogSource.sha256, 'Retained U1qhiK report changed');
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(value.ok, false); assert.equal(value.caseName, 'open'); assert.equal(value.cleanupAfterRelease, true);
  assert.equal(value.stages?.length, 1);
  const receipt = value.stages[0].receipt, identity = value.fixtureIdentity;
  assert.equal(receipt.nonce, ownedDialogSource.nonce); assert.equal(receipt.clientGuid, ownedDialogSource.clientGuid);
  assert.equal(receipt.clientGuid, receipt.nonce.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
  assert.equal(receipt.pid, identity.pid); assert.equal(receipt.startedUtcTicks, identity.startedUtcTicks);
  assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
  assert.equal(receipt.result, 0); assert.equal(receipt.showInvoked, true); assert.equal(receipt.showReturned, true);
  assert.equal(receipt.fileOkCalls, 1); assert.equal(receipt.acceptedFiles, 1);
  assert.equal(receipt.clientScoped, true); assert.equal(receipt.clientCleanupAttempted, true); assert.equal(receipt.clientCleared, false); assert.equal(receipt.originalRcwReleased, true);
  assert.equal(path.win32.basename(receipt.selectedPath), ownedDialogSource.nonce + '.txt');
  assert.equal(path.win32.basename(path.win32.dirname(receipt.selectedPath)), 'pp-desktop-dialogs-U1qhiK');
  assert.equal(receipt.failures?.length, 1); assert.equal(receipt.failures[0].operation, 'IFileDialog.ClearClientData');
  assert.equal(receipt.failures[0].hresult, ownedDialogSource.priorClearHresult);
  assert.equal(receipt.freshCleanup?.attempted, true); assert.equal(receipt.freshCleanup.clientScoped, true);
  assert.equal(receipt.freshCleanup.cleared, false); assert.equal(receipt.freshCleanup.released, true);
  assert.equal(receipt.freshCleanup.clearHresult, ownedDialogSource.priorClearHresult);
  assert.equal(receipt.freshCleanup.failures?.length, 1); assert.equal(receipt.freshCleanup.failures[0].operation, 'FreshIFileDialog.ClearClientData');
  assert.equal(receipt.freshCleanup.failures[0].hresult, ownedDialogSource.priorClearHresult);
  assert.equal(value.cleanup.session, null); assert.equal(value.cleanup.receipt.nonce, ownedDialogSource.nonce);
  assert.equal(value.cleanup.receipt.pid, identity.pid); assert.equal(value.cleanup.receipt.startedUtcTicks, identity.startedUtcTicks);
  assert.equal(value.cleanup.receipt.reason, 'requested'); assert.equal(value.cleanup.receipt.modal, false);
  assert.equal(value.cleanup.fixtureExit.ok, true); assert.equal(value.cleanup.fixtureExit.originalExited, true);
  return { ...ownedDialogSource, originalAcceptanceStillFailed: true, priorNormalFixtureExit: true };
}
function receiptIdentity(value, expected, identity) {
  assert.equal(value?.nonce, expected.nonce); assert.equal(value.clientGuid, ownedDialogSource.clientGuid);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0); assert.match(value.startedUtcTicks, /^[1-9]\d{15,18}$/);
  if (identity) { assert.equal(value.pid, identity.pid); assert.equal(value.startedUtcTicks, identity.startedUtcTicks); }
}
function readyReceipt(value, expected) {
  receiptIdentity(value, expected);
  assert.equal(value.protocol, 'profilepilot.dialog-cleanup-probe'); assert.equal(value.apartment, 'STA'); assert.equal(value.comAttempted, false);
  return value;
}
export function validateRawCleanupResult(value, expected, identity) {
  receiptIdentity(value, expected, identity);
  const result = value.result;
  assert.equal(result?.clientGuid, ownedDialogSource.clientGuid);
  for (const key of ['initializeHresult', 'createHresult', 'setClientGuidHresult', 'clearClientDataHresult'])
    assert.ok(Number.isInteger(result[key]) && result[key] >= -2147483648 && result[key] <= 2147483647, 'Missing raw HRESULT: ' + key);
  assert.ok([0, 1].includes(result.initializeHresult)); assert.equal(result.createHresult, 0); assert.equal(result.setClientGuidHresult, 0);
  for (const key of ['disposeAttempted', 'disposeReturned', 'rawInterfaceAcquired', 'rawInterfaceReleased', 'rcwAcquired', 'rcwReleased', 'comUninitialized']) assert.equal(result[key], true, key);
  assert.equal(result.rcwFinalReleaseCount, 0); assert.deepEqual(result.failures, []);
  assert.equal(result.showCalled, false); assert.equal(result.adviseCalled, false); assert.equal(result.historyAbsenceAsserted, false);
  return { rawHresult: result.clearClientDataHresult, rawHresultHex: '0x' + (result.clearClientDataHresult >>> 0).toString(16).padStart(8, '0'),
    clearReturnedSOk: result.clearClientDataHresult === 0, sameAsPriorExceptionHresult: result.clearClientDataHresult === ownedDialogSource.priorClearHresult,
    historyAbsenceAsserted: false, originalAcceptanceStillFailed: true };
}

export function noShowProbeLifecycle(expected, io) {
  let attempted = false, launched, pinned;
  function pin(identity, ready) {
    readyReceipt(ready, expected); assert.equal(identity?.ok, true);
    assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0);
    assert.match(identity.startedUtcTicks, /^[1-9]\d{15,18}$/);
    assert.ok(path.win32.isAbsolute(identity.executable) && path.win32.isAbsolute(expected.executable));
    assert.equal(normalize(identity.executable), normalize(expected.executable));
    assert.match(expected.sha256, /^[a-f0-9]{64}$/); assert.equal(identity.sha256, expected.sha256);
    assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
    if (launched) assert.equal(identity.pid, launched.pid);
    receiptIdentity(ready, expected, identity); pinned = Object.freeze({ ...identity }); return pinned;
  }
  return {
    get attempted() { return attempted; }, get identity() { return pinned; }, pin,
    async launch() { assert.equal(attempted, false); attempted = true; launched = await io.launch(); return launched; },
    async cleanup() {
      const result = { attempted, errors: [], closeRequested: false, identityRecovered: false, ok: !attempted };
      if (!attempted) return result;
      const fail = (stage, error) => result.errors.push({ stage, message: error.message });
      try {
        if (!pinned) { const ready = result.ready = readyReceipt(await io.ready(), expected); pin(await io.inspect(ready.pid), ready); result.identityRecovered = true; }
      } catch (error) { fail('identity', error); }
      // A launcher handshake failure must not suppress the nonce-only close.
      // Identity uncertainty suppresses force, never the private close request.
      try { await io.requestClose(); result.closeRequested = true; } catch (error) { fail('request-close', error); }
      try {
        const closed = result.receipt = await io.closed(); assert.ok(pinned, 'No verified identity');
        receiptIdentity(closed, expected, pinned); assert.equal(closed.reason, 'requested'); assert.equal(closed.normalReleaseConfirmed, true);
        assert.equal(typeof closed.comAttempted, 'boolean'); assert.equal(typeof closed.comFinished, 'boolean');
        if (closed.comAttempted) assert.equal(closed.comFinished, true);
      } catch (error) { fail('close-receipt', error); }
      if (pinned) { result.identity = pinned; try { result.exit = await retireNoticeChainOwned(pinned, io); } catch (error) { fail('exit', error); } }
      result.ok = !result.errors.length && result.closeRequested && result.exit?.ok === true;
      return result;
    }
  };
}
// Injectable orchestration is shared by real execution and pure failure tests.
// No go token is sent until the source, gate and exact ordinary child identity
// have been validated. A failure does not retry COM or create another child.
export async function runNoShowDiagnostic(expected, io) {
  const lifecycle = noShowProbeLifecycle(expected, io), report = { diagnosticCompleted: false, ok: false, cleanup: {}, comAuthorized: false };
  try {
    await io.gate();
    report.launch = await lifecycle.launch(); report.ready = readyReceipt(await io.ready(), expected);
    report.identity = lifecycle.pin(await io.inspect(report.ready.pid), report.ready);
    await io.go(); report.comAuthorized = true;
    report.raw = await io.result(); report.comparison = validateRawCleanupResult(report.raw, expected, report.identity);
    report.diagnosticCompleted = true;
  } catch (error) { report.error = { message: error.message, code: error.code }; }
  finally {
    report.cleanup = await lifecycle.cleanup();
    try { report.failureReceipt = await io.failure(); if (report.failureReceipt) throw new Error('Probe reported a failure or forced exit'); }
    catch (error) { report.failureReceiptError = error.message; }
    report.ok = report.diagnosticCompleted && report.cleanup.ok && !report.error && !report.failureReceiptError;
  }
  return report;
}
async function poll(read, label, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try { const value = await read(); if (performance.now() >= deadline) break; return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(40);
  }
  throw new Error(label + ' deadline');
}
async function optionalJson(file) { try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

export async function verifyDialogCleanup(options) {
  assert.equal(process.platform, 'win32', 'This isolated COM diagnostic is Windows-only.');
  const source = validateOwnedDialogSource(await readFile(path.join(root, ownedDialogSource.report)));
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-dialog-cleanup-probe-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const executable = path.join(home, 'DialogCleanupProbe.exe'), identityExe = path.join(home, 'Identity.exe'), base = path.join(home, 'probe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = (out, sourceFile, refs) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/target:exe', '/out:' + out,
    ...refs.map(name => '/r:' + name + '.dll'), path.join(root, sourceFile)], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  const report = { ok: false, mode: options.run ? 'run' : 'compile-only', startedAt: new Date().toISOString(), home, output, source,
    scope: 'isolated no-Show raw-HRESULT diagnostic; not a production desktop acceptance or history-absence test',
    okMeaning: 'The expected raw result was recorded and the exact owned process released COM and exited normally; ok does not mean ClearClientData succeeded.',
    limitations: ['Only the retained U1qhiK nonce-derived client GUID is used. No Show, Advise, options, folder, direct registry API or history enumeration is performed.',
      'ClearClientData may modify the state for that one owned GUID. HRESULT evidence does not prove all persisted history is absent and never rewrites prior failed acceptance.',
      'A new Medium STA process and a new IFileDialog instance differ from the prior dialog process. Equal or different HRESULTs narrow observations, not establish a root cause.',
      'The harness does not open a dialog, create a ProfilePilot session, install hooks or send input. Exact owned-process identity queries and a bounded forced cleanup fallback are possible; any forced exit fails this diagnostic.'],
    sources: ['https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-clearclientdata',
      'https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifiledialog-setclientguid',
      'https://learn.microsoft.com/en-us/dotnet/standard/native-interop/preserve-sig',
      'https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/ShObjIdl_core.h'] };
  let heartbeat;
  try {
    compile(executable, 'scripts/e2e/desktop-dialog-cleanup-probe.cs', ['System.Web.Extensions']);
    compile(identityExe, 'scripts/e2e/desktop-observer-fault-identity.cs', ['System.Web.Extensions', 'System.Management']);
    report.compiled = { executable, sha256: digest(await readFile(executable)), identityExe, identitySha256: digest(await readFile(identityExe)) };
    if (!options.run) { report.ok = true; report.executed = false; return report; }
    await assertDesktopAcceptanceWindow();
    const expected = { nonce: randomBytes(16).toString('hex'), executable, sha256: report.compiled.sha256 };
    report.nonce = expected.nonce;
    await writeFile(base + '.heartbeat', expected.nonce);
    report.heartbeatErrors = [];
    heartbeat = setInterval(() => { const now = new Date(); void utimes(base + '.heartbeat', now, now).catch(error => report.heartbeatErrors.push(error.message)); }, 1000);
    const inspect = args => JSON.parse(execFileSync(identityExe, args, { windowsHide: true, encoding: 'utf8', timeout: 15000 }).replace(/^\uFEFF/, ''));
    report.execution = await runNoShowDiagnostic(expected, {
      gate: assertDesktopAcceptanceWindow,
      launch: () => launchWindowsUserProcess(executable, ['--armed', base, expected.nonce, source.clientGuid], home),
      ready: () => poll(() => json(base + '.ready.json'), 'probe ready'),
      inspect: pid => inspect(['--inspect', String(pid)]),
      go: () => writeFile(base + '.go', expected.nonce + ':' + source.clientGuid),
      result: () => poll(async () => { const failure = await optionalJson(base + '.failure.json'); if (failure) throw new Error('Probe failed before result: ' + JSON.stringify(failure)); return json(base + '.result.json'); }, 'raw HRESULT result', 20000),
      requestClose: () => writeFile(base + '.close', expected.nonce),
      closed: () => poll(() => json(base + '.closed.json'), 'normal COM release and close'),
      wait: async (identity, milliseconds) => { const result = inspect(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, String(milliseconds)]); assert.equal(result.ok, true); assert.equal(typeof result.originalExited, 'boolean'); return result; },
      force: identity => inspect(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]),
      failure: () => optionalJson(base + '.failure.json')
    });
    report.ok = report.execution.ok && report.heartbeatErrors.length === 0; report.executed = true;
  } catch (error) { report.error = { message: error.message, code: error.code }; }
  finally {
    clearInterval(heartbeat); report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyDialogCleanup(cleanupProbeOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: report.ok, mode: report.mode, diagnosticCompleted: report.execution?.diagnosticCompleted,
    comparison: report.execution?.comparison, report: path.join(report.output, 'report.json') }));
  if (!report.ok) process.exitCode = 1;
}
