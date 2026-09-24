const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { TaskStore, scrubDiagnostics } = require("../dist/main/tasks/store");
const { TaskService, workerEnvironment } = require("../dist/main/tasks/service");
const { WrapperBrowser, observationFingerprint, effectiveEffect, parseCliResult } = require("../dist/main/tasks/browser");
const { providerEnvironment } = require("../dist/main/tasks/provider");
const { sdkExecutable } = require("../dist/main/tasks/runtime");

test("PDF reader enforces attachment scope, paginates text, and renders image-only pages", async t => {
  const f = fixture(t);
  const { makePdf } = require("./fixtures/task-pdf.cjs");
  const { readTaskDocument, authorizeTaskRead } = require("../dist/main/tasks/files");
  const file = path.join(f.store.root, "resume.pdf");
  writeFileSync(file, makePdf(["BT /F1 16 Tf 60 760 Td (Email: pdf-reader@example.test) Tj ET", "0 0 1 rg 40 40 200 200 re f"]));
  f.task.attachments.push({ id: "pdf", name: "resume.pdf", path: file, size: 1000 });
  const textFile = path.join(f.store.root, "notes.txt"); writeFileSync(textFile, "selected notes");
  f.task.attachments.push({ id: "text", name: "notes.txt", path: textFile, size: 14 });
  assert.equal(authorizeTaskRead(f.task, textFile).allowed, true);
  assert.equal(authorizeTaskRead(f.task, file).allowed, false);
  const first = await f.service.handleTool(f.task, f.run, "read_document", { attachmentId: "pdf" });
  const data = JSON.parse(first.content[0].text);
  assert.match(data.pages[0].text, /pdf-reader@example.test/); assert.equal(data.totalPages, 2); assert.equal(data.nextPage, 2);
  assert.equal(first.content.length, 1);
  const second = await readTaskDocument(f.task, { attachmentId: "pdf", startPage: 2 });
  assert.equal(JSON.parse(second.content[0].text).nextPage, null);
  const image = second.content.find(block => block.type === "image"); assert.ok(image);
  assert.equal(Buffer.from(image.data, "base64").subarray(1, 4).toString(), "PNG");
  const layout = await readTaskDocument(f.task, { attachmentId: "pdf", images: true });
  assert.ok(layout.content.some(block => block.type === "image"));
  await assert.rejects(readTaskDocument(f.task, { attachmentId: "other" }), /未获当前任务授权/);
  await assert.rejects(readTaskDocument(f.task, { attachmentId: "pdf", startPage: 3 }), /页码超出/);
  await assert.rejects(readTaskDocument(f.task, { attachmentId: "pdf", count: 4 }));
});

test("packaged SDK launches the unpacked native executable on Windows and macOS", () => {
  assert.equal(sdkExecutable("node", "app-runtime"), "app-runtime");
  assert.equal(sdkExecutable("C:\\App\\resources\\app.asar\\node_modules\\sdk\\claude.exe", "unused", () => true), "C:\\App\\resources\\app.asar.unpacked\\node_modules\\sdk\\claude.exe");
  assert.equal(sdkExecutable("/Applications/App.app/Contents/Resources/app.asar/node_modules/sdk/claude", "unused", () => true), "/Applications/App.app/Contents/Resources/app.asar.unpacked/node_modules/sdk/claude");
  assert.equal(sdkExecutable("/development/node_modules/sdk/claude", "unused", () => true), "/development/node_modules/sdk/claude");
});

test("compatible provider maps auxiliary models and selects exactly one auth mechanism", () => {
  const env = providerEnvironment({ baseUrl: "https://api.moonshot.cn/anthropic", model: "kimi-k3" }, "test-key", "test-cwd");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "test-key"); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "kimi-k3"); assert.equal(env.CLAUDE_CONFIG_DIR, "test-cwd");
  const standard = providerEnvironment({ baseUrl: "https://example.test/anthropic", model: "custom", authMode: "apiKey" }, "test-key", "cwd");
  assert.equal(standard.ANTHROPIC_API_KEY, "test-key"); assert.equal(standard.ANTHROPIC_AUTH_TOKEN, undefined);
  const deepseek = providerEnvironment({ baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" }, "test-key", "cwd");
  assert.equal(deepseek.ANTHROPIC_AUTH_TOKEN, "test-key"); assert.equal(deepseek.ANTHROPIC_API_KEY, undefined);
  for (const tier of ["OPUS", "SONNET", "HAIKU", "FABLE"]) assert.equal(deepseek[`ANTHROPIC_DEFAULT_${tier}_MODEL`], "deepseek-flash");
});

test("record-page navigation does not consume submission authorization", () => {
  const action = { kind: "click", ref: "e5", effect: "read", summary: "查看记录" };
  for (const label of ["提交记录", "订单详情", "查看申请状态", "View submission history"]) {
    assert.equal(effectiveEffect(action, { snapshot: `- link "${label}" [ref=e5]` }), "read");
  }
  assert.equal(effectiveEffect(action, { snapshot: '- button "提交申请" [ref=e5]' }), "submit");
  assert.equal(effectiveEffect(action, { snapshot: '- button "删除记录" [ref=e5]' }), "delete");
});

test("Windows pointer preparation paints the frame and sends a submission click only once", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t); const commands = [];
  const browser = new WrapperBrowser(f.store.root, async (_task, args) => {
    commands.push(args); if (args[0] === "screenshot") writeFileSync(args[1], "temporary frame"); return "ok";
  });
  await browser.execute(f.task, { kind: "click", ref: "@e2", effect: "submit", summary: "Submit" });
  assert.deepEqual(commands.map(args => args[0]), ["scrollintoview", "screenshot", "click"]);
  assert.equal(require("node:fs").existsSync(commands[1][1]), false);
});

for (const status of ["cancelled", "failed", "partial", "completed"]) {
  test(`continue ${status} task preserves its conversation and spent authorization`, async t => {
    const f = fixture(t); f.service.runs.delete(f.task.id);
    f.task.status = status; f.task.port = 9223; f.task.sdkSessionId = "original-sdk-session";
    f.task.result = { summary: "Earlier result", evidence: ["receipt"], remaining: ["verify"] };
    f.task.items = [{ id: "done", label: "Done", status: "completed" }];
    f.task.grant = { origin: "https://example.test", effects: ["submit"], maxActions: 3, used: 2 };
    const originalId = f.task.id, sessionId = f.task.sessionId;
    const message = "只补充今天的内容，保留上次结果。\n不要重复提交。";
    await f.service.control(originalId, status === "cancelled" ? "rerun" : "resume", message);
    assert.equal(f.store.data.tasks.length, 1);
    assert.equal(f.task.id, originalId); assert.equal(f.task.sessionId, sessionId);
    assert.equal(f.task.sdkSessionId, "original-sdk-session");
    assert.equal(f.task.status, "queued"); assert.equal(f.task.result, undefined);
    assert.equal(f.task.items[0].status, "completed"); assert.equal(f.task.grant.used, 2);
    assert.equal(f.task.resumeContext.observed, false);
    assert.ok(f.task.events.some(event => event.text.includes("Earlier result")));
    assert.equal(f.task.events.filter(event => event.kind === "user" && event.text === message).length, 1);
    assert.equal(f.task.events.filter(event => event.kind === "user").at(-1).text, message);
    assert.equal(f.task.events.filter(event => event.kind === "user").length, 2, "only the original request and the actual follow-up belong to the user");
    assert.deepEqual(f.calls, [], "released browser must be reacquired through the normal ownership checks");
    await assert.rejects(f.service.control(originalId, "resume"), /正在执行或排队/);
  });
}

test("continuation refuses an exhausted budget without altering history", async t => {
  const f = fixture(t); f.service.runs.delete(f.task.id); f.task.status = "cancelled";
  f.task.usage.actions = f.task.limits.actions;
  f.task.result = { summary: "Previous result", evidence: [], remaining: [] };
  await assert.rejects(f.service.control(f.task.id, "resume"), /运行限制/);
  assert.equal(f.task.status, "cancelled"); assert.equal(f.task.result.summary, "Previous result");
  assert.equal(f.store.data.tasks.length, 1);
});

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-tasks-"));
  const store = new TaskStore(root);
  const task = store.create({ prompt: "填写申请并提交", profileId: "isolated:test" }, "Test profile");
  let snapshot = '- textbox "姓名" [ref=e1]\n- button "提交申请" [ref=e2]';
  const calls = [];
  const browser = {
    observe: async () => ({ version: "observed", at: new Date().toISOString(), url: "https://example.test/apply", title: "申请", snapshot, account: "账号未确认", fingerprint: observationFingerprint("https://example.test/apply", snapshot) }),
    execute: async (_task, action) => { calls.push(action); return "clicked"; },
    tabs: async () => [], control: async (_task, command) => { calls.push(command); }
  };
  const service = new TaskService(store, { browser, apiKey: () => "", prepareProfile: async () => ({ port: 9223, name: "Test" }), profileName: async () => "Test", changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
  service.runs.set(task.id, run); task.status = "running";
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, task, service, run, browser, calls, setSnapshot: (value) => snapshot = value };
}

test('changing action summaries cannot bypass repeated no-progress handoff', async t => {
  const f = fixture(t); f.task.port = 9223;
  for (let i = 0; i < 3; i++) {
    await f.service.handleTool(f.task, f.run, 'observe', {});
    await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'press', value: 'Tab', effect: 'read', version: f.task.observation.version, summary: `Try ${i}` });
  }
  await f.service.handleTool(f.task, f.run, 'observe', {});
  await assert.rejects(f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'press', value: 'Tab', effect: 'read', version: f.task.observation.version, summary: 'Another description' }), /停止重复尝试/);
  assert.equal(f.task.status, 'waiting_user'); assert.equal(f.task.pending.kind, 'handoff');
  assert.equal(f.task.receipts.length, 3); assert.ok(f.calls.includes('handoff'));
});

test('repeating an action on pages that actually change remains allowed', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) {
    f.setSnapshot(`Page ${i}`);
    await f.service.handleTool(f.task, f.run, 'observe', {});
    await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'press', value: 'ArrowDown', effect: 'read', version: f.task.observation.version, summary: 'Next' });
  }
  assert.equal(f.task.status, 'running'); assert.equal(f.task.receipts.length, 5);
});

test('human return retains context and requires observation before new navigation', async t => {
  const f = fixture(t);
  f.task.resumeContext = { reason: '登录', url: 'https://example.test/', returnedAt: new Date().toISOString(), observed: false };
  const action = { kind: 'open', value: 'https://example.test/login', effect: 'read', summary: 'Check login' };
  const blocked = await f.service.handleTool(f.task, f.run, 'browser_action', action);
  assert.equal(blocked.isError, true); assert.equal(f.calls.length, 0);
  const observation = await f.service.handleTool(f.task, f.run, 'observe', {});
  assert.equal(f.task.resumeContext.observed, true);
  assert.equal(JSON.parse(observation.content[0].text).resumeContext.reason, '登录');
});

test('main model can request DOM layout when regular page refs omit an icon', async t => {
  const f = fixture(t);
  f.browser.observeFast = async () => ({ ...(await f.browser.observe()), fast: { document: 'd', guard: 'g', candidates: [{ ref: 'e1', role: 'button', label: '个人中心', kind: 'click', offscreen: true }] } });
  const result = await f.service.handleTool(f.task, f.run, 'observe', { layout: true });
  assert.equal(JSON.parse(result.content[0].text).fast.candidates[0].label, '个人中心');
  assert.ok(f.task.observation.fast);
});

test('cancellation records an honest partial summary without claiming clicks completed the goal', async t => {
  const f = fixture(t);
  await f.service.handleTool(f.task, f.run, 'observe', {});
  await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'press', value: 'Tab', effect: 'read', version: f.task.observation.version, summary: '查找账号入口' });
  await f.service.control(f.task.id, 'cancel');
  assert.equal(f.task.status, 'cancelled'); assert.match(f.task.result.summary, /查找账号入口/);
  assert.match(f.task.result.summary, /尚未确认全部完成/);
  assert.equal(f.task.result.evidence.length, 0); assert.ok(f.task.result.remaining.length);
});

for (const status of ["completed", "partial", "failed"]) {
  test(`deadline drains a ${status} task while the SDK final response is pending`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { EventEmitter } = require("node:events");
    const f = fixture(t);
    const child = new EventEmitter();
    child.connected = true; child.exitCode = null; child.signalCode = null;
    let stopped = 0;
    child.send = message => {
      if (message.kind === "stop") {
        stopped++;
        queueMicrotask(() => { child.connected = false; child.exitCode = 0; child.emit("exit", 0); });
      }
    };
    child.kill = () => { throw new Error("Cooperative SDK stop should not require killing"); };
    f.service.dependencies.apiKey = () => "test-key";
    f.service.dependencies.worker = () => child;
    f.task.limits.minutes = 1;
    await f.service.startRun(f.task, f.run);
    f.task.observation = await f.browser.observe();
    await f.service.handleTool(f.task, f.run, "finish", { status, summary: "结果已保存", evidence: ["提交申请"], remaining: [] });
    assert.equal(f.service.runs.has(f.task.id), true, "SDK has not exited yet");
    t.mock.timers.tick(60000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.task.status, status);
    assert.equal(stopped, 1);
    assert.equal(f.service.runs.has(f.task.id), false);
    assert.deepEqual(f.calls, ["complete"]);
    assert.equal(f.task.events.some(e => e.text.includes("已暂停")), false);
  });
}

test("handoff keeps a live desktop receiver until return or shutdown", async t => {
  const f = fixture(t); const receivers = new Set();
  f.service.dependencies.controlReceiver = (session, waiting) => waiting ? receivers.add(session) : receivers.delete(session);
  f.task.port = 9224;
  await f.service.control(f.task.id, "takeover");
  assert.ok(receivers.has(f.task.sessionId));
  f.service.runs.clear();
  f.service.externalControl(f.task.sessionId, "agent", "active", "user-return");
  assert.equal(f.task.status, "queued"); assert.equal(receivers.size, 0);
  f.task.status = "waiting_user"; f.task.pending = { kind: "handoff" }; f.service.publish();
  assert.equal(receivers.size, 1);
  await f.service.close(); assert.equal(receivers.size, 0);
});

test("disabling screenshot retention still supplies vision without storing image data", async t => {
  const f = fixture(t); f.store.data.settings.saveScreenshots = false;
  const observe = f.browser.observe;
  f.browser.observe = async (_task, screenshot, retain) => {
    assert.equal(screenshot, true); assert.equal(retain, false);
    return { ...await observe(), screenshotDataUrl: "data:image/png;base64,aW1hZ2U=" };
  };
  const result = await f.service.handleTool(f.task, f.run, "observe", { screenshot: true });
  assert.ok(result.content.some(block => block.type === "image"));
  assert.equal(f.task.observation.screenshotDataUrl, undefined);
  assert.ok(!readFileSync(f.store.file, "utf8").includes("aW1hZ2U="));
});

test("selected retries preserve completed items, frozen materials and used authorization", async t => {
  const f = fixture(t); f.service.runs.clear(); f.task.status = "partial";
  f.task.items = [{ id: "done", label: "已投递", status: "completed" }, { id: "failed", label: "未成功", status: "failed" }, { id: "unknown", label: "待核查", status: "uncertain" }];
  f.task.materials = [{ id: "removed-from-library", version: 2, content: "原资料" }];
  f.task.grant = { origin: "https://example.test", effects: ["submit"], maxActions: 3, used: 2 };
  f.task.receipts = [{ id: "submitted", action: { kind: "click", effect: "submit", summary: "提交" }, status: "executed" }];
  await assert.rejects(f.service.retryItems(f.task.id, ["done"]));
  const retry = await f.service.retryItems(f.task.id, ["failed", "unknown"]);
  assert.equal(retry.items.length, 2); assert.equal(retry.sourceTaskId, f.task.id);
  assert.equal(retry.items[1].status, "uncertain"); assert.equal(retry.grant.used, 2);
  assert.equal(retry.materials[0].content, "原资料"); assert.equal(retry.needsReconciliation, true);
  assert.equal(retry.receipts[0].status, "uncertain"); assert.equal(f.task.receipts[0].status, "executed");
  assert.equal(f.task.items[0].status, "completed"); assert.equal(retry.sdkSessionId, undefined);
});
test("interrupted submission becomes uncertain and never automatically reruns", (t) => {
  const f = fixture(t);
  f.task.receipts.push({ id: "receipt", at: new Date().toISOString(), status: "started", action: { kind: "click", effect: "submit", summary: "投递" } });
  f.store.save();
  const recovered = new TaskStore(f.store.root).get(f.task.id);
  assert.equal(recovered.status, "paused"); assert.equal(recovered.needsReconciliation, true);
  assert.equal(recovered.receipts[0].status, "uncertain");
});
test("corrupt storage fails without overwriting the original", (t) => {
  const f = fixture(t); writeFileSync(f.store.file, "broken{");
  assert.throws(() => new TaskStore(f.store.root)); assert.equal(readFileSync(f.store.file, "utf8"), "broken{");
});
test("material contents are pinned to the version selected by the task", (t) => {
  const f = fixture(t); f.store.data.materials.push({ id: "m1", name: "简历", content: "旧资料", scope: "申请", version: 1, updatedAt: "now" });
  const task = f.store.create({ prompt: "填写", profileId: "p", materialIds: ["m1"] }, "P");
  f.store.data.materials[0].content = "新资料"; assert.equal(task.materials[0].content, "旧资料");
});
test("stale references cannot execute actions after a dynamic page change", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  f.setSnapshot('- textbox "其他账号" [ref=e1]');
  const result = await f.service.handleTool(f.task, f.run, "browser_action", { kind: "fill", ref: "@e1", value: "Alice", version: "observed", effect: "edit", summary: "填写姓名" });
  assert.equal(result.isError, true); assert.equal(f.calls.length, 0);
});
test("submit-like button is confirmed even if the model labels it as read", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "read", summary: "提交申请" });
  assert.equal(f.task.status, "waiting_user"); assert.equal(f.task.pending.action.effect, "submit"); assert.equal(f.calls.length, 0);
});
test("changed facts invalidate a pending approval without clicking", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  f.service.runs.clear(); f.setSnapshot('- button "提交到另一公司" [ref=e2]');
  await f.service.reply(f.task.id, f.task.pending.id, "确认", true);
  assert.equal(f.calls.length, 0); assert.equal(f.task.status, "queued"); assert.equal(f.task.pending, undefined);
});
test("approval is consumed once and duplicate reply cannot resubmit", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  const id = f.task.pending.id; f.service.runs.clear();
  await f.service.reply(f.task.id, id, "确认", true);
  await assert.rejects(f.service.reply(f.task.id, id, "确认", true));
  assert.equal(f.calls.length, 1); assert.equal(f.task.receipts[0].status, "executed");
});
test("paused task refuses tool calls even if the SDK returns a late action", async (t) => {
  const f = fixture(t); await f.service.control(f.task.id, "pause");
  await assert.rejects(f.service.handleTool(f.task, f.run, "browser_action", { kind: "open", value: "https://example.test", effect: "read", summary: "打开网页" }));
  assert.equal(f.calls.length, 0);
});

test("pause after a submission requires reconciliation before continuing", async t => {
  const f = fixture(t);
  f.task.receipts.push({ id: "submitted", at: new Date().toISOString(), status: "executed", action: { kind: "click", effect: "submit", summary: "提交后立即暂停" } });
  await f.service.control(f.task.id, "pause"); await f.service.endRun(f.task, f.run);
  assert.equal(f.task.receipts[0].status, "uncertain"); assert.equal(f.task.needsReconciliation, true);
  await f.service.control(f.task.id, "resume"); assert.equal(f.task.needsReconciliation, true);
});
test("an unverified model completion cannot mark a task complete", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  const result = await f.service.handleTool(f.task, f.run, "finish", { status: "completed", summary: "完成", evidence: ["不存在的成功编号"], remaining: [] });
  assert.equal(result.isError, true); assert.equal(f.task.status, "running");
});
test("visible receipt supports completion and records evidence", async (t) => {
  const f = fixture(t); f.setSnapshot("申请已提交，编号 ABC-123"); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "finish", { status: "completed", summary: "申请已提交", evidence: ["编号 ABC-123"], remaining: [] });
  assert.equal(f.task.status, "completed"); assert.deepEqual(f.task.result.evidence, ["编号 ABC-123"]);
});
test("diagnostics omit personal data, page content, files and credential fields", (t) => {
  const f = fixture(t); f.task.events.push({ text: "private@example.com", kind: "user", at: "now", id: "e" });
  f.task.materials.push({ content: "private@example.com" });
  const result = JSON.stringify(scrubDiagnostics(f.store.snapshot()));
  assert.equal(result.includes("private@example.com"), false); assert.equal(result.includes("prompt"), false);
});
test("browser bridge rejects arbitrary paths and privileged URLs", async (t) => {
  const f = fixture(t); const calls = []; const bridge = new WrapperBrowser(f.store.root, async (_task, args) => calls.push(args));
  await assert.rejects(bridge.execute(f.task, { kind: "open", value: "file:///C:/secret.txt", effect: "read", summary: "读取" }));
  await assert.rejects(bridge.execute(f.task, { kind: "upload", ref: "@e1", attachmentId: "not-approved", effect: "edit", summary: "上传" }));
  assert.equal(calls.length, 0);
});
test("CLI result reports errors rather than turning them into successful text", () => {
  assert.deepEqual(parseCliResult('{"success":true,"data":{"url":"https://example.test"}}'), { url: "https://example.test" });
  assert.throws(() => parseCliResult('{"success":false,"error":"AGENT_USER_IN_CONTROL"}'), /AGENT_USER_IN_CONTROL/);
});
test("worker environment does not inherit agent credentials or session identity", () => {
  const before = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "test-secret";
  assert.equal(workerEnvironment().ANTHROPIC_API_KEY, undefined); assert.equal(workerEnvironment().AGENT_BROWSER_SESSION, undefined);
  if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before;
});
test("a managed launcher from another HOME cannot be selected as the real browser CLI", (t) => {
  if (process.platform !== "win32") return t.skip("Windows cmd launcher regression");
  const { resolveRealAgentBrowser } = require("../dist/main/agent-browser-wrapper");
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "agent-browser.cmd"), '@echo off\nnode "C:\\other\\profilepilot-agent-browser-wrapper.cjs" %*');
  assert.equal(resolveRealAgentBrowser({ PATH: root, HOME: path.join(root, "unrelated-home"), PATHEXT: ".CMD" }), null);
});
test("a simultaneous duplicate approval cannot execute twice", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  f.service.runs.clear(); const decision = f.task.pending.id;
  const results = await Promise.allSettled([f.service.reply(f.task.id, decision, "确认", true), f.service.reply(f.task.id, decision, "确认", true)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.calls.length, 1);
});
test("cancel during approval page verification prevents the queued click", async (t) => {
  const f = fixture(t); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  f.service.runs.clear(); let finish; const observed = f.task.observation;
  f.browser.observe = () => new Promise(resolve => finish = resolve);
  const approval = f.service.reply(f.task.id, f.task.pending.id, "确认", true);
  await f.service.control(f.task.id, "cancel"); finish(observed);
  await assert.rejects(approval, /已取消/); assert.equal(f.calls.length, 0); assert.equal(f.task.status, "cancelled");
});
test("explicit per-origin grant avoids repeated confirmation and stops at its quota", async (t) => {
  const f = fixture(t); f.task.grant = { origin: "https://example.test", effects: ["submit"], maxActions: 1, used: 0 };
  await f.service.handleTool(f.task, f.run, "observe", {});
  const action = { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" };
  await f.service.handleTool(f.task, f.run, "browser_action", action); assert.equal(f.calls.length, 1);
  await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", action);
  assert.equal(f.calls.length, 1); assert.equal(f.task.pending.kind, "confirmation");
});
test("daily schedules retain the selected wall-clock time across DST", () => {
  const { zonedLocalToIso, nextDailyOccurrence } = require("../dist/shared/task-time");
  assert.equal(zonedLocalToIso("2026-09-19T09:00", "Asia/Shanghai"), "2026-09-19T01:00:00.000Z");
  assert.equal(nextDailyOccurrence("2026-03-07T14:00:00.000Z", "America/New_York", Date.parse("2026-03-07T14:00:00.000Z")), "2026-03-08T13:00:00.000Z");
  assert.throws(() => zonedLocalToIso("2026-03-08T02:30", "America/New_York"), /不存在/);
});

test("shutdown drains an in-flight submission, preserves uncertainty and returns browser control", async (t) => {
  const f = fixture(t); f.task.port = 9223;
  f.task.grant = { origin: "https://example.test", effects: ["submit"], maxActions: 1, used: 0 };
  await f.service.handleTool(f.task, f.run, "observe", {});
  let complete; const started = new Promise(resolve => { f.browser.execute = async () => { resolve(); return new Promise(done => complete = done); }; });
  f.run.chain = f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  await started;
  let closed = false; const closing = f.service.close().then(() => closed = true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(f.task.status, "paused"); assert.ok(f.calls.includes("handoff"));
  complete("request sent"); await closing;
  assert.equal(f.task.receipts[0].status, "uncertain"); assert.equal(f.task.needsReconciliation, true);
  assert.equal(new TaskStore(f.store.root).get(f.task.id).needsReconciliation, true);
});

test("shutdown also invalidates an idle confirmation and hands it back", async (t) => {
  const f = fixture(t); f.task.port = 9223;
  await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "browser_action", { kind: "click", ref: "@e2", version: "observed", effect: "submit", summary: "提交" });
  f.service.runs.clear(); await f.service.close();
  assert.equal(f.task.pending, undefined); assert.equal(f.task.status, "paused"); assert.deepEqual(f.calls, ["handoff"]);
});

test("return from the browser overlay resumes a waiting task after fresh observation", async (t) => {
  const f = fixture(t); f.service.runs.clear();
  f.task.status = "waiting_user"; f.task.pending = { id: "handoff", kind: "handoff", title: "登录", details: "", createdAt: "now" };
  f.task.observation = await f.browser.observe();
  f.service.externalControl(f.task.sessionId, "agent", "active", "connection-updated");
  assert.equal(f.task.status, "waiting_user");
  f.service.externalControl(f.task.sessionId, "agent", "active", "user-return");
  assert.equal(f.task.status, "queued"); assert.equal(f.task.pending, undefined); assert.equal(f.task.observation, undefined);
});

test("ending a waiting browser session cancels its task", async (t) => {
  const f = fixture(t); f.task.status = "waiting_user"; f.task.pending = { id: "q", kind: "question" };
  f.service.externalControl(f.task.sessionId, "user", "stopped", "session-stopped");
  assert.equal(f.task.status, "cancelled"); assert.equal(f.task.pending, undefined); assert.equal(f.run.stopped, true);
});

test("after a read-only interruption, a fresh observation permits continuing", async (t) => {
  const f = fixture(t); f.task.needsReconciliation = true;
  await f.service.handleTool(f.task, f.run, "observe", {});
  assert.equal(f.task.needsReconciliation, false);
});

test("unresolved submission prevents completion even with an unrelated visible success phrase", async (t) => {
  const f = fixture(t); f.task.needsReconciliation = true;
  f.task.receipts.push({ id: "r", status: "uncertain", action: { effect: "submit" } });
  f.setSnapshot("页面已加载成功"); await f.service.handleTool(f.task, f.run, "observe", {});
  const result = await f.service.handleTool(f.task, f.run, "finish", { status: "completed", summary: "完成", evidence: ["页面已加载成功"], remaining: [] });
  assert.equal(result.isError, true); assert.equal(f.task.status, "running");
});

test("reaching the action limit still permits observing and reporting the final result", async (t) => {
  const f = fixture(t); f.task.usage.actions = f.task.limits.actions;
  f.setSnapshot("提交完成，编号 ABC-123"); await f.service.handleTool(f.task, f.run, "observe", {});
  await f.service.handleTool(f.task, f.run, "finish", { status: "completed", summary: "完成", evidence: ["编号 ABC-123"], remaining: [] });
  assert.equal(f.task.status, "completed");
});

test("Windows download paths are normalized without changing the destination or other platforms", () => {
  const { chromiumDownloadParams } = require("../dist/main/browser-gateway-policy");
  const params = { behavior: "allow", downloadPath: "\\\\?\\C:\\任务\\downloads", eventsEnabled: true };
  assert.deepEqual(chromiumDownloadParams(params, "win32"), { ...params, downloadPath: "C:\\任务\\downloads" });
  assert.equal(chromiumDownloadParams(params, "darwin"), params);
  assert.equal(chromiumDownloadParams({ downloadPath: "\\\\?\\UNC\\server\\share" }, "win32").downloadPath, "\\\\server\\share");
});

test("table pagination returns valid bounded JSON with a continuation row", async (t) => {
  const f = fixture(t); const { readTaskTable } = require("../dist/main/tasks/files");
  const file = path.join(f.store.root, "data.csv");
  writeFileSync(file, "name,value\n" + Array.from({ length: 100 }, (_, i) => `item-${i},${"x".repeat(1900)}`).join("\n"));
  f.task.attachments.push({ id: "csv", path: file, name: "data.csv", size: 200000 });
  const first = await readTaskTable(f.task, { attachmentId: "csv", count: 100 });
  assert.ok(first.nextRow > 1 && first.nextRow < 101); assert.equal(first.totalRows, 101);
  const second = await readTaskTable(f.task, { attachmentId: "csv", startRow: first.nextRow, count: 1 });
  assert.equal(second.rows[0][0], `item-${first.nextRow - 2}`);
  await assert.rejects(readTaskTable(f.task, { attachmentId: "unselected" }), /未获/);
});

test("generated result files are readable within their task and CSV cannot inject formulas", (t) => {
  const f = fixture(t); const { writeTaskResult, canReadTaskFile } = require("../dist/main/tasks/files");
  const file = writeTaskResult(f.task, path.join(f.store.root, "artifacts"), { name: "结果", format: "csv", columns: ["name", "value"], rows: [["测试", "=HYPERLINK(\"https://evil.test\")"]] });
  assert.ok(readFileSync(file.path, "utf8").includes("'=HYPERLINK"));
  f.task.attachments.unshift({ id: "missing", path: path.join(f.store.root, "missing") });
  assert.equal(canReadTaskFile(f.task, file.path), true);
  assert.equal(canReadTaskFile({ attachments: [] }, file.path), false);
  assert.equal(canReadTaskFile(f.task, f.store.file), false);
});

test("same-profile tasks queue while another profile can run, including during user handoff", async (t) => {
  const { EventEmitter } = require("node:events");
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-queue-")); const store = new TaskStore(root);
  const controls = [];
  const service = new TaskService(store, { apiKey: () => "fixture", profileName: async id => id, prepareProfile: async id => ({ port: id === "a" ? 9223 : 9224, name: id }),
    changed: () => {}, notify: () => {}, browser: { control: async (task, command) => controls.push([task.id, command]) },
    worker: () => { const child = new EventEmitter(); child.connected = true; child.exitCode = null; child.signalCode = null;
      child.send = message => { if (message.kind === "stop") queueMicrotask(() => { child.connected = false; child.exitCode = 0; child.emit("exit", 0); }); }; child.kill = () => { child.exitCode = 0; child.emit("exit", 0); }; return child; } });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const first = store.create({ profileId: "a", prompt: "first" }, "A");
  const second = store.create({ profileId: "a", prompt: "second" }, "A");
  const other = store.create({ profileId: "b", prompt: "other" }, "B");
  await service.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.status, "running"); assert.equal(second.status, "queued"); assert.equal(other.status, "running");
  await service.control(first.id, "takeover"); await new Promise(resolve => setImmediate(resolve)); await service.tick();
  assert.equal(first.status, "waiting_user"); assert.equal(second.status, "queued");
  await service.control(first.id, "cancel"); await service.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.status, "running"); assert.ok(controls.some(([id, action]) => id === first.id && action === "release"));
});

test("missed schedules do not backfill external work and due schedules persist their execution", async (t) => {
  const f = fixture(t); f.service.runs.clear(); f.task.status = "cancelled";
  f.store.data.schedules.push({ id: "missed", name: "missed", enabled: true, repeat: "once", timezone: "UTC", at: new Date(Date.now() - 600000).toISOString(), task: { prompt: "do not backfill", profileId: "p" } });
  f.store.data.schedules.push({ id: "due", name: "due", enabled: true, repeat: "once", timezone: "UTC", at: new Date(Date.now() - 1000).toISOString(), task: { prompt: "scheduled", profileId: "p" } });
  await TaskService.prototype.tick.call(f.service);
  assert.ok(f.store.data.schedules[0].missedAt); assert.equal(f.store.data.schedules[0].lastTaskId, undefined);
  const scheduled = f.store.data.tasks.find(task => task.prompt === "scheduled");
  assert.equal(scheduled.scheduledBy, "due"); assert.equal(f.store.data.schedules[1].lastTaskId, scheduled.id);
});
