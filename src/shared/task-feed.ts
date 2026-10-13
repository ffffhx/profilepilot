import type { BrowserTask, TaskDetailUpdate, TaskListSnapshot, TaskListUpdate, TaskSummary } from "./tasks";

export function summarizeTask(task: BrowserTask): TaskSummary {
  const { id, title, profileId, profileName, status, createdAt, updatedAt, pinnedAt, archivedAt, metadataUpdatedAt, port, browserConnection } = task;
  return { id, title, profileId, profileName, status, createdAt, updatedAt, pinnedAt, archivedAt, metadataUpdatedAt, port, browserConnection,
    ...(task.pending ? { pending: { kind: task.pending.kind } } : {}) };
}

/** Undefined means an event was missed; reload the small list before continuing. */
export function applyTaskListUpdate(current: TaskListSnapshot, update: TaskListUpdate): TaskListSnapshot | undefined {
  if (update.revision <= current.revision) return current;
  if (update.revision !== current.revision + 1) return;
  const changed = new Map(update.tasks.map(task => [task.id, task]));
  const removed = new Set(update.removed);
  const tasks = current.tasks.filter(task => !removed.has(task.id)).map(task => {
    const next = changed.get(task.id); changed.delete(task.id); return next || task;
  });
  tasks.unshift(...changed.values());
  const next = { ...current, ...update.metadata, tasks, revision: update.revision };
  if (update.tokenRecords) {
    const records = new Map((current.tokenRecords || []).map(record => [record.taskId, record]));
    for (const id of update.tokenRecords.removed) records.delete(id);
    for (const record of update.tokenRecords.updated) records.set(record.taskId, record);
    next.tokenRecords = [...records.values()];
  }
  return next;
}

export function applyTaskDetailUpdate(current: { task: BrowserTask; version: number } | undefined, update: TaskDetailUpdate): { task: BrowserTask; version: number } | undefined {
  if (update.task) return { task: update.task, version: update.version };
  if (!current || current.task.id !== update.id || current.version !== update.baseVersion) return;
  const task = { ...current.task, ...update.fields };
  for (const key of update.removed || []) delete (task as unknown as Record<string, unknown>)[key];
  for (const [key, patch] of Object.entries(update.arrays || {})) {
    const previous = (current.task as unknown as Record<string, unknown>)[key];
    if (!patch || !Array.isArray(previous) || patch.from > previous.length) return;
    (task as unknown as Record<string, unknown>)[key] = [...previous.slice(0, patch.from), ...patch.values];
  }
  return { task, version: update.version };
}
