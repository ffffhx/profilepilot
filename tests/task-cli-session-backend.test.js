const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const output = process.env.PPILOT_BACKEND_TEST_DIST || path.join(__dirname, "../dist/main/tasks");
const { TaskStore } = require(path.join(output, "store"));
const { TaskService } = require(path.join(output, "service"));
const { parseTaskManagementCommand, executeTaskManagementCommand, executeNativeUiCommand } = require(path.join(output, "management"));
const { conversationEvents, browserPermissionScope, terminalPermissionScope, hasSessionPermission, redactProviderSecrets } = require(path.join(output, "conversation"));

function fixture(t, mode = "manual") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppilot-session-"));
  const store = new TaskStore(root);
  const task = store.create({ profileId: "test", prompt: "original goal", mode }, "Test");
  task.status = "paused";
  const executed = [];
  const observation = { version: "v1", fingerprint: "same-page", at: new Date().toISOString(), url: "https://example.test/form", title: "Form", snapshot: '- textbox "Name" [ref=e1]\n- button "发送" [ref=e2]', account: "" };
  const service = new TaskService(store, {
    apiKey: () => "private-key", profileName: async () => "Test", prepareProfile: async () => ({ name: "Test" }),
    changed: () => {}, notify: () => {},
    browser: { observe: async () => ({ ...observation }), execute: async (_task, action) => { executed.push(action); return "executed"; }, control: async () => {}, tabs: async () => [] }
  });
  service.tick = async () => {};
  const run = () => {
    task.status = "running"; task.observation = { ...observation };
    const value = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
    service.runs.set(task.id, value); return value;
  };
  const cleanup = { expectedError: undefined };
  t.after(async () => {
    for (const run of service.runs.values()) clearTimeout(run.timer);
    service.runs.clear();
    try {
      if (cleanup.expectedError) await assert.rejects(service.close(), cleanup.expectedError);
      else await service.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const command = value => executeTaskManagementCommand(parseTaskManagementCommand(value), service, async () => "test");
  return { root, store, task, service, executed, observation, run, command, cleanup };
}

test("session protocol validates modes, scope, settings and absolute attachment paths", async t => {
  const f = fixture(t);
  assert.throws(() => parseTaskManagementCommand({ action: "task.mode", id: f.task.id, mode: "bypassPermissions" }));
  assert.throws(() => parseTaskManagementCommand({ action: "task.settings.update", input: { hasApiKey: true } }));
  assert.throws(() => parseTaskManagementCommand({ action: "task.reply", id: f.task.id, decisionId: randomUUID(), answer: "", scope: "global" }));
  await assert.rejects(f.command({ action: "task.attachments.import", paths: ["relative.txt"] }), /绝对路径/);
  const settings = await f.command({ action: "task.settings.get" });
  assert.equal(JSON.stringify(settings).includes("private-key"), false);
  assert.equal(settings.settings.hasApiKey, false);
});

test("plan mode rejects terminal and file mutation tools and a falsely labelled read fill", async t => {
  const f = fixture(t, "plan"), run = f.run();
  for (const name of ["terminal_run", "terminal_stop", "export_result", "fill_fields"]) {
    const result = await f.service.handleTool(f.task, run, name, {});
    assert.equal(result.isError, true, name);
  }
  const result = await f.service.handleTool(f.task, run, "browser_action", { kind: "fill", ref: "e1", version: "v1", value: "hello", effect: "read", summary: "fill" });
  assert.equal(result.isError, true);
  assert.equal(f.executed.length, 0);
});

test("open without a valid URL fails before creating an uncertain receipt or browser I/O", async t => {
  const f = fixture(t), run = f.run();
  for (const value of [undefined, "", "   ", "/relative", "not a url"]) {
    await assert.rejects(f.service.handleTool(f.task, run, "browser_action", {
      kind: "open", ref: "e1", version: "v1", value, effect: "read", summary: "Open observed article"
    }), /open 需要.*kind=click/);
  }
  assert.equal(f.executed.length, 0);
  assert.equal(f.task.receipts.length, 0);
  assert.equal(f.task.usage.actions, 0);
  assert.equal(run.browserAccessed, undefined);
  const result = await f.service.handleTool(f.task, run, "browser_action", {
    kind: "open", value: "https://example.test/article?q=hello", effect: "read", summary: "Open article"
  });
  assert.equal(result.isError, false);
  assert.equal(f.executed.length, 1);
});

test("manual mode confirms edits and remembers only the explicit origin/effect/action scope", async t => {
  const f = fixture(t), run = f.run();
  await f.service.handleTool(f.task, run, "browser_action", { kind: "fill", ref: "e1", version: "v1", value: "hello", effect: "edit", summary: "Fill name" });
  assert.equal(f.executed.length, 0);
  const decision = f.task.pending;
  assert.match(decision.permissionScope.label, /https:\/\/example.test · edit · fill/);
  f.service.runs.clear();
  await f.service.reply(f.task.id, decision.id, "approved", true, "session");
  assert.equal(f.executed.length, 1);
  assert.equal(f.task.permissionRules.length, 1);
  const action = { kind: "fill", effect: "edit" };
  f.task.observation = { ...f.observation };
  assert.equal(hasSessionPermission(f.task, browserPermissionScope(f.task, action)), true);
  assert.equal(hasSessionPermission(f.task, browserPermissionScope(f.task, { ...action, effect: "send" })), false);
  f.task.observation.url = "https://other.test/form";
  assert.equal(hasSessionPermission(f.task, browserPermissionScope(f.task, action)), false);
  await f.command({ action: "task.permissions", id: f.task.id, revokeId: "all" });
  assert.equal(f.task.permissionRules.length, 0);
});

test("manual browsing trusts observed search, Escape and article semantics without extra edit confirmations", async t => {
  const f = fixture(t, "manual"), run = f.run();
  const candidates = [
    { ref: "e1", role: "searchbox", label: "搜索", kind: "fill", dom: { tag: "INPUT", type: "search", search: true, popup: false, toggle: false, command: "", download: false, effect: "read" } },
    { ref: "e2", role: "link", label: "刚刚发布的科技文章", kind: "click", href: "https://example.test/article", dom: { tag: "A", type: "", search: false, popup: false, toggle: false, command: "", download: false, effect: "read" } }
  ];
  f.observation.fast = { document: "doc", candidates, guard: JSON.stringify([f.observation.url, "doc", candidates, ["", ""], ["search-node", "article-node"], { focusedRef: "e1", editable: true }]) };
  for (const action of [
    { kind: "fill", ref: "e1", value: "AI", effect: "edit" },
    { kind: "press", ref: "e1", value: "Enter", effect: "submit" },
    { kind: "press", value: "Escape", effect: "edit" },
    { kind: "click", ref: "e2", effect: "submit" }
  ]) {
    await f.service.handleTool(f.task, run, "observe", {});
    const result = await f.service.handleTool(f.task, run, "browser_action", { ...action, version: "v1", summary: "Read search results" });
    assert.equal(result.isError, false, action.kind);
    assert.equal(f.task.pending, undefined); assert.equal(f.task.status, "running");
    assert.equal(f.executed.at(-1).effect, "read");
  }
  assert.equal(f.executed.length, 4);
  assert.equal(f.task.needsReconciliation, false);
});

test("rerendered filter refs and changed summaries cannot bypass the no-progress guard", async t => {
  for (const fast of [false, true]) {
    const f = fixture(t, "acceptEdits"), run = f.run(); f.task.port = 9223;
    const controls = []; f.service.dependencies.browser.control = async (_task, action) => controls.push(action);
    for (let index = 0; index < 4; index++) {
      const ref = `e${index + 10}`;
      f.observation.snapshot = `- button "筛选" [ref=${ref}]`;
      if (fast) {
        const candidates = [{ ref, role: "button", label: "筛选", kind: "click" }];
        f.observation.fast = { document: "same-document", candidates, guard: JSON.stringify([f.observation.url, "same-document", candidates, ["same context"], ["same attributes"]]) };
      }
      await f.service.handleTool(f.task, run, "observe", {});
      const attempt = f.service.handleTool(f.task, run, "browser_action", { kind: "click", ref, version: "v1", effect: "read", summary: `Try a different description ${index}` });
      if (index === 3) await assert.rejects(attempt, /停止重复尝试/); else await attempt;
    }
    assert.equal(f.executed.length, 3); assert.deepEqual(controls, ["handoff"]);
    assert.equal(f.task.status, "waiting_user");
  }
});

test("scroll position, page slices and changed content remain real progress", async t => {
  for (const progress of ["viewport", "page", "content"]) {
    const f = fixture(t, "acceptEdits"), run = f.run();
    for (let index = 0; index < 8; index++) {
      f.observation.snapshot = progress === "content" ? `Result ${index}` : "Same article text";
      if (progress === "viewport") f.observation.viewport = { width: 1000, height: 800, x: 0, y: index * 500, scrollWidth: 1000, scrollHeight: 10000 };
      if (progress === "page") f.observation.page = { frameId: "main", offset: index * 80, textOffset: index * 1000, totalControls: 1000, totalText: 20000 };
      await f.service.handleTool(f.task, run, "observe", {});
      const result = await f.service.handleTool(f.task, run, "browser_action", { kind: "scroll", value: "down", version: "v1", effect: "read", summary: "Next results" });
      assert.equal(result.isError, false, progress);
    }
    assert.equal(f.executed.length, 8); assert.equal(f.task.status, "running");
  }
});

test("acceptEdits allows edits but requires confirmation for sends", async t => {
  const f = fixture(t, "acceptEdits"), run = f.run();
  await f.service.handleTool(f.task, run, "browser_action", { kind: "fill", ref: "e1", version: "v1", value: "hello", effect: "edit", summary: "Fill name" });
  assert.equal(f.executed.length, 1);
  f.task.observation = { ...f.observation };
  await f.service.handleTool(f.task, run, "browser_action", { kind: "click", ref: "e2", version: "v1", effect: "send", summary: "Send" });
  assert.equal(f.executed.length, 1);
  assert.equal(f.task.pending.kind, "confirmation");
});

test("terminal execution is not run before approval and once does not create a standing grant", async t => {
  const f = fixture(t), run = f.run();
  let calls = 0;
  f.service.terminal.run = async () => { calls++; return { status: "succeeded", stdout: "ok", stderr: "", exit_code: 0 }; };
  const input = { command: "console.log('ok')", runtime: "node", summary: "Print ok" };
  await f.service.handleTool(f.task, run, "terminal_run", input);
  assert.equal(calls, 0);
  const decision = f.task.pending;
  f.service.runs.clear();
  await f.service.reply(f.task.id, decision.id, "", true, "once");
  assert.equal(calls, 1);
  assert.equal(f.task.permissionRules, undefined);
  assert.ok(f.task.events.some(event => event.text.includes('"stdout":"ok"')));
  assert.notEqual(terminalPermissionScope({ ...decision.terminal, command: "different" }).scope, decision.permissionScope.scope);
});

test("node command wrappers fail before terminal confirmation or execution", async t => {
  const f = fixture(t), run = f.run();
  f.service.terminal.run = async () => assert.fail("Invalid source must never execute");
  for (const command of ['node -e "console.log(1)"', 'node.exe --eval "console.log(1)"', 'node -p "1+1"']) {
    await assert.rejects(f.service.handleTool(f.task, run, "terminal_run", { runtime: "node", command, summary: "test" }), /JavaScript/);
    assert.equal(f.task.pending, undefined); assert.equal(f.task.status, "running");
    assert.equal(f.task.usage.actions, 0);
  }
});

test("profile availability reports optional provider readiness without changing task state", t => {
  const f = fixture(t);
  assert.equal(f.service.profileAvailability("test"), undefined);
  f.service.dependencies.profileAvailability = id => id === "native:Default" ? { ready: false, code: "UPDATE_REQUIRED", reason: "Update extension" } : undefined;
  assert.deepEqual(f.service.profileAvailability("native:Default"), { ready: false, code: "UPDATE_REQUIRED", reason: "Update extension" });
  assert.equal(f.service.profileAvailability("test"), undefined);
  assert.equal(f.task.status, "paused");
});

test("rewind changes the actual next context and preserves irreversible action receipts", async t => {
  const f = fixture(t);
  f.store.event(f.task, "assistant", "old assistant answer");
  f.store.event(f.task, "user", "edit this request");
  const checkpoint = f.task.events.at(-1).id;
  f.store.event(f.task, "assistant", "must disappear from context");
  f.task.sdkSessionId = "old-sdk-session";
  f.task.context = { summary: "old compressed context", throughEventId: checkpoint, compactedAt: new Date().toISOString() };
  f.task.receipts = [{ id: "receipt", action: { effect: "send" }, status: "executed" }];
  const result = await f.command({ action: "task.rewind", id: f.task.id, eventId: checkpoint });
  assert.equal(result.draft, "edit this request");
  assert.equal(result.task.status, "paused");
  assert.equal(f.task.sdkSessionId, undefined);
  assert.equal(f.task.context, undefined);
  assert.equal(conversationEvents(f.task).some(event => event.text.includes("must disappear")), false);
  assert.equal(f.task.receipts[0].id, "receipt");
  assert.equal(result.task.checkpoints.some(point => point.eventId === checkpoint), false);
});

test("fork copies conversation and materials without copying browser leases or standing authority", async t => {
  const f = fixture(t);
  f.task.sdkSessionId = "original-sdk"; f.task.port = 9223;
  f.task.grant = { origin: "https://example.test", effects: ["send"], maxActions: 5, used: 1 };
  f.task.permissionRules = [{ id: randomUUID(), scope: "scope", kind: "browser", label: "old grant", createdAt: new Date().toISOString() }];
  const result = await f.command({ action: "task.fork", id: f.task.id, title: "New branch" });
  const branch = f.store.get(result.task.id);
  assert.notEqual(branch.id, f.task.id);
  assert.notEqual(branch.sessionId, f.task.sessionId);
  assert.equal(branch.sdkSessionId, undefined);
  assert.equal(branch.port, undefined);
  assert.equal(branch.grant, undefined);
  assert.equal(branch.permissionRules, undefined);
  assert.equal(branch.sourceTaskId, f.task.id);
  assert.equal(branch.status, "paused");
  assert.equal(branch.events[0].text, "original goal");
});

function fakeWorker(onStart) {
  const child = new EventEmitter(); child.connected = true; child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.connected = false; child.exitCode = 0; return true; };
  child.send = value => { if (value.kind === "start") queueMicrotask(() => onStart(child, value)); };
  return child;
}

test("unexpected worker exit preserves a pure conversation and reports only bounded runtime diagnostics", { timeout: 10000 }, async t => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const f = fixture(t);
  const script = path.join(f.root, "failed-worker.cjs");
  fs.writeFileSync(script, `process.on('message', message => {
    if (message.kind !== 'start') return;
    process.stderr.write('private-key ' + 'x'.repeat(100000) + '\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n', () => process.exit(23));
  });`);
  let child, exited;
  f.service.dependencies.worker = () => {
    child = fork(script, [], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    exited = once(child, "exit");
    return child;
  };
  const run = f.run();
  try {
    await f.service.startRun(f.task, run);
    await exited; await run.ending;
    assert.equal(f.task.status, "paused");
    assert.equal(f.task.needsReconciliation, false);
    assert.equal(f.service.runs.has(f.task.id), false);
    const event = f.task.events.at(-1).text;
    assert.match(event, /退出码 23/);
    assert.match(event, /内存分配失败/);
    assert.doesNotMatch(event, /核查页面|private-key|xxx/);
    assert.ok(event.length < 250);
    assert.equal(f.executed.length, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited.catch(() => {});
    await f.service.endRun(f.task, run);
  }
});

test("worker signals do not invent memory failure and retain real unresolved external work", async t => {
  const f = fixture(t);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  f.task.receipts = [{ id: "pending-submit", at: new Date().toISOString(), action: { kind: "click", summary: "Send", effect: "send" }, status: "uncertain" }];
  const run = f.run(); await f.service.startRun(f.task, run);
  child.connected = false; child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM");
  await run.ending;
  assert.equal(f.task.needsReconciliation, true);
  assert.match(f.task.events.at(-1).text, /SIGTERM.*已有外部操作待核查/);
  assert.doesNotMatch(f.task.events.at(-1).text, /内存/);
});

test("a completed answer followed by worker exit is not reported as an interrupted round", async t => {
  const f = fixture(t);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  const run = f.run(); await f.service.startRun(f.task, run);
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", summary: "Answer", responseOnly: true, evidence: [], remaining: [] });
  assert.equal(result.isError, false);
  child.connected = false; child.exitCode = 0; child.emit("exit", 0, null);
  await run.ending;
  assert.equal(f.task.status, "completed");
  assert.equal(f.task.result.kind, "answer");
  assert.equal(f.task.events.some(event => event.text.includes("本轮完成前退出")), false);
});

test("a real IPC worker receives stop without a late handoff tool_result", { timeout: 10000 }, async t => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const f = fixture(t);
  const script = path.join(f.root, "ipc-worker.cjs"), report = path.join(f.root, "ipc-messages.json");
  fs.writeFileSync(script, `const fs = require('node:fs'); const seen = [];
process.on('message', message => {
  seen.push(message.kind);
  if (message.kind === 'start') process.send({ kind: 'tool', id: 'handoff', name: 'handoff', args: { reason: 'No progress' } });
  if (message.kind === 'stop') process.send({ kind: 'fixture-stopped' });
  if (message.kind === 'fixture-exit') { fs.writeFileSync(process.argv[2], JSON.stringify(seen)); process.disconnect(); }
});`);
  let child, exited, toolReceived, stopReceived;
  const sent = [];
  f.service.dependencies.worker = () => {
    child = fork(script, [report], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    exited = once(child, "exit");
    toolReceived = new Promise(resolve => child.on("message", value => { if (value.kind === "tool") resolve(); }));
    stopReceived = new Promise(resolve => child.on("message", value => { if (value.kind === "fixture-stopped") resolve(); }));
    const send = child.send.bind(child);
    child.send = (...args) => { sent.push(args[0].kind); return send(...args); };
    return child;
  };
  // Keep the channel connected until the tool handler has returned. This
  // deterministically exercises the old connected-only check after stop.
  f.service.dependencies.browser.control = async () => { await stopReceived; };
  f.task.browserLeaseAttempted = true;
  const run = f.run();
  try {
    await f.service.startRun(f.task, run); await toolReceived; await run.chain;
    assert.equal(child.connected, true);
    assert.equal(run.stopped, true); assert.equal(f.task.pending.kind, "handoff");
    assert.deepEqual(sent, ["start", "stop"]);
    await new Promise((resolve, reject) => child.send({ kind: "fixture-exit" }, error => error ? reject(error) : resolve()));
    await exited; await run.ending;
    assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), ["start", "stop", "fixture-exit"]);
    assert.equal(f.task.status, "waiting_user"); assert.equal(f.service.runs.has(f.task.id), false);
    assert.equal(f.task.events.some(event => event.kind === "error"), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited.catch(() => {});
    await f.service.endRun(f.task, run);
  }
});

test("tool replies finishing after pause or endRun are not sent on a still-connected IPC channel", async t => {
  for (const ending of ["pause", "endRun"]) {
    const f = fixture(t), sent = [];
    let child, observed;
    f.service.dependencies.worker = () => {
      child = fakeWorker(() => {});
      child.send = (message, callback) => { sent.push(message.kind); callback?.(null); };
      return child;
    };
    f.service.dependencies.browser.observe = () => new Promise(resolve => { observed = resolve; });
    const run = f.run(); await f.service.startRun(f.task, run);
    child.emit("message", { kind: "tool", id: "read", name: "observe", args: {} });
    // The first browser tool now prepares its connection lazily.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof observed, "function");
    let drained;
    if (ending === "pause") await f.service.control(f.task.id, "pause");
    else drained = f.service.endRun(f.task, run);
    child.emit("message", { kind: "tool", id: "late-action", name: "browser_action", args: { kind: "open", value: "https://example.test/late", effect: "read", summary: "Must not navigate" } });
    observed({ ...f.observation }); await run.chain;
    if (drained) await drained; else await f.service.endRun(f.task, run);
    assert.equal(child.connected, true);
    assert.equal(sent.includes("tool_result"), false, ending);
    assert.equal(f.executed.length, 0, ending);
    assert.equal(f.task.events.some(event => event.kind === "error"), false, ending);
  }
});

test("IPC closed-channel errors are ignored only during stop or draining; active and unrelated failures remain visible", async t => {
  for (const code of ["EPIPE", "ERR_IPC_CHANNEL_CLOSED", "EACCES"]) {
    for (const lifecycle of ["active", "stopped", "ending"]) {
      for (const delivery of ["callback", "throw", "event"]) {
        const f = fixture(t);
        let child;
        const error = Object.assign(new Error(`${code}: private-key`), { code });
        f.service.dependencies.worker = () => {
          child = fakeWorker(() => {});
          child.send = (message, callback) => {
            if (message.kind === "start") { callback?.(null); return; }
            if (lifecycle !== "stopped" && message.kind === "stop") { callback?.(null); return; }
            if (delivery === "throw") throw error;
            if (delivery === "event") queueMicrotask(() => {
              child.emit("error", error);
              if (lifecycle === "stopped" && code !== "EACCES") child.emit("error", error);
            });
            else queueMicrotask(() => callback?.(error));
          };
          return child;
        };
        const run = f.run(); await f.service.startRun(f.task, run);
        let drain;
        if (lifecycle === "stopped") {
          f.task.status = "waiting_user"; f.task.pending = { id: "handoff", kind: "handoff", title: "No progress" };
          f.service.stopWorker(run);
        } else if (lifecycle === "ending") {
          let finish;
          run.chain = new Promise(resolve => { finish = resolve; });
          drain = f.service.endRun(f.task, run);
          // A send already in flight can report an error after drain began.
          if (delivery === "event") child.emit("error", error); else run.workerError(error);
          finish();
        } else {
          child.emit("message", { kind: "tool", id: "plan", name: "plan", args: { steps: ["Review"] } });
          await run.chain;
        }
        await new Promise(resolve => setImmediate(resolve));
        await (drain || f.service.endRun(f.task, run));
        const errors = f.task.events.filter(event => event.kind === "error");
        const expected = lifecycle !== "active" && code !== "EACCES";
        assert.equal(errors.length, expected ? 0 : 1, `${code}/${lifecycle}/${delivery}`);
        if (!expected) { assert.ok(errors[0].text.includes(code)); assert.equal(errors[0].text.includes("private-key"), false); }
        if (lifecycle === "stopped") { assert.equal(f.task.status, "waiting_user"); assert.equal(f.task.pending.kind, "handoff"); }
        else assert.equal(f.task.status, "paused");
      }
    }
  }
});

test("compact uses a model-only summary and resets SDK context while retaining full history", async t => {
  const f = fixture(t);
  f.task.model = "session-summary-model";
  f.store.event(f.task, "assistant", "A".repeat(2000));
  f.task.sdkSessionId = "old-sdk";
  let start;
  f.service.dependencies.worker = () => fakeWorker((child, value) => {
    start = value;
    child.emit("message", { kind: "result", success: true, result: "Preserve original goal; completed preliminary reading.", inputTokens: 30, outputTokens: 10, costUsd: 0.001 });
  });
  const result = await f.command({ action: "task.compact", id: f.task.id, instructions: "keep the goal" });
  assert.match(start.compactPrompt, /keep the goal/);
  assert.equal(start.settings.model, "session-summary-model");
  assert.equal(f.task.sdkSessionId, undefined);
  assert.match(f.task.context.summary, /original goal/);
  assert.ok(result.afterCharacters < result.beforeCharacters);
  assert.equal(f.task.events.some(event => event.text.length === 2000), true);
  assert.equal(conversationEvents(f.task).some(event => event.text.length === 2000), false);
});

test("cancel while compacting cannot replace the old context or revive the session", async t => {
  const f = fixture(t);
  f.task.sdkSessionId = "preserved-sdk";
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  const compacting = f.service.compactConversation(f.task.id);
  await Promise.resolve();
  const rejected = assert.rejects(compacting, /状态已经改变/);
  await f.service.control(f.task.id, "cancel");
  assert.equal(child.exitCode, 0, "cancel terminates the compaction worker immediately");
  child.emit("message", { kind: "result", success: true, result: "stale summary", costUsd: 0 });
  await rejected;
  assert.equal(f.task.status, "cancelled");
  assert.equal(f.task.context, undefined);
  assert.equal(f.task.sdkSessionId, "preserved-sdk");
});

test("attachment import copies selected files into managed storage and adds them to a paused conversation", async t => {
  const f = fixture(t);
  const selected = path.join(f.root, "selected.txt"); fs.writeFileSync(selected, "original attachment");
  const { attachments } = await f.command({ action: "task.attachments.import", id: f.task.id, paths: [selected] });
  assert.equal(attachments.length, 1);
  assert.notEqual(attachments[0].path, selected);
  fs.writeFileSync(selected, "changed original");
  assert.equal(fs.readFileSync(attachments[0].path, "utf8"), "original attachment");
  assert.equal(f.task.attachments[0].id, attachments[0].id);
});

test("stream deltas are visible to task.get without writing each token to disk", async t => {
  const f = fixture(t);
  let child, saves = 0;
  const save = f.store.save.bind(f.store); f.store.save = () => { saves++; save(); };
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  const run = f.run();
  await f.service.startRun(f.task, run);
  const before = saves;
  child.emit("message", { kind: "text_delta", id: "message-1", text: "Hello " });
  child.emit("message", { kind: "text_delta", id: "message-1", text: "world" });
  const page = await f.command({ action: "task.get", id: f.task.id });
  assert.equal(page.stream.text, "Hello world");
  assert.equal(saves, before);
  assert.equal(f.task.events.some(event => event.text === "Hello world"), false);
  child.emit("message", { kind: "text", text: "Hello world" });
  assert.equal(f.service.streams.has(f.task.id), false);
  assert.equal(f.task.events.filter(event => event.text === "Hello world").length, 1);
  clearTimeout(run.timer);
});

test("task.model changes only the session model and is used by the next worker", async t => {
  const f = fixture(t, "manual");
  f.task.model = "old-model";
  f.task.sdkSessionId = "keep-conversation";
  const pending = { id: randomUUID(), kind: "question", title: "More info?", details: "", createdAt: new Date().toISOString() };
  f.task.status = "waiting_user"; f.task.pending = pending;
  const result = await f.command({ action: "task.model", id: f.task.id, model: " new-model " });
  assert.equal(result.task.model, "new-model");
  assert.equal(result.task.mode, "manual");
  assert.equal(result.task.status, "waiting_user");
  assert.equal(f.task.pending, pending);
  assert.equal(f.task.sdkSessionId, "keep-conversation");
  assert.notEqual(f.store.data.settings.model, "new-model");
  assert.equal(JSON.parse(fs.readFileSync(f.store.file, "utf8")).tasks[0].model, "new-model");
  let start;
  f.service.dependencies.worker = () => fakeWorker((_child, value) => { start = value; });
  const run = f.run();
  await f.service.startRun(f.task, run);
  assert.equal(start.settings.model, "new-model");
  assert.equal(start.task.sdkSessionId, "keep-conversation");
});

test("task.model rejects malformed commands, active tasks and context editing without mutation", async t => {
  const f = fixture(t);
  for (const input of [{ model: " " }, { model: "m".repeat(201) }, { model: "ok", mode: "plan" }, { model: "ok", id: "bad-id" }]) {
    assert.throws(() => parseTaskManagementCommand({ action: "task.model", id: f.task.id, ...input }));
  }
  const run = f.run();
  await assert.rejects(f.command({ action: "task.model", id: f.task.id, model: "new" }), /先暂停/);
  assert.equal(f.task.model, undefined);
  run.stopped = true; f.task.status = "paused";
  await assert.rejects(f.command({ action: "task.model", id: f.task.id, model: "new" }), /先暂停/);
  f.service.runs.clear(); f.service.editingContext.add(f.task.id);
  await assert.rejects(f.command({ action: "task.model", id: f.task.id, model: "new" }), /先暂停/);
  f.service.editingContext.clear();
  assert.equal(f.task.model, undefined);
});

test("invalid mode/model update and invalid fork checkpoint have no partial side effects", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.store.file, "utf8"), events = structuredClone(f.task.events);
  assert.throws(() => f.service.setMode(f.task.id, "plan", " "));
  assert.equal(f.task.mode, "manual");
  await assert.rejects(f.command({ action: "task.fork", id: f.task.id, eventId: randomUUID() }), /找不到/);
  assert.equal(f.store.data.tasks.length, 1);
  assert.deepEqual(f.task.events, events);
  assert.equal(fs.readFileSync(f.store.file, "utf8"), before);
});

test("terminal session rules cannot broaden cwd, runtime, command, lifetime or timeout", () => {
  const input = { command: "pwd", runtime: "shell", cwd: ".", background: false, timeout_ms: 1000, yield_ms: 100 };
  const scope = terminalPermissionScope(input).scope;
  for (const changed of [{ command: "pwd; delete-files" }, { runtime: "node" }, { cwd: "subdir" }, { background: true }, { timeout_ms: 300000 }]) {
    assert.notEqual(terminalPermissionScope({ ...input, ...changed }).scope, scope);
  }
  assert.equal(terminalPermissionScope({ ...input, yield_ms: 0 }).scope, scope);
});

test("a stale browser approval cannot save a session rule", async t => {
  const f = fixture(t), run = f.run();
  await f.service.handleTool(f.task, run, "browser_action", { kind: "fill", ref: "e1", version: "v1", value: "name", effect: "edit", summary: "Fill" });
  const decision = f.task.pending;
  f.service.runs.clear(); f.observation.fingerprint = "changed";
  await f.service.reply(f.task.id, decision.id, "", true, "session");
  assert.equal(f.executed.length, 0);
  assert.equal(f.task.permissionRules, undefined);
  assert.equal(f.task.pending, undefined);
});

test("provider credentials spanning stream chunks are withheld and redacted before publication", async t => {
  const f = fixture(t);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  await f.service.startRun(f.task, f.run());
  child.emit("message", { kind: "text_delta", id: "secret-stream", text: "Header: private-" });
  assert.equal((await f.command({ action: "task.get", id: f.task.id })).stream.text, "Header: ");
  child.emit("message", { kind: "text_delta", id: "secret-stream", text: "key." });
  assert.equal((await f.command({ action: "task.get", id: f.task.id })).stream.text, "Header: [REDACTED].");
  child.emit("message", { kind: "text", id: "secret-stream", text: "Header: private-key." });
  child.emit("message", { kind: "error", text: "Unauthorized: private-key" });
  const result = await f.command({ action: "task.get", id: f.task.id });
  assert.equal(JSON.stringify(result).includes("private-key"), false);
  assert.equal(fs.readFileSync(f.store.file, "utf8").includes("private-key"), false);
  assert.equal(result.stream, undefined);
  assert.equal(redactProviderSecrets("echo aaa", ["aaa"], true), "echo [REDACTED]");
  assert.equal(redactProviderSecrets("echo a%2Fb", ["a/b"]), "echo [REDACTED]");
});

test("stream IPC batches deltas separately from full snapshots and persists the same message identity", async t => {
  const f = fixture(t), updates = [], snapshots = [];
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  f.service.dependencies.streamChanged = update => updates.push(structuredClone(update));
  f.service.dependencies.changed = snapshot => snapshots.push(snapshot);
  await f.service.startRun(f.task, f.run());
  await new Promise(resolve => setTimeout(resolve, 110)); snapshots.length = 0;
  child.emit("message", {kind:"text_delta",id:"response",text:"中文"});
  child.emit("message", {kind:"text_delta",id:"response",text:"输出"});
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(updates.length,1); assert.equal(updates[0].stream.text,"中文输出"); assert.equal(snapshots.length,0);
  assert.equal(f.task.events.some(event=>event.kind==="assistant"),false);
  child.emit("message", {kind:"text",id:"response",text:"中文输出"});
  assert.equal(f.task.events.at(-1).streamId,updates[0].stream.id);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(snapshots.length,1); assert.equal(snapshots[0].streams[f.task.id],undefined);
});

test("reused SDK response ids get separate block identities and id-less completion retains its delta identity", async t => {
  const f = fixture(t); let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  await f.service.startRun(f.task,f.run());
  child.emit("message", {kind:"text_delta",id:"same",text:"first"});
  const first = f.service.snapshot().streams[f.task.id].id;
  child.emit("message", {kind:"text",id:"same",text:"first"});
  child.emit("message", {kind:"text_delta",id:"same",text:"second"});
  const second = f.service.snapshot().streams[f.task.id].id;
  assert.notEqual(first,second);
  child.emit("message", {kind:"text",text:"second"});
  assert.deepEqual(f.task.events.filter(event=>event.kind==="assistant").map(event=>event.streamId),[first,second]);
  assert.equal(f.service.snapshot().streams[f.task.id],undefined);
});

test("stream text keeps its prefix at the event limit and old final messages do not clear a newer stream", async t => {
  const f = fixture(t);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  await f.service.startRun(f.task, f.run());
  child.emit("message", { kind: "text_delta", id: "new-message", text: "prefix " + "x".repeat(30000) });
  child.emit("message", { kind: "text", id: "old-message", text: "previous" });
  const result = await f.command({ action: "task.get", id: f.task.id });
  assert.equal(result.stream.id, "new-message");
  assert.equal(result.stream.text.length, 30000);
  assert.ok(result.stream.text.startsWith("prefix "));
});

for (const [success, budgetExceeded, expected] of [[false, false, "failed"], [true, false, "partial"], [false, true, "paused"]]) {
  test(`SDK result success=${success}, budget=${budgetExceeded} reports ${expected}`, async t => {
    const f = fixture(t);
    let child;
    f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
    await f.service.startRun(f.task, f.run());
    child.emit("message", { kind: "result", success, budgetExceeded, result: "response private-key", costUsd: 0 });
    const result = await f.command({ action: "task.status", id: f.task.id });
    assert.equal(result.task.status, expected);
    assert.equal(JSON.stringify(result).includes("private-key"), false);
  });
}

test("attachment limits reject a whole import before copying or changing the conversation", async t => {
  const f = fixture(t), small = path.join(f.root, "small.txt"), large = path.join(f.root, "large.bin");
  fs.writeFileSync(small, "small");
  const handle = fs.openSync(large, "w"); fs.ftruncateSync(handle, 50 * 1024 * 1024 + 1); fs.closeSync(handle);
  for (const paths of [[small, large], [small, f.root], Array(51).fill(small)]) {
    await assert.rejects(async () => f.command({ action: "task.attachments.import", id: f.task.id, paths }));
    assert.equal(f.task.attachments.length, 0);
    assert.equal(f.store.data.attachments.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, "attachments")), false);
  }
  f.task.attachments = Array.from({ length: 50 }, (_, n) => ({ id: String(n), name: "old", path: small, size: 5 }));
  await assert.rejects(f.command({ action: "task.attachments.import", id: f.task.id, paths: [small] }), /最多/);
  assert.equal(f.task.attachments.length, 50);
});

test("an attachment that grows while copying is rejected and its partial managed file is removed", async t => {
  const f = fixture(t), small = path.join(f.root, "growing.txt");
  fs.writeFileSync(small, "small");
  const copy = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (source, destination) => {
    copy(source, destination);
    const handle = fs.openSync(destination, "r+"); fs.ftruncateSync(handle, 50 * 1024 * 1024 + 1); fs.closeSync(handle);
  });
  await assert.rejects(f.command({ action: "task.attachments.import", id: f.task.id, paths: [small] }), /50 MB/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "attachments")), []);
  assert.deepEqual(f.task.attachments, []);
  assert.deepEqual(f.store.data.attachments, []);
});

test("failed compaction preserves the original context and ignores late worker accounting", async t => {
  const f = fixture(t);
  f.task.sdkSessionId = "old-sdk";
  f.task.context = { summary: "old summary", throughEventId: f.task.events[0].id, compactedAt: new Date().toISOString() };
  const original = structuredClone(f.task.context);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  const compacting = f.service.compactConversation(f.task.id);
  await Promise.resolve();
  const rejected = assert.rejects(compacting, error => error.message === "provider rejected [REDACTED]");
  child.emit("message", { kind: "error", text: "provider rejected private-key" });
  await rejected;
  child.emit("message", { kind: "result", success: true, result: "late summary", costUsd: 100 });
  assert.deepEqual(f.task.context, original);
  assert.equal(f.task.sdkSessionId, "old-sdk");
  assert.equal(f.task.usage.costUsd, 0);
});

async function sdkWorker(input, messages) {
  const vm = require("node:vm"), { createRequire } = require("node:module");
  const filename = path.join(output, "worker.js");
  const source = fs.readFileSync(filename, "utf8");
  const processMock = new EventEmitter(), sent = [];
  let options, closed = false, disconnected;
  const done = new Promise(resolve => { disconnected = resolve; });
  processMock.connected = true; processMock.env = {}; processMock.send = value => sent.push(value);
  processMock.disconnect = disconnected;
  const sdk = {
    tool: (name, _description, _schema, callback) => ({ name, callback }), createSdkMcpServer: value => value,
    query: value => {
      options = value.options;
      const iterator = (async function* () { for (const message of messages) yield message; })();
      return Object.assign(iterator, { close: () => { closed = true; }, interrupt: async () => {} });
    }
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,process,Function){${source}\n})`, { filename });
  load(createRequire(filename), module, module.exports, path.dirname(filename), processMock, function () { return () => Promise.resolve(sdk); });
  processMock.emit("message", { kind: "start", ...input });
  await done;
  assert.equal(closed, true);
  assert.equal(sent.some(message => message.kind === "error"), false, JSON.stringify(sent));
  return { options, sent };
}

test("worker forwards real SDK deltas before completed blocks and excludes subagent text", async t => {
  const f = fixture(t);
  const delta = (id, event, parent_tool_use_id = null) => ({ type: "stream_event", uuid: id, event, parent_tool_use_id });
  const complete = (text, parent_tool_use_id = null) => ({ type: "assistant", error: true, parent_tool_use_id, message: { id: "response-1", content: [{ type: "text", text }] } });
  const { options, sent } = await sdkWorker({ task: f.task, settings: f.store.data.settings, apiKey: "private-key", cwd: f.root }, [
    delta("1", { type: "message_start", message: { id: "response-1" } }),
    delta("2", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First " } }),
    delta("3", { type: "message_start", message: { id: "child-response" } }, "agent-tool"),
    delta("4", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hidden child text" } }, "agent-tool"),
    complete("hidden child text", "agent-tool"),
    delta("5", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "block" } }),
    complete("First block"),
    delta("6", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Second block" } }),
    complete("Second block")
  ]);
  assert.equal(options.includePartialMessages, true);
  assert.deepEqual(sent.filter(message => ["text_delta", "text"].includes(message.kind)), [
    { kind: "text_delta", id: "response-1", text: "First " }, { kind: "text_delta", id: "response-1", text: "block" },
    { kind: "text", id: "response-1", text: "First block" }, { kind: "text_delta", id: "response-1", text: "Second block" },
    { kind: "text", id: "response-1", text: "Second block" }
  ]);
});

test("compaction worker cannot resume or persist an SDK session and has no tools", async t => {
  const f = fixture(t); f.task.sdkSessionId = "sensitive-session";
  const { options } = await sdkWorker({ task: f.task, settings: f.store.data.settings, apiKey: "private-key", cwd: f.root, compactPrompt: "summarize" }, []);
  assert.equal(options.resume, undefined);
  assert.equal(options.persistSession, false);
  assert.equal(options.includePartialMessages, false);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.mcpServers, {});
});

test("manual mode requires approval before creating a result file and consumes it once", async t => {
  const f = fixture(t), run = f.run();
  const input = { name: "report", format: "markdown", text: "User-approved report" };
  await f.service.handleTool(f.task, run, "export_result", input);
  assert.equal(f.task.status, "waiting_user");
  assert.equal(f.task.outputs, undefined);
  assert.equal(fs.existsSync(path.join(f.root, "artifacts", f.task.id)), false);
  const pending = f.task.pending;
  assert.deepEqual(JSON.parse((await f.command({ action: "task.get", id: f.task.id })).task.pending.details), { ...input, columns: [], rows: [] });
  f.service.runs.clear();
  await f.command({ action: "task.reply", id: f.task.id, decisionId: pending.id, approved: true, answer: "", scope: "once" });
  assert.equal(f.task.outputs.length, 1);
  assert.equal(fs.readFileSync(f.task.outputs[0].path, "utf8"), input.text);
  await assert.rejects(f.service.reply(f.task.id, pending.id, "", true), /失效/);
  assert.equal(f.task.outputs.length, 1);
});

test("rejecting a file confirmation writes nothing while acceptEdits allows task outputs", async t => {
  const f = fixture(t), run = f.run(), input = { name: "report", format: "html", text: "<h1>Report</h1>" };
  await f.service.handleTool(f.task, run, "export_result", input);
  const pending = f.task.pending;
  f.service.runs.clear();
  await f.service.reply(f.task.id, pending.id, "", false);
  assert.equal(f.task.outputs, undefined);
  f.task.status = "paused";
  f.service.setMode(f.task.id, "acceptEdits");
  await f.service.handleTool(f.task, f.run(), "export_result", input);
  assert.equal(f.task.outputs.length, 1);
});

for (const mode of ["plan", "manual"]) {
  test(`${mode} cannot bypass edit policy with read-labelled checkbox clicks or keystrokes`, async t => {
    for (const kind of ["click", "press", "download", "close_tab"]) {
      const f = fixture(t, mode);
      f.observation.snapshot = '- checkbox "Receive messages" [ref=e1]';
      const result = await f.service.handleTool(f.task, f.run(), "browser_action", { kind, ref: "e1", version: "v1", value: kind === "press" ? "Space" : undefined, effect: "read", summary: "Read" });
      assert.equal(f.executed.length, 0, kind);
      if (mode === "plan") assert.equal(result.isError, true, kind);
      else { assert.equal(f.task.pending.kind, "confirmation", kind); assert.equal(f.task.pending.action.effect, "edit", kind); }
    }
  });
}

test("status clears running subagents when their worker exits and after application recovery", async t => {
  const f = fixture(t);
  let child;
  f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
  const run = f.run(); await f.service.startRun(f.task, run);
  child.emit("message", { kind: "agent_activity", id: "agent-1", description: "Investigate", status: "running" });
  child.emit("message", { kind: "agent_activity", id: "agent-2", description: "Done", status: "completed" });
  assert.equal((await f.command({ action: "task.status", id: f.task.id })).subagents[0].status, "running");
  await f.service.endRun(f.task, run);
  const status = await f.command({ action: "task.status", id: f.task.id });
  assert.equal(status.task.running, false);
  assert.deepEqual(status.subagents.map(agent => agent.status), ["interrupted", "completed"]);
  f.task.agentActivities[0].status = "running"; f.store.save();
  const recovered = new TaskStore(f.root);
  assert.deepEqual(recovered.get(f.task.id).agentActivities.map(agent => agent.status), ["interrupted", "completed"]);
});

test("native creation retains target and policy and defaults to acceptEdits without terminal authority", async t => {
  const f = fixture(t);
  f.store.data.nativeAccessPolicies = { "native:Default": { blockedOrigins: ["https://blocked.test"], confirmActions: false } };
  const task = f.store.create({ profileId: "native:Default", prompt: "Use this page", nativeTarget: { tabId: 15 } }, "Chrome");
  assert.equal(task.mode, "acceptEdits");
  assert.deepEqual(task.nativeTarget, { tabId: 15 });
  assert.deepEqual(task.nativeAccess, f.store.data.nativeAccessPolicies[task.profileId]);
  assert.notEqual(task.nativeAccess, f.store.data.nativeAccessPolicies[task.profileId]);
  assert.throws(() => f.store.create({ profileId: "other", prompt: "task", nativeTarget: { tabId: 15 } }, "Other"), /系统 Chrome/);
  assert.throws(() => f.store.create({ profileId: "native:Default", prompt: "task", nativeTarget: { tabId: 15, newTab: true } }, "Chrome"));
});

test("native default access executes browser consequences with receipts and still stops for reconciliation", async t => {
  for (const effect of ["send", "purchase"]) {
    const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
    f.observation.snapshot = `- button "${effect === "purchase" ? "购买" : "发送"}" [ref=e2]`;
    const run = f.run();
    await f.service.handleTool(f.task, run, "browser_action", { kind: "click", ref: "e2", version: "v1", effect, summary: "Authorized operation" });
    assert.equal(f.task.pending, undefined);
    assert.equal(f.executed.length, 1);
    assert.equal(f.task.receipts[0].action.effect, effect);
    assert.equal(f.task.receipts[0].status, "executed");
    f.task.observation = { ...f.observation }; f.task.needsReconciliation = true;
    const result = await f.service.handleTool(f.task, run, "browser_action", { kind: "click", ref: "e2", version: "v1", effect, summary: "Repeat" });
    assert.equal(result.isError, true);
    assert.equal(f.executed.length, 1);
  }
});

test("native full browser access never grants unapproved terminal execution", async t => {
  const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
  let called = false;
  f.service.terminal.run = async () => { called = true; };
  await f.service.handleTool(f.task, f.run(), "terminal_run", { command: "echo test", summary: "test" });
  assert.equal(called, false);
  assert.equal(f.task.pending.kind, "confirmation");
});

test("native blocked navigation checks its destination and explicit confirmation remains enforceable", async t => {
  const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
  f.task.nativeAccess = { blockedOrigins: ["https://blocked.test"], confirmActions: true };
  const run = f.run();
  const blocked = await f.service.handleTool(f.task, run, "browser_action", { kind: "open", value: "https://blocked.test/path", effect: "read", summary: "Visit" });
  assert.equal(blocked.isError, true);
  assert.equal(f.executed.length, 0);
  await f.service.handleTool(f.task, run, "browser_action", { kind: "fill", ref: "e1", version: "v1", value: "name", effect: "edit", summary: "Edit" });
  assert.equal(f.task.pending.kind, "confirmation");
  assert.equal(f.executed.length, 0);
});

test("read_page stores the actionable observation but sends only public page data to the worker", async t => {
  const f = fixture(t, "plan"), run = f.run();
  let input;
  const observation = { ...f.observation, page: { frameId: "child", nextCursor: "page-2", totalControls: 180, totalText: 30000, offset: 80, textOffset: 8000 },
    frames: [{ id: "child", url: "https://example.test/frame", oopif: true }],
    fast: { document: "document-1", guard: "private-dom-guard", candidates: [{ ref: "e88", role: "link", label: "Next", kind: "click" }] } };
  f.service.dependencies.browser.readPage = async (_task, options) => { input = options; return observation; };
  const result = await f.service.handleTool(f.task, run, "read_page", { cursor: "page-1", frameId: "child" });
  const visible = JSON.parse(result.content[0].text);
  assert.equal(input.limit, 80);
  assert.equal(input.textLimit, 8000);
  assert.equal(input.frameId, "child");
  assert.equal(f.task.observation, observation);
  assert.equal(visible.page.nextCursor, "page-2");
  assert.deepEqual(visible.frames, observation.frames);
  assert.equal(visible.fast.guard, undefined);
  assert.equal(visible.fast.document, undefined);
  await assert.rejects(f.service.handleTool(f.task, run, "read_page", { limit: 121 }));
});

test("pure CLI answer completes without browser/terminal evidence and is explicitly an answer", async t => {
  const f = fixture(t), run = f.run();
  f.task.prompt = "不要操作浏览器和终端，仅回复：验收成功";
  f.task.observation = undefined;
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "验收成功", evidence: [], remaining: [] });
  assert.equal(result.isError, false);
  assert.equal(f.task.status, "completed");
  assert.equal(f.task.usage.actions, 0);
  assert.equal(f.executed.length, 0);
  assert.equal(f.service.terminal.list(f.task.id).length, 0);
  const { task } = await f.command({ action: "task.get", id: f.task.id });
  assert.equal(task.result.kind, "answer");
  assert.equal(task.result.summary, "已回答：验收成功");
  assert.deepEqual(task.result.evidence, []);
});

test("pure answer worker exit never releases an unclaimed gateway or native session", async t => {
  for (const connection of ["gateway", "extension"]) {
    const f = fixture(t);
    f.service.dependencies.prepareProfile = async () => ({ name: "Test", browserConnection: connection, port: connection === "gateway" ? 9223 : undefined });
    let child, controls = 0;
    f.service.dependencies.worker = () => fakeWorker(value => { child = value; });
    f.service.dependencies.browser.control = async () => { controls++; throw new Error("Session has no Profile: never claimed"); };
    // A second pure-answer turn must also avoid cleanup after the route has
    // already been prepared by the first turn.
    for (let turn = 0; turn < 2; turn++) {
      if (turn) await f.service.control(f.task.id, "resume", "再回复一次");
      const run = f.run();
      await f.service.startRun(f.task, run);
      child.emit("message", { kind: "text", id: `answer-${turn}`, text: "终端对话测试通过" });
      child.emit("message", { kind: "tool", id: `finish-${turn}`, name: "finish", args: { status: "completed", responseOnly: true, summary: "终端对话测试通过", evidence: [], remaining: [] } });
      await run.chain;
      child.connected = false; child.exitCode = 0; child.emit("exit", 0);
      await run.ending;
      const { task } = await f.command({ action: "task.get", id: f.task.id });
      assert.equal(task.status, "completed", connection);
      assert.equal(task.running, false, connection);
      assert.equal(task.result.kind, "answer", connection);
      assert.equal(task.usage.actions, 0, connection);
      assert.equal(controls, 0, connection);
      assert.equal(f.task.browserReleasePending, undefined, connection);
      assert.equal(f.task.events.some(event => event.kind === "error"), false, connection);
    }
  }
});

test("browser reads cannot finish as pure answers and their leases still receive cleanup", async t => {
  for (const scenario of ["observe", "tabs", "read_page", "failed-read", "retained", "release-error"]) {
    const f = fixture(t);
    f.service.dependencies.prepareProfile = async () => ({ name: "Test", port: 9223 });
    f.service.dependencies.worker = () => fakeWorker(() => {});
    const controls = [];
    f.service.dependencies.browser.control = async (_task, action) => {
      controls.push(action);
      if (scenario === "release-error") throw new Error("real browser release failed");
    };
    // Legacy/retained sessions have a route but no new lease marker. Preserve
    // their old cleanup rather than assume that no observation means no lease.
    if (scenario === "retained") f.task.port = 9223;
    const run = f.run();
    await f.service.startRun(f.task, run);
    if (scenario === "failed-read") {
      f.service.dependencies.browser.observe = async () => { throw new Error("snapshot failed after claiming"); };
      await assert.rejects(f.service.handleTool(f.task, run, "observe", {}), /snapshot failed/);
    } else if (scenario !== "retained") {
      f.service.dependencies.browser.readPage = async () => ({ ...f.observation });
      await f.service.handleTool(f.task, run, scenario === "release-error" ? "tabs" : scenario, {});
    }
    const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "Answer", evidence: [], remaining: [] });
    assert.equal(result.isError, scenario !== "retained", scenario);
    if (scenario !== "retained") {
      assert.equal(f.task.status, "running"); assert.equal(f.task.result, undefined);
      await f.service.handleTool(f.task, run, "finish", { status: "partial", summary: "Observed only", evidence: [], remaining: ["External task not verified"] });
    }
    await f.service.endRun(f.task, run);
    assert.deepEqual(controls, ["complete"], scenario);
    if (scenario === "release-error") {
      assert.equal(f.task.browserReleasePending, true);
      assert.equal(f.task.browserLeaseAttempted, true);
      assert.ok(f.task.events.some(event => event.kind === "error" && event.text.includes("real browser release failed")));
    } else {
      assert.equal(f.task.browserReleasePending, undefined, scenario);
      assert.equal(f.task.browserLeaseAttempted, false, scenario);
    }
  }
});

test("reading a selected local attachment still permits an answer without browser access", async t => {
  const f = fixture(t), run = f.run(); f.task.observation = undefined;
  const file = path.join(f.root, "selected.csv"); fs.writeFileSync(file, "name,value\nexample,42\n");
  f.task.attachments = [{ id: "selected", name: "selected.csv", path: file, size: fs.statSync(file).size }];
  for (const method of ["observe", "readPage", "tabs", "execute"]) f.service.dependencies.browser[method] = async () => assert.fail("Local attachment must not access the browser");
  const table = await f.service.handleTool(f.task, run, "read_table", { attachmentId: "selected" });
  assert.equal(table.isError, false);
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "Local attachment explained", evidence: [], remaining: [] });
  assert.equal(result.isError, false); assert.equal(f.task.result.kind, "answer");
  assert.equal(f.task.observation, undefined); assert.equal(f.task.usage.actions, 0);
});

test("pause, cancel, takeover and shutdown do not control a prepared but unclaimed browser", async t => {
  for (const connection of ["gateway", "extension"]) for (const operation of ["pause", "cancel", "takeover", "close"]) {
    const f = fixture(t);
    f.service.dependencies.prepareProfile = async () => ({ name: "Test", browserConnection: connection, port: connection === "gateway" ? 9223 : undefined });
    f.service.dependencies.worker = () => {
      const child = fakeWorker(() => {});
      const send = child.send;
      child.send = message => {
        send(message);
        if (message.kind === "stop") { child.connected = false; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); }
      };
      return child;
    };
    const controls = [];
    f.service.dependencies.browser.control = async (_task, action) => { controls.push(action); throw new Error("unclaimed session"); };
    const run = f.run();
    await f.service.startRun(f.task, run);
    if (operation === "close") await f.service.close();
    else { await f.service.control(f.task.id, operation); await f.service.endRun(f.task, run); }
    assert.deepEqual(controls, [], `${connection}/${operation}`);
    assert.equal(f.task.browserLeaseAttempted, false);
    assert.equal(f.task.browserReleasePending, undefined);
    assert.equal(f.task.events.some(event => event.kind === "error"), false);
    if (operation === "pause" || operation === "takeover") {
      await f.service.control(f.task.id, "resume", "continue");
      assert.deepEqual(controls, [], "resuming an unclaimed task must wait for its first actual browser request");
      assert.equal(f.task.status, "queued");
    }
  }
});

test("stopping after a failed browser request preserves real handoff and release errors", async t => {
  for (const operation of ["pause", "cancel", "close"]) {
    const f = fixture(t);
    f.service.dependencies.prepareProfile = async () => ({ name: "Test", port: 9223 });
    f.service.dependencies.worker = () => fakeWorker(() => {});
    const controls = [];
    f.service.dependencies.browser.observe = async () => { throw new Error("failed after claim"); };
    f.service.dependencies.browser.control = async (_task, action) => { controls.push(action); throw new Error("real cleanup failed"); };
    const run = f.run();
    await f.service.startRun(f.task, run);
    await assert.rejects(f.service.handleTool(f.task, run, "observe", {}), /failed after claim/);
    if (operation === "close") {
      run.child.exitCode = 0;
      // Shutdown now reports failed handoff to its coordinator rather than
      // silently marking cleanup successful. The memoized close result is also
      // checked by fixture teardown, without skipping later fixtures' timers.
      f.cleanup.expectedError = error => error instanceof AggregateError && error.errors.some(item => item.message === "real cleanup failed");
      await assert.rejects(f.service.close(), f.cleanup.expectedError);
      assert.ok(f.task.events.some(event => event.kind === "error" && event.text.includes("real cleanup failed")));
    } else await assert.rejects(f.service.control(f.task.id, operation), /real cleanup failed/);
    assert.deepEqual(controls, [operation === "cancel" ? "release" : "handoff"]);
    assert.equal(f.task.browserLeaseAttempted, true);
    if (operation === "cancel") assert.equal(f.task.browserReleasePending, true);
    // The deliberate fault belongs to the operation under test. A subsequent
    // fixture shutdown must not fail before other fixtures can release timers.
    f.service.dependencies.browser.control = async () => {};
  }
});

test("responseOnly cannot hide browser, terminal or file actions from this run", async t => {
  for (const operation of ["browser", "terminal", "file"]) {
    const f = fixture(t, "acceptEdits"), run = f.run();
    if (operation === "browser") await f.service.handleTool(f.task, run, "browser_action", { kind: "open", effect: "read", value: "https://example.test", summary: "Open" });
    if (operation === "terminal") {
      f.task.mode = undefined;
      f.service.terminal.run = async () => ({ status: "succeeded", stdout: "fake evidence", stderr: "", exit_code: 0 });
      await f.service.handleTool(f.task, run, "terminal_run", { command: "echo fake evidence", summary: "echo" });
    }
    if (operation === "file") await f.service.handleTool(f.task, run, "export_result", { name: "fake", format: "markdown", text: "evidence" });
    const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "Answered", evidence: [], remaining: [] });
    assert.equal(result.isError, true, operation);
    assert.equal(f.task.status, "running", operation);
  }
});

test("two verified browser rounds can be followed by a pure answer without reopening old receipts", async t => {
  const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
  f.service.dependencies.prepareProfile = async () => ({ name: "Native", browserConnection: "extension" });
  f.service.dependencies.worker = () => fakeWorker(() => {});
  for (let turn = 0; turn < 2; turn++) {
    if (turn) await f.service.control(f.task.id, "resume", "继续浏览另一个平台");
    let run = f.run(); await f.service.startRun(f.task, run);
    if (turn) {
      // Pausing the next round must not reopen the already verified first round.
      await f.service.control(f.task.id, "pause"); await f.service.endRun(f.task, run);
      assert.equal(f.task.needsReconciliation, false);
      await f.service.control(f.task.id, "resume", "继续第二轮");
      run = f.run(); await f.service.startRun(f.task, run);
    }
    await f.service.handleTool(f.task, run, "observe", {});
    // Reproduce older DOM classification: a search/record click was tagged submit.
    await f.service.handleTool(f.task, run, "browser_action", { kind: "click", ref: "e2", version: "v1", effect: "submit", summary: `Search round ${turn + 1}` });
    await f.service.handleTool(f.task, run, "observe", {});
    const finished = await f.service.handleTool(f.task, run, "finish", { status: "completed", summary: "浏览完成", evidence: ["Name"], remaining: [] });
    assert.equal(finished.isError, false);
    await f.service.endRun(f.task, run);
    assert.equal(f.task.receipts.every(receipt => receipt.status === "executed"), true);
  }
  const receipts = structuredClone(f.task.receipts), actions = f.task.usage.actions;
  await f.service.control(f.task.id, "resume", "仅根据前两轮总结，不浏览、不运行终端、不写文件");
  assert.equal(f.task.needsReconciliation, false);
  assert.deepEqual(f.task.receipts, receipts);
  const forbidden = async () => assert.fail("Pure follow-up must not perform external I/O");
  Object.assign(f.service.dependencies.browser, { observe: forbidden, observeFast: forbidden, readPage: forbidden, execute: forbidden, tabs: forbidden, control: forbidden });
  f.service.terminal.run = forbidden;
  f.store.data.settings.jevEnabled = true; f.store.data.settings.jevMode = "driver";
  f.service.dependencies.jevApiKey = () => "fixture-only";
  const run = f.run(); await f.service.startRun(f.task, run);
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "比较已有结果", evidence: [], remaining: [] });
  assert.equal(result.isError, false);
  await f.service.endRun(f.task, run);
  assert.equal(f.task.result.kind, "answer"); assert.equal(f.task.needsReconciliation, false);
  assert.deepEqual(f.task.result.remaining, []); assert.deepEqual(f.task.receipts, receipts);
  assert.equal(f.task.usage.actions, actions); assert.equal(f.task.outputs, undefined);
  assert.equal(f.task.events.some(event => event.kind === "error"), false);
});

test("pure answers preserve unresolved external work and cannot turn it into verified completion", async t => {
  for (const status of ["started", "uncertain", "executed"]) {
    const f = fixture(t, "acceptEdits");
    f.task.receipts = [{ id: "pending-submit", at: new Date().toISOString(), status,
      action: { kind: "click", effect: "submit", summary: "发送申请" },
      ...(status === "executed" ? { reconciliation: { outcome: "uncertain", evidence: "结果未知", at: new Date().toISOString() } } : {}) }];
    f.task.needsReconciliation = false; // Stale persisted flag must not hide a receipt.
    f.task.items = [{ id: "pending-item", label: "核查申请是否送达", status: "uncertain" }];
    const receipts = structuredClone(f.task.receipts), items = structuredClone(f.task.items);
    const run = f.run(); f.task.observation = undefined;
    const answer = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "仅说明已知情况", evidence: [], remaining: [] });
    assert.equal(answer.isError, false, status);
    assert.equal(f.task.result.kind, "answer"); assert.equal(f.task.needsReconciliation, true);
    assert.deepEqual(f.task.receipts, receipts); assert.deepEqual(f.task.items, items);
    assert.ok(f.task.result.remaining.some(value => value.includes("发送申请")));
    assert.ok(f.task.result.remaining.some(value => value.includes("核查申请是否送达")));
    const dto = (await f.command({ action: "task.get", id: f.task.id })).task;
    assert.equal(dto.result.kind, "answer"); assert.equal(dto.needsReconciliation, true);
    assert.deepEqual(dto.result.remaining, f.task.result.remaining);
    await f.service.endRun(f.task, run);
    await f.service.control(f.task.id, "resume", "继续处理外部任务");
    const next = f.run();
    await f.service.handleTool(f.task, next, "observe", {});
    assert.equal(f.task.needsReconciliation, true, "an unrelated fresh page cannot settle an unresolved submission");
    const verified = await f.service.handleTool(f.task, next, "finish", { status: "completed", summary: "全部完成", evidence: ["Name"], remaining: [] });
    assert.equal(verified.isError, true);
    const repeated = await f.service.handleTool(f.task, next, "browser_action", { kind: "click", effect: "submit", ref: "e2", version: "v1", summary: "再次发送申请" });
    assert.equal(repeated.isError, true); assert.equal(f.executed.length, 0);
  }
});

test("answer-only continuation preserves partial remaining work and never upgrades unverified execution", async t => {
  const f = fixture(t);
  f.task.status = "partial";
  f.task.result = { summary: "仍待核查", evidence: [], remaining: ["检查服务端是否收到申请"] };
  f.task.receipts = [{ id: "unverified", at: new Date().toISOString(), status: "executed", action: { kind: "click", effect: "submit", summary: "发送申请" } }];
  await f.service.control(f.task.id, "resume", "仅解释当前进度，不操作浏览器");
  assert.equal(f.task.receipts[0].status, "uncertain"); assert.equal(f.task.needsReconciliation, true);
  const run = f.run();
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", responseOnly: true, summary: "只作解释", evidence: [], remaining: [] });
  assert.equal(result.isError, false);
  assert.ok(f.task.result.remaining.includes("检查服务端是否收到申请"));
  assert.equal(f.task.result.kind, "answer"); assert.equal(f.task.needsReconciliation, true);
  const restored = new TaskStore(f.root).get(f.task.id);
  assert.equal(restored.result.kind, "answer"); assert.equal(restored.needsReconciliation, true);
  assert.equal(restored.receipts[0].status, "uncertain"); assert.equal(restored.receipts[0].verifiedAt, undefined);
});

test("reconciling one receipt cannot hide a second started submission", async t => {
  const f = fixture(t), run = f.run();
  f.task.receipts = ["first", "second"].map(id => ({ id, status: "started", at: new Date().toISOString(), action: { kind: "click", effect: "submit", summary: id } }));
  f.task.needsReconciliation = true;
  await f.service.handleTool(f.task, run, "reconcile", { receiptId: "first", outcome: "completed", evidence: "Name" });
  assert.equal(f.task.needsReconciliation, true);
  await f.service.handleTool(f.task, run, "reconcile", { receiptId: "second", outcome: "uncertain", evidence: "Name" });
  assert.equal(f.task.needsReconciliation, true);
  await f.service.handleTool(f.task, run, "reconcile", { receiptId: "second", outcome: "not_completed", evidence: "Name" });
  assert.equal(f.task.needsReconciliation, false);
});

test("verified legacy receipts stay settled through reload and later interruptions", async t => {
  const f = fixture(t);
  f.task.status = "completed"; f.task.result = { kind: "verified", summary: "浏览完成", evidence: ["Name"], remaining: [] };
  f.task.receipts = [{ id: "old-search", at: new Date().toISOString(), status: "executed", action: { kind: "press", effect: "submit", value: "Enter", summary: "执行搜索" } }];
  f.store.save();
  const restored = new TaskStore(f.root);
  const task = restored.get(f.task.id);
  task.status = "running"; restored.save();
  const recovered = new TaskStore(f.root).get(f.task.id);
  assert.equal(recovered.receipts[0].status, "executed");
  assert.equal(recovered.needsReconciliation, false);
  assert.equal(recovered.status, "paused");
  // The completion marker must never bless an explicitly uncertain operation.
  recovered.status = "completed"; recovered.result = { kind: "verified", summary: "stale", evidence: ["Name"], remaining: [] };
  recovered.receipts[0].status = "uncertain"; recovered.needsReconciliation = false;
  restored.data.tasks = [recovered]; restored.save();
  assert.equal(new TaskStore(f.root).get(f.task.id).needsReconciliation, true);
});

test("idle native reservation cleanup distinguishes page freshness from unresolved submissions", async t => {
  const at = new Date().toISOString();
  const cases = [
    { name: "no external work", receipts: [], expected: false },
    { name: "read-only history", receipts: [{ status: "executed", action: { kind: "click", effect: "read", summary: "查看记录" } }], expected: false },
    { name: "verified submission", receipts: [{ status: "executed", verifiedAt: at }], expected: false },
    { name: "reconciled submission", receipts: [{ status: "uncertain", reconciliation: { outcome: "completed", evidence: "服务器回执", at } }], expected: false },
    ...["uncertain", "started", "executed"].flatMap(status => [false, true].map(initial => ({ name: `${status} submit, initial flag ${initial}`, receipts: [{ status }], initial, expected: true })))
  ];
  for (const scenario of cases) {
    const f = fixture(t);
    f.task.profileId = "native:Default"; f.task.browserConnection = "extension";
    f.task.observation = { ...f.observation }; f.task.needsReconciliation = scenario.initial || false;
    f.task.receipts = scenario.receipts.map((receipt, index) => ({ id: `receipt-${index}`, at,
      action: { kind: "click", effect: "submit", summary: "发送申请" }, ...receipt }));
    const sessionId = f.task.sessionId, action = structuredClone(f.task.receipts[0]?.action);
    for (const method of ["observe", "tabs", "execute", "control"]) f.service.dependencies.browser[method] = async () => assert.fail("Idle state reconciliation must not access Chrome");
    f.service.reconcileIdleNativeProfile("native:Default");
    assert.equal(f.task.browserConnection, undefined, scenario.name);
    assert.equal(f.task.status, "paused"); assert.equal(f.task.sessionId, sessionId);
    assert.equal(f.task.observation, undefined);
    assert.equal(f.task.resumeContext.url, f.observation.url); assert.equal(f.task.resumeContext.observed, false);
    assert.equal(f.task.needsReconciliation, scenario.expected, scenario.name);
    assert.deepEqual(f.task.receipts[0]?.action, action);
    if (scenario.expected) assert.equal(f.task.receipts[0].status, "uncertain", scenario.name);
    const reloaded = new TaskStore(f.root).get(f.task.id);
    assert.equal(reloaded.needsReconciliation, scenario.expected, `${scenario.name} persisted`);
    assert.deepEqual(reloaded.receipts, f.task.receipts);
  }
});

test("ordinary business completion still requires real evidence", async t => {
  const f = fixture(t), run = f.run(); f.task.observation = undefined;
  const result = await f.service.handleTool(f.task, run, "finish", { status: "completed", summary: "Sent", evidence: [], remaining: [] });
  assert.equal(result.isError, true);
  assert.equal(f.task.status, "running");
  const malformed = await f.service.handleTool(f.task, run, "finish", { status: "completed", summary: "Sent", evidence: [{ quote: "sensitive page content".repeat(1000) }], remaining: [] });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /字符串数组/);
  assert.ok(malformed.content[0].text.length < 350);
  assert.equal(malformed.content[0].text.includes("sensitive page content"), false);
  assert.equal(f.task.status, "running");
});

test("worker prompt reflects native full access, explicit restrictions and pure-answer completion", async t => {
  const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
  const full = await sdkWorker({ task: f.task, settings: f.store.data.settings, apiKey: "key", cwd: f.root }, []);
  assert.match(full.options.systemPrompt, /无需额外逐次浏览器确认/);
  assert.doesNotMatch(full.options.systemPrompt, /支付交由用户完成/);
  assert.match(full.options.systemPrompt, /responseOnly=true/);
  assert.match(full.options.systemPrompt, /不要为纯问答制造证据/);
  f.task.nativeAccess = { confirmActions: true };
  const confirmed = await sdkWorker({ task: f.task, settings: f.store.data.settings, apiKey: "key", cwd: f.root }, []);
  assert.match(confirmed.options.systemPrompt, /当前启用操作确认/);
  f.task.mode = "plan";
  const plan = await sdkWorker({ task: f.task, settings: f.store.data.settings, apiKey: "key", cwd: f.root }, []);
  assert.match(plan.options.systemPrompt, /当前为 plan 模式/);
  const connection = await sdkWorker({ task: {}, settings: f.store.data.settings, apiKey: "key", cwd: f.root, test: true }, []);
  assert.deepEqual(connection.options.tools, []);
});

test("native UI merges in-flight start requests, persists identity and rejects ID reuse", async t => {
  const f = fixture(t), profile = "native:Default";
  let release;
  f.service.dependencies.profileName = () => new Promise(resolve => { release = resolve; });
  const params = { prompt: "read selected text", selection: "untrusted page text", tabId: 17, requestId: "start-1" };
  const first = executeNativeUiCommand(profile, "startTask", params, f.service);
  const second = executeNativeUiCommand(profile, "startTask", params, f.service);
  await Promise.resolve(); release("Native");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.task.id, b.task.id);
  assert.equal(f.store.data.tasks.filter(task => task.profileId === profile).length, 1);
  assert.equal(f.store.get(a.task.id).nativeTarget.tabId, 17);
  assert.equal(f.store.get(a.task.id).nativeTarget.newTab, undefined);
  assert.match(a.task.prompt, /仅作为任务资料/);
  assert.equal(a.taskSessionId, f.store.get(a.task.id).sessionId);
  await assert.rejects(executeNativeUiCommand(profile, "startTask", { ...params, prompt: "changed" }, f.service), /同一个请求编号/);
  const recovered = new TaskService(new TaskStore(f.root), f.service.dependencies);
  const replay = await executeNativeUiCommand(profile, "startTask", params, recovered);
  assert.equal(replay.task.id, a.task.id);
  await recovered.close();
});

test("native UI binds task operations to the paired profile and preserves user message deduplication", async t => {
  const f = fixture(t); f.task.profileId = "native:Default";
  const profile = f.task.profileId;
  const message = { taskId: f.task.id, message: "one user message", requestId: "message-1" };
  await executeNativeUiCommand(profile, "taskMessage", message, f.service);
  await executeNativeUiCommand(profile, "taskMessage", message, f.service);
  assert.equal(f.task.events.filter(event => event.text === message.message).length, 1);
  for (const method of ["getUiState", "taskMessage"]) {
    await assert.rejects(executeNativeUiCommand("native:Other", method, method === "getUiState" ? { taskId: f.task.id } : { ...message, requestId: "foreign" }, f.service), /其他 Profile/);
  }
  const own = await executeNativeUiCommand(profile, "getUiState", { taskId: f.task.id }, f.service);
  assert.equal(own.task.id, f.task.id);
  assert.ok(own.events.some(event => event.text === message.message));
});

test("native task and profile confirmation updates inherit existing site restrictions", async t => {
  const f = fixture(t), profileId = "native:Default";
  f.store.data.nativeAccessPolicies = { [profileId]: { blockedOrigins: ["https://blocked.test"], allowedOrigins: ["https://allowed.test"] } };
  const task = f.store.create({ profileId, prompt: "restricted", nativeAccess: { confirmActions: true } }, "Native");
  assert.deepEqual(task.nativeAccess, { ...f.store.data.nativeAccessPolicies[profileId], confirmActions: true });
  task.status = "paused";
  const result = await executeNativeUiCommand(profileId, "setAccess", { confirmActions: true }, f.service);
  assert.deepEqual(result.access.blockedOrigins, ["https://blocked.test"]);
  assert.deepEqual(result.access.allowedOrigins, ["https://allowed.test"]);
  assert.equal(task.nativeAccess.confirmActions, true);
  const fork = f.service.forkConversation(task.id);
  assert.deepEqual(fork.nativeAccess, task.nativeAccess);
});

test("native UI does not treat text as an approval and taskReply is explicitly deduplicated", async t => {
  const f = fixture(t); f.task.profileId = "native:Default";
  const run = f.run();
  await f.service.handleTool(f.task, run, "export_result", { name: "approved", format: "markdown", text: "content" });
  const pending = f.task.pending; f.service.runs.clear();
  await assert.rejects(executeNativeUiCommand(f.task.profileId, "taskMessage", { taskId: f.task.id, message: "sure", requestId: "text-approval" }, f.service), /不能代替确认/);
  assert.equal(f.task.outputs, undefined);
  const request = { taskId: f.task.id, decisionId: pending.id, approved: true, requestId: "reply-1" };
  await executeNativeUiCommand(f.task.profileId, "taskReply", request, f.service);
  await executeNativeUiCommand(f.task.profileId, "taskReply", request, f.service);
  assert.equal(f.task.outputs.length, 1);
});

test("service read_page uses selected frame/range for click preflight and consecutive fills", async t => {
  for (const tool of ["browser_action", "fill_fields"]) {
    const f = fixture(t, "acceptEdits"); f.task.profileId = "native:Default";
    const scope = { frameId: "nested", offset: 80, textOffset: 8000, totalControls: 200, totalText: 24000 };
    const selected = { ...f.observation, snapshot: '- textbox "A" [ref=e81]\n- textbox "B" [ref=e82]', page: scope, fast: { document: "doc", guard: "guard", candidates: [], slice: { offset: 80 }, native: { frameId: "nested" } } };
    let cached, checks = 0;
    const read = async (_task, input) => { assert.equal(input.frameId, "nested"); cached = structuredClone(selected); return structuredClone(cached); };
    const reobserve = async task => {
      checks++; assert.equal((task.observation || cached).page.frameId, "nested");
      assert.equal((task.observation || cached).page.offset, 80);
      return structuredClone(cached);
    };
    f.service.dependencies.browser.readPage = read;
    f.service.dependencies.browser.observe = reobserve;
    f.service.dependencies.browser.observeFast = reobserve;
    const run = f.run(); await f.service.handleTool(f.task, run, "read_page", { frameId: "nested", cursor: "later-page" });
    const result = await f.service.handleTool(f.task, run, tool, tool === "browser_action"
      ? { kind: "fill", ref: "e81", version: "v1", effect: "edit", value: "first", summary: "Fill" }
      : { version: "v1", fields: [{ ref: "e81", value: "first" }, { ref: "e82", value: "second" }] });
    assert.equal(result.isError, false);
    assert.equal(f.executed.length, tool === "browser_action" ? 1 : 2);
    assert.ok(checks >= (tool === "browser_action" ? 1 : 2));
    assert.equal(f.task.observation, undefined);
  }
});

test("fill_fields ignores its own FastBrowser value updates but stops on genuine form changes", async t => {
  for (const change of ["value", "label", "role", "disabled", "options", "frame"]) {
    const f = fixture(t, "acceptEdits"), run = f.run();
    const current = { ...f.observation, page: { frameId: "child", offset: 80, textOffset: 0, totalControls: 2, totalText: 0 },
      fast: { document: "doc", guard: "guard", candidates: [
        { ref: "e81", role: "textbox", label: "Name", kind: "fill", value: "", offscreen: true },
        { ref: "e82", role: "textbox", label: "City", kind: "fill", value: "" }
      ] } };
    const snapshot = () => current.snapshot = current.fast.candidates.map(c => `- ${c.role} ${JSON.stringify(c.label)} [ref=${c.ref}] value=${JSON.stringify(c.value)}`).join("\n");
    snapshot(); f.task.observation = structuredClone(current);
    f.service.dependencies.browser.observe = async () => structuredClone(current);
    f.service.dependencies.browser.execute = async (_task, action) => {
      f.executed.push(action);
      current.fast.candidates.find(c => c.ref === action.ref).value = action.value;
      current.fast.candidates[0].offscreen = false;
      if (f.executed.length === 1) {
        if (change === "label") current.fast.candidates[1].label = "Different question";
        if (change === "role") current.fast.candidates[1].role = "button";
        if (change === "disabled") current.fast.candidates.pop();
        if (change === "options") current.fast.candidates[1].options = [{ label: "Unexpected", value: "x" }];
        if (change === "frame") current.page.frameId = "different-frame";
      }
      snapshot(); return "filled";
    };
    const result = await f.service.handleTool(f.task, run, "fill_fields", { version: "v1", fields: [{ ref: "e81", value: "Alice" }, { ref: "e82", value: "Shanghai" }] });
    const details = JSON.parse(result.content[0].text);
    assert.equal(details.filled, change === "value" ? 2 : 1, change);
    assert.equal(f.executed.length, change === "value" ? 2 : 1, change);
    if (change !== "value") assert.equal(details.stopped, true, change);
  }
});
