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
    globalThis.api = { handle, state, flush: async () => { await Promise.all([...logoUpdates.values()]); } };`, context);
  await new Promise(resolve => setImmediate(resolve));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await context.api.flush(); };
  return { ...context.api, flush, chrome, tabs, icons, storage, calls };
}

test('existing tabs are marked only while controlled, without changing active tab', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  assert.match(f.icons.get(7), /icon-32.png$/); assert.equal(f.icons.has(8), false);
  await f.handle('switch', { sessionId: 'one', tabId: 8 }); await f.flush();
  assert.equal(f.icons.get(7), null); assert.match(f.icons.get(8), /icon-32.png$/);
  await f.handle('control', { sessionId: 'one', action: 'handoff' }); await f.flush();
  assert.equal(f.icons.get(8), null); assert.equal(f.tabs.get(8).active, true);
});

test('created tabs retain the logo after completion and are forgotten when closed', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  assert.equal(f.icons.get(7), null); assert.match(f.icons.get(9), /icon-32.png$/);
  await f.handle('control', { sessionId: 'one', action: 'complete' }); await f.flush();
  assert.match(f.icons.get(9), /icon-32.png$/);
  f.tabs.delete(9); f.chrome.tabs.onRemoved.emit(9); await f.flush();
  assert.deepEqual([...f.storage.tabLogos.created], []);
});

test('navigation reinjects the logo and replacement IDs retain creation provenance', async () => {
  const f = await fixture();
  await f.handle('claim', { sessionId: 'one', tabId: 7 });
  await f.handle('newTab', { sessionId: 'one', url: 'https://fixture.test/new' }); await f.flush();
  const count = f.calls.length;
  f.chrome.tabs.onUpdated.emit(9, { status: 'complete' }); await f.flush();
  assert.equal(f.calls.length, count + 1);
  f.tabs.set(10, { ...f.tabs.get(9), id: 10 }); f.tabs.delete(9);
  f.chrome.tabs.onReplaced.emit(10, 9); await f.flush();
  assert.match(f.icons.get(10), /icon-32.png$/); assert.deepEqual([...f.storage.tabLogos.created], [10]);
});

test('takeover during a pending tab lookup cannot install a stale active logo', async () => {
  const f = await fixture(); let release;
  const originalGet = f.chrome.tabs.get;
  await f.handle('claim', { sessionId: 'one', tabId: 7 }); await f.flush();
  f.chrome.tabs.get = async id => { if (id === 7 && !release) await new Promise(resolve => { release = resolve; }); return originalGet(id); };
  f.chrome.tabs.onUpdated.emit(7, { status: 'complete' });
  await new Promise(resolve => setImmediate(resolve));
  await f.handle('control', { sessionId: 'one', action: 'handoff' });
  release(); await f.flush(); assert.equal(f.icons.get(7), null);
});
