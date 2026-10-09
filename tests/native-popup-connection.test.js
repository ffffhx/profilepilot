const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');

test('connection status never waits for or requests desktop task information', async () => {
  const f = await popupFixture([], { handlers: {
    getUiState: () => { throw new Error('The task service must not be queried'); }
  } });
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.equal(f.element('#connection-note').textContent, '浏览器服务正常');
  assert.equal(f.element('#connection-state').hidden, false);
  await f.poll();
  assert.deepEqual(f.calls.map(c => c.method), ['state', 'state']);
});

test('disconnected and unpaired browsers have distinct recovery controls', async () => {
  const disconnected = await popupFixture([], { state: { connected: false } });
  assert.equal(disconnected.element('#connection-label').textContent, '未连接');
  assert.equal(disconnected.element('#connect').hidden, true);
  assert.equal(disconnected.element('#reconnect').hidden, false);
  const unpaired = await popupFixture([], { state: { connected: false, profileId: undefined } });
  assert.equal(unpaired.element('#connection-label').textContent, '尚未配对');
  assert.equal(unpaired.element('#connect').hidden, false);
  assert.equal(unpaired.element('#reconnect').hidden, true);
});

test('popup and side panel do not flash pairing or reconnecting before loading state', () => {
  for (const file of ['popup.html', 'sidepanel.html']) {
    const html = readFileSync('extensions/profilepilot/' + file, 'utf8');
    assert.match(html, /<form[^>]*id="connect"[^>]*hidden/);
    assert.match(html, /<div[^>]*id="connection-state"[^>]*hidden/);
    assert.doesNotMatch(html, /读取连接中|正在连接中/);
  }
});
