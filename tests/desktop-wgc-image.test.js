const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const target = { id: 'a'.repeat(32), title: 'Owned test data', process: 'fixture', pid: 42, className: 'Chrome_WidgetWin_1', nativeHandle: '123456' };
const version = 'b'.repeat(32);
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'wgc-test', ...extra });

function wgcImage() {
  return {
    source: 'windows-graphics-capture', mimeType: 'image/jpeg', data: 'native-jpeg-data', width: 1002, height: 697,
    windowX: 100, windowY: 50, windowWidth: 1018, windowHeight: 705, coordinateInputAvailable: false,
    captureDiagnostics: { status: 'captured_unmapped', geometryStatus: 'stable_dimensions_match_origin_unvalidated', colorMode: 'SDR-BGRA8', contentWidth: 1002, contentHeight: 697, frameTimestampTicks: '123456789123456', elapsedMs: 130.5, candidateCaptureRect: { X: 8, Y: 0, Width: 1002, Height: 697 } }
  };
}

let captureBundle;
function captureModule(electron) {
  const source = path.resolve(__dirname, '../src/main/desktop/capture.ts');
  captureBundle ||= buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' }).outputFiles[0].text;
  const instance = new Module(source, module); instance.filename = source; instance.paths = Module._nodeModulePaths(path.dirname(source));
  const realRequire = instance.require.bind(instance);
  instance.require = id => id === 'electron' ? electron : realRequire(id);
  instance._compile(captureBundle, source);
  return instance.exports;
}

function forbiddenElectron() {
  const unexpected = () => { throw new Error('A preserved WGC image must never use an Electron capture API'); };
  return { BrowserWindow: { getAllWindows: unexpected }, desktopCapturer: { getSources: unexpected }, screen: { dipToScreenRect: unexpected } };
}

test('native WGC images bypass every Electron compositor API and retain the original metadata object', async () => {
  const { captureDesktopWindow } = captureModule(forbiddenElectron());
  const image = wgcImage(); Object.freeze(image.captureDiagnostics); Object.freeze(image);
  for (const window of [target, { ...target, className: 'Form' }, { ...target, nativeHandle: undefined }]) {
    const result = await captureDesktopWindow(window, image);
    assert.strictEqual(result, image); assert.strictEqual(result.captureDiagnostics, image.captureDiagnostics);
    assert.equal(result.coordinateInputAvailable, false); assert.equal(result.captureRect, undefined);
    assert.equal(result.source, 'windows-graphics-capture'); assert.equal(result.data, 'native-jpeg-data');
  }
});

test('the App cannot promote a native screenshot with unavailable physical coordinate awareness', async () => {
  const { captureDesktopWindow } = captureModule(forbiddenElectron());
  for (const coordinateInputAvailable of [false, true, undefined, null, 'true']) {
    const native = { ...wgcImage(), source: 'native-window', coordinateInputAvailable };
    const result = await captureDesktopWindow({ ...target, className: 'Form' }, native);
    assert.equal(result.coordinateInputAvailable, coordinateInputAvailable === true);
    assert.equal(result.data, native.data);
    assert.equal(result.source, 'native-window');
  }
});

test('an unsupported WGC fallback retains its reason and compositor images remain unqualified', async () => {
  const calls = [];
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 900, height: 600 }), toJPEG: quality => { assert.equal(quality, 90); return Buffer.from('compositor-data'); } };
  const { captureDesktopWindow } = captureModule({
    BrowserWindow: { getAllWindows: () => [] },
    desktopCapturer: { getSources: async options => { calls.push(options); return [{ id: 'window:123456:0', thumbnail }]; } },
    screen: { dipToScreenRect: () => assert.fail('External HWND must not use owned window DIP mapping') }
  });
  for (const status of ['unsupported_api', 'unsupported_capture', 'device_unsupported']) {
    const native = { ...wgcImage(), source: 'native-window', captureFallback: `windows_graphics_capture_${status}`, captureDiagnostics: undefined, captureRect: { x: 0, y: 0, width: 1018, height: 705 } };
    const result = await captureDesktopWindow(target, native);
    assert.equal(result.source, 'compositor'); assert.equal(result.captureFallback, native.captureFallback);
    assert.equal(result.data, Buffer.from('compositor-data').toString('base64'));
    assert.equal(result.coordinateInputAvailable, false); assert.equal(result.captureRect, undefined);
    assert.equal(result.windowX, native.windowX); assert.equal(result.windowWidth, native.windowWidth);
  }
  assert.equal(calls.length, 3); assert.deepEqual(calls[0].types, ['window']);
});

test('owned Chromium fallback requires explicit physical pixels and a contained content crop', async () => {
  let content = { x: 108, y: 50, width: 100, height: 100 };
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123456n);
  const page = { isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }), toJPEG: () => Buffer.from('owned-compositor') };
  const { captureDesktopWindow } = captureModule({
    BrowserWindow: { getAllWindows: () => [{ getNativeWindowHandle: () => handle, capturePage: async () => page, getContentBounds: () => content }] },
    screen: { dipToScreenRect: () => content },
    desktopCapturer: { getSources: () => assert.fail('Owned capture must use its own page') }
  });
  const native = { ...wgcImage(), source: 'native-window', windowWidth: 110, windowHeight: 110, captureDiagnostics: undefined };
  for (const physicalPixelsAvailable of [undefined, false, true]) {
    const result = await captureDesktopWindow(target, { ...native, physicalPixelsAvailable });
    assert.equal(result.coordinateInputAvailable, physicalPixelsAvailable === true);
    assert.deepEqual(result.captureRect, physicalPixelsAvailable === true ? { x: 8, y: 0, width: 100, height: 100 } : undefined);
  }
  for (const invalid of [{ ...content, x: 99 }, { ...content, width: 111 }, { ...content, y: 49 }, { ...content, height: 111 }, { ...content, width: 0 }, { ...content, height: -1 }, { ...content, width: NaN }]) {
    content = invalid;
    const result = await captureDesktopWindow(target, { ...native, physicalPixelsAvailable: true });
    assert.equal(result.coordinateInputAvailable, false);
    assert.equal(result.captureRect, undefined);
  }
});

test('candidate capture bounds cannot authorize coordinate input through the service', async t => {
  const { captureDesktopWindow } = captureModule(forbiddenElectron());
  let actions = 0;
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, capture: captureDesktopWindow, driver: () => ({ close() {}, async request(operation) {
    if (operation === 'windows') return { windows: [target] };
    if (operation === 'window.screenshot') return { windowId: target.id, version, image: wgcImage(), elements: [], gaps: [], truncated: false };
    if (operation === 'window.action') { actions++; return { executed: true }; }
    throw new Error(`Unexpected operation ${operation}`);
  } }) });
  t.after(() => service.close());
  await service.execute(command('claim', { windowId: target.id }));
  const result = await service.execute(command('screenshot'));
  assert.equal(result.image.coordinateInputAvailable, false); assert.ok(result.image.captureDiagnostics.candidateCaptureRect);
  for (const params of [
    { kind: 'click', x: 50, y: 60 },
    { kind: 'double_click', x: 50, y: 60 },
    { kind: 'move', x: 50, y: 60 },
    { kind: 'wheel', x: 50, y: 60, deltaY: 120 },
    { kind: 'drag', ref: 'e1', toX: 80, toY: 90 }
  ]) await assert.rejects(service.execute(command('action', { requestId: randomUUID(), params: { version, ...params } })), { code: 'DESKTOP_SCREENSHOT_REQUIRED' });
  assert.equal(actions, 0);
});

test('native protected, changed or failed captures reject before any App compositor fallback', async t => {
  for (const status of ['capture_protected', 'access_denied', 'window_closed', 'window_changed', 'size_changed', 'device_lost', 'timeout', 'cancelled', 'empty_frame']) {
    let captureCalls = 0;
    const failure = Object.assign(new Error('Capture is unavailable'), { code: 'DESKTOP_SCREENSHOT_UNAVAILABLE', details: { cause: `WGC_${status.toUpperCase()}`, diagnostics: { capture: { source: 'windows-graphics-capture', status } } } });
    const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, capture: async () => { captureCalls++; assert.fail('Failure must not become an App screenshot'); }, driver: () => ({ close() {}, async request(operation) {
      if (operation === 'windows') return { windows: [target] };
      if (operation === 'window.screenshot') throw failure;
      throw new Error(`Unexpected operation ${operation}`);
    } }) });
    try {
      await service.execute(command('claim', { windowId: target.id }));
      await assert.rejects(service.execute(command('screenshot')), error => error.code === failure.code && error.details.diagnostics.capture.status === status);
      assert.equal(captureCalls, 0);
    } finally { service.close(); }
  }
});

test('native WGC image formatting and geometry checks are pure and bounded', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-wgc-image-test-'));
  const executable = path.join(directory, 'DesktopWgcImageTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const { resolveWindowsWinrtReferences } = await import('../scripts/windows-winrt-contracts.mjs');
  const winrt = await resolveWindowsWinrtReferences(root, { framework });
  const { desktopSourceFiles } = await import('../scripts/desktop-source-files.mjs');
  const sources = desktopSourceFiles.map(file => path.join(root, 'native', 'desktop', file));
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopWgcImageTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/r:${path.join(framework, 'WPF', file)}`),
    ...winrt.references.map(file => `/r:${file}`), ...sources, path.join(__dirname, 'helpers', 'desktop-wgc-image-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(result.ok, true); assert.equal(result.checks.length, 15);
  t.diagnostic(result.checks.join('; '));
});
