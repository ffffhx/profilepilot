import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startTaskFixture } from "./browser-task-fixture.mjs";
import { startModelFixture, lastObservation, pageRef } from "./task-model-fixture.mjs";
import { startTaskGatewayFixture } from "./task-gateway-fixture.mjs";
const require = createRequire(import.meta.url);
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { WrapperBrowser } = require("../dist/main/tasks/browser");
const root = await mkdtemp(path.join(os.tmpdir(), "pp-integration-"));
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const model = await startModelFixture((body, turn) => {
  const previous = body.messages.at(-1)?.content;
  const error = Array.isArray(previous) && previous.find(block => block.type === "tool_result" && block.is_error);
  if (error) return { type: "text", text: `Fixture detected tool failure: ${JSON.stringify(error.content)}` };
  const observation = lastObservation(body);
  const action = (kind, extra) => ({ kind, effect: "edit", summary: "本地集成验收", version: observation?.version, ...extra });
  const tool = (name, input) => ({ type: "tool_use", id: `tool_${turn}`, name: `mcp__profilepilot__${name}`, input });
  console.log(`SDK request ${turn + 1}`);
  switch (turn) {
    case 0: return tool("browser_action", action("open", { value: fixture.url + "/apply", effect: "read" }));
    case 1: case 3: case 5: case 7: return tool("observe", { screenshot: false });
    case 2: return tool("fill_fields", { version: observation.version, fields: [{ ref: pageRef(observation, "姓名"), value: "集成测试用户", kind: "fill" }, { ref: pageRef(observation, "邮箱"), value: "integration@example.test", kind: "fill" }] });
    case 4: return tool("browser_action", action("check", { ref: pageRef(observation, "确认资料正确") }));
    case 6: return tool("browser_action", action("click", { ref: pageRef(observation, "提交申请"), effect: "submit", summary: "提交本地测试申请" }));
    case 8: return tool("export_result", { name: "申请结果", format: "csv", columns: ["姓名", "回执", "来源"], rows: [["集成测试用户", "PP-1", fixture.url + "/records"]], text: "" });
    case 9: return tool("finish", { status: "completed", summary: "本地申请已提交并生成结果表。", evidence: ["PP-1"], remaining: [] });
    default: return { type: "text", text: "本地集成验收结束。" };
  }
});
const store = new TaskStore(root); store.data.settings.baseUrl = model.url;
const browser = new WrapperBrowser(path.join(root, "artifacts"));
const service = new TaskService(store, { browser, apiKey: () => "fixture-key-only", profileName: async () => "Agent 产品验收",
  prepareProfile: async () => ({ name: gateway.name, port: gateway.port }), changed: () => {}, notify: () => {} });
let task;
try {
  task = await service.create({ prompt: "在本地验收站填写并提交测试申请，生成结果表。", profileId: gateway.id, grant: { origin: fixture.url, effects: ["submit"], maxActions: 1 }, limits: { minutes: 3, actions: 40, budgetUsd: 5 } });
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(task.status, "completed", JSON.stringify({ status: task.status, events: task.events, result: task.result, observation: task.observation, needsReconciliation: task.needsReconciliation, records: fixture.records }, null, 2));
  assert.equal(service.runs.size, 0); assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].name, "集成测试用户"); assert.equal(fixture.records[0].email, "integration@example.test");
  assert.equal(task.grant.used, 1); assert.equal(task.outputs?.length, 1, JSON.stringify(task.events));
  assert.equal(new TaskStore(root).get(task.id).status, "completed");
  const output = path.resolve("test-results/browser-tasks"); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "task-integration-result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), model: "scripted local endpoint; not a real model benchmark", path: "TaskService → Claude Agent SDK → MCP → Wrapper → Gateway → Chrome → real HTTP fixture", requests: model.requests.length, records: fixture.records, actions: task.usage.actions, status: task.status }, null, 2));
  console.log("PASS complete service + SDK + Gateway + Chrome submission and CSV output");
} finally {
  if (task && !["completed", "partial", "failed", "cancelled"].includes(task.status)) await service.control(task.id, "cancel").catch(() => {});
  await service.close(); await model.close(); await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
