const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');

async function fixture() {
  const icons = new Map(), storage = {}, calls = [];
  const tabs = new Map([7, 8].map(id => [id, { id, url: `https://fixture.test/${id}`, active: id === 8, status: 'complete' }]));
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const area = { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value), remove: async () => {} };
  const chrome = {
    tabs: { get: async id => { if (!tabs.has(id)) throw Error('closed'); return { ...tabs.get(id) }; },
      query: async () => [...tabs.values()], create: async props => { assert.equal(props.active, false); const tab = { id: 9, ...props, status: 'complete' }; tabs.set(9, tab); return tab; },
      update: async () => assert.fail('Logo must not activate a tab'), onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event() },
    windows: { update: async () => assert.fail('Logo must not focus a window') },
    scripting: { executeScript: async request => { calls.push(request); icons.set(request.target.tabId, request.args[0]); } },
    runtime: { getURL: file => `chrome-extension://fixture/${file}`, getManifest: () => ({ version: '0.2.4' }), onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area, session: area, onChanged: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: event(), onDetach: event() }
  };
  const context = vm.createContext({ chrome, URL, crypto: webcrypto, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + `
    globalThis.api = { handle, state, legacy: () => { logoTabs.add(7); syncTabLogos(); }, flush: async () => { await Promise.all([...logoUpdates.values()]); } };`, context);
  await new Promise(resolve => setImmediate(resolve));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await context.api.flush(); };
  return { ...context.api, flush, chrome, tabs, icons, storage, calls };
}

test('native task indicators preserve existing site favicons and the active tab', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  assert.equal(f.icons.size, 0);
  await f.handle('switch', { sessionId: 'one', tabId: 8 }); await f.flush();
  assert.equal(f.icons.size, 0);
  await f.handle('control', { sessionId: 'one', action: 'handoff' }); await f.flush();
  assert.equal(f.icons.size, 0); assert.equal(f.tabs.get(8).active, true);
});

test('new task tabs preserve site favicons through completion and closure', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  assert.equal(f.icons.size, 0);
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  assert.equal(f.icons.size, 0);
  f.tabs.delete(9); f.chrome.tabs.onRemoved.emit(9); await f.flush();
  assert.deepEqual([...f.storage.tabLogos.created], []);
});

test('navigation and replacement do not inject page markers', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  const count = f.calls.length;
  f.chrome.tabs.onUpdated.emit(9, { status: 'complete' }); await f.flush();
  assert.equal(f.calls.length, count);
  f.tabs.set(10, { ...f.tabs.get(9), id: 10 }); f.tabs.delete(9);
  f.chrome.tabs.onReplaced.emit(10, 9); await f.flush();
  assert.equal(f.icons.size, 0); assert.deepEqual([...f.storage.tabLogos.created], [10]);
});

test('legacy injected favicons are restored, including during takeover', async () => {
  const f = await fixture(); let release;
  const originalGet = f.chrome.tabs.get;
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  f.chrome.tabs.get = async id => { if (id === 7 && !release) await new Promise(resolve => { release = resolve; }); return originalGet(id); };
  f.legacy();
  await new Promise(resolve => setImmediate(resolve));
  await f.handle('control', { sessionId: 'one', action: 'handoff' });
  release(); await f.flush(); assert.equal(f.icons.get(7), null);
});
