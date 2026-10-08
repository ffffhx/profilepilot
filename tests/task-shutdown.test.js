const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// Current source, bundled only in memory: never overwrite another Agent's dist.
const repo = path.resolve(__dirname, '..');
const compiled = buildSync({
  stdin: { contents: 'export { TaskService } from "./src/main/tasks/service"; export { TaskStore } from "./src/main/tasks/store";', resolveDir: repo, loader: 'ts' },
  bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent'
});
const loaded = new Module(path.join(__dirname, 'task-shutdown-bundle.cjs'), module);
loaded.filename = loaded.id; loaded.paths = Module._nodeModulePaths(repo);
loaded._compile(compiled.outputFiles[0].text, loaded.filename);
const { TaskService, TaskStore } = loaded.exports;
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shutdown-'));
  const store = new TaskStore(root);
  const task = store.create({ prompt: 'Synthetic shutdown audit', profileId: 'isolated:test' }, 'Fixture');
  const calls = [];
  const browser = { control: async (_task, action) => { calls.push(action); }, execute: async () => { calls.push('execute'); }, observe: async () => { calls.push('observe'); } };
  const service = new TaskService(store, { browser, apiKey: () => '', prepareProfile: async () => ({ port: 9223, name: 'Fixture' }), profileName: async () => 'Fixture', changed: () => {}, notify: () => {} });
  const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 };
  task.status = 'running'; task.port = 9223; service.runs.set(task.id, run);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, store, task, run, calls, browser, read: () => JSON.parse(fs.readFileSync(store.file, 'utf8')).tasks.find(saved => saved.id === task.id) };
}

test('a stuck terminal cannot delay saving paused/uncertain tasks or starting browser handoff', async t => {
  const f = fixture(t), terminal = deferred();
  f.task.receipts.push({ id: 'in-flight', at: new Date().toISOString(), status: 'started', action: { kind: 'click', effect: 'submit', ref: 'e1', summary: 'Synthetic submission' } });
  f.service.terminal.close = () => terminal.promise;
  let settled = false;
  const closing = f.service.close().then(() => settled = true);
  try {
    await flush();
    assert.equal(settled, false);
    assert.equal(f.run.stopped, true);
    assert.equal(f.read().status, 'paused');
    assert.equal(f.read().receipts[0].status, 'uncertain');
    assert.equal(f.read().needsReconciliation, true);
    assert.deepEqual(f.calls, ['handoff']);
    await assert.rejects(f.service.handleTool(f.task, f.run, 'observe', {}), /停止|等待/);
    await assert.rejects(f.service.control(f.task.id, 'resume'), /退出/);
    assert.deepEqual(f.calls, ['handoff'], 'stopped worker and user continuation cannot send new actions');
  } finally { terminal.resolve(); await closing; }
});

test('idle confirmation is durably invalidated before a pending terminal shutdown', async t => {
  const f = fixture(t), terminal = deferred();
  f.service.runs.clear(); f.task.status = 'waiting_user';
  f.task.pending = { id: 'confirmation', kind: 'confirmation', title: 'Synthetic save', details: '', createdAt: new Date().toISOString() };
  f.service.terminal.close = () => terminal.promise;
  const closing = f.service.close();
  try {
    await flush();
    assert.equal(f.read().pending, undefined);
    assert.equal(f.read().status, 'paused');
    assert.deepEqual(f.calls, ['handoff']);
  } finally { terminal.resolve(); await closing; }
});

test('handoff failures are persisted and reported even while terminal cleanup is pending', async t => {
  const f = fixture(t), terminal = deferred();
  f.browser.control = async () => { throw Error('synthetic handoff failure'); };
  f.service.terminal.close = () => terminal.promise;
  const closing = f.service.close();
  try {
    await flush();
    assert.ok(f.read().events.some(event => event.text.includes('synthetic handoff failure')));
  } finally {
    terminal.resolve();
    await assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(item => item.message === 'synthetic handoff failure'));
    // Test cleanup should not rethrow the deliberately injected failure.
    f.service.close = async () => {};
  }
});

test('a scheduler already awaiting when shutdown starts cannot launch another worker', async t => {
  const f = fixture(t), scheduling = deferred();
  f.service.runs.clear(); f.task.status = 'queued'; f.task.port = undefined;
  f.service.scheduleDue = () => scheduling.promise;
  const ticking = f.service.tick();
  await f.service.close();
  scheduling.resolve(); await ticking;
  assert.equal(f.task.status, 'queued');
  assert.equal(f.service.runs.size, 0);
  assert.deepEqual(f.calls, []);
});
