import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TaskSnapshot } from "../../shared/tasks";
import type { StoredTask } from "./sdk-history";

interface TaskReference { id: string; record: string; }
type TaskMetadata = Omit<TaskSnapshot, "tasks">;
export type StoredTaskSnapshot = TaskMetadata & { version: number; tasks: StoredTask[] };
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function atomicWrite(file: string, text: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600); created = true;
    writeFileSync(descriptor, text, "utf8"); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    // Never remove the committed file as a Windows rename fallback.
    renameSync(temporary, file); created = false;
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* preserve original error */ }
    if (created) try { unlinkSync(temporary); } catch { /* retry can replace an uncommitted file */ }
  }
}

/** Immutable task records, committed together by one atomic manifest replacement.
 * A small task update serializes that task and the index, never unrelated histories. */
export class TaskRecords {
  readonly file: string;
  private readonly directory: string;
  private references = new Map<string, TaskReference>();
  private savedIndex?: string;
  private legacyVersion?: number;
  private protectedRecords = new Set<string>();

  constructor(readonly root: string) {
    this.file = path.join(root, "tasks.json");
    this.directory = path.join(root, "task-records");
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      if (!/^tasks\.json\.before-pricing-\d+\.bak$/.test(name)) continue;
      const backup = JSON.parse(readFileSync(path.join(root, name), "utf8"));
      if (backup.version === 3 && Array.isArray(backup.tasks)) {
        for (const reference of backup.tasks) if (typeof reference?.record === "string") this.protectedRecords.add(reference.record);
      }
    }
  }

  backup(suffix: string): void {
    writeFileSync(`${this.file}${suffix}`, readFileSync(this.file), { mode: 0o600, flag: "wx" });
    for (const reference of this.references.values()) this.protectedRecords.add(reference.record);
  }

  read(): StoredTaskSnapshot | undefined {
    for (let attempt = 0; ; attempt++) {
      if (!existsSync(this.file)) return undefined;
      const text = readFileSync(this.file, "utf8");
      try { return this.readIndex(text); }
      catch (error) {
        // A reader can have the old index while a writer retires its records.
        // Retry only if the committed index actually changed; preserve corruption.
        if (attempt < 2 && existsSync(this.file) && readFileSync(this.file, "utf8") !== text) continue;
        throw error;
      }
    }
  }

  private readIndex(text: string): StoredTaskSnapshot {
    const parsed = JSON.parse(text);
    if (![1, 2, 3].includes(parsed.version) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.materials) || !Array.isArray(parsed.attachments) || !Array.isArray(parsed.schedules)) {
      throw new Error("任务数据格式不正确，已保留原文件，请检查任务存储。");
    }
    if (parsed.version !== 3) { this.legacyVersion = parsed.version; return parsed; }
    const references = new Map<string, TaskReference>();
    const tasks = parsed.tasks.map((reference: TaskReference) => {
      if (!reference || typeof reference.id !== "string" || !/^[\w-]+$/.test(reference.id) || typeof reference.record !== "string" ||
        !reference.record.startsWith(`${reference.id}.`) || !/^[\w-]+\.[a-f0-9]{64}\.json$/.test(reference.record) || references.has(reference.id)) {
        throw new Error("任务记录索引损坏，已保留原文件。");
      }
      const bytes = readFileSync(path.join(this.directory, reference.record), "utf8");
      if (`${reference.id}.${digest(bytes)}.json` !== reference.record) throw new Error("任务记录校验失败，已保留原文件。");
      const task = JSON.parse(bytes) as StoredTask;
      if (task.id !== reference.id) throw new Error("任务记录编号与索引不一致。");
      references.set(reference.id, reference);
      return task;
    });
    this.references = references; this.savedIndex = digest(text);
    return { ...parsed, tasks };
  }

  write(metadata: TaskMetadata, order: string[], changes: StoredTask[]): void {
    const references = new Map(this.references);
    const pending: Array<{ file: string; text: string }> = [];
    for (const task of changes) {
      if (typeof task.id !== "string" || !/^[\w-]+$/.test(task.id)) throw new Error("任务编号格式不正确。");
      const text = JSON.stringify(task), record = `${task.id}.${digest(text)}.json`;
      references.set(task.id, { id: task.id, record });
      if (this.references.get(task.id)?.record !== record || !existsSync(path.join(this.directory, record))) {
        pending.push({ file: path.join(this.directory, record), text });
      }
    }
    const tasks = order.map(id => {
      const reference = references.get(id);
      if (!reference) throw new Error(`任务 ${id} 尚未保存，必须把新增任务包含在本次变更中。`);
      return reference;
    });
    if (new Set(order).size !== order.length) throw new Error("任务编号重复，未保存变更。");
    // Serialize before touching disk so serialization failures cannot publish a partial change.
    const text = JSON.stringify({ ...metadata, tasks, version: 3 }), indexDigest = digest(text);
    if (indexDigest === this.savedIndex && !pending.length && existsSync(this.file)) return;
    if (this.legacyVersion !== undefined) {
      const backup = `${this.file}.before-records.v${this.legacyVersion}.bak`;
      if (!existsSync(backup)) writeFileSync(backup, readFileSync(this.file), { mode: 0o600, flag: "wx" });
    }
    if (pending.length) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    try {
      for (const record of pending) { atomicWrite(record.file, record.text); written.push(record.file); }
      atomicWrite(this.file, text);
    } catch (error) {
      const committed = new Set([...this.references.values()].map(ref => path.join(this.directory, ref.record)));
      for (const file of written) if (!committed.has(file)) try { unlinkSync(file); } catch { /* unreferenced record is harmless */ }
      throw error;
    }
    const previous = this.references;
    this.references = new Map(tasks.map(ref => [ref.id, ref]));
    this.savedIndex = indexDigest; this.legacyVersion = undefined;
    // Only obsolete records from the previous committed index are eligible for deletion.
    for (const reference of previous.values()) {
      if (this.references.get(reference.id)?.record === reference.record || this.protectedRecords.has(reference.record)) continue;
      try { unlinkSync(path.join(this.directory, reference.record)); } catch { /* a later cleanup may retry */ }
    }
  }
}
