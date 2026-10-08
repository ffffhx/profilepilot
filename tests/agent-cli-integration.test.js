const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");
const { startProfilePilotManagementServer } = require("../dist/main/profilepilot-management-server");

// Exercise the distributed CLI bundle as another process, using the real task
// service and persistence. The injected worker is deterministic and uses no API key.
test("bundled Agent CLI submits, answers, follows and continues the desktop task", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppac-"));
  const env = { ...process.env, PROFILEPILOT_MANAGEMENT_ROOT: path.join(root, "m") };
  const store = new TaskStore(path.join(root, "tasks"));
  const starts = [];
  const browserControls = [];
  const service = new TaskService(store, {
    apiKey: () => "fixture-only",
    profileName: async () => "CLI 中文 Profile",
    prepareProfile: async () => ({ name: "CLI 中文 Profile", port: 9999 }),
    changed: () => {}, notify: () => {},
    browser: {
      observe: async () => ({ version: "v1", fingerprint: "fp1", at: new Date().toISOString(),
        url: "https://example.test/", title: "本地测试", snapshot: "CLI fixture verified", account: "fixture" }),
      execute: async () => { throw new Error("This test must not change a website"); },
      tabs: async () => [],
      control: async (_task, action) => { browserControls.push(action); }
    },
    worker: (_task, start) => { starts.push(start); return scriptedWorker(starts.length); }
  });
  const server = await startProfilePilotManagementServer({
    env, homeDir: root, getTaskService: () => service,
    profileManager: { getState: async () => ({ profiles: [{ id: "isolated:cli", name: "CLI 中文 Profile", source: "isolated", running: true }] }) }
  });
  t.after(async () => {
    await service.close();
    await server.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const invoke = args => cli(args, env);

  const prompt = "先询问用户，再核验页面。\n路径 C:\\测试 文件\\资料.txt 保持原文。";
  const file = path.join(root, "多行 prompt.txt");
  fs.writeFileSync(file, "\ufeff" + prompt, "utf8");
  const created = await invoke(["agent", "run", "--profile", "CLI 中文 Profile", "--prompt-file", file, "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const id = JSON.parse(created.stdout).data.task.id;
  assert.equal(store.get(id).prompt, prompt);
  const firstSession = store.get(id).sessionId;

  const waiting = await invoke(["agent", "watch", id, "--json"]);
  assert.equal(waiting.code, 3, waiting.stderr + waiting.stdout);
  waiting.stdout.trim().split(/\r?\n/).forEach(line => JSON.parse(line));
  const pending = store.get(id).pending;
  assert.equal(pending.kind, "question");
  assert.equal(service.runs.size, 0, "watch waits for the worker to drain before a reply");

  const stale = await invoke(["agent", "reply", id, "--decision", "00000000-0000-4000-8000-000000000001", "--message", "无效", "--json"]);
  assert.equal(stale.code, 1);
  assert.equal(store.get(id).pending.id, pending.id);

  const answered = await invoke(["agent", "reply", id, "--decision", pending.id, "--message", "已核对，请继续。", "--follow", "--json"]);
  assert.equal(answered.code, 0, answered.stderr + answered.stdout);
  answered.stdout.trim().split(/\r?\n/).forEach(line => JSON.parse(line));
  assert.equal(store.get(id).status, "completed");
  assert.equal(store.get(id).result.summary, "CLI fixture completed");
  assert.equal(service.runs.size, 0);
  assert.ok(browserControls.includes("complete"));

  const continued = await invoke(["agent", "resume", id, "--message", "再核验一次，保留上次记录。", "--follow", "--json"]);
  assert.equal(continued.code, 0, continued.stderr + continued.stdout);
  assert.equal(store.data.tasks.length, 1);
  assert.equal(store.get(id).sessionId, firstSession);
  assert.equal(starts[2].task.sdkSessionId, "fixture-sdk-session");
  assert.ok(store.get(id).events.some(event => event.text === "再核验一次，保留上次记录。"));
  assert.equal(JSON.parse(fs.readFileSync(store.file, "utf8")).tasks[0].status, "completed");

  const listed = await invoke(["agent", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).data.tasks[0].id, id);
  const shown = await invoke(["agent", "show", id, "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).data.task.result.summary, "CLI fixture completed");
});

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/main/profilepilot-cli.cjs"), ...args], {
      env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`)); }, 12000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => { stdout += text; });
    child.stderr.on("data", text => { stderr += text; });
    child.on("error", error => { clearTimeout(deadline); reject(error); });
    child.on("close", code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
}

function scriptedWorker(turn) {
  const child = new EventEmitter();
  child.connected = true; child.exitCode = null; child.signalCode = null;
  let toolIndex = 0;
  const end = () => {
    if (!child.connected) return;
    child.connected = false; child.exitCode = 0; child.emit("exit", 0);
  };
  child.kill = () => { end(); return true; };
  child.send = message => {
    if (message.kind === "stop") { setImmediate(end); return; }
    if (message.kind === "start") {
      setImmediate(() => {
        child.emit("message", { kind: "session", id: "fixture-sdk-session" });
        next();
      });
    } else if (message.kind === "tool_result") setImmediate(next);
  };
  function next() {
    if (!child.connected) return;
    const steps = turn === 1
      ? [["ask_user", { question: "是否已核对资料？", details: "请在终端回复。" }]]
      : [["observe", {}], ["finish", { status: "completed", summary: "CLI fixture completed", evidence: ["CLI fixture verified"], remaining: [] }]];
    const step = steps[toolIndex++];
    if (!step) { end(); return; }
    child.emit("message", { kind: "tool", id: `tool-${toolIndex}`, name: step[0], args: step[1] });
  }
  return child;
}
