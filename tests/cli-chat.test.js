const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const output = mkdtempSync(path.join(tmpdir(), 'ppilot-chat-test-'));
buildSync({ entryPoints: { chat: path.resolve('src/main/cli/chat.ts'), terminal: path.resolve('src/main/cli/terminal.ts') }, outdir: output, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { AgentChat } = require(path.join(output, 'chat.cjs'));
const { renderTerminalFrame, stripAnsi } = require(path.join(output, 'terminal.cjs'));
test.after(() => rmSync(output, { recursive: true, force: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2500) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Condition did not become true'); await delay(10); }
}

function fixture(t, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'ppilot-chat-home-'));
  mkdirSync(path.join(home, '.profilepilot', 'cli'), { recursive: true });
  writeFileSync(path.join(home, '.profilepilot', 'cli', 'settings.json'), JSON.stringify({ defaultProfile: 'profile-a', theme: 'dark' }));
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  let screen = '';
  let brokenOutput;
  const stdout = new Writable({ write(chunk, encoding, callback) {
    screen += chunk;
    if (brokenOutput?.test(chunk.toString())) callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    else callback();
  } });
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const calls = [];
  const controller = new AbortController();
  const task = { id: '82c9c9f3-fab9-4f98-9b62-6ac6658bdd61', profileId: 'profile-a', profileName: 'Browser A', title: 'Chat test', prompt: 'hello', status: 'completed', running: false, mode: 'manual', model: 'test-model', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan: [], items: [], usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 }, limits: { minutes: 10, actions: 100, budgetUsd: 1 }, needsReconciliation: false };
  const events = [];
  const settings = { model: 'test-model', baseUrl: 'http://localhost:1', hasApiKey: true };
  const profiles = [{ id: 'profile-a', name: 'Browser A', source: 'isolated', agent_access: 'allowed', ...options.profile }];
  const responses = new Map();
  const receipts = new Set();
  const request = async command => {
    calls.push(command);
    if (responses.has(command.action)) return responses.get(command.action)(command);
    let data = {};
    switch (command.action) {
      case 'profile.list': data = { profiles }; break;
      case 'profile.get': data = { profile: profiles.find(profile => profile.id === command.selector) }; break;
      case 'task.settings.get': data = { settings }; break;
      case 'task.settings.update': Object.assign(settings, command.input); data = { settings: { ...settings, apiKey: undefined } }; break;
      case 'task.models': data = { models: ['test-model', 'second-model'] }; break;
      case 'task.create': task.prompt = command.input.prompt; task.status = 'running'; task.running = true; task.mode = command.input.mode; data = { task }; break;
      case 'task.get': {
        const revision = task.historyRevision || 0, reset = command.revision !== undefined && command.revision !== revision;
        const start = reset ? 0 : command.after || 0, selected = events.slice(start, start + (command.limit || 200));
        data = { task, events: selected, cursor: start + selected.length, hasMore: start + selected.length < events.length, revision, reset }; break;
      }
      case 'task.control':
        if (command.control === 'queue') {
          task.messageQueue ||= [];
          if (!receipts.has(command.requestId)) task.messageQueue.push({ id: `queued-${calls.length}`, message: command.message, attachmentIds: command.attachmentIds || [], createdAt: new Date().toISOString() });
          receipts.add(command.requestId);
        } else { task.running = ['resume', 'steer'].includes(command.control); task.status = task.running ? 'running' : command.control === 'cancel' ? 'cancelled' : 'paused'; }
        data = { task }; break;
      case 'task.queue':
        task.messageQueue ||= [];
        if (command.removeId) {
          const index = task.messageQueue.findIndex(message => message.id === command.removeId);
          if (index < 0) return { ok: false, error: { code: 'QUEUE_MESSAGE_MISSING', message: '消息已消费' } };
          task.messageQueue.splice(index, 1);
        }
        data = { queue: task.messageQueue }; break;
      case 'task.attachments.import': data = { attachments: command.paths.map((file, index) => ({ id: `file-${index}`, path: file })) }; break;
      case 'task.limits': Object.assign(task.limits, command.limits); data = { task }; break;
      case 'task.reply': task.pending = undefined; task.running = true; task.status = 'running'; data = { task }; break;
      case 'task.mode': task.mode = command.mode; data = { task }; break;
      case 'task.model': task.model = command.model; data = { task }; break;
      case 'task.list': data = { tasks: [task], total: 1 }; break;
      case 'task.permissions': data = { rules: [] }; break;
      case 'task.status': data = { task, processes: [], subagents: [], context: { characters: 12 } }; break;
      default: throw new Error('Unexpected request: ' + command.action);
    }
    return { ok: true, version: 1, id: 'test', data: structuredClone(data) };
  };
  const app = new AgentChat({ parsed: { local: 'agent', verb: 'chat', json: false, ...options.parsed }, io: { stdout, stderr: stdout }, stdin: input, request, signal: controller.signal, homeDir: home, cwd: home, pollMs: options.pollMs ?? 25 });
  const running = app.run();
  t.after(async () => { controller.abort(); await running; input.destroy(); rmSync(home, { recursive: true, force: true }); });
  return { app, input, stdout, calls, task, events, settings, profiles, responses, controller, running, breakOutputOn: pattern => { brokenOutput = pattern; }, screen: () => screen,
    frame: (columns = 65, rows = 18) => { app.render(); return renderTerminalFrame(app.ui.state, { columns, rows, theme: 'mono' }).lines.map(stripAnsi).join('\n'); },
    ready: () => until(() => app.settings && !app.busy) };
}

test('interactive chat uses saved Profile and restores the terminal on exit', async t => {
  const f = fixture(t); await f.ready();
  assert.equal(f.app.profile.name, 'Browser A');
  assert.equal(f.input.isRaw, true);
  f.input.write('/exit\r');
  assert.equal(await f.running, 0);
  assert.equal(f.input.isRaw, false);
  assert.match(f.screen(), /\x1b\[\?1049l/);
});

test('closing a terminal during the final resume hint does not crash a completed chat', async t => {
  const f = fixture(t); await f.ready(); await f.app.attach(f.task.id);
  f.breakOutputOn(/继续此会话/);
  f.input.write('/exit\r');
  assert.equal(await f.running, 0);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.stdout.listenerCount('error'), 0);
  assert.equal(f.calls.some(call => call.action === 'task.control'), false);
});

test('a closed output disconnects chat and releases raw input without cancelling the task', async t => {
  const f = fixture(t); await f.ready(); await f.app.attach(f.task.id);
  f.stdout.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(await f.running, 0);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.calls.some(call => call.action === 'task.control'), false);
});

test('real readline bracketed paste cannot invoke commands, menus or submit lines', async t => {
  const f = fixture(t); await f.ready();
  f.input.write('\x1b[200~');
  f.input.write('/exit\r?\t\x03');
  f.input.write('\x1b[201~');
  await delay(30);
  assert.equal(f.app.ended, false);
  assert.equal(f.calls.some(c => c.action === 'task.create'), false);
  assert.equal(f.app.help, false);
  assert.match(f.app.editor.text, /\/exit/);
});

test('Shift Enter remains multiline while a slash menu is visible', async t => {
  const f = fixture(t); await f.ready();
  f.input.write('/exit');
  f.input.write('\x1b[27;2;13~');
  await delay(30);
  assert.equal(f.app.ended, false);
  assert.equal(f.app.editor.text, '/exit\n');
});

test('Ctrl C during execution pauses the task and keeps the conversation open', async t => {
  const f = fixture(t); await f.ready();
  f.input.write('hello\r');
  await until(() => f.calls.some(c => c.action === 'task.create'));
  f.input.write('\x03');
  await until(() => f.calls.some(c => c.action === 'task.control' && c.control === 'pause'));
  assert.equal(f.app.ended, false);
  assert.equal(f.task.status, 'paused');
});

test('messages typed while running persist on server and recall removes them before editing', async t => {
  const f = fixture(t); await f.ready();
  f.input.write('first\r'); await until(() => f.app.task?.running);
  f.input.write('second\r');
  await until(() => f.app.serverQueue.length === 1 && !f.app.busy);
  assert.equal(f.task.messageQueue[0].message, 'second');
  assert.equal(f.calls.some(c => c.action === 'task.control' && c.control === 'steer'), false);
  f.input.write('\x1b[A');
  await until(() => f.app.serverQueue.length === 0 && !f.app.busy);
  assert.equal(f.app.editor.text, 'second');
  f.input.write('\r');
  await until(() => f.app.serverQueue.length === 1 && !f.app.busy);
  assert.equal(f.calls.filter(c => c.action === 'task.control' && c.message === 'second').length, 2);
  assert.notEqual(f.calls.filter(c => c.action === 'task.control' && c.message === 'second')[0].requestId, f.calls.filter(c => c.action === 'task.control' && c.message === 'second')[1].requestId);
});

test('confirmation uses the decision ID and session scope, never a default text reply', async t => {
  const f = fixture(t); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'decision-one', kind: 'confirmation', title: 'Send message?', details: 'Send exactly this content', permissionScope: { kind: 'browser', scope: 'scope-one', label: 'https://example.test · send' } };
  await f.app.attach(f.task.id);
  assert.equal(f.app.popup.choices.length, 4);
  f.input.write('\x1b[B\r');
  await until(() => f.calls.some(c => c.action === 'task.reply'));
  const command = f.calls.find(c => c.action === 'task.reply');
  assert.equal(command.decisionId, 'decision-one');
  assert.equal(command.scope, 'session');
  assert.equal(command.approved, true);
});

test('model selection updates the current task and persisted provider preference separately', async t => {
  const f = fixture(t); await f.ready(); await f.app.attach(f.task.id);
  await f.app.chooseModel('second-model');
  assert.equal(f.task.model, 'second-model');
  assert.equal(f.settings.model, 'second-model');
  assert.deepEqual(f.calls.filter(c => ['task.model', 'task.settings.update'].includes(c.action)).map(c => c.action), ['task.model', 'task.settings.update']);
});

test('connection wizard accepts blank defaults and masks credentials', async t => {
  const f = fixture(t); await f.ready();
  f.input.write('/login\r'); await until(() => Boolean(f.app.question));
  f.input.write('\r'); await until(() => f.app.question?.title.includes('模型名称'));
  f.input.write('\r'); await until(() => f.app.question?.secret);
  f.input.write('secret-value-123');
  assert.equal(f.screen().includes('secret-value-123'), false);
  f.input.write('\r');
  await until(() => f.calls.some(c => c.action === 'task.settings.update'));
  assert.equal(f.settings.baseUrl, 'http://localhost:1');
  assert.equal(f.settings.apiKey, 'secret-value-123');
});

test('Esc refuses a confirmation while keeping the CLI alive', async t => {
  const f = fixture(t); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'decision-two', kind: 'confirmation', title: 'Delete?', details: 'Delete one item' };
  await f.app.attach(f.task.id);
  f.input.emit('keypress', undefined, { name: 'escape', sequence: '\x1b' });
  await until(() => f.calls.some(c => c.action === 'task.reply'));
  assert.equal(f.calls.find(c => c.action === 'task.reply').approved, false);
  assert.equal(f.app.ended, false);
});

const ok = data => ({ ok: true, version: 1, id: 'test', data: structuredClone(data) });
const failed = message => ({ ok: false, version: 1, id: 'test', error: { code: 'test_error', message } });
const time = offset => new Date(Date.now() + offset).toISOString();

test('successful retry archives the matching error before new progress and preserves its original text', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.responses.set('task.create', () => failed('请连接最新的 ProfilePilot 扩展'));
  f.input.write('开始检索\r');
  await until(() => f.app.messages.some(message => message.role === 'error') && !f.app.busy);
  const error = f.app.messages.find(message => message.role === 'error');
  assert.equal(f.app.editor.text, '开始检索');
  await f.app.request({ action: 'task.models' });
  assert.equal(error.collapsedText, undefined, 'an unrelated successful request is not a successful retry');
  f.input.write('\r');
  await until(() => f.app.messages.filter(message => message.role === 'error').length === 2 && !f.app.busy);
  assert.ok(f.app.messages.every(message => !message.collapsedText));
  f.responses.delete('task.create');
  f.input.write('\r'); await until(() => f.app.task?.running && !f.app.busy);
  f.events.push({ id: 'new-progress', kind: 'assistant', at: time(1000), text: '新的搜索进度：已开始检索' });
  await f.app.poll(); f.app.render();
  const transcript = f.app.ui.state.messages;
  assert.equal(transcript.at(-1).id, 'new-progress');
  assert.equal(error.text, '请连接最新的 ProfilePilot 扩展');
  assert.match(error.collapsedText, /重试成功/);
  assert.ok(f.app.messages.filter(message => message.role === 'error').every(message => message.collapsedText));
  assert.equal(f.app.notice, '');
  assert.match(f.frame(), /新的搜索进度/);
  assert.ok(!f.app.ui.lastFrame.lines.join('').includes('\x1b[91m'), 'processed errors are no longer active red errors');
});

test('external approval closes the stale popup, restores the draft and folds large confirmation details', async t => {
  for (const [columns, rows, filepath, newline] of [[65, 18, 'C:\\Users\\tester\\report.csv', '\r\n'], [80, 24, '/Users/tester/report.csv', '\n']]) {
    await t.test(`${columns}x${rows}`, async t => {
      const f = fixture(t, { pollMs: Infinity }); await f.ready();
      const details = JSON.stringify({ path: filepath, rows: Array.from({ length: 50 }, (_, i) => [`audit row ${i}`, '中文 👨‍👩‍👧‍👦']) }, null, 2).replace(/\n/g, newline);
      f.events.push({ id: 'before', kind: 'assistant', at: time(-3000), text: '准备创建结果文件' });
      f.task.status = 'waiting_user'; f.task.pending = { id: 'export-one', kind: 'confirmation', title: '导出 CSV', details, createdAt: time(-2000) };
      f.app.editor.setText('保留我的草稿 👨‍👩‍👧‍👦');
      await f.app.attach(f.task.id);
      assert.equal(f.app.popup.decisionId, 'export-one');
      f.events.push({ id: 'approved', kind: 'user', at: time(-1000), text: '确认执行' }, { id: 'after', kind: 'assistant', at: time(1000), text: 'CSV 已完成，继续核查下一条结果' });
      f.task.pending = undefined; f.task.running = true; f.task.status = 'running';
      await f.app.poll();
      assert.equal(f.app.popup, undefined);
      assert.equal(f.app.editor.text, '保留我的草稿 👨‍👩‍👧‍👦');
      assert.equal(f.calls.some(call => call.action === 'task.reply'), false, 'external approval must not be submitted a second time');
      const record = f.app.messages.find(message => message.decisionId === 'export-one');
      assert.equal(record.text, `导出 CSV\n${details}`);
      assert.match(record.collapsedText, /确认已结束/);
      assert.deepEqual(f.app.ui.state.messages.map(message => message.id), ['before', 'decision-export-one', 'approved', 'after']);
      const screen = f.frame(columns, rows);
      assert.match(screen, /CSV 已完成/);
      assert.ok(!screen.includes('audit row'));
      f.input.write('\x0f');
      assert.equal(f.app.ui.state.expandedTools, true);
      assert.ok(f.frame(columns, rows).includes('audit row'), 'Ctrl+O restores the full confirmation audit details');
      await f.app.attach(f.task.id);
      assert.equal(f.app.messages.find(message => message.decisionId === 'export-one').text, record.text, 'reattaching the same task keeps local audit records');
    });
  }
});

test('external replacement immediately presents the next decision without duplicating audit entries', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'one', kind: 'confirmation', title: '旧确认', details: '旧操作', createdAt: time(-2000) };
  f.app.editor.setText('draft'); await f.app.attach(f.task.id);
  f.app.popup.selected = 2;
  f.task.pending = { id: 'two', kind: 'confirmation', title: '新确认', details: '新操作', createdAt: time(-1000) };
  await f.app.poll();
  assert.equal(f.app.popup.decisionId, 'two');
  assert.equal(f.app.popup.selected, 0);
  assert.equal(f.app.popup.draft, 'draft');
  f.app.closePopup(); await f.app.permissionMenu();
  await f.app.poll();
  assert.equal(f.app.messages.filter(message => message.decisionId === 'two').length, 1);
  assert.ok(f.app.messages.find(message => message.decisionId === 'one').collapsedText);
  assert.equal(f.app.messages.find(message => message.decisionId === 'two').collapsedText, undefined);
  f.input.write('\x1b[B\x1b[A\r'); await until(() => f.calls.some(call => call.action === 'task.reply') && !f.app.busy);
  assert.equal(f.calls.find(call => call.action === 'task.reply').decisionId, 'two');
  assert.equal(f.app.popup, undefined);
  assert.equal(f.app.editor.text, 'draft');
});

test('resolving a deferred confirmation leaves unrelated menus and notices intact', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'later', kind: 'handoff', title: '手动操作', details: '请完成登录', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  const later = f.app.popup.choices.at(-1);
  f.app.closePopup(); await later.choose();
  assert.match(f.app.notice, /等待处理/);
  await f.app.modelMenu(); f.app.notice = '保留此通知';
  f.task.pending = undefined; f.task.running = true;
  await f.app.poll();
  assert.equal(f.app.popup.title, '选择模型');
  assert.equal(f.app.notice, '保留此通知');
  assert.ok(f.app.messages.find(message => message.decisionId === 'later').collapsedText);
});

test('answering a pending question updates task state immediately and removes its stale notice', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'question', kind: 'question', title: '选择哪一项？', details: '请回复名称', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  assert.match(f.app.notice, /选择哪一项/);
  f.input.write('第一项\r'); await until(() => f.calls.some(call => call.action === 'task.reply') && !f.app.busy);
  assert.equal(f.app.task.pending, undefined);
  assert.equal(f.app.task.running, true);
  assert.equal(f.app.notice, '');
  assert.ok(f.app.messages.find(message => message.decisionId === 'question').collapsedText);
});

test('a poll issued before local approval cannot resurrect the old confirmation afterwards', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'race', kind: 'confirmation', title: '批准操作', details: '一次操作', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  const stale = ok({ task: f.task, events: [], cursor: 0, hasMore: false });
  let release;
  f.responses.set('task.get', () => new Promise(resolve => { release = resolve; }));
  const polling = f.app.poll();
  await until(() => Boolean(release));
  f.input.write('\x1b[B\x1b[A\r'); await until(() => f.app.task.running && !f.app.busy);
  release(stale); await polling;
  assert.equal(f.app.task.pending, undefined);
  assert.equal(f.app.popup, undefined);
  assert.ok(f.app.messages.find(message => message.decisionId === 'race').collapsedText);
});

test('successful polling clears only its own connection error and keeps unrelated notices', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready(); await f.app.attach(f.task.id);
  f.responses.set('task.get', () => failed('temporary connection error'));
  await f.app.poll(); assert.match(f.app.notice, /连接中断/);
  f.responses.delete('task.get'); await f.app.poll(); assert.equal(f.app.notice, '');
  f.responses.set('task.get', () => failed('another connection error'));
  await f.app.poll(); f.app.notice = '已添加附件';
  f.responses.delete('task.get'); await f.app.poll(); assert.equal(f.app.notice, '已添加附件');
});

test('a poll started during a reply cannot overwrite the newer reply response', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'during-reply', kind: 'confirmation', title: '批准操作', details: '一次操作', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  const stale = ok({ task: f.task, events: [], cursor: 0, hasMore: false });
  let releaseReply, releasePoll;
  f.responses.set('task.reply', () => new Promise(resolve => { releaseReply = resolve; }));
  const replying = f.app.replyDecision('during-reply', true);
  await until(() => Boolean(releaseReply));
  f.responses.set('task.get', () => new Promise(resolve => { releasePoll = resolve; }));
  const polling = f.app.poll(); await until(() => Boolean(releasePoll));
  f.task.pending = undefined; f.task.running = true;
  releaseReply(ok({ task: f.task })); await replying;
  releasePoll(stale); await polling;
  assert.equal(f.app.task.pending, undefined);
  assert.equal(f.app.popup, undefined);
  assert.ok(f.app.messages.find(message => message.decisionId === 'during-reply').collapsedText);
});

test('a failed reply reopens the current confirmation and is only archived once retry succeeds', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.status = 'waiting_user'; f.task.pending = { id: 'reply-retry', kind: 'confirmation', title: '批准操作', details: '一次操作', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  f.responses.set('task.reply', () => failed('reply temporarily unavailable'));
  f.input.write('\x1b[B\x1b[A\r'); await until(() => f.app.messages.some(message => message.role === 'error') && !f.app.busy);
  await f.app.poll();
  assert.equal(f.app.popup.decisionId, 'reply-retry');
  assert.equal(f.app.messages.filter(message => message.decisionId === 'reply-retry').length, 1);
  assert.equal(f.app.messages.find(message => message.role === 'error').collapsedText, undefined);
  f.responses.delete('task.reply'); f.input.write('\x1b[B\x1b[A\r');
  await until(() => f.app.task.running && !f.app.busy);
  assert.ok(f.app.messages.find(message => message.role === 'error').collapsedText);
  assert.ok(f.app.messages.find(message => message.decisionId === 'reply-retry').collapsedText);
  assert.equal(f.app.popup, undefined);
});

test('local records interleave with delayed events and stream text without duplicating committed streams', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready(); await f.app.attach(f.task.id);
  const at = offset => new Date(100000 + offset).toISOString();
  f.app.addMessage({ role: 'system', text: 'local status' }, at(20));
  f.events.push({ id: 'early', kind: 'assistant', at: at(10), text: 'earlier event delivered later' });
  f.responses.set('task.get', () => ok({ task: f.task, events: f.events, cursor: f.events.length, hasMore: false, stream: { id: 'stream-one', updatedAt: at(30), text: 'streamed answer' } }));
  await f.app.poll();
  assert.deepEqual(f.app.ui.state.messages.map(message => message.text), ['earlier event delivered later', 'local status', 'streamed answer']);
  f.responses.set('task.get', () => ok({ task: f.task, events: [{ id: 'stream-one', kind: 'assistant', at: at(30), text: 'committed answer' }], cursor: 2, hasMore: false, stream: { id: 'stream-one', updatedAt: at(30), text: 'streamed answer' } }));
  await f.app.poll();
  assert.equal(f.app.ui.state.messages.filter(message => message.id === 'stream-one').length, 1);
  assert.equal(f.app.ui.state.messages.at(-1).text, 'committed answer');
});

test('offline native Profile remains selectable for text, browser readiness stays informational', async t => {
  const reason = '浏览器工具需连接扩展';
  const f = fixture(t, { pollMs: Infinity, profile: { source: 'native', task_ready: false, task_unavailable_reason: reason } });
  await f.ready();
  assert.equal(f.app.ui.state.notice, reason);
  await f.app.profileMenu();
  assert.ok(!f.app.popup.choices[0].disabled);
  assert.equal(f.app.popup.choices[0].description, reason);
  f.app.closePopup(); f.input.write('纯文字问答\r');
  await until(() => f.app.task?.running && !f.app.busy);
  assert.equal(f.calls.filter(call => call.action === 'task.create').length, 1);
  assert.equal(f.calls.some(call => ['profile.get', 'task.connection.test'].includes(call.action)), false);
});

test('Profile menu refreshes browser readiness without disabling plain text sessions', async t => {
  const f = fixture(t, { pollMs: Infinity, profile: { task_ready: false, task_unavailable_code: 'extension_disconnected' } }); await f.ready();
  await f.app.profileMenu(); assert.equal(f.app.popup.choices[0].description, 'extension_disconnected');
  f.app.closePopup(); delete f.profiles[0].task_ready; delete f.profiles[0].task_unavailable_code;
  await f.app.profileMenu(); assert.ok(!f.app.popup.choices[0].disabled);
  f.app.closePopup();
  assert.equal(f.app.profile.task_ready, undefined);
});

test('restoring history bypasses Profile readiness and does not issue any readiness or model probe', async t => {
  const f = fixture(t, { pollMs: Infinity, parsed: { id: '82c9c9f3-fab9-4f98-9b62-6ac6658bdd61' }, profile: { task_ready: false, task_unavailable_reason: '请升级扩展' } });
  f.events.push({ id: 'history', kind: 'assistant', at: time(-1000), text: '历史任务已完成' });
  await f.ready();
  assert.equal(f.app.task.id, f.task.id);
  assert.match(f.frame(), /历史任务已完成/);
  assert.equal(f.calls.some(call => ['profile.get', 'task.create', 'task.control', 'task.connection.test'].includes(call.action)), false);
});

test('#30 secret editors cannot stash, search, yank, invoke helpers or contaminate the restored editor', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.app.editor.setText('original stash'); f.input.write('\x13');
  f.app.editor.setText('normal draft'); const normal = f.app.editor;
  let answer;
  f.app.ask('API Key', value => { answer = value; }, true);
  const secretEditor = f.app.editor;
  f.input.write('never-leak-this-key');
  for (const sequence of ['\x13', '\x12', '\x19', '\x07', '\x02', '\x14', '\x1bp']) f.input.write(sequence);
  assert.equal(f.app.editor.text, 'never-leak-this-key');
  assert.equal(f.app.popup, undefined);
  f.input.write('\r'); await until(() => answer && !f.app.busy);
  assert.equal(answer, 'never-leak-this-key');
  assert.equal(secretEditor.text, '');
  assert.equal(f.app.editor, normal);
  f.input.write('\x13'); assert.equal(f.app.editor.text, 'original stash');
  f.input.write('\x19\x1a'); assert.doesNotMatch(f.app.editor.text, /never-leak/);
  assert.doesNotMatch(f.screen(), /never-leak/);
  assert.doesNotMatch(JSON.stringify(await f.app.preferences.readHistory()), /never-leak/);
  f.app.ask('API Key', () => { throw new Error('must not submit'); }, true);
  f.input.write('cancel-secret\x03');
  assert.equal(f.app.question, undefined);
  assert.doesNotMatch(f.app.editor.text, /cancel-secret/);
});

test('#32 不要发送 + Enter and bare Enter/Tab cannot approve; selection and Enter must be explicit', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.pending = { id: 'reject-me', kind: 'confirmation', title: '发送消息', details: '提交给外部对象', createdAt: time(-1000) }; f.task.status = 'waiting_user';
  f.app.editor.setText('preserved draft'); await f.app.attach(f.task.id);
  f.input.write('不要发送\r');
  await delay(20);
  assert.equal(f.calls.some(call => call.action === 'task.reply'), false);
  assert.equal(f.app.editor.text, '');
  assert.equal(f.app.popup.draft, 'preserved draft');
  f.input.write('\t'); await delay(10);
  assert.equal(f.calls.some(call => call.action === 'task.reply'), false, 'Tab selects but never submits');
  f.input.write('\r'); await until(() => f.calls.some(call => call.action === 'task.reply'));
  assert.equal(f.calls.find(call => call.action === 'task.reply').approved, false);
});

test('#31 shell context remains owned by its conversation and survives a failed submission', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  const original = f.app.currentShellContext(); original.text = 'task-A-shell-only';
  f.responses.set('task.create', () => failed('offline'));
  const message = { text: 'test', paths: [] };
  await assert.rejects(f.app.submitMessage(message), /offline/);
  assert.equal(original.text, 'task-A-shell-only');
  f.responses.delete('task.create');
  await f.app.submitMessage(message);
  assert.equal(original.text, '');
  assert.match(f.task.prompt, /task-A-shell-only/);
  original.text = 'late-A-output';
  f.task.running = false; f.app.task.running = false;
  f.app.newConversation();
  assert.equal(f.app.currentShellContext().text, '');
  await f.app.submitMessage({ text: 'task B', paths: [] });
  assert.doesNotMatch(f.task.prompt, /late-A-output/);
});

test('#31/#35 real local shell emits UTF-8 text without CLIXML and late output stays in original context', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  const owner = f.app.currentShellContext();
  await f.app.runShell(process.platform === 'win32' ? "Write-Output '中文🙂'; Start-Sleep -Milliseconds 80; [Console]::Error.Write('错误é'); Write-Error '可读错误'" : "printf '中文🙂'; sleep .08; printf '错误é' >&2");
  const record = f.app.messages.at(-1);
  f.app.newConversation();
  await until(() => !f.app.shell, 8000);
  assert.match(record.detail, /中文🙂/); assert.match(record.detail, /错误é/);
  assert.doesNotMatch(record.detail, /#< CLIXML|<Objs|�/);
  assert.match(owner.text, /中文🙂/);
  assert.equal(f.app.currentShellContext().text, '');
});

test('#33/#56 persistent queue restores on attach, preserves FIFO, supports recall/edit/remove and now', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready(); await f.app.attach(f.task.id);
  f.task.running = true; f.app.task.running = true;
  await f.app.submitMessage({ text: 'first', paths: [], attachmentIds: ['image-a'] });
  await f.app.submitMessage({ text: 'second', paths: [] });
  const firstId = f.task.messageQueue[0].id;
  await f.app.background(); assert.equal(f.task.messageQueue.length, 2);
  await f.app.attach(f.task.id); assert.deepEqual(f.app.serverQueue.map(item => item.message), ['first', 'second']);
  await f.app.editQueued(f.app.serverQueue[1]);
  assert.deepEqual(f.task.messageQueue.map(item => item.message), ['first']);
  f.app.editor.setText('edited second'); f.input.write('\r'); await until(() => f.task.messageQueue.length === 2 && !f.app.busy);
  await f.app.sendQueuedNow();
  const sent = f.calls.find(call => call.action === 'task.control' && call.control === 'steer');
  assert.equal(sent.message, 'first'); assert.deepEqual(sent.attachmentIds, ['image-a']);
  assert.equal(sent.requestId, `now-${firstId}`);
  assert.deepEqual(f.task.messageQueue.map(item => item.message), ['edited second']);
  await assert.rejects(f.app.removeQueued(f.task.id, firstId), /消息已消费/);
});

test('#34 question, resume and queue carry imported attachments; retries retain request IDs and do not reimport', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  const file = path.join(f.app.cwd, 'proof.txt'); writeFileSync(file, 'offline attachment', 'utf8');
  f.task.pending = { id: 'question-file', kind: 'question', title: '提供附件', details: '附件内容', createdAt: time(-1000) };
  await f.app.attach(f.task.id);
  f.responses.set('task.reply', () => failed('retry reply'));
  const message = { text: '附上文件', paths: [file] };
  await assert.rejects(f.app.submitMessage(message), /retry reply/);
  f.responses.delete('task.reply'); await f.app.submitMessage(message);
  const replies = f.calls.filter(call => call.action === 'task.reply');
  assert.deepEqual(replies[0].attachmentIds, ['file-0']); assert.equal(replies[0].requestId, replies[1].requestId);
  assert.equal(f.calls.filter(call => call.action === 'task.attachments.import').length, 1);
  assert.equal(f.calls.find(call => call.action === 'task.attachments.import').id, f.task.id);
  f.task.running = false; f.app.task.running = false;
  await f.app.submitMessage({ text: `参考 @"${file}"`, paths: [] });
  assert.deepEqual(f.calls.findLast(call => call.action === 'task.control').attachmentIds, ['file-0']);
  await f.app.submitMessage({ text: '排队附件', paths: [file] });
  assert.deepEqual(f.task.messageQueue[0].attachmentIds, ['file-0']);
});

test('#37/#61 history revision resets old events; full transcript can find and export records before 2000', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  for (let index = 0; index < 2006; index++) f.events.push({ id: `event-${index}`, at: time(index), kind: index % 2 ? 'assistant' : 'user', text: index === 0 ? '最早的专属消息' : `body ${index}` });
  await f.app.attach(f.task.id); await f.app.transcriptMenu('最早的专属消息');
  assert.equal(f.app.events.length, 2006);
  assert.equal(f.app.currentChoices()[0].id, 'event-0');
  assert.equal(await f.app.transcriptText('event-0'), '最早的专属消息', 'copy-one must preserve raw message text without export headings');
  const choose = f.app.currentChoices()[0].choose; f.app.closePopup(); await choose();
  assert.ok(f.app.ui.scrollOffset > 0);
  const target = path.join(f.app.cwd, 'transcript-export.md'); await f.app.exportTranscript(target);
  assert.match(require('node:fs').readFileSync(target, 'utf8'), /最早的专属消息/);
  f.events.splice(0, f.events.length, { id: 'revised', at: time(3000), kind: 'user', text: '修订历史' }); f.task.historyRevision = 1;
  await f.app.poll();
  assert.deepEqual(f.app.events.map(event => event.id), ['revised']); assert.equal(f.app.historyRevision, 1);
});

test('#39 agents panel continuously observes a separate task and targets message/stop without switching main task', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready(); await f.app.attach(f.task.id);
  const main = f.app.task.id, target = { ...structuredClone(f.task), id: 'target-b', title: '独立受控任务', running: true, status: 'running' }, targetEvents = [];
  f.responses.set('task.list', () => ok({ tasks: [f.task, target], total: 2 }));
  f.responses.set('task.get', command => command.id === target.id ? ok({ task: target, events: targetEvents.slice(command.after || 0), cursor: targetEvents.length, hasMore: false, revision: 0 }) : ok({ task: f.task, events: [], cursor: 0, hasMore: false }));
  f.responses.set('task.status', () => ok({ processes: [], subagents: [{ id: 'sdk-observation-only' }], relatedTasks: [{ id: target.id }] }));
  f.responses.set('task.control', command => { assert.equal(command.id, target.id); if (command.control === 'cancel') { target.status = 'cancelled'; target.running = false; } return ok({ task: target }); });
  await f.app.agentStatus();
  const choose = f.app.popup.choices.find(item => item.id === target.id).choose; f.app.closePopup(); await choose();
  assert.equal(f.app.task.id, main); assert.equal(f.app.agentsPanel.target, target.id);
  assert.match(f.app.ui.state.status, /查看 target-b/);
  targetEvents.push({ id: 'target-progress', at: time(0), kind: 'assistant', text: '目标任务继续输出' });
  await until(() => f.app.agentsPanel.page.events.some(item => item.id === 'target-progress'));
  await f.app.sendAgentMessage(target.id, '定向消息');
  assert.equal(f.calls.findLast(call => call.action === 'task.control').control, 'queue');
  const stop = f.app.popup.choices.find(item => item.label === '停止此任务'); f.app.closePopup(); await stop.choose();
  const confirm = f.app.popup.choices.find(item => item.label === '确认停止'); f.app.closePopup(); await confirm.choose();
  assert.equal(target.status, 'cancelled'); assert.equal(f.app.task.id, main);
  assert.match(f.app.agentPanelMessages().at(-1).text, /只读观察/);
});

test('#42/#43 search hint wins; Esc dismisses slash/file/help before pausing, retaining drafts', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready(); await f.app.attach(f.task.id);
  f.task.running = true; f.app.task.running = true;
  f.app.editor.setHistory(['old history']); f.input.write('\x12unmatched');
  assert.match(f.frame(80, 24), /无匹配/);
  f.app.key(undefined, { name: 'escape' }); assert.equal(f.calls.some(call => call.action === 'task.control'), false);
  f.input.write('/res'); assert.ok(f.app.currentChoices().length);
  f.app.key(undefined, { name: 'escape' }); assert.equal(f.app.editor.text, '/res'); assert.equal(f.app.currentChoices().length, 0);
  assert.equal(f.calls.some(call => call.action === 'task.control'), false);
  f.app.editor.clear(); f.input.write('?'); f.app.key(undefined, { name: 'escape' }); assert.equal(f.app.help, false);
  assert.equal(f.calls.some(call => call.action === 'task.control'), false);
  f.app.key(undefined, { name: 'escape' }); await until(() => f.calls.some(call => call.action === 'task.control' && call.control === 'pause'));
});

test('#49 resume search includes stable identity and preview never attaches or loses search', async t => {
  const f = fixture(t, { pollMs: Infinity }); await f.ready();
  f.task.title = 'a'.repeat(180); f.events.push({ id: 'preview', kind: 'assistant', text: 'preview content', at: time(0) });
  await f.app.sessionMenu(); f.app.editor.setText(f.task.id.slice(0, 8));
  f.input.write('\t'); await until(() => f.app.popup.choices[0].detail.includes('preview content') && !f.app.busy);
  assert.equal(f.app.task, undefined); assert.equal(f.app.editor.text, f.task.id.slice(0, 8));
  assert.match(f.frame(80, 24), /completed/); assert.match(f.frame(80, 24), /82c9c9f3/);
});

test('#50 linear screen reader mode produces labelled append-only output without ANSI or credential echo', async t => {
  const f = fixture(t, { pollMs: Infinity, parsed: { screenReader: true } }); await f.ready();
  f.app.addMessage({ role: 'assistant', text: '读屏内容' }); f.app.render();
  f.app.ask('API Key', () => {}, true); f.input.write('secret-reader-value');
  assert.match(f.screen(), /\[assistant\] 读屏内容/); assert.match(f.screen(), /隐藏输入/);
  assert.doesNotMatch(f.screen(), /\x1b|secret-reader-value/);
  f.input.write('\x03'); f.app.close(0); await f.running;
  assert.doesNotMatch(f.screen(), /\x1b/);
});
