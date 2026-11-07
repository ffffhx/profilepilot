const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { transformSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { DesktopControlNotice } = loadCli('src/main/desktop/notice.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const root = path.resolve(__dirname, '..'), target = { id: 'a'.repeat(32), title: 'Owned fake', pid: 12, process: 'fake', className: 'Fake' };
const other = { ...target, id: 'b'.repeat(32), pid: 34 };
const ipcSource = transformSync(fs.readFileSync(path.join(root, 'src/main/desktop/ipc.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Actual IPC + notice lifecycle + DesktopService. Every Electron object,
// driver, observer and time source is injected; no OS/UI/native helper is used.
function fixture(mode = {}) {
  const windows = [], drivers = [], arms = [], logs = [], events = new Map(), handlers = new Map();
  let service, desktop, onPause, now = 100, constructions = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); constructions++; if (mode.construct) throw new Error('Construct failed');
      this.options = options;
      this.destroyed = false; this.visible = false; this.shows = 0; this.destroys = 0; this.load = deferred(); this.url = 'about:blank';
      this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {},
        getURL: () => this.url, send() { mode.broadcast?.(service); }, setWindowOpenHandler() { if (mode.configure) throw new Error('Configure failed'); } });
      windows.push(this);
    }
    static getAllWindows() { return windows; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.shows++; if (mode.show === 'throw') throw new Error('Show failed'); this.visible = mode.show !== 'invisible';
      if (mode.autoReady !== false) queueMicrotask(() => { void ready(this).catch(() => {}); }); }
    hide() { if (mode.hide) throw new Error('Hide failed'); this.visible = false; }
    destroy() { this.destroys++; if (mode.destroy === 'throw') throw new Error('Destroy failed'); if (mode.destroy !== 'pending') this.confirmDestroyed(); }
    confirmDestroyed() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    loadFile(file, options) { if (mode.load) throw new Error('Synchronous load failed'); this.nonce = options.query.notice; this.url = pathToFileURL(file).href + '?notice=' + this.nonce; if (mode.autoLoad) this.load.resolve(); return this.load.promise; }
  }
  const container = { exports: {} };
  vm.runInNewContext(ipcSource, { module: container, exports: {}, __dirname: path.join(root, 'src/main/desktop'), process: { platform: 'win32', env: {}, pid: 456 },
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, app: { once: (event, callback) => events.set(event, callback), setAccessibilitySupportEnabled() {} },
        ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
        globalShortcut: { register: () => false, unregister() {} } };
      if (name === './notice') return { DesktopControlNotice: class extends DesktopControlNotice { constructor(options) { super({ ...options, timeoutMs: mode.timeoutMs || 2000 }); } } };
      if (name === './service') return { DesktopService: class { constructor(options) {
        service = new DesktopService({ ...options, platform: 'win32', available: () => true, now: () => now,
          inputObserver: callback => { onPause = callback; return {
            async arm(generation, marker) { arms.push({ generation, marker }); desktop = { phase: 'ready', generation, epoch: 'fake' }; return { ...desktop }; },
            snapshot: () => ({ connected: true, epoch: 'fake', desktop }), disarm() { desktop = null; }, detach() {}
          }; },
          driver() { const driver = { inputMarker: (drivers.length + 1).toString(16), closed: false, actions: 0,
            close() { this.closed = true; }, async request(operation) {
              if (operation === 'windows') return { windows: [target, other] };
              if (operation === 'window.action') { this.actions++; mode.afterAction?.(); return { executed: true }; }
              return { windowId: target.id, version: 'c'.repeat(32), elements: [], image: null };
            } }; drivers.push(driver); return driver; }
        }); return service;
      } } };
      if (name === './capture') return {};
      if (name === '../diagnostic-log') return { writeDiagnosticLog: (...args) => logs.push(args) };
      if (name === '../../shared/desktop') return { DESKTOP_CHANNEL: 'desktop:request', DESKTOP_CHANGED: 'desktop:changed' };
      if (name === '../workspace-shell') return { isWorkspaceShell: () => false };
      return require(name);
    }
  });
  container.exports.registerDesktop();
  const request = (window, method, arg) => {
    const frame = window.webContents.mainFrame = { url: window.url };
    return handlers.get('desktop:request')({ sender: window.webContents, senderFrame: frame }, method, arg);
  };
  const ready = (window, generation = service.status().inputObservation.generation, nonce = window.nonce) => request(window, 'notice-ready', { generation, documentNonce: nonce });
  const command = (method, extras = {}) => service.execute({ action: 'desktop', method, session: 'notice-test', ...extras });
  return { mode, service, windows, drivers, arms, logs, get constructions() { return constructions; }, advance: milliseconds => { now += milliseconds; },
    command, claim: () => command('claim', { windowId: target.id }), action: () => command('action', { requestId: randomUUID(), params: { version: 'c'.repeat(32), ref: 'e1', kind: 'invoke' } }),
    pause: () => onPause({ epoch: 'fake', generation: desktop.generation, reason: 'physical_input', certainty: 'observed' }),
    request, ready, toolbar: (window, action = 'return') => request(window, 'control', action),
    async close() { await service.close(); events.get('will-quit')?.(); }
  };
}

test('first claim does not ARM until load, show and visible evidence; idle only hides the ready notice', async () => {
  const f = fixture();
  try {
    const claim = f.claim(); await turn(); assert.equal(f.arms.length, 0); assert.equal(f.service.status().inputObservation.phase, 'arming');
    assert.equal(f.windows[0].options.webPreferences.backgroundThrottling, false);
    assert.equal(f.windows[0].shows, 0); f.windows[0].load.resolve(); await claim;
    assert.equal(f.arms.length, 1); assert.equal(f.service.status().session.state, 'active'); assert.equal(f.windows[0].visible, true);
    await f.command('complete'); assert.equal(f.windows[0].visible, false); assert.equal(f.windows[0].destroyed, false);
    await assert.rejects(f.toolbar(f.windows[0]), /已失效/);
  } finally { await f.close(); }
});

for (const failure of ['construct', 'configure', 'load', 'show-throw', 'show-invisible', 'async-load']) test('notice failure is bounded, pauses once and never ARM: ' + failure, async () => {
  const mode = { autoLoad: true, [failure]: true };
  if (failure.startsWith('show-')) mode.show = failure.slice(5);
  if (failure === 'async-load') mode.autoLoad = false;
  const f = fixture(mode);
  try {
    const rejected = assert.rejects(f.claim(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    if (failure === 'async-load') { await turn(); f.windows[0].load.reject(new Error('Load failed')); }
    await rejected;
    const state = f.service.status(); assert.equal(state.session.state, 'paused'); assert.equal(state.inputObservation.phase, 'paused');
    assert.equal(state.inputObservation.reason, 'notice_unavailable'); assert.equal(state.inputObservation.certainty, 'unknown');
    assert.equal(f.arms.length, 0); assert.equal(f.drivers[1].closed, true); assert.equal(f.constructions, 1);
    for (let i = 0; i < 5; i++) f.service.noticeUnavailable(); assert.equal(f.constructions, 1); assert.deepEqual(f.service.status(), state);
  } finally { await f.close(); }
});

test('load timeout cannot authorize input, and a late load cannot affect explicit new-generation recovery', async () => {
  const f = fixture({ timeoutMs: 20 });
  try {
    await assert.rejects(f.claim(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' }); const old = f.windows[0];
    assert.equal(f.arms.length, 0); assert.equal(old.destroyed, true);
    f.mode.autoLoad = true; await f.service.resume(); assert.equal(f.arms.length, 1); const current = f.windows[1];
    old.load.resolve(); old.emit('unresponsive'); await turn();
    assert.equal(f.service.status().session.state, 'active'); assert.equal(current.destroyed, false); assert.equal(old.shows, 0);
    await assert.rejects(f.toolbar(old), /已失效/);
  } finally { await f.close(); }
});

for (const cancellation of ['takeover', 'stop', 'expire', 'close']) test('pending UI preparation cancels promptly and never ARM after ' + cancellation, async () => {
  const f = fixture();
  try {
    const claim = assert.rejects(f.claim(), { code: 'DESKTOP_USER_IN_CONTROL' }); await turn(); const window = f.windows[0];
    if (cancellation === 'expire') { f.advance(300001); f.service.status(); }
    else if (cancellation === 'close') await f.service.close();
    else f.service.control(cancellation);
    await claim; assert.equal(f.service.busy, false); assert.equal(f.arms.length, 0);
    window.load.resolve(); await turn(); assert.equal(f.arms.length, 0); assert.equal(window.destroyed, true);
    if (cancellation === 'takeover') { assert.equal(f.service.status().inputObservation.reason, 'user_takeover'); f.mode.autoLoad = true; await f.service.resume(); assert.equal(f.arms.length, 1); }
    else assert.equal(f.service.status().session, null);
  } finally { await f.close(); }
});

for (const destroy of ['throw', 'pending']) test('unconfirmed destroy prevents a replacement and revokes old toolbar authority: ' + destroy, async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); const old = f.windows[0]; f.mode.destroy = destroy; old.emit('unresponsive');
    assert.equal(f.service.status().session.state, 'paused'); await assert.rejects(f.toolbar(old), /已失效/);
    await assert.rejects(f.service.resume(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' }); assert.equal(f.constructions, 1); assert.equal(f.arms.length, 1);
    old.confirmDestroyed(); f.mode.destroy = undefined; await f.service.resume(); assert.equal(f.constructions, 2); assert.equal(f.arms.length, 2);
    await assert.rejects(f.toolbar(old), /已失效/);
  } finally { f.mode.destroy = undefined; await f.close(); }
});

test('show failure during an executed action notification preserves its successful receipt and pauses control', async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); f.mode.afterAction = () => { f.mode.show = 'throw'; };
    const request = { action: 'desktop', method: 'action', session: 'notice-test', requestId: randomUUID(), params: { kind: 'invoke', ref: 'e1', version: 'c'.repeat(32) } };
    const result = await f.service.execute(request); assert.equal(result.executed, true); assert.equal(result.requiresObservation, true);
    assert.equal(f.service.status().inputObservation.reason, 'notice_unavailable'); assert.deepEqual(await f.service.execute(request), result);
    assert.equal(f.drivers.reduce((count, driver) => count + driver.actions, 0), 1);
  } finally { await f.close(); }
});

test('failed UI notifications cannot replace a prior physical pause or renew its lease; explicit close remains user takeover', async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); const window = f.windows[0]; let prevented = false;
    window.emit('close', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    assert.equal(f.service.status().inputObservation.reason, 'user_takeover'); assert.equal(window.visible, false);
    await f.service.resume(); f.pause(); const paused = f.service.status(); f.advance(1000);
    window.emit('unresponsive'); assert.deepEqual(f.service.status(), paused);
  } finally { await f.close(); }
});

test('select prepares the existing ready UI for the new generation before observer rearm', async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); f.mode.show = 'invisible';
    await assert.rejects(f.command('select', { windowId: other.id }), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    assert.equal(f.arms.length, 1); assert.equal(f.service.status().session.window.id, other.id); assert.equal(f.service.status().session.state, 'paused');
  } finally { await f.close(); }
});

test('notice unavailable code has recoverable CLI classification', async () => {
  let output = '';
  assert.equal(await runDesktopCli(['claim', '--session', 'notice-test', '--window', target.id], async () => ({ ok: false,
    error: { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE', message: '提示条不可用' } }), { stdout: { write(value) { output += value; } }, stderr: { write() {} } }), 75);
  assert.equal(JSON.parse(output).code, 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE');
});

for (const order of ['load-first', 'ack-first']) test('notice requires both load and matching rendered-state ACK: ' + order, async () => {
  const f = fixture({ autoReady: false });
  try {
    const claim = f.claim(); await turn(); const window = f.windows[0];
    await assert.rejects(f.ready(window, 'stale-generation'), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    await assert.rejects(f.ready(window, undefined, randomUUID()), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    if (order === 'load-first') { window.load.resolve(); await turn(); assert.equal(window.visible, true); }
    else await f.ready(window);
    assert.equal(f.arms.length, 0); assert.equal(f.service.status().inputObservation.phase, 'arming');
    if (order === 'load-first') await f.ready(window); else window.load.resolve();
    await claim; assert.equal(f.arms.length, 1);
  } finally { await f.close(); }
});

test('fulfilled load with missing or nonfunctional page script times out without ARM', async () => {
  const f = fixture({ autoLoad: true, autoReady: false, timeoutMs: 20 });
  try {
    await assert.rejects(f.claim(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    assert.equal(f.arms.length, 0); assert.equal(f.windows[0].destroyed, true);
    assert.equal(f.service.status().inputObservation.reason, 'notice_unavailable');
  } finally { await f.close(); }
});

for (const action of ['stop', 'takeover']) test('visible loading toolbar can cancel pending readiness through IPC: ' + action, async () => {
  const f = fixture({ autoLoad: true, autoReady: false });
  try {
    const claim = assert.rejects(f.claim(), { code: 'DESKTOP_USER_IN_CONTROL' }); await turn(); const window = f.windows[0];
    assert.equal(window.visible, true); await assert.rejects(f.toolbar(window, 'return'), /已失效/);
    await f.toolbar(window, action); await claim; assert.equal(f.arms.length, 0); assert.equal(f.service.busy, false);
    await assert.rejects(f.ready(window), /已失效/);
    if (action === 'takeover') assert.equal(f.service.status().inputObservation.reason, 'user_takeover');
    else assert.equal(f.service.status().session, null);
  } finally { await f.close(); }
});

for (const event of ['pagehide', 'script-error', 'navigation']) test('document invalidation revokes a late readiness ACK: ' + event, async () => {
  const f = fixture({ autoLoad: true, autoReady: false });
  try {
    const claim = assert.rejects(f.claim(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' }); await turn(); const window = f.windows[0];
    if (event === 'navigation') window.webContents.emit('did-start-navigation', {}, window.url, false, true);
    else await f.request(window, 'notice-unavailable', { documentNonce: window.nonce });
    await claim; await assert.rejects(f.ready(window), /已失效/); assert.equal(f.arms.length, 0);
  } finally { await f.close(); }
});

test('reuse requires a new rendered generation; prior ACK cannot authorize resume, and new generation has its own deadline', async () => {
  const f = fixture({ autoLoad: true, timeoutMs: 30 });
  try {
    await f.claim(); const window = f.windows[0], old = f.service.status().inputObservation.generation;
    f.service.control('takeover'); f.mode.autoReady = false;
    const resume = f.service.resume(); await turn(); assert.equal(f.constructions, 1); assert.equal(f.arms.length, 1);
    await assert.rejects(f.ready(window, old), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    await f.ready(window); await resume; assert.equal(f.arms.length, 2);
    f.service.control('takeover'); await assert.rejects(f.service.resume(), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    assert.equal(f.arms.length, 2); assert.equal(window.destroyed, true);
  } finally { await f.close(); }
});

test('a hidden idle document fault is retired before another owner can reuse its old readiness', async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); const window = f.windows[0]; await f.command('complete');
    await f.request(window, 'notice-unavailable', { documentNonce: window.nonce }); assert.equal(window.destroyed, true);
    await f.service.execute({ action: 'desktop', method: 'claim', session: 'successor', windowId: target.id });
    assert.equal(f.constructions, 2); assert.equal(f.arms.length, 2);
  } finally { await f.close(); }
});

test('retired document failure and readiness cannot revoke or reactivate a successor', async () => {
  const f = fixture({ autoLoad: true });
  try {
    await f.claim(); const old = f.windows[0];
    await f.request(old, 'notice-unavailable', { documentNonce: old.nonce });
    assert.equal(f.service.status().session.state, 'paused');
    await f.service.resume(); const current = f.windows[1], active = f.service.status();
    await assert.rejects(f.request(old, 'notice-unavailable', { documentNonce: old.nonce }), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    await assert.rejects(f.request(current, 'notice-unavailable', { documentNonce: old.nonce }), { code: 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' });
    await assert.rejects(f.ready(old), /已失效/);
    assert.deepEqual(f.service.status(), active); assert.equal(current.destroyed, false); assert.equal(f.arms.length, 2);
  } finally { await f.close(); }
});
