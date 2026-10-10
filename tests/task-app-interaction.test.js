const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsModule } = require('./helpers/load-ts-module');
const { MessageDrafts, draftKey, messageDelivery, findTaskHit, attentionReason, messageKeyAction, ScopedOperations } = loadTsModule('src/renderer/task-interaction-model.ts');
const { taskMarkdown } = loadTsModule('src/renderer/task-rich-text.ts');
const { richTranscript, readableTask } = loadTsModule('src/renderer/task-rich-view.ts');
const { artifactPreviewMarkup, csvRows } = loadTsModule('src/renderer/task-workbench-dialogs.ts');
const { workbenchNavigation, searchSnippet } = loadTsModule('src/renderer/task-workbench-navigation.ts');
const { workbenchThread, taskQuickControls } = loadTsModule('src/renderer/task-workbench-view.ts');
const task = (patch = {}) => ({ id: 'A', title: '任务甲', prompt: '最初要求', profileId: 'native:one', profileName: '工作账户', status: 'running', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T01:00:00Z', events: [], items: [], plan: [], materials: [], attachments: [], receipts: [], usage: { actions: 0, elapsedMs: 0, costUsd: 0 }, limits: { minutes: 30, actions: 200, budgetUsd: 5 }, ...patch });
const options = (drafts = new MessageDrafts()) => ({ drafts, attachments: [], settings: { model: 'model-local', retentionDays: 30 }, hint: 'Enter 发送 · Ctrl+Enter 换行', status: '执行中', inspector: false });
function storage() { const values = new Map(); return { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) }; }

test('#3/#4 draft reload isolates task, ordinary message and each decision', () => {
  const disk = storage(), drafts = new MessageDrafts(disk);
  for (const [key, text] of [[draftKey('A', 'steer-task'), '普通草稿'], [draftKey('B', 'steer-task'), '乙草稿'], [draftKey('A', 'reply-task', 'q1'), '旧问题'], [draftKey('A', 'reply-task', 'q2'), '新问题']]) drafts.set(key, { text, attachments: [text] });
  const reloaded = new MessageDrafts(disk);
  assert.equal(reloaded.get(draftKey('A', 'steer-task')).text, '普通草稿');
  assert.deepEqual(reloaded.get(draftKey('A', 'reply-task', 'q1')).attachments, ['旧问题']);
  assert.equal(reloaded.entries('A').length, 3);
  assert.equal(reloaded.get(draftKey('B', 'reply-task', 'q1')).text, '');
});
test('#3 draft cache does not accept settings/API key forms or malformed keys', () => {
  const disk = storage(), drafts = new MessageDrafts(disk);
  drafts.set(draftKey('', 'settings-form'), { text: 'do-not-store-key' });
  drafts.set('broken', { text: 'invalid' });
  assert.equal(disk.getItem('profilepilot-message-drafts-v2'), null);
});
test('#3 cache corruption skips invalid entries while retaining later valid drafts', () => {
  const disk = storage(); disk.setItem('profilepilot-message-drafts-v2', JSON.stringify([['not-json', { text: 'bad' }], [draftKey('A', 'steer-task'), { text: 'good', attachments: [5, 'file'] }]]));
  assert.deepEqual(new MessageDrafts(disk).get(draftKey('A', 'steer-task')).attachments, ['file']);
});
test('#2/#13 successful send clears only acknowledged text and attachments', () => {
  const drafts = new MessageDrafts(), key = draftKey('A', 'steer-task');
  drafts.set(key, { text: 'old', attachments: ['sent'] }); const sent = drafts.get(key);
  drafts.set(key, { text: 'typed while sending', attachments: ['sent', 'new'] }); drafts.acknowledge(key, sent);
  assert.equal(drafts.get(key).text, 'typed while sending'); assert.deepEqual(drafts.get(key).attachments, ['new']);
});
test('#13/#56 retries keep a request id; a changed payload or decision gets a new one', () => {
  let serial = 0; const id = () => `r${++serial}`, drafts = new MessageDrafts(), key = draftKey('A', 'reply-task', 'q1');
  drafts.set(key, { text: 'reply', attachments: ['file'] });
  assert.equal(drafts.prepare(key, 'approve:once', id).requestId, 'r1');
  assert.equal(drafts.prepare(key, 'approve:once', id).requestId, 'r1');
  assert.equal(drafts.prepare(key, 'approve:session', id).requestId, 'r2');
  drafts.set(key, { text: 'different' }); assert.equal(drafts.prepare(key, 'approve:session', id).requestId, 'r3');
});
test('#56 ordinary messages during a decision always queue; terminal tasks resume', () => {
  assert.equal(messageDelivery(task({ pending: { id: 'q1' } }), 'steer'), 'queue');
  assert.equal(messageDelivery(task(), 'queue'), 'queue');
  assert.equal(messageDelivery(task(), 'steer'), 'steer');
  assert.equal(messageDelivery(task({ status: 'completed' }), 'queue'), 'resume');
});
const enter = { key: 'Enter', keyCode: 13, isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false };
test('#8 plain Enter submits once, repeated Enter is consumed', () => { assert.equal(messageKeyAction(enter, false, false), 'submit'); assert.equal(messageKeyAction({ ...enter, repeat: true }, false, false), 'consume'); });
test('#8 Windows/macOS newline modifiers and confirmation never approve via Enter', () => {
  for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) assert.equal(messageKeyAction({ ...enter, [key]: true }, false, false), 'newline');
  assert.equal(messageKeyAction(enter, false, true), 'newline');
});
test('#8 IME composition and keyCode 229 pass through without submitting', () => {
  assert.equal(messageKeyAction({ ...enter, isComposing: true }, false, false), 'ignore');
  assert.equal(messageKeyAction({ ...enter, keyCode: 229 }, false, false), 'ignore');
  assert.equal(messageKeyAction(enter, true, false), 'ignore');
});
test('#12 slow operation deduplicates only its own scope; another task completes', async () => {
  const ops = new ScopedOperations(); let finish; const waiting = ops.run('task:A', 'sending', () => new Promise(resolve => { finish = resolve; }), () => {});
  assert.equal(await ops.run('task:A', 'duplicate', async () => assert.fail('duplicate send'), () => {}), false);
  assert.equal(await ops.run('task:B', 'other task', async () => {}, () => {}), true);
  assert.equal(ops.running.has('task:A'), true); finish(); assert.equal(await waiting, true);
});
test('#13 operation errors remain available until explicit retry succeeds', async () => {
  const ops = new ScopedOperations(); let count = 0; const request = async () => { if (++count === 1) throw Error('offline'); };
  assert.equal(await ops.run('task:A', 'send', request, () => {}), false);
  assert.equal(ops.errors.get('task:A').message, 'offline');
  await ops.run('task:B', 'navigate independently', async () => {}, () => {});
  const failure = ops.errors.get('task:A'); assert.ok(failure);
  await ops.run('task:A', failure.label, failure.retry, () => {}); assert.equal(ops.errors.size, 0);
});
test('#14 search finds followup, old result, item evidence and page snapshot', () => {
  const value = task({ events: [{ id: 'u2', kind: 'user', text: '后续 unique-followup' }, { id: 'old', kind: 'assistant', text: '上次执行结果：{"summary":"past-output"}' }], items: [{ id: 'i1', label: 'item', evidence: 'row-evidence' }], evidencePages: [{ title: 'page', url: 'https://example.com', snapshot: 'hidden-page-text' }] });
  assert.equal(findTaskHit(value, 'UNIQUE-FOLLOWUP').id, 'event-u2');
  assert.equal(findTaskHit(value, 'past-output').id, 'event-old');
  assert.equal(findTaskHit(value, 'row-evidence').id, 'item-i1');
  assert.equal(findTaskHit(value, 'hidden-page-text').id, 'task-evidence');
  assert.match(searchSnippet(value, 'unique-followup').html, /<mark>unique-followup<\/mark>/);
});
test('#15 attention includes questions, handoff, failure and unread completion', () => {
  assert.equal(attentionReason(task({ pending: { kind: 'handoff' } })), '需要接管');
  assert.equal(attentionReason(task({ pending: { kind: 'confirmation' } })), '等待确认');
  assert.equal(attentionReason(task({ status: 'failed' })), '执行失败');
  assert.equal(attentionReason(task({ status: 'completed' })), '完成未读');
  assert.equal(attentionReason(task({ status: 'completed' }), '2026-09-27T02:00:00Z'), '');
  assert.equal(attentionReason(task({ archivedAt: 'today', status: 'failed' })), '');
});
test('#16 markdown creates heading, list, quote, code and scrollable table', () => {
  const html = taskMarkdown('# 标题\n\n1. 一\n2. 二\n\n> 引用\n\n```js\nlet x = "<tag>";\n```\n\n| A | B |\n| --- | --- |\n| a | b |');
  for (const pattern of [/<h1>标题<\/h1>/, /<ol>/, /<blockquote>/, /data-copy-code/, /&lt;tag&gt;/, /class="task-table-scroll"/, /<th scope="col">A<\/th>/]) assert.match(html, pattern);
});
test('#16 markdown escapes HTML, disallows script/data/file URLs and remote images', () => {
  const html = taskMarkdown('<img src=x onerror=alert(1)>\n[bad](javascript:alert(1)) [data](data:text/html,evil) [file](file:///secret)\n![pixel](https://example.com/track)');
  assert.doesNotMatch(html, /<(?:img|script|iframe|object)\b|href="(?:javascript|data|file):/i);
  assert.match(html, /&lt;img/);
});
test('#16 arbitrary quotes inside a safe link cannot add HTML attributes', () => {
  const html = taskMarkdown('[safe](https://example.com/"onclick="evil)');
  assert.doesNotMatch(html, /"onclick="evil/); assert.match(taskMarkdown('[site](https://example.com)'), /data-task-link/);
});
test('#17/#27 old result parses as a rich answer and diagnostics stay grouped', () => {
  const oldResult = { summary: '## Previous result', evidence: ['source'], remaining: ['next'] };
  const value = task({ events: [{ id: 's', kind: 'system', text: 'step', at: '2026-09-27' }, { id: 'a', kind: 'action', text: 'tool', at: '2026-09-27' }, { id: 'r', kind: 'assistant', text: `上次执行结果：${JSON.stringify(oldResult)}`, at: '2026-09-27' }] });
  const html = richTranscript(value); assert.match(html, /<details class="tool-group task-process-group"/); assert.match(html, /2 条记录/); assert.match(html, /<h2>Previous result<\/h2>/); assert.doesNotMatch(html, /上次执行结果：|&quot;summary&quot;/);
  assert.match(readableTask(value), /Previous result/); assert.doesNotMatch(readableTask(value), /"summary"/);
});
test('#18 CSV preserves quoted commas, embedded newlines and escaped quotes', () => {
  assert.deepEqual(csvRows('name,note\r\n"A,B","line1\nline2 ""ok"""\r\n'), [['name', 'note'], ['A,B', 'line1\nline2 "ok"']]);
  assert.match(artifactPreviewMarkup({ name: 'test.csv', mime: 'text/csv', text: 'A,B\n<script>,x' }), /&lt;script&gt;/);
});
test('#18 image preview only accepts inert raster data URLs; PDF shows text plus scan', () => {
  assert.match(artifactPreviewMarkup({ name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }), /<img /);
  assert.doesNotMatch(artifactPreviewMarkup({ name: 'a.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AAAA' }), /<img /);
  const pdf = artifactPreviewMarkup({ name: 'a.pdf', mime: 'application/pdf', text: '<script> extracted', dataUrl: 'data:image/png;base64,AAAA' });
  assert.match(pdf, /<img /); assert.match(pdf, /PDF 文字预览/); assert.match(pdf, /&lt;script&gt;/);
});
test('#18 HTML preview is inert escaped text even if content has scripts', () => {
  const html = artifactPreviewMarkup({ name: 'unsafe.html', mime: 'text/plain', text: '<script>alert(1)</script>' }); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});
test('#1/#4/#28 controls stay outside inspector, summary and separate reply + ordinary composer coexist', () => {
  const html = workbenchThread(task({ pending: { id: 'q1', kind: 'confirmation', title: 'Approve?', details: 'details' } }), options());
  assert.match(taskQuickControls(task()), /data-control="cancel"/);
  assert.doesNotMatch(html.slice(html.indexOf('<aside'), html.indexOf('</aside>')), /data-control="cancel"/);
  assert.match(html, /class="task-thread-status"/); assert.match(html, /class="task-decision-card"/);
  assert.match(html, /id="reply-task"/); assert.match(html, /id="task-chat-composer"/); assert.match(html, /data-decision-id="q1"/);
  assert.doesNotMatch(html, /id="task-evidence"/);
  const withEvidence = workbenchThread(task({ evidencePages: [{ title: 'Source', url: 'https://example.com', snapshot: 'Observed text' }] }), options());
  assert.doesNotMatch(withEvidence, /id="task-evidence"|Observed text/);
  assert.doesNotMatch(withEvidence, /任务操作与记录|模型与运行状态|执行步骤与运行情况|执行记录与资料版本/);
  assert.match(withEvidence, /<dialog id="task-session-settings"/);
});
test('#2/#24/#56/#57 followup has files/context/queue and scoped approval/revoke entry', () => {
  const html = workbenchThread(task({ pending: { id: 'q1', kind: 'confirmation', title: 'scope', details: '', permissionScope: { kind: 'browser', label: 'write', scope: 'https://example.com' } }, permissionRules: [{ id: 'rule1', label: 'site writes', scope: 'example.com' }], messageQueue: [{ id: 'm1', message: 'queued', attachmentIds: ['a'], createdAt: '' }] }), options());
  assert.equal((html.match(/data-action="attach-message"/g) || []).length, 1, 'decision attachments remain outside the React composer');
  for (const pattern of [/id="task-chat-composer"/, /data-edit-queued="m1"/, /data-remove-queued="m1"/, /value="session"/, /data-revoke-permission="rule1"/]) assert.match(html, pattern);
});
test('#19 keyboard users can read disabled takeover reason in ordinary text', () => {
  const html = workbenchThread(task(), options()); assert.match(html, /disabled aria-describedby="task-takeover-reason"/); assert.match(html, /id="task-takeover-reason">任务连接浏览器后可接管/);
});
test('#26 pin and status coexist with Profile/time/status metadata', () => {
  const html = workbenchNavigation([task({ pinnedAt: '2026-09-27' })], 'A', { running: '执行中' }, {});
  for (const pattern of [/recent-document[^>]*aria-label="执行中"/, /class="task-pin"/, /class="recent-task-copy"/, /class="recent-meta"/, /工作账户/]) assert.match(html, pattern);
});
test('#61/#64/#65 stream keeps its mount without redundant lifecycle notices', () => {
  const html = workbenchThread(task(), { ...options(), stream: { id: 's', text: '**streaming**', updatedAt: '' } });
  assert.match(html, /id="task-chat"[^>]*data-task-chat-owned/);
  assert.doesNotMatch(html, /task-retention-note|task-lifecycle-note|默认保留 30 天/);
});
test('#13/#17 terminal tasks without a saved result still explain completion state', () => {
  assert.match(richTranscript(task({ status: 'failed' })), /尚无完整核实结果/);
  assert.match(richTranscript(task({ status: 'completed' })), /未保存结果摘要/);
});
test('identical answer event and final result render once while keeping result anchor and copy action', () => {
  const value = task({ status: 'completed', events: [{ id: 'answer', kind: 'assistant', text: '已准备好，开始处理。' }], result: { kind: 'answer', summary: '已回答：已准备好，开始处理。', evidence: [], remaining: [] } });
  const html = richTranscript(value);
  assert.equal((html.match(/<p>已准备好，开始处理。<\/p>/g) || []).length, 1);
  assert.equal((html.match(/id="task-result"/g) || []).length, 1);
  assert.match(html, /task-final-answer/); assert.match(html, /data-copy-message="result"/);
  assert.doesNotMatch(html, /未保存结果摘要/);
  const withRemaining = richTranscript(task({ ...value, result: { ...value.result, remaining: ['仍需确认'] } }));
  assert.equal((withRemaining.match(/<p>已准备好，开始处理。<\/p>/g) || []).length, 1);
  assert.match(withRemaining, /仍需确认/);
  const verified = richTranscript(task({ ...value, result: { ...value.result, kind: 'verified', summary: '已准备好，开始处理。' } }));
  assert.equal((verified.match(/<p>已准备好，开始处理。<\/p>/g) || []).length, 2);
});
test('resume folds only an adjacent saved pure answer, retaining its event anchor and actions', () => {
  const answer = '## 检查结果\n\n已准备好。';
  const events = [
    { id: 'original', kind: 'assistant', text: answer, at: '2026-09-27T01:00:00Z' },
    { id: 'saved', kind: 'assistant', text: answer, at: '2026-09-27T02:00:00.000Z' },
    { id: 'followup', kind: 'user', text: '继续处理', at: '2026-09-27T02:00:00.001Z' },
    { id: 'resume', kind: 'system', text: '继续对话；需要浏览器操作时先重新观察。', at: '2026-09-27T02:00:00.002Z' }
  ];
  const html = richTranscript(task({ events }));
  assert.equal((html.match(/<h2>检查结果<\/h2>/g) || []).length, 1);
  assert.equal((html.match(/id="event-saved"/g) || []).length, 1);
  assert.match(html, /data-copy-message="saved"/); assert.match(html, /data-quote-message="saved"/);
  const withRemaining = richTranscript(task({ events: [{ ...events[0] }, { ...events[1], text: `已回答：${answer}\n待完成：确认资料` }, ...events.slice(2)] }));
  assert.equal((withRemaining.match(/<h2>检查结果<\/h2>/g) || []).length, 1);
  assert.match(withRemaining, /待完成：确认资料/);
  const ordinaryRepeat = richTranscript(task({ events: events.slice(0, 3) }));
  assert.equal((ordinaryRepeat.match(/<h2>检查结果<\/h2>/g) || []).length, 2);
  const repeatedUser = richTranscript(task({ events: [{ ...events[2], id: 'u1' }, { ...events[2], id: 'u2' }] }));
  assert.equal((repeatedUser.match(/继续处理/g) || []).length, 2);
});
test('compact followup is only offered for terminal tasks without a pending decision or queue', () => {
  assert.match(workbenchThread(task({ status: 'completed' }), options()), /class="task-detail[^"]*is-terminal/);
  assert.match(workbenchThread(task({ status: 'completed' }), options()), /id="task-thread-end"/);
  assert.doesNotMatch(workbenchThread(task({ status: 'completed', messageQueue: [{ id: 'q', message: 'later', attachmentIds: [], createdAt: '' }] }), options()), /is-terminal/);
  assert.doesNotMatch(workbenchThread(task({ status: 'waiting_user', pending: { id: 'p', kind: 'question', title: 'Question', details: '' } }), options()), /is-terminal/);
});
test('#2 questions require a written answer; attachments never approve an unanswered question', () => {
  const html = workbenchThread(task({ pending: { id: 'q', kind: 'question', title: 'Need a choice', details: '' } }), options());
  assert.match(html, /name="answer" id="answer" required/);
  assert.doesNotMatch(html, /name="steering"[^>]*required/);
});
