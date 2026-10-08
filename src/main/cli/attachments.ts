import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Clipboard text travels on stdin, never through shell interpolation. */
export function copyTextToClipboard(text: string, platform = process.platform): Promise<void> {
  if (platform !== "win32" && platform !== "darwin") return Promise.reject(new Error("当前平台请使用 /export 导出后复制。"));
  return new Promise((resolve, reject) => {
    const child = platform === "darwin" ? spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] }) : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding; Set-Clipboard -Value ([Console]::In.ReadToEnd())"], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("剪贴板写入超时，可使用 /export。")); }, 10000);
    child.stderr?.on("data", chunk => { error += chunk.toString("utf8"); });
    child.on("error", failure => { clearTimeout(timer); reject(failure); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error || "剪贴板写入失败")); });
    child.stdin?.on("error", failure => { clearTimeout(timer); reject(failure); });
    child.stdin?.end(text, "utf8");
  });
}

export interface FileCandidate { path: string; label: string; kind: "file" | "directory"; size?: number; }
export interface FileMention { query: string; start: number; end: number; }
export interface ClipboardImage { path: string; name: string; size: number; }
export type HelperExec = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr?: string }>;
const EXCLUDED = new Set(["node_modules", ".git", ".svn", ".hg", ".next", ".cache", "dist", "coverage"]);

/** @ mentions begin at a word boundary; emails are ordinary prompt text. */
export function fileMentionAt(text: string, cursor: number): FileMention | undefined {
  for (const mention of mentions(text, true)) if (mention.start < cursor && mention.end >= cursor) return { ...mention, query: unquote(text.slice(mention.start + 1, cursor)) };
  return undefined;
}

export async function fileCandidates(query: string, options: { cwd: string; limit?: number; maxScanned?: number }): Promise<FileCandidate[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const maxScanned = Math.max(1, Math.min(options.maxScanned ?? 2500, 10000));
  const cwd = path.resolve(options.cwd);
  const normalizedQuery = process.platform === "win32" ? unquote(query).replace(/\\/g, "/") : unquote(query);
  // Once a directory is named, enumerate that directory directly. A workspace
  // crawl can exhaust its budget before reaching a deep, explicitly typed path.
  const explicit = normalizedQuery.includes("/") || normalizedQuery === "~" || normalizedQuery === "..";
  const resolvedQuery = resolveInputPath(normalizedQuery, cwd);
  const slash = normalizedQuery.lastIndexOf("/");
  const directoryQuery = normalizedQuery.endsWith("/") || normalizedQuery === "~" || normalizedQuery === "..";
  const searchRoot = explicit ? (directoryQuery ? resolvedQuery : path.dirname(resolvedQuery)) : cwd;
  const needle = directoryQuery ? "" : (explicit ? normalizedQuery.slice(slash + 1) : normalizedQuery).toLocaleLowerCase();
  const results: FileCandidate[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: searchRoot, depth: 0 }];
  let scanned = 0;
  while (pending.length && scanned < maxScanned && results.length < limit) {
    const current = pending.shift()!;
    let entries;
    try { entries = await fs.readdir(current.directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++scanned > maxScanned || results.length >= limit) break;
      if (entry.isSymbolicLink() || EXCLUDED.has(entry.name) || entry.name.startsWith(".profilepilot-")) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const absolute = path.join(current.directory, entry.name);
      const relativePath = path.relative(cwd, absolute);
      const relative = process.platform === "win32" ? relativePath.replace(/\\/g, "/") : relativePath;
      const searchable = explicit ? entry.name : relative;
      if (!needle || searchable.toLocaleLowerCase().includes(needle)) {
        let size: number | undefined;
        if (entry.isFile()) { try { size = (await fs.stat(absolute)).size; } catch { continue; } }
        results.push({ path: absolute, label: relative + (entry.isDirectory() ? "/" : ""), kind: entry.isDirectory() ? "directory" : "file", ...(size === undefined ? {} : { size }) });
      }
      if (!explicit && entry.isDirectory() && current.depth < 5) pending.push({ directory: absolute, depth: current.depth + 1 });
    }
  }
  return results;
}

export async function resolveFileMentions(text: string, options: { cwd: string; maxFiles?: number; maxBytes?: number }): Promise<string[]> {
  const paths = [...new Map(mentions(text).map(mention => {
    const file = resolveInputPath(mention.query, options.cwd);
    return [process.platform === "win32" ? file.toLowerCase() : file, file];
  })).values()];
  if (paths.length > (options.maxFiles ?? 20)) throw new Error("附加文件数量超过限制，请减少 @文件引用。");
  let bytes = 0;
  for (const file of paths) {
    let stat;
    try { stat = await fs.stat(file); } catch { throw new Error(`找不到附加文件：${file}`); }
    if (!stat.isFile()) throw new Error(`请选择文件，不能直接附加目录：${file}`);
    bytes += stat.size;
    if (bytes > (options.maxBytes ?? 50 * 1024 * 1024)) throw new Error("附加文件总大小超过 50 MB，请减少文件或缩小内容。");
  }
  return paths;
}

export async function captureClipboardImage(options: { directory?: string; platform?: NodeJS.Platform; exec?: HelperExec; env?: NodeJS.ProcessEnv } = {}): Promise<ClipboardImage | null> {
  const platform = options.platform || process.platform;
  if (platform !== "win32" && platform !== "darwin") throw new Error("图片剪贴板目前支持 Windows 和 macOS；也可以使用 @文件路径 附加图片。");
  const directory = path.resolve(options.directory || path.join(os.homedir(), ".profilepilot", "cli", "clipboard"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `clipboard-${randomUUID()}.png`, file = path.join(directory, name);
  const run = options.exec || runHelper;
  try {
    const result = platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_CLIPBOARD, "utf16le").toString("base64")], { env: { ...process.env, ...options.env, PPILOT_CLIPBOARD_OUTPUT: file }, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
      : await run("osascript", ["-e", MAC_CLIPBOARD, file], { env: { ...process.env, ...options.env }, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.stdout.trim() === "NO_IMAGE") { await fs.rm(file, { force: true }); return null; }
    const stat = await fs.stat(file);
    if (stat.size > 20 * 1024 * 1024) throw new Error("剪贴板图片超过 20 MB，请先缩小图片。");
    const handle = await fs.open(file, "r");
    try { const signature = Buffer.alloc(8); await handle.read(signature, 0, 8, 0); if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("剪贴板没有可读取的 PNG 图片。"); }
    finally { await handle.close(); }
    await fs.chmod(file, 0o600).catch(() => {});
    return { path: file, name, size: stat.size };
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
}

/** No shell: editor environment variables supply one executable and argv only. */
export function parseEditorCommand(command: string, platform = process.platform): string[] {
  const args: string[] = []; let current = "", quote = "", started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && platform === "win32") {
        let end = index; while (command[end] === "\\") end++;
        const count = end - index;
        if (command[end] === '"') { current += "\\".repeat(Math.floor(count / 2)); if (count % 2) current += '"'; else quote = ""; index = end; }
        else { current += "\\".repeat(count); index = end - 1; }
      } else if (char === "\\" && quote === '"' && /["\\$`]/.test(command[index + 1] || "\n")) current += command[++index];
      else current += char;
    }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { args.push(current); current = ""; started = false; } }
    else { started = true; current += char === "\\" && platform !== "win32" && index + 1 < command.length ? command[++index] : char; }
  }
  if (quote) throw new Error("VISUAL/EDITOR 的引号没有闭合。");
  if (started) args.push(current);
  if (!args.length || !args[0]) throw new Error("请配置 VISUAL 或 EDITOR。");
  return args;
}

export async function editTextExternally(text: string, options: { editor?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess; directory?: string } = {}): Promise<string> {
  const env = options.env || process.env, platform = options.platform || process.platform;
  const command = options.editor || env.VISUAL || env.EDITOR || (platform === "win32" ? "notepad.exe" : "vi");
  const [requestedExecutable, ...args] = parseEditorCommand(command, platform);
  let executable = requestedExecutable, editorEnv = env;
  const basename = (platform === "win32" ? path.win32 : path.posix).basename(executable).replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
  if (["code", "code-insiders", "codium", "subl", "zed"].includes(basename) && !args.includes("--wait") && !args.includes("-w")) args.push("--wait");
  if (platform === "win32") {
    const resolved = await windowsEditor(executable, env);
    executable = resolved.executable; args.unshift(...resolved.prefix);
    if (resolved.node) editorEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  }
  const directory = await fs.mkdtemp(path.join(options.directory || os.tmpdir(), "ppilot-editor-"));
  const file = path.join(directory, "prompt.md");
  try {
    await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await new Promise<void>((resolve, reject) => {
      const child = (options.spawn || spawn)(executable, [...args, file], { env: editorEnv, stdio: "inherit", windowsHide: true, shell: false });
      child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`外部编辑器已退出（${signal || code}），输入仍保留。`)));
    });
    const stat = await fs.stat(file); if (stat.size > 1024 * 1024) throw new Error("编辑内容超过 1 MB，请缩小后重试。");
    return (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  } finally {
    // Only the unique directory created above is removed; no caller-supplied
    // path or editor command is interpreted as a filesystem operation.
    const resolved = path.resolve(directory), parent = path.resolve(options.directory || os.tmpdir());
    if (path.dirname(resolved) === parent && path.basename(resolved).startsWith("ppilot-editor-")) await fs.rm(resolved, { recursive: true, force: true });
  }
}

function mentions(text: string, incomplete = false): FileMention[] {
  const results: FileMention[] = [];
  const expression = /(^|\s)@("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s]*)/g;
  for (const match of text.matchAll(expression)) {
    const raw = match[2], start = match.index + match[1].length, end = start + raw.length + 1;
    if (!incomplete && (!unquote(raw) || ((raw.startsWith('"') || raw.startsWith("'")) && (raw.length < 2 || !raw.endsWith(raw[0]))))) continue;
    results.push({ start, end, query: unquote(raw) });
  }
  return results;
}
function unquote(value: string): string { return /^["']/.test(value) ? value.slice(1, value.length > 1 && value.endsWith(value[0]) ? -1 : undefined) : value; }
function resolveInputPath(value: string, cwd: string): string {
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")) ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}
async function windowsEditor(executable: string, env: NodeJS.ProcessEnv): Promise<{ executable: string; prefix: string[]; node?: boolean }> {
  const envPath = env[Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH"];
  const directories = executable.includes("\\") || executable.includes("/") ? [""] : String(envPath || "").split(";").map(directory => directory.replace(/^"(.*)"$/, "$1"));
  const candidates = directories.flatMap(directory => {
    const base = directory ? path.join(directory, executable) : executable;
    return path.extname(base) ? [base] : [base + ".exe", base + ".cmd", base];
  });
  for (const candidate of candidates) {
    try { if (!(await fs.stat(candidate)).isFile()) continue; } catch { continue; }
    if (!/\.(?:cmd|bat)$/i.test(candidate)) return { executable: candidate, prefix: [] };
    // VS Code distributes a batch shim; run its known Electron CLI directly
    // instead of enabling a command shell for untrusted prompt/file text.
    if (/^(?:code|code-insiders|codium)\.cmd$/i.test(path.basename(candidate))) {
      const installation = path.resolve(path.dirname(candidate), "..");
      const cli = path.join(installation, "resources", "app", "out", "cli.js");
      for (const binary of ["Code.exe", "Code - Insiders.exe", "VSCodium.exe"]) {
        const native = path.join(installation, binary);
        try { await fs.access(native); await fs.access(cli); return { executable: native, prefix: [cli], node: true }; } catch { /* Try the next supported product. */ }
      }
    }
    throw new Error("Windows 的 VISUAL/EDITOR 请指向编辑器 .exe；不执行任意 .cmd/.bat shell 脚本。");
  }
  return { executable, prefix: [] };
}
const runHelper: HelperExec = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
const WINDOWS_CLIPBOARD = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $picture = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $picture) { Write-Output 'NO_IMAGE'; exit 0 }; try { $picture.Save($env:PPILOT_CLIPBOARD_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'SAVED' } finally { $picture.Dispose() }";
const MAC_CLIPBOARD = `on run argv
  try
    set imageData to the clipboard as «class PNGf»
  on error
    return "NO_IMAGE"
  end try
  set outputFile to open for access POSIX file (item 1 of argv) with write permission
  try
    set eof outputFile to 0
    write imageData to outputFile
    close access outputFile
  on error messageText
    close access outputFile
    error messageText
  end try
  return "SAVED"
end run`;
