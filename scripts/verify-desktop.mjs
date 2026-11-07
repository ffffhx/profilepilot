import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';
import { assistedFixtureSource, compileAssistedPreparer, prepareAssistedForeground } from './e2e/assisted-foreground.mjs';

if (process.platform !== 'win32') throw new Error('Native desktop verification requires Windows.');
const compileOnly = process.argv.includes('--compile-only');
if (!compileOnly) await assertDesktopAcceptanceWindow();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { DesktopService } = require('../dist/main/desktop/service.js');
const { startProfilePilotManagementServer } = require('../dist/main/profilepilot-management-server.js');
const useApp = process.argv.includes('--app');
const prepareFocus = process.argv.includes('--focus-before-input');
const awaitForeground = process.argv.includes('--await-foreground');
const assistedForeground = process.argv.includes('--assisted-foreground');
assert.ok(!assistedForeground || useApp, '--assisted-foreground requires --app and a Medium fixture.');
const session = useApp ? 'verification-app-' + randomUUID() : 'verification';
const home = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-desktop-'));
const output = path.join(root, '.tools', 'desktop-verification', path.basename(home));
await mkdir(output, { recursive: true });
const executable = path.join(home, 'DesktopFixture.exe');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', `/out:${executable}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-fixture.cs'), assistedFixtureSource], { windowsHide: true });
if (compileOnly) {
  if (assistedForeground) compileAssistedPreparer(home);
  console.log(JSON.stringify({ ok: true, mode: 'compile-only', executable, guiStarted: false }));
  process.exit(0);
}
const receipt = path.join(home, 'fixture-receipt.txt');
let fixture, server;
const service = useApp ? null : new DesktopService();
const env = { ...process.env };
if (useApp) delete env.PROFILEPILOT_MANAGEMENT_ROOT;
else env.PROFILEPILOT_MANAGEMENT_ROOT = path.join(home, 'management');
const report = {
  ok: false, startedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(), checks: [], screenshots: [], timingSamples: [], markerPhases: [], markerChecks: [], cleanup: {},
  scope: assistedForeground ? 'Explicit assisted foreground setup clicks only the owned fixture pad; all subsequent product actions use the Medium ProfilePilot App and CLI.' : useApp ? 'Ordinary desktop-user WinForms fixture through the running development ProfilePilot App and CLI; all control goes through App management.' : 'Owned WinForms fixture through isolated ProfilePilot management IPC and CLI; native action cancellation additionally calls the same DesktopService directly.',
  mode: useApp ? 'app' : 'isolated', assistedForeground, productAutonomousActivationProven: false,
  limitations: ['This run covers only the fixture display configuration recorded below; mixed DPI, cross-monitor movement and macOS are not tested.', 'Latency samples include CLI process and IPC overhead. They are local observations, not a cross-device benchmark.', 'These native-window captures do not validate external Chromium compositor border mapping.', 'GetMessageExtraInfo describes owned WM messages and may discard upper marker bits; stable values do not prove full64 low-level hook delivery, authenticated provenance or automatic takeover. Zero-marker moves remain unattributed and may be synthesized by Windows.']
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checked = name => report.checks.push(name);
async function cli(args, expected = 0) {
  try { return (await runDesktopCliProcess({ entry: path.join(root, 'dist/main/profilepilot-cli.cjs'), args: ['desktop', ...args, '--json'], env, expectedExitCode: expected })).response; }
  catch (error) { report.lastFailure = { args: args.filter(value => value !== session), exitCode: error.exitCode, errorCode: error.code, outcome: error.outcome, response: error.response }; throw error; }
}
async function action(params, requestId = randomUUID(), expected = 0) {
  const file = path.join(home, 'action.json'); await writeFile(file, JSON.stringify(params));
  return cli(['action', '--session', session, '--params-file', file, '--request-id', requestId], expected);
}
async function waitFor(read, accept, label, timeout = 3000, interval = 20) {
  const deadline = performance.now() + timeout;
  let value;
  while (performance.now() < deadline) {
    try { value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(interval);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(value)}`);
}
const readInput = async () => JSON.parse(await readFile(receipt + '.input.json', 'utf8'));
const waitInput = (accept, label, timeout, interval) => waitFor(readInput, accept, label, timeout, interval);
const zeroMarker = '0000000000000000';
let markerPhase;
function beginMarkerPhase(reason) {
  markerPhase = { reason, receivedKeyboardMarker: null, receivedPointerMarker: null }; report.markerPhases.push(markerPhase);
}
async function readMarkers() {
  const value = await waitFor(async () => JSON.parse(await readFile(receipt + '.markers.json', 'utf8')), Boolean, 'complete marker receipt');
  report.lastInputMarkers = value; return value;
}
function markerDelta(before, after) {
  assert.equal(after.source, 'GetMessageExtraInfo'); assert.equal(after.lowLevelHookEvidence, false);
  assert.equal(after.overflow, false, 'Owned marker counter overflowed');
  assert.ok(Array.isArray(after.events));
  const previous = new Map(before.events.map(event => [event.kind + ':' + event.marker, event.count]));
  const seen = new Set();
  return after.events.map(event => {
    assert.match(event.marker, /^[0-9a-f]{16}$/);
    assert.ok(Number.isSafeInteger(event.count) && event.count > 0);
    const key = event.kind + ':' + event.marker;
    assert.ok(!seen.has(key), 'Duplicate marker counter'); seen.add(key);
    const count = event.count - (previous.get(key) || 0);
    assert.ok(count >= 0, 'Marker counters unexpectedly reset');
    return { kind: event.kind, marker: event.marker, count };
  }).filter(event => event.count > 0);
}
async function checkMarkers(label, before, required) {
  const record = { label, phase: markerPhase.reason, required, before, lowLevelHookEvidence: false }; report.markerChecks.push(record);
  const after = await waitFor(readMarkers, value => {
    record.after = value;
    const delta = markerDelta(before, value);
    return Object.entries(required).every(([kind, count]) => delta.filter(event => event.kind === kind && (kind !== 'move' || event.marker !== zeroMarker)).reduce((sum, event) => sum + event.count, 0) >= count);
  }, label + ' marker delivery');
  const delta = record.delta = markerDelta(before, after);
  // Capture release can synthesize same-position moves. Preserve these counts
  // without treating a zero ExtraInfo value as proof of physical activity.
  record.unattributedMoves = delta.filter(event => event.kind === 'move' && event.marker === zeroMarker).reduce((sum, event) => sum + event.count, 0);
  const attributed = delta.filter(event => event.kind !== 'move' || event.marker !== zeroMarker);
  assert.ok(attributed.length > 0, 'No marked input reached the owned control');
  for (const event of attributed) {
    assert.notEqual(event.marker, zeroMarker, 'Required input lost its marker: ' + event.kind);
    const keyboard = ['key_down', 'key_up', 'unicode_down', 'unicode_up'].includes(event.kind);
    const field = keyboard ? 'receivedKeyboardMarker' : 'receivedPointerMarker';
    if (!keyboard) assert.match(event.marker, /^00000000[0-9a-f]{8}$/, 'Pointer packets must use the explicitly registered 32-bit value');
    markerPhase[field] ||= event.marker;
    assert.equal(event.marker, markerPhase[field], 'Received WM marker changed within one input kind and worker phase');
  }
  for (const [kind, count] of Object.entries(required)) assert.ok(attributed.filter(event => event.kind === kind).reduce((sum, event) => sum + event.count, 0) >= count, 'Missing marked ' + kind);
  record.ok = true;
}
async function markedAction(label, params, required) {
  const before = await readMarkers();
  const result = await action(params);
  await checkMarkers(label, before, required);
  return result;
}
const observe = async () => (await cli(['observe', '--session', session])).result;
function find(snapshot, name) {
  const element = snapshot.elements.find(candidate => candidate.name === name);
  assert.ok(element, `Missing fixture element: ${name}`);
  return element;
}
function captureRect(image) {
  return image.captureRect || { x: 0, y: 0, width: image.windowWidth, height: image.windowHeight };
}
function imagePoint(image, pixel) {
  const rect = captureRect(image);
  assert.ok(rect.width > 0 && rect.height > 0 && image.width > 0 && image.height > 0);
  return { x: Math.round(rect.x + pixel.x * rect.width / image.width), y: Math.round(rect.y + pixel.y * rect.height / image.height) };
}
function elementImagePoint(snapshot, element) {
  const image = snapshot.image, rect = captureRect(image);
  return {
    x: (element.bounds[0] + element.bounds[2] / 2 - image.windowX - rect.x) * image.width / rect.width,
    y: (element.bounds[1] + element.bounds[3] / 2 - image.windowY - rect.y) * image.height / rect.height
  };
}
async function capture(name, { imageOnly = false, verifyMarkers = true } = {}) {
  const file = path.join(output, name + '.jpg');
  const started = performance.now();
  const snapshot = (await cli(['screenshot', '--session', session, '--output', file, ...(imageOnly ? ['--image-only'] : [])])).result;
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const image = snapshot.image;
  assert.ok(image && image.coordinateInputAvailable !== false, 'Fixture native screenshot must support coordinate input');
  assert.equal(image.mimeType, 'image/jpeg');
  const decoded = JSON.parse(execFileSync(executable, ['--inspect-image', file], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  assert.equal(decoded.format.toLowerCase(), 'b96b3cae-0728-11d3-9d7b-0000f81ef32e', 'Decoder must identify actual JPEG bytes');
  assert.equal(decoded.width, image.width); assert.equal(decoded.height, image.height);
  assert.ok(decoded.width >= 300 && decoded.height >= 200, 'Capture is a full fixture window, not a tiny placeholder');
  assert.ok(image.windowWidth >= image.width && image.windowHeight >= image.height);
  const rect = captureRect(image);
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= image.windowWidth && rect.y + rect.height <= image.windowHeight, 'Capture rectangle stays within the physical window');
  if (verifyMarkers) for (const marker of decoded.markers) assert.ok(marker.count >= 300, `Expected colored fixture pixels ${marker.rgb}; found ${marker.count}`);
  if (imageOnly) {
    assert.deepEqual(snapshot.elements, []); assert.equal(snapshot.truncated, false);
    assert.ok(snapshot.gaps.includes('uia_skipped'));
  }
  report.screenshots.push({ file, width: decoded.width, height: decoded.height, captureRect: rect, source: image.source, imageOnly, elapsedMs, markers: verifyMarkers ? decoded.markers : undefined });
  return { snapshot, decoded, elapsedMs };
}
function nativeMarker(captured, index) { return imagePoint(captured.snapshot.image, captured.decoded.markers[index]); }

try {
  if (useApp) {
    const runtime = JSON.parse(execFileSync(process.execPath, [path.join(root, 'dist/main/profilepilot-cli.cjs'), 'status', '--json'], { env, windowsHide: true, encoding: 'utf8', timeout: 5000 }));
    assert.equal(runtime.ok, true);
    assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(), path.join(root, 'dist/main/entry.js').toLowerCase(), 'Use the development App from this checkout');
    report.appBuild = { pid: runtime.data.pid, buildId: runtime.data.build.buildId, startedAt: runtime.data.build.startedAt };
  } else server = await startProfilePilotManagementServer({ profileManager: {}, getDesktopService: () => service, homeDir: home, env });
  const available = await cli(['status']); assert.equal(available.result.available, true);
  assert.equal(available.result.session, null, 'Do not replace an existing desktop task');
  fixture = useApp ? await launchWindowsUserProcess(executable, [receipt, '--detached', ...(assistedForeground ? ['--assisted-foreground'] : [])], root) : spawn(executable, [receipt], { windowsHide: false, stdio: 'pipe' });
  report.display = await waitFor(async () => JSON.parse(await readFile(receipt + '.environment.json', 'utf8')), value => value.pid === fixture.pid, 'fixture ready', 10000, 100);
  if (useApp) assert.equal(report.display.administrator, false, 'The App fixture must represent ordinary user applications');
  let window, windows;
  for (let attempt = 0; attempt < 15 && !window; attempt++) {
    windows = (await cli(['windows'])).result.windows;
    window = windows.find(item => item.pid === fixture.pid && item.title === 'ProfilePilot desktop verification');
    if (!window) await delay(200);
  }
  assert.ok(window, 'fixture is discoverable: ' + JSON.stringify({ pid: fixture.pid, count: windows.length, matches: windows.filter(item => /fixture/i.test(item.process)) }));
  report.preflight = (await cli(['doctor', '--window', window.id])).result;
  if (assistedForeground) {
    report.assistedForegroundPreparation = await prepareAssistedForeground({ enabled: true, directory: home, executable, fileBase: receipt,
      pid: fixture.pid, startedUtcTicks: report.display.startedUtcTicks, hwnd: report.display.hwnd });
    assert.equal(report.assistedForegroundPreparation.ok, true, 'Assisted foreground setup failed; product input must not continue.');
    report.limitations.push('Foreground was prepared by an explicitly enabled fixture-only click; product autonomous activation is not proven.');
    // Delay the existing owned TopMost popup until preparation has restored the
    // main window. Otherwise restoring its owner also demotes the owned popup.
    const popupRequest = { nonce: report.assistedForegroundPreparation.nonce, pid: fixture.pid,
      hwnd: report.display.hwnd, startedUtcTicks: report.display.startedUtcTicks };
    await writeFile(receipt + '.popup.show.tmp', JSON.stringify(popupRequest), { flag: 'wx' });
    await rename(receipt + '.popup.show.tmp', receipt + '.popup.show');
    report.popupPreparation = await waitFor(async () => JSON.parse(await readFile(receipt + '.popup.ready.json', 'utf8')),
      value => typeof value?.ok === 'boolean', 'owned popup creation after preparation', 5000, 20);
    const popupReady = report.popupPreparation;
    assert.equal(popupReady.ok, true, popupReady.error || 'Owned popup preparation failed; product input must not continue.');
    assert.equal(popupReady.nonce, popupRequest.nonce); assert.equal(popupReady.pid, fixture.pid);
    assert.equal(popupReady.startedUtcTicks, popupRequest.startedUtcTicks); assert.equal(popupReady.ownerHwnd, popupRequest.hwnd);
    assert.equal(popupReady.foregroundHwnd, popupRequest.hwnd, 'Creating the nonactivating popup must preserve the prepared foreground');
    assert.equal(popupReady.managedTopMost, false, 'Native initial topmost style must avoid the WinForms managed activation path');
    assert.equal(popupReady.native?.hwnd, popupReady.popupHwnd); assert.equal(popupReady.native?.pid, fixture.pid);
    assert.equal(popupReady.native?.ownerHwnd, popupRequest.hwnd); assert.equal(popupReady.native?.topMost, true);
    assert.equal(popupReady.native?.noActivate, true); assert.equal(popupReady.native?.visible, true);
  }
  await cli(['claim', '--session', session, '--window', window.id]);
  beginMarkerPhase('claim');
  checked('ProfilePilot management IPC + CLI and exact fixture window discovery');
  let snapshot = await observe();
  assert.ok(!JSON.stringify(snapshot).includes('fixture-password-should-be-omitted'));
  checked('password values omitted');
  const value = '你好 ProfilePilot & $() ` "';
  await action({ version: snapshot.version, ref: find(snapshot, 'Desktop test input').reference, kind: 'set_value', value });
  snapshot = await observe(); assert.equal(find(snapshot, 'Desktop test input').text, value);
  const params = { version: snapshot.version, ref: find(snapshot, 'Desktop test apply').reference, kind: 'invoke' }, id = randomUUID();
  await action(params, id); await action(params, id);
  await action(params, randomUUID(), 75);
  assert.equal(await readFile(receipt, 'utf8'), '1\n' + value, 'real native button executes once');
  checked('UI Automation Unicode value, semantic invoke, duplicate receipt and stale version');
  if (prepareFocus) {
    snapshot = await observe();
    report.focusPreparation = { action: await action({ version: snapshot.version, ref: find(snapshot, 'Desktop test input').reference, kind: 'focus' }) };
    report.focusPreparation.diagnostics = (await cli(['doctor', '--window', window.id])).result;
    // This is an explicit fixture experiment, not a production fallback or a
    // claim that UIA SetFocus guarantees foreground activation.
  }
  if (awaitForeground) {
    const continuation = path.join(home, 'foreground-ready.json');
    console.log(JSON.stringify({ awaitingForeground: true, window, continuation, session }));
    report.foregroundPreparation = await waitFor(async () => JSON.parse(await readFile(continuation, 'utf8')), value => value?.prepared === true, 'explicit foreground preparation', 120000, 200);
    const state = (await cli(['status'])).result;
    assert.equal(state.session?.name, session); assert.equal(state.session?.state, 'active', 'External preparation must never bypass user takeover');
    report.foregroundPreparation.diagnostics = (await cli(['doctor', '--window', window.id])).result;
    assert.equal(report.foregroundPreparation.diagnostics.foreground.hwnd, window.nativeHandle, 'Foreground must actually be the owned fixture before the physical input baseline');
  }
  let captured = await capture('native-window');
  const button = find(captured.snapshot, 'Desktop test apply');
  await action({ version: captured.snapshot.version, kind: 'click', ...imagePoint(captured.snapshot.image, elementImagePoint(captured.snapshot, button)) });
  assert.equal(await readFile(receipt, 'utf8'), '2\n' + value, 'physical pointer clicks the observed button');
  checked('JPEG decoder dimensions and three actual fixture colors');
  checked('captureRect maps screenshot pixels to native coordinates');

  // Targets below come from decoded pixel colors, independent of UIA bounds.
  captured = await capture('pixel-click');
  let before = await readInput();
  await markedAction('left click', { version: captured.snapshot.version, kind: 'click', ...nativeMarker(captured, 1) }, { left_down: 1, left_up: 1 });
  await waitInput(state => state.ups > before.ups && !state.held, 'screenshot-derived pointer click');
  captured = await capture('double-click'); before = await readInput();
  await markedAction('double click', { version: captured.snapshot.version, kind: 'double_click', ...nativeMarker(captured, 1) }, { left_down: 1, left_double: 1, left_up: 2 });
  await waitInput(state => state.doubles > before.doubles && state.ups >= before.ups + 2 && !state.held, 'double click');
  checked('native double click reaches the owned window');
  captured = await capture('middle-click'); before = await readInput();
  await markedAction('middle click', { version: captured.snapshot.version, kind: 'click', button: 'middle', ...nativeMarker(captured, 2) }, { middle_down: 1, middle_up: 1 });
  await waitInput(state => state.middles === before.middles + 1 && !state.held, 'middle click');
  checked('native middle button click and release');
  captured = await capture('right-click'); before = await readInput();
  await markedAction('right click', { version: captured.snapshot.version, kind: 'click', button: 'right', ...nativeMarker(captured, 2) }, { right_down: 1, right_up: 1 });
  await waitInput(state => state.downs > before.downs && state.ups > before.ups && !state.held, 'right click');
  checked('native right button click and release');
  captured = await capture('pointer-move'); before = await readInput();
  await markedAction('pointer move', { version: captured.snapshot.version, kind: 'move', ...nativeMarker(captured, 0) }, { move: 1 });
  await waitInput(state => state.moves > before.moves && Math.abs(state.lastX - state.greenX) <= 2 && Math.abs(state.lastY - state.greenY) <= 2 && state.downs === before.downs, 'pointer move without pressing');
  checked('native move without button injection');
  captured = await capture('drag-before'); before = await readInput();
  const dragStart = nativeMarker(captured, 0), dragEnd = { x: dragStart.x + 120, y: dragStart.y + 40 };
  await markedAction('drag', { version: captured.snapshot.version, kind: 'drag', ...dragStart, toX: dragEnd.x, toY: dragEnd.y }, { move: 1, left_down: 1, left_up: 1 });
  const dragged = await waitInput(state => state.drags === before.drags + 1 && !state.held, 'drag and mouse-up');
  assert.ok(Math.abs(dragged.greenX - before.greenX - 120) <= 2 && Math.abs(dragged.greenY - before.greenY - 40) <= 2);
  const draggedCapture = await capture('drag-after');
  const draggedPixel = nativeMarker(draggedCapture, 0);
  assert.ok(Math.abs(draggedPixel.x - dragEnd.x) <= 2 && Math.abs(draggedPixel.y - dragEnd.y) <= 2, 'New screenshot visibly contains the marker at the drag destination');
  checked('native drag changes real pixels and releases the mouse');
  captured = await capture('wheel'); before = await readInput();
  await markedAction('both wheel axes', { version: captured.snapshot.version, kind: 'wheel', ...nativeMarker(captured, 1), deltaX: 240, deltaY: -120 }, { wheel_x: 1, wheel_y: 1 });
  await waitInput(state => state.wheelX === before.wheelX + 240 && state.wheelY === before.wheelY - 120, 'horizontal and vertical wheel');
  checked('native horizontal and vertical wheel units');
  captured = await capture('wheel-limits'); before = await readInput();
  await action({ version: captured.snapshot.version, kind: 'wheel', ...nativeMarker(captured, 1), deltaY: 1201 }, randomUUID(), 2);
  assert.equal((await readInput()).wheelY, before.wheelY, 'out-of-bound wheel request never reaches fixture');
  await markedAction('wheel limit', { version: captured.snapshot.version, kind: 'wheel', ...nativeMarker(captured, 1), deltaY: 1200 }, { wheel_y: 1 });
  await waitInput(state => state.wheelY === before.wheelY + 1200, 'wheel limit boundary');
  checked('wheel rejects values above ±1200 before input and accepts boundary');

  captured = await capture('image-only', { imageOnly: true });
  before = await readInput();
  await markedAction('image-only move', { version: captured.snapshot.version, kind: 'move', ...nativeMarker(captured, 2) }, { move: 1 });
  await waitInput(state => state.moves > before.moves, 'image-only coordinate action');
  checked('image-only has a fresh actionable screenshot version and no UIA refs');

  captured = await capture('cancel-drag'); before = await readInput();
  const cancelStart = nativeMarker(captured, 0);
  const cancelParams = { version: captured.snapshot.version, kind: 'drag', ...cancelStart, toX: cancelStart.x + 180, toY: cancelStart.y + 20 };
  const beforeCancelledMarkers = await readMarkers();
  const pending = useApp ? action(cancelParams, randomUUID(), 75) : service.execute({ action: 'desktop', method: 'action', session, requestId: randomUUID(), params: cancelParams }).then(result => ({ ok: true, result }), error => ({ ok: false, code: error.code, message: error.message }));
  await waitInput(state => state.held && state.downs > before.downs, 'drag actually pressed before takeover', 3000, 5);
  if (useApp) await cli(['handoff', '--session', session]);
  else service.control('takeover');
  const cancelled = await pending;
  assert.equal(cancelled.ok, false, 'takeover interrupts the in-flight drag');
  const released = await waitInput(state => !state.held && state.ups > before.ups, 'cancelled drag releases mouse');
  await checkMarkers('cancelled drag and cleanup release', beforeCancelledMarkers, { left_down: 1, left_up: 1 });
  const physicalKeys = JSON.parse(execFileSync(executable, ['--input-state'], { windowsHide: true, encoding: 'utf8' }));
  assert.ok(Object.values(physicalKeys).every(held => held === false), 'no mouse button or modifier remains physically held');
  await delay(120);
  const stopped = await readInput();
  report.cancelledDrag = { outcome: cancelled, physicalKeys, released, stopped };
  // Windows may synthesize a same-position MouseMove when capture is released.
  // Verify physical progress and pressed state instead of counting those events.
  assert.deepEqual([stopped.lastX, stopped.lastY, stopped.downs, stopped.held], [released.lastX, released.lastY, released.downs, false], 'pointer movement and new presses stopped after takeover');
  assert.ok(Math.abs(stopped.lastX - before.greenX - 180) > 10, 'cancelled drag did not continue to its destination');
  assert.equal((await cli(['status'])).result.session.state, 'paused');
  await cli(['resume', '--session', session]);
  beginMarkerPhase('resume after cancelled drag');
  checked('takeover during real mouse-down stops drag and releases buttons');

  snapshot = await observe();
  await markedAction('resumed edit click', { version: snapshot.version, ref: find(snapshot, 'Desktop test input').reference, kind: 'click' }, { left_down: 1, left_up: 1 });
  snapshot = await observe();
  // WinForms may consume the shortcut key during message preprocessing. The
  // modifier down/up is observable; exact text replacement verifies Ctrl+A.
  await markedAction('resumed shortcut', { version: snapshot.version, kind: 'press_key', keys: ['CTRL', 'A'] }, { key_down: 1, key_up: 1 });
  snapshot = await observe();
  await markedAction('resumed Unicode', { version: snapshot.version, kind: 'type_text', value: '键盘输入 verified' }, { unicode_down: '键盘输入 verified'.length, unicode_up: '键盘输入 verified'.length });
  snapshot = await observe(); assert.equal(find(snapshot, 'Desktop test input').text, '键盘输入 verified');
  checked('native keyboard shortcut and Unicode typing');
  const popupWindows = (await cli(['windows'])).result.windows.filter(item => item.pid === fixture.pid && item.id !== window.id);
  assert.equal(popupWindows.length, 1, 'untitled nonactivating popup is discoverable');
  await cli(['select', '--session', session, '--window', popupWindows[0].id]);
  beginMarkerPhase('select popup');
  const popupCapture = (await cli(['screenshot', '--session', session, '--output', path.join(output, 'untitled-popup.jpg')])).result;
  const popupButton = find(popupCapture, 'Desktop popup action');
  await markedAction('popup click', { version: popupCapture.version, kind: 'click', ...imagePoint(popupCapture.image, elementImagePoint(popupCapture, popupButton)) }, { left_down: 1, left_up: 1 });
  const popupResult = await waitFor(() => readFile(receipt + '.popup', 'utf8'), result => Boolean(result), 'popup click');
  assert.equal(popupResult, 'clicked-without-activation', 'popup input preserves keyboard focus');
  checked('untitled nonactivating popup discovery and pointer input');
  await cli(['select', '--session', session, '--window', window.id]);
  beginMarkerPhase('select main window');
  checked('owned WM messages retain stable nonzero keyboard and 32-bit pointer markers per worker phase, including cleanup; full64 low-level hook delivery is not asserted');

  snapshot = await observe();
  await action({ version: snapshot.version, ref: find(snapshot, 'Desktop test populate').reference, kind: 'invoke' });
  snapshot = await observe();
  assert.equal(snapshot.truncated, true); assert.ok(snapshot.gaps.includes('children_limit'), '300 child controls must report a concrete traversal gap');
  checked('UIA child budget reports truncated and children_limit');
  const versions = new Set();
  for (let index = 0; index < 3; index++) for (const imageOnly of [false, true]) {
    const sample = await capture(`timing-${index}-${imageOnly ? 'image-only' : 'uia'}`, { imageOnly, verifyMarkers: false });
    assert.ok(!versions.has(sample.snapshot.version)); versions.add(sample.snapshot.version);
    if (!imageOnly) assert.ok(sample.snapshot.elements.length > 0);
    report.timingSamples.push({ mode: imageOnly ? 'image-only' : 'uia-and-image', elapsedMs: sample.elapsedMs, elements: sample.snapshot.elements.length, gaps: sample.snapshot.gaps });
  }
  checked('three local CLI latency samples per screenshot mode on populated UIA tree');
  snapshot = await observe();
  await cli(['handoff', '--session', session]);
  await cli(['observe', '--session', session], 75);
  await cli(['resume', '--session', session]);
  beginMarkerPhase('final resume');
  await action({ version: snapshot.version, ref: find(snapshot, 'Desktop test apply').reference, kind: 'invoke' }, randomUUID(), 75);
  await observe(); await cli(['complete', '--session', session]);
  assert.equal((await cli(['status'])).result.session, null);
  checked('handoff/resume invalidation and session cleanup');
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, code: error.code, stack: error.stack };
  throw error;
} finally {
  // Each cleanup remains independent. A lost management reply must not skip
  // stopping our fixture, and cleanup must never release another task's owner.
  const cleanup = async (name, operation) => {
    try { await operation(); report.cleanup[name] = true; }
    catch (error) { report.cleanup[name] = { error: error.message }; report.ok = false; process.exitCode = 1; }
  };
  if (useApp) {
    await cleanup('session', async () => {
      const state = await cli(['status']);
      if (state?.result?.session?.name === session) await cli(['release', '--session', session]);
      assert.notEqual((await cli(['status'])).result.session?.name, session);
    });
  }
  await cleanup('service', async () => { await service?.close(); });
  await cleanup('server', async () => { await server?.close(); });
  if (fixture) {
    await cleanup('markerReceipt', async () => { report.finalInputMarkers = await readMarkers(); });
    await cleanup('fixture', async () => {
      if (useApp) {
        try { await writeFile(receipt + '.close', 'close'); await delay(300); }
        finally { terminateOwnedWindowsProcess(fixture.pid, executable); }
      } else { try { fixture.stdin.end(); } finally { fixture.kill(); } }
    });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, checks: report.checks.length, cleanup: report.cleanup }));
}
