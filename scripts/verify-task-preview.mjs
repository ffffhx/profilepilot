import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';
const require = createRequire(import.meta.url);
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const { TaskPreviewStream } = require('../dist/main/tasks/preview');
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client');
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const task = { id: randomUUID(), profileId: gateway.id, sessionId: `pp-live-${randomUUID()}`, port: gateway.port, status: 'running', attachments: [] };
const browser = new WrapperBrowser(path.resolve('test-results/browser-tasks'));
const updates = []; const frames = []; let acknowledge = true;
const stream = new TaskPreviewStream(() => task, update => {
  updates.push({ ...update, frame: undefined });
  if (update.frame) {
    frames.push({ id: update.frameId, hash: createHash('sha256').update(update.frame).digest('hex'), url: update.url });
    if (acknowledge) queueMicrotask(() => stream.ack(update.frameId));
  }
});
async function until(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.ok(predicate(), `${label}: ${JSON.stringify(updates.slice(-4))}`);
}
const state = async () => (await requestBrowserGateway({ action: 'status' }, { homeDir: gateway.home })).state.profiles.find(p => p.profileId === task.profileId);
try {
  await browser.execute(task, { kind: 'open', value: fixture.url + '/live', effect: 'read', summary: 'Open live fixture' });
  stream.start();
  await until(() => new Set(frames.map(f => f.hash)).size >= 4, 'page animation should stream without Agent observations');
  assert.equal((await state()).ownerSessionId, task.sessionId);
  console.log('PASS continuous frames without model calls or screenshot polling');
  acknowledge = false;
  await until(() => stream.pendingFrame !== undefined, 'pending frame');
  const count = frames.length;
  await new Promise(r => setTimeout(r, 600));
  assert.equal(frames.length, count, 'renderer backpressure bounds outstanding frames');
  acknowledge = true; stream.ack(frames.at(-1).id);
  await until(() => frames.length > count, 'stream resumes after ack');
  await browser.control(task, 'handoff');
  assert.equal((await state()).ownership, 'user');
  const handedOff = frames.length;
  await until(() => frames.length > handedOff + 2, 'human handoff should retain the live view');
  await assert.rejects(browser.observe(task), /AGENT_USER_IN_CONTROL|用户正在/);
  assert.equal((await state()).ownership, 'user');
  await browser.control(task, 'resume');
  await browser.execute(task, { kind: 'open', value: fixture.url + '/live?second', effect: 'read', summary: 'Change page after return' });
  await until(() => frames.some(f => f.url.endsWith('/live?second')), 'navigation should update the stream');
  console.log('PASS handoff stays live, input remains blocked, return and navigation work');
  const before = await state();
  task.sessionId = 'different-task';
  await until(() => updates.at(-1)?.state === 'unavailable', 'session isolation');
  task.sessionId = before.ownerSessionId;
  await until(() => updates.at(-1)?.state === 'live', 'reconnect same task');
  stream.close(); const stopped = frames.length;
  await new Promise(r => setTimeout(r, 350)); assert.equal(frames.length, stopped);
  assert.equal((await state()).ownerSessionId, task.sessionId);
  assert.equal((await state()).ownership, 'agent');
  console.log('PASS session isolation and closing preview preserves Agent ownership');
  const { TaskStore } = require('../dist/main/tasks/store');
  let viewTaskId;
  const app = await launchProfilePilotE2e({ env: { CPM_START_VIEW: 'tasks', PROFILEPILOT_GATEWAY_HOME: gateway.home }, prepareFixture: async ({ dataDir }) => {
    const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
    const saved = store.create({ profileId: task.profileId, prompt: '查看实时浏览器画面，核对执行模型' }, '实时预览验收浏览器');
    viewTaskId = saved.id; saved.status = 'waiting_user'; saved.port = task.port; saved.sessionId = task.sessionId;
    saved.pending = { id: randomUUID(), kind: 'question', title: '请核对实时画面', details: '页面计数器会持续更新。', createdAt: new Date().toISOString() };
    saved.modelRuns = [{ id: 'kimi-k3', endpoint: 'https://api.moonshot.cn', at: new Date().toISOString() }];
    saved.usage.jev = { calls: 4, completedCalls: 4, elapsedMs: 7685, inputTokens: 22094 };
    saved.execution = { engine: 'model', activity: '核对页面', reason: 'Jev 将复杂判断交给主模型继续处理。', at: new Date().toISOString() };
    store.save();
  } });
  try {
    const d = app.driver;
    await d.domClick(`[data-task="${viewTaskId}"]`);
    let live = false;
    for (let i = 0; i < 80 && !live; i++) {
      live = await d.evaluate('document.querySelector(".live-canvas")?.hidden === false');
      if (!live) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(live, 'Electron task panel must receive and display real streamed frames');
    assert.match((await d.query('.model-info')).text, /Kimi · kimi-k3/);
    assert.match((await d.query('.decision-explanation')).text, /Kimi · kimi-k3/);
    const first = await d.evaluate('document.querySelector(".live-canvas").toDataURL()');
    await new Promise(r => setTimeout(r, 600));
    assert.notEqual(await d.evaluate('document.querySelector(".live-canvas").toDataURL()'), first);
    await d.evaluate('window.__liveCanvas = document.querySelector(".live-canvas"); document.querySelector("#steering").focus(); document.querySelector("#steering").value = "保留已完成步骤";');
    await d.evaluate('window.tasks.snapshot().then(({settings})=>window.tasks.saveSettings({...settings,model:"different-model"}))');
    assert.equal(await d.evaluate('window.__liveCanvas === document.querySelector(".live-canvas")'), true);
    assert.equal(await d.evaluate('document.activeElement.id'), 'steering');
    assert.match((await d.query('.model-info')).text, /Kimi · kimi-k3/);
    const dir = path.join(repoRoot, 'test-results', 'browser-tasks'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'task-live-preview.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
    await d.domClick('[data-action="back"]');
    assert.equal(await d.evaluate('document.querySelector(".live-canvas") === null'), true);
    assert.equal((await state()).ownerSessionId, task.sessionId);
    console.log('PASS Electron live canvas, model identity, frame updates, input focus and snapshot continuity');
  } finally { await app.stop(); }
} finally {
  stream.close(); await browser.control(task, 'complete').catch(() => {});
  await fixture.close(); await gateway.close();
}
