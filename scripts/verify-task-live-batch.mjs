import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
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
const root = await mkdtemp(path.join(os.tmpdir(), "pp-live-batch-"));
const gateway = await startTaskGatewayFixture(); const fixture = await startTaskFixture();
const store = new TaskStore(root); store.data.settings = { ...store.data.settings, ...provider.settings };
const browser = new WrapperBrowser(path.join(root, "artifacts"));
let lastEvent;
const service = new TaskService(store, { browser, apiKey: () => provider.apiKey, profileName: async () => gateway.name,
  prepareProfile: async () => ({ name: gateway.name, port: gateway.port }),
  changed: snapshot => { const event = snapshot.tasks[0]?.events.at(-1); if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(event.kind, event.text.replaceAll(provider.apiKey, "[REDACTED]").slice(0, 400)); } }, notify: () => {} });
let task;
try {
  const file = { id: "batch-input", name: "batch.csv", path: path.join(root, "batch.csv"), size: 128 };
  await writeFile(file.path, "\ufeffname,email,city\n运营测试A,a@example.test,上海\n运营测试B,,北京\n运营测试C,c@example.test,北京\n");
  store.data.attachments.push(file);
  task = await service.create({ profileId: gateway.id, attachmentIds: [file.id], items: ["运营测试A", "运营测试B", "运营测试C"],
    prompt: `读取 batch.csv，把三项资料逐项录入 ${fixture.url}/admin。用 name 填姓名/商品名称、email 填邮箱、city 选城市，勾选确认资料正确，再提交；不需要附件和额外信息，不选模拟中断。邮箱为空的项目必须标记 failed 并说明缺失必填字段，不编造邮箱，也不要为它暂停其他独立项目。A、C 继续处理并核查回执。逐项更新任务列表，避免重复录入，最后生成含姓名、结果、回执和来源链接的 CSV，并报告未完成事项。只访问该本地站，最多已授权两次提交。`,
    grant: { origin: fixture.url, effects: ["submit"], maxActions: 2 }, limits: { minutes: 12, actions: 65, budgetUsd: 2 }
  });
  const started = Date.now();
  while (Date.now() - started < 750000 && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 500));
  const expectedItems = task.items[0].status === "completed" && task.items[1].status === "failed" && task.items[2].status === "completed";
  const csvFile = task.outputs?.find(file => /\.csv$/i.test(file.name));
  const csv = csvFile ? await readFile(csvFile.path, "utf8") : "";
  const validCsv = ["运营测试A", "运营测试B", "运营测试C", "PP-1", "PP-2", fixture.url].every(value => csv.includes(value));
  const evidence = { passed: task.status === "partial" && fixture.records.length === 2 && expectedItems && validCsv, at: new Date().toISOString(), model: provider.settings.model, elapsedMs: Date.now() - started, status: task.status, items: task.items, result: task.result, pending: task.pending, usage: task.usage, records: fixture.records, events: task.events, validCsv, limitation: "Controlled local mixed-outcome sample, not an open-web success rate." };
  const output = "test-results/browser-tasks"; await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "live-batch-result.json"), JSON.stringify(evidence, null, 2).replaceAll(provider.apiKey, "[REDACTED]"));
  if (csvFile) await copyFile(csvFile.path, path.join(output, "live-batch-output.csv"));
  assert.equal(evidence.passed, true, JSON.stringify({ status: task.status, items: task.items, records: fixture.records, pending: task.pending, result: task.result, validCsv }));
  assert.deepEqual(fixture.records.map(record => record.name).sort(), ["运营测试A", "运营测试C"]);
  assert.equal(task.grant.used, 2); console.log("PASS real model mixed batch: failure isolated, other items completed, CSV verified");
} finally {
  if (task && !["completed", "partial", "failed", "cancelled"].includes(task.status)) await service.control(task.id, "cancel").catch(() => {});
  await service.close(); await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
