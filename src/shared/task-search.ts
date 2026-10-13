import type { BrowserTask, TaskSearchHit } from "./tasks";

export type SearchHit = TaskSearchHit;
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
