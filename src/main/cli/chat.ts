import { emitKeypressEvents, type Key } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { ShellTextDecoder } from "./shell-output";
import type { Readable } from "node:stream";
import type { AgentCliIo, AgentCliTransport, ParsedAgentCliCommand } from "../profilepilot-agent-cli";
import type { ManagementTask, ManagementTaskPage, ManagementTaskSummary, ProfilePilotManagementCommand } from "../profilepilot-management-protocol";
import type { TaskEvent, TaskSettings, TaskQueuedMessage } from "../../shared/tasks";
import { TerminalUI, type TerminalMessage, type TerminalState } from "./terminal";
import { InputEditor } from "./editor";
import { CliPreferencesStore } from "./preferences";
import { fileCandidates, fileMentionAt, resolveFileMentions, captureClipboardImage, editTextExternally, copyTextToClipboard } from "./attachments";
import { safeText } from "./markdown";

type Mode = "manual" | "plan" | "acceptEdits";
type Profile = { id: string; name: string; source: string; agent_access: string; task_ready?: boolean; task_unavailable_reason?: string; task_unavailable_code?: string };
type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(enabled: boolean): unknown };
type Choice = { id?: string; label: string; description?: string; detail?: string; disabled?: boolean; preview?(): Promise<void>; choose(): void | Promise<void> };
type Popup = { title: string; choices: Choice[]; selected: number; draft: string; filter: boolean; decisionId?: string; armed?: boolean };
type Question = { title: string; secret?: boolean; draft: string; editor: InputEditor; submit(text: string): Promise<void> | void };
type PendingMessage = { text: string; paths: string[]; attachmentIds?: string[]; importedPaths?: string[]; requestId?: string };
type LocalMessage = TerminalMessage & { at: string; decisionId?: string; errorScope?: string };
type ChatOptions = { parsed: ParsedAgentCliCommand; prompt?: string; io: AgentCliIo; stdin: Input; request: AgentCliTransport; signal?: AbortSignal; homeDir?: string; cwd?: string; pollMs?: number };

class ChatRequestError extends Error {
  constructor(message: string, readonly scope: string) { super(message); }
}

export const CHAT_COMMANDS = [
  ["help", "命令与快捷键"], ["clear", "开始新对话"], ["resume", "搜索并恢复历史会话"],
  ["rename", "重命名当前会话"], ["branch", "创建会话分支"], ["rewind", "回到先前的用户消息"],
  ["model", "选择模型"], ["plan", "切换计划模式"], ["permissions", "权限模式与本会话授权"],
  ["context", "查看上下文与用量"], ["compact", "压缩当前会话上下文"], ["tasks", "任务与后台执行"],
  ["agents", "持续查看、消息与停止受控任务会话"], ["background", "让当前任务在后台继续"], ["queue", "查看、取回或撤回持久队列"],
  ["profile", "选择浏览器 Profile"], ["attach", "添加文件或图片"], ["attachments", "查看或移除待发送附件"], ["theme", "选择终端主题"],
  ["config", "模型连接、主题和默认设置"], ["login", "配置模型 API 凭据"], ["status", "检查服务和模型连接"],
  ["transcript", "搜索全部历史并跳转"], ["tools", "逐项展开工具详情"], ["copy", "复制完整历史或指定消息 ID"], ["export", "导出完整历史为 Markdown"], ["accessibility", "读屏与减少动态效果"], ["limits", "当前会话执行限制"], ["pause", "暂停当前执行"], ["continue", "继续当前任务"],
  ["cancel", "取消当前任务"], ["exit", "退出 ppilot"]
] as const;

/** Stateful controller; rendering and input decoding are independently testable. */
export class AgentChat {
  private editor = new InputEditor();
  private readonly preferences: CliPreferencesStore;
  private readonly ui: TerminalUI;
  private readonly cwd: string;
  private readonly controller = new AbortController();
  private settings?: TaskSettings;
  private profiles: Profile[] = [];
  private profile?: Profile;
  private task?: ManagementTask;
  private events: TaskEvent[] = [];
  private cursor = 0;
  private historyRevision?: number;
  private stream?: { id: string; text: string; updatedAt: string };
  private messages: LocalMessage[] = [];
  private messageSequence = 0;
  private taskRevision = 0;
  private readonly savedMessages = new Map<string, LocalMessage[]>();
  private errorNotice?: string;
  private pollNotice?: string;
  private decisionNotice?: { id: string; text: string };
  private queue: PendingMessage[] = [];
  private serverQueue: TaskQueuedMessage[] = [];
  private retryMessage?: PendingMessage;
  private readonly savedQueues = new Map<string, PendingMessage[]>();
  private attachments: string[] = [];
  private mode: Mode = "manual";
  private popup?: Popup;
  private question?: Question;
  private notice = "";
  private expanded = false;
  private help = false;
  private busy = false;
  private suspended = false;
  private ended = false;
  private exitCode = 0;
  private polling = false;
  private completionIndex = 0;
  private completionSignature = "";
  private dismissedCompletion?: string;
  private fileLoading = false;
  private fileChoices: Choice[] = [];
  private fileGeneration = 0;
  private operation: Promise<void> = Promise.resolve();
  private finish?: () => void;
  private timer?: NodeJS.Timeout;
  private lastPoll = 0;
  private lastEscape = 0;
  private lastInterrupt = 0;
  private lastEof = 0;
  private decisionShown?: string;
  private shell?: ChildProcess;
  private conversationId = randomUUID();
  private readonly shellContexts = new Map<string, { text: string }>();
  private readonly eventMessages = new Map<string, { event: TaskEvent; message: LocalMessage }>();
  private timelineCache?: { key: string; messages: TerminalMessage[] };
  private expandedToolIds = new Set<string>();
  private collapsedToolIds = new Set<string>();
  private screenReader = false;
  private agentsPanel?: { tasks: ManagementTaskSummary[]; target?: string; page?: ManagementTaskPage; status?: { processes: unknown[]; subagents: unknown[]; relatedTasks?: Array<{ id: string; title?: string; status?: string }> }; updatedAt?: number; menu: "list" | "actions"; messages?: TerminalMessage[] };
  private panelPolling = false;
  private readonly signalAbort = (): void => this.close(130);
  private readonly onKey = (text: string | undefined, key: Key): void => this.key(text, key);

  constructor(private readonly options: ChatOptions) {
    this.cwd = options.cwd || process.cwd();
    this.preferences = new CliPreferencesStore({ homeDir: options.homeDir, cwd: this.cwd });
    this.ui = new TerminalUI({ stdout: options.io.stdout as NodeJS.WriteStream }, { cwd: this.cwd, version: "0.1.0" });
  }

  async run(): Promise<number> {
    const input = this.options.stdin;
    const output = this.options.io.stdout as NodeJS.WriteStream;
    const previousRaw = input.isRaw || false;
    let outputError: NodeJS.ErrnoException | undefined;
    const onOutputError = (error: NodeJS.ErrnoException): void => {
      outputError = error;
      // A terminal can close its output while the final resume hint is being
      // flushed. Treat that as a disconnect, and still release raw input.
      this.close(error.code === "EPIPE" ? 0 : 1);
    };
    output.on?.("error", onOutputError);
    try {
      const [prefs, history, draft] = await Promise.all([this.preferences.loadSettings(), this.preferences.readHistory(), this.preferences.loadDraft()]);
      this.editor.setHistory(history);
      if (draft) this.editor.setText(draft);
      if (prefs.theme) this.ui.setTheme(prefs.theme === "auto" ? (process.env.COLORFGBG?.split(";").at(-1) === "15" ? "light" : "dark") : prefs.theme);
      this.screenReader = Boolean(this.options.parsed.screenReader || process.env.PPILOT_SCREEN_READER === "1" || prefs.screenReader);
      this.ui.setAccessibility(this.screenReader, Boolean(this.options.parsed.reducedMotion || prefs.reducedMotion));
      this.ui.start();
      emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.on("keypress", this.onKey);
      input.resume();
      this.options.signal?.addEventListener("abort", this.signalAbort, { once: true });
      this.timer = setInterval(() => {
        if (this.ended || this.suspended) return;
        if (this.agentsPanel && Date.now() - (this.agentsPanel.updatedAt || 0) > 500) void this.pollAgents();
        if (Date.now() - this.lastPoll > (this.options.pollMs ?? 250)) void this.poll();
      }, 100);
      this.render();
      this.schedule(async () => {
        const [profileData, settings] = await Promise.all([
          this.request<{ profiles: Profile[] }>({ action: "profile.list" }),
          this.request<{ settings: TaskSettings }>({ action: "task.settings.get" })
        ]);
        this.settings = settings.settings;
        this.profiles = profileData.profiles.filter(p => p.agent_access !== "blocked" && ["native", "isolated"].includes(p.source));
        const selector = this.options.parsed.profile || prefs.defaultProfile;
        this.profile = this.profiles.find(p => p.id === selector || p.name === selector);
        if (this.options.parsed.profile && !this.profile && !this.options.parsed.id) throw new Error("指定的 Profile 不可用，请使用 /profile 重新选择。");
        if (this.options.parsed.id) await this.attach(this.options.parsed.id);
        if (!this.task && !this.profile) await this.profileMenu(false);
        else if (this.options.prompt) await this.submitMessage({ text: this.options.prompt, paths: [] });
        if (!this.task && this.profile?.task_ready === false) this.notice = this.profileUnavailableReason(this.profile);
        else if (!this.settings.hasApiKey) this.notice = "尚未配置模型凭据 · /login 开始配置";
      });
      if (!this.ended) await new Promise<void>(resolve => { this.finish = resolve; });
      return this.exitCode;
    } finally {
      this.ended = true;
      this.controller.abort();
      clearInterval(this.timer);
      this.options.signal?.removeEventListener("abort", this.signalAbort);
      input.off("keypress", this.onKey);
      input.setRawMode?.(previousRaw);
      input.pause();
      this.ui.stop();
      await this.preferences.saveDraft(this.popup?.draft ?? this.question?.draft ?? this.editor.text).catch(() => undefined);
      if (this.question?.secret) this.editor.destroy();
      if (this.task && !output.destroyed) output.write(`\n继续此会话：ppilot --resume ${safeText(this.task.id)}\n`);
      // Keep the error listener until asynchronous writes and their error
      // events have finished; removing it immediately can crash on EPIPE.
      if (typeof output.on === "function" && !output.destroyed) await new Promise<void>(resolve => output.write("", () => resolve()));
      await new Promise<void>(resolve => setImmediate(resolve));
      output.off?.("error", onOutputError);
      if (outputError && outputError.code !== "EPIPE") throw outputError;
    }
  }

  private async request<T>(command: ProfilePilotManagementCommand): Promise<T> {
    const scope = `${command.action}:${"id" in command ? command.id : "selector" in command ? command.selector : ""}${"control" in command ? `:${command.control}` : ""}`;
    const mutatesTask = ["task.create", "task.reply", "task.control", "task.queue", "task.limits", "task.mode", "task.model", "task.metadata", "task.rewind", "task.compact"].includes(command.action);
    if (mutatesTask) this.taskRevision++;
    try {
      const response = await this.options.request(command, this.controller.signal);
      if (!response.ok) throw new Error(response.error.message);
      this.resolveErrors(scope);
      return response.data as T;
    } catch (error) {
      throw new ChatRequestError(error instanceof Error ? error.message : String(error), scope);
    } finally { if (mutatesTask) this.taskRevision++; }
  }

  private resolveErrors(scope: string): void {
    for (const message of this.messages) {
      if (message.errorScope === scope && !message.collapsedText) message.collapsedText = `重试成功 · 历史错误：${message.text.split("\n")[0]}`;
    }
    if (this.notice === this.errorNotice && !this.messages.some(message => message.role === "error" && !message.collapsedText)) this.notice = "";
  }

  private schedule(action: () => void | Promise<void>): void {
    this.operation = this.operation.then(async () => {
      if (this.ended) return;
      this.busy = true; this.render();
      try { await action(); }
      catch (error) { if (!this.ended) this.error(error); }
      finally { this.busy = false; this.render(); }
    });
  }

  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.addMessage({ role: "error", text: message }, undefined, { errorScope: error instanceof ChatRequestError ? error.scope : undefined });
    this.notice = this.errorNotice = "操作未完成 · 修正后重试，或 /status 检查连接";
  }

  private addMessage(message: TerminalMessage, at = new Date().toISOString(), metadata: Pick<LocalMessage, "decisionId" | "errorScope"> = {}): LocalMessage {
    const record = { ...message, id: message.id ?? `local-${++this.messageSequence}`, at, ...metadata };
    this.messages.push(record);
    return record;
  }

  private async poll(): Promise<void> {
    if (!this.task || this.polling || this.busy || this.ended) return;
    this.polling = true; this.lastPoll = Date.now();
    const id = this.task.id;
    const revision = this.taskRevision;
    try {
      for (let n = 0; n < 20; n++) {
        const page = await this.request<ManagementTaskPage>({ action: "task.get", id, after: this.cursor, limit: 200, revision: this.historyRevision });
        if (this.task?.id !== id || this.ended || revision !== this.taskRevision) return;
        this.task = page.task;
        this.mode = page.task.mode || this.mode;
        if (page.reset) { this.events = []; this.eventMessages.clear(); }
        this.events.push(...page.events);
        this.historyRevision = page.revision;
        this.serverQueue = page.task.messageQueue || [];
        this.cursor = page.cursor;
        this.stream = page.stream;
        if (!page.hasMore) break;
      }
      if (this.notice === this.pollNotice) this.notice = "";
      this.pollNotice = undefined;
      this.checkDecision();
      this.render();
    } catch (error) {
      if (!this.ended && this.task?.id === id && revision === this.taskRevision) { this.notice = this.pollNotice = `连接中断：${error instanceof Error ? error.message : error} · /status 重试`; this.lastPoll = Date.now() + 2000; }
    } finally { this.polling = false; }
  }

  private render(): void {
    if (this.ended || this.suspended) return;
    const timelineKey = `${this.task?.id}:${this.historyRevision}:${this.events.length}:${this.events.at(-1)?.id}:${this.stream?.id}:${this.stream?.text}:${this.help}:${JSON.stringify(this.messages)}`;
    if (this.timelineCache?.key !== timelineKey) {
    const timeline: Array<TerminalMessage & { at: string }> = this.events.map(event => {
      const cached = this.eventMessages.get(event.id);
      if (cached?.event === event) return cached.message;
      const message: LocalMessage = {
      id: event.id,
      at: event.at,
      role: event.kind === "action" ? "tool" : event.kind,
      text: event.text,
      ...(event.kind === "assistant" && event.text.startsWith('上次执行结果：{"') ? { collapsedText: "上次结果已保留 · Ctrl+O 展开" } : {}),
      ...(event.kind === "action" ? { title: event.text.split("\n")[0], detail: event.text.split("\n").slice(1).join("\n"), status: "unknown" as const } : {})
      };
      this.eventMessages.set(event.id, { event, message }); return message;
    });
    if (this.stream?.text && !this.events.some(event => event.id === this.stream!.id)) timeline.push({ id: this.stream.id, at: this.stream.updatedAt, role: "assistant", text: this.stream.text, status: "running" });
    timeline.push(...this.messages);
    // Stable sorting preserves server order for equal timestamps, while local
    // confirmations/errors stay at their original point in the conversation.
    const conversation: TerminalMessage[] = timeline.sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0));
    if (this.help) conversation.push({ role: "system", text: [
      "/ 命令    @ 文件    ! 本地终端命令",
      "Enter 发送    Ctrl+J / Shift+Enter 换行",
      "Esc / Ctrl+C 中断当前执行    Ctrl+D 退出",
      "Ctrl+R 搜索输入历史    Ctrl+S 暂存草稿    Ctrl+G 外部编辑器",
      "Ctrl+K/U/W 剪切    Ctrl+Y 粘回    Alt+Y 轮换    Ctrl+Shift+Z 重做",
      "Ctrl+O 全部工具    /tools 单项详情    /transcript 全历史查找与跳转",
      "Ctrl+T 任务    Ctrl+B 转后台    /agents 持续查看与定向消息",
      "Shift+Tab 切换模式    Alt+P 模型    Alt+V 粘贴图片",
      "PgUp/PgDn 滚动    空输入双 Esc 回退会话    ? 收起帮助"
    ].join("\n") });
    this.timelineCache = { key: timelineKey, messages: conversation };
    }
    const conversation = this.agentsPanel?.page ? this.agentPanelMessages() : this.timelineCache!.messages;
    const choices = this.currentChoices();
    const popup = this.popup;
    const displayTask = this.agentsPanel?.page?.task || this.task;
    const observing = Boolean(this.agentsPanel?.page);
    this.editor.setViewportWidth(Math.max(1, ((this.options.io.stdout as NodeJS.WriteStream).columns || 80) - 3));
    const input = this.editor.view();
    const footer = input.search ? `历史搜索：${input.search.query}${input.search.index < 0 ? "（无匹配）" : ""} · Ctrl+R 下一个 · Enter 取回 · Esc 返回` : this.serverQueue.length ? `${this.serverQueue.length} 条已保存队列 · /queue 管理 · ↑ 取回 · Ctrl+Enter 立即发送` : `${this.modeLabel()} · ? 快捷键 · / 命令`;
    const state: TerminalState = {
      messages: conversation,
      transcriptVersion: this.agentsPanel?.page ? String(this.agentsPanel.updatedAt) : timelineKey,
      input: { ...input, placeholder: input.placeholder || this.question?.title || (popup && !popup.filter ? "↑/↓ 选择 · Enter 确认 · Esc 返回（此处不输入文本）" : this.task?.pending?.kind === "question" ? "回答 Agent 的问题…" : "向 Agent 描述你的任务…"), ...(this.question?.secret ? { masked: true } : {}) },
      model: displayTask?.model || this.settings?.model || "连接模型…", profile: observing ? displayTask?.profileName : this.profile?.name || this.task?.profileName,
      mode: this.modeLabel(), busy: this.busy || Boolean(displayTask?.running) || Boolean(this.shell),
      status: (observing ? `查看 ${displayTask?.id.slice(0, 8)} · ` : "") + (this.question?.title || (this.shell ? "正在执行终端命令" : displayTask?.pending?.title || (displayTask?.running ? "正在处理" : displayTask?.status === "paused" ? "已暂停 · 输入消息继续" : ""))),
      footer, notice: [this.notice, this.attachments.map(file => `[${/\.(png|jpe?g|gif|webp)$/i.test(file) ? "Image" : "File"}: ${path.basename(file)}]`).join(" ")].filter(Boolean).join(" · "),
      expandedTools: this.expanded, expandedToolIds: this.expandedToolIds, collapsedToolIds: this.collapsedToolIds, showWelcome: !conversation.length,
      context: displayTask ? `${displayTask.usage.inputTokens + displayTask.usage.outputTokens} tokens · $${displayTask.usage.costUsd.toFixed(4)}` : undefined,
      ...(choices.length || popup || this.completionVisible() ? { menu: { title: popup?.title || (this.editor.text.startsWith("/") ? "命令" : "文件"), items: choices, selected: popup?.selected ?? this.completionIndex, loading: this.fileLoading, filter: popup?.filter ? this.editor.text : undefined } } : {})
    };
    this.ui.render(state);
  }

  private modeLabel(): string { return this.mode === "plan" ? "plan mode" : this.mode === "acceptEdits" ? "accept edits" : "manual mode"; }

  private currentChoices(): Choice[] {
    if (this.popup) {
      const query = this.popup.filter ? this.editor.text.trim().toLowerCase() : "";
      const rows = this.popup.choices.filter(choice => !query || `${choice.id || ""} ${choice.label} ${choice.description || ""} ${choice.detail || ""}`.toLowerCase().includes(query));
      this.popup.selected = Math.max(0, Math.min(this.popup.selected, rows.length - 1));
      return rows;
    }
    if (this.question || this.editor.view().search || this.dismissedCompletion === this.editor.text) return [];
    if (/^\/[^\s]*$/.test(this.editor.text)) {
      const query = this.editor.text.slice(1).toLowerCase();
      return CHAT_COMMANDS.filter(([name]) => name.includes(query)).map(([name, description]) => ({ label: `/${name}`, description,
        choose: () => { this.editor.clear(); return this.command(name, ""); } }));
    }
    return this.fileChoices;
  }

  private completionVisible(): boolean { return !this.question && !this.editor.view().search && this.dismissedCompletion !== this.editor.text && (/^\/[^\s]*$/.test(this.editor.text) || Boolean(fileMentionAt(this.editor.text, this.editor.cursor))); }

  private key(text: string | undefined, key: Key = {}): void {
    if (this.ended || this.suspended) return;
    if (this.editor.isCapturingInput) { this.editor.handleKey(text, key); this.render(); return; }
    if (this.question?.secret) {
      if (key.name === "escape" || key.ctrl && ["c", "d"].includes(key.name || "")) this.restoreQuestion();
      else if (key.name === "return" && !key.ctrl && !key.meta && !key.shift) {
        const question = this.question, answer = this.editor.text;
        this.restoreQuestion(); this.schedule(async () => { try { await question.submit(answer); } catch { throw new Error("凭据未能保存，请重试 /login；秘密输入已清除。"); } });
      } else this.editor.handleKey(text, key);
      this.render(); return;
    }
    if (key.ctrl && key.name === "l") { this.ui.suspend(); this.ui.resume(); this.render(); return; }
    if (this.question && key.name === "return" && !key.shift && !key.ctrl && !key.meta) {
      const question = this.question, answer = this.editor.text;
      this.restoreQuestion();
      this.schedule(() => question.submit(answer)); this.render(); return;
    }
    if (key.name === "pageup" || key.name === "pagedown") { this.ui.scroll(key.name === "pageup" ? 10 : -10); this.render(); return; }
    if (key.ctrl && key.name === "end") { this.ui.scrollToBottom(); this.render(); return; }
    if (key.ctrl && key.name === "o") { this.expanded = !this.expanded; this.expandedToolIds.clear(); this.collapsedToolIds.clear(); this.render(); return; }
    if (key.ctrl && key.name === "t") { this.schedule(() => this.tasksMenu()); return; }
    if (key.ctrl && key.name === "b") { this.schedule(() => this.background()); return; }
    if (key.meta && key.name === "p") { this.schedule(() => this.modelMenu()); return; }
    if (key.shift && key.name === "tab" || key.meta && key.name === "m") { this.schedule(() => this.setMode(this.mode === "manual" ? "acceptEdits" : this.mode === "acceptEdits" ? "plan" : "manual")); return; }
    if ((key.ctrl && key.name === "return") || key.sequence === "\x1b[13;5u") { this.schedule(() => this.sendQueuedNow()); return; }
    if (text === "?" && !this.editor.text && !this.popup && !this.question) { this.help = !this.help; this.render(); return; }
    const choices = this.currentChoices();
    if (this.popup && key.name === "tab" && choices[this.popup.selected]?.preview) { this.schedule(choices[this.popup.selected].preview!); return; }
    if (this.popup && !this.popup.filter && key.name === "space" && choices[this.popup.selected]?.preview) { this.schedule(choices[this.popup.selected].preview!); return; }
    if (this.popup?.decisionId && key.name === "tab") {
      this.popup.selected = (this.popup.selected + 1) % Math.max(1, choices.length); this.popup.armed = true; this.render(); return;
    }
    if (this.popup?.decisionId && key.name === "return" && !this.popup.armed) {
      this.notice = "确认菜单：先按 ↑/↓ 明确选择，再按 Enter；Esc 拒绝。输入文字不会批准。"; this.render(); return;
    }
    if (choices.length && ["up", "down", "tab", "return"].includes(key.name || "") && !key.ctrl && !key.meta && !key.shift) {
      let selected = this.popup?.selected ?? this.completionIndex;
      if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        if (this.popup) { this.popup.selected = selected; this.popup.armed = true; } else this.completionIndex = selected;
      } else {
        const choice = choices[Math.min(selected, choices.length - 1)];
        if (!choice || choice.disabled) { this.notice = choice?.description || "此选项当前不可用"; this.render(); return; }
        if (!this.popup && key.name === "tab" && this.editor.text.startsWith("/")) this.editor.replaceText(choice.label + " ");
        else { if (this.popup) this.closePopup(); this.fileChoices = []; this.schedule(choice.choose); }
      }
      this.render(); return;
    }
    if (this.popup && !this.popup.filter && key.name !== "escape" && !(key.ctrl && key.name === "c")) {
      this.popup.armed = false;
      this.notice = "此处使用 ↑/↓ 选择、Enter 确认、Esc 返回；不接受文本回复。"; this.render(); return;
    }
    if (!this.popup && !this.question && !this.editor.text && key.name === "up" && this.serverQueue.length) {
      const pending = this.serverQueue.at(-1)!; this.schedule(() => this.editQueued(pending)); return;
    }
    const intents = this.editor.handleKey(text, key);
    for (const intent of intents) {
      if (intent.type === "submit") {
        if (this.popup) continue;
        if (this.question) {
          const question = this.question; this.restoreQuestion();
          this.schedule(() => question.submit(intent.text));
        } else this.acceptInput(intent.text);
      } else if (intent.type === "escape") this.escape();
      else if (intent.type === "interrupt") this.interrupt();
      else if (intent.type === "eof") {
        const now = Date.now(); if (now - this.lastEof < 800) this.requestExit(); else { this.notice = "再按 Ctrl+D 退出"; this.lastEof = now; }
      } else if (intent.type === "external-editor") this.schedule(() => this.externalEditor());
      else if (intent.type === "image-paste") this.schedule(() => this.pasteImage());
      else if (intent.type === "stash") this.notice = "草稿已暂存 · Ctrl+S 恢复";
    }
    if (this.editor.text !== this.completionSignature) { this.completionIndex = 0; this.completionSignature = this.editor.text; }
    if (this.editor.text !== this.dismissedCompletion) this.dismissedCompletion = undefined;
    void this.updateFileChoices();
    this.render();
  }

  private acceptInput(raw: string): void {
    const text = raw.trim(); if (!text) return;
    this.editor.clear(); this.fileChoices = []; this.help = false; this.notice = ""; this.ui.scrollToBottom();
    const editor = this.editor;
    void this.preferences.appendHistory(text).then(() => this.preferences.readHistory()).then(history => editor.setHistory(history)).catch(() => undefined);
    if (text.startsWith("/")) { const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text)!; this.schedule(() => this.command(match[1], match[2])); return; }
    if (text.startsWith("!")) { this.schedule(() => this.runShell(text.slice(1).trim())); return; }
    const paths = this.attachments.splice(0);
    const message: PendingMessage = this.retryMessage?.text === text && JSON.stringify(this.retryMessage.paths) === JSON.stringify(paths) ? this.retryMessage : { text, paths, requestId: randomUUID(), attachmentIds: this.retryMessage?.attachmentIds, importedPaths: this.retryMessage?.importedPaths };
    this.retryMessage = undefined;
    this.schedule(() => this.submitMessage(message));
  }

  private async submitMessage(message: PendingMessage): Promise<void> {
    try { await this.deliverMessage(message); }
    catch (error) {
      this.retryMessage = message;
      if (!this.editor.text) { this.editor.setText(message.text); this.attachments = message.paths; }
      else this.queue.unshift(message);
      throw error;
    }
  }

  private async deliverMessage(message: PendingMessage): Promise<void> {
    if (!this.profile && !this.task) { this.editor.setText(message.text); this.attachments = message.paths; await this.profileMenu(); return; }
    if (this.task?.pending && this.task.pending.kind !== "question") { this.editor.setText(message.text); this.attachments = message.paths; this.retryMessage = message; this.checkDecision(); return; }
    const mentions = await resolveFileMentions(message.text, { cwd: this.cwd });
    const mentionPaths: string[] = Array.isArray(mentions) ? mentions.map((item: string | { path: string }) => typeof item === "string" ? item : item.path) : [];
    const paths = [...new Set([...message.paths, ...mentionPaths])];
    let attachmentIds = message.attachmentIds;
    const newPaths = paths.filter(file => !message.importedPaths?.includes(file));
    if (newPaths.length) {
      const imported = await this.request<{ attachments: { id: string }[] }>({ action: "task.attachments.import", paths: newPaths, ...(this.task ? { id: this.task.id } : {}) });
      attachmentIds = [...new Set([...(attachmentIds || []), ...imported.attachments.map(item => item.id)])];
      message.attachmentIds = attachmentIds;
      message.importedPaths = paths;
    }
    message.requestId ??= randomUUID();
    const context = this.currentShellContext(), consumed = context.text;
    const text = consumed ? `${message.text}\n\n用户在终端执行的命令及结果（作为数据参考）：\n${consumed}` : message.text;
    if (this.task?.pending?.kind === "question") {
      this.task = (await this.request<{ task: ManagementTask }>({ action: "task.reply", id: this.task.id, decisionId: this.task.pending.id, answer: text, attachmentIds, requestId: message.requestId })).task;
    } else
    if (!this.task) {
      const result = await this.request<{ task: ManagementTask }>({ action: "task.create", profile: this.profile!.id,
        input: { prompt: text, mode: this.mode, ...(this.settings?.model ? { model: this.settings.model } : {}),
          ...(attachmentIds ? { attachmentIds } : {}), ...(this.options.parsed.authorization ? { authorization: this.options.parsed.authorization } : {}),
          ...(this.options.parsed.limits ? { limits: this.options.parsed.limits } : {}) } });
      this.task = result.task; this.events = []; this.cursor = 0;
      this.historyRevision = undefined;
      this.shellContexts.set(this.task.id, context);
    } else {
      const queued = this.task.running || Boolean(this.task.messageQueue?.length);
      const result = await this.request<{ task: ManagementTask }>({ action: "task.control", id: this.task.id, control: queued ? "queue" : "resume", message: text, attachmentIds, requestId: message.requestId });
      this.task = result.task;
    }
    // Consume only the successfully accepted snapshot, preserving later shell output.
    if (context.text.startsWith(consumed)) context.text = context.text.slice(consumed.length);
    this.serverQueue = this.task?.messageQueue || [];
    this.notice = this.serverQueue.length ? `已保存到任务队列 · /queue 查看、编辑或撤回 · Ctrl+Enter 立即发送` : ""; this.checkDecision();
    this.lastPoll = 0;
  }

  private openPopup(title: string, choices: Choice[], filter = true, decisionId?: string): void {
    const draft = this.popup?.draft ?? this.editor.text;
    this.popup = { title, choices, selected: 0, draft, filter, decisionId };
    this.editor.clear(); this.fileChoices = []; this.render();
  }

  private closePopup(): void {
    if (!this.popup) return;
    const draft = this.popup.draft; this.popup = undefined; this.editor.setText(draft);
  }

  private ask(title: string, submit: Question["submit"], secret = false): void {
    if (this.question) this.restoreQuestion();
    this.question = { title, submit, secret, draft: this.editor.text, editor: this.editor };
    this.editor = new InputEditor({ secret }); this.render();
  }

  private restoreQuestion(): void {
    if (!this.question) return;
    this.editor.destroy(); this.editor = this.question.editor; this.question = undefined;
  }

  private currentShellContext(): { text: string } {
    const key = this.task?.id || this.conversationId;
    let context = this.shellContexts.get(key);
    if (!context) { context = { text: "" }; this.shellContexts.set(key, context); }
    return context;
  }

  private profileUnavailableReason(profile: Profile): string {
    return profile.task_unavailable_reason || profile.task_unavailable_code || "此 Profile 暂时无法执行任务，请检查浏览器连接后重试。";
  }

  private async ensureProfileReady(): Promise<void> {
    const selector = this.task?.profileId ?? this.profile?.id;
    if (!selector) return;
    const { profile } = await this.request<{ profile: Profile }>({ action: "profile.get", selector });
    this.profiles = this.profiles.map(item => item.id === profile.id ? profile : item);
    this.profile = profile;
    // Old servers omit readiness; do not retain a stale false from a prior list.
    if (profile.task_ready === false) throw new ChatRequestError(this.profileUnavailableReason(profile), `profile.ready:${profile.id}`);
    this.resolveErrors(`profile.ready:${profile.id}`);
  }

  private async profileMenu(refresh = true): Promise<void> {
    if (refresh) {
      const data = await this.request<{ profiles: Profile[] }>({ action: "profile.list" });
      this.profiles = data.profiles.filter(profile => profile.agent_access !== "blocked" && ["native", "isolated"].includes(profile.source));
      this.profile = this.profiles.find(profile => profile.id === this.profile?.id);
    }
    this.openPopup("选择浏览器 Profile · 以后自动使用此选择", this.profiles.map(profile => ({ label: profile.name,
      description: profile.task_ready === false ? this.profileUnavailableReason(profile) : profile.source === "native" ? "已登记的浏览器" : "独立浏览器",
      choose: async () => {
        if (this.task?.running) throw new Error("请先暂停当前任务，或 /clear 开始新会话。");
        if (this.task && this.task.profileId !== profile.id) {
          this.saveCurrentQueue();
          this.taskRevision++;
          this.task = undefined; this.events = []; this.cursor = 0; this.stream = undefined; this.messages = []; this.queue = []; this.decisionShown = undefined;
          this.serverQueue = []; this.historyRevision = undefined; this.conversationId = randomUUID(); this.retryMessage = undefined;
        }
        if (this.profile?.id !== profile.id && !this.task) this.conversationId = randomUUID();
        this.profile = profile;
        await this.preferences.saveSettings({ defaultProfile: profile.id });
        this.notice = `已选择 ${profile.name}`;
        if (this.options.prompt && !this.task) { const prompt = this.options.prompt; this.options.prompt = undefined; await this.submitMessage({ text: prompt, paths: [] }); }
      } })), true);
    if (!this.profiles.length) this.notice = "尚无可用 Profile · 请在 ProfilePilot 中创建并允许 Agent 连接";
  }

  private async attach(id: string): Promise<void> {
    this.saveCurrentQueue();
    this.taskRevision++;
    if (this.popup?.decisionId) this.closePopup();
    this.task = undefined; this.events = []; this.cursor = 0; this.historyRevision = undefined; this.eventMessages.clear(); this.messages = this.savedMessages.get(id) || []; this.stream = undefined; this.queue = this.savedQueues.get(id) || []; this.savedQueues.delete(id); this.decisionShown = undefined;
    const page = await this.request<ManagementTaskPage>({ action: "task.get", id, after: 0, limit: 200 });
    this.task = page.task; this.events = page.events; this.cursor = page.cursor; this.stream = page.stream;
    this.historyRevision = page.revision; this.serverQueue = page.task.messageQueue || []; this.agentsPanel = undefined;
    this.profile = this.profiles.find(p => p.id === page.task.profileId);
    this.mode = page.task.mode || "manual";
    this.notice = `已恢复 ${page.task.title}`;
    this.lastPoll = 0; this.checkDecision();
  }

  private async sessionMenu(): Promise<void> {
    const result = await this.allTasks();
    this.openPopup("恢复会话 · 搜索名称 / ID / Profile · Tab 预览", result.map(task => ({ id: task.id, label: task.title,
      description: `${task.id.slice(0, 8)} · ${task.status} · ${task.profileName}`,
      detail: `${task.id}\n${task.profileName} · ${task.status} · ${new Date(task.updatedAt).toLocaleString()}`,
      preview: () => this.previewSession(task.id), choose: () => this.attach(task.id) })));
    if (!result.length) this.notice = "还没有历史会话";
  }

  private async allTasks(): Promise<ManagementTaskSummary[]> {
    const tasks: ManagementTaskSummary[] = [];
    for (;;) {
      const page = await this.request<{ tasks: ManagementTaskSummary[]; total: number }>({ action: "task.list", offset: tasks.length, limit: 100 });
      tasks.push(...page.tasks);
      if (!page.tasks.length || tasks.length >= page.total) return tasks;
    }
  }

  private requireTask(): ManagementTask { if (!this.task) throw new Error("先开始一个会话，再使用此命令。"); return this.task; }

  private async command(name: string, argument: string): Promise<void> {
    switch (name) {
      case "help": this.help = !this.help; break;
      case "exit": case "quit": this.requestExit(); break;
      case "clear": case "new": this.newConversation(); break;
      case "resume": if (argument) await this.attach(argument); else await this.sessionMenu(); break;
      case "continue": await this.control("resume", argument || undefined); break;
      case "pause": await this.control("pause"); break;
      case "cancel": await this.control("cancel"); this.queue = []; break;
      case "profile": await this.profileMenu(); break;
      case "rename": {
        const id = this.requireTask().id;
        const rename = async (title: string): Promise<void> => { this.task = (await this.request<{ task: ManagementTask }>({ action: "task.metadata", id, title: title.trim() })).task; };
        if (argument) await rename(argument); else this.ask("会话的新名称", rename);
        break;
      }
      case "branch": case "fork": {
        const id = this.requireTask().id;
        const result = await this.request<{ task: ManagementTask }>({ action: "task.fork", id, ...(argument ? { title: argument } : {}) });
        await this.attach(result.task.id); this.notice = "已进入分支 · 原会话可通过 /resume 恢复"; break;
      }
      case "rewind": case "undo": await this.rewindMenu(); break;
      case "compact": {
        const id = this.requireTask().id;
        this.notice = "正在压缩会话上下文…";
        const result = await this.request<{ task: ManagementTask; beforeCharacters: number; afterCharacters: number }>({ action: "task.compact", id, ...(argument ? { instructions: argument } : {}) });
        await this.attach(result.task.id); this.notice = `上下文已压缩：${result.beforeCharacters} → ${result.afterCharacters} 字符`; break;
      }
      case "model": if (argument) await this.chooseModel(argument); else await this.modelMenu(); break;
      case "plan": await this.setMode(this.mode === "plan" ? "manual" : "plan"); break;
      case "permissions": await this.permissionMenu(); break;
      case "context": case "usage": await this.context(); break;
      case "tasks": await this.tasksMenu(); break;
      case "agents": await this.agentStatus(); break;
      case "background": await this.background(); break;
      case "theme": this.themeMenu(); break;
      case "config": this.configMenu(); break;
      case "login": this.configureConnection(); break;
      case "status": await this.connectionStatus(); break;
      case "transcript": await this.transcriptMenu(argument); break;
      case "tools": this.toolsMenu(); break;
      case "copy": await this.copyTranscript(argument); break;
      case "export": await this.exportTranscript(argument); break;
      case "queue": await this.queueMenu(); break;
      case "accessibility": this.accessibilityMenu(); break;
      case "limits": this.limitsMenu(); break;
      case "attach": if (argument) this.attachments.push(path.resolve(this.cwd, argument.replace(/^['"]|['"]$/g, ""))); else this.ask("文件路径（支持拖入文件）", input => { this.attachments.push(path.resolve(this.cwd, input.trim().replace(/^['"]|['"]$/g, ""))); }); break;
      case "attachments": this.openPopup("待发送附件 · 选择可移除", this.attachments.map((file, index) => ({ label: path.basename(file), description: file, choose: () => { this.attachments.splice(index, 1); } }))); break;
      default: throw new Error(`未知命令 /${name} · 输入 / 查看可用命令。`);
    }
  }

  private async control(control: "pause" | "resume" | "cancel", message?: string): Promise<void> {
    const id = this.requireTask().id;
    this.task = (await this.request<{ task: ManagementTask }>({ action: "task.control", id, control, ...(message ? { message } : {}) })).task;
    this.lastPoll = 0; this.checkDecision();
  }

  private newConversation(): void {
    const clear = (): void => {
      this.saveCurrentQueue();
      this.taskRevision++;
      if (this.popup?.decisionId) this.closePopup();
      this.task = undefined; this.events = []; this.messages = []; this.stream = undefined; this.cursor = 0; this.queue = [];
      this.conversationId = randomUUID(); this.historyRevision = undefined; this.serverQueue = []; this.retryMessage = undefined; this.agentsPanel = undefined;
      this.decisionShown = undefined; this.attachments = []; this.editor.clear(); this.notice = "新会话 · /resume 恢复历史";
    };
    if (this.task?.running) this.openPopup("当前任务仍在执行", [
      { label: "转入后台并开始新会话", choose: clear },
      { label: "暂停后开始新会话", choose: async () => { await this.control("pause"); clear(); } },
      { label: "返回当前会话", choose: () => undefined }
    ], false); else clear();
  }

  private async background(): Promise<void> {
    const task = this.requireTask();
    this.saveCurrentQueue();
    this.taskRevision++;
    if (this.popup?.decisionId) this.closePopup();
    this.task = undefined; this.events = []; this.cursor = 0; this.stream = undefined; this.queue = [];
    this.conversationId = randomUUID(); this.historyRevision = undefined; this.serverQueue = []; this.retryMessage = undefined; this.agentsPanel = undefined;
    this.messages = [];
    this.addMessage({ role: "system", text: `“${task.title}”已转入后台。通过 /tasks 查看或重新连接。后台执行依赖 ProfilePilot APP 服务持续运行；关闭窗口与退出 APP 不同，完全退出 APP 会停止执行。` });
    this.decisionShown = undefined;
  }

  private saveCurrentQueue(): void {
    if (this.task && this.queue.length) this.savedQueues.set(this.task.id, this.queue);
    if (this.task) this.savedMessages.set(this.task.id, this.messages);
  }

  private async sendQueuedNow(): Promise<void> {
    const id = this.requireTask().id;
    await this.refreshQueue(id);
    const message = this.serverQueue[0]; if (!message) { this.notice = "没有排队消息"; return; }
    if (this.task?.pending) throw new Error("请先处理待确认操作或问题，再发送队列消息。");
    await this.removeQueued(id, message.id);
    try {
      this.task = (await this.request<{ task: ManagementTask }>({ action: "task.control", id, control: "steer", message: message.message, attachmentIds: message.attachmentIds, requestId: `now-${message.id}` })).task;
    } catch (error) {
      // A failed immediate send remains recoverable in the editor with its receipt ID.
      this.retryMessage = { text: message.message, paths: [], attachmentIds: message.attachmentIds, requestId: `now-${message.id}` };
      this.editor.setText(message.message); throw error;
    }
    await this.refreshQueue(id); this.notice = "已立即发送 · 中断当前执行后处理此消息"; this.lastPoll = 0;
  }

  private escape(): void {
    if (this.popup) {
      const id = this.popup.decisionId;
      this.closePopup();
      if (this.agentsPanel) this.agentsPanel = undefined;
      if (id && this.task?.pending?.id === id && this.task.pending.kind === "confirmation") this.schedule(() => this.replyDecision(id, false));
      return;
    }
    if (this.question) { this.restoreQuestion(); return; }
    if (this.agentsPanel) { this.agentsPanel = undefined; return; }
    if (this.help) { this.help = false; return; }
    if (this.completionVisible()) { this.dismissedCompletion = this.editor.text; this.fileChoices = []; this.fileGeneration++; this.fileLoading = false; return; }
    if (this.task?.running || this.shell) { this.interrupt(); return; }
    const now = Date.now();
    if (now - this.lastEscape < 500) { if (this.editor.text) this.editor.clear(); else this.schedule(() => this.rewindMenu()); }
    this.lastEscape = now;
  }

  private interrupt(): void {
    if (this.popup || this.question || this.help || this.completionVisible() || this.agentsPanel) { this.escape(); return; }
    if (this.shell) { this.stopShell(); return; }
    if (this.task?.running) {
      // Do not enqueue cancellation behind a long-running model/config request.
      void this.control("pause").then(() => { this.notice = "已中断当前执行 · 输入消息继续"; this.render(); }).catch(error => this.error(error));
      return;
    }
    if (this.popup) { this.closePopup(); return; }
    const now = Date.now();
    if (this.editor.text) { this.editor.clear(); this.lastInterrupt = now; this.notice = "输入已清除 · 再按 Ctrl+C 退出"; }
    else if (now - this.lastInterrupt < 800) this.close(0);
    else { this.lastInterrupt = now; this.notice = "再按 Ctrl+C 退出"; }
  }

  private requestExit(): void {
    if (this.task?.running) this.openPopup("退出时如何处理当前任务？", [
      { label: "暂停任务并退出", choose: async () => { await this.control("pause"); this.close(0); } },
      { label: "保持后台执行并退出", description: "必须保持 ProfilePilot APP 服务运行；完全退出 APP 会停止执行", choose: () => this.close(0) },
      { label: "继续对话", choose: () => undefined }
    ], false); else this.close(0);
  }

  private close(code: number): void { if (this.ended) return; this.stopShell(); this.exitCode = code; this.ended = true; this.finish?.(); }

  private checkDecision(): void {
    const pending = this.task?.pending;
    // A reply may come from another CLI or the desktop. Reconcile before the
    // "already shown" guard so an old popup cannot block the next decision.
    if (this.popup?.decisionId && this.popup.decisionId !== pending?.id) this.closePopup();
    for (const message of this.messages) {
      if (message.decisionId && message.decisionId !== pending?.id && !message.collapsedText) {
        message.collapsedText = `确认已结束：${message.title ?? message.text.split("\n")[0]} · Ctrl+O 查看记录`;
      }
    }
    if (this.decisionShown !== pending?.id) this.decisionShown = undefined;
    if (this.decisionNotice && this.decisionNotice.id !== pending?.id) {
      if (this.notice === this.decisionNotice.text) this.notice = "";
      this.decisionNotice = undefined;
    }
    if (!pending || this.task?.running) return;
    if (pending.id === this.decisionShown || this.popup || this.question) return;
    this.decisionShown = pending.id;
    if (!this.messages.some(message => message.decisionId === pending.id)) {
      this.addMessage({ id: `decision-${pending.id}`, role: "system", title: pending.title, text: `${pending.title}\n${pending.details}` }, pending.createdAt, { decisionId: pending.id });
    }
    const notice = (text: string): void => { this.notice = text; this.decisionNotice = { id: pending.id, text }; };
    if (pending.kind === "question") { notice(`${pending.title} ${pending.details}`); return; }
    const choices: Choice[] = [{ label: pending.kind === "handoff" ? "我已完成手动操作，交还 Agent" : "允许这一次", description: pending.details,
      choose: () => this.replyDecision(pending.id, true) }];
    if (pending.kind === "confirmation" && pending.permissionScope) choices.push({ label: "本会话允许同范围的操作", description: pending.permissionScope.label, choose: () => this.replyDecision(pending.id, true, "session") });
    if (pending.kind === "confirmation") choices.push({ label: "拒绝", choose: () => this.replyDecision(pending.id, false) });
    choices.push({ label: "稍后处理", choose: () => { notice("等待处理 · /permissions 重新打开确认"); } });
    this.openPopup(pending.title, choices, false, pending.id);
  }

  private async replyDecision(decisionId: string, approved: boolean, scope: "once" | "session" = "once"): Promise<void> {
    const task = this.requireTask();
    if (task.pending?.id !== decisionId) throw new Error("待确认操作已经变化，请阅读最新内容再选择。");
    try {
      this.task = (await this.request<{ task: ManagementTask }>({ action: "task.reply", id: task.id, decisionId, approved, answer: "", scope })).task;
      this.checkDecision();
    } catch (error) {
      this.decisionShown = undefined;
      throw error;
    } finally { this.lastPoll = 0; }
  }

  private async rewindMenu(): Promise<void> {
    const task = this.requireTask();
    if (task.running) throw new Error("先按 Esc 暂停当前执行，再回退会话。");
    this.openPopup("回到此消息之前 · 已执行的浏览器操作不会撤销", this.events.filter(event => event.kind === "user").map(event => ({ label: event.text.slice(0, 160), description: new Date(event.at).toLocaleString(),
      choose: async () => {
        const result = await this.request<{ task: ManagementTask; draft: string }>({ action: "task.rewind", id: task.id, eventId: event.id });
        await this.attach(result.task.id); this.editor.setText(result.draft); this.notice = "会话已回退 · 可修改并重新发送";
      } })));
  }

  private async modelMenu(): Promise<void> {
    const { models } = await this.request<{ models: string[] }>({ action: "task.models" });
    this.openPopup("选择模型", [...new Set([this.settings?.model || "", ...models].filter(Boolean))].map(model => ({ label: model, description: model === this.settings?.model ? "当前模型" : undefined, choose: () => this.chooseModel(model) })));
  }

  private async chooseModel(model: string): Promise<void> {
    if (this.task) this.task = (await this.request<{ task: ManagementTask }>({ action: "task.model", id: this.task.id, model })).task;
    this.settings = (await this.request<{ settings: TaskSettings }>({ action: "task.settings.update", input: { model } })).settings;
    await this.preferences.saveSettings({ model });
    this.notice = `模型：${model} · 后续执行生效`;
  }

  private async setMode(mode: Mode): Promise<void> {
    if (this.task) this.task = (await this.request<{ task: ManagementTask }>({ action: "task.mode", id: this.task.id, mode })).task;
    this.mode = mode;
    this.notice = mode === "plan" ? "计划模式：只读观察与制定计划" : mode === "acceptEdits" ? "自动允许编辑；外部提交仍需确认" : "手动模式：操作前确认";
  }

  private async permissionMenu(): Promise<void> {
    if (this.task?.pending && this.task.pending.kind !== "question") { this.decisionShown = undefined; this.checkDecision(); return; }
    const choices: Choice[] = [
      { label: "Manual", description: "操作前确认", choose: () => this.setMode("manual") },
      { label: "Accept edits", description: "允许编辑，提交/发送等仍确认", choose: () => this.setMode("acceptEdits") },
      { label: "Plan", description: "只读观察和规划", choose: () => this.setMode("plan") }
    ];
    if (this.task) {
      const id = this.task.id;
      const { rules } = await this.request<{ rules: Array<{ id: string; kind: string; label: string }> }>({ action: "task.permissions", id });
      for (const rule of rules) choices.push({ label: `撤销授权：${rule.label}`, description: rule.kind, choose: async () => { await this.request({ action: "task.permissions", id, revokeId: rule.id }); this.notice = "授权已撤销"; } });
    }
    this.openPopup("权限模式与本会话规则", choices);
  }

  private async context(): Promise<void> {
    const task = this.requireTask();
    const { context } = await this.request<{ context: unknown }>({ action: "task.status", id: task.id });
    this.addMessage({ role: "system", text: `### 上下文与用量\n\n${JSON.stringify(context, null, 2)}\n\n输入 ${task.usage.inputTokens} tokens · 输出 ${task.usage.outputTokens} tokens\n费用 $${task.usage.costUsd.toFixed(4)}\n使用 /compact 压缩当前上下文。` });
  }

  private async tasksMenu(): Promise<void> {
    const tasks = await this.allTasks();
    this.openPopup("任务 · 选择查看或连接", tasks.map(task => ({ label: task.title, description: `${task.status}${task.running ? " · 执行中" : ""} · ${task.profileName}`,
      choose: async () => {
        this.openPopup(task.title, [
          { label: "连接此会话", choose: () => this.attach(task.id) },
          { label: "查看执行详情", choose: async () => { this.agentsPanel = { tasks, target: task.id, menu: "actions" }; await this.pollAgents(); this.showAgentActions(task.id); } },
          { label: "暂停", choose: async () => { await this.request({ action: "task.control", id: task.id, control: "pause" }); } },
          { label: "取消任务", choose: async () => { await this.request({ action: "task.control", id: task.id, control: "cancel" }); } }
        ], false);
      } })));
  }

  private async agentStatus(): Promise<void> {
    this.agentsPanel = { tasks: [], menu: "list" };
    await this.pollAgents();
    this.showAgentList();
  }

  private showAgentList(): void {
    const panel = this.agentsPanel; if (!panel) return;
    panel.menu = "list";
    panel.target = undefined; panel.page = undefined; panel.messages = undefined;
    this.openPopup("受控任务会话 · 持续更新 · Esc 返回当前对话", panel.tasks.map(task => ({ id: task.id, label: task.title,
      description: `${task.id.slice(0, 8)} · ${task.status} · ${task.profileName}`, detail: task.id,
      choose: async () => { panel.target = task.id; panel.page = undefined; panel.menu = "actions"; await this.pollAgents(); this.showAgentActions(task.id); } })));
  }

  private showAgentActions(id: string): void {
    const panel = this.agentsPanel; if (!panel) return;
    panel.menu = "actions";
    this.openPopup(`任务 ${id.slice(0, 8)} · 持续查看详情（主对话保持原任务）`, [
      { label: "定向发送消息", description: "运行中排队；问题回复；暂停/结束后继续", choose: () => this.ask(`发送给任务 ${id.slice(0, 8)}（支持 @附件）`, async message => { await this.sendAgentMessage(id, message); this.showAgentActions(id); }) },
      { label: "暂停此任务", choose: async () => { await this.request({ action: "task.control", id, control: "pause" }); await this.pollAgents(); this.showAgentActions(id); } },
      { label: "停止此任务", description: "取消指定任务，不影响当前主对话", choose: () => this.openPopup(`停止 ${id.slice(0, 8)}？`, [
        { label: "返回查看", choose: () => this.showAgentActions(id) },
        { label: "确认停止", choose: async () => { await this.request({ action: "task.control", id, control: "cancel" }); await this.pollAgents(); this.showAgentActions(id); } }
      ], false) },
      { label: "连接为当前会话", choose: () => this.attach(id) },
      { label: "创建关联分支", description: "仅创建任务会话，需输入后才执行", choose: async () => { const result = await this.request<{ task: ManagementTask }>({ action: "task.fork", id }); panel.target = result.task.id; panel.page = undefined; await this.pollAgents(); this.showAgentActions(result.task.id); } },
      { label: "返回受控任务列表", choose: () => this.showAgentList() },
      { label: "返回主对话", choose: () => { this.agentsPanel = undefined; } }
    ], false);
  }

  private async pollAgents(): Promise<void> {
    const panel = this.agentsPanel;
    if (!panel || this.panelPolling || this.ended) return;
    this.panelPolling = true; panel.updatedAt = Date.now();
    try {
      panel.tasks = await this.allTasks();
      if (this.agentsPanel !== panel) return;
      if (panel.target) {
        const id = panel.target;
        let page: ManagementTaskPage;
        do {
          const prior = panel.page;
          page = await this.request<ManagementTaskPage>({ action: "task.get", id, after: prior?.cursor || 0, revision: prior?.revision, limit: 200 });
          if (this.agentsPanel !== panel || panel.target !== id) return;
          panel.page = { ...page, events: [...(page.reset ? [] : prior?.events || []), ...page.events] };
        } while (page.hasMore);
        panel.status = await this.request({ action: "task.status", id });
        panel.messages = undefined;
      }
      if (panel.menu === "list" && this.popup?.title.startsWith("受控任务会话")) {
        const previous = this.currentChoices()[this.popup.selected]?.id;
        const draft = this.editor.text;
        this.showAgentList(); this.editor.setText(draft);
        this.popup!.selected = Math.max(0, this.currentChoices().findIndex(item => item.id === previous));
      }
      this.render();
    } catch (error) { if (this.agentsPanel === panel) { this.notice = `面板暂未更新：${error instanceof Error ? error.message : error}`; this.render(); } }
    finally { this.panelPolling = false; }
  }

  private agentPanelMessages(): TerminalMessage[] {
    const panel = this.agentsPanel!;
    if (panel.messages) return panel.messages;
    const page = panel.page!;
    const events: TerminalMessage[] = page.events.map(event => ({ id: event.id, role: event.kind === "action" ? "tool" : event.kind, text: event.text, ...(event.kind === "action" ? { status: "unknown" as const } : {}) }));
    if (page.stream?.text && !page.events.some(event => event.id === page.stream!.id)) events.push({ id: page.stream.id, role: "assistant", text: page.stream.text, status: "running" });
    events.push({ id: "agent-panel-status", role: "system", text: `查看任务 ${page.task.id}\n${page.task.title} · ${page.task.status} · ${page.task.profileName}\n${page.task.pending ? `等待：${page.task.pending.title}\n${page.task.pending.details}\n` : ""}关联任务：${panel.status?.relatedTasks?.map(task => `${task.id} ${task.title || ""} ${task.status || ""}`).join("\n") || "无"}\nSDK 内嵌子 Agent（只读观察，不支持定向消息或停止）：\n${JSON.stringify(panel.status?.subagents || [], null, 2)}\n本地进程（只读）：${JSON.stringify(panel.status?.processes || [], null, 2)}` });
    return panel.messages = events;
  }

  private async sendAgentMessage(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("消息不能为空。");
    const { task } = await this.request<ManagementTaskPage>({ action: "task.get", id, limit: 1 });
    if (task.pending && task.pending.kind !== "question") throw new Error("此任务等待明确授权；请连接该会话阅读确认内容，不会把文字当作批准。");
    const paths = await resolveFileMentions(text, { cwd: this.cwd });
    const attachmentIds = paths.length ? (await this.request<{ attachments: { id: string }[] }>({ action: "task.attachments.import", id, paths })).attachments.map(item => item.id) : undefined;
    const requestId = randomUUID();
    if (task.pending) await this.request({ action: "task.reply", id, decisionId: task.pending.id, answer: text, attachmentIds, requestId });
    else await this.request({ action: "task.control", id, control: task.running ? "queue" : "resume", message: text, attachmentIds, requestId });
    this.notice = `已发送给 ${id.slice(0, 8)}${task.running ? " 的持久队列" : ""}`; await this.pollAgents();
  }

  private async refreshQueue(id: string): Promise<void> {
    const result = await this.request<{ queue: TaskQueuedMessage[] }>({ action: "task.queue", id });
    if (this.task?.id === id) this.serverQueue = result.queue;
  }

  private async removeQueued(id: string, removeId: string): Promise<void> {
    const result = await this.request<{ queue: TaskQueuedMessage[] }>({ action: "task.queue", id, removeId });
    if (this.task?.id === id) this.serverQueue = result.queue;
  }

  private async editQueued(message: TaskQueuedMessage): Promise<void> {
    const id = this.requireTask().id;
    await this.removeQueued(id, message.id);
    this.editor.setText(message.message);
    this.retryMessage = { text: message.message, paths: [], attachmentIds: message.attachmentIds, requestId: randomUUID() };
    this.notice = "消息已从服务端队列取回 · 附件仍保留 · 修改后 Enter 重新排队";
  }

  private async queueMenu(): Promise<void> {
    const id = this.requireTask().id; await this.refreshQueue(id);
    this.openPopup("任务持久队列 · 按显示顺序执行", this.serverQueue.map((message, index) => ({ id: message.id,
      label: `${index + 1}. ${message.message}`, description: `${message.attachmentIds.length} 个附件 · ${new Date(message.createdAt).toLocaleTimeString()}`, detail: `${message.message}\n附件：${message.attachmentIds.join(", ") || "无"}`,
      choose: () => this.openPopup(`队列 ${index + 1} · ${message.id.slice(0, 8)}`, [
        { label: "取回编辑", choose: () => this.editQueued(message) },
        { label: "撤回", choose: async () => { await this.removeQueued(id, message.id); await this.queueMenu(); } },
        { label: "返回队列", choose: () => this.queueMenu() }
      ], false) })));
  }

  private async loadFullHistory(): Promise<void> {
    const id = this.requireTask().id;
    let more: boolean;
    do {
      const page = await this.request<ManagementTaskPage>({ action: "task.get", id, after: this.cursor, revision: this.historyRevision, limit: 200 });
      if (this.task?.id !== id) return;
      if (page.reset) { this.events = []; this.eventMessages.clear(); }
      this.events.push(...page.events); this.cursor = page.cursor; this.historyRevision = page.revision; this.task = page.task; this.stream = page.stream;
      more = page.hasMore;
    } while (more);
    this.render();
  }

  private async transcriptMenu(query = ""): Promise<void> {
    await this.loadFullHistory();
    this.openPopup("全部历史 · 搜索全文 · Enter 跳转 · Tab 预览 · /copy /export", this.events.map(event => ({ id: event.id,
      label: `${event.kind} · ${event.text.split("\n")[0]}`, description: event.id, detail: event.text,
      preview: async () => { this.notice = event.text; }, choose: () => { this.render(); this.ui.scrollToMessage(event.id); }
    })));
    if (query) this.editor.setText(query);
  }

  private toolsMenu(): void {
    this.openPopup("工具详情 · 单项展开 / 收起 · Ctrl+O 控制全部", this.timelineCache?.messages.filter(message => message.role === "tool").map(message => ({ id: message.id, label: message.title || message.text.split("\n")[0], description: `${this.expandedToolIds.has(message.id || "") ? "展开" : "折叠"} · ${message.status || "状态未报告"}`,
      choose: () => {
        const id = message.id!, visible = this.expandedToolIds.has(id) || this.expanded && !this.collapsedToolIds.has(id);
        if (visible) { this.expandedToolIds.delete(id); this.collapsedToolIds.add(id); } else { this.collapsedToolIds.delete(id); this.expandedToolIds.add(id); }
        this.render(); this.ui.scrollToMessage(id);
      }
    })) || []);
  }

  private async transcriptText(id?: string): Promise<string> {
    await this.loadFullHistory();
    const events = id ? this.events.filter(event => event.id === id) : this.events;
    if (id && !events.length) throw new Error("未找到此消息 ID；用 /transcript 搜索消息。");
    if (id) return safeText(events[0].text);
    return safeText(events.map(event => `## ${event.kind} · ${event.at} · ${event.id}\n\n${event.text}`).join("\n\n"));
  }
  private async copyTranscript(id: string): Promise<void> { await copyTextToClipboard(await this.transcriptText(id || undefined)); this.notice = id ? "消息已复制" : "完整历史已复制"; }
  private async exportTranscript(file: string): Promise<void> {
    const text = await this.transcriptText();
    const target = file ? path.resolve(this.cwd, file.replace(/^['"]|['"]$/g, "")) : path.join(this.cwd, `ppilot-${this.requireTask().id}-${Date.now()}.md`);
    await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" }); this.notice = `历史已导出：${target}`;
  }
  private async previewSession(id: string): Promise<void> {
    const page = await this.request<ManagementTaskPage>({ action: "task.get", id, after: 0, limit: 5 });
    const choice = this.popup?.choices.find(choice => choice.id === id);
    if (choice) choice.detail = `${page.task.id}\n${page.task.profileName} · ${page.task.status}\n${page.task.result?.summary || page.events.map(event => `${event.kind}: ${event.text}`).join("\n") || page.task.prompt}${page.hasMore ? "\n… 连接后查看完整历史" : ""}`;
  }

  private accessibilityMenu(): void {
    this.openPopup("终端可访问性", [
      { label: "线性读屏模式", description: "无备用屏幕、颜色、光标重绘或动画；带角色标签的追加输出", choose: async () => { this.screenReader = true; this.ui.setAccessibility(true, true); await this.preferences.saveSettings({ screenReader: true, reducedMotion: true }); } },
      { label: "全屏、减少动态效果", description: "保留 TUI，停止 spinner 动画", choose: async () => { this.screenReader = false; this.ui.setAccessibility(false, true); await this.preferences.saveSettings({ screenReader: false, reducedMotion: true }); } },
      { label: "全屏默认交互", choose: async () => { this.screenReader = false; this.ui.setAccessibility(false, false); await this.preferences.saveSettings({ screenReader: false, reducedMotion: false }); } }
    ], false);
  }

  private limitsMenu(): void {
    const task = this.requireTask();
    this.openPopup("当前会话执行限制", (["minutes", "actions", "budgetUsd"] as const).map(field => ({ label: `${field}: ${task.limits[field]}`, choose: () => this.ask(`新的 ${field}（正数）`, async text => {
      const value = Number(text); if (!Number.isFinite(value) || value <= 0) throw new Error("限制必须是正数。");
      this.task = (await this.request<{ task: ManagementTask }>({ action: "task.limits", id: task.id, limits: { [field]: value } })).task;
      this.notice = "当前会话限制已更新";
    }) })));
  }

  private themeMenu(): void {
    this.openPopup("终端主题", ["dark", "light", "mono"].map(theme => ({ label: theme, choose: async () => {
      this.ui.setTheme(theme as "dark" | "light" | "mono"); await this.preferences.saveSettings({ theme: theme as "dark" | "light" | "mono" });
    } })), false);
  }

  private configMenu(): void {
    this.openPopup("设置", [
      { label: "模型", description: this.settings?.model, choose: () => this.modelMenu() },
      { label: "模型连接与凭据", description: this.settings?.baseUrl, choose: () => this.configureConnection() },
      { label: "终端主题", choose: () => this.themeMenu() },
      { label: "可访问性与动态效果", choose: () => this.accessibilityMenu() },
      { label: "当前会话执行限制", choose: () => this.limitsMenu() },
      { label: "默认浏览器 Profile", description: this.profile?.name, choose: () => this.profileMenu() },
      { label: "检查模型连接", choose: () => this.connectionStatus() },
      { label: "清除已保存的输入草稿", choose: async () => { await this.preferences.saveDraft(""); this.editor.clear(); this.notice = "草稿已清除"; } }
    ]);
  }

  private configureConnection(): void {
    this.ask("模型 API 地址（留空保留当前地址）", baseUrl => {
      const endpoint = baseUrl.trim() || this.settings?.baseUrl || "https://api.anthropic.com";
      this.ask("模型名称（留空保留当前模型）", model => {
        const chosen = model.trim() || this.settings?.model || "claude-sonnet-4-6";
        this.ask("API Key（隐藏输入；留空保留已保存凭据）", async apiKey => {
          this.settings = (await this.request<{ settings: TaskSettings }>({ action: "task.settings.update", input: { baseUrl: endpoint, model: chosen, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } })).settings;
          this.notice = "模型配置已保存 · /status 测试连接";
        }, true);
      });
    });
  }

  private async connectionStatus(): Promise<void> {
    const ping = await this.request<{ app_version: string }>({ action: "ping" });
    this.settings = (await this.request<{ settings: TaskSettings }>({ action: "task.settings.get" })).settings;
    this.addMessage({ role: "system", text: `ProfilePilot ${ping.app_version} · 服务已连接\n模型：${this.settings.model}\nAPI：${this.settings.baseUrl}\n凭据：${this.settings.hasApiKey ? "已配置" : "未配置"}` });
    if (this.settings.hasApiKey) {
      const result = await this.request<{ message: string }>({ action: "task.connection.test" });
      this.notice = result.message;
    } else this.notice = "使用 /login 配置模型凭据";
  }

  private async updateFileChoices(): Promise<void> {
    const generation = ++this.fileGeneration;
    if (this.popup || this.question || this.dismissedCompletion === this.editor.text) { this.fileChoices = []; this.fileLoading = false; return; }
    const mention = fileMentionAt(this.editor.text, this.editor.cursor);
    if (!mention) { this.fileChoices = []; this.fileLoading = false; return; }
    this.fileLoading = true; this.render();
    const candidates = await fileCandidates(mention.query, { cwd: this.cwd, limit: 15 }).catch(() => []);
    if (generation !== this.fileGeneration) return;
    this.fileLoading = false;
    this.fileChoices = candidates.map(candidate => ({ id: candidate.path, label: candidate.label, description: candidate.kind === "directory" ? "目录" : "文件", detail: candidate.path,
      choose: () => {
        const before = this.editor.text.slice(0, mention.start);
        const after = this.editor.text.slice(mention.end);
        const candidatePath = candidate.path + (candidate.kind === "directory" && !candidate.path.endsWith(path.sep) ? path.sep : "");
        const value = `@${/\s/.test(candidatePath) ? `"${candidatePath}"` : candidatePath}${candidate.kind === "directory" ? "" : " "}`;
        this.editor.replaceText(before + value + after, before.length + value.length);
        void this.updateFileChoices();
      } }));
    this.render();
  }

  private async externalEditor(): Promise<void> {
    const input = this.options.stdin;
    this.suspended = true; this.ui.suspend(); input.off("keypress", this.onKey); input.setRawMode?.(false); input.pause();
    try { this.editor.replaceText(await editTextExternally(this.editor.text)); }
    finally { input.setRawMode?.(true); input.on("keypress", this.onKey); input.resume(); this.suspended = false; this.ui.resume(); }
  }

  private async pasteImage(): Promise<void> {
    const image = await captureClipboardImage({ directory: path.join(os.tmpdir(), "ppilot-clipboard") });
    if (!image) throw new Error("剪贴板中没有图片。也可使用 /attach 添加图片文件。");
    this.attachments.push(typeof image === "string" ? image : image.path);
    this.notice = `图片已添加 · 共 ${this.attachments.length} 个附件`;
  }

  private async runShell(command: string): Promise<void> {
    if (!command) { this.notice = "在 ! 后输入终端命令"; return; }
    if (this.shell) throw new Error("已有终端命令在执行。按 Esc 中断后重试。");
    const item = this.addMessage({ role: "tool", title: command, text: command, detail: "", status: "running" });
    const context = this.currentShellContext();
    const executable = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
    const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; ${command}`;
    const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : ["-lc", command];
    const child = spawn(executable, args, { cwd: this.cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    this.shell = child;
    const decoders = [new ShellTextDecoder(process.platform === "win32"), new ShellTextDecoder(process.platform === "win32")];
    const append = (text: string): void => { item.detail = `${item.detail || ""}${text}`.slice(-50000); this.render(); };
    child.stdout?.on("data", buffer => append(decoders[0].write(buffer))); child.stderr?.on("data", buffer => append(decoders[1].write(buffer)));
    child.on("error", error => { item.status = "error"; item.detail = error.message; this.shell = undefined; this.render(); });
    child.on("close", code => {
      this.shell = undefined; item.status = code === 0 ? "done" : "error";
      for (const decoder of decoders) append(decoder.end());
      item.text = `${command}\n退出码 ${code ?? "中断"}`;
      context.text = `${context.text}\n$ ${command}\n${item.detail || ""}\nexit=${code}`.slice(-30000); this.render();
    });
  }

  private stopShell(): void {
    if (!this.shell?.pid) return;
    if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(this.shell.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-this.shell.pid, "SIGTERM"); } catch { this.shell.kill("SIGTERM"); } }
    this.notice = "已中断终端命令";
  }
}

export async function runInteractiveChat(options: ChatOptions): Promise<number> { return new AgentChat(options).run(); }
