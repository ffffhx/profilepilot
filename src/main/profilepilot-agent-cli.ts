import { promises as fs } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { runInteractiveChat } from "./cli/chat";
import { safeText } from "./cli/markdown";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { CreateTaskInput, TaskEvent, TaskStream } from "../shared/tasks";
import type { ManagementTask, ProfilePilotManagementCommand, ProfilePilotManagementResponse, ProfilePilotTaskCommand } from "./profilepilot-management-protocol";

export interface AgentCliIo {
  stdout: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
  stderr: Pick<NodeJS.WriteStream, "write">;
}
export type AgentCliTransport = (command: ProfilePilotManagementCommand, signal?: AbortSignal) => Promise<ProfilePilotManagementResponse>;
export interface AgentCliRuntime {
  stdin?: Readable & { isTTY?: boolean };
  signals?: Pick<NodeJS.Process, "on" | "off">;
  pollIntervalMs?: number;
  homeDir?: string;
  cwd?: string;
}
type AgentVerb = "run" | "chat" | "list" | "show" | "watch" | "reply" | "resume" | "pause" | "cancel" | "takeover" | "send";
export interface ParsedAgentCliCommand {
  local: "agent";
  verb: AgentVerb | "help";
  json: boolean;
  topic?: AgentVerb;
  command?: ProfilePilotTaskCommand;
  profile?: string;
  prompt?: string;
  promptFile?: string;
  authorization?: string;
  limits?: CreateTaskInput["limits"];
  id?: string;
  follow?: boolean;
  screenReader?: boolean;
  reducedMotion?: boolean;
}

const VERBS = new Set<AgentVerb>(["run", "chat", "list", "show", "watch", "reply", "resume", "pause", "cancel", "takeover", "send"]);
const COMMAND_OPTIONS: Record<AgentVerb, string[]> = {
  run: ["profile", "prompt-file", "authorization", "minutes", "actions", "budget", "follow", "json"],
  chat: ["profile", "resume", "prompt-file", "authorization", "minutes", "actions", "budget", "screen-reader", "reduced-motion"],
  list: ["limit", "offset", "json"], show: ["after", "limit", "json"], watch: ["after", "json"],
  reply: ["decision", "message", "approve", "reject", "follow", "json"],
  resume: ["message", "follow", "json"], pause: ["json"], cancel: ["json"], takeover: ["json"],
  send: ["follow", "json", "queue", "now"]
};
const BOOLEAN_OPTIONS = new Set(["follow", "json", "approve", "reject", "queue", "now", "screen-reader", "reduced-motion"]);

export function parseAgentCliArgs(args: string[]): ParsedAgentCliCommand {
  if (!args.length || args[0] === "--help" || args[0] === "-h") return { local: "agent", verb: "help", json: false };
  const verb = args[0] as AgentVerb;
  if (!VERBS.has(verb)) throw new Error(`不支持的 Agent 命令：${verb}。运行 ppilot --help 查看用法。`);
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let literal = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (literal) { positionals.push(arg); continue; }
    if (arg === "--") { literal = true; continue; }
    if (arg === "--help" || arg === "-h") return { local: "agent", verb: "help", topic: verb, json: false };
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    const key = arg === "-f" ? "follow" : arg.slice(2);
    if (!arg.startsWith("--") && arg !== "-f" || !COMMAND_OPTIONS[verb].includes(key)) throw new Error(`${verb} 不支持参数：${arg}`);
    if (values.has(key)) throw new Error(`参数重复：--${key}`);
    if (BOOLEAN_OPTIONS.has(key)) { values.set(key, "true"); continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith("--") || value === "-h") throw new Error(`--${key} 需要一个值。`);
    if (!value.trim()) throw new Error(`--${key} 不能为空。`);
    values.set(key, value);
  }
  const parsed: ParsedAgentCliCommand = { local: "agent", verb, json: values.has("json") };
  const number = (key: string, min: number, max: number, integer = false): number | undefined => {
    if (!values.has(key)) return undefined;
    const value = Number(values.get(key));
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) {
      throw new Error(`--${key} 需要 ${min} 到 ${max} 之间的${integer ? "整数" : "数值"}。`);
    }
    return value;
  };
  const count = (min: number, max = min): void => {
    if (positionals.length < min || positionals.length > max) throw new Error(`${verb} 的位置参数数量不正确。运行 ppilot ${verb} --help 查看用法。`);
  };
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`${verb} 需要 --${key}。`);
    return value;
  };
  if (verb === "run" || verb === "chat") {
    count(0, 1);
    const resume = values.get("resume");
    const profile = values.get("profile");
    const promptFile = values.get("prompt-file");
    if (positionals.length && promptFile) throw new Error("任务文本和 --prompt-file 不能同时使用。");
    if (resume && (profile || positionals.length || promptFile || ["authorization", "minutes", "actions", "budget"].some(key => values.has(key)))) {
      throw new Error("chat --resume 只接受已有任务 ID，不能同时指定新任务参数。");
    }
    if (verb === "run" && !profile) required("profile");
    if (verb === "run" && !positionals.length && !promptFile) throw new Error("run 需要任务文本或 --prompt-file。");
    if (verb === "chat" && promptFile === "-") throw new Error("chat 需要交互终端；请使用文件路径，或使用 run --prompt-file - 读取管道。");
    const minutes = number("minutes", 1, 1440, true);
    const actions = number("actions", 1, 10000, true);
    const budgetUsd = number("budget", Number.MIN_VALUE, 1000);
    const limits = { ...(minutes === undefined ? {} : { minutes }), ...(actions === undefined ? {} : { actions }), ...(budgetUsd === undefined ? {} : { budgetUsd }) };
    return { ...parsed, ...(profile ? { profile } : {}), ...(resume ? { id: resume } : {}),
      ...(values.has("screen-reader") ? { screenReader: true } : {}), ...(values.has("reduced-motion") ? { reducedMotion: true } : {}),
      ...(positionals.length ? { prompt: positionals[0] } : {}), ...(promptFile ? { promptFile } : {}),
      ...(values.has("authorization") ? { authorization: values.get("authorization") } : {}),
      ...(Object.keys(limits).length ? { limits } : {}), ...(values.has("follow") ? { follow: true } : {}) };
  }
  if (verb === "list") {
    count(0);
    const limit = number("limit", 1, 100, true);
    const offset = number("offset", 0, Number.MAX_SAFE_INTEGER, true);
    return { ...parsed, command: { action: "task.list", ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) } };
  }
  count(verb === "send" ? 2 : 1);
  const id = positionals[0].trim();
  if (!id) throw new Error(`${verb} 需要任务 ID。`);
  parsed.id = id;
  if (verb === "show" || verb === "watch") {
    const after = number("after", 0, Number.MAX_SAFE_INTEGER, true);
    const limit = number("limit", 1, 200, true);
    return { ...parsed, command: { action: "task.get", id, ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) } };
  }
  if (values.has("follow")) parsed.follow = true;
  if (verb === "reply") {
    if (values.has("approve") && values.has("reject")) throw new Error("--approve 与 --reject 不能同时使用。");
    if (!["message", "approve", "reject"].some(key => values.has(key))) throw new Error("reply 需要 --message、--approve 或 --reject。确认操作必须明确指定 --approve 或 --reject。");
    return { ...parsed, command: { action: "task.reply", id, decisionId: required("decision"), answer: values.get("message") || "",
      ...(values.has("approve") ? { approved: true } : values.has("reject") ? { approved: false } : {}) } };
  }
  const message = verb === "send" ? positionals[1] : values.get("message");
  if (verb === "send" && !message?.trim()) throw new Error("send 需要补充说明文本。");
  if (values.has("queue") && values.has("now")) throw new Error("--queue 与 --now 不能同时使用。");
  return { ...parsed, command: { action: "task.control", id, control: verb === "send" ? values.has("now") ? "steer" : "queue" : verb,
    ...(message === undefined ? {} : { message }) } };
}

export function agentCliHelp(topic?: AgentVerb): string {
  const common = `\n复用桌面应用中配置的模型、凭据、权限与任务记录；交互聊天会尝试自动启动已安装的应用。\n任务文本包含以 - 开头的参数时，放在 -- 之后。文本文件使用 UTF-8。\n退出码：0 成功/任务已提交，1 失败或取消，2 参数错误，3 等待输入/暂停/部分完成，69 应用未运行，130 中断。\n全屏聊天中 Ctrl+C 暂停执行并保留对话；watch/run --follow 中 Ctrl+C 退出跟随。\n用 ppilot watch <任务ID> 或 ppilot --resume <任务ID> 重新连接。\n`;
  const help: Record<AgentVerb, string> = {
    run: `ppilot run --profile <名称|ID> <任务文本> [--follow] [--json]\n  用 --prompt-file <路径|-> 代替任务文本，- 从标准输入读取。\n  可选：--authorization <授权说明> --minutes <1..1440> --actions <1..10000> --budget <大于 0、最多 1000 USD>\n  默认提交后返回任务 ID；--follow 持续显示事件直到需要输入或任务结束。`,
    chat: `ppilot\nppilot --profile <名称|ID> [任务文本]\nppilot --resume <任务ID>\n  直接运行 ppilot 进入全屏对话；未指定 Profile 时沿用已保存的选择，或在终端选择。\n  新任务支持 --prompt-file <路径>、--authorization、--minutes、--actions、--budget。\n  输入 / 浏览命令，? 查看快捷键；Ctrl+J / Shift+Enter 换行，@ 选择文件。\n  /resume 恢复历史，/continue 继续当前任务，/model 选择模型，/permissions 管理权限。\n  运行中发送的消息排队；确认操作通过菜单明确选择，/exit 可暂停或保留后台执行。`,
    list: `ppilot list [--limit <1..100>] [--offset <数量>] [--json]`,
    show: `ppilot show <任务ID> [--after <事件游标>] [--limit <1..200>] [--json]\n  返回任务详情、一页事件和下一页 cursor；hasMore 表示还有事件。`,
    watch: `ppilot watch <任务ID> [--after <事件游标>] [--json]\n  自动分页并跟随新事件；--json 输出 NDJSON：task、event、end、interrupted 或 error 记录。\n  游标为已读取事件数量；重新连接时可传上次的 cursor。`,
    reply: `ppilot reply <任务ID> --decision <确认ID> [--message <回复>] [--approve|--reject] [--follow] [--json]\n  普通问题用 --message；操作确认必须 --approve 或 --reject；完成浏览器接管后用 --approve 交还。`,
    resume: `ppilot resume <任务ID> [--message <补充说明>] [--follow] [--json]\n  继续暂停/结束的任务；待确认操作请先使用 reply。`,
    pause: `ppilot pause <任务ID> [--json]`, cancel: `ppilot cancel <任务ID> [--json]`,
    takeover: `ppilot takeover <任务ID> [--json]\n  接管后通过 reply --decision <确认ID> --approve 交还浏览器。`,
    send: `ppilot send <任务ID> <补充说明> [--queue|--now] [--follow] [--json]\n  默认 --queue 持久排队并按顺序执行；--now 中断当前执行后立即处理，待确认时需先处理确认。`
  };
  help.chat += "\n  /queue 查看、取回或撤回持久队列；Ctrl+Enter 立即发送最早排队消息。\n  --screen-reader 线性读屏，--reduced-motion 减少动态效果，也可 /accessibility 设置。\n  /agents 持续管理真实任务会话；SDK 内嵌子 Agent 仅支持观察。";
  help.watch += "\n  流式新增 NDJSON stream（id/delta/reset）与 reset（历史修订）；event 是同一 id 的最终记录。";
  return `ProfilePilot CLI · Agent commands\n\n${topic ? help[topic] : Object.values(help).join("\n\n")}\n${common}\n后台任务依赖 ProfilePilot APP 服务持续运行；关闭窗口不等于退出 APP，完全退出 APP 会停止执行。\n`;
}

type TaskPage = { task: ManagementTask; events: TaskEvent[]; cursor: number; hasMore: boolean; stream?: TaskStream; revision?: number; reset?: boolean };
type Session = { signal: AbortSignal; request: AgentCliTransport; io: AgentCliIo; json: boolean; pollMs: number };
class AgentCliError extends Error {
  constructor(message: string, readonly code: string, readonly exitCode = 1) { super(message); }
}
function aborted(): Error { return Object.assign(new Error("终端连接已中断。"), { name: "AbortError" }); }
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw aborted(); }
async function requestData<T>(session: Session, command: ProfilePilotManagementCommand): Promise<T> {
  checkSignal(session.signal);
  const response = await session.request(command, session.signal);
  checkSignal(session.signal);
  if (!response.ok) throw new AgentCliError(response.error.message, response.error.code);
  return response.data as T;
}
function record(io: AgentCliIo, value: unknown): void { io.stdout.write(`${JSON.stringify(value)}\n`); }
function taskExit(task: ManagementTask): number {
  if (task.status === "failed" || task.status === "cancelled") return 1;
  return ["waiting_user", "paused", "partial"].includes(task.status) ? 3 : 0;
}
function stopped(task: ManagementTask): boolean { return !task.running && task.status !== "running" && task.status !== "queued"; }
function formatTask(task: ManagementTask): string {
  const lines = [`${task.id} · ${task.status}${task.running && !["running", "queued"].includes(task.status) ? "（正在结束当前执行）" : ""} · ${task.title}`, `Profile：${task.profileName}`];
  if (task.pending) {
    lines.push(`需要回复 [${task.pending.kind}]：${task.pending.title}`, task.pending.details,
      `确认 ID：${task.pending.id}`, `回复：ppilot reply ${task.id} --decision ${task.pending.id} ${task.pending.kind === "question" ? '--message "你的回复"' : "--approve 或 --reject"}`);
  }
  if (task.result) {
    lines.push(task.result.summary);
    if (task.result.evidence.length) lines.push(`依据：\n${task.result.evidence.join("\n")}`);
    if (task.result.remaining.length) lines.push(`待完成：\n${task.result.remaining.join("\n")}`);
  }
  if (task.outputs?.length) lines.push(`输出文件：\n${task.outputs.map(output => `${output.name}: ${output.path}`).join("\n")}`);
  return `${lines.join("\n")}\n`;
}
function eventLine(event: TaskEvent): string { return `${event.at} [${event.kind}] ${event.text}\n`; }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", cancel); resolve(); };
    const cancel = (): void => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(aborted()); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

class TaskView {
  cursor: number;
  private signature = "";
  private revision?: number;
  private streams = new Map<string, string>();
  private committed = new Set<string>();
  constructor(private session: Session, after = 0) { this.cursor = after; }
  async read(id: string): Promise<TaskPage> {
    const page = await requestData<TaskPage>(this.session, { action: "task.get", id, after: this.cursor, limit: 200, ...(this.revision === undefined ? {} : { revision: this.revision }) });
    if (page.reset) {
      this.cursor = 0; this.streams.clear(); this.committed.clear(); this.signature = "";
      if (this.session.json) record(this.session.io, { type: "reset", taskId: id, revision: page.revision });
      else this.session.io.stdout.write("\n[历史已修订，重新读取]\n");
    }
    this.revision = page.revision;
    if (!Number.isSafeInteger(page.cursor) || page.cursor < this.cursor || page.hasMore && page.cursor === this.cursor) throw new AgentCliError("事件游标没有前进，请重新连接任务。", "INVALID_EVENT_CURSOR");
    if (!this.session.json && !this.signature) {
      this.session.io.stdout.write(formatTask(page.task));
      this.signature = JSON.stringify([page.task.status, page.task.running, page.task.pending, page.task.result, page.task.outputs]);
    }
    const start = page.cursor - page.events.length;
    for (let index = 0; index < page.events.length; index += 1) {
      const event = page.events[index];
      const streamed = this.streams.get(event.id);
      if (this.session.json) record(this.session.io, { type: "event", taskId: id, cursor: start + index + 1, event });
      else if (event.kind === "assistant" && streamed !== undefined) {
        const text = safeText(event.text);
        this.session.io.stdout.write(text.startsWith(streamed) ? text.slice(streamed.length) + "\n" : `\n[assistant 更新] ${text}\n`);
      } else this.session.io.stdout.write(eventLine(event));
      this.streams.delete(event.id);
      this.committed.add(event.id);
    }
    if (page.stream?.text && !this.committed.has(page.stream.id)) {
      const stream = page.stream, text = safeText(stream.text), prior = this.streams.get(stream.id) || "";
      if (text !== prior) {
        const append = text.startsWith(prior), delta = append ? text.slice(prior.length) : text;
        if (this.session.json) record(this.session.io, { type: "stream", taskId: id, id: stream.id, delta, ...(append ? {} : { reset: true }), updatedAt: stream.updatedAt, revision: page.revision });
        else this.session.io.stdout.write(`${prior ? append ? "" : "\n[assistant 更新] " : "\n[assistant] "}${delta}`);
        this.streams.set(stream.id, text);
      }
    }
    this.cursor = page.cursor;
    const signature = JSON.stringify([page.task.status, page.task.running, page.task.pending, page.task.result, page.task.outputs]);
    if (signature !== this.signature) {
      if (this.session.json) record(this.session.io, { type: "task", task: page.task, cursor: this.cursor });
      else this.session.io.stdout.write(formatTask(page.task));
      this.signature = signature;
    }
    return page;
  }
}

async function watchTask(id: string, session: Session, after = 0): Promise<number> {
  const view = new TaskView(session, after);
  for (;;) {
    const page = await view.read(id);
    if (!page.hasMore && stopped(page.task)) {
      const exitCode = taskExit(page.task);
      if (session.json) record(session.io, { type: "end", task: page.task, cursor: view.cursor, exitCode });
      return exitCode;
    }
    if (!page.hasMore) await delay(session.pollMs, session.signal);
  }
}

async function readPrompt(parsed: ParsedAgentCliCommand, stdin: Readable, signal: AbortSignal): Promise<string | undefined> {
  if (parsed.promptFile && parsed.promptFile !== "-") {
    let value: string;
    try { value = await fs.readFile(parsed.promptFile, "utf8"); }
    catch (error) { throw new AgentCliError(`无法读取任务文件：${(error as Error).message}`, "INVALID_PROMPT_FILE", 2); }
    return cleanPrompt(value);
  }
  if (parsed.promptFile === "-") {
    const value = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = (): void => { stdin.off("data", data); stdin.off("end", end); stdin.off("error", fail); stdin.off("close", close); signal.removeEventListener("abort", cancel); stdin.pause(); };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const cancel = (): void => fail(aborted());
      const data = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"); bytes += buffer.length;
        if (bytes > 512 * 1024) { fail(new AgentCliError("任务输入超过 512 KiB。", "INVALID_PROMPT", 2)); return; }
        chunks.push(buffer);
      };
      const end = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
      const close = (): void => stdin.readableEnded ? end() : fail(new AgentCliError("读取标准输入时连接关闭。", "STDIN_CLOSED", 2));
      if (signal.aborted) { reject(aborted()); return; }
      if (stdin.readableEnded) { resolve(""); return; }
      if (stdin.destroyed) { reject(new AgentCliError("标准输入已关闭。", "STDIN_CLOSED", 2)); return; }
      stdin.on("data", data); stdin.once("end", end); stdin.once("error", fail); stdin.once("close", close);
      signal.addEventListener("abort", cancel, { once: true }); stdin.resume();
    });
    return cleanPrompt(value);
  }
  return parsed.prompt === undefined ? undefined : cleanPrompt(parsed.prompt);
}
function cleanPrompt(value: string): string {
  const prompt = value.replace(/^\uFEFF/, "").trim();
  if (!prompt) throw new AgentCliError("任务文本不能为空。", "INVALID_PROMPT", 2);
  if (prompt.length > 30000) throw new AgentCliError("任务文本不能超过 30000 个字符。", "INVALID_PROMPT", 2);
  return prompt;
}
function createCommand(parsed: ParsedAgentCliCommand, prompt: string): ProfilePilotTaskCommand {
  return { action: "task.create", profile: parsed.profile!, input: { prompt,
    ...(parsed.authorization ? { authorization: parsed.authorization } : {}), ...(parsed.limits ? { limits: parsed.limits } : {}) } };
}

class ChatInput {
  readonly lines: Array<{ text: string; decisionId?: string }> = [];
  decisionId?: string;
  closed = false;
  private wake?: () => void;
  private reader: Interface;
  constructor(private stdin: Readable & { isTTY?: boolean }, io: AgentCliIo, interrupt: () => void) {
    this.reader = createInterface({ input: stdin, output: io.stdout as Writable, terminal: Boolean(stdin.isTTY && io.stdout.isTTY) });
    this.reader.on("line", text => { this.lines.push({ text, decisionId: this.decisionId }); this.wake?.(); });
    this.reader.on("close", () => { this.closed = true; this.wake?.(); });
    this.reader.on("SIGINT", interrupt);
  }
  async wait(signal: AbortSignal, ms?: number): Promise<void> {
    checkSignal(signal);
    if (this.lines.length || this.closed) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => { clearTimeout(timer); this.wake = undefined; signal.removeEventListener("abort", cancel); };
      const finish = (): void => { cleanup(); resolve(); };
      const cancel = (): void => { cleanup(); reject(aborted()); };
      this.wake = finish;
      signal.addEventListener("abort", cancel, { once: true });
      if (ms !== undefined) timer = setTimeout(finish, ms);
    });
  }
  close(): void { this.reader.close(); this.reader.removeAllListeners(); this.stdin.pause(); }
}

async function chooseChatProfile(session: Session, input: ChatInput): Promise<string | undefined> {
  const result = await requestData<{ profiles: Array<{ id: string; name: string; source: string; agent_access: string }> }>(session, { action: "profile.list" });
  const profiles = result.profiles.filter(profile => profile.agent_access !== "blocked" && ["isolated", "native"].includes(profile.source));
  if (!profiles.length) throw new AgentCliError("没有可用的 Agent Profile。请先在桌面应用中创建 Profile 或允许 Agent 连接。", "NO_AGENT_PROFILE");
  session.io.stdout.write(`选择本次对话使用的 Profile：\n${profiles.map((profile, index) => `  ${index + 1}. ${profile.name} (${profile.id})`).join("\n")}\n`);
  for (;;) {
    session.io.stdout.write("Profile 编号或名称（/exit 退出）> ");
    while (!input.lines.length && !input.closed) await input.wait(session.signal);
    checkSignal(session.signal);
    if (!input.lines.length) return;
    const choice = input.lines.shift()!.text.trim();
    if (choice === "/exit") return;
    if (choice === "/help") { session.io.stdout.write("输入列表编号、唯一名称或完整 ID 选择 Profile；选择后即可输入任务并与 Agent 对话。\n"); continue; }
    const number = /^[1-9]\d*$/.test(choice) ? Number(choice) : NaN;
    const byId = profiles.find(profile => profile.id === choice);
    const matches = profiles.filter(profile => profile.name === choice);
    const selected = byId || (Number.isSafeInteger(number) ? profiles[number - 1] : matches.length === 1 ? matches[0] : undefined);
    if (selected) { session.io.stdout.write(`已选择：${selected.name}\n`); return selected.id; }
    session.io.stderr.write("请选择列表中的编号、唯一名称或完整 ID。\n");
  }
}

async function chat(parsed: ParsedAgentCliCommand, prompt: string | undefined, session: Session, stdin: Readable & { isTTY?: boolean }, interrupt: () => void, rememberId: (id: string) => void): Promise<number> {
  const input = new ChatInput(stdin, session.io, interrupt);
  let id = parsed.id;
  let task: ManagementTask | undefined;
  let view = new TaskView(session);
  let promptKey = "";
  session.io.stdout.write("ppilot · ProfilePilot Agent\n输入 /help 查看命令，Ctrl+C 或 /exit 退出连接。\n");
  try {
    if (!id && !parsed.profile) {
      const profile = await chooseChatProfile(session, input);
      if (!profile) return 0;
      parsed = { ...parsed, profile };
    }
    if (id) rememberId(id);
    else if (prompt) {
      task = (await requestData<{ task: ManagementTask }>(session, createCommand(parsed, prompt))).task;
      id = task.id; rememberId(id);
    }
    for (;;) {
      checkSignal(session.signal);
      let more = false;
      if (id) { const page = await view.read(id); task = page.task; more = page.hasMore; }
      if (more) continue;
      if (input.closed && !input.lines.length) return task ? taskExit(task) : 0;
      const ready = !task || stopped(task);
      const key = ready ? task?.pending?.id || task?.status || "new" : "running";
      input.decisionId = ready ? task?.pending?.id : undefined;
      if (key !== promptKey) {
        const message = !task ? "任务 > " : task.pending?.kind === "confirmation" ? "确认操作？输入 yes 或 no > "
          : task.pending?.kind === "handoff" ? "请完成浏览器操作，输入 yes 交还浏览器 > "
          : task.pending ? "回复 > " : ready ? "继续任务的消息（或 /exit）> " : "运行中，可输入补充说明或 /pause。\n";
        session.io.stdout.write(message); promptKey = key;
      }
      if (!input.lines.length) { await input.wait(session.signal, session.pollMs); continue; }
      const submitted = input.lines.shift()!;
      const line = submitted.text.trim();
      if (!line) { promptKey = ""; continue; }
      const [slash, ...rest] = line.split(/\s+/);
      if (slash === "/exit") return task ? taskExit(task) : 0;
      if (slash === "/help") { session.io.stdout.write("/pause 暂停 · /resume [说明] 继续 · /cancel 取消任务 · /exit 退出连接\n普通文本会创建任务、回复问题或继续当前任务；确认操作需输入 yes/no。\n"); promptKey = ""; continue; }
      try {
        let command: ProfilePilotTaskCommand;
        // A queued answer belongs to the decision shown when it was typed.
        // After another answer clears that decision it must not become a new
        // instruction that resumes or steers the task.
        if (!line.startsWith("/") && submitted.decisionId && submitted.decisionId !== task?.pending?.id) {
          throw new AgentCliError("刚才的问题已处理，旧的回复不会作为新任务指令执行。请根据当前状态重新输入。", "STALE_CHAT_DECISION", 2);
        }
        if (line.startsWith("/")) {
          if (!["/pause", "/resume", "/cancel"].includes(slash)) throw new AgentCliError("未知命令，输入 /help 查看帮助。", "INVALID_CHAT_COMMAND", 2);
          if (!id) throw new AgentCliError("请先输入任务文本。", "NO_ACTIVE_TASK", 2);
          if (slash !== "/resume" && rest.length) throw new AgentCliError(`${slash} 不接受参数。`, "INVALID_CHAT_COMMAND", 2);
          command = { action: "task.control", id, control: slash.slice(1) as "pause" | "resume" | "cancel", ...(rest.length ? { message: rest.join(" ") } : {}) };
        } else if (!id) command = createCommand(parsed, line);
        else if (task?.pending) {
          if (!ready) throw new AgentCliError("正在结束当前执行，请等待出现回复提示后再操作。", "TASK_DRAINING");
          const pending = task.pending;
          if (submitted.decisionId !== pending.id) throw new AgentCliError("待回复的问题已改变，请阅读当前问题后重新输入。之前输入的文本不会批准新操作。", "STALE_CHAT_DECISION", 2);
          if (pending.kind === "confirmation" || pending.kind === "handoff") {
            if (!/^(yes|no)$/i.test(line) || pending.kind === "handoff" && !/^yes$/i.test(line)) {
              throw new AgentCliError(pending.kind === "handoff" ? "交还浏览器需要明确输入 yes；尚未完成可用 /exit 离开。" : "请明确输入 yes 或 no；空白和其他文本不会批准操作。", "EXPLICIT_APPROVAL_REQUIRED", 2);
            }
            command = { action: "task.reply", id, decisionId: pending.id, answer: "", approved: /^yes$/i.test(line) };
          } else command = { action: "task.reply", id, decisionId: pending.id, answer: line };
        } else command = { action: "task.control", id, control: ready ? "resume" : "queue", message: line, requestId: randomUUID() };
        input.decisionId = undefined;
        const result = await requestData<{ task: ManagementTask }>(session, command);
        task = result.task;
        if (!id) { id = task.id; rememberId(id); view = new TaskView(session); }
      } catch (error) {
        if (!(error instanceof AgentCliError)) throw error;
        session.io.stderr.write(`[ProfilePilot] ${error.message} (${error.code})\n`);
      }
      promptKey = "";
    }
  } finally { input.close(); }
}

export async function runAgentCli(parsed: ParsedAgentCliCommand, io: AgentCliIo, request: AgentCliTransport, runtime: AgentCliRuntime = {}): Promise<number> {
  const terminalIo = io;
  if (!parsed.json) io = {
    stdout: { isTTY: terminalIo.stdout.isTTY, write: chunk => terminalIo.stdout.write(safeText(String(chunk))) },
    stderr: { write: chunk => terminalIo.stderr.write(safeText(String(chunk))) }
  };
  if (parsed.verb === "help") { io.stdout.write(agentCliHelp(parsed.topic)); return 0; }
  const stdin = runtime.stdin || process.stdin;
  const signals = runtime.signals || process;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  signals.on("SIGINT", interrupt); signals.on("SIGTERM", interrupt);
  const session: Session = { signal: controller.signal, request, io, json: parsed.json, pollMs: runtime.pollIntervalMs ?? 500 };
  let activeId = parsed.id;
  try {
    if (parsed.verb === "chat" && !stdin.isTTY) throw new AgentCliError("agent chat 需要交互终端。管道或脚本请用 agent run --prompt-file - --follow [--json]。", "TTY_REQUIRED", 2);
    const prompt = await readPrompt(parsed, stdin, controller.signal);
    if (parsed.verb === "chat") {
      if (typeof (stdin as NodeJS.ReadStream).setRawMode === "function" && io.stdout.isTTY) {
        return await runInteractiveChat({ parsed, prompt, io: terminalIo, stdin, request, signal: controller.signal, homeDir: runtime.homeDir, cwd: runtime.cwd, pollMs: runtime.pollIntervalMs });
      }
      const code = await chat(parsed, prompt, session, stdin, interrupt, id => { activeId = id; });
      if (activeId) io.stdout.write(`已退出连接。重新连接：ppilot --resume ${activeId}\n`);
      return code;
    }
    if (parsed.verb === "watch") return await watchTask(parsed.id!, session, parsed.command?.action === "task.get" ? parsed.command.after : undefined);
    const command = parsed.verb === "run" ? createCommand(parsed, prompt!) : parsed.command!;
    if ((command.action === "task.control" && command.message || command.action === "task.reply") && !("requestId" in command && command.requestId)) Object.assign(command, { requestId: randomUUID() });
    const data = await requestData<Record<string, unknown>>(session, command);
    const task = data.task as ManagementTask | undefined;
    if (task) activeId = task.id;
    if (parsed.json) record(io, parsed.follow ? { type: "task", task } : { ok: true, data });
    else if (command.action === "task.list") {
      const tasks = data.tasks as ManagementTask[];
      io.stdout.write(tasks.length ? `${tasks.map(item => `${item.id} · ${item.status} · ${item.profileName} · ${item.title}`).join("\n")}\n` : "没有任务。\n");
      io.stdout.write(`共 ${data.total} 个任务。\n`);
    } else if (task) {
      io.stdout.write(formatTask(task));
      if (command.action === "task.get") {
        for (const event of data.events as TaskEvent[]) io.stdout.write(eventLine(event));
        io.stdout.write(`事件游标：${data.cursor}${data.hasMore ? `；下一页：ppilot show ${task.id} --after ${data.cursor}` : ""}\n`);
      } else if (!parsed.follow) io.stdout.write(`查看进度：ppilot watch ${task.id}\n`);
    }
    if (parsed.follow && activeId) return await watchTask(activeId, session);
    return 0;
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      const recovery = activeId ? `ppilot ${parsed.verb === "chat" ? "--resume" : "watch"} ${activeId}` : undefined;
      if (parsed.json) record(io, { type: "interrupted", taskId: activeId, recovery, exitCode: 130 });
      else io.stderr.write(`\n已退出终端连接，后台任务不会因此取消；执行依赖 ProfilePilot APP 服务保持运行（完全退出 APP 会停止执行）。${recovery ? `\n重新连接：${recovery}` : ""}\n`);
      return 130;
    }
    const candidate = error as NodeJS.ErrnoException;
    const unavailable = candidate.code === "ENOENT" || candidate.code === "ECONNREFUSED" || candidate.code === "EPIPE";
    const code = error instanceof AgentCliError ? error.code : unavailable ? "PROFILEPILOT_APP_NOT_RUNNING" : "PROFILEPILOT_CLI_ERROR";
    const message = unavailable ? "无法连接 ProfilePilot。请先启动桌面应用后重试。" : candidate.message || String(error);
    const exitCode = error instanceof AgentCliError ? error.exitCode : unavailable ? 69 : 1;
    if (parsed.json) record(io, { type: "error", ok: false, error: { code, message }, exitCode });
    else io.stderr.write(`[ProfilePilot] ${message} (${code})\n`);
    return exitCode;
  } finally { signals.off("SIGINT", interrupt); signals.off("SIGTERM", interrupt); }
}
