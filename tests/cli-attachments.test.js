const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fileMentionAt, fileCandidates, resolveFileMentions, captureClipboardImage, editTextExternally, parseEditorCommand } = require('./cli-test-build.cjs').loadCli('src/main/cli/attachments.ts');

test("file completion is bounded, ignores generated trees and resolves quoted paths", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-files-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "node_modules")); await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "src", "中文 file.txt"), "content");
  await fs.writeFile(path.join(root, "src", "other.ts"), "x");
  await fs.writeFile(path.join(root, "node_modules", "hidden.txt"), "no"); await fs.writeFile(path.join(root, ".git", "hidden.txt"), "no");
  const source = 'see @"src/中文 file.txt" then @src/other.ts';
  const found = fileMentionAt(source, source.indexOf('" then'));
  assert.equal(found.query, "src/中文 file.txt"); assert.equal(found.start, 4);
  assert.equal(fileMentionAt("email@example.test", 10), undefined);
  assert.equal(fileMentionAt("see @", 5).query, "");
  const candidates = await fileCandidates("src", { cwd: root });
  assert.equal(candidates.some(file => file.label === "src/中文 file.txt"), true);
  assert.equal((await fileCandidates("", { cwd: root, limit: 1 })).length, 1);
  assert.equal((await fileCandidates("hidden", { cwd: root })).length, 0);
  assert.deepEqual(await resolveFileMentions(source, { cwd: root }), [path.join(root, "src", "中文 file.txt"), path.join(root, "src", "other.ts")]);
  await assert.rejects(resolveFileMentions("@src", { cwd: root }), /目录/);
  await assert.rejects(resolveFileMentions(source, { cwd: root, maxFiles: 1 }), /数量/);
  await assert.rejects(resolveFileMentions(source, { cwd: root, maxBytes: 1 }), /大小/);
});

test("clipboard helpers use hidden Windows STA and macOS argv without reading real clipboard", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-images-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const platform of ["win32", "darwin"]) {
    let seen;
    const captured = await captureClipboardImage({ directory: root, platform, exec: async (executable, args, options) => {
      seen = { executable, args, options };
      const target = platform === "win32" ? options.env.PPILOT_CLIPBOARD_OUTPUT : args.at(-1);
      await fs.writeFile(target, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
      return { stdout: "SAVED" };
    } });
    assert.equal(captured.size, 9); assert.equal(path.dirname(captured.path), root);
    assert.equal(seen.options.windowsHide, true);
    if (platform === "win32") { assert.equal(seen.executable, "powershell.exe"); assert.equal(seen.args.includes("-STA"), true); assert.match(Buffer.from(seen.args.at(-1), "base64").toString("utf16le"), /Clipboard.*GetImage/); }
    else { assert.equal(seen.executable, "osascript"); assert.equal(seen.args.at(-1), captured.path); }
  }
  assert.equal(await captureClipboardImage({ directory: root, platform: "win32", exec: async () => ({ stdout: "NO_IMAGE" }) }), null);
  const before = (await fs.readdir(root)).length;
  await assert.rejects(captureClipboardImage({ directory: root, platform: "win32", exec: async (_command, _args, options) => { await fs.writeFile(options.env.PPILOT_CLIPBOARD_OUTPUT, "invalid image"); return { stdout: "SAVED" }; } }), /PNG/);
  assert.equal((await fs.readdir(root)).length, before);
});

test("external editor preserves shell-looking text, passes argv and cleans unique temp directory", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(parseEditorCommand('"C:\\Program Files\\Editor\\editor.exe" --wait'), ["C:\\Program Files\\Editor\\editor.exe", "--wait"]);
  assert.throws(() => parseEditorCommand('"unclosed'), /引号/);
  let seen;
  const edited = await editTextExternally("literal $(do-not-run) `x`", { directory: root, editor: 'code --new-window', env: { PATH: "" }, platform: "win32", spawn: (executable, args, options) => {
    seen = { executable, args, options }; const child = new EventEmitter();
    setImmediate(async () => { assert.equal(await fs.readFile(args.at(-1), "utf8"), "literal $(do-not-run) `x`"); await fs.writeFile(args.at(-1), "edited\r\n中文"); child.emit("exit", 0, null); });
    return child;
  } });
  assert.equal(edited, "edited\n中文"); assert.equal(seen.executable, "code"); assert.equal(seen.args.includes("--wait"), true);
  assert.equal(seen.options.shell, false); assert.equal(seen.options.windowsHide, true); assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(editTextExternally("keep this", { directory: root, editor: "bad", spawn: () => { const child = new EventEmitter(); setImmediate(() => child.emit("exit", 2, null)); return child; } }), /输入仍保留/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("typed directory completion reaches deep paths within a small scan budget", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-files-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deep = path.join(root, "space dir", "one", "two", "three", "four", "five", "six");
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, "target.txt"), "target");
  await fs.mkdir(path.join(root, "aaa"));
  const relative = path.relative(root, deep).replace(/\\/g, "/");
  for (const query of [`${relative}/`, `${relative}/tar`, `./${relative}/tar`]) {
    const found = await fileCandidates(query, { cwd: root, maxScanned: 1 });
    assert.equal(found.length, 1, query); assert.equal(found[0].path, path.join(deep, "target.txt"));
  }
  const quoted = `@"${relative}/"`;
  const mention = fileMentionAt(quoted, quoted.length);
  assert.equal(mention.query, `${relative}/`);
  assert.equal((await fileCandidates(mention.query, { cwd: root }))[0].path, path.join(deep, "target.txt"));
  assert.equal(fileMentionAt("@file", 0), undefined);
});

test("empty or unfinished quoted mentions are ignored and literal apostrophes survive", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-files-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "authors'"); await fs.writeFile(file, "text");
  for (const text of ['@""', "@''", '@"', "@'", '@"unfinished']) assert.deepEqual(await resolveFileMentions(text, { cwd: root }), [], text);
  assert.deepEqual(await resolveFileMentions("@authors'", { cwd: root }), [file]);
  if (process.platform === "win32") assert.equal((await resolveFileMentions("@authors' @AUTHORS'", { cwd: root, maxFiles: 1 })).length, 1);
});

test("clipboard no-image and helper failures clean partial files on both platforms", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-images-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const platform of ["win32", "darwin"]) {
    for (const fail of [false, true]) {
      const run = captureClipboardImage({ directory: root, platform, env: { PPILOT_TEST: "inherited" }, exec: async (_file, args, options) => {
        assert.equal(options.env.PPILOT_TEST, "inherited");
        const inheritedKey = Object.keys(process.env).find(key => key.toLowerCase() === "path");
        if (inheritedKey) assert.equal(options.env[inheritedKey], process.env[inheritedKey]);
        const target = platform === "win32" ? options.env.PPILOT_CLIPBOARD_OUTPUT : args.at(-1);
        await fs.writeFile(target, "partial");
        if (fail) throw new Error("helper failed");
        return { stdout: "NO_IMAGE\n" };
      } });
      if (fail) await assert.rejects(run, /helper failed/); else assert.equal(await run, null);
      assert.deepEqual(await fs.readdir(root), []);
    }
  }
});

test("editor command parsing preserves empty args, Windows slashes and macOS escaped spaces", () => {
  assert.deepEqual(parseEditorCommand(String.raw`"C:\Program Files\Editor\editor.exe" "" "C:\folder\\"`, "win32"), ["C:\\Program Files\\Editor\\editor.exe", "", "C:\\folder\\"]);
  assert.deepEqual(parseEditorCommand(String.raw`/Applications/Visual\ Studio\ Code.app/bin/code --wait ''`, "darwin"), ["/Applications/Visual Studio Code.app/bin/code", "--wait", ""]);
  assert.deepEqual(parseEditorCommand(String.raw`editor 'literal\backslash' "quoted\"word"`, "darwin"), ["editor", "literal\\backslash", 'quoted"word']);
  assert.throws(() => parseEditorCommand('"" --wait'), /VISUAL/);
});

test("Windows VS Code batch shim resolves to the native CLI without a command shell", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installation = path.join(root, "Visual Studio Code"), bin = path.join(installation, "bin");
  const cli = path.join(installation, "resources", "app", "out", "cli.js"), exe = path.join(installation, "Code.exe");
  await fs.mkdir(bin, { recursive: true }); await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(path.join(bin, "code.cmd"), "unused batch shim"); await fs.writeFile(cli, ""); await fs.writeFile(exe, "");
  let invoked = false;
  const text = await editTextExternally("original", { editor: "code --new-window", platform: "win32", directory: root, env: { pAtH: `"${bin}"` }, spawn: (file, args, options) => {
    invoked = true; assert.equal(file, exe); assert.equal(args[0], cli); assert.equal(args.filter(arg => arg === "--wait").length, 1);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1"); assert.equal(options.shell, false);
    const child = new EventEmitter(); setImmediate(() => child.emit("exit", 0, null)); return child;
  } });
  assert.equal(text, "original"); assert.equal(invoked, true);
  assert.deepEqual(await fs.readdir(root), ["Visual Studio Code"]);
  const unsupported = path.join(bin, "custom.cmd"); await fs.writeFile(unsupported, "unused");
  await assert.rejects(editTextExternally("original", { editor: `"${unsupported}"`, platform: "win32", directory: root, spawn: () => { throw new Error("must not spawn"); } }), /\.cmd\/\.bat/);
});

test("macOS external editor receives escaped executable and waits; spawn errors preserve cleanup", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = await editTextExternally("draft", { editor: String.raw`/Applications/Visual\ Studio\ Code.app/bin/code`, platform: "darwin", directory: root, spawn: (file, args) => {
    assert.equal(file, "/Applications/Visual Studio Code.app/bin/code"); assert.equal(args.includes("--wait"), true);
    const child = new EventEmitter(); setImmediate(() => child.emit("exit", 0, null)); return child;
  } });
  assert.equal(text, "draft"); assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(editTextExternally("draft", { editor: "missing", directory: root, spawn: () => {
    const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("ENOENT"))); return child;
  } }), /ENOENT/);
  assert.deepEqual(await fs.readdir(root), []);
});
