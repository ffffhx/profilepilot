import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const ids = [];
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks' }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  for (const status of ['paused', 'completed']) {
    const task = store.create({ prompt: 'DeepSeek 计价修复验收', profileId: 'isolated:fixture' }, '测试浏览器');
    ids.push(task.id); task.status = status;
    Object.assign(task.usage, { inputTokens: 5145085, outputTokens: 50339, costUsd: 0.113587176 });
    task.cachedInputTokens = 4808448;
    task.costAccounting = { version: 'deepseek-2026-09-24', sessionId: 'fixture', sdkUsd: 5.345884, originalUsd: 5.345884 };
    task.result = { summary: '此前费用估算使用了错误单价，现已校正。', evidence: [], remaining: [] };
  }
  store.save();
} });
try {
  const d = app.driver;
  await d.domClick(`[data-task="${ids[0]}"]`);
  const toggle = await d.query('[aria-controls="task-inspector"]');
  if (toggle.attributes['aria-expanded'] !== 'true') await d.domClick('[aria-controls="task-inspector"]');
  const info = (await d.query('#task-inspector')).text;
  assert.match(info, /主模型估算费用/); assert.match(info, /\$0\.114/); assert.match(info, /93\.5%/); assert.match(info, /\$5/);
  assert.match(info, /峰谷价格/); assert.match(info, /账单为准/);
  assert.doesNotMatch(info, /\$5\.346|Reached maximum budget/);
  await d.domClick(`[data-task="${ids[1]}"]`);
  await d.domClick('#history-details summary');
  assert.match((await d.query('#history-details')).text, /主模型估算 \$0\.114/);
  assert.match((await d.query('#history-details')).text, /93\.5%/);
  const dir = path.join(repoRoot, 'test-results/browser-tasks'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'task-pricing.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  console.log('PASS pricing in active/history UI, original $5 budget, cache rate and estimate description');
} finally { await app.stop(); }
