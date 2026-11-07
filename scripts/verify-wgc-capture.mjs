// Default: compile only, no window or capture. --run opens an owned Electron
// fixture and records a capture-only matrix; coordinate input stays disabled.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { fixtureSource } from './e2e/wgc-fixture-source.mjs';
import { resolveWindowsWinrtReferences } from './windows-winrt-contracts.mjs';

assert.equal(process.platform, 'win32', 'The WGC probe requires Windows.');
const args = process.argv.slice(2);
const userWorker = args.length === 2 && args[0] === '--run-user';
assert.ok(userWorker || (args.length <= 1 && (!args.length || ['--run', '--compile-only'].includes(args[0]))), 'Expected --compile-only or --run');
const run = userWorker;
const completionFile = userWorker ? args[1] : undefined;
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (userWorker || args[0] === '--run') await assertDesktopAcceptanceWindow();
if (args[0] === '--run') {
  // The orchestration shell can be High integrity. Launch the whole capture
  // harness through Explorer so both Electron and every probe inherit Medium.
  const launchDirectory = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-wgc-user-'));
  const resultFile = path.join(launchDirectory, 'result.json');
  const launched = await launchWindowsUserProcess(process.execPath, [fileURLToPath(import.meta.url), '--run-user', resultFile], root);
  let last;
  try {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try {
        last = JSON.parse(await readFile(resultFile, 'utf8'));
        if (last.finished) break;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(last?.finished, 'Ordinary-user WGC harness timed out');
    console.log(JSON.stringify({ ...last, launcher: launched }));
    if (!last.ok) process.exitCode = 1;
  } finally {
    if (!last?.finished) {
      if (last?.fixturePid) terminateOwnedWindowsProcess(last.fixturePid, require('electron'));
      terminateOwnedWindowsProcess(launched.pid, process.execPath);
    }
  }
  process.exit(process.exitCode || 0);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-wgc-'));
const output = path.join(root, '.tools', 'wgc-verification', path.basename(temporary));
await mkdir(output, { recursive: true });
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const references = [];
const sources = ['native/desktop/capture-wgc.cs', 'scripts/e2e/wgc-probe.cs'].map(file => path.join(root, file));
const executable = path.join(temporary, 'WgcProbe.exe');
const report = {
  ok: false, mode: run ? 'owned-electron-capture-medium' : 'compile-only', startedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(),
  electron: require('electron/package.json').version, buildInputs: [], captures: [],
  limitations: ['Coordinate input remains disabled; this is a capture and mapping measurement.', 'Only the display and scale actually recorded in each fixture state are tested; mixed DPI, HDR, multiple GPUs and macOS need separate devices.', 'The capture provider never activates a window, opens a picker, requests borderless access or falls back to a different source.']
};

let fixture;
let sequence = 0, stderr = '';
const commandFile = path.join(temporary, 'command.json'), responseFile = path.join(temporary, 'response.json');
async function waitReply(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fixture?.exitCode !== null && fixture?.exitCode !== undefined) throw new Error(`Fixture exited ${fixture.exitCode}\n${stderr}`);
    try {
      const reply = JSON.parse(await readFile(responseFile, 'utf8'));
      if (reply.id === id) { if (reply.error) throw new Error(reply.error); return reply; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture reply timed out: ${id}\n${stderr}`);
}
async function command(action) {
  const id = String(++sequence);
  await writeFile(commandFile, JSON.stringify({ id, action }));
  return (await waitReply(id)).state;
}
async function capture(label, state, expected = 'captured_unmapped', extra = []) {
  const imagePath = path.join(output, label + '.jpg');
  let stdout;
  try { ({ stdout } = await execute(executable, ['--capture', state.hwnd, '--output', imagePath, ...extra], { windowsHide: true, timeout: 15000, encoding: 'utf8' })); }
  catch (error) { if (error.code !== 3) throw error; stdout = error.stdout; }
  const result = JSON.parse(stdout);
  const record = { label, state, ...result }; report.captures.push(record);
  assert.equal(result.result?.Status, expected, `${label}: ${stdout}`);
  assert.equal(result.administrator, false, 'The actual capture process must not have an elevated administrator token');
  assert.equal(result.integrityRid, 8192, 'Every actual capture process must have Medium integrity');
  assert.equal(result.result.CoordinateInputAvailable, false, 'Prototype must never enable coordinate input');
  if (!result.ok) return record;
  assert.equal(result.result.Geometry.ProcessId, fixture.pid, 'Capture stays in the owned fixture process');
  assert.equal(result.result.ForegroundAfter, result.result.ForegroundBefore, 'Capture must not activate the target');
  const bytes = await readFile(imagePath);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
  const decoded = JSON.parse((await execute(executable, ['--inspect', imagePath], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout).image;
  assert.equal(decoded.width, result.result.Width); assert.equal(decoded.height, result.result.Height);
  const geometry = result.result.Geometry;
  record.decoded = decoded;
  record.pixelErrors = [];
  const webContents = state.webContentsPhysicalBounds;
  // Win32 client includes Electron's menu host; the CSS viewport starts at the
  // physical BrowserWindow content bounds. Record both instead of assuming that
  // GetClientRect's origin is the origin of every application's rendered page.
  assert.ok(Math.abs(webContents.width - state.page.width * state.page.dpr) <= 2, `${label}: inconsistent viewport width`);
  assert.ok(Math.abs(webContents.height - state.page.height * state.page.dpr) <= 2, `${label}: inconsistent viewport height`);
  decoded.markers.forEach((marker, index) => {
    assert.ok(marker.count >= 300, `${label}: captured marker ${index} is missing`);
    const css = state.page.markers[index];
    const measured = { x: geometry.VisibleFrame.X + marker.x * result.result.ContentWidth / decoded.width, y: geometry.VisibleFrame.Y + marker.y * result.result.ContentHeight / decoded.height };
    const expectedPoint = { x: webContents.x + css.x * state.page.dpr, y: webContents.y + css.y * state.page.dpr };
    const error = { x: measured.x - expectedPoint.x, y: measured.y - expectedPoint.y };
    record.pixelErrors.push({ marker: css.id, measured, expected: expectedPoint, error });
    assert.ok(Math.abs(error.x) <= 3 && Math.abs(error.y) <= 3, `${label}: marker ${index} DWM-origin mapping error ${JSON.stringify(error)}`);
  });
  return record;
}
try {
  // Build and identity checks belong to the report lifetime too: a missing
  // reference or incorrect token must promptly complete the parent handshake.
  const sdk = await resolveWindowsWinrtReferences(root, { framework });
  references.push(...sdk.references);
  report.sdk = { version: sdk.version, packageSha256: sdk.packageSha256, hashes: sdk.hashes };
  for (const file of [...references, ...sources]) report.buildInputs.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  await execute(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', `/out:${executable}`, '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', ...references.map(file => `/r:${file}`), ...sources], { windowsHide: true, timeout: 30000 });
  report.compiled = true;
  if (run) {
    report.captureIdentity = JSON.parse((await execute(executable, ['--identity'], { windowsHide: true, timeout: 5000, encoding: 'utf8' })).stdout);
    assert.equal(report.captureIdentity.administrator, false, 'WGC tests must run as the ordinary desktop user before any capture');
    assert.equal(report.captureIdentity.integrityRid, 8192, 'Capture harness must use a Medium integrity token');
    await writeFile(completionFile, JSON.stringify({ finished: false, output, ordinaryUser: true }));
    const fixturePath = path.join(temporary, 'fixture.cjs'); await writeFile(fixturePath, fixtureSource);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    fixture = spawn(require('electron'), [fixturePath, path.join(temporary, 'electron-user-data'), temporary], { env: environment, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
    await writeFile(completionFile, JSON.stringify({ finished: false, output, ordinaryUser: true, fixturePid: fixture.pid }));
    fixture.stderr.setEncoding('utf8'); fixture.stderr.on('data', value => stderr += value);
    fixture.on('error', error => { stderr += error.stack; });
    let state = (await waitReply('ready')).state;
    report.initialState = state;
    report.ownedWindowDiagnostics = JSON.parse((await execute(executable, ['--diagnose', String(fixture.pid)], { windowsHide: true, timeout: 5000, encoding: 'utf8' })).stdout);
    report.stateAfterDiagnostic = await command('normal');
    state = report.stateAfterDiagnostic;
    await capture('normal', state);
    for (const mode of ['menu-less', 'resize', 'move', 'maximize', 'restore', 'cover']) { state = await command(mode); await capture(mode, state); }
    await command('uncover');
    state = await command('frameless'); await capture('frameless', state);
    await capture('cancel-before-start', state, 'cancelled', ['--cancel-after-ms', '0']);
    await capture('cancel-during-startup', state, 'cancelled', ['--cancel-after-ms', '1']);
    await capture('cancel-after-80ms', state, 'cancelled', ['--cancel-after-ms', '80']);
    await capture('bounded-startup', state, 'timeout', ['--timeout-ms', '1']);
    state = await command('protect'); await capture('protected', state, 'capture_protected');
    state = await command('unprotect'); await capture('unprotected', state);
    state = await command('minimize'); await capture('minimized', state, 'window_minimized');
    await command('restore');
    state = await command('hide'); await capture('hidden', state, 'window_hidden');
    await command('show');
    state = await command('close'); await capture('closed', state, 'window_closed');
  }
  report.ok = true;
  console.log(JSON.stringify({ ok: true, mode: report.mode, output, captures: report.captures.length }));
} catch (error) {
  report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  if (fixture) {
    await writeFile(commandFile, JSON.stringify({ id: 'shutdown', action: 'quit' }));
    await Promise.race([new Promise(resolve => fixture.exitCode !== null ? resolve() : fixture.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (fixture.exitCode === null) fixture.kill();
  }
  report.finishedAt = new Date().toISOString(); report.fixtureStderr = stderr;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (completionFile) await writeFile(completionFile, JSON.stringify({ finished: true, ok: report.ok, output, ordinaryUser: report.captureIdentity?.administrator === false, captures: report.captures.length, error: report.error }));
}
