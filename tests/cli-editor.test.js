const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { emitKeypressEvents } = require("node:readline");
const { InputEditor } = require('./cli-test-build.cjs').loadCli('src/main/cli/editor.ts');
const key = (editor, name, options = {}) => editor.handleKey(undefined, { name, ...options });

function terminalInput(editor, chunks) {
  const stream = new PassThrough(), intents = [];
  emitKeypressEvents(stream);
  stream.on("keypress", (text, event) => intents.push(...editor.handleKey(text, event)));
  for (const chunk of chunks) stream.write(chunk);
  stream.destroy();
  return intents;
}

test("editor preserves Chinese, combining accents and family emoji as graphemes", () => {
  const editor = new InputEditor({ text: "中e\u0301👨‍👩‍👧‍👦文" });
  key(editor, "left"); assert.equal(editor.cursor, editor.text.length - 1);
  key(editor, "backspace"); assert.equal(editor.text, "中e\u0301文");
  key(editor, "left"); assert.equal(editor.cursor, 1);
  key(editor, "delete"); assert.equal(editor.text, "中文");
  editor.handleKey("\b"); assert.equal(editor.text, "文");
  editor.handleKey("\x1a"); assert.equal(editor.text, "中文");
  editor.handleKey("\x1f"); assert.equal(editor.text, "中e\u0301文");
  key(editor, "z", { ctrl: true, shift: true }); assert.equal(editor.text, "中文");
});

test("editor multiline bindings separate submission from newline insertion", () => {
  const editor = new InputEditor();
  editor.insert("one"); editor.handleKey("\n", { name: "j", ctrl: true }); editor.insert("two\\");
  assert.deepEqual(editor.handleKey("\r", { name: "return" }), []); editor.insert("three");
  editor.handleKey("\x1b[13;2u"); editor.insert("four");
  assert.equal(editor.text, "one\ntwo\nthree\nfour");
  const intent = editor.handleKey("\r", { name: "return" });
  assert.deepEqual(intent, [{ type: "submit", text: editor.text }]);
  assert.equal(editor.text.endsWith("four"), true);
  key(editor, "home"); key(editor, "k", { ctrl: true }); assert.equal(editor.text.endsWith("\n"), true);
  editor.setText("\nhello", 0); key(editor, "home"); assert.equal(editor.cursor, 0);
  editor.setText("long first\n中a\nlast", 8); key(editor, "down"); assert.equal(editor.cursor, 13); key(editor, "up"); assert.equal(editor.cursor, 8);
});

test("history navigation restores draft; CtrlR searches and cancels without submission", () => {
  const editor = new InputEditor({ text: "draft", history: ["first query", "Chinese 中文", "final query"] });
  key(editor, "up"); assert.equal(editor.text, "final query");
  key(editor, "up"); assert.equal(editor.text, "Chinese 中文");
  key(editor, "down"); key(editor, "down"); assert.equal(editor.text, "draft");
  key(editor, "r", { ctrl: true }); editor.handleKey("中"); assert.equal(editor.text, "Chinese 中文");
  assert.equal(editor.view().search.query, "中");
  key(editor, "escape"); assert.equal(editor.text, "draft");
  key(editor, "r", { ctrl: true }); editor.handleKey("query"); assert.equal(editor.text, "final query");
  key(editor, "r", { ctrl: true }); assert.equal(editor.text, "first query");
  assert.deepEqual(key(editor, "return"), []); assert.equal(editor.text, "first query"); assert.equal(editor.view().search, undefined);
});

test("stash swaps intact drafts and editor emits external helper and exit intents", () => {
  const editor = new InputEditor({ text: "original\ndraft" });
  assert.deepEqual(key(editor, "s", { ctrl: true }), [{ type: "stash", text: "original\ndraft" }]);
  assert.equal(editor.text, ""); editor.insert("temporary"); key(editor, "s", { ctrl: true }); assert.equal(editor.text, "original\ndraft");
  key(editor, "s", { ctrl: true }); assert.equal(editor.text, "temporary");
  assert.deepEqual(key(editor, "g", { ctrl: true }), [{ type: "external-editor" }]);
  assert.deepEqual(key(editor, "v", { ctrl: true }), [{ type: "image-paste" }]);
  assert.deepEqual(key(editor, "v", { meta: true }), [{ type: "image-paste" }]);
  assert.deepEqual(key(editor, "c", { ctrl: true }), [{ type: "interrupt" }]);
  assert.deepEqual(key(editor, "escape"), [{ type: "escape" }]);
  assert.deepEqual(key(editor, "tab"), [{ type: "complete" }]);
  editor.clear(); assert.deepEqual(key(editor, "d", { ctrl: true }), [{ type: "eof" }]);
});

test("bracketed paste never submits, collapses display and retains all text", () => {
  const editor = new InputEditor({ text: "prefix " });
  const body = "a\r\nb\nc\nd\n" + "中文".repeat(450);
  assert.deepEqual(editor.handleKey("\x1b[200~"), []);
  assert.deepEqual(editor.handleKey(body), []);
  assert.deepEqual(editor.handleKey("\x1b[201~"), []);
  assert.equal(editor.text, "prefix " + body.replace(/\r\n/g, "\n"));
  assert.match(editor.view().text, /^prefix \[粘贴 5 行/);
  assert.equal(editor.view().cursor, editor.view().text.length);
  assert.equal(key(editor, "return")[0].text, editor.text);
  key(editor, "left"); assert.equal(editor.view().text, editor.text, "moving inside a collapsed paste expands it");
  key(editor, "backspace"); assert.equal(editor.text.endsWith("中文文"), true);
});

test("line and word deletion work without slicing graphemes", () => {
  const editor = new InputEditor({ text: "first\nhello 中文 👨‍👩‍👧‍👦" });
  key(editor, "w", { ctrl: true }); assert.equal(editor.text, "first\nhello 中文 ");
  key(editor, "w", { ctrl: true }); assert.equal(editor.text, "first\nhello ");
  key(editor, "a", { ctrl: true }); assert.equal(editor.cursor, 6);
  key(editor, "e", { ctrl: true }); assert.equal(editor.cursor, editor.text.length);
  key(editor, "u", { ctrl: true }); assert.equal(editor.text, "first\n");
});

test("readline bracketed paste captures real control-key events and is one undoable edit", () => {
  const editor = new InputEditor({ text: "draft " });
  const body = "?\r\n/command\t@file\x03\x0f\x14\x02\x1b[A\n中文👨‍👩‍👧‍👦\nend";
  assert.deepEqual(terminalInput(editor, ["\x1b[20", "0~", body.slice(0, 10), body.slice(10)]), []);
  assert.equal(editor.isCapturingInput, true);
  assert.equal(editor.text, "draft ");
  assert.deepEqual(terminalInput(editor, ["\x1b[201~"]), []);
  assert.equal(editor.isCapturingInput, false);
  assert.equal(editor.text, "draft " + body.replace(/\r\n/g, "\n"));
  const collapsed = editor.view().text;
  assert.match(collapsed, /\[粘贴 /);
  terminalInput(editor, ["\x1a"]); assert.equal(editor.text, "draft ");
  key(editor, "z", { ctrl: true, shift: true }); assert.equal(editor.view().text, collapsed);
  assert.deepEqual(terminalInput(editor, ["\r"]), [{ type: "submit", text: editor.text }]);
});

test("readline ShiftEnter variants and CtrlJ insert newlines without leaking sequence suffixes", () => {
  for (const sequence of ["\n", "\x1b\r", "\x1b[13;2u", "\x1b[27;2;13~", "\x1b[13;2:1u", "\x1b[13;2:2u"]) {
    const editor = new InputEditor({ text: "one" });
    assert.deepEqual(terminalInput(editor, [sequence.slice(0, 3), sequence.slice(3), "two"]), [], JSON.stringify(sequence));
    assert.equal(editor.text, "one\ntwo", JSON.stringify(sequence));
    assert.equal(editor.isCapturingInput, false);
  }
  const editor = new InputEditor({ text: "one" });
  terminalInput(editor, ["\x1b[13;2:1u", "\x1b[13;2:3u", "\x1b[13;5u"]);
  assert.equal(editor.text, "one\n", "release and CtrlEnter do not add newlines");
  editor.setText("C:\\folder\\"); terminalInput(editor, ["\n"]);
  assert.equal(editor.text, "C:\\folder\\\n", "CtrlJ preserves a literal trailing backslash");
  editor.setText("continue\\"); terminalInput(editor, ["\r"]);
  assert.equal(editor.text, "continue\n", "plain Enter removes the continuation backslash");
});

test("large readline pastes preserve every character and split terminators end capture", () => {
  const editor = new InputEditor(), text = "中文 👨‍👩‍👧‍👦 e\u0301\n".repeat(2000);
  assert.deepEqual(terminalInput(editor, ["\x1b[200~", text, "\x1b[201~"]), []);
  assert.equal(editor.text, text); assert.equal(editor.isCapturingInput, false);
  key(editor, "z", { ctrl: true }); assert.equal(editor.text, "");
  editor.handleKey("\x1b[200~abc\x1b[20"); editor.handleKey("1~");
  assert.equal(editor.text, "abc"); assert.equal(editor.isCapturingInput, false);
});

test("clear resets interrupted paste and extended-key capture", () => {
  const editor = new InputEditor();
  terminalInput(editor, ["\x1b[200~unfinished"]); editor.clear();
  assert.equal(editor.isCapturingInput, false);
  terminalInput(editor, ["fresh"]); assert.equal(editor.text, "fresh");
  editor.handleKey("\x1b[27;2;"); assert.equal(editor.isCapturingInput, true);
  editor.setText("replacement"); terminalInput(editor, ["x"]);
  assert.equal(editor.text, "replacementx");
});

test("history boundaries never erase the current draft and recall is undoable", () => {
  const editor = new InputEditor({ text: "draft", history: ["older", "newer"] });
  key(editor, "down"); assert.equal(editor.text, "draft");
  key(editor, "up"); key(editor, "down"); key(editor, "down"); assert.equal(editor.text, "draft");
  key(editor, "up"); key(editor, "up"); key(editor, "up"); assert.equal(editor.text, "older");
  key(editor, "z", { ctrl: true }); assert.equal(editor.text, "newer");
  key(editor, "down"); assert.equal(editor.text, "newer");
  editor.setText("new draft"); key(editor, "up"); key(editor, "down"); assert.equal(editor.text, "new draft");
  key(editor, "s", { ctrl: true }); key(editor, "z", { ctrl: true }); assert.equal(editor.text, "new draft");
});

test("search reports missing matches, accepts pasted queries, and restores drafts on cancel or undo", () => {
  const editor = new InputEditor({ text: "draft", history: ["first 中文", "second query"] });
  terminalInput(editor, ["\x12", "missing"]);
  assert.equal(editor.isCapturingInput, true, "search owns keys before controller menus and shortcuts");
  assert.equal(editor.view().search.index, -1); assert.equal(editor.view().search.match, ""); assert.equal(editor.text, "draft");
  terminalInput(editor, ["\x07"]); assert.equal(editor.view().search, undefined); assert.equal(editor.text, "draft");
  assert.equal(editor.isCapturingInput, false);
  terminalInput(editor, ["\x12", "\x1b[200~中文\x1b[201~"]);
  assert.equal(editor.view().search.query, "中文"); assert.equal(editor.text, "first 中文");
  terminalInput(editor, ["\r"]); assert.equal(editor.view().search, undefined);
  terminalInput(editor, ["\x1a"]); assert.equal(editor.text, "draft");
  key(editor, "z", { ctrl: true, shift: true }); assert.equal(editor.text, "first 中文");
  terminalInput(editor, ["\x12", "query"]); editor.setHistory([]);
  terminalInput(editor, ["\x12"]); assert.equal(editor.view().search.index, -1);
  editor.setHistory(["refreshed query"]); assert.equal(editor.text, "refreshed query");
});

test("external replacements are undoable; fresh drafts reset edit state and normalize cursor positions", () => {
  const editor = new InputEditor({ text: "old" });
  editor.replaceText("edited\r\ntext", 9); assert.equal(editor.cursor, 8); assert.equal(editor.text, "edited\ntext");
  key(editor, "z", { ctrl: true }); assert.equal(editor.text, "old");
  key(editor, "z", { ctrl: true, shift: true }); assert.equal(editor.text, "edited\ntext");
  editor.setText("a\r\nb", 3); assert.equal(editor.cursor, 2);
  key(editor, "z", { ctrl: true }); assert.equal(editor.text, "a\nb");
  editor.setText("\u0301x", 0); editor.insert("e"); assert.equal(editor.cursor, 2);
  key(editor, "backspace"); assert.equal(editor.text, "x");
});

test("Windows CtrlArrow and macOS OptionArrow move by complete words", () => {
  for (const [back, forward] of [["\x1b[1;5D", "\x1b[1;5C"], ["\x1b[1;3D", "\x1b[1;3C"], ["\x1bb", "\x1bf"]]) {
    const editor = new InputEditor({ text: "first 中文 👨‍👩‍👧‍👦" });
    terminalInput(editor, [back]); assert.equal(editor.cursor, 9);
    terminalInput(editor, [back]); assert.equal(editor.cursor, 6);
    terminalInput(editor, [forward]); assert.equal(editor.cursor, 8);
  }
});
