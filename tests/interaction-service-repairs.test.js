const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const output = process.env.PPILOT_BACKEND_TEST_DIST || path.resolve(__dirname, '../dist/main/tasks');
const { TaskStore } = require(path.join(output, 'store'));
const { TaskService } = require(path.join(output, 'service'));
const { TaskTerminal, terminalInvocation } = require(path.join(output, 'terminal'));
const { taskModelContext } = require(path.join(output, 'model-context'));
const { executeTaskManagementCommand, parseTaskManagementCommand } = require(path.join(output, 'management'));
const { previewTaskFile, taskMarkdown } = require(path.join(output, 'presentation'));
const { isAgentBrowserHelpInvocation, shouldCheckProfilePilotNotice } = require(path.join(output, '../agent-browser-wrapper'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-interaction-fix-'));
  const store = new TaskStore(root);
  const task = store.create({ profileId: 'isolated:test', prompt: '只回答已有内容，不要打开浏览器' }, 'Test'); task.status = 'paused';
  const service = new TaskService(store, { apiKey: () => 'fixture', profileName: async () => 'Test',
    prepareProfile: async () => { throw new Error('BROWSER_OFFLINE'); }, changed: () => {}, notify: () => {}, controlWaitMs: 1,
    browser: { control: async () => {}, observe: async () => { throw new Error('UNEXPECTED_BROWSER'); }, execute: async () => { throw new Error('UNEXPECTED_BROWSER'); }, tabs: async () => [] } });
  service.tick = async () => {};
  t.after(async () => { await service.close(); assert.ok(root.startsWith(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const run = () => { task.status = 'running'; const value = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 }; service.runs.set(task.id, value); return value; };
  return { root, store, task, service, run, command: command => executeTaskManagementCommand(parseTaskManagementCommand(command), service, async () => task.profileId) };
}

test('#51 rebuilding fork/rewind context retains user constraints older than 35 events', t => {
  const f = fixture(t); f.store.event(f.task, 'user', 'Always preserve original source files');
  for (let i = 0; i < 80; i++) f.store.event(f.task, 'assistant', `reply ${i}`);
  const branch = f.service.forkConversation(f.task.id);
  assert.ok(taskModelContext(branch).recentHistory.some(e => e.text === 'Always preserve original source files'));
  f.store.event(branch, 'user', 'discard this request');
  f.service.rewindConversation(branch.id, branch.events.at(-1).id);
  assert.ok(taskModelContext(branch).recentHistory.some(e => e.text === 'Always preserve original source files'));
  assert.ok(!taskModelContext(branch).recentHistory.some(e => e.text === 'discard this request'));
});

test('#52 revision resets clients even after the replacement history grows past the old cursor', async t => {
  const f = fixture(t); f.store.event(f.task, 'user', 'old branch');
  const first = await f.command({ action: 'task.get', id: f.task.id });
  f.service.rewindConversation(f.task.id, f.task.events.at(-1).id);
  for (let i = 0; i < 20; i++) f.store.event(f.task, 'assistant', `new ${i}`);
  const next = await f.command({ action: 'task.get', id: f.task.id, after: first.cursor, revision: first.revision });
  assert.equal(next.reset, true); assert.equal(next.revision, 1);
  assert.equal(next.events[0].text, f.task.prompt); assert.ok(!next.events.some(e => e.text === 'old branch'));
});

test('#53 an unclaimed paused route does not reserve its Profile', async t => {
  const f = fixture(t); f.task.port = 9223; f.task.browserLeaseAttempted = false;
  const second = f.store.create({ profileId: f.task.profileId, prompt: 'another turn' }, 'Test');
  const launched = []; f.service.launch = task => { launched.push(task.id); task.status = 'paused'; };
  await TaskService.prototype.tick.call(f.service);
  assert.deepEqual(launched, [second.id]);
});

test('#54 text-only starts its worker while its browser is offline; first browser tool still checks connection', async t => {
  const f = fixture(t); let started = false;
  f.service.dependencies.worker = () => { const child = new EventEmitter(); child.connected = true; child.exitCode = 0; child.send = (_value, cb) => { started = true; cb?.(); }; child.kill = () => true; return child; };
  const run = f.run(); await f.service.startRun(f.task, run);
  assert.equal(started, true); assert.equal(f.task.port, undefined);
  await assert.rejects(f.service.handleTool(f.task, run, 'observe', {}), /BROWSER_OFFLINE/);
  await f.service.endRun(f.task, run);
});

test('#55 limits can be raised in place without resetting usage or auto-running', async t => {
  const f = fixture(t); f.task.usage.actions = 200; f.task.usage.costUsd = 5;
  await f.command({ action: 'task.limits', id: f.task.id, limits: { actions: 400, budgetUsd: 10 } });
  assert.equal(f.task.limits.actions, 400); assert.equal(f.task.usage.actions, 200); assert.equal(f.task.status, 'paused');
  await f.service.control(f.task.id, 'resume', 'continue'); assert.equal(f.task.status, 'queued');
});

test('#33/#56 queue is durable, FIFO, deduplicated and removable across clients', async t => {
  const f = fixture(t); const run = f.run();
  await f.command({ action: 'task.control', id: f.task.id, control: 'queue', message: 'first', requestId: 'message-1' });
  await f.command({ action: 'task.control', id: f.task.id, control: 'queue', message: 'first', requestId: 'message-1' });
  await f.command({ action: 'task.control', id: f.task.id, control: 'queue', message: 'second', requestId: 'message-2' });
  assert.deepEqual(new TaskStore(f.root).get(f.task.id).messageQueue.map(e => e.message), ['first', 'second']);
  await f.command({ action: 'task.queue', id: f.task.id, removeId: 'message-2' });
  f.task.status = 'completed'; await f.service.endRun(f.task, run);
  await f.service.drainQueue(f.task);
  assert.equal(f.task.status, 'queued'); assert.deepEqual(f.service.queue(f.task.id), []);
  assert.equal(f.task.events.filter(e => e.text === 'first').length, 1);
  assert.throws(() => f.service.queue(f.task.id, 'message-1'), /已被交付或移除/);
});

test('#58 questions cannot be bypassed with generic resume', async t => {
  const f = fixture(t); f.task.status = 'waiting_user';
  f.task.pending = { id: randomUUID(), kind: 'question', title: 'Which?', details: '', createdAt: new Date().toISOString() };
  await assert.rejects(f.service.control(f.task.id, 'resume', 'generic'), /回答当前问题/);
  assert.equal(f.task.pending.kind, 'question'); assert.ok(!f.task.events.some(e => e.text === 'generic'));
});

test('#2/#56 attachment-only followups are queued and delivered once with visible context', async t => {
  const f = fixture(t), run = f.run();
  const file = path.join(f.root, 'followup.txt'); fs.writeFileSync(file, 'new context');
  const attachment = f.service.importAttachmentPaths([file])[0];
  const options = { requestId: 'file-only', attachmentIds: [attachment.id] };
  await f.service.control(f.task.id, 'queue', '', options);
  f.task.status = 'completed'; await f.service.endRun(f.task, run); await f.service.drainQueue(f.task);
  await f.service.control(f.task.id, 'queue', '', options);
  assert.equal(f.task.attachments.length, 1);
  assert.equal(f.task.events.filter(event => event.text === '已补充附件，请结合这些文件继续当前任务。').length, 1);
  assert.equal(f.service.queue(f.task.id).length, 0);
});

test('#2/#34 question replies bind files and explicit request retries do not duplicate messages', async t => {
  const f = fixture(t); const file = path.join(f.root, 'answer.txt'); fs.writeFileSync(file, 'fixture');
  const attachment = f.service.importAttachmentPaths([file])[0];
  const decisionId = randomUUID(); f.task.status = 'waiting_user';
  f.task.pending = { id: decisionId, kind: 'question', title: 'Which?', details: '', createdAt: new Date().toISOString() };
  const command = { action: 'task.reply', id: f.task.id, decisionId, answer: 'see attached', requestId: 'reply-1', attachmentIds: [attachment.id] };
  await f.command(command); await f.command(command);
  assert.equal(f.task.attachments.length, 1); assert.equal(f.task.attachments[0].id, attachment.id);
  assert.equal(f.task.events.filter(e => e.text === 'see attached').length, 1);
});

test('#59 a worker which has not stopped produces a real failed send and preserves the message for retry', async t => {
  const f = fixture(t), run = f.run();
  await assert.rejects(f.service.control(f.task.id, 'steer', 'new direction', { requestId: 'steer-1' }), /尚未发送/);
  assert.equal(f.task.events.some(e => e.text === 'new direction'), false); assert.equal(f.task.status, 'paused');
  await f.service.endRun(f.task, run);
  await f.service.control(f.task.id, 'steer', 'new direction', { requestId: 'steer-1' });
  assert.equal(f.task.events.filter(e => e.text === 'new direction').length, 1);
});

test('#60 failed browser return and repeated successful requests append exactly one message', async t => {
  const f = fixture(t); f.task.port = 9223; f.task.browserLeaseAttempted = true;
  f.service.dependencies.browser.control = async (_task, action) => { if (action === 'resume') throw new Error('return failed'); };
  await assert.rejects(f.service.control(f.task.id, 'resume', 'continue here', { requestId: 'resume-1' }), /return failed/);
  assert.ok(!f.task.events.some(e => e.text === 'continue here'));
  f.service.dependencies.browser.control = async () => {};
  await f.service.control(f.task.id, 'resume', 'continue here', { requestId: 'resume-1' });
  await f.service.control(f.task.id, 'resume', 'continue here', { requestId: 'resume-1' });
  assert.equal(f.task.events.filter(e => e.text === 'continue here').length, 1);
});

test('#61 desktop snapshots expose transient streams without saving them to task history', t => {
  const f = fixture(t); f.service.streams.set(f.task.id, { id: 'stream', text: 'partial answer', updatedAt: new Date().toISOString() });
  assert.equal(f.service.snapshot().streams[f.task.id].text, 'partial answer');
  f.service.publish(); assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).streams, undefined);
});

for (const operation of ['resume', 'reply']) {
  test(`#60 ${operation} save failure rolls back acceptance; retry persists exactly one message`, async t => {
    const f = fixture(t);
    if (operation === 'reply') { f.task.status = 'waiting_user'; f.task.pending = { id: randomUUID(), kind: 'question', title: 'Which?', details: '', createdAt: new Date().toISOString() }; }
    const decisionId = f.task.pending?.id, options = { requestId: 'disk-retry' };
    const send = () => operation === 'resume' ? f.service.control(f.task.id, 'resume', 'persist me', options) : f.service.reply(f.task.id, decisionId, 'persist me', false, 'once', options);
    const save = f.store.save.bind(f.store); f.store.save = () => { throw Error('DISK_FULL'); };
    await assert.rejects(send(), /DISK_FULL/);
    assert.equal(f.task.status, operation === 'resume' ? 'paused' : 'waiting_user');
    assert.ok(!f.task.messageReceipts?.length); assert.ok(!f.task.events.some(event => event.text === 'persist me'));
    f.store.save = save; await send(); await send();
    const saved = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).tasks[0];
    assert.equal(saved.events.filter(event => event.text === 'persist me').length, 1);
    assert.equal(saved.messageReceipts.length, 1);
  });
}

test('#57 approval is durable before a terminal process starts', async t => {
  const f = fixture(t); f.task.status = 'waiting_user'; f.task.mode = 'manual';
  f.task.pending = { id: randomUUID(), kind: 'confirmation', title: 'Run?', details: '', createdAt: new Date().toISOString(), terminal: { runtime: 'node', command: 'console.log(1)', summary: 'test' }, permissionScope: { kind: 'terminal', scope: 'fixture', label: 'Fixture command' } };
  f.service.terminal.run = async () => {
    const saved = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).tasks[0];
    assert.equal(saved.pending, undefined); assert.equal(saved.usage.actions, 1); assert.equal(saved.permissionRules.length, 1);
    assert.equal(saved.messageReceipts[0].id, 'approval-save'); assert.ok(saved.events.some(event => event.text === '确认执行'));
    return { status: 'succeeded', stdout: '', stderr: '' };
  };
  await f.service.reply(f.task.id, f.task.pending.id, '', true, 'session', { requestId: 'approval-save' });
});

test('#62 subcommand help is local but JS text, option values and -- operands never bypass Gateway checks', () => {
  assert.equal(isAgentBrowserHelpInvocation(['--cdp', '61589', 'eval', '--help']), true);
  assert.equal(shouldCheckProfilePilotNotice(['--cdp', '61589', 'eval', '--help']), false);
  for (const args of [['eval', '"--help"'], ['eval', '--', '--help'], ['--output', '--help', 'snapshot']]) {
    assert.equal(isAgentBrowserHelpInvocation(args), false); assert.equal(shouldCheckProfilePilotNotice(args), true);
  }
});

test('#64 retention does not silently delete conversation history or output files', async t => {
  const f = fixture(t); f.task.status = 'completed'; f.task.updatedAt = '2000-01-01T00:00:00Z';
  const file = path.join(f.root, 'kept.txt'); fs.writeFileSync(file, 'Keep me');
  f.task.outputs = [{ id: randomUUID(), path: file, name: 'kept.txt', size: 7 }];
  await TaskService.prototype.tick.call(f.service);
  assert.equal(f.store.data.tasks.length, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'Keep me');
});

test('#66 terminal history survives restart and does not claim interrupted processes are stopped', async t => {
  const f = fixture(t);
  const result = await f.service.terminal.run(f.task.id, { runtime: 'node', command: 'console.log("保存输出")', summary: 'local fixture', yield_ms: 1000 });
  assert.equal(result.status, 'succeeded');
  const restored = new TaskTerminal(f.root); assert.match(restored.list(f.task.id)[0].stdout, /保存输出/);
  await restored.close();
  const records = JSON.parse(fs.readFileSync(path.join(f.root, 'terminal-history.json'), 'utf8')); records[0].status = 'running';
  fs.writeFileSync(path.join(f.root, 'terminal-history.json'), JSON.stringify(records));
  const interrupted = new TaskTerminal(f.root); const history = await interrupted.read(f.task.id, { process_id: result.process_id });
  assert.equal(history.status, 'interrupted'); assert.match(history.stderr, /不表示进程已停止/); await interrupted.close();
  assert.match(terminalInvocation('darwin', 'shell', '/tmp/task.sh', 'echo hello').executable, /bash/);
  assert.match(terminalInvocation('win32', 'shell', 'C:\\tmp\\task.ps1', 'Write-Output hello').source, /UTF8Encoding/);
});

test('#18 result preview is inert text and readable export omits SDK and credentials', async t => {
  const f = fixture(t); const file = path.join(f.root, 'report.html'); fs.writeFileSync(file, '<script>danger()</script>');
  const preview = await previewTaskFile({ id: randomUUID(), name: 'report.html', path: file, size: 25 });
  assert.equal(preview.mime, 'text/plain'); assert.equal(preview.dataUrl, undefined);
  f.task.sdkSessionId = 'SECRET_SESSION'; const markdown = taskMarkdown(f.task);
  assert.match(markdown, /只回答已有内容/); assert.doesNotMatch(markdown, /SECRET_SESSION/);
});
