const test = require('node:test');
const assert = require('node:assert/strict');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const controlled = { sessionId: 'external-session', tabId: 9, tabTitle: '正在处理的页面', url: 'https://controlled.test/article', ownership: 'agent' };

test('status shows the controlled tab rather than the active tab or old conversation', async () => {
  const f = await popupFixture([{ id: 7, active: true, title: '用户正在看的页面', url: 'https://other.test' }], {
    state: { ...controlled, task: { title: '已结束的任务', status: 'completed' } }
  });
  assert.equal(f.element('#page-title').textContent, controlled.tabTitle);
  assert.equal(f.element('#page-domain').textContent, 'controlled.test');
  assert.equal(f.element('#control-state').textContent, '正在控制');
  assert.deepEqual(f.calls.map(c => c.method), ['state'], 'opening the popup only reads local state');
});

test('ending a session clears its historical tab while the connection stays healthy', async () => {
  const f = await popupFixture([], { state: controlled });
  f.setState({ sessionId: undefined }); await f.poll();
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.equal(f.element('#control-state').textContent, '空闲');
  assert.equal(f.element('#page-title').textContent, '当前没有受控标签页');
  assert.equal(f.element('#page-domain').hidden, true);
});

test('handoff and a browser-paused session display paused without resuming control', async () => {
  for (const patch of [{ ownership: 'user' }, { pausedByBrowser: true }]) {
    const f = await popupFixture([], { state: controlled });
    f.setState(patch); await f.poll();
    assert.equal(f.element('#control-state').textContent, '已暂停');
    assert.equal(f.element('#page-title').textContent, controlled.tabTitle);
    assert.ok(f.calls.every(c => c.method === 'state'));
  }
});

test('a closed target is not replaced with an unrelated active tab', async () => {
  const f = await popupFixture([{ id: 7, active: true, title: 'Other' }], { state: controlled });
  f.setState({ tabTitle: undefined, url: undefined }); await f.poll();
  assert.equal(f.element('#control-state').textContent, '等待页面');
  assert.equal(f.element('#page-title').textContent, '当前没有可用的受控标签页');
  assert.equal(f.element('#page-domain').hidden, true);
});

test('target changes update the title and domain, and untrusted titles are plain text', async () => {
  const f = await popupFixture([], { state: controlled });
  f.setState({ tabId: 11, tabTitle: '<img src=x onerror=alert(1)>', url: 'https://second.test:8443/path' }); await f.poll();
  assert.equal(f.element('#page-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.element('#page-title').innerHTML, undefined);
  assert.equal(f.element('#page-domain').textContent, 'second.test:8443');
  f.setState({ tabTitle: '', url: 'about:blank' }); await f.poll();
  assert.equal(f.element('#page-title').textContent, '空白标签页');
});

test('losing connection immediately clears the old controlled page', async () => {
  const f = await popupFixture([], { state: controlled });
  f.setState({ connected: false }); await f.poll();
  assert.equal(f.element('#connection-label').textContent, '未连接');
  assert.equal(f.element('#control-state').textContent, '未连接');
  assert.equal(f.element('#page-title').textContent, '连接后显示受控标签页');
  assert.equal(f.element('#page-domain').hidden, true);
  assert.equal(f.element('#reconnect').hidden, false);
});
