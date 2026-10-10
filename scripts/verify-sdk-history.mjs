// Real SDK sessions against a local scripted endpoint: no browser or paid model.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startModelFixture } from "./task-model-fixture.mjs";
const require = createRequire(import.meta.url);
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const preview = process.argv.includes("--preview");
const root = preview ? path.resolve("artifacts", `sdk-history-preview-${Date.now()}`, "app-data", "browser-tasks")
  : await mkdtemp(path.join(os.tmpdir(), "pp-sdk-reuse-"));
await mkdir(root, { recursive: true });
const mainRequests = [];
const model = await startModelFixture(body => {
  if (!body.tools?.some(tool => tool.name === "mcp__profilepilot__observe")) return { type: "text", text: "Auxiliary response" };
  mainRequests.push(body);
  return { type: "text", text: `已记录测试信息。回答 ${mainRequests.length}。` };
});
let service;
const dependencies = { browser: {}, apiKey: () => "fixture-key-only", profileName: async () => "本地测试", changed: () => {}, notify: () => {} };
const waitForRun = async task => {
  const until = Date.now() + 55000;
  while (service.runs.has(task.id) || task.status === "queued") {
    if (Date.now() > until) throw new Error(`SDK task did not drain: ${task.status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task.status, "partial", JSON.stringify(task.events.filter(e => e.kind === "error")));
};
try {
  let store = new TaskStore(root);
  store.data.settings.baseUrl = model.url;
  service = new TaskService(store, dependencies);
  let task = await service.create({ profileId: "native:fixture", prompt: "纯问答：记住测试代号 ALPHA，不要操作浏览器。" });
  await waitForRun(task);
  const sessionId = task.sdkSessionId;
  assert.ok(sessionId);
  const firstEvents = structuredClone(task.events);
  await service.updateTaskMetadata(task.id, { title: "SDK 会话存储验收" });
  await service.close();

  const disk = JSON.parse(await readFile(store.file, "utf8"));
  assert.equal(disk.version, 2);
  assert.equal(disk.tasks[0].title, undefined);
  assert.ok(disk.tasks[0].events.some(event => event.kind === "assistant" && event.sdkText && event.text === undefined));
  store = new TaskStore(root);
  task = store.get(task.id);
  assert.equal(task.title, "SDK 会话存储验收");
  assert.deepEqual(task.events, firstEvents);
  service = new TaskService(store, dependencies);
  await service.control(task.id, "resume", "纯问答：现在用一句话解释代号。不要操作网页。");
  await waitForRun(task);
  assert.equal(task.sdkSessionId, sessionId, "SDK session is resumed rather than reconstructed");
  assert.equal(mainRequests.length, 2);
  const textBlocks = mainRequests[1].messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).filter(block => block.type === "text").map(block => block.text));
  const contexts = textBlocks.flatMap(text => { try { const value = JSON.parse(text); return value._profilepilot ? [value] : []; } catch { return []; } });
  assert.equal(contexts.length, 2, "the original input appears once, alongside the new input");
  const latest = contexts.at(-1);
  assert.equal(latest._profilepilot.mode, "resume");
  assert.equal(latest.recentHistory, undefined);
  assert.equal(latest.goal, undefined);
  assert.equal(latest.inputEvents.filter(event => event.kind === "user").length, 1);
  assert.ok(latest.currentRequest.includes("现在用一句话"));
  assert.ok(textBlocks.some(text => text.includes("回答 1")), "SDK restored the actual prior assistant response");
  await service.close();
  const restored = new TaskStore(root).get(task.id);
  assert.deepEqual(restored.events, task.events);
  assert.equal(restored.events.filter(event => event.kind === "assistant" && event.streamId).length, 2);
  // Continuing a finished task also records its product-level result summary.
  assert.ok(restored.events.some(event => event.kind === "assistant" && !event.streamId && event.text.includes("待完成")));
  const sdkPackage = JSON.parse(await readFile(path.join(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
  const result = { passed: true, sdk: sdkPackage.version,
    platform: process.platform, requests: mainRequests.length, sdkSessionReused: true, titleAndHistoryRestored: true, incrementalContinuation: true,
    ...(preview ? { previewDataDir: path.dirname(root), taskId: task.id } : {}) };
  const output = path.resolve("test-results/browser-tasks/sdk-history-result.json");
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await service?.close(); await model.close();
  if (!preview && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("pp-sdk-reuse-")) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
