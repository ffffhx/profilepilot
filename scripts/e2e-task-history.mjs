import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const ids = [];
const repeatedError = '退出时交还浏览器失败：Error: ' + JSON.stringify({ source: 'ProfilePilot', error_code: 'GATEWAY_PROFILE_NOT_FOUND', hard_stop: true, session: 'fixture-session', message: '当前 Session 没有受管理的 Profile' }, null, 2);
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks' }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  for (const status of ['cancelled', 'completed', 'failed', 'partial']) {
    const task = store.create({ prompt: '看下我的小红书投递情况，只查看已有投递，不修改或再次投递。', profileId: 'isolated:fixture' }, '求职浏览器');
    task.status = status; ids.push(task.id);
    task.usage.actions = 14; task.usage.elapsedMs = 83000;
    task.events = Array.from({ length: 30 }, (_, i) => ({ id: `event-${i}`, at: new Date().toISOString(), kind: i === 0 ? 'user' : 'system', text: i === 0 ? task.prompt : `检查投递记录，第 ${i} 次页面观察。` }));
    task.events.push(...Array.from({ length: 21 }, (_, i) => ({ id: `error-${i}`, at: new Date().toISOString(), kind: 'error', text: repeatedError })));
    if (status === 'completed') {
      task.events.push({ id: 'previous-result', at: new Date().toISOString(), kind: 'assistant', text: '上次执行结果：' + JSON.stringify({ summary: '之前的回复：已找到记录。', evidence: ['历史页面'], remaining: ['核查日期'] }) });
      task.events.push({ id: 'follow-up', at: new Date().toISOString(), kind: 'user', text: '只补充今天的记录 <保持原样>' });
      task.result = { summary: '已核查已有投递记录。', evidence: ['当前账号的投递页面'], remaining: [] };
    }
    if (status === 'partial') task.usage.actions = task.limits.actions;
  }
  store.save();
} });
try {
  const d = app.driver;
  for (const id of ids) {
    await d.domClick(`[data-task="${id}"]`);
    assert.equal(await d.evaluate('document.querySelector(".browser-live") === null'), true);
    assert.equal(await d.evaluate('document.querySelector("#history-process").open'), false);
    assert.ok((await d.query('.history-answer')).text.length > 30);
    assert.equal(await d.evaluate('document.querySelector(".history-next") === null'), true);
    assert.equal(await d.evaluate('document.querySelector("#steering").disabled'), false);
    assert.equal(await d.evaluate('document.querySelector("#steer-task button[type=submit]").disabled'), true, 'empty messages must not send');
  }
  await d.domClick(`[data-task="${ids[1]}"]`);
  assert.match((await d.query('[aria-label="之前的回复"]')).text, /已找到记录/);
  assert.match((await d.query('[aria-label="用户消息"]')).text, /只补充今天的记录 <保持原样>/);
  await d.domClick(`[data-task="${ids[3]}"]`);
  await d.domInput('#steering', '保留这个发送失败的草稿');
  await d.domClick('#steer-task button[type=submit]');
  await d.waitFor('#task-app', n => n.attributes['aria-busy'] !== 'true');
  assert.match((await d.query('#task-toast')).text, /运行限制/);
  assert.equal(await d.evaluate('document.querySelector("#steering").value'), '保留这个发送失败的草稿');
  await d.domClick(`[data-task="${ids[0]}"]`);
  const dir = path.join(repoRoot, 'test-results', 'browser-tasks'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'task-history.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.domClick('#history-process summary');
  assert.equal(await d.evaluate('document.querySelectorAll(".history-events .event").length'), 31);
  assert.equal(await d.evaluate('document.querySelectorAll(".task-error").length'), 1);
  assert.match((await d.query('.task-error-meta')).text, /21 次，已合并/);
  assert.equal(await d.evaluate('document.querySelector(".task-error-details").open'), false);
  assert.equal(await d.evaluate('document.querySelector(".task-error-details pre").getClientRects().length'), 0);
  assert.equal(await d.evaluate('document.querySelector(".task-error-details pre").textContent'), repeatedError);
  assert.equal(await d.evaluate(`window.tasks.snapshot().then(s => s.tasks.find(t => t.id === '${ids[0]}').events.length)`), 51, 'rendering must preserve diagnostic records');
  await d.domClick('.task-error-details summary');
  assert.equal(await d.evaluate('document.querySelector(".task-error-details").open'), true);
  assert.equal(await d.evaluate('getComputedStyle(document.querySelector(".history-events")).overflowY'), 'visible');
  await d.domClick('#history-details summary');
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:false}))');
  assert.equal(await d.evaluate('document.querySelector("#history-details").open'), true);
  assert.equal(await d.evaluate('document.querySelector(".task-error-details").open'), true);
  await d.domClick('#history-menu summary');
  await d.domClick('[data-action="edit-task"]');
  assert.match(await d.evaluate('document.querySelector("#prompt").value'), /只查看已有投递/);
  assert.equal(await d.evaluate('window.tasks.snapshot().then(s => s.tasks.length)'), 4, 'Editing must not execute a task');
  await d.domClick(`[data-task="${ids[0]}"]`);
  await d.domInput('#steering', '只补充今天的记录');
  await d.domClick(`[data-task="${ids[1]}"]`);
  await d.domClick(`[data-task="${ids[0]}"]`);
  assert.equal(await d.evaluate('document.querySelector("#steering").value'), '只补充今天的记录', 'switching conversations preserves drafts');
  const originalSession = await d.evaluate(`window.tasks.snapshot().then(s => s.tasks.find(t => t.id === ${JSON.stringify(ids[0])}).sessionId)`);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    await d.evaluate('document.querySelector("#steering").setSelectionRange(3, 3)');
    await d.dispatch('#steering', 'keydown', { key: 'Enter', [modifier]: true });
    assert.equal(await d.evaluate('document.querySelector("#steering").value.includes("\\n")'), true);
  }
  await d.domInput('#steering', '只补充今天的记录\n保留原来的结果');
  await d.dispatch('#steering', 'keydown', { key: 'Enter', shiftKey: true });
  await d.dispatch('#steering', 'compositionstart');
  await d.dispatch('#steering', 'keydown', { key: 'Enter' });
  await d.dispatch('#steering', 'compositionend');
  await d.dispatch('#steering', 'keydown', { key: 'Enter', isComposing: true });
  await d.dispatch('#steering', 'keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(await d.evaluate(`window.tasks.snapshot().then(s => s.tasks.find(t => t.id === ${JSON.stringify(ids[0])}).status)`), 'cancelled', 'newlines and IME confirmation must not submit');
  await d.dispatch('#steering', 'keydown', { key: 'Enter' });
  await d.waitFor('#task-app', n => n.attributes['aria-busy'] !== 'true');
  await d.waitFor('.execution-status, #reply-task', s => s.exists);
  assert.match((await d.query('#events .task-error-meta')).text, /21 次，已合并/);
  const resumed = await d.evaluate(`window.tasks.snapshot().then(s => ({ count: s.tasks.length, task: s.tasks.find(t => t.id === ${JSON.stringify(ids[0])}) }))`);
  assert.equal(resumed.count, 4, 'Continue must not create another sidebar session');
  assert.notEqual(resumed.task.status, 'cancelled');
  assert.equal(resumed.task.sessionId, originalSession);
  assert.equal(resumed.task.events.filter(event => event.kind === 'user' && event.text === '只补充今天的记录\n保留原来的结果').length, 1);
  console.log('PASS: history chat composer, preserved conversation, same-session follow-up, Windows/macOS newline keys, IME protection, drafts, failure recovery and collapsed diagnostics');
} finally { await app.stop(); }
