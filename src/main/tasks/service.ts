import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TERMINAL_TASKS, jevProviderFor, type BrowserTask, type BrowserAction, type BrowserObservation, type JevAssessment, type CreateTaskInput, type TaskSnapshot } from "../../shared/tasks";
import { browserActionSchema, effectiveEffect, type BrowserAdapter } from "./browser";
import { TaskStore, now } from "./store";
import { nextDailyOccurrence } from "../../shared/task-time";
import { authorizeTaskRead, readTaskDocument, readTaskTable, writeTaskResult } from "./files";
import { evaluateJevPage, jevPageState, JEV_MAX_CALLS, jevModel } from "./jev";
import { runJevDriver } from "./jev-driver";
import { chooseJevAction } from "./jev-actions";
import { taskHelper } from "./task-helper";

export interface TaskServiceDependencies {
  browser: BrowserAdapter;
  prepareProfile(id: string): Promise<{ name: string; port: number }>;
  profileName(id: string): Promise<string>;
  apiKey(): string;
  jevApiKey?(): string;
  evaluateJev?: typeof evaluateJevPage;
  chooseJev?: typeof chooseJevAction;
  taskHelper?: typeof taskHelper;
  changed(snapshot: TaskSnapshot): void;
  notify(title: string, body: string, taskId?: string): void;
  controlReceiver?(sessionId: string, waiting: boolean): void;
  worker?: (task: BrowserTask, start: Record<string, unknown>) => ChildProcess;
}
interface Run {
  child?: ChildProcess; started: number; stopped: boolean; timer?: NodeJS.Timeout;
  chain: Promise<unknown>; repeat: string; repeatCount: number; ending?: Promise<void>; starting?: Promise<void>; resumeAfterStop?: boolean;
  jevAbort?: AbortController; jevCache?: { hash: string; result: JevAssessment }; jevUnavailable?: string; jevConfig?: string;
  driver?: boolean; driverAbort?: AbortController;
}
const textResult = (value: unknown, isError = false): any => ({ isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const serious = (effect: string): boolean => ["submit", "send", "purchase", "delete"].includes(effect);

export class TaskService {
  readonly runs = new Map<string, Run>();
  private ticking = false;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private closing?: Promise<void>;
  private readonly returning = new Set<string>();
  private readonly receivers = new Set<string>();
  private lastCleanup = 0;
  private readonly decisionsInFlight = new Set<string>();
  constructor(readonly store: TaskStore, readonly dependencies: TaskServiceDependencies) {}
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
        for (const task of this.store.data.tasks.slice()) if (TERMINAL_TASKS.has(task.status) && Date.parse(task.updatedAt) < cutoff && !this.runs.has(task.id)) this.deleteTask(task.id);
      }
      for (const task of this.store.data.tasks.slice().reverse()) {
        if (task.status !== "queued" || this.runs.size >= this.store.data.settings.maxConcurrent) continue;
        const occupied = this.store.data.tasks.some((other) => other.id !== task.id && other.profileId === task.profileId &&
          (this.runs.has(other.id) || (["running", "waiting_user", "paused"].includes(other.status) && Boolean(other.port))));
        if (!occupied) this.launch(task);
      }
    } finally { this.ticking = false; }
  }
  private launch(task: BrowserTask): void {
    const run: Run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: "", repeatCount: 0 };
    this.runs.set(task.id, run);
    task.runningSince = new Date(run.started).toISOString();
    task.status = "running";
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
    task.profileName = profile.name;
    task.observation = undefined;
    run.timer = setTimeout(() => {
      void (async () => {
        if (this.closed || run.stopped || this.runs.get(task.id) !== run) return;
        // finish can persist a terminal result while the SDK is still writing
        // its final response. Drain that run without pausing a finished task.
        if (TERMINAL_TASKS.has(task.status)) {
          this.stopWorker(run);
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
        const settings = structuredClone(this.store.data.settings);
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
        finally { run.driver = false; }
        if (run.stopped || task.status !== "running") return void this.endRun(task, run);
        this.store.event(task, "system", fallback || "配置已更新，交由主模型继续处理。");
        task.observation = undefined; this.publish();
      }
    }
    const cwd = path.join(this.store.root, "sessions", task.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const start = { kind: "start", task: structuredClone(task), settings: this.store.data.settings, apiKey: this.dependencies.apiKey(), cwd };
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
      if (message.kind === "text" && !run.stopped) this.store.event(task, "assistant", String(message.text));
      if (message.kind === "result") {
        // SDK cost is cumulative for resumed sessions; never add it twice.
        task.usage.costUsd = Math.max(task.usage.costUsd, Number(message.costUsd) || 0);
        task.usage.inputTokens = Math.max(task.usage.inputTokens, Number(message.inputTokens) || 0);
        task.usage.outputTokens = Math.max(task.usage.outputTokens, Number(message.outputTokens) || 0);
        if (!run.stopped && task.status === "running") {
          task.status = "partial";
          task.result = { summary: message.result || "Agent 已结束，但未提供可验证的完成结果。", evidence: [], remaining: ["需要核查任务完成情况"] };
        }
      }
      if (message.kind === "error" && !run.stopped) {
        task.status = "paused"; task.needsReconciliation = true;
        this.store.event(task, "error", String(message.text));
      }
      this.publish();
    });
    worker.once("error", (error) => {
      this.store.event(task, "error", error.message); task.status = "paused"; task.needsReconciliation = true;
      void this.endRun(task, run);
    });
    worker.once("exit", () => { void this.endRun(task, run); });
    worker.send(start);
    this.publish();
  }
  private assertRunning(task: BrowserTask, run: Run): void {
    if (run.stopped || this.runs.get(task.id) !== run || task.status !== "running") throw new Error("任务当前已停止或等待用户，不得继续操作浏览器。");
  }
  async handleTool(task: BrowserTask, run: Run, name: string, args: any): Promise<any> {
    this.assertRunning(task, run);
    if (name === "authorize_read") return typeof args.path === "string" ? authorizeTaskRead(task, args.path) : { allowed: false };
    if (name === "read_document") return readTaskDocument(task, args);
    if (name === "read_table") return textResult(await readTaskTable(task, args));
    if (name === "export_result") {
      const file = writeTaskResult(task, path.join(this.store.root, "artifacts"), args);
      this.store.event(task, "system", `已生成结果文件：${file.name}`); this.publish(); return textResult(file);
    }
    if (name === "observe") {
      const observation = run.driver && args.fast && this.dependencies.browser.observeFast
        ? await this.dependencies.browser.observeFast(task)
        : await this.dependencies.browser.observe(task, args.screenshot === true, this.store.data.settings.saveScreenshots);
      this.assertRunning(task, run);
      if (!task.receipts.some((receipt) => serious(receipt.action.effect) && ["started", "uncertain"].includes(receipt.status) && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""))) task.needsReconciliation = false;
      await this.assessPage(task, run, observation);
      this.assertRunning(task, run);
      const content: any[] = [{ type: "text", text: JSON.stringify({ ...observation, screenshotDataUrl: undefined, screenshotPath: undefined }) }];
      if (observation.screenshotDataUrl) content.push({ type: "image", mimeType: "image/png", data: observation.screenshotDataUrl.split(",")[1] });
      if (!this.store.data.settings.saveScreenshots) { observation.screenshotDataUrl = undefined; observation.screenshotPath = undefined; }
      task.observation = observation; this.publish();
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
      if (action.kind !== "open" && (!task.observation || action.version !== task.observation.version)) return textResult("页面引用已失效，请重新 observe。", true);
      if (task.observation) {
        const latest = task.observation.fast && this.dependencies.browser.observeFast ? await this.dependencies.browser.observeFast(task) : await this.dependencies.browser.observe(task);
        this.assertRunning(task, run);
        if (latest.fingerprint !== task.observation.fingerprint) {
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
      if (result.status === "completed" && (task.needsReconciliation || !this.validEvidence(task, result.evidence) || task.items.some((item) => !["completed", "skipped"].includes(item.status)) || result.remaining.length)) return textResult("无法标记完成：请核查结果不明的操作、提供已观察页面中的依据并核对未完成项目，或使用 partial。", true);
      task.status = result.status; task.result = { summary: result.summary, evidence: result.evidence, remaining: result.remaining };
      if (result.status === "completed") task.needsReconciliation = false;
      this.publish(); this.notify(task, result.summary);
      return textResult("结果已保存。请结束本次执行。");
    }
    throw new Error("不支持的任务工具。");
  }
  private validEvidence(task: BrowserTask, evidence: unknown[]): boolean {
    if (!task.observation || !evidence.length) return false;
    return evidence.every((value) => typeof value === "string" && value.trim().length >= 3 && task.observation!.snapshot.includes(value));
  }
  private async perform(task: BrowserTask, run: Run, action: BrowserAction): Promise<string> {
    this.assertRunning(task, run);
    if (task.usage.actions >= task.limits.actions) throw new Error("任务达到操作次数上限，请检查并报告已有结果和剩余事项。");
    const signature = JSON.stringify({ ...action, version: undefined });
    run.repeatCount = signature === run.repeat ? run.repeatCount + 1 : 1; run.repeat = signature;
    if (run.repeatCount > 3) throw new Error("同一个动作已重复三次。请重新判断阻碍，必要时请求用户接管。");
    const receipt = { id: randomUUID(), at: now(), action, status: "started" as const, observationVersion: task.observation?.version };
    task.receipts.push(receipt); task.usage.actions++;
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
    const usage = (task.usage.jev ||= { calls: 0, inputTokens: 0, elapsedMs: 0 });
    usage.calls++; this.publish();
    const result = await (this.dependencies.evaluateJev || evaluateJevPage)(key, state, observation.version, { provider, signal: run.jevAbort.signal });
    usage.inputTokens += result.inputTokens; usage.elapsedMs += result.elapsedMs;
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
  private stopWorker(run: Run): void {
    run.stopped = true;
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
    const task = this.store.get(id);
    if (action === "rerun") {
      await this.create({ prompt: task.prompt, profileId: task.profileId, authorization: task.authorization,
        materialIds: task.materials.map((entry) => entry.id), attachmentIds: task.attachments.map((entry) => entry.id),
        items: task.items.map((item) => item.label), limits: task.limits, grant: task.grant }); return;
    }
    if (TERMINAL_TASKS.has(task.status)) throw new Error("任务已经结束，可选择再次执行。");
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
      if (task.port) {
        try { await this.returnBrowser(task); }
        catch (error) { throw new Error(`无法交还浏览器：${String(error)}`); }
      }
      task.pending = undefined; task.observation = undefined; task.status = "queued";
      if (message.trim()) this.store.event(task, "user", message.trim());
      this.store.event(task, "system", "继续任务；将重新观察浏览器实际状态。");
      this.publish(); void this.tick(); return;
    }
    const run = this.runs.get(id);
    task.status = action === "cancel" ? "cancelled" : action === "takeover" ? "waiting_user" : "paused";
    task.observation = undefined;
    task.pending = action === "takeover" ? { id: randomUUID(), kind: "handoff", title: "浏览器由你操作", details: "完成后点击交还并继续，Agent 会重新观察页面。", createdAt: now() } : undefined;
    this.store.event(task, "system", action === "cancel" ? "任务已取消，已发生的操作不会撤销。" : "正在停止后续动作并交还浏览器。");
    if (run) this.stopWorker(run);
    this.publish();
    if (task.port) await this.dependencies.browser.control(task, action === "cancel" ? "release" : "handoff");
    if (!run) { this.publish(); void this.tick(); }
  }
  async reply(id: string, decisionId: string, answer: string, approved: boolean): Promise<void> {
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
    this.store.event(task, "user", answer || (approved ? "确认执行" : "不执行此操作"));
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
    if (pending.kind !== "confirmation" && task.port) await this.returnBrowser(task);
    task.pending = undefined; task.observation = undefined; task.status = "queued";
    this.publish(); void this.tick();
  }
  private async endRun(task: BrowserTask, run: Run): Promise<void> {
    if (run.ending) return run.ending;
    run.ending = (async () => {
      if (run.timer) clearTimeout(run.timer);
      await run.chain;
      task.usage.elapsedMs += Date.now() - run.started;
      task.runningSince = undefined;
      if (run.stopped && !TERMINAL_TASKS.has(task.status) && task.pending?.kind !== "confirmation") this.markInterrupted(task);
      if (task.status === "running") {
        task.status = "paused"; this.markInterrupted(task);
        this.store.event(task, "system", "Agent 进程已退出，继续前需要核查页面。");
      }
      if (task.port && TERMINAL_TASKS.has(task.status)) {
        try { await this.dependencies.browser.control(task, task.status === "cancelled" ? "release" : "complete"); }
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
      const run = this.runs.get(task.id); if (run) this.stopWorker(run);
      task.status = sessionStatus === "stopped" ? "cancelled" : "waiting_user";
      task.observation = undefined;
      task.pending = sessionStatus === "stopped" ? undefined : { id: randomUUID(), kind: "handoff", title: "浏览器已由用户接管", details: "交还后会重新观察页面。", createdAt: now() };
      this.publish(); this.notify(task, task.pending?.title || "任务已停止");
    }
  }
  private async returnBrowser(task: BrowserTask): Promise<void> {
    this.returning.add(task.id);
    try { await this.dependencies.browser.control(task, "resume"); }
    finally { this.returning.delete(task.id); }
  }
  private acceptBrowserReturn(task: BrowserTask): void {
    task.pending = undefined; task.observation = undefined; task.status = "queued";
    this.store.event(task, "system", "浏览器已交还，将重新观察并继续任务。");
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
  deleteTask(id: string): void {
    const task = this.store.get(id);
    if (!TERMINAL_TASKS.has(task.status) || this.runs.has(id)) throw new Error("请先取消任务并等待浏览器释放。");
    this.store.data.tasks = this.store.data.tasks.filter((task) => task.id !== id);
    for (const sub of ["sessions", "artifacts"]) {
      const target = path.resolve(this.store.root, sub, id);
      if (!target.startsWith(path.resolve(this.store.root, sub) + path.sep)) throw new Error("无效的任务路径。");
      rmSync(target, { recursive: true, force: true });
    }
    this.publish();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.closing = (async () => {
      const active = [...this.runs];
      for (const [id, run] of active) {
        const task = this.store.get(id); this.stopWorker(run);
        if (!TERMINAL_TASKS.has(task.status)) {
          if (task.status === "running") task.status = "paused";
          task.observation = undefined;
        }
      }
      const retained = this.store.data.tasks.filter(task => task.port && !TERMINAL_TASKS.has(task.status));
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
    })();
    return this.closing;
  }
}

export function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))), ELECTRON_RUN_AS_NODE: "1" };
}
