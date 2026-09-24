import { fork, type ChildProcess } from "node:child_process";
import { mergeCostRecords } from "../../shared/task-cost";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TERMINAL_TASKS, hasTaskBrowser, jevProviderFor, type BrowserTask, type BrowserAction, type BrowserObservation, type JevAssessment, type CreateTaskInput, type TaskSnapshot, type TaskMetadataInput } from "../../shared/tasks";
import { browserActionSchema, effectiveEffect, type BrowserAdapter } from "./browser";
import { TaskStore, now } from "./store";
import { nextDailyOccurrence } from "../../shared/task-time";
import { authorizeTaskRead, readTaskDocument, readTaskTable, writeTaskResult } from "./files";
import { evaluateJevPage, jevPageState, JEV_MAX_CALLS, jevModel } from "./jev";
import { runJevDriver } from "./jev-driver";
import { chooseJevAction } from "./jev-actions";
import { taskHelper } from "./task-helper";
import { FastBrowserPageError, readLinkGuard } from "./fast-browser";
import { beginJevCall, finishJevCall } from "./jev-usage";
import { recordTaskModel } from "../../shared/task-model";
import { TaskTerminal, terminalRunSchema } from "./terminal";
import { applyPricedCost, costBaseline } from "./cost-accounting";

export interface TaskServiceDependencies {
  browser: BrowserAdapter;
  prepareProfile(id: string): Promise<{ name: string; port?: number; browserConnection?: "gateway" | "extension" }>;
  profileName(id: string): Promise<string>;
  apiKey(): string;
  jevApiKey?(): string;
  evaluateJev?: typeof evaluateJevPage;
  chooseJev?: typeof chooseJevAction;
  taskHelper?: typeof taskHelper;
  changed(snapshot: TaskSnapshot): void;
  notify(title: string, body: string, taskId?: string): void;
  controlReceiver?(sessionId: string, waiting: boolean): void;
  closePreview?(): void;
  closeBrowser?(): void;
  worker?: (task: BrowserTask, start: Record<string, unknown>) => ChildProcess;
}
interface Run {
  child?: ChildProcess; started: number; stopped: boolean; timer?: NodeJS.Timeout;
  chain: Promise<unknown>; repeat: string; repeatCount: number; ending?: Promise<void>; starting?: Promise<void>; resumeAfterStop?: boolean;
  browserRelease?: Promise<void>;
  terminalStop?: Promise<void>;
  jevAbort?: AbortController; jevCache?: { hash: string; result: JevAssessment }; jevUnavailable?: string; jevConfig?: string;
  driver?: boolean; driverAbort?: AbortController;
  attempts?: Map<string, number>; visitedStates?: Map<string, number>;
}
const textResult = (value: unknown, isError = false): any => ({ isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const serious = (effect: string): boolean => ["submit", "send", "purchase", "delete"].includes(effect);

export class TaskService {
  readonly runs = new Map<string, Run>();
  readonly terminal: TaskTerminal;
  private ticking = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private closing?: Promise<void>;
  private readonly returning = new Set<string>();
  private readonly receivers = new Set<string>();
  private lastCleanup = 0;
  private readonly decisionsInFlight = new Set<string>();
  private readonly archiving = new Set<string>();
  reconcileIdleNativeProfile(profileId: string): void {
    let changed = false;
    for (const task of this.store.data.tasks) {
      if (task.profileId !== profileId || task.browserConnection !== "extension" || task.status !== "paused" || this.runs.has(task.id) || task.pending) continue;
      task.browserConnection = undefined;
      task.resumeContext = { reason: "扩展确认原会话已释放，继续时重新核查页面", url: task.observation?.url || task.resumeContext?.url, observed: false };
      task.observation = undefined; task.needsReconciliation = true;
      this.store.event(task, "system", "扩展已连接且无任务占用，已清除旧的浏览器预留；任务记录保留，继续时将重新连接并核查页面。");
      changed = true;
    }
    if (changed) this.publish();
  }
  constructor(readonly store: TaskStore, readonly dependencies: TaskServiceDependencies) {
    this.terminal = new TaskTerminal(store.root, (id, result) => {
      const task = store.data.tasks.find(task => task.id === id);
      if (!task) return;
      const outcome = { succeeded: "已完成", failed: `执行失败（退出码 ${result.exit_code ?? "未知"}）`, stopped: "已停止", timed_out: "超时，已停止", running: "运行中" }[result.status];
      store.event(task, "system", `终端${outcome}：${result.summary}`); this.publish();
    });
  }
  start(): void {
    this.syncControlReceivers();
    this.timer = setInterval(() => { void this.tick(); }, 3000);
    this.timer.unref();
    void this.tick();
  }
  publish(): void {
    this.syncControlReceivers();
    this.store.save();
    this.dependencies.changed(this.store.snapshot());
  }
  private syncControlReceivers(): void {
    // The desktop process stays alive and receives Gateway return events even
    // after the SDK worker stops for a handoff. Advertise that actual receiver.
    const waiting = new Set(this.closed ? [] : this.store.data.tasks.filter(task => task.port && task.status === "waiting_user" && task.pending?.kind === "handoff").map(task => task.sessionId));
    for (const session of this.receivers) if (!waiting.has(session)) {
      this.dependencies.controlReceiver?.(session, false); this.receivers.delete(session);
    }
    for (const session of waiting) if (!this.receivers.has(session)) {
      this.dependencies.controlReceiver?.(session, true); this.receivers.add(session);
    }
  }
  async create(input: CreateTaskInput): Promise<BrowserTask> {
    if (this.closed) throw new Error("应用正在退出，无法创建任务。");
    const name = await this.dependencies.profileName(input.profileId);
    const task = this.store.create(input, name);
    this.publish(); void this.tick(); return task;
  }
  async retryItems(id: string, itemIds: string[]): Promise<BrowserTask> {
    if (this.closed) throw new Error("应用正在退出，无法创建任务。");
    const source = this.store.get(id);
    if (!TERMINAL_TASKS.has(source.status) || this.runs.has(id)) throw new Error("请等待原任务结束后再继续未完成项。");
    const ids = [...new Set(itemIds)];
    const items = ids.map(id => source.items.find(item => item.id === id));
    if (!items.length || items.some(item => !item || item.status === "completed")) throw new Error("请选择尚未完成的项目。");
    if (source.attachments.some(file => !existsSync(file.path))) throw new Error("原任务的附件已删除，请新建任务并重新选择附件。");
    const name = await this.dependencies.profileName(source.profileId);
    const task = this.store.create({ prompt: source.prompt, profileId: source.profileId, authorization: source.authorization, limits: source.limits, items: items.map(item => item!.label) }, name);
    task.sourceTaskId = source.id;
    task.materials = structuredClone(source.materials); task.attachments = structuredClone(source.attachments);
    task.grant = source.grant ? structuredClone(source.grant) : undefined;
    task.receipts = structuredClone(source.receipts.filter(receipt => serious(receipt.action.effect)));
    this.markInterrupted(task);
    for (let i = 0; i < task.items.length; i++) {
      task.items[i].result = items[i]!.result;
      if (items[i]!.status === "uncertain") task.items[i].status = "uncertain";
    }
    this.store.event(task, "user", `仅继续所选 ${items.length} 项；原任务中已完成的项目保持不变。沿用原资料版本和剩余自动操作额度。结果未确认的提交必须先核查，不得直接重试。`);
    this.publish(); void this.tick(); return task;
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      await this.scheduleDue();
      if (Date.now() - this.lastCleanup > 3600000) {
        this.lastCleanup = Date.now();
        const cutoff = Date.now() - this.store.data.settings.retentionDays * 86400000;
        for (const task of this.store.data.tasks.slice()) if (!task.pinnedAt && !task.archivedAt && !this.archiving.has(task.id) && TERMINAL_TASKS.has(task.status) && Math.max(Date.parse(task.updatedAt), Date.parse(task.metadataUpdatedAt || task.updatedAt)) < cutoff && !this.runs.has(task.id) && !this.terminal.hasRunning(task.id)) this.deleteTask(task.id);
      }
      for (const task of this.store.data.tasks.slice().reverse()) {
        if (task.status !== "queued" || this.archiving.has(task.id) || this.runs.size >= this.store.data.settings.maxConcurrent) continue;
        const occupied = this.store.data.tasks.some((other) => other.id !== task.id && other.profileId === task.profileId &&
          (this.runs.has(other.id) || (["running", "waiting_user", "paused"].includes(other.status) && hasTaskBrowser(other))));
        if (!occupied) this.launch(task);
      }
    } finally { this.ticking = false; }
  }
  private launch(task: BrowserTask): void {
    const run: Run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
    this.runs.set(task.id, run);
    task.runningSince = new Date(run.started).toISOString();
    task.status = "running";
    task.execution = { engine: "preparing", activity: "准备浏览器", at: now() };
    this.store.event(task, "system", "正在准备浏览器和 Agent。"); this.publish();
    run.starting = this.startRun(task, run).catch((error) => {
      if (!run.stopped) {
        task.status = "waiting_user";
        task.pending = { id: randomUUID(), kind: "question", title: "暂时无法开始", details: String(error instanceof Error ? error.message : error), createdAt: now() };
        this.store.event(task, "error", task.pending.details);
      }
      void this.endRun(task, run);
    });
  }
  private async startRun(task: BrowserTask, run: Run): Promise<void> {
    const key = this.dependencies.apiKey();
    if (!key) throw new Error("请在设置中配置模型 API 密钥并测试连接。");
    if (task.usage.elapsedMs >= task.limits.minutes * 60000 || task.usage.actions >= task.limits.actions || task.usage.costUsd >= task.limits.budgetUsd) throw new Error("任务已达到运行限制。可在新的任务中调整限制后继续处理剩余工作。");
    const profile = await this.dependencies.prepareProfile(task.profileId);
    if (run.stopped) return void this.endRun(task, run);
    task.port = profile.port;
    task.browserConnection = profile.browserConnection || "gateway";
    task.profileName = profile.name;
    task.observation = undefined;
    run.timer = setTimeout(() => {
      void (async () => {
        if (this.closed || run.stopped || this.runs.get(task.id) !== run) return;
        // finish can persist a terminal result while the SDK is still writing
        // its final response. Drain that run without pausing a finished task.
        if (TERMINAL_TASKS.has(task.status)) {
          this.stopWorker(run, ["completed", "partial"].includes(task.status));
          await this.endRun(task, run);
          return;
        }
        this.store.event(task, "system", "任务达到时间上限，已暂停并保留现场。");
        await this.control(task.id, "pause");
      })().catch(error => {
        this.store.event(task, "error", `时间上限收尾失败：${String(error)}`);
        this.publish();
      });
    }, Math.max(1000, task.limits.minutes * 60000 - task.usage.elapsedMs));
    if (this.store.data.settings.jevEnabled && this.store.data.settings.jevMode === "driver" && this.dependencies.browser.observeFast) {
      const jevKey = this.dependencies.jevApiKey?.() || "";
      if (jevKey) {
        run.driver = true; run.driverAbort = new AbortController();
        task.execution = { engine: "jev", activity: "观察页面并选择下一步", at: now() };
        const settings = structuredClone(this.store.data.settings);
        recordTaskModel(task, settings);
        const current = (): boolean => {
          this.assertRunning(task, run);
          return JSON.stringify(this.store.data.settings) === JSON.stringify(settings) && this.dependencies.jevApiKey?.() === jevKey && this.dependencies.apiKey() === key;
        };
        const driver = runJevDriver({ task, settings, apiKey: key, jevKey, signal: run.driverAbort.signal, current,
          observe: async () => { await this.handleTool(task, run, "observe", { fast: true }); return task.observation!; },
          tool: (name, args) => this.handleTool(task, run, name, args),
          event: text => { this.store.event(task, "system", text); this.publish(); }, publish: () => this.publish(),
          choose: this.dependencies.chooseJev, helper: this.dependencies.taskHelper });
        // Close/pause waits for this loop to drain, including any in-flight action.
        run.chain = driver.catch(() => {});
        let fallback: string | undefined;
        try { fallback = await driver; }
        catch (error) {
          // Only page-script failures can fall back. Gateway ownership, cancellation,
          // limits and uncertain transport failures must retain their stop behavior.
          if (!(error instanceof FastBrowserPageError) || run.stopped || run.driverAbort.signal.aborted || task.status !== "running") throw error;
          fallback = `${error.message}\n已自动切换到主模型，将重新观察页面后继续。`;
        }
        finally { run.driver = false; }
        if (run.stopped || task.status !== "running") return void this.endRun(task, run);
        this.store.event(task, "system", fallback || "配置已更新，交由主模型继续处理。");
        task.execution = { engine: "model", activity: "主模型继续处理", reason: fallback, at: now() };
        task.observation = undefined; this.publish();
      }
    }
    const cwd = path.join(this.store.root, "sessions", task.id);
    task.execution = { engine: "model", activity: "主模型正在处理", reason: task.execution?.reason, at: now() };
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const settings = structuredClone(this.store.data.settings);
    recordTaskModel(task, settings);
    const start = { kind: "start", task: structuredClone(task), settings, apiKey: this.dependencies.apiKey(), cwd, terminal: this.terminal.context(task.id) };
    const costStart = costBaseline(task);
    const worker = this.dependencies.worker?.(task, start) ?? fork(path.join(__dirname, "worker.js"), [], {
      cwd, env: workerEnvironment(), execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], ...{ windowsHide: true }
    });
    run.child = worker;
    worker.stdout?.resume(); worker.stderr?.resume();
    worker.on("message", (message: any) => {
      if (message.kind === "tool") {
        // MCP may issue several calls concurrently; browser actions must remain ordered.
        run.chain = run.chain.then(async () => {
          let result: unknown;
          try { result = await this.handleTool(task, run, message.name, message.args); }
          catch (error) { result = textResult(error instanceof Error ? error.message : String(error), true); }
          if (worker.connected) worker.send({ kind: "tool_result", id: message.id, result });
        }).catch((error) => { this.store.event(task, "error", String(error)); this.publish(); });
        return;
      }
      if (message.kind === "session") task.sdkSessionId = String(message.id);
      if (message.kind === "cost" && message.charge) task.costRecords = mergeCostRecords(task.costRecords || [], [message.charge]);
      if (message.kind === "text" && !run.stopped) this.store.event(task, "assistant", String(message.text));
      if (message.kind === "result") {
        task.modelTokenUsage = mergeModelTokens(task.modelTokenUsage || [], message.modelTokenUsage);
        // SDK cost is cumulative for resumed sessions; never add it twice.
        applyPricedCost(task, costStart, Number(message.costUsd), message.priceVersion);
        if (Number.isSafeInteger(message.cachedInputTokens) && message.cachedInputTokens >= 0) task.cachedInputTokens = Math.max(task.cachedInputTokens || 0, message.cachedInputTokens);
        task.usage.inputTokens = Math.max(task.usage.inputTokens, Number(message.inputTokens) || 0);
        task.usage.outputTokens = Math.max(task.usage.outputTokens, Number(message.outputTokens) || 0);
        if (!run.stopped && task.status === "running") {
          task.status = message.budgetExceeded ? "paused" : "partial";
          task.result = { summary: message.budgetExceeded ? `任务估算费用已达到 $${task.limits.budgetUsd.toFixed(2)} 上限，已暂停并保留记录。这是任务预算限制，实际扣费以服务商账单为准。` : message.result || "Agent 已结束，但未提供可验证的完成结果。", evidence: [], remaining: ["需要核查任务完成情况"] };
        }
      }
      if (message.kind === "error" && !run.stopped) {
        task.status = "paused"; task.needsReconciliation = true;
        this.store.event(task, "error", String(message.text));
      }
      this.publish();
    });
    worker.once("error", (error) => {
      this.store.event(task, "error", error.message);
      if (!TERMINAL_TASKS.has(task.status)) { task.status = "paused"; task.needsReconciliation = true; }
      void this.endRun(task, run);
    });
    worker.once("exit", () => { void this.endRun(task, run); });
    worker.send(start);
    this.publish();
  }
  private assertRunning(task: BrowserTask, run: Run): void {
    if (run.stopped || this.runs.get(task.id) !== run || task.status !== "running") throw new Error("任务当前已停止或等待用户，不得继续执行操作。");
  }
  async handleTool(task: BrowserTask, run: Run, name: string, args: any): Promise<any> {
    this.assertRunning(task, run);
    if (name === "authorize_read") return typeof args.path === "string" ? authorizeTaskRead(task, args.path) : { allowed: false };
    if (name === "terminal_run") {
      const input = terminalRunSchema.parse(args);
      if (task.usage.actions >= task.limits.actions) return textResult("任务达到操作次数上限，请报告已有结果。", true);
      task.usage.actions++;
      task.execution = { engine: "model", activity: "正在执行终端命令", at: now() };
      this.store.event(task, "system", `终端${input.background ? "启动后台服务" : "执行"}：${input.summary}`); this.publish();
      const result = await this.terminal.run(task.id, input);
      return textResult(result, ["failed", "timed_out"].includes(result.status));
    }
    if (name === "terminal_read") {
      const result = await this.terminal.read(task.id, args);
      return textResult(result, ["failed", "timed_out"].includes(result.status));
    }
    if (name === "terminal_stop") return textResult(await this.terminal.stop(task.id, args));
    if (name === "read_document") return readTaskDocument(task, args);
    if (name === "read_table") return textResult(await readTaskTable(task, args));
    if (name === "export_result") {
      const file = writeTaskResult(task, path.join(this.store.root, "artifacts"), args);
      this.store.event(task, "system", `已生成结果文件：${file.name}`); this.publish(); return textResult(file);
    }
    if (name === "observe") {
      task.execution = { engine: run.driver ? "jev" : "model", activity: "正在观察当前页面", reason: task.execution?.reason, at: now() }; this.publish();
      const observation = ((run.driver && args.fast) || args.layout === true) && this.dependencies.browser.observeFast
        ? await this.dependencies.browser.observeFast(task)
        : await this.dependencies.browser.observe(task, args.screenshot === true, this.store.data.settings.saveScreenshots);
      if (((run.driver && args.fast) || args.layout === true) && observation.fast && args.screenshot === true && !observation.screenshotDataUrl) {
        const visual = await this.dependencies.browser.observe(task, true, this.store.data.settings.saveScreenshots);
        observation.screenshotDataUrl = visual.screenshotDataUrl; observation.screenshotPath = visual.screenshotPath;
      }
      this.assertRunning(task, run);
      if (!task.receipts.some((receipt) => serious(receipt.action.effect) && ["started", "uncertain"].includes(receipt.status) && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""))) task.needsReconciliation = false;
      await this.assessPage(task, run, observation);
      this.assertRunning(task, run);
      if (task.resumeContext?.returnedAt) task.resumeContext.observed = true;
      // The exact DOM guard is local execution state, not model context. It
      // duplicates controls, nearby text and raw attributes on every observe.
      const content: any[] = [{ type: "text", text: JSON.stringify({ ...observation,
        fast: observation.fast ? { candidates: observation.fast.candidates } : undefined,
        screenshotDataUrl: undefined, screenshotPath: undefined, resumeContext: task.resumeContext }) }];
      if (observation.screenshotDataUrl) content.push({ type: "image", mimeType: "image/png", data: observation.screenshotDataUrl.split(",")[1] });
      if (!this.store.data.settings.saveScreenshots) { observation.screenshotDataUrl = undefined; observation.screenshotPath = undefined; }
      task.observation = observation;
      const { version, at, url, title, snapshot } = observation;
      const pages = (task.evidencePages || []).filter(page => page.url !== url || page.snapshot !== snapshot);
      task.evidencePages = [...pages, { version, at, url, title, snapshot: snapshot.slice(0, 60000) }].slice(-16);
      this.publish();
      return { content };
    }
    if (name === "tabs") return textResult(await this.dependencies.browser.tabs(task));
    if (name === "fill_fields") {
      const input = z.object({ version: z.string(), fields: z.array(z.object({ ref: z.string().regex(/^@?e\d+$/), value: z.string().max(20000), kind: z.enum(["fill", "select", "check", "uncheck"]).default("fill") })).min(1).max(20) }).parse(args);
      if (!task.observation || task.observation.version !== input.version) throw new Error("表单观察已失效，请重新观察。");
      const structure = (snapshot: string): string => snapshot.split("\n").filter((line) => /ref=e\d+|^\s*@e\d+\s/.test(line)).map((line) => line.replace(/\]:.*$/, "]").replace(/checked=(true|false)/g, "checked")).join("\n");
      const original = task.observation; const expected = structure(original.snapshot);
      let count = 0;
      for (const field of input.fields) {
        this.assertRunning(task, run);
        const observed = await this.dependencies.browser.observe(task);
        if (observed.url !== original.url || structure(observed.snapshot) !== expected) {
          task.observation = observed; this.publish(); return textResult({ filled: count, stopped: true, reason: "表单结构已变化，剩余填写已停止，请重新观察。" });
        }
        task.observation = observed;
        await this.perform(task, run, { ...field, version: observed.version, effect: "edit", summary: `填写字段 ${field.ref}` });
        count++;
      }
      return textResult({ filled: count, instruction: "请重新观察填写结果。" });
    }
    if (name === "verify_account") {
      const { account, evidence } = z.object({ account: z.string().min(1).max(200), evidence: z.string().min(3).max(1000) }).parse(args);
      if (!this.validEvidence(task, [evidence]) || !evidence.includes(account)) throw new Error("账号核对需要当前页面中包含账号标识的原文。");
      task.observation!.account = account; this.publish(); return textResult("已记录当前页面显示的账号。");
    }
    if (name === "reconcile") {
      const input = z.object({ receiptId: z.string(), outcome: z.enum(["completed", "not_completed", "uncertain"]), evidence: z.string().min(3).max(3000) }).parse(args);
      const receipt = task.receipts.find((entry) => entry.id === input.receiptId);
      if (!receipt || !this.validEvidence(task, [input.evidence])) throw new Error("核查需要有效操作记录和当前记录页中的原文依据。");
      receipt.reconciliation = { outcome: input.outcome, evidence: input.evidence, at: now() };
      task.needsReconciliation = task.receipts.some((entry) => serious(entry.action.effect) && entry.status === "uncertain" && (!entry.reconciliation || entry.reconciliation.outcome === "uncertain"));
      this.store.event(task, "system", `操作核查：${input.outcome}；页面依据：${input.evidence}`); this.publish();
      return textResult("核查结果已记录。已完成的操作不可重复执行。");
    }
    if (name === "browser_action") {
      const action = browserActionSchema.parse(args);
      if (task.resumeContext?.returnedAt && !task.resumeContext.observed) return textResult("人工交还后必须先观察当前页面和标签页，保留用户已经完成的登录与导航。", true);
      const readNavigation = action.effect === "read" && ["open", "switch_tab"].includes(action.kind);
      if (action.kind !== "open" && !readNavigation && (!task.observation || action.version !== task.observation.version)) return textResult("页面引用已失效，请重新 observe。", true);
      // An explicit read-only navigation does not use a DOM reference from the
      // old page. A rotating banner must not prevent leaving that page.
      if (task.observation && !readNavigation) {
        const latest = task.observation.fast && this.dependencies.browser.observeFast ? await this.dependencies.browser.observeFast(task) : await this.dependencies.browser.observe(task);
        this.assertRunning(task, run);
        const target = task.observation.fast && readLinkGuard(task.observation.fast.guard, action);
        const unchangedLink = target && latest.fast && target === readLinkGuard(latest.fast.guard, action);
        if (latest.fingerprint !== task.observation.fingerprint && !unchangedLink) {
          task.observation = latest; this.publish();
          return textResult("页面内容已经变化，旧动作已取消。请重新 observe 后决定操作。", true);
        }
      }
      action.effect = effectiveEffect(action, task.observation);
      if (serious(action.effect)) {
        if (action.effect === "purchase") {
          task.pending = { id: randomUUID(), kind: "handoff", title: "请在浏览器中完成购买或支付", details: action.summary, createdAt: now() };
          task.status = "waiting_user"; this.publish(); this.stopWorker(run);
          await this.dependencies.browser.control(task, "handoff"); this.notify(task, task.pending.title);
          return textResult("已交给用户完成购买或支付，禁止继续点击。");
        }
        if (task.needsReconciliation) return textResult("此前操作结果未确认。先观察回执或记录页，并更新项目结果；不能重复提交。", true);
        const grant = task.grant;
        if (grant && task.observation && grant.effects.includes(action.effect as "submit" | "send" | "delete") && new URL(task.observation.url).origin === grant.origin && grant.used < grant.maxActions) {
          grant.used++;
          this.store.event(task, "system", `按任务授权执行 ${action.effect}（${grant.used}/${grant.maxActions}）。`);
          return textResult(await this.perform(task, run, action));
        }
        task.pending = { id: randomUUID(), kind: "confirmation", title: action.summary, details: `${task.observation?.title || ""}\n${task.observation?.url || ""}\n操作：${action.effect}\n${action.value || ""}`, action,
          observationVersion: task.observation?.version, createdAt: now() };
        task.status = "waiting_user"; this.publish(); this.stopWorker(run);
        this.notify(task, "请检查并确认操作");
        return textResult("操作尚未执行，正在等待用户确认。停止后续操作。");
      }
      return textResult(await this.perform(task, run, action));
    }
    if (name === "ask_user" || name === "handoff") {
      task.pending = { id: randomUUID(), kind: name === "handoff" ? "handoff" : "question",
        title: z.string().min(1).max(3000).parse(args.question || args.reason), details: String(args.details || "").slice(0, 10000), createdAt: now() };
      task.status = "waiting_user"; this.publish();
      if (name === "handoff") task.resumeContext = { reason: task.pending.title, url: task.observation?.url };
      this.stopWorker(run);
      if (name === "handoff") await this.dependencies.browser.control(task, "handoff");
      this.notify(task, task.pending.title);
      return textResult("已等待用户，停止后续操作。");
    }
    if (name === "plan") { task.plan = z.array(z.string().max(1000)).max(30).parse(args.steps); this.publish(); return textResult("计划已更新。"); }
    if (name === "update_item") {
      const item = task.items.find((item) => item.id === args.id);
      if (!item) throw new Error("批量项目不存在。");
      const status = z.enum(["pending", "running", "waiting_user", "completed", "skipped", "failed", "uncertain"]).parse(args.status);
      if (status === "completed" && !this.validEvidence(task, [args.evidence])) throw new Error("项目完成需要当前页面中的原文依据。");
      item.status = status; item.result = String(args.result || "").slice(0, 10000); item.evidence = String(args.evidence || "").slice(0, 3000);
      this.publish(); return textResult("项目已更新。");
    }
    if (name === "finish") {
      const result = z.object({ status: z.enum(["completed", "partial", "failed"]), summary: z.string().min(1).max(20000), evidence: z.array(z.string().min(1).max(3000)).max(30), remaining: z.array(z.string().max(3000)).max(50) }).parse(args);
      if (result.status === "completed") {
        if (task.needsReconciliation) return textResult("无法标记完成：存在结果不明的提交等操作，请先观察回执或记录页并 reconcile；尚未确认时使用 partial。", true);
        if (!this.validEvidence(task, result.evidence, true, true)) return textResult("无法标记完成：完成依据未匹配本任务已观察页面或成功终端输出。浏览器业务请引用 observe 原文，本地结果可引用终端输出；不要将多个片段拼成一条引文。", true);
        if (task.items.some(item => !["completed", "skipped"].includes(item.status)) || result.remaining.length) return textResult("无法标记完成：仍有未完成项目或剩余事项，请继续处理或使用 partial。", true);
      }
      task.status = result.status; task.result = { summary: result.summary, evidence: result.evidence, remaining: result.remaining };
      if (result.status === "completed") task.needsReconciliation = false;
      this.publish(); this.notify(task, result.summary);
      return textResult("结果已保存。请结束本次执行。");
    }
    throw new Error("不支持的任务工具。");
  }
  private validEvidence(task: BrowserTask, evidence: unknown[], includeHistory = false, includeTerminal = false): boolean {
    if (!evidence.length) return false;
    const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
    const snapshots = [task.observation?.snapshot || "", ...(includeHistory ? (task.evidencePages || []).map(page => page.snapshot) : []), ...(includeTerminal ? this.terminal.evidence(task.id) : [])].map(normalize);
    return evidence.every(value => typeof value === "string" && value.trim().length >= 3 && snapshots.some(snapshot => snapshot.includes(normalize(value))));
  }
  private async perform(task: BrowserTask, run: Run, action: BrowserAction): Promise<string> {
    this.assertRunning(task, run);
    if (task.usage.actions >= task.limits.actions) throw new Error("任务达到操作次数上限，请检查并报告已有结果和剩余事项。");
    const signature = JSON.stringify({ kind: action.kind, ref: action.ref, value: action.value, attachmentId: action.attachmentId, effect: action.effect });
    run.repeatCount = signature === run.repeat ? run.repeatCount + 1 : 1; run.repeat = signature;
    const state = createHash("sha256").update(JSON.stringify([task.observation?.url, task.observation?.snapshot, task.observation?.viewport])).digest("hex");
    const attempts = run.attempts ||= new Map(); const states = run.visitedStates ||= new Map();
    const key = state + signature;
    attempts.set(key, (attempts.get(key) || 0) + 1); states.set(state, (states.get(state) || 0) + 1);
    if (attempts.get(key)! > 3 || states.get(state)! > 6) {
      const reason = "多次操作后仍回到相同页面，已停止重复尝试。请检查当前入口，或补充下一步线索。";
      task.pending = { id: randomUUID(), kind: "handoff", title: "需要检查当前页面", details: reason, createdAt: now() };
      task.resumeContext = { reason, url: task.observation?.url }; task.status = "waiting_user";
      this.store.event(task, "system", reason); this.stopWorker(run); this.publish();
      if (hasTaskBrowser(task)) await this.dependencies.browser.control(task, "handoff");
      throw new Error(reason);
    }
    if (attempts.get(key) === 3 || states.get(state) === 5) this.store.event(task, "system", "当前页面尚无进展：请检查截图、视口和标签页，改变查找方式，避免继续猜地址或重复按键。");
    const receipt = { id: randomUUID(), at: now(), action, status: "started" as const, observationVersion: task.observation?.version };
    // Evidence gathered before a mutation cannot establish its result. Read-only
    // navigation keeps earlier pages so multi-page research can cite them.
    if (action.effect !== "read") task.evidencePages = [];
    task.receipts.push(receipt); task.usage.actions++;
    task.execution = { engine: run.driver ? "jev" : "model", activity: action.summary, reason: task.execution?.reason, at: now() };
    this.store.event(task, "action", action.summary); this.publish();
    try {
      const result = await this.dependencies.browser.execute(task, action);
      Object.assign(receipt, { status: "executed", result: result.slice(0, 8000) });
      task.observation = undefined;
      this.publish(); return result;
    } catch (error) {
      Object.assign(receipt, { status: "uncertain", result: String(error) });
      if (serious(action.effect)) task.needsReconciliation = true;
      task.observation = undefined; this.publish(); throw error;
    }
  }
  private async assessPage(task: BrowserTask, run: Run, observation: BrowserObservation): Promise<void> {
    if (!this.store.data.settings.jevEnabled || this.store.data.settings.jevMode === "driver") return;
    const provider = jevProviderFor(this.store.data.settings);
    const unavailable = (note: string): void => { observation.jev = { status: "unavailable", model: jevModel(provider), version: observation.version, elapsedMs: 0, inputTokens: 0, note }; };
    if ((task.usage.jev?.calls || 0) >= JEV_MAX_CALLS) return unavailable("此任务已达到 100 次 Jev 判断上限，继续由主模型判断。");
    let key = "";
    try { key = this.dependencies.jevApiKey?.() || ""; } catch { return unavailable("无法读取 Jev 密钥，继续由主模型判断。"); }
    if (!key) return unavailable("尚未配置 Jev 密钥，继续由主模型判断。");
    const config = createHash("sha256").update(JSON.stringify([provider, key])).digest("hex");
    if (run.jevConfig !== config) { run.jevConfig = config; run.jevCache = undefined; run.jevUnavailable = undefined; }
    if (run.jevUnavailable) return unavailable(run.jevUnavailable);
    const state = jevPageState(task, observation);
    const hash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    if (run.jevCache?.hash === hash) { observation.jev = { ...run.jevCache.result, version: observation.version }; return; }
    run.jevAbort = new AbortController();
    const record = beginJevCall(task, "advisory"); this.publish();
    let result: JevAssessment;
    try {
      result = await (this.dependencies.evaluateJev || evaluateJevPage)(key, state, observation.version, { provider, signal: run.jevAbort.signal });
      finishJevCall(task, record, { elapsedMs: result.elapsedMs, inputTokens: result.inputTokens, note: result.note, outcome: result.status, operation: result.answers?.next.choice });
    } finally { finishJevCall(task, record); }
    this.assertRunning(task, run);
    // Discard results from credentials or a provider changed while the request was in flight.
    if (!this.store.data.settings.jevEnabled || jevProviderFor(this.store.data.settings) !== provider) return;
    try { if (this.dependencies.jevApiKey?.() !== key) return; } catch { return; }
    observation.jev = result;
    if (result.status === "unavailable") {
      run.jevUnavailable = result.note;
      this.store.event(task, "system", result.note);
    } else run.jevCache = { hash, result };
  }
  private stopWorker(run: Run, preserveBackground = false): void {
    run.stopped = true;
    const taskId = [...this.runs].find(([, active]) => active === run)?.[0];
    if (taskId && !run.terminalStop) run.terminalStop = this.terminal.stopTask(taskId, !preserveBackground).catch(error => {
      this.store.event(this.store.get(taskId), "error", String(error)); this.publish();
    });
    run.jevAbort?.abort();
    run.driverAbort?.abort();
    if (run.child?.connected) run.child.send({ kind: "stop" });
    if (run.child) {
      const child = run.child;
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 6000);
      killTimer.unref(); child.once("exit", () => clearTimeout(killTimer));
    }
  }
  async control(id: string, action: "pause" | "resume" | "takeover" | "cancel" | "rerun" | "steer", message = ""): Promise<void> {
    if (this.closed) throw new Error("应用正在退出，任务将在保存后暂停。");
    if (this.archiving.has(id) && action !== "cancel") throw new Error("任务正在停止并归档，请稍后操作。");
    const task = this.store.get(id);
    // Older renderers send rerun. Continue the original task for both commands.
    if (action === "rerun") action = "resume";
    const finished = TERMINAL_TASKS.has(task.status);
    if (finished && action !== "resume") throw new Error("任务已经结束，可选择继续任务。");
    if (action === "steer") {
      if (!message.trim()) throw new Error("请输入补充要求。");
      this.store.event(task, "user", message.trim()); this.publish();
      // A correction must not seize the browser while the human is working.
      if (task.pending?.kind === "handoff") return;
      await this.control(id, "pause");
      const deadline = Date.now() + 10000;
      while (this.runs.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (task.status === "paused" && !this.runs.has(id)) await this.control(id, "resume");
      return;
    }
    if (action === "resume") {
      if (task.status === "running" || task.status === "queued") throw new Error("任务正在执行或排队。");
      if (this.runs.has(id)) throw new Error("正在等待当前动作停止，请稍后继续。");
      if (task.pending?.kind === "confirmation") throw new Error("请先处理确认卡片。");
      if (finished) {
        if (task.attachments.some(file => !existsSync(file.path))) throw new Error("原任务的附件已删除，请重新选择附件后执行。");
        if (task.usage.elapsedMs >= task.limits.minutes * 60000 || task.usage.actions >= task.limits.actions || task.usage.costUsd >= task.limits.budgetUsd) throw new Error("原任务已达到运行限制，无法直接继续。请修改要求并调整限制后执行。");
        // Terminal browser leases have been released. The next observation will
        // reacquire the same session through normal profile ownership checks.
        if (task.result) this.store.event(task, "assistant", `上次执行结果：${JSON.stringify(task.result)}`);
        task.result = undefined;
        this.markInterrupted(task);
        task.resumeContext = { reason: "继续原任务", url: task.observation?.url, returnedAt: now(), observed: false };
        if (!message.trim()) this.store.event(task, "user", "继续当前任务。先核查当前页面与已有执行记录，保留已完成项目，不要重复提交或重做已完成操作。");
      }
      if (!finished && hasTaskBrowser(task)) {
        try { await this.returnBrowser(task); }
        catch (error) { throw new Error(`无法交还浏览器：${String(error)}`); }
      }
      if (task.pending?.kind === "handoff") this.recordBrowserReturn(task, message);
      task.archivedAt = undefined;
      task.pending = undefined; task.observation = undefined; task.status = "queued";
      if (message.trim()) this.store.event(task, "user", message.trim());
      this.store.event(task, "system", "继续任务；将重新观察浏览器实际状态。");
      this.publish(); void this.tick(); return;
    }
    const run = this.runs.get(id);
    if (action === "cancel") this.recordStoppedResult(task);
    if (action === "takeover") task.resumeContext = { reason: "用户主动接管", url: task.observation?.url };
    task.status = action === "cancel" ? "cancelled" : action === "takeover" ? "waiting_user" : "paused";
    task.observation = undefined;
    task.pending = action === "takeover" ? { id: randomUUID(), kind: "handoff", title: "浏览器由你操作", details: "完成后点击交还并继续，Agent 会重新观察页面。", createdAt: now() } : undefined;
    this.store.event(task, "system", action === "cancel" ? "任务已取消，已发生的操作不会撤销。" : "正在停止后续动作并交还浏览器。");
    if (run) this.stopWorker(run);
    this.publish();
    // A pause during read-only startup/observation can park the controller
    // halfway through CDP initialization. Stop scheduling immediately, but give
    // the in-flight read a bounded chance to drain before handing off.
    // Explicit takeover/cancel remain immediate; no input or submission waits.
    if (action === "pause" && run?.driver && task.receipts.every(receipt => receipt.action.effect === "read")) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([run.chain, new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); })]); }
      finally { if (deadline) clearTimeout(deadline); }
    }
    if (hasTaskBrowser(task)) {
      if (action === "cancel") await this.releaseBrowser(task);
      else await this.dependencies.browser.control(task, "handoff");
    }
    if (!run) { this.publish(); void this.tick(); }
  }
  async reply(id: string, decisionId: string, answer: string, approved: boolean): Promise<void> {
    if (this.archiving.has(id)) throw new Error("任务正在停止并归档，请稍后操作。");
    if (this.decisionsInFlight.has(id)) throw new Error("该确认正在处理，请勿重复操作。");
    this.decisionsInFlight.add(id);
    try { await this.applyReply(id, decisionId, answer, approved); }
    finally { this.decisionsInFlight.delete(id); }
  }
  private async applyReply(id: string, decisionId: string, answer: string, approved: boolean): Promise<void> {
    if (this.closed) throw new Error("应用正在退出，无法处理确认。");
    const task = this.store.get(id); const pending = task.pending;
    if (!pending || pending.id !== decisionId || task.status !== "waiting_user") throw new Error("该问题或确认已失效。");
    if (this.runs.has(id)) throw new Error("正在停止当前执行，请稍后操作。");
    const response = answer || (pending.kind === "confirmation" ? approved ? "确认执行" : "不执行此操作" : "继续当前任务");
    if (pending.kind === "confirmation") this.store.event(task, "user", response);
    if (pending.kind === "confirmation" && approved && pending.action) {
      const observation = task.observation?.fast && this.dependencies.browser.observeFast ? await this.dependencies.browser.observeFast(task) : await this.dependencies.browser.observe(task);
      if (task.status !== "waiting_user" || task.pending?.id !== decisionId) throw new Error("任务状态已经改变，原确认已取消。");
      if (!task.observation || observation.fingerprint !== task.observation.fingerprint || task.observation.version !== pending.observationVersion) {
        task.pending = undefined; task.observation = undefined; task.status = "queued";
        this.store.event(task, "system", "页面发生变化，原确认已失效。Agent 将重新检查。"); this.publish(); void this.tick(); return;
      }
      task.status = "running";
      task.pending = undefined;
      const run: Run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
      this.runs.set(id, run);
      try { run.chain = this.perform(task, run, pending.action); await run.chain; }
      catch (error) { this.store.event(task, "error", String(error)); }
      finally { this.runs.delete(id); }
      if (task.status !== "running") { this.publish(); return; }
    }
    if (pending.kind !== "confirmation" && hasTaskBrowser(task)) await this.returnBrowser(task);
    if (pending.kind !== "confirmation") this.store.event(task, "user", response);
    if (pending.kind === "handoff") this.recordBrowserReturn(task, answer);
    task.pending = undefined; task.observation = undefined; task.status = "queued";
    this.publish(); void this.tick();
  }
  private async endRun(task: BrowserTask, run: Run): Promise<void> {
    if (run.ending) return run.ending;
    run.ending = (async () => {
      if (run.timer) clearTimeout(run.timer);
      await run.chain;
      await run.terminalStop;
      task.usage.elapsedMs += Date.now() - run.started;
      task.runningSince = undefined;
      if (run.stopped && !TERMINAL_TASKS.has(task.status) && task.pending?.kind !== "confirmation") this.markInterrupted(task);
      if (task.status === "running") {
        task.status = "paused"; this.markInterrupted(task);
        this.store.event(task, "system", "Agent 进程已退出，继续前需要核查页面。");
      }
      await this.terminal.stopTask(task.id, !["completed", "partial"].includes(task.status));
      if (hasTaskBrowser(task) && TERMINAL_TASKS.has(task.status)) {
        try { await this.releaseBrowser(task); }
        catch (error) { this.store.event(task, "error", `释放浏览器失败：${String(error)}`); }
      }
      if (this.runs.get(task.id) === run) this.runs.delete(task.id);
      if (run.resumeAfterStop && !this.closed && task.status === "waiting_user" && task.pending?.kind === "handoff") this.acceptBrowserReturn(task);
      this.publish(); void this.tick();
    })();
    return run.ending;
  }
  externalControl(sessionId: string, ownership: string, sessionStatus: string, reason = ""): void {
    if (this.closed) return;
    const task = this.store.data.tasks.find((task) => task.sessionId === sessionId && !TERMINAL_TASKS.has(task.status));
    if (!task) return;
    if (reason === "user-return" && ownership === "agent" && task.pending?.kind === "handoff" && !this.returning.has(task.id)) {
      const run = this.runs.get(task.id);
      if (run) run.resumeAfterStop = true;
      else { this.acceptBrowserReturn(task); this.publish(); void this.tick(); }
      return;
    }
    if (sessionStatus === "stopped" || (ownership === "user" && (task.status === "running" || task.pending?.kind === "confirmation"))) {
      if (sessionStatus === "stopped") this.recordStoppedResult(task);
      const connectionPaused = ["extension-paused", "extension-disconnected"].includes(reason);
      if (sessionStatus !== "stopped") task.resumeContext = { reason: connectionPaused ? "浏览器连接已暂停" : "用户接管浏览器", url: task.observation?.url };
      const run = this.runs.get(task.id); if (run) this.stopWorker(run);
      task.status = sessionStatus === "stopped" ? "cancelled" : "waiting_user";
      task.observation = undefined;
      task.pending = sessionStatus === "stopped" ? undefined : { id: randomUUID(), kind: "handoff", title: connectionPaused ? "浏览器连接已暂停" : "浏览器已由用户接管", details: connectionPaused ? "连接暂停不代表你主动接管了浏览器。发送补充说明或点击继续，将尝试恢复连接并重新观察页面。" : "发送补充说明并继续后，Agent 会重新观察页面。", createdAt: now() };
      this.publish(); this.notify(task, task.pending?.title || "任务已停止");
    }
  }
  private async returnBrowser(task: BrowserTask): Promise<void> {
    this.returning.add(task.id);
    try { await this.dependencies.browser.control(task, "resume"); }
    finally { this.returning.delete(task.id); }
  }
  private async releaseBrowser(task: BrowserTask): Promise<void> {
    const run = this.runs.get(task.id);
    if (run?.browserRelease) return run.browserRelease;
    const release = (async () => {
      task.browserReleasePending = true; this.publish();
      await this.dependencies.browser.control(task, task.status === "cancelled" ? "release" : "complete");
      task.browserReleasePending = undefined; this.publish();
    })();
    // Cancel and worker exit can race. Release this run's session only once.
    if (run) run.browserRelease = release;
    try { await release; }
    catch (error) { if (run) run.browserRelease = undefined; throw error; }
  }
  private acceptBrowserReturn(task: BrowserTask): void {
    this.recordBrowserReturn(task);
    task.pending = undefined; task.observation = undefined; task.status = "queued";
    this.store.event(task, "system", "浏览器已交还，将重新观察并继续任务。");
  }
  private recordBrowserReturn(task: BrowserTask, userResponse = ""): void {
    task.resumeContext = { reason: task.resumeContext?.reason || task.pending?.title || "人工操作", url: task.resumeContext?.url || task.observation?.url,
      userResponse: userResponse.trim() || undefined, returnedAt: now(), observed: false };
    this.store.event(task, "system", "人工操作已结束。先检查当前标签页、主页账号入口或记录页；不能仅凭 /login 页面显示表单判断未登录，不要重做用户已经完成的步骤。");
  }
  private recordStoppedResult(task: BrowserTask): void {
    if (task.result) return;
    const last = task.receipts.at(-1);
    const completed = task.items.filter(item => item.status === "completed");
    task.result = { summary: `任务已停止，尚未确认全部完成。${last ? `最后尝试：${last.action.summary}（${last.status === "executed" ? "动作已执行，业务结果需核查" : "操作结果未确认"}）。` : "尚未执行浏览器动作。"}${task.pending ? `停止前等待：${task.pending.title}。` : ""}`,
      evidence: completed.flatMap(item => item.evidence ? [item.evidence] : []),
      remaining: task.items.length ? task.items.filter(item => !["completed", "skipped"].includes(item.status)).map(item => item.label) : ["核查原任务目标的完成情况；再次执行前先查看已有记录。"] };
  }
  private markInterrupted(task: BrowserTask): void {
    for (const receipt of task.receipts) if (receipt.status === "started" || (serious(receipt.action.effect) && receipt.status === "executed" && !receipt.reconciliation)) receipt.status = "uncertain";
    task.needsReconciliation = task.receipts.some((receipt) => serious(receipt.action.effect) && receipt.status === "uncertain" && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""));
  }
  private notify(task: BrowserTask, body: string): void { if (this.store.data.settings.notifications) this.dependencies.notify(task.title, body.slice(0, 160), task.id); }
  private async scheduleDue(): Promise<void> {
    for (const schedule of this.store.data.schedules) {
      if (!schedule.enabled || Date.parse(schedule.at) > Date.now()) continue;
      if (Date.now() - Date.parse(schedule.at) > 5 * 60000) {
        schedule.missedAt = now();
        this.dependencies.notify(schedule.name, "错过计划时间，未自动执行。请在定时任务中重新安排。");
      } else {
        try {
          const task = await this.create(schedule.task);
          task.scheduledBy = schedule.id; schedule.lastTaskId = task.id; schedule.lastRunAt = now();
        } catch (error) { schedule.missedAt = now(); this.dependencies.notify(schedule.name, String(error)); }
      }
      if (schedule.repeat === "once") schedule.enabled = false;
      else {
        schedule.at = nextDailyOccurrence(schedule.at, schedule.timezone);
      }
      this.publish();
    }
  }
  async updateTaskMetadata(id: string, input: TaskMetadataInput): Promise<void> {
    if (this.closed) throw new Error("应用正在退出，请稍后再试。");
    const patch = z.object({ title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict().refine(value => Object.values(value).some(item => item !== undefined), "请选择要修改的任务信息。").parse(input);
    const task = this.store.get(id);
    if (this.archiving.has(id)) throw new Error("任务正在停止并归档，请稍后操作。");
    if (patch.pinned === true && (patch.archived === true || task.archivedAt && patch.archived !== false)) throw new Error("请先移出归档，再置顶任务。");
    if (patch.archived === true) {
      if (this.decisionsInFlight.has(id) || this.returning.has(id)) throw new Error("正在处理任务确认或交还浏览器，请稍后归档。");
      this.archiving.add(id);
      try { await this.stopForArchive(task); }
      finally { this.archiving.delete(id); }
      if (this.closed) throw new Error("应用正在退出，任务记录已保留，请重新打开后归档。");
    }
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.archived !== undefined) task.archivedAt = patch.archived ? task.archivedAt || now() : undefined;
    if (patch.pinned !== undefined) task.pinnedAt = patch.pinned ? task.pinnedAt || now() : undefined;
    if (task.archivedAt) task.pinnedAt = undefined;
    task.metadataUpdatedAt = now();
    // Organizing a task is not execution activity. Preserve its timeline and result.
    this.publish();
  }
  private async stopForArchive(task: BrowserTask): Promise<void> {
    const run = this.runs.get(task.id);
    const wasFinished = TERMINAL_TASKS.has(task.status);
    if (!wasFinished) await this.control(task.id, "cancel");
    else if (run) this.stopWorker(run);
    // Keep the task visible until the current action and worker have drained.
    // A failed stop can be retried; archiving must never hide live execution.
    const deadline = Date.now() + 15000;
    while (this.runs.has(task.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.runs.has(task.id)) throw new Error("任务正在停止，记录仍保留在侧栏；请稍后再次归档。");
    if (!TERMINAL_TASKS.has(task.status)) throw new Error("任务状态已改变，请稍后再次归档。");
    // Retry only unfinished cleanup, including after restarting the app. Old
    // archived/cancelled tasks must not touch a browser now used by another task.
    if (task.browserReleasePending) await this.releaseBrowser(task);
    await this.terminal.stopTask(task.id);
  }
  deleteTask(id: string): void {
    if (this.archiving.has(id)) throw new Error("任务正在停止并归档，请稍后操作。");
    const task = this.store.get(id);
    if (!TERMINAL_TASKS.has(task.status) || this.runs.has(id)) throw new Error("请先取消任务并等待浏览器释放。");
    if (this.terminal.hasRunning(id)) throw new Error("任务仍有后台服务运行，请先归档任务以停止服务，再删除。");
    this.store.data.tasks = this.store.data.tasks.filter((task) => task.id !== id);
    for (const sub of ["sessions", "artifacts", "workspaces", "terminals"]) {
      const target = path.resolve(this.store.root, sub, id);
      if (!target.startsWith(path.resolve(this.store.root, sub) + path.sep)) throw new Error("无效的任务路径。");
      rmSync(target, { recursive: true, force: true });
    }
    this.publish();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.dependencies.closePreview?.();
    this.closing = (async () => {
      const active = [...this.runs];
      for (const [id, run] of active) {
        const task = this.store.get(id); this.stopWorker(run);
        if (!TERMINAL_TASKS.has(task.status)) {
          if (task.status === "running") task.status = "paused";
          task.observation = undefined;
        }
      }
      await this.terminal.close();
      const retained = this.store.data.tasks.filter(task => hasTaskBrowser(task) && !TERMINAL_TASKS.has(task.status));
      for (const task of retained) if (task.pending?.kind === "confirmation") {
        task.pending = undefined; task.status = "paused"; task.observation = undefined;
        this.store.event(task, "system", "应用退出，提交确认已失效；继续后会重新检查页面。");
      }
      this.publish();
      await Promise.allSettled(retained.map(task => this.dependencies.browser.control(task, "handoff").catch(error => this.store.event(task, "error", `退出时交还浏览器失败：${String(error)}`))));
      await Promise.allSettled(active.map(async ([id, run]) => {
        const task = this.store.get(id);
        await run.starting;
        await run.chain.catch(() => {});
        if (run.child && run.child.exitCode === null && run.child.signalCode === null) await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 7000);
          run.child!.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
        if (!TERMINAL_TASKS.has(task.status)) this.markInterrupted(task);
        await this.endRun(task, run);
      }));
      this.publish();
      this.dependencies.closeBrowser?.();
    })();
    return this.closing;
  }
}

export function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), ELECTRON_RUN_AS_NODE: "1" };
}
import { mergeModelTokens } from "../../shared/task-token-usage";
