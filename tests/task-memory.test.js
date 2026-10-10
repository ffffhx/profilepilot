const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-memory-test-'));
  const store = new TaskStore(root);
  const service = new TaskService(store, { browser: {}, apiKey: () => '', changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  t.after(async () => { service.runs.clear(); await service.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, memory: service.memory };
}

test('stable Profile identity shares memory across tasks and restarts, not with another Profile', t => {
  const f = fixture(t);
  const first = f.store.create({ profileId: 'native:A', prompt: 'first' }, 'Before rename');
  const second = f.store.create({ profileId: 'native:A', prompt: 'second' }, 'After rename');
  f.service.writeMemory(first.profileId, 'MEMORY.md', 'Prefer concise Chinese.', null);
  assert.equal(f.service.getMemory(second.profileId).files[0].content, 'Prefer concise Chinese.');
  assert.equal(f.service.getMemory('native:B').files.length, 0);
  const reopened = new TaskService(new TaskStore(f.root), { browser: {}, apiKey: () => '', changed: () => {}, notify: () => {} });
  assert.equal(reopened.getMemory('native:A').files.length, 1);
});

test('native tools are confined to Markdown in the current Profile, including Windows path cases', t => {
  const f = fixture(t), base = f.memory.directory('native:A');
  f.memory.write('native:A', 'MEMORY.md', 'index', null);
  assert.equal(f.memory.authorize('native:A', path.join(base, 'MEMORY.md'), 'Read', false), true);
  assert.equal(f.memory.authorize('native:A', path.join(base, 'new.md'), 'Write', true, { content: 'note' }), true);
  for (const filename of ['../outside.md', 'nested/topic.md', 'memory.json', 'CON.md', 'MEMORY.md:secret']) {
    assert.equal(f.memory.authorize('native:A', path.resolve(base, filename), 'Write', true, { content: 'note' }), false, filename);
  }
  assert.equal(f.memory.authorize('native:A', path.join(f.memory.directory('native:B'), 'MEMORY.md'), 'Write', true, { content: 'note' }), false);
  assert.equal(f.memory.authorize('native:A', path.join(base, 'MEMORY.md'), 'Write', false, { content: 'note' }), false);
  assert.equal(f.memory.authorize('native:A', path.join(base, 'absent.md'), 'Read', false), false);
  if (process.platform === 'win32') assert.equal(f.memory.authorize('native:A', path.join(base, 'MEMORY.md').toUpperCase(), 'Read', false), true);
});

test('hardlinks and directory junctions cannot escape memory access checks', t => {
  const f = fixture(t), base = f.memory.directory('native:A');
  const outside = path.join(f.root, 'private.md'); fs.writeFileSync(outside, 'private');
  fs.linkSync(outside, path.join(base, 'linked.md'));
  assert.equal(f.memory.authorize('native:A', path.join(base, 'linked.md'), 'Read', false), false);
  assert.equal(f.memory.authorize('native:A', path.join(base, 'linked.md'), 'Write', true, { content: 'note' }), false);
  const linkedProfile = f.memory.directory('native:B'); fs.rmdirSync(linkedProfile);
  fs.symlinkSync(f.root, linkedProfile, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.memory.authorize('native:B', path.join(linkedProfile, 'private.md'), 'Read', false), false);
  fs.unlinkSync(linkedProfile);
});

test('native Write and repeated Edit cannot grow a memory beyond the readable limit', t => {
  const f = fixture(t), base = f.memory.directory('A');
  f.memory.write('A', 'MEMORY.md', 'xx', null);
  const file = path.join(base, 'MEMORY.md');
  assert.equal(f.memory.authorize('A', file, 'Write', true, { content: '中'.repeat(100000) }), false);
  assert.equal(f.memory.authorize('A', file, 'Edit', true, { old_string: 'x', new_string: 'a'.repeat(150000), replace_all: true }), false);
  assert.equal(f.memory.authorize('A', file, 'Edit', true, { old_string: 'x', new_string: 'new', replace_all: true }), true);
});

test('stale edits are rejected and deleting a topic removes its index entry', t => {
  const f = fixture(t);
  f.memory.write('A', 'MEMORY.md', '# Memory\n- [Preference](feedback.md)\n- [Other](other.md)\n', null);
  f.memory.write('A', 'feedback.md', 'original', null);
  const file = f.memory.list('A').find(file => file.name === 'feedback.md');
  f.memory.write('A', file.name, 'updated', file.revision);
  assert.throws(() => f.memory.write('A', file.name, 'stale', file.revision), /刷新/);
  assert.throws(() => f.memory.delete('A', file.name, file.revision), /刷新/);
  const updated = f.memory.list('A').find(file => file.name === 'feedback.md');
  f.memory.delete('A', updated.name, updated.revision);
  assert.equal(f.memory.list('A').length, 1);
  assert.ok(!f.memory.list('A')[0].content.includes('feedback.md'));
  assert.ok(f.memory.list('A')[0].content.includes('other.md'));
});

test('busy Profiles reject management edits; plan, stopped, and disabled tasks cannot write memories', async t => {
  const f = fixture(t);
  const task = f.store.create({ profileId: 'native:A', prompt: 'review', mode: 'plan' }, 'A');
  const file = path.join(f.memory.directory(task.profileId), 'MEMORY.md');
  const run = { stopped: false, chain: Promise.resolve(), started: Date.now() };
  task.status = 'running'; f.service.runs.set(task.id, run);
  assert.throws(() => f.service.setMemoryEnabled(task.profileId, false), /暂停/);
  assert.throws(() => f.service.writeMemory(task.profileId, 'MEMORY.md', 'x', null), /暂停/);
  assert.equal((await f.service.handleTool(task, run, 'authorize_memory', { path: file, tool: 'Write', input: { content: 'note' } })).allowed, false);
  task.mode = 'manual';
  assert.equal((await f.service.handleTool(task, run, 'authorize_memory', { path: file, tool: 'Write', input: { content: 'note' } })).allowed, false);
  task.mode = 'acceptEdits';
  assert.equal((await f.service.handleTool(task, run, 'authorize_memory', { path: file, tool: 'Write', input: { content: 'note' } })).allowed, true);
  run.stopped = true;
  await assert.rejects(() => f.service.handleTool(task, run, 'authorize_memory', { path: file, tool: 'Write', input: { content: 'note' } }), /停止/);
  f.service.runs.clear(); task.status = 'paused';
  f.service.setMemoryEnabled(task.profileId, false);
  assert.equal(new TaskStore(f.root).data.memoryPolicies[task.profileId].enabled, false);
  task.status = 'running'; run.stopped = false; f.service.runs.set(task.id, run);
  assert.equal((await f.service.handleTool(task, run, 'authorize_memory', { path: file, tool: 'Write', input: { content: 'note' } })).allowed, false);
});
