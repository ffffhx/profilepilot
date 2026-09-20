import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadConfiguredTaskProvider } from "./task-provider-fixture.mjs";
const require = createRequire(import.meta.url);
const { workerEnvironment } = require("../dist/main/tasks/service");
const { authorizeTaskRead } = require("../dist/main/tasks/files");
const { makePdf } = require("../tests/fixtures/task-pdf.cjs");
const provider = await loadConfiguredTaskProvider();
const root = await mkdtemp(path.join(os.tmpdir(), "pp-pdf-test-"));
const file = path.join(root, "test-resume.pdf");
// A valid synthetic PDF, containing no personal data or third-party document.
const content = "BT /F1 16 Tf 60 760 Td (Name: Test Applicant) Tj 0 -28 Td (Email: pdf-reader@example.test) Tj ET";
const pdf = makePdf([content]);
await writeFile(file, pdf);
const task = { prompt: "这是 PDF 附件读取兼容性测试。请读取选择的 test-resume.pdf，包含页图（images=true），回答其中的邮箱地址。不需要打开网页，不要猜测文件内容。", profileName: "文件验收", materials: [], attachments: [{ id: "pdf", name: "test-resume.pdf", path: file, size: Buffer.byteLength(pdf) }], items: [], plan: [], events: [], receipts: [], limits: { actions: 10, budgetUsd: 0.5 }, usage: { actions: 0, costUsd: 0 } };
const packaged = process.env.PP_VERIFY_PACKAGED === "1";
const runtime = packaged ? { execPath: path.resolve("release/win-unpacked/ProfilePilot.exe") } : {};
const base = packaged ? "release/win-unpacked/resources/app.asar" : ".";
const tools = []; let child, parser, answer = "", imageDelivered = false;
try {
  parser = fork(path.resolve("scripts/task-document-probe.cjs"), [], { cwd: root, env: workerEnvironment(), ...runtime, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const parse = input => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { parser.off("message", receive); reject(new Error("PDF parser timed out")); }, 30000);
    const receive = message => {
      if (message.id !== id) return;
      clearTimeout(timer); parser.off("message", receive);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    };
    parser.on("message", receive);
    parser.send({ id, task, input, modulePath: path.resolve(base, "dist/main/tasks/files.js") });
  });
  const result = await new Promise((resolve, reject) => {
    child = fork(path.resolve(base, "dist/main/tasks/worker.js"), [], { cwd: root, env: workerEnvironment(), ...runtime, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("PDF read verification timed out")); }, 120000);
    child.on("message", async message => {
      if (message.kind === "text") answer += message.text;
      if (message.kind === "tool") {
        tools.push(message.name);
        try {
          const result = message.name === "authorize_read" ? authorizeTaskRead(task, message.args.path) : message.name === "read_document" ? await parse(message.args) : { content: [{ type: "text", text: message.name === "finish" ? "已记录文件读取结果，测试结束。" : "文件兼容性测试无需操作浏览器，请读取已选择的 PDF 并回答邮箱。" }] };
          if (result.content?.some(block => block.type === "image")) imageDelivered = true;
          child.send({ kind: "tool_result", id: message.id, result });
        } catch (error) { clearTimeout(timer); reject(error); }
      }
      if (message.kind === "error") { clearTimeout(timer); reject(new Error(message.text)); }
      if (message.kind === "result") { clearTimeout(timer); resolve(message); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.send({ kind: "start", cwd: root, task, settings: provider.settings, apiKey: provider.apiKey });
  });
  const evidence = { passed: result.success && tools.includes("read_document") && imageDelivered && (answer + result.result).includes("pdf-reader@example.test"), packaged, imageDelivered, at: new Date().toISOString(), model: provider.settings.model, result: result.result, answer, tools, costUsd: result.costUsd };
  await mkdir("test-results/browser-tasks", { recursive: true });
  await writeFile(`test-results/browser-tasks/pdf${packaged ? "-packaged" : ""}-result.json`, JSON.stringify(evidence, null, 2).replaceAll(provider.apiKey, "[REDACTED]"));
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
  console.log("PASS local PDF text + page image + actual SDK + real provider", result.result);
} finally { child?.kill(); parser?.kill(); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
