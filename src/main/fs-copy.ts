import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  OperationPauseSignal
} from "../shared/types";
import { CopyStats } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export async function copyPath(
  sourcePath: string,
  targetPath: string,
  options: { shouldCopy?: (sourcePath: string) => boolean } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await copyPathWithProgress(sourcePath, targetPath, options.shouldCopy || (() => true), () => undefined);
}

export async function collectCopyStats(
  sourcePath: string,
  shouldCopy: (source: string) => boolean,
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal
): Promise<CopyStats> {
  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  if (!shouldCopy(sourcePath)) {
    return { files: 0, bytes: 0 };
  }

  const stat = await fs.lstat(sourcePath);
  if (!isCopyableFilesystemEntry(stat)) {
    return { files: 0, bytes: 0 };
  }

  if (stat.isDirectory()) {
    const children = await fs.readdir(sourcePath);
    const childStats = await Promise.all(
      children.map((child) => collectCopyStats(path.join(sourcePath, child), shouldCopy, abortSignal, pauseSignal))
    );
    return childStats.reduce(
      (total, item) => ({
        files: total.files + item.files,
        bytes: total.bytes + item.bytes
      }),
      { files: 0, bytes: 0 }
    );
  }

  return {
    files: 1,
    bytes: stat.isFile() ? stat.size : 0
  };
}

export async function copyPathWithProgress(
  sourcePath: string,
  targetPath: string,
  shouldCopy: (source: string) => boolean,
  onFileCopied: (bytes: number) => void,
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal
): Promise<void> {
  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  if (!shouldCopy(sourcePath)) {
    return;
  }

  const stat = await fs.lstat(sourcePath);
  if (!isCopyableFilesystemEntry(stat)) {
    return;
  }

  if (stat.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    const children = await fs.readdir(sourcePath);
    for (const child of children) {
      await waitIfPaused(pauseSignal, abortSignal);
      await copyPathWithProgress(
        path.join(sourcePath, child),
        path.join(targetPath, child),
        shouldCopy,
        onFileCopied,
        abortSignal,
        pauseSignal
      );
    }
    await preserveTimestamps(targetPath, stat);
    return;
  }

  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  await fs.copyFile(sourcePath, targetPath);
  await preserveTimestamps(targetPath, stat);
  onFileCopied(stat.isFile() ? stat.size : 0);
}

// 不复制符号链接：避免把指向 profile 之外（如 /etc/hosts）的链接传播到隔离 profile，
// 破坏隔离。profile 数据中符号链接极罕见，跳过是安全的。
export function isCopyableFilesystemEntry(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isDirectory() || stat.isFile();
}

export async function preserveTimestamps(targetPath: string, stat: Awaited<ReturnType<typeof fs.lstat>>): Promise<void> {
  try {
    await fs.utimes(targetPath, stat.atime, stat.mtime);
  } catch {
    // Some filesystems reject timestamp preservation for special entries; copied data is still usable.
  }
}

export function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new ProfileManagerError(
      "已终止同步。已完成替换的数据会保留，未完成的临时数据会在下次同步前恢复或清理，重新同步会继续覆盖补齐。",
      "OPERATION_CANCELLED"
    );
  }
}

export async function waitIfPaused(pauseSignal?: OperationPauseSignal, abortSignal?: AbortSignal): Promise<void> {
  throwIfAborted(abortSignal);
  if (!pauseSignal?.paused) {
    return;
  }

  await pauseSignal.waitIfPaused();
  throwIfAborted(abortSignal);
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0 秒";
  }
  if (durationMs < 1000) {
    return "不足 1 秒";
  }

  const totalSeconds = Math.ceil(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

export function formatCopyRemainingTime(progress: {
  copiedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  elapsedMs: number;
}): string {
  const total = progress.totalBytes > 0 ? progress.totalBytes : progress.totalFiles;
  const copied = progress.totalBytes > 0 ? progress.copiedBytes : progress.copiedFiles;

  if (total <= 0 || copied <= 0 || progress.elapsedMs < 1000) {
    return "计算中";
  }

  const remaining = Math.max(0, total - copied);
  if (remaining === 0) {
    return "0 秒";
  }

  const ratePerMs = copied / progress.elapsedMs;
  if (!Number.isFinite(ratePerMs) || ratePerMs <= 0) {
    return "计算中";
  }

  return formatDuration(remaining / ratePerMs);
}
