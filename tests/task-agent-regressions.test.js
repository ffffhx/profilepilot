const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { firstTaskUrl } = require('../dist/main/tasks/jev-driver');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');

test('initial navigation separates Chinese instructions and Markdown from URLs', () => {
  for (const prompt of [
    '访问 https://example.test/animated，查看我的全部投递记录',
    '打开 https://example.test/animated。然后查询',
    '打开（https://example.test/animated）并读取',
    '打开 [记录](https://example.test/animated)。',
    '打开 https://example.test/animated; then read it',
  ]) assert.equal(firstTaskUrl(prompt), 'https://example.test/animated', prompt);
  assert.equal(firstTaskUrl('访问 https://example.test/wiki/Title_(detail) 和第二页'), 'https://example.test/wiki/Title_(detail)');
  assert.equal(firstTaskUrl('访问 https://example.test/记录?page=2&q=%E3%80%82，读取'), 'https://example.test/%E8%AE%B0%E5%BD%95?page=2&q=%E3%80%82');
  assert.equal(firstTaskUrl('查询记录，不指定地址'), undefined);
});

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-agent-regression-'));
  const store = new TaskStore(root);
  const task = store.create({ profileId: 'isolated:test', prompt: '只读查询' }, 'Test');
  const old = { version: 'v1', fingerprint: 'old-carousel', url: 'https://example.test/start', title: 'Start', snapshot: '- link "记录" [ref=e1]', account: 'test' };
  let observations = 0, actions = 0;
  const browser = { observe: async () => { observations++; return { ...old, version: 'v2', fingerprint: 'new-carousel' }; }, execute: async () => { actions++; return 'navigated'; }, control: async () => {}, tabs: async () => [] };
  const service = new TaskService(store, { browser, apiKey: () => '', profileName: async () => 'Test', prepareProfile: async () => ({ name: 'Test', port: 9223 }), changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 };
  task.status = 'running'; task.observation = old; service.runs.set(task.id, run);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, task, run, service, browser, counts: () => ({ observations, actions }) };
}

test('idle extension clears only a stale paused reservation, retaining task history and recovery context', t => {
  const f = fixture(t);
  f.task.profileId = 'native:Default'; f.task.browserConnection = 'extension'; f.task.status = 'paused';
  f.service.reconcileIdleNativeProfile('native:Default');
  assert.equal(f.task.browserConnection, 'extension'); // The run is still draining.
  f.service.runs.delete(f.task.id);
  f.task.pending = { kind: 'handoff' };
  f.service.reconcileIdleNativeProfile('native:Default');
  assert.equal(f.task.browserConnection, 'extension');
  f.task.pending = undefined;
  const session = f.task.sessionId;
  f.service.reconcileIdleNativeProfile('native:Default');
  assert.equal(f.task.browserConnection, undefined);
  assert.equal(f.task.status, 'paused'); assert.equal(f.task.sessionId, session);
  assert.equal(f.task.resumeContext.url, 'https://example.test/start');
  assert.equal(f.task.needsReconciliation, true);
});

test('read-only URL navigation leaves a changing page, while DOM actions still reject stale refs', async t => {
  const f = fixture(t);
  const result = await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'open', value: 'https://example.test/records', effect: 'read', summary: '查看记录' });
  assert.equal(result.isError, false); assert.deepEqual(f.counts(), { observations: 0, actions: 1 });
  f.task.observation = { version: 'v1', fingerprint: 'old-carousel', snapshot: '', url: 'https://example.test/start' };
  const stale = await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'click', version: 'v1', ref: 'e1', effect: 'read', summary: '点击记录' });
  assert.equal(stale.isError, true); assert.equal(f.counts().actions, 1);
});

test('switching tabs uses a tab ID, not an old page DOM version', async t => {
  const f = fixture(t);
  const result = await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'switch_tab', value: 't1', effect: 'read', summary: 'Return to entry tab' });
  assert.equal(result.isError, false);
  assert.deepEqual(f.counts(), { observations: 0, actions: 1 });
  f.task.resumeContext = { returnedAt: new Date().toISOString(), observed: false };
  const unobserved = await f.service.handleTool(f.task, f.run, 'browser_action', { kind: 'switch_tab', value: 't1', effect: 'read', summary: 'Return to entry tab' });
  assert.equal(unobserved.isError, true);
  assert.equal(f.counts().actions, 1, 'User handoff still requires observing before navigation');
});

test('model observations omit local DOM guards but keep controls and local stale-action protection', async t => {
  const f = fixture(t);
  const guard = 'local-only-guard-with-exact-attributes';
  const candidate = { ref: 'e1', role: 'button', label: '头像', kind: 'click' };
  f.browser.observe = async () => ({ version: 'v3', fingerprint: 'f3', at: new Date().toISOString(),
    url: 'https://example.test/', title: 'Example', snapshot: '- button "头像" [ref=e1]', account: 'unknown',
    fast: { document: 'local-document', guard, candidates: [candidate] } });
  const result = await f.service.handleTool(f.task, f.run, 'observe', {});
  const sent = JSON.parse(result.content[0].text);
  assert.deepEqual(sent.fast.candidates, [candidate]);
  assert.equal(sent.fast.guard, undefined);
  assert.equal(sent.fast.document, undefined);
  assert.ok(!result.content[0].text.includes(guard));
  assert.equal(f.task.observation.fast.guard, guard);
  assert.equal(f.task.observation.fast.document, 'local-document');
});

test('a screenshot unavailable from ordinary observe does not cause a second screenshot attempt', async t => {
  const f = fixture(t); let calls = 0;
  f.browser.observe = async () => { calls++; return { version: 'v3', fingerprint: 'blank', url: 'about:blank', title: '', snapshot: '空白任务页', fast: { candidates: [], guard: 'g' } }; };
  const result = await f.service.handleTool(f.task, f.run, 'observe', { screenshot: true });
  assert.equal(result.isError, undefined);
  assert.equal(calls, 1);
});

test('extension connection pauses are distinguished from explicit user takeover', t => {
  const f = fixture(t);
  f.service.externalControl(f.task.sessionId, 'user', 'active', 'extension-paused');
  assert.equal(f.task.pending.title, '浏览器连接已暂停');
  assert.match(f.task.pending.details, /发送补充说明/);
  assert.equal(f.task.resumeContext.reason, '浏览器连接已暂停');
  f.task.status = 'running';
  f.service.externalControl(f.task.sessionId, 'user', 'active', 'extension-takeover');
  assert.equal(f.task.pending.title, '浏览器已由用户接管');
});

test('reply connection failure leaves a retryable decision without recording duplicate user messages', async t => {
  const f = fixture(t);
  f.service.runs.delete(f.task.id);
  f.task.status = 'waiting_user'; f.task.browserConnection = 'extension';
  f.task.pending = { id: 'handoff', kind: 'handoff', title: '恢复连接' };
  let fails = true;
  f.browser.control = async () => { if (fails) throw Error('扩展离线'); };
  await assert.rejects(f.service.reply(f.task.id, 'handoff', '请继续当前任务', true), /扩展离线/);
  assert.equal(f.task.pending.id, 'handoff');
  assert.equal(f.task.events.filter(e => e.kind === 'user' && e.text === '请继续当前任务').length, 0);
  fails = false;
  await f.service.reply(f.task.id, 'handoff', '请继续当前任务', true);
  assert.equal(f.task.events.filter(e => e.kind === 'user' && e.text === '请继续当前任务').length, 1);
  assert.equal(f.task.resumeContext.userResponse, '请继续当前任务');
  assert.equal(f.task.status, 'queued');
});

test('hover ignores unrelated carousel changes but still checks target context, attributes and identity', () => {
  const { readLinkGuard } = require('../dist/main/tasks/fast-browser');
  const action = { kind: 'hover', effect: 'read', ref: 'e1' };
  const make = (changes = {}) => JSON.stringify(['https://example.test', 'doc',
    [{ ref: changes.ref || 'e1', role: 'button', label: '头像', kind: 'click' }, { ref: 'e2', label: changes.slide || 'Slide 1' }],
    [changes.context || '账号区域', 'carousel'], [changes.attributes || '["dropdown-trigger"]', '[]']]);
  const guard = readLinkGuard(make(), action);
  assert.ok(guard);
  assert.equal(readLinkGuard(make({ slide: 'Slide 2' }), action), guard);
  for (const change of [{ ref: 'e3' }, { context: '另一个账号' }, { attributes: '["changed"]' }]) {
    assert.notEqual(readLinkGuard(make(change), action), guard);
  }
  assert.equal(readLinkGuard(make(), { ...action, effect: 'submit' }), undefined);
});

test('invalid scroll directions fail before browser execution or an uncertain receipt is created', async t => {
  const f = fixture(t);
  const before = f.task.receipts.length;
  await assert.rejects(f.service.handleTool(f.task, f.run, 'browser_action', {
    kind: 'scroll', value: 'bottom', version: 'v1', effect: 'read', summary: '查看页底'
  }), /scroll 方向只支持/);
  assert.equal(f.task.receipts.length, before);
  assert.equal(f.counts().actions, 0);
});

test('opening a records menu is read-only while application submission and payment menus remain protected', () => {
  const { effectiveEffect } = require('../dist/main/tasks/browser');
  const action = { kind: 'click', ref: 'e1', effect: 'read' };
  assert.equal(effectiveEffect(action, { snapshot: '- menuitem "投递记录" [ref=e1]' }), 'read');
  assert.equal(effectiveEffect(action, { snapshot: '- menuitem "投递简历" [ref=e1]' }), 'submit');
  assert.equal(effectiveEffect(action, { snapshot: '- menuitem "支付" [ref=e1]' }), 'purchase');
});

test('pause drains read-only connection and observation; takeover and write interruption remain immediate', async t => {
  for (const { action, status, effect, drains } of [
    { action: 'pause', status: 'started', effect: 'read', drains: true },
    { action: 'pause', status: 'executed', effect: 'read', drains: true },
    { action: 'takeover', status: 'started', effect: 'read', drains: false },
    { action: 'pause', status: 'started', effect: 'submit', drains: false },
  ]) {
    await t.test(`${action}/${status}/${effect}`, async t => {
      const f = fixture(t), controls = [];
      f.task.port = 9223;
      f.task.receipts = [{ id: 'bootstrap', status, action: { kind: effect === 'read' ? 'open' : 'click', effect, value: 'https://example.test' } }];
      f.run.driver = true;
      let finish;
      f.run.chain = new Promise(resolve => { finish = resolve; });
      f.browser.control = async (_task, command) => { controls.push(command); };
      const stopping = f.service.control(f.task.id, action);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.run.stopped, true, 'No later driver actions may start');
      assert.deepEqual(controls, drains ? [] : ['handoff']);
      finish(); await stopping;
      assert.deepEqual(controls, ['handoff']);
    });
  }
});

test('native fast observations with an image do not capture a second image', async t => {
  const f = fixture(t); let captures = 0;
  f.browser.observe = async () => { captures++; return { ...f.task.observation, fast: { document: 'doc', guard: 'guard', candidates: [] }, screenshotDataUrl: 'data:image/png;base64,YQ==' }; };
  const result = await f.service.handleTool(f.task, f.run, 'observe', { screenshot: true });
  assert.equal(captures, 1); assert.equal(result.content.filter(c => c.type === 'image').length, 1);
});

test('layout observations still fetch the image when requested', async t => {
  const f = fixture(t); let captures = 0;
  f.browser.observeFast = async () => ({ ...f.task.observation, fast: { document: 'doc', guard: 'guard', candidates: [] } });
  f.browser.observe = async () => { captures++; return { ...f.task.observation, screenshotDataUrl: 'data:image/png;base64,YQ==' }; };
  const result = await f.service.handleTool(f.task, f.run, 'observe', { layout: true, screenshot: true });
  assert.equal(captures, 1); assert.equal(result.content.filter(c => c.type === 'image').length, 1);
});

test('export retains a single matching extension and preserves CSV escaping', t => {
  const f = fixture(t), { writeTaskResult } = require('../dist/main/tasks/files');
  const input = { name: 'applications.csv', format: 'csv', columns: ['value'], rows: [['=formula']] };
  const file = writeTaskResult(f.task, path.join(f.store.root, 'artifacts'), input);
  assert.equal(file.name, 'applications.csv');
  assert.match(require('node:fs').readFileSync(file.path, 'utf8'), /'=formula/);
});

test('multi-page completion accepts observed quotes, while account and reconciliation require the current page', async t => {
  const f = fixture(t);
  f.browser.observe = async () => ({ version: 'a', url: 'https://example.test/a', snapshot: '项目 A\n编号 ALPHA-27\n账号 first@example.test', fingerprint: 'a' });
  await f.service.handleTool(f.task, f.run, 'observe', {});
  f.browser.observe = async () => ({ version: 'b', url: 'https://example.test/b', snapshot: '项目 B\n编号 BETA-63', fingerprint: 'b' });
  await f.service.handleTool(f.task, f.run, 'observe', {});
  assert.equal(new TaskStore(f.store.root).get(f.task.id).evidencePages.length, 2);
  await assert.rejects(f.service.handleTool(f.task, f.run, 'verify_account', { account: 'first@example.test', evidence: '账号 first@example.test' }), /账号核对/);
  const invalid = await f.service.handleTool(f.task, f.run, 'finish', { status: 'completed', summary: 'Done', evidence: ['FAKE-RESULT'], remaining: [] });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /原文/); assert.doesNotMatch(invalid.content[0].text, /结果不明/);
  const valid = await f.service.handleTool(f.task, f.run, 'finish', { status: 'completed', summary: 'Both projects', evidence: ['编号 ALPHA-27', '编号 BETA-63'], remaining: [] });
  assert.equal(valid.isError, false); assert.equal(f.task.status, 'completed');
});

test('an uncertain submission still prevents completion using prior observed evidence', async t => {
  const f = fixture(t); f.task.needsReconciliation = true;
  const result = await f.service.handleTool(f.task, f.run, 'finish', { status: 'completed', summary: 'Done', evidence: ['记录'], remaining: [] });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /reconcile/);
});

test('read link guards ignore unrelated carousel controls but protect target identity, URL, context and attributes', () => {
  const { readLinkGuard } = require('../dist/main/tasks/fast-browser');
  const action = { kind: 'click', ref: 'e1', effect: 'read' };
  const make = (change = {}) => JSON.stringify(['https://example.test/start', 'doc1', [{ ref: 'e1', role: 'link', href: 'https://example.test/records', label: '个人中心', ...change.candidate }, { ref: change.carousel || 'e2', role: 'button' }], [change.context || '个人中心', 'carousel'], [change.attributes || '["/records?page=1"]', 'banner']]);
  const original = readLinkGuard(make(), action);
  assert.ok(original); assert.equal(original, readLinkGuard(make({ carousel: 'e999' }), action));
  for (const change of [{ candidate: { ref: 'e50' } }, { candidate: { label: '退出' } }, { attributes: '["/records?page=2"]' }, { context: '另一账号' }]) assert.notEqual(original, readLinkGuard(make(change), action));
  assert.equal(readLinkGuard(make(), { ...action, effect: 'submit' }), undefined);
  assert.equal(readLinkGuard(make({ candidate: { role: 'button' } }), action), undefined);
  assert.equal(readLinkGuard('malformed', action), undefined);
});
