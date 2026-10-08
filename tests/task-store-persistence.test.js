const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const esbuild = require('esbuild');

// Exercise today's TypeScript without overwriting the shared dist/ tree.
const repo = path.resolve(__dirname, '..');
const compiled = esbuild.buildSync({
  stdin: { contents: 'export { TaskStore } from "./src/main/tasks/store"; export { updateTokenRecords } from "./src/shared/task-token-usage";', resolveDir: repo, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', write: false, logLevel: 'silent',
});
const loaded = new Module(path.join(__dirname, 'task-store-test-bundle.cjs'), module);
loaded.filename = loaded.id;
loaded.paths = Module._nodeModulePaths(repo);
loaded._compile(compiled.outputFiles[0].text, loaded.filename);
const { TaskStore, updateTokenRecords } = loaded.exports;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-store-历史 '));
  const store = new TaskStore(root);
  const task = store.create({ prompt: '保留消息、核查回执，不重复执行。', profileId: 'fixture-profile' }, '测试 Profile');
  t.after(() => {
    // Drain pending timers while mocks are still scoped to the test. No live app data.
    try { store.close(); } catch { /* failure-injection tests deliberately reject writes */ }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('pp-store-历史 '));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { store, task, read: () => JSON.parse(fs.readFileSync(store.file, 'utf8')) };
}

function committedWrites(t, file) {
  const original = fs.renameSync;
  const writes = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = original(from, to);
    if (to === file) writes.push(JSON.parse(fs.readFileSync(to, 'utf8')));
    return result;
  });
  return writes;
}

test('critical receipts and user messages are flushed synchronously, including pending metadata', t => {
  const { store, task, read } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = committedWrites(t, store.file);
  task.execution = { engine: 'model', activity: '正在执行', at: task.updatedAt };
  store.scheduleSave();
  const receipt = { id: 'receipt-1', at: task.updatedAt, status: 'started', action: { kind: 'click', ref: 'submit', effect: 'submit', summary: '提交一次' } };
  task.receipts.push(receipt);
  store.event(task, 'user', '补充消息必须先存盘');
  store.save();
  assert.equal(read().tasks[0].receipts[0].status, 'started', 'the external operation may now begin');
  assert.equal(read().tasks[0].events.at(-1).text, '补充消息必须先存盘');
  assert.equal(read().tasks[0].execution.activity, '正在执行');
  receipt.status = 'executed'; receipt.result = '页面返回完成';
  store.save();
  assert.equal(read().tasks[0].receipts[0].status, 'executed');
  t.mock.timers.tick(1000);
  assert.equal(writes.length, 2, 'critical save cancels the older deferred batch');
});

test('a burst saves the latest metadata once, without sliding the first deadline', t => {
  const { store, task, read } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = committedWrites(t, store.file);
  for (let i = 1; i <= 8; i++) {
    task.execution = { engine: 'model', activity: `进度 ${i}`, at: task.updatedAt };
    store.scheduleSave();
    t.mock.timers.tick(10);
  }
  assert.equal(writes.length, 1);
  assert.equal(read().tasks[0].execution.activity, '进度 8');
  task.execution.activity = '下一批'; store.scheduleSave();
  t.mock.timers.tick(80);
  assert.equal(writes.length, 2);
  assert.equal(read().tasks[0].execution.activity, '下一批');
});

test('flush and close preserve queued messages, permissions and direct legacy mutations', t => {
  const { store, task, read } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = committedWrites(t, store.file);
  task.messageQueue = [{ id: 'queued-message', message: '稍后跟进', attachmentIds: [], createdAt: task.updatedAt }];
  task.permissionRules = [{ id: 'permission', kind: 'browser', label: '允许本会话读取', scope: 'read', createdAt: task.updatedAt }];
  store.scheduleSave(); store.flush();
  assert.equal(read().tasks[0].messageQueue[0].message, '稍后跟进');
  assert.equal(read().tasks[0].permissionRules[0].scope, 'read');
  store.event(task, 'assistant', '已经记录 🧪');
  store.close();
  assert.equal(read().tasks[0].events.at(-1).text, '已经记录 🧪');
  store.close(); t.mock.timers.tick(1000);
  assert.equal(writes.length, 2, 'close is idempotent and cancels the batch');
  const reopened = new TaskStore(store.root);
  assert.equal(reopened.get(task.id).events.at(-1).text, '已经记录 🧪');
  assert.equal(reopened.get(task.id).messageQueue[0].message, '稍后跟进');
  assert.equal(reopened.get(task.id).permissionRules.length, 1);
  reopened.close();
});

test('unchanged saves perform no disk replacement but a missing file is restored', t => {
  const { store, task, read } = fixture(t);
  const writes = committedWrites(t, store.file);
  for (let i = 0; i < 10; i++) store.save();
  assert.equal(writes.length, 0);
  fs.unlinkSync(store.file);
  store.save();
  assert.equal(writes.length, 1);
  assert.equal(read().tasks[0].id, task.id);
});

test('the complete replacement is synced before rename and remains version-1 compatible', t => {
  const { store, task, read } = fixture(t);
  const order = [];
  const sync = fs.fsyncSync, rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', descriptor => { sync(descriptor); order.push('synced'); });
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(path.dirname(from), path.dirname(to));
    assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).tasks[0].events.at(-1).text, '持久化边界');
    order.push('renamed'); rename(from, to);
  });
  store.event(task, 'assistant', '持久化边界'); store.save();
  assert.deepEqual(order, ['synced', 'renamed']);
  assert.equal(read().version, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`${operation} failure leaves the old JSON intact, cleans owned temp files and permits retry`, t => {
    const { store, task, read } = fixture(t);
    const originalBytes = fs.readFileSync(store.file);
    const expected = new Error(`${operation}: simulated disk/permission failure`);
    const injected = t.mock.method(fs, operation, () => { throw expected; });
    store.event(task, 'user', '失败后仍须保留并重试');
    assert.throws(() => store.save(), error => error === expected);
    assert.equal(store.persistenceError, expected);
    assert.deepEqual(fs.readFileSync(store.file), originalBytes);
    assert.deepEqual(fs.readdirSync(store.root), ['tasks.json']);
    injected.mock.restore();
    store.flush();
    assert.equal(store.persistenceError, undefined);
    assert.equal(read().tasks[0].events.at(-1).text, '失败后仍须保留并重试');
  });
}

test('deferred write failures are observable and a later close retries the unsaved state', t => {
  const { store, task, read } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const expected = new Error('simulated sharing violation');
  const failure = t.mock.method(fs, 'renameSync', () => { throw expected; });
  const reported = t.mock.method(console, 'error', () => {});
  task.execution = { engine: 'model', activity: '未丢失的进度', at: task.updatedAt };
  store.scheduleSave(); t.mock.timers.tick(80);
  assert.equal(store.persistenceError, expected);
  assert.equal(reported.mock.callCount(), 1);
  assert.equal(read().tasks[0].execution, undefined);
  failure.mock.restore(); store.close();
  assert.equal(read().tasks[0].execution.activity, '未丢失的进度');
  assert.equal(store.persistenceError, undefined);
});

test('serialization failure also preserves the file and recovers on flush', t => {
  const { store, task, read } = fixture(t);
  const original = fs.readFileSync(store.file);
  task.accidentalCycle = task;
  assert.throws(() => store.save(), /circular/i);
  assert.ok(store.persistenceError);
  assert.deepEqual(fs.readFileSync(store.file), original);
  delete task.accidentalCycle;
  store.event(task, 'assistant', '序列化已恢复'); store.flush();
  assert.equal(read().tasks[0].events.at(-1).text, '序列化已恢复');
  assert.equal(store.persistenceError, undefined);
});

test('reopening an interrupted action keeps its receipt and message and requires reconciliation', t => {
  const { store, task } = fixture(t);
  task.status = 'running';
  task.receipts.push({ id: 'before-send', at: task.updatedAt, status: 'started', action: { kind: 'click', ref: 'send', effect: 'send', summary: '发送消息' } });
  store.event(task, 'user', '不要重复发送'); store.save();
  const reopened = new TaskStore(store.root);
  const recovered = reopened.get(task.id);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.receipts[0].status, 'uncertain');
  assert.equal(recovered.needsReconciliation, true);
  assert.ok(recovered.events.some(event => event.text === '不要重复发送'));
  // The old process is no longer used after a crash/restart.
  store.data = reopened.snapshot();
  reopened.close();
});

test('batched persistence preserves monotonic token history after task deletion', t => {
  const { store, task, read } = fixture(t);
  task.usage.inputTokens = 250; task.usage.outputTokens = 80; store.save();
  task.usage.inputTokens = 100; store.scheduleSave(); store.flush();
  assert.equal(read().tokenRecords[0].inputTokens, 250);
  store.data.tasks = []; store.scheduleSave(); store.close();
  const reopened = new TaskStore(store.root);
  assert.equal(reopened.data.tasks.length, 0);
  assert.equal(reopened.data.tokenRecords[0].inputTokens, 250);
  assert.equal(reopened.data.tokenRecords[0].outputTokens, 80);
  reopened.close();
});

test('batch delays reject non-finite or unbounded values without losing subsequent saves', t => {
  const { store } = fixture(t);
  for (const delay of [NaN, Infinity, -1, 1001]) assert.throws(() => store.scheduleSave(delay), RangeError);
  store.scheduleSave(0); store.flush();
  assert.equal(store.persistenceError, undefined);
});

// Historical workload benchmark, not an assertion that a machine meets a speed
// threshold. The baseline reproduces the previous save algorithm (ledger + pretty
// JSON + write + rename); the new branch uses exactly the same progress updates.
test('history benchmark reports blocking and committed writes with equivalent final data', t => {
  const { store, task } = fixture(t);
  const historyTasks = 100, eventsPerTask = 160, updates = 24;
  const seed = store.snapshot();
  const message = '已核查页面与操作回执，保留上下文供后续继续。Checked the page and receipt; retain context for the next turn. '.repeat(3);
  seed.tasks = Array.from({ length: historyTasks }, (_, i) => ({
    ...structuredClone(task), id: `history-${i}`, title: `历史任务 ${i}`, status: 'completed',
    usage: { ...task.usage, inputTokens: 4000 + i, outputTokens: 800 + i },
    events: Array.from({ length: eventsPerTask }, (_, j) => ({ id: `event-${i}-${j}`, at: task.updatedAt, kind: j % 2 ? 'assistant' : 'user', text: `${message}${j}` })),
    receipts: [{ id: `receipt-${i}`, at: task.updatedAt, status: 'executed', action: { kind: 'click', effect: 'read', ref: 'row', summary: '打开记录' }, result: '可读内容' }],
  }));
  const baseline = structuredClone(seed);
  const baselineFile = path.join(store.root, 'baseline.json');
  const legacySave = () => {
    baseline.tokenRecords = updateTokenRecords(baseline.tokenRecords || [], baseline.tasks);
    const temp = `${baselineFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...baseline, version: 1 }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, baselineFile);
  };
  store.data = structuredClone(seed); store.save(); legacySave();
  const rename = fs.renameSync;
  let baselineWrites = 0, batchWrites = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === baselineFile) baselineWrites++;
    if (to === store.file) batchWrites++;
  });
  const mutate = (data, i) => { data.tasks[0].execution = { engine: 'model', activity: `更新 ${i}`, at: task.updatedAt }; };
  const baselineStalls = [];
  let started = performance.now();
  for (let i = 0; i < updates; i++) {
    const before = performance.now(); mutate(baseline, i); legacySave(); baselineStalls.push(performance.now() - before);
  }
  const baselineBlockingMs = performance.now() - started;
  const immediateStalls = [];
  started = performance.now();
  for (let i = 0; i < updates; i++) {
    const before = performance.now(); mutate(store.data, i); store.save(); immediateStalls.push(performance.now() - before);
  }
  const immediateBlockingMs = performance.now() - started;
  const immediateWrites = batchWrites;
  assert.equal(immediateWrites, updates, 'explicit critical saves never become deferred');
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), JSON.parse(fs.readFileSync(baselineFile, 'utf8')));
  // Reset outside the measured batch so both branches start with the same history.
  store.data = structuredClone(seed); store.save(); batchWrites = 0;
  started = performance.now();
  for (let i = 0; i < updates; i++) { mutate(store.data, i); store.scheduleSave(); }
  const scheduleBlockingMs = performance.now() - started;
  started = performance.now(); store.flush();
  const flushBlockingMs = performance.now() - started;
  const beforeNoop = batchWrites;
  started = performance.now(); store.save();
  const noChangeBlockingMs = performance.now() - started;
  assert.equal(batchWrites, beforeNoop);
  assert.equal(baselineWrites, updates);
  assert.equal(batchWrites, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), JSON.parse(fs.readFileSync(baselineFile, 'utf8')));
  const ms = n => Number(n.toFixed(2));
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, historyTasks, events: historyTasks * eventsPerTask, updates,
    baseline: { bytes: fs.statSync(baselineFile).size, writes: baselineWrites, synchronousBlockingMs: ms(baselineBlockingMs), maxSaveBlockingMs: ms(Math.max(...baselineStalls)) },
    immediate: { writes: immediateWrites, synchronousBlockingMs: ms(immediateBlockingMs), maxSaveBlockingMs: ms(Math.max(...immediateStalls)), includesFsync: true },
    batched: { bytes: fs.statSync(store.file).size, writes: batchWrites, scheduleBlockingMs: ms(scheduleBlockingMs), flushBlockingMs: ms(flushBlockingMs), totalBlockingMs: ms(scheduleBlockingMs + flushBlockingMs) },
    unchangedSave: { writes: 0, blockingMs: ms(noChangeBlockingMs) },
    limits: '24 replaceable progress updates in one burst; critical saves remain synchronous; serialization/digest are still O(history); no browser or macOS run',
  }));
});
