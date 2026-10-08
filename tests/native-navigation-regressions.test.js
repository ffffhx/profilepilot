const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');

const copy = value => JSON.parse(JSON.stringify(value));
const event = () => ({ addListener(fn) { this.listener = fn; } });

async function fixture({ fastTimeouts = false } = {}) {
  const calls = [], persisted = {}, tabs = new Map([
    [7, { id: 7, url: 'https://fixture.test/original', status: 'complete' }],
    [8, { id: 8, url: 'https://fixture.test/target', status: 'complete' }],
    [9, { id: 9, url: 'https://fixture.test/other-task-tab', status: 'complete' }],
  ]);
  let clock = 0, nextTab = 10;
  const area = () => ({ get: async () => ({}), set: async values => Object.assign(persisted, copy(values)), remove: async () => {} });
  const chrome = {
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('missing tab'); return { ...tabs.get(id) }; },
      create: async options => { const tab = { id: nextTab++, pendingUrl: options.url, status: 'loading' }; tabs.set(tab.id, tab); calls.push(['create', copy(options), tab.id]); return { ...tab }; },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event(),
    },
    runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, getManifest: () => ({ version: '0.2.1' }), onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area(), session: area(), onChanged: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    debugger: {
      attach: async target => calls.push(['attach', target.tabId]),
      detach: async target => calls.push(['detach', target.tabId]),
      sendCommand: async (target, method, params) => { calls.push([method, target.tabId, copy(params)]); return {}; },
      onEvent: event(), onDetach: event(),
    },
  };
  class FixtureDate extends Date { static now() { return clock; } }
  const timer = (fn, ms) => setTimeout(fn, fastTimeouts && ms >= 1000 ? 1 : ms);
  const context = vm.createContext({ chrome, URL, crypto: webcrypto, Date: FixtureDate, WebSocket: { OPEN: 1 }, setTimeout: timer, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + `
    globalThis.api = {
      handle, state, saveSelection,
      seed() { config = {profileId:'native:fixture'}; currentTab = 7; sessionId = 'navigation'; ownership = 'agent'; attached = true;
        allowedTabs.add(7); allowedTabs.add(9); taskTabs.set(sessionId, {tabId:7,tabs:[7,9]}); },
      takeover() { ownership = 'user'; pausedByBrowser = true; controlEpoch++; },
      idle() { sessionId = undefined; ownership = 'user'; attached = false; currentTab = undefined; allowedTabs.clear(); },
      allowed: () => [...allowedTabs], saved: () => [...taskTabs],
      enqueue(fn) { const pending = commandQueue.then(fn); commandQueue = pending.catch(() => {}); return pending; }
    };`, context);
  await new Promise(resolve => setImmediate(resolve));
  context.api.seed(); await context.api.saveSelection();
  const ui = message => new Promise(resolve => chrome.runtime.onMessage.listener(message, { id: 'fixture', url: 'chrome-extension://fixture/sidepanel.html' }, resolve));
  return { ...context.api, ui, chrome, tabs, calls, persisted, advance: ms => { clock += ms; } };
}

function commitAfter(f, reads = 2, initialBlank = false) {
  const get = f.chrome.tabs.get;
  let count = 0;
  f.chrome.tabs.get = async id => {
    const tab = f.tabs.get(id);
    if (id >= 10 && tab.pendingUrl) {
      count++;
      if (count >= reads) { tab.url = tab.pendingUrl; delete tab.pendingUrl; tab.status = 'complete'; }
      else if (initialBlank) tab.url = 'about:blank';
    }
    return get(id);
  };
  return () => count;
}

test('UI sleeping target selection preserves original target, full authorization and persisted selection', async () => {
  for (const condition of ['discarded', 'frozen', 'unloaded']) {
    const f = await fixture(), before = copy(f.persisted);
    Object.assign(f.tabs.get(8), condition === 'unloaded' ? { status: condition } : { [condition]: true });
    const response = await f.ui({ method: 'selectTab', tabId: 8 });
    assert.match(response.error, /休眠.*未切换/);
    assert.equal((await f.state()).tabId, 7);
    assert.equal((await f.state()).ownership, 'agent');
    assert.deepEqual([...f.allowed()], [7, 9]);
    assert.deepEqual(f.persisted, before);
    assert.deepEqual(f.calls, []);
  }
});

test('UI debugger attachment failure rolls back target, permission set and durable task record', async () => {
  const f = await fixture(), before = copy(f.persisted);
  f.chrome.debugger.attach = async target => { f.calls.push(['attach', target.tabId]); if (target.tabId === 8) throw Error('Debugger occupied'); };
  const response = await f.ui({ method: 'selectTab', tabId: 8 });
  assert.match(response.error, /Debugger occupied/);
  const state = await f.state();
  assert.equal(state.tabId, 7); assert.equal(state.ownership, 'agent'); assert.equal(state.pausedByBrowser, false);
  assert.deepEqual([...f.allowed()], [7, 9]); assert.deepEqual(f.persisted, before);
  assert.deepEqual(copy(f.saved()), [['navigation', { tabId: 7, tabs: [7, 9] }]]);
  await f.handle('open', { sessionId: 'navigation', url: 'https://fixture.test/recover' });
  assert.equal(f.calls.at(-1)[0], 'Page.navigate'); assert.equal(f.calls.at(-1)[1], 7);
});

test('a storage failure while selecting restores the original persisted target and task tabs', async () => {
  const f = await fixture(), before = copy(f.persisted), set = f.chrome.storage.session.set;
  f.chrome.storage.session.set = async values => {
    await set(values);
    if (values.selection.tabId === 8) throw Error('storage write failed');
  };
  const response = await f.ui({ method: 'selectTab', tabId: 8 });
  assert.match(response.error, /storage write failed/);
  assert.equal((await f.state()).tabId, 7);
  assert.deepEqual([...f.allowed()], [7, 9]); assert.deepEqual(f.persisted, before);
});

test('UI selection during user takeover does not attach, resume or clear the pause', async () => {
  const f = await fixture(); f.takeover();
  const response = await f.ui({ method: 'selectTab', tabId: 8 });
  assert.equal(response.error, undefined);
  assert.equal(response.result.tabId, 8); assert.equal(response.result.ownership, 'user'); assert.equal(response.result.pausedByBrowser, true);
  assert.ok(!f.calls.some(call => call[0] === 'attach'));
  assert.deepEqual([...f.allowed()], [7, 9, 8]);
  await assert.rejects(f.handle('open', { sessionId: 'navigation', url: 'https://fixture.test/blocked' }), /用户正在操作/);
});

test('newTab waits for pendingUrl commit, including transient about:blank, without activation or duplicate creation', async () => {
  for (const initialBlank of [false, true]) {
    const f = await fixture(), reads = commitAfter(f, 3, initialBlank);
    const result = await f.handle('newTab', { sessionId: 'navigation', url: 'https://fixture.test/new?a=1#section' });
    assert.equal(result.tabId, 10); assert.equal((await f.state()).tabId, 10);
    assert.equal(reads(), 3);
    assert.deepEqual(f.calls.filter(call => call[0] === 'create'), [['create', { url: 'https://fixture.test/new?a=1#section', active: false }, 10]]);
    assert.deepEqual([...f.allowed()], [7, 9, 10]);
    assert.equal(f.persisted.selection.tabId, 10);
    assert.ok(!f.calls.some(call => call[0] === 'remove'));
  }
});

test('newTab readiness timeout preserves the original selection and reports the already-created tab ID', async () => {
  const f = await fixture(), before = copy(f.persisted), get = f.chrome.tabs.get;
  f.chrome.tabs.get = async id => { if (id >= 10) f.advance(1000); return get(id); };
  await assert.rejects(f.handle('newTab', { sessionId: 'navigation', url: 'https://fixture.test/slow' }), error => {
    assert.match(error.message, /尚未完成加载.*ID: 10.*勿重复新建/); assert.equal(error.createdTabId, 10); return true;
  });
  assert.equal((await f.state()).tabId, 7); assert.equal((await f.state()).ownership, 'agent');
  assert.deepEqual([...f.allowed()], [7, 9]); assert.deepEqual(f.persisted, before);
  assert.deepEqual(f.calls.map(call => call[0]), ['create']); assert.equal(f.tabs.has(10), true);
  Object.assign(f.tabs.get(10), { url: 'https://fixture.test/slow', pendingUrl: undefined, status: 'complete' });
  await f.handle('switch', { sessionId: 'navigation', tabId: 10 });
  assert.equal((await f.state()).tabId, 10);
});

test('takeover during tabs.create or readiness never attaches, changes selection or closes the new user-owned tab', async () => {
  for (const phase of ['create', 'get']) {
    const f = await fixture(), before = copy(f.persisted);
    const create = f.chrome.tabs.create, get = f.chrome.tabs.get;
    f.chrome.tabs.create = async options => { const result = await create(options); if (phase === 'create') f.takeover(); return result; };
    f.chrome.tabs.get = async id => { if (id >= 10 && phase === 'get') f.takeover(); return get(id); };
    await assert.rejects(f.handle('newTab', { sessionId: 'navigation', url: 'https://fixture.test/new' }), /用户正在操作.*ID: 10/);
    assert.equal((await f.state()).tabId, 7); assert.equal((await f.state()).ownership, 'user');
    assert.deepEqual(f.persisted, before); assert.deepEqual([...f.allowed()], [7, 9]);
    assert.deepEqual(f.calls.map(call => call[0]), ['create']); assert.equal(f.tabs.has(10), true);
  }
});

test('a stalled Chrome tab read is bounded and keeps the partial create outcome recoverable', async () => {
  const f = await fixture({ fastTimeouts: true }), get = f.chrome.tabs.get;
  f.chrome.tabs.get = id => id >= 10 ? new Promise(() => {}) : get(id);
  await assert.rejects(f.handle('newTab', { sessionId: 'navigation', url: 'https://fixture.test/stalled' }), /尚未完成加载.*ID: 10/);
  assert.equal((await f.state()).tabId, 7);
  assert.deepEqual(f.calls.map(call => call[0]), ['create']);
});

test('newTab attachment failure identifies the created tab while restoring original authorization', async () => {
  const f = await fixture(), before = copy(f.persisted); commitAfter(f, 1);
  f.chrome.debugger.attach = async target => { f.calls.push(['attach', target.tabId]); throw Error('Debugger occupied'); };
  await assert.rejects(f.handle('newTab', { sessionId: 'navigation', url: 'https://fixture.test/new' }), /Debugger occupied.*ID: 10/);
  assert.equal((await f.state()).tabId, 7); assert.deepEqual([...f.allowed()], [7, 9]);
  assert.deepEqual(f.persisted, before); assert.ok(f.tabs.has(10));
  assert.ok(!f.calls.some(call => call[0] === 'remove'));
});

test('takeover during UI selection cancels pending work and never restores over the user state', async () => {
  const f = await fixture(), get = f.chrome.tabs.get;
  f.chrome.tabs.get = async id => { if (id === 8) f.takeover(); return get(id); };
  const response = await f.ui({ method: 'selectTab', tabId: 8 });
  assert.match(response.error, /控制状态已改变/);
  assert.equal((await f.state()).ownership, 'user'); assert.equal((await f.state()).tabId, 7);
  assert.deepEqual(f.calls, []);
});

test('UI newTab uses the same commit wait while preserving user ownership and pause', async () => {
  const f = await fixture(); f.takeover(); const reads = commitAfter(f, 2);
  const response = await f.ui({ method: 'selectTab', newTab: true });
  assert.equal(response.error, undefined); assert.equal(reads(), 2);
  assert.equal(response.result.tabId, 10); assert.equal(response.result.ownership, 'user'); assert.equal(response.result.pausedByBrowser, true);
  assert.ok(!f.calls.some(call => call[0] === 'attach' || call[0] === 'remove'));
});

test('claim newTab shares commit readiness before attaching its new task', async () => {
  const f = await fixture(); f.idle(); const reads = commitAfter(f, 2);
  await f.handle('claim', { sessionId: 'new-task', newTab: true });
  assert.equal(reads(), 2); assert.equal((await f.state()).tabId, 10); assert.equal((await f.state()).ownership, 'agent');
  assert.deepEqual([...f.allowed()], [10]); assert.ok(f.calls.some(call => call[0] === 'attach' && call[1] === 10));
});

test('UI selection is queued so later Agent navigation uses the successfully selected target', async () => {
  const f = await fixture(), get = f.chrome.tabs.get;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.chrome.tabs.get = async id => {
    if (id === 8 && !release) { await new Promise(resolve => { release = resolve; entered(); }); }
    return get(id);
  };
  const selecting = f.ui({ method: 'selectTab', tabId: 8 }); await waiting;
  const navigating = f.enqueue(() => f.handle('open', { sessionId: 'navigation', url: 'https://fixture.test/after-selection' }));
  assert.ok(!f.calls.some(call => call[0] === 'Page.navigate'));
  release(); assert.equal((await selecting).error, undefined); await navigating;
  assert.equal(f.calls.at(-1)[0], 'Page.navigate'); assert.equal(f.calls.at(-1)[1], 8);
});
