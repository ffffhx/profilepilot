const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const manifest = JSON.parse(readFileSync('extensions/profilepilot/manifest.json', 'utf8'));

async function fixture() {
  const calls = [], tabs = [
    { id: 1, windowId: 10, active: true, url: 'https://one.example/', title: 'One' },
    { id: 2, windowId: 20, active: true, url: 'https://two.example/', title: 'Two' },
    { id: 3, windowId: 30, active: true, incognito: true, url: 'https://private.example/' }
  ];
  const event = () => ({ addListener() {} });
  const area = () => ({ get: async () => ({}), set: async () => {} });
  const chrome = {
    tabs: { query: async q => tabs.filter(t => (!q.windowId || t.windowId === q.windowId) && (!q.active || t.active)),
      captureVisibleTab: async id => {
        // Background previews have no activeTab grant from a user extension click.
        if (!manifest.host_permissions.includes('<all_urls>')) throw Error('Either the <all_urls> or activeTab permission is required.');
        calls.push(['capture', id]); return 'data:image/jpeg;base64,frame';
      },
      update: async () => { throw Error('Must not activate a tab'); },
      onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event() },
    windows: { getLastFocused: async () => ({ id: 20 }), update: async () => { throw Error('Must not focus'); } },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event(), getManifest: () => manifest },
    storage: { local: area(), session: area(), onChanged: event() }, alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    debugger: { attach: async () => { throw Error('Must not attach'); }, onEvent: event(), onDetach: event() }
  };
  const context = vm.createContext({ chrome, URL, crypto: webcrypto, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + '\nglobalThis.preview = () => handle("liveView", {});', context);
  await new Promise(resolve => setImmediate(resolve));
  return { preview: context.preview, chrome, tabs, calls };
}

test('preview uses the selected Profile active window without control or incognito access', async () => {
  const f = await fixture(), result = await f.preview();
  assert.equal(result.primaryTitle, 'Two');
  assert.equal(result.tabCount, 2);
  assert.equal(result.screenshot, 'data:image/jpeg;base64,frame');
  assert.deepEqual(f.calls, [['capture', 20]]);
});
test('preview discards a frame if the tab changes during capture', async () => {
  const f = await fixture();
  f.chrome.tabs.captureVisibleTab = async () => { f.tabs[1] = { ...f.tabs[1], id: 9 }; return 'wrong frame'; };
  const result = await f.preview();
  assert.equal(result.screenshot, null); assert.ok(result.screenshotError);
});
test('restricted pages and capture failures produce an unavailable state', async () => {
  const f = await fixture(); f.tabs[1].url = 'chrome://settings';
  let result = await f.preview(); assert.equal(result.screenshot, null); assert.equal(f.calls.length, 0);
  f.tabs[1].url = 'https://two.example/'; f.chrome.tabs.captureVisibleTab = async () => { throw Error('minimized'); };
  result = await f.preview(); assert.equal(result.screenshot, null); assert.ok(result.screenshotError);
});
test('missing screenshot permission provides an actionable extension reload message', async () => {
  const f = await fixture();
  f.chrome.tabs.captureVisibleTab = async () => { throw Error('Either the <all_urls> or activeTab permission is required.'); };
  const result = await f.preview();
  assert.equal(result.screenshot, null);
  assert.match(result.screenshotError, /chrome:\/\/extensions.*重新加载/);
});
