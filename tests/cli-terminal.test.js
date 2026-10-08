const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

// Compile only the renderer into an isolated directory so the test neither
// depends on stale dist output nor competes with a running desktop build.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ppilot-terminal-test-"));
buildSync({ entryPoints: [path.resolve(__dirname, "../src/main/cli/terminal.ts"), path.resolve(__dirname, "../src/main/cli/markdown.ts")],
  outdir: temporary, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { TerminalUI, renderTerminalFrame } = require(path.join(temporary, "terminal.js"));
const { textWidth, wrapAnsi, truncateAnsi, stripAnsi, safeText, renderMarkdown, palette } = require(path.join(temporary, "markdown.js"));
const empty = () => ({ messages: [], input: { text: "", cursor: 0 }, showWelcome: false });
const plain = frame => frame.lines.map(stripAnsi);

test("cell widths preserve CJK, combining marks, family emoji, flags and ANSI styles", () => {
  assert.equal(textWidth("中文"), 4);
  assert.equal(textWidth("e\u0301"), 1);
  assert.equal(textWidth("👨‍👩‍👧‍👦🇨🇳👍🏽"), 6);
  assert.equal(textWidth("\x1b[31m中A\x1b[0m"), 3);
  assert.equal(textWidth("a\tb"), 5);
  for (const width of [1, 2, 3, 7, 65]) {
    const lines = wrapAnsi("\x1b[31m中文 é 👨‍👩‍👧‍👦 🇨🇳\x1b[0m", width);
    assert.ok(lines.every(line => textWidth(line) <= width), `overflow at ${width}`);
    if (width > 1) assert.equal(lines.map(stripAnsi).join(""), "中文 é 👨‍👩‍👧‍👦 🇨🇳");
  }
});

test("model output cannot move the cursor, replace the title or write the clipboard", () => {
  const malicious = "hello\x1b[2J\x1b[H\x1b]52;c;secret\x07\x1b]0;fake title\x07world\x1bPevil\x1b\\";
  assert.equal(safeText(malicious), "helloworld");
  assert.equal(safeText("\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x1b\\"), "label");
  const frame = renderTerminalFrame({ ...empty(), messages: [{ role: "assistant", text: malicious }] }, { columns: 40, rows: 12 });
  assert.ok(frame.lines.join("").includes("helloworld"));
  assert.ok(!frame.lines.join("").includes("secret"));
  assert.ok(!frame.lines.join("").includes("\x1b[2J"));
});

test("Markdown displays headings, lists, links and highlighted fenced code and diff", () => {
  const value = "# Heading\n- **bold** and `code`\n[docs](https://example.com)\n```ts\nconst title = '中文';\n```\n```diff\n-old\n+new\n```";
  const lines = renderMarkdown(value, 25);
  const output = lines.map(stripAnsi).join("\n");
  assert.ok(output.includes("Heading"));
  assert.ok(output.includes("• bold and code"));
  assert.ok(output.includes("╭─ ts"));
  assert.ok(output.includes("const title = '中文';"));
  assert.ok(output.includes("-old") && output.includes("+new"));
  assert.ok(lines.join("").includes("\x1b[92m+new"));
  assert.ok(lines.every(line => textWidth(line) <= 25));
  assert.ok(!renderMarkdown(value, 25, "mono").join("").includes("\x1b"));
});

test("renderer keeps the input, menu and cursor on screen at narrow Windows pane sizes", () => {
  for (const [columns, rows] of [[80, 24], [65, 18], [20, 9], [4, 4]]) {
    const state = { ...empty(), showWelcome: true, model: "Sonnet", profile: "中文浏览器", busy: true,
      messages: [{ role: "assistant", text: "持续输出中文 👨‍👩‍👧‍👦\n".repeat(12) }],
      input: { text: "第一行\n第二行 👨‍👩‍👧‍👦 editing", cursor: 20 },
      menu: { title: "命令", selected: 1, items: [{ label: "/help", description: "帮助" }, { label: "/model", description: "模型选择" }] } };
    const frame = renderTerminalFrame(state, { columns, rows });
    assert.equal(frame.lines.length, rows);
    assert.ok(frame.lines.every(line => textWidth(line) < columns), `overflow at ${columns}×${rows}`);
    assert.ok(frame.lines.every(line => !line.includes("\n")));
    assert.ok(frame.cursor.row >= 1 && frame.cursor.row <= rows);
    assert.ok(frame.cursor.column >= 1 && frame.cursor.column < columns);
  }
});

test("input cursor follows grapheme cell widths instead of UTF-16 lengths", () => {
  const state = { ...empty(), input: { text: "中👨‍👩‍👧‍👦é", cursor: "中👨‍👩‍👧‍👦é".length } };
  const frame = renderTerminalFrame(state, { columns: 30, rows: 10, theme: "mono" });
  assert.equal(frame.cursor.column, 8); // prompt 2 + graphemes 2, 2, 1 + one-based offset
  assert.equal(frame.cursor.row, 6); // input border + footer + status + persistent identity below
  assert.ok(plain(frame)[frame.cursor.row - 1].includes("中👨‍👩‍👧‍👦é"));
});

test("password and API key input never enters visible frames", () => {
  const frame = renderTerminalFrame({ ...empty(), input: { text: "sk-secret-中文", cursor: 12, masked: true } }, { columns: 65, rows: 18 });
  assert.ok(!frame.lines.join("").includes("secret"));
  assert.ok(!frame.lines.join("").includes("中文"));
  assert.ok(plain(frame).join("").includes("••••"));
});

test("long filtered menus keep the selected option visible and sanitize their labels", () => {
  const menu = { title: "Sessions", filter: "work", selected: 38,
    items: Array.from({ length: 40 }, (_, i) => ({ label: `session ${i}\nlabel`, description: "工作目录" })) };
  const frame = renderTerminalFrame({ ...empty(), menu }, { columns: 65, rows: 18, theme: "mono" });
  assert.ok(plain(frame).some(line => line.includes("❯   session 38 label")));
  assert.ok(plain(frame).some(line => line.includes("Sessions · work")));
  assert.ok(frame.lines.every(line => !line.includes("\n")));
});

test("collapsed tools summarize output while expanded tools show details", () => {
  const state = { ...empty(), messages: [{ role: "tool", title: "Read report.txt", text: "line one\nline two\nline three", status: "done" }] };
  const collapsed = plain(renderTerminalFrame(state, { columns: 40, rows: 14, theme: "mono" })).join("\n");
  const expanded = plain(renderTerminalFrame({ ...state, expandedTools: true }, { columns: 40, rows: 14, theme: "mono" })).join("\n");
  assert.ok(collapsed.includes("line one · line two"));
  assert.ok(expanded.includes("│ line one\n"));
  assert.ok(expanded.includes("│ line three"));
});

test("transcript scrolling and resizing leave the input viewport anchored", () => {
  const state = { ...empty(), messages: Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `message ${i}` })), input: { text: "draft", cursor: 5 } };
  const latest = renderTerminalFrame(state, { columns: 60, rows: 14, theme: "mono" });
  const earlier = renderTerminalFrame(state, { columns: 60, rows: 14, scrollOffset: 20, theme: "mono" });
  assert.ok(plain(latest).join("\n").includes("message 29"));
  assert.ok(!plain(earlier).join("\n").includes("message 29"));
  assert.ok(plain(earlier).join("\n").includes("lines below"));
  assert.equal(latest.cursor.row, earlier.cursor.row);
  assert.equal(plain(latest)[latest.cursor.row - 1], "❯ draft");
});

test("alternate screen, paste mode and cursor are restored after suspend and stop", () => {
  class Output extends EventEmitter {
    columns = 65; rows = 18; isTTY = true; chunks = [];
    write(value) { this.chunks.push(value); return true; }
  }
  const stdout = new Output();
  const ui = new TerminalUI({ stdout }, { theme: "mono", cwd: "/workspace" });
  ui.render(empty());
  assert.equal(stdout.listenerCount("resize"), 1);
  assert.ok(stdout.chunks.join("").includes("\x1b[?1049h\x1b[?2004h"));
  const startCount = stdout.chunks.length;
  ui.suspend();
  assert.ok(stdout.chunks.at(-1).startsWith("\x1b[?2026l\x1b[0m"));
  assert.ok(stdout.chunks.at(-1).includes("\x1b[?1049l"));
  ui.render({ ...empty(), input: { text: "hidden while editor is active", cursor: 0 } });
  assert.equal(stdout.chunks.length, startCount + 1);
  ui.resume();
  assert.ok(stdout.chunks.at(-1).includes("hidden while editor is active"));
  stdout.columns = 25; stdout.rows = 10; stdout.emit("resize");
  assert.ok(!stdout.chunks.at(-1).includes("\x1b[18;"));
  const repaintedRows = [...stdout.chunks.at(-1).matchAll(/\x1b\[(\d+);1H\x1b\[0m\x1b\[2K/g)].map(match => Number(match[1]));
  assert.deepEqual(repaintedRows, Array.from({ length: 10 }, (_, i) => i + 1));
  assert.ok(!stdout.chunks.at(-1).includes("\n"), "absolute row redraws must not scroll the terminal");
  ui.stop();
  assert.equal(stdout.listenerCount("resize"), 0);
  assert.ok(stdout.chunks.at(-1).includes("\x1b[?25h\x1b[?2004l\x1b[?1049l"));
  const stoppedCount = stdout.chunks.length;
  ui.stop();
  assert.equal(stdout.chunks.length, stoppedCount);
});

test("idle repeated renders write zero bytes at both target terminal sizes", () => {
  for (const [columns, rows] of [[65, 18], [80, 24]]) {
    const stdout = { columns, rows, isTTY: true, chunks: [], write(value) { this.chunks.push(value); } };
    const ui = new TerminalUI({ stdout });
    const state = { ...empty(), messages: [{ role: "assistant", text: "等待输入 👨‍👩‍👧‍👦" }], input: { text: "draft", cursor: 5 } };
    try {
      ui.render(state);
      assert.ok(stdout.chunks.join("").includes("\x1b[?2026h"));
      stdout.chunks.length = 0;
      for (let i = 0; i < 100; i++) ui.render({ ...state, input: { ...state.input }, messages: [...state.messages] });
      assert.deepEqual(stdout.chunks, []);
      assert.equal(Buffer.byteLength(stdout.chunks.join("")), 0);
    } finally { ui.stop(); }
  }
});

test("cursor-only and line-only changes still emit synchronized updates", () => {
  const stdout = { columns: 65, rows: 18, isTTY: true, chunks: [], write(value) { this.chunks.push(value); } };
  const ui = new TerminalUI({ stdout }, { theme: "mono" });
  try {
    ui.render({ ...empty(), input: { text: "draft", cursor: 5 } });
    stdout.chunks.length = 0;
    ui.render({ ...empty(), input: { text: "draft", cursor: 2 } });
    assert.deepEqual(stdout.chunks, ["\x1b[?2026h\x1b[?25l\x1b[14;5H\x1b[?25h\x1b[?2026l"]);
    stdout.chunks.length = 0;
    ui.render({ ...empty(), input: { text: "drawn", cursor: 2 } });
    assert.equal(stdout.chunks.length, 1);
    assert.ok(stdout.chunks[0].startsWith("\x1b[?2026h\x1b[?25l"));
    assert.ok(stdout.chunks[0].includes("\x1b[2K❯ drawn"));
    assert.ok(stdout.chunks[0].endsWith("\x1b[14;5H\x1b[?25h\x1b[?2026l"));
    stdout.chunks.length = 0;
    ui.render({ ...empty(), input: { text: "drawn", cursor: 2 } });
    assert.deepEqual(stdout.chunks, []);
  } finally { ui.stop(); }
});

test("redirected output never receives full-screen control sequences", () => {
  const stdout = { isTTY: false, chunks: [], write(value) { this.chunks.push(value); } };
  const ui = new TerminalUI({ stdout });
  try {
    ui.render(empty()); ui.suspend(); ui.resume();
  } finally { ui.stop(); }
  assert.deepEqual(stdout.chunks, []);
});

test("tabs expand into cells across soft wraps without replacement glyphs or native tab stops", () => {
  assert.deepEqual(wrapAnsi("abc\td", 3), ["abc", "   ", " d"]);
  assert.deepEqual(wrapAnsi("ab\td", 3), ["ab ", " d"]);
  assert.deepEqual(wrapAnsi("a\tb", 1), ["a", " ", " ", " ", " ", "b"]);
  assert.deepEqual(wrapAnsi("a\r\nb", 8), ["a", "b"]);
  const frame = renderTerminalFrame({ ...empty(), input: { text: "abc\td", cursor: 5 } }, { columns: 6, rows: 18, theme: "mono" });
  assert.equal(plain(frame)[frame.cursor.row - 1], "   d");
  assert.equal(frame.cursor.column, 5);
  assert.ok(!frame.lines.join("").includes("\t"));
});

test("truncation keeps whole CJK and emoji graphemes and closes its color", () => {
  assert.equal(truncateAnsi("中abc", 2), "…");
  assert.equal(truncateAnsi("a👨‍👩‍👧‍👦xyz", 4), "a👨‍👩‍👧‍👦…");
  const colored = truncateAnsi("\x1b[31m中abcdef", 4);
  assert.equal(stripAnsi(colored), "中a…");
  assert.ok(colored.endsWith("\x1b[0m"));
});

test("sanitization removes C1 control strings and character set changes as complete sequences", () => {
  assert.equal(safeText("a\x9d52;c;secret\x9cb\x90hidden\x9cc\x1b(Bd"), "abcd");
  assert.equal(safeText("a\x1b]52;c;unfinished"), "a");
});

test("four-backtick fences preserve embedded triples and reject closing fence info strings", () => {
  const value = ["````markdown", "```js", "const a = 1", "```", "````still code", "`````", "after"].join("\n");
  const lines = renderMarkdown(value, 40, "mono");
  assert.deepEqual(lines, ["╭─ markdown", "│ ```js", "│ const a = 1", "│ ```", "│ ````still code", "╰" + "─".repeat(39), "after"]);
  const streamed = renderMarkdown("~~~TS\nconst x = 1", 40);
  assert.ok(streamed.at(-1).includes("╰"));
  assert.ok(streamed[1].includes(palette().keyword + "const"));
});

test("wrapped lists, ordered lists and quotes keep their prefixes aligned", () => {
  assert.deepEqual(renderMarkdown("- 中文中文中文", 8, "mono"), ["• 中文中", "  文中文"]);
  assert.deepEqual(renderMarkdown("12. abcdefghi", 8, "mono"), ["12. abcd", "    efgh", "    i"]);
  assert.deepEqual(renderMarkdown("> abcdefghij", 8, "mono"), ["│ abcdef", "│ ghij"]);
  for (const width of [1, 2, 3]) {
    const lines = renderMarkdown("```ts\nx\n```", width, "mono");
    assert.ok(lines.some(line => line.endsWith("x")), "borders must not consume the entire code viewport");
    assert.ok(lines.every(line => textWidth(line) <= width));
  }
});

test("raw unified diffs retain literal addition/deletion markers and color", () => {
  const source = "--- a/report\n+++ b/report\n@@ -1 +1 @@\n- old text\n+ new 中文 👨‍👩‍👧‍👦\n context";
  const lines = renderMarkdown(source, 30);
  assert.deepEqual(lines.map(stripAnsi), source.split("\n"));
  assert.ok(lines[3].includes(palette().error));
  assert.ok(lines[4].includes(palette().success));
  assert.ok(lines[0].includes(palette().keyword));
  assert.ok(!renderMarkdown("```js\n-counter\n```", 30).join("").includes(palette().error));
});

test("inline code restores heading and quote styling in dark, light and mono themes", () => {
  for (const theme of ["dark", "light", "mono"]) {
    const colors = palette(theme);
    const heading = renderMarkdown("# before `code` after", 60, theme)[0];
    const quote = renderMarkdown("> before **bold** after", 60, theme)[0];
    assert.ok(heading.includes("code" + colors.reset + colors.bold + " after"));
    assert.ok(quote.includes("bold" + colors.reset + colors.muted + " after"));
  }
  assert.notEqual(palette("light").brand, palette("dark").brand);
});

test("empty notices preserve running status and usage at both target terminal sizes", () => {
  for (const [columns, rows] of [[65, 18], [80, 24]]) {
    const frame = renderTerminalFrame({ ...empty(), busy: true, status: "正在处理", notice: "", context: "123 tokens" }, { columns, rows, theme: "mono" });
    assert.ok(plain(frame).some(line => line === "✻ 正在处理 · 123 tokens"));
    assert.equal(frame.lines.length, rows);
    assert.equal(plain(frame)[frame.cursor.row - 1].slice(0, 2), "❯ ");
  }
});

test("cursor offsets follow sanitized CRLF text and snap inside masked graphemes", () => {
  const source = "a\r\n中\x1b[31mbc";
  const frame = renderTerminalFrame({ ...empty(), input: { text: source, cursor: source.length - 1 } }, { columns: 65, rows: 18, theme: "mono" });
  assert.equal(plain(frame)[frame.cursor.row - 1], "  中bc");
  assert.equal(frame.cursor.column, 6);
  const secret = "a👨‍👩‍👧‍👦b";
  for (const [cursor, column] of [[1, 4], [3, 4], [12, 5], [13, 6]]) {
    const masked = renderTerminalFrame({ ...empty(), input: { text: secret, cursor, masked: true } }, { columns: 65, rows: 18, theme: "mono" });
    assert.equal(masked.cursor.column, column);
    assert.equal(plain(masked)[masked.cursor.row - 1], "❯ •••");
  }
});

test("right-margin caret has a continuation row before the next explicit input line", () => {
  for (const columns of [65, 80]) {
    const text = "x".repeat(columns - 3) + "\nnext";
    const frame = renderTerminalFrame({ ...empty(), input: { text, cursor: columns - 3 } }, { columns, rows: 18, theme: "mono" });
    assert.equal(plain(frame)[frame.cursor.row - 1], "  ");
    assert.equal(plain(frame)[frame.cursor.row], "  next");
    assert.equal(frame.cursor.column, 3);
  }
});

test("long drafts and menus preserve selection, shortcut, status and some transcript", () => {
  for (const [columns, rows] of [[65, 18], [80, 24]]) {
    const text = Array.from({ length: 12 }, (_, i) => `第 ${i} 行 👨‍👩‍👧‍👦`).join("\n");
    const frame = renderTerminalFrame({ ...empty(), input: { text, cursor: text.length }, busy: true, status: "处理任务",
      messages: [{ role: "assistant", text: "上一条消息\n可见记录" }],
      menu: { title: "模型", selected: 19, items: Array.from({ length: 20 }, (_, i) => ({ label: `model ${i}`, description: "描述".repeat(40), shortcut: "Enter" })) }
    }, { columns, rows, theme: "mono" });
    assert.ok(frame.viewport.visible >= 3);
    assert.ok(plain(frame).some(line => line.includes("可见记录")));
    assert.ok(plain(frame).some(line => line.includes("❯   model 19") && line.endsWith("Enter")));
    assert.ok(plain(frame)[frame.cursor.row - 1].includes("第 11 行"));
    assert.ok(plain(frame).some(line => line.includes("处理任务")));
    assert.equal(frame.lines.length, rows);
    assert.ok(frame.lines.every(line => textWidth(line) < columns));
  }
});

test("scrolling to the beginning does not hide the oldest transcript line behind the banner", () => {
  const state = { ...empty(), messages: Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `message ${i}` })) };
  const frame = renderTerminalFrame(state, { columns: 65, rows: 18, scrollOffset: 9999, theme: "mono" });
  assert.equal(frame.viewport.start, 0);
  assert.match(plain(frame)[0], /lines below/);
  assert.equal(plain(frame)[1], "● message 0");
  const short = renderTerminalFrame(empty(), { columns: 65, rows: 18, scrollOffset: 9999, theme: "mono" });
  assert.ok(!plain(short).join("").includes("lines below"));
});

test("scrolled transcript stays anchored while new output arrives and returns to the latest output", () => {
  const stdout = { columns: 65, rows: 18, isTTY: true, chunks: [], write(value) { this.chunks.push(value); } };
  const ui = new TerminalUI({ stdout }, { theme: "mono" });
  const state = { ...empty(), messages: Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `message ${i}` })) };
  try {
    ui.render(state);
    ui.scroll(12);
    stdout.chunks.length = 0;
    ui.render({ ...state, messages: [...state.messages, { role: "assistant", text: "newest streamed output" }] });
    // Only the banner changes: existing transcript rows must not be redrawn.
    const writtenRows = [...stdout.chunks.join("").matchAll(/\x1b\[(\d+);1H\x1b\[0m\x1b\[2K/g)].map(match => Number(match[1]));
    assert.deepEqual(writtenRows, [1]);
    ui.scrollToBottom();
    assert.ok(stdout.chunks.at(-1).includes("newest streamed output"));
    ui.scroll(9999);
    assert.ok(stdout.chunks.at(-1).includes("● message 0"));
  } finally { ui.stop(); }
});

test("folded tool summaries report line counts and expand into a colored diff", () => {
  const state = { ...empty(), messages: [{ role: "tool", title: "Edit report", status: "done", text: "```diff\n-old\n+new\n```" }] };
  const folded = renderTerminalFrame(state, { columns: 65, rows: 18 });
  assert.ok(plain(folded).some(line => line.includes("4 lines")));
  const expanded = renderTerminalFrame({ ...state, expandedTools: true }, { columns: 65, rows: 18 });
  assert.ok(expanded.lines.some(line => line.includes(palette().error + "-old")));
  assert.ok(expanded.lines.some(line => line.includes(palette().success + "+new")));
  assert.deepEqual(expanded.cursor, folded.cursor);
});

test("processed audit entries collapse to a neutral line and retain expandable sanitized details", () => {
  for (const theme of ["dark", "light", "mono"]) {
    for (const [columns, rows] of [[65, 18], [80, 24]]) {
      const record = { role: "error", text: "旧错误\r\n审计原文 👨‍👩‍👧‍👦\x1b]52;c;clipboard-secret\x07",
        collapsedText: "重试成功 · 历史错误：旧错误\n" + "长标题".repeat(40) };
      const state = { ...empty(), messages: [record, { role: "assistant", text: "新的执行进度" }] };
      const folded = renderTerminalFrame(state, { columns, rows, theme });
      assert.ok(plain(folded).some(line => line.includes("重试成功")));
      assert.ok(!plain(folded).join("\n").includes("审计原文"));
      assert.ok(plain(folded).some(line => line.includes("新的执行进度")));
      if (theme !== "mono") assert.ok(!folded.lines.join("").includes(palette(theme).error));
      const expanded = renderTerminalFrame({ ...state, expandedTools: true }, { columns, rows, theme });
      assert.ok(plain(expanded).join("\n").includes("审计原文 👨‍👩‍👧‍👦"));
      assert.ok(!expanded.lines.join("").includes("clipboard-secret"));
      assert.deepEqual(expanded.cursor, folded.cursor);
      assert.ok(folded.lines.every(line => textWidth(line) < columns && !line.includes("\n")));
      assert.ok(record.text.includes("审计原文"), "rendering never mutates the audit record");
    }
  }
});
