import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assistedFixtureSource, compileAssistedPreparer, prepareAssistedForeground } from './e2e/assisted-foreground.mjs';

if (process.platform !== 'win32') throw new Error('Desktop keyboard acceptance requires Windows; macOS native desktop is unsupported.');
assert.ok(process.argv.slice(2).every(value => ['--compile-only', '--assisted-foreground'].includes(value)), 'Use --compile-only or explicit --assisted-foreground.');
const compileOnly = process.argv.includes('--compile-only');
const assistedForeground = process.argv.includes('--assisted-foreground');
// The shared local constraint is checked before any App/desktop query or GUI
// launch. Compile-only does not inspect desktop state or start the executable.
if (!compileOnly) await assertDesktopAcceptanceWindow();
await main();

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-keyboard-'));
  const output = path.join(root, '.tools', 'desktop-verification', path.basename(home));
  await mkdir(output, { recursive: true });
  const executable = path.join(home, 'DesktopKeyboardFixture.exe');
  const state = path.join(home, 'fixture');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', '/codepage:65001',
    `/out:${executable}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    path.join(root, 'scripts/e2e/desktop-keyboard-fixture.cs'), assistedFixtureSource], { windowsHide: true, timeout: 30000 });
  if (compileOnly) {
    if (assistedForeground) compileAssistedPreparer(home);
    console.log(JSON.stringify({ ok: true, mode: 'compile-only', executable, guiStarted: false }));
    return;
  }

  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const session = 'keyboard-' + randomUUID();
  const report = { ok: false, startedAt: new Date().toISOString(), assistedForeground, productAutonomousActivationProven: false,
    scope: assistedForeground ? 'Explicit assisted foreground setup clicks only the owned fixture pad; all test actions then use the Medium App CLI.' : 'Medium-token owned WinForms fixture through the running development App CLI; no direct input injection by this harness.',
    checks: [], actions: [], preflights: [], receipts: {}, markerChecks: [], cleanup: {}, limitations: [
      'Windows only; this run does not validate macOS, IMEs, every keyboard layout, or physical/injected event provenance.',
      'Doctor samples the App catalog helper. It records foreground but does not establish an atomic guarantee before the action.',
      'The focus-transfer check is a real event race in this fixture, not proof that every application changes focus synchronously.',
      'GetMessageExtraInfo counters cover only owned WM messages and may discard upper marker bits. Stable values do not prove complete 64-bit delivery to a low-level hook, authenticate provenance, or enable automatic user takeover.'
    ] };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let fixture, target, claimed = false;

  async function cli(args, expected = 0) {
    try { return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...args, '--json'], env, expectedExitCode: expected })).response; }
    catch (error) { report.lastFailure = { args, exitCode: error.exitCode, errorCode: error.code, outcome: error.outcome, response: error.response }; throw error; }
  }
  const desktop = (args, expected) => cli(['desktop', ...args], expected);
  const observe = async () => (await desktop(['observe', '--session', session])).result;
  function find(snapshot, name) {
    const element = snapshot.elements.find(value => value.name === name);
    assert.ok(element, 'Missing fixture element: ' + name); return element;
  }
  async function poll(read, accept, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await read(); if (accept(last)) return last; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(30);
    }
    throw new Error(label + ' timed out: ' + JSON.stringify(last));
  }
  const readInput = async () => {
    const value = await poll(async () => JSON.parse(await readFile(state + '.input.json', 'utf8')), Boolean, 'complete fixture receipt', 2000);
    report.lastFixture = value; return value;
  };
  const waitInput = (accept, label) => poll(readInput, accept, label);
  const units = value => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  const keys = value => value.events.filter(event => ['keyDown', 'keyUp', 'keyPress'].includes(event.kind));
  // Prepare resets fixture counters, but it keeps the same desktop worker. Its
  // received WM marker must remain stable; this does not recover or verify all
  // bits of the sent marker. Low-level hook evidence belongs to another harness.
  let windowMessageMarker;
  function checkMarkers(name, value, required) {
    const markers = value.inputMarkers;
    const record = { name, generation: value.generation, required, markers }; report.markerChecks.push(record);
    assert.equal(markers?.source, 'GetMessageExtraInfo'); assert.equal(markers?.lowLevelHookEvidence, false);
    assert.equal(markers?.overflow, false, 'Owned marker counters must be complete');
    assert.ok(Array.isArray(markers.events));
    const kinds = new Set(['key_down', 'key_up', 'unicode_down', 'unicode_up']), seen = new Set();
    for (const event of markers.events) {
      assert.ok(kinds.has(event.kind)); assert.match(event.marker, /^[0-9a-f]{16}$/);
      assert.notEqual(event.marker, '0000000000000000', 'Keyboard delivery lost its marker');
      assert.ok(Number.isSafeInteger(event.count) && event.count > 0);
      const key = event.kind + ':' + event.marker;
      assert.ok(!seen.has(key), 'Duplicate marker counter'); seen.add(key);
      windowMessageMarker ||= event.marker;
      assert.equal(event.marker, windowMessageMarker, 'Received WM marker changed across fixture preparations or cleanup');
    }
    for (const [kind, count] of Object.entries(required)) assert.ok(markers.events.filter(event => event.kind === kind).reduce((sum, event) => sum + event.count, 0) >= count, 'Missing marked ' + kind);
    record.receivedWindowMessageMarker = windowMessageMarker; record.lowLevelHookEvidence = false; record.ok = true;
  }
  function foregroundEvents(value) {
    for (const event of keys(value)) assert.equal(event.targetWasForeground, true, 'Keyboard event reached the fixture outside its foreground window: ' + JSON.stringify(event));
  }
  async function action(params, expected = 0, requestId = randomUUID()) {
    const file = path.join(home, 'action-' + requestId + '.json');
    await writeFile(file, JSON.stringify(params));
    const record = { requestId, params }; report.actions.push(record);
    const response = await desktop(['action', '--session', session, '--params-file', file, '--request-id', requestId], expected);
    record.response = response; return response;
  }
  async function input(snapshot, kind, extra, expected = 0, requestId) {
    return action({ version: snapshot.version, ref: find(snapshot, 'Keyboard primary').reference, kind, ...extra }, expected, requestId);
  }
  async function saveReceipt(name, value) {
    report.receipts[name] = value;
    await writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
  }
  async function prepare(mode) {
    const before = await readInput();
    let snapshot = await observe();
    await action({ version: snapshot.version, ref: find(snapshot, 'Prepare ' + mode).reference, kind: 'invoke' });
    await waitInput(value => value.generation > before.generation && value.mode === mode, 'prepare ' + mode);
    // This semantic focus is setup only. The subsequent physical action must
    // pass its own native activation, input-state, and focused-element checks.
    snapshot = await observe();
    await input(snapshot, 'focus', {});
    const diagnostics = (await desktop(['doctor', '--window', target.id])).result;
    report.preflights.push({ mode, diagnostics });
    assert.equal(diagnostics.source.integrity.rid, 8192, 'The actual App catalog helper must be Medium integrity');
    assert.equal(diagnostics.source.integrity.elevated, false);
    assert.equal(diagnostics.target.pid, fixture.pid);
    assert.equal(diagnostics.target.integrity.rid, 8192, 'The target fixture must be Medium integrity');
    assert.equal(diagnostics.target.integrity.elevated, false);
    return observe();
  }

  try {
    const runtime = await cli(['status']); assert.equal(runtime.ok, true);
    assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase(), 'Use the actual development App from this checkout');
    report.appBuild = { pid: runtime.data.pid, buildId: runtime.data.build.buildId, startedAt: runtime.data.build.startedAt };
    const initial = (await desktop(['status'])).result;
    assert.equal(initial.available, true); assert.equal(initial.session, null, 'Do not replace an existing desktop task');
    fixture = await launchWindowsUserProcess(executable, [state, ...(assistedForeground ? ['--assisted-foreground'] : [])], root);
    report.environment = await poll(async () => JSON.parse(await readFile(state + '.environment.json', 'utf8')), value => value.pid === fixture.pid, 'fixture environment');
    assert.equal(report.environment.administrator, false);
    await waitInput(value => value.mode === 'initial', 'initial fixture receipt');
    target = await poll(async () => (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.title === 'ProfilePilot keyboard verification'), Boolean, 'exact owned fixture window');
    assert.equal(target.nativeHandle, report.environment.hwnd);
    report.window = target;
    if (assistedForeground) {
      report.assistedForegroundPreparation = await prepareAssistedForeground({ enabled: true, directory: home, executable, fileBase: state,
        pid: fixture.pid, startedUtcTicks: report.environment.startedUtcTicks, hwnd: report.environment.hwnd });
      assert.equal(report.assistedForegroundPreparation.ok, true, 'Assisted foreground setup failed; product input must not continue.');
    }
    // A lost CLI response can leave a successfully claimed owner behind. The
    // finally block checks the exact task name even when claim itself throws.
    claimed = true; await desktop(['claim', '--session', session, '--window', target.id]);

    let snapshot = await prepare('unicode');
    const unicode = 'ProfilePilot 中文 🧪 😀 e\u0301';
    await input(snapshot, 'type_text', { value: unicode });
    let value = await waitInput(value => value.primary.text === unicode && value.events.filter(event => event.kind === 'keyUp').length >= unicode.length, 'Unicode keyboard delivery');
    assert.deepEqual(value.primary.utf16, units(unicode)); assert.equal(value.secondary.text, '');
    assert.deepEqual(value.events.filter(event => event.kind === 'keyPress' && event.box === 'primary').map(event => event.code), units(unicode));
    foregroundEvents(value); await saveReceipt('unicode', value);
    checkMarkers('Unicode packet down/up', value, { unicode_down: unicode.length, unicode_up: unicode.length });
    report.checks.push('Unicode, surrogate-pair emoji and combining characters arrive as exact text and real KeyPress events');

    await prepare('navigation');
    for (const step of [
      { key: 'HOME', code: 36, text: 'abcdef', position: 0 },
      { key: 'END', code: 35, text: 'abcdef', position: 6 },
      { key: 'LEFT', code: 37, text: 'abcdef', position: 5 },
      { key: 'DELETE', code: 46, text: 'abcde', position: 5 },
      { key: 'HOME', code: 36, text: 'abcde', position: 0 },
      { key: 'DELETE', code: 46, text: 'bcde', position: 0 }
    ]) {
      const before = await readInput(); snapshot = await observe();
      await input(snapshot, 'press_key', { keys: [step.key] });
      value = await waitInput(value => value.events.some(event => event.sequence > before.sequence && event.kind === 'keyUp' && event.code === step.code), 'navigation key ' + step.key);
      const delivered = keys(value).filter(event => event.sequence > before.sequence);
      assert.deepEqual(delivered.filter(event => event.kind === 'keyDown').map(event => event.code), [step.code]);
      assert.deepEqual(delivered.filter(event => event.kind === 'keyUp').map(event => event.code), [step.code]);
      assert.ok(delivered.every(event => event.box === 'primary' && event.modifiers === 0));
      assert.equal(value.primary.text, step.text); assert.equal(value.primary.selectionStart, step.position);
      assert.equal(value.primary.selectionLength, 0); assert.equal(value.secondary.text, ''); foregroundEvents(value);
      checkMarkers('navigation ' + step.key, value, { key_down: 1, key_up: 1 });
    }
    await saveReceipt('navigation', value);
    report.checks.push('Home, End, Left and Delete deliver real key down/up events and the expected caret/text edits');

    for (const invalid of [
      { name: 'duplicate-key', keys: ['A', 'A'], exit: 2, code: 'DESKTOP_INVALID_ARGUMENTS' },
      { name: 'duplicate-alias', keys: ['CTRL', 'CONTROL'], exit: 2, code: 'DESKTOP_INVALID_ARGUMENTS' },
      { name: 'unsupported-f01', keys: ['F01'], exit: 1, code: 'DESKTOP_KEY_UNSUPPORTED' }
    ]) {
      snapshot = await prepare('rejection');
      const before = await readInput();
      const rejected = await input(snapshot, 'press_key', { keys: invalid.keys }, invalid.exit);
      assert.equal(rejected.code, invalid.code);
      await delay(100); value = await readInput();
      assert.equal(value.primary.text, ''); assert.equal(value.secondary.text, ''); assert.deepEqual(keys(value), keys(before));
      assert.deepEqual(value.inputMarkers, before.inputMarkers, 'Rejected input must not add any marked keyboard message');
      // No intervening observe: success proves validation did not consume the
      // prior version. A new request ID is required for this different action.
      await input(snapshot, 'type_text', { value: '✓' });
      value = await waitInput(value => value.primary.text === '✓' && value.events.some(event => event.kind === 'keyUp'), 'old version after ' + invalid.name);
      assert.equal(value.secondary.text, ''); foregroundEvents(value); await saveReceipt(invalid.name, value);
      checkMarkers('same observation after ' + invalid.name, value, { unicode_down: 1, unicode_up: 1 });
      report.checks.push(invalid.name + ' is rejected before delivery and the same observation version remains usable');
    }

    snapshot = await prepare('transfer');
    const transferId = randomUUID();
    const transfer = await input(snapshot, 'type_text', { value: 'A remaining text must stay out 🧪' }, 75, transferId);
    assert.equal(transfer.code, 'DESKTOP_OUTCOME_UNKNOWN');
    assert.equal(transfer.details?.cause, 'DESKTOP_FOCUS_CHANGED');
    value = await waitInput(value => value.transferred, 'first-character focus transfer');
    await delay(150); value = await readInput();
    assert.equal(value.transferFocusSucceeded, true); assert.equal(value.firstTransferText, 'A');
    assert.equal(value.primary.text, 'A'); assert.equal(value.secondary.text, '');
    assert.deepEqual(value.events.filter(event => event.kind === 'keyPress').map(event => [event.box, event.code]), [['primary', 65]]);
    foregroundEvents(value); await saveReceipt('focus-transfer', value);
    checkMarkers('focus transfer and Unicode release', value, { unicode_down: 1, unicode_up: 1 });
    const paused = (await desktop(['status'])).result.session;
    assert.equal(paused?.name, session); assert.equal(paused.state, 'paused');
    const receiptArgs = ['receipt', '--session', session, '--request-id', transferId];
    const firstReceipt = (await desktop(receiptArgs)).result;
    const secondReceipt = (await desktop(receiptArgs)).result;
    assert.equal(firstReceipt.state, 'failed'); assert.equal(firstReceipt.error.code, 'DESKTOP_OUTCOME_UNKNOWN');
    assert.equal(firstReceipt.error.details?.cause, 'DESKTOP_FOCUS_CHANGED');
    assert.equal(firstReceipt.historical, true); assert.deepEqual(secondReceipt, firstReceipt);
    assert.deepEqual(keys(await readInput()), keys(value), 'Receipt lookup must not dispatch another key');
    assert.deepEqual((await readInput()).inputMarkers, value.inputMarkers, 'Receipt lookup must not dispatch another marked keyboard message');
    report.focusTransferReceipt = firstReceipt;
    report.checks.push('First-character focus transfer stops remaining text, pauses the owner, and preserves the failed read-only receipt');
    report.checks.push('Owned Unicode and navigation down/up WM messages retain one nonzero received marker across preparations and failed-action cleanup; full64 low-level hook delivery is not asserted');
    await desktop(['complete', '--session', session]);
    report.cleanup.session = (await desktop(['status'])).result.session;
    assert.notEqual(report.cleanup.session?.name, session, 'This fixture session must be released');
    claimed = false;
    report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, stack: error.stack }; process.exitCode = 1;
  } finally {
    // Keep session and process cleanup independent: a failed IPC cleanup must
    // never leave our own fixture behind or release someone else's session.
    if (claimed) {
      try {
        const current = (await desktop(['status'])).result.session;
        if (current?.name === session) await desktop(['release', '--session', session]);
        report.cleanup.session = (await desktop(['status'])).result.session;
      } catch (error) { report.cleanup.sessionError = error.message; report.ok = false; process.exitCode = 1; }
    }
    if (fixture) {
      try {
        try { await saveReceipt('final-fixture', await readInput()); } catch (error) { report.cleanup.finalReceiptError = error.message; }
        await writeFile(state + '.close', 'close'); await delay(250);
        terminateOwnedWindowsProcess(fixture.pid, executable); report.cleanup.fixtureStopped = true;
      } catch (error) { report.cleanup.fixtureError = error.message; report.ok = false; process.exitCode = 1; }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), checks: report.checks.length, cleanup: report.cleanup }, null, 2));
  }
}
