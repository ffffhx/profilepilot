const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const original = { id: 7, url: 'https://fixture.test/', title: '招聘页面', windowId: 1, active: true };
const dedicated = { id: 9, url: 'https://fixture.test/', title: '招聘页面', windowId: 2, active: true };

test('extension discovers a new loaded tab without reload and preserves explicit selection', async () => {
  const f = await popupFixture([original, { id: 9, windowId: 2 }]);
  const select = f.element('#next-tab'); assert.equal(select.value, 'current'); select.value = '7';
  f.setTabs([original, dedicated,
    { id: 10, url: 'https://private.test/', incognito: true },
    { id: 11, url: 'chrome://settings' },
    { id: 12, url: 'http://127.0.0.1:12345/profilepilot-connect/test' }]);
  f.chrome.tabs.onUpdated.emit(9, { status: 'complete', title: dedicated.title }); await f.flush();
  assert.deepEqual(select.children.map(o => o.value), ['current', 'new', '7', '9']);
  assert.match(select.children[3].textContent, /fixture.test（当前窗口）/);
  assert.equal(select.value, '7', 'new tabs must not silently replace the user choice');
  select.value = '9'; select.listeners.change(); f.setTabs([original]); f.chrome.tabs.onRemoved.emit(9); await f.flush();
  assert.equal(select.value, '', 'a removed selection must not silently authorize another tab');
  assert.equal(f.element('#select-tab').disabled, true);
  assert.deepEqual(f.calls.map(c => c.method), ['getUiState'], 'refreshing choices never changes the task target');
});
test('a slower old tab query cannot overwrite the newest tab list', async () => {
  const f = await popupFixture([original, dedicated]); const pending = [];
  f.chrome.tabs.query = () => new Promise(resolve => pending.push(resolve));
  f.chrome.tabs.onUpdated.emit(9, { title: 'old title' }); await f.flush();
  f.chrome.tabs.onRemoved.emit(9); await f.flush(); assert.equal(pending.length, 2);
  pending[1]([original]); await f.flush(); pending[0]([original, dedicated]); await f.flush();
  assert.deepEqual(f.element('#next-tab').children.map(o => o.value), ['current', 'new', '7']);
});
test('idle pairing does not require an existing page and explains current or new-page use', async () => {
  const f = await popupFixture([]);
  assert.match(f.element('#status').textContent, /直接使用当前页，也可新建页/);
  assert.equal(f.element('#select-tab').disabled, true);
  const html = readFileSync('extensions/profilepilot/popup.html', 'utf8');
  assert.equal(/<select[^>]*id="tab"/.test(html), false);
  f.element('#code').value = 'PP1.fixture'; await f.submit('#connect');
  assert.ok(f.calls.some(c => c.method === 'connect'));
});
