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
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';
import { retireNoticeChainOwned } from './verify-desktop-notice-chain.mjs';

export const dialogOptions = 0x02000000 | 0x1000 | 0x800 | 0x8 | 0x40 | 0x40000;
export const dialogLabels = Object.freeze({ file: 'Owned file', open: 'Open owned' });
export function parseOptions(args) {
  let execution, caseName = 'both', caseSpecified = false, cleanupAfterRelease = false;
  const usage = 'Use --check (default) or --run, optionally --case cancel|open|both. --cleanup-after-release requires one explicit cancel/open case.';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--check' || argument === '--run') { assert.equal(execution, undefined, usage); execution = argument; }
    else if (argument === '--cleanup-after-release') { assert.equal(cleanupAfterRelease, false, usage); cleanupAfterRelease = true; }
    else if (argument === '--case') {
      assert.equal(caseSpecified, false, usage); caseSpecified = true; caseName = args[++index];
      assert.ok(['cancel', 'open', 'both'].includes(caseName), usage);
    } else assert.fail(usage);
  }
  assert.ok(!cleanupAfterRelease || caseSpecified && caseName !== 'both', usage);
  return { run: execution === '--run', caseName, ...(cleanupAfterRelease ? { cleanupAfterRelease } : {}) };
}
export function dialogPlan(caseName) {
  assert.ok(['cancel', 'open', 'both'].includes(caseName), 'Unknown dialog case');
  return (caseName === 'both' ? ['cancel', 'open'] : [caseName]).map((mode, index) => ({ mode, sequence: index + 1 }));
}
const normalize = value => path.win32.resolve(value).toLowerCase();
export function assertFixtureReceipt(value, expected) {
  for (const field of ['nonce', 'pid', 'startedUtcTicks']) assert.equal(value?.[field], expected[field], 'Receipt identity: ' + field);
}
export function exactWindow(windows, receipt) {
  assert.match(receipt.hwnd, /^[1-9][0-9]*$/);
  const matches = windows.filter(window => window.pid === receipt.pid && window.nativeHandle === receipt.hwnd && window.title === receipt.title);
  assert.equal(matches.length, 1, 'Expected exactly one owned PID/HWND/title window');
  if (receipt.className) assert.equal(matches[0].className, receipt.className);
  return matches[0];
}
export function dialogControl(observation, kind, expected) {
  assert.ok(expected?.windowId && expected?.title, 'Require the previously verified owned dialog identity');
  assert.equal(observation.windowId, expected.windowId, 'Observation must belong to the selected owned dialog');
  const roots = observation.elements.filter(element => element.parent < 0);
  assert.equal(roots.length, 1); assert.equal(roots[0].role, 'Window'); assert.equal(roots[0].name, expected.title);
  const label = dialogLabels.file;
  const labelled = element => element?.name === label || element?.name === label + ':';
  const filename = element => {
    if (element.role !== 'Edit' || !element.actions.includes('set_value') || element.automationId === 'SearchEditBox' || element.automationId?.startsWith('System.')) return false;
    let matchesLabel = labelled(element);
    const visited = new Set();
    for (let parent = element.parent; Number.isInteger(parent) && parent >= 0 && !visited.has(parent);) {
      visited.add(parent); const ancestor = observation.elements[parent];
      if (!ancestor || ancestor.role === 'ListItem') return false;
      if (ancestor.role === 'ComboBox' && labelled(ancestor)) matchesLabel = true;
      if (ancestor === roots[0]) return matchesLabel;
      parent = ancestor.parent;
    }
    return false;
  };
  const matches = observation.elements.filter(element => {
    if (kind === 'file') return filename(element);
    if (kind === 'cancel') return element.role === 'Button' && element.actions.includes('invoke') && element.automationId === '2';
    if (kind === 'open') return element.role === 'Button' && element.actions.includes('invoke') && element.automationId === '1' && element.name === dialogLabels.open;
    return false;
  });
  assert.equal(matches.length, 1, 'Expected exactly one observed dialog control: ' + kind);
  assert.equal(matches[0].password, false); assert.notEqual(matches[0].enabled, false); assert.notEqual(matches[0].offscreen, true);
  return matches[0];
}
export function assertActionCompleted(response) {
  if (response?.ok !== true || response.result?.executed !== true) throw Object.assign(new Error('Input was not confirmed; stop without replay or recovery.'), {
    code: response?.code || 'DIALOG_ACTION_UNCONFIRMED', response, outcome: 'unknown'
  });
}
export async function invokeOwnedDialog(invoke, waitForDialog) {
  const response = await invoke(); assertActionCompleted(response);
  return { response, dialog: await waitForDialog() };
}
export function assertDialogResult(value, { mode, sequence, file, identity }) {
  assertFixtureReceipt(value, identity);
  const diagnostics = JSON.stringify({ error: value.error, failures: value.failures, result: value.result, resultHex: value.resultHex,
    showInvoked: value.showInvoked, showReturned: value.showReturned, clientScoped: value.clientScoped, clientCleanupAttempted: value.clientCleanupAttempted });
  assert.equal(value.ok, true, diagnostics); assert.deepEqual(value.failures, [], diagnostics);
  assert.equal(value.mode, mode); assert.equal(value.sequence, sequence);
  assert.equal(value.showInvoked, true); assert.equal(value.showReturned, true);
  assert.equal(value.clientScoped, true); assert.equal(value.clientCleanupAttempted, true);
  const clientGuid = identity.nonce.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  assert.equal(value.clientGuid, clientGuid, 'Cleanup must use only this fixture nonce client GUID');
  assert.equal(value.clientCleared, true); assert.equal(value.workingDirectoryRestored, true); assert.equal(value.parentEnabled, true); assert.equal(value.closing, false);
  assert.equal(value.sentinels, 0); assert.equal(value.reentrant, 0);
  if (mode === 'cancel') { assert.equal(value.result, -2147023673); assert.equal(value.selectedPath, null); assert.equal(value.acceptedFiles, 0); }
  else { assert.equal(value.result, 0); assert.equal(path.win32.isAbsolute(value.selectedPath), true); assert.equal(normalize(value.selectedPath), normalize(file)); assert.ok(value.fileOkCalls >= 1); assert.ok(value.acceptedFiles >= 1); }
}
export async function cleanupDialogAcceptance({ session, fixture, fixtureAttempted, fixtureIdentity, executable, nonce, fixtureSha256 }, { desktop, writeClose, readReady, readClosed, inspect }) {
  const cleanup = {}; let ok = true;
  try {
    const current = await desktop(['status'], 15000); assert.equal(current.ok, true);
    if (current.result.session?.name === session) { const released = await desktop(['release', '--session', session], 15000); assert.equal(released.ok, true); }
    const after = await desktop(['status'], 15000); assert.equal(after.ok, true); cleanup.session = after.result.session;
    assert.notEqual(after.result.session?.name, session);
  } catch (error) { cleanup.sessionError = error.message; ok = false; }
  // Management failure cannot skip independent retirement of the owned fixture.
  if (fixtureAttempted || fixture) {
    cleanup.fixtureAttempted = true;
    let pinned;
    try {
      assert.match(nonce, /^[a-f0-9]{32}$/); assert.ok(path.win32.isAbsolute(executable)); assert.match(fixtureSha256, /^[a-f0-9]{64}$/);
      let ready, value = fixtureIdentity;
      if (!value) {
        // Launch may have created a detached process and then thrown while
        // returning its handshake. Recover only from this private nonce file.
        ready = cleanup.ready = await readReady();
        assert.equal(ready.nonce, nonce); assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
        assert.match(ready.startedUtcTicks, /^[1-9]\d{15,18}$/); assert.match(ready.hwnd, /^[1-9]\d*$/);
        assert.equal(ready.administrator, false); assert.equal(ready.dialogApi, 'IFileOpenDialog'); assert.equal(ready.addToRecent, false);
        if (fixture) assert.equal(ready.pid, fixture.pid);
        value = await inspect(['--inspect', String(ready.pid)]);
      }
      const expectedPid = fixture?.pid ?? ready?.pid ?? value.pid;
      assert.ok(Number.isSafeInteger(expectedPid) && expectedPid > 0);
      assert.ok(path.win32.isAbsolute(value.executable));
      assertOwnedIdentity(value, { pid: expectedPid, executable, sha256: fixtureSha256 });
      assert.match(value.startedUtcTicks, /^[1-9]\d{15,18}$/);
      if (ready) assert.equal(value.startedUtcTicks, ready.startedUtcTicks);
      pinned = cleanup.fixtureIdentity = Object.freeze({ ...value }); cleanup.identityRecovered = Boolean(ready);
    } catch (error) { cleanup.identityError = error.message; ok = false; }
    // Recover a full identity while it is live, then always send nonce close,
    // including a missing PID/readiness, invalid identity or failed App status.
    try {
      await writeClose(); cleanup.closeRequested = true;
    } catch (error) { cleanup.closeError = error.message; ok = false; }
    try {
      cleanup.receipt = await readClosed(); assert.equal(cleanup.receipt.nonce, nonce);
      assert.ok(pinned, 'No verified fixture identity for close receipt');
      assertFixtureReceipt(cleanup.receipt, { nonce, pid: pinned.pid, startedUtcTicks: pinned.startedUtcTicks });
      assert.equal(cleanup.receipt.reason, 'requested'); assert.equal(cleanup.receipt.modal, false);
    } catch (error) { cleanup.receiptError = error.message; ok = false; }
    if (pinned) try {
      const retired = cleanup.fixtureRetirement = await retireNoticeChainOwned(pinned, {
        wait: async (value, milliseconds) => {
          const result = await inspect(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, String(milliseconds)]);
          assert.equal(result.ok, true); assert.equal(typeof result.originalExited, 'boolean'); return result;
        },
        force: value => inspect(['--cleanup-owned', String(value.pid), value.startedUtcTicks, value.executable, value.sha256, String(value.parentPid)])
      });
      cleanup.fixtureExit = retired.afterForce ?? retired.wait;
      cleanup.forcedAttempts = retired.forcedAttempts;
      if (!retired.ok) { cleanup.fixtureError = retired.forcedAttempts.length ? 'Forced fixture cleanup was needed; acceptance failed' : 'Original fixture retirement was not clean'; ok = false; }
    } catch (error) { cleanup.fixtureError = error.message; ok = false; }
  }
  return { ok, cleanup };
}
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function poll(read, accept, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args); assert.equal(process.platform, 'win32', 'Windows native dialog acceptance only.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-dialogs-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const reportFile = path.join(output, 'report.json'), nonce = randomBytes(16).toString('hex');
  const state = path.join(home, 'state'), file = path.join(home, nonce + '.txt');
  const executable = path.join(home, 'DialogFixture.exe'), identityExe = path.join(home, 'DialogIdentity.exe');
  const entry = path.join(root, 'dist/main/profilepilot-cli.cjs'), session = 'dialogs-' + randomUUID();
  const report = { ok: false, mode: options.run ? 'actual-app' : 'compile-only', caseName: options.caseName, cleanupAfterRelease: options.cleanupAfterRelease === true,
    plannedCases: dialogPlan(options.caseName), startedAt: new Date().toISOString(), output,
    scope: 'Owned Medium WinForms buttons synchronously open genuine IFileOpenDialog through actual App UIA Invoke; only one precreated nonce file may be selected.',
    checks: [], stages: [], commands: [], cleanup: {}, fixtureStarted: false, inputActionCommandsSent: 0,
    limitations: ['No screenshot, hardware input, or user document is requested.', 'Framework lacks public AddToRecent; the fixture uses documented native COM options, not reflection.',
      'A modal Invoke timeout or unknown result ends acceptance without replay, resume, another stage or another control route.',
      'One Windows display and ordinary-token App; no macOS, mixed-DPI or cross-integrity claim.',
      'The fixture attempts to clear only its nonce-derived IFileDialog client GUID. A failed clear does not prove persisted state is absent; default user dialog history is never cleared.'] };
  const persist = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  let fixture, fixtureIdentity, heartbeat, appIdentity, runtimeStarted = false, fixtureAttempted = false;
  const inspect = args => JSON.parse(execFileSync(identityExe, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  const receiptIdentity = () => ({ nonce, pid: fixture.pid, startedUtcTicks: fixtureIdentity.startedUtcTicks });
  async function cli(parameters, timeoutMs = 70000) {
    const record = { parameters, startedAt: new Date().toISOString() }; report.commands.push(record);
    try {
      const result = await runDesktopCliProcess({ entry, args: [...parameters, '--json'], cwd: root, env, expectedExitCode: null, timeoutMs });
      record.exitCode = result.exitCode; record.response = result.response; return result.response;
    } catch (error) { record.error = { code: error.code, message: error.message, outcome: error.outcome }; throw error; }
    finally { record.finishedAt = new Date().toISOString(); await persist(); }
  }
  const desktop = (parameters, timeout) => cli(['desktop', ...parameters], timeout);
  async function successful(parameters) { const value = await desktop(parameters); assert.equal(value.ok, true, JSON.stringify(value)); return value.result; }
  const observe = () => successful(['observe', '--session', session]);
  const byName = (observation, name) => { const found = observation.elements.filter(item => item.name === name); assert.equal(found.length, 1, name); return found[0]; };
  async function action(observation, element, kind, extra = {}) {
    const parameters = { version: observation.version, ref: element.reference, kind, ...extra };
    const request = path.join(home, 'action-' + randomUUID() + '.json'); await writeFile(request, JSON.stringify(parameters));
    report.inputActionCommandsSent++;
    return desktop(['action', '--session', session, '--params-file', request, '--request-id', randomUUID()]);
  }
  const readReceipt = suffix => poll(() => json(state + suffix), value => {
    assertFixtureReceipt(value, receiptIdentity()); return true;
  }, suffix);
  async function stale(observation, element) {
    const response = await action(observation, element, 'invoke'); assert.equal(response.ok, false); assert.equal(response.code, 'DESKTOP_OBSERVATION_STALE'); return response;
  }
  try {
    const sources = ['scripts/e2e/desktop-dialog-fixture.cs', 'scripts/e2e/desktop-observer-fault-identity.cs'];
    report.sources = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(path.join(root, name)))])));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compile = (destination, source, references, target) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/warnaserror+', '/target:' + target,
      '/out:' + destination, ...references.map(name => '/r:' + name), path.join(root, source)], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    compile(executable, sources[0], ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'], 'winexe');
    compile(identityExe, sources[1], ['System.Management.dll', 'System.Web.Extensions.dll'], 'exe');
    for (const source of sources) assert.equal(hash(await readFile(path.join(root, source))), report.sources[source]);
    report.compiled = { fixture: hash(await readFile(executable)), identity: hash(await readFile(identityExe)) };
    if (!options.run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    runtimeStarted = true;
    const runtime = await cli(['status']); assert.equal(runtime.ok, true);
    assert.equal(normalize(runtime.data.build.entry), normalize(path.join(root, 'dist/main/entry.js')));
    report.app = { pid: runtime.data.pid, build: runtime.data.build };
    const manifest = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(manifest.buildId, runtime.data.build.buildId);
    const artifacts = ['dist/main/profilepilot-cli.cjs', 'dist/main/entry.js', 'dist/native/ProfilePilot.Desktop.exe', 'dist/native/ProfilePilot.InputObserver.exe'];
    report.artifacts = Object.fromEntries(await Promise.all(artifacts.map(async name => [name, hash(await readFile(path.join(root, name)))])));
    for (const name of artifacts) assert.equal(report.artifacts[name], manifest.components[name], 'Artifact changed: ' + name);
    assert.equal(manifest.cliSha256, report.artifacts[artifacts[0]]);
    appIdentity = report.appIdentity = inspect(['--inspect', String(runtime.data.pid)]);
    const appExecutable = path.join(root, 'node_modules/electron/dist/electron.exe');
    assertOwnedIdentity(appIdentity, { pid: runtime.data.pid, executable: appExecutable, sha256: hash(await readFile(appExecutable)) });
    report.initialStatus = await successful(['status']); assert.equal(report.initialStatus.session, null, 'Do not replace another session');
    await writeFile(file, 'Owned dialog fixture ' + nonce + '\n', { flag: 'wx' });
    await writeFile(state + '.heartbeat', nonce, { flag: 'wx' });
    heartbeat = setInterval(() => { const now = new Date(); void utimes(state + '.heartbeat', now, now).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
    fixtureAttempted = report.fixtureLaunchAttempted = true;
    fixture = await launchWindowsUserProcess(executable, [state, nonce, file, ...(options.cleanupAfterRelease ? ['--cleanup-after-release'] : [])], home); report.fixtureStarted = true;
    fixtureIdentity = report.fixtureIdentity = inspect(['--inspect', String(fixture.pid)]);
    assertOwnedIdentity(fixtureIdentity, { pid: fixture.pid, executable, sha256: report.compiled.fixture });
    const ready = report.fixture = await readReceipt('.ready.json'); assert.equal(ready.administrator, false); assert.equal(ready.addToRecent, false);
    assert.equal(normalize(ready.allowedFile), normalize(file));
    let parent = exactWindow((await successful(['windows'])).windows, ready);
    assert.equal(parent.enabled, true); assert.equal(parent.minimized, false);
    await successful(['claim', '--session', session, '--window', parent.id]);
    for (const { mode, sequence } of report.plannedCases) {
      const stage = { mode, sequence }; report.stages.push(stage);
      const before = stage.parentObservation = await observe();
      const opener = byName(before, (mode === 'cancel' ? 'Open cancellation dialog ' : 'Open selection dialog ') + nonce);
      const sentinel = byName(before, 'Parent sentinel ' + nonce);
      assert.ok(opener.actions.includes('invoke'));
      const began = performance.now();
      const invoked = await invokeOwnedDialog(() => action(before, opener, 'invoke'), () => readReceipt('.dialog-' + sequence + '.json'));
      stage.invoke = invoked.response; stage.invokeElapsedMs = performance.now() - began; stage.dialog = invoked.dialog;
      assert.equal(stage.dialog.sequence, sequence); assert.equal(stage.dialog.mode, mode); assert.equal(stage.dialog.ownerHwnd, ready.hwnd);
      assert.equal(stage.dialog.addToRecent, false); assert.equal(stage.dialog.options, dialogOptions);
      stage.opening = await readReceipt('.opening-' + sequence + '.json'); assert.equal(stage.opening.options & dialogOptions, dialogOptions);
      assert.equal(stage.opening.fileLabel, dialogLabels.file); assert.equal(stage.opening.openLabel, dialogLabels.open);
      const openedCatalog = (await successful(['windows'])).windows;
      const target = stage.dialogWindow = exactWindow(openedCatalog, stage.dialog); assert.notEqual(target.nativeHandle, parent.nativeHandle);
      stage.disabledParent = exactWindow(openedCatalog, ready);
      assert.equal(stage.disabledParent.enabled, false); assert.equal(target.enabled, true); assert.equal(target.minimized, false);
      assert.equal(target.ownerNativeHandle, ready.hwnd, 'Product catalog must report the actual Win32 owner relation');
      await successful(['select', '--session', session, '--window', target.id]);
      let observed = stage.dialogObservation = await observe();
      stage.staleParent = await stale(before, sentinel);
      observed = stage.controlObservation = await observe();
      const dialogScope = { windowId: target.id, title: stage.dialog.title };
      if (mode === 'open') {
        stage.inputRoute = 'filename-set-value';
        stage.fileControl = dialogControl(observed, 'file', dialogScope);
        assertActionCompleted(stage.fill = await action(observed, stage.fileControl, 'set_value', { value: file }));
        observed = stage.afterFill = await observe();
        assert.equal(dialogControl(observed, 'file', dialogScope).text, file, 'Fresh UIA must confirm the exact owned file path');
      }
      const closer = stage.closeControl = dialogControl(observed, mode, dialogScope);
      assertActionCompleted(stage.close = await action(observed, closer, 'invoke'));
      stage.receipt = await readReceipt('.result-' + sequence + '.json');
      assertDialogResult(stage.receipt, { mode, sequence, file, identity: receiptIdentity() });
      const catalog = (await successful(['windows'])).windows;
      assert.equal(catalog.some(window => window.pid === fixture.pid && window.nativeHandle === stage.dialog.hwnd), false, 'Closed dialog must be gone');
      parent = exactWindow(catalog, ready); assert.equal(parent.enabled, true); await successful(['select', '--session', session, '--window', parent.id]);
      stage.restoredParent = await observe(); assert.equal(byName(stage.restoredParent, 'Parent sentinel ' + nonce).enabled, true);
      stage.staleDialog = await stale(observed, closer);
      const stateReceipt = stage.state = await readReceipt('.state.json');
      assert.equal(stateReceipt.sequence, sequence); assert.equal(stateReceipt.sentinels, 0); assert.equal(stateReceipt.reentrant, 0); assert.equal(stateReceipt.modal, false);
      report.checks.push(mode + ': confirmed UIA modal Invoke, exact native dialog select, stale refs refused, actual result and parent recovery'); await persist();
    }
    await successful(['complete', '--session', session, '--require-active']);
    const finalRuntime = await cli(['status']); assert.equal(finalRuntime.ok, true); assert.equal(finalRuntime.data.pid, report.app.pid);
    for (const key of ['buildId', 'startedAt', 'entry']) assert.equal(finalRuntime.data.build[key], report.app.build[key]);
    assertOwnedIdentity(inspect(['--inspect', String(report.app.pid)]), { pid: report.app.pid, executable: appIdentity.executable, sha256: appIdentity.sha256, original: appIdentity });
    for (const name of artifacts) assert.equal(hash(await readFile(path.join(root, name))), report.artifacts[name]);
    report.ok = true;
  } catch (error) {
    report.error = { code: error.code, message: error.message, stack: error.stack, outcome: error.outcome };
    // File receipts remain readable if a modal Invoke blocks the product worker.
    if (fixture) for (const suffix of ['.state.json', '.opening-1.json', '.dialog-1.json', '.result-1.json', '.opening-2.json', '.dialog-2.json', '.result-2.json', '.fixture-error.json']) {
      try { const value = await json(state + suffix); assertFixtureReceipt(value, receiptIdentity()); (report.failureReceipts ||= {})[suffix] = value; } catch { /* Not all stages were reached. */ }
    }
  } finally {
    if (runtimeStarted) {
      const retired = await cleanupDialogAcceptance({ session, fixture, fixtureAttempted, fixtureIdentity, executable, nonce, fixtureSha256: report.compiled?.fixture }, {
        desktop, inspect, writeClose: () => writeFile(state + '.close', nonce),
        readReady: () => poll(() => json(state + '.ready.json'), () => true, 'private owned ready for cleanup', 3000),
        readClosed: () => poll(() => json(state + '.closed.json'), () => true, 'private owned close receipt')
      });
      Object.assign(report.cleanup, retired.cleanup); if (retired.cleanup.fixtureIdentity) report.fixtureIdentity = retired.cleanup.fixtureIdentity;
      if (!retired.ok) report.ok = false;
    }
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: reportFile, checks: report.checks.length, fixtureStarted: report.fixtureStarted, cleanup: report.cleanup }));
  }
  return report;
}
if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  try { if (!(await main()).ok) process.exitCode = 1; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
