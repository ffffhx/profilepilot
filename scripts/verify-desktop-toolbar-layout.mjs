import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';

const require = createRequire(import.meta.url);
const { stages } = require('./e2e/desktop-toolbar-layout-main.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function selectMessageModel(reasons, describe, error, nonce) {
  assert.ok(Array.isArray(reasons) && reasons.length > 0);
  const candidates = reasons.map(reason => ({ reason, message: describe(reason) }));
  assert.ok(candidates.every(value => typeof value.message === 'string' && value.message.length > 0));
  candidates.sort((a, b) => b.message.length - a.message.length);
  return { nonce, ...candidates[0], candidates, error: error.repeat(6), errorIsSyntheticRepetition: true };
}
export function toolbarViewport(source) {
  const matched = source.match(/new BrowserWindow\(\{\s*width:\s*(\d+),\s*height:\s*(\d+)/);
  assert.ok(matched, 'Toolbar dimensions must be explicit in the production IPC source');
  const width = Number(matched[1]), height = Number(matched[2]);
  assert.ok(width >= 300 && width <= 1000 && height >= 100 && height <= 1000);
  return { width, height };
}
export async function confirmToolbarExit(wait, cleanup) {
  let waited, waitError;
  try {
    waited = await wait();
    assert.equal(waited.ok, true);
    assert.equal(typeof waited.originalExited, 'boolean');
    if (waited.originalExited) return { ok: true, waited, forced: false };
  } catch (error) { waitError = error.message; }
  const fallback = await cleanup();
  assert.equal(fallback.ok, true); assert.equal(fallback.originalExited, true);
  // A normal exit racing the fallback remains a normal exit. If cleanup had
  // to kill the original, preserve that fact and fail acceptance explicitly.
  return { ok: fallback.forced !== true, waited, ...(waitError ? { waitError } : {}), fallback, forced: fallback.forced === true };
}
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
  assert.ok(args.length <= 1 && (!args.length || ['--check', '--run'].includes(args[0])), 'Use --check (default) or --run.');
  assert.equal(process.platform, 'win32'); const run = args[0] === '--run';
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-toolbar-layout-')), nonce = randomBytes(16).toString('hex');
  const output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const reportFile = path.join(output, 'report.json'), base = path.join(home, 'fixture');
  const mainFile = path.join(root, 'scripts/e2e/desktop-toolbar-layout-main.cjs'), preloadFile = path.join(root, 'scripts/e2e/desktop-toolbar-layout-preload.cjs');
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe'), identityExe = path.join(home, 'ToolbarIdentity.exe');
  const modelModule = path.join(home, 'messages.cjs'), modelFile = path.join(home, 'messages.json');
  const report = { ok: false, mode: run ? 'actual-app-capture' : 'check', startedAt: new Date().toISOString(), fixtureStarted: false,
    realInputActionsSent: 0, commands: [], stages: [], cleanup: {},
    scope: 'Real bundled toolbar HTML/CSS/JS in an isolated Medium Electron fixture; desktopControl is stubbed there. Real App controls and screenshots the fixture through ppilot desktop.',
    limitations: ['A fake paused label in the fixture is not a paused owner in the real App.',
      'No autonomous activation, real takeover, cross-integrity, mixed DPI or production-toolbar freshness proof.',
      'Longest message is selected from current production pause messages by character count. The error repeats a real message to exercise the 48px cap.'] };
  const persist = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
  let fixture, identity, heartbeat, session;
  const inspect = pid => JSON.parse(execFileSync(identityExe, ['--inspect', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  async function cli(parameters, expectedExitCode = 0) {
    assert.ok(!parameters.includes('action'), 'Layout acceptance never sends an input action');
    const record = { parameters }; report.commands.push(record);
    const result = await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: [...parameters, '--json'],
      cwd: root, env, expectedExitCode, timeoutMs: 70000 });
    record.exitCode = result.exitCode; record.response = result.response; return result.response;
  }
  const desktop = (parameters, expected) => cli(['desktop', ...parameters], expected);
  const assertActive = state => {
    assert.equal(state.session?.name, session); assert.equal(state.session.state, 'active'); assert.equal(state.session.window.pid, fixture.pid);
    assert.equal(state.inputObservation.phase, 'ready'); assert.notEqual(state.inputObservation.unobservedTestDriver, true);
  };
  try {
    const sources = ['public/desktop-control.html', 'public/desktop.css', 'public/desktop-control.js', 'src/main/desktop/errors.ts', 'src/main/desktop/ipc.ts',
      'scripts/e2e/desktop-toolbar-layout-main.cjs', 'scripts/e2e/desktop-toolbar-layout-preload.cjs', 'scripts/e2e/desktop-observer-fault-identity.cs'];
    report.sources = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(path.join(root, file)))])));
    execFileSync(process.execPath, ['--check', mainFile], { windowsHide: true }); execFileSync(process.execPath, ['--check', preloadFile], { windowsHide: true });
    // Isolated test bundle exposes only the real message keys to the harness.
    // No production module/export or build output is changed.
    buildSync({ stdin: { contents: await readFile(path.join(root, 'src/main/desktop/errors.ts'), 'utf8') + '\nexport const fixturePauseReasons = Object.keys(pauseMessages);',
      sourcefile: 'toolbar-fixture-messages.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: modelModule, logLevel: 'silent' });
    const messages = require(modelModule);
    report.model = selectMessageModel(messages.fixturePauseReasons, messages.desktopPauseMessage, messages.desktopErrorMessage('DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY'), nonce);
    report.model.viewport = toolbarViewport(await readFile(path.join(root, 'src/main/desktop/ipc.ts'), 'utf8'));
    await writeFile(modelFile, JSON.stringify(report.model));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/warnaserror+', `/out:${identityExe}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
      path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    for (const file of sources) assert.equal(hash(await readFile(path.join(root, file))), report.sources[file], 'Source changed while preparing fixture');
    if (!run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    report.runtime = await cli(['status']); assert.equal(report.runtime.ok, true);
    assert.equal(path.resolve(report.runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
    report.initialStatus = (await desktop(['status'])).result; assert.equal(report.initialStatus.session, null, 'An existing owner must not be disturbed');
    report.manifest = await json(path.join(root, 'dist/main/control-build.json'));
    assert.equal(report.runtime.data.build.buildId, report.manifest.buildId);
    assert.equal(hash(await readFile(path.join(root, 'dist/main/profilepilot-cli.cjs'))), report.manifest.cliSha256);
    await writeFile(base + '.heartbeat', nonce);
    heartbeat = setInterval(() => { const now = new Date(); void utimes(base + '.heartbeat', now, now).catch(error => { report.cleanup.heartbeatError = error.message; }); }, 2000);
    fixture = await launchWindowsUserProcess(electron, [mainFile, home, nonce, modelFile], home); report.fixtureStarted = true;
    identity = inspect(fixture.pid); report.identity = identity;
    const electronHash = hash(await readFile(electron)); assertOwnedIdentity(identity, { pid: fixture.pid, executable: electron, sha256: electronHash });
    const ready = report.fixture = await poll(async () => {
      try { const failure = await json(base + '.failure.json'); throw new Error(failure.error); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return json(base + '.ready.json');
    }, value => value.nonce === nonce && value.pid === fixture.pid, 'isolated toolbar fixture ready', 20000);
    assert.equal(ready.realDesktopService, false); assert.equal(ready.hooksInstalled, false); assert.equal(ready.inputInjected, false);
    report.fixtureBoot = await json(base + '.boot.json'); assert.equal(report.fixtureBoot.nonce, nonce); assert.equal(report.fixtureBoot.pid, fixture.pid);
    const target = (await desktop(['windows'])).result.windows.find(value => value.pid === fixture.pid && value.nativeHandle === ready.hwnd); assert.ok(target);
    session = 'toolbar-layout-' + randomUUID(); const claim = await desktop(['claim', '--session', session, '--window', target.id]); assertActive(claim.result);
    for (const stage of stages) {
      await assertDesktopAcceptanceWindow(); assertActive((await desktop(['status'])).result);
      const id = randomBytes(16).toString('hex'), temporary = base + '.request.tmp';
      await writeFile(temporary, JSON.stringify({ nonce, id, stage })); await rename(temporary, base + '.request.json');
      const value = await poll(() => json(base + '.stage.json'), item => item.nonce === nonce && item.pid === fixture.pid && item.requestId === id, stage + ' layout');
      const record = { ...value }; report.stages.push(record);
      assert.equal(value.error, undefined); assert.equal(value.realDesktopService, false);
      // On Windows a frameless window's effective content size can differ
      // from the requested BrowserWindow size after DPI/frame adjustment.
      // Measure the production configuration as it is; do not enlarge the
      // fixture to make a clipped layout pass.
      assert.ok(value.measured.viewport.width > 0 && value.measured.viewport.height > 0);
      assert.ok(Math.abs(value.measured.viewport.width - value.window.contentBounds.width) <= 1);
      assert.ok(Math.abs(value.measured.viewport.height - value.window.contentBounds.height) <= 1);
      const screenshot = await desktop(['screenshot', '--session', session, '--image-only', '--output', path.join(output, stage + '.jpg')]);
      record.screenshot = screenshot.result.image; assert.ok(record.screenshot.width > 0 && record.screenshot.height > 0);
      assertActive((await desktop(['status'])).result); await persist();
      // Keep collecting visual evidence after a layout assertion fails. There
      // are no input actions; any real owner pause aborts immediately above.
    }
    const complete = await desktop(['complete', '--session', session, '--require-active']); assert.equal(complete.result.session, null); session = undefined;
    for (const file of sources) assert.equal(hash(await readFile(path.join(root, file))), report.sources[file], 'Source changed during acceptance');
    const finalRuntime = await cli(['status']); assert.equal(finalRuntime.data.pid, report.runtime.data.pid);
    assert.equal(finalRuntime.data.build.buildId, report.runtime.data.build.buildId); assert.equal(finalRuntime.data.build.startedAt, report.runtime.data.build.startedAt);
    assertOwnedIdentity(inspect(fixture.pid), { pid: fixture.pid, executable: electron, sha256: electronHash, original: identity });
    report.ok = report.stages.length === stages.length && report.stages.every(value => value.issues.length === 0);
  } catch (error) {
    report.error = { message: error.message, code: error.code, response: error.response, last: error.last };
    if (fixture) for (const [name, suffix] of [['fixtureBoot', '.boot.json'], ['fixtureFailure', '.failure.json']]) {
      try { report[name] = await json(base + suffix); } catch (failure) { report[name] = { available: false, code: failure.code }; }
    }
  }
  finally {
    if (session) try {
      const state = (await desktop(['status'])).result;
      if (state.session?.name === session) report.cleanup.release = await desktop(['release', '--session', session]);
      else assert.equal(state.session, null, 'A different owner appeared and was left untouched');
    } catch (error) { report.cleanup.sessionError = error.message; report.ok = false; }
    if (fixture) {
      try {
        await writeFile(base + '.close', nonce);
        report.cleanup.receipt = await poll(() => json(base + '.closed.json'), value => value.nonce === nonce && value.pid === fixture.pid, 'owned fixture close');
        assert.equal(report.cleanup.receipt.reason, 'requested');
      } catch (error) { report.cleanup.receiptError = error.message; report.ok = false; }
      try {
        assert.ok(identity, 'No pinned fixture identity; cannot force cleanup');
        const inspectExit = parameters => JSON.parse(execFileSync(identityExe, parameters, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
        report.cleanup.exit = await confirmToolbarExit(
          () => inspectExit(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, '5000']),
          () => inspectExit(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, identity.executable, identity.sha256, String(identity.parentPid)]));
        if (!report.cleanup.exit.ok) report.ok = false;
      } catch (error) { report.cleanup.exitError = error.message; report.ok = false; }
    }
    clearInterval(heartbeat); if (report.cleanup.heartbeatError) report.ok = false;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: reportFile, fixtureStarted: report.fixtureStarted,
      layoutIssues: report.stages.flatMap(value => (value.issues || []).map(issue => value.stage + ':' + issue)) }));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { if (!(await main()).ok) process.exitCode = 1; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
