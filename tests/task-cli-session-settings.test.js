const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const output = process.env.PPILOT_BACKEND_TEST_DIST || path.join(__dirname, "../dist/main/tasks");
const { parseTaskManagementCommand, executeTaskManagementCommand } = require(path.join(output, "management"));

test("CLI and desktop share encrypted settings, reject provider key reuse, and never return credentials", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-cli-settings-"));
  let handler;
  const electron = { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (_name, value) => { handler = value; } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(Buffer.from(value).toString("hex")), decryptString: value => Buffer.from(value.toString(), "hex").toString() },
    dialog: {}, shell: {} };
  const filename = path.resolve("dist/main/tasks/ipc.js"), localRequire = createRequire(filename), module = { exports: {} };
  const source = fs.readFileSync(process.env.PPILOT_BACKEND_IPC_SOURCE || filename, "utf8");
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,process){${source}\n})`, { filename });
  load(id => id === "electron" ? electron : localRequire(id), module, module.exports, path.dirname(filename), { env: { ...process.env, CPM_DATA_DIR: root } });
  const service = module.exports.registerTaskService({ getState: async () => ({ profiles: [] }) });
  service.tick = async () => {};
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const command = value => executeTaskManagementCommand(parseTaskManagementCommand(value), service, async () => "unused");
  const secret = "CLI-private-provider-key";
  const first = await command({ action: "task.settings.update", input: { apiKey: secret, model: "chosen-model" } });
  assert.equal(first.settings.model, "chosen-model");
  assert.equal(first.settings.hasApiKey, true);
  assert.equal(service.dependencies.apiKey(), secret);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(root, "browser-tasks", "tasks.json"), "utf8").includes(secret), false);
  assert.equal(fs.readFileSync(path.join(root, "browser-tasks", "credentials.bin"), "utf8").includes(secret), false);
  await assert.rejects(command({ action: "task.settings.update", input: { baseUrl: "https://other-provider.test/anthropic" } }), /请输入新服务/);
  await assert.rejects(command({ action: "task.settings.update", input: { baseUrl: "http://untrusted.test", apiKey: "new" } }), /HTTPS/);
  assert.equal(service.dependencies.apiKey(), secret);
  const event = { senderFrame: { url: pathToFileURL(path.resolve("public/tasks.html")).href } };
  await handler(event, "saveSettings", { ...service.store.data.settings, model: "from-desktop" });
  assert.equal((await command({ action: "task.settings.get" })).settings.model, "from-desktop");
  const { EventEmitter } = require("node:events");
  t.mock.method(require("node:child_process"), "fork", () => {
    const child = new EventEmitter();
    child.kill = () => true;
    child.send = () => queueMicrotask(() => child.emit("message", { kind: "error", text: `Provider echoed ${secret}` }));
    return child;
  });
  await assert.rejects(command({ action: "task.connection.test" }), error => error.message === "Provider echoed [REDACTED]");
  const selected = path.join(root, "selected.txt"); fs.writeFileSync(selected, "shared importer");
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  const attachments = await handler(event, "importAttachments");
  assert.equal(attachments.length, 1);
  assert.notEqual(attachments[0].path, selected);
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: Array(51).fill(selected) });
  await assert.rejects(handler(event, "importAttachments"));
  assert.equal(service.store.data.attachments.length, 1);
  // Extension files now belong to the independent browser service. The
  // desktop delegates this action rather than opening its own install folder.
  let revealRequests = 0;
  t.mock.method(service.dependencies.browser.native.bridge, "revealExtension", async () => { revealRequests++; });
  await handler(event, "openNativeExtensionFolder");
  assert.equal(revealRequests, 1);
  await command({ action: "task.settings.update", input: { apiKey: "" } });
  assert.equal(service.dependencies.apiKey(), "");
  assert.equal((await command({ action: "task.settings.get" })).settings.hasApiKey, false);
});

test("real task IPC wiring preserves registered direct owners but releases orphan and completed task owners", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-native-ipc-"));
  const electron = { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} }, safeStorage: { isEncryptionAvailable: () => true }, dialog: {}, shell: {} };
  const filename = path.resolve("dist/main/tasks/ipc.js"), localRequire = createRequire(filename), module = { exports: {} };
  const source = fs.readFileSync(process.env.PPILOT_BACKEND_IPC_SOURCE || filename, "utf8");
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,process){${source}\n})`, { filename });
  load(id => id === "electron" ? electron : localRequire(id), module, module.exports, path.dirname(filename), { env: { ...process.env, CPM_DATA_DIR: root } });
  const profileId = "native:Default";
  const service = module.exports.registerTaskService({ getState: async () => ({ profiles: [{ id: profileId, source: "native", name: "Chrome" }] }) });
  service.tick = async () => {};
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const native = service.dependencies.browser.native.bridge;
  const state = { profileId, connected: true, ownership: "agent", taskTabs: true, ownerSessionId: undefined,
    extensionVersion: "0.2.0", capabilities: ["tabs", "cdp", "cdpSessions", "history", "downloads", "sidePanel"] };
  const released = [];
  t.mock.method(native, "request", async (profile, method, params) => {
    assert.equal(profile, profileId);
    if (method === "control" && params.action === "release") { released.push(params.sessionId); state.ownerSessionId = undefined; }
    return {};
  });
  // Exercise the real adapter's streamed event ordering. Direct claims are
  // registered by the service; the desktop must apply that identity before
  // notifying TaskService. Reserved-prefix rejection is covered in
  // native-control.test.js at the service boundary.
  let sequence = 0;
  const publish = directSession => native.receive({ type: "event", sequence: ++sequence, directSession,
    event: { type: "state", profileId, sessionId: state.ownerSessionId, state: { ...state } } });
  state.ownerSessionId = "external-reviewer";
  publish(true);
  assert.equal(native.isDirectSession(profileId, "external-reviewer"), true);
  assert.equal(native.isDirectSession("native:Other", "external-reviewer"), false);
  assert.deepEqual(released, [], "the first claim event must already recognize the real direct registration");
  state.ownerSessionId = "unknown-owner";
  publish(false);
  assert.deepEqual(released, ["unknown-owner"]);
  const task = service.store.create({ profileId, prompt: "finished" }, "Chrome"); task.status = "completed";
  state.ownerSessionId = task.sessionId;
  publish(false);
  assert.deepEqual(released, ["unknown-owner", task.sessionId]);
  const ui = await native.uiHandler(profileId, "getUiState", { taskId: task.id });
  assert.equal(ui.task.id, task.id);
  assert.equal(ui.taskSessionId, task.sessionId);
  assert.equal(ui.browser.profileId, profileId);
});
