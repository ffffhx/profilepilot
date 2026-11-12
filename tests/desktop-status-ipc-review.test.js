const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { transformSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const noticeModule = loadCli('src/main/desktop/notice.ts');

const root = path.resolve(__dirname, '..');
const url = name => pathToFileURL(path.join(root, 'public', name)).href;
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = active => ({ available: true, session: active ? { name: 'owned', state: 'active', window: { pid: 123, title: 'Owned fixture' } } : null,
  inputObservation: { available: true, phase: active ? 'ready' : 'idle', ...(active ? { generation: 'g1' } : {}) } });

function ipcFixture(options = {}) {
  const windows = [], notifications = [], requests = new Map(), appEvents = new Map(), logs = [], controls = [], shortcuts = [];
  class Window {
    constructor(options = {}) {
      this.options = options; this.url = options.url || 'about:blank'; this.destroyed = false; this.events = new Map(); this.load = pending();
      this.webContents = { mainFrame: {}, getURL: () => { if (this.failUrl) throw new Error('Frame gone'); return this.url; },
        send: (channel, value) => { if (this.failSend) throw new Error('Renderer gone'); notifications.push({ window: this, channel, value }); },
        setWindowOpenHandler() {}, on: (name, listener) => this.events.set(name, listener) };
      windows.push(this);
    }
    static getAllWindows() { return windows; }
    isDestroyed() { return this.destroyed; }
    hide() { if (this.destroyed || this.failHide) throw new Error('Object has been destroyed'); this.hidden = true; }
    showInactive() { if (this.destroyed) throw new Error('Object has been destroyed'); this.shown = true; this.hidden = false;
      queueMicrotask(() => { void request(this.url, 'notice-ready', { generation: service.value.inputObservation.generation, documentNonce: this.nonce }).catch(() => {}); }); }
    isVisible() { return this.shown === true && !this.hidden; }
    destroy() { if (this.destroyed || this.failDestroy) throw new Error('Object has been destroyed'); this.destroyed = true; this.events.get('closed')?.(); }
    on(name, listener) { this.events.set(name, listener); }
    loadFile(file, options) { this.nonce = options.query.notice; this.url = pathToFileURL(file).href + '?notice=' + this.nonce; return this.load.promise; }
  }
  let service;
  class Service {
    constructor(options) { this.options = options; this.value = status(false); service = this; }
    status() { return this.value; }
    emit(value) { this.value = value; return this.options.onChanged(value); }
    control(action) { controls.push(action); return this.value; }
    noticeUnavailable() { controls.push('notice-unavailable'); return this.value; }
    async resume(expected) { this.lastReturnExpectation = expected; controls.push('resume'); return this.value; }
    async windows() { return { windows: [] }; }
    async preview(id) { return { windowId: id }; }
    close() { this.value = status(false); this.closed = true; if (this.closeThrows) throw this.closeThrows; return this.closeError ? Promise.reject(this.closeError) : Promise.resolve(); }
  }
  const source = transformSync(fs.readFileSync(path.join(root, 'src/main/desktop/ipc.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const container = { exports: {} };
  vm.runInNewContext(source, { module: container, exports: {}, __dirname: path.join(root, 'src/main/desktop'), process: { platform: 'win32', env: {}, pid: 456 },
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, app: { once: (name, listener) => appEvents.set(name, listener), setAccessibilitySupportEnabled() {} },
        ipcMain: { handle: (name, listener) => requests.set(name, listener) }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
        globalShortcut: { register: name => { shortcuts.push('register:' + name); return true; }, unregister: name => shortcuts.push('unregister:' + name) } };
      if (name === './service') return { DesktopService: Service };
      if (name === './notice') return noticeModule;
      if (name === './capture') return { captureDesktopWindow: () => { throw new Error('No captures in a pure IPC test'); } };
      if (name === '../diagnostic-log') return { writeDiagnosticLog: (...args) => { logs.push(args); if (options.logError) throw new Error('Diagnostic writer unavailable'); } };
      if (name === '../../shared/desktop') return { DESKTOP_CHANNEL: 'desktop:request', DESKTOP_CHANGED: 'desktop:changed' };
      if (name === '../workspace-shell') return { isWorkspaceShell(source, directory) { try { return path.resolve(fileURLToPath(source)) === path.join(directory, 'workspace.html'); } catch { return false; } } };
      return require(name);
    }
  });
  container.exports.registerDesktop();
  const request = (source, method, arg, subframe = false) => {
    const mainFrame = { url: source }, sender = windows.find(window => !window.destroyed && window.url.split('?')[0] === source.split('?')[0])?.webContents || { mainFrame };
    sender.mainFrame = mainFrame;
    return requests.get('desktop:request')({ sender, senderFrame: subframe ? { url: source } : mainFrame }, method, arg);
  };
  const prepare = (value = status(true)) => { service.emit(value); const waiting = service.options.prepareControlNotice(new AbortController().signal); void waiting.catch(() => {}); return waiting; };
  return { Window, service, windows, notifications, controls, shortcuts, logs, request, prepare, quit: () => appEvents.get('will-quit')() };
}

test('desktop status broadcast sends only to bundled trusted top-level documents', () => {
  const f = ipcFixture();
  const trusted = ['desktop.html', 'desktop-control.html', 'workspace.html'].map(name => new f.Window({ url: url(name) }));
  for (const source of ['https://example.test/desktop.html', url('index.html'), url('desktop.html') + '/other', 'data:text/html,hello', 'about:blank']) new f.Window({ url: source });
  const dead = new f.Window({ url: url('desktop.html') }); dead.destroyed = true;
  const bad = new f.Window({ url: url('desktop.html') }); bad.failUrl = true;
  f.service.emit(status(false));
  assert.deepEqual(f.notifications.map(item => item.window), trusted);
  assert.ok(f.notifications.every(item => item.channel === 'desktop:changed'));
});

test('one closing renderer cannot prevent other trusted windows receiving a push', () => {
  const f = ipcFixture(), gone = new f.Window({ url: url('desktop.html') }), live = new f.Window({ url: url('workspace.html') });
  gone.failSend = true; assert.doesNotThrow(() => f.service.emit(status(false)));
  assert.deepEqual(f.notifications.map(item => item.window), [live]);
});

test('desktop requests reject untrusted URLs and subframes even when the subframe URL is bundled', async () => {
  const f = ipcFixture();
  for (const source of ['https://example.test/workspace.html', url('index.html'), 'about:blank']) await assert.rejects(f.request(source, 'status'), /本地工作区/);
  for (const page of ['desktop.html', 'desktop-control.html', 'workspace.html']) {
    if (page === 'desktop-control.html') await assert.rejects(f.request(url(page), 'status'), /已失效/);
    else assert.equal((await f.request(url(page), 'status')).session, null);
    await assert.rejects(f.request(url(page), 'status', undefined, true), /本地工作区/);
  }
});

test('workspace IPC refuses an unbound return that could apply to an unseen successor', async () => {
  const f = ipcFixture(); f.service.emit({ ...status(true), session: { name: 'successor', state: 'paused', window: { pid: 123, title: 'Successor' } } });
  await assert.rejects(f.request(url('workspace.html'), 'control', 'return'));
  assert.deepEqual(f.controls, []);
});

test('the toolbar cannot enumerate or preview windows; its validated return command uses asynchronous resume', async () => {
  const f = ipcFixture(), prepared = f.prepare(); f.windows.at(-1).load.resolve(); await prepared;
  for (const method of ['windows', 'preview']) await assert.rejects(f.request(url('desktop-control.html'), method, 'a'.repeat(32)), /控制条/);
  await assert.rejects(f.request(url('desktop-control.html'), 'control', 'claim'));
  const expected = { session: 'owned', generation: 'g1', revision: 0 };
  await f.request(url('desktop-control.html'), 'control', { action: 'return', ...expected }); assert.deepEqual(f.controls, ['resume']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.service.lastReturnExpectation)), expected);
});

test('return IPC validates a bounded complete identity while revocation remains immediate', async () => {
  const f = ipcFixture(), expected = { action: 'return', session: 'owned', generation: 'g1', revision: 2 };
  for (const value of [null, {}, 'return', { ...expected, session: '' }, { ...expected, generation: '' },
    { ...expected, revision: undefined }, { ...expected, revision: -1 }, { ...expected, revision: 0.5 },
    { ...expected, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...expected, extra: true }])
    await assert.rejects(f.request(url('workspace.html'), 'control', value));
  assert.deepEqual(f.controls, []);
  await f.request(url('workspace.html'), 'control', 'takeover'); await f.request(url('workspace.html'), 'control', 'stop');
  assert.deepEqual(f.controls, ['takeover', 'stop']);
  await f.request(url('workspace.html'), 'control', expected);
  assert.deepEqual(JSON.parse(JSON.stringify(f.service.lastReturnExpectation)), { session: 'owned', generation: 'g1', revision: 2 });
});

test('normal shutdown suppresses pushes, destroys the notice, unregisters the shortcut and records asynchronous driver-close failure', async () => {
  const f = ipcFixture(); f.prepare(); const notice = f.windows.at(-1);
  f.service.closeError = new Error('driver shutdown unknown'); f.quit();
  const before = f.notifications.length; f.service.emit(status(true)); notice.load.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notifications.length, before); assert.equal(notice.destroyed, true);
  assert.ok(f.shortcuts.includes('unregister:Control+Alt+Escape')); assert.equal(f.logs[0][2], 'desktop.shutdown.unconfirmed');
});

test('an already destroyed notice cannot throw from no-session update or skip quit shortcut cleanup', () => {
  const f = ipcFixture(); f.prepare(); const notice = f.windows.at(-1); notice.destroyed = true;
  assert.doesNotThrow(() => f.service.emit(status(false)));
  assert.doesNotThrow(() => f.quit());
  assert.equal(f.shortcuts.includes('unregister:Control+Alt+Escape'), true);
});

test('hide and destroy races are contained and quit still unregisters the stop shortcut', () => {
  const f = ipcFixture(); f.prepare(); const notice = f.windows.at(-1);
  notice.failHide = true; notice.failDestroy = true; assert.doesNotThrow(() => f.service.emit(status(false)));
  assert.doesNotThrow(() => f.quit());
  assert.equal(f.shortcuts.includes('unregister:Control+Alt+Escape'), true); assert.ok(f.logs.length >= 2);
});

test('synchronous service-close and diagnostic failures cannot interrupt notice or shortcut cleanup', () => {
  const f = ipcFixture({ logError: true }); f.prepare(); const notice = f.windows.at(-1);
  f.service.closeThrows = new Error('Synchronous close failure'); notice.failDestroy = true;
  assert.doesNotThrow(() => f.quit()); assert.equal(f.shortcuts.includes('unregister:Control+Alt+Escape'), true);
  assert.equal(f.logs.length, 2, 'Both independent failures must reach the best-effort diagnostic writer');
});

test('a replaced notice cannot be shown or pause a later owner from its delayed load callbacks', async () => {
  for (const fail of [false, true]) {
    const f = ipcFixture(); f.prepare(); const old = f.windows.at(-1); old.destroy();
    const value = status(true); value.inputObservation.generation = 'g2'; f.prepare(value);
    const before = [...f.controls], current = f.windows.at(-1); assert.notEqual(current, old);
    if (fail) old.load.reject(new Error('stale load')); else old.load.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(old.shown, undefined); assert.equal(current.shown, undefined); assert.deepEqual(f.controls, before);
    current.load.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(current.shown, true);
  }
});

function frameFixture(workspace = 'desktop', owned = true) {
  const { workspaceRoute } = loadCli('src/shared/workspaces.ts');
  const events = [], listeners = new Map(); let notify, removed = 0, subscribed = 0;
  const parent = { location: { href: url('workspace.html') }, workspaceHost: { owns: () => owned } };
  for (const name of ['profileManager', 'browserConnection', 'tasks', 'localApps', 'phones', 'mobile', 'gpuiControl']) parent[name] = {};
  parent.desktopControl = { status: async () => status(false), onChanged(listener) { subscribed++; notify = listener; return () => { removed++; }; } };
  const window = { parent, addEventListener: (name, listener) => listeners.set(name, listener) };
  const document = { hidden: true, documentElement: { classList: { add() {} }, dataset: {} },
    dispatchEvent: event => { events.push(event.type); return true; }, addEventListener() {} };
  const source = transformSync(fs.readFileSync(path.join(root, 'src/renderer/workspace-frame.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  vm.runInNewContext(source, { window, document, location: { href: url(workspace === 'desktop' ? 'desktop.html' : 'index.html') },
    CustomEvent: class { constructor(type) { this.type = type; } }, require(name) { return name.endsWith('workspaces') ? { workspaceRoute } : {}; } });
  return { window, events, notify: state => notify?.(state), get removed() { return removed; }, get subscribed() { return subscribed; } };
}

test('workspace bridge forwards immediately to the active desktop pane even when document.hidden is true', () => {
  const f = frameFixture(), seen = []; f.window.workspacePane.setActive(true); f.window.desktopControl.onChanged(value => seen.push(value));
  f.notify('ready'); f.notify('paused'); assert.deepEqual(seen, ['ready', 'paused']);
});

test('inactive desktop pane coalesces the latest status and flushes it before the visibility refresh', () => {
  const f = frameFixture(), seen = []; f.window.desktopControl.onChanged(value => { seen.push(value); f.events.push('callback:' + value); });
  f.notify('ready'); f.notify('paused'); assert.deepEqual(seen, []);
  f.window.workspacePane.setActive(true); assert.deepEqual(seen, ['paused']);
  assert.deepEqual(f.events.slice(-2), ['callback:paused', 'workspace-visibilitychange']);
  f.window.workspacePane.setActive(false); f.notify('idle'); f.window.workspacePane.dispose(); f.window.workspacePane.setActive(true);
  assert.deepEqual(seen, ['paused']); assert.equal(f.removed, 1);
});

test('a different workspace cannot subscribe to desktop status and an unowned frame receives no bridge', async () => {
  const other = frameFixture('browser'); other.window.desktopControl.onChanged(() => {}); assert.equal(other.subscribed, 0);
  await assert.rejects(other.window.desktopControl.status());
  assert.equal(frameFixture('desktop', false).window.desktopControl, undefined);
});
