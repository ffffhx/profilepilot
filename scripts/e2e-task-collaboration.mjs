import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const preview = process.argv.includes('--preview');
const output = path.join(repoRoot, 'test-results/browser-tasks');
await mkdir(output, { recursive: true });
let taskId;
const app = await launchProfilePilotE2e({ name: 'task collaboration', env: { CPM_START_VIEW: 'agent' },
  prepareFixture: async ({ dataDir }) => {
    const store = new TaskStore(path.join(dataDir, 'browser-tasks'));
    const task = store.create({ profileId: 'native:fixture', prompt: '请让两个 Agent 分别分析方案与复核结论，再汇总建议。' }, '协作界面预览');
    taskId = task.id; task.status = 'completed'; task.title = '多 Agent 协作 · 界面验收';
    task.agentActivities = [
      { id: 'fixture-researcher', name: 'researcher', role: 'researcher', description: '分析资料，整理可选方案', status: 'completed', summary: '方案 A 便于快速实施；方案 B 更适合后续扩展。已将比较依据发送给 reviewer。', updatedAt: new Date().toISOString() },
      { id: 'fixture-reviewer', name: 'reviewer', role: 'reviewer', description: '交叉复核依据与遗漏', status: 'completed', summary: '已复核 researcher 的比较，补充迁移成本与验证步骤，结果已回传主 Agent。', updatedAt: new Date().toISOString() }
    ];
    store.event(task, 'assistant', '两个子 Agent 已完成分析和交叉复核。我已汇总它们的结论。\n\n这是界面测试数据；实际 SDK 并行、通信、回传与停止由本地运行时测试验证。');
    task.result = { kind: 'answer', summary: '协作界面测试数据', evidence: [], remaining: [] }; store.save();
  }
});
try {
  await app.driver.waitFor('html[data-workspace="agent"][data-workspace-loading="false"]', state => state.exists, { target: 'shell' });
  await app.driver.domClick(`[data-task="${taskId}"]`);
  await app.driver.waitFor('.task-agent-progress');
  const state = await app.driver.query('.task-agent-progress');
  assert.match(state.text, /researcher/); assert.match(state.text, /reviewer/); assert.match(state.text, /已返回/);
  await app.driver.domClick('#agent-result-fixture-researcher summary');
  assert.equal(await app.driver.evaluate('document.querySelector("#agent-result-fixture-researcher").open'), true);
  assert.match((await app.driver.query('#agent-result-fixture-researcher')).text, /方案 A/);
  await app.driver.waitFor('html[data-workspace="agent"][data-workspace-loading="false"]', state => state.exists, { target: 'shell' });
  await app.driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', { target: 'shell' });
  await app.driver.evaluate('document.querySelector(".task-agent-progress").scrollIntoView({block:"start"}); true');
  await app.driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const screenshot = await app.driver.screenshot();
  await writeFile(path.join(output, 'collaboration-ui.png'), Buffer.from(screenshot.pngBase64, 'base64'));
  await writeFile(path.join(output, 'collaboration-ui-result.json'), JSON.stringify({ passed: true, agentsVisible: true, summariesExpandable: true, htmlEscaping: 'covered by unit test' }, null, 2));
  console.log('PASS collaboration desktop UI: names, statuses and expandable reports');
  if (preview) {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/preview.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(await readFile(path.join(output, 'collaboration-ui.png'))); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProfilePilot · 多 Agent 协作预览</title><style>body{margin:0;padding:24px;background:#f5f4f0;color:#202321;font-family:system-ui}main{max-width:1300px;margin:auto}h1{font-size:24px}p{color:#616660}img{width:100%;border:1px solid #ddd;border-radius:12px}</style><main><h1>ProfilePilot · 多 Agent 协作</h1><p>独立运行的桌面应用截图 · 界面测试数据。实际 SDK 的并行、消息、回传、追问及停止已通过本地测试。</p><img src="/preview.png" alt="任务中的子 Agent 名称、完成状态与可展开的返回摘要"></main></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const record = { pid: process.pid, appPid: app.child.pid, url: `http://127.0.0.1:${server.address().port}/`, screenshot: path.join(output, 'collaboration-ui.png') };
    await writeFile(path.join(output, 'collaboration-preview.json'), JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record));
    const stop = async () => { server.closeAllConnections(); server.close(); await app.stop(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else await app.stop();
} catch (error) { console.error(app.output()); await app.stop(); throw error; }
