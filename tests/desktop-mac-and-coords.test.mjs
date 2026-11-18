import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { desktopExecutable, DesktopWorker } = loadCli('src/main/desktop/worker.ts');
const { DesktopService, mapDesktopActionCoordinates } = loadCli('src/main/desktop/service.ts');
const { desktopActionSchema } = loadCli('src/main/desktop/schema.ts');
const { computeNoticePosition, DesktopControlNotice } = loadCli('src/main/desktop/notice.ts');
const { isNonChromiumNativeDesktopTarget } = loadCli('src/main/desktop/admission.ts');
const { createWindowsDesktopDiscovery, createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');

test('desktopExecutable resolves macOS and Windows native helper binaries', () => {
  assert.ok(desktopExecutable('darwin').endsWith(path.join('native', 'profilepilot-desktop-mac')));
  assert.ok(desktopExecutable('win32').endsWith(path.join('native', 'ProfilePilot.Desktop.exe')));
});

test('DesktopWorker spawns macOS native binary in-place to preserve TCC attribution', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mac-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const macBin = path.join(dir, 'profilepilot-desktop-mac');
  fs.writeFileSync(macBin, '#!/bin/sh\n');

  let spawnedExe = '';
  const fakeSpawn = (exe, args) => {
    spawnedExe = exe;
    assert.equal(args[0], '--input-marker');
    const child = new EventEmitter();
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      const req = JSON.parse(text);
      if (req.operation === 'cancel') {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        return;
      }
      child.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { windows: [] } }) + '\n');
    });
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    };
    return child;
  };

  if (process.platform !== 'win32') {
    const worker = new DesktopWorker(macBin, fakeSpawn);
    const res = await worker.request('windows', {});
    assert.deepEqual(res, { windows: [] });
    assert.equal(spawnedExe, macBin);
    await worker.close();
  }
});

test('DesktopService on darwin works cleanly without WindowsInputBroker across interactive and background sessions', async () => {
  const win = {
    id: 'a'.repeat(32),
    title: 'TextEdit',
    process: 'TextEdit',
    pid: 512,
    className: 'AXWindow',
    nativeHandle: '9001',
    bounds: { x: 100, y: 80, width: 900, height: 600 }
  };
  const ver1 = '1'.repeat(32);
  const ver2 = '2'.repeat(32);
  const actions = [];

  const service = new DesktopService({
    platform: 'darwin',
    available: () => true,
    driver: () => ({
      inputMarker: 'fedcba9876543210',
      close() {},
      async request(op, params) {
        if (op === 'windows') return { windows: [win] };
        if (op === 'control.background') return { mode: 'background', backgroundTarget: { pid: win.pid, window: win.nativeHandle } };
        if (op === 'window.observe') return { windowId: win.id, version: ver1, truncated: false, elements: [{ reference: 'e0', role: 'Window', name: 'TextEdit', text: '', actions: ['invoke'], password: false }], image: null };
        if (op === 'window.screenshot') {
          return {
            windowId: win.id,
            version: ver2,
            truncated: false,
            elements: [],
            image: {
              mimeType: 'image/jpeg',
              data: Buffer.from('jpg').toString('base64'),
              width: 900,
              height: 600,
              windowWidth: 900,
              windowHeight: 600,
              captureRect: { x: 0, y: 0, width: 900, height: 600 },
              coordinateInputAvailable: true
            }
          };
        }
        if (op === 'window.action') {
          actions.push(params);
          return { executed: true, requiresObservation: true };
        }
        throw new Error('Unexpected op: ' + op);
      }
    })
  });

  try {
    const initial = service.status();
    assert.equal(initial.supported, true);
    assert.equal(initial.available, true);
    assert.equal(initial.inputObservation.available, true);
    assert.equal(initial.inputObservation.phase, 'idle');

    const claimed = await service.execute({ action: 'desktop', method: 'claim', session: 'mac-task', windowId: win.id });
    assert.equal(claimed.session.state, 'active');
    assert.equal(claimed.inputObservation.phase, 'ready');
    assert.ok(claimed.inputObservation.generation);

    await service.execute({ action: 'desktop', method: 'screenshot', session: 'mac-task' });
    const clickRes = await service.execute({
      action: 'desktop',
      method: 'action',
      session: 'mac-task',
      requestId: randomUUID(),
      observeAfter: false,
      params: { version: ver2, kind: 'click', x: 500, y: 500, coordSpace: 'normalized' }
    });
    assert.equal(clickRes.executed, true);
    assert.deepEqual(actions[0], { version: ver2, kind: 'click', x: 450, y: 300 });

    const paused = await service.execute({ action: 'desktop', method: 'handoff', session: 'mac-task' });
    assert.equal(paused.session.state, 'paused');
    assert.equal(paused.inputObservation.phase, 'paused');
    const resumed = await service.resume({
      session: paused.session.name,
      generation: paused.inputObservation.generation,
      revision: paused.session.revision
    });
    assert.equal(resumed.session.state, 'active');
    await service.execute({ action: 'desktop', method: 'complete', session: 'mac-task', requireActive: true });
    assert.equal(service.status().session, null);
  } finally {
    await service.close();
  }
});

test('server-side coordSpace auto-scales image, normalized, and physical coordinates with WGC DWM extended-frame offset', async () => {
  const win = { id: 'b'.repeat(32), title: 'Browser', process: 'chrome', pid: 777, className: 'Chrome_WidgetWin_1' };
  const ver = '3'.repeat(32);
  const dispatched = [];

  const service = new DesktopService({
    platform: 'win32',
    allowUnobservedTestDriver: true,
    available: () => true,
    driver: () => ({
      close() {},
      async request(op, params) {
        if (op === 'windows') return { windows: [win] };
        if (op === 'window.screenshot') {
          // Simulates Win10/11 8px left/right/bottom invisible resize border + 0.5x image downscale:
          // Outer GetWindowRect: 1016 x 708; Visible DWM frame: offset (8, 0), size 1000 x 700; Encoded JPEG: 500 x 350.
          return {
            windowId: win.id,
            version: ver,
            truncated: false,
            elements: [],
            image: {
              mimeType: 'image/jpeg',
              data: 'ZmFrZQ==',
              width: 500,
              height: 350,
              windowWidth: 1016,
              windowHeight: 708,
              captureRect: { x: 8, y: 0, width: 1000, height: 700 },
              coordinateInputAvailable: true,
              source: 'windows-graphics-capture'
            }
          };
        }
        if (op === 'window.action') {
          dispatched.push(params);
          return { executed: true };
        }
        return { windowId: win.id, version: ver, elements: [], image: null };
      }
    })
  });

  try {
    await service.execute({ action: 'desktop', method: 'claim', session: 'coord-test', windowId: win.id });

    // 1. coordSpace: "image" -> (250, 175) in 500x350 maps to (8 + 500, 0 + 350) = (508, 350)
    await service.execute({ action: 'desktop', method: 'screenshot', session: 'coord-test' });
    const reqId = randomUUID();
    const clickCmd = {
      action: 'desktop',
      method: 'action',
      session: 'coord-test',
      requestId: reqId,
      observeAfter: false,
      params: { version: ver, kind: 'click', x: 250, y: 175, coordSpace: 'image', button: 'left' }
    };
    await service.execute(clickCmd);
    // Replay with same requestId must match receipt hash without mutating input
    await service.execute(clickCmd);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { version: ver, kind: 'click', x: 508, y: 350, button: 'left' });

    // 2. coordSpace: "normalized" drag -> (0, 0) -> (8, 0), (1000, 1000) -> clamped to (8 + 999, 0 + 699) = (1007, 699)
    await service.execute({ action: 'desktop', method: 'screenshot', session: 'coord-test' });
    await service.execute({
      action: 'desktop',
      method: 'action',
      session: 'coord-test',
      requestId: randomUUID(),
      observeAfter: false,
      params: { version: ver, kind: 'drag', x: 0, y: 0, toX: 1000, toY: 1000, coordSpace: 'normalized' }
    });
    assert.deepEqual(dispatched[1], { version: ver, kind: 'drag', x: 8, y: 0, toX: 1007, toY: 699 });

    // 3. coordSpace: "physical" passes raw physical window pixels and rejects out-of-window coordinates
    await service.execute({ action: 'desktop', method: 'screenshot', session: 'coord-test' });
    await assert.rejects(
      service.execute({
        action: 'desktop',
        method: 'action',
        session: 'coord-test',
        requestId: randomUUID(),
        observeAfter: false,
        params: { version: ver, kind: 'move', x: 1016, y: 100, coordSpace: 'physical' }
      }),
      { code: 'DESKTOP_BAD_REQUEST' }
    );
    await service.execute({
      action: 'desktop',
      method: 'action',
      session: 'coord-test',
      requestId: randomUUID(),
      observeAfter: false,
      params: { version: ver, kind: 'move', x: 20, y: 30, coordSpace: 'physical' }
    });
    assert.deepEqual(dispatched[2], { version: ver, kind: 'move', x: 20, y: 30 });
  } finally {
    await service.close();
  }

  // Schema checks
  assert.equal(desktopActionSchema.safeParse({ version: ver, kind: 'click', x: 100, y: 200, coordSpace: 'image' }).success, true);
  assert.equal(desktopActionSchema.safeParse({ version: ver, kind: 'drag', ref: 'e1', toX: 500, toY: 500, coordSpace: 'normalized' }).success, true);
  assert.equal(desktopActionSchema.safeParse({ version: ver, kind: 'click', ref: 'e1', coordSpace: 'image' }).success, false);
  assert.equal(desktopActionSchema.safeParse({ version: ver, kind: 'click', x: 1001, y: 50, coordSpace: 'normalized' }).success, false);
  assert.equal(desktopActionSchema.safeParse({ version: ver, kind: 'invoke', ref: 'e1', coordSpace: 'image' }).success, false);
  assert.deepEqual(
    mapDesktopActionCoordinates({ kind: 'wheel', x: 500, y: 500, deltaY: 120, coordSpace: 'normalized' }, {
      imageWidth: 800, imageHeight: 600, windowWidth: 1600, windowHeight: 1200,
      captureRect: { x: 0, y: 0, width: 1600, height: 1200 }
    }),
    { kind: 'wheel', x: 800, y: 600, deltaY: 120 }
  );
});

test('DesktopControlNotice dodges target window caption controls and scopes global shortcut to active sessions', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const noticeSize = { width: 390, height: 200 };

  // Maximized window on Windows -> top-right caption buttons occluded -> dodges to bottom-left!
  const maxPos = computeNoticePosition(workArea, noticeSize, { x: 0, y: 0, width: 1920, height: 1080 }, 'win32');
  assert.equal(maxPos.corner, 'bottom-left');
  assert.equal(maxPos.x, 16);
  assert.equal(maxPos.y, 864);

  // Top-right window -> dodges to bottom-left (zero overlap!)
  const trPos = computeNoticePosition(workArea, noticeSize, { x: 1100, y: 0, width: 820, height: 600 }, 'win32');
  assert.equal(trPos.corner, 'bottom-left');

  // Bottom-left window -> keeps top-right (zero overlap!)
  const blPos = computeNoticePosition(workArea, noticeSize, { x: 0, y: 400, width: 800, height: 680 }, 'win32');
  assert.equal(blPos.corner, 'top-right');

  // Verify scoped globalShortcut in ipc.ts: idle on startup -> registers on session -> unregisters when session ends
  const shortcuts = [];
  let onChangedCallback;
  let currentStatus = {
    supported: true, available: true, platform: 'darwin', stopShortcutAvailable: false,
    inputObservation: { available: true, phase: 'idle' }, session: null
  };
  const ipcCode = transformSync(fs.readFileSync(path.join(root, 'src/main/desktop/ipc.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022'
  }).code;
  const mod = { exports: {} };
  vm.runInNewContext(ipcCode, {
    module: mod, exports: {}, __dirname: path.join(root, 'src/main/desktop'),
    process: { platform: 'darwin', env: {}, pid: 999 },
    require(id) {
      if (id === 'electron') {
        return {
          BrowserWindow: class { static getAllWindows() { return []; } },
          app: { once() {}, setAccessibilitySupportEnabled() {} },
          ipcMain: { handle() {} },
          screen: { getPrimaryDisplay: () => ({ workArea }) },
          globalShortcut: {
            register: key => { shortcuts.push('register:' + key); return true; },
            unregister: key => { shortcuts.push('unregister:' + key); }
          }
        };
      }
      if (id === './service') {
        return {
          DesktopService: class {
            constructor(opts) { onChangedCallback = opts.onChanged; }
            status() { return currentStatus; }
            control() { return currentStatus; }
            noticeUnavailable() { return currentStatus; }
            async close() {}
          }
        };
      }
      if (id === './notice') return { DesktopControlNotice, computeNoticePosition };
      if (id === './capture') return { captureDesktopWindow: async (_w, img) => img };
      if (id === '../diagnostic-log') return { writeDiagnosticLog() {} };
      if (id === '../../shared/desktop') return { DESKTOP_CHANNEL: 'desktop:request', DESKTOP_CHANGED: 'desktop:changed' };
      if (id === '../workspace-shell') return { isWorkspaceShell: () => false };
      return require(id);
    }
  });
  mod.exports.registerDesktop();
  assert.deepEqual(shortcuts, [], 'idle startup must not claim global shortcut');

  currentStatus = {
    ...currentStatus,
    inputObservation: { available: true, phase: 'ready', generation: 'g1' },
    session: { name: 's1', state: 'active', revision: 0, expiresAt: 999999, window: { id: 'a'.repeat(32), title: 'App', process: 'App', pid: 10, className: 'AXWindow' } }
  };
  onChangedCallback(currentStatus);
  assert.deepEqual(shortcuts, ['register:CommandOrControl+Alt+Escape']);

  currentStatus = { ...currentStatus, inputObservation: { available: true, phase: 'idle' }, session: null };
  onChangedCallback(currentStatus);
  assert.deepEqual(shortcuts, ['register:CommandOrControl+Alt+Escape', 'unregister:CommandOrControl+Alt+Escape']);
});

test('non-Chromium native fast-path skips Chrome RM catalog scans, tolerates GATEWAY_UNAVAILABLE, and ignores unrelated unresolved Local Apps', async () => {
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 100, className: 'Notepad', process: 'Notepad' }), true);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 101, className: 'CabinetWClass', process: 'explorer.exe' }), true);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 102, className: 'AXWindow', process: 'TextEdit' }), true);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 103, className: 'Chrome_WidgetWin_1', process: 'Notepad' }), false);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 104, className: 'AXWindow', process: 'Google Chrome' }), false);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 105, className: 'AXWindow', process: 'Electron' }), false);
  assert.equal(isNonChromiumNativeDesktopTarget({ pid: 106 }), false);

  let catalogCalls = 0;
  const discovery = createWindowsDesktopDiscovery({
    sample: async () => ({
      snapshotId: randomUUID(),
      capturedAt: 1000,
      snapshot: {
        processes: [
          { pid: 100, parentPid: 4, name: 'Notepad.exe', executablePath: 'C:\\Windows\\Notepad.exe', commandLine: 'Notepad.exe', commandLineAvailable: true, startedAt: null, identityStatus: 'confirmed', creationFileTime: '1' },
          { pid: 200, parentPid: 4, name: 'chrome.exe', executablePath: 'C:\\Chrome\\chrome.exe', commandLine: 'chrome.exe', commandLineAvailable: true, startedAt: null, identityStatus: 'confirmed', creationFileTime: '2' }
        ],
        tcp: [],
        processesAvailable: true,
        processesComplete: true,
        tcpAvailable: true,
        tcpComplete: true
      }
    }),
    catalog: async () => {
      catalogCalls++;
      throw new Error('PROFILE_FILE_SCAN_START_FAILED_5');
    },
    apps: async () => [
      // Unrelated service-mode local app with unresolved PID
      {
        id: 'unrelated-api',
        mode: 'service',
        command: 'npm run dev',
        cwd: 'C:\\api',
        cdpPort: null,
        inspectPort: null,
        agentPort: null,
        servicePort: 4321,
        serviceProcess: 'C:\\api\\server.js',
        runtime: { status: 'unknown', pid: null, startedAt: null, exitCode: null, error: '' }
      }
    ]
  });

  const admit = createRuntimeDesktopAdmission({
    discovery,
    now: () => 1000,
    gateway: async () => { throw Object.assign(new Error('Gateway offline'), { code: 'GATEWAY_UNAVAILABLE' }); },
    native: async () => { throw new Error('Browser service discovery unavailable'); }
  });

  // Notepad succeeds cleanly without hitting Chrome RM catalog or failing on GATEWAY_UNAVAILABLE / unrelated service app!
  const notepadDecision = await admit({ pid: 100, className: 'Notepad', process: 'Notepad' });
  assert.equal(notepadDecision.status, 'unmanaged');
  assert.equal(catalogCalls, 0);

  // Chrome still runs full strict catalog & fails closed!
  const chromeDecision = await admit({ pid: 200, className: 'Chrome_WidgetWin_1', process: 'chrome' });
  assert.equal(chromeDecision.status, 'unknown');
  assert.equal(catalogCalls, 1);
});
