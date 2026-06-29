import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AccountSyncRecord,
  NativeProfileMetadata,
  StoredMigratedExtension,
  StoredProfile
} from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";

export const execFileAsync = promisify(execFile);

// ps 的 lstart 等列会跟随系统语言输出（中文环境下是“四  6/11 17:13:50 2026”），
// 而解析逻辑依赖英文格式，所以调用 ps 时统一强制 POSIX locale。
export const POSIX_LOCALE_ENV: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
export const APP_DATA_DIR_NAME = "ProfilePilot";
export const LEGACY_APP_DATA_DIR_NAME = "Codex Chrome Profile Manager";

export function defaultDataDir(): string {
  const preferred = appDataDir(APP_DATA_DIR_NAME);
  const legacy = appDataDir(LEGACY_APP_DATA_DIR_NAME);
  if (existsSync(path.join(legacy, "profiles.json"))) {
    return legacy;
  }

  return preferred;
}

export function appDataDir(name: string): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", name);
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), name);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), makeSlug(name));
}

export function makeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "profile";
}

export function normalizeProfileName(nameInput: string): string {
  const name = String(nameInput || "").trim();
  if (!name || name.length > 80) {
    throw new ProfileManagerError("Profile 名称长度必须是 1-80 个字符。", "INVALID_PROFILE_NAME");
  }

  return name;
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isProcessGoneError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function normalizeProfile(profile: unknown): StoredProfile | null {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const candidate = profile as Partial<StoredProfile>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.dirName !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    dirName: candidate.dirName,
    createdAt: candidate.createdAt,
    lastLaunchedAt: typeof candidate.lastLaunchedAt === "string" ? candidate.lastLaunchedAt : null,
    lastCdpPort:
      typeof candidate.lastCdpPort === "number" && Number.isInteger(candidate.lastCdpPort)
        ? candidate.lastCdpPort
        : null,
    fixedCdpPort:
      typeof candidate.fixedCdpPort === "number" && Number.isInteger(candidate.fixedCdpPort)
        ? candidate.fixedCdpPort
        : null,
    clonedFromProfileId:
      typeof candidate.clonedFromProfileId === "string" && candidate.clonedFromProfileId
        ? candidate.clonedFromProfileId
        : null,
    projectTag:
      typeof candidate.projectTag === "string" && candidate.projectTag.trim() ? candidate.projectTag.trim() : null,
    migratedExtensions: Array.isArray(candidate.migratedExtensions)
      ? candidate.migratedExtensions
          .map(normalizeStoredMigratedExtension)
          .filter((item): item is StoredMigratedExtension => Boolean(item))
      : []
  };
}

export function normalizeStoredMigratedExtension(extension: unknown): StoredMigratedExtension | null {
  if (!extension || typeof extension !== "object") {
    return null;
  }

  const candidate = extension as Partial<StoredMigratedExtension>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sourceProfileId !== "string" ||
    typeof candidate.sourceExtensionId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.migratedAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    sourceProfileId: candidate.sourceProfileId,
    sourceExtensionId: candidate.sourceExtensionId,
    name: candidate.name,
    version: candidate.version,
    path: candidate.path,
    migratedAt: candidate.migratedAt,
    includeData: Boolean(candidate.includeData)
  };
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  if (value === undefined) {
    return "undefined";
  }

  return JSON.stringify(value) ?? "null";
}

export function getNestedValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value;
  for (const pathPart of pathParts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, pathPart)) {
      return undefined;
    }
    current = current[pathPart];
  }

  return current;
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function moveStringToFront(values: string[], item: string): string[] {
  return uniqueStrings([item, ...values.filter((value) => value !== item)]);
}

export function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function makePathSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function isSameFilesystemPath(pathA: string, pathB: string): Promise<boolean> {
  const [resolvedA, resolvedB] = await Promise.all([
    resolveComparablePath(pathA),
    resolveComparablePath(pathB)
  ]);
  return resolvedA === resolvedB;
}

export async function resolveComparablePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function shouldCopyLocalExtensionPackagePath(sourceRootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(sourceRootPath, candidatePath);
  return !relativePath.split(path.sep).includes(".git");
}

export async function getAvailableDiskBytes(targetPath: string): Promise<number> {
  const probePath = await nearestExistingPath(targetPath);
  try {
    const stats = (await fs.statfs(probePath)) as { bavail: number | bigint; bsize: number | bigint };
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProfileManagerError(`无法读取目标磁盘可用空间：${reason}`, "DISK_SPACE_CHECK_FAILED");
  }
}

export async function nearestExistingPath(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

export function normalizeSafeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    !normalized ||
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new ProfileManagerError("路径不安全，已停止操作。", "UNSAFE_PATH");
  }

  return normalized;
}

export function chromeProfileDirName(userDataPath: string, profilePath: string): string {
  const relativePath = path.relative(userDataPath, profilePath);
  if (!relativePath || relativePath === "." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return "Default";
  }

  return relativePath.split(path.sep).filter(Boolean)[0] || "Default";
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function normalizeNativeProfileMetadata(input: Record<string, unknown>): Record<string, NativeProfileMetadata> {
  return Object.fromEntries(
    Object.entries(input).map(([dirName, value]) => {
      const metadata = value && typeof value === "object" ? (value as Partial<NativeProfileMetadata>) : {};
      return [
        dirName,
        {
          lastLaunchedAt: typeof metadata.lastLaunchedAt === "string" ? metadata.lastLaunchedAt : null,
          name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null
        }
      ];
    })
  );
}

export function normalizeAccountSyncRecords(input: Record<string, unknown>): Record<string, AccountSyncRecord> {
  return Object.fromEntries(
    Object.entries(input)
      .map(([targetProfileId, value]) => {
        const record = value && typeof value === "object" ? (value as Partial<AccountSyncRecord>) : null;
        if (
          !record ||
          typeof record.sourceProfileId !== "string" ||
          typeof record.targetProfileId !== "string" ||
          typeof record.syncedAt !== "string"
        ) {
          return null;
        }

        const sourceFingerprints = normalizeAccountSyncSourceFingerprints(record.sourceFingerprints);
        return [
          targetProfileId,
          {
            sourceProfileId: record.sourceProfileId,
            targetProfileId: record.targetProfileId,
            syncedAt: record.syncedAt,
            copiedCount: typeof record.copiedCount === "number" ? record.copiedCount : 0,
            skippedCount: typeof record.skippedCount === "number" ? record.skippedCount : 0,
            launchedTarget: Boolean(record.launchedTarget),
            ...(sourceFingerprints ? { sourceFingerprints } : {})
          }
        ] as const;
      })
      .filter((entry): entry is readonly [string, AccountSyncRecord] => Boolean(entry))
  );
}

export function normalizeAccountSyncSourceFingerprints(input: unknown): Record<string, string | null> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .map(([relativePath, fingerprint]) => {
      if (typeof fingerprint === "string" || fingerprint === null) {
        return [relativePath, fingerprint] as const;
      }
      return null;
    })
    .filter((entry): entry is readonly [string, string | null] => Boolean(entry));

  return entries.length ? Object.fromEntries(entries) : undefined;
}

// ---- 从 Chrome 数据（Local State / Preferences）读入的路径片段是不可信的，
// 必须防 ../、绝对路径等导致读/写/删到 Chrome 数据目录之外。 ----

export function isSafePathSegment(value: string): boolean {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

// 把一个相对路径解析到 base 内；若是绝对路径或会逃出 base，返回 null。
export function resolveWithinBase(base: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) {
    return null;
  }
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, relative);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

export function compareNumbers(a: number, b: number): number {
  return a - b;
}

export function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

export function earlierIsoDate(current: string | null, next: string | null): string | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return Date.parse(next) < Date.parse(current) ? next : current;
}
