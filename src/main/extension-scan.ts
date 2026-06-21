import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import type {
  ExtensionDataPath,
  ProfileExtensionInfo,
  ProfileExtensionInstallType
} from "../shared/types";
import { exists, getNestedValue, isRecord, numberValue, readJsonFile, resolveWithinBase, stringValue, uniqueStrings } from "./fs-util";
import { ChromeExtensionManifest, ChromeExtensionSetting, ChromePreferences } from "./internal-types";

export async function scanProfileExtensions(profilePath: string): Promise<ProfileExtensionInfo[]> {
  const preferences = await readChromePreferences(profilePath);
  const securePreferences = await readChromeSecurePreferences(profilePath);
  const settings = {
    ...(preferences.extensions?.settings || {}),
    ...(securePreferences.extensions?.settings || {})
  };
  const directoryIds = await readExtensionDirectoryIds(profilePath);
  const extensionIds = uniqueStrings([...Object.keys(settings), ...directoryIds]).filter(isLikelyExtensionId);
  const extensions = await Promise.all(
    extensionIds.map((extensionId) =>
      scanProfileExtension(
        profilePath,
        extensionId,
        settings[extensionId],
        hasProtectedExtensionInstallRecord(securePreferences, extensionId)
      )
    )
  );

  return extensions
    .filter((extension): extension is ProfileExtensionInfo => Boolean(extension))
    .filter(isUserManageableExtension)
    .sort((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

export function isUserManageableExtension(extension: ProfileExtensionInfo): boolean {
  return extension.installType !== "component";
}

export async function scanProfileExtension(
  profilePath: string,
  extensionId: string,
  setting?: ChromeExtensionSetting,
  hasProtectedInstallRecord = false
): Promise<ProfileExtensionInfo | null> {
  const extensionPath = await findExtensionManifestDirectory(profilePath, extensionId, setting);
  const diskManifest = extensionPath ? await readManifest(extensionPath) : null;
  const prefManifest = isRecord(setting?.manifest) ? (setting?.manifest as ChromeExtensionManifest) : null;
  const manifest = diskManifest || prefManifest || {};
  const rawName = stringValue(manifest.name) || extensionId;
  const name = extensionPath ? await resolveManifestText(rawName, extensionPath, manifest) : rawName;
  const rawDescription = stringValue(manifest.description);
  const description = rawDescription && extensionPath ? await resolveManifestText(rawDescription, extensionPath, manifest) : rawDescription;
  const version = stringValue(manifest.version) || versionFromExtensionPath(extensionPath) || "未知";
  const updateUrl = stringValue(manifest.update_url) || stringValue(prefManifest?.update_url);
  const fromWebStore = Boolean(
    setting?.from_webstore === true || (updateUrl && updateUrl.includes("clients2.google.com/service/update2/crx"))
  );
  const installType = detectInstallType(profilePath, extensionPath, setting, fromWebStore);
  const dataPaths = await collectExtensionDataPaths(profilePath, extensionId);

  if (!extensionPath && !prefManifest) {
    return null;
  }

  return {
    id: extensionId,
    name,
    version,
    description: description || null,
    enabled: isExtensionEnabled(setting),
    fromWebStore,
    installType,
    storeUrl: fromWebStore ? chromeWebStoreUrl(extensionId) : null,
    path: extensionPath,
    hasLocalData: dataPaths.length > 0,
    dataPaths,
    canCopyLocally: Boolean(extensionPath && installType !== "component"),
    canPersistInstall: Boolean(extensionPath && installType !== "component" && hasProtectedInstallRecord)
  };
}

export async function readChromePreferences(profilePath: string): Promise<ChromePreferences> {
  return (await readJsonFile<ChromePreferences>(path.join(profilePath, "Preferences"))) || {};
}

export async function readChromeSecurePreferences(profilePath: string): Promise<ChromePreferences> {
  return (await readJsonFile<ChromePreferences>(path.join(profilePath, "Secure Preferences"))) || {};
}

export async function readExtensionDirectoryIds(profilePath: string): Promise<string[]> {
  const extensionsPath = path.join(profilePath, "Extensions");
  const entries = await fs.readdir(extensionsPath, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && isLikelyExtensionId(entry.name)).map((entry) => entry.name);
}

export async function findExtensionManifestDirectory(
  profilePath: string,
  extensionId: string,
  setting?: ChromeExtensionSetting
): Promise<string | null> {
  const candidates: string[] = [];
  const settingPath = stringValue(setting?.path);
  if (settingPath) {
    if (path.isAbsolute(settingPath)) {
      // 绝对路径来自 unpacked 扩展，是合法用法，保留。
      candidates.push(settingPath);
    } else {
      // 相对路径来自 Preferences（用户可写），限制在 profile / 扩展目录内，防 ../ 遍历。
      const withinProfile = resolveWithinBase(profilePath, settingPath);
      if (withinProfile) {
        candidates.push(withinProfile);
      }
      const extBase = path.join(profilePath, "Extensions", extensionId);
      const withinExt = resolveWithinBase(extBase, settingPath);
      if (withinExt) {
        candidates.push(withinExt);
      }
    }
  }

  candidates.push(path.join(profilePath, "Extensions", extensionId));

  for (const candidate of uniqueStrings(candidates)) {
    const resolved = await resolveManifestDirectory(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export async function resolveManifestDirectory(candidatePath: string): Promise<string | null> {
  if (await exists(path.join(candidatePath, "manifest.json"))) {
    return candidatePath;
  }

  const entries = await fs.readdir(candidatePath, { withFileTypes: true }).catch(() => []);
  const versionDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionDirectoryNames)
    .reverse();

  for (const dirName of versionDirs) {
    const versionPath = path.join(candidatePath, dirName);
    if (await exists(path.join(versionPath, "manifest.json"))) {
      return versionPath;
    }
  }

  return null;
}

export async function readManifest(extensionPath: string): Promise<ChromeExtensionManifest | null> {
  const manifest = await readJsonFile<ChromeExtensionManifest>(path.join(extensionPath, "manifest.json"));
  return isRecord(manifest) ? manifest : null;
}

export async function resolveManifestText(value: string, extensionPath: string, manifest: ChromeExtensionManifest): Promise<string> {
  const messageKey = parseManifestMessageKey(value);
  if (!messageKey) {
    return value;
  }

  // 和 Chrome 一致：先按浏览器/系统 UI 语言解析（这才是用户在 Chrome 里看到的名字），
  // 解析不到再回退到扩展自己的 default_locale，最后兜底英文。
  const defaultLocale = stringValue(manifest.default_locale);
  const locales = uniqueStrings(
    [...uiLocaleCandidates(), defaultLocale, "zh_CN", "zh", "en", "en_US"].filter(Boolean) as string[]
  );
  for (const locale of locales) {
    const message = await readLocaleMessage(extensionPath, locale, messageKey);
    if (message) {
      return message;
    }
  }

  return value;
}

// ProfilePilot（Electron）的 UI 语言候选，用作扩展 __MSG__ 名称的首选解析语言。
// Chrome 扩展 _locales 目录用下划线（zh_CN / en_US），这里把 "zh-CN" normalize 成 "zh_CN"，
// 并补上基础语言段 "zh"。
export function uiLocaleCandidates(): string[] {
  let uiLocale = "";
  try {
    uiLocale = app.getLocale() || "";
  } catch {
    uiLocale = "";
  }
  const normalized = uiLocale.replace(/-/g, "_");
  const base = normalized.split("_")[0];
  return uniqueStrings([normalized, base].filter(Boolean));
}

export function parseManifestMessageKey(value: string): string | null {
  const match = value.match(/^__MSG_([A-Za-z0-9_@]+)__$/);
  return match ? match[1] : null;
}

export async function readLocaleMessage(extensionPath: string, locale: string, messageKey: string): Promise<string | null> {
  const messages = await readJsonFile<Record<string, { message?: unknown }>>(
    path.join(extensionPath, "_locales", locale, "messages.json")
  );
  if (!messages || typeof messages !== "object") {
    return null;
  }

  const directMessage = stringValue(messages[messageKey]?.message);
  if (directMessage) {
    return directMessage;
  }

  const lowerKey = messageKey.toLowerCase();
  const matchingKey = Object.keys(messages).find((key) => key.toLowerCase() === lowerKey);
  return matchingKey ? stringValue(messages[matchingKey]?.message) : null;
}

export function detectInstallType(
  profilePath: string,
  extensionPath: string | null,
  setting: ChromeExtensionSetting | undefined,
  fromWebStore: boolean
): ProfileExtensionInstallType {
  const location = numberValue(setting?.location);
  // Chrome stores built-in services as extensions, but they are not user-manageable in chrome://extensions.
  if (location === 5 || location === 10) {
    return "component";
  }

  if (fromWebStore) {
    return "web_store";
  }

  if (!extensionPath) {
    return "unknown";
  }

  const relative = path.relative(path.join(profilePath, "Extensions"), extensionPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return "profile";
  }

  return "local";
}

export function isExtensionEnabled(setting: ChromeExtensionSetting | undefined): boolean {
  if (!setting) {
    return false;
  }

  const state = numberValue(setting.state);
  if (state !== null) {
    return state === 1;
  }

  return !hasDisableReason(setting.disable_reasons) && !hasDisableReason(setting.disable_reason);
}

export function hasDisableReason(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasDisableReason);
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return Boolean(normalized && normalized !== "0");
  }

  if (typeof value === "boolean") {
    return value;
  }

  return false;
}

export async function collectExtensionDataPaths(profilePath: string, extensionId: string): Promise<ExtensionDataPath[]> {
  const specs = extensionDataRelativePaths(extensionId).map((relativePath) => ({
    label: extensionDataLabel(relativePath),
    relativePath,
    path: path.join(profilePath, relativePath)
  }));
  const existing = await Promise.all(specs.map(async (spec) => ((await exists(spec.path)) ? spec : null)));

  return existing.filter((spec): spec is ExtensionDataPath => Boolean(spec));
}

export function extensionDataRelativePaths(extensionId: string): string[] {
  return [
    path.join("Local Extension Settings", extensionId),
    path.join("Sync Extension Settings", extensionId),
    path.join("Managed Extension Settings", extensionId),
    path.join("IndexedDB", `chrome-extension_${extensionId}_0.indexeddb.leveldb`),
    path.join("File System", `chrome-extension_${extensionId}`),
    path.join("databases", `chrome-extension_${extensionId}_0`)
  ];
}

export function extensionDeleteRelativePaths(extensionId: string): string[] {
  return uniqueStrings([
    path.join("Extensions", extensionId),
    path.join("Migrated Extensions", extensionId),
    ...extensionDataRelativePaths(extensionId)
  ]);
}

export function extensionDataLabel(relativePath: string): string {
  return relativePath.split(path.sep)[0] || relativePath;
}

export function hasProtectedExtensionInstallRecord(preferences: ChromePreferences, extensionId: string): boolean {
  return Boolean(
    preferences.extensions?.settings?.[extensionId] &&
      stringValue(
        getNestedValue(preferences as unknown as Record<string, unknown>, [
          "protection",
          "macs",
          "extensions",
          "settings",
          extensionId
        ])
      ) &&
      stringValue(
        getNestedValue(preferences as unknown as Record<string, unknown>, [
          "protection",
          "macs",
          "extensions",
          "settings_encrypted_hash",
          extensionId
        ])
      )
  );
}

export function chromeWebStoreUrl(extensionId: string): string {
  return `https://chromewebstore.google.com/detail/${extensionId}`;
}

export function versionFromExtensionPath(extensionPath: string | null): string | null {
  if (!extensionPath) {
    return null;
  }

  return path.basename(extensionPath).replace(/_\d+$/, "") || null;
}

export function compareVersionDirectoryNames(a: string, b: string): number {
  const aVersion = a.replace(/_\d+$/, "");
  const bVersion = b.replace(/_\d+$/, "");
  const aParts = aVersion.split(".").map((part) => Number(part));
  const bParts = bVersion.split(".").map((part) => Number(part));
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aPart = Number.isFinite(aParts[index]) ? aParts[index] : 0;
    const bPart = Number.isFinite(bParts[index]) ? bParts[index] : 0;
    if (aPart !== bPart) {
      return aPart - bPart;
    }
  }

  return a.localeCompare(b);
}

export function isLikelyExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}
