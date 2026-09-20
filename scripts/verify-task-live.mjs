import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startTaskFixture } from "./browser-task-fixture.mjs";
import { startTaskGatewayFixture } from "./task-gateway-fixture.mjs";
import { loadConfiguredTaskProvider } from "./task-provider-fixture.mjs";
const require = createRequire(import.meta.url);
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { WrapperBrowser } = require("../dist/main/tasks/browser");
const provider = await loadConfiguredTaskProvider();
const root = await mkdtemp(path.join(os.tmpdir(), "pp-live-task-"));
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const store = new TaskStore(root); store.data.settings = { ...store.data.settings, ...provider.settings };
const browser = new WrapperBrowser(path.join(root, "artifacts"));
let lastEvent;
const service = new TaskService(store, { browser, apiKey: () => provider.apiKey, profileName: async () => gateway.name,
  prepareProfile: async () => ({ name: gateway.name, port: gateway.port }),
  changed: snapshot => { const event = snapshot.tasks[0]?.events.at(-1); if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(event.kind, event.text.replaceAll(provider.apiKey, "[REDACTED]").slice(0, 500)); } }, notify: () => {} });
let task;
try {
  const attachment = { id: "test-resume", name: "test-resume.txt", path: path.join(root, "test-resume.txt"), size: 32 };
  await writeFile(attachment.path, "Local test applicant only."); store.data.attachments.push(attachment);
  task = await service.create({
    prompt: `在 ${fixture.url}/apply 完成一次本地招聘表单测试。姓名填“真实模型验收”，邮箱 live@example.test，城市选上海；上传选中的 test-resume.txt；展开额外信息并填写“本地自动化验收”；勾选确认资料正确。不要勾选模拟连接中断。本次已授权提交一次。提交后核查页面回执或提交记录，成功时生成含姓名、回执编号和来源链接的 CSV，再报告结果。不要访问其他网站。`,
    profileId: gateway.id, attachmentIds: [attachment.id], grant: { origin: fixture.url, effects: ["submit"], maxActions: 1 }, limits: { minutes: 6, actions: 45, budgetUsd: 1 }
  });
  const started = Date.now();
  while (Date.now() - started < 390000 && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 500));
  const evidence = { passed: task.status === "completed" && fixture.records.length === 1 && task.outputs?.length > 0, at: new Date().toISOString(), model: provider.settings.model, endpoint: provider.settings.baseUrl, elapsedMs: Date.now() - started, status: task.status, result: task.result, pending: task.pending, usage: task.usage, records: fixture.records, events: task.events, outputs: task.outputs?.map(({ name, size }) => ({ name, size })), checks: ["real model decisions", "SDK tool calls", "registered isolated Profile", "form", "upload", "dynamic field", "submit", "receipt", "CSV output"], limitation: "One controlled local task; not an open-web success-rate benchmark." };
  await mkdir("test-results/browser-tasks", { recursive: true });
  await writeFile("test-results/browser-tasks/live-task-result.json", JSON.stringify(evidence, null, 2).replaceAll(provider.apiKey, "[REDACTED]"));
  assert.equal(task.status, "completed", JSON.stringify({ status: task.status, result: task.result, pending: task.pending, fixtureEvents: fixture.events }));
  assert.equal(fixture.records.length, 1); assert.equal(fixture.records[0].name, "真实模型验收");
  assert.equal(fixture.records[0].email, "live@example.test"); assert.equal(fixture.records[0].city, "上海");
  assert.equal(fixture.records[0].file, "test-resume.txt"); assert.equal(fixture.records[0].notes, "本地自动化验收");
  assert.ok(task.outputs?.length); console.log("PASS real model + SDK + Gateway + Chrome task", JSON.stringify(task.usage));
} finally {
  if (task && !["completed", "partial", "failed", "cancelled"].includes(task.status)) await service.control(task.id, "cancel").catch(() => {});
  await service.close(); await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
