const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist/main/tasks/store');
const { tokenTotals } = require('../dist/shared/task-token-usage');
const { mergeModelTokens, modelTokenTotals, updateTokenRecords } = require('../dist/shared/task-token-usage');

test('model counters retain exact IDs, merge cumulative results once, and preserve unattributed history', () => {
  const models = mergeModelTokens([], [{ model: 'kimi-k3', inputTokens: 100, outputTokens: 20 }, { model: 'deepseek-flash', inputTokens: 50, outputTokens: 10 }]);
  assert.deepEqual(mergeModelTokens(models, models), models);
  const record = { taskId: 'x', createdAt: '', updatedAt: '', inputTokens: 200, outputTokens: 40, models, modelNames: ['kimi-k3', 'deepseek-flash'], jevInputTokens: 0, helperInputTokens: 0, helperOutputTokens: 0 };
  const result = modelTokenTotals([record]);
  assert.equal(result.find(m => m.model === 'kimi-k3').inputTokens, 100);
  assert.equal(result.find(m => m.historical).inputTokens, 50);
  assert.equal(result.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0), 240);
  assert.deepEqual(updateTokenRecords([record], []), [record]);
  const updated = { ...record, models: mergeModelTokens(models, [{ model: 'kimi-k3', inputTokens: 150, outputTokens: 30 }]) };
  assert.equal(modelTokenTotals([updated]).some(m => m.historical), false);
  assert.equal(mergeModelTokens(models, [{ model: 'bad', inputTokens: -1, outputTokens: NaN }]).at(-1).inputTokens, 0);
});

test('token ledger migrates, survives restart and deletion, and does not double-count cumulative usage', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pp-token-'));
  try {
    let store = new TaskStore(dir);
    const task = store.create({ prompt: 'usage test', profileId: 'fixture' }, 'Fixture');
    Object.assign(task.usage, { inputTokens: 1000, outputTokens: 100, jev: { inputTokens: 200, calls: 1, elapsedMs: 0 }, helper: { inputTokens: 50, outputTokens: 20, calls: 1, elapsedMs: 0 } });
    store.save(); store.save();
    assert.deepEqual(tokenTotals(store.data.tokenRecords), { input: 1250, output: 120, total: 1370 });
    assert.equal(tokenTotals(store.data.tokenRecords, 'jev').total, 200);
    assert.equal(tokenTotals(store.data.tokenRecords, 'helper').total, 70);
    store = new TaskStore(dir);
    store.data.tasks[0].usage.inputTokens = 1500;
    store.save();
    assert.equal(tokenTotals(store.data.tokenRecords).total, 1870);
    store.data.tasks = []; store.save();
    store = new TaskStore(dir);
    assert.equal(tokenTotals(store.data.tokenRecords).total, 1870);
    assert.equal(JSON.stringify(store.data.tokenRecords).includes('usage test'), false);
    assert.equal(store.data.tokenRecords.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
