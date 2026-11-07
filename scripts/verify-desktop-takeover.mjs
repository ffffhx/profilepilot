import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assistedFixtureSource, compileAssistedPreparer, prepareAssistedForeground } from './e2e/assisted-foreground.mjs';

// Default/--check only compiles. Only --run can query the running App or create
// a fixture. All injected input below is explicitly synthetic, never hardware.
const args = process.argv.slice(2);
assert.ok(args.every(value => ['--check', '--run', '--assisted-foreground'].includes(value)) && new Set(args).size === args.length,
  'Use --check (default) or --run [--assisted-foreground].');
assert.ok(!(args.includes('--check') && args.includes('--run')), '--check and --run are mutually exclusive.');
if (process.platform !== 'win32') throw new Error('Takeover acceptance requires Windows; this does not test macOS native desktop control.');
const run = args.includes('--run'), assistedForeground = args.includes('--assisted-foreground');
if (run) await assertDesktopAcceptanceWindow();
await main();

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-takeover-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home));
  await mkdir(output, { recursive: true });
  // Reuse the existing owned-fixture preparer whitelist without widening it.
  const executable = path.join(home, 'DesktopFixture.exe'), fileBase = path.join(home, 'fixture');
  const source = path.join(root, 'scripts/e2e/desktop-takeover-fixture.cs');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', `/out:${executable}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', source, assistedFixtureSource],
  { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  if (!run) {
    if (assistedForeground) compileAssistedPreparer(home);
    console.log(JSON.stringify({ ok: true, mode: 'compile-only', executable, output, guiStarted: false, inputSent: false, hooksInstalled: false }));
    return;
  }

  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  const session = 'takeover-' + randomUUID(), nonce = randomBytes(16).toString('hex');
  const foreignMarker = 'b22345678901def0';
  const report = { ok: false, startedAt: new Date().toISOString(), mode: 'actual-app-takeover', assistedForeground,
    productAutonomousActivationProven: false, hardwareInputTested: false, additionalHooksInstalled: false,
    scope: 'One owned Medium WinForms Edit, actual App CLI, and one nonce-authorized synthetic foreign-marked F24 down/up pair.',
    checks: [], actions: [], statuses: [], receipts: {}, cleanup: {}, marker: { value: foreignMarker, bits: 64,
      source: 'Fixed explicit test constant in the nonce-bound fixture SendInput KEYBDINPUT.dwExtraInfo; not an App marker or an authenticity claim.' },
    limitations: [
      'All F24 input is synthetic. This run does not establish physical-hardware provenance or test physical keyboard/mouse interaction.',
      'The fixture installs no hook. App inputObservation is the production observer evidence; owned WM receipts can truncate marker upper bits and are reported separately.',
      'The public App status does not return the triggering marker. The controlled foreign injection and observed pause are correlated, not independent full64 hook-event attribution; unrelated concurrent injected activity is a remaining race.',
      'Foreground, focused Edit and held-input preflight samples are not atomic with SendInput. Unknown outcomes fail the run and never replay the pair.',
      'Only this explicitly authorized synthetic scenario may resume. Unexpected takeover, missing events, observer interruption or another session aborts without resume.',
      'No helper-kill, simultaneous input, every keyboard layout, multi-monitor, or macOS acceptance is claimed.'
    ] };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let fixture, target, claimAttempted = false, launchAttempted = false, heartbeat;
  async function cli(parameters, expectedExitCode = 0, timeoutMs = 70000) {
    try { return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...parameters, '--json'], env, cwd: root, expectedExitCode, timeoutMs })).response; }
    catch (error) { report.lastCliFailure = { args: parameters, code: error.code, outcome: error.outcome, exitCode: error.exitCode, response: error.response }; throw error; }
  }
  const desktop = (parameters, expected, timeout) => cli(['desktop', ...parameters], expected, timeout);
  async function status(label, timeout = 15000) {
    const value = (await desktop(['status'], 0, timeout)).result;
    report.statuses.push({ label, sampledAt: new Date().toISOString(), value }); return value;
  }
  function active(value) {
    assert.equal(value.session?.name, session); assert.equal(value.session?.window.pid, fixture.pid);
    assert.equal(value.session.state, 'active'); assert.equal(value.inputObservation.available, true);
    assert.equal(value.inputObservation.phase, 'ready'); assert.ok(value.inputObservation.generation && value.inputObservation.epoch);
    assert.notEqual(value.inputObservation.unobservedTestDriver, true);
  }
  async function poll(read, accept, label, timeout = 10000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) {
      try { last = await read(Math.max(1, deadline - Date.now())); if (accept(last)) return last; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(40);
    }
    throw Object.assign(new Error(label + ' timed out'), { code: 'TAKEOVER_EVIDENCE_TIMEOUT', last });
  }
  async function readReceipt() {
    const value = JSON.parse(await readFile(fileBase + '.input.json', 'utf8'));
    assert.equal(value.nonce, nonce); assert.equal(value.pid, fixture.pid); report.lastFixture = value; return value;
  }
  async function saveReceipt(name, value) { report.receipts[name] = value; await writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
  const observe = async () => (await desktop(['observe', '--session', session])).result;
  function edit(snapshot, capability) {
    const found = snapshot.elements.filter(value => value.name === 'Takeover owned edit' && value.role === 'Edit');
    assert.equal(found.length, 1, 'The exact owned Edit must be unambiguous');
    if (capability) assert.ok(found[0].actions.includes(capability), 'Missing Edit capability: ' + capability);
    return found[0];
  }
  async function action(snapshot, kind, extra = {}, expected = 0) {
    await assertDesktopAcceptanceWindow();
    const requestId = randomUUID(), params = { version: snapshot.version, ref: edit(snapshot, kind === 'set_value' ? kind : undefined).reference, kind, ...extra };
    const file = path.join(home, requestId + '.json'); await writeFile(file, JSON.stringify(params), { flag: 'wx' });
    const record = { requestId, params, startedAt: new Date().toISOString() }; report.actions.push(record);
    record.response = await desktop(['action', '--session', session, '--params-file', file, '--request-id', requestId], expected);
    record.finishedAt = new Date().toISOString(); return record;
  }
  const lookup = async requestId => (await desktop(['receipt', '--session', session, '--request-id', requestId])).result;
  const sameEffects = (before, after) => {
    assert.equal(after.text, before.text); assert.equal(after.textChanges, before.textChanges); assert.equal(after.sequence, before.sequence);
    assert.deepEqual(after.markerEvidence, before.markerEvidence); assert.deepEqual(after.foreign, before.foreign);
  };
  try {
    const runtime = await cli(['status']); assert.equal(runtime.ok, true);
    assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
    report.appBuild = { pid: runtime.data.pid, buildId: runtime.data.build.buildId, startedAt: runtime.data.build.startedAt, entry: runtime.data.build.entry };
    report.fixtureSourceSha256 = createHash('sha256').update(await readFile(source)).digest('hex');
    const initial = await status('initial'); assert.equal(initial.available, true); assert.equal(initial.session, null, 'Never replace another desktop task');
    assert.equal(initial.inputObservation.available, true); assert.notEqual(initial.inputObservation.unobservedTestDriver, true);
    await writeFile(fileBase + '.heartbeat', new Date().toISOString());
    heartbeat = setInterval(() => { void writeFile(fileBase + '.heartbeat', new Date().toISOString()).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000); heartbeat.unref();
    await assertDesktopAcceptanceWindow(); launchAttempted = true;
    fixture = await launchWindowsUserProcess(executable, [fileBase, nonce, foreignMarker, ...(assistedForeground ? ['--assisted-foreground'] : [])], root);
    report.environment = await poll(async () => JSON.parse(await readFile(fileBase + '.environment.json', 'utf8')), value => value.pid === fixture.pid, 'owned environment');
    assert.equal(report.environment.nonce, nonce); assert.equal(report.environment.marker, foreignMarker);
    assert.equal(report.environment.administrator, false); assert.equal(report.environment.pointerBits, 64); assert.equal(report.environment.hooksInstalled, false);
    target = await poll(async () => (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.title === 'ProfilePilot takeover verification'), Boolean, 'owned target');
    assert.equal(target.nativeHandle, report.environment.hwnd); report.window = target;
    if (assistedForeground) {
      report.assistedForegroundPreparation = await prepareAssistedForeground({ enabled: true, directory: home, executable, fileBase,
        pid: fixture.pid, startedUtcTicks: report.environment.startedUtcTicks, hwnd: target.nativeHandle });
      assert.equal(report.assistedForegroundPreparation.ok, true, 'Assisted setup must succeed before claim/input');
    }
    claimAttempted = true;
    report.claim = (await desktop(['claim', '--session', session, '--window', target.id])).result; active(report.claim);
    let snapshot = await observe(); await action(snapshot, 'focus');
    report.preflight = (await desktop(['doctor', '--window', target.id])).result;
    assert.equal(report.preflight.source.integrity.rid, 8192); assert.equal(report.preflight.source.integrity.elevated, false);
    assert.equal(report.preflight.target.pid, fixture.pid); assert.equal(report.preflight.target.integrity.rid, 8192);
    assert.equal(report.preflight.target.integrity.elevated, false); assert.equal(report.preflight.foreground.hwnd, target.nativeHandle);
    const beforeOwn = await status('before-own-input'); active(beforeOwn);
    snapshot = await observe(); const own = await action(snapshot, 'type_text', { value: 'own' });
    assert.equal(own.response.result.executed, true);
    let receipt = await poll(readReceipt, value => value.text === 'own' && value.markerEvidence.counts.reduce((sum, item) => sum + item.up, 0) >= 3, 'own text delivered');
    assert.equal(receipt.foreign.attempted, false); assert.equal(receipt.targetWasForeground, true); assert.equal(receipt.markerEvidence.overflow, false);
    const afterOwn = await status('after-own-input'); active(afterOwn);
    assert.equal(afterOwn.inputObservation.generation, beforeOwn.inputObservation.generation);
    assert.equal(afterOwn.inputObservation.epoch, beforeOwn.inputObservation.epoch);
    await saveReceipt('own-input', receipt);
    const historical = await lookup(own.requestId); assert.equal(historical.state, 'succeeded'); assert.equal(historical.historical, true);
    report.ownActionReceipt = historical;
    report.checks.push('Actual App own marked type_text reaches the owned Edit without pausing the ready production observer');

    snapshot = await observe(); const beforeForeign = await status('before-foreign-input'); active(beforeForeign);
    receipt = await readReceipt();
    const marker = BigInt('0x' + foreignMarker), low = marker & 0xffffffffn;
    assert.ok(receipt.markerEvidence.counts.every(value => BigInt('0x' + value.marker) !== marker && BigInt('0x' + value.marker) !== low), 'Foreign test marker collides with an own WM marker; do not inject');
    assert.equal(receipt.editFocused, true); assert.equal(receipt.targetWasForeground, true); assert.equal(receipt.foreign.requested, false);
    await assertDesktopAcceptanceWindow();
    const request = { action: 'foreign-f24', nonce, marker: foreignMarker, pid: fixture.pid, hwnd: target.nativeHandle,
      startedUtcTicks: report.environment.startedUtcTicks, expiresAt: Date.now() + 5000 };
    report.foreignRequest = { ...request, recordedAt: new Date().toISOString() };
    await writeFile(fileBase + '.foreign.request.tmp', JSON.stringify(request), { flag: 'wx' });
    await rename(fileBase + '.foreign.request.tmp', fileBase + '.foreign.request.json');
    receipt = await poll(readReceipt, value => value.foreign.complete || value.foreign.error, 'foreign pair receipt');
    await saveReceipt('foreign-input', receipt);
    assert.equal(receipt.foreign.error, null); assert.equal(receipt.foreign.complete, true); assert.equal(receipt.foreign.inserted, 2);
    assert.equal(receipt.foreign.down, 1); assert.equal(receipt.foreign.up, 1); assert.equal(receipt.foreign.released, true);
    assert.equal(receipt.foreign.nonForeground, 0); assert.equal(receipt.foreign.unmatched, 0); assert.equal(receipt.text, 'own');
    assert.equal(receipt.foreign.preflight.heldCount, 0); assert.equal(receipt.foreign.preflight.ownedFocus, true); assert.equal(receipt.foreign.preflight.ownedForeground, true);
    const paused = await poll(remaining => status('await-external-pause', Math.min(10000, remaining)), value => value.session?.state === 'paused', 'production observer pause', 15000);
    assert.equal(paused.session.name, session); assert.equal(paused.inputObservation.phase, 'paused');
    assert.equal(paused.inputObservation.reason, 'external_input'); assert.equal(paused.inputObservation.certainty, 'observed');
    assert.equal(paused.inputObservation.generation, beforeForeign.inputObservation.generation);
    assert.equal(paused.inputObservation.epoch, beforeForeign.inputObservation.epoch);
    report.externalPause = paused;
    report.checks.push('One nonce-bound synthetic foreign64 F24 pair reaches the owned Edit and the actual App pauses with external_input / observed');

    const rejected = await action(snapshot, 'set_value', { value: 'MUST-NOT-APPEAR' }, 75);
    assert.equal(rejected.response.code, 'DESKTOP_USER_IN_CONTROL');
    await delay(150); sameEffects(receipt, await readReceipt());
    const receiptAfterPause = await lookup(own.requestId); assert.deepEqual(receiptAfterPause, historical);
    sameEffects(receipt, await readReceipt()); report.receiptAfterPause = receiptAfterPause;
    report.checks.push('A new UIA set_value is rejected while paused without changing owned text/events; historical receipt lookup remains read-only');

    report.conditionalCompletion = await desktop(['complete', '--session', session, '--require-active'], 75);
    assert.equal(report.conditionalCompletion.code, 'DESKTOP_USER_IN_CONTROL');
    const afterCompletionRefusal = await status('after-conditional-completion-refusal');
    assert.deepEqual(afterCompletionRefusal.inputObservation, paused.inputObservation);
    assert.equal(afterCompletionRefusal.session?.name, session); assert.equal(afterCompletionRefusal.session.state, 'paused');
    sameEffects(receipt, await readReceipt());
    report.checks.push('Conditional completion refuses the paused owner and preserves its session and input state');

    // Explicitly authorized by this test's scope, only after the exact expected
    // synthetic event and its release have been proved. No failure path resumes.
    const beforeResume = await status('before-explicit-test-resume');
    assert.deepEqual(beforeResume.inputObservation, paused.inputObservation); assert.equal(beforeResume.session?.name, session); assert.equal(beforeResume.session.state, 'paused');
    await assertDesktopAcceptanceWindow();
    report.explicitTestResume = { reason: 'Authorized synthetic-fixture acceptance continuation; not automatic recovery from arbitrary user takeover.', requestedAt: new Date().toISOString() };
    const resumed = (await desktop(['resume', '--session', session])).result; active(resumed);
    assert.notEqual(resumed.inputObservation.generation, paused.inputObservation.generation); report.explicitTestResume.status = resumed;
    const priorVersion = snapshot.version; snapshot = await observe(); assert.notEqual(snapshot.version, priorVersion);
    report.explicitTestResume.freshVersion = snapshot.version;
    const resumedInput = await action(snapshot, 'type_text', { value: '+resumed' }); assert.equal(resumedInput.response.result.executed, true);
    receipt = await poll(readReceipt, value => value.text === 'own+resumed', 'new-generation own input');
    assert.equal(receipt.foreign.down, 1); assert.equal(receipt.foreign.up, 1); assert.equal(receipt.foreign.complete, true); await saveReceipt('resumed-input', receipt);
    const afterResume = await status('after-new-generation-input'); active(afterResume);
    assert.equal(afterResume.inputObservation.generation, resumed.inputObservation.generation);
    report.checks.push('Explicit test-only resume arms a different generation; fresh observe and own type_text succeed without replaying foreign input');
    report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, outcome: error.outcome, last: error.last, stack: error.stack }; process.exitCode = 1;
  } finally {
    const results = await Promise.allSettled([
      (async () => {
        if (!claimAttempted) return;
        // Exact random session name makes release safe even if a status query
        // or the original claim response was lost. Never release another owner.
        const release = await desktop(['release', '--session', session], null, 15000); report.cleanup.release = release;
        assert.ok(release.ok || release.code === 'DESKTOP_SESSION_ENDED', 'Owned session release was not confirmed');
        const current = await status('cleanup', 15000); report.cleanup.session = current.session;
        assert.notEqual(current.session?.name, session, 'Owned session survived cleanup');
      })(),
      (async () => {
        if (!fixture) { if (launchAttempted) throw new Error('Fixture launch outcome unknown; heartbeat expiration is the remaining owned cleanup mechanism.'); return; }
        try { await saveReceipt('final-fixture', await readReceipt()); } catch (error) { report.cleanup.finalReceiptError = error.message; }
        await writeFile(fileBase + '.close', nonce); await delay(250);
        terminateOwnedWindowsProcess(fixture.pid, executable); report.cleanup.fixtureStopped = true;
        try { report.cleanup.fixtureCloseReceipt = JSON.parse(await readFile(fileBase + '.closed.json', 'utf8')); } catch (error) { report.cleanup.closeReceiptUnavailable = error.code || error.message; }
      })()
    ]);
    clearInterval(heartbeat);
    for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') {
      report.cleanup[index === 0 ? 'sessionError' : 'fixtureError'] = results[index].reason.message; report.ok = false; process.exitCode = 1;
    }
    if (report.cleanup.heartbeatError) { report.ok = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), checks: report.checks.length, cleanup: report.cleanup }, null, 2));
  }
}
