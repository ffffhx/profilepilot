const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { performance } = require('node:perf_hooks');
const { loadCli } = require('./cli-test-build.cjs');
const { InputEditor } = loadCli('src/main/cli/editor.ts');
const { TerminalUI, renderTerminalFrame, stripAnsi, textWidth } = loadCli('src/main/cli/terminal.ts');
const { ShellTextDecoder } = loadCli('src/main/cli/shell-output.ts');
const { parseAgentCliArgs, runAgentCli, agentCliHelp } = loadCli('src/main/profilepilot-agent-cli.ts');
const key = (editor, name, options = {}) => editor.handleKey(undefined, { name, ...options });
const base = () => ({ input: { text: 'draft', cursor: 5 }, messages: [], showWelcome: false, model: 'model-A', profile: 'profile-A', mode: 'manual' });
const plain = frame => frame.lines.map(stripAnsi).join('\n');

test('#35 incremental UTF-8 and CLIXML decoder tolerates every byte boundary', () => {
  const input = Buffer.from('普通中文🙂#< CLIXML\r\n<Objs><S S="Error">错误 &amp; _xD83D__xDE42__x000D__x000A_</S><S S="Warning">警告</S></Objs>后续文本', 'utf8');
  for (let split = 0; split <= input.length; split++) {
    const decoder = new ShellTextDecoder(true);
    assert.equal(decoder.write(input.subarray(0, split)) + decoder.write(input.subarray(split)) + decoder.end(), '普通中文🙂错误 & 🙂\r\n警告后续文本');
  }
  const decoder = new ShellTextDecoder(false), bytes = Buffer.from('é中文👨‍👩‍👧‍👦');
  assert.equal([...bytes].map(byte => decoder.write(Buffer.from([byte]))).join('') + decoder.end(), 'é中文👨‍👩‍👧‍👦');
});

test('#40 terminal kill/yank/yank-pop and punctuation word movement preserve undo/redo', () => {
  const editor = new InputEditor({ text: 'one two' });
  key(editor, 'w', { ctrl: true }); assert.equal(editor.text, 'one ');
  key(editor, 'y', { ctrl: true }); assert.equal(editor.text, 'one two');
  key(editor, 'a', { ctrl: true }); key(editor, 'd', { meta: true }); assert.equal(editor.text, ' two');
  key(editor, 'y', { ctrl: true }); assert.equal(editor.text, 'one two');
  key(editor, 'y', { meta: true }); assert.equal(editor.text, 'two two');
  key(editor, 'z', { ctrl: true }); assert.equal(editor.text, 'one two');
  key(editor, 'z', { ctrl: true, shift: true }); assert.equal(editor.text, 'two two');
  editor.setText('src/main/file.ts'); key(editor, 'b', { meta: true }); assert.equal(editor.cursor, 14);
  key(editor, 'b', { meta: true }); assert.equal(editor.cursor, 9);
  key(editor, 'd', { meta: true }); assert.equal(editor.text, 'src/main/.ts');
});

test('#44 visual-row navigation uses terminal cells, preserves drafts and shows clipped input bounds', () => {
  const editor = new InputEditor({ text: 'x'.repeat(180), history: ['history must not replace wrapped draft'] });
  editor.setViewportWidth(77);
  key(editor, 'up'); assert.equal(editor.text.length, 180); assert.equal(editor.cursor, 103);
  key(editor, 'up'); assert.equal(editor.cursor, 26);
  key(editor, 'down'); assert.equal(editor.cursor, 103);
  editor.setText('中'.repeat(20) + 'e\u0301👨‍👩‍👧‍👦'); editor.setViewportWidth(20);
  key(editor, 'up'); assert.equal(editor.text, '中'.repeat(20) + 'e\u0301👨‍👩‍👧‍👦'); assert.ok(editor.cursor < 20);
  editor.setText('x'.repeat(77)); editor.setViewportWidth(77); key(editor, 'up'); assert.equal(editor.text.length, 77); assert.equal(editor.cursor, 0);
  const text = Array.from({ length: 20 }, (_, index) => `row ${index}`).join('\n');
  const frame = renderTerminalFrame({ ...base(), input: { text, cursor: text.length } }, { columns: 80, rows: 24 });
  assert.match(plain(frame), /↑13.*14–20\/20.*↓0/);
  assert.ok(frame.cursor.row >= 1 && frame.cursor.row <= 24);
});

test('#48 collapsed paste expands while editing and recollapses without losing content or undo', () => {
  const editor = new InputEditor(); const content = '第一行\n第二行\n第三行\n第四行\n第五行';
  editor.paste(content); const folded = editor.view().text; assert.match(folded, /粘贴/);
  key(editor, 'left'); assert.equal(editor.view().text, content);
  key(editor, 'right'); assert.equal(editor.view().text, folded);
  assert.deepEqual(key(editor, 'return'), [{ type: 'submit', text: content }]);
});

test('#38/#45/#46 stable editor rows, counts, no-match, selected detail and simultaneous status survive notices', () => {
  for (const [columns, rows] of [[65,18], [80,24], [120,40]]) {
    const state = { ...base(), messages: [{ id: 'one', role: 'assistant', text: 'conversation' }], busy: true, status: '等待确认', context: '120 tokens', notice: '图片已添加', footer: 'manual' };
    const options = { columns, rows, theme: 'mono', cwd: 'C:\\work' };
    const closed = renderTerminalFrame(state, options);
    const open = renderTerminalFrame({ ...state, menu: { title: '命令', selected: 10, items: Array.from({ length: 30 }, (_, index) => ({ label: 'long-title'.repeat(15), description: `id-${index} running`, detail: 'C:\\somewhere\\long-file.txt' })) } }, options);
    assert.equal(open.cursor.row, closed.cursor.row, `${columns} editor must stay anchored`);
    const output = plain(open);
    for (const expected of ['11/30', 'id-10', 'running', '等待确认', '120 tokens', '图片已添加', 'model-A', 'profile-A', 'C:\\work']) assert.ok(output.includes(expected), expected);
    assert.ok(open.lines.every(line => textWidth(line) < columns));
    assert.match(plain(renderTerminalFrame({ ...state, menu: { title: '命令', items: [], selected: 0 } }, options)), /无匹配/);
    assert.match(plain(renderTerminalFrame({ ...state, menu: { title: '文件', items: [], selected: 0, loading: true } }, options)), /加载中/);
  }
});

test('#36/#37 warmed 2500-message frames reuse markdown layout and retain earliest message positions', t => {
  const state = { ...base(), transcriptVersion: 'history-v1', messages: Array.from({ length: 2500 }, (_, i) => ({ id: `message-${i}`, role: 'assistant', text: `# Message ${i}\n\n**bold** 中文\n- line\n- line\n\n\`code\` content` })) };
  const options = { columns: 80, rows: 24, theme: 'dark' };
  const started = performance.now(); const initial = renderTerminalFrame(state, options); const initialMs = performance.now() - started;
  const before = performance.now();
  for (let i = 0; i < 50; i++) renderTerminalFrame({ ...state, input: { text: `typing ${i}`, cursor: 8 } }, { ...options, tick: i });
  const average = (performance.now() - before) / 50;
  t.diagnostic(`2500 messages: cold=${initialMs.toFixed(2)}ms; warm frame mean=${average.toFixed(2)}ms`);
  assert.ok(average < 25, `cached input frames took ${average}ms, must not reparse full history`);
  assert.equal(initial.messageRows.get('message-0'), 0);
  assert.ok(initial.messageRows.has('message-2499'));
  const start = renderTerminalFrame(state, { ...options, scrollOffset: 999999 });
  assert.match(plain(start), /Message 0/);
});

test('#47 individual tools expand independently with neutral unknown status and navigation anchor', () => {
  const messages = [
    { id: 'tool-a', role: 'tool', title: 'tool A', text: 'A', detail: 'A first\nA second\nA third', status: 'unknown' },
    { id: 'tool-b', role: 'tool', title: 'tool B', text: 'B', detail: 'B first\nB second\nB third', status: 'running' }
  ];
  const state = { ...base(), messages, expandedToolIds: new Set(['tool-a']) };
  const rendered = plain(renderTerminalFrame(state, { columns: 80, rows: 40, theme: 'mono' }));
  assert.match(rendered, /○ tool A \[状态未报告\]/); assert.match(rendered, /│ A second/); assert.doesNotMatch(rendered, /│ B second/);
  const collapsed = plain(renderTerminalFrame({ ...state, expandedTools: true, collapsedToolIds: new Set(['tool-b']) }, { columns: 80, rows: 40, theme: 'mono' }));
  assert.doesNotMatch(collapsed, /│ B second/);
  let output = ''; const ui = new TerminalUI({ stdout: { isTTY: false, columns: 80, rows: 14, write: text => { output += text; } } });
  ui.render({ ...state, messages: [...messages, ...Array.from({ length: 30 }, (_, i) => ({ id: `tail-${i}`, role: 'assistant', text: 'tail' }))] });
  ui.scrollToMessage('tool-a'); assert.ok(ui.scrollOffset > 0); assert.match(plain(ui.lastFrame), /tool A/); ui.stop();
});

function task(overrides = {}) { return { id: 'task-one', title: 'title', profileName: 'profile', status: 'running', running: true, ...overrides }; }
function capture() {
  let stdout = '', stderr = ''; const stdin = new PassThrough(); stdin.isTTY = false;
  return { io: { stdout: { write: text => { stdout += text; return true; } }, stderr: { write: text => { stderr += text; return true; } } }, runtime: { stdin, signals: new EventEmitter(), pollIntervalMs: 0 }, out: () => stdout, err: () => stderr };
}
const ok = data => ({ version: 1, id: 'mock', ok: true, data });

test('#41 human list/show/watch and backend errors never pass terminal control sequences; JSON stays parseable', async () => {
  const malicious = '\x1b[2Jclear\x1b]0;TITLE\x07\x1b]52;c;SECRETS\x07\x1bPpayload\x1b\\visible';
  for (const verb of ['list', 'show', 'watch']) {
    const c = capture();
    await runAgentCli(parseAgentCliArgs(verb === 'list' ? [verb] : [verb, 'task-one']), c.io, async () => ok({ tasks: [task({ title: malicious })], total: 1, task: task({ title: malicious, running: false, status: 'completed' }), events: [{ id: 'e', at: '', kind: 'assistant', text: malicious }], cursor: 1, hasMore: false }), c.runtime);
    assert.doesNotMatch(c.out(), /\x1b|TITLE|SECRETS|payload/); assert.match(c.out(), /clearvisible/);
  }
  const c = capture(); await runAgentCli(parseAgentCliArgs(['show', 'task-one']), c.io, async () => ({ ok: false, error: { code: 'TEST', message: malicious } }), c.runtime); assert.doesNotMatch(c.err(), /\x1b|TITLE|SECRETS/);
  const json = capture(); await runAgentCli(parseAgentCliArgs(['show', 'task-one', '--json']), json.io, async () => ok({ task: task({ title: malicious }), events: [], cursor: 0, hasMore: false }), json.runtime);
  assert.equal(JSON.parse(json.out()).data.task.title, malicious);
});

test('#61 watch consumes deltas, ignores duplicate snapshots and finalizes same ID once in human/JSON modes', async () => {
  for (const json of [false, true]) {
    const c = capture(), stream = { id: 'assistant-one', text: '中文', updatedAt: '1' };
    const pages = [
      { task: task(), events: [], cursor: 0, hasMore: false, stream, revision: 0 },
      { task: task(), events: [], cursor: 0, hasMore: false, stream, revision: 0 },
      { task: task(), events: [], cursor: 0, hasMore: false, stream: { ...stream, text: '中文后续', updatedAt: '2' }, revision: 0 },
      { task: task(), events: [{ id: stream.id, kind: 'assistant', at: '3', text: '中文后续最终' }], cursor: 1, hasMore: false, revision: 0 },
      { task: task({ running: false, status: 'completed' }), events: [], cursor: 1, hasMore: false, stream, revision: 0 }
    ];
    let calls = 0;
    const code = await runAgentCli(parseAgentCliArgs(['watch', 'task-one', ...(json ? ['--json'] : [])]), c.io, async command => { if (calls) assert.equal(command.revision, 0); return ok(pages[calls++]); }, c.runtime);
    assert.equal(code, 0);
    if (json) {
      const records = c.out().trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.filter(record => record.type === 'stream').map(record => record.delta), ['中文', '后续']);
      assert.equal(records.filter(record => record.type === 'event').length, 1);
    } else { assert.equal(c.out().split('中文').length - 1, 1); assert.match(c.out(), /中文后续最终/); }
  }
});

test('#61 history reset accepts a lower cursor and reports replacement in NDJSON', async () => {
  const c = capture(), calls = [];
  const pages = [
    { task: task(), events: [{ id: 'old', kind: 'assistant', at: '', text: 'old' }], cursor: 5, hasMore: false, revision: 1 },
    { task: task({ running: false, status: 'completed' }), events: [{ id: 'new', kind: 'assistant', at: '', text: 'new' }], cursor: 1, hasMore: false, revision: 2, reset: true }
  ];
  await runAgentCli(parseAgentCliArgs(['watch', 'task-one', '--json']), c.io, async command => { calls.push(command); return ok(pages[calls.length - 1]); }, c.runtime);
  assert.equal(calls[1].revision, 1);
  assert.equal(c.out().split('\n').filter(line => line.includes('"type":"reset"')).length, 1);
  assert.doesNotMatch(c.out(), /INVALID_EVENT_CURSOR/);
});

test('#50/#56/#65 CLI exposes accessible modes, explicit send timing and honest APP dependency', () => {
  assert.equal(parseAgentCliArgs(['chat', '--screen-reader']).screenReader, true);
  assert.equal(parseAgentCliArgs(['chat', '--reduced-motion']).reducedMotion, true);
  assert.equal(parseAgentCliArgs(['send', 'task-one', 'text']).command.control, 'queue');
  assert.equal(parseAgentCliArgs(['send', 'task-one', 'text', '--now']).command.control, 'steer');
  assert.throws(() => parseAgentCliArgs(['send', 'task-one', 'text', '--queue', '--now']));
  assert.match(agentCliHelp('chat'), /完全退出 APP 会停止执行/);
  assert.match(agentCliHelp('watch'), /stream/);
});
