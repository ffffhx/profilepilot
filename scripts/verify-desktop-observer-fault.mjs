import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assistedFixtureSource, compileAssistedPreparer, prepareAssistedForeground } from './e2e/assisted-foreground.mjs';
import { evaluateOwnedObserverExitEvidence } from './e2e/desktop-observer-fault-evidence.mjs';

const args = process.argv.slice(2);
assert.ok(args.every(value => ['--check', '--run', '--assisted-foreground'].includes(value)) && new Set(args).size === args.length);
assert.ok(!(args.includes('--check') && args.includes('--run')), 'Use --check (default) or --run [--assisted-foreground].');
assert.equal(process.platform, 'win32');
const run = args.includes('--run'), assisted = args.includes('--assisted-foreground');
if (run) await assertDesktopAcceptanceWindow();
await main();

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-observer-fault-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const executable = path.join(home, 'DesktopFixture.exe'), identity = path.join(home, 'ObserverFaultIdentity.exe');
  const entry = path.join(home, 'observer-fault-main.cjs'), base = path.join(home, 'main'), fileBase = path.join(home, 'fixture');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', `/out:${executable}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-takeover-fixture.cs'), assistedFixtureSource],
  { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', `/out:${identity}`,
    '/r:System.Management.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')],
  { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  buildSync({ entryPoints: [path.join(root, 'scripts/e2e/desktop-observer-fault-main.ts')], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  if (!run) {
    if (assisted) compileAssistedPreparer(home);
    console.log(JSON.stringify({ ok: true, mode: 'compile-only', output, entry, executable, identity, guiStarted: false, hooksInstalled: false })); return;
  }
  const nonce = randomBytes(16).toString('hex'), session = 'observer-fault-' + randomUUID();
  const env = { ...process.env, PROFILEPILOT_MANAGEMENT_ROOT: path.join(home, 'management') };
  const electron = createRequire(import.meta.url)('electron');
  const report = { ok: false, mode: 'isolated-medium-electron-production-desktop-services', startedAt: new Date().toISOString(),
    runningUserAppTested: false, browserSubscriptionsCreated: false, hardwareInputTested: false, explicitResumePerformed: false,
    assistedForeground: assisted, productAutonomousActivationProven: false, checks: [], actions: [], statuses: [], cleanup: {},
    limitations: ['This is an isolated Electron main using production Service/Runtime/Worker/management modules, not the running user App main or its admission catalogs.',
      'The fixed production observer mutex is unchanged. An existing helper must make this run fail; no competing hook or user helper is terminated.',
      'Only owned WinForms UIA values are changed. No synthetic foreign input or hardware input is used.',
      'Child exit receipt and the following service pause show App event handling, not the exact OS termination instant. No automatic recovery is permitted.'] };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let fixture, electronProcess, ready, heartbeat, claimAttempted = false, fixtureLaunched = false, mainLaunched = false;
  async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
  async function poll(read, accept, label, timeout = 12000) {
    const deadline = Date.now() + timeout; let value;
    while (Date.now() < deadline) {
      try { value = await read(); if (accept(value)) return value; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(40);
    }
    throw Object.assign(new Error(label + ' timed out'), { last: value });
  }
  async function cli(parameters, expectedExitCode = 0) {
    return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...parameters, '--json'], env, cwd: root, expectedExitCode, timeoutMs: 70000 })).response;
  }
  const desktop = (parameters, expected) => cli(['desktop', ...parameters], expected);
  async function status(label) { const value = (await desktop(['status'])).result; report.statuses.push({ label, value, at: Date.now() }); return value; }
  async function privateRequest(action, extra = {}) {
    const request = { id: randomUUID(), action, nonce, expiresAt: Date.now() + 10000, ...extra };
    await writeFile(base + '.request.tmp', JSON.stringify(request)); await rename(base + '.request.tmp', base + '.request.json');
    const response = await poll(() => json(base + '.response.json'), value => value.id === request.id, 'owned private response');
    assert.equal(response.ok, true, response.error); return response;
  }
  const readReceipt = async () => { const value = await json(fileBase + '.input.json'); assert.equal(value.nonce, nonce); assert.equal(value.pid, fixture.pid); return value; };
  async function action(snapshot, value, expected = 0) {
    await assertDesktopAcceptanceWindow();
    const edits = snapshot.elements.filter(element => element.name === 'Takeover owned edit' && element.role === 'Edit'); assert.equal(edits.length, 1);
    assert.ok(edits[0].actions.includes('set_value'));
    const requestId = randomUUID(), params = { version: snapshot.version, ref: edits[0].reference, kind: 'set_value', value };
    const file = path.join(home, requestId + '.json'); await writeFile(file, JSON.stringify(params), { flag: 'wx' });
    const record = { requestId, params, response: await desktop(['action', '--session', session, '--params-file', file, '--request-id', requestId], expected) };
    report.actions.push(record); return record;
  }
  function active(value) {
    assert.equal(value.session?.name, session); assert.equal(value.session?.window.pid, fixture.pid); assert.equal(value.session.state, 'active');
    assert.equal(value.inputObservation.phase, 'ready'); assert.notEqual(value.inputObservation.unobservedTestDriver, true);
  }
  try {
    await mkdir(path.join(home, 'electron-user-data'), { recursive: true });
    await writeFile(fileBase + '.heartbeat', new Date().toISOString()); await writeFile(base + '.heartbeat', new Date().toISOString());
    heartbeat = setInterval(() => { for (const prefix of [fileBase, base]) void writeFile(prefix + '.heartbeat', new Date().toISOString()).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000); heartbeat.unref();
    await assertDesktopAcceptanceWindow(); fixtureLaunched = true;
    fixture = await launchWindowsUserProcess(executable, [fileBase, nonce, 'b22345678901def0', ...(assisted ? ['--assisted-foreground'] : [])], root);
    const environment = report.fixtureEnvironment = await poll(() => json(fileBase + '.environment.json'), value => value.pid === fixture.pid && value.nonce === nonce, 'owned WinForms ready');
    assert.equal(environment.administrator, false); assert.equal(environment.hooksInstalled, false);
    const config = { home, base, nonce, session, target: environment, identityExecutable: identity,
      gateModule: path.join(root, 'scripts/e2e/desktop-acceptance-window.mjs'),
      observerExecutable: path.join(root, 'dist/native/ProfilePilot.InputObserver.exe'), desktopExecutable: path.join(root, 'dist/native/ProfilePilot.Desktop.exe') };
    const configFile = path.join(home, 'fixture-config.json'); await writeFile(configFile, JSON.stringify(config), { flag: 'wx' });
    await assertDesktopAcceptanceWindow(); mainLaunched = true;
    electronProcess = await launchWindowsUserProcess(electron, [entry, configFile], root);
    ready = report.mainReady = await poll(() => json(base + '.ready.json'), value => value.nonce === nonce && value.pid === electronProcess.pid, 'isolated Medium Electron ready');
    assert.equal(ready.mainIdentity.integrityRid, 8192); assert.equal(ready.mainIdentity.elevated, false); assert.equal(ready.mainIdentity.uiAccess, false);
    assert.equal(ready.managementRoot, env.PROFILEPILOT_MANAGEMENT_ROOT);
    const ping = await cli(['status']); assert.equal(ping.data.pid, electronProcess.pid); assert.equal(path.resolve(ping.data.build.entry), entry);
    const initial = await status('initial'); assert.equal(initial.session, null);
    const target = await poll(async () => (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === environment.hwnd), Boolean, 'owned target');
    if (assisted) {
      report.assistedPreparation = await prepareAssistedForeground({ enabled: true, directory: home, executable, fileBase, pid: fixture.pid, startedUtcTicks: environment.startedUtcTicks, hwnd: environment.hwnd });
      assert.equal(report.assistedPreparation.ok, true);
    }
    claimAttempted = true; active((await desktop(['claim', '--session', session, '--window', target.id])).result);
    let snapshot = (await desktop(['observe', '--session', session])).result;
    const baseline = await action(snapshot, 'observer-fault-baseline'); assert.equal(baseline.response.result.executed, true);
    const before = await poll(readReceipt, value => value.text === 'observer-fault-baseline', 'baseline UIA effect');
    assert.equal(before.foreign.attempted, false);
    const receipt = report.baselineReceipt = (await desktop(['receipt', '--session', session, '--request-id', baseline.requestId])).result;
    report.nativeIdentity = (await desktop(['doctor', '--window', target.id])).result;
    assert.equal(report.nativeIdentity.source.integrity.rid, 8192); assert.equal(report.nativeIdentity.source.integrity.elevated, false);
    assert.equal(report.nativeIdentity.target.pid, fixture.pid); assert.equal(report.nativeIdentity.target.integrity.rid, 8192);
    snapshot = (await desktop(['observe', '--session', session])).result;
    const current = await status('before-fault'); active(current);
    const inspection = report.inspection = (await privateRequest('inspect')).result;
    assert.equal(inspection.spawnCount, 1); assert.equal(inspection.browserFactoryCalls, 0); assert.deepEqual(inspection.runtime.browserPids, []);
    assert.equal(inspection.child.identity.parentPid, electronProcess.pid); assert.equal(inspection.child.identity.sha256, ready.sourceHash);
    assert.equal(path.dirname(inspection.child.expectedPath).toLowerCase(), path.join(os.tmpdir(), 'profilepilot-input-observer-runtime').toLowerCase());
    await assertDesktopAcceptanceWindow();
    report.fault = await privateRequest('fault', { session, epoch: current.inputObservation.epoch, generation: current.inputObservation.generation,
      childPid: inspection.child.pid, childStartedUtcTicks: inspection.child.identity.startedUtcTicks });
    const paused = report.paused = await poll(() => status('after-fault'), value => value.session?.state === 'paused', 'observer-exit pause');
    assert.equal(paused.session.name, session); assert.ok(['helper_exited', 'disconnected'].includes(paused.inputObservation.reason)); assert.equal(paused.inputObservation.certainty, 'unknown');
    assert.equal(paused.inputObservation.generation, current.inputObservation.generation);
    report.checks.push('Owned Medium observer is terminated and production service pauses for transport loss or process exit with unknown certainty');
    const rejected = await action(snapshot, 'MUST-NOT-APPEAR', 75); assert.equal(rejected.response.code, 'DESKTOP_USER_IN_CONTROL');
    assert.deepEqual(await readReceipt(), before);
    assert.deepEqual((await desktop(['receipt', '--session', session, '--request-id', baseline.requestId])).result, receipt);
    assert.deepEqual(await readReceipt(), before); report.checks.push('Stale UIA action is refused without effects and historical receipt lookup remains read-only');
    await delay(2200);
    const stable = await status('no-automatic-recovery'); assert.deepEqual(stable.inputObservation, paused.inputObservation); assert.equal(stable.session.state, 'paused');
    const after = report.after = (await privateRequest('inspect')).result;
    assert.equal(after.spawnCount, 1); assert.equal(after.child.closed, true); assert.equal(after.runtime.stopConfirmed, true);
    report.lossEvidence = evaluateOwnedObserverExitEvidence(after.events, { childPid: inspection.child.pid,
      generation: current.inputObservation.generation, epoch: current.inputObservation.epoch });
    assert.equal(report.lossEvidence.reason, paused.inputObservation.reason); assert.equal(after.drivers[1].stopConfirmed, true);
    report.checks.push('A matching owned transport/exit receipt precedes pause; final observer and owner-driver exits are confirmed without restart or ARM');
    report.sourceHashes = { main: createHash('sha256').update(await readFile(entry)).digest('hex'), observer: ready.sourceHash,
      desktop: createHash('sha256').update(await readFile(config.desktopExecutable)).digest('hex'),
      cli: createHash('sha256').update(await readFile(path.join(root, 'dist/main/profilepilot-cli.cjs'))).digest('hex') };
    report.ok = true;
  } catch (error) { report.error = { message: error.message, code: error.code, last: error.last, stack: error.stack }; process.exitCode = 1; }
  finally {
    async function cleanup(label, operation) { try { report.cleanup[label] = await operation(); } catch (error) { report.cleanup[label + 'Error'] = error.message; report.ok = false; process.exitCode = 1; } }
    await cleanup('session', async () => {
      if (!claimAttempted) return 'not-claimed'; const released = await desktop(['release', '--session', session], null);
      assert.ok(released.ok || released.code === 'DESKTOP_SESSION_ENDED'); return released;
    });
    await cleanup('main', async () => {
      if (!electronProcess) { assert.equal(mainLaunched, false, 'Electron launch outcome unknown; heartbeat remains responsible'); return 'not-launched'; }
      if (ready) {
        try { await privateRequest('close'); } catch (error) { report.cleanup.mainCloseRequestError = error.message; }
        try { report.cleanup.mainReceipt = await poll(() => json(base + '.closed.json'), value => value.nonce === nonce, 'owned main close', 12000); }
        catch (error) { report.cleanup.mainCloseReceiptError = error.message; }
        const proof = ready.mainIdentity;
        const stopped = JSON.parse(execFileSync(identity, ['--cleanup-owned', String(proof.pid), proof.startedUtcTicks, proof.executable, proof.sha256, String(proof.parentPid)], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
        assert.equal(stopped.originalExited, true); assert.equal(report.cleanup.mainReceipt?.cleanupConfirmed, true, 'Service cleanup must be confirmed, not inferred from process termination'); return stopped;
      }
      throw new Error('Unidentified Electron main cannot be terminated safely; heartbeat/hard lifetime remain active');
    });
    await cleanup('fixture', async () => {
      if (!fixture) { assert.equal(fixtureLaunched, false, 'Fixture launch outcome unknown'); return 'not-launched'; }
      await writeFile(fileBase + '.close', nonce); await delay(250); terminateOwnedWindowsProcess(fixture.pid, executable); return { stopped: true };
    });
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) { report.ok = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, report: path.join(output, 'report.json'), checks: report.checks.length, cleanup: report.cleanup }, null, 2));
  }
}
