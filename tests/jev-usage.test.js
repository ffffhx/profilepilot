const test = require('node:test');
const assert = require('node:assert/strict');
const { beginJevCall, finishJevCall } = require('../dist/main/tasks/jev-usage');
const { renderJevProgress } = require('../dist/renderer/task-progress');

test('in-flight and interrupted decisions do not dilute the response average', () => {
  const task = { usage: {} };
  const first = beginJevCall(task, 'driver');
  finishJevCall(task, first, { elapsedMs: 1921, inputTokens: 5523, note: '<untrusted>' });
  const second = beginJevCall(task, 'driver');
  assert.equal(task.usage.jev.calls, 2);
  assert.equal(task.usage.jev.completedCalls, 1);
  finishJevCall(task, second);
  assert.equal(second.status, 'interrupted');
  assert.equal(task.usage.jev.elapsedMs, 1921);
  assert.equal(task.usage.jev.completedCalls, 1);
  const html = renderJevProgress(task);
  assert.match(html, /1\.9 秒/);
  assert.match(html, /5,523 token/);
  assert.match(html, /&lt;untrusted&gt;/);
  assert.doesNotMatch(html, /<untrusted>/);
});

test('old aggregate data survives the first new decision and settling is idempotent', () => {
  const task = { usage: { jev: { calls: 4, elapsedMs: 7685, inputTokens: 22094 } } };
  const record = beginJevCall(task, 'driver');
  finishJevCall(task, record, { elapsedMs: 1000, inputTokens: 10 });
  finishJevCall(task, record, { elapsedMs: 1000, inputTokens: 10 });
  assert.equal(task.usage.jev.completedCalls, 5);
  assert.equal(task.usage.jev.elapsedMs, 8685);
});
