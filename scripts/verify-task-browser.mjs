import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startTaskFixture } from "./browser-task-fixture.mjs";
import { startTaskGatewayFixture } from "./task-gateway-fixture.mjs";
const require = createRequire(import.meta.url);
const { WrapperBrowser } = require("../dist/main/tasks/browser");
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const root = path.resolve("test-results/browser-tasks"); await mkdir(root, { recursive: true });
const task = { id: randomUUID(), sessionId: `pp-verify-${randomUUID()}`, port: gateway.port, attachments: [] };
const upload = path.join(root, "test-resume.txt"); await writeFile(upload, "Test applicant, example.test only");
task.attachments.push({ id: "fixture-resume", name: "test-resume.txt", path: upload, size: 33 });
const browser = new WrapperBrowser(root);
const action = async (kind, value, ref) => browser.execute(task, { kind, value, ref, effect: "read", summary: "本地验收" });
function refFor(snapshot, label) {
  const line = snapshot.split("\n").find(line => line.includes(label) && /@e\d+|ref=e\d+/.test(line));
  assert.ok(line, `No ref for ${label}: ${snapshot}`);
  return (line.match(/@e\d+/)?.[0] || "@" + line.match(/ref=(e\d+)/)[1]);
}
try {
  console.log("Opening fixture through Gateway");
  await action("open", fixture.url + "/apply");
  console.log("Filling form and uploading attachment");
  let state = await browser.observe(task, true);
  await writeFile(path.join(root, "initial-observation.json"), JSON.stringify(state, null, 2));
  assert.ok(state.snapshot.includes("招聘申请"));
  await action("fill", "测试用户", refFor(state.snapshot, "姓名"));
  state = await browser.observe(task); await action("fill", "test@example.test", refFor(state.snapshot, "邮箱"));
  state = await browser.observe(task); await action("select", "上海", refFor(state.snapshot, "城市"));
  state = await browser.observe(task); await browser.execute(task, { kind: "upload", ref: refFor(state.snapshot, "附件"), attachmentId: "fixture-resume", effect: "edit", summary: "上传测试附件" });
  state = await browser.observe(task); await action("check", undefined, refFor(state.snapshot, "确认资料正确"));
  state = await browser.observe(task); await action("click", undefined, refFor(state.snapshot, "展开额外信息"));
  state = await browser.observe(task); await action("fill", "动态表单验证", refFor(state.snapshot, "补充说明"));
  state = await browser.observe(task); await action("click", undefined, refFor(state.snapshot, "提交申请"));
  state = await browser.observe(task, true);
  assert.ok(state.snapshot.includes("PP-1"), JSON.stringify({ records: fixture.records, observation: { ...state, screenshotDataUrl: undefined } }, null, 2));
  assert.equal(fixture.records.length, 1); assert.equal(fixture.records[0].name, "测试用户");
  assert.equal(fixture.records[0].notes, "动态表单验证");
  assert.equal(fixture.records[0].file, "test-resume.txt");
  console.log("Checking download");
  await action("download", "report.csv", refFor(state.snapshot, "下载报表"));
  assert.ok((await readFile(task.outputs[0].path, "utf8")).includes("PP-1"));
  await browser.control(task, "handoff");
  await assert.rejects(browser.observe(task), /AGENT_USER_IN_CONTROL|user.*control|用户/i);
  await browser.control(task, "resume"); state = await browser.observe(task);
  assert.ok(state.snapshot.includes("PP-1"));
  await writeFile(path.join(root, "gateway-browser-result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), session: task.sessionId, port: task.port, checks: ["gateway routing", "observation", "text filling", "select", "checkbox", "file upload", "file download", "dynamic form", "submit receipt", "takeover hard-stop", "return and reobserve"], records: fixture.records }, null, 2));
  console.log("PASS real browser through ProfilePilot Gateway: form, receipt, takeover and return");
} catch (error) {
  console.error("Browser verification failed:", error);
  throw error;
} finally {
  await browser.control(task, "complete").catch(error => console.error("cleanup", String(error)));
  await fixture.close();
  await gateway.close();
  console.log("Browser verification cleanup finished");
}
