import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { BrowserTask, TaskEvent } from "../../shared/tasks";

/** Read-only references into SDK-owned transcripts. Never append private record
 * types to these files. Titles are written through the SDK's renameSession API. */
export interface SdkValueRef {
  file: string;
  uuid: string;
  path: Array<string | number>;
  digest: string;
  format?: "prompt" | "assistant" | "skill";
}
type SharedField = "prompt" | "materials" | "attachments" | "outputs" | "skill";
export type StoredTask = Omit<BrowserTask, "events"> & {
  events: Array<Omit<TaskEvent, "text"> & { text?: string; sdkText?: SdkValueRef }>;
  sdkFields?: Partial<Record<SharedField, SdkValueRef>>;
  sdkTitle?: string;
};
export interface SdkPromptState { state: Record<string, unknown>; throughEventId?: string; }
interface Transcript {
  file: string; session: string; size: number; mtime: number;
  rows: Map<string, { offset: number; length: number }>;
  values: Map<string, SdkValueRef>; events: Map<string, SdkValueRef>;
  assistants: Map<string, SdkValueRef[]>;
  title?: string; prompt?: SdkPromptState;
  durable?: boolean;
}
const fields: Record<SharedField, string> = { prompt: "goal", materials: "materials", attachments: "attachments", outputs: "outputs", skill: "selectedSkill" };
const skillSnapshot = (value: any): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { adapter, ...snapshot } = value;
  return snapshot;
};
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("") : "";
const promptOf = (record: any): Record<string, any> | undefined => {
  if (record.type !== "user" || record.isSidechain) return;
  try {
    const value = JSON.parse(textOf(record.message?.content));
    if (value && typeof value === "object" && (value._profilepilot?.version === 1 ||
      typeof value.goal === "string" && Array.isArray(value.recentHistory) && "authorization" in value)) return value;
  } catch { /* Ordinary user/tool messages are not product context snapshots. */ }
};

/** Only indexes completed JSONL records. Message bodies remain in the SDK files;
 * the in-memory index stores byte offsets, digests and the latest input state.
 * Discovery uses actual directory entries (including Windows long-path hashes),
 * never a guessed encoding of cwd. */
export class SdkTaskHistory {
  private files = new Map<string, Transcript>();
  constructor(readonly directory: string) {}
  refresh(): void {
    const projects = path.join(this.directory, "projects");
    const present = new Set<string>();
    if (existsSync(projects)) for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const entry of readdirSync(path.join(projects, project.name), { withFileTypes: true })) {
        if (!entry.isFile() || !/^[\w-]+\.jsonl$/.test(entry.name)) continue;
        const key = `${project.name}/${entry.name}`, file = path.join(projects, project.name, entry.name);
        present.add(key);
        const stat = statSync(file), previous = this.files.get(key);
        if (previous && previous.size === stat.size && previous.mtime === stat.mtimeMs) continue;
        // Bound reads to the size observed above; a concurrently appended record
        // is picked up on the next refresh instead of partially acknowledged.
        const bytes = Buffer.alloc(stat.size), fd = openSync(file, "r");
        let read = 0;
        try { while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n; } }
        finally { closeSync(fd); }
        const index: Transcript = { file, session: entry.name.slice(0, -6), size: stat.size, mtime: stat.mtimeMs,
          rows: new Map(), values: new Map(), events: new Map(), assistants: new Map() };
        let offset = 0;
        while (offset < read) {
          const end = bytes.indexOf(10, offset);
          if (end < 0 || end >= read) break;
          try {
            const record = JSON.parse(bytes.toString("utf8", offset, end));
            if (record.sessionId && record.sessionId !== index.session) { offset = end + 1; continue; }
            if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) index.title = record.customTitle;
            // Compaction may summarize away previously supplied product fields.
            // Keep the delivery cursor, but resend current state on continuation.
            if (record.type === "system" && record.subtype === "compact_boundary" && index.prompt) index.prompt.state = {};
            if (typeof record.uuid === "string" && !record.isSidechain) {
              index.rows.set(record.uuid, { offset, length: end - offset });
              this.indexRecord(index, key, record);
            }
          } catch { /* Unknown or incomplete records never replace local data. */ }
          offset = end + 1;
        }
        this.files.set(key, index);
      }
    }
    for (const key of this.files.keys()) if (!present.has(key)) this.files.delete(key);
  }
  private indexRecord(index: Transcript, file: string, record: any): void {
    const reference = (value: unknown, at: SdkValueRef["path"], format?: SdkValueRef["format"]): SdkValueRef =>
      ({ file, uuid: record.uuid, path: at, digest: digest(value), ...(format ? { format } : {}) });
    const input = promptOf(record);
    if (input) {
      for (const [field, key] of Object.entries(fields)) if (input[key] !== undefined) {
        const value = field === "skill" ? skillSnapshot(input[key]) : input[key];
        index.values.set(`${field}:${digest(value)}`, reference(value, [key], field === "skill" ? "skill" : "prompt"));
      }
      for (const list of ["recentHistory", "inputEvents"]) if (Array.isArray(input[list])) input[list].forEach((event: any, i: number) => {
        if (typeof event.id === "string" && typeof event.text === "string" && ["user", "assistant"].includes(event.kind))
          index.events.set(`${event.id}:${digest(event.text)}`, reference(event.text, [list, i, "text"], "prompt"));
      });
      const { _profilepilot, recentHistory, inputEvents, conversationSummary, currentRequest, instruction, ...state } = input;
      index.prompt = { state: _profilepilot?.mode === "resume" ? { ...index.prompt?.state, ...state } : state,
        throughEventId: _profilepilot?.throughEventId || recentHistory?.at(-1)?.id };
    }
    if (record.type === "assistant" && typeof record.message?.id === "string") {
      const value = textOf(record.message.content);
      if (value) {
        const list = index.assistants.get(record.message.id) || [];
        list.push(reference(value, [], "assistant")); index.assistants.set(record.message.id, list);
      }
    }
  }
  private session(id: string): Transcript | undefined {
    const matches = [...this.files.values()].filter(file => file.session === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  hasSession(id: string): boolean { return Boolean(this.session(id)?.prompt); }
  title(id: string): string | undefined { return this.session(id)?.title; }
  context(id: string): SdkPromptState | undefined { return this.session(id)?.prompt; }
  private durable(index: Transcript): boolean {
    if (index.durable) return true;
    // Do not replace our synced task data with references to SDK bytes that
    // only exist in OS write buffers. Flush without modifying their content.
    let fd: number | undefined;
    try { fd = openSync(index.file, "r+"); fsyncSync(fd); index.durable = true; return true; }
    catch { return false; } // Read-only/locked logs keep their local fallback.
    finally { if (fd !== undefined) closeSync(fd); }
  }
  read(ref: SdkValueRef): unknown {
    const file = this.files.get(ref.file), row = file?.rows.get(ref.uuid);
    if (!file || !row) throw new Error("SDK 会话记录缺失，已保留任务索引；请恢复对应的 sessions 目录后重试。");
    const bytes = Buffer.alloc(row.length), fd = openSync(file.file, "r");
    let length: number;
    try { length = readSync(fd, bytes, 0, row.length, row.offset); } finally { closeSync(fd); }
    if (length !== row.length) throw new Error("SDK 会话记录尚未完整写入，任务索引保持不变。");
    const record = JSON.parse(bytes.toString("utf8"));
    let value: any = ref.format === "prompt" || ref.format === "skill" ? promptOf(record) : ref.format === "assistant" ? textOf(record.message?.content) : record;
    for (const key of ref.path) value = value?.[key];
    if (ref.format === "skill") value = skillSnapshot(value);
    if (value === undefined || digest(value) !== ref.digest) throw new Error("SDK 会话记录与任务引用不一致，已保留原始数据。");
    return value;
  }
  hydrate(stored: StoredTask): BrowserTask {
    const task = { ...stored, events: stored.events.map(event => {
      const { sdkText, ...rest } = event;
      return { ...rest, text: sdkText ? this.read(sdkText) as string : event.text || "" };
    }) } as BrowserTask;
    for (const [field, ref] of Object.entries(stored.sdkFields || {})) (task as any)[field] = this.read(ref);
    if (stored.sdkTitle) {
      const title = this.title(stored.sdkTitle);
      if (!title) throw new Error("SDK 会话标题记录缺失，任务索引保持不变。");
      task.title = title;
    }
    delete (task as any).sdkFields; delete (task as any).sdkTitle;
    return task;
  }
  dehydrate(task: BrowserTask): StoredTask {
    const indexes = [...this.files.values()].filter(index => this.durable(index));
    if (!indexes.length) return task;
    const stored: StoredTask = { ...task, events: task.events.map(event => ({ ...event })) };
    for (const field of Object.keys(fields) as SharedField[]) if (task[field] !== undefined) {
      const key = `${field}:${digest(task[field])}`;
      const ref = indexes.map(index => index.values.get(key)).find(Boolean);
      if (ref) { (stored.sdkFields ||= {})[field] = ref; delete (stored as any)[field]; }
    }
    if (task.sdkSessionId && indexes.some(index => index.session === task.sdkSessionId) && this.title(task.sdkSessionId) === task.title) { stored.sdkTitle = task.sdkSessionId; delete (stored as any).title; }
    for (let i = 0; i < task.events.length; i++) {
      const event = task.events[i];
      if (!["user", "assistant"].includes(event.kind)) continue;
      let ref = indexes.map(index => index.events.get(`${event.id}:${digest(event.text)}`)).find(Boolean);
      if (!ref && event.kind === "assistant" && event.streamId) {
        for (const index of indexes) for (const [id, values] of index.assistants) {
          if (event.streamId === id || event.streamId.startsWith(`${id}:`)) ref ||= values.find(value => value.digest === digest(event.text));
        }
      }
      // Redacted/truncated/partial messages differ from their SDK record and
      // stay local. Never restore unredacted content by approximate matching.
      if (ref) { stored.events[i].sdkText = ref; delete stored.events[i].text; }
    }
    return stored;
  }
}
