const test = require('node:test');
const assert = require('node:assert/strict');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const tabs = [{ id: 7, url: 'https://fixture.test/a', title: 'A', windowId: 2, active: true },
  { id: 8, url: 'https://fixture.test/b', title: 'B', windowId: 2, active: false }];
const currentTask = { id: 'existing', status: 'running', title: 'Existing conversation' };
const edit = (f, value) => { f.element('#prompt').value = value; f.element('#prompt').listeners.input(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a late send preserves a newer draft, including text edited back to the original', async () => {
  for (const newer of ['new unsent text', 'first']) {
    const f = await popupFixture(tabs, { state: { task: currentTask } });
    const reply = deferred(); f.handlers.taskMessage = () => reply.promise;
    edit(f, 'first'); const pending = f.submit('#compose'); await f.flush();
    edit(f, 'intermediate edit'); edit(f, newer);
    reply.resolve({ result: currentTask }); await pending;
    assert.equal(f.element('#prompt').value, newer);
    assert.equal(f.calls.filter(c => c.method === 'taskMessage').length, 1);
  }
});

test('a late send cannot leave the new conversation or discard its draft', async () => {
  const f = await popupFixture(tabs, { state: { task: currentTask } });
  const reply = deferred(); f.handlers.taskMessage = () => reply.promise;
  edit(f, 'old conversation message'); const pending = f.submit('#compose'); await f.flush();
  f.element('#new-task').onclick(); edit(f, 'new task draft');
  reply.resolve({ result: currentTask }); await pending; await f.poll();
  assert.equal(f.element('#prompt').value, 'new task draft');
  assert.equal(f.element('#conversation').hidden, true);
  assert.equal(f.element('#send').textContent, '开始任务');
  f.handlers.startTask = () => ({ result: { id: 'new-task', status: 'queued' } });
  await f.submit('#compose');
  assert.equal(f.calls.find(c => c.method === 'startTask').prompt, 'new task draft');
  assert.equal(f.calls.filter(c => c.method === 'taskMessage').length, 1);
});

test('choosing a new conversation while target lookup waits cancels the unsent request', async () => {
  const f = await popupFixture(tabs);
  const context = deferred(); f.handlers.getPageContext = () => context.promise;
  edit(f, 'old draft'); const pending = f.submit('#compose'); await f.flush();
  f.element('#new-task').onclick(); edit(f, 'new draft');
  context.resolve({ result: tabs[0] }); await pending;
  assert.equal(f.calls.some(c => c.method === 'startTask'), false);
  assert.equal(f.element('#prompt').value, 'new draft');
  assert.equal(f.element('#send').disabled, false);
});

test('selection from another tab or a navigated document is omitted before starting a task', async () => {
  for (const actual of [tabs[1], { ...tabs[0], url: 'https://fixture.test/changed' }]) {
    const f = await popupFixture(tabs);
    f.handlers.getPageContext = () => ({ result: { ...tabs[0], selection: 'Only from document A' } });
    f.element('#refresh-context').onclick(); await f.flush();
    assert.equal(f.element('#selection').hidden, false);
    f.handlers.getPageContext = () => ({ result: actual });
    edit(f, 'explain current document'); await f.submit('#compose');
    const sent = f.calls.find(c => c.method === 'startTask');
    assert.equal(sent.tabId, actual.id);
    assert.equal(sent.selection, undefined);
  }
});

test('a retained explicit selection must still match that tab current document', async () => {
  const f = await popupFixture(tabs, { storage: { nativeTaskContext: { ...tabs[0], selection: 'Saved selection A' } } });
  f.handlers.getPageContext = () => ({ result: { ...tabs[0], url: 'https://fixture.test/new-document' } });
  edit(f, 'summarize selected page'); await f.submit('#compose');
  const sent = f.calls.find(c => c.method === 'startTask');
  assert.equal(sent.tabId, 7); assert.equal(sent.selection, undefined);
});

test('lost-response retry keeps the validated original selection and request despite polling', async () => {
  const f = await popupFixture(tabs);
  f.handlers.getPageContext = () => ({ result: { ...tabs[0], selection: 'Saved selection A' } });
  f.element('#refresh-context').onclick(); await f.flush();
  f.handlers.startTask = () => ({ error: 'Connection lost before receipt' });
  edit(f, 'explain selection'); await f.submit('#compose');
  const first = f.calls.find(c => c.method === 'startTask');
  assert.equal(first.tabId, 7); assert.equal(first.selection, 'Saved selection A');
  f.setState({ currentTab: tabs[1], task: { id: 'created', status: 'running' } }); await f.poll();
  assert.equal(f.element('#selection').hidden, true);
  f.handlers.getPageContext = () => ({ result: tabs[1] });
  f.handlers.startTask = () => ({ result: { id: 'created', status: 'running' } });
  await f.submit('#compose');
  const second = f.calls.filter(c => c.method === 'startTask')[1];
  assert.deepEqual(second, first);
  assert.equal(f.calls.some(c => c.method === 'taskMessage'), false);
});

test('changing the page selector during current-page lookup prevents an ambiguous send', async () => {
  const f = await popupFixture(tabs);
  const context = deferred(); f.handlers.getPageContext = () => context.promise;
  edit(f, 'read current page'); const pending = f.submit('#compose'); await f.flush();
  f.element('#next-tab').value = '8'; f.element('#next-tab').listeners.change();
  context.resolve({ result: tabs[0] }); await pending;
  assert.equal(f.calls.some(c => c.method === 'startTask'), false);
  assert.match(f.element('#error').textContent, /页面已改变/);
  assert.equal(f.element('#prompt').value, 'read current page');
});
