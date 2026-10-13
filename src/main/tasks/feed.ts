import type { BrowserTask, TaskDetailUpdate, TaskListMetadata, TaskListSnapshot, TaskListUpdate, TaskStream, TaskSummary, TaskTokenRecord } from "../../shared/tasks";
import { summarizeTask } from "../../shared/task-feed";

/** A feed revision represents a published transaction, not a renderer read. */
export class TaskListFeed {
  private revision = 0;
  private summaries = new Map<string, TaskSummary>();
  private metadata: TaskListMetadata;
  private tokenSources = new Map<string, TaskTokenRecord>();
  constructor(private read: () => { tasks: BrowserTask[]; metadata: TaskListMetadata }) {
    const initial = read();
    for (const task of initial.tasks) this.summaries.set(task.id, summarizeTask(task));
    this.metadata = structuredClone(initial.metadata);
    for (const record of initial.metadata.tokenRecords || []) this.tokenSources.set(record.taskId, record);
  }
  update(changes: ReadonlySet<string>): TaskListUpdate | undefined {
    const state = this.read(), ids = new Set(state.tasks.map(task => task.id));
    const removed = [...this.summaries.keys()].filter(id => !ids.has(id));
    for (const id of removed) this.summaries.delete(id);
    const tasks = state.tasks.filter(task => changes.has(task.id) || !this.summaries.has(task.id)).map(summarizeTask);
    for (const task of tasks) this.summaries.set(task.id, task);
    const metadata: Partial<TaskListMetadata> = {};
    for (const key of new Set([...Object.keys(state.metadata), ...Object.keys(this.metadata)]) as Set<keyof TaskListMetadata>) {
      if (key === "tokenRecords") continue;
      if (JSON.stringify(state.metadata[key]) !== JSON.stringify(this.metadata[key])) {
        Object.assign(metadata, { [key]: structuredClone(state.metadata[key]) });
      }
    }
    Object.assign(this.metadata, metadata);
    const records = new Map((this.metadata.tokenRecords || []).map(record => [record.taskId, record]));
    const recordIds = new Set<string>(), updated: TaskTokenRecord[] = [];
    for (const record of state.metadata.tokenRecords || []) {
      recordIds.add(record.taskId);
      if (changes.has(record.taskId) || this.tokenSources.get(record.taskId) !== record) {
        if (JSON.stringify(records.get(record.taskId)) !== JSON.stringify(record)) {
          const value = structuredClone(record); updated.push(value); records.set(record.taskId, value);
        }
        this.tokenSources.set(record.taskId, record);
      }
    }
    const removedRecords = [...records.keys()].filter(id => !recordIds.has(id));
    for (const id of removedRecords) { records.delete(id); this.tokenSources.delete(id); }
    const tokenRecords = updated.length || removedRecords.length ? { updated, removed: removedRecords } : undefined;
    if (tokenRecords) this.metadata.tokenRecords = [...records.values()];
    if (!tasks.length && !removed.length && !Object.keys(metadata).length && !tokenRecords) return;
    return { revision: ++this.revision, tasks, removed, metadata, ...(tokenRecords ? { tokenRecords } : {}) };
  }
  snapshot(): TaskListSnapshot {
    const order = this.read().tasks;
    return structuredClone({ ...this.metadata, tasks: order.map(task => this.summaries.get(task.id)!).filter(Boolean), revision: this.revision });
  }
}

/** One cursor per desktop window. Switching tasks releases the previous history. */
export class TaskDetailCursor {
  private previous?: BrowserTask;
  private version = 0;
  get taskId(): string | undefined { return this.previous?.id; }
  read(task: BrowserTask, version?: number, stream?: TaskStream): TaskDetailUpdate {
    const previous = this.previous, next = structuredClone(task), nextVersion = ++this.version;
    this.previous = next;
    if (!previous || previous.id !== task.id || version !== nextVersion - 1) {
      return { id: task.id, version: nextVersion, task: structuredClone(next), stream };
    }
    const fields: Partial<BrowserTask> = {}, removed: Array<keyof BrowserTask> = [], arrays: TaskDetailUpdate["arrays"] = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof BrowserTask>) {
      if (!(key in next)) { removed.push(key); continue; }
      const before = previous[key], after = next[key];
      if (Array.isArray(before) && Array.isArray(after)) {
        let from = 0;
        while (from < before.length && from < after.length && JSON.stringify(before[from]) === JSON.stringify(after[from])) from++;
        if (from !== before.length || from !== after.length) arrays[key] = { from, values: after.slice(from) };
      } else if (JSON.stringify(before) !== JSON.stringify(after)) Object.assign(fields, { [key]: after });
    }
    return { id: task.id, version: nextVersion, baseVersion: version, fields, removed, arrays, stream };
  }
}
