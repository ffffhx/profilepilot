import { createReadStream, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentActivity } from "../shared/types";
import { isRecord, stringValue } from "./fs-util";
import { findAgentSessionFile, type AgentSessionFile } from "./session-context";

const ACTIVITY_ACTION_LIMIT = 60;
const ACTIVITY_MESSAGE_LIMIT = 120;

export interface SessionTailerBase {
  agent?: string;
  project?: string;
  sessionTitle?: string;
}

export class SessionTailer {
  private sessionFile: AgentSessionFile | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readChain: Promise<void> = Promise.resolve();
  private offset = 0;
  private partialLine = "";
  private parsed: AgentActivity = {};
  private started = false;

  constructor(
    private readonly session: string,
    private base: SessionTailerBase,
    private readonly onUpdate: () => void
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.pollTimer = setInterval(() => {
      this.scheduleRead();
    }, 2000);
    this.scheduleRead();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.closeWatcher();
  }

  updateBase(base: SessionTailerBase): void {
    const before = JSON.stringify(this.base);
    this.base = base;
    if (JSON.stringify(this.base) !== before) {
      this.onUpdate();
    }
  }

  getActivity(): AgentActivity {
    const inferredAgent =
      this.base.agent || (this.sessionFile?.kind === "claude" ? "Claude Code" : this.sessionFile?.kind === "codex" ? "Codex" : undefined);
    return {
      agent: inferredAgent,
      project: this.base.project,
      session: this.session,
      sessionTitle: this.base.sessionTitle,
      ...this.parsed
    };
  }

  private scheduleRead(): void {
    this.readChain = this.readChain
      .then(() => this.readNewBytes())
      .catch(() => {
        // 会话文件可能正在被写入、轮转或暂时不可读；下一轮继续尝试。
      });
  }

  private async readNewBytes(): Promise<void> {
    if (!this.started) {
      return;
    }
    if (!this.sessionFile) {
      const found = await findAgentSessionFile(this.session);
      if (!found) {
        return;
      }
      this.attachFile(found);
    }
    if (!this.sessionFile) {
      return;
    }

    const file = this.sessionFile.file;
    const stats = await stat(file).catch(() => null);
    if (!stats) {
      this.closeWatcher();
      this.sessionFile = null;
      this.offset = 0;
      this.partialLine = "";
      return;
    }
    if (stats.size < this.offset) {
      this.offset = 0;
      this.partialLine = "";
      this.parsed = {};
    }
    if (stats.size === this.offset) {
      return;
    }

    let chunkText = "";
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file, {
        encoding: "utf8",
        start: this.offset,
        end: stats.size - 1
      });
      stream.on("data", (chunk) => {
        const text = String(chunk);
        chunkText += text;
        this.offset += Buffer.byteLength(text, "utf8");
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });

    if (!chunkText) {
      return;
    }
    const changed = this.consumeLines(chunkText);
    if (changed) {
      this.onUpdate();
    }
  }

  private attachFile(file: AgentSessionFile): void {
    this.closeWatcher();
    this.sessionFile = file;
    this.offset = 0;
    this.partialLine = "";
    this.parsed = {};
    try {
      this.watcher = watch(file.file, () => {
        this.scheduleRead();
      });
    } catch {
      this.watcher = null;
    }
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close();
    } catch {
      // 文件 watcher 已关闭时忽略。
    }
    this.watcher = null;
  }

  private consumeLines(text: string): boolean {
    const lines = `${this.partialLine}${text}`.split(/\r?\n/);
    this.partialLine = lines.pop() || "";
    let changed = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      const before = JSON.stringify(this.parsed);
      if (this.sessionFile?.kind === "claude") {
        this.consumeClaudeEntry(parsed);
      } else if (this.sessionFile?.kind === "codex") {
        this.consumeCodexEntry(parsed);
      }
      changed = JSON.stringify(this.parsed) !== before || changed;
    }
    return changed;
  }

  private consumeClaudeEntry(entry: Record<string, unknown>): void {
    if (stringValue(entry.type) !== "assistant" || !isRecord(entry.message)) {
      return;
    }
    const content = entry.message.content;
    const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      const partType = stringValue(part.type);
      if (partType === "text") {
        const text = normalizeText(stringValue(part.text) || "");
        if (text) {
          this.parsed.lastMessage = truncate(text, ACTIVITY_MESSAGE_LIMIT);
          this.parsed.updatedAt = new Date().toISOString();
        }
        continue;
      }
      if (partType !== "tool_use") {
        continue;
      }
      const name = stringValue(part.name) || "";
      const input = isRecord(part.input) ? part.input : {};
      if (name === "TodoWrite") {
        this.consumeTodos(input.todos);
        continue;
      }
      if (name === "Bash") {
        const command = stringValue(input.command) || "";
        if (command.includes("agent-browser")) {
          this.parsed.currentAction = describeAgentBrowserCommand(command);
          this.parsed.updatedAt = new Date().toISOString();
          continue;
        }
      }
      if (!this.parsed.currentAction && name) {
        this.parsed.currentAction = truncate(`使用 ${name}`, ACTIVITY_ACTION_LIMIT);
        this.parsed.updatedAt = new Date().toISOString();
      }
    }
  }

  private consumeCodexEntry(entry: Record<string, unknown>): void {
    const text = codexAssistantText(entry);
    if (text) {
      this.parsed.lastMessage = truncate(text, ACTIVITY_MESSAGE_LIMIT);
      this.parsed.updatedAt = new Date().toISOString();
    }

    const commandSource = codexCommandSource(entry);
    const command = commandSource ? findAgentBrowserCommand(commandSource) : "";
    if (command) {
      this.parsed.currentAction = describeAgentBrowserCommand(command);
      this.parsed.updatedAt = new Date().toISOString();
    }
  }

  private consumeTodos(rawTodos: unknown): void {
    if (!Array.isArray(rawTodos)) {
      return;
    }
    const todos = rawTodos.filter(isRecord);
    const total = todos.length;
    const done = todos.filter((todo) => {
      const status = stringValue(todo.status);
      return status === "completed" || status === "done";
    }).length;
    const activeIndex = todos.findIndex((todo) => stringValue(todo.status) === "in_progress");
    const active = activeIndex >= 0 ? todos[activeIndex] : null;
    const pending = todos.find((todo, index) => index > activeIndex && stringValue(todo.status) === "pending")
      || todos.find((todo) => stringValue(todo.status) === "pending");

    this.parsed.todoDone = done;
    this.parsed.todoTotal = total;
    this.parsed.currentStep = active ? todoText(active) : undefined;
    this.parsed.nextStep = pending ? todoText(pending) : undefined;
    this.parsed.updatedAt = new Date().toISOString();
  }
}

function todoText(todo: Record<string, unknown>): string | undefined {
  return truncate(normalizeText(stringValue(todo.activeForm) || stringValue(todo.content) || ""), ACTIVITY_MESSAGE_LIMIT) || undefined;
}

function codexAssistantText(entry: Record<string, unknown>): string {
  const payload = isRecord(entry.payload) ? entry.payload : entry;
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.response_item) ? payload.response_item : payload;
  const role = stringValue(item.role) || stringValue(payload.role);
  const type = stringValue(item.type) || stringValue(payload.type) || stringValue(entry.type);
  if (role && role !== "assistant") {
    return "";
  }
  if (!role && type !== "message") {
    return "";
  }
  return normalizeText(messageContentText(item.content) || messageContentText(payload.content));
}

function codexCommandSource(entry: Record<string, unknown>): Record<string, unknown> | null {
  const payload = isRecord(entry.payload) ? entry.payload : entry;
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.response_item) ? payload.response_item : payload;
  const role = stringValue(item.role) || stringValue(payload.role);
  return role === "user" ? null : entry;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!isRecord(part)) {
        return "";
      }
      return stringValue(part.text) || stringValue(part.content) || "";
    })
    .filter(Boolean)
    .join(" ");
}

function findAgentBrowserCommand(value: unknown, depth = 0): string {
  if (depth > 6) {
    return "";
  }
  if (typeof value === "string") {
    return value.includes("agent-browser") ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentBrowserCommand(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return "";
  }
  if (!isRecord(value)) {
    return "";
  }

  for (const key of ["command", "cmd", "script"]) {
    const candidate = stringValue(value[key]);
    if (candidate?.includes("agent-browser")) {
      return candidate;
    }
  }

  for (const key of ["arguments", "args", "payload", "item", "response_item", "content", "call"]) {
    const nested = value[key];
    if (typeof nested === "string" && (nested.startsWith("{") || nested.startsWith("["))) {
      try {
        const parsed = JSON.parse(nested);
        const found = findAgentBrowserCommand(parsed, depth + 1);
        if (found) {
          return found;
        }
      } catch {
        // 不是 JSON 字符串则按普通字符串兜底。
      }
    }
    const found = findAgentBrowserCommand(nested, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

export function describeAgentBrowserCommand(command: string): string {
  const raw = command.slice(command.indexOf("agent-browser")).trim();
  const tokens = shellWords(raw);
  const start = tokens.findIndex((token) => token === "agent-browser" || path.basename(token) === "agent-browser");
  const args = stripAgentBrowserOptions(start >= 0 ? tokens.slice(start + 1) : tokens.slice(1));
  const verb = (args[0] || "").toLowerCase();
  const rest = args.slice(1).filter((arg) => !arg.startsWith("-"));

  if (verb === "open" || verb === "goto" || verb === "navigate") {
    return truncate(`打开 ${hostLabel(rest[0] || "")}`, ACTIVITY_ACTION_LIMIT);
  }
  if (verb === "click") {
    return truncate(rest[0] ? `点击「${rest[0]}」` : "点击页面元素", ACTIVITY_ACTION_LIMIT);
  }
  if (verb === "fill" || verb === "type" || verb === "input") {
    return "填写输入框";
  }
  if (verb === "screenshot") {
    return "截图";
  }
  if (verb === "snapshot") {
    return "读取页面结构";
  }
  if (verb === "press" || verb === "key") {
    return truncate(rest[0] ? `按键 ${rest[0]}` : "按键", ACTIVITY_ACTION_LIMIT);
  }
  if (verb === "hover") {
    return truncate(rest[0] ? `移动到「${rest[0]}」` : "移动鼠标", ACTIVITY_ACTION_LIMIT);
  }
  if (verb === "wait") {
    return "等待页面";
  }

  const summary = [verb || "agent-browser", ...rest].join(" ");
  return truncate(summary || "AI 正在操作浏览器", ACTIVITY_ACTION_LIMIT);
}

function stripAgentBrowserOptions(args: string[]): string[] {
  const valueOptions = new Set(["--cdp", "--session", "--timeout", "--profile", "--browser", "-p"]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      continue;
    }
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function hostLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname || parsed.href;
  } catch {
    return rawUrl || "页面";
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  const normalized = normalizeText(text);
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}
