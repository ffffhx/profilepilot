const test = require('node:test');
const assert = require('node:assert/strict');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const tabs = [{ id: 7, url: 'https://fixture.test/other', title: '已有页', windowId: 1, active: true },
  { id: 9, url: 'https://fixture.test/current', title: '当前页', windowId: 2, active: true }];
const methods = f => f.calls.map(c => c.method);

test('starts with the current page and no takeover, page-claim or approval detour', async () => {
  const f = await popupFixture(tabs);
  assert.equal(f.element('#next-tab').value, 'current');
  f.element('#prompt').value = '总结页面';
  await f.submit('#compose');
  const command = f.calls.find(c => c.method === 'startTask');
  assert.equal(command.tabId, 9); assert.equal(command.prompt, '总结页面'); assert.ok(command.requestId);
  assert.equal(methods(f).some(m => ['takeover', 'selectTab', 'taskReply'].includes(m)), false);
  assert.match(f.element('#status').textContent, /直接使用当前页/);
});
test('new page and an explicitly chosen existing page are sent as distinct targets', async () => {
  const f = await popupFixture(tabs);
  f.element('#next-tab').value = 'new'; f.element('#prompt').value = '新页面任务'; await f.submit('#compose');
  const fresh = f.calls.find(c => c.method === 'startTask'); assert.equal(fresh.newTab, true); assert.equal(fresh.tabId, undefined);
  f.element('#next-tab').value = '7'; f.element('#prompt').value = '已有页面任务'; await f.submit('#compose');
  assert.equal(f.calls.filter(c => c.method === 'startTask')[1].tabId, 7);
});
test('changing the task page while agent owns it does not require handoff', async () => {
  const f = await popupFixture(tabs, { state: { sessionId: 'pp-task-t', ownership: 'agent', task: { id: 't', status: 'running' } } });
  f.element('#next-tab').value = '7';
  f.element('#next-tab').listeners.change();
  assert.equal(f.element('#select-tab').disabled, false);
  await f.element('#select-tab').onclick();
  assert.equal(f.calls.find(c => c.method === 'selectTab').tabId, 7);
  assert.equal(methods(f).includes('takeover'), false);
});
test('selected text is shown literally and attached only when included', async () => {
  const f = await popupFixture(tabs, { storage: { nativeTaskContext: { tabId: 7, title: '已有页', url: tabs[0].url, selection: '<script>context</script>' } } });
  assert.equal(f.element('#next-tab').value, '7');
  assert.equal(f.element('#selection').textContent, '<script>context</script>');
  f.element('#prompt').value = '解释选区'; await f.submit('#compose');
  assert.equal(f.calls.find(c => c.method === 'startTask').selection, '<script>context</script>');
  f.element('#include-selection').checked = false; f.element('#prompt').value = '只看页面'; await f.submit('#compose');
  assert.equal(f.calls.filter(c => c.method === 'startTask')[1].selection, undefined);
});
test('message retries preserve requestId and simultaneous submits run once', async () => {
  const f = await popupFixture(tabs);
  let resolve;
  f.handlers.startTask = () => new Promise(r => { resolve = r; });
  f.element('#prompt').value = '唯一任务';
  const first = f.submit('#compose'); await f.submit('#compose'); await f.flush();
  assert.equal(f.calls.filter(c => c.method === 'startTask').length, 1);
  resolve({ error: 'Connection lost' }); await first;
  const id = f.calls.find(c => c.method === 'startTask').requestId;
  f.handlers.startTask = () => ({ result: {} }); await f.submit('#compose');
  assert.equal(f.calls.filter(c => c.method === 'startTask')[1].requestId, id);
});
test('stop aborts extension input then stops the current task; queued task can stop without a lease', async () => {
  const f = await popupFixture(tabs, { state: { sessionId: 'pp-task-t', ownership: 'agent', task: { id: 't', status: 'running' } } });
  await f.element('#takeover').onclick();
  assert.deepEqual(methods(f).slice(1, 3), ['takeover', 'taskControl']);
  assert.equal(f.calls.find(c => c.method === 'taskControl').action, 'stop');
  const queued = await popupFixture(tabs, { state: { task: { id: 'q', status: 'queued' } } });
  await queued.element('#takeover').onclick();
  assert.equal(methods(queued).includes('takeover'), false);
  assert.equal(queued.calls.find(c => c.method === 'taskControl').taskId, 'q');
});
test('optional confirmation uses explicit taskReply, plain text stays a message', async () => {
  const f = await popupFixture(tabs, { state: { task: { id: 't', status: 'waiting_user', pending: { id: 'd', kind: 'confirmation', title: '提交表单' } } } });
  assert.equal(f.element('#decision-controls').hidden, false);
  f.element('#prompt').value = '修改说明'; await f.submit('#compose');
  assert.equal(methods(f).includes('taskMessage'), true); assert.equal(methods(f).includes('taskReply'), false);
  await f.element('#deny').onclick();
  const reply = f.calls.find(c => c.method === 'taskReply'); assert.equal(reply.approved, false); assert.equal(reply.decisionId, 'd');
});
test('site restrictions are optional, normalized, and invalid paths never reach transport', async () => {
  const f = await popupFixture(tabs);
  assert.equal(f.element('#confirm-actions').checked, false);
  f.element('#blocked-origins').value = 'https://EXAMPLE.com/\nhttps://example.com';
  await f.submit('#access-form');
  assert.deepEqual(f.calls.find(c => c.method === 'setAccess').blockedOrigins, ['https://example.com']);
  f.element('#blocked-origins').value = 'https://example.com/private';
  await f.submit('#access-form');
  assert.equal(f.calls.filter(c => c.method === 'setAccess').length, 1);
  assert.equal(f.element('#error').hidden, false);
});
test('task events from the backend envelope are text-only and preserve progress', async () => {
  const f = await popupFixture(tabs, { state: { task: { id: 't', status: 'running', title: '总结' }, events: [{ kind: 'assistant', text: '<img onerror=alert(1)>' }], stream: { text: '继续输出' } } });
  const rows = f.element('#messages').children;
  assert.equal(rows.length, 2); assert.equal(rows[0].children[1].textContent, '<img onerror=alert(1)>');
  assert.equal(rows[1].children[1].textContent, '继续输出');
});
test('current-page target is re-read at send time, and uncertain retry stays with the original command', async () => {
  const f = await popupFixture(tabs);
  f.handlers.getPageContext = () => ({ result: tabs[0] });
  f.handlers.startTask = () => ({ error: 'Connection lost before receipt' });
  f.element('#prompt').value = '保持原任务'; await f.submit('#compose');
  const first = f.calls.find(c => c.method === 'startTask'); assert.equal(first.tabId, 7);
  f.setState({ currentTab: tabs[1], task: { id: 'created-after-timeout', status: 'running' } });
  await f.poll();
  f.handlers.startTask = () => ({ result: { task: { id: 'created-after-timeout', status: 'running' } } });
  await f.submit('#compose');
  const retried = f.calls.filter(c => c.method === 'startTask')[1];
  assert.equal(retried.requestId, first.requestId); assert.equal(retried.tabId, 7);
  assert.equal(methods(f).includes('taskMessage'), false, 'polling discovers the created task but retry must not append a duplicate message');
});
test('polling pins the current conversation and a queued conversation cannot switch another task page', async () => {
  const f = await popupFixture(tabs, { state: { sessionId: 'pp-task-owner', taskSessionId: 'pp-task-queued', task: { id: 'queued-task', status: 'queued' } } });
  assert.equal(f.element('#select-tab').hidden, true);
  await f.poll(); assert.equal(f.calls.filter(c => c.method === 'getUiState')[1].taskId, 'queued-task');
});

test('external session can return and select its page despite a historical conversation', async () => {
  for (const status of ['completed', 'paused', 'queued']) {
    const f = await popupFixture(tabs, { state: { sessionId: 'external-research', ownership: 'user',
      taskSessionId: 'pp-task-history', task: { id: 'history', status } } });
    assert.equal(f.element('#return').disabled, false, status);
    assert.equal(f.element('#select-tab').hidden, false, status);
    await f.element('#return').onclick();
    assert.equal(methods(f).includes('return'), true, status);
    assert.equal(methods(f).includes('taskControl'), false, 'never resume an unrelated historical task');
  }
});

test('external session remains independent when a historical conversation omits taskSessionId', async () => {
  for (const status of ['completed', 'paused', 'queued']) {
    const f = await popupFixture(tabs, { state: { sessionId: 'external-research', ownership: 'user', task: { id: 'history', status } } });
    assert.equal(f.element('#return').disabled, false, status);
    assert.equal(f.element('#select-tab').hidden, false, status);
    await f.element('#return').onclick();
    assert.equal(methods(f).includes('return'), true, status);
    assert.equal(methods(f).includes('taskControl'), false, 'missing history metadata must not route resume to another task');
    f.setState({ ownership: 'agent' }); await f.poll();
    await f.element('#takeover').onclick();
    assert.equal(methods(f).includes('takeover'), true, status);
    assert.equal(methods(f).includes('taskControl'), false, 'missing history metadata must not stop a queued historical task');
  }
});

test('stopping an external session does not stop a different queued conversation', async () => {
  const f = await popupFixture(tabs, { state: { sessionId: 'external-research', ownership: 'agent',
    taskSessionId: 'pp-task-history', task: { id: 'history', status: 'queued' } } });
  assert.equal(f.element('#return').disabled, true);
  await f.element('#takeover').onclick();
  assert.equal(methods(f).includes('takeover'), true);
  assert.equal(methods(f).includes('taskControl'), false);
});

test('matching built-in session resumes its task and an idle historical task can still resume', async () => {
  for (const sessionId of ['pp-task-history', undefined]) {
    const f = await popupFixture(tabs, { state: { sessionId, ownership: 'user', taskSessionId: 'pp-task-history',
      task: { id: 'history', status: 'paused' } } });
    assert.equal(f.element('#return').disabled, false);
    await f.element('#return').onclick();
    assert.equal(f.calls.find(c => c.method === 'taskControl')?.taskId, 'history');
    assert.equal(methods(f).includes('return'), false);
  }
});
test('side panel opens directly from the click without losing the Chrome gesture to messaging', async () => {
  const f = await popupFixture(tabs);
  f.element('#open-side-panel').onclick();
  assert.deepEqual(f.calls.at(-1), { method: 'sidePanel.open', windowId: 2 });
  assert.equal(methods(f).includes('openSidePanel'), false);
});
test('temporary installation marker is cleared only after the explicit persistent-install action', async () => {
  const normal = await popupFixture(tabs);
  assert.equal(normal.element('#temporary-installation').hidden, true);
  const f = await popupFixture(tabs, { state: { installationMode: 'temporary' } });
  assert.equal(f.element('#temporary-installation').hidden, false);
  assert.equal(methods(f).includes('confirmPersistentInstallation'), false);
  f.handlers.confirmPersistentInstallation = command => { assert.equal(command.confirmed, true); f.setState({ installationMode: 'persistent' }); return { result: {} }; };
  await f.element('#confirm-persistent-installation').onclick();
  assert.equal(f.element('#temporary-installation').hidden, true);
});
