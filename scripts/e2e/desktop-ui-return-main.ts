import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export interface ReturnIdentity { session: string; generation: string; revision: number; }
export function validateReturnIdentity(value: any): asserts value is ReturnIdentity {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['generation', 'revision', 'session']);
  assert.match(value.session, /^[a-zA-Z0-9._:-]{1,100}$/); assert.match(value.generation, /^[a-zA-Z0-9._:-]{1,128}$/);
  assert.ok(Number.isSafeInteger(value.revision) && value.revision >= 0);
}
export function identityFromStatus(status: any): ReturnIdentity {
  const value = { session: status.session?.name, generation: status.inputObservation?.generation, revision: status.session?.revision };
  validateReturnIdentity(value); return value;
}
export function validateUiReturnRequest(value: any, nonce: string, now: number) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.nonce, nonce); assert.match(value.id || '', /^[a-f0-9-]{36}$/);
  assert.ok(['desktop', 'inspect', 'toolbar', 'close'].includes(value.action));
  assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > now && value.expiresAt <= now + 90000);
  const fields = ['id', 'nonce', 'expiresAt', 'action', ...(value.action === 'desktop' ? ['command'] : value.action === 'toolbar' ? ['operation', 'expected', 'webContentsId', 'documentNonce', 'slot'] : [])];
  assert.deepEqual(Object.keys(value).sort(), fields.sort());
  if (value.action === 'desktop') {
    assert.equal(value.command?.action, 'desktop');
    assert.ok(['status', 'windows', 'claim', 'observe', 'release'].includes(value.command.method), 'No private resume/input route');
  }
  if (value.action === 'toolbar') {
    assert.ok(['snapshot', 'save', 'saved-return', 'raw-return', 'current-click', 'takeover', 'stop'].includes(value.operation));
    validateReturnIdentity(value.expected);
    assert.ok(Number.isSafeInteger(value.webContentsId) && value.webContentsId > 0); assert.match(value.documentNonce, /^[a-f0-9-]{36}$/);
    assert.ok(['A', 'B', null].includes(value.slot));
    assert.equal(value.slot !== null, ['save', 'saved-return'].includes(value.operation));
  }
}
export function validateUiReturnToolbar(value: any, facts: any) {
  assert.equal(facts.browserFactoryCalls, 0); assert.deepEqual(facts.runtime.browserPids, []);
  assert.deepEqual(identityFromStatus(facts.status), value.expected);
  assert.equal(facts.status.session.window.pid, facts.target.pid); assert.equal(facts.status.session.window.nativeHandle, facts.target.hwnd);
  assert.equal(facts.toolbar?.webContentsId, value.webContentsId); assert.equal(facts.toolbar.documentNonce, value.documentNonce);
  assert.equal(facts.toolbar.exactOwnedFile, true); assert.equal(facts.toolbar.visible, true); assert.equal(facts.toolbar.destroyed, false);
  if (facts.status.session.state === 'paused') {
    assert.equal(facts.status.inputObservation.phase, 'paused');
    assert.equal(facts.status.inputObservation.reason, 'user_takeover', 'Unexpected pause must stop this scenario');
  }
  if (value.operation === 'takeover') assert.ok(['active', 'paused'].includes(facts.status.session.state));
  else if (value.operation !== 'stop') {
    assert.equal(facts.status.session.state, 'paused'); assert.equal(facts.status.inputObservation.phase, 'paused');
    assert.equal(facts.status.inputObservation.reason, 'user_takeover', 'Unexpected pause must stop this scenario');
  }
}
export function validateUiReturnRejected(before: any, after: any) {
  assert.deepEqual(after.status, before.status); assert.equal(after.status.session.state, 'paused');
  assert.equal(after.status.inputObservation.reason, 'user_takeover'); assert.equal(after.status.inputObservation.phase, 'paused');
  assert.equal(after.spawnCount, before.spawnCount); assert.equal(after.drivers.length, before.drivers.length);
  assert.equal(after.browserFactoryCalls, 0); assert.deepEqual(after.runtime.browserPids, []);
  assert.equal(after.runtime.desktop, null); assert.equal(after.runtime.stopConfirmed, true);
  assert.equal(after.toolbar.webContentsId, before.toolbar.webContentsId); assert.equal(after.toolbar.documentNonce, before.toolbar.documentNonce);
  assert.equal(after.toolbar.destroyed, false); assert.equal(after.toolbar.visible, true);
  assert.ok(after.observers.every((value: any) => value.exited && value.closed));
  assert.ok(after.drivers.filter((value: any) => value.roles.includes('owner')).every((value: any) => value.stopConfirmed));
}
export function uiReturnToolbarSource(operation: string, nonce: string, expected: ReturnIdentity, slot: string | null) {
  validateReturnIdentity(expected); assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.ok(['snapshot', 'save', 'saved-return', 'raw-return', 'current-click', 'takeover', 'stop'].includes(operation));
  assert.ok(['A', 'B', null].includes(slot)); assert.equal(slot !== null, ['save', 'saved-return'].includes(operation));
  const config = JSON.stringify({ operation, expected, slot, key: '__pp_ui_return_' + nonce });
  // Read the production page's already rendered lexical identity. Never fetch
  // current status to repair a stale value, or intercept production events.
  return '(async () => { const config = ' + config + '; try { '
    + 'const button = document.getElementById("return"); const rendered = typeof returnExpectation === "undefined" ? null : JSON.parse(JSON.stringify(returnExpectation)); '
    + 'const view = { identity: rendered, task: document.getElementById("control-task").textContent, state: document.getElementById("control-state").textContent, returnHidden: button.hidden, returnDisabled: button.disabled, error: document.getElementById("control-error").textContent }; '
    + 'const matches = rendered && ["session","generation","revision"].every(key => rendered[key] === config.expected[key]); '
    + 'if (["snapshot","save","current-click"].includes(config.operation) && (!matches || button.hidden || button.disabled)) return { ok: false, reason: "render_not_current", view }; '
    + 'if (config.operation === "snapshot") return { ok: true, view }; '
    + 'if (config.operation === "save") { const saved = window[config.key] || (window[config.key] = Object.create(null)); if (saved[config.slot]) return { ok: false, reason: "already_saved" }; saved[config.slot] = Object.freeze({ ...rendered }); return { ok: true, view, saved: saved[config.slot] }; } '
    + 'if (config.operation === "current-click") { button.click(); const deadline = Date.now() + 60000; while (button.disabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); return { ok: !button.disabled, issued: "production-button-click", handlerSettled: !button.disabled, completedError: document.getElementById("control-error").textContent, view }; } '
    + 'try { let result; if (config.operation === "saved-return") { const saved = window[config.key]?.[config.slot]; if (!saved) return { ok: false, reason: "missing_saved_identity" }; result = await window.desktopControl.control("return", saved); } '
    + 'else if (config.operation === "raw-return") result = await window.desktopControl.control("return"); '
    + 'else result = await window.desktopControl.control(config.operation); return { ok: true, accepted: true, result, view }; '
    + '} catch (error) { return { ok: true, accepted: false, message: error instanceof Error ? error.message : String(error), view }; } '
    + '} catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; } })()';
}

async function run(configFile: string) {
  const { app, BrowserWindow } = require('electron') as typeof import('electron');
  const { registerDesktop } = require('../../src/main/desktop/ipc') as typeof import('../../src/main/desktop/ipc');
  const { desktopExecutable } = require('../../src/main/desktop/worker') as typeof import('../../src/main/desktop/worker');
  const { WindowsInputRuntime } = require('../../src/main/desktop/input-runtime') as typeof import('../../src/main/desktop/input-runtime');
  const { spawnWindowsInputObserver } = require('../../src/main/desktop/input-observer-process') as typeof import('../../src/main/desktop/input-observer-process');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(process.platform, 'win32'); assert.match(config.nonce, /^[a-f0-9]{32}$/); assert.equal(config.sessions.length, 2); assert.notEqual(config.sessions[0], config.sessions[1]);
  assert.equal(path.dirname(path.resolve(configFile)), path.resolve(config.home));
  const base = path.join(config.home, 'main');
  // Only local diagnostics are written. No management server or shared runtime-state.
  process.env.PROFILEPILOT_LOG_ROOT = path.join(config.home, 'logs');
  process.env.CPM_ELECTRON_SMOKE_TEST = '1'; // Do not compete for the real App's stop shortcut.
  app.setPath('userData', path.join(config.home, 'user-data'));
  const exec = promisify(execFile), events: any[] = [], drivers: any[] = [], windows: any[] = [], observers: any[] = [];
  let sequence = 0, service: any, runtime: any, identity: any, observer: any, spawnCount = 0, browserFactoryCalls = 0;
  let lastObservation: any, lastId = '', busy = false, closing: Promise<void> | undefined, timer: any, stateKey = '';
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
    return { nonce: config.nonce, pid: process.pid, identity, scope: 'isolated-registerDesktop-ui-return', status: service?.status(), runtime: runtime?.snapshot(),
      browserFactoryCalls, spawnCount, lastObservation, toolbar: toolbar(), events,
      observers: observers.map(value => ({ pid: value.child.pid, identity: value.identity, exited: value.exited, closed: value.closed })),
      drivers: drivers.map(record => ({ roles: record.roles, pid: record.child?.pid, identity: record.identity, stopConfirmed: record.driver.stopConfirmed, exited: record.exited, closed: record.closed })) };
  }
  function recordState() {
    const status = service?.status(); if (!status) return;
    const value = { session: status.session?.name, revision: status.session?.revision, state: status.session?.state, phase: status.inputObservation.phase, reason: status.inputObservation.reason, generation: status.inputObservation.generation, epoch: status.inputObservation.epoch };
    const key = JSON.stringify(value); if (key !== stateKey) { stateKey = key; event('service-state', value); }
  }
  async function close(reason: string) {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(timer); const failures: string[] = [];
      for (const operation of [() => service?.close(), () => runtime?.dispose()]) try { await operation(); } catch (error: any) { failures.push(error.code || error.message); }
      // Driver/observer stop promises establish exit; retain the original
      // child references until their transport close events also settle.
      for (const record of [...drivers, ...observers]) if (record.child && !record.closed) {
        const closed = await new Promise<boolean>(resolve => {
          const finished = () => { clearTimeout(deadline); resolve(true); };
          const deadline = setTimeout(() => { record.child.removeListener('close', finished); resolve(false); }, 2000);
          record.child.once('close', finished);
          if (record.closed) { record.child.removeListener('close', finished); finished(); }
        });
        if (!closed) failures.push('owned-child-close-unconfirmed');
      }
      // Normal Electron shutdown lets registerDesktop destroy its notice.
      save('.closing.json', { ...evidence(), reason, failures });
      app.quit();
    })(); return closing;
  }
  app.on('browser-window-created', (_event, window: any) => {
    windows.push(window); window.__contentsId = window.webContents.id;
    window.webContents.on('did-finish-load', () => { toolbar(); event('notice-loaded', { webContentsId: window.__contentsId }); });
    window.once('closed', () => { event('notice-closed', { webContentsId: window.__contentsId }); queueMicrotask(() => { if (service) recordState(); }); });
  });
  app.on('window-all-closed', () => {}); // The isolated service owns its lifetime.
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void close('electron-quit'); } });
  process.on('uncaughtException', error => { try { save('.failure.json', { message: error.message }); } finally { void close('uncaught-main-error'); } });
  process.on('unhandledRejection', (error: any) => { try { save('.failure.json', { message: error?.message || String(error) }); } finally { void close('unhandled-main-rejection'); } });
  async function inspect() {
    trackDrivers();
    for (const record of [...drivers, ...observers]) {
      if (!record.child || record.exited) continue;
      const value = await identify(record.child.pid); assert.equal(value.parentPid, process.pid);
      const expectedHash = observers.includes(record) ? config.observerHash : config.desktopHash;
      assert.equal(value.sha256, expectedHash);
      assert.equal(path.dirname(value.executable).toLowerCase(), path.join(os.tmpdir(), 'profilepilot-' + (observers.includes(record) ? 'input-observer' : 'desktop') + '-runtime').toLowerCase());
      if (record.identity) sameIdentity(value, record.identity); else record.identity = value;
    }
    recordState(); return evidence();
  }
  async function handle(request: any) {
    validateUiReturnRequest(request, config.nonce, Date.now());
    if (request.action === 'close') { save('.response.json', { id: request.id, ok: true, closing: true }); void close('owned-request'); return; }
    if (request.action === 'inspect') return inspect();
    if (request.action === 'desktop') {
      if (!['status', 'receipt', 'release'].includes(request.command.method)) await gate();
      if (!['status', 'windows'].includes(request.command.method)) assert.ok(config.sessions.includes(request.command.session));
      const result = await service.execute(request.command);
      if (request.command.method === 'observe') lastObservation = result;
      recordState(); trackDrivers(); return result;
    }
    await gate(); sameIdentity(await identify(config.target.pid), config.targetIdentity);
    await inspect();
    validateUiReturnToolbar(request, { browserFactoryCalls, runtime: runtime.snapshot(), status: service.status(), target: config.target, toolbar: toolbar() });
    event('toolbar-operation', { operation: request.operation, expected: request.expected, slot: request.slot });
    const result = await windows[0].webContents.executeJavaScript(uiReturnToolbarSource(request.operation, config.nonce, request.expected, request.slot));
    recordState(); trackDrivers(); return result;
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
        const child = spawn(file, args, options); observer = { child, exited: false, closed: false }; const record = observer; observers.push(record); spawnCount++;
        child.once('exit', () => { record.exited = true; event('observer-exit', { pid: child.pid }); });
        child.once('close', () => { record.closed = true; event('observer-close', { pid: child.pid }); }); return child;
      }) as any }) });
    Object.defineProperty(runtime, 'browserGuard', { value: () => { browserFactoryCalls++; throw new Error('Browser subscriptions forbidden in UI return acceptance'); } });
    service = registerDesktop({ inputObserver: runtime.observeDesktop, admission: async target => {
      if (target.pid !== config.target.pid || target.nativeHandle !== config.target.hwnd) return { status: 'unknown', reason: 'not_owned_target', matches: [], gaps: ['owned_target_only'] };
      sameIdentity(await identify(target.pid), config.targetIdentity);
      return { status: 'unmanaged', reason: 'exact_owned_fixture', matches: [], gaps: [] };
    } });
    app.on('will-quit', () => {
      const value = evidence(); let failures: string[] = [];
      try { failures = JSON.parse(fs.readFileSync(base + '.closing.json', 'utf8')).failures; } catch { failures.push('missing-closing-evidence'); }
      save('.closed.json', { ...value, failures, cleanupConfirmed: failures.length === 0 && value.status.session === null
        && value.runtime.stopConfirmed && value.drivers.every((driver: any) => driver.stopConfirmed) && value.observers.every((observer: any) => observer.exited && observer.closed)
        && windows.every(window => window.isDestroyed()) });
    });
    recordState(); save('.ready.json', evidence());
    timer = setInterval(() => { void tick(); }, 40);
    setTimeout(() => { void close('hard-lifetime-expired'); }, 300000).unref();
  } catch (error: any) { save('.failure.json', { message: error.message, code: error.code }); await close('startup-failed'); }
}

// Imported pure validators never launch Electron or install a hook.
if (process.versions.electron && (process as any).type === 'browser' && process.argv[1]
    && path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase()) {
  void run(process.argv[2]).catch(error => { try { require('electron').app.exit(1); } finally { console.error(error.message); } });
}
