import type { BrowserTask, TaskApi, TaskListSnapshot, TaskListUpdate, TaskStream } from "../shared/tasks";
import { applyTaskDetailUpdate, applyTaskListUpdate } from "../shared/task-feed";

/** Retains one selected conversation; list state is independent of its history. */
export class TaskData {
  list?: TaskListSnapshot;
  detail?: { task: BrowserTask; version: number };
  stream?: TaskStream;
  error = "";
  private selected = "";
  private generation = 0;
  private dirty = false;
  private loading?: Promise<void>;
  private loadingList?: Promise<void>;
  private waiting: TaskListUpdate[] = [];
  private unsubscribe: Array<() => void>;
  constructor(private api: Pick<TaskApi, "list" | "detail" | "onChanged" | "onStream">, private changed: (kind: "list" | "detail" | "stream" | "error") => void) {
    this.unsubscribe = [api.onChanged(update => {
      if (!this.list || this.loadingList) { this.waiting.push(update); return; }
      const next = applyTaskListUpdate(this.list, update);
      if (!next) { this.waiting.push(update); void this.refresh().catch(() => {}); return; }
      if (next === this.list) return;
      this.list = next;
      if (update.removed.includes(this.selected)) { this.select(""); }
      else if (update.tasks.some(task => task.id === this.selected)) void this.refreshDetail().catch(() => {});
      this.changed("list");
    })];
    if (api.onStream) this.unsubscribe.push(api.onStream(update => {
      if (update.taskId !== this.selected || this.detail?.task.events.some(event => event.streamId === update.stream.id)) return;
      this.setStream(update.stream); this.changed("stream");
    }));
  }
  get(id: string): BrowserTask | undefined { return this.detail?.task.id === id ? this.detail.task : undefined; }
  select(id: string): void {
    if (id === this.selected) return;
    this.selected = id; this.generation++; this.detail = undefined; this.stream = undefined; this.error = "";
    if (id) void this.refreshDetail().catch(() => {});
  }
  async refresh(): Promise<void> {
    if (this.loadingList) return this.loadingList;
    this.loadingList = (async () => {
      try {
        // Events arriving during invoke are replayed against the response revision.
        for (;;) {
          let snapshot: TaskListSnapshot | undefined = await this.api.list();
          const waiting = this.waiting; this.waiting = [];
          for (const update of waiting) { snapshot = snapshot && applyTaskListUpdate(snapshot, update); if (!snapshot) break; }
          if (!snapshot) continue;
          this.list = snapshot; this.error = "";
          if (this.selected && !snapshot.tasks.some(task => task.id === this.selected)) this.select("");
          this.changed("list"); break;
        }
      } catch (error) { this.error = String(error); this.changed("error"); throw error; }
    })();
    try { await this.loadingList; } finally { this.loadingList = undefined; }
    await this.refreshDetail();
  }
  private setStream(stream?: TaskStream): void {
    if (stream && (!this.stream || stream.updatedAt >= this.stream.updatedAt)) this.stream = stream;
    if (this.stream && this.detail?.task.events.some(event => event.streamId === this.stream!.id)) this.stream = undefined;
  }
  async refreshDetail(): Promise<void> {
    if (!this.selected) return;
    this.dirty = true;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      while (this.dirty && this.selected) {
        this.dirty = false;
        const id = this.selected, generation = this.generation;
        try {
          const update = await this.api.detail(id, this.detail?.version);
          if (generation !== this.generation) { this.dirty = !!this.selected; continue; }
          const detail = applyTaskDetailUpdate(this.detail, update);
          if (!detail) { this.detail = undefined; this.dirty = true; continue; }
          this.detail = detail; this.setStream(update.stream); this.error = ""; this.changed("detail");
        } catch (error) {
          if (generation !== this.generation) { this.dirty = !!this.selected; continue; }
          this.error = String(error); this.changed("error"); throw error;
        }
      }
    })();
    try { await this.loading; } finally { this.loading = undefined; }
  }
  dispose(): void { this.generation++; this.selected = ""; for (const unsubscribe of this.unsubscribe) unsubscribe(); }
}
