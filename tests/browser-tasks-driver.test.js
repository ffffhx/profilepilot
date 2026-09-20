const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { actionQuestions, parseActionDecision, chooseJevAction } = require('../dist/main/tasks/jev-actions');
const { taskHelper } = require('../dist/main/tasks/task-helper');
const { effectiveEffect } = require('../dist/main/tasks/browser');

const candidates = [{ ref: 'e1', role: 'textbox', label: '姓名', kind: 'fill', value: '' }, { ref: 'e2', role: 'button', label: '提交', kind: 'click', submit: true }];
const questions = actionQuestions(candidates);
const answer = (head, selected) => ({ type: 'choice', choice: selected, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(questions[head].criteria).map(k => [k, k === selected ? 1 : 0])) });
test('dynamic questions expose only supported operations and actual targets; only the selected target head is consumed', () => {
  assert.equal(questions.operation.criteria.SELECT, undefined);
  const parsed = parseActionDecision({ operation: answer('operation', 'CLICK'), click_target: answer('click_target', 'e2'), type_target: { malicious: true } }, questions);
  assert.equal(parsed.target, 'e2'); assert.equal(parsed.operation, 'CLICK');
});
test('unknown targets, malformed distributions, wrong maxima, low confidence cannot produce actions', () => {
  for (const corrupt of [a => a.click_target.choice = 'e99', a => a.operation.probabilities.CLICK = NaN, a => delete a.operation.probabilities.DONE, a => { a.operation.probabilities.CLICK = 0.1; a.operation.probabilities.DONE = 0.9; }]) {
    const a = { operation: answer('operation', 'CLICK'), click_target: answer('click_target', 'e2') }; corrupt(a); assert.throws(() => parseActionDecision(a, questions));
  }
  const a = { operation: answer('operation', 'CLICK'), click_target: answer('click_target', 'e2') }; a.operation.confidence = 0.4;
  assert.equal(parseActionDecision(a, questions).operation, undefined);
});
test('API failure is redacted and is never an executable decision', async () => {
  const task = { prompt: 'fill', authorization: '', events: [], receipts: [] };
  const result = await chooseJevAction('secret-key', task, { url: 'https://test.test/?token=secret-url', snapshot: '', fast: { candidates } }, { provider: 'typesafe', signal: new AbortController().signal, fetch: async (_url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.body.includes('secret-url'), false); return new Response('secret-key', { status: 429 });
  } });
  assert.equal(result.operation, undefined); assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('default form submit buttons are classified as submissions, history links remain reads', () => {
  const obs = { fast: { candidates: [{ ref: 'e1', submit: true }] }, snapshot: '- button "继续" [ref=e1]' };
  assert.equal(effectiveEffect({ kind: 'click', ref: 'e1', effect: 'read' }, obs), 'submit');
  assert.equal(effectiveEffect({ kind: 'click', ref: 'e2', effect: 'read' }, { snapshot: '- link "提交记录" [ref=e2]' }), 'read');
});

async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-driver-'));
  const store = new TaskStore(root);
  Object.assign(store.data.settings, { jevMode: 'driver', jevEnabled: true, jevProvider: 'typesafe', notifications: false });
  let value = '', executions = 0, helperCalls = 0, workerCalls = 0, decisions = 0;
  const controls = [];
  const observe = async () => ({ version: `v${executions}`, fingerprint: `f${executions}`, url: 'https://example.test/form', at: new Date().toISOString(), title: 'Form', account: 'unknown', snapshot: `姓名 ${value}\n提交成功\n- button "提交" [ref=e2]`, fast: { document: 'd', guard: `g${executions}`, candidates: candidates.map(c => c.ref === 'e1' ? { ...c, value } : c) } });
  const browser = { observe, observeFast: observe, execute: async (_t, a) => { executions++; if (a.kind === 'fill') value = a.value; return 'executed'; }, control: async (_t, a) => controls.push(a), tabs: async () => [] };
  const service = new TaskService(store, { browser, apiKey: () => 'main', jevApiKey: () => 'jev', profileName: async () => 'Test', prepareProfile: async () => ({ name: 'Test', port: 9227 }), changed: () => {}, notify: () => {},
    worker: () => { workerCalls++; throw new Error('fallback reached'); },
    chooseJev: async (...args) => { decisions++; return options.choose ? options.choose(...args) : { operation: executions ? 'DONE' : 'TYPE_TEXT', target: 'e1', inputTokens: 10, elapsedMs: 2 }; },
    taskHelper: async (...args) => { helperCalls++; return { result: options.helper ? await options.helper(...args) : args[4] === 'fields' ? { fields: [{ ref: 'e1', text: '张三', source: '张三' }], question: '' } : { complete: true, summary: '已填写张三', evidence: ['姓名 张三'], remaining: [] }, inputTokens: 20, outputTokens: 10, elapsedMs: 3 }; }
  });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const task = await service.create({ profileId: 'isolated:test', prompt: '将姓名填写张三，不提交' });
  return { store, task, service, browser, controls, counts: () => ({ executions, helperCalls, workerCalls, decisions }) };
}
async function drained(f) { for (let i = 0; i < 200 && f.service.runs.has(f.task.id); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(f.service.runs.has(f.task.id), false); }
test('Jev executes a fill and independently verifies completion without spawning SDK; releases browser', async t => {
  const f = await fixture(t); await drained(f);
  assert.equal(f.task.status, 'completed'); assert.deepEqual(f.counts(), { executions: 1, helperCalls: 2, workerCalls: 0, decisions: 2 });
  assert.equal(f.task.usage.jevActions, 1); assert.equal(f.task.usage.helper.calls, 2); assert.ok(f.controls.includes('complete'));
});
test('Jev cannot bypass submit confirmation and no submission happens while waiting', async t => {
  const f = await fixture(t, { choose: async () => ({ operation: 'CLICK', target: 'e2', inputTokens: 1, elapsedMs: 1 }) }); await drained(f);
  assert.equal(f.task.status, 'waiting_user'); assert.equal(f.task.pending.kind, 'confirmation'); assert.equal(f.counts().executions, 0); assert.equal(f.counts().workerCalls, 0);
});
test('pause aborts an in-flight Jev request and drains the run without fallback or action', async t => {
  let entered; const started = new Promise(r => entered = r);
  const f = await fixture(t, { choose: async (_k, _t, _o, opts) => { entered(); return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })); } });
  await started; await f.service.control(f.task.id, 'pause'); await drained(f);
  assert.equal(f.task.status, 'paused'); assert.equal(f.counts().executions, 0); assert.equal(f.counts().workerCalls, 0); assert.ok(f.controls.includes('handoff'));
});
test('uncertain Jev delegates once to the existing SDK with no speculative browser action', async t => {
  const f = await fixture(t, { choose: async () => ({ inputTokens: 1, elapsedMs: 1, note: 'uncertain' }) }); await drained(f);
  assert.equal(f.counts().workerCalls, 1); assert.equal(f.counts().executions, 0);
});
test('uncertainty after progress gets independent verification without another action or SDK startup', async t => {
  let calls = 0;
  const f = await fixture(t, { choose: async () => ++calls === 1 ? { operation: 'TYPE_TEXT', target: 'e1', inputTokens: 1, elapsedMs: 1 } : { inputTokens: 1, elapsedMs: 1, note: 'uncertain' } }); await drained(f);
  assert.equal(f.task.status, 'completed'); assert.equal(f.counts().workerCalls, 0); assert.equal(f.counts().helperCalls, 2); assert.equal(f.counts().executions, 1);
});
test('DONE cannot complete with fabricated evidence or unfinished requirements', async t => {
  for (const result of [{ complete: true, summary: 'done', evidence: ['invented receipt'], remaining: [] }, { complete: true, summary: 'done', evidence: ['提交成功'], remaining: ['upload attachment'] }, { complete: false, summary: 'not done', evidence: ['提交成功'], remaining: [] }]) {
    const f = await fixture(t, { choose: async () => ({ operation: 'DONE', inputTokens: 1, elapsedMs: 1 }), helper: async () => result }); await drained(f);
    assert.notEqual(f.task.status, 'completed'); assert.equal(f.counts().workerCalls, 1); assert.equal(f.counts().executions, 0);
  }
});
test('missing personal information asks user instead of inventing a fill', async t => {
  const f = await fixture(t, { helper: async () => ({ fields: [], question: '请提供姓名' }) }); await drained(f);
  assert.equal(f.task.pending.kind, 'question'); assert.equal(f.counts().executions, 0); assert.equal(f.counts().workerCalls, 0);
});
test('confirmation uses fresh fast observation and changed facts invalidate approval', async t => {
  const f = await fixture(t, { choose: async () => ({ operation: 'CLICK', target: 'e2', inputTokens: 1, elapsedMs: 1 }) }); await drained(f);
  const id = f.task.pending.id; f.service.tick = async () => {};
  const old = f.browser.observeFast;
  f.browser.observeFast = async task => ({ ...await old(task), fingerprint: 'changed' });
  await f.service.reply(f.task.id, id, '', true);
  assert.equal(f.counts().executions, 0); assert.equal(f.task.pending, undefined); assert.equal(f.task.status, 'queued');
});
test('explicit approval of unchanged fast observation executes only once', async t => {
  const f = await fixture(t, { choose: async () => ({ operation: 'CLICK', target: 'e2', inputTokens: 1, elapsedMs: 1 }) }); await drained(f);
  const id = f.task.pending.id; f.service.tick = async () => {};
  await f.service.reply(f.task.id, id, '', true);
  await assert.rejects(f.service.reply(f.task.id, id, '', true), /已失效/);
  assert.equal(f.counts().executions, 1);
});
test('helper uses configured Anthropic authentication and rejects unsupported personal information', async () => {
  const task = { prompt: '姓名张三', authorization: '', materials: [], events: [], receipts: [] };
  const obs = { url: 'https://example.test', title: 'Form', snapshot: '', fast: { candidates } };
  let supported = true;
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.moonshot.cn/anthropic/v1/messages'); assert.equal(init.headers.authorization, 'Bearer protected'); assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ fields: [{ ref: 'e1', text: supported ? '张三' : '李四', source: supported ? '张三' : '李四' }], question: '' }) }], usage: { input_tokens: 12, output_tokens: 3 } }));
  };
  const settings = { baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3' };
  const good = await taskHelper('protected', settings, task, obs, 'fields', new AbortController().signal, fetch); assert.equal(good.result.fields[0].text, '张三');
  supported = false; await assert.rejects(taskHelper('protected', settings, task, obs, 'fields', new AbortController().signal, fetch), /主模型辅助请求未成功/);
});
