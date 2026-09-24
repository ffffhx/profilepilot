// Uses the configured real model with the production SDK worker and terminal
// tools. Browser observation is a fixture; no personal browser tabs are touched.
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { loadConfiguredTaskProvider } from './task-provider-fixture.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const provider = await loadConfiguredTaskProvider();
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-terminal-live-'));
const store = new TaskStore(root);
store.data.settings = { ...store.data.settings, ...provider.settings, jevEnabled: false, notifications: false };
const calls = [];
const service = new TaskService(store, {
  apiKey: () => provider.apiKey, profileName: async () => '终端验收（无真实浏览器）', prepareProfile: async () => ({ name: '终端验收' }), changed: () => {}, notify: () => {},
  browser: { control: async () => {}, tabs: async () => [], observe: async () => ({ version: 'fixture-1', fingerprint: 'fixture-1', url: 'about:blank', title: '终端工具验收', snapshot: '这是验收夹具的空白页；本任务只生成本地网页，无需访问真实浏览器。', at: new Date().toISOString() }) }
});
const handle = service.handleTool.bind(service);
service.handleTool = async (task, run, name, args) => { calls.push(name); console.log(`tool: ${name}`); return handle(task, run, name, args); };
let task;
try {
  task = await service.create({ profileId: 'terminal-fixture', prompt: '验收新终端工具：仅在当前任务目录工作。用 export_result 生成名为 terminal-check.html 的真正 HTML，包含标题“终端能力验收成功”；用 terminal_run 的内置 node runtime 将文件复制到工作目录，再启动只监听 127.0.0.1 随机端口的后台 HTTP 服务。再用独立 terminal_run HTTP 请求验证 200 和标题，打印验证结果。用 finish 完成并给出网址及终端验证 evidence，保持后台服务运行。本次浏览器是空白验收夹具，不要使用 browser_action；不要访问其他文件、账户、网站或系统设置。', limits: { minutes: 3, actions: 20, budgetUsd: 0.5 } });
  const deadline = Date.now() + 170000;
  while (Date.now() < deadline && (['queued', 'running'].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(task.status, 'completed', JSON.stringify({ status: task.status, result: task.result, events: task.events.slice(-4).map(e => e.text) }));
  assert.equal(service.runs.has(task.id), false, 'SDK worker must finish');
  assert.ok(calls.includes('terminal_run')); assert.ok(calls.includes('export_result')); assert.ok(calls.includes('finish'));
  const artifact = task.outputs.find(file => file.name === 'terminal-check.html'); assert.ok(artifact);
  const html = await readFile(artifact.path, 'utf8'); assert.ok(html.includes('终端能力验收成功'));
  const jobs = service.terminal.list(task.id);
  const background = jobs.find(job => job.background && job.status === 'running'); assert.ok(background, 'background server still running after SDK exit');
  const url = [...jobs.map(job => job.stdout), task.result.summary].join('\n').match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; assert.ok(url);
  const response = await fetch(url); assert.equal(response.status, 200); assert.ok((await response.text()).includes('终端能力验收成功'));
  await service.close(); await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  const evidence = { passed: true, at: new Date().toISOString(), model: provider.settings.model, browser: 'fixture, no real tabs used', calls,
    artifact: artifact.name, backgroundSurvivedSdkExit: true, httpStatus: 200, stoppedOnAppClose: true, usage: task.usage };
  await mkdir('test-results/browser-tasks', { recursive: true });
  await writeFile('test-results/browser-tasks/terminal-live-result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await service.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
