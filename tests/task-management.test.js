const { readTaskRecords } = require('./helpers/task-records.cjs');
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { startProfilePilotManagementServer } = require("../dist/main/profilepilot-management-server");
const { PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES } = require("../dist/main/profilepilot-management-protocol");
const { initializeDiagnosticLogging } = require("../dist/main/diagnostic-log");

test("authenticated task commands share the desktop store and controls", async t => {
  const f = await fixture(t);
  const review = await f.request({ action: "task.review.status" });
  assert.equal(review.ok, true);
  assert.equal(review.data.settings.enabled, false);
  const arranged = await f.request({ action: "task.review.configure", input: { time: "19:30", timezone: "Asia/Shanghai" } });
  assert.equal(arranged.data.settings.time, "19:30");
  assert.equal((await f.request({ action: "task.review.configure", input: { enabledAt: "2020-01-01T00:00:00Z" } })).ok, false);
  const prompt = "TASK_PRIVATE_PROMPT_测试";
  const created = await f.request({ action: "task.create", profile: "Test browser", input: { prompt, limits: { minutes: 7 } } });
  assert.equal(created.ok, true);
  const id = created.data.task.id;
  assert.equal(created.data.task.profileId, "isolated:test");
  assert.equal(created.data.task.running, false);
  assert.equal(created.data.task.limits.minutes, 7);
  assert.equal(f.store.get(id).prompt, prompt);
  await new Promise(resolve => setTimeout(resolve, 100)); // Desktop broadcasts coalesce.
  assert.equal(f.snapshots.at(-1).tasks[0].id, id);
  assert.equal(readTaskRecords(f.store.file).tasks[0].id, id);
  const listed = await f.request({ action: "task.list", limit: 1 });
  assert.equal(listed.data.total, 1);
  assert.equal(listed.data.tasks[0].id, id);
  assert.equal(listed.data.tasks[0].prompt, undefined);
  assert.equal(listed.data.tasks[0].pending, undefined);
  const stopped = await f.request({ action: "task.control", id, control: "pause" });
  assert.equal(stopped.data.task.status, "paused");
  const continued = await f.request({ action: "task.control", id, control: "resume", message: "FOLLOWUP_PRIVATE_TEXT" });
  assert.equal(continued.data.task.id, id);
  assert.equal(continued.data.task.status, "queued");
  const steered = await f.request({ action: "task.control", id, control: "steer", message: "STEER_PRIVATE_TEXT" });
  assert.equal(steered.data.task.status, "queued");
  const handed = await f.request({ action: "task.control", id, control: "takeover" });
  assert.equal(handed.data.task.pending.kind, "handoff");
  const decisionId = handed.data.task.pending.id;
  for (const approved of [undefined, false]) {
    const refused = await f.request({ action: "task.reply", id, decisionId, answer: "", ...(approved === undefined ? {} : { approved }) });
    assert.equal(refused.error.code, "TASK_APPROVAL_REQUIRED");
    assert.equal(f.store.get(id).pending.id, decisionId);
  }
  const returned = await f.request({ action: "task.reply", id, decisionId, answer: "HANDOFF_PRIVATE_TEXT", approved: true });
  assert.equal(returned.data.task.status, "queued");
  assert.equal(returned.data.task.pending, undefined);
  assert.equal((await f.request({ action: "task.reply", id, decisionId, answer: "", approved: true })).ok, false);
  await f.request({ action: "task.control", id, control: "takeover" });
  assert.equal((await f.request({ action: "task.control", id, control: "resume" })).data.task.status, "queued");
  assert.equal((await f.request({ action: "task.control", id, control: "cancel" })).data.task.status, "cancelled");
  assert.equal(f.store.data.tasks.length, 1);
  const log = fs.readFileSync(path.join(f.logs, "profilepilot.log.jsonl"), "utf8");
  for (const secret of [prompt, "FOLLOWUP_PRIVATE_TEXT", "STEER_PRIVATE_TEXT", "HANDOFF_PRIVATE_TEXT"]) assert.equal(log.includes(secret), false);
});

test("task socket rejects malformed, unauthenticated and unknown mutation requests", async t => {
  const f = await fixture(t);
  const id = randomUUID(), decisionId = randomUUID();
  const invalid = [
    { action: "task.create", profile: "Test browser", input: { prompt: "" } },
    { action: "task.create", profile: "Test browser", input: { prompt: "hello", profileId: "isolated:other" } },
    { action: "task.create", profile: "Test browser", input: { prompt: "hello", extra: true } },
    { action: "task.create", profile: "Test browser", input: { prompt: "hello", limits: { minutes: 0 } } },
    { action: "task.create", profile: "Test browser", input: { prompt: "hello", grant: { origin: "https://user:pass@example.test", effects: ["submit"], maxActions: 1 } } },
    { action: "task.get", id: "not-a-uuid" },
    { action: "task.get", id, after: -1 },
    { action: "task.get", id, after: 0.5 },
    { action: "task.get", id, limit: 201 },
    { action: "task.list", limit: 101 },
    { action: "task.list", offset: "0" },
    { action: "task.list", token: "injected" },
    { action: "task.control", id, control: "delete" },
    { action: "task.reply", id, decisionId, answer: "yes", approved: "true" },
    { action: "task.reply", id, decisionId, answer: "yes", approved: 1 },
    { action: "task.reply", id, decisionId: "stale", answer: "yes", approved: true },
    { action: "task.reply", id, decisionId },
    { action: "task.unknown", id }
  ];
  for (const command of invalid) {
    const response = await f.request(command);
    assert.equal(response.ok, false, JSON.stringify(command));
    assert.equal(response.error.code, "TASK_COMMAND_INVALID", JSON.stringify(command));
  }
  assert.equal((await f.request({ action: "task.get", id })).error.code, "TASK_NOT_FOUND");
  assert.equal((await f.request({ action: "task.list", offset: 1 })).error.code, "TASK_CURSOR_INVALID");
  const unauthorized = await f.request({ action: "task.create", profile: "Test browser", input: { prompt: "unauthorized" } }, "0".repeat(64));
  assert.equal(unauthorized.error.code, "MANAGEMENT_UNAUTHORIZED");
  const unknown = await f.request({ action: "profile.oops", selector: "isolated:test", confirmed: true });
  assert.equal(unknown.error.code, "MANAGEMENT_COMMAND_UNKNOWN");
  assert.equal(f.deleted.length, 0);
  assert.equal(f.store.data.tasks.length, 0);
  f.setAvailable(false);
  assert.equal((await f.request({ action: "task.list" })).error.code, "TASK_SERVICE_UNAVAILABLE");
});

test("task reply requires explicit decisions and hides stored browser and material data", async t => {
  const f = await fixture(t);
  const task = f.store.create({ prompt: "test", profileId: "isolated:test" }, "Test browser");
  const id = task.id;
  task.status = "waiting_user";
  task.pending = { id: randomUUID(), kind: "confirmation", title: "Send", details: "Submit the form", createdAt: new Date().toISOString(), action: { kind: "fill", effect: "submit", summary: "submit", ref: "e1", value: "SECRET_VALUE" } };
  task.observation = { version: "v1", snapshot: "PRIVATE_PAGE", screenshotDataUrl: "PRIVATE_SCREENSHOT" };
  task.materials = [{ content: "PRIVATE_MATERIAL" }];
  task.receipts = [{ action: { value: "PRIVATE_RECEIPT" } }];
  task.attachments = [{ path: "PRIVATE_ATTACHMENT" }];
  task.sdkSessionId = "PRIVATE_SDK_SESSION";
  const page = await f.request({ action: "task.get", id });
  const json = JSON.stringify(page);
  for (const value of ["SECRET_VALUE", "PRIVATE_PAGE", "PRIVATE_SCREENSHOT", "PRIVATE_MATERIAL", "PRIVATE_RECEIPT", "PRIVATE_ATTACHMENT", "PRIVATE_SDK_SESSION"]) assert.equal(json.includes(value), false);
  assert.equal(page.data.task.pending.action.summary, "submit");
  const decisionId = task.pending.id;
  assert.equal((await f.request({ action: "task.reply", id, decisionId, answer: "yes" })).error.code, "TASK_APPROVAL_REQUIRED");
  assert.equal(task.pending.id, decisionId);
  assert.equal(f.browserCalls.length, 0);
  assert.equal((await f.request({ action: "task.reply", id, decisionId: randomUUID(), answer: "", approved: true })).ok, false);
  assert.equal(task.pending.id, decisionId);
  assert.equal((await f.request({ action: "task.reply", id, decisionId, answer: "deny", approved: false })).data.task.status, "queued");
  assert.equal(f.browserCalls.length, 0);
  task.status = "waiting_user";
  task.pending = { id: randomUUID(), kind: "question", title: "Which?", details: "Choose a city", createdAt: new Date().toISOString() };
  const question = task.pending.id;
  assert.equal((await f.request({ action: "task.reply", id, decisionId: question, answer: "  " })).error.code, "TASK_ANSWER_REQUIRED");
  assert.equal((await f.request({ action: "task.reply", id, decisionId: question, answer: "Shanghai" })).data.task.status, "queued");
  assert.equal(task.events.at(-1).text, "Shanghai");
  // Restore realistic stored data before service shutdown validates receipts.
  task.receipts = []; task.attachments = [];
});

test("event cursors preserve exact text across bounded pages and large task results", async t => {
  const f = await fixture(t);
  const task = f.store.create({ prompt: "test", profileId: "isolated:test" }, "Test browser");
  task.events = [];
  for (let i = 0; i < 12; i++) f.store.event(task, "assistant", `${i}:` + "\u0000".repeat(29990));
  task.result = { summary: "large result ".repeat(150000), evidence: ["proof"], remaining: [] };
  task.items = Array.from({ length: 500 }, (_, index) => ({ id: String(index), label: "label".repeat(600), status: "pending", result: "detail".repeat(5000) }));
  const collected = [];
  let cursor = 0, pageCount = 0;
  for (;;) {
    const response = await f.request({ action: "task.get", id: task.id, after: cursor, limit: 200 });
    assert.equal(response.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES);
    const page = response.data;
    assert.ok(page.task.truncated.includes("result"));
    assert.ok(page.task.truncated.includes("items"));
    assert.equal(page.cursor, cursor + page.events.length);
    collected.push(...page.events); cursor = page.cursor; pageCount++;
    if (!page.hasMore) break;
    assert.ok(page.events.length > 0);
  }
  assert.ok(pageCount > 1);
  assert.deepEqual(collected, task.events);
  assert.equal(cursor, task.events.length);
  const empty = await f.request({ action: "task.get", id: task.id, after: cursor });
  assert.deepEqual(empty.data.events, []);
  assert.equal(empty.data.hasMore, false);
  const reset = await f.request({ action: "task.get", id: task.id, after: cursor + 1 });
  assert.equal(reset.ok, true); assert.equal(reset.data.reset, true);
  assert.equal(reset.data.events[0].id, task.events[0].id);
});

test("expanded management protocol supports schedule/template/material listing and task.detail/search/pin/archive/delete", async t => {
  const { loadCli } = require("./cli-test-build.cjs");
  const { TaskStore: LiveStore } = loadCli("src/main/tasks/store.ts");
  const { TaskService: LiveService } = loadCli("src/main/tasks/service.ts");
  const { parseTaskManagementCommand, executeTaskManagementCommand } = loadCli("src/main/tasks/management.ts");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pptm-ext-"));
  const store = new LiveStore(path.join(root, "tasks"));
  const service = new LiveService(store, {
    browser: { observe: async () => ({}), execute: async () => "ok", tabs: async () => [], control: async () => {} },
    apiKey: () => "",
    prepareProfile: async () => ({ name: "Test browser", port: 9223 }),
    profileName: async () => "Test browser",
    changed: () => {},
    notify: () => {}
  });
  service.tick = async () => {};
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const exec = cmd => executeTaskManagementCommand(parseTaskManagementCommand(cmd), service, async selector => selector === "Test browser" ? "isolated:test" : selector);

  // Materials & Templates listing (without leaking raw material secret body)
  store.data.materials.push({ id: randomUUID(), name: "测试简历", scope: "求职", content: "SUPER_PRIVATE_BODY", version: 2, updatedAt: new Date().toISOString() });
  store.data.templates.push({ id: randomUUID(), name: "日报模板", task: { prompt: "汇总今日数据", profileId: "__device__" }, updatedAt: new Date().toISOString() });
  const mats = await exec({ action: "material.list" });
  assert.equal(mats.materials.length, 1);
  assert.equal(mats.materials[0].name, "测试简历");
  assert.equal(JSON.stringify(mats).includes("SUPER_PRIVATE_BODY"), false);

  const tpls = await exec({ action: "template.list" });
  assert.equal(tpls.templates.length, 1);
  assert.equal(tpls.templates[0].name, "日报模板");

  // Schedule save / list / re-enable / delete
  const schedSaved = await exec({
    action: "schedule.save",
    input: {
      name: "早间整理",
      task: { prompt: "检查手机消息", profileId: "__device__" },
      at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      repeat: "weekdays",
      catchUpPolicy: "run_within_window",
      enabled: true
    }
  });
  assert.equal(schedSaved.schedule.repeat, "weekdays");
  assert.equal(schedSaved.schedule.catchUpPolicy, "run_within_window");
  const schedList = await exec({ action: "schedule.list" });
  assert.equal(schedList.schedules.length, 1);
  await exec({ action: "schedule.delete", id: schedSaved.schedule.id });
  assert.equal((await exec({ action: "schedule.list" })).schedules.length, 0);

  // Device-only task creation + detail + search + pin + archive + delete
  const created = await exec({ action: "task.create", profile: "__device__", input: { prompt: "唯一检索词_ALPHA_OMEGA 操作手机" } });
  const taskId = created.task.id;
  assert.equal(created.task.profileId, "__device__");

  const detail = await exec({ action: "task.detail", id: taskId });
  assert.equal(detail.task.id, taskId);

  const searched = await exec({ action: "task.search", query: "ALPHA_OMEGA" });
  assert.equal(searched.results.length, 1);
  assert.equal(searched.results[0].taskId, taskId);

  const pinned = await exec({ action: "task.pin", id: taskId, pinned: true });
  assert.equal(pinned.pinned, true);

  const archived = await exec({ action: "task.archive", id: taskId, archived: true });
  assert.equal(archived.archived, true);
  assert.equal(archived.task.status, "cancelled");

  const deleted = await exec({ action: "task.delete", id: taskId });
  assert.equal(deleted.deleted, true);
  assert.equal(store.data.tasks.length, 0);
});

async function fixture(t) {
  // Windows uses a named pipe; macOS has a small Unix socket pathname limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pptm-"));
  const logs = path.join(root, "logs"), controlRoot = path.join(root, "c");
  initializeDiagnosticLogging({ homeDir: root, env: { PROFILEPILOT_LOG_ROOT: logs }, captureConsole: false });
  const store = new TaskStore(path.join(root, "tasks"));
  const snapshots = [], browserCalls = [], deleted = [];
  const browser = { observe: async () => { browserCalls.push("observe"); return {}; }, execute: async () => { browserCalls.push("execute"); return "ok"; }, tabs: async () => [], control: async (_task, action) => { browserCalls.push(action); } };
  const service = new TaskService(store, { browser, apiKey: () => "", prepareProfile: async () => ({ name: "Test browser", port: 9223 }), profileName: async () => "Test browser", changed: snapshot => snapshots.push(snapshot), notify: () => {} });
  // Keep scheduling deterministic here; subprocess CLI integration exercises
  // the actual scheduler and an injected worker separately.
  service.tick = async () => {};
  let available = true;
  const handle = await startProfilePilotManagementServer({
    profileManager: { getState: async () => ({ profiles: [{ id: "isolated:test", name: "Test browser", source: "isolated" }] }), deleteProfile: async id => { deleted.push(id); throw new Error("unexpected deletion"); } },
    getTaskService: () => available ? service : undefined,
    homeDir: root, env: { PROFILEPILOT_MANAGEMENT_ROOT: controlRoot }
  });
  const token = fs.readFileSync(path.join(controlRoot, "secret"), "utf8").trim();
  t.after(async () => { await handle.close(); await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, service, snapshots, logs, browserCalls, deleted, setAvailable: value => { available = value; }, request: (command, overrideToken) => rawRequest(handle.socketPath, { version: 1, id: randomUUID(), token: overrideToken ?? token, command }) };
}

function rawRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("test management request timed out")); });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => { output += chunk; });
    socket.once("end", () => { try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); } });
  });
}
