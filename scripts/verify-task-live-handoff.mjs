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
const { subscribeBrowserGatewayEvents, requestBrowserGateway } = require("../dist/main/browser-gateway-client");
const { gatewayOverlayControl } = require("../dist/main/profile-manager");
const { writeAgentBrowserControlWaitStateSync, clearAgentBrowserControlWaitStateSync } = require("../dist/main/agent-browser-session");
const provider = await loadConfiguredTaskProvider();
const root = await mkdtemp(path.join(os.tmpdir(), "pp-live-handoff-"));
const gateway = await startTaskGatewayFixture(); const fixture = await startTaskFixture();
const store = new TaskStore(root); store.data.settings = { ...store.data.settings, ...provider.settings };
const browser = new WrapperBrowser(path.join(root, "artifacts"));
let task, lastEvent;
const service = new TaskService(store, { browser, apiKey: () => provider.apiKey, profileName: async () => gateway.name,
  prepareProfile: async () => ({ name: gateway.name, port: gateway.port }),
  controlReceiver: (session, waiting) => waiting ? writeAgentBrowserControlWaitStateSync(session, process.pid, gateway.home) : clearAgentBrowserControlWaitStateSync(session, process.pid, gateway.home),
  changed: snapshot => { const event = snapshot.tasks[0]?.events.at(-1); if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(event.kind, event.text.replaceAll(provider.apiKey, "[REDACTED]").slice(0, 350)); } }, notify: () => {} });
const subscription = subscribeBrowserGatewayEvents({ onEvent: event => {
  const binding = event.controlEvent?.profile;
  if (task && binding?.ownerSessionId === task.sessionId) service.externalControl(task.sessionId, binding.ownership, binding.sessionStatus, event.controlEvent.reason);
} }, { homeDir: gateway.home });
await subscription.ready;
const waitUntilIdle = async timeout => { const deadline = Date.now() + timeout; while (Date.now() < deadline && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 300)); };
try {
  task = await service.create({ profileId: gateway.id,
    prompt: `在 ${fixture.url}/shop 准备本地购物订单。商品名称填“验收保温杯”，邮箱 buyer@example.test，城市北京，确认资料正确；不要附件、补充说明或模拟中断。填好后 handoff 把浏览器交给我，最终提交订单由我自己完成，禁止代我点击提交。等我交还后，到 ${fixture.url}/records 核查我完成的订单回执并报告结果。只访问本地测试站。`,
    limits: { minutes: 9, actions: 40, budgetUsd: 1.5 }
  });
  const started = Date.now(); await waitUntilIdle(330000);
  assert.equal(task.status, "waiting_user", JSON.stringify({ status: task.status, result: task.result, pending: task.pending }));
  assert.equal(task.pending?.kind, "handoff"); assert.equal(fixture.records.length, 0, "Agent must not submit the purchase");
  const status = await requestBrowserGateway({ action: "status" }, { homeDir: gateway.home });
  const binding = status.state.profiles.find(profile => profile.publicPort === gateway.port);
  assert.equal(binding.ownership, "user");
  const overlay = gatewayOverlayControl(binding, gateway.home, Date.now() + 60000);
  assert.equal(overlay.agentOffline, false, "The UI must retain an actual receiver for return-to-Agent");
  await assert.rejects(browser.observe(task), /AGENT_USER_IN_CONTROL|user.*control|用户/i);
  // The fixture's independent user actor submits while the Agent is parked.
  // This never represents an actual payment or bypasses control of a real site.
  const receipt = await fetch(fixture.url + "/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "购物", name: "验收保温杯", email: "buyer@example.test", city: "北京", submittedBy: "fixture-user" }) }).then(response => response.json());
  store.event(task, "user", `我已经手动完成订单，回执 ${receipt.id}。现在交还浏览器，请核对提交记录。`); service.publish();
  const sessionId = task.sdkSessionId;
  await browser.control(task, "resume"); // Gateway event, the same return event used by the browser overlay.
  const eventDeadline = Date.now() + 10000;
  while (task.status === "waiting_user" && Date.now() < eventDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  await waitUntilIdle(240000);
  const evidence = { passed: task.status === "completed" && fixture.records.length === 1 && task.sdkSessionId === sessionId, at: new Date().toISOString(), model: provider.settings.model, elapsedMs: Date.now() - started, status: task.status, result: task.result, pending: task.pending, usage: task.usage, records: fixture.records, overlayControl: overlay, sdkSessionResumed: task.sdkSessionId === sessionId, events: task.events, limitation: "Real model and browser control; human purchase simulated by an independent local fixture actor. No real shopping or payment." };
  await mkdir("test-results/browser-tasks", { recursive: true });
  await writeFile("test-results/browser-tasks/live-handoff-result.json", JSON.stringify(evidence, null, 2).replaceAll(provider.apiKey, "[REDACTED]"));
  assert.equal(evidence.passed, true, JSON.stringify({ status: task.status, result: task.result, pending: task.pending }));
  assert.ok(!task.receipts.some(receipt => ["purchase", "submit"].includes(receipt.action.effect)), "No order submission by Agent");
  console.log("PASS real model purchase handoff, live overlay receiver, Gateway return, SDK resume and receipt verification");
} finally {
  if (task && !["completed", "partial", "failed", "cancelled"].includes(task.status)) await service.control(task.id, "cancel").catch(() => {});
  subscription.close(); await service.close(); await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
