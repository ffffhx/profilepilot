const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { ReviewService } = loadCli('src/main/review/service.ts');
const { reviewWindow, wallTime } = loadCli('src/main/review/schedule.ts');
const { collectReviewSources, transcriptRecord, redactReviewText } = loadCli('src/main/review/sources.ts');
const { validateReviewAnswer, analyzeReview } = loadCli('src/main/review/analyze.ts');

const settings = { enabled: true, time: '21:00', timezone: 'Asia/Shanghai', weeklyDay: 0, sources: { trace: false, profilepilot: true, codex: false, claude: false } };
const model = { baseUrl: 'https://example.test', model: 'test-model', hasApiKey: true };
const at = '2026-11-15T12:00:00.000Z';
const task = () => ({ id: 'task-one', title: '连接工具', prompt: '连接后读取状态', createdAt: at, updatedAt: at, events: [
  { id: 'event-one', at, kind: 'user', text: '先检查连接，不要重复重试。' },
  { id: 'event-two', at, kind: 'assistant', text: '检查后已成功连接，状态已核实。' }
] });
const answer = input => ({ summary: '根据可读片段，连接前检查可以复用。', findings: [{ key: 'browser.connection-check', kind: 'workflow', title: '连接前检查', observation: '一次任务中检查后成功。', suggestion: '先查连接再操作。', verification: '下次记录重试次数。', evidenceIds: [input.evidence[0].id], confidence: 'high', workflow: { when: '连接工具时', inputs: ['目标标识'], steps: ['检查状态', '连接并核实'], exceptions: ['接管时等待用户交还'], done: '读取到目标状态' } }] });
function fixture(t, custom = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-15T13:10:00Z'), calls = 0;
  const dependencies = { home: root, codexDirectory: path.join(root, 'codex'), claudeDirectory: path.join(root, 'claude'), traceRoot: root,
    tasks: () => [task()], settings: () => model, apiKey: () => 'fixture-secret', clock: () => clock,
    analyze: async input => { calls++; return validateReviewAnswer(answer(input), input); }, ...custom };
  const service = new ReviewService(root, dependencies);
  t.after(() => service.close());
  return { root, dependencies, service, advance: delta => { clock += delta; }, calls: () => calls };
}

test('wall-clock windows handle Shanghai, DST gaps, repeated hours and weekly boundaries', () => {
  const window = reviewWindow(settings, 'daily', Date.parse('2026-11-15T12:59:59Z'));
  assert.equal(window.key, 'daily:2026-11-14');
  assert.equal(new Date(window.until).toISOString(), '2026-11-14T13:00:00.000Z');
  const weekly = reviewWindow(settings, 'weekly', Date.parse('2026-11-15T13:00:00Z'));
  assert.equal(weekly.key, 'weekly:2026-11-15');
  assert.equal(weekly.until - weekly.from, 7 * 86400000);
  assert.equal(new Date(wallTime('2026-03-08', '02:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  const fall = { ...settings, time: '01:30', timezone: 'America/New_York' };
  assert.equal(reviewWindow(fall, 'daily', Date.parse('2026-11-01T05:45:00Z')).key, reviewWindow(fall, 'daily', Date.parse('2026-11-01T06:45:00Z')).key);
});

test('extracts visible Codex/Claude records only, redacts credentials and skips partial/out-of-window rows', async t => {
  const f = fixture(t);
  const codex = path.join(f.root, 'codex', '2026', '11', '15');
  const claude = path.join(f.root, 'claude', '中文 project');
  fs.mkdirSync(codex, { recursive: true }); fs.mkdirSync(claude, { recursive: true });
  const codexRow = (channel, text, timestamp = at) => ({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text }] } });
  fs.writeFileSync(path.join(codex, 'rollout-test.jsonl'), [codexRow('analysis', 'HIDDEN_REASONING'), codexRow('final', '已完成，password="very-secret"；https://u:p@example.test/page?token=secret'), codexRow('final', 'OLD_RECORD', '2020-01-01T00:00:00Z')].map(JSON.stringify).join('\n') + '\n{"type":');
  fs.writeFileSync(path.join(claude, 'session.jsonl'), JSON.stringify({ timestamp: at, type: 'user', message: { content: '请核对中文路径。' } }) + '\n');
  for (const file of [path.join(codex, 'rollout-test.jsonl'), path.join(claude, 'session.jsonl')]) fs.utimesSync(file, new Date(at), new Date(at));
  const result = await collectReviewSources({ ...settings, sources: { ...settings.sources, codex: true, claude: true } }, Date.parse(at) - 1000, Date.parse(at) + 1000, f.dependencies);
  assert.equal(result.evidence.filter(row => row.source === 'codex').length, 1);
  assert.equal(result.evidence.filter(row => row.source === 'claude').length, 1);
  const serialized = JSON.stringify(result);
  for (const secret of ['HIDDEN_REASONING', 'very-secret', 'token=secret', 'u:p@', 'OLD_RECORD']) assert.equal(serialized.includes(secret), false, secret);
  assert.ok(result.evidence.some(row => row.text.includes('中文路径')));
  assert.equal(transcriptRecord({ timestamp: at, type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'SECRET_REASONING' }] } }, 'claude'), undefined);
  assert.equal(transcriptRecord({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call_output', output: { content: [{ type: 'text', text: '已恢复连接' }, { type: 'image', data: 'PRIVATE_IMAGE' }] } } }, 'codex').text, '工具结果：已恢复连接');
  assert.equal(redactReviewText('Authorization: Bearer super-secret-access-token').includes('super-secret'), false);
  const sampleSecrets = [
    'postgres://dbadmin:SuperSecret123@db.internal:5432/prod?sslmode=require',
    'redis://:redisPass999@cache.local:6379/0#primary',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
    'ghp_1234567890abcdef1234567890abcdef',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretkeybytes\n-----END RSA PRIVATE KEY-----'
  ].join('\n');
  const scrubbedSecrets = redactReviewText(sampleSecrets);
  for (const leaked of ['SuperSecret123', 'sslmode=require', 'redisPass999', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'sk-ant-api03', 'AIzaSyDaGmWKa4JsXZ', 'ghp_1234567890', 'MIIEpAIBAAKCAQEAsecretkeybytes']) {
    assert.equal(scrubbedSecrets.includes(leaked), false, `expected ${leaked} to be redacted`);
  }
  assert.match(scrubbedSecrets, /postgres:\/\/db\.internal:5432\/prod/);
});

test('saveAsTemplate converts workflow findings into device-ready reusable task templates and records usage callbacks', async t => {
  const savedTemplates = [];
  const usageEntries = [];
  const f = fixture(t, {
    saveTemplate: input => {
      const entry = { id: 'tpl-1', ...input, updatedAt: at };
      savedTemplates.push(entry);
      return entry;
    },
    onUsage: entry => usageEntries.push(entry),
    analyze: async input => ({
      ...validateReviewAnswer(answer(input), input),
      usage: { inputTokens: 320, outputTokens: 140 },
      model: 'deepseek-chat'
    })
  });
  const report = await f.service.run('daily');
  assert.equal(usageEntries.length, 1);
  assert.equal(usageEntries[0].inputTokens, 320);
  assert.equal(usageEntries[0].outputTokens, 140);
  assert.equal(usageEntries[0].model, 'deepseek-chat');
  const template = f.service.saveAsTemplate(report.id, report.findings[0].id);
  assert.equal(savedTemplates.length, 1);
  assert.equal(template.name, '连接前检查');
  assert.equal(template.task.profileId, '__device__');
  assert.match(template.task.prompt, /适用场景：连接工具时/);
  assert.match(template.task.prompt, /执行步骤：\n1\. 检查状态\n2\. 连接并核实/);
  assert.match(template.task.prompt, /完成标准：读取到目标状态/);
});

test('rejects invented evidence and workflows from counts, keeps single-task workflows provisional', () => {
  const input = { kind: 'daily', evidence: [{ id: 'real', source: 'codex', session: 'one' }], known: [], coverage: [], recentSummaries: [] };
  const result = validateReviewAnswer(answer(input), input);
  assert.equal(result.findings[0].confidence, 'low');
  assert.match(result.findings[0].id, /^[a-f0-9]{24}$/);
  const bad = answer(input); bad.findings[0].evidenceIds = ['invented'];
  assert.throws(() => validateReviewAnswer(bad, input), /不存在/);
  assert.throws(() => validateReviewAnswer(answer(input), { ...input, evidence: [{ id: 'real', source: 'trace' }] }), /计数不足/);
});

test('daily/weekly automation persists once, honors feedback, exports drafts and does not change agent instructions', async t => {
  const f = fixture(t);
  await f.service.tick(); assert.equal(f.calls(), 0, 'opt-in starts disabled');
  f.service.configure(settings);
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.calls(), 2, 'one daily and one weekly run');
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.reports.length, 2);
  const report = f.service.report(snapshot.reports[0].id);
  assert.equal(report.findings.length, 1);
  f.service.feedback(report.id, report.findings[0].id, 'dismissed', '已经有方案');
  const next = await f.service.run('daily');
  assert.equal(next.findings.length, 0);
  assert.equal(next.suppressed, 1);
  const draft = f.service.exportWorkflow(report.id, report.findings[0].id);
  assert.ok(fs.readFileSync(draft.path, 'utf8').includes('尚未安装'));
  assert.equal(fs.existsSync(path.join(f.root, 'AGENTS.md')), false);
  const restarted = new ReviewService(f.root, f.dependencies); t.after(() => restarted.close());
  const calls = f.calls(); await restarted.tick(); assert.equal(f.calls(), calls);
  assert.equal(restarted.snapshot().feedback[0].value, 'dismissed');
  assert.throws(() => f.service.report('../../outside'), /Invalid|无效/);
  assert.throws(() => f.service.configure({ timezone: 'Not/A_Zone' }));
});

test('missed days are combined, failed model requests back off and retry after restart', async t => {
  const f = fixture(t);
  f.service.configure(settings); await f.service.tick();
  f.advance(3 * 86400000); await f.service.tick();
  const report = f.service.snapshot().reports[0];
  assert.equal(Date.parse(report.until) - Date.parse(report.from), 3 * 86400000);
  const bad = fixture(t, { analyze: async () => { throw new Error('模型连接失败'); } });
  bad.service.configure(settings); await bad.service.tick();
  assert.equal(bad.service.snapshot().reports[0].status, 'failed');
  const index = JSON.parse(fs.readFileSync(path.join(bad.service.directory, 'index.json'), 'utf8'));
  assert.equal(index.attempts['daily:2026-11-15'].count, 1);
  await bad.service.tick();
  assert.equal(bad.service.snapshot().reports.filter(row => row.kind === 'daily').length, 1);
  bad.advance(3600001); await bad.service.tick();
  const retried = JSON.parse(fs.readFileSync(path.join(bad.service.directory, 'index.json'), 'utf8'));
  assert.equal(retried.attempts['daily:2026-11-15'].count, 2);
});

test('empty input needs no model; damaged indexes are preserved and do not break task service initialization', async t => {
  const f = fixture(t, { tasks: () => [], apiKey: () => { throw new Error('must not read key'); } });
  f.service.configure(settings);
  const report = await f.service.run('daily');
  assert.equal(report.findings.length, 0); assert.equal(f.calls(), 0);
  const file = path.join(f.service.directory, 'index.json'); fs.writeFileSync(file, 'broken-data');
  const broken = new ReviewService(f.root, f.dependencies); t.after(() => broken.close());
  assert.match(broken.snapshot().error, /原文件已保留/);
  assert.throws(() => broken.configure(settings));
  await broken.tick(); assert.equal(fs.readFileSync(file, 'utf8'), 'broken-data');
});

test('closing cancels analysis and disables overlapping runs', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { analyze: (_input, _settings, _key, signal) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  f.service.configure(settings);
  const pending = f.service.run('daily');
  await ready;
  await assert.rejects(f.service.run('weekly'), /已有复盘/);
  const failed = assert.rejects(pending, /应用退出/);
  await f.service.close(); await failed;
  assert.equal(f.service.snapshot().running, false);
});

test('analysis uses existing provider, omits local paths, never exposes tool execution, rejects incomplete results', async () => {
  const input = { kind: 'daily', from: at, until: at, evidence: [{ id: 'real', source: 'codex', session: 'one', location: 'C:/private/path' }], coverage: [], known: [], recentSummaries: [] };
  let request;
  const transport = async (url, init) => { request = { url, init, body: JSON.parse(init.body) }; return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer(input)) }], usage: { input_tokens: 10, output_tokens: 20 } }); };
  const result = await analyzeReview(input, model, 'fixture-key', new AbortController().signal, transport);
  assert.equal(request.url, 'https://example.test/v1/messages');
  assert.equal(request.body.tools, undefined);
  assert.equal(request.init.body.includes('C:/private/path'), false);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
  await assert.rejects(analyzeReview(input, model, 'key', new AbortController().signal, async () => Response.json({ stop_reason: 'max_tokens' })), /长度限制/);
  await analyzeReview(input, { ...model, baseUrl: 'https://api.deepseek.com/anthropic' }, 'fixture-key', new AbortController().signal, transport);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
});

test('notification failures cannot cause a completed report to be retried', async t => {
  const f = fixture(t, { notify: () => { throw new Error('notifications unavailable'); } });
  f.service.configure(settings);
  await f.service.tick(); await f.service.tick();
  assert.equal(f.calls(), 2);
  assert.ok(f.service.snapshot().reports.every(report => report.status === 'complete'));
});

test('trace review spans control routes and excludes explicit verification samples', async t => {
  const f = fixture(t);
  const directory = path.join(f.root, 'control-diagnostics'); fs.mkdirSync(directory);
  for (const route of ['extension', 'gateway', 'electron', 'desktop', 'phone', 'gpui', 'remote']) {
    const row = { at, route, scope: 'cli', ok: false, method: 'observe', taskKind: 'real', durationMs: 10, code: 'NEEDS_USER', requiresUser: true };
    fs.writeFileSync(path.join(directory, `cli-${route}.jsonl`), JSON.stringify(row) + '\n' + JSON.stringify({ ...row, taskKind: 'verification' }) + '\n');
  }
  const result = await collectReviewSources({ ...settings, sources: { trace: true, profilepilot: false, codex: false, claude: false } }, Date.parse(at) - 1000, Date.parse(at) + 1000, f.dependencies);
  assert.equal(result.evidence.length, 7);
  assert.equal(result.coverage[0].records, 7);
  assert.match(result.coverage[0].note, /排除 7/);
  assert.ok(result.evidence.every(row => row.text.includes('需用户操作不等于缺陷')));
});
