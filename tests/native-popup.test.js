const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

async function popupFixture(initialTabs) {
  const elements = new Map(), timers = new Set(), calls = [];
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const element = () => ({ value: '', children: [], listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren(...children) { this.children = children; }
  });
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }, createElement: element };
  let tabs = initialTabs;
  const chrome = {
    runtime: { async sendMessage(message) {
      calls.push(message.method);
      return { result: { profileId: 'native:Default', connected: true, ownership: 'user', tabId: 7 } };
    } },
    tabs: { query: async () => tabs, onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
    windows: { getCurrent: async () => ({ id: 2 }) }
  };
  const context = vm.createContext({ chrome, document, URL, URLSearchParams, location: { hash: '' },
    window: { addEventListener() {} }, setInterval() {},
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); }
  });
  await vm.runInContext(`(async () => {${readFileSync('extensions/profilepilot/popup.js', 'utf8')}\n})()`, context);
  const flush = async () => {
    for (const fn of [...timers]) { timers.delete(fn); fn(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  return { chrome, calls, flush, element: selector => document.querySelector(selector), setTabs: value => { tabs = value; } };
}

const original = { id: 7, url: 'https://fixture.test/', title: '招聘页面', windowId: 1, active: true };
const dedicated = { id: 9, url: 'https://fixture.test/', title: '招聘页面', windowId: 2, active: true };

test('extension discovers a new loaded tab without reload and preserves explicit selection', async () => {
  const f = await popupFixture([original, { id: 9, windowId: 2 }]);
  const select = f.element('#next-tab');
  assert.equal(select.value, '7');
  f.setTabs([original, dedicated,
    { id: 10, url: 'https://private.test/', incognito: true },
    { id: 11, url: 'chrome://settings' },
    { id: 12, url: 'http://127.0.0.1:12345/profilepilot-connect/test' }]);
  f.chrome.tabs.onUpdated.emit(9, { status: 'complete', title: dedicated.title });
  await f.flush();
  assert.deepEqual(select.children.map(o => o.value), ['', '7', '9']);
  assert.match(select.children[2].textContent, /fixture.test（当前窗口）/);
  assert.equal(select.value, '7', 'new tabs must not silently replace the user choice');
  select.value = '9'; select.listeners.change();
  f.setTabs([original]); f.chrome.tabs.onRemoved.emit(9);
  await f.flush();
  assert.equal(select.value, '', 'a removed selection must not silently authorize another tab');
  assert.equal(f.element('#select-tab').disabled, true);
  assert.deepEqual(f.calls, ['state'], 'refreshing choices never changes authorization');
});

test('a slower old tab query cannot overwrite the newest tab list', async () => {
  const f = await popupFixture([original, dedicated]);
  const pending = [];
  f.chrome.tabs.query = () => new Promise(resolve => pending.push(resolve));
  f.chrome.tabs.onUpdated.emit(9, { title: 'old title' }); await f.flush();
  f.chrome.tabs.onRemoved.emit(9); await f.flush();
  assert.equal(pending.length, 2);
  pending[1]([original]); await f.flush();
  pending[0]([original, dedicated]); await f.flush();
  assert.deepEqual(f.element('#next-tab').children.map(o => o.value), ['', '7']);
});

test('idle connection explains automatic task tabs and does not require an existing page to pair', async () => {
  const f = await popupFixture([]);
  assert.match(f.element('#status').textContent, /自动新开标签页，无需手动选择/);
  assert.equal(f.element('#select-tab').disabled, true);
  const html = readFileSync('extensions/profilepilot/popup.html', 'utf8');
  assert.equal(/<select[^>]*id="tab"/.test(html), false);
  f.element('#code').value = 'PP1.fixture';
  await f.element('#connect').listeners.submit({ preventDefault() {} });
  assert.ok(f.calls.includes('connect'));
});
