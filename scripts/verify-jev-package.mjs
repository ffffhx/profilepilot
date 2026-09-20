import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
if (process.send) {
  try {
    const { evaluateJevPage, JEV_QUESTIONS } = require(path.resolve("release/win-unpacked/resources/app.asar/dist/main/tasks/jev.js"));
    const answers = {};
    for (const [id, question] of Object.entries(JEV_QUESTIONS)) {
      answers[id] = question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria)[0] } : question.type === "boolean" ? { type: "boolean", probability: 0.9 } : { type: "score", score: 1 };
    }
    let requests = 0;
    const result = await evaluateJevPage("package-test-dummy-key", { goal: "test", needsReconciliation: false, page: { url: "https://example.test", title: "test", snapshot: "login" }, recentActions: [], latestUserMessage: "test" }, "test-version", { provider: "vercel", fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ answers, usage: { inputTokens: 20, outputTokens: 0 }, providerMetadata: { typesafe: { confidence: { page: 0.9, next: 0.9 } } } }), { headers: { "content-type": "application/json" } });
    } });
    assert.equal(requests, 1); assert.equal(result.status, "ready");
    process.send({ passed: true, at: new Date().toISOString(), mode: "Windows ASAR + real AI SDK + synthetic response; no live Jev call", result });
  } catch (error) { process.send({ passed: false, error: String(error.stack || error) }); }
  process.disconnect();
} else {
  const child = fork(fileURLToPath(import.meta.url), [], { execPath: path.resolve("release/win-unpacked/ProfilePilot.exe"), execArgv: [], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Packaged Jev verification timed out")), 20000);
      child.once("message", value => { clearTimeout(timer); resolve(value); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(result.passed, true, result.error);
    await mkdir("test-results/browser-tasks", { recursive: true });
    await writeFile("test-results/browser-tasks/jev-packaged-result.json", JSON.stringify(result, null, 2));
    console.log("PASS packaged Electron ASAR imports AI SDK and evaluates Jev with a synthetic response");
  } finally { child.kill(); }
}
