import { createReadStream, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentActivity } from "../shared/types";
import { isRecord, stringValue } from "./fs-util";
import { findAgentSessionFile, type AgentSessionFile } from "./session-context";

const ACTIVITY_ACTION_LIMIT = 60;
const ACTIVITY_MESSAGE_LIMIT = 120;
const ACTIVITY_TARGET_URL_LIMIT = 90;
const MAX_FULL_INITIAL_READ_BYTES = 50 * 1024 * 1024;
const INITIAL_TAIL_READ_BYTES = 2 * 1024 * 1024;

type ParsedAgentActivity = AgentActivity & {
  targetUrl?: string;
};

export interface SessionTailerBase {
  agent?: string;
  project?: string;
  sessionTitle?: string;
}

export interface SessionTailerOptions {
  pollIntervalMs?: number;
}

export type AgentControlPhase = "unknown" | "active" | "completed";

export class SessionTailer {
  private sessionFile: AgentSessionFile | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readChain: Promise<void> = Promise.resolve();
  private offset = 0;
  private partialLine = "";
  private parsed: ParsedAgentActivity = {};
  private controlPhase: AgentControlPhase = "unknown";
  private started = false;

  constructor(
    private readonly session: string,
    private base: SessionTailerBase,
    private readonly onUpdate: () => void,
    private readonly options: SessionTailerOptions = {}
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.pollTimer = setInterval(() => {
      this.scheduleRead();
    }, this.pollIntervalMs());
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

  getControlPhase(): AgentControlPhase {
    return this.controlPhase;
  }

  private scheduleRead(): void {
    this.readChain = this.readChain
      .then(() => this.readNewBytes())
      .catch(() => {
        // 会话文件可能正在被写入、轮转或暂时不可读；下一轮继续尝试。
      });
  }

  private pollIntervalMs(): number {
    return Math.max(1, this.options.pollIntervalMs ?? 2000);
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
      this.controlPhase = "unknown";
    }
    if (this.offset === 0 && stats.size > MAX_FULL_INITIAL_READ_BYTES) {
      // 超大会话档案首次接入只扫尾部；第一条半截 JSONL 解析失败即可自然跳过。
      this.offset = Math.max(0, stats.size - INITIAL_TAIL_READ_BYTES);
      this.partialLine = "";
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
    this.controlPhase = "unknown";
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
      const before = JSON.stringify({ parsed: this.parsed, controlPhase: this.controlPhase });
      if (this.sessionFile?.kind === "claude") {
        this.consumeClaudeEntry(parsed);
      } else if (this.sessionFile?.kind === "codex") {
        this.consumeCodexEntry(parsed);
      }
      changed = JSON.stringify({ parsed: this.parsed, controlPhase: this.controlPhase }) !== before || changed;
    }
    return changed;
  }

  private consumeClaudeEntry(entry: Record<string, unknown>): void {
    const entryType = stringValue(entry.type);
    if (entryType === "user" && isRecord(entry.message) && isClaudeTurnStart(entry.message.content)) {
      this.controlPhase = "active";
      return;
    }
    if (entryType !== "assistant" || !isRecord(entry.message)) {
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
        const text = assistantMessageText(stringValue(part.text) || "");
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
        const command = findBrowserDriverCommand(input.command);
        if (command) {
          this.consumeBrowserDriverCommand(command);
          continue;
        }
      }
      const browserCommand = findBrowserDriverCommand({ name, input });
      if (browserCommand) {
        this.consumeBrowserDriverCommand(browserCommand);
        continue;
      }
      if (!this.parsed.currentAction && name) {
        this.parsed.currentAction = truncate(`使用 ${name}`, ACTIVITY_ACTION_LIMIT);
        this.parsed.updatedAt = new Date().toISOString();
      }
    }
    if (stringValue(entry.message.stop_reason) === "end_turn") {
      this.controlPhase = "completed";
    }
  }

  private consumeCodexEntry(entry: Record<string, unknown>): void {
    const payload = isRecord(entry.payload) ? entry.payload : entry;
    const eventType = stringValue(payload.type);
    if (eventType === "task_started") {
      this.controlPhase = "active";
    } else if (eventType === "task_complete") {
      this.controlPhase = "completed";
    }

    const text = codexAssistantText(entry);
    if (text) {
      this.parsed.lastMessage = truncate(text, ACTIVITY_MESSAGE_LIMIT);
      this.parsed.updatedAt = new Date().toISOString();
    }

    const commandSource = codexCommandSource(entry);
    const command = commandSource ? findBrowserDriverCommand(commandSource) : "";
    if (command) {
      this.consumeBrowserDriverCommand(command);
    }

    const plan = codexPlanSteps(entry);
    if (plan) {
      this.consumeTodos(plan);
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

  private consumeBrowserDriverCommand(command: string): void {
    this.parsed.currentAction = describeBrowserDriverCommand(command);
    const target = browserDriverTargetUrl(command);
    if (target.hasTargetCommand) {
      this.parsed.targetUrl = target.targetUrl;
    }
    this.parsed.updatedAt = new Date().toISOString();
  }
}

function isClaudeTurnStart(content: unknown): boolean {
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text" }] : [];
  return !parts.some((part) => isRecord(part) && stringValue(part.type) === "tool_result");
}

function todoText(todo: Record<string, unknown>): string | undefined {
  return truncate(
    normalizeText(stringValue(todo.activeForm) || stringValue(todo.content) || stringValue(todo.step) || ""),
    ACTIVITY_MESSAGE_LIMIT
  ) || undefined;
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
  return assistantMessageText(messageContentText(item.content) || messageContentText(payload.content));
}

function codexCommandSource(entry: Record<string, unknown>): Record<string, unknown> | null {
  const payload = isRecord(entry.payload) ? entry.payload : entry;
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.response_item) ? payload.response_item : payload;
  const role = stringValue(item.role) || stringValue(payload.role);
  if (role === "user") {
    return null;
  }

  const type = stringValue(item.type) || stringValue(payload.type) || stringValue(entry.type);
  const name = stringValue(item.name) || stringValue(payload.name);
  if (type === "function_call" || type === "tool_call" || type === "shell") {
    return {
      name,
      arguments: item.arguments ?? payload.arguments,
      input: item.input ?? payload.input,
      command: item.command ?? payload.command,
      cmd: item.cmd ?? payload.cmd,
      script: item.script ?? payload.script
    };
  }
  return null;
}

function codexPlanSteps(entry: Record<string, unknown>): Record<string, unknown>[] | null {
  const payload = isRecord(entry.payload) ? entry.payload : entry;
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.response_item) ? payload.response_item : payload;
  const type = stringValue(item.type) || stringValue(payload.type) || stringValue(entry.type);
  const name = stringValue(item.name) || stringValue(payload.name);

  if (type === "plan" || type === "update_plan") {
    return planArray(item.plan ?? payload.plan);
  }
  if (name !== "update_plan" && name !== "functions.update_plan") {
    return null;
  }

  const args = parseJsonRecord(item.arguments ?? payload.arguments) || parseJsonRecord(item.input ?? payload.input);
  return args ? planArray(args.plan) : null;
}

function planArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(isRecord);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

export function findAgentBrowserCommand(value: unknown, depth = 0): string {
  if (depth > 6) {
    return "";
  }
  if (typeof value === "string") {
    return parseAgentBrowserActions(value).length > 0 ? value : "";
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
    if (candidate && parseAgentBrowserActions(candidate).length > 0) {
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

export function findBrowserDriverCommand(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") {
    return parseBrowserDriverActions(value).length > 0 ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBrowserDriverCommand(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";

  const mcpCommand = chromeDevtoolsMcpToolCommand(value);
  if (mcpCommand) return mcpCommand;
  for (const key of ["command", "cmd", "script"]) {
    const candidate = stringValue(value[key]);
    if (candidate && parseBrowserDriverActions(candidate).length > 0) return candidate;
  }
  for (const key of ["arguments", "args", "input", "payload", "item", "response_item", "content", "call"]) {
    const nested = value[key];
    if (typeof nested === "string" && (nested.startsWith("{") || nested.startsWith("["))) {
      try {
        const found = findBrowserDriverCommand(JSON.parse(nested), depth + 1);
        if (found) return found;
      } catch {
        // Continue with the ordinary string/object traversal.
      }
    }
    const found = findBrowserDriverCommand(nested, depth + 1);
    if (found) return found;
  }
  return "";
}

export function describeBrowserDriverCommand(command: string): string {
  const agentActions = parseAgentBrowserActions(command);
  if (agentActions.length) return describeAgentBrowserCommand(command);
  const actions = parseBrowserDriverActions(command);
  const action = actions[0];
  if (!action) return "AI 正在操作浏览器";
  const pseudo = ["agent-browser", action.verb, ...action.rest]
    .map((token) => JSON.stringify(token))
    .join(" ");
  return describeAgentBrowserCommand(pseudo).replace(/^agent-browser\s+/, "");
}

export function describeAgentBrowserCommand(command: string): string {
  const actions = parseAgentBrowserActions(command);
  const action = actions[0] || fallbackAgentBrowserAction(command);
  if (!action) {
    return "AI 正在操作浏览器";
  }
  const { verb, rest } = action;

  let description: string;
  if (verb === "open" || verb === "goto" || verb === "navigate") {
    description = `打开 ${hostLabel(rest[0] || "")}`;
  } else if (verb === "click") {
    description = rest[0] ? `点击「${rest[0]}」` : "点击页面元素";
  } else if (verb === "fill" || verb === "type" || verb === "input") {
    description = "填写输入框";
  } else if (verb === "screenshot") {
    description = "截图";
  } else if (verb === "snapshot") {
    description = "读取页面结构";
  } else if (verb === "press" || verb === "key") {
    description = rest[0] ? `按键 ${rest[0]}` : "按键";
  } else if (verb === "hover") {
    description = rest[0] ? `移动到「${rest[0]}」` : "移动鼠标";
  } else if (verb === "mouse") {
    description = "移动/点击鼠标";
  } else if (verb === "scroll") {
    description = "滚动页面";
  } else if (verb === "wait") {
    description = "等待";
  } else if (verb === "eval") {
    description = "执行脚本";
  } else if (verb === "back") {
    description = "后退";
  } else if (verb === "forward") {
    description = "前进";
  } else if (verb === "reload") {
    description = "刷新页面";
  } else if (verb === "close") {
    description = "关闭页面";
  } else {
    description = [verb || "agent-browser", ...rest].join(" ") || "AI 正在操作浏览器";
  }

  return truncate(actions.length > 1 ? `${description}等 ${actions.length} 步操作` : description, ACTIVITY_ACTION_LIMIT);
}

export function extractAgentBrowserTargetUrl(command: string): string | undefined {
  return agentBrowserTargetUrl(command).targetUrl;
}

interface AgentBrowserAction {
  segment: string;
  verb: string;
  rest: string[];
}

const AGENT_BROWSER_ACTION_VERBS = new Set([
  "open",
  "goto",
  "navigate",
  "click",
  "fill",
  "type",
  "input",
  "press",
  "key",
  "screenshot",
  "snapshot",
  "eval",
  "scroll",
  "back",
  "forward",
  "reload",
  "close",
  "mouse",
  "hover",
  "wait"
]);

const AGENT_BROWSER_TARGET_VERBS = new Set(["open", "goto", "navigate"]);

function chromeDevtoolsMcpToolCommand(value: Record<string, unknown>): string {
  const name = stringValue(value.name) || "";
  if (!/(?:chrome[-_ ]?devtools|devtools[-_ ]?chrome)/i.test(name)) return "";
  const rawTool = name.split("__").filter(Boolean).at(-1) || name.split(/[.:/]/).filter(Boolean).at(-1) || "";
  const verb = normalizeBrowserDriverVerb(rawTool.toLowerCase());
  if (!AGENT_BROWSER_ACTION_VERBS.has(verb)) return "";
  const input = parseJsonRecord(value.input) || parseJsonRecord(value.arguments) || {};
  const argument = firstBrowserToolArgument(input, verb);
  return ["chrome-devtools-mcp", rawTool, ...(argument ? [JSON.stringify(argument)] : [])].join(" ");
}

function firstBrowserToolArgument(value: unknown, verb: string, depth = 0): string {
  if (depth > 4 || !isRecord(value)) return "";
  const preferred = AGENT_BROWSER_TARGET_VERBS.has(verb)
    ? ["url"]
    : verb === "press"
      ? ["key"]
      : ["uid", "ref", "selector", "text", "url"];
  for (const key of preferred) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const candidate = firstBrowserToolArgument(nested, verb, depth + 1);
      if (candidate) return candidate;
    }
  }
  return "";
}

function parseAgentBrowserActions(command: string): AgentBrowserAction[] {
  const actions: AgentBrowserAction[] = [];
  for (const segment of shellCommandSegments(command)) {
    const action = parseAgentBrowserActionSegment(segment);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}

function parseBrowserDriverActions(command: string): AgentBrowserAction[] {
  const actions: AgentBrowserAction[] = [];
  for (const segment of shellCommandSegments(command)) {
    const action = parseAgentBrowserActionSegment(segment) ||
      parsePlaywrightCliActionSegment(segment) ||
      parseChromeDevtoolsMcpActionSegment(segment);
    if (action) actions.push(action);
  }
  return actions;
}

function parsePlaywrightCliActionSegment(segment: string): AgentBrowserAction | null {
  const tokens = shellWords(segment.trim());
  if (!tokens.length || path.basename(tokens[0]) !== "playwright-cli") return null;
  const args = stripPlaywrightCliOptions(tokens.slice(1));
  const rawVerb = (args[0] || "").toLowerCase();
  const verb = normalizeBrowserDriverVerb(rawVerb);
  if (!AGENT_BROWSER_ACTION_VERBS.has(verb)) return null;
  return { segment, verb, rest: args.slice(1).filter((arg) => !arg.startsWith("-")) };
}

function parseChromeDevtoolsMcpActionSegment(segment: string): AgentBrowserAction | null {
  const tokens = shellWords(segment.trim());
  if (!tokens.length || path.basename(tokens[0]) !== "chrome-devtools-mcp") return null;
  const rawVerb = (tokens[1] || "").toLowerCase();
  const verb = normalizeBrowserDriverVerb(rawVerb);
  if (!AGENT_BROWSER_ACTION_VERBS.has(verb)) return null;
  return { segment, verb, rest: tokens.slice(2).filter((arg) => !arg.startsWith("-")) };
}

function normalizeBrowserDriverVerb(verb: string): string {
  const aliases: Record<string, string> = {
    "go-back": "back",
    "go-forward": "forward",
    "tab-new": "open",
    "new-page": "open",
    "new_page": "open",
    "navigate-page": "goto",
    "navigate_page": "goto",
    "take-screenshot": "screenshot",
    "take_screenshot": "screenshot",
    "take-snapshot": "snapshot",
    "take_snapshot": "snapshot",
    "evaluate-script": "eval",
    "evaluate_script": "eval",
    "press-key": "press",
    "press_key": "press",
    "fill-form": "fill",
    "fill_form": "fill",
    "type-text": "type",
    "type_text": "type",
    "wait-for": "wait",
    "wait_for": "wait",
    "close-page": "close",
    "close_page": "close"
  };
  return aliases[verb] || verb;
}

function parseAgentBrowserActionSegment(segment: string): AgentBrowserAction | null {
  const tokens = shellWords(segment.trim());
  if (!tokens.length || path.basename(tokens[0]) !== "agent-browser") {
    return null;
  }
  const args = stripAgentBrowserOptions(tokens.slice(1));
  const verb = (args[0] || "").toLowerCase();
  if (!AGENT_BROWSER_ACTION_VERBS.has(verb)) {
    return null;
  }
  return {
    segment,
    verb,
    rest: args.slice(1).filter((arg) => !arg.startsWith("-"))
  };
}

function fallbackAgentBrowserAction(command: string): AgentBrowserAction | null {
  const tokens = shellWords(command.trim());
  const start = tokens.findIndex((token) => path.basename(token) === "agent-browser");
  if (start < 0) {
    return null;
  }
  const args = stripAgentBrowserOptions(tokens.slice(start + 1));
  return {
    segment: command,
    verb: (args[0] || "").toLowerCase(),
    rest: args.slice(1).filter((arg) => !arg.startsWith("-"))
  };
}

function agentBrowserTargetUrl(command: string): { hasTargetCommand: boolean; targetUrl?: string } {
  let hasTargetCommand = false;
  let targetUrl: string | undefined;
  for (const action of parseAgentBrowserActions(command)) {
    if (!AGENT_BROWSER_TARGET_VERBS.has(action.verb)) {
      continue;
    }
    hasTargetCommand = true;
    targetUrl = targetUrlFromArgs(action.rest);
  }
  return { hasTargetCommand, targetUrl };
}

function browserDriverTargetUrl(command: string): { hasTargetCommand: boolean; targetUrl?: string } {
  let hasTargetCommand = false;
  let targetUrl: string | undefined;
  for (const action of parseBrowserDriverActions(command)) {
    if (!AGENT_BROWSER_TARGET_VERBS.has(action.verb)) continue;
    hasTargetCommand = true;
    targetUrl = targetUrlFromArgs(action.rest);
  }
  return { hasTargetCommand, targetUrl };
}

function targetUrlFromArgs(args: string[]): string | undefined {
  for (const arg of args) {
    const targetUrl = normalizeTargetUrl(arg);
    if (targetUrl) {
      return targetUrl;
    }
  }
  return undefined;
}

function normalizeTargetUrl(rawUrl: string): string | undefined {
  const value = rawUrl.trim();
  if (!value) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!parsed.protocol) {
    return undefined;
  }
  const pathLabel = `${parsed.pathname || ""}${parsed.search || ""}${parsed.hash || ""}`;
  const suffix = pathLabel === "/" ? "" : pathLabel;
  const label = parsed.host ? `${parsed.host}${suffix}` : parsed.href.replace(/^[a-z][a-z\d+.-]*:(\/\/)?/i, "");
  return truncate(label, ACTIVITY_TARGET_URL_LIMIT) || undefined;
}

function shellCommandSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaping = true;
      continue;
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      quote = quote ? null : char;
      current += char;
      continue;
    }
    if (!quote && (char === ";" || char === "|" || char === "\n" || (char === "&" && input[index + 1] === "&"))) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      if (char === "&" || (char === "|" && input[index + 1] === "|")) {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
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

function stripPlaywrightCliOptions(args: string[]): string[] {
  const valueOptions = new Set([
    "-s",
    "--s",
    "--session",
    "--cdp",
    "--endpoint",
    "--browser",
    "--profile",
    "--config"
  ]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-") && arg.includes("=")) continue;
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
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

function assistantMessageText(text: string): string {
  const meaningfulLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isToolReceiptLine(line));
  return normalizeText(meaningfulLines.join(" "));
}

function isToolReceiptLine(text: string): boolean {
  return /^[✓✗](?:\s|$)/.test(text);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  const normalized = normalizeText(text);
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}
