const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

test("Jev credentials are isolated, omitted from snapshots, preserved by main settings, and deleted independently", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-jev-ipc-")); let handler;
  const opened = [];
  const electron = { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (_channel, fn) => { handler = fn; } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(Buffer.from(value).toString("hex")), decryptString: value => Buffer.from(value.toString(), "hex").toString() },
    shell: { openExternal: async url => { opened.push(url); } }, dialog: {} };
  const filename = path.resolve("dist/main/tasks/ipc.js"); const localRequire = createRequire(filename); const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,process){${readFileSync(filename, "utf8")}\n})`, { filename });
  load(id => id === "electron" ? electron : localRequire(id), module, module.exports, path.dirname(filename), { env: { ...process.env, CPM_DATA_DIR: root } });
  const event = { senderFrame: { url: pathToFileURL(path.resolve("public/tasks.html")).href } }; let service;
  try {
    service = module.exports.registerTaskService({ getState: async () => ({ profiles: [] }) });
    service.tick = async () => {};
    assert.equal(JSON.parse(readFileSync(path.join(root, "browser-tasks", "tasks.json"), "utf8")).settings.jevMode, "driver");
    await assert.rejects(handler(event, "saveJevSettings", { enabled: true }), /请先填写/);
    await handler(event, "saveJevSettings", { enabled: true, apiKey: "jev-fixture-secret" });
    assert.equal(service.dependencies.jevApiKey(), "jev-fixture-secret");
    assert.equal(service.store.data.settings.hasJevApiKey, true);
    assert.equal(service.store.data.settings.jevProvider, "typesafe");
    assert.equal(service.store.data.settings.jevMode, "driver");
    await handler(event, "saveJevSettings", { enabled: true, mode: "advisory" });
    assert.equal(service.store.data.settings.jevMode, "advisory");
    await assert.rejects(handler(event, "saveJevSettings", { enabled: true, mode: "unknown" }));
    await assert.rejects(handler(event, "saveJevSettings", { enabled: true, provider: "vercel" }), /Vercel/);
    assert.equal(service.store.data.settings.jevProvider, "typesafe");
    await handler(event, "saveJevSettings", { enabled: true, provider: "vercel", apiKey: "gateway-fixture-secret" });
    assert.equal(service.dependencies.jevApiKey(), "gateway-fixture-secret");
    await handler(event, "openJevConsole", "keys");
    assert.equal(new URL(opened.pop()).hostname, "vercel.com");
    await handler(event, "saveJevSettings", { enabled: true, provider: "typesafe" });
    assert.equal(service.dependencies.jevApiKey(), "jev-fixture-secret");
    assert.equal(JSON.stringify(service.store.snapshot()).includes("jev-fixture-secret"), false);
    assert.equal(readFileSync(path.join(root, "browser-tasks", "tasks.json"), "utf8").includes("jev-fixture-secret"), false);
    await handler(event, "saveSettings", { ...service.store.data.settings, apiKey: "main-fixture-secret" });
    assert.equal(service.store.data.settings.jevEnabled, true); assert.equal(service.dependencies.jevApiKey(), "jev-fixture-secret");
    await handler(event, "saveJevSettings", { enabled: false });
    assert.equal(service.dependencies.jevApiKey(), "jev-fixture-secret");
    await handler(event, "saveJevSettings", { enabled: false, apiKey: "" });
    assert.equal(service.dependencies.jevApiKey(), ""); assert.equal(service.dependencies.apiKey(), "main-fixture-secret");
    assert.equal(service.store.data.settings.hasJevApiKey, false);
    await assert.rejects(handler(event, "saveSettings", { ...service.store.data.settings, baseUrl: "https://api.deepseek.com/anthropic" }), /请输入新服务/);
    assert.equal(service.dependencies.apiKey(), "main-fixture-secret");
    await assert.rejects(handler(event, "testJevConnection"), /请先/);
    await handler(event, "openJevConsole", "keys"); await handler(event, "openJevConsole", "billing");
    assert.equal(opened.length, 2); assert.ok(opened.every(url => new URL(url).hostname === "console.typesafe.ai"));
    await handler(event, "saveJevSettings", { enabled: true, provider: "vercel" });
    assert.equal(service.dependencies.jevApiKey(), "gateway-fixture-secret");
    // A pre-provider release only stored the original Vercel vault and flags.
    delete service.store.data.settings.jevProvider; service.publish(); await service.close();
    service = module.exports.registerTaskService({ getState: async () => ({ profiles: [] }) });
    service.tick = async () => {};
    assert.equal(service.store.data.settings.jevProvider, "vercel");
    assert.equal(service.store.data.settings.jevEnabled, true);
    assert.equal(service.dependencies.jevApiKey(), "gateway-fixture-secret");
    await assert.rejects(handler(event, "openJevConsole", "https://example.test"));
    opened.length = 0;
    await handler(event, "openLink", "http://localhost:8080/");
    await handler(event, "openLink", "https://example.test/?a=1&b=2");
    for (const url of ["javascript:alert(1)", "file:///tmp/test.html", "https://user:secret@example.test", "https://example.test\n"]) await assert.rejects(handler(event, "openLink", url), /HTTP/);
    await assert.rejects(handler({ senderFrame: { url: "https://example.test" } }, "openLink", "http://localhost:8080/"), /本地桌面/);
    assert.deepEqual(opened, ["http://localhost:8080/", "https://example.test/?a=1&b=2"]);
    await assert.rejects(handler({ senderFrame: { url: "https://example.test" } }, "saveJevSettings", { enabled: true, apiKey: "wrong" }), /本地桌面/);
  } finally { await service?.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); rmSync(root, { recursive: true, force: true }); }
});

test("task notification restores the desktop and opens the matching task", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-task-ipc-"));
  const actions = []; let notification;
  const window = {
    webContents: { getURL: () => "file:///app/public/tasks.html", send: () => {} },
    isMinimized: () => true, isDestroyed: () => false,
    restore: () => actions.push("restore"), show: () => actions.push("show"), focus: () => actions.push("focus"),
    loadFile: async (file, options) => actions.push({ file, options })
  };
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.handlers = {}; notification = this; }
    on(name, fn) { this.handlers[name] = fn; return this; }
    show() { actions.push("notification shown"); }
  }
  const electron = { BrowserWindow: { getAllWindows: () => [window] }, Notification, ipcMain: { handle: () => {} }, safeStorage: {}, shell: {}, dialog: {} };
  const filename = path.resolve("dist/main/tasks/ipc.js"); const localRequire = createRequire(filename);
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,process){${readFileSync(filename, "utf8")}\n})`, { filename });
  load(id => id === "electron" ? electron : localRequire(id), module, module.exports, path.dirname(filename), { env: { ...process.env, CPM_DATA_DIR: root } });
  let service;
  try {
    service = module.exports.registerTaskService({ getState: async () => ({ profiles: [] }) });
    service.dependencies.notify("验收任务", "等待确认", "task-id");
    assert.equal(notification.options.title, "ProfilePilot · 验收任务");
    notification.handlers.click();
    assert.deepEqual(actions.slice(0, 4), ["notification shown", "restore", "show", "focus"]);
    assert.equal(path.basename(actions[4].file), "tasks.html");
    assert.deepEqual(actions[4].options.query, { task: "task-id" });
  } finally {
    await service?.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  }
});
