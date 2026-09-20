import { fork } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadConfiguredTaskProvider } from "./task-provider-fixture.mjs";
const require = createRequire(import.meta.url);
const { workerEnvironment } = require("../dist/main/tasks/service");
const provider = await loadConfiguredTaskProvider();
const cwd = await mkdtemp(path.join(os.tmpdir(), "pp-provider-test-"));
const packaged = process.env.PP_VERIFY_PACKAGED === "1";
let child;
try {
  const result = await new Promise((resolve, reject) => {
    child = fork(path.resolve(packaged ? "release/win-unpacked/resources/app.asar/dist/main/tasks/worker.js" : "dist/main/tasks/worker.js"), [], { cwd, env: workerEnvironment(), ...(packaged ? { execPath: path.resolve("release/win-unpacked/ProfilePilot.exe") } : {}), execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Real provider test timed out.")); }, 90000);
    child.on("message", message => {
      if (message.kind === "result" || message.kind === "error") {
        clearTimeout(timer); message.kind === "error" || !message.success ? reject(new Error(message.text || message.result)) : resolve(message);
      }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.send({ kind: "start", test: true, task: {}, settings: provider.settings, apiKey: provider.apiKey, cwd });
  });
  const evidence = { passed: true, packaged, at: new Date().toISOString(), endpoint: provider.settings.baseUrl, model: provider.settings.model, result: result.result, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, sdkCostUsd: result.costUsd } };
  await mkdir("test-results/browser-tasks", { recursive: true });
  await writeFile(`test-results/browser-tasks/provider${packaged ? "-packaged" : ""}-result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  child?.kill();
  if (path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
