const test = require('node:test');
const assert = require('node:assert/strict');
const { recordTaskModel, modelLabel } = require('../dist/shared/task-model');
const { renderExecutionStatus, renderModelInfo, renderJevProgress } = require('../dist/renderer/task-progress');
test('actual execution model is frozen, model changes are retained, credentials are excluded', () => {
  const task = { status: 'running', usage: { jev: { calls: 1, completedCalls: 1, elapsedMs: 1900, inputTokens: 20 } }, execution: { engine: 'model', activity: '主模型继续处理', reason: 'Jev 转交主模型', at: new Date().toISOString() } };
  const settings = { model: 'kimi-k3', baseUrl: 'https://user:secret@api.example.test/anthropic?key=hidden' };
  recordTaskModel(task, settings); recordTaskModel(task, settings);
  assert.equal(task.modelRuns.length, 1); assert.equal(task.modelRuns[0].endpoint, 'https://api.example.test');
  settings.model = 'claude-example';
  assert.match(renderExecutionStatus(task), /Kimi · kimi-k3 正在执行/);
  assert.match(renderModelInfo(task, settings), /Kimi · kimi-k3/);
  assert.match(renderJevProgress(task), /Jev 转交Kimi · kimi-k3/);
  assert.doesNotMatch(JSON.stringify(task), /secret|hidden/);
  recordTaskModel(task, settings); assert.equal(task.modelRuns.length, 2);
  assert.match(renderModelInfo(task, settings), /模型变更记录/);
  assert.match(renderExecutionStatus(task), /Claude · claude-example/);
});
test('unknown model names remain literal; legacy tasks never claim current settings were their model', () => {
  assert.equal(modelLabel('my-custom-model'), 'my-custom-model');
  assert.equal(modelLabel('moonshot/kimi-example'), 'Kimi · moonshot/kimi-example');
  const settings = { model: 'kimi-k3' };
  assert.doesNotMatch(renderModelInfo({ status: 'completed', usage: {} }, settings), /kimi-k3/);
  assert.match(renderModelInfo({ status: 'waiting_user', usage: {} }, settings), /当前配置/);
  const task = { status: 'running', usage: {}, execution: { engine: 'model' }, modelRuns: [{ id: '<img onerror="bad">' }] };
  assert.doesNotMatch(renderExecutionStatus(task), /<img/);
});
