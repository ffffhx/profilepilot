import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const { TaskStore } = createRequire(import.meta.url)('../dist/main/tasks/store');
let taskId;
const app = await launchProfilePilotE2e({ name: 'Agent-only zoom', prepareFixture: async ({ dataDir }) => {
  const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
  const task = store.create({ profileId: 'zoom-fixture', prompt: '检查 Agent 独立缩放，其他页签保持原来的大小。' }, '测试浏览器');
  taskId = task.id;
  task.status = 'completed';
  store.event(task, 'assistant', Array.from({ length: 48 }, (_, i) => `段落 ${i + 1}：中文与 English、长对话和底部输入框都应正常显示。`).join('\n\n'));
  store.save();
} });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const paint = () => shell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
const modifier = process.platform === 'darwin' ? 'meta' : 'control';
const navigate = async id => {
  await shell(`window.workspaceHost.navigate(${JSON.stringify(id === 'browser' ? 'index.html' : `${id === 'agent' ? 'tasks' : id}.html`)})`);
  await d.waitFor(`html[data-workspace="${id}"][data-workspace-loading="false"]`, s => s.exists, { target: 'shell' });
  await paint();
};
const shellGeometry = () => shell(`(() => {
  const rail=document.querySelector('.workspace-rail').getBoundingClientRect(), header=document.querySelector('.workspace-identity').getBoundingClientRect();
  return { width:innerWidth, height:innerHeight, dpr:devicePixelRatio, rail:rail.toJSON(), header:header.toJSON() };
})()`);
const pageGeometry = () => d.evaluate(`({width:innerWidth,height:innerHeight,font:getComputedStyle(document.body).fontSize,root:document.documentElement.getBoundingClientRect().toJSON()})`);
const zoom = () => shell(`Number(document.querySelector('iframe[data-workspace="agent"]').dataset.zoom)`);
const press = async (key, shift = false) => {
  const result = await d.request('workspaceZoomShortcut', { keyCode: key, modifiers: [modifier, ...(shift ? ['shift'] : [])] });
  assert.equal(result.prevented, true, 'native whole-window zoom is intercepted');
  assert.equal(result.windowZoom, 1, 'native window zoom stays at the default');
  await paint();
};
const layout = async () => {
  const bounds = await shell(`(() => {
    const f=document.querySelector('iframe[data-workspace="agent"]'), area=document.querySelector('#workspace-pages');
    return { frame:f.getBoundingClientRect().toJSON(), area:area.getBoundingClientRect().toJSON() };
  })()`);
  for (const edge of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(bounds.frame[edge] - bounds.area[edge]) < 2, `Agent ${edge} stays inside its content viewport`);
  const state = await d.evaluate(`(() => {
    const w=document.querySelector('.workspace'), editor=document.querySelector('#steering'), bar=document.querySelector('.task-followup-actions');
    const footer=document.querySelector('.history-footer').getBoundingClientRect();
    return { overflow:document.documentElement.scrollWidth>innerWidth+1, documentScroll:document.scrollingElement.scrollHeight>innerHeight+1,
      bottom:footer.bottom, height:innerHeight, editor:editor.value, toolbarOverflow:bar.scrollWidth>bar.clientWidth+1,
      conversationScroll:w.scrollHeight>w.clientHeight };
  })()`);
  assert.equal(state.overflow, false);
  assert.equal(state.documentScroll, false);
  assert.equal(state.toolbarOverflow, false);
  assert.ok(state.bottom <= state.height + 1);
  assert.equal(state.editor, '缩放后保留这份草稿');
  assert.equal(state.conversationScroll, true);
};

try {
  const otherPages = ['browser', 'phones', 'tools', 'local-apps', 'settings'];
  const original = new Map();
  for (const id of otherPages) { await navigate(id); original.set(id, await pageGeometry()); }
  await navigate('agent');
  await d.domClick(`[data-task="${taskId}"]`);
  await d.waitFor('#steering');
  await d.domInput('#steering', '缩放后保留这份草稿');
  await d.evaluate('document.querySelector("#steering").focus({preventScroll:true}); true');
  const chrome = await shellGeometry();
  assert.equal(await zoom(), 100);
  // The full native handler/IPC path, without injecting desktop input.
  await press('='); assert.equal(await zoom(), 110);
  await press('-'); assert.equal(await zoom(), 100);
  await press('-'); assert.equal(await zoom(), 90);
  await press('0'); assert.equal(await zoom(), 100);
  await press('+', true);
  assert.equal(await zoom(), 110);
  for (let i = 0; i < 6; i++) await press('=');
  assert.equal(await zoom(), 150, 'zoom has an upper bound');
  await layout();
  assert.deepEqual(await shellGeometry(), chrome, 'native window and navigation keep their original scale');
  for (const id of otherPages) {
    await navigate(id);
    assert.deepEqual(await pageGeometry(), original.get(id), `${id} does not inherit Agent zoom`);
    await press('='); await press('-'); await press('0');
    assert.deepEqual(await pageGeometry(), original.get(id), `${id} ignores Agent zoom shortcuts`);
    assert.equal(await zoom(), 150, 'shortcuts outside Agent do not change its saved preference');
    assert.deepEqual(await shellGeometry(), chrome);
  }
  await navigate('agent');
  assert.equal(await zoom(), 150, 'Agent retains zoom after switching tabs');
  for (const [width, height] of [[1000, 720], [1440, 1000]]) {
    await d.request('resize', { width, height }); await paint();
    await layout();
  }
  const output = path.join(repoRoot, 'test-results', 'workspace-zoom');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'agent-150.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  for (let i = 0; i < 9; i++) await press('-');
  assert.equal(await zoom(), 80, 'zoom has a lower bound');
  await layout();
  await writeFile(path.join(output, 'agent-80.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  await shell('location.reload(); true');
  await d.waitFor('.workspace-link', s => s.exists, { target: 'shell' });
  await navigate('agent');
  assert.equal(await zoom(), 80, 'Agent zoom survives reload');
  await press('0'); assert.equal(await zoom(), 100);
  assert.equal(await shell(`localStorage.getItem('profilepilot-agent-zoom')`), '100');
  console.log('PASS Agent-only native zoom: Ctrl/Cmd +/−/0, bounds, persistence, drafts, small/large windows, unchanged tabs and desktop chrome');
} finally { await app.stop(); }
