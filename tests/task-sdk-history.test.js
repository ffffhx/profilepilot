const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { taskModelContext } = require('../dist/main/tasks/model-context');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sdk-history-中文 '));
  const store = new TaskStore(root);
  const task = store.create({ profileId: 'native:stable-profile-id', prompt: '保留原始资料，查询后生成报告。' }, '可以重命名的 Profile');
  const cwd = path.join(root, 'sessions', task.id);
  const sessionId = randomUUID();
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(cwd, 'projects', project, `${sessionId}.jsonl`);
  const append = record => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(record) + '\n'); };
  const input = context => {
    const uuid = randomUUID();
    append({ type: 'user', uuid, parentUuid: null, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false,
      message: { role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] } });
    return uuid;
  };
  const assistant = (text, id = 'msg_test') => {
    append({ type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
    store.event(task, 'assistant', text, id);
  };
  const title = value => append({ type: 'custom-title', customTitle: value, sessionId });
  t.after(() => { store.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, task, cwd, sessionId, file, append, input, assistant, title,
    read: () => JSON.parse(fs.readFileSync(store.file, 'utf8')) };
}

test('SDK-backed bodies and exact input fields are references; product-only state stays local', t => {
  const f = fixture(t);
  f.task.attachments = [{ id: 'attachment', path: path.join(f.root, 'input.csv'), name: 'input.csv', size: 12 }];
  f.task.outputs = [{ id: 'report', path: path.join(f.root, 'report.csv'), name: 'report.csv', size: 20 }];
  f.task.materials = [{ id: 'm1', name: '资料', scope: 'task', content: '业务资料正文', version: 1, updatedAt: f.task.updatedAt }];
  f.task.skill = { id: 'report', title: '报告 Skill', version: '1', digest: 'captured', root: path.join(f.root, 'skills', 'report'), instructions: '只使用用户提供的资料。', parameters: { topic: '测试' } };
  f.input(taskModelContext(f.task)); f.title(f.task.title); f.task.sdkSessionId = f.sessionId;
  f.assistant('报告生成完毕。');
  f.store.event(f.task, 'system', '用户已暂停，禁止继续执行。');
  const expected = structuredClone(f.task);
  f.store.save();
  const saved = f.read().tasks[0];
  assert.equal(f.read().version, 2);
  for (const field of ['title', 'prompt', 'attachments', 'outputs', 'materials', 'skill']) assert.equal(saved[field], undefined, field);
  assert.equal(saved.sdkTitle, f.sessionId);
  assert.equal(saved.profileId, 'native:stable-profile-id');
  assert.ok(saved.events[0].sdkText); assert.equal(saved.events[0].text, undefined);
  assert.ok(saved.events[1].sdkText); assert.equal(saved.events[1].text, undefined);
  assert.equal(saved.events[2].text, expected.events[2].text);
  const reopened = new TaskStore(f.root);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.get(f.task.id))), JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.snapshot().tasks[0])), JSON.parse(JSON.stringify(expected)));
  reopened.close();
  assert.equal(JSON.parse(fs.readFileSync(f.store.file + '.before-sdk-reuse.v1.bak')).version, 1);
});

test('unsent, partial and redacted messages keep their exact local text', t => {
  const f = fixture(t);
  f.input(taskModelContext(f.task)); f.task.sdkSessionId = f.sessionId;
  f.append({ type: 'assistant', uuid: randomUUID(), sessionId: f.sessionId,
    message: { id: 'secret', content: [{ type: 'text', text: 'secret-key and full response' }] } });
  f.store.event(f.task, 'assistant', '[REDACTED] and full response', 'secret');
  f.store.event(f.task, 'assistant', 'partial', 'not-yet-flushed');
  f.store.event(f.task, 'user', '这条消息还没发送给 SDK');
  f.store.save();
  assert.deepEqual(f.read().tasks[0].events.slice(1).map(e => e.text), f.task.events.slice(1).map(e => e.text));
  const before = fs.readFileSync(f.file);
  fs.appendFileSync(f.file, '{"type":"assistant","uuid":"unfinished');
  f.store.save();
  assert.equal(f.read().tasks[0].events.at(-1).text, '这条消息还没发送给 SDK');
  fs.writeFileSync(f.file, before);
});

test('missing or modified referenced records never overwrite the persisted task index', t => {
  const f = fixture(t);
  f.input(taskModelContext(f.task)); f.store.save();
  const index = fs.readFileSync(f.store.file), transcript = fs.readFileSync(f.file);
  fs.unlinkSync(f.file);
  assert.throws(() => new TaskStore(f.root), /SDK 会话记录缺失/);
  assert.deepEqual(fs.readFileSync(f.store.file), index);
  fs.writeFileSync(f.file, transcript.toString().replaceAll('保留原始资料', '改写原始资料'));
  assert.throws(() => new TaskStore(f.root), /SDK 会话记录与任务引用不一致/);
  assert.deepEqual(fs.readFileSync(f.store.file), index);
  fs.writeFileSync(f.file, transcript);
});

test('legacy transcripts migrate without changing bytes, while unsupported records keep v1 fallbacks', t => {
  const f = fixture(t);
  const legacy = { ...taskModelContext(f.task) }; delete legacy._profilepilot;
  f.input(legacy); f.assistant('旧版消息也能恢复。');
  const bytes = fs.readFileSync(f.file);
  f.store.save();
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(new TaskStore(f.root).get(f.task.id).events[1].text, '旧版消息也能恢复。');
  const other = f.store.create({ prompt: '尚未创建 SDK 会话', profileId: 'native:other' }, 'Other');
  f.store.save();
  assert.equal(f.read().tasks.find(t => t.id === other.id).prompt, other.prompt);
});

test('SDK rename is the title source, including external title changes and app restart', async t => {
  const f = fixture(t);
  f.input(taskModelContext(f.task)); f.title(f.task.title); f.task.sdkSessionId = f.sessionId; f.store.save();
  const service = new TaskService(f.store, { changed: () => {}, apiKey: () => '', notify: () => {}, browser: {} });
  await service.updateTaskMetadata(f.task.id, { title: '通过 SDK 重命名' });
  assert.equal(f.read().tasks[0].title, undefined);
  assert.equal(new TaskStore(f.root).get(f.task.id).title, '通过 SDK 重命名');
  assert.match(fs.readFileSync(f.file, 'utf8'), /通过 SDK 重命名/);
  f.title('外部 SDK 改名');
  assert.equal(service.snapshot().tasks[0].title, '外部 SDK 改名');
  await service.close();
});

test('normal resume sends changed state and undelivered inputs without replaying history', t => {
  const f = fixture(t);
  f.task.grant = { origin: 'https://example.test', effects: ['submit'], maxActions: 1, used: 0 };
  f.input(taskModelContext(f.task)); f.task.sdkSessionId = f.sessionId;
  f.assistant('这是先前已在 SDK 中保存的答复。');
  f.store.event(f.task, 'user', '现在只解释结果，不操作网页。');
  f.task.grant = undefined;
  const history = f.store.sdkHistory(f.task.id); history.refresh();
  const next = taskModelContext(f.task, undefined, history.context(f.sessionId));
  assert.equal(next._profilepilot.mode, 'resume');
  assert.equal(next.recentHistory, undefined); assert.equal(next.goal, undefined); assert.equal(next.materials, undefined);
  assert.equal(next.executionGrant, null);
  assert.equal(next.currentRequest, '现在只解释结果，不操作网页。');
  assert.deepEqual(next.inputEvents.map(e => e.text), ['现在只解释结果，不操作网页。']);
  f.input(next); history.refresh();
  assert.equal(history.context(f.sessionId).state.goal, f.task.prompt);
  assert.equal(history.context(f.sessionId).state.executionGrant, null);
  const rebuilt = taskModelContext({ ...f.task, sdkSessionId: undefined });
  assert.equal(rebuilt._profilepilot.mode, 'rebuild');
  assert.equal(rebuilt.recentHistory.length, f.task.events.length);
});

test('SDK compaction resends current product state without duplicating conversation history', t => {
  const f = fixture(t);
  f.input(taskModelContext(f.task)); f.task.sdkSessionId = f.sessionId;
  f.assistant('即将被 SDK 压缩的回答');
  f.append({ type: 'system', subtype: 'compact_boundary', sessionId: f.sessionId, uuid: randomUUID() });
  f.store.event(f.task, 'user', '压缩后继续');
  const history = f.store.sdkHistory(f.task.id); history.refresh();
  const next = taskModelContext(f.task, undefined, history.context(f.sessionId));
  assert.equal(next._profilepilot.mode, 'resume');
  assert.equal(next.goal, f.task.prompt);
  assert.deepEqual(next.materials, f.task.materials);
  assert.equal(next.recentHistory, undefined);
  assert.deepEqual(next.inputEvents.map(e => e.text), ['压缩后继续']);
  f.store.save();
  assert.equal(new TaskStore(f.root).get(f.task.id).events[1].text, '即将被 SDK 压缩的回答');
});

test('branches and rewind hydrate first and do not retain references to another task directory', t => {
  const f = fixture(t);
  f.input(taskModelContext(f.task)); f.assistant('历史答复'); f.task.status = 'paused'; f.store.save();
  const reopened = new TaskStore(f.root);
  const service = new TaskService(reopened, { changed: () => {}, apiKey: () => '', notify: () => {}, browser: {} });
  const branch = service.forkConversation(f.task.id);
  const saved = JSON.parse(fs.readFileSync(reopened.file));
  assert.ok(branch.events.some(e => e.text === '历史答复'));
  assert.equal(saved.tasks.find(t => t.id === branch.id).events.some(e => e.sdkText), false);
  reopened.event(branch, 'user', '撤回这条'); reopened.save();
  service.rewindConversation(branch.id, branch.events.at(-1).id);
  assert.ok(new TaskStore(f.root).get(branch.id).events.some(e => e.text === '历史答复'));
  reopened.close();
});

test('multiple assistant blocks with the same message ID retain order and exact text', t => {
  const f = fixture(t);
  f.assistant('第一块', 'msg_shared');
  f.assistant('第二块', 'msg_shared:local-display-id');
  // The SDK uses one message ID; display IDs are disambiguated by the product.
  const rows = fs.readFileSync(f.file, 'utf8').replaceAll('msg_shared:local-display-id', 'msg_shared'); fs.writeFileSync(f.file, rows);
  f.store.save();
  assert.deepEqual(new TaskStore(f.root).get(f.task.id).events.slice(1).map(e => e.text), ['第一块', '第二块']);
});
