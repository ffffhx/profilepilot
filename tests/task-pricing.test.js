const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepseekPeak, priceDeepseek, providerPricing } = require('../dist/main/tasks/pricing');
const { costBaseline, applyPricedCost, legacyCostCorrection } = require('../dist/main/tasks/cost-accounting');
const { TaskStore } = require('../dist/main/tasks/store');

test('DeepSeek prices uncached input, cache hits and output at separate published rates', () => {
  const usage = { inputTokens: 1000000, cacheReadInputTokens: 1000000, outputTokens: 1000000, cacheCreationInputTokens: 0 };
  assert.equal(priceDeepseek('deepseek-flash', usage, new Date('2026-09-23T14:00Z')), 0.753);
  assert.equal(priceDeepseek('deepseek-flash', usage, new Date('2026-09-24T02:00Z')), 1.506);
  assert.equal(priceDeepseek('deepseek-v4-pro', usage, new Date('2026-09-24T02:00Z')), 5.324);
  assert.equal(priceDeepseek('unrecognized-model', usage, new Date()), undefined);
  assert.equal(priceDeepseek('deepseek-flash', { ...usage, inputTokens: -1 }, new Date()), undefined);
});

test('peak periods use UTC and China holidays regardless of machine timezone', () => {
  for (const at of ['2026-09-24T01:00Z', '2026-09-24T03:59Z', '2026-09-24T06:00Z', '2026-09-24T09:59Z']) assert.equal(deepseekPeak(new Date(at)), true, at);
  for (const at of ['2026-09-24T00:59Z', '2026-09-24T04:00Z', '2026-09-24T10:00Z', '2026-09-25T02:00Z', '2026-09-26T02:00Z', '2026-10-01T02:00Z']) assert.equal(deepseekPeak(new Date(at)), false, at);
});

test('official DeepSeek rates are never applied to an arbitrary compatible gateway', () => {
  const settings = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic' };
  assert.ok(providerPricing(settings)?.modelPricing.overrides['deepseek-flash']);
  for (const url of ['https://proxy.example/anthropic', 'http://api.deepseek.com', 'https://api.deepseek.com:1234', 'https://api.deepseek.com.evil.test', 'bad url']) assert.equal(providerPricing({ ...settings, baseUrl: url }), undefined);
  assert.equal(providerPricing({ ...settings, model: 'custom-model' }), undefined);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-price-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const task = store.create({ prompt: 'pricing fixture', profileId: 'fixture' }, 'Fixture');
  task.status = 'paused'; task.sdkSessionId = 'fixture-session';
  task.modelRuns = [{ id: 'deepseek-flash', endpoint: 'https://api.deepseek.com', at: '2026-09-23T14:00:00Z' }];
  task.result = { summary: 'Reached maximum budget ($0.287378)', evidence: ['preserved'], remaining: ['continue'] };
  const values = [
    ['2026-09-23T14:42:32.673Z', 174685, 23917, 4071296, 3.506998],
    ['2026-09-23T14:55:33.017Z', 208310, 44427, 4628992, 4.466721],
    ['2026-09-23T15:04:04.448Z', 226934, 47008, 4805504, 4.712622],
    ['2026-09-24T02:35:52.942Z', 336637, 50339, 4808448, 5.345884]
  ];
  const rows = values.flatMap(([timestamp, inputTokens, outputTokens, cacheReadInputTokens, totalCostUSD]) => [
    { type: 'assistant', timestamp },
    { type: 'cost-state', sessionId: task.sdkSessionId, totalCostUSD, hasUnknownModelCost: true,
      modelUsage: { 'deepseek-flash': { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens: 0 } } }
  ]);
  const dir = path.join(root, 'sessions', task.id, 'projects', 'fixture'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, task.sdkSessionId + '.jsonl'); fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n'));
  Object.assign(task.usage, { inputTokens: 5145085, outputTokens: 50339, costUsd: 5.345884 }); store.save();
  return { root, store, task, file, rows };
}

test('legacy repair backs up exact store, retains session and budget, and runs only once', t => {
  const { root, store, task, file } = fixture(t), before = fs.readFileSync(store.file, 'utf8'), transcript = fs.readFileSync(file, 'utf8');
  const repaired = new TaskStore(root), fixed = repaired.get(task.id);
  assert.equal(fixed.usage.costUsd, 0.113587176); assert.equal(fixed.cachedInputTokens, 4808448);
  assert.equal(fixed.costAccounting.sdkUsd, 5.345884); assert.equal(fixed.limits.budgetUsd, 5);
  assert.equal(repaired.data.tokenRecords.find(r => r.taskId === task.id).sdkCostUsd, fixed.usage.costUsd);
  assert.equal(fixed.status, 'paused'); assert.equal(fixed.sdkSessionId, task.sdkSessionId); assert.equal(fixed.sessionId, task.sessionId);
  assert.deepEqual(fixed.result.evidence, ['preserved']); assert.match(fixed.result.summary, /已校正/);
  const backup = fs.readdirSync(root).filter(f => f.includes('before-pricing'));
  assert.equal(backup.length, 1); assert.equal(fs.readFileSync(path.join(root, backup[0]), 'utf8'), before);
  assert.equal(fs.readFileSync(file, 'utf8'), transcript, 'do not rewrite SDK conversation');
  const again = new TaskStore(root).get(task.id);
  assert.equal(again.usage.costUsd, fixed.usage.costUsd); assert.equal(again.events.length, fixed.events.length);
  assert.equal(fs.readdirSync(root).filter(f => f.includes('before-pricing')).length, 1);
});

test('missing, corrupt, mixed-provider and mismatched histories are left unchanged', t => {
  const { root, task, file } = fixture(t);
  const initial = JSON.stringify(task);
  task.modelRuns.push({ id: 'deepseek-flash', endpoint: 'https://proxy.example' });
  assert.equal(legacyCostCorrection(root, task), undefined); task.modelRuns.pop();
  task.usage.costUsd += 1; assert.equal(legacyCostCorrection(root, task), undefined); task.usage.costUsd -= 1;
  fs.appendFileSync(file, '\n{partial'); assert.equal(legacyCostCorrection(root, task), undefined);
  fs.unlinkSync(file); assert.equal(legacyCostCorrection(root, task), undefined);
  assert.equal(JSON.stringify(task), initial);
});

test('resume adds only new spend, never restoring guessed history or counting a result twice', () => {
  const task = { sdkSessionId: 'same', usage: { costUsd: 0.113587176 }, costAccounting: { version: 'deepseek-2026-09-24', sessionId: 'same', sdkUsd: 5.345884 } };
  const baseline = costBaseline(task);
  applyPricedCost(task, baseline, 5.355884, 'deepseek-2026-09-24');
  assert.equal(task.usage.costUsd, 0.123587176);
  applyPricedCost(task, baseline, 5.355884, 'deepseek-2026-09-24'); assert.equal(task.usage.costUsd, 0.123587176);
  applyPricedCost(task, costBaseline(task), 0); assert.equal(task.costAccounting.sdkUsd, 5.355884);
  const next = costBaseline(task); task.sdkSessionId = 'new';
  applyPricedCost(task, next, 0.02, 'deepseek-2026-09-24'); assert.equal(task.usage.costUsd, 0.143587176);
  applyPricedCost(task, costBaseline(task), 0.01, 'deepseek-2026-09-24'); assert.equal(task.usage.costUsd, 0.153587176);
});

test('providers without corrected history keep SDK accounting', () => {
  const task = { sdkSessionId: 'plain', usage: { costUsd: 2 } }, baseline = costBaseline(task);
  applyPricedCost(task, baseline, 3); applyPricedCost(task, baseline, 2);
  assert.equal(task.usage.costUsd, 3); assert.equal(task.costAccounting, undefined);
});

test('task runtime resumes repaired conversation and preserves a real budget pause', async t => {
  const { EventEmitter } = require('node:events');
  const { TaskService } = require('../dist/main/tasks/service');
  const { root, task: original } = fixture(t), store = new TaskStore(root), task = store.get(original.id);
  let child, start;
  const service = new TaskService(store, { apiKey: () => 'fixture', profileName: async () => 'Fixture', prepareProfile: async () => ({ name: 'Fixture', port: 9223 }),
    changed() {}, notify() {}, browser: { control: async () => {} }, worker: (_task, input) => {
      start = input; child = new EventEmitter(); child.connected = true; child.exitCode = null; child.signalCode = null;
      child.send = message => { if (message.kind === 'stop') queueMicrotask(() => { child.connected = false; child.exitCode = 0; child.emit('exit', 0); }); };
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); }; return child;
    } });
  try {
    task.status = 'queued'; await service.tick(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(start, 'corrected task passes original budget guard');
    assert.equal(start.task.sdkSessionId, original.sdkSessionId); assert.equal(start.task.limits.budgetUsd, 5);
    child.emit('message', { kind: 'result', costUsd: 10.345884, priceVersion: 'deepseek-2026-09-24', inputTokens: 5145085, outputTokens: 50339, budgetExceeded: true });
    assert.equal(task.status, 'paused'); assert.match(task.result.summary, /\$5\.00 上限/);
    assert.equal(task.usage.costUsd, 5.113587176); assert.doesNotMatch(task.result.summary, /Reached maximum budget/);
  } finally { await service.close(); }
});
