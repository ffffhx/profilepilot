import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { resolveWindowsWinrtReferences } from './windows-winrt-contracts.mjs';
import { desktopSourceFiles } from './desktop-source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Windows foreground experiment only.');
await assertDesktopAcceptanceWindow();
const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-foreground-grant-'));
const output = path.join(root, '.tools', 'desktop-verification', path.basename(directory));
await mkdir(output, { recursive: true });
const session = 'foreground-grant-' + randomUUID();
const fixtureExe = path.join(directory, 'DesktopFixture.exe');
const grantExe = path.join(directory, 'ForegroundGrantExperiment.exe');
const receipt = path.join(directory, 'fixture-receipt.txt');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
const winrt = await resolveWindowsWinrtReferences(root, { framework });
execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${fixtureExe}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-fixture.cs'), path.join(root, 'scripts/e2e/assisted-foreground-fixture.cs')], { windowsHide: true });
execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:ForegroundGrantExperiment', `/out:${grantExe}`, '/r:System.Management.dll', '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll', ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => '/r:' + path.join(framework, 'WPF', file)), ...winrt.references.map(file => '/r:' + file), ...desktopSourceFiles.map(file => path.join(root, 'native/desktop', file)), path.join(root, 'scripts/e2e/foreground-grant.cs')], { windowsHide: true });
const env = { ...process.env }; delete env.PROFILEPILOT_MANAGEMENT_ROOT;
const report = { startedAt: new Date().toISOString(), session, outcome: 'pending', actions: [], cleanup: {} };
let fixture, claimed = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cli(args, check = true) {
  const child = spawn(process.execPath, [path.join(root, 'dist/main/profilepilot-cli.cjs'), ...args, '--json'], { env, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const body = JSON.parse(stdout);
  if (check) assert.equal(code, 0, stdout + stderr);
  return { code, body };
}
const desktop = async args => (await cli(['desktop', ...args])).body.result;
async function receiptValue() { try { return await readFile(receipt, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function screenshot(name) { return desktop(['screenshot', '--session', session, '--output', path.join(output, name + '.jpg')]); }
function point(snapshot) {
  const button = snapshot.elements.find(item => item.name === 'Desktop test apply');
  assert.ok(button); assert.equal(snapshot.image.coordinateInputAvailable, true);
  return { x: Math.round(button.bounds[0] + button.bounds[2] / 2 - snapshot.image.windowX), y: Math.round(button.bounds[1] + button.bounds[3] / 2 - snapshot.image.windowY) };
}
async function action(snapshot) {
  const params = { version: snapshot.version, kind: 'click', ...point(snapshot) };
  const requestId = randomUUID(), file = path.join(directory, requestId + '.json');
  await writeFile(file, JSON.stringify(params));
  const result = await cli(['desktop', 'action', '--session', session, '--params-file', file, '--request-id', requestId], false);
  report.actions.push({ requestId, params, ...result }); return result;
}
try {
  const runtime = (await cli(['status'])).body.data;
  assert.equal(path.resolve(runtime.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase());
  report.app = { pid: runtime.pid, buildId: runtime.build.buildId };
  assert.equal((await desktop(['status'])).session, null, 'An existing desktop owner must not be replaced.');
  fixture = await launchWindowsUserProcess(fixtureExe, [receipt, '--detached'], root);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { report.fixture = JSON.parse(await readFile(receipt + '.environment.json', 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; await delay(100); }
  }
  assert.equal(report.fixture.pid, fixture.pid); assert.equal(report.fixture.administrator, false);
  const window = (await desktop(['windows'])).windows.find(item => item.pid === fixture.pid && item.title === 'ProfilePilot desktop verification');
  assert.ok(window); report.windowId = window.id;
  await desktop(['claim', '--session', session, '--window', window.id]); claimed = true;
  const initial = await screenshot('before-grant'); report.initial = { version: initial.version, image: { ...initial.image, data: undefined }, point: point(initial) };
  report.preflight = await desktop(['doctor', '--window', window.id]);
  // An explicit pause lets the coordinating agent inspect this exact fixture image.
  const gate = path.join(output, 'inspection-confirmed.txt');
  console.log(JSON.stringify({ stage: 'inspect-owned-fixture', output, screenshot: path.join(output, 'before-grant.jpg'), gate }));
  let confirmed = false;
  for (let attempt = 0; attempt < 450; attempt++) {
    try { confirmed = (await readFile(gate, 'utf8')).trim() === 'continue'; if (!confirmed) throw new Error('Experiment cancelled before input.'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); }
  }
  assert.equal(confirmed, true, 'Image inspection timeout.');
  const first = await action(await screenshot('before-first-input'));
  report.receiptBeforeGrant = await receiptValue();
  if (first.body.ok) { report.outcome = 'activation-already-available-no-grant-needed'; }
  else {
    assert.equal(first.body.code, 'DESKTOP_FOCUS_REQUIRED', 'Only a known pre-input focus refusal can be retried after a grant.');
    assert.equal(report.receiptBeforeGrant, null, 'The rejected action must not have reached the fixture.');
    const state = await desktop(['status']); assert.equal(state.session.name, session); assert.equal(state.session.state, 'active');
    const helperPid = first.body.details?.diagnostics?.source?.pid; assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    report.grant = JSON.parse(execFileSync(grantExe, [String(helperPid), String(runtime.pid)], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
    assert.equal(report.grant.target.pid, helperPid); assert.equal(report.grant.target.parentPid, runtime.pid);
    if (!report.grant.granted) report.outcome = 'grant-denied-no-input-retry';
    else {
      const current = await desktop(['status']); assert.equal(current.session.name, session); assert.equal(current.session.state, 'active');
      const second = await action(await screenshot('after-grant-before-input'));
      report.receiptAfterGrant = await receiptValue();
      report.outcome = second.body.ok && report.receiptAfterGrant === '1\n' ? 'exact-pid-grant-recovered-click' : 'grant-accepted-activation-or-input-still-unconfirmed';
      report.after = await desktop(['doctor', '--window', window.id]);
    }
  }
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  if (claimed) {
    try { const current = await desktop(['status']); if (current.session?.name === session) await desktop(['release', '--session', session]); report.cleanup.session = (await desktop(['status'])).session; }
    catch (error) { report.cleanup.sessionError = error.message; }
  }
  if (fixture) {
    await writeFile(receipt + '.close', 'close'); await delay(350);
    try { terminateOwnedWindowsProcess(fixture.pid, fixtureExe); report.cleanup.fixtureTerminated = true; }
    catch (error) { report.cleanup.fixtureError = error.message; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: report.outcome, output, cleanup: report.cleanup, error: report.error }));
}
