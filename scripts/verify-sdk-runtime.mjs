// Exercises the real SDK process and MCP transport with a deterministic local
// model endpoint. This is transport/permission evidence, not a model benchmark.
import http from "node:http";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { workerEnvironment } = require("../dist/main/tasks/service");
const { authorizeTaskRead } = require("../dist/main/tasks/files");
const { makePdf } = require("../tests/fixtures/task-pdf.cjs");
const requests = [];
const messages = [];
const root = await mkdtemp(path.join(os.tmpdir(), "pp-sdk-"));
const selectedFile = path.join(root, "selected.txt");
const unselectedFile = path.join(root, "not-selected.txt");
const pdfFile = path.join(root, "selected.pdf");
await writeFile(pdfFile, makePdf(["BT /F1 16 Tf 60 760 Td (PDF-MUST-USE-PRODUCT-READER) Tj ET"]));
await writeFile(selectedFile, "APPROVED-TASK-FILE-CONTENT");
await writeFile(unselectedFile, "UNSELECTED-SECRET-MUST-NOT-APPEAR");
const attachments = [{ id: "fixture", path: selectedFile, name: "selected.txt", size: 26 }, { id: "pdf", path: pdfFile, name: "selected.pdf", size: 1000 }];
const server = http.createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":100}'); return; }
  if (!req.url?.includes("messages")) { res.setHeader("content-type", "application/json"); res.end('{}'); return; }
  const body = JSON.parse(text); requests.push(body);
  const turn = requests.length;
  const block = turn <= 2 ? { type: "tool_use", id: `tool_read_${turn}`, name: "Read", input: { file_path: turn === 1 ? unselectedFile : selectedFile } }
    : turn === 3 ? { type: "tool_use", id: "tool_pdf", name: "Read", input: { file_path: pdfFile } }
    : turn === 4 ? { type: "tool_use", id: "tool_observe", name: "mcp__profilepilot__observe", input: { screenshot: false } } : { type: "text", text: "SDK transport verified" };
  const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: `msg_${turn}`, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
  if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", {}); res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const child = fork(path.resolve("dist/main/tasks/worker.js"), [], { cwd: root, env: workerEnvironment(), execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
let stderr = ""; child.stderr.on("data", data => stderr += data); child.stdout.resume();
try {
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`SDK runtime timeout. ${stderr}`)); }, 55000);
    child.on("message", message => {
      messages.push(message);
      if (message.kind === "tool") child.send({ kind: "tool_result", id: message.id, result: message.name === "authorize_read" ? authorizeTaskRead({ attachments }, message.args.path) : { content: [{ type: "text", text: "页面标题：测试；表单状态：已填写。" }] } });
      if (message.kind === "result") { clearTimeout(timeout); resolve(message); }
      if (message.kind === "error") { clearTimeout(timeout); reject(new Error(message.text)); }
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => { clearTimeout(timeout); if (!messages.some(m => m.kind === "result")) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
  });
  child.send({ kind: "start", cwd: root, apiKey: "fixture-key-only", settings: { model: "claude-sonnet-4-6", baseUrl: `http://127.0.0.1:${server.address().port}` },
    task: { prompt: "观察测试页面", profileName: "测试", authorization: "", materials: [], attachments, items: [], plan: [], events: [], receipts: [], needsReconciliation: false, limits: { actions: 5, budgetUsd: 1 }, usage: { actions: 0, costUsd: 0 } } });
  const outcome = await result;
  assert.equal(outcome.success, true, JSON.stringify(outcome));
  assert.ok(messages.some(m => m.kind === "tool" && m.name === "observe"));
  assert.ok(requests.length >= 2);
  assert.ok(JSON.stringify(requests).includes("APPROVED-TASK-FILE-CONTENT"));
  assert.equal(JSON.stringify(requests).includes("UNSELECTED-SECRET-MUST-NOT-APPEAR"), false);
  assert.equal(JSON.stringify(requests).includes("PDF-MUST-USE-PRODUCT-READER"), false);
  assert.equal(JSON.stringify(requests).includes('"type":"document"'), false);
  assert.ok(JSON.stringify(requests.at(-1).messages).includes("read_document"), "PDF Read denial must explain the supported tool");
  const advertised = requests.flatMap(r => (r.tools || []).map(t => t.name));
  assert.equal(advertised.includes("Bash"), false);
  const output = path.resolve("test-results/browser-tasks"); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "sdk-transport-result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), model: "deterministic local fixture, not a live model", requests: requests.length, tools: [...new Set(advertised)], toolCalls: messages.filter(m => m.kind === "tool").map(m => m.name) }, null, 2));
  console.log("PASS real Claude Agent SDK process + MCP + selected-file read + unselected-file rejection; no shell tool exposed");
} finally {
  if (child.connected) child.send({ kind: "stop" });
  child.kill(); child.stdout.destroy(); child.stderr.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // SDK children may still flush their session files on Windows; only this
  // verified disposable directory is eligible for cleanup.
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
