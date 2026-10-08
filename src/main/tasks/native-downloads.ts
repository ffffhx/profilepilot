import { constants } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { BrowserTask, TaskAttachment } from "../../shared/tasks";

export interface NativeDownloadItem {
  id: number; filename: string; state: "in_progress" | "complete" | "interrupted";
  url?: string; finalUrl?: string; error?: string; exists?: boolean; bytesReceived?: number; totalBytes?: number;
}
export interface NativeDownloadInput {
  operation?: "start" | "wait" | "search" | "cancel";
  url?: string; ref?: string; filename?: string; id?: number; token?: string; timeoutMs?: number;
}
export function portableDownloadName(filename: string): string {
  // Chrome reports native paths. basename(win32) also recognizes backslashes
  // when a receipt is inspected on macOS; POSIX basename alone does not.
  const name = path.win32.basename(path.posix.basename(filename)).normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  let safe = !name || name === "." || name === ".." ? "download.bin" : name;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  while (Buffer.byteLength(safe, "utf8") > 180) safe = Array.from(safe).slice(0, -1).join("");
  return safe;
}
export function taskArtifactDirectory(root: string, taskId: string): string {
  const base = path.resolve(root), target = path.resolve(base, taskId), relative = path.relative(base, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("无效的任务产物目录。");
  return target;
}

// Wait requests deliberately run outside the action queue so they can be
// cancelled. Coalesce only registration of the same completed download, not
// the network wait or unrelated downloads, and release failed entries too.
const registrations = new WeakMap<BrowserTask, Map<string, { signature: string; result: Promise<TaskAttachment> }>>();

/** Register only a browser-confirmed ID and exact filename; never enumerate a
 * user's Downloads folder. Keep the Chrome original and a task-owned copy. */
export async function registerNativeDownload(root: string, task: BrowserTask, item: NativeDownloadItem): Promise<TaskAttachment> {
  if (!Number.isSafeInteger(item.id) || item.id < 0) throw new Error("Chrome 返回的下载 ID 无效。");
  if (item.state === "interrupted") throw new Error(`下载 ${item.id} 已中断：${item.error || "Chrome 未提供原因"}`);
  if (item.state !== "complete") throw new Error(`下载 ${item.id} 尚未完成，不能登记文件。`);
  if (!item.filename || !path.isAbsolute(item.filename) || item.exists === false) throw new Error(`下载 ${item.id} 没有可读取的已保存文件。`);
  const key = JSON.stringify([path.resolve(root), task.id, task.profileId, task.sessionId, item.id]);
  const signature = JSON.stringify([path.resolve(item.filename), item.bytesReceived]);
  let pending = registrations.get(task);
  const existing = pending?.get(key);
  if (existing) {
    if (existing.signature !== signature) throw new Error(`下载 ${item.id} 的并发登记信息不一致，请核查后继续。`);
    return existing.result;
  }
  if (!pending) { pending = new Map(); registrations.set(task, pending); }
  const entries = pending;
  const result = copyCompletedDownload(root, task, item).finally(() => {
    entries.delete(key);
    if (!entries.size) registrations.delete(task);
  });
  entries.set(key, { signature, result });
  return result;
}

async function copyCompletedDownload(root: string, task: BrowserTask, item: NativeDownloadItem): Promise<TaskAttachment> {
  const source = await realpath(item.filename);
  const before = await stat(source);
  if (!before.isFile() || (typeof item.bytesReceived === "number" && item.bytesReceived >= 0 && before.size !== item.bytesReceived)) throw new Error(`下载 ${item.id} 的文件类型或落盘大小不匹配。`);
  const id = `download-${createHash("sha256").update(`${task.profileId}\0${task.sessionId}\0${item.id}`).digest("hex").slice(0, 24)}`;
  const existing = task.outputs?.find(file => file.id === id);
  if (existing) { if ((await stat(existing.path)).size !== existing.size) throw new Error("已登记的下载文件已发生变化。"); return existing; }
  const directory = path.join(taskArtifactDirectory(root, task.id), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = portableDownloadName(item.filename), destination = path.join(directory, name);
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; throw new Error(`下载 ${item.id} 的产物路径已存在但未登记，请核查文件后继续。`); }
  const [after, saved] = await Promise.all([stat(source), stat(destination)]);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || saved.size !== after.size) throw new Error(`下载 ${item.id} 的文件在登记期间发生变化，未登记产物。`);
  const output = { id, name, path: destination, size: saved.size };
  (task.outputs ||= []).push(output);
  return output;
}
