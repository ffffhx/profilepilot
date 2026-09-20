import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { loadConfiguredTaskProvider } from "./task-provider-fixture.mjs";

// Use only a Profile explicitly allocated for this verification. Credentials stay in memory.
const profileId = process.argv[2];
const port = Number(process.argv[3]);
if (!profileId?.startsWith("isolated:") || !Number.isInteger(port) || port < 1024) throw new Error("Usage: node scripts/verify-task-live-jev.mjs <allocated-profile-id> <logical-port>");
const require = createRequire(import.meta.url);
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { WrapperBrowser } = require("../dist/main/tasks/browser");
const { evaluateJevPage } = require("../dist/main/tasks/jev");
const { requestBrowserGateway, subscribeBrowserGatewayEvents } = require("../dist/main/browser-gateway-client");
const provider = await loadConfiguredTaskProvider({ includeJev: true });
assert.ok(provider.settings.jevEnabled && provider.jevApiKey, "Jev must be enabled with a saved key.");
const gateway = await requestBrowserGateway({ action: "status" });
const binding = gateway.state.profiles.find(p => p.publicPort === port && p.profileId === profileId);
assert.ok(binding, "The allocated Profile must be running through Gateway.");
assert.ok(!binding.ownerSessionId || binding.sessionStatus === "stopped", "Do not take an occupied Profile.");
const root = path.resolve(".cpm-data", `jev-open-web-${Date.now()}`);
const resultRoot = path.resolve("test-results/browser-tasks", path.basename(root));
await mkdir(resultRoot, { recursive: true });
const redact = value => [provider.apiKey, provider.jevApiKey].reduce((text, key) => key ? text.replaceAll(key, "[REDACTED]") : text, value);
const store = new TaskStore(root);
store.data.settings = { ...store.data.settings, ...provider.settings, notifications: false };
const assessments = [], observations = [], toolCalls = [];
let lastEvent, task;
const browser = new WrapperBrowser(path.join(root, "artifacts"));
const service = new TaskService(store, {
  browser, apiKey: () => provider.apiKey, jevApiKey: () => provider.jevApiKey,
  profileName: async id => { assert.equal(id, profileId); return binding.profileName; },
  prepareProfile: async id => { assert.equal(id, profileId); return { name: binding.profileName, port }; },
  evaluateJev: async (key, state, version, options) => {
    const result = await evaluateJevPage(key, state, version, options);
    assessments.push({ url: state.page.url, title: state.page.title, ...result });
    console.log("jev", JSON.stringify({ status: result.status, url: state.page.url, page: result.answers?.page.choice, next: result.answers?.next.choice, elapsedMs: result.elapsedMs }));
    return result;
  },
  changed: snapshot => {
    const event = snapshot.tasks[0]?.events.at(-1);
    if (event && event.id !== lastEvent) { lastEvent = event.id; console.log(event.kind, redact(event.text).slice(0, 900)); }
  }, notify: () => {}
});
const originalHandle = service.handleTool.bind(service);
service.handleTool = async (task, run, name, args) => {
  const result = await originalHandle(task, run, name, args);
  toolCalls.push({ name, at: new Date().toISOString(), args, isError: result?.isError });
  if (name === "observe" && !result.isError) {
    const observation = JSON.parse(result.content[0].text);
    observations.push({ ...observation, screenshotPath: task.observation?.screenshotPath, screenshotDataUrl: undefined });
  }
  return result;
};
const subscription = subscribeBrowserGatewayEvents({ onEvent: event => {
  const profile = event.controlEvent?.profile;
  if (task && profile?.ownerSessionId === task.sessionId) service.externalControl(task.sessionId, profile.ownership, profile.sessionStatus, event.controlEvent.reason);
} });
await subscription.ready;
const started = Date.now();
try {
  task = await service.create({ profileId,
    prompt: "完成一次真实公开网页资料整理：访问 https://github.com/browser-use/browser-use ，查看仓库及其 Releases 页面，记录页面上标记为 Latest 的版本号、发布日期（按页面显示原样记录）与许可证；从仓库链接进入 Browser Use 官方文档，找到 Python 本地快速开始的安装依赖与安装浏览器命令。把这些核实信息导出为 browser-use-research.csv，列为：项目、内容、来源链接。不要安装软件。只浏览公开页面，不登录、不发消息、不 Star、不 Fork、不进行任何提交。不要把仓库的云端 API 产品与本地 Python 库混淆。若网页确实不可访问或信息找不到，应报告缺项。每个关键页面至少 observe 一次，最后截图保留页面依据；在 finish 中引用当前已观察页面的短原文，中文总结。",
    authorization: "允许访问公开页面、浏览链接与读取资料，允许生成本地结果文件。",
    limits: { minutes: 10, actions: 60, budgetUsd: 2 }
  });
  console.log("TASK", JSON.stringify({ id: task.id, sessionId: task.sessionId, resultRoot }));
  while (Date.now() - started < 630000 && (["queued", "running"].includes(task.status) || service.runs.has(task.id))) await new Promise(resolve => setTimeout(resolve, 750));
  const outputs = [];
  for (const file of task.outputs || []) {
    const target = path.join(resultRoot, path.basename(file.name)); await copyFile(file.path, target);
    outputs.push({ name: file.name, path: target, size: file.size });
  }
  for (const observation of observations) if (observation.screenshotPath) {
    const target = path.join(resultRoot, path.basename(observation.screenshotPath));
    await copyFile(observation.screenshotPath, target); observation.screenshotPath = target;
  }
  const evidence = { passed: task.status === "completed" && assessments.some(a => a.answers) && outputs.some(f => f.name.endsWith(".csv")), at: new Date().toISOString(), model: provider.settings.model, jevProvider: provider.settings.jevProvider, profileId, port, elapsedMs: Date.now() - started, status: task.status, result: task.result, pending: task.pending, usage: task.usage, outputs, assessments, observations, toolCalls, events: task.events, receipts: task.receipts, limitation: "Single live open-web task with Kimi planning/execution and Jev advisory evaluation; no comparison run without Jev." };
  await writeFile(path.join(resultRoot, "result.json"), redact(JSON.stringify(evidence, null, 2)));
  console.log("RESULT", JSON.stringify({ passed: evidence.passed, status: task.status, result: task.result, pending: task.pending, usage: task.usage, assessments: assessments.length, outputs, evidence: path.join(resultRoot, "result.json") }));
  for (const file of outputs) if (file.name.endsWith(".csv")) console.log("CSV", redact(await readFile(file.path, "utf8")));
  process.exitCode = evidence.passed ? 0 : 1;
} finally {
  subscription.close();
  // Preserve a genuine human takeover or pending action; never auto-resume it.
  if (task && ["running", "queued"].includes(task.status)) await service.control(task.id, "pause");
  await service.close();
  console.log("Run stopped; task data retained at", root);
}
