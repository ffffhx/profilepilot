import { TaskRecords } from "./records";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BrowserTask, CreateTaskInput, TaskSnapshot, TaskEvent } from "../../shared/tasks";
import { taskModelText } from "../../shared/task-model";
import { updateTokenRecords } from "../../shared/task-token-usage";
import { legacyCostCorrection } from "./cost-accounting";
import { interruptReceipts, preserveVerifiedReceipts } from "./conversation";
import { captureTaskSkill, taskSkillCatalog, taskSkillSelectionSchema } from "./skills";
import { SdkTaskHistory, type StoredTask } from "./sdk-history";

export const now = (): string => new Date().toISOString();
const text = z.string().trim().min(1).max(30000);
const nativeOriginSchema = z.string().trim().url().max(2000).transform(value => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("站点规则必须是无路径、凭据或查询参数的 HTTP/HTTPS 来源。");
  return url.origin;
});
export const nativeAccessSchema = z.object({ allowedOrigins: z.array(nativeOriginSchema).max(200).optional(), blockedOrigins: z.array(nativeOriginSchema).max(200).optional(), confirmActions: z.boolean().optional() }).strict();
export const createTaskSchema = z.object({
  skill: taskSkillSelectionSchema.optional(),
  nativeTarget: z.object({ tabId: z.number().int().positive().optional(), newTab: z.boolean().optional() }).strict().refine(value => !(value.newTab && value.tabId !== undefined), "新标签页不能同时指定既有标签页编号。").optional(),
  nativeAccess: nativeAccessSchema.optional(),
  mode: z.enum(["manual", "plan", "acceptEdits"]).optional(), model: z.string().trim().min(1).max(200).optional(),
  prompt: text, profileId: z.string().min(1).max(200), authorization: z.string().max(5000).default(""),
  materialIds: z.array(z.string()).max(50).default([]), attachmentIds: z.array(z.string()).max(50).default([]),
  items: z.array(z.string().trim().min(1).max(3000)).max(500).default([]),
  grant: z.object({ origin: z.string().url().transform((value) => {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("授权网站需填写 HTTP/HTTPS 网站来源，例如 https://example.com，不能包含路径或凭据。");
    return url.origin;
  }), effects: z.array(z.enum(["submit", "send", "delete"])).min(1).max(3), maxActions: z.number().int().min(1).max(500) }).optional(),
  limits: z.object({ minutes: z.number().int().min(1).max(1440).default(30), actions: z.number().int().min(1).max(10000).default(200), budgetUsd: z.number().positive().max(1000).default(5) }).default({ minutes: 30, actions: 200, budgetUsd: 5 })
});

export class TaskStore {
  readonly file: string;
  data: TaskSnapshot;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly records: TaskRecords;
  private readonly pendingTasks = new Set<string>();
  private saveError?: Error;
  private histories = new Map<string, SdkTaskHistory>();
  private sdkTitles = new Map<string, { session: string; title: string }>();
  /** Deferred failures stay visible until a successful save/flush retries them. */
  get persistenceError(): Error | undefined { return this.saveError; }
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.records = new TaskRecords(root);
    this.file = this.records.file;
    this.data = { tasks: [], materials: [], attachments: [], schedules: [], templates: [], settings: { model: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com", maxConcurrent: 2, retentionDays: 30, saveScreenshots: true, notifications: true, hasApiKey: false } };
    const parsed = this.records.read();
    if (parsed) {
      const tasks = parsed.tasks.map((stored: StoredTask) => {
        const history = this.sdkHistory(stored.id);
        history.refresh();
        const task = history.hydrate(stored);
        if (stored.sdkTitle) this.sdkTitles.set(task.id, { session: stored.sdkTitle, title: task.title });
        return task;
      });
      this.data = { ...this.data, ...parsed, tasks, settings: { ...this.data.settings, ...parsed.settings } };
    }
    const corrections = this.data.tasks.map(task => ({ task, correction: legacyCostCorrection(root, task) })).filter(entry => entry.correction);
    if (corrections.length) {
      // Preserve the exact original store before applying the idempotent repair.
      this.records.backup(`.before-pricing-${Date.now()}.bak`);
      for (const { task, correction } of corrections) {
        task.costAccounting = correction!.accounting; task.cachedInputTokens = correction!.cacheReadInputTokens;
        task.usage.costUsd = correction!.costUsd;
        if (task.status === "paused" && task.result?.summary.startsWith("Reached maximum budget") && task.usage.costUsd < task.limits.budgetUsd) {
          task.result.summary = "此前费用估算使用了错误单价，现已校正。任务保持暂停，可继续处理原来的要求。";
        }
        this.event(task, "system", `已按 DeepSeek 公布单价校正估算费用：$${correction!.accounting.originalUsd!.toFixed(3)} → $${task.usage.costUsd.toFixed(3)}。原预算上限保持不变，实际费用以服务商账单为准。`);
      }
    }
    // Never replay an interrupted external operation automatically after a crash.
    for (const task of this.data.tasks) {
      task.runningSince = undefined;
      for (const activity of task.agentActivities || []) if (activity.status === "running") { activity.status = "interrupted"; activity.updatedAt = now(); }
      for (const decision of task.jevDecisions || []) if (decision.status === "running") {
        decision.status = "interrupted"; decision.note = "应用中断，未收到完整判断响应；不计入平均响应时间。";
      }
      const interrupted = task.status === "running";
      preserveVerifiedReceipts(task);
      interruptReceipts(task, interrupted);
      if (task.status === "running") {
        task.status = "paused";
        task.observation = undefined;
        this.event(task, "system", "应用中断，任务已暂停。继续时将先核查页面及已执行操作。");
      }
      if (task.pending?.kind === "confirmation") {
        task.pending = undefined;
        task.status = "paused";
        task.observation = undefined;
      }
    }
    this.save();
  }
  /** Synchronous durability boundary: retain this before/after external actions,
   * user messages, permissions and task-state transitions. Also drains batching.
   * Normal mutations pass only changed tasks; [] saves metadata. Omitting changes
   * is a full checkpoint for startup recovery or an imported/replaced snapshot. */
  save(changes: readonly BrowserTask[] = this.data.tasks): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    for (const task of changes) this.pendingTasks.add(task.id);
    try {
      const changed = this.data.tasks.filter(task => this.pendingTasks.has(task.id));
      this.data.tokenRecords = updateTokenRecords(this.data.tokenRecords || [], changed);
      const records = changed.map(task => {
        const history = this.sdkHistory(task.id);
        history.refresh(); this.refreshTitle(task, history);
        return history.dehydrate(task);
      });
      const { tasks, ...metadata } = this.data;
      this.records.write(metadata, tasks.map(task => task.id), records);
      for (const stored of records) if (stored.sdkTitle) {
        this.sdkTitles.set(stored.id, { session: stored.sdkTitle, title: this.get(stored.id).title });
      }
      this.pendingTasks.clear(); this.saveError = undefined;
    } catch (error) {
      this.saveError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
  /** Only for replaceable progress/activity metadata, never action receipts or
   * messages. The first request sets the deadline; repeated updates cannot delay
   * saving forever. Serialization occurs once when the batch is drained. */
  scheduleSave(delayMs = 80, changes: readonly BrowserTask[] = this.data.tasks): void {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) throw new RangeError("保存延迟须在 0–1000ms 之间。");
    for (const task of changes) this.pendingTasks.add(task.id);
    if (this.saveTimer) return;
    // Keep the short timer referenced so ordinary process exit cannot drop a batch.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try { this.save([]); }
      catch (error) { console.error("任务进度保存失败；下次保存或关闭时将重试。", error); }
    }, delayMs);
  }
  /** Flush queued changes. Imports that replace data must explicitly call save(). */
  flush(): void { this.save([]); }
  /** Call after the service's final state changes, before application shutdown. */
  close(): void { this.flush(); }
  sdkHistory(id: string): SdkTaskHistory {
    if (!/^[\w-]+$/.test(id)) throw new Error("任务编号格式不正确。");
    let history = this.histories.get(id);
    if (!history) { history = new SdkTaskHistory(path.join(this.root, "sessions", id)); this.histories.set(id, history); }
    return history;
  }
  private refreshTitle(task: BrowserTask, history: SdkTaskHistory): void {
    const previous = this.sdkTitles.get(task.id);
    if (!previous || previous.session !== task.sdkSessionId || task.title !== previous.title) return;
    const title = history.title(previous.session);
    if (title) { task.title = title; previous.title = title; }
  }
  get(id: string): BrowserTask {
    const task = this.data.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("任务不存在。");
    return task;
  }
  create(input: CreateTaskInput, profileName: string, nativeRequest?: NonNullable<BrowserTask["nativeUiRequests"]>[number]): BrowserTask {
    const parsed = createTaskSchema.parse(input);
    if (!parsed.profileId.startsWith("native:") && (parsed.nativeTarget || parsed.nativeAccess)) throw new Error("原生浏览器目标与权限仅适用于系统 Chrome Profile。");
    const materials = parsed.materialIds.map((id) => {
      const value = this.data.materials.find((entry) => entry.id === id);
      if (!value) throw new Error("选择的资料已不存在。");
      return structuredClone(value);
    });
    const attachments = parsed.attachmentIds.map((id) => {
      const value = this.data.attachments.find((entry) => entry.id === id);
      if (!value) throw new Error("选择的附件已不存在。");
      return structuredClone(value);
    });
    const id = randomUUID();
    const task: BrowserTask = {
      skill: parsed.skill ? captureTaskSkill(parsed.skill, this.root) : undefined,
      mode: parsed.mode || (parsed.profileId.startsWith("native:") ? "acceptEdits" : undefined), model: parsed.model,
      nativeTarget: parsed.nativeTarget, nativeAccess: parsed.profileId.startsWith("native:") ? structuredClone({ ...this.data.nativeAccessPolicies?.[parsed.profileId], ...parsed.nativeAccess }) : undefined,
      nativeUiRequests: nativeRequest ? [structuredClone(nativeRequest)] : undefined,
      id, title: parsed.prompt.slice(0, 48), prompt: parsed.prompt, profileId: parsed.profileId, profileName,
      status: "queued", createdAt: now(), updatedAt: now(), sessionId: `pp-task-${id}`,
      authorization: parsed.authorization, attachments, materials, events: [],
      items: parsed.items.map((label) => ({ id: randomUUID(), label, status: "pending" })),
      plan: [], receipts: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0, actions: 0 },
      limits: parsed.limits, needsReconciliation: false, grant: parsed.grant ? { ...parsed.grant, used: 0 } : undefined
    };
    this.event(task, "user", parsed.prompt);
    this.data.tasks.unshift(task);
    this.save([task]);
    return task;
  }
  event(task: BrowserTask, kind: TaskEvent["kind"], value: string, streamId?: string): void {
    if (kind === "system") value = taskModelText(task, value);
    task.events.push({ id: randomUUID(), at: now(), kind, text: value.slice(0, 30000), ...(streamId ? { streamId } : {}) });
    task.updatedAt = now();
    this.pendingTasks.add(task.id);
  }
  listMetadata(): import("../../shared/tasks").TaskListMetadata {
    const { materials, attachments, schedules, templates, settings, memoryPolicies, nativeAccessPolicies, tokenRecords } = this.data;
    return { materials, attachments, schedules, templates, settings, memoryPolicies, nativeAccessPolicies, tokenRecords, skills: this.catalog.skills, skillIssues: this.catalog.issues };
  }
  private catalog = taskSkillCatalog();
  refreshCatalog(): void { this.catalog = taskSkillCatalog(); }
  refreshTaskTitle(id: string): void {
    const task = this.get(id);
    if (this.sdkTitles.has(id)) { const history = this.sdkHistory(id); history.refresh(); this.refreshTitle(task, history); }
  }
  snapshot(): TaskSnapshot {
    for (const task of this.data.tasks) if (this.sdkTitles.has(task.id)) { const history = this.sdkHistory(task.id); history.refresh(); this.refreshTitle(task, history); }
    const catalog = taskSkillCatalog(); return { ...structuredClone(this.data), skills: catalog.skills, skillIssues: catalog.issues };
  }
}

export function scrubDiagnostics(data: TaskSnapshot): unknown {
  return {
    generatedAt: now(), settings: { ...data.settings, baseUrl: new URL(data.settings.baseUrl).origin },
    tasks: data.tasks.map((task) => ({ id: task.id, status: task.status, createdAt: task.createdAt,
      updatedAt: task.updatedAt, usage: task.usage, limits: task.limits,
      needsReconciliation: task.needsReconciliation,
      events: task.events.map(({ at, kind }) => ({ at, kind })),
      receipts: task.receipts.map(({ at, status, action }) => ({ at, status, kind: action.kind, effect: action.effect })) }))
  };
}
