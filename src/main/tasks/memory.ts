import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { ProfileMemoryFile } from "../../shared/tasks";

export interface MemoryAccess { directory: string; writable: boolean; }
const MAX_BYTES = 256 * 1024;
const revision = (text: string): string => createHash("sha256").update(text).digest("hex");
const validName = (name: string): boolean => /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,100}\.md$/iu.test(name)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);

/** SDK-owned Markdown, shared by stable Profile ID rather than task/session ID.
 * Reject symlinks/junctions and multiply-linked files on Windows and macOS. */
export class ProfileMemory {
  constructor(private readonly root: string) {}
  directory(profileId: string): string {
    if (!profileId || profileId.length > 200) throw new Error("无效的 Profile。");
    const base = path.join(this.root, "memory");
    const directory = path.join(base, revision(profileId));
    for (const entry of [base, directory]) {
      if (!existsSync(entry)) mkdirSync(entry, { mode: 0o700 });
      const info = lstatSync(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("记忆目录不能是软链接或目录联接。");
    }
    return realpathSync(directory);
  }
  private file(profileId: string, name: string): string {
    if (!validName(name)) throw new Error("记忆文件必须是当前目录中的 Markdown 文件，不能包含路径或系统保留名称。");
    const file = path.join(this.directory(profileId), name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("记忆文件不能是链接或特殊文件。");
      if (info.size > MAX_BYTES) throw new Error("单个记忆文件不能超过 256 KB。");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return file;
  }
  authorize(profileId: string, candidate: string, tool: string, writable: boolean, input: Record<string, unknown> = {}): boolean {
    try {
      if (!["Read", "Write", "Edit"].includes(tool) || tool !== "Read" && !writable || !path.isAbsolute(candidate)) return false;
      const directory = this.directory(profileId);
      const name = path.relative(directory, path.resolve(candidate));
      const file = this.file(profileId, name);
      if (tool === "Write") return typeof input.content === "string" && Buffer.byteLength(input.content, "utf8") <= MAX_BYTES;
      if (!existsSync(file)) return false;
      if (tool === "Edit") {
        const { old_string: before, new_string: after } = input;
        if (typeof before !== "string" || !before || typeof after !== "string") return false;
        const content = readFileSync(file, "utf8");
        const matches = input.replace_all ? content.split(before).length - 1 : Number(content.includes(before));
        if (Buffer.byteLength(content, "utf8") + matches * (Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8")) > MAX_BYTES) return false;
      }
      return true;
    } catch { return false; }
  }
  list(profileId: string): ProfileMemoryFile[] {
    return readdirSync(this.directory(profileId)).filter(validName).sort((a, b) => a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)).map(name => {
      const file = this.file(profileId, name), content = readFileSync(file, "utf8");
      return { name, content, revision: revision(content), updatedAt: lstatSync(file).mtime.toISOString() };
    });
  }
  private checkRevision(file: string, expected: string | null): void {
    const actual = existsSync(file) ? revision(readFileSync(file, "utf8")) : null;
    if (actual !== expected) throw new Error("记忆已被其他窗口或任务修改，请刷新后再编辑。");
  }
  write(profileId: string, name: string, content: string, expected: string | null): void {
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("单个记忆文件不能超过 256 KB。");
    const file = this.file(profileId, name);
    this.checkRevision(file, expected);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, content, "utf8"); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  delete(profileId: string, name: string, expected: string): void {
    const file = this.file(profileId, name);
    this.checkRevision(file, expected);
    // Remove the topic's index entry first; an interruption leaves an unindexed
    // topic instead of an index that recalls a file the user already deleted.
    if (name !== "MEMORY.md") {
      const index = this.list(profileId).find(file => file.name === "MEMORY.md");
      if (index) {
        const retained = index.content.split(/\r?\n/).filter(line => !line.includes(`](${name})`) && !line.includes(`](./${name})`) && !line.includes(`](${encodeURIComponent(name)})`)).join("\n");
        if (retained !== index.content) this.write(profileId, index.name, retained, index.revision);
      }
    }
    unlinkSync(file);
  }
}
