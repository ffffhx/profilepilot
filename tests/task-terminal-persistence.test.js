const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

// Compile only in memory. No application launch or shared dist/ writes.
const repo = path.resolve(__dirname, '..');
const output = esbuild.buildSync({ entryPoints: [path.join(repo, 'src/main/tasks/terminal.ts')], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', packages: 'external', write: false, logLevel: 'silent' });
const loaded = new Module(path.join(__dirname, 'terminal-persistence-bundle.cjs'), module);
loaded.filename = loaded.id; loaded.paths = Module._nodeModulePaths(repo);
loaded._compile(output.outputFiles[0].text, loaded.filename);
const { TaskTerminal } = loaded.exports;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (terminal, command, options = {}) => terminal.run('test-task', {
  runtime: 'node', command, summary: '隔离终端持久化验收', yield_ms: 10000, ...options,
});

function fixture(t, changed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-terminal-save-'));
  const terminal = new TaskTerminal(root, changed);
  const history = path.join(root, 'terminal-history.json');
  const reported = t.mock.method(console, 'error', () => {});
  t.after(async () => {
    // Restore I/O/stop injection before closing real isolated test children.
    t.mock.restoreAll();
    try { await terminal.close(); } catch { /* notification-failure case remains reportable */ }
    assert.equal(terminal.hasRunning('test-task'), false, 'never leave a test process running');
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pp-terminal-save-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, terminal, history, reported,
    tempFiles: () => fs.readdirSync(root).filter(name => name.endsWith('.tmp')),
    read: () => JSON.parse(fs.readFileSync(history, 'utf8')) };
}

async function until(check, message) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), message);
}

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`startup ${operation} failure keeps listeners installed, stops the real child and preserves old history`, async t => {
    const f = fixture(t);
    await run(f.terminal, "console.log('previous history')");
    const oldBytes = fs.readFileSync(f.history);
    const spawn = cp.spawn, original = fs[operation];
    let child;
    t.mock.method(cp, 'spawn', (...args) => { child = spawn(...args); return child; });
    const failure = t.mock.method(fs, operation, (...args) => {
      const isHistory = operation === 'renameSync' ? args[1] === f.history : typeof args[0] === 'number';
      if (!isHistory) return original(...args);
      assert.ok(child.listenerCount('error') > 0);
      assert.ok(child.listenerCount('close') > 0);
      assert.ok(child.stdout.listenerCount('data') > 0);
      assert.ok(child.stderr.listenerCount('data') > 0);
      if (operation === 'writeFileSync') original(args[0], '{partial');
      throw new Error(`simulated ${operation} failure`);
    });
    await assert.rejects(run(f.terminal, 'setInterval(() => {}, 1000)', { yield_ms: 0 }), /启动记录保存失败.*核查副作用/);
    assert.ok(child.pid, 'this test actually launched an isolated Node child');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child really exited');
    assert.equal(f.terminal.hasRunning('test-task'), false);
    assert.equal(f.terminal.list('test-task').at(-1).status, 'stopped');
    assert.match(f.terminal.list('test-task').at(-1).stderr, /命令可能已经执行/);
    assert.deepEqual(fs.readFileSync(f.history), oldBytes);
    assert.deepEqual(f.tempFiles(), []);
    failure.mock.restore(); await f.terminal.close();
    assert.equal(f.read().at(-1).status, 'stopped');
    assert.equal(f.terminal.persistenceError, undefined);
  });
}

test('async output persistence failure is observable, never uncaught, and close stops the child before reporting it', async t => {
  const f = fixture(t);
  const result = await run(f.terminal, "setTimeout(() => console.log('未落盘输出'), 150); setInterval(() => {}, 1000)", { background: true, yield_ms: 0 });
  const oldBytes = fs.readFileSync(f.history), rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.history) throw new Error('simulated sharing violation');
    return rename(from, to);
  });
  await until(() => f.terminal.persistenceError, 'the real output timer attempted to persist');
  const current = await f.terminal.read('test-task', { process_id: result.process_id, wait_ms: 0 });
  assert.match(current.stdout, /未落盘输出/);
  assert.match(current.persistenceError, /终端历史保存失败.*sharing violation/);
  assert.equal(current.stderr, '', 'storage diagnostics do not masquerade as command stderr');
  assert.equal(f.reported.mock.callCount(), 1);
  await assert.rejects(f.terminal.close(), error => error instanceof AggregateError && /终端历史保存失败/.test(error.message));
  assert.equal(f.terminal.hasRunning('test-task'), false);
  assert.deepEqual(fs.readFileSync(f.history), oldBytes);
  assert.deepEqual(f.tempFiles(), []);
  failure.mock.restore(); await f.terminal.close();
  assert.equal(f.terminal.persistenceError, undefined);
  const reopened = new TaskTerminal(f.root);
  assert.match(reopened.list('test-task')[0].stdout, /未落盘输出/);
  assert.equal(reopened.list('test-task')[0].status, 'stopped');
  assert.equal(reopened.list('test-task')[0].persistenceError, undefined);
  await reopened.close();
});

test('close-event write failure cannot escape the event callback or suppress the result notification', async t => {
  const notices = [];
  const f = fixture(t, (_task, result) => notices.push(result));
  const rename = fs.renameSync;
  let commits = 0;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.history && commits++ >= 1) throw new Error('close-event disk failure');
    return rename(from, to);
  });
  const result = await run(f.terminal, "console.log('process completed')");
  assert.equal(result.status, 'succeeded');
  assert.match(result.persistenceError, /close-event disk failure/);
  assert.equal(notices.length, 1);
  assert.match(notices[0].persistenceError, /close-event disk failure/);
  assert.deepEqual(f.tempFiles(), []);
  await assert.rejects(f.terminal.close(), /终端关闭未完全成功/);
  failure.mock.restore(); await f.terminal.close();
  assert.equal(f.read()[0].status, 'succeeded');
});

test('a throwing service notification is contained and reported by final close', async t => {
  const f = fixture(t, () => { throw new Error('tasks.json is not writable'); });
  const result = await run(f.terminal, "console.log('finished')");
  assert.equal(result.status, 'succeeded');
  assert.equal(f.read()[0].status, 'succeeded');
  assert.match(f.reported.mock.calls[0].arguments[0], /终端结束通知失败/);
  await assert.rejects(f.terminal.close(), /终端结束通知失败.*tasks.json/);
});

test('close attempts every stop and still saves other final states if one stop fails', async t => {
  const f = fixture(t);
  const first = await run(f.terminal, 'setInterval(() => {}, 1000)', { background: true, yield_ms: 0 });
  const second = await run(f.terminal, 'setInterval(() => {}, 1000)', { background: true, yield_ms: 0 });
  const stop = f.terminal.stopJob.bind(f.terminal);
  const injected = t.mock.method(f.terminal, 'stopJob', job => {
    if (job.process_id === first.process_id) return Promise.reject(new Error('simulated stop denied'));
    return stop(job);
  });
  await assert.rejects(f.terminal.close(), /stop denied/);
  assert.equal(f.read().find(job => job.process_id === second.process_id).status, 'stopped');
  assert.equal(f.terminal.hasRunning('test-task'), true, 'the failed stop is not falsely reported as finished');
  injected.mock.restore(); await f.terminal.close();
  assert.equal(f.terminal.hasRunning('test-task'), false);
  assert.ok(f.read().every(job => job.status === 'stopped'));
});

test('failed startup cleanup reports both failures and retains ownership for a later stop', async t => {
  const f = fixture(t);
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('initial history failure'); });
  const stop = t.mock.method(f.terminal, 'stopJob', () => Promise.reject(new Error('stop denied')));
  await assert.rejects(run(f.terminal, 'setInterval(() => {}, 1000)', { background: true, yield_ms: 0 }), error =>
    error instanceof AggregateError && error.errors.length === 2 && /无法确认进程已停止/.test(error.message));
  assert.equal(f.terminal.hasRunning('test-task'), true);
  assert.equal(f.terminal.list('test-task').length, 1);
  assert.deepEqual(f.tempFiles(), []);
  failure.mock.restore(); stop.mock.restore();
  await f.terminal.close();
  assert.equal(f.terminal.hasRunning('test-task'), false);
});

test('failed deletion keeps the in-memory terminal history available for retry', async t => {
  const f = fixture(t);
  const result = await run(f.terminal, "console.log('keep this record')");
  const oldBytes = fs.readFileSync(f.history);
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('deletion save failed'); });
  assert.throws(() => f.terminal.forgetTask('test-task'), /deletion save failed/);
  assert.equal(f.terminal.list('test-task')[0].process_id, result.process_id);
  assert.match(f.terminal.list('test-task')[0].stdout, /keep this record/);
  assert.deepEqual(fs.readFileSync(f.history), oldBytes);
  assert.deepEqual(f.tempFiles(), []);
  failure.mock.restore(); f.terminal.forgetTask('test-task');
  assert.deepEqual(f.terminal.list('test-task'), []);
  assert.deepEqual(f.read(), []);
});

test('constructor migration write failure keeps the exact previous history and cleans its temp file', async t => {
  const f = fixture(t);
  await run(f.terminal, "console.log('persisted history')");
  const oldBytes = fs.readFileSync(f.history);
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('startup migration failed'); });
  assert.throws(() => new TaskTerminal(f.root), /startup migration failed/);
  assert.deepEqual(fs.readFileSync(f.history), oldBytes);
  assert.deepEqual(f.tempFiles(), []);
  failure.mock.restore();
});
