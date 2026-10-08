const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadCli } = require('./cli-test-build.cjs');
const { parseAgentCliArgs } = loadCli('src/main/profilepilot-agent-cli.ts');
const { parseProfilePilotCliArgs, runProfilePilotCli } = loadCli('src/main/profilepilot-cli.ts');

const ID = "619fcb7e-ab0c-4322-884b-2183e9be920e";
const DECISION = "e07903e9-cd3e-416b-ae77-7a01e94b115d";
function task(overrides = {}) {
  return { id: ID, title: "测试任务", prompt: "任务", profileId: "isolated:one", profileName: "个人工作",
    status: "queued", running: false, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
    plan: [], items: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0, actions: 0 },
    limits: { minutes: 20, actions: 50, budgetUsd: 2 }, needsReconciliation: false, ...overrides };
}
const decision = (kind = "confirmation", id = DECISION) => ({ id, kind, title: "请确认", details: "将提交表单", createdAt: "2026-09-26T00:00:00Z" });
const event = (id, text = `事件 ${id}`) => ({ id: String(id), kind: "assistant", text, at: "2026-09-26T00:00:00Z" });
const ok = data => ({ version: 1, id: "request", ok: true, data });
const page = (value, events = [], cursor = events.length, hasMore = false) => ok({ task: value, events, cursor, hasMore });
function fixture(onWrite) {
  let stdout = "", stderr = "";
  const stdin = new PassThrough();
  const signals = new EventEmitter();
  const io = { stdout: { write(chunk) { stdout += chunk; onWrite?.(String(chunk), "stdout", stdin, signals); return true; } },
    stderr: { write(chunk) { stderr += chunk; onWrite?.(String(chunk), "stderr", stdin, signals); return true; } } };
  return { io, stdin, signals, get stdout() { return stdout; }, get stderr() { return stderr; },
    runtime(request) { return { stdin, signals, request, pollIntervalMs: 1 }; } };
}
function jsonLines(value) { return value.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }

test("agent parser preserves prompts and uses explicit option terminator", () => {
  assert.deepEqual(parseProfilePilotCliArgs([]), { local: "agent", verb: "chat", json: false });
  assert.deepEqual(parseProfilePilotCliArgs(["--profile", "工作"]), parseAgentCliArgs(["chat", "--profile", "工作"]));
  assert.deepEqual(parseProfilePilotCliArgs(["--resume", ID]), parseAgentCliArgs(["chat", "--resume", ID]));
  assert.deepEqual(parseProfilePilotCliArgs(["run", "--profile", "工作", "任务"]), parseAgentCliArgs(["run", "--profile", "工作", "任务"]));
  assert.equal(parseProfilePilotCliArgs(["agent", "run", "--profile", "工作", "解释 --help 和 --version"]).prompt, "解释 --help 和 --version");
  assert.equal(parseAgentCliArgs(["run", "--profile", "工作", "--", "--help"]).prompt, "--help");
  assert.deepEqual(parseAgentCliArgs(["chat", "--resume", ID]), { local: "agent", verb: "chat", json: false, id: ID });
  assert.deepEqual(parseAgentCliArgs(["show", ID, "--after", "3", "--limit", "2", "--json"]).command, { action: "task.get", id: ID, after: 3, limit: 2 });
  assert.deepEqual(parseAgentCliArgs(["list", "--offset", "2", "--limit", "5"]).command, { action: "task.list", offset: 2, limit: 5 });
  assert.equal(parseAgentCliArgs(["run", "--help"]).topic, "run");
});

test("agent parser rejects conflicting and unknown flags, invalid budgets and missing values", () => {
  for (const args of [
    ["run", "prompt"], ["run", "--profile", "工作"], ["run", "--profile", "工作", "prompt", "extra"],
    ["run", "--profile", "工作", "--prompt-file", "file", "prompt"],
    ["run", "--profile", "工作", "prompt", "--bad"], ["run", "--profile", "工作", "prompt", "--yes"],
    ["run", "--profile", "工作", "prompt", "--minutes", "1.5"], ["run", "--profile", "工作", "prompt", "--budget", "0"],
    ["run", "--profile", "工作", "prompt", "--actions", "10001"], ["run", "--profile", "工作", "prompt", "--profile", "other"],
    ["run", "--profile", "--json"], ["list", "--limit", "101"], ["show", ID, "--after", "-1"],
    ["pause", ID, "--follow"], ["chat", "--resume", ID, "--profile", "工作"], ["chat", "--profile", "工作", "--json"],
    ["chat", "--profile", "工作", "--prompt-file", "-"], ["reply", ID, "--decision", DECISION],
    ["reply", ID, "--decision", DECISION, "--approve", "--reject"]
  ]) assert.throws(() => parseAgentCliArgs(args), undefined, args.join(" "));
});

test("reply only carries explicit approval and send/control map to backend commands", () => {
  assert.deepEqual(parseAgentCliArgs(["reply", ID, "--decision", DECISION, "--message", "yes"]).command,
    { action: "task.reply", id: ID, decisionId: DECISION, answer: "yes" });
  assert.equal(parseAgentCliArgs(["reply", ID, "--decision", DECISION, "--reject"]).command.approved, false);
  assert.equal(parseAgentCliArgs(["reply", ID, "--decision", DECISION, "--approve"]).command.approved, true);
  assert.deepEqual(parseAgentCliArgs(["send", ID, "补充说明"]).command, { action: "task.control", id: ID, control: "queue", message: "补充说明" });
  assert.equal(parseAgentCliArgs(["send", ID, "补充说明", "--now"]).command.control, "steer");
  assert.throws(() => parseAgentCliArgs(["send", ID, "补充说明", "--now", "--queue"]));
  assert.deepEqual(parseAgentCliArgs(["resume", ID, "--message", "继续"]).command, { action: "task.control", id: ID, control: "resume", message: "继续" });
});

test("run submits once with model limits and returns JSON task envelope", async () => {
  const f = fixture(); const calls = [];
  const exit = await runProfilePilotCli(["agent", "run", "--profile", "个人工作", "解释 --help", "--authorization", "只读", "--minutes", "90", "--actions", "100", "--budget", "0.2", "--json"], f.io,
    f.runtime(async command => { calls.push(command); return ok({ task: task() }); }));
  assert.equal(exit, 0); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: "task.create", profile: "个人工作", input: { prompt: "解释 --help", authorization: "只读", limits: { minutes: 90, actions: 100, budgetUsd: 0.2 } } });
  assert.equal(JSON.parse(f.stdout).data.task.id, ID); assert.equal(f.stderr, "");
});

test("prompt files and stdin preserve UTF-8 multiline text and Windows paths", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-agent-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "中文任务.txt");
  const prompt = "查找中文资料\r\n保存在 C:\\资料\\结果.md";
  await fs.writeFile(file, `\uFEFF${prompt}\n`, "utf8");
  for (const source of [file, "-"]) {
    const f = fixture(); let received;
    if (source === "-") f.stdin.end(Buffer.from(`\uFEFF${prompt}\n`, "utf8"));
    const exit = await runProfilePilotCli(["agent", "run", "--profile", "工作", "--prompt-file", source, "--json"], f.io,
      f.runtime(async command => { received = command.input.prompt; return ok({ task: task() }); }));
    assert.equal(exit, 0); assert.equal(received, prompt); assert.equal(f.stdin.listenerCount("data"), 0);
  }
});

test("JSON parse, backend, file and connection errors stay machine readable", async () => {
  const cases = [
    { args: ["run", "--profile", "x", "--wat", "--json"], code: 2, request: async () => assert.fail("must not call backend") },
    { args: ["list", "--json"], code: 1, request: async () => ({ version: 1, id: "x", ok: false, error: { code: "NOT_READY", message: "需要配置模型" } }) },
    { args: ["list", "--json"], code: 69, request: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } },
    { args: ["run", "--profile", "x", "--prompt-file", "Z:/missing/profilepilot-test-nonexistent.txt", "--json"], code: 2, request: async () => assert.fail("must not call backend") }
  ];
  for (const item of cases) {
    const f = fixture();
    assert.equal(await runProfilePilotCli(["agent", ...item.args], f.io, f.runtime(item.request)), item.code);
    const result = JSON.parse(f.stdout); assert.equal(result.ok, false); assert.equal(result.exitCode, item.code); assert.equal(f.stderr, "");
  }
});

test("follow pages events without duplicates and waits for final worker drain", async () => {
  const f = fixture(); const after = []; let index = 0;
  const states = [
    page(task({ status: "running", running: true }), [event(1), event(2)], 2, true),
    page(task({ status: "completed", running: true }), [event(3)], 3),
    page(task({ status: "completed", running: true }), [], 3),
    page(task({ status: "completed", running: false }), [event(4, "最终结果已保存")], 4)
  ];
  const exit = await runProfilePilotCli(["agent", "run", "--profile", "工作", "任务", "--follow", "--json"], f.io,
    f.runtime(async command => {
      if (command.action === "task.create") return ok({ task: task() });
      assert.equal(command.action, "task.get"); after.push(command.after); return states[index++];
    }));
  assert.equal(exit, 0); assert.deepEqual(after, [0, 2, 3, 3]);
  const records = jsonLines(f.stdout);
  assert.deepEqual(records.filter(value => value.type === "event").map(value => value.event.id), ["1", "2", "3", "4"]);
  assert.deepEqual(records.filter(value => value.type === "event").map(value => value.cursor), [1, 2, 3, 4]);
  assert.equal(records.at(-1).type, "end"); assert.equal(records.at(-1).cursor, 4); assert.equal(records.at(-1).exitCode, 0);
});

test("watch exit codes expose waiting, partial completion and failure", async () => {
  for (const [status, expected] of [["waiting_user", 3], ["paused", 3], ["partial", 3], ["failed", 1], ["cancelled", 1], ["completed", 0]]) {
    const f = fixture();
    const code = await runProfilePilotCli(["agent", "watch", ID, "--after", "8", "--json"], f.io,
      f.runtime(async command => { assert.equal(command.after, 8); return page(task({ status }), [], 8); }));
    assert.equal(code, expected); assert.equal(jsonLines(f.stdout).at(-1).exitCode, expected);
    assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  }
});

test("Ctrl+C detaches watch without cancelling task and removes signal handlers", async () => {
  const f = fixture(); const commands = [];
  const code = await runProfilePilotCli(["agent", "watch", ID, "--json"], f.io, f.runtime(async command => {
    commands.push(command); setImmediate(() => f.signals.emit("SIGINT")); return page(task({ status: "running", running: true }));
  }));
  assert.equal(code, 130); assert.ok(commands.every(command => command.action === "task.get"));
  const end = jsonLines(f.stdout).at(-1); assert.equal(end.type, "interrupted"); assert.equal(end.recovery, `ppilot watch ${ID}`);
  assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("Ctrl+C during stdin prompt read leaves no input or signal listeners", async () => {
  const f = fixture();
  const result = runProfilePilotCli(["agent", "run", "--profile", "工作", "--prompt-file", "-", "--json"], f.io,
    f.runtime(async () => assert.fail("incomplete prompt must not create task")));
  setImmediate(() => f.signals.emit("SIGINT"));
  assert.equal(await result, 130); assert.equal(f.stdin.listenerCount("data"), 0); assert.equal(f.stdin.listenerCount("end"), 0);
  assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.stdin.isPaused(), true);
});

test("chat refuses noninteractive stdin before touching backend", async () => {
  const f = fixture();
  const code = await runProfilePilotCli(["agent", "chat", "--profile", "工作"], f.io, f.runtime(async () => assert.fail("non-TTY chat must fail early")));
  assert.equal(code, 2); assert.match(f.stderr, /TTY_REQUIRED/); assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("chat accepts only explicit confirmation, retains task ID, and cleans up readline", { timeout: 3000 }, async () => {
  let promptCount = 0; let approved = false; const replies = [];
  const f = fixture((chunk, stream, stdin) => {
    if (stream !== "stdout") return;
    if (chunk.includes("确认操作？")) {
      const text = ++promptCount === 1 ? "y\n" : "yes\n";
      setImmediate(() => stdin.write(text));
    }
    if (chunk.includes("继续任务的消息")) setImmediate(() => stdin.write("/exit\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    if (command.action === "task.reply") { replies.push(command); approved = true; return ok({ task: task({ status: "queued" }) }); }
    return page(task(approved ? { status: "completed" } : { status: "waiting_user", pending: decision() }));
  }));
  assert.equal(code, 0); assert.equal(replies.length, 1); assert.equal(replies[0].approved, true); assert.equal(replies[0].decisionId, DECISION);
  assert.match(f.stderr, /EXPLICIT_APPROVAL_REQUIRED/); assert.match(f.stdout, new RegExp(`ppilot --resume ${ID}`));
  assert.equal(f.stdin.listenerCount("data"), 0); assert.equal(f.stdin.listenerCount("end"), 0); assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("chat cannot approve a new decision using yes buffered during execution", { timeout: 3000 }, async () => {
  let reads = 0; const replies = [];
  const f = fixture((chunk, stream, stdin) => {
    // Deliver the buffered answer while the running prompt is actually shown.
    // setImmediate can lose to the polling timer under full-suite contention,
    // which would instead type a fresh answer after the confirmation appears.
    if (stream === "stdout" && chunk.includes("运行中，可输入")) queueMicrotask(() => stdin.write("yes\n"));
    if (stream === "stderr" && chunk.includes("STALE_CHAT_DECISION")) setImmediate(() => stdin.write("/exit\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    if (command.action === "task.reply") { replies.push(command); assert.fail("buffered yes must not approve"); }
    return page(task(++reads === 1 ? { status: "running", running: true } : { status: "waiting_user", pending: decision() }));
  }));
  assert.equal(code, 3); assert.equal(replies.length, 0); assert.match(f.stderr, /STALE_CHAT_DECISION/);
});

test("chat polls while awaiting input and notices decisions answered in desktop", { timeout: 3000 }, async () => {
  let reads = 0;
  const f = fixture((chunk, stream, stdin) => {
    if (stream === "stdout" && chunk.includes("继续任务的消息")) setImmediate(() => stdin.write("/exit\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    assert.equal(command.action, "task.get");
    return page(task(++reads < 3 ? { status: "waiting_user", pending: decision("question") } : { status: "completed" }));
  }));
  assert.equal(code, 0); assert.ok(reads >= 3); assert.match(f.stdout, /completed/);
});

test("chat discards queued decision answers after the first answer clears the decision", { timeout: 3000 }, async () => {
  let approved = false, prompted = false;
  const mutations = [];
  const f = fixture((chunk, stream, stdin) => {
    if (stream === "stdout" && chunk.includes("确认操作？") && !prompted) {
      prompted = true;
      setImmediate(() => stdin.write("yes\nyes\n"));
    }
    if (stream === "stderr" && chunk.includes("STALE_CHAT_DECISION")) setImmediate(() => stdin.write("/exit\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    if (command.action === "task.reply") {
      approved = true; mutations.push(command);
      return ok({ task: task({ status: "running", running: true }) });
    }
    assert.equal(command.action, "task.get", "a buffered answer must not become steer/resume");
    return page(task(approved ? { status: "running", running: true } : { status: "waiting_user", pending: decision() }));
  }));
  assert.equal(code, 0);
  assert.equal(mutations.length, 1);
  assert.match(f.stderr, /STALE_CHAT_DECISION/);
});

test("chat EOF leaves pending confirmation untouched", { timeout: 3000 }, async () => {
  const commands = [];
  const f = fixture((chunk, stream, stdin) => { if (stream === "stdout" && chunk.includes("确认操作？")) setImmediate(() => stdin.end()); });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    commands.push(command); return page(task({ status: "waiting_user", pending: decision() }));
  }));
  assert.equal(code, 3); assert.ok(commands.every(command => command.action === "task.get"));
  assert.equal(f.stdin.listenerCount("data"), 0); assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("chat Ctrl+C and disconnect release input without cancelling background work", { timeout: 3000 }, async () => {
  for (const kind of ["signal", "disconnect"]) {
    let reads = 0;
    const f = fixture((chunk, stream, stdin, signals) => {
      if (kind === "signal" && stream === "stdout" && chunk.includes("运行中，可输入")) setImmediate(() => signals.emit("SIGINT"));
    });
    f.stdin.isTTY = true;
    const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
      assert.equal(command.action, "task.get");
      if (kind === "disconnect" && ++reads > 1) throw Object.assign(new Error("disconnected"), { code: "ECONNRESET" });
      return page(task({ status: "running", running: true }));
    }));
    assert.equal(code, kind === "signal" ? 130 : 1); assert.equal(f.stdin.listenerCount("data"), 0); assert.equal(f.stdin.isPaused(), true);
    assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  }
});

test("chat continues completed task with same ID and supports slash controls", { timeout: 3000 }, async () => {
  const commands = []; let phase = 0;
  const f = fixture((chunk, stream, stdin) => {
    if (stream !== "stdout") return;
    if (chunk.includes("继续任务的消息")) setImmediate(() => stdin.write(phase === 0 ? "继续整理\n" : "/exit\n"));
    if (chunk.includes("运行中，可输入")) setImmediate(() => stdin.write("/pause\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli(["agent", "chat", "--resume", ID], f.io, f.runtime(async command => {
    commands.push(command);
    if (command.action === "task.control") { phase++; return ok({ task: task({ status: phase === 1 ? "running" : "paused", running: phase === 1 }) }); }
    return page(task({ status: phase === 0 ? "completed" : phase === 1 ? "running" : "paused", running: phase === 1 }));
  }));
  assert.equal(code, 3);
  assert.ok(commands.find(command => command.message === "继续整理").requestId);
  assert.deepEqual(commands.filter(command => command.action === "task.control").map(({ requestId, ...command }) => command), [
    { action: "task.control", id: ID, control: "resume", message: "继续整理" },
    { action: "task.control", id: ID, control: "pause" }
  ]);
});

test("bare ppilot selects an eligible Profile and starts the conversation", { timeout: 3000 }, async () => {
  const mutations = []; let selectionCount = 0;
  const f = fixture((chunk, stream, stdin) => {
    if (stream !== "stdout") return;
    if (chunk.includes("Profile 编号或名称")) setImmediate(() => stdin.write(++selectionCount === 1 ? "99\n" : "2\n"));
    if (chunk === "任务 > ") setImmediate(() => stdin.write("整理页面信息\n"));
    if (chunk.includes("继续任务的消息")) setImmediate(() => stdin.write("/exit\n"));
  });
  f.stdin.isTTY = true;
  const code = await runProfilePilotCli([], f.io, f.runtime(async command => {
    if (command.action === "profile.list") return ok({ profiles: [
      { id: "isolated:blocked", name: "不可访问", source: "isolated", agent_access: "blocked" },
      { id: "native:one", name: "本机浏览器", source: "native", agent_access: "allowed" },
      { id: "isolated:work", name: "工作", source: "isolated", agent_access: "allowed" },
      { id: "clone:one", name: "子 Profile", source: "clone", agent_access: "allowed" }
    ] });
    if (command.action === "task.create") { mutations.push(command); return ok({ task: task({ status: "completed" }) }); }
    assert.equal(command.action, "task.get");
    return page(task({ status: "completed" }));
  }));
  assert.equal(code, 0);
  assert.deepEqual(mutations, [{ action: "task.create", profile: "isolated:work", input: { prompt: "整理页面信息" } }]);
  assert.doesNotMatch(f.stdout, /不可访问|子 Profile/);
  assert.match(f.stdout, /已选择：工作/);
  assert.match(f.stderr, /请选择列表中的编号/);
  assert.equal(f.stdin.listenerCount("data"), 0);
});

test("bare ppilot profile selection exits without submitting and handles unavailable Profiles", { timeout: 3000 }, async () => {
  for (const mode of ["exit", "eof", "interrupt", "empty"]) {
    const f = fixture((chunk, stream, stdin, signals) => {
      if (stream !== "stdout" || !chunk.includes("Profile 编号或名称")) return;
      setImmediate(() => {
        if (mode === "exit") stdin.write("/exit\n");
        if (mode === "eof") stdin.end();
        if (mode === "interrupt") signals.emit("SIGINT");
      });
    });
    f.stdin.isTTY = true;
    const code = await runProfilePilotCli([], f.io, f.runtime(async command => {
      assert.equal(command.action, "profile.list");
      return ok({ profiles: mode === "empty" ? [] : [{ id: "isolated:one", name: "工作", source: "isolated", agent_access: "allowed" }] });
    }));
    assert.equal(code, mode === "empty" ? 1 : mode === "interrupt" ? 130 : 0);
    assert.equal(f.stdin.listenerCount("data"), 0);
    assert.equal(f.signals.listenerCount("SIGINT"), 0);
  }
});
