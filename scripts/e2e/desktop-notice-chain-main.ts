import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export const noticeChainCases = ['throw', 'rejection'] as const;
export function noticeChainFaultSource(kind: string, nonce: string) {
  assert.ok(noticeChainCases.includes(kind as any)); assert.match(nonce, /^[a-f0-9]{32}$/);
  return `setTimeout(() => { console.log('notice-chain-fault:${nonce}:${kind}'); ${kind === 'throw'
    ? "throw new Error('Owned notice chain throw')" : "void Promise.reject(new Error('Owned notice chain rejection'))"}; }, 0); true`;
}
export function validateNoticeChainRequest(value: any, nonce: string, now: number) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.nonce, nonce); assert.match(value.id || '', /^[a-f0-9-]{36}$/);
  assert.ok(['desktop', 'inspect', 'fault', 'close'].includes(value.action));
  assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > now && value.expiresAt <= now + 90000);
  const fields = ['id', 'nonce', 'expiresAt', 'action', ...(value.action === 'desktop' ? ['command'] : value.action === 'fault' ? ['epoch', 'generation', 'version', 'webContentsId', 'documentNonce'] : [])];
  assert.deepEqual(Object.keys(value).sort(), fields.sort());
  if (value.action === 'desktop') {
    const command = value.command;
    assert.equal(command?.action, 'desktop');
    assert.ok(['status', 'windows', 'claim', 'observe', 'action', 'receipt', 'release'].includes(command.method));
    if (command.method === 'action') assert.equal(command.params?.kind, 'set_value', 'Only owned UIA set_value is permitted');
    if (command.method === 'observe') assert.ok(!command.screenshot, 'No screenshot requested by notice chain');
  }
}
export function validateNoticeChainFault(value: any, facts: any) {
  assert.equal(facts.attempted, false, 'A fault is never replayed');
  assert.equal(facts.browserFactoryCalls, 0); assert.deepEqual(facts.runtime.browserPids, []);
  assert.equal(facts.status.session?.name, facts.session); assert.equal(facts.status.session.state, 'active');
  assert.equal(facts.status.session.window.pid, facts.target.pid); assert.equal(facts.status.session.window.nativeHandle, facts.target.hwnd);
  assert.equal(facts.status.inputObservation.phase, 'ready'); assert.equal(facts.status.inputObservation.epoch, value.epoch);
  assert.equal(facts.status.inputObservation.generation, value.generation); assert.notEqual(facts.status.inputObservation.unobservedTestDriver, true);
  assert.equal(facts.runtime.desktop?.phase, 'ready'); assert.equal(facts.runtime.desktop.epoch, value.epoch); assert.equal(facts.runtime.desktop.generation, value.generation);
  assert.equal(facts.lastObservation?.version, value.version); assert.equal(facts.lastObservation.windowId, facts.status.session.window.id);
  assert.equal(facts.toolbar?.webContentsId, value.webContentsId); assert.equal(facts.toolbar.documentNonce, value.documentNonce);
  assert.equal(facts.toolbar.exactOwnedFile, true); assert.equal(facts.toolbar.visible, true); assert.equal(facts.toolbar.destroyed, false);
  assert.equal(facts.ownerDriverStopConfirmed, false); assert.equal(facts.observerExited, false);
}
export function validateNoticeChainEvidence(value: any, expected: any) {
  assert.equal(value.nonce, expected.nonce); assert.equal(value.status.session?.name, expected.session);
  assert.equal(value.status.session.state, 'paused'); assert.equal(value.status.inputObservation.reason, 'notice_unavailable');
  assert.equal(value.status.inputObservation.certainty, 'unknown'); assert.equal(value.status.inputObservation.generation, expected.generation);
  assert.equal(value.status.inputObservation.epoch, expected.epoch);
  assert.equal(value.faultAttempted, true); assert.equal(value.faultScheduled, true);
  assert.equal(value.browserFactoryCalls, 0); assert.equal(value.spawnCount, 1); assert.deepEqual(value.runtime.browserPids, []);
  assert.equal(value.runtime.stopConfirmed, true); assert.equal(value.runtime.desktop, null);
  assert.equal(value.observer.exited, true); assert.equal(value.observer.closed, true);
  assert.equal(value.drivers.filter((driver: any) => driver.roles.includes('owner') && driver.stopConfirmed && driver.exited && driver.closed).length, 1);
  assert.equal(value.toolbar.destroyed, true);
  const fault = value.events.find((event: any) => event.kind === 'fault-fired' && event.case === expected.case);
  const paused = value.events.find((event: any) => event.kind === 'service-state' && event.reason === 'notice_unavailable' && event.generation === expected.generation);
  assert.ok(fault && paused && fault.sequence < paused.sequence, 'An owned main-world fault must precede the specific notice pause');
}

async function run(configFile: string) {
  const { app, BrowserWindow } = require('electron') as typeof import('electron');
  const { registerDesktop } = require('../../src/main/desktop/ipc') as typeof import('../../src/main/desktop/ipc');
  const { desktopExecutable } = require('../../src/main/desktop/worker') as typeof import('../../src/main/desktop/worker');
  const { WindowsInputRuntime } = require('../../src/main/desktop/input-runtime') as typeof import('../../src/main/desktop/input-runtime');
  const { spawnWindowsInputObserver } = require('../../src/main/desktop/input-observer-process') as typeof import('../../src/main/desktop/input-observer-process');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(process.platform, 'win32'); assert.match(config.nonce, /^[a-f0-9]{32}$/); assert.ok(noticeChainCases.includes(config.case));
  assert.equal(path.dirname(path.resolve(configFile)), path.resolve(config.home));
  const base = path.join(config.home, 'main');
  // Only local diagnostics are written. No management server or shared runtime-state.
  process.env.PROFILEPILOT_LOG_ROOT = path.join(config.home, 'logs');
  process.env.CPM_ELECTRON_SMOKE_TEST = '1'; // Do not compete for the real App's stop shortcut.
  app.setPath('userData', path.join(config.home, 'user-data'));
  const exec = promisify(execFile), events: any[] = [], drivers: any[] = [], windows: any[] = [];
  let sequence = 0, service: any, runtime: any, identity: any, observer: any, spawnCount = 0, browserFactoryCalls = 0;
  let faultAttempted = false, faultScheduled = false, lastObservation: any, lastId = '', busy = false, closing: Promise<void> | undefined, timer: any, stateKey = '';
  const save = (suffix: string, value: any) => { const file = base + suffix; fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
  const event = (kind: string, details: any = {}) => { events.push({ sequence: ++sequence, kind, at: Date.now(), ...details }); assert.ok(events.length <= 256, 'Bounded fixture event journal exceeded'); };
  async function gate() { await (await import(pathToFileURL(config.gateModule).href)).assertDesktopAcceptanceWindow(); }
  async function identify(pid: number) {
    const { stdout } = await exec(config.identityExecutable, ['--inspect', String(pid)], { windowsHide: true, timeout: 10000 });
    const value = JSON.parse(stdout); assert.equal(value.ok, true); assert.equal(value.pid, pid);
    assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false); return value;
  }
  function sameIdentity(actual: any, expected: any) {
    for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'sha256']) assert.equal(actual[key], expected[key]);
    assert.equal(path.resolve(actual.executable).toLowerCase(), path.resolve(expected.executable).toLowerCase());
  }
  function toolbar() {
    assert.ok(windows.length <= 1, 'Notice must not automatically recreate after failure');
    const window = windows[0]; if (!window) return null;
    const destroyed = window.isDestroyed();
    const url = destroyed ? window.__ownedUrl : window.webContents.getURL();
    let exactOwnedFile = false, documentNonce;
    try { exactOwnedFile = path.resolve(fileURLToPath(url)).toLowerCase() === path.join(config.home, 'public/desktop-control.html').toLowerCase(); documentNonce = new URL(url).searchParams.get('notice'); } catch {}
    if (!destroyed) window.__ownedUrl = url;
    return { destroyed, visible: !destroyed && window.isVisible(), webContentsId: window.__contentsId, exactOwnedFile, documentNonce, url };
  }
  function trackDrivers() {
    // Read-only acceptance instrumentation: production registerDesktop keeps
    // its default constructor/factory and controls every close operation.
    for (const [role, driver] of [['catalog', service?.catalog], ['owner', service?.owner?.driver]] as const) {
      if (!driver) continue;
      let record = drivers.find(value => value.driver === driver);
      if (!record) { record = { driver, roles: [], child: undefined, exited: false, closed: false }; drivers.push(record); }
      if (!record.roles.includes(role)) record.roles.push(role);
      const child = driver.process;
      if (child && !record.child) {
        record.child = child;
        child.once('exit', () => { record.exited = true; event('driver-exit', { pid: child.pid, roles: record.roles }); });
        child.once('close', () => { record.closed = true; event('driver-close', { pid: child.pid, roles: record.roles }); });
      }
    }
  }
  function evidence() {
    trackDrivers();
    return { nonce: config.nonce, pid: process.pid, identity, case: config.case, scope: 'isolated-registerDesktop-chain', status: service?.status(), runtime: runtime?.snapshot(),
      browserFactoryCalls, spawnCount, faultAttempted, faultScheduled, lastObservation, toolbar: toolbar(), events,
      observer: observer && { pid: observer.child.pid, identity: observer.identity, exited: observer.exited, closed: observer.closed },
      drivers: drivers.map(record => ({ roles: record.roles, pid: record.child?.pid, identity: record.identity, stopConfirmed: record.driver.stopConfirmed, exited: record.exited, closed: record.closed })) };
  }
  function recordState() {
    const status = service?.status(); if (!status) return;
    const value = { state: status.session?.state, phase: status.inputObservation.phase, reason: status.inputObservation.reason, generation: status.inputObservation.generation, epoch: status.inputObservation.epoch };
    const key = JSON.stringify(value); if (key !== stateKey) { stateKey = key; event('service-state', value); }
  }
  async function close(reason: string) {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(timer); const failures: string[] = [];
      for (const operation of [() => service?.close(), () => runtime?.dispose()]) try { await operation(); } catch (error: any) { failures.push(error.code || error.message); }
      // Use normal Electron shutdown so registerDesktop's will-quit cleanup
      // destroys the notice. No test calls noticeUnavailable/control to pass.
      save('.closing.json', { ...evidence(), reason, failures });
      app.quit();
    })(); return closing;
  }
  app.on('browser-window-created', (_event, window: any) => {
    windows.push(window); window.__contentsId = window.webContents.id;
    window.webContents.on('did-finish-load', () => { toolbar(); event('notice-loaded', { webContentsId: window.__contentsId }); });
    window.webContents.on('console-message', (message: any) => {
      if (message.message === 'notice-chain-fault:' + config.nonce + ':' + config.case) event('fault-fired', { case: config.case, webContentsId: window.__contentsId });
    });
    window.once('closed', () => { event('notice-closed', { webContentsId: window.__contentsId }); queueMicrotask(() => { if (service) recordState(); }); });
  });
  app.on('window-all-closed', () => {}); // Preserve the service after a failed notice.
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void close('electron-quit'); } });
  process.on('uncaughtException', error => { try { save('.failure.json', { message: error.message }); } finally { void close('uncaught-main-error'); } });
  process.on('unhandledRejection', (error: any) => { try { save('.failure.json', { message: error?.message || String(error) }); } finally { void close('unhandled-main-rejection'); } });
  async function inspect() {
    trackDrivers();
    for (const record of [...drivers, ...(observer ? [observer] : [])]) {
      if (!record.child || record.exited) continue;
      const value = await identify(record.child.pid); assert.equal(value.parentPid, process.pid);
      const expectedHash = record === observer ? config.observerHash : config.desktopHash;
      assert.equal(value.sha256, expectedHash);
      assert.equal(path.dirname(value.executable).toLowerCase(), path.join(os.tmpdir(), 'profilepilot-' + (record === observer ? 'input-observer' : 'desktop') + '-runtime').toLowerCase());
      if (record.identity) sameIdentity(value, record.identity); else record.identity = value;
    }
    recordState(); return evidence();
  }
  async function handle(request: any) {
    validateNoticeChainRequest(request, config.nonce, Date.now());
    if (request.action === 'close') { save('.response.json', { id: request.id, ok: true, closing: true }); void close('owned-request'); return; }
    if (request.action === 'inspect') return inspect();
    if (request.action === 'desktop') {
      if (!['status', 'receipt', 'release'].includes(request.command.method)) await gate();
      if (!['status', 'windows'].includes(request.command.method)) assert.equal(request.command.session, config.session);
      const result = await service.execute(request.command);
      if (request.command.method === 'observe') lastObservation = result;
      recordState(); trackDrivers(); return result;
    }
    await gate(); sameIdentity(await identify(config.target.pid), config.targetIdentity);
    await inspect();
    validateNoticeChainFault(request, { attempted: faultAttempted, browserFactoryCalls, runtime: runtime.snapshot(), status: service.status(),
      session: config.session, target: config.target, lastObservation, toolbar: toolbar(),
      ownerDriverStopConfirmed: service.owner?.driver.stopConfirmed, observerExited: observer?.exited });
    // No await separates current control validation and the one owned injection.
    faultAttempted = true; event('fault-scheduled', { case: config.case });
    faultScheduled = await windows[0].webContents.executeJavaScript(noticeChainFaultSource(config.case, config.nonce)) === true;
    recordState(); return { scheduled: faultScheduled };
  }
  async function tick() {
    if (busy || closing) return; busy = true;
    try {
      recordState();
      if (Date.now() - fs.statSync(base + '.heartbeat').mtimeMs > 30000) { void close('heartbeat-expired'); return; }
      const file = base + '.request.json'; if (!fs.existsSync(file)) return;
      assert.ok(fs.statSync(file).size <= 16384);
      const request = JSON.parse(fs.readFileSync(file, 'utf8')); if (lastId === request.id) return; lastId = request.id;
      try { const result = await handle(request); if (request.action !== 'close') save('.response.json', { id: request.id, ok: true, result }); }
      catch (error: any) { recordState(); save('.response.json', { id: request.id, ok: false, code: error.code, message: error.message }); }
    } catch (error: any) { save('.failure.json', { message: error.message }); void close('private-channel-failed'); }
    finally { busy = false; }
  }
  try {
    await gate(); await app.whenReady(); identity = await identify(process.pid); save('.boot.json', { nonce: config.nonce, pid: process.pid, identity });
    assert.equal(path.resolve(desktopExecutable()).toLowerCase(), path.join(config.home, 'dist/native/ProfilePilot.Desktop.exe').toLowerCase());
    runtime = new WindowsInputRuntime({ spawn: () => spawnWindowsInputObserver({ executable: path.join(config.home, 'dist/native/ProfilePilot.InputObserver.exe'),
      spawnProcess: ((file: string, args: string[], options: any) => {
        const child = spawn(file, args, options); observer = { child, exited: false, closed: false }; const record = observer; spawnCount++;
        child.once('exit', () => { record.exited = true; event('observer-exit', { pid: child.pid }); });
        child.once('close', () => { record.closed = true; event('observer-close', { pid: child.pid }); }); return child;
      }) as any }) });
    Object.defineProperty(runtime, 'browserGuard', { value: () => { browserFactoryCalls++; throw new Error('Browser subscriptions forbidden in notice chain'); } });
    service = registerDesktop({ inputObserver: runtime.observeDesktop, admission: async target => {
      if (target.pid !== config.target.pid || target.nativeHandle !== config.target.hwnd) return { status: 'unknown', reason: 'not_owned_target', matches: [], gaps: ['owned_target_only'] };
      sameIdentity(await identify(target.pid), config.targetIdentity);
      return { status: 'unmanaged', reason: 'exact_owned_fixture', matches: [], gaps: [] };
    } });
    app.on('will-quit', () => {
      const value = evidence(); let failures: string[] = [];
      try { failures = JSON.parse(fs.readFileSync(base + '.closing.json', 'utf8')).failures; } catch { failures.push('missing-closing-evidence'); }
      save('.closed.json', { ...value, failures, cleanupConfirmed: failures.length === 0 && value.status.session === null
        && value.runtime.stopConfirmed && value.drivers.every((driver: any) => driver.stopConfirmed)
        && windows.every(window => window.isDestroyed()) });
    });
    recordState(); save('.ready.json', evidence());
    timer = setInterval(() => { void tick(); }, 40);
    setTimeout(() => { void close('hard-lifetime-expired'); }, 180000).unref();
  } catch (error: any) { save('.failure.json', { message: error.message, code: error.code }); await close('startup-failed'); }
}

// Imported pure validators never launch Electron or install a hook.
if (process.versions.electron && (process as any).type === 'browser' && process.argv[1]
    && path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase()) {
  void run(process.argv[2]).catch(error => { try { require('electron').app.exit(1); } finally { console.error(error.message); } });
}
