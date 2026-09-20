import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BrowserTask, CreateTaskInput, TaskSnapshot, TaskEvent } from "../../shared/tasks";

export const now = (): string => new Date().toISOString();
const text = z.string().trim().min(1).max(30000);
export const createTaskSchema = z.object({
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
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, "tasks.json");
    this.data = { tasks: [], materials: [], attachments: [], schedules: [], templates: [], settings: { model: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com", maxConcurrent: 2, retentionDays: 30, saveScreenshots: true, notifications: true, hasApiKey: false } };
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.materials) || !Array.isArray(parsed.schedules) || !Array.isArray(parsed.attachments)) throw new Error("任务数据格式不正确，已保留原文件，请检查任务存储。");
      this.data = { ...this.data, ...parsed, settings: { ...this.data.settings, ...parsed.settings } };
    }
    // Never replay an interrupted external operation automatically after a crash.
    for (const task of this.data.tasks) {
      task.runningSince = undefined;
      const interrupted = task.status === "running";
      for (const receipt of task.receipts) if (receipt.status === "started" || (interrupted && ["submit", "send", "purchase", "delete"].includes(receipt.action.effect) && receipt.status === "executed" && !receipt.reconciliation)) receipt.status = "uncertain";
      if (task.receipts.some(receipt => receipt.status === "uncertain" && ["submit", "send", "purchase", "delete"].includes(receipt.action.effect) && !["completed", "not_completed"].includes(receipt.reconciliation?.outcome || ""))) task.needsReconciliation = true;
      if (task.status === "running") {
        task.status = "paused";
        task.needsReconciliation = true;
        task.observation = undefined;
        this.event(task, "system", "应用中断，任务已暂停。继续时将先核查页面及已执行操作。");
      }
      if (task.pending?.kind === "confirmation") {
        task.pending = undefined;
        task.status = "paused";
        task.needsReconciliation = true;
        task.observation = undefined;
      }
    }
    this.save();
  }
  save(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...this.data, version: 1 }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.file);
  }
  get(id: string): BrowserTask {
    const task = this.data.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("任务不存在。");
    return task;
  }
  create(input: CreateTaskInput, profileName: string): BrowserTask {
    const parsed = createTaskSchema.parse(input);
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
      id, title: parsed.prompt.slice(0, 48), prompt: parsed.prompt, profileId: parsed.profileId, profileName,
      status: "queued", createdAt: now(), updatedAt: now(), sessionId: `pp-task-${id}`,
      authorization: parsed.authorization, attachments, materials, events: [],
      items: parsed.items.map((label) => ({ id: randomUUID(), label, status: "pending" })),
      plan: [], receipts: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0, actions: 0 },
      limits: parsed.limits, needsReconciliation: false, grant: parsed.grant ? { ...parsed.grant, used: 0 } : undefined
    };
    this.event(task, "user", parsed.prompt);
    this.data.tasks.unshift(task);
    this.save();
    return task;
  }
  event(task: BrowserTask, kind: TaskEvent["kind"], value: string): void {
    task.events.push({ id: randomUUID(), at: now(), kind, text: value.slice(0, 30000) });
    task.updatedAt = now();
  }
  snapshot(): TaskSnapshot { return structuredClone(this.data); }
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
