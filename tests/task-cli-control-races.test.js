const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../dist/main/tasks/store");
const { TaskService } = require("../dist/main/tasks/service");

// CLI and desktop requests can overlap while browser ownership is changing.
// Hold the browser return open to exercise those races without a live browser.
for (const kind of ["question", "handoff"]) {
  for (const interruption of ["cancel", "takeover"]) {
    test(`${kind} reply cannot undo a concurrent ${interruption}`, async t => {
      const f = fixture(t, kind);
      const original = f.task.pending;
      const replying = f.service.reply(f.task.id, original.id, "old reply", true);
      await f.service.control(f.task.id, interruption);
      const pending = f.task.pending;
      const status = f.task.status;
      const rejected = assert.rejects(replying, /状态已经改变/);
      f.finishReturn();
      await rejected;
      assert.equal(f.task.status, status);
      assert.equal(f.task.pending, pending);
      assert.equal(f.task.events.some(event => event.text === "old reply"), false);
      assert.equal(JSON.parse(readFileSync(f.store.file, "utf8")).tasks[0].status, status);
      if (interruption === "takeover") assert.notEqual(pending.id, original.id);
    });
  }
}

for (const interruption of ["cancel", "takeover", "pause"]) {
  test(`resume cannot undo a concurrent ${interruption}`, async t => {
    const f = fixture(t, "paused");
    const resuming = f.service.control(f.task.id, "resume", "stale continuation");
    await f.service.control(f.task.id, interruption);
    const status = f.task.status, pending = f.task.pending;
    const rejected = assert.rejects(resuming, /状态已经改变/);
    f.finishReturn();
    await rejected;
    assert.equal(f.task.status, status);
    assert.equal(f.task.pending, pending);
    assert.equal(f.task.events.some(event => event.text === "stale continuation"), false);
  });
}

test("a second browser return is rejected while the first resume is pending", async t => {
  const f = fixture(t, "paused");
  const first = f.service.control(f.task.id, "resume", "first continuation");
  await assert.rejects(f.service.control(f.task.id, "resume", "second continuation"), /正在交还浏览器/);
  assert.equal(f.resumeCalls(), 1);
  f.finishReturn();
  await first;
  assert.equal(f.task.status, "queued");
  assert.equal(f.task.events.filter(event => event.text === "first continuation").length, 1);
  assert.equal(f.task.events.some(event => event.text === "second continuation"), false);
});

for (const interruption of ["cancel", "takeover", "pause"]) {
  test(`queued delivery cannot undo a concurrent ${interruption}`, async t => {
    const f = fixture(t, "paused");
    const sending = f.service.control(f.task.id, "queue", "queued continuation", { requestId: "queue-race" });
    await f.service.control(f.task.id, interruption);
    const status = f.task.status, pending = f.task.pending;
    f.finishReturn(); await sending;
    assert.equal(f.task.status, status); assert.equal(f.task.pending, pending);
    assert.equal(f.service.queue(f.task.id)[0].message, "queued continuation");
    assert.ok(!f.task.events.some(event => event.text === "queued continuation"));
  });
}

test("steer does not resume after a newer pause during its initial handoff", async t => {
  const f = fixture(t, "paused");
  let finishHandoff, handoffs = 0;
  const handoff = new Promise(resolve => { finishHandoff = resolve; });
  f.service.dependencies.browser.control = async (_task, action) => {
    if (action === "handoff" && ++handoffs === 1) await handoff;
  };
  const steering = f.service.control(f.task.id, "steer", "obsolete steering");
  await f.service.control(f.task.id, "pause");
  const rejected = assert.rejects(steering, /状态已经改变/);
  finishHandoff(); await rejected;
  assert.equal(f.task.status, "paused");
  assert.ok(!f.task.events.some(event => event.text === "obsolete steering"));
});

for (const operation of ["reply", "resume"]) {
  test(`${operation} revalidates an attachment removed during browser return before making task runnable`, async t => {
    const f = fixture(t, operation === "reply" ? "question" : "paused");
    const file = path.join(f.store.root, "input.txt"); writeFileSync(file, "context");
    const attachment = f.service.importAttachmentPaths([file])[0];
    const options = { requestId: "removed-file", attachmentIds: [attachment.id] };
    const continuation = operation === "reply" ? f.service.reply(f.task.id, f.task.pending.id, "with file", false, "once", options) : f.service.control(f.task.id, "resume", "with file", options);
    unlinkSync(attachment.path);
    const rejected = assert.rejects(continuation, /附件不存在/); f.finishReturn(); await rejected;
    assert.equal(f.task.status, operation === "reply" ? "waiting_user" : "paused");
    assert.equal(f.task.attachments.length, 0);
    assert.ok(!f.task.events.some(event => event.text === "with file"));
  });
}

test("shutdown still flushes task state and closes browser after terminal persistence fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-close-failure-"));
  try {
    const store = new TaskStore(root); let flushed = false, browserClosed = false;
    const originalClose = store.close.bind(store); store.close = () => { flushed = true; originalClose(); };
    const service = new TaskService(store, { apiKey: () => "unused", profileName: async () => "Test", prepareProfile: async () => { throw Error("unused"); }, changed: () => {}, notify: () => {}, closeBrowser: () => { browserClosed = true; }, browser: { control: async () => {}, observe: async () => {}, execute: async () => {}, tabs: async () => [] } });
    service.terminal.close = async () => { throw Error("disk unavailable"); };
    await assert.rejects(service.close(), error => error instanceof AggregateError && error.errors.some(item => item.message === "disk unavailable"));
    assert.equal(flushed, true); assert.equal(browserClosed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const operation of ["reply", "resume"]) {
  test(`${operation} checks cancellation at the final promise boundary`, async t => {
    const f = fixture(t, operation === "reply" ? "question" : "paused");
    let finish;
    const returned = new Promise(resolve => { finish = resolve; });
    f.service.dependencies.browser.control = (_task, action) => action === "resume" ? returned : Promise.resolve();
    const continuing = operation === "reply"
      ? f.service.reply(f.task.id, f.task.pending.id, "stale reply", false)
      : f.service.control(f.task.id, "resume", "stale continuation");
    // This callback runs after returnBrowser's await, before its caller's await.
    const cancelling = returned.then(() => f.service.control(f.task.id, "cancel"));
    const rejected = assert.rejects(continuing, /状态已经改变/);
    finish();
    await Promise.all([cancelling, rejected]);
    assert.equal(f.task.status, "cancelled");
    assert.equal(f.task.events.some(event => event.text.startsWith("stale ")), false);
  });
}

for (const kind of ["question", "handoff"]) {
  test(`${kind} reply still resumes after the normal browser return callback`, async t => {
    const f = fixture(t, kind);
    const replying = f.service.reply(f.task.id, f.task.pending.id, "continue normally", true);
    f.finishReturn();
    await replying;
    assert.equal(f.task.status, "queued");
    assert.equal(f.task.pending, undefined);
    assert.equal(f.task.events.filter(event => event.text === "continue normally").length, 1);
    if (kind === "handoff") assert.equal(f.task.resumeContext.userResponse, "continue normally");
  });
}

test("shutdown prevents a pending browser return from queueing another run", async t => {
  const f = fixture(t, "handoff");
  const replying = f.service.reply(f.task.id, f.task.pending.id, "too late", true);
  await f.service.close();
  const rejected = assert.rejects(replying, /状态已经改变/);
  f.finishReturn();
  await rejected;
  assert.equal(f.task.status, "waiting_user");
  assert.equal(f.task.pending.kind, "handoff");
});

function fixture(t, state) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-cli-race-"));
  const store = new TaskStore(root);
  const task = store.create({ prompt: "check existing page", profileId: "isolated:test" }, "Test");
  task.port = 9223;
  task.status = state === "paused" ? "paused" : "waiting_user";
  if (state !== "paused") task.pending = { id: randomUUID(), kind: state, title: "Continue?", details: "Test decision", createdAt: new Date().toISOString() };
  let finishReturn, resumeCalls = 0;
  const returned = new Promise(resolve => { finishReturn = resolve; });
  const service = new TaskService(store, {
    apiKey: () => "unused",
    prepareProfile: async () => { throw new Error("This regression must not launch a browser"); },
    profileName: async () => "Test",
    changed: () => {}, notify: () => {},
    browser: {
      control: async (_task, action) => {
        if (action !== "resume") return;
        resumeCalls++;
        await returned;
        service.externalControl(task.sessionId, "agent", "active", "user-return");
      },
      observe: async () => { throw new Error("Unexpected browser observation"); },
      execute: async () => { throw new Error("Unexpected browser action"); },
      tabs: async () => []
    }
  });
  service.tick = async () => {};
  service.publish();
  t.after(async () => {
    finishReturn();
    await service.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  return { service, store, task, finishReturn, resumeCalls: () => resumeCalls };
}
