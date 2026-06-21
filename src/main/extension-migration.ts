import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionMigrationDiffItem,
  ExtensionMigrationDiffResult,
  ExtensionMigrationDiffStatus,
  ProfileExtensionInfo,
  PublicProfile,
  StoredProfile
} from "../shared/types";
import { makeAccountSyncWorkPath, pathMetadataFingerprint, recoverInterruptedAccountSyncPath, replacePathWithStagedCopy } from "./account-sync";
import { closeTemporaryChromeWithCdp, enableDeveloperModeOverCdp, launchTemporaryChromeWithCdp, readChromeMajorVersion } from "./chrome-launch";
import { readChromeSecurePreferences } from "./extension-scan";
import { copyPath } from "./fs-copy";
import { cloneJsonValue, exists, getNestedValue, isRecord, isSameFilesystemPath, makePathSegment, normalizeSafeRelativePath, readJsonFile, shouldCopyLocalExtensionPackagePath, stringValue, uniqueStrings, writeJsonFileAtomic } from "./fs-util";
import { ACCOUNT_SYNC_PARTIAL_SUFFIX, ChromeExtensionSetting, MigratedExtensionLaunchPlan, ProtectedDeveloperModeRecord, ProtectedExtensionInstallRecord, TemporaryChromeCdpLaunch } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export async function readProtectedExtensionInstallRecord(
  profilePath: string,
  extensionId: string
): Promise<ProtectedExtensionInstallRecord | null> {
  const securePreferences = await readChromeSecurePreferences(profilePath);
  const setting = securePreferences.extensions?.settings?.[extensionId];
  const settingMac = stringValue(
    getNestedValue(securePreferences as unknown as Record<string, unknown>, [
      "protection",
      "macs",
      "extensions",
      "settings",
      extensionId
    ])
  );
  const encryptedHashMac = stringValue(
    getNestedValue(securePreferences as unknown as Record<string, unknown>, [
      "protection",
      "macs",
      "extensions",
      "settings_encrypted_hash",
      extensionId
    ])
  );

  if (!setting || !settingMac || !encryptedHashMac) {
    return null;
  }

  return {
    setting: cloneJsonValue(setting) as ChromeExtensionSetting,
    settingMac,
    encryptedHashMac
  };
}

export function isProfileRelativeExtensionSetting(setting: ChromeExtensionSetting): boolean {
  const settingPath = stringValue(setting.path);
  return Boolean(settingPath && !path.isAbsolute(settingPath));
}

export async function copyExtensionPackageToProfile(
  extension: ProfileExtensionInfo,
  sourceProfilePath: string,
  targetProfilePath: string
): Promise<string> {
  if (!extension.path) {
    throw new ProfileManagerError(`插件 ${extension.name} 没有可复制的插件包目录。`, "EXTENSION_PATH_MISSING");
  }

  const sourcePath = extension.path;
  const sourceExtensionsRoot = path.join(sourceProfilePath, "Extensions");
  const relativeFromExtensions = path.relative(sourceExtensionsRoot, sourcePath);
  const packageRelativePath =
    relativeFromExtensions &&
    !relativeFromExtensions.startsWith("..") &&
    !path.isAbsolute(relativeFromExtensions)
      ? normalizeSafeRelativePath(relativeFromExtensions)
      : path.join(extension.id, makePathSegment(path.basename(sourcePath)));
  const targetPath = path.join(targetProfilePath, "Extensions", packageRelativePath);

  if (await isSameFilesystemPath(sourcePath, targetPath)) {
    return targetPath;
  }

  await fs.rm(targetPath, { recursive: true, force: true });
  await copyPath(sourcePath, targetPath, {
    shouldCopy: (candidatePath) => shouldCopyLocalExtensionPackagePath(sourcePath, candidatePath)
  });
  return targetPath;
}

export let cachedProtectedDeveloperModeRecord: ProtectedDeveloperModeRecord | null = null;

export async function getProtectedDeveloperModeRecord(targetProfilePath: string): Promise<ProtectedDeveloperModeRecord> {
  const existing = await readProtectedDeveloperModeRecord(targetProfilePath);
  if (existing) {
    return existing;
  }

  if (!cachedProtectedDeveloperModeRecord) {
    cachedProtectedDeveloperModeRecord = await createProtectedDeveloperModeRecordWithChrome();
  }
  return cachedProtectedDeveloperModeRecord;
}

export async function readProtectedDeveloperModeRecord(profilePath: string): Promise<ProtectedDeveloperModeRecord | null> {
  const securePreferences = await readChromeSecurePreferences(profilePath);
  const developerMode = securePreferences.extensions?.ui?.developer_mode;
  const developerModeMac = stringValue(
    getNestedValue(securePreferences as unknown as Record<string, unknown>, [
      "protection",
      "macs",
      "extensions",
      "ui",
      "developer_mode"
    ])
  );
  const encryptedHashMac = stringValue(
    getNestedValue(securePreferences as unknown as Record<string, unknown>, [
      "protection",
      "macs",
      "extensions",
      "ui",
      "developer_mode_encrypted_hash"
    ])
  );

  if (developerMode !== true || !developerModeMac || !encryptedHashMac) {
    return null;
  }

  return {
    developerMode: true,
    developerModeMac,
    encryptedHashMac
  };
}

export async function writeProtectedExtensionInstallRecord(
  profilePath: string,
  extensionId: string,
  installRecord: ProtectedExtensionInstallRecord,
  developerModeRecord: ProtectedDeveloperModeRecord | null
): Promise<void> {
  const securePreferencesPath = path.join(profilePath, "Secure Preferences");
  const securePreferences =
    (await readJsonFile<Record<string, unknown>>(securePreferencesPath)) || ({} as Record<string, unknown>);
  const extensions = ensureRecordProperty(securePreferences, "extensions");
  const settings = ensureRecordProperty(extensions, "settings");
  settings[extensionId] = cloneJsonValue(installRecord.setting);

  const protection = ensureRecordProperty(securePreferences, "protection");
  const macs = ensureRecordProperty(protection, "macs");
  const protectedExtensions = ensureRecordProperty(macs, "extensions");
  const settingsMacs = ensureRecordProperty(protectedExtensions, "settings");
  const settingsEncryptedHashMacs = ensureRecordProperty(protectedExtensions, "settings_encrypted_hash");
  settingsMacs[extensionId] = installRecord.settingMac;
  settingsEncryptedHashMacs[extensionId] = installRecord.encryptedHashMac;

  if (developerModeRecord) {
    const ui = ensureRecordProperty(extensions, "ui");
    ui.developer_mode = true;

    const uiMacs = ensureRecordProperty(protectedExtensions, "ui");
    uiMacs.developer_mode = developerModeRecord.developerModeMac;
    uiMacs.developer_mode_encrypted_hash = developerModeRecord.encryptedHashMac;
  }

  await fs.mkdir(profilePath, { recursive: true });
  await writeJsonFileAtomic(securePreferencesPath, securePreferences);
}

export function ensureRecordProperty(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (isRecord(current)) {
    return current;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export async function createProtectedDeveloperModeRecordWithChrome(): Promise<ProtectedDeveloperModeRecord> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profilepilot-devmode-"));
  let launch: TemporaryChromeCdpLaunch | null = null;
  try {
    launch = await launchTemporaryChromeWithCdp(userDataDir);
    await enableDeveloperModeOverCdp(launch.port);
    await closeTemporaryChromeWithCdp(launch);
    launch = null;

    const record = await readProtectedDeveloperModeRecord(path.join(userDataDir, "Default"));
    if (!record) {
      throw new ProfileManagerError("Chrome 没有写入可复用的开发者模式保护记录。", "DEVELOPER_MODE_RECORD_MISSING");
    }
    return record;
  } finally {
    if (launch) {
      await closeTemporaryChromeWithCdp(launch).catch(() => undefined);
    }
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function inspectExtensionMigrationItem(
  extension: ProfileExtensionInfo,
  targetExtension: ProfileExtensionInfo | null,
  targetProfile: PublicProfile,
  dataChanged: boolean,
  openInstallPages: boolean
): ExtensionMigrationDiffItem {
  const canPersistInstall = canPersistExtensionInstall(extension);
  const canLoadViaCdp = !canPersistInstall && canLoadLocalExtensionViaCdp(extension, targetProfile);
  const canOpenInstallPage = Boolean(extension.fromWebStore && extension.storeUrl);
  const needsManualLoad = Boolean(extension.path && !extension.fromWebStore && !canPersistInstall && !canLoadViaCdp);
  const targetVersion = targetExtension?.version || null;
  let status: ExtensionMigrationDiffStatus;

  if (!targetExtension) {
    status = canPersistInstall || canLoadViaCdp
      ? "missing"
      : needsManualLoad
        ? "manual_load_required"
        : canOpenInstallPage
          ? "needs_install_page"
          : "unsupported";
  } else if (extension.version !== targetExtension.version) {
    status = canPersistInstall || canLoadViaCdp
      ? "version_changed"
      : needsManualLoad
        ? "manual_load_required"
        : canOpenInstallPage
          ? "needs_install_page"
          : "unsupported";
  } else if (dataChanged) {
    status = "data_changed";
  } else {
    status = "same";
  }

  return {
    id: extension.id,
    name: extension.name,
    sourceVersion: extension.version,
    targetVersion,
    status,
    reason: extensionMigrationDiffReason(status, Boolean(targetExtension), openInstallPages, canLoadViaCdp, canPersistInstall),
    willCopyLocally: (status === "missing" || status === "version_changed") && canPersistInstall,
    willLoadViaCdp: (status === "missing" || status === "version_changed") && canLoadViaCdp,
    willOpenInstallPage: status === "needs_install_page" && canOpenInstallPage && openInstallPages
  };
}

export function extensionMigrationDiffReason(
  status: ExtensionMigrationDiffStatus,
  hasTargetExtension: boolean,
  openInstallPages: boolean,
  willLoadViaCdp = false,
  willPersistInstall = false
): string {
  switch (status) {
    case "missing":
      if (willPersistInstall) {
        return "目标缺少，本次会写入持久安装记录";
      }
      if (willLoadViaCdp) {
        return "目标缺少，本次会登记为启动时自动加载";
      }
      return "目标缺少，本次会同步";
    case "version_changed":
      if (willPersistInstall) {
        return "版本不同，本次会更新持久安装记录";
      }
      if (willLoadViaCdp) {
        return "版本不同，本次会更新启动时自动加载配置";
      }
      return "版本不同，本次会更新";
    case "data_changed":
      return "插件数据不同，本次会同步数据";
    case "same":
      return "已一致，本次无需同步";
    case "needs_install_page":
      if (!openInstallPages) {
        return hasTargetExtension ? "版本不同，需要安装页，当前不会自动打开" : "目标缺少，需要安装页，当前不会自动打开";
      }
      return hasTargetExtension ? "版本不同，本次会打开安装页" : "目标缺少，本次会打开安装页";
    case "manual_load_required":
      return hasTargetExtension
        ? "本地未打包插件不能自动更新，需要在目标手动重新加载原目录"
        : "目标缺少本地未打包插件，需要在目标手动加载原目录";
    case "unsupported":
    default:
      return "没有可自动同步的插件目录";
  }
}

export function isExtensionMigrationActionItem(item: ExtensionMigrationDiffItem): boolean {
  return (
    item.status === "missing" ||
    item.status === "version_changed" ||
    item.status === "data_changed" ||
    item.status === "manual_load_required" ||
    item.willOpenInstallPage
  );
}

export function summarizeExtensionMigrationDiff(
  items: ExtensionMigrationDiffItem[],
  targetOnlyCount: number
): ExtensionMigrationDiffResult["summary"] {
  return {
    missingCount: items.filter((item) => item.status === "missing").length,
    changedCount: items.filter((item) => item.status === "version_changed" || item.status === "data_changed").length,
    sameCount: items.filter((item) => item.status === "same").length,
    needsInstallPageCount: items.filter((item) => item.status === "needs_install_page").length,
    cdpLoadCount: items.filter((item) => item.willLoadViaCdp).length,
    manualLoadCount: items.filter((item) => item.status === "manual_load_required").length,
    unsupportedCount: items.filter((item) => item.status === "unsupported").length,
    targetOnlyCount
  };
}

export function canLoadLocalExtensionViaCdp(extension: ProfileExtensionInfo, targetProfile: PublicProfile): boolean {
  return Boolean(extension.path && !extension.fromWebStore && targetProfile.source === "isolated");
}

export function canPersistExtensionInstall(extension: ProfileExtensionInfo): boolean {
  return Boolean(extension.path && extension.canPersistInstall);
}

export function manualLoadExtensionReason(extension: ProfileExtensionInfo): string {
  const sourcePath = extension.path || "源插件目录";
  return `需要在目标 chrome://extensions 手动加载未打包目录：${sourcePath}`;
}

export function isManualLoadSkipReason(reason: string): boolean {
  return reason.includes("手动加载未打包目录") || reason.includes("手动加载源目录");
}

export async function extensionDataDiffers(
  sourceProfilePath: string,
  targetProfilePath: string,
  extension: ProfileExtensionInfo
): Promise<boolean> {
  for (const dataPath of extension.dataPaths) {
    const relativePath = normalizeSafeRelativePath(dataPath.relativePath);
    const [sourceFingerprint, targetFingerprint] = await Promise.all([
      pathMetadataFingerprint(path.join(sourceProfilePath, relativePath)),
      pathMetadataFingerprint(path.join(targetProfilePath, relativePath))
    ]);
    if (sourceFingerprint !== targetFingerprint) {
      return true;
    }
  }

  return false;
}

export async function copyExtensionDataPath(
  sourceProfilePath: string,
  targetProfilePath: string,
  relativePath: string
): Promise<boolean> {
  const safeRelativePath = normalizeSafeRelativePath(relativePath);
  const sourcePath = path.join(sourceProfilePath, safeRelativePath);
  if (!(await exists(sourcePath))) {
    return false;
  }

  const targetPath = path.join(targetProfilePath, safeRelativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  // 复用账号同步成熟的 staging 模式：先复制到临时目录，成功后再原子替换（旧数据先移到
  // previous 备份），避免“先删目标再复制、中途失败丢失 IndexedDB/LocalStorage 等不可再生数据”。
  await recoverInterruptedAccountSyncPath(targetPath);
  const stagingPath = makeAccountSyncWorkPath(targetPath, ACCOUNT_SYNC_PARTIAL_SUFFIX);
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    await copyPath(sourcePath, stagingPath);
    await replacePathWithStagedCopy(stagingPath, targetPath);
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

export async function removeExtensionReferencesFromProfilePreferences(profilePath: string, extensionId: string): Promise<void> {
  await Promise.all(
    ["Preferences", "Secure Preferences"].map(async (fileName) => {
      const filePath = path.join(profilePath, fileName);
      const preferences = await readJsonFile<Record<string, unknown>>(filePath);
      if (!preferences) {
        return;
      }

      let changed = false;
      if (isRecord(preferences.extensions)) {
        changed = removeExtensionReferences(preferences.extensions, extensionId) || changed;
      }
      if (isRecord(preferences.protection)) {
        changed = removeExtensionReferences(preferences.protection, extensionId) || changed;
      }

      if (changed) {
        await writeJsonFileAtomic(filePath, preferences);
      }
    })
  );
}

export function removeExtensionReferences(value: unknown, extensionId: string): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (item === extensionId || item === `chrome-extension://${extensionId}`) {
        value.splice(index, 1);
        changed = true;
        continue;
      }
      changed = removeExtensionReferences(item, extensionId) || changed;
    }
    return changed;
  }

  if (!isRecord(value)) {
    return false;
  }

  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (key === extensionId) {
      delete value[key];
      changed = true;
      continue;
    }
    changed = removeExtensionReferences(item, extensionId) || changed;
  }

  return changed;
}

export let cachedCanAutoLoadUnpackedExtensions: boolean | null = null;

export async function canAutoLoadUnpackedExtensions(): Promise<boolean> {
  if (cachedCanAutoLoadUnpackedExtensions !== null) {
    return cachedCanAutoLoadUnpackedExtensions;
  }

  cachedCanAutoLoadUnpackedExtensions = await detectAutoLoadUnpackedExtensionSupport();
  return cachedCanAutoLoadUnpackedExtensions;
}

export async function detectAutoLoadUnpackedExtensionSupport(): Promise<boolean> {
  const launcherName = (process.env.CHROME_BINARY
    ? path.basename(process.env.CHROME_BINARY)
    : process.env.CHROME_APP_NAME || "Google Chrome"
  ).toLowerCase();

  if (launcherName.includes("chromium") || launcherName.includes("chrome for testing")) {
    return true;
  }

  const majorVersion = await readChromeMajorVersion();
  if (launcherName.includes("google chrome") || majorVersion !== null) {
    return majorVersion !== null ? majorVersion < 137 : false;
  }

  return true;
}

export async function getMigratedExtensionLaunchPlan(profile: StoredProfile): Promise<MigratedExtensionLaunchPlan> {
  const extensionPaths = uniqueStrings((profile.migratedExtensions || []).map((extension) => extension.path));
  const existingPaths: string[] = [];
  for (const extensionPath of extensionPaths) {
    if (await exists(path.join(extensionPath, "manifest.json"))) {
      existingPaths.push(extensionPath);
    }
  }

  if (!existingPaths.length) {
    return { launchArgs: [], runtimeLoadPaths: [] };
  }

  if (await canAutoLoadUnpackedExtensions()) {
    return { launchArgs: [`--load-extension=${existingPaths.join(",")}`], runtimeLoadPaths: [] };
  }

  return { launchArgs: [], runtimeLoadPaths: existingPaths };
}

export function makeStoredMigratedExtensionId(extensionId: string): string {
  return `migrated:${extensionId}`;
}
