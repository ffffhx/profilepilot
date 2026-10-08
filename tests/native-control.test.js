const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const build = process.env.PP_CONTROL_BUILD || path.resolve('dist');
const { NativeBrowserBridge } = require(path.join(build, 'main/tasks/native-bridge'));
const { NativeControlService } = require(path.join(build, 'main/native-control/service'));
const { requestNativeControl } = require(path.join(build, 'main/native-control/cli'));
const { NATIVE_REQUIRED_CAPABILITIES } = require(path.join(build, 'main/tasks/native-compatibility'));

async function worker() {
  const { webcrypto } = await import('node:crypto');
  const calls = [], messages = [], downloads = new Map(); let socket, runtimeListener, next = 50;
  const tabs = new Map([[7, { id: 7, windowId: 1, active: true, url: 'https://fixture.test', title: 'fixture' }], [8, { id: 8, windowId: 1, active: false, url: 'https://second.test' }], [9, { id: 9, incognito: true, url: 'https://private.test' }]]);
  const event = () => ({ addListener(fn) { this.fire = fn; } });
  const area = () => ({ data: {}, async get(key) { return { [key]: this.data[key] }; }, async set(value) { Object.assign(this.data, value); }, async remove(keys) { for (const key of [].concat(keys)) delete this.data[key]; } });
  class Socket {
    static OPEN = 1; readyState = 0; listeners = {};
    constructor() { socket = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.listeners.open?.(); this.receive({ type: 'welcome' }); }); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    send(text) { messages.push(JSON.parse(text)); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const chrome = {
    runtime: { id: 'fixture', getURL: f => `chrome-extension://fixture/${f}`, getManifest: () => ({ version: '0.2.0' }), reload: () => calls.push('reload'), onMessage: { addListener(fn) { runtimeListener = fn; } }, onInstalled: event(), onStartup: event() },
    storage: { local: area(), session: area(), onChanged: event() }, alarms: { onAlarm: event(), create: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { get: async id => { if (!tabs.has(id)) throw Error('missing'); return { ...tabs.get(id) }; }, query: async q => [...tabs.values()].filter(t => !q.active || t.active), create: async p => { const tab = { id: next++, windowId: 1, ...p }; tabs.set(tab.id, tab); return tab; }, update: async (id, p) => { calls.push(['update', id, p]); Object.assign(tabs.get(id), p); return tabs.get(id); }, remove: async id => { tabs.delete(id); chrome.tabs.onRemoved.fire(id); }, onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event() },
    windows: { get: async () => ({ state: 'minimized' }), update: async () => calls.push('focus') },
    history: { search: async p => { calls.push(['history', p]); return [{ id: 'history-1', url: 'https://fixture.test', lastVisitTime: 200 }]; } },
    debugger: { attach: async target => calls.push(['attach', target]), detach: async target => calls.push(['detach', target]), sendCommand: async (target, method, params) => { calls.push([method, target, params]); return { method }; }, onEvent: event(), onDetach: event() },
    downloads: { download: async p => { const id = next++; downloads.set(id, { id, state: 'in_progress', filename: '/downloads/report.csv', url: p.url, bytesReceived: 0, totalBytes: 5 }); return id; }, search: async p => downloads.has(p.id) ? [{ ...downloads.get(p.id) }] : [], cancel: async id => { downloads.get(id).state = 'interrupted'; }, onCreated: event(), onChanged: event() },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: event() }, sidePanel: { open: async () => {} },
    scripting: { executeScript: async () => [{ result: 'selected text' }] }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, WebSocket: Socket, URL, atob, fetch, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync('extensions/profilepilot/background.js', 'utf8') + '\nglobalThis.api={handle,state,connectTest:()=>{config={port:12345,profileId:"native:fixture",token:"fixture"};return connect();}};', context);
  await new Promise(r => setImmediate(r));
  await context.api.connectTest();
  return { ...context.api, calls, messages, downloads, tabs, chrome, socket, close: () => socket.close(), ui: value => new Promise(resolve => runtimeListener(value, { id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html' }, resolve)) };
}

test('full-access existing tabs, background/minimized pointer, history and OOPIF event routing', async t => {
  const w = await worker(); t.after(w.close);
  assert.deepEqual(Array.from(await w.handle('tabs', {}), t => t.id), ['7', '8']);
  await w.handle('claim', { sessionId: 'one', tabId: 8 });
  await w.handle('preparePointer', { sessionId: 'one' });
  assert.equal(w.calls.some(c => c === 'focus' || c[0] === 'update'), false);
  await w.handle('cdp', { sessionId: 'one', method: 'Network.enable' });
  w.chrome.debugger.onEvent.fire({ tabId: 8 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
  await w.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate', cdpSessionId: 'child', params: { expression: 'document.title' } });
  assert.equal(w.calls.at(-1)[1].sessionId, 'child');
  w.chrome.debugger.onEvent.fire({ tabId: 8, sessionId: 'child' }, 'Runtime.consoleAPICalled', { type: 'log' });
  assert.equal(w.messages.at(-1).cdpSessionId, 'child');
  assert.equal(w.messages.at(-1).sessionId, 'one');
  await w.handle('history', { sessionId: 'one', query: 'fixture', startTime: 100, endTime: 500, maxResults: 3 });
  assert.equal(w.calls.at(-1)[1].maxResults, 3);
  await assert.rejects(w.handle('history', { sessionId: 'two' }), /占用/);
  await assert.rejects(w.handle('history', { sessionId: 'one', maxResults: -1 }), /无效/);
  await w.handle('switch', { sessionId: 'one', tabId: 7 });
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Runtime.enable', cdpSessionId: 'child' }), /失效/);
  await assert.rejects(w.handle('extension.reload', {}), /任务/);
  await w.handle('control', { sessionId: 'one', action: 'handoff' });
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Input.insertText' }), /用户正在/);
  await assert.rejects(w.handle('claim', { sessionId: 'other' }), /另一个/);
});

test('protocol errors do not revoke control, user stop invalidates queued operations', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one' });
  w.chrome.debugger.sendCommand = async () => { throw Error('Method not found'); };
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Browser.getVersion' }), /Method/);
  assert.equal((await w.state()).ownership, 'agent');
  let release; const blocked = new Promise(r => { release = r; });
  w.chrome.debugger.sendCommand = async (_target, method) => { if (method === 'Runtime.evaluate') await blocked; w.calls.push(method); return {}; };
  w.socket.receive({ id: 1, method: 'cdp', params: { sessionId: 'one', method: 'Runtime.evaluate' } });
  await new Promise(r => setImmediate(r));
  w.socket.receive({ id: 2, method: 'cdp', params: { sessionId: 'one', method: 'Input.insertText' } });
  await w.ui({ method: 'takeover' }); release();
  await new Promise(r => setImmediate(r));
  assert.equal(w.calls.includes('Input.insertText'), false);
  assert.match(w.messages.find(m => m.id === 2).error, /取消/);
});

test('claim picks active tab in last focused window; explicit target and newTab override it', async t => {
  const w = await worker(); t.after(w.close);
  w.tabs.get(8).active = true; w.tabs.get(8).windowId = 2;
  w.chrome.tabs.query = async q => q.lastFocusedWindow ? [w.tabs.get(8)] : [...w.tabs.values()];
  await w.handle('claim', { sessionId: 'one' }); assert.equal((await w.state()).tabId, 8);
  await w.handle('control', { sessionId: 'one', action: 'release' });
  await w.handle('claim', { sessionId: 'two', tabId: 7 }); assert.equal((await w.state()).tabId, 7);
  await w.handle('control', { sessionId: 'two', action: 'release' });
  await w.handle('claim', { sessionId: 'three', newTab: true });
  assert.equal(w.tabs.get((await w.state()).tabId).url, 'about:blank');
});

test('downloads are ID-scoped, concurrent waits can be cancelled and takeover stops waiting', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one' });
  const first = await w.handle('downloads.start', { sessionId: 'one', url: 'https://fixture.test/report.csv' });
  const second = await w.handle('downloads.start', { sessionId: 'one', url: 'https://fixture.test/report.csv' });
  assert.notEqual(first.id, second.id);
  await assert.rejects(w.handle('downloads.search', { sessionId: 'one', id: 999 }), /不属于/);
  const waiting = w.handle('downloads.wait', { sessionId: 'one', id: first.id, timeoutMs: 2000 });
  await w.handle('downloads.cancel', { sessionId: 'one', id: first.id });
  assert.equal((await waiting).state, 'interrupted');
  const takeover = assert.rejects(w.handle('downloads.wait', { sessionId: 'one', id: second.id, timeoutMs: 2000 }), /用户正在/);
  await w.handle('control', { sessionId: 'one', action: 'handoff' }); await takeover;
  await w.handle('control', { sessionId: 'one', action: 'release' });
  await w.handle('claim', { sessionId: 'two' });
  await assert.rejects(w.handle('downloads.search', { sessionId: 'two', id: second.id }), /不属于/);
});

test('download arms require matching page events and reject ambiguous same-URL creations', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one' });
  const { token } = await w.handle('downloads.arm', { sessionId: 'one', frameId: 'frame' });
  w.chrome.debugger.onEvent.fire({ tabId: 7 }, 'Page.downloadWillBegin', { guid: 'guid', frameId: 'frame', url: 'https://fixture.test/file' });
  for (const id of [20, 21]) w.chrome.downloads.onCreated.fire({ id, url: 'https://fixture.test/file' });
  await assert.rejects(w.handle('downloads.wait', { sessionId: 'one', token }), /多个下载/);
  await w.handle('downloads.disarm', { sessionId: 'one', token });
  await assert.rejects(w.handle('downloads.wait', { sessionId: 'one', token }), /失效/);
});

test('temporary installation cannot reload and needs an explicit persistent-install confirmation', async t => {
  const w = await worker(); t.after(w.close);
  w.chrome.storage.onChanged.fire({ profilepilotInstallation: { newValue: { mode: 'temporary' } } }, 'local');
  assert.equal((await w.state()).installationMode, 'temporary');
  await assert.rejects(w.handle('extension.reload', {}), /临时安装/);
  assert.equal(w.calls.includes('reload'), false);
  assert.match((await w.ui({ method: 'confirmPersistentInstallation' })).error, /确认/);
  assert.equal((await w.state()).installationMode, 'temporary');
  assert.equal((await w.ui({ method: 'confirmPersistentInstallation', confirmed: true })).error, undefined);
  assert.equal((await w.state()).installationMode, undefined);
});

test('side panel forwards pinned taskId and receives complete UI response', async t => {
  const w = await worker(); t.after(w.close);
  const result = w.ui({ method: 'getUiState', taskId: 'pinned-task' });
  await new Promise(r => setImmediate(r));
  const command = w.messages.find(m => m.type === 'ui');
  assert.equal(command.params.taskId, 'pinned-task');
  w.socket.receive({ type: 'ui-result', id: command.id, result: { task: { id: 'pinned-task' }, events: [{ kind: 'user', text: 'hello' }] } });
  const response = await result;
  assert.equal(response.result.task.id, 'pinned-task'); assert.equal(response.result.currentTab.id, 7);
  assert.equal(response.result.events[0].text, 'hello');
});

test('direct claim rejects legacy advertisements before reserving or sending a command', async t => {
  const state = { profileId: 'native:fixture', connected: true, ownership: 'user', taskTabs: true };
  const calls = [];
  const bridge = { states: () => [state], onEvent: () => () => {}, request: async (_profile, method) => { calls.push(method); return {}; } };
  const service = new NativeControlService(bridge, os.tmpdir()); t.after(() => service.close());
  const command = { requestId: 'legacy-claim', method: 'claim', sessionId: 'direct' };
  const updateRequired = error => error.code === 'NATIVE_EXTENSION_UPDATE_REQUIRED' && /更新或重新加载.*0\.2\.0/.test(error.message);
  await assert.rejects(service.request(command), updateRequired);
  Object.assign(state, { extensionVersion: '0.2.0', capabilities: ['tabs', 'cdp'] });
  await assert.rejects(service.request({ ...command, requestId: 'incomplete-claim' }), updateRequired);
  assert.deepEqual(calls, []); assert.equal(service.ownsSession(state.profileId, 'direct'), false);
  assert.equal(state.connected, true); assert.equal(state.ownership, 'user');
  state.capabilities = [...NATIVE_REQUIRED_CAPABILITIES];
  await assert.rejects(service.request(command), updateRequired, 'upgrade never replays an earlier failed claim');
  const result = await service.request({ ...command, requestId: 'modern-claim' });
  assert.equal(result.sessionId, 'direct'); assert.deepEqual(calls, ['claim']);
  assert.equal(service.ownsSession(state.profileId, 'direct'), true);
});

test('direct service keeps versioned observe/action flow, deduplicates requests, never auto-resumes', async () => {
  let listener; const state = { profileId: 'native:fixture', connected: true, ownership: 'user', taskTabs: true, extensionVersion: '0.2.0', capabilities: [...NATIVE_REQUIRED_CAPABILITIES] };
  const calls = [];
  const bridge = { states: () => [state], onEvent: fn => { listener = fn; return () => {}; }, request: async (_profile, method, p) => { calls.push(method); if (method === 'claim') Object.assign(state, { ownership: 'agent', ownerSessionId: p.sessionId }); if (method === 'control') state.ownership = p.action === 'resume' ? 'agent' : 'user'; return {}; } };
  const service = new NativeControlService(bridge, os.tmpdir());
  service.browser.observe = async () => ({ version: 'v1', snapshot: 'fixture' });
  service.browser.execute = async () => { calls.push('execute'); return 'done'; };
  const request = (method, params = {}, extra = {}) => service.request({ requestId: randomUUID(), method, params, sessionId: 'direct', ...extra });
  await request('claim');
  assert.equal(service.ownsSession('native:fixture', 'direct'), true);
  assert.equal(service.ownsSession('native:another', 'direct'), false);
  await assert.rejects(request('claim', {}, { sessionId: 'pp-task-impersonation' }), /专用前缀/);
  const obs = await request('observe'); assert.equal(obs.version, 'v1');
  await assert.rejects(request('action', { kind: 'click', version: 'old' }), /version/);
  const command = { requestId: 'same', method: 'action', sessionId: 'direct', params: { kind: 'click', ref: 'e1', version: 'v1' } };
  assert.equal(await service.request(command), 'done'); assert.equal(await service.request(command), 'done');
  assert.equal(calls.filter(c => c === 'execute').length, 1);
  await assert.rejects(service.request({ ...command, params: {} }), /requestId/);
  await assert.rejects(request('action', { kind: 'click', version: 'v1' }), /version/);
  await request('observe'); state.ownership = 'user'; listener({ type: 'state', profileId: state.profileId, state });
  await assert.rejects(request('observe'), /接管/);
  assert.equal(calls.includes('control'), false);
  state.connected = false; await assert.rejects(request('observe'), /断线/);
  service.close();
});

test('CLI errors give stable actionable exit codes without leaking discovery secrets', () => {
  const { nativeControlError, NativeControlError } = require(path.join(build, 'main/native-control/errors'));
  assert.equal(nativeControlError(new NativeControlError('NATIVE_DISCONNECTED', 'offline')).exitCode, 69);
  assert.equal(nativeControlError(new NativeControlError('NATIVE_USER_IN_CONTROL', 'stopped')).exitCode, 75);
  assert.equal(nativeControlError(new NativeControlError('NATIVE_INVALID_REQUEST', 'bad input')).exitCode, 64);
  assert.equal(nativeControlError(new Error('动作必须携带最新 version')).code, 'NATIVE_OBSERVATION_STALE');
});

test('local HTTP discovery/authentication/status works without a model or platform-specific socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-native-control-'));
  const bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  try {
    await bridge.start();
    const connection = JSON.parse(fs.readFileSync(path.join(root, 'native-control.json')));
    const status = await requestNativeControl({ method: 'status', requestId: 'one' }, root);
    assert.equal(status.protocolVersion, 1); assert.deepEqual(status.profiles, []);
    const response = await fetch(`http://127.0.0.1:${connection.port}/native-control`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://untrusted.test' }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify(status).includes(connection.token), false);
  } finally { bridge.close(); assert.equal(fs.existsSync(path.join(root, 'native-control.json')), false); fs.rmSync(root, { recursive: true, force: true }); }
});
