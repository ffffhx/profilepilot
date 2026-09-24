const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-task-organization-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  const store = new TaskStore(root);
  let broadcasts = 0;
  const service = new TaskService(store, { changed: () => broadcasts++, apiKey: () => '', notify: () => {}, browser: {} });
  const create = prompt => {
    const task = store.create({ prompt, profileId: 'isolated:fixture' }, 'Test');
    task.status = 'completed'; task.result = { summary: 'Preserved result', evidence: ['Saved page'], remaining: [] };
    return task;
  };
  return { root, store, service, create, broadcasts: () => broadcasts };
}

test('pin, rename, archive and restore persist without changing execution history', async t => {
  const f = fixture(t), task = f.create('Original task');
  const original = structuredClone(task);
  await f.service.updateTaskMetadata(task.id, { pinned: true, title: '  Renamed task  ' });
  assert.equal(task.title, 'Renamed task'); assert.ok(task.pinnedAt);
  let reloaded = new TaskStore(f.root).get(task.id);
  assert.equal(reloaded.pinnedAt, task.pinnedAt);
  assert.equal(reloaded.title, 'Renamed task');
  await f.service.updateTaskMetadata(task.id, { archived: true });
  assert.ok(task.archivedAt); assert.equal(task.pinnedAt, undefined);
  reloaded = new TaskStore(f.root).get(task.id);
  assert.equal(reloaded.archivedAt, task.archivedAt);
  await assert.rejects(f.service.updateTaskMetadata(task.id, { pinned: true }), /先移出归档/);
  await f.service.updateTaskMetadata(task.id, { archived: false });
  assert.equal(new TaskStore(f.root).get(task.id).archivedAt, undefined);
  for (const key of ['updatedAt', 'prompt', 'events', 'receipts', 'result', 'usage', 'sessionId', 'status']) assert.deepEqual(task[key], original[key], key);
  assert.equal(f.broadcasts(), 3);
});

test('invalid metadata is rejected before stopping or renaming a task', async t => {
  const f = fixture(t), task = f.create('Original');
  task.status = 'queued';
  for (const patch of [{}, { title: ' ' }, { title: 'x'.repeat(121) }, { pinned: 'true' }, { status: 'running' }, { archived: true, pinned: true }]) {
    await assert.rejects(f.service.updateTaskMetadata(task.id, patch));
  }
  assert.equal(f.broadcasts(), 0); assert.equal(task.title, 'Original');
  assert.equal(task.status, 'queued'); assert.equal(task.archivedAt, undefined);
  await assert.rejects(f.service.updateTaskMetadata('missing', { pinned: true }), /不存在/);
});

test('queued, paused and waiting tasks stop before archiving; restoring never restarts them', async t => {
  const f = fixture(t), other = f.create('Unaffected');
  f.service.tick = async () => {};
  const controls = [];
  f.service.dependencies.browser.control = async (task, action) => controls.push([task.id, action]);
  for (const status of ['queued', 'paused', 'waiting_user']) {
    const task = f.create(status), result = structuredClone(task.result);
    task.status = status;
    if (status !== 'queued') task.browserConnection = 'extension';
    await f.service.updateTaskMetadata(task.id, { archived: true });
    assert.equal(task.status, 'cancelled'); assert.ok(task.archivedAt);
    assert.deepEqual(task.result, result);
    assert.equal(new TaskStore(f.root).get(task.id).archivedAt, task.archivedAt);
    await f.service.updateTaskMetadata(task.id, { archived: false });
    assert.equal(task.status, 'cancelled'); assert.equal(task.archivedAt, undefined);
    assert.equal(controls.some(([id]) => id === task.id), status !== 'queued');
  }
  assert.equal(other.status, 'completed'); assert.equal(other.archivedAt, undefined);
});

test('archiving drains the live worker and current action, and blocks concurrent changes', async t => {
  const { EventEmitter } = require('node:events');
  const f = fixture(t), task = f.create('Running');
  const child = new EventEmitter();
  child.connected = true; child.exitCode = null; child.signalCode = null;
  let stopped = false, finishAction;
  child.send = message => { if (message.kind === 'stop') stopped = true; };
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  Object.assign(f.service.dependencies, { apiKey: () => 'fixture', prepareProfile: async () => ({ name: 'Fixture', port: 9223 }), worker: () => child });
  const controls = [];
  f.service.dependencies.browser.control = async (_, action) => controls.push(action);
  task.status = 'queued';
  await f.service.tick(); await f.service.runs.get(task.id).starting;
  const run = f.service.runs.get(task.id);
  run.chain = new Promise(resolve => { finishAction = resolve; });
  try {
    const archive = f.service.updateTaskMetadata(task.id, { archived: true });
    assert.ok(stopped); assert.equal(task.status, 'cancelled'); assert.equal(task.archivedAt, undefined);
    await assert.rejects(f.service.control(task.id, 'resume'), /正在停止并归档/);
    await assert.rejects(f.service.updateTaskMetadata(task.id, { archived: false }), /正在停止并归档/);
    assert.throws(() => f.service.deleteTask(task.id), /正在停止并归档/);
    child.emit('error', new Error('Worker exited while stopping'));
    child.kill();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.status, 'cancelled'); assert.equal(task.archivedAt, undefined);
    finishAction(); await archive;
    assert.ok(task.archivedAt); assert.equal(f.service.runs.has(task.id), false);
    assert.deepEqual(controls, ['release']);
    assert.equal(task.result.summary, 'Preserved result');
  } finally { finishAction(); child.kill(); await f.service.close(); }
});

test('archiving during browser preparation waits and never starts a worker', async t => {
  const f = fixture(t), task = f.create('Preparing');
  let prepared;
  Object.assign(f.service.dependencies, { apiKey: () => 'fixture', prepareProfile: () => new Promise(resolve => { prepared = resolve; }), worker: () => assert.fail('Must not start a worker') });
  task.status = 'queued';
  await f.service.tick();
  const archive = f.service.updateTaskMetadata(task.id, { archived: true });
  assert.equal(task.status, 'cancelled'); assert.equal(task.archivedAt, undefined);
  prepared({ name: 'Fixture', port: 9223 }); await archive;
  assert.ok(task.archivedAt); assert.equal(f.service.runs.size, 0);
});

test('failed browser release leaves the stopped task visible and can be retried', async t => {
  const f = fixture(t), task = f.create('Waiting');
  f.service.tick = async () => {};
  task.status = 'waiting_user'; task.browserConnection = 'extension';
  f.service.dependencies.browser.control = async () => { throw Error('Release failed'); };
  await assert.rejects(f.service.updateTaskMetadata(task.id, { archived: true }), /Release failed/);
  assert.equal(task.status, 'cancelled'); assert.equal(task.archivedAt, undefined);
  assert.equal(new TaskStore(f.root).get(task.id).browserReleasePending, true);
  let released = false;
  f.service.dependencies.browser.control = async (_, action) => { assert.equal(action, 'release'); released = true; };
  await f.service.updateTaskMetadata(task.id, { archived: true });
  assert.ok(released); assert.ok(task.archivedAt); assert.equal(task.browserReleasePending, undefined);
});

test('archiving a previously cancelled task never touches a browser reused by another task', async t => {
  const f = fixture(t), task = f.create('Cancelled');
  task.status = 'cancelled'; task.port = 9223;
  f.service.dependencies.browser.control = async () => assert.fail('Historical task must not touch the browser');
  await f.service.updateTaskMetadata(task.id, { archived: true });
  assert.ok(task.archivedAt);
});

test('archiving waits for an in-flight user reply or browser return before changing task state', async t => {
  const f = fixture(t), task = f.create('Waiting'); task.status = 'waiting_user';
  for (const pending of [f.service.decisionsInFlight, f.service.returning]) {
    pending.add(task.id);
    await assert.rejects(f.service.updateTaskMetadata(task.id, { archived: true }), /稍后归档/);
    assert.equal(task.status, 'waiting_user'); assert.equal(task.archivedAt, undefined);
    pending.delete(task.id);
  }
});

test('retention preserves pinned and archived tasks and gives restored tasks a fresh retention period', async t => {
  const f = fixture(t);
  const pinned = f.create('Pinned'), archived = f.create('Archived'), expired = f.create('Expired');
  const old = '2000-01-01T00:00:00.000Z';
  for (const task of [pinned, archived, expired]) task.updatedAt = old;
  await f.service.updateTaskMetadata(pinned.id, { pinned: true });
  await f.service.updateTaskMetadata(archived.id, { archived: true });
  await f.service.tick();
  assert.deepEqual(f.store.data.tasks.map(task => task.id).sort(), [pinned.id, archived.id].sort());
  await f.service.updateTaskMetadata(pinned.id, { pinned: false });
  await f.service.updateTaskMetadata(archived.id, { archived: false });
  f.service.lastCleanup = 0;
  await f.service.tick();
  assert.equal(f.store.data.tasks.length, 2);
  assert.equal(archived.updatedAt, old);
});

test('continuing an archived task restores its sidebar visibility only after validation succeeds', async t => {
  const f = fixture(t), task = f.create('Archived');
  f.service.tick = async () => {};
  await f.service.updateTaskMetadata(task.id, { archived: true });
  task.usage.actions = task.limits.actions;
  await assert.rejects(f.service.control(task.id, 'resume'), /运行限制/);
  assert.ok(task.archivedAt);
  task.usage.actions = 0;
  await f.service.control(task.id, 'resume');
  assert.equal(task.archivedAt, undefined); assert.equal(task.status, 'queued');
  assert.equal(f.store.data.tasks.length, 1);
});
