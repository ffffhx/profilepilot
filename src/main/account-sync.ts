import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  AccountSyncDiffItem,
  AccountSyncDiffResult,
  AccountSyncRecord,
  OperationPauseSignal
} from "../shared/types";
import { collectCopyStats, copyPathWithProgress, formatByteSize, formatCopyRemainingTime, formatDuration, preserveTimestamps, throwIfAborted, waitIfPaused } from "./fs-copy";
import { cloneJsonValue, exists, getAvailableDiskBytes, isRecord, moveStringToFront, normalizeSafeRelativePath, readJsonFile, stableJsonStringify, stringArrayValue, uniqueStrings, writeJsonFileAtomic } from "./fs-util";
import { ACCOUNT_SYNC_DISK_SPACE_BUFFER_RATIO, ACCOUNT_SYNC_DISK_SPACE_MAX_BUFFER_BYTES, ACCOUNT_SYNC_DISK_SPACE_MIN_BUFFER_BYTES, ACCOUNT_SYNC_PARTIAL_SUFFIX, ACCOUNT_SYNC_PREFERENCE_FILES, ACCOUNT_SYNC_PREVIOUS_SUFFIX, ACCOUNT_SYNC_WORK_PREFIX, AccountSyncCopyPlan, AccountSyncDataLocation, AccountSyncExtensionPreferencesSnapshot, AccountSyncPathSpec, ChromeLocalState, CopyStats, JsonPropertySnapshot } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export async function inspectAccountSyncPathDiff(
  sourceLocation: AccountSyncDataLocation,
  targetLocation: AccountSyncDataLocation,
  spec: AccountSyncPathSpec
): Promise<AccountSyncDiffItem> {
  const sourcePath = path.join(sourceLocation.profilePath, spec.relativePath);
  const targetPath = path.join(targetLocation.profilePath, normalizeSafeRelativePath(spec.relativePath));
  const [sourceFingerprint, targetFingerprint] = await Promise.all([
    pathMetadataFingerprint(sourcePath, isAccountSyncComparablePath),
    pathMetadataFingerprint(targetPath, isAccountSyncComparablePath)
  ]);

  if (!sourceFingerprint) {
    return accountSyncDiffItem(spec.label, spec.relativePath, "source_missing");
  }
  if (!targetFingerprint) {
    return accountSyncDiffItem(spec.label, spec.relativePath, "target_missing");
  }

  return accountSyncDiffItem(spec.label, spec.relativePath, sourceFingerprint === targetFingerprint ? "same" : "changed");
}

export async function inspectAccountLocalStateDiff(
  sourceLocation: AccountSyncDataLocation,
  targetLocation: AccountSyncDataLocation
): Promise<AccountSyncDiffItem> {
  const sourceLocalStatePath = path.join(sourceLocation.userDataPath, "Local State");
  const targetLocalStatePath = path.join(targetLocation.userDataPath, "Local State");
  const sourceLocalState = await readJsonFile<ChromeLocalState>(sourceLocalStatePath);
  if (!sourceLocalState) {
    return accountSyncDiffItem("浏览器账号状态", "Local State", "source_missing");
  }

  const sourceInfo = localStateProfileInfo(sourceLocalState, sourceLocation.profileDirName);
  if (!sourceInfo) {
    return accountSyncDiffItem("浏览器账号状态", "Local State", "source_missing");
  }

  const targetExists = await exists(targetLocalStatePath);
  const targetLocalState = (await readJsonFile<ChromeLocalState>(targetLocalStatePath)) || {};
  const targetProfile = targetLocalState.profile;
  const targetInfoCache = isRecord(targetProfile?.info_cache) ? targetProfile.info_cache : {};
  const targetInfo = isRecord(targetInfoCache[targetLocation.profileDirName])
    ? (targetInfoCache[targetLocation.profileDirName] as Record<string, unknown>)
    : {};
  if (!hasAccountLocalStateValues(sourceInfo) && !hasAccountLocalStateValues(targetInfo)) {
    return accountSyncDiffItem("浏览器账号状态", "Local State", "source_missing");
  }

  const simulatedTarget = cloneJsonValue(targetLocalState) as ChromeLocalState;
  const simulatedProfile = ensureLocalStateProfile(simulatedTarget);
  const simulatedInfoCache = ensureLocalStateInfoCache(simulatedProfile);
  const existingTargetInfo = isRecord(simulatedInfoCache[targetLocation.profileDirName])
    ? simulatedInfoCache[targetLocation.profileDirName]
    : {};
  simulatedInfoCache[targetLocation.profileDirName] = mergeLocalStateProfileAccountInfo(sourceInfo, existingTargetInfo);
  simulatedProfile.last_used = targetLocation.profileDirName;
  simulatedProfile.last_active_profiles = moveStringToFront(
    stringArrayValue(simulatedProfile.last_active_profiles),
    targetLocation.profileDirName
  );
  simulatedProfile.profiles_order = moveStringToFront(
    uniqueStrings([...stringArrayValue(simulatedProfile.profiles_order), ...Object.keys(simulatedInfoCache)]),
    targetLocation.profileDirName
  );

  if (stableJsonStringify(simulatedTarget) === stableJsonStringify(targetLocalState)) {
    return accountSyncDiffItem("浏览器账号状态", "Local State", "same");
  }

  return accountSyncDiffItem("浏览器账号状态", "Local State", targetExists ? "changed" : "target_missing");
}

export function accountSyncDiffItem(
  label: string,
  relativePath: string,
  status: AccountSyncDiffItem["status"]
): AccountSyncDiffItem {
  return {
    label,
    relativePath,
    status,
    reason: accountSyncDiffReason(status)
  };
}

export function accountSyncDiffReason(status: AccountSyncDiffItem["status"]): string {
  switch (status) {
    case "changed":
      return "源和目标不同，本次会同步";
    case "same":
      return "已一致，本次无需同步";
    case "target_missing":
      return "目标缺少，本次会同步";
    case "source_missing":
    default:
      return "源 Profile 中没有生成，本次无需同步";
  }
}

export function summarizeAccountSyncDiff(items: AccountSyncDiffItem[]): AccountSyncDiffResult["summary"] {
  const changedCount = items.filter((item) => item.status === "changed").length;
  const targetMissingCount = items.filter((item) => item.status === "target_missing").length;
  return {
    changedCount,
    sameCount: items.filter((item) => item.status === "same").length,
    sourceMissingCount: items.filter((item) => item.status === "source_missing").length,
    targetMissingCount,
    syncableCount: changedCount + targetMissingCount
  };
}

export async function applyAccountSyncRecordBaseline(
  items: AccountSyncDiffItem[],
  sourceLocation: AccountSyncDataLocation,
  record: AccountSyncRecord
): Promise<AccountSyncDiffItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.status !== "changed") {
        return item;
      }

      const currentFingerprint = await accountSyncSourceFingerprint(sourceLocation, item.relativePath);
      const recordedFingerprint = record.sourceFingerprints?.[item.relativePath];
      if (recordedFingerprint !== undefined) {
        if (currentFingerprint === recordedFingerprint) {
          return accountSyncBaselineSameItem(item);
        }
        return item;
      }

      if (!(await accountSyncSourcePathChangedAfterRecord(sourceLocation, item.relativePath, record))) {
        return accountSyncBaselineSameItem(item);
      }

      return item;
    })
  );
}

export function accountSyncBaselineSameItem(item: AccountSyncDiffItem): AccountSyncDiffItem {
  return {
    ...item,
    status: "same",
    reason: "上次同步后源 Profile 没有新变化，本次无需同步"
  };
}

export function shouldApplyAccountDiffItem(item: AccountSyncDiffItem | null, onlyChanged: boolean): boolean {
  if (!item || item.status === "source_missing") {
    return false;
  }

  return !onlyChanged || item.status !== "same";
}

export function hasAccountLocalStateValues(info: Record<string, unknown>): boolean {
  return Object.keys(info).some(isAccountLocalStateProfileInfoKey);
}

export async function pathMetadataFingerprint(
  filePath: string,
  shouldInclude: (candidatePath: string) => boolean = () => true
): Promise<string | null> {
  if (!(await exists(filePath)) || !shouldInclude(filePath)) {
    return null;
  }

  const hash = createHash("sha256");
  await appendPathMetadataFingerprint(hash, filePath, filePath, shouldInclude);
  return hash.digest("hex");
}

export async function appendPathMetadataFingerprint(
  hash: ReturnType<typeof createHash>,
  rootPath: string,
  filePath: string,
  shouldInclude: (candidatePath: string) => boolean
): Promise<void> {
  if (!shouldInclude(filePath)) {
    return;
  }

  const stat = await fs.lstat(filePath);
  const relativePath = path.relative(rootPath, filePath) || ".";
  if (stat.isDirectory()) {
    hash.update(`dir:${relativePath}\n`);
    const children = (await fs.readdir(filePath)).sort((a, b) => a.localeCompare(b));
    for (const child of children) {
      await appendPathMetadataFingerprint(hash, rootPath, path.join(filePath, child), shouldInclude);
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(filePath);
    hash.update(`symlink:${relativePath}:${linkTarget}\n`);
    return;
  }

  hash.update(`file:${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
}

export async function snapshotAccountSyncSourceFingerprints(
  sourceLocation: AccountSyncDataLocation
): Promise<Record<string, string | null>> {
  const relativePaths = uniqueStrings([...accountSyncCopySpecs().map((spec) => spec.relativePath), "Local State"]);
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => [relativePath, await accountSyncSourceFingerprint(sourceLocation, relativePath)] as const)
  );

  return Object.fromEntries(entries);
}

export async function accountSyncSourceFingerprint(
  sourceLocation: AccountSyncDataLocation,
  relativePath: string
): Promise<string | null> {
  return pathMetadataFingerprint(accountSyncSourcePath(sourceLocation, relativePath), isAccountSyncComparablePath);
}

export async function accountSyncSourcePathChangedAfterRecord(
  sourceLocation: AccountSyncDataLocation,
  relativePath: string,
  record: AccountSyncRecord
): Promise<boolean> {
  const recordTime = Date.parse(record.syncedAt);
  if (!Number.isFinite(recordTime)) {
    return true;
  }

  const latestMtime = await latestPathMtimeMs(accountSyncSourcePath(sourceLocation, relativePath), isAccountSyncComparablePath);
  return latestMtime === null || latestMtime > recordTime + 1000;
}

export function accountSyncSourcePath(sourceLocation: AccountSyncDataLocation, relativePath: string): string {
  if (relativePath === "Local State") {
    return path.join(sourceLocation.userDataPath, "Local State");
  }

  return path.join(sourceLocation.profilePath, normalizeSafeRelativePath(relativePath));
}

export async function latestPathMtimeMs(
  filePath: string,
  shouldInclude: (candidatePath: string) => boolean = () => true
): Promise<number | null> {
  if (!(await exists(filePath)) || !shouldInclude(filePath)) {
    return null;
  }

  const stat = await fs.lstat(filePath);
  let latest = stat.mtimeMs;
  if (!stat.isDirectory()) {
    return latest;
  }

  const children = await fs.readdir(filePath);
  for (const child of children) {
    const childMtime = await latestPathMtimeMs(path.join(filePath, child), shouldInclude);
    if (childMtime !== null && childMtime > latest) {
      latest = childMtime;
    }
  }

  return latest;
}

export function isAccountSyncComparablePath(candidatePath: string): boolean {
  const name = path.basename(candidatePath);
  return name !== "LOCK" && !isAccountSyncWorkArtifactName(name);
}

export function accountSyncCopySpecs(): AccountSyncPathSpec[] {
  return [
    { label: "Google Profile Picture", relativePath: "Google Profile Picture.png" },
    { label: "书签", relativePath: "Bookmarks" },
    { label: "书签备份", relativePath: "Bookmarks.bak" },
    { label: "历史记录和下载记录", relativePath: "History" },
    { label: "历史记录和下载记录 journal", relativePath: "History-journal" },
    { label: "历史记录和下载记录 WAL", relativePath: "History-wal" },
    { label: "历史记录和下载记录 SHM", relativePath: "History-shm" },
    { label: "下载服务数据", relativePath: "Download Service" },
    { label: "浏览器设置和主题", relativePath: "Preferences" },
    { label: "受保护浏览器设置", relativePath: "Secure Preferences" },
    { label: "快捷方式", relativePath: "Shortcuts" },
    { label: "快捷方式 journal", relativePath: "Shortcuts-journal" },
    { label: "快捷方式 WAL", relativePath: "Shortcuts-wal" },
    { label: "快捷方式 SHM", relativePath: "Shortcuts-shm" },
    { label: "常用网站", relativePath: "Top Sites" },
    { label: "常用网站 journal", relativePath: "Top Sites-journal" },
    { label: "常用网站 WAL", relativePath: "Top Sites-wal" },
    { label: "常用网站 SHM", relativePath: "Top Sites-shm" },
    { label: "网站图标", relativePath: "Favicons" },
    { label: "网站图标 journal", relativePath: "Favicons-journal" },
    { label: "网站图标 WAL", relativePath: "Favicons-wal" },
    { label: "网站图标 SHM", relativePath: "Favicons-shm" },
    { label: "Cookies", relativePath: "Cookies" },
    { label: "Cookies journal", relativePath: "Cookies-journal" },
    { label: "Cookies WAL", relativePath: "Cookies-wal" },
    { label: "Cookies SHM", relativePath: "Cookies-shm" },
    { label: "Network Cookies", relativePath: path.join("Network", "Cookies") },
    { label: "Network Cookies journal", relativePath: path.join("Network", "Cookies-journal") },
    { label: "Network Cookies WAL", relativePath: path.join("Network", "Cookies-wal") },
    { label: "Network Cookies SHM", relativePath: path.join("Network", "Cookies-shm") },
    { label: "Local Storage", relativePath: "Local Storage" },
    { label: "Session Storage", relativePath: "Session Storage" },
    { label: "IndexedDB", relativePath: "IndexedDB" },
    { label: "Storage", relativePath: "Storage" },
    { label: "File System", relativePath: "File System" },
    { label: "Service Worker", relativePath: "Service Worker" },
    { label: "WebStorage", relativePath: "WebStorage" },
    { label: "Databases", relativePath: "databases" },
    { label: "Web Data", relativePath: "Web Data" },
    { label: "Web Data journal", relativePath: "Web Data-journal" },
    { label: "Account Web Data", relativePath: "Account Web Data" },
    { label: "Account Web Data journal", relativePath: "Account Web Data-journal" },
    { label: "Accounts", relativePath: "Accounts" },
    { label: "Sync Data", relativePath: "Sync Data" },
    { label: "Sync App Settings", relativePath: "Sync App Settings" },
    { label: "Trusted Vault", relativePath: "trusted_vault.pb" },
    { label: "Trust Tokens", relativePath: "Trust Tokens" },
    { label: "Trust Tokens journal", relativePath: "Trust Tokens-journal" },
    { label: "DIPS", relativePath: "DIPS" },
    { label: "DIPS WAL", relativePath: "DIPS-wal" },
    { label: "DIPS SHM", relativePath: "DIPS-shm" },
    { label: "SharedStorage", relativePath: "SharedStorage" },
    { label: "SharedStorage WAL", relativePath: "SharedStorage-wal" },
    { label: "SharedStorage SHM", relativePath: "SharedStorage-shm" },
    { label: "GCM Store", relativePath: "GCM Store" },
    { label: "Network Persistent State", relativePath: "Network Persistent State" },
    { label: "Transport Security", relativePath: "TransportSecurity" }
  ];
}

export async function existingAccountSyncSpecs(profilePath: string): Promise<AccountSyncPathSpec[]> {
  const specs = accountSyncCopySpecs();
  const existing = await Promise.all(
    specs.map(async (spec): Promise<AccountSyncPathSpec | null> => ((await exists(path.join(profilePath, spec.relativePath))) ? spec : null))
  );

  return existing.filter((spec): spec is AccountSyncPathSpec => Boolean(spec));
}

export async function accountSyncDataScore(profilePath: string): Promise<number> {
  const markers = [
    "Preferences",
    "Cookies",
    path.join("Network", "Cookies"),
    "Local Storage",
    "Account Web Data",
    "Accounts",
    "Sync Data"
  ];
  const existing = await Promise.all(markers.map((marker) => exists(path.join(profilePath, marker))));
  return existing.filter(Boolean).length;
}

export async function mergeAccountLocalStateValues(
  sourceLocation: AccountSyncDataLocation,
  targetLocation: AccountSyncDataLocation
): Promise<boolean> {
  const sourceLocalStatePath = path.join(sourceLocation.userDataPath, "Local State");
  const targetLocalStatePath = path.join(targetLocation.userDataPath, "Local State");
  const sourceLocalState = await readJsonFile<ChromeLocalState>(sourceLocalStatePath);
  if (!sourceLocalState) {
    return false;
  }

  const sourceInfo = localStateProfileInfo(sourceLocalState, sourceLocation.profileDirName);
  if (!sourceInfo) {
    return false;
  }

  const targetLocalState = (await readJsonFile<ChromeLocalState>(targetLocalStatePath)) || {};
  const before = JSON.stringify(targetLocalState);
  const targetProfile = ensureLocalStateProfile(targetLocalState);
  const targetInfoCache = ensureLocalStateInfoCache(targetProfile);
  const targetDirName = targetLocation.profileDirName;
  const existingTargetInfo = isRecord(targetInfoCache[targetDirName]) ? targetInfoCache[targetDirName] : {};

  targetInfoCache[targetDirName] = mergeLocalStateProfileAccountInfo(sourceInfo, existingTargetInfo);
  targetProfile.last_used = targetDirName;
  targetProfile.last_active_profiles = moveStringToFront(stringArrayValue(targetProfile.last_active_profiles), targetDirName);
  targetProfile.profiles_order = moveStringToFront(
    uniqueStrings([...stringArrayValue(targetProfile.profiles_order), ...Object.keys(targetInfoCache)]),
    targetDirName
  );

  if (JSON.stringify(targetLocalState) === before) {
    return false;
  }

  await writeJsonFileAtomic(targetLocalStatePath, targetLocalState);
  return true;
}

export function localStateProfileInfo(localState: ChromeLocalState, dirName: string): Record<string, unknown> | null {
  const infoCache = localState.profile?.info_cache;
  if (!isRecord(infoCache)) {
    return null;
  }

  const directInfo = infoCache[dirName];
  if (isRecord(directInfo)) {
    return directInfo;
  }

  const defaultInfo = infoCache.Default;
  return isRecord(defaultInfo) ? defaultInfo : null;
}

export function ensureLocalStateProfile(localState: ChromeLocalState): NonNullable<ChromeLocalState["profile"]> {
  if (!isRecord(localState.profile)) {
    localState.profile = {};
  }

  return localState.profile;
}

export function ensureLocalStateInfoCache(
  profile: NonNullable<ChromeLocalState["profile"]>
): NonNullable<NonNullable<ChromeLocalState["profile"]>["info_cache"]> {
  if (!isRecord(profile.info_cache)) {
    profile.info_cache = {};
  }

  return profile.info_cache;
}

export function mergeLocalStateProfileAccountInfo(
  sourceInfo: Record<string, unknown>,
  targetInfo: Record<string, unknown>
): Record<string, unknown> {
  const next = cloneJsonValue(targetInfo) as Record<string, unknown>;

  for (const key of Object.keys(next)) {
    if (isAccountLocalStateProfileInfoKey(key) && !Object.prototype.hasOwnProperty.call(sourceInfo, key)) {
      delete next[key];
    }
  }

  for (const [key, value] of Object.entries(sourceInfo)) {
    if (isAccountLocalStateProfileInfoKey(key)) {
      next[key] = cloneJsonValue(value);
    }
  }

  return next;
}

export function isAccountLocalStateProfileInfoKey(key: string): boolean {
  return (
    [
      "account_id",
      "account_name",
      "avatar_icon",
      "enterprise_label",
      "force_signin_profile_locked",
      "hosted_domain",
      "is_consented_primary_account",
      "is_managed",
      "is_using_default_avatar",
      "is_using_default_name",
      "managed_user_id",
      "name",
      "user_accepted_account_management",
      "user_name"
    ].includes(key) ||
    key.startsWith("gaia_") ||
    key.startsWith("signin.") ||
    key.startsWith("last_downloaded_gaia_picture_url")
  );
}

export async function snapshotAccountSyncExtensionPreferences(
  profilePath: string
): Promise<AccountSyncExtensionPreferencesSnapshot> {
  const entries = await Promise.all(
    ACCOUNT_SYNC_PREFERENCE_FILES.map(async (fileName) => {
      const preferences = (await readJsonFile<Record<string, unknown>>(path.join(profilePath, fileName))) || {};
      return [
        fileName,
        {
          extensions: snapshotJsonProperty(preferences, ["extensions"]),
          protectedExtensions: snapshotJsonProperty(preferences, ["protection", "macs", "extensions"])
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries) as AccountSyncExtensionPreferencesSnapshot;
}

export async function restoreAccountSyncExtensionPreferences(
  profilePath: string,
  snapshot: AccountSyncExtensionPreferencesSnapshot
): Promise<boolean> {
  let changedAny = false;

  for (const fileName of ACCOUNT_SYNC_PREFERENCE_FILES) {
    const filePath = path.join(profilePath, fileName);
    const preferences = await readJsonFile<Record<string, unknown>>(filePath);
    if (!preferences) {
      continue;
    }

    const before = JSON.stringify(preferences);
    restoreJsonProperty(preferences, ["extensions"], snapshot[fileName].extensions);
    restoreJsonProperty(preferences, ["protection", "macs", "extensions"], snapshot[fileName].protectedExtensions);

    if (JSON.stringify(preferences) !== before) {
      await writeJsonFileAtomic(filePath, preferences);
      changedAny = true;
    }
  }

  return changedAny;
}

export function snapshotJsonProperty(root: Record<string, unknown>, pathParts: string[]): JsonPropertySnapshot {
  const parent = getJsonPropertyParent(root, pathParts, false);
  const key = pathParts[pathParts.length - 1];
  if (!parent || !(key in parent)) {
    return { exists: false, value: null };
  }

  return { exists: true, value: cloneJsonValue(parent[key]) };
}

export function restoreJsonProperty(
  root: Record<string, unknown>,
  pathParts: string[],
  snapshot: JsonPropertySnapshot
): void {
  const key = pathParts[pathParts.length - 1];
  if (snapshot.exists) {
    const parent = getJsonPropertyParent(root, pathParts, true);
    if (parent) {
      parent[key] = cloneJsonValue(snapshot.value);
    }
    return;
  }

  const parent = getJsonPropertyParent(root, pathParts, false);
  if (parent && key in parent) {
    delete parent[key];
  }
}

export function getJsonPropertyParent(
  root: Record<string, unknown>,
  pathParts: string[],
  create: boolean
): Record<string, unknown> | null {
  let current: Record<string, unknown> = root;

  for (const pathPart of pathParts.slice(0, -1)) {
    const next = current[pathPart];
    if (isRecord(next)) {
      current = next;
      continue;
    }

    if (!create) {
      return null;
    }

    const created: Record<string, unknown> = {};
    current[pathPart] = created;
    current = created;
  }

  return current;
}

export function shouldCopyAccountSyncPathEntry(sourceRootPath: string, candidatePath: string): boolean {
  const name = path.basename(candidatePath);
  if (name === "LOCK" || isAccountSyncWorkArtifactName(name)) {
    return false;
  }

  const rootName = path.basename(sourceRootPath);
  const relativePath = path.relative(sourceRootPath, candidatePath);
  const firstPart = relativePath.split(path.sep).find(Boolean) || "";
  return !isAccountSyncExtensionStoreEntry(rootName, firstPart);
}

export function isAccountSyncExtensionStoreEntry(rootName: string, firstPart: string): boolean {
  return (
    Boolean(firstPart) &&
    ["IndexedDB", "File System", "databases"].includes(rootName) &&
    firstPart.startsWith("chrome-extension_")
  );
}

export async function collectAccountSyncPathStats(
  sourcePath: string,
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal
): Promise<CopyStats> {
  const shouldCopy = (source: string): boolean => shouldCopyAccountSyncPathEntry(sourcePath, source);
  return collectCopyStats(sourcePath, shouldCopy, abortSignal, pauseSignal);
}

export async function assertAccountSyncDiskSpace(
  targetProfilePath: string,
  copyPlans: AccountSyncCopyPlan[],
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal
): Promise<void> {
  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  const plannedStats = sumAccountSyncCopyPlanStats(copyPlans);
  if (plannedStats.bytes <= 0) {
    return;
  }

  const safetyBytes = accountSyncDiskSpaceBufferBytes(plannedStats.bytes);
  const requiredBytes = plannedStats.bytes + safetyBytes;
  const availableBytes = await getAvailableDiskBytes(targetProfilePath);
  if (availableBytes >= requiredBytes) {
    return;
  }

  const largestItems = copyPlans
    .filter((plan) => plan.stats.bytes > 0)
    .sort((a, b) => b.stats.bytes - a.stats.bytes)
    .slice(0, 3)
    .map((plan) => `${plan.spec.label} ${formatByteSize(plan.stats.bytes)}`)
    .join("、");
  const largestDetail = largestItems ? `最大项目：${largestItems}。` : "";
  throw new ProfileManagerError(
    `磁盘空间不足，已停止账号同步，尚未开始复制数据。预计至少需要 ${formatByteSize(requiredBytes)}（待复制 ${formatByteSize(plannedStats.bytes)} + 安全余量 ${formatByteSize(safetyBytes)}），当前可用 ${formatByteSize(availableBytes)}。${largestDetail}请先释放空间，或清理源 Profile 的缓存/Service Worker 后重试。`,
    "INSUFFICIENT_DISK_SPACE"
  );
}

export function sumAccountSyncCopyPlanStats(copyPlans: AccountSyncCopyPlan[]): CopyStats {
  return copyPlans.reduce(
    (total, plan) => ({
      files: total.files + plan.stats.files,
      bytes: total.bytes + plan.stats.bytes
    }),
    { files: 0, bytes: 0 }
  );
}

export function accountSyncDiskSpaceBufferBytes(plannedBytes: number): number {
  if (!Number.isFinite(plannedBytes) || plannedBytes <= 0) {
    return 0;
  }

  const proportionalBuffer = Math.ceil(plannedBytes * ACCOUNT_SYNC_DISK_SPACE_BUFFER_RATIO);
  const minimumBuffer = Math.min(ACCOUNT_SYNC_DISK_SPACE_MIN_BUFFER_BYTES, plannedBytes);
  return Math.min(
    ACCOUNT_SYNC_DISK_SPACE_MAX_BUFFER_BYTES,
    Math.max(minimumBuffer, proportionalBuffer)
  );
}

export async function copyAccountSyncPath(
  sourcePath: string,
  targetPath: string,
  onProgress?: (detail: string) => void,
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal,
  precomputedStats?: CopyStats
): Promise<void> {
  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await recoverInterruptedAccountSyncPath(targetPath);
  const shouldCopy = (source: string): boolean => shouldCopyAccountSyncPathEntry(sourcePath, source);
  onProgress?.(precomputedStats ? "正在准备复制" : "正在统计文件");
  const stats = precomputedStats || (await collectCopyStats(sourcePath, shouldCopy, abortSignal, pauseSignal));
  const stagingPath = makeAccountSyncWorkPath(targetPath, ACCOUNT_SYNC_PARTIAL_SUFFIX);
  if (!stats.files) {
    throwIfAborted(abortSignal);
    await waitIfPaused(pauseSignal, abortSignal);
    const sourceStat = await fs.lstat(sourcePath);
    if (sourceStat.isDirectory()) {
      await fs.rm(stagingPath, { recursive: true, force: true });
      await fs.mkdir(stagingPath, { recursive: true });
      await preserveTimestamps(stagingPath, sourceStat);
      await replacePathWithStagedCopy(stagingPath, targetPath);
    }
    onProgress?.("没有需要复制的文件");
    return;
  }

  let copiedFiles = 0;
  let copiedBytes = 0;
  let lastReportAt = 0;
  const copyStartedAt = Date.now();
  const reportCopied = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastReportAt < 250 && copiedFiles < stats.files) {
      return;
    }
    lastReportAt = now;
    onProgress?.(
      `已复制 ${copiedFiles}/${stats.files} 个文件，${formatByteSize(copiedBytes)}/${formatByteSize(stats.bytes)} · 已用 ${formatDuration(now - copyStartedAt)} · 本项预计剩余 ${formatCopyRemainingTime({
        copiedFiles,
        totalFiles: stats.files,
        copiedBytes,
        totalBytes: stats.bytes,
        elapsedMs: now - copyStartedAt
      })}`
    );
  };

  reportCopied(true);
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    await copyPathWithProgress(
      sourcePath,
      stagingPath,
      shouldCopy,
      (bytes) => {
        copiedFiles += 1;
        copiedBytes += bytes;
        reportCopied();
      },
      abortSignal,
      pauseSignal
    );
    throwIfAborted(abortSignal);
    await waitIfPaused(pauseSignal, abortSignal);
    onProgress?.("正在替换目标数据");
    await replacePathWithStagedCopy(stagingPath, targetPath);
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  reportCopied(true);
}

export async function recoverInterruptedAccountSyncArtifactsForProfile(profilePath: string): Promise<void> {
  for (const spec of accountSyncCopySpecs()) {
    await recoverInterruptedAccountSyncPath(path.join(profilePath, normalizeSafeRelativePath(spec.relativePath)));
  }
}

export async function recoverInterruptedAccountSyncPath(targetPath: string): Promise<void> {
  const parentPath = path.dirname(targetPath);
  const entries = await fs.readdir(parentPath).catch(() => []);
  if (!entries.length) {
    return;
  }

  const prefix = accountSyncWorkPrefixForTarget(targetPath);
  const partialPaths = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(ACCOUNT_SYNC_PARTIAL_SUFFIX))
    .map((entry) => path.join(parentPath, entry));
  const previousPaths = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(ACCOUNT_SYNC_PREVIOUS_SUFFIX))
    .sort()
    .map((entry) => path.join(parentPath, entry));

  await Promise.all(partialPaths.map((partialPath) => fs.rm(partialPath, { recursive: true, force: true })));

  if (!previousPaths.length) {
    return;
  }

  if (!(await exists(targetPath)) && previousPaths.length) {
    // 取出最新一份备份用于恢复；无论成功失败，它都不再进入下面的“清理更旧备份”列表。
    const latestPreviousPath = previousPaths.pop() as string;
    try {
      await fs.rename(latestPreviousPath, targetPath);
    } catch {
      // 恢复失败：保留这份最新备份（不删，下次启动再试），但仍继续清理更旧的备份，避免无限堆积。
      console.warn(
        `[profilepilot] 恢复备份 ${latestPreviousPath} 到 ${targetPath} 失败，已保留待下次重试。`
      );
    }
  }

  // 清理剩余（更旧的）备份，避免 .previous 文件随多次中断无限堆积。
  await Promise.all(previousPaths.map((previousPath) => fs.rm(previousPath, { recursive: true, force: true })));
}

export async function replacePathWithStagedCopy(stagingPath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const previousPath = makeAccountSyncWorkPath(targetPath, ACCOUNT_SYNC_PREVIOUS_SUFFIX);
  const targetExists = await exists(targetPath);
  if (targetExists) {
    await fs.rm(previousPath, { recursive: true, force: true });
    await fs.rename(targetPath, previousPath);
  }

  try {
    await fs.rename(stagingPath, targetPath);
  } catch (error) {
    // staging→target 失败：尽力把刚移走的旧数据从 previous 恢复回 target。
    if (targetExists && !(await exists(targetPath)) && (await exists(previousPath))) {
      try {
        await fs.rename(previousPath, targetPath);
      } catch (restoreError) {
        // 恢复也失败：旧数据仍完整保存在 previousPath，抛出带真实原因的明确错误，便于排查，
        // 不静默吞掉，也不删除 previousPath。
        const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new ProfileManagerError(
          `替换数据失败且未能自动恢复（${reason}）。原数据已备份在 ${previousPath}（可手动改名回 ${path.basename(targetPath)} 恢复）。`,
          "STAGED_REPLACE_RECOVERY_FAILED"
        );
      }
    }
    throw error;
  }

  if (targetExists) {
    await fs.rm(previousPath, { recursive: true, force: true });
  }
}

export function makeAccountSyncWorkPath(targetPath: string, suffix: string): string {
  return path.join(path.dirname(targetPath), `${accountSyncWorkPrefixForTarget(targetPath)}${Date.now()}-${randomUUID()}${suffix}`);
}

export function accountSyncWorkPrefixForTarget(targetPath: string): string {
  return `${ACCOUNT_SYNC_WORK_PREFIX}${path.basename(targetPath)}-`;
}

export function isAccountSyncWorkArtifactName(name: string): boolean {
  return name.startsWith(ACCOUNT_SYNC_WORK_PREFIX);
}

export function accountSyncRecordKey(sourceProfileId: string, targetProfileId: string): string {
  return `${sourceProfileId}::${targetProfileId}`;
}
