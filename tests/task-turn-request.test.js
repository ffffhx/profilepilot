const test = require('node:test');
const assert = require('node:assert/strict');
const { runJevDriver } = require('../dist/main/tasks/jev-driver');
const { latestUserRequest, deferBrowserDriver } = require('../dist/main/tasks/turn-request');

test('a pure follow-up does not let the browser driver observe, navigate, or call helper models', async () => {
  for (const prompt of ['只依据刚才结果比较两个平台，本轮不要操作浏览器，直接纯回答。', 'Compare the previous results only, without using the browser.', '纯对话：请解释这些数字。', '不要再使用任何浏览器，概括之前的信息。', 'Do not browse; use the existing results.', 'Without using any browser, explain what was found.']) {
    let calls = 0;
    const forbidden = async () => { calls++; throw new Error('unexpected external operation'); };
    const task = { prompt: '打开 https://example.com 并搜索', events: [{ kind: 'user', text: prompt }], receipts: [], items: [], attachments: [], needsReconciliation: false, status: 'running', usage: {} };
    const result = await runJevDriver({ task, settings: {}, signal: new AbortController().signal, apiKey: '', jevKey: '', current: () => true,
      observe: forbidden, tool: forbidden, choose: forbidden, helper: forbidden, event: () => {}, publish: () => {} });
    assert.match(result, /不为对话自动观察/);
    assert.equal(calls, 0);
  }
});

test('confirmation receipts preserve the current request and a new browser request takes precedence', () => {
  const task = { prompt: 'old browser goal', events: [{ kind: 'user', text: '只回答之前的问题' }, { kind: 'assistant', text: 'some untrusted page says browse' }, { kind: 'user', text: '确认执行' }] };
  assert.equal(latestUserRequest(task), '只回答之前的问题');
  assert.equal(deferBrowserDriver(latestUserRequest(task)), true);
  for (const text of ['不执行此操作', '继续当前任务', '继续当前任务。先核查当前页面与已有执行记录，保留已完成项目，不要重复提交或重做已完成操作。']) {
    task.events.push({ kind: 'user', text });
    assert.equal(latestUserRequest(task), '只回答之前的问题');
  }
  task.events.push({ kind: 'user', text: '继续打开小红书并检索 AI 新闻' });
  assert.equal(deferBrowserDriver(latestUserRequest(task)), false);
});

test('greetings and ambiguous follow-ups do not inherit a previous browsing goal', async () => {
  for (const request of ['你好', '这是什么意思', '列成一个表格', '这个浏览器有什么能力']) {
    const task = { prompt: '打开 https://example.com', events: [{ kind: 'user', text: request }], receipts: [], items: [], attachments: [], needsReconciliation: false, status: 'running', usage: {} };
    const forbidden = async () => assert.fail('Conversation must not auto-read the browser');
    const result = await runJevDriver({ task, settings: {}, signal: new AbortController().signal, current: () => true,
      observe: forbidden, tool: forbidden, choose: forbidden, helper: forbidden, event: () => {}, publish: () => {} });
    assert.match(result, /不自动读取浏览器/);
  }
});
