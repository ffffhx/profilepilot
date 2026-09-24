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
    const task = store.create({ prompt: '长对话滚动验收', profileId: 'isolated:fixture' }, '测试浏览器');
    ids.push(task.id); task.status = status;
    task.events = Array.from({ length: 45 }, (_, i) => ({ id: `scroll-${i}`, at: new Date().toISOString(), kind: i % 3 ? 'system' : 'assistant', text: `消息 ${i + 1}：检查对话滚动以及底部的继续聊天输入框。` }));
  }
  store.save();
} });
try {
  const d = app.driver;
  const metrics = () => d.evaluate(`(() => {
    const root = document.scrollingElement, w = document.querySelector('.workspace');
    return { viewport: innerHeight, documentHeight: root.scrollHeight, documentTop: root.scrollTop,
      workspaceHeight: w.clientHeight, workspaceContent: w.scrollHeight, workspaceTop: w.scrollTop,
      sidebarTop: document.querySelector('.sidebar').getBoundingClientRect().top,
      frameHeight: document.querySelector('.app-frame').getBoundingClientRect().height };
  })()`);
  const assertSingleScroll = async label => {
    const m = await metrics();
    console.log(label, JSON.stringify(m));
    assert.ok(m.documentHeight <= m.viewport + 1, 'document must not gain a second scroll range');
    assert.equal(m.documentTop, 0, 'focusing the composer must not move the whole page');
    assert.equal(m.sidebarTop, 0, 'sidebar stays anchored to the viewport');
    assert.ok(m.workspaceContent > m.workspaceHeight, 'long messages scroll in the workspace');
  };
  for (const [i, id] of ids.entries()) {
    await d.domClick(`[data-task="${id}"]`);
    if (i === 0 && (await d.query('#task-inspector-toggle')).attributes['aria-expanded'] === 'true') await d.domClick('#task-inspector-toggle');
    if (i === 1) await d.domClick('#history-process summary');
    await d.evaluate('document.querySelector("#steering").focus()');
    await d.evaluate('document.querySelector("#steering").scrollIntoView({block:"end"})');
    await assertSingleScroll(i ? 'completed composer' : 'active composer');
    await d.evaluate('window.scrollTo(0, 100000); document.querySelector(".workspace").scrollTop = 100');
    await assertSingleScroll('reading earlier messages');
    await d.evaluate('window.tasks.snapshot().then(({settings}) => window.tasks.saveSettings({...settings,notifications:false}))');
    assert.equal((await metrics()).workspaceTop, 100);
    await assertSingleScroll('after task update');
  }
  await d.evaluate('window.resizeTo(1000, 700)');
  await d.evaluate('document.querySelector("#steering").focus()');
  await assertSingleScroll('shorter window');
  const dir = path.join(repoRoot, 'test-results', 'browser-tasks');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'task-scroll-single.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  console.log('PASS single conversation scroll: active/finished composers, focus, scrollIntoView, updates, smaller window and fixed sidebar');
} finally { await app.stop(); }
