import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), json = async file => JSON.parse(await readFile(file, 'utf8'));
export function parseNoticeChainArgs(args) {
  let mode, kind = 'throw', seenCase = false;
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--run'].includes(args[i]) && !mode) mode = args[i];
    else if (args[i] === '--case' && !seenCase) { seenCase = true; kind = args[++i]; }
    else throw new Error('Use [--check | --run] [--case throw | rejection]');
  }
  assert.ok(['throw', 'rejection'].includes(kind)); return { run: mode === '--run', kind };
}
export function noticeChainLayout(home) {
  const entry = path.join(home, 'dist/main/desktop/main.cjs'), directory = path.dirname(entry);
  return { entry, public: path.resolve(directory, '../../../public'), preload: path.resolve(directory, '../../desktop-preload.js'),
    desktop: path.resolve(directory, '../../native/ProfilePilot.Desktop.exe'), observer: path.resolve(directory, '../../native/ProfilePilot.InputObserver.exe') };
}
export async function retireNoticeChainOwned(identity, io) {
  const result = { pid: identity?.pid, errors: [], forcedAttempts: [] };
  const failure = (stage, error) => { result.errors.push({ stage, message: error.message }); };
  let exited = false;
  try { result.wait = await io.wait(identity, 10000); exited = result.wait.originalExited === true; }
  catch (error) { failure('wait', error); }
  if (!exited) {
    const attempt = { identity, attempted: false }; result.forcedAttempts.push(attempt);
    try {
      assert.ok(Number.isSafeInteger(identity?.pid) && identity.pid > 0 && Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0);
      assert.match(identity.startedUtcTicks || '', /^[1-9]\d{15,18}$/); assert.match(identity.sha256 || '', /^[a-f0-9]{64}$/);
      assert.ok(path.win32.isAbsolute(identity.executable)); assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
      attempt.attempted = true; attempt.result = await io.force(identity);
    } catch (error) { attempt.error = error.message; failure('force', error); }
    try { result.afterForce = await io.wait(identity, 10000); exited = result.afterForce.originalExited === true; }
    catch (error) { failure('after-force-wait', error); }
  }
  result.originalExited = exited;
  result.ok = exited && !result.errors.length && !result.forcedAttempts.length;
  return result;
}
async function poll(read, accept, label, timeout = 12000) {
  const deadline = Date.now() + timeout; let last;
  do {
    try { last = await read(); if (accept(last)) return last; }
    catch (error) { if (!['ENOENT', 'SAMPLE_UNSTABLE'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  } while (Date.now() < deadline);
  throw Object.assign(new Error(label + ' deadline'), { last });
}
async function atomic(file, value) { await writeFile(file + '.tmp', JSON.stringify(value)); await rename(file + '.tmp', file); }

export async function verifyNoticeChain(options) {
  assert.equal(process.platform, 'win32');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-notice-chain-')), output = path.join(root, '.tools/desktop-verification', path.basename(home));
  const layout = noticeChainLayout(home), base = path.join(home, 'main'), fixtureBase = path.join(home, 'fixture');
  await Promise.all([mkdir(output, { recursive: true }), mkdir(path.dirname(layout.entry), { recursive: true }), mkdir(layout.public, { recursive: true }), mkdir(path.dirname(layout.desktop), { recursive: true })]);
  const identityExe = path.join(home, 'Identity.exe'), fixtureExe = path.join(home, 'DesktopFixture.exe'), samplerExe = path.join(home, 'Sample.exe');
  const report = { ok: false, scope: 'isolated-registerDesktop-chain', case: options.kind, mode: options.run ? 'run' : 'compile-only', home, output,
    startedAt: new Date().toISOString(), actualAppFaultInjected: false, physicalInputInjected: false, managementServerStarted: false,
    productionSourcesChanged: null, casesAutoResumed: false, checks: [], cleanup: {}, commands: [],
    limitations: ['Production registerDesktop/Service/defaultWorker/Runtime/observer run in an isolated Medium Electron main, not the user App entry.',
      'Admission recognizes only the pinned owned WinForms target; real Profile/Electron catalogs and global shortcut registration are excluded.',
      'Fault injection is owned main-world JavaScript, not an OS crash. No pointer/keyboard input or hardware takeover is simulated.',
      'No competing hook is installed if the fixed production observer instance gate is occupied. Unexpected takeover is never resumed.'] };
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = (out, refs, sources, target = 'exe') => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/target:' + target, '/out:' + out,
    ...refs.map(name => '/r:' + name + '.dll'), ...sources.map(file => path.join(root, file))], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  compile(identityExe, ['System.Management', 'System.Web.Extensions'], ['scripts/e2e/desktop-observer-fault-identity.cs']);
  compile(samplerExe, ['System.Windows.Forms', 'System.Drawing', 'System.Management', 'System.Web.Extensions'], ['scripts/e2e/desktop-session-cycle-fixture.cs']);
  compile(fixtureExe, ['System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions'], ['scripts/e2e/desktop-takeover-fixture.cs', 'scripts/e2e/assisted-foreground-fixture.cs'], 'winexe');
  const bundle = buildSync({ entryPoints: [path.join(root, 'scripts/e2e/desktop-notice-chain-main.ts')], outfile: layout.entry, bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent', metafile: true });
  report.bundleSources = Object.fromEntries(await Promise.all(Object.keys(bundle.metafile.inputs).filter(file => /^(src|scripts)[/\\]/.test(file))
    .map(async file => [file, hash(await readFile(path.join(root, file)))])));
  execFileSync(process.execPath, ['--check', layout.entry], { windowsHide: true, timeout: 10000 });
  const assets = [['dist/desktop-preload.js', layout.preload], ['dist/native/ProfilePilot.Desktop.exe', layout.desktop], ['dist/native/ProfilePilot.InputObserver.exe', layout.observer],
    ...['desktop-control.html', 'desktop-control.js', 'desktop.css'].map(name => ['public/' + name, path.join(layout.public, name)])];
  report.assets = {};
  for (const [source, dest] of assets) { const before = await readFile(path.join(root, source)); await copyFile(path.join(root, source), dest);
    assert.equal(hash(await readFile(dest)), hash(before)); report.assets[source] = { sha256: hash(before), copiedTo: dest }; }
  report.hashes = { main: hash(await readFile(layout.entry)), fixture: hash(await readFile(fixtureExe)), identity: hash(await readFile(identityExe)), sampler: hash(await readFile(samplerExe)) };
  const policies = createRequire(import.meta.url)(layout.entry); // Entry guard prevents any GUI/helper startup in Node.
  if (!options.run) {
    report.ok = true; report.guiStarted = false; report.hooksInstalled = false;
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); return report;
  }
  await assertDesktopAcceptanceWindow();
  const nonce = randomBytes(16).toString('hex'), session = 'notice-chain-' + randomUUID(), electron = createRequire(import.meta.url)('electron');
  Object.assign(report, { nonce, session });
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  let originalApp, originalIdentity, fixture, fixtureIdentity, main, mainIdentity, ready, heartbeat, fixtureAttempted = false, mainAttempted = false;
  const id = (args, timeout = 16000) => {
    const value = JSON.parse(execFileSync(identityExe, args, { encoding: 'utf8', windowsHide: true, timeout })); assert.equal(value.ok, true, value.error); return value;
  };
  const sameIdentity = (actual, expected) => {
    for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'sha256']) assert.equal(actual[key], expected[key]);
    assert.equal(path.resolve(actual.executable).toLowerCase(), path.resolve(expected.executable).toLowerCase());
    assert.equal(actual.integrityRid, 8192); assert.equal(actual.elevated, false); assert.equal(actual.uiAccess, false);
  };
  async function appCommand(args) {
    assert.ok(args.join(' ') === 'status' || args.join(' ') === 'desktop status', 'User App is inspected read-only');
    return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...args, '--json'], env, cwd: root, timeoutMs: 70000, expectedExitCode: 0 })).response;
  }
  async function appPreflight() {
    const status = await appCommand(['status']); assert.equal(status.ok, true); const app = status.data;
    const identity = id(['--inspect', String(app.pid)]);
    assert.equal(path.resolve(identity.executable).toLowerCase(), path.resolve(electron).toLowerCase()); assert.equal(identity.sha256, hash(await readFile(electron)));
    assert.equal(identity.integrityRid, 8192); assert.equal(identity.elevated, false); assert.equal(identity.uiAccess, false);
    assert.ok(Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0); assert.match(identity.startedUtcTicks, /^[1-9]\d{15,18}$/);
    const build = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(app.build.buildId, build.buildId); assert.equal(path.resolve(app.build.entry), path.join(root, 'dist/main/entry.js'));
    assert.equal(hash(await readFile(path.join(root, 'dist/main/profilepilot-cli.cjs'))), build.cliSha256);
    if (originalApp) { assert.equal(app.pid, originalApp.pid); assert.equal(app.build.startedAt, originalApp.build.startedAt); assert.equal(app.build.buildId, originalApp.build.buildId); sameIdentity(identity, originalIdentity); }
    const desktop = await appCommand(['desktop', 'status']); assert.equal(desktop.ok, true); assert.equal(desktop.result.session, null);
    const sample = await poll(async () => {
      let raw; try { raw = execFileSync(samplerExe, ['--sample', String(app.pid), electron, identity.startedUtcTicks], { windowsHide: true, timeout: 10000, encoding: 'utf8' }); }
      catch (error) { let detail; try { detail = JSON.parse(error.stdout); } catch {} if (detail?.code === 'SAMPLE_UNSTABLE') throw Object.assign(new Error(detail.message), { code: detail.code }); throw error; }
      const value = JSON.parse(raw); assert.equal(value.ok, true); return value;
    }, () => true, 'stable user App process sample');
    assert.equal(sample.children.filter(child => child.kind === 'input-observer').length, 0, 'Existing App observer must not be disturbed');
    return { app, identity, desktop: desktop.result, sample };
  }
  async function request(action, extra = {}, timeout = 70000) {
    const value = { id: randomUUID(), nonce, expiresAt: Date.now() + 85000, action, ...extra };
    await atomic(base + '.request.json', value);
    const response = await poll(() => json(base + '.response.json'), result => result.id === value.id, 'private ' + action, timeout);
    report.commands.push({ action, method: extra.command?.method, response }); return response;
  }
  async function desktop(method, extra = {}, expected = true) {
    const result = await request('desktop', { command: { action: 'desktop', method, ...(!['status', 'windows'].includes(method) ? { session } : {}), ...extra } });
    assert.equal(result.ok, expected, result.message); return result;
  }
  const inspect = async () => { const response = await request('inspect', {}, 15000); assert.equal(response.ok, true, response.message); return response.result; };
  async function receipt() { const value = await json(fixtureBase + '.input.json'); assert.equal(value.nonce, nonce); assert.equal(value.pid, fixture.pid); return value; }
  async function action(snapshot, value, expected = true) {
    const edits = snapshot.elements.filter(element => element.role === 'Edit' && element.name === 'Takeover owned edit'); assert.equal(edits.length, 1);
    const requestId = randomUUID(), params = { kind: 'set_value', ref: edits[0].reference, version: snapshot.version, value };
    return { requestId, response: await desktop('action', { requestId, params }, expected) };
  }
  try {
    report.appBefore = await appPreflight(); originalApp = report.appBefore.app; originalIdentity = report.appBefore.identity;
    await Promise.all([writeFile(base + '.heartbeat', nonce), writeFile(fixtureBase + '.heartbeat', nonce)]);
    heartbeat = setInterval(() => { for (const file of [base, fixtureBase]) void writeFile(file + '.heartbeat', nonce).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000); heartbeat.unref();
    await assertDesktopAcceptanceWindow(); fixtureAttempted = true;
    fixture = await launchWindowsUserProcess(fixtureExe, [fixtureBase, nonce, 'b22345678901def0'], root);
    fixtureIdentity = report.fixtureIdentity = id(['--inspect', String(fixture.pid)]); assert.equal(fixtureIdentity.sha256, report.hashes.fixture); assert.equal(path.resolve(fixtureIdentity.executable), fixtureExe);
    assert.equal(fixtureIdentity.integrityRid, 8192); assert.equal(fixtureIdentity.elevated, false); assert.equal(fixtureIdentity.uiAccess, false);
    const target = report.target = await poll(() => json(fixtureBase + '.environment.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'owned WinForms ready');
    assert.equal(target.startedUtcTicks, fixtureIdentity.startedUtcTicks); assert.equal(target.administrator, false); assert.equal(target.hooksInstalled, false);
    const config = { home, nonce, session, case: options.kind, target, targetIdentity: fixtureIdentity, identityExecutable: identityExe,
      desktopHash: report.assets['dist/native/ProfilePilot.Desktop.exe'].sha256, observerHash: report.assets['dist/native/ProfilePilot.InputObserver.exe'].sha256,
      gateModule: path.join(root, 'scripts/e2e/desktop-acceptance-window.mjs') };
    const configFile = path.join(home, 'config.json'); await writeFile(configFile, JSON.stringify(config), { flag: 'wx' });
    await assertDesktopAcceptanceWindow(); mainAttempted = true;
    main = await launchWindowsUserProcess(electron, [layout.entry, configFile], root);
    mainIdentity = report.mainIdentity = id(['--inspect', String(main.pid)]); assert.equal(mainIdentity.sha256, originalIdentity.sha256); sameIdentity(mainIdentity, { ...mainIdentity, executable: electron });
    ready = report.ready = await poll(async () => {
      try { const failure = await json(base + '.failure.json'); throw new Error('Isolated main: ' + failure.message); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(base + '.ready.json');
    }, value => value.nonce === nonce && value.pid === main.pid, 'isolated production IPC ready');
    sameIdentity(ready.identity, mainIdentity); assert.equal(ready.status.session, null); assert.equal(ready.spawnCount, 0);
    const listed = (await desktop('windows')).result.windows.filter(window => window.pid === target.pid && window.nativeHandle === target.hwnd);
    assert.equal(listed.length, 1); const selected = listed[0];
    const claimed = (await desktop('claim', { windowId: selected.id })).result;
    assert.equal(claimed.session.name, session); assert.equal(claimed.session.state, 'active'); assert.equal(claimed.inputObservation.phase, 'ready');
    let snapshot = (await desktop('observe')).result;
    const baseline = report.baseline = await action(snapshot, 'notice-chain-baseline'); assert.equal(baseline.response.result.executed, true);
    const before = report.inputBefore = await poll(receipt, value => value.text === 'notice-chain-baseline', 'owned baseline UIA effect'); assert.equal(before.foreign.attempted, false);
    const historical = report.historical = (await desktop('receipt', { requestId: baseline.requestId })).result;
    snapshot = (await desktop('observe')).result; report.freshObservation = snapshot;
    const pre = report.beforeFault = await inspect(); assert.equal(pre.status.session.state, 'active'); assert.equal(pre.status.inputObservation.phase, 'ready');
    assert.equal(pre.toolbar.exactOwnedFile, true); assert.equal(pre.toolbar.visible, true); assert.equal(pre.spawnCount, 1); assert.equal(pre.browserFactoryCalls, 0);
    const owner = pre.drivers.find(driver => driver.roles.includes('owner')); assert.ok(owner?.identity); assert.equal(owner.identity.parentPid, main.pid); assert.equal(pre.observer.identity.parentPid, main.pid);
    report.fault = await request('fault', { epoch: pre.status.inputObservation.epoch, generation: pre.status.inputObservation.generation,
      version: snapshot.version, webContentsId: pre.toolbar.webContentsId, documentNonce: pre.toolbar.documentNonce }, 15000);
    assert.equal(report.fault.ok, true, report.fault.message); assert.equal(report.fault.result.scheduled, true);
    const after = report.afterFault = await poll(inspect, value => value.status.session?.state === 'paused' && value.runtime.stopConfirmed && value.observer?.closed
      && value.drivers.some(driver => driver.roles.includes('owner') && driver.stopConfirmed && driver.closed), 'notice pause and native retirement');
    policies.validateNoticeChainEvidence(after, { nonce, session, case: options.kind, generation: pre.status.inputObservation.generation, epoch: pre.status.inputObservation.epoch });
    report.checks.push('Actual active production IPC/Service/Runtime chain pauses for the owned post-ready notice failure and retires observer/owner driver');
    const rejected = report.rejected = await action(snapshot, 'MUST-NOT-APPEAR', false); assert.equal(rejected.response.code, 'DESKTOP_USER_IN_CONTROL');
    assert.deepEqual(await receipt(), before); assert.deepEqual((await desktop('receipt', { requestId: baseline.requestId })).result, historical);
    assert.deepEqual(await receipt(), before); report.checks.push('Old UIA action is rejected with unchanged fixture text/counters and historical receipt');
    await delay(2200);
    const stable = report.noRecovery = await inspect(); policies.validateNoticeChainEvidence(stable, { nonce, session, case: options.kind, generation: pre.status.inputObservation.generation, epoch: pre.status.inputObservation.epoch });
    assert.deepEqual(stable.status.inputObservation, after.status.inputObservation); assert.deepEqual(await receipt(), before);
    report.checks.push('No automatic notice recreation, ARM, helper restart or session resume');
    report.ok = true;
  } catch (error) { report.error = { message: error.message, code: error.code, last: error.last }; }
  finally {
    const cleanup = async (name, operation) => { try { report.cleanup[name] = await operation(); } catch (error) { report.cleanup[name + 'Error'] = error.message; report.ok = false; } };
    if (mainAttempted) {
      await cleanup('mainCloseRequest', () => atomic(base + '.request.json', { id: randomUUID(), nonce, expiresAt: Date.now() + 85000, action: 'close' }));
      await cleanup('mainReceipt', async () => { const value = await poll(() => json(base + '.closed.json'), result => result.nonce === nonce, 'isolated main clean receipt', 20000); assert.equal(value.cleanupConfirmed, true); return value; });
      await cleanup('mainExit', async () => {
        if (!mainIdentity) {
          const boot = await json(base + '.boot.json'); assert.equal(boot.nonce, nonce); mainIdentity = boot.identity; if (main) assert.equal(mainIdentity.pid, main.pid);
          assert.equal(path.resolve(mainIdentity.executable).toLowerCase(), path.resolve(electron).toLowerCase()); assert.equal(mainIdentity.sha256, originalIdentity.sha256);
          report.mainIdentity = mainIdentity;
        }
        const value = await retireNoticeChainOwned(mainIdentity, { wait: (identity, ms) => id(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, String(ms)]),
          force: identity => id(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]) });
        if (!value.ok) report.ok = false; return value;
      });
      // The main process may have failed before writing its final receipt.
      // Independently confirm every exact native identity already observed;
      // a force fallback is recorded as a failed run even if EOF also cleaned it.
      const known = new Map();
      for (const evidence of [report.beforeFault, report.afterFault, report.noRecovery, report.cleanup.mainReceipt]) {
        for (const item of [...(evidence?.drivers || []), ...(evidence?.observer ? [evidence.observer] : [])]) {
          const identity = item.identity; if (identity) known.set(identity.pid + ':' + identity.startedUtcTicks, identity);
        }
      }
      report.cleanup.nativeExits = [];
      for (const identity of known.values()) await cleanup('native:' + identity.pid, async () => {
        assert.equal(identity.parentPid, mainIdentity.pid);
        const value = await retireNoticeChainOwned(identity, { wait: (actual, ms) => id(['--wait-owned-exit', String(actual.pid), actual.startedUtcTicks, String(ms)]),
          force: actual => id(['--cleanup-owned', String(actual.pid), actual.startedUtcTicks, actual.executable, actual.sha256, String(actual.parentPid)]) });
        report.cleanup.nativeExits.push(value); if (!value.ok) report.ok = false; return value;
      });
    }
    if (fixtureAttempted) {
      await cleanup('fixtureCloseRequest', () => writeFile(fixtureBase + '.close', nonce));
      await cleanup('fixtureReceipt', async () => { const value = await poll(() => json(fixtureBase + '.closed.json'), result => result.nonce === nonce, 'owned WinForms clean receipt'); assert.equal(value.pid, fixture?.pid); return value; });
      await cleanup('fixtureExit', async () => {
        if (!fixtureIdentity) {
          const environment = await json(fixtureBase + '.environment.json'); assert.equal(environment.nonce, nonce);
          if (fixture) assert.equal(environment.pid, fixture.pid);
          fixtureIdentity = id(['--inspect', String(environment.pid)]); assert.equal(fixtureIdentity.startedUtcTicks, environment.startedUtcTicks);
          assert.equal(path.resolve(fixtureIdentity.executable), fixtureExe); assert.equal(fixtureIdentity.sha256, report.hashes.fixture);
          report.fixtureIdentity = fixtureIdentity;
        }
        const value = await retireNoticeChainOwned(fixtureIdentity, { wait: (identity, ms) => id(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, String(ms)]),
          force: identity => id(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]) });
        if (!value.ok) report.ok = false; return value;
      });
    }
    if (heartbeat) clearInterval(heartbeat);
    if (report.cleanup.heartbeatError) report.ok = false;
    if (originalApp) await cleanup('userAppAfter', appPreflight);
    let unchanged = true;
    for (const [source, expected] of [...Object.entries(report.assets).map(([source, asset]) => [source, asset.sha256]), ...Object.entries(report.bundleSources)]) {
      await cleanup('sourceUnchanged:' + source, async () => {
        try { const same = hash(await readFile(path.join(root, source))) === expected; unchanged &&= same; assert.equal(same, true); return true; }
        catch (error) { unchanged = false; throw error; }
      });
    }
    report.productionSourcesChanged = !unchanged;
    report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await verifyNoticeChain(parseNoticeChainArgs(process.argv.slice(2))); console.log(JSON.stringify({ ok: result.ok, mode: result.mode, case: result.case,
    output: result.output, checks: result.checks, error: result.error,
    cleanup: { mainExited: result.cleanup.mainExit?.ok, fixtureExited: result.cleanup.fixtureExit?.ok,
      nativeExited: result.cleanup.nativeExits?.every(value => value.ok), userAppIdle: result.cleanup.userAppAfter?.desktop.session === null,
      errors: Object.fromEntries(Object.entries(result.cleanup).filter(([key]) => key.endsWith('Error'))) } })); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ ok: false, message: error.message })); process.exitCode = 1; }
}
