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
const root = await mkdtemp(path.join(os.tmpdir(), "pp-recovery-"));
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
let stage = 0, task, service, store, pausedResolve;
const pauseReached = new Promise(resolve => pausedResolve = resolve);
const model = await startModelFixture(async body => {
  const observation = lastObservation(body);
  const current = stage++;
  const tool = (name, input) => ({ type: "tool_use", id: `recovery_${current}`, name: `mcp__profilepilot__${name}`, input });
  const action = (kind, extra) => tool("browser_action", { kind, version: observation?.version, effect: "edit", summary: "恢复验收", ...extra });
  const previous = body.messages.at(-1)?.content;
  const error = Array.isArray(previous) && previous.find(block => block.type === "tool_result" && block.is_error);
  if (error) return { type: "text", text: `Fixture tool failure: ${JSON.stringify(error.content)}` };
  console.log(`Recovery stage ${current}`);
  switch (current) {
    case 0: return action("open", { value: fixture.url + "/apply", effect: "read" });
    case 1: case 3: case 5: case 7: return tool("observe", { screenshot: false });
    case 2: return tool("fill_fields", { version: observation.version, fields: [{ ref: pageRef(observation, "姓名"), kind: "fill", value: "恢复测试" }, { ref: pageRef(observation, "邮箱"), kind: "fill", value: "recovery@example.test" }] });
    case 4: return action("check", { ref: pageRef(observation, "确认资料正确") });
    case 6: return action("check", { ref: pageRef(observation, "模拟提交后连接中断") });
    case 8: return action("click", { ref: pageRef(observation, "提交申请"), effect: "submit", summary: "提交后模拟响应丢失" });
    case 9: {
      const deadline = Date.now() + 4000;
      while (!fixture.records.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!fixture.records.length) {
        const observed = await browser.observe(task, true);
        const output = path.resolve("test-results/browser-tasks"); await mkdir(output, { recursive: true });
        await writeFile(path.join(output, "recovery-failure.png"), Buffer.from(observed.screenshotDataUrl.split(",")[1], "base64"));
        console.error("Submission did not reach fixture:", fixture.events, { ...observed, screenshotDataUrl: undefined }, task.receipts.at(-1));
        console.error("DOM diagnostics", await browser.command(task, ["eval", "JSON.stringify({focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.outerHTML,buttons:[...document.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,rect:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML}}),requests:performance.getEntriesByType('resource').map(e=>e.name)})"]));
      }
      pausedResolve(); return { type: "text", text: "提交请求已发送，等待应用退出恢复验收。" };
    }
    case 10: return tool("observe", { screenshot: false });
    case 11: return action("open", { value: fixture.url + "/records", effect: "read" });
    case 12: return tool("observe", { screenshot: false });
    case 13: return tool("reconcile", { receiptId: task.receipts.find(receipt => receipt.action.effect === "submit").id, outcome: "completed", evidence: "PP-1" });
    case 14: return tool("finish", { status: "completed", summary: "已核对记录，原申请成功，未重复提交。", evidence: ["PP-1"], remaining: [] });
    default: return { type: "text", text: "恢复验收完成。" };
  }
});
const browser = new WrapperBrowser(path.join(root, "artifacts"));
const dependencies = { browser, apiKey: () => "fixture-key-only", profileName: async () => "Agent 产品验收",
  prepareProfile: async () => ({ name: gateway.name, port: gateway.port }), changed: () => {}, notify: () => {} };
try {
  store = new TaskStore(root); store.data.settings.baseUrl = model.url;
  service = new TaskService(store, dependencies);
  task = await service.create({ prompt: "在本地站提交申请；如果断线，恢复后先核查提交记录，避免重复。", profileId: gateway.id, grant: { origin: fixture.url, effects: ["submit"], maxActions: 2 }, limits: { minutes: 4, actions: 50, budgetUsd: 5 } });
  let timer;
  await Promise.race([pauseReached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Did not reach submit checkpoint: ${JSON.stringify(task.events)}`)), 100000); })]).finally(() => clearTimeout(timer));
  // Hold task state at the shutdown boundary before the worker's final text/result arrives.
  await service.close();
  assert.ok(task.usage.costUsd > 0, "Graceful interruption must flush the already-consumed SDK usage");
  assert.equal(fixture.records.length, 1);
  const id = task.id, sdkSessionId = task.sdkSessionId;
  store = new TaskStore(root); task = store.get(id);
  assert.equal(task.status, "paused"); assert.equal(task.needsReconciliation, true);
  assert.equal(task.receipts.find(receipt => receipt.action.effect === "submit").status, "uncertain");
  service = new TaskService(store, dependencies);
  await service.control(task.id, "resume");
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(task.status, "completed", JSON.stringify({ events: task.events, result: task.result, observation: task.observation }, null, 2));
  assert.equal(task.sdkSessionId, sdkSessionId); assert.equal(task.needsReconciliation, false);
  assert.equal(fixture.records.length, 1); assert.equal(task.grant.used, 1);
  assert.equal(task.receipts.find(receipt => receipt.action.effect === "submit").reconciliation.outcome, "completed");
  const output = path.resolve("test-results/browser-tasks"); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "recovery-result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), model: "scripted local endpoint, real SDK resume", checks: ["server commits then drops response", "shutdown drains worker and returns browser", "persistent uncertain receipt", "SDK session resume", "record-page reconciliation", "no duplicate submission"], submissions: fixture.records.length, usage: task.usage }, null, 2));
  console.log("PASS shutdown + real SDK resume + browser reconciliation without duplicate submission");
} finally {
  if (task && service && !["completed", "partial", "failed", "cancelled"].includes(task.status)) await service.control(task.id, "cancel").catch(() => {});
  await service?.close(); await model.close(); await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
