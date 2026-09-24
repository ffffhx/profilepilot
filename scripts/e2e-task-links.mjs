import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
let taskId;
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks' }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  const task = store.create({ prompt: '打开网站 http://localhost:8080/', profileId: 'isolated:fixture' }, '测试浏览器');
  taskId = task.id; task.status = 'completed';
  task.result = { summary: 'HTML 网站已运行。\n地址：http://localhost:8080/（点击打开）\n来源：https://example.com/?a=1&b=2。', evidence: ['https://example.com/proof'], remaining: [] };
  task.events.push({ id: 'progress', kind: 'assistant', text: '检查 http://localhost:8080/', at: new Date().toISOString() });
  store.save();
} });
try {
  const d = app.driver;
  await d.domClick(`[data-task="${taskId}"]`);
  const selector = '.history-answer-body a[data-task-link]';
  const link = await d.query(selector);
  assert.equal(link.text, 'http://localhost:8080/');
  assert.equal(link.attributes.href, 'http://localhost:8080/');
  assert.equal(link.attributes.target, '_blank');
  const style = await d.evaluate(`getComputedStyle(document.querySelector('${selector}')).textDecorationLine`);
  assert.match(style, /underline/);
  assert.equal(await d.evaluate('document.querySelectorAll(".history-answer-body a[data-task-link]").length'), 3);
  // The real preload + IPC must reject a tampered URL without navigating or
  // spawning an Electron child window. Valid external URLs are tested at IPC.
  const original = await d.evaluate('location.href');
  const windows = (await d.windows()).length;
  await d.evaluate(`document.querySelector('${selector}').href = 'javascript:window.badLinkExecuted=true'`);
  await d.domClick(selector);
  await d.waitFor('body', snapshot => /只能打开有效的 HTTP/.test(snapshot.text));
  assert.equal(await d.evaluate('location.href'), original);
  assert.equal(await d.evaluate('Boolean(window.badLinkExecuted)'), false);
  assert.equal((await d.windows()).length, windows);
  await d.evaluate(`document.querySelector('${selector}').href = 'http://localhost:8080/'`);
  const dir = path.join(repoRoot, 'test-results/browser-tasks'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'task-links.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  console.log('PASS task result/progress URLs, link styling, safe external dispatch and preserved app window');
} finally { await app.stop(); }
