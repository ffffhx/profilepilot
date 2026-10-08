const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');

async function fixture() {
  const calls = [], tabs = new Map([
    [7, { id: 7, url: 'https://x.example/current', active: true, status: 'complete' }],
    [8, { id: 8, url: 'https://notes.example/note', active: false, status: 'complete' }],
  ]);
  const event = () => ({ addListener() {} });
  const area = () => ({ get: async () => ({}), set: async () => {} });
  const chrome = {
    tabs: { get: async id => { if (!tabs.has(id)) throw Error('missing tab'); return { ...tabs.get(id) }; },
      query: async q => [...tabs.values()].filter(tab => !q.active || tab.active), onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event() },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event(), getManifest: () => ({ version: '0.2.0' }) },
    storage: { local: area(), session: area(), onChanged: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    debugger: { attach: async target => { calls.push(['attach', target.tabId]); },
      detach: async target => { calls.push(['detach', target.tabId]); },
      sendCommand: async (target, method, params) => { calls.push([method, target.tabId, params]); return {}; },
      onEvent: event(), onDetach: event() },
  };
  const context = vm.createContext({ chrome, URL, crypto: webcrypto, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + `
    globalThis.api = { handle, state, seed() {
      currentTab = 7; sessionId = 'one'; ownership = 'agent'; attached = true;
      allowedTabs.add(7); taskTabs.set('one', {tabId: 7, tabs: [7]});
    }, allowed: () => [...allowedTabs] };`, context);
  await new Promise(resolve => setImmediate(resolve)); context.api.seed();
  return { ...context.api, tabs, chrome, calls };
}

test('sleeping tab selection preserves the live target so explicit navigation can recover', async () => {
  for (const condition of ['discarded', 'frozen', 'unloaded']) {
    const f = await fixture(); Object.assign(f.tabs.get(8), condition === 'unloaded' ? { status: condition } : { [condition]: true });
    await assert.rejects(f.handle('switch', { sessionId: 'one', tabId: 8 }), /休眠.*未切换/);
    assert.equal((await f.state()).tabId, 7); assert.deepEqual([...f.allowed()], [7]);
    assert.deepEqual(f.calls, [], 'No detach, activation or input for an unavailable target');
    await f.handle('open', { sessionId: 'one', url: 'https://notes.example/search' });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'Page.navigate'); assert.equal(f.calls[0][1], 7);
    assert.equal(f.calls[0][2].url, 'https://notes.example/search');
  }
});

test('failed debugger attachment rolls selection back and does not authorize the failed target', async () => {
  const f = await fixture();
  f.chrome.debugger.attach = async target => { f.calls.push(['attach', target.tabId]); if (target.tabId === 8) throw Error('Debugger is occupied'); };
  await assert.rejects(f.handle('switch', { sessionId: 'one', tabId: 8 }), /occupied/);
  assert.equal((await f.state()).tabId, 7); assert.deepEqual([...f.allowed()], [7]);
  await assert.rejects(f.handle('closeTab', { sessionId: 'one', tabId: 8 }), /未授权/);
  await f.handle('open', { sessionId: 'one', url: 'https://notes.example/search' });
  assert.equal(f.calls.at(-1)[0], 'Page.navigate'); assert.equal(f.calls.at(-1)[1], 7);
});

test('successful switching persists the selected target and tabs expose sleep state', async () => {
  const f = await fixture();
  await f.handle('switch', { sessionId: 'one', tabId: 8 });
  assert.equal((await f.state()).tabId, 8); assert.deepEqual([...f.allowed()], [7, 8]);
  Object.assign(f.tabs.get(7), { discarded: true, status: 'unloaded' });
  for (const params of [{}, { sessionId: 'one' }]) {
    const entries = await f.handle('tabs', params);
    assert.equal(entries.find(t => t.id === '7').discarded, true);
    assert.equal(entries.find(t => t.id === '7').status, 'unloaded');
    assert.equal(entries.find(t => t.id === '8').current, true);
  }
});

test('takeover during selection never reconnects or resumes input in the old target', async () => {
  const f = await fixture(); let cancelled = false;
  f.chrome.debugger.attach = async () => {
    await f.handle('control', { sessionId: 'one', action: 'handoff' }); cancelled = true;
  };
  await assert.rejects(f.handle('switch', { sessionId: 'one', tabId: 8 }, () => { if (cancelled) throw Error('cancelled'); }), /cancelled/);
  assert.equal((await f.state()).ownership, 'user');
  assert.ok(!f.calls.some(call => call[0] === 'Page.navigate' || call[0] === 'Input.dispatchMouseEvent'));
  await assert.rejects(f.handle('open', { sessionId: 'one', url: 'https://notes.example/search' }), /用户正在操作/);
});

test('new implicit tasks skip a discarded idle target while explicit selection remains exact', async () => {
  const f = await fixture();
  await f.handle('control', { sessionId: 'one', action: 'complete' });
  Object.assign(f.tabs.get(7), { discarded: true, active: false }); f.tabs.get(8).active = true;
  await f.handle('claim', { sessionId: 'two' });
  assert.equal((await f.state()).tabId, 8);
  assert.ok(!f.calls.some(call => call[0] === 'attach' && call[1] === 7));
  await f.handle('control', { sessionId: 'two', action: 'complete' });
  await assert.rejects(f.handle('claim', { sessionId: 'three', tabId: 7 }), /休眠/);
  assert.equal((await f.state()).tabId, 7, 'An explicitly requested target is never silently replaced');
  assert.equal((await f.state()).ownership, 'user');
});
