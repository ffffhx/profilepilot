import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';
import { windowStateFixtureLifecycle } from './verify-desktop-window-state.mjs';
import { pollProviderFile, verifyProviderPending } from './verify-desktop-provider-block.mjs';
import { desktopParentComponents, digest, errorInfo, parentDeathOptions, verifyParentBuild, verifyArtifacts,
  verifyProbeParent, verifyProbeHelper, runParentDeathCase, retireProbeProcess } from './e2e/desktop-parent-death-protocol.mjs';
import { verifyParentRuntime, verifyProbeDirectory, verifyBootstrapCompletion } from './e2e/desktop-parent-death-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const sha = async file => digest(await readFile(file));
export async function verifyDesktopParentDeath(options) {
  assert.equal(process.platform, 'win32');
  const runtimeKind = options.runtime || 'node'; assert.ok(['node', 'electron'].includes(runtimeKind));
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-parent-death-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const nonce = randomBytes(16).toString('hex'), runId = randomUUID(), base = path.join(home, 'fixture');
  const config = { root, home, nonce, runId, identityExe: path.join(home, 'Identity.exe'), fixtureExe: path.join(home, 'ProviderBlock.exe'),
    parentReady: path.join(home, 'parent-ready.json'), parentState: path.join(home, 'parent-state.json'), parentClosed: path.join(home, 'parent-closed.json'),
    parentGo: path.join(home, 'parent-go'), parentObserve: path.join(home, 'parent-observe'), parentStop: path.join(home, 'parent-stop'),
    parentEntryError: path.join(home, 'parent-entry-error.json'), bootstrapReady: path.join(home, 'bootstrap-ready.json'),
    bootstrapSpawn: path.join(home, 'bootstrap-spawn.json'), bootstrapClosed: path.join(home, 'bootstrap-closed.json'),
    electronEntry: path.join(root, 'scripts/e2e/desktop-parent-death-electron.cjs') };
  const parentEntry = path.join(root, 'scripts/e2e/desktop-parent-death-parent.mjs'), configFile = path.join(home, 'config.json');
  const bootstrapEntry = path.join(root, 'scripts/e2e/desktop-parent-death-bootstrap.mjs');
  const report = { ok: false, mode: options.run ? 'isolated-production-parent-death' : 'compile-only', nonce, runId, output,
    startedAt: new Date().toISOString(), parentRuntime: runtimeKind, parentAttempted: false, bootstrapAttempted: false, cleanup: {},
    scope: 'Actual dist DesktopWorker and production native helper under a separate Medium ' + runtimeKind + ' parent; one owned WinForms provider. This is not a crash of the running ProfilePilot App.',
    limitations: ['No observer, hook, keyboard/pointer action, screenshot, or current App connection.',
      'The planned exact-parent termination is fault injection, distinct from cleanup force; any cleanup force fails acceptance.',
      'Parent and helper original exits are checked independently by PID/birth, never inferred from inherited-pipe close.',
      'Parent exit must be confirmed within 10s from before publishing the observe command, earlier than this pinned worker\'s 12s request timer; late confirmation fails attribution.',
      'One real accessibility Name getter is observed; the fixture does not attribute the getter caller PID.',
      'The 5s helper wait is an observation window, not a real-time scheduling guarantee or proof of cooperative cancellation.',
      'Unrelated window rows are transient discovery data only and are not written into this report.'] };
  const persist = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  let fixtureLife, heartbeat, parentLaunch, parentIdentity, helperIdentity, plannedFault = false, bootstrapLaunch, bootstrapIdentity;
  const inspect = args => JSON.parse(execFileSync(config.identityExe, args, { encoding: 'utf8', windowsHide: true, timeout: 12000 }));
  const wait = (value, ms) => inspect(['--wait-owned-exit', String(value.pid), value.startedUtcTicks, String(ms)]);
  const force = value => inspect(['--cleanup-owned', String(value.pid), value.startedUtcTicks, value.executable, value.sha256, String(value.parentPid)]);
  const parentExpectation = () => ({ nonce, executable: config.parentExecutable, sha256: config.parentHash, runtime: config.runtime });
  const freshState = async () => {
    const after = Date.now();
    return pollProviderFile(() => json(config.parentState), value => value.nonce === nonce && value.capturedAt >= after, 'fresh isolated parent state', 2500);
  };
  const providerState = async () => {
    const after = Date.now();
    return pollProviderFile(() => json(base + '.state.json'), value => value.nonce === nonce && Date.parse(value.capturedAt) >= after, 'fresh owned provider state', 2000);
  };
  const recoverParent = async () => {
    const ready = await pollProviderFile(() => json(config.parentReady), value => value.nonce === nonce, 'parent identity receipt', 5000);
    const value = verifyProbeParent(ready, parentExpectation(), parentLaunch?.pid);
    parentIdentity = report.parentIdentity = value;
    const current = inspect(['--inspect', String(value.pid)]);
    assertOwnedIdentity(current, { pid: value.pid, executable: config.parentExecutable, sha256: config.parentHash, original: value });
    parentIdentity = report.parentIdentity = current;
    report.runtime = ready.runtime;
  };
  const recoverBootstrap = async () => {
    const ready = await pollProviderFile(() => json(config.bootstrapReady), value => value.nonce === nonce, 'bootstrap identity receipt', 5000);
    bootstrapIdentity = report.bootstrapIdentity = verifyProbeParent(ready,
      { nonce, executable: config.nodeExecutable, sha256: config.nodeHash }, bootstrapLaunch?.pid);
    return bootstrapIdentity;
  };
  const bootstrapCompleted = async () => {
    if (!bootstrapIdentity) await recoverBootstrap();
    const receipt = await pollProviderFile(() => json(config.bootstrapClosed), value => value.nonce === nonce, 'bootstrap normal exit receipt', 5000);
    return verifyBootstrapCompletion(receipt, bootstrapIdentity, nonce, wait(bootstrapIdentity, 5000));
  };
  const recoverSpawnedParent = async () => {
    if (!bootstrapIdentity) await recoverBootstrap();
    const receipt = await json(config.bootstrapSpawn); assert.equal(receipt.nonce, nonce);
    const candidate = receipt.identity;
    // A candidate bare PID is diagnostic only. Inspect it and bind every field
    // before it can become an owned cleanup identity.
    const pid = candidate?.pid ?? receipt.pid; assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const current = inspect(['--inspect', String(pid)]);
    assertOwnedIdentity(current, { pid, executable: config.parentExecutable, sha256: config.parentHash, ...(candidate ? { original: candidate } : {}) });
    assert.equal(current.parentPid, bootstrapIdentity.pid);
    parentIdentity = report.parentIdentity = current;
  };
  const recoverHelper = async () => {
    const state = await json(config.parentState); assert.equal(state.nonce, nonce); assert.ok(parentIdentity);
    const candidate = state.helperIdentity || state.helperCandidate;
    if (!candidate) return;
    assert.ok(Number.isSafeInteger(candidate.pid) && candidate.pid > 0);
    const current = inspect(['--inspect', String(candidate.pid)]);
    helperIdentity = report.helperIdentity = verifyProbeHelper(current, parentIdentity,
      config.build.components['dist/native/ProfilePilot.Desktop.exe'], path.join(os.tmpdir(), 'profilepilot-desktop-runtime'));
    if (state.helperIdentity) assertOwnedIdentity(current, { pid: candidate.pid, executable: candidate.executable, sha256: candidate.sha256, original: candidate });
  };
  try {
    config.build = report.build = await verifyParentBuild(root);
    const built = require(path.join(root, 'dist/main/desktop/worker.js'));
    assert.equal(typeof built.DesktopWorker, 'function');
    assert.equal(path.resolve(built.desktopExecutable()).toLowerCase(), path.join(root, 'dist/native/ProfilePilot.Desktop.exe').toLowerCase());
    report.productionModuleLoaded = true;
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compile = (executable, source, refs, target) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/target:' + target,
      '/out:' + executable, ...refs.map(ref => '/r:' + ref + '.dll'), path.join(root, source)], { windowsHide: true, timeout: 30000 });
    compile(config.identityExe, 'scripts/e2e/desktop-observer-fault-identity.cs', ['System.Management', 'System.Web.Extensions'], 'exe');
    compile(config.fixtureExe, 'scripts/e2e/desktop-provider-block-fixture.cs', ['System.Web.Extensions', 'System.Drawing', 'System.Windows.Forms', 'Accessibility'], 'winexe');
    config.nodeExecutable = process.execPath; config.nodeHash = await sha(process.execPath); config.fixtureHash = await sha(config.fixtureExe);
    config.parentExecutable = runtimeKind === 'electron' ? require('electron') : process.execPath;
    config.parentHash = await sha(config.parentExecutable);
    config.runtime = { kind: runtimeKind, ...(runtimeKind === 'electron' ? {
      home, electronVersion: require('electron/package.json').version,
      directories: Object.fromEntries(['userData', 'sessionData', 'logs', 'crashDumps'].map(key => [key, verifyProbeDirectory(home, path.join(home, 'electron-' + key))]))
    } : {}) };
    report.runtimeExpected = config.runtime;
    const files = [fileURLToPath(import.meta.url), parentEntry, path.join(root, 'scripts/e2e/desktop-parent-death-protocol.mjs'),
      bootstrapEntry, config.electronEntry, config.parentExecutable, config.nodeExecutable,
      path.join(root, 'scripts/verify-desktop-provider-block.mjs'), config.identityExe, config.fixtureExe,
      path.join(root, 'dist/main/control-build.json'), ...desktopParentComponents.map(name => path.join(root, name))];
    config.artifacts = report.artifacts = Object.fromEntries(await Promise.all(files.map(async file => [file, await sha(file)])));
    if (!options.run) { report.ok = true; report.guiStarted = false; report.osSampled = false; return report; }
    await assertDesktopAcceptanceWindow();
    fixtureLife = windowStateFixtureLifecycle({ nonce, executable: config.fixtureExe, sha256: config.fixtureHash }, {
      launch: () => launchWindowsUserProcess(config.fixtureExe, [base, nonce], root),
      ready: () => pollProviderFile(() => json(base + '.ready.json'), value => value.nonce === nonce, 'owned fixture ready', 5000),
      inspect: pid => inspect(['--inspect', String(pid)]), requestClose: () => writeFile(base + '.close', nonce),
      closed: () => pollProviderFile(() => json(base + '.closed.json'), value => value.nonce === nonce, 'owned fixture close', 10000), wait, force
    });
    await writeFile(base + '.heartbeat', nonce);
    heartbeat = setInterval(() => { void writeFile(base + '.heartbeat', nonce).catch(error => { report.cleanup.heartbeatError = errorInfo(error); }); }, 1000);
    const fixture = await fixtureLife.launch();
    const fixtureIdentity = report.fixtureIdentity = fixtureLife.pin(inspect(['--inspect', String(fixture.pid)]));
    const ready = report.fixture = await pollProviderFile(() => json(base + '.ready.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'fixture ready', 10000);
    assert.equal(ready.startedUtcTicks, fixtureIdentity.startedUtcTicks); assert.equal(ready.hwnd, ready.currentHwnd);
    assert.equal(ready.nonactivating, true); assert.equal(ready.foregroundBefore, ready.foregroundAfter);
    config.fixture = { pid: fixture.pid, hwnd: ready.hwnd, rootName: ready.rootName };
    await writeFile(configFile, JSON.stringify(config));
    report.parentAttempted = true;
    if (runtimeKind === 'electron') {
      report.bootstrapAttempted = true;
      bootstrapLaunch = await launchWindowsUserProcess(process.execPath, [bootstrapEntry, configFile], root);
      await recoverBootstrap();
      report.bootstrapBeforeFault = await bootstrapCompleted();
      const started = await json(config.bootstrapSpawn); assert.equal(started.nonce, nonce);
      assert.ok(started.identity); assert.equal(started.identity.parentPid, bootstrapIdentity.pid);
      parentLaunch = { pid: started.identity.pid };
    } else parentLaunch = await launchWindowsUserProcess(process.execPath, [parentEntry, configFile], root);
    await recoverParent(); await writeFile(config.parentGo, nonce);
    report.baseline = await pollProviderFile(() => json(config.parentState), value => {
      assert.equal(value.nonce, nonce); if (value.error) throw new Error('Isolated parent setup failed: ' + value.error.code);
      return value.phase === 'baseline-ready';
    }, 'production worker baseline', 20000);
    await recoverHelper(); assert.ok(helperIdentity);
    const expected = { nonce, pid: fixture.pid, startedUtcTicks: fixtureIdentity.startedUtcTicks, hwnd: ready.hwnd, runId };
    await writeFile(base + '.arm.json', JSON.stringify({ nonce, id: runId, expiresAt: Date.now() + 10000 }));
    report.armed = await pollProviderFile(() => json(base + '.armed.json'), value => value.nonce === nonce && value.runId === runId, 'provider armed', 3000);
    for (const key of ['nonce', 'pid', 'startedUtcTicks', 'hwnd', 'runId']) assert.equal(report.armed[key], expected[key]);
    assert.equal(report.armed.phase, 'armed'); assert.equal(report.armed.entries, 0); assert.equal(report.armed.getterActive, false);
    const observationStartedAt = performance.now();
    await writeFile(config.parentObserve, nonce);
    report.trial = {};
    await runParentDeathCase({ expected, parent: parentIdentity, helper: helperIdentity, observationStartedAt }, {
      now: () => performance.now(),
      entered: () => pollProviderFile(() => json(base + '.entered.json'), value => value.nonce === nonce && value.runId === runId, 'getter entry', 8000),
      parentPending: async () => { const value = await freshState(); verifyParentRuntime(value.runtime, config.runtime); return value; }, providerPending: providerState,
      terminateParent: () => { plannedFault = true; return force(parentIdentity); },
      waitParentExit: () => wait(parentIdentity, 5000), waitHelperExit: ms => wait(helperIdentity, ms)
    }, report.trial);
    report.ok = true;
  } catch (error) { report.error = errorInfo(error); }
  finally {
    if (options.run) {
      const clean = async (name, task) => { try { report.cleanup[name] = await task(); } catch (error) { report.cleanup[name + 'Error'] = errorInfo(error); report.ok = false; } };
      // Always release the fixture gate before asking an orphaned helper to finish.
      if (fixtureLife?.attempted) await clean('providerRelease', async () => { await writeFile(base + '.release', nonce + ':' + runId); return true; });
      if (report.parentAttempted) {
        if (!parentIdentity) await clean('parentIdentityRecovery', recoverParent);
        await clean('parentStop', async () => { await writeFile(config.parentStop, nonce); return true; });
        if (!parentIdentity && report.bootstrapAttempted) await clean('spawnedParentIdentityRecovery', recoverSpawnedParent);
        if (!helperIdentity && parentIdentity) await clean('helperIdentityRecovery', recoverHelper);
        if (helperIdentity) await clean('helper', async () => { const result = await retireProbeProcess(helperIdentity, { wait, force }); if (!result.ok) report.ok = false; return result; });
        else { report.cleanup.helperIdentityUnconfirmed = true; report.ok = false; }
        if (parentIdentity) await clean('parent', async () => {
          const result = await retireProbeProcess(parentIdentity, { wait, force }); if (!result.ok) report.ok = false;
          if (!plannedFault) {
            result.receipt = await pollProviderFile(() => json(config.parentClosed), value => value.nonce === nonce, 'parent normal close', 3000);
            assert.equal(result.receipt.pid, parentIdentity.pid); assert.equal(result.receipt.startedUtcTicks, parentIdentity.startedUtcTicks);
            assert.equal(result.receipt.reason, 'requested'); assert.equal(result.receipt.exitCode, 0);
          }
          return result;
        });
        else { report.cleanup.parentIdentityUnconfirmed = true; report.ok = false; }
      }
      if (report.bootstrapAttempted) await clean('bootstrap', async () => {
        if (!bootstrapIdentity) await recoverBootstrap();
        const result = await retireProbeProcess(bootstrapIdentity, { wait, force }); if (!result.ok) report.ok = false;
        result.normal = await bootstrapCompleted(); return result;
      });
      if (fixtureLife?.attempted) await clean('fixture', async () => {
        const result = await fixtureLife.cleanup(); if (!result.ok || result.receipt?.getterPending !== false) report.ok = false; return result;
      });
      clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
      if (config.artifacts) await clean('artifactsUnchanged', async () => { await verifyArtifacts(config.artifacts); return true; });
    }
    report.finishedAt = new Date().toISOString(); await persist();
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyDesktopParentDeath(parentDeathOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: result.ok, mode: result.mode, output: result.output, error: result.error }));
  if (!result.ok) process.exitCode = 1;
}
