import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';
import { confirmToolbarExit, toolbarViewport } from './verify-desktop-toolbar-layout.mjs';

export const noticeCases = ['normal', 'missing-js', 'script-throw', 'no-ack', 'missing-preload'];
export const postReadyCases = ['post-ready-throw', 'post-ready-rejection'];
export function parseOptions(args) {
  let mode, suite = 'startup', caseSet = false;
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--run'].includes(args[i]) && !mode) mode = args[i];
    else if (args[i] === '--case' && !caseSet) { caseSet = true; suite = args[++i]; }
    else throw new Error('Use [--check | --run] [--case post-ready]');
  }
  assert.ok(suite === 'post-ready' || !caseSet && suite === 'startup', 'Unknown case suite');
  return { run: mode === '--run', suite };
}
export function fixtureAsset(kind, filename, original) {
  assert.ok([...noticeCases, ...postReadyCases].includes(kind)); assert.ok(['desktop-control.html', 'desktop.css', 'desktop-control.js'].includes(filename));
  if (filename !== 'desktop-control.js') return original;
  if (kind === 'missing-js') return undefined;
  if (kind === 'script-throw') return "throw new Error('Owned notice fixture script failed');\n";
  if (kind === 'no-ack') return '';
  return original;
}
export function assertRuntimeResult(value, nonce, identity) {
  assert.equal(value.nonce, nonce); assert.equal(value.pid, identity.pid); assert.equal(value.startedUtcTicks, identity.startedUtcTicks);
  for (const field of ['realDesktopService', 'realObserver', 'realDriver', 'hooksInstalled', 'inputInjected']) assert.equal(value[field], false);
  assert.equal(value.ok, true); assert.equal(value.readyCount, 2); assert.equal(value.windowsDestroyed, true); assert.deepEqual(value.controls, []);
  assert.deepEqual(value.cases.map(item => item.case), ['normal-first', 'normal-reuse', ...noticeCases.slice(1)]);
  for (const item of value.cases.slice(0, 2)) { assert.equal(item.expectedReady, true); assert.equal(item.ready, true); assert.equal(item.code, undefined); }
  const reused = value.cases[1]; assert.equal(reused.sameWindow, true); assert.equal(reused.sameDocumentNonce, true); assert.equal(reused.hiddenBetween, true);
  const firstAck = value.messages.find(item => item.case === 'normal' && item.type === 'notice-ready' && item.generation === 'first');
  const secondAck = value.messages.find(item => item.case === 'normal' && item.type === 'notice-ready' && item.generation === 'second');
  assert.match(firstAck?.documentNonce || '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(secondAck?.documentNonce, firstAck.documentNonce, 'Both generations must independently ACK the same document');
  assert.equal(value.messages.some(item => item.case !== 'normal' && item.type === 'notice-ready'), false, 'Broken documents must never ACK readiness');
  for (const item of value.cases.slice(2)) {
    assert.equal(item.expectedReady, false); assert.equal(item.ready, false); assert.equal(item.code, 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE'); assert.equal(item.windowDestroyed, true);
  }
  const noAck = value.cases.find(item => item.case === 'no-ack'); assert.ok(noAck.elapsedMs >= 4900 && noAck.elapsedMs < 15000, 'No ACK must exercise the production 5s deadline');
}
export function assertPostReadyResult(value, nonce, identity) {
  assert.equal(value.nonce, nonce); assert.equal(value.pid, identity.pid); assert.equal(value.startedUtcTicks, identity.startedUtcTicks);
  for (const field of ['realDesktopService', 'realObserver', 'realDriver', 'hooksInstalled', 'inputInjected']) assert.equal(value[field], false);
  assert.equal(value.suite, 'post-ready'); assert.equal(value.ok, true); assert.equal(value.readyCount, 2);
  assert.equal(value.windowsDestroyed, true); assert.deepEqual(value.controls, []);
  assert.deepEqual(value.cases.map(item => item.case), postReadyCases);
  for (const item of value.cases) {
    assert.equal(item.expectedReady, true); assert.equal(item.ready, true); assert.equal(item.code, undefined); assert.equal(item.faultScheduled, true);
    assert.equal(item.postFault.faultFired, true); assert.equal(item.postFault.automaticallyDestroyed, true); assert.equal(item.postFault.authorityRevoked, true);
    assert.equal(item.postFault.phase, 'paused'); assert.equal(item.postFault.unavailableCallback, true); assert.equal(item.postFault.unavailableMessage, true);
    assert.equal(item.windowDestroyed, true);
  }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(read, accept, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs; let value;
  while (Date.now() < deadline) {
    try { value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw Object.assign(new Error(label + ' timed out'), { last: value });
}

export async function main(args = process.argv.slice(2)) {
  const { run, suite } = parseOptions(args); assert.equal(process.platform, 'win32');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-notice-runtime-')), nonce = randomBytes(16).toString('hex');
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const reportFile = path.join(output, 'report.json'), base = path.join(home, 'fixture');
  const mainFile = path.join(home, 'notice-runtime.cjs'), preload = path.join(home, 'notice-preload.cjs'), identityExe = path.join(home, 'NoticeIdentity.exe');
  const configFile = path.join(home, 'config.json'), electron = path.join(root, 'node_modules/electron/dist/electron.exe');
  const report = { ok: false, mode: run ? 'real-electron-notice' : 'check', suite, startedAt: new Date().toISOString(), fixtureStarted: false,
    inputActionCommandsSent: 0, commands: [], cleanup: {},
    normalCapturePlanned: suite === 'startup',
    scope: 'Real production DesktopControlNotice and sandbox preload with copied public assets in an independent Medium Electron process. Host uses fake status/controls only; no DesktopService, driver, observer or hooks in fixture. '
      + (suite === 'startup' ? 'Normal bar is observed and captured by the real App through ppilot.' : 'Post-ready cases use only real App idle-status preflight; no claim, screenshot or input commands are sent.'),
    limitations: ['Fault cases prove the isolated real Electron notice lifecycle, not the complete real App control chain.',
      'The actual registerDesktop + DesktopService integration is covered separately by fake-Electron unit tests.',
      'A simulated paused/active label is not a real App owner. This harness never resumes a paused real App owner.',
      'showInactive and visible readiness are not proof of autonomous activation, mixed DPI, or input delivery.'] };
  const persist = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  let fixture, identity, heartbeat, session;
  const execIdentity = parameters => JSON.parse(execFileSync(identityExe, parameters, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  async function cli(parameters) {
    assert.ok(!parameters.includes('action'), 'No input actions allowed'); const record = { parameters }; report.commands.push(record);
    const result = await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...parameters, '--json'], cwd: root, env, expectedExitCode: 0, timeoutMs: 70000 });
    record.exitCode = result.exitCode; record.response = result.response; return result.response;
  }
  const desktop = parameters => cli(['desktop', ...parameters]);
  const active = value => {
    assert.equal(value.session?.name, session); assert.equal(value.session.state, 'active'); assert.equal(value.session.window.pid, fixture.pid);
    assert.equal(value.inputObservation.phase, 'ready'); assert.notEqual(value.inputObservation.unobservedTestDriver, true);
  };
  const receipt = async suffix => {
    try { const failure = await json(base + '.failure.json'); throw Object.assign(new Error(failure.message || 'Fixture failed'), { fixtureFailure: failure }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return json(base + suffix);
  };
  try {
    const sources = ['src/main/desktop/notice.ts', 'src/main/desktop/errors.ts', 'src/desktop-preload.ts', 'src/shared/desktop.ts', 'src/main/desktop/ipc.ts',
      'public/desktop-control.html', 'public/desktop.css', 'public/desktop-control.js', 'scripts/e2e/desktop-notice-runtime.ts',
      'scripts/verify-desktop-notice.mjs', 'scripts/e2e/desktop-observer-fault-identity.cs'];
    report.sources = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(path.join(root, file)))])));
    for (const [entry, outfile] of [['scripts/e2e/desktop-notice-runtime.ts', mainFile], ['src/desktop-preload.ts', preload]]) {
      buildSync({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent' });
      execFileSync(process.execPath, ['--check', outfile], { windowsHide: true, timeout: 10000 });
    }
    report.assets = {};
    for (const kind of suite === 'post-ready' ? postReadyCases : noticeCases) {
      const directory = path.join(home, 'assets', kind); await mkdir(directory, { recursive: true });
      report.assets[kind] = {};
      for (const name of ['desktop-control.html', 'desktop.css', 'desktop-control.js']) {
        const body = fixtureAsset(kind, name, await readFile(path.join(root, 'public', name), 'utf8'));
        report.assets[kind][name] = body === undefined ? { absent: true } : { sha256: hash(body) };
        if (body !== undefined) await writeFile(path.join(directory, name), body);
      }
    }
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/warnaserror+', `/out:${identityExe}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
      path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    await writeFile(configFile, JSON.stringify({ nonce, suite, preload, identityExe, viewport: toolbarViewport(await readFile(path.join(root, 'src/main/desktop/ipc.ts'), 'utf8')) }));
    report.artifacts = Object.fromEntries(await Promise.all([mainFile, preload, identityExe, configFile].map(async file => [path.basename(file), hash(await readFile(file))])));
    for (const file of sources) assert.equal(hash(await readFile(path.join(root, file))), report.sources[file], 'Source changed during compilation');
    if (!run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    report.runtime = await cli(['status']); assert.equal(report.runtime.ok, true);
    assert.equal(path.resolve(report.runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
    report.initialStatus = (await desktop(['status'])).result; assert.equal(report.initialStatus.session, null, 'Existing owner must be left untouched');
    report.manifest = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(report.runtime.data.build.buildId, report.manifest.buildId);
    assert.equal(hash(await readFile(path.join(root, 'dist/main/profilepilot-cli.cjs'))), report.manifest.cliSha256);
    const electronHash = hash(await readFile(electron));
    report.appIdentity = execIdentity(['--inspect', String(report.runtime.data.pid)]);
    assertOwnedIdentity(report.appIdentity, { pid: report.runtime.data.pid, executable: electron, sha256: electronHash });
    await writeFile(base + '.heartbeat', nonce);
    heartbeat = setInterval(() => { const now = new Date(); void utimes(base + '.heartbeat', now, now).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
    fixture = await launchWindowsUserProcess(electron, [mainFile, home, nonce, configFile], home); report.fixtureStarted = true;
    identity = execIdentity(['--inspect', String(fixture.pid)]); report.identity = identity;
    assertOwnedIdentity(identity, { pid: fixture.pid, executable: electron, sha256: electronHash });
    if (suite === 'startup') {
    const ready = report.fixture = await poll(() => receipt('.ready.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'normal notice ready', 20000);
    assert.equal(ready.startedUtcTicks, identity.startedUtcTicks); assert.equal(ready.realDesktopService, false); assert.equal(ready.hooksInstalled, false); assert.equal(ready.inputInjected, false);
    assertOwnedIdentity(ready.identity, { pid: fixture.pid, executable: electron, sha256: electronHash, original: identity });
    const target = (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === ready.hwnd); assert.ok(target, 'Exact normal fixture window not enumerated');
    session = 'notice-runtime-' + randomUUID(); active((await desktop(['claim', '--session', session, '--window', target.id])).result);
    report.observation = (await desktop(['observe', '--session', session])).result;
    active((await desktop(['status'])).result); await assertDesktopAcceptanceWindow();
    report.screenshot = (await desktop(['screenshot', '--session', session, '--image-only', '--output', path.join(output, 'normal.jpg')])).result.image;
    assert.ok(report.screenshot.width > 0 && report.screenshot.height > 0); active((await desktop(['status'])).result);
    const completed = await desktop(['complete', '--session', session, '--require-active']); assert.equal(completed.result.session, null); session = undefined;
    await assertDesktopAcceptanceWindow(); assert.equal((await desktop(['status'])).result.session, null);
    await writeFile(base + '.advance', nonce);
    }
    report.result = await poll(() => receipt('.done.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'notice fault matrix', 35000);
    if (suite === 'post-ready') assertPostReadyResult(report.result, nonce, identity);
    else assertRuntimeResult(report.result, nonce, identity);
    for (const file of sources) assert.equal(hash(await readFile(path.join(root, file))), report.sources[file], 'Source changed during acceptance');
    const final = await cli(['status']); assert.equal(final.data.pid, report.runtime.data.pid); assert.equal(final.data.build.buildId, report.runtime.data.build.buildId);
    assert.equal(final.data.build.startedAt, report.runtime.data.build.startedAt);
    assertOwnedIdentity(execIdentity(['--inspect', String(fixture.pid)]), { pid: fixture.pid, executable: electron, sha256: electronHash, original: identity });
    report.ok = true;
  } catch (error) {
    report.error = { message: error.message, code: error.code, response: error.response, last: error.last, fixtureFailure: error.fixtureFailure };
  } finally {
    if (session) try {
      const current = (await desktop(['status'])).result;
      if (current.session?.name === session) report.cleanup.release = await desktop(['release', '--session', session]);
      else assert.equal(current.session, null, 'Different owner left untouched');
    } catch (error) { report.ok = false; report.cleanup.sessionError = error.message; }
    if (fixture) {
      try {
        await writeFile(base + '.close', nonce);
        report.cleanup.receipt = await poll(() => json(base + '.closed.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'fixture close');
        assert.equal(report.cleanup.receipt.startedUtcTicks, identity?.startedUtcTicks); assert.equal(report.cleanup.receipt.reason, 'requested'); assert.equal(report.cleanup.receipt.windowsDestroyed, true);
      } catch (error) { report.ok = false; report.cleanup.receiptError = error.message; }
      try {
        assert.ok(identity, 'No pinned identity; no forced cleanup permitted');
        report.cleanup.exit = await confirmToolbarExit(
          () => execIdentity(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, '5000']),
          () => execIdentity(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]));
        if (!report.cleanup.exit.ok) report.ok = false;
      } catch (error) { report.ok = false; report.cleanup.exitError = error.message; }
      for (const [name, suffix] of [['fixtureBoot', '.boot.json'], ['fixtureFailure', '.failure.json'], ['fixtureCases', '.cases.json']]) {
        try { report[name] = await json(base + suffix); } catch (error) { report[name] = { available: false, code: error.code }; }
      }
    }
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: reportFile, fixtureStarted: report.fixtureStarted }));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { if (!(await main()).ok) process.exitCode = 1; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
