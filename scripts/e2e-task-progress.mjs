import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";
const require = createRequire(import.meta.url);
const { TaskStore } = require("../dist/main/tasks/store");
let taskId;
const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: "tasks" }, prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, "browser-tasks"));
  const task = store.create({ prompt: "查看已有投递记录，核对当前账号", profileId: "isolated:fixture" }, "任务预览浏览器");
  taskId = task.id; task.status = "waiting_user";
  task.modelRuns = [{ id: "kimi-k3", endpoint: "https://api.moonshot.cn", at: new Date().toISOString() }];
  task.pending = { id: "question", kind: "question", title: "请确认当前账号入口", details: "页面尚未显示可核对的投递记录。补充入口后继续。", createdAt: new Date().toISOString() };
  task.usage.jev = { calls: 4, completedCalls: 4, elapsedMs: 7685, inputTokens: 22094 };
  task.usage.jevActions = 0;
  task.execution = { engine: "model", activity: "检查账号入口", at: new Date().toISOString(), reason: "Jev 对下一步不够确定，已转交主模型。" };
  task.jevDecisions = [0, 1, 2, 3].map(i => ({ at: new Date().toISOString(), mode: "driver", status: "completed", elapsedMs: 1921, inputTokens: 5523, confidence: 0.6, note: "页面入口不明确，转交主模型。", outcome: "转交主模型" }));
  task.events = Array.from({ length: 45 }, (_, i) => ({ id: `event-${i}`, at: new Date().toISOString(), kind: "system", text: `观察记录 ${i + 1}：检查当前页面与账号入口。` }));
  store.save();
} });
try {
  const d = app.driver;
  assert.equal((await d.windows()).main.visible, false);
  assert.equal((await d.windows()).main.focused, false);
  await d.domClick(`[data-task="${taskId}"]`);
  await d.waitFor(".jev-progress");
  assert.equal(await d.evaluate('getComputedStyle(document.querySelector("#events")).overflowY'), 'visible');
  assert.equal(await d.evaluate('getComputedStyle(document.querySelector("#events")).maxHeight'), 'none');
  assert.ok(await d.evaluate('document.querySelector(".workspace").scrollHeight > document.querySelector(".workspace").clientHeight'));
  const atBottom = () => d.evaluate('(() => { const w = document.querySelector(".workspace"); return w.scrollHeight - w.clientHeight - w.scrollTop < 2; })()');
  assert.equal(await atBottom(), true, 'opening a conversation shows its latest messages');
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:true}))');
  assert.equal(await atBottom(), true, 'updates keep following when already at the bottom');
  assert.match((await d.query('.model-info')).text, /Kimi · kimi-k3/);
  assert.match((await d.query('.decision-explanation')).text, /Kimi · kimi-k3/);
  assert.equal(await d.evaluate('Boolean(document.querySelector(".browser-live canvas"))'), true);
  assert.equal(await d.evaluate('Boolean(document.querySelector("img.preview"))'), false);
  assert.match((await d.query(".decision-metrics")).text, /1\.9 秒/);
  assert.match((await d.query(".decision-metrics")).text, /22,094 token/);
  assert.equal(await d.evaluate('document.querySelector("#events").lastElementChild.id === "reply-task"'), true);
  await d.evaluate(`(() => { const field = document.querySelector('#answer'); field.value = '保留已经完成的步骤'; field.focus(); field.setSelectionRange(2, 5); document.querySelector('.workspace').scrollTop = 80; })()`);
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:false}))');
  const preserved = await d.evaluate(`({ value: document.querySelector('#answer').value, start: document.querySelector('#answer').selectionStart, scroll: document.querySelector('.workspace').scrollTop, focused: document.activeElement.id })`);
  assert.equal(preserved.value, '保留已经完成的步骤'); assert.equal(preserved.start, 2); assert.equal(preserved.focused, 'answer'); assert.equal(preserved.scroll, 80);
  await d.dispatch('#answer', 'compositionstart');
  await d.evaluate(`window.__compositionField = document.querySelector('#answer'); window.__compositionField.value = '正在输入中文';`);
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:true}))');
  assert.equal(await d.evaluate('window.__compositionField === document.querySelector("#answer")'), true);
  await d.dispatch('#answer', 'compositionend');
  await d.waitFor('#answer', s => s.value === '正在输入中文');
  await d.domClick('#jev-decision-details summary');
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:false}))');
  assert.equal(await d.evaluate('document.querySelector("#jev-decision-details").open'), true);
  const dir = path.join(repoRoot, 'test-results', 'browser-tasks'); await mkdir(dir, { recursive: true });
  async function screenshot(name) {
    await d.evaluate('document.querySelector(".workspace").scrollTop = 0; document.querySelector(".thread-inspector").scrollTop = 0');
    await d.screenshot();
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(path.join(dir, name), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  }
  assert.equal((await d.query('#task-inspector-toggle')).attributes['aria-expanded'], 'true');
  const expandedWidth = await d.evaluate('document.querySelector(".thread-main").getBoundingClientRect().width');
  await screenshot('task-progress.png');
  await d.evaluate(`window.__replyField = document.querySelector('#answer'); window.__replyField.value = '补充入口稍后发送'; document.querySelector('.workspace').scrollTop = 80;`);
  await d.domClick('#task-inspector-toggle');
  assert.equal((await d.query('#task-inspector-toggle')).attributes['aria-expanded'], 'false');
  assert.equal(await d.evaluate('getComputedStyle(document.querySelector("#task-inspector")).display'), 'none');
  assert.equal(await d.evaluate('document.querySelector("#task-inspector [data-control=cancel]").getClientRects().length'), 0);
  assert.equal(await d.evaluate('window.__replyField === document.querySelector("#answer")'), true);
  assert.equal(await d.evaluate('document.querySelector("#answer").value'), '补充入口稍后发送');
  assert.equal(await d.evaluate('document.querySelector(".workspace").scrollTop'), 80);
  if (await d.evaluate('innerWidth > 1080')) {
    assert.ok(await d.evaluate('document.querySelector(".thread-main").getBoundingClientRect().width') > expandedWidth);
  }
  await screenshot('task-sidebar-collapsed.png');
  // A task update must keep the chosen visibility and the reply draft.
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:true}))');
  assert.equal(await d.evaluate('document.querySelector("#task-inspector").hidden'), true);
  assert.equal(await d.evaluate('document.querySelector("#answer").value'), '补充入口稍后发送');
  await d.domClick('[data-action=back]');
  await d.domClick(`[data-task="${taskId}"]`);
  assert.equal(await d.evaluate('document.querySelector("#task-inspector").hidden'), true);
  // Recreate the renderer to check persistence beyond in-memory task navigation.
  await d.evaluate(`document.body.dataset.reloadProbe = 'true'; setTimeout(() => { location.href = './tasks.html?task=${taskId}'; }, 0)`);
  await d.waitFor('body:not([data-reload-probe]) #task-inspector-toggle');
  assert.equal(await d.evaluate('document.querySelector("#task-inspector").hidden'), true);
  await d.evaluate('document.querySelector("#task-inspector-toggle").focus({ preventScroll: true })');
  await d.domClick('#task-inspector-toggle');
  await d.waitFor('#task-inspector-toggle', s => s.attributes['aria-expanded'] === 'true');
  assert.equal(await d.evaluate('document.activeElement.id'), 'task-inspector-toggle');
  assert.equal(await d.evaluate('document.querySelector("#task-inspector").hidden'), false);
  await d.evaluate('document.querySelector(".thread-inspector").scrollTop = 120');
  await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:false}))');
  assert.equal(await d.evaluate('document.querySelector(".thread-inspector").scrollTop'), 120);
  // Electron exposes resizeTo in the isolated test window on Windows and macOS.
  await d.evaluate('window.resizeTo(1000, 800)');
  await d.waitFor('#task-inspector', asyncSnapshot => asyncSnapshot.exists);
  await new Promise(resolve => setTimeout(resolve, 150));
  if (await d.evaluate('innerWidth <= 1080')) {
    assert.equal(await d.evaluate('getComputedStyle(document.querySelector("#task-inspector")).position'), 'fixed');
    assert.equal(await d.evaluate('document.querySelector("#task-inspector").getBoundingClientRect().right <= innerWidth'), true);
    await screenshot('task-sidebar-narrow.png');
    await d.domClick('#task-inspector-toggle');
    assert.equal(await d.evaluate('document.querySelector("#task-inspector").getClientRects().length'), 0);
  }
  await writeFile(path.join(dir, 'task-progress-result.json'), JSON.stringify({ passed: true, checks: ['metric formatting', 'reply in conversation flow', 'single workspace scroll preserved', 'text and selection preserved', 'IME composition preserved', 'decision details preserved', 'sidebar visibility and content expansion', 'reply draft unchanged by toggle', 'preference survives navigation and reload', 'toggle focus retained', 'sidebar scroll preserved', 'narrow layout'] }, null, 2));
  console.log('PASS task progress: metrics, request priority, scroll, focus, IME, sidebar visibility, draft preservation, persistent preference and toggle focus');
  assert.ok((await d.windows()).all.every(window => !window.visible && !window.focused));
} finally {
  await app.stop({ removeFixture: false });
  assert.ok(path.resolve(app.fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(app.fixtureRoot, { recursive: true, force: true, maxRetries: 0 }).catch(error => {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
}
