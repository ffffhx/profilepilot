import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const ids = [];
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks' }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  const titles = ['小红书 · 查看已有投递', '快手 · 招聘申请记录', '整理今天的 AI 新闻', '阿里巴巴 · 申请进度'];
  for (let i = 0; i < 16; i++) {
    const task = store.create({ prompt: titles[i] || `历史任务 ${i + 1}`, profileId: 'isolated:fixture' }, '求职浏览器');
    task.status = i === 4 ? 'queued' : [2, 5].includes(i) ? 'paused' : 'completed';
    // Keep the queued fixture waiting without launching a browser or model.
    if (i === 5) task.browserConnection = 'extension';
    task.result = { summary: '已核查已有记录，任务结果已保留。', evidence: [], remaining: [] };
    ids.push(task.id);
  }
  store.data.settings.notifications = false; store.save();
} });
const d = app.driver;
const sidebar = id => `#task-menu-sidebar-${id}`;
const waitMetadata = async (id, condition) => {
  for (let i = 0; i < 60; i++) {
    const task = await d.evaluate(`window.tasks.snapshot().then(s => s.tasks.find(t => t.id === ${JSON.stringify(id)}))`);
    if (condition(task)) {
      await d.waitFor('#task-app[aria-busy="false"]', state => state.exists);
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Task metadata did not reach the expected state');
};
const openMenu = async id => { await d.domClick(sidebar(id)); await d.waitFor('.task-context-menu', state => state.exists); };
try {
  await d.waitFor('.recent-task', state => state.count === 16);
  await d.domClick(`[data-task="${ids[0]}"]`);
  await openMenu(ids[1]);
  assert.match(await d.evaluate('document.querySelector(".page-heading h1").textContent'), /小红书/);
  await d.domClick('[data-menu-action="pin"]');
  await waitMetadata(ids[1], task => !!task.pinnedAt);
  assert.equal(await d.evaluate(`document.querySelector('[data-task-group="pinned"] [data-task]').dataset.task`), ids[1]);
  assert.equal(await d.evaluate('document.querySelectorAll(".recent-task").length'), 16);
  await openMenu(ids[1]);
  // Menu survives normal snapshots without closing or selecting another task.
  await d.evaluate('window.tasks.snapshot().then(s => window.tasks.saveSettings({...s.settings, notifications:false}))');
  assert.equal((await d.query('.task-context-menu')).exists, true);
  await d.evaluate('document.querySelector(".task-context-menu").dispatchEvent(new KeyboardEvent("keydown", {key:"End", bubbles:true}))');
  assert.equal(await d.evaluate('document.activeElement.dataset.menuAction'), 'delete');
  await d.evaluate('document.querySelector(".task-context-menu").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))');
  assert.equal(await d.evaluate('document.activeElement.id'), `task-menu-sidebar-${ids[1]}`);
  assert.equal((await d.query('.task-context-menu')).exists, false);
  await openMenu(ids[1]);
  await d.domClick('[data-menu-action="rename"]');
  await d.domInput('#task-title-input', '  快手 · <投递记录>  ');
  await d.domClick('.task-rename button[type="submit"]');
  await waitMetadata(ids[1], task => task.title === '快手 · <投递记录>');
  assert.equal(await d.evaluate(`document.querySelector('${sidebar(ids[1])}').previousElementSibling.textContent.trim()`), '快手 · <投递记录>');
  await openMenu(ids[1]); await d.domClick('[data-menu-action="archive"]');
  await waitMetadata(ids[1], task => !!task.archivedAt && !task.pinnedAt);
  assert.equal((await d.query(sidebar(ids[1]))).exists, false);
  assert.match(await d.evaluate('document.querySelector(".page-heading h1").textContent'), /小红书/);
  await d.domClick('[data-nav="history"]');
  await d.domClick('[data-task-scope="archived"]');
  assert.equal((await d.query('.task-list-entry')).count, 1);
  await d.domClick(`[data-task="${ids[1]}"]`);
  assert.equal((await d.query('.task-archive-notice')).exists, true);
  await d.domClick('[data-restore-task]');
  await waitMetadata(ids[1], task => !task.archivedAt);
  assert.equal((await d.query(sidebar(ids[1]))).exists, true);
  // Right-click and Shift+F10 work in both Windows and macOS Chromium.
  await d.evaluate(`document.querySelector('[data-task-row="${ids[2]}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:180,clientY:740}))`);
  assert.equal(await d.evaluate('document.querySelector("[data-menu-action=archive]").disabled'), false);
  assert.equal(await d.evaluate('document.querySelector("[data-menu-action=delete]").disabled'), true);
  assert.equal(await d.evaluate('(() => { const r=document.querySelector(".task-context-menu").getBoundingClientRect(); return r.bottom<=innerHeight && r.right<=innerWidth; })()'), true);
  await d.evaluate('document.querySelector(".task-context-menu").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
  for (const [id, status] of [[ids[2], 'paused'], [ids[4], 'queued']]) {
    await openMenu(id); await d.domClick('[data-menu-action="archive"]');
    await d.waitFor('.task-confirm[open]', state => state.exists);
    assert.equal(await d.evaluate('document.querySelector("[data-confirm-action]").textContent'), '停止并归档');
    await d.domClick('.task-confirm button[value="cancel"]');
    await d.waitFor('.task-confirm', state => !state.exists);
    await waitMetadata(id, task => task.status === status && !task.archivedAt);
    await openMenu(id); await d.domClick('[data-menu-action="archive"]');
    await d.domClick('.task-confirm[open] [data-confirm-action]');
    await d.waitFor('.task-confirm', state => !state.exists);
    const archived = await waitMetadata(id, task => !!task.archivedAt && task.status === 'cancelled');
    assert.equal(archived.result.summary, '已核查已有记录，任务结果已保留。');
    assert.equal((await d.query(sidebar(id))).exists, false);
    await d.domClick('[data-nav="history"]'); await d.domClick('[data-task-scope="archived"]');
    await d.domClick(`[data-task="${id}"]`); await d.domClick('[data-restore-task]');
    await waitMetadata(id, task => !task.archivedAt && task.status === 'cancelled');
    assert.equal((await d.query(sidebar(id))).exists, true);
  }
  await d.evaluate(`document.querySelector('[data-task="${ids[0]}"]').dispatchEvent(new KeyboardEvent('keydown', {key:'F10',shiftKey:true,bubbles:true,cancelable:true}))`);
  await d.domClick('[data-menu-action="pin"]'); await waitMetadata(ids[0], task => !!task.pinnedAt);
  // More menu must stay outside the scroll container and inside the viewport.
  await openMenu(ids[0]);
  const artifacts = path.join(repoRoot, 'test-results', 'browser-tasks'); await mkdir(artifacts, { recursive: true });
  await d.screenshot();
  await new Promise(resolve => setTimeout(resolve, 300));
  await writeFile(path.join(artifacts, 'task-organization.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await d.domClick('[data-menu-action="unpin"]'); await waitMetadata(ids[0], task => !task.pinnedAt);
  await openMenu(ids[3]); await d.domClick('[data-menu-action="delete"]');
  await d.domClick('.task-confirm button[value="cancel"]');
  await d.waitFor('.task-confirm', state => !state.exists);
  assert.equal((await d.query(sidebar(ids[3]))).exists, true);
  await openMenu(ids[3]); await d.domClick('[data-menu-action="delete"]');
  await d.domClick('.task-confirm[open] [data-confirm-action]');
  await d.waitFor('.task-confirm', state => !state.exists);
  await d.waitFor(sidebar(ids[3]), state => !state.exists);
  const persisted = JSON.parse(await readFile(path.join(app.dataDir, 'browser-tasks', 'tasks.json'), 'utf8'));
  assert.equal(persisted.tasks.find(task => task.id === ids[1]).title, '快手 · <投递记录>');
  assert.equal(persisted.tasks.length, 15);
  console.log('PASS: sidebar groups, all tasks, pin/unpin, rename, archive/restore, queued/paused stop confirmation, cancelled confirmation, no restart on restore, persistence, keyboard/right-click menus, live refresh, viewport bounds and safe deletion');
} catch (error) {
  console.error(await d.evaluate('({toast:document.getElementById("task-toast")?.textContent,dialogs:[...document.querySelectorAll("dialog")].map(d=>({open:d.open,returnValue:d.returnValue})),busy:document.getElementById("task-app").getAttribute("aria-busy")})').catch(() => null));
  throw error;
} finally { await app.stop(); }
