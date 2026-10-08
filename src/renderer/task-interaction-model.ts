import type { BrowserTask, TaskResult } from "../shared/tasks";
import { TERMINAL_TASKS } from "../shared/tasks";

export function draftKey(taskId: string, formId: string, decisionId = ""): string {
  return JSON.stringify([taskId, formId, formId === "reply-task" ? decisionId : ""]);
}
export type MessageDraft = { text: string; attachments: string[]; mode: "queue" | "steer"; requestId?: string; submitted?: string };
function validDraftKey(key: string): boolean { try { const parts = JSON.parse(key); return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === "string") && ["create-task", "steer-task", "reply-task"].includes(parts[1]); } catch { return false; } }
export function messageDelivery(task: Pick<BrowserTask, "status" | "pending">, mode: "queue" | "steer"): "queue" | "steer" | "resume" { return task.pending ? "queue" : TERMINAL_TASKS.has(task.status) ? "resume" : mode; }
export class MessageDrafts {
  private values = new Map<string, MessageDraft>();
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">, private name = "profilepilot-message-drafts-v2") {
    try { const saved: unknown = JSON.parse(storage?.getItem(name) || "[]"); if (Array.isArray(saved)) for (const row of saved) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || !row[1] || typeof row[1].text !== "string") continue;
      if (!validDraftKey(row[0])) continue;
      this.values.set(row[0], { text: row[1].text, attachments: Array.isArray(row[1].attachments) ? row[1].attachments.filter((id: unknown) => typeof id === "string") : [], mode: row[1].mode === "steer" ? "steer" : "queue", requestId: typeof row[1].requestId === "string" ? row[1].requestId : undefined, submitted: typeof row[1].submitted === "string" ? row[1].submitted : undefined });
    } } catch { /* A malformed cache must not prevent the workspace from opening. */ }
  }
  get(key: string): MessageDraft { const draft = this.values.get(key); return draft ? { ...draft, attachments: [...draft.attachments] } : { text: "", attachments: [], mode: "queue" }; }
  entries(taskId: string): Array<[string, MessageDraft]> { return [...this.values].filter(([key, draft]) => JSON.parse(key)[0] === taskId && (!!draft.text || !!draft.attachments.length)).map(([key]) => [key, this.get(key)]); }
  prepare(key: string, context: string, makeId: () => string): MessageDraft {
    const draft = this.get(key), fingerprint = JSON.stringify([context, draft.text, draft.attachments, draft.mode]);
    this.set(key, { requestId: draft.submitted === fingerprint && draft.requestId ? draft.requestId : makeId(), submitted: fingerprint });
    return this.get(key);
  }
  set(key: string, patch: Partial<MessageDraft>): void { if (!validDraftKey(key)) return; this.values.set(key, { ...this.get(key), ...patch }); this.persist(); }
  acknowledge(key: string, sent: MessageDraft): void {
    const current = this.get(key);
    this.set(key, { text: current.text === sent.text ? "" : current.text, attachments: current.attachments.filter(id => !sent.attachments.includes(id)), requestId: undefined, submitted: undefined });
  }
  private persist(): void { try { this.storage?.setItem(this.name, JSON.stringify([...this.values])); } catch { /* Keep the in-memory draft when disk is full or storage unavailable. */ } }
}
export function priorResult(text: string): TaskResult | undefined {
  if (!text.startsWith("上次执行结果：")) return;
  try { const result = JSON.parse(text.slice("上次执行结果：".length)); if (typeof result.summary === "string" && Array.isArray(result.evidence) && Array.isArray(result.remaining)) return result; } catch { /* Ordinary assistant text. */ }
}
export interface SearchHit { id: string; text: string; label: string; }
export function taskSearchDocuments(task: BrowserTask): SearchHit[] {
  return [{ id: "task-prompt", text: task.prompt, label: "最初要求" }, { id: "task-context", text: `${task.title} ${task.profileName}`, label: "任务" },
    ...task.events.map(event => ({ id: `event-${event.id}`, text: event.text, label: event.kind === "user" ? "用户消息" : "执行记录" })),
    { id: "task-result", text: [task.result?.summary, ...(task.result?.evidence || []), ...(task.result?.remaining || [])].join("\n"), label: "任务结果" },
    ...task.items.map(item => ({ id: `item-${item.id}`, text: `${item.label}\n${item.result || ""}\n${item.evidence || ""}`, label: "逐项结果" })),
    ...(task.evidencePages || []).map(page => ({ id: "task-evidence", text: `${page.title}\n${page.url}\n${page.snapshot}`, label: "页面证据" }))];
}
export function findTaskHit(task: BrowserTask, query: string): SearchHit | undefined {
  const q = query.normalize("NFKC").toLocaleLowerCase().trim(); if (!q) return;
  return taskSearchDocuments(task).find(row => row.text.normalize("NFKC").toLocaleLowerCase().includes(q));
}
export function attentionReason(task: BrowserTask, readAt?: string): string {
  if (task.archivedAt) return "";
  if (task.pending) return task.pending.kind === "confirmation" ? "等待确认" : task.pending.kind === "handoff" ? "需要接管" : "等待回答";
  if (task.status === "failed") return "执行失败";
  if (["completed", "partial", "cancelled"].includes(task.status) && (!readAt || readAt < task.updatedAt)) return "完成未读";
  return "";
}
export function messageKeyAction(event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat">, composing: boolean, confirmation: boolean): "ignore" | "newline" | "submit" | "consume" {
  if (event.key !== "Enter" || event.isComposing || composing || event.keyCode === 229) return "ignore";
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || confirmation) return "newline";
  return event.repeat ? "consume" : "submit";
}
export class ScopedOperations {
  readonly running = new Map<string, string>();
  readonly errors = new Map<string, { label: string; message: string; retry: () => Promise<unknown> }>();
  async run(key: string, label: string, fn: () => Promise<unknown>, changed: () => void): Promise<boolean> {
    if (this.running.has(key)) return false;
    this.running.set(key, label); this.errors.delete(key); changed();
    try { await fn(); return true; }
    catch (error) { this.errors.set(key, { label, message: error instanceof Error ? error.message : String(error), retry: fn }); return false; }
    finally { this.running.delete(key); changed(); }
  }
}
