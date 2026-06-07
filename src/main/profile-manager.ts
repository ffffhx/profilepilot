import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  AccountSyncBackupMetadata,
  AccountSyncBackupSummary,
  AccountSyncCopiedItem,
  AccountSyncRequest,
  AccountSyncRestoreResult,
  AccountSyncResult,
  AccountSyncSkippedItem,
  AppState,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionDataPath,
  ExtensionMigrationBackupMetadata,
  ExtensionMigrationBackupSummary,
  ExtensionMigrationCopiedExtension,
  ExtensionMigrationDataCopy,
  ExtensionMigrationRequest,
  ExtensionMigrationRestoreResult,
  ExtensionMigrationResult,
  ExtensionMigrationSkippedExtension,
  ExtensionScanResult,
  NativeChromeProfile,
  NativeProfileMetadata,
  ProfileExtensionInfo,
  ProfileExtensionInstallType,
  PublicProfile,
  Registry,
  StoredMigratedExtension,
  StoredProfile
} from "../shared/types";

const execFileAsync = promisify(execFile);

export const APP_TITLE = "ProfilePilot";
const APP_DATA_DIR_NAME = "ProfilePilot";
const LEGACY_APP_DATA_DIR_NAME = "Codex Chrome Profile Manager";

type ProfileRef = { source: "native"; dirName: string } | { source: "isolated"; id: string };

interface RuntimeProfile {
  pids: number[];
  startedAt: string | null;
  cdpPort: number | null;
  listeningPorts: number[];
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<
      string,
      {
        name?: unknown;
        user_name?: unknown;
        is_using_default_name?: unknown;
      }
    >;
  };
}

interface ChromePreferences {
  extensions?: {
    settings?: Record<string, ChromeExtensionSetting>;
  };
}

interface ChromeExtensionSetting {
  state?: unknown;
  disable_reasons?: unknown;
  disable_reason?: unknown;
  from_webstore?: unknown;
  location?: unknown;
  path?: unknown;
  manifest?: ChromeExtensionManifest;
}

interface ChromeExtensionManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  default_locale?: unknown;
  update_url?: unknown;
}

interface AccountSyncPathSpec {
  label: string;
  relativePath: string;
}

interface AccountSyncDataLocation {
  userDataPath: string;
  profilePath: string;
}

export class ProfileManagerError extends Error {
  constructor(
    message: string,
    readonly code = "PROFILE_MANAGER_ERROR"
  ) {
    super(message);
    this.name = "ProfileManagerError";
  }
}

export class ProfileManager {
  private readonly profilesDir: string;
  private readonly registryPath: string;
  private readonly extensionBackupDir: string;
  private readonly accountSyncBackupDir: string;

  constructor(private readonly dataDir = defaultDataDir()) {
    this.profilesDir = path.join(dataDir, "profiles");
    this.registryPath = path.join(dataDir, "profiles.json");
    this.extensionBackupDir = path.join(dataDir, "extension-migration-backups");
    this.accountSyncBackupDir = path.join(dataDir, "account-sync-backups");
  }

  async getState(): Promise<AppState> {
    const registry = await this.loadRegistry();
    const nativeChromeProfiles = await scanNativeChromeProfiles();
    const nativePaths = nativeChromeProfiles.map((profile) => profile.path);
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const runtime = await this.getRuntime(nativePaths.concat(isolatedPaths), nativeChromeProfiles.map((profile) => profile.dirName));

    const nativeProfiles = nativeChromeProfiles.map((profile) => this.toNativePublicProfile(profile, registry, runtime));
    const isolatedProfiles = (await Promise.all(
      registry.profiles.map((profile) => this.toIsolatedPublicProfile(profile, runtime))
    )).sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt || "";
        const bTime = b.lastLaunchedAt || b.createdAt || "";
        return bTime.localeCompare(aTime);
      });
    const profiles = [...nativeProfiles, ...isolatedProfiles];

    const runningProfiles = profiles.filter((profile) => profile.running);
    const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;

    return {
      appTitle: APP_TITLE,
      dataDir: this.dataDir,
      profilesDir: this.profilesDir,
      profiles,
      nativeProfileCount: nativeProfiles.length,
      isolatedProfileCount: isolatedProfiles.length,
      nativeChromeProfiles,
      runningProfiles,
      currentProfile: runningProfiles[0] || lastLaunchedProfile,
      chromeLauncher: this.getLauncherLabel()
    };
  }

  async createProfile(nameInput: string): Promise<StoredProfile> {
    const name = normalizeProfileName(nameInput);

    const registry = await this.loadRegistry();
    const id = randomUUID();
    const dirName = `${makeSlug(name)}-${id.slice(0, 8)}`;
    const now = new Date().toISOString();
    const profile: StoredProfile = {
      id,
      name,
      dirName,
      createdAt: now,
      lastLaunchedAt: null
    };

    await fs.mkdir(this.isolatedProfilePath(profile), { recursive: false });
    registry.profiles.push(profile);
    await this.saveRegistry(registry);

    return profile;
  }

  async renameProfile(profileId: string, nameInput: string): Promise<void> {
    const ref = parseProfileId(profileId);
    const name = normalizeProfileName(nameInput);
    const registry = await this.loadRegistry();

    if (ref.source === "native") {
      const profile = (await scanNativeChromeProfiles()).find((item) => item.dirName === ref.dirName);
      if (!profile) {
        throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
      }

      registry.nativeProfiles = {
        ...(registry.nativeProfiles || {}),
        [profile.dirName]: {
          ...(registry.nativeProfiles?.[profile.dirName] || {}),
          lastLaunchedAt: registry.nativeProfiles?.[profile.dirName]?.lastLaunchedAt || null,
          name
        }
      };
      await this.saveRegistry(registry);
      return;
    }

    const profile = this.findIsolatedProfile(registry, ref.id);
    profile.name = name;
    await this.saveRegistry(registry);
  }

  async launchProfile(profileId: string): Promise<void> {
    const ref = parseProfileId(profileId);

    if (ref.source === "native") {
      await this.launchNativeProfile(ref.dirName);
      return;
    }

    await this.launchIsolatedProfile(ref.id);
  }

  async launchProfileWithCdp(profileId: string, portInput?: number | null): Promise<void> {
    const ref = parseProfileId(profileId);
    if (ref.source === "native") {
      throw new ProfileManagerError(
        "CDP 启动只支持工具独立 Profile。请先创建独立 Profile，再用于 Agent/browser 自动化。",
        "CDP_NATIVE_UNSUPPORTED"
      );
    }

    await this.launchIsolatedProfileWithCdp(ref.id, portInput);
  }

  async closeProfile(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      throw new ProfileManagerError("这个 Profile 当前未运行。", "PROFILE_NOT_RUNNING");
    }

    for (const pid of profile.pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!isProcessGoneError(error)) {
          throw error;
        }
      }
    }

    await this.waitUntilProfileStops(profile.id, 1800);
  }

  async focusProfile(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      throw new ProfileManagerError("这个 Profile 当前未运行。", "PROFILE_NOT_RUNNING");
    }

    const raisedWindow = await focusProfileWindow(profile.pids);
    if (raisedWindow || profile.source !== "isolated" || (await hasRendererProcessForProfile(profile.path))) {
      return;
    }

    await requestIsolatedProfileWindow(profile);
    await sleep(700);

    const refreshedProfile = await this.getPublicProfile(profileId);
    await focusProfileWindow(refreshedProfile.pids.length ? refreshedProfile.pids : profile.pids);
  }

  async openProfileFolder(profileId: string): Promise<void> {
    const ref = parseProfileId(profileId);
    const profilePath = await this.pathForRef(ref);
    await fs.mkdir(profilePath, { recursive: true });

    const error = await shell.openPath(profilePath);
    if (error) {
      throw new ProfileManagerError(`打开目录失败：${error}`, "OPEN_FOLDER_FAILED");
    }
  }

  async deleteProfile(profileId: string): Promise<DeleteProfileResult> {
    const ref = parseProfileId(profileId);

    if (ref.source === "native") {
      return this.deleteNativeProfile(ref.dirName);
    }

    return this.deleteIsolatedProfile(ref.id);
  }

  async scanProfileExtensions(profileId: string): Promise<ExtensionScanResult> {
    const profile = await this.getPublicProfile(profileId);
    const profileDataPath = await this.resolveChromeProfileDataPath(profile);
    const extensions = await scanProfileExtensions(profileDataPath);

    return {
      profileId: profile.id,
      profileName: profile.name,
      profilePath: profileDataPath,
      extensions
    };
  }

  async migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    const extensionIds = uniqueStrings(request.extensionIds || []).filter(isLikelyExtensionId);
    const includeData = Boolean(request.includeData);
    const openInstallPages = Boolean(request.openInstallPages);

    if (!sourceProfileId || !targetProfileId || sourceProfileId === targetProfileId) {
      throw new ProfileManagerError("请选择两个不同的 Profile 进行插件迁移。", "INVALID_MIGRATION_PROFILES");
    }
    if (!extensionIds.length) {
      throw new ProfileManagerError("请至少选择一个要迁移的插件。", "NO_EXTENSIONS_SELECTED");
    }

    const state = await this.getState();
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetProfileId);
    if (!sourceProfile || !targetProfile) {
      throw new ProfileManagerError("没有找到源 Profile 或目标 Profile。", "PROFILE_NOT_FOUND");
    }
    if (targetProfile.running) {
      throw new ProfileManagerError("迁移插件前请先关闭目标 Profile。", "TARGET_PROFILE_RUNNING");
    }
    if (includeData && sourceProfile.running) {
      throw new ProfileManagerError("迁移插件数据前请先关闭源 Profile，或取消勾选“同时迁移插件数据”。", "SOURCE_PROFILE_RUNNING");
    }

    const scan = await this.scanProfileExtensions(sourceProfileId);
    const sourceProfileDataPath = await this.resolveChromeProfileDataPath(sourceProfile);
    const targetProfileDataPath = await this.resolveChromeProfileDataPath(targetProfile, true);
    const selectedExtensions = extensionIds
      .map((id) => scan.extensions.find((extension) => extension.id === id))
      .filter(Boolean) as ProfileExtensionInfo[];
    if (!selectedExtensions.length) {
      throw new ProfileManagerError("在源 Profile 里没有找到已选择的插件。", "EXTENSIONS_NOT_FOUND");
    }

    const backup = await this.createExtensionMigrationBackup(targetProfile, selectedExtensions, targetProfileDataPath);
    const copiedExtensions: ExtensionMigrationCopiedExtension[] = [];
    const dataCopies: ExtensionMigrationDataCopy[] = [];
    const skippedExtensions: ExtensionMigrationSkippedExtension[] = [];
    const webStoreInstallUrls: string[] = [];
    const now = new Date().toISOString();
    const copiedForRegistry: StoredMigratedExtension[] = [];

    try {
      for (const extension of selectedExtensions) {
        if (extension.canCopyLocally && extension.path) {
          if (targetProfile.source !== "isolated") {
            if (extension.fromWebStore && extension.storeUrl) {
              webStoreInstallUrls.push(extension.storeUrl);
            }

            skippedExtensions.push({
              id: extension.id,
              name: extension.name,
              reason: extension.fromWebStore
                ? "商店插件静默挂载需要目标是工具独立 Profile"
                : "本地插件只能持久挂载到工具独立 Profile"
            });
          } else {
            const copiedPath = await this.copyLocalExtensionToIsolatedProfile(extension, targetProfile);
            copiedExtensions.push({
              id: extension.id,
              name: extension.name,
              version: extension.version,
              path: copiedPath,
              fromWebStore: extension.fromWebStore
            });
            copiedForRegistry.push({
              id: makeStoredMigratedExtensionId(extension.id),
              sourceProfileId,
              sourceExtensionId: extension.id,
              name: extension.name,
              version: extension.version,
              path: copiedPath,
              migratedAt: now,
              includeData
            });
          }
        } else if (extension.fromWebStore && extension.storeUrl) {
          webStoreInstallUrls.push(extension.storeUrl);
          skippedExtensions.push({
            id: extension.id,
            name: extension.name,
            reason: "源 Profile 里没有找到可静默复制的插件目录"
          });
        } else if (!extension.fromWebStore) {
          skippedExtensions.push({
            id: extension.id,
            name: extension.name,
            reason: "没有找到可复制的插件目录"
          });
        }

        if (includeData) {
          for (const dataPath of extension.dataPaths) {
            const copied = await copyExtensionDataPath(sourceProfileDataPath, targetProfileDataPath, dataPath.relativePath);
            if (copied) {
              dataCopies.push({
                id: extension.id,
                name: extension.name,
                relativePath: dataPath.relativePath
              });
            }
          }
        }
      }

      if (copiedForRegistry.length) {
        await this.mergeMigratedExtensions(targetProfile, copiedForRegistry);
      }

      let openedInstallPages = false;
      if (openInstallPages && webStoreInstallUrls.length) {
        await this.launchProfileWithUrls(targetProfile.id, uniqueStrings(webStoreInstallUrls));
        openedInstallPages = true;
      }

      return {
        sourceProfileId,
        targetProfileId,
        selectedCount: selectedExtensions.length,
        copiedExtensions,
        dataCopies,
        webStoreInstallUrls: uniqueStrings(webStoreInstallUrls),
        skippedExtensions,
        backup,
        openedInstallPages,
        state: await this.getState()
      };
    } catch (error) {
      try {
        await this.restoreBackupMetadata(await this.readExtensionMigrationBackupMetadata(backup.id));
        await this.discardMigratedExtensions(targetProfile, copiedForRegistry);
      } catch {
        // Keep the original migration error as the visible failure.
      }
      throw error;
    }
  }

  async deleteProfileExtension(profileIdInput: string, extensionIdInput: string): Promise<ExtensionDeleteResult> {
    const profileId = String(profileIdInput || "");
    const extensionId = String(extensionIdInput || "");
    if (!profileId || !isLikelyExtensionId(extensionId)) {
      throw new ProfileManagerError("请选择要删除的 Profile 和插件。", "INVALID_EXTENSION_DELETE_REQUEST");
    }

    const state = await this.getState();
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Profile。", "PROFILE_NOT_FOUND");
    }
    if (profile.running) {
      throw new ProfileManagerError("删除插件前请先关闭这个 Profile，然后刷新列表。", "PROFILE_RUNNING");
    }

    const scan = await this.scanProfileExtensions(profileId);
    const extension = scan.extensions.find((item) => item.id === extensionId);
    if (!extension) {
      throw new ProfileManagerError("没有在这个 Profile 里找到要删除的插件。", "EXTENSION_NOT_FOUND");
    }

    const profileDataPath = await this.resolveChromeProfileDataPath(profile);
    const backup = await this.createExtensionMigrationBackup(profile, [extension], profileDataPath);
    const deletedPaths: string[] = [];

    try {
      for (const relativePath of extensionDeleteRelativePaths(extensionId)) {
        const targetPath = path.join(profileDataPath, normalizeSafeRelativePath(relativePath));
        if (await exists(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
          deletedPaths.push(targetPath);
        }
      }

      if (profile.source === "isolated") {
        const migratedExtensionPath = path.join(profile.path, "Migrated Extensions", extensionId);
        if (await exists(migratedExtensionPath)) {
          await fs.rm(migratedExtensionPath, { recursive: true, force: true });
          deletedPaths.push(migratedExtensionPath);
        }
      }

      await removeExtensionReferencesFromProfilePreferences(profileDataPath, extensionId);
      await this.removeMigratedExtensionReference(profile, extensionId);

      return {
        profileId: profile.id,
        profileName: profile.name,
        extensionId,
        extensionName: extension.name,
        deletedPaths,
        backup,
        scan: await this.scanProfileExtensions(profileId),
        state: await this.getState()
      };
    } catch (error) {
      try {
        await this.restoreBackupMetadata(await this.readExtensionMigrationBackupMetadata(backup.id));
      } catch {
        // Keep the original delete error visible.
      }
      throw error;
    }
  }

  async listExtensionMigrationBackups(): Promise<ExtensionMigrationBackupSummary[]> {
    await fs.mkdir(this.extensionBackupDir, { recursive: true });
    const entries = await fs.readdir(this.extensionBackupDir, { withFileTypes: true }).catch(() => []);
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<ExtensionMigrationBackupSummary | null> => {
          try {
            return summarizeExtensionMigrationBackup(
              await this.readExtensionMigrationBackupMetadata(entry.name)
            );
          } catch {
            return null;
          }
        })
    );

    return backups
      .filter((backup): backup is ExtensionMigrationBackupSummary => Boolean(backup))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restoreExtensionMigrationBackup(backupId: string): Promise<ExtensionMigrationRestoreResult> {
    const metadata = await this.readExtensionMigrationBackupMetadata(backupId);
    const state = await this.getState();
    const targetProfile = state.profiles.find((profile) => profile.id === metadata.targetProfileId);
    if (targetProfile?.running) {
      throw new ProfileManagerError("恢复备份前请先关闭目标 Profile。", "TARGET_PROFILE_RUNNING");
    }

    await this.restoreBackupMetadata(metadata);

    return {
      backup: summarizeExtensionMigrationBackup(metadata),
      state: await this.getState()
    };
  }

  async syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    const launchTarget = Boolean(request.launchTarget);

    if (!sourceProfileId || !targetProfileId || sourceProfileId === targetProfileId) {
      throw new ProfileManagerError("请选择两个不同的 Profile 进行账号同步。", "INVALID_ACCOUNT_SYNC_PROFILES");
    }

    const state = await this.getState();
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetProfileId);
    if (!sourceProfile || !targetProfile) {
      throw new ProfileManagerError("没有找到源 Profile 或目标 Profile。", "PROFILE_NOT_FOUND");
    }
    if (targetProfile.running) {
      throw new ProfileManagerError(
        "同步账号前请先关闭目标 Profile，然后刷新列表。Chrome 运行时写入目标登录数据库可能造成数据不一致。",
        "PROFILE_RUNNING"
      );
    }

    const sourceLocation = await this.resolveAccountSyncLocation(sourceProfile, false);
    const targetLocation = await this.resolveAccountSyncLocation(targetProfile, true);
    const availableSpecs = await existingAccountSyncSpecs(sourceLocation.profilePath);
    const hasSourcePreferences = await exists(path.join(sourceLocation.profilePath, "Preferences"));
    if (!availableSpecs.length && !hasSourcePreferences) {
      throw new ProfileManagerError("源 Profile 里没有找到可同步的账号数据。", "ACCOUNT_SYNC_SOURCE_EMPTY");
    }

    const backup = await this.createAccountSyncBackup(targetProfile, targetLocation);
    const copiedItems: AccountSyncCopiedItem[] = [];
    const skippedItems: AccountSyncSkippedItem[] = [];

    try {
      for (const spec of accountSyncCopySpecs()) {
        const sourcePath = path.join(sourceLocation.profilePath, spec.relativePath);
        if (!(await exists(sourcePath))) {
          skippedItems.push({
            label: spec.label,
            relativePath: spec.relativePath,
            reason: "源 Profile 中不存在"
          });
          continue;
        }

        const targetPath = path.join(targetLocation.profilePath, normalizeSafeRelativePath(spec.relativePath));
        await fs.rm(targetPath, { recursive: true, force: true });
        await copyAccountSyncPath(sourcePath, targetPath);
        copiedItems.push({
          label: spec.label,
          relativePath: spec.relativePath
        });
      }

      const preferencesMerged = await mergeAccountPreferenceValues(
        sourceLocation.profilePath,
        targetLocation.profilePath
      );
      if (preferencesMerged) {
        copiedItems.push({
          label: "账号偏好",
          relativePath: "Preferences"
        });
      } else {
        skippedItems.push({
          label: "账号偏好",
          relativePath: "Preferences",
          reason: "源 Profile 中不存在可合并的账号偏好"
        });
      }

      let launchedTarget = false;
      if (launchTarget) {
        await this.launchProfile(targetProfileId);
        launchedTarget = true;
      }

      return {
        sourceProfileId,
        targetProfileId,
        copiedItems,
        skippedItems,
        backup,
        launchedTarget,
        state: await this.getState()
      };
    } catch (error) {
      try {
        await this.restoreAccountSyncBackupMetadata(await this.readAccountSyncBackupMetadata(backup.id));
      } catch {
        // Keep the original account sync error visible.
      }
      throw error;
    }
  }

  async listAccountSyncBackups(): Promise<AccountSyncBackupSummary[]> {
    await fs.mkdir(this.accountSyncBackupDir, { recursive: true });
    const entries = await fs.readdir(this.accountSyncBackupDir, { withFileTypes: true }).catch(() => []);
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<AccountSyncBackupSummary | null> => {
          try {
            return summarizeAccountSyncBackup(await this.readAccountSyncBackupMetadata(entry.name));
          } catch {
            return null;
          }
        })
    );

    return backups
      .filter((backup): backup is AccountSyncBackupSummary => Boolean(backup))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restoreAccountSyncBackup(backupId: string): Promise<AccountSyncRestoreResult> {
    const metadata = await this.readAccountSyncBackupMetadata(backupId);
    const state = await this.getState();
    const targetProfile = state.profiles.find((profile) => profile.id === metadata.targetProfileId);
    if (targetProfile?.running) {
      throw new ProfileManagerError("恢复账号同步备份前请先关闭目标 Profile。", "TARGET_PROFILE_RUNNING");
    }

    await this.restoreAccountSyncBackupMetadata(metadata);

    return {
      backup: summarizeAccountSyncBackup(metadata),
      state: await this.getState()
    };
  }

  private async launchNativeProfile(dirName: string): Promise<void> {
    const profiles = await scanNativeChromeProfiles();
    const profile = profiles.find((item) => item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
    }

    await launchChrome([`--profile-directory=${profile.dirName}`, "--no-first-run"]);
    const registry = await this.loadRegistry();
    registry.nativeProfiles = {
      ...(registry.nativeProfiles || {}),
      [profile.dirName]: {
        ...(registry.nativeProfiles?.[profile.dirName] || {}),
        lastLaunchedAt: new Date().toISOString()
      }
    };
    await this.saveRegistry(registry);
  }

  private async launchIsolatedProfile(id: string): Promise<void> {
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, id);
    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    await launchChrome([`--user-data-dir=${profilePath}`, "--no-first-run", ...(await getMigratedExtensionLaunchArgs(profile))]);
    profile.lastLaunchedAt = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  private async launchIsolatedProfileWithCdp(id: string, portInput?: number | null): Promise<void> {
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, id);
    const currentState = await this.getState();
    const currentProfile = currentState.profiles.find((item) => item.id === makeIsolatedProfileId(id));
    if (currentProfile?.running) {
      throw new ProfileManagerError("请先关闭这个 Profile，再用 CDP 模式启动。", "PROFILE_RUNNING");
    }

    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    const requestedPort = normalizeCdpPortInput(portInput);
    const cdpPort = requestedPort ?? (await findAvailableCdpPort(profile.lastCdpPort || 9222));
    if (!(await isPortAvailable(cdpPort))) {
      const owner = await describePortOwner(cdpPort);
      const detail = owner ? `，占用者：${owner}` : "";
      throw new ProfileManagerError(`CDP 端口 ${cdpPort} 已被占用${detail}。`, "CDP_PORT_IN_USE");
    }

    await launchChrome([
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      ...(await getMigratedExtensionLaunchArgs(profile)),
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`
    ]);

    profile.lastLaunchedAt = new Date().toISOString();
    profile.lastCdpPort = cdpPort;
    await this.saveRegistry(registry);
    await waitForCdp(cdpPort, 6000);
  }

  private async launchProfileWithUrls(profileId: string, urls: string[]): Promise<void> {
    const ref = parseProfileId(profileId);
    if (!urls.length) {
      return;
    }

    if (ref.source === "native") {
      await this.launchNativeProfileWithUrls(ref.dirName, urls);
      return;
    }

    await this.launchIsolatedProfileWithUrls(ref.id, urls);
  }

  private async launchNativeProfileWithUrls(dirName: string, urls: string[]): Promise<void> {
    const profiles = await scanNativeChromeProfiles();
    const profile = profiles.find((item) => item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
    }

    await launchChrome([`--profile-directory=${profile.dirName}`, "--no-first-run", ...urls]);
    const registry = await this.loadRegistry();
    registry.nativeProfiles = {
      ...(registry.nativeProfiles || {}),
      [profile.dirName]: {
        ...(registry.nativeProfiles?.[profile.dirName] || {}),
        lastLaunchedAt: new Date().toISOString()
      }
    };
    await this.saveRegistry(registry);
  }

  private async launchIsolatedProfileWithUrls(id: string, urls: string[]): Promise<void> {
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, id);
    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    await launchChrome([
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      ...(await getMigratedExtensionLaunchArgs(profile)),
      ...urls
    ]);
    profile.lastLaunchedAt = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  private async deleteNativeProfile(dirName: string): Promise<DeleteProfileResult> {
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.source === "native" && item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
    }
    if (profile.isDefault) {
      throw new ProfileManagerError("默认 Chrome Profile 受保护，不能删除。", "DEFAULT_PROFILE_PROTECTED");
    }
    if (await isChromeRunning()) {
      throw new ProfileManagerError("删除 Chrome Profile 前请先退出 Chrome。", "CHROME_RUNNING");
    }
    if (profile.running) {
      throw new ProfileManagerError("删除前请先关闭这个 Chrome Profile。", "PROFILE_RUNNING");
    }

    const trashPath = await this.moveToTrash(profile.path, profile.dirName);
    await removeNativeProfileFromLocalState(profile.dirName);
    const registry = await this.loadRegistry();
    if (registry.nativeProfiles) {
      delete registry.nativeProfiles[profile.dirName];
      await this.saveRegistry(registry);
    }

    return {
      deletedProfile: profile,
      trashPath,
      state: await this.getState()
    };
  }

  private async deleteIsolatedProfile(id: string): Promise<DeleteProfileResult> {
    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, id);
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.source === "isolated" && item.id === makeIsolatedProfileId(id));
    if (profile?.running) {
      throw new ProfileManagerError("删除前请先关闭这个 Chrome Profile。", "PROFILE_RUNNING");
    }

    const publicProfile = profile || (await this.toIsolatedPublicProfile(storedProfile, new Map()));
    const trashPath = await this.moveToTrash(this.isolatedProfilePath(storedProfile), storedProfile.dirName);
    const nextProfiles = registry.profiles.filter((item) => item.id !== id);
    await this.saveRegistry({ ...registry, profiles: nextProfiles });

    return {
      deletedProfile: publicProfile,
      trashPath,
      state: await this.getState()
    };
  }

  private async pathForRef(ref: ProfileRef): Promise<string> {
    if (ref.source === "native") {
      const profile = (await scanNativeChromeProfiles()).find((item) => item.dirName === ref.dirName);
      if (!profile) {
        throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
      }

      return profile.path;
    }

    const registry = await this.loadRegistry();
    return this.isolatedProfilePath(this.findIsolatedProfile(registry, ref.id));
  }

  private async ensureStore(): Promise<void> {
    await fs.mkdir(this.profilesDir, { recursive: true });

    try {
      await fs.access(this.registryPath);
    } catch {
      await this.saveRegistry({ profiles: [], nativeProfiles: {} });
    }
  }

  private async loadRegistry(): Promise<Registry> {
    await this.ensureStore();

    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Registry>;
      const nativeProfiles =
        parsed.nativeProfiles && typeof parsed.nativeProfiles === "object"
          ? normalizeNativeProfileMetadata(parsed.nativeProfiles)
          : {};

      return {
        profiles: Array.isArray(parsed.profiles)
          ? (parsed.profiles.map(normalizeProfile).filter(Boolean) as StoredProfile[])
          : [],
        nativeProfiles
      };
    } catch {
      const backup = `${this.registryPath}.broken-${Date.now()}`;
      try {
        await fs.rename(this.registryPath, backup);
      } catch {
        // Start clean if the broken registry cannot be backed up.
      }
      return { profiles: [], nativeProfiles: {} };
    }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.registryPath);
  }

  private async getRuntime(profilePaths: string[], nativeDirNames: string[]): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
        maxBuffer: 1024 * 1024 * 8
      });

      for (const line of stdout.split("\n")) {
        const processInfo = parseRuntimeProcess(line);
        if (!processInfo) {
          continue;
        }

        const { command } = processInfo;

        // A normally opened Chrome often does not include --profile-directory.
        // Treat that main browser process as the Default profile.
        if (defaultNativeKey && isImplicitDefaultChromeProcess(command)) {
          addRuntimeProcess(runtime, defaultNativeKey, processInfo);
        }

        for (const profilePath of profilePaths) {
          if (!command.includes("--user-data-dir=") || !command.includes(profilePath)) {
            continue;
          }
          addRuntimeProcess(runtime, profilePath, processInfo);
        }

        for (const dirName of nativeDirNames) {
          if (!command.includes("--profile-directory=") || !command.includes(`--profile-directory=${dirName}`)) {
            continue;
          }
          addRuntimeProcess(runtime, makeNativeRuntimeKey(dirName), processInfo);
        }
      }

      await attachListeningPorts(runtime);
    } catch {
      return runtime;
    }

    return runtime;
  }

  private toNativePublicProfile(
    profile: NativeChromeProfile,
    registry: Registry,
    runtime: Map<string, RuntimeProfile>
  ): PublicProfile {
    const runtimeProfile = mergeRuntimeProfiles(runtime.get(profile.path), runtime.get(makeNativeRuntimeKey(profile.dirName)));

    return {
      id: makeNativeProfileId(profile.dirName),
      source: "native",
      name: registry.nativeProfiles?.[profile.dirName]?.name || profile.name,
      dirName: profile.dirName,
      path: profile.path,
      createdAt: null,
      lastLaunchedAt: runtimeProfile.startedAt || registry.nativeProfiles?.[profile.dirName]?.lastLaunchedAt || null,
      userName: profile.userName,
      isDefault: profile.isDefault,
      deletable: !profile.isDefault,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids,
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      listeningPorts: runtimeProfile.listeningPorts
    };
  }

  private async toIsolatedPublicProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): Promise<PublicProfile> {
    const profilePath = this.isolatedProfilePath(profile);
    const runtimeProfile = runtime.get(profilePath) || emptyRuntimeProfile();
    const userName = await readIsolatedProfileUserName(profilePath);

    return {
      id: makeIsolatedProfileId(profile.id),
      source: "isolated",
      name: profile.name,
      dirName: profile.dirName,
      path: profilePath,
      createdAt: profile.createdAt,
      lastLaunchedAt: runtimeProfile.startedAt || profile.lastLaunchedAt,
      userName,
      isDefault: false,
      deletable: true,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids,
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      listeningPorts: runtimeProfile.listeningPorts
    };
  }

  private async createExtensionMigrationBackup(
    targetProfile: PublicProfile,
    selectedExtensions: ProfileExtensionInfo[],
    targetProfileDataPath: string
  ): Promise<ExtensionMigrationBackupSummary> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `${stamp}-${makeSlug(targetProfile.name || targetProfile.dirName)}`;
    const backupPath = path.join(this.extensionBackupDir, id);
    const snapshotPath = path.join(backupPath, "snapshot");
    await fs.mkdir(snapshotPath, { recursive: true });

    const itemRelativePaths = uniqueStrings(
      [
        "Preferences",
        "Secure Preferences",
        "Extensions",
        ...selectedExtensions.flatMap((extension) => extensionDataRelativePaths(extension.id))
      ].filter(Boolean)
    );

    const items = await Promise.all(
      itemRelativePaths.map(async (relativePath) => {
        const sourcePath = path.join(targetProfileDataPath, relativePath);
        const existed = await exists(sourcePath);
        if (existed) {
          await copyPath(sourcePath, path.join(snapshotPath, relativePath));
        }

        return {
          relativePath,
          existed
        };
      })
    );

    const metadata: ExtensionMigrationBackupMetadata = {
      id,
      createdAt: new Date().toISOString(),
      path: backupPath,
      targetProfileId: targetProfile.id,
      targetProfileName: targetProfile.name,
      targetProfilePath: targetProfileDataPath,
      itemCount: items.length,
      items,
      targetMigratedExtensions: await this.getMigratedExtensionsSnapshot(targetProfile)
    };

    await fs.writeFile(path.join(backupPath, "backup.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return summarizeExtensionMigrationBackup(metadata);
  }

  private async resolveChromeProfileDataPath(profile: PublicProfile, ensureProfilePath = false): Promise<string> {
    if (profile.source === "native") {
      return profile.path;
    }

    const profileDataPath = await resolveIsolatedProfileDataPath(profile.path);
    if (ensureProfilePath) {
      await fs.mkdir(profileDataPath, { recursive: true });
    }

    return profileDataPath;
  }

  private async copyLocalExtensionToIsolatedProfile(
    extension: ProfileExtensionInfo,
    targetProfile: PublicProfile
  ): Promise<string> {
    if (!extension.path) {
      throw new ProfileManagerError(`插件 ${extension.name} 没有可复制的插件包目录。`, "EXTENSION_PATH_MISSING");
    }

    const versionSlug = makePathSegment(extension.version || "unknown-version");
    const targetPath = path.join(targetProfile.path, "Migrated Extensions", extension.id, versionSlug);
    await fs.rm(targetPath, { recursive: true, force: true });
    await copyPath(extension.path, targetPath);
    return targetPath;
  }

  private async mergeMigratedExtensions(
    targetProfile: PublicProfile,
    copiedExtensions: StoredMigratedExtension[]
  ): Promise<void> {
    if (targetProfile.source !== "isolated") {
      return;
    }

    const ref = parseProfileId(targetProfile.id);
    if (ref.source !== "isolated") {
      return;
    }

    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, ref.id);
    const existing = storedProfile.migratedExtensions || [];
    const copiedIds = new Set(copiedExtensions.map((extension) => extension.id));
    storedProfile.migratedExtensions = [
      ...existing.filter((extension) => !copiedIds.has(extension.id)),
      ...copiedExtensions
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.saveRegistry(registry);
  }

  private async getMigratedExtensionsSnapshot(targetProfile: PublicProfile): Promise<StoredMigratedExtension[]> {
    if (targetProfile.source !== "isolated") {
      return [];
    }

    const ref = parseProfileId(targetProfile.id);
    if (ref.source !== "isolated") {
      return [];
    }

    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, ref.id);
    return [...(storedProfile.migratedExtensions || [])];
  }

  private async discardMigratedExtensions(
    targetProfile: PublicProfile,
    copiedExtensions: StoredMigratedExtension[]
  ): Promise<void> {
    if (targetProfile.source !== "isolated" || !copiedExtensions.length) {
      return;
    }

    const ref = parseProfileId(targetProfile.id);
    if (ref.source !== "isolated") {
      return;
    }

    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, ref.id);
    const copiedIds = new Set(copiedExtensions.map((extension) => extension.id));
    storedProfile.migratedExtensions = (storedProfile.migratedExtensions || []).filter(
      (extension) => !copiedIds.has(extension.id)
    );
    await this.saveRegistry(registry);
  }

  private async removeMigratedExtensionReference(profile: PublicProfile, extensionId: string): Promise<void> {
    if (profile.source !== "isolated") {
      return;
    }

    const ref = parseProfileId(profile.id);
    if (ref.source !== "isolated") {
      return;
    }

    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, ref.id);
    const beforeCount = storedProfile.migratedExtensions?.length || 0;
    storedProfile.migratedExtensions = (storedProfile.migratedExtensions || []).filter(
      (extension) => extension.sourceExtensionId !== extensionId && extension.id !== makeStoredMigratedExtensionId(extensionId)
    );
    if ((storedProfile.migratedExtensions || []).length !== beforeCount) {
      await this.saveRegistry(registry);
    }
  }

  private async readExtensionMigrationBackupMetadata(backupId: string): Promise<ExtensionMigrationBackupMetadata> {
    const safeId = path.basename(String(backupId || ""));
    if (!safeId || safeId !== backupId) {
      throw new ProfileManagerError("备份 ID 无效。", "INVALID_BACKUP_ID");
    }

    const raw = await fs.readFile(path.join(this.extensionBackupDir, safeId, "backup.json"), "utf8");
    const parsed = JSON.parse(raw) as ExtensionMigrationBackupMetadata;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.targetProfilePath !== "string" ||
      !Array.isArray(parsed.items)
    ) {
      throw new ProfileManagerError("备份元数据无效。", "INVALID_BACKUP_METADATA");
    }

    return parsed;
  }

  private async restoreBackupMetadata(metadata: ExtensionMigrationBackupMetadata): Promise<void> {
    const snapshotPath = path.join(metadata.path, "snapshot");
    for (const item of metadata.items) {
      const relativePath = normalizeSafeRelativePath(item.relativePath);
      const targetPath = path.join(metadata.targetProfilePath, relativePath);
      const backupItemPath = path.join(snapshotPath, relativePath);

      await fs.rm(targetPath, { recursive: true, force: true });
      if (item.existed && (await exists(backupItemPath))) {
        await copyPath(backupItemPath, targetPath);
      }
    }

    await this.restoreMigratedExtensionsSnapshot(metadata);
  }

  private async restoreMigratedExtensionsSnapshot(metadata: ExtensionMigrationBackupMetadata): Promise<void> {
    if (!metadata.targetProfileId.startsWith("isolated:") || !metadata.targetMigratedExtensions) {
      return;
    }

    const ref = parseProfileId(metadata.targetProfileId);
    if (ref.source !== "isolated") {
      return;
    }

    const registry = await this.loadRegistry();
    const storedProfile = registry.profiles.find((profile) => profile.id === ref.id);
    if (!storedProfile) {
      return;
    }

    storedProfile.migratedExtensions = metadata.targetMigratedExtensions;
    await this.saveRegistry(registry);
  }

  private async resolveAccountSyncLocation(
    profile: PublicProfile,
    ensureProfilePath: boolean
  ): Promise<AccountSyncDataLocation> {
    if (profile.source === "native") {
      return {
        userDataPath: nativeChromeUserDataDir(),
        profilePath: profile.path
      };
    }

    const rootPath = profile.path;
    const defaultProfilePath = path.join(rootPath, "Default");
    const rootScore = await accountSyncDataScore(rootPath);
    const defaultScore = await accountSyncDataScore(defaultProfilePath);
    const profilePath = defaultScore > 0 || rootScore === 0 ? defaultProfilePath : rootPath;

    if (ensureProfilePath) {
      await fs.mkdir(profilePath, { recursive: true });
    }

    return {
      userDataPath: rootPath,
      profilePath
    };
  }

  private async createAccountSyncBackup(
    targetProfile: PublicProfile,
    targetLocation: AccountSyncDataLocation
  ): Promise<AccountSyncBackupSummary> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `${stamp}-${makeSlug(targetProfile.name || targetProfile.dirName)}`;
    const backupPath = path.join(this.accountSyncBackupDir, id);
    const snapshotPath = path.join(backupPath, "snapshot");
    await fs.mkdir(snapshotPath, { recursive: true });

    const itemRelativePaths = accountSyncBackupRelativePaths();
    const items = await Promise.all(
      itemRelativePaths.map(async (relativePath) => {
        const sourcePath = path.join(targetLocation.profilePath, relativePath);
        const existed = await exists(sourcePath);
        if (existed) {
          await copyAccountSyncPath(sourcePath, path.join(snapshotPath, relativePath));
        }

        return {
          relativePath,
          existed
        };
      })
    );

    const metadata: AccountSyncBackupMetadata = {
      id,
      createdAt: new Date().toISOString(),
      path: backupPath,
      targetProfileId: targetProfile.id,
      targetProfileName: targetProfile.name,
      targetProfilePath: targetLocation.profilePath,
      targetUserDataPath: targetLocation.userDataPath,
      itemCount: items.length,
      items
    };

    await fs.writeFile(path.join(backupPath, "backup.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return summarizeAccountSyncBackup(metadata);
  }

  private async readAccountSyncBackupMetadata(backupId: string): Promise<AccountSyncBackupMetadata> {
    const safeId = path.basename(String(backupId || ""));
    if (!safeId || safeId !== backupId) {
      throw new ProfileManagerError("账号同步备份 ID 无效。", "INVALID_BACKUP_ID");
    }

    const raw = await fs.readFile(path.join(this.accountSyncBackupDir, safeId, "backup.json"), "utf8");
    const parsed = JSON.parse(raw) as AccountSyncBackupMetadata;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.targetProfilePath !== "string" ||
      typeof parsed.targetUserDataPath !== "string" ||
      !Array.isArray(parsed.items)
    ) {
      throw new ProfileManagerError("账号同步备份元数据无效。", "INVALID_BACKUP_METADATA");
    }

    return parsed;
  }

  private async restoreAccountSyncBackupMetadata(metadata: AccountSyncBackupMetadata): Promise<void> {
    const snapshotPath = path.join(metadata.path, "snapshot");
    for (const item of metadata.items) {
      const relativePath = normalizeSafeRelativePath(item.relativePath);
      const targetPath = path.join(metadata.targetProfilePath, relativePath);
      const backupItemPath = path.join(snapshotPath, relativePath);

      await fs.rm(targetPath, { recursive: true, force: true });
      if (item.existed && (await exists(backupItemPath))) {
        await copyAccountSyncPath(backupItemPath, targetPath);
      }
    }
  }

  private findIsolatedProfile(registry: Registry, id: string): StoredProfile {
    const profile = registry.profiles.find((item) => item.id === id);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Profile。", "PROFILE_NOT_FOUND");
    }

    return profile;
  }

  private isolatedProfilePath(profile: StoredProfile): string {
    return path.join(this.profilesDir, profile.dirName);
  }

  private async getPublicProfile(profileId: string): Promise<PublicProfile> {
    const ref = parseProfileId(profileId);
    const expectedId = ref.source === "native" ? makeNativeProfileId(ref.dirName) : makeIsolatedProfileId(ref.id);
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.id === expectedId);

    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Profile。", "PROFILE_NOT_FOUND");
    }

    return profile;
  }

  private getLauncherLabel(): string {
    if (process.env.CHROME_BINARY) {
      return process.env.CHROME_BINARY;
    }

    if (process.platform === "darwin") {
      return process.env.CHROME_APP_NAME || "Google Chrome";
    }

    if (process.platform === "win32") {
      return "chrome";
    }

    return "google-chrome";
  }

  private async moveToTrash(sourcePath: string, dirName: string): Promise<string | null> {
    if (!(await exists(sourcePath))) {
      return null;
    }

    const trashRoot =
      process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : path.join(this.dataDir, "trash");
    await fs.mkdir(trashRoot, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let targetPath = path.join(trashRoot, `${dirName}-${stamp}`);
    let counter = 1;
    while (await exists(targetPath)) {
      targetPath = path.join(trashRoot, `${dirName}-${stamp}-${counter}`);
      counter += 1;
    }

    await fs.rename(sourcePath, targetPath);
    return targetPath;
  }

  private async waitUntilProfileStops(profileId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(150);
      const state = await this.getState();
      const profile = state.profiles.find((item) => item.id === profileId);
      if (!profile?.running) {
        return;
      }
    }
  }
}

export function createProfileManager(): ProfileManager {
  return new ProfileManager(process.env.CPM_DATA_DIR || defaultDataDir());
}

function defaultDataDir(): string {
  const preferred = appDataDir(APP_DATA_DIR_NAME);
  const legacy = appDataDir(LEGACY_APP_DATA_DIR_NAME);
  if (existsSync(path.join(legacy, "profiles.json"))) {
    return legacy;
  }

  return preferred;
}

function appDataDir(name: string): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", name);
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), name);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), makeSlug(name));
}

function makeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "profile";
}

function normalizeProfileName(nameInput: string): string {
  const name = String(nameInput || "").trim();
  if (!name || name.length > 80) {
    throw new ProfileManagerError("Profile 名称长度必须是 1-80 个字符。", "INVALID_PROFILE_NAME");
  }

  return name;
}

async function launchChrome(args: string[]): Promise<void> {
  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, args);
  } else if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", process.env.CHROME_APP_NAME || "Google Chrome", "--args", ...args]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", ...args]);
  } else {
    launchDetached("google-chrome", args);
  }
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessGoneError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

async function focusProfileWindow(pids: number[]): Promise<boolean> {
  if (process.platform !== "darwin") {
    throw new ProfileManagerError("当前只支持在 macOS 上把 Profile 窗口显示到最前面。", "FOCUS_UNSUPPORTED");
  }

  let lastError: unknown = null;
  let activatedAnyProcess = false;
  for (const pid of pids) {
    try {
      const raisedWindow = await focusMacProcess(pid);
      activatedAnyProcess = true;
      if (raisedWindow) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (activatedAnyProcess) {
    return false;
  }

  const detail = lastError instanceof Error && lastError.message ? ` ${lastError.message}` : "";
  throw new ProfileManagerError(
    `无法把这个 Chrome Profile 窗口显示到最前面。${detail}`,
    "FOCUS_PROFILE_FAILED"
  );
}

async function focusMacProcess(pid: number): Promise<boolean> {
  await activateMacProcess(pid);

  const script = `
tell application "System Events"
  set targetProcesses to every process whose unix id is ${pid}
  if (count of targetProcesses) is 0 then error "Process not found"
  set targetProcess to item 1 of targetProcesses
	  tell targetProcess
	    set visible to true
	    set raisedWindow to false
	    try
	      repeat with targetWindow in windows
	        try
	          set value of attribute "AXMinimized" of targetWindow to false
	        end try
      end repeat
	    end try
	    if (count of windows) is greater than 0 then
	      perform action "AXRaise" of window 1
	      set raisedWindow to true
	    end if
	    return raisedWindow
	  end tell
	end tell
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.trim().toLowerCase() === "true";
  } catch {
    // NSRunningApplication activation already brought the app process forward.
    // Window enumeration can fail for Chrome's separate profile instances on macOS.
    return false;
  }
}

async function hasRendererProcessForProfile(profilePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8
    });

    return stdout.split("\n").some((command) => {
      return (
        command.includes("Google Chrome Helper (Renderer)") &&
        command.includes("--type=renderer") &&
        command.includes(`--user-data-dir=${profilePath}`)
      );
    });
  } catch {
    return true;
  }
}

async function requestIsolatedProfileWindow(profile: PublicProfile): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const command = getDirectChromeCommand();
  if (!command) {
    throw new ProfileManagerError("找不到可直接唤起窗口的 Chrome 二进制。", "FOCUS_PROFILE_FAILED");
  }

  launchDetached(command, [`--user-data-dir=${profile.path}`, "--no-first-run"]);
}

function getDirectChromeCommand(): string | null {
  if (process.env.CHROME_BINARY) {
    return process.env.CHROME_BINARY;
  }

  if (process.platform !== "darwin") {
    return null;
  }

  const appName = process.env.CHROME_APP_NAME || "Google Chrome";
  const command = `/Applications/${appName}.app/Contents/MacOS/${appName}`;
  return existsSync(command) ? command : null;
}

async function activateMacProcess(pid: number): Promise<void> {
  const script = `
ObjC.import("AppKit");
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (!app) {
  throw new Error("Process not found");
}
const activated = app.activateWithOptions(
  $.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows
);
if (!activated) {
  throw new Error("Activate failed");
}
`;

  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
}

function normalizeProfile(profile: unknown): StoredProfile | null {
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
    migratedExtensions: Array.isArray(candidate.migratedExtensions)
      ? candidate.migratedExtensions
          .map(normalizeStoredMigratedExtension)
          .filter((item): item is StoredMigratedExtension => Boolean(item))
      : []
  };
}

function normalizeStoredMigratedExtension(extension: unknown): StoredMigratedExtension | null {
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

async function readIsolatedProfileUserName(profileRootPath: string): Promise<string | null> {
  const profileDataPath = await resolveIsolatedProfileDataPath(profileRootPath);
  const preferences = await readJsonFile<Record<string, unknown>>(path.join(profileDataPath, "Preferences"));
  if (!preferences) {
    return null;
  }

  return accountDisplayNameFromPreferences(preferences);
}

async function resolveIsolatedProfileDataPath(profileRootPath: string): Promise<string> {
  const defaultProfilePath = path.join(profileRootPath, "Default");
  const [rootScore, defaultScore] = await Promise.all([
    accountSyncDataScore(profileRootPath),
    accountSyncDataScore(defaultProfilePath)
  ]);

  if (defaultScore > 0 || (await exists(defaultProfilePath)) || rootScore === 0) {
    return defaultProfilePath;
  }

  return profileRootPath;
}

function accountDisplayNameFromPreferences(preferences: Record<string, unknown>): string | null {
  const accountInfoValue = preferences.account_info;
  if (Array.isArray(accountInfoValue)) {
    for (const accountInfo of accountInfoValue) {
      const label = accountDisplayNameFromRecord(accountInfo);
      if (label) {
        return label;
      }
    }
  } else {
    const label = accountDisplayNameFromRecord(accountInfoValue);
    if (label) {
      return label;
    }
  }

  return (
    stringValue(getNestedValue(preferences, ["profile", "user_name"])) ||
    stringValue(getNestedValue(preferences, ["profile", "gaia_name"])) ||
    stringValue(getNestedValue(preferences, ["google", "services", "username"])) ||
    stringValue(getNestedValue(preferences, ["google", "services", "last_username"])) ||
    null
  );
}

function accountDisplayNameFromRecord(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return (
    stringValue(value.email) ||
    stringValue(value.account_email) ||
    stringValue(value.full_name) ||
    stringValue(value.gaia_name) ||
    stringValue(value.name) ||
    null
  );
}

async function scanProfileExtensions(profilePath: string): Promise<ProfileExtensionInfo[]> {
  const preferences = await readChromePreferences(profilePath);
  const securePreferences = await readChromeSecurePreferences(profilePath);
  const settings = {
    ...(securePreferences.extensions?.settings || {}),
    ...(preferences.extensions?.settings || {})
  };
  const directoryIds = await readExtensionDirectoryIds(profilePath);
  const extensionIds = uniqueStrings([...Object.keys(settings), ...directoryIds]).filter(isLikelyExtensionId);
  const extensions = await Promise.all(
    extensionIds.map((extensionId) => scanProfileExtension(profilePath, extensionId, settings[extensionId]))
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

function isUserManageableExtension(extension: ProfileExtensionInfo): boolean {
  return extension.installType !== "component";
}

async function scanProfileExtension(
  profilePath: string,
  extensionId: string,
  setting?: ChromeExtensionSetting
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
    canCopyLocally: Boolean(extensionPath && installType !== "component")
  };
}

async function readChromePreferences(profilePath: string): Promise<ChromePreferences> {
  return (await readJsonFile<ChromePreferences>(path.join(profilePath, "Preferences"))) || {};
}

async function readChromeSecurePreferences(profilePath: string): Promise<ChromePreferences> {
  return (await readJsonFile<ChromePreferences>(path.join(profilePath, "Secure Preferences"))) || {};
}

async function readExtensionDirectoryIds(profilePath: string): Promise<string[]> {
  const extensionsPath = path.join(profilePath, "Extensions");
  const entries = await fs.readdir(extensionsPath, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && isLikelyExtensionId(entry.name)).map((entry) => entry.name);
}

async function findExtensionManifestDirectory(
  profilePath: string,
  extensionId: string,
  setting?: ChromeExtensionSetting
): Promise<string | null> {
  const candidates: string[] = [];
  const settingPath = stringValue(setting?.path);
  if (settingPath) {
    if (path.isAbsolute(settingPath)) {
      candidates.push(settingPath);
    } else {
      candidates.push(path.join(profilePath, settingPath));
      candidates.push(path.join(profilePath, "Extensions", extensionId, settingPath));
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

async function resolveManifestDirectory(candidatePath: string): Promise<string | null> {
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

async function readManifest(extensionPath: string): Promise<ChromeExtensionManifest | null> {
  const manifest = await readJsonFile<ChromeExtensionManifest>(path.join(extensionPath, "manifest.json"));
  return isRecord(manifest) ? manifest : null;
}

async function resolveManifestText(value: string, extensionPath: string, manifest: ChromeExtensionManifest): Promise<string> {
  const messageKey = parseManifestMessageKey(value);
  if (!messageKey) {
    return value;
  }

  const defaultLocale = stringValue(manifest.default_locale);
  const locales = uniqueStrings([defaultLocale, "zh_CN", "zh", "en", "en_US"].filter(Boolean) as string[]);
  for (const locale of locales) {
    const message = await readLocaleMessage(extensionPath, locale, messageKey);
    if (message) {
      return message;
    }
  }

  return value;
}

function parseManifestMessageKey(value: string): string | null {
  const match = value.match(/^__MSG_([A-Za-z0-9_@]+)__$/);
  return match ? match[1] : null;
}

async function readLocaleMessage(extensionPath: string, locale: string, messageKey: string): Promise<string | null> {
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

function detectInstallType(
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

function isExtensionEnabled(setting: ChromeExtensionSetting | undefined): boolean {
  if (!setting) {
    return false;
  }

  const state = numberValue(setting.state);
  if (state !== null) {
    return state === 1;
  }

  return !hasDisableReason(setting.disable_reasons) && !hasDisableReason(setting.disable_reason);
}

function hasDisableReason(value: unknown): boolean {
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

async function collectExtensionDataPaths(profilePath: string, extensionId: string): Promise<ExtensionDataPath[]> {
  const specs = extensionDataRelativePaths(extensionId).map((relativePath) => ({
    label: extensionDataLabel(relativePath),
    relativePath,
    path: path.join(profilePath, relativePath)
  }));
  const existing = await Promise.all(specs.map(async (spec) => ((await exists(spec.path)) ? spec : null)));

  return existing.filter((spec): spec is ExtensionDataPath => Boolean(spec));
}

function extensionDataRelativePaths(extensionId: string): string[] {
  return [
    path.join("Local Extension Settings", extensionId),
    path.join("Sync Extension Settings", extensionId),
    path.join("Managed Extension Settings", extensionId),
    path.join("IndexedDB", `chrome-extension_${extensionId}_0.indexeddb.leveldb`),
    path.join("File System", `chrome-extension_${extensionId}`),
    path.join("databases", `chrome-extension_${extensionId}_0`)
  ];
}

function extensionDeleteRelativePaths(extensionId: string): string[] {
  return uniqueStrings([
    path.join("Extensions", extensionId),
    path.join("Migrated Extensions", extensionId),
    ...extensionDataRelativePaths(extensionId)
  ]);
}

function extensionDataLabel(relativePath: string): string {
  return relativePath.split(path.sep)[0] || relativePath;
}

async function copyExtensionDataPath(
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
  await fs.rm(targetPath, { recursive: true, force: true });
  await copyPath(sourcePath, targetPath);
  return true;
}

function accountSyncCopySpecs(): AccountSyncPathSpec[] {
  return [
    { label: "Cookies", relativePath: "Cookies" },
    { label: "Cookies journal", relativePath: "Cookies-journal" },
    { label: "Cookies WAL", relativePath: "Cookies-wal" },
    { label: "Cookies SHM", relativePath: "Cookies-shm" },
    { label: "Network Cookies", relativePath: path.join("Network", "Cookies") },
    { label: "Network Cookies journal", relativePath: path.join("Network", "Cookies-journal") },
    { label: "Network Cookies WAL", relativePath: path.join("Network", "Cookies-wal") },
    { label: "Network Cookies SHM", relativePath: path.join("Network", "Cookies-shm") },
    { label: "Extension Cookies", relativePath: "Extension Cookies" },
    { label: "Extension Cookies journal", relativePath: "Extension Cookies-journal" },
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
    { label: "Sync Extension Settings", relativePath: "Sync Extension Settings" },
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

function accountSyncBackupRelativePaths(): string[] {
  return uniqueStrings(["Preferences", ...accountSyncCopySpecs().map((spec) => spec.relativePath)]);
}

async function existingAccountSyncSpecs(profilePath: string): Promise<AccountSyncPathSpec[]> {
  const specs = accountSyncCopySpecs();
  const existing = await Promise.all(
    specs.map(async (spec): Promise<AccountSyncPathSpec | null> => ((await exists(path.join(profilePath, spec.relativePath))) ? spec : null))
  );

  return existing.filter((spec): spec is AccountSyncPathSpec => Boolean(spec));
}

async function accountSyncDataScore(profilePath: string): Promise<number> {
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

async function mergeAccountPreferenceValues(sourceProfilePath: string, targetProfilePath: string): Promise<boolean> {
  const sourcePath = path.join(sourceProfilePath, "Preferences");
  const targetPath = path.join(targetProfilePath, "Preferences");
  const sourcePreferences = await readJsonFile<Record<string, unknown>>(sourcePath);
  if (!sourcePreferences) {
    return false;
  }

  const targetPreferences = (await readJsonFile<Record<string, unknown>>(targetPath)) || {};
  let changed = false;

  for (const preferencePath of accountPreferencePaths()) {
    changed = copyPreferencePath(sourcePreferences, targetPreferences, preferencePath) || changed;
  }

  if (changed) {
    await writeJsonFileAtomic(targetPath, targetPreferences);
  }

  return changed;
}

function accountPreferencePaths(): string[] {
  return [
    "account_info",
    "account_tracker_service_last_update",
    "account_values",
    "dual_layer_user_pref_store.user_selected_sync_types",
    "gaia_cookie",
    "google.services",
    "profile.avatar_index",
    "profile.gaia_info_picture_file_name",
    "profile.gaia_info_picture_url",
    "profile.gaia_name",
    "profile.managed_user_id",
    "profile.user_name",
    "signin",
    "sync",
    "trusted_vault"
  ];
}

function copyPreferencePath(
  sourcePreferences: Record<string, unknown>,
  targetPreferences: Record<string, unknown>,
  preferencePath: string
): boolean {
  const pathParts = preferencePath.split(".");
  const sourceValue = getNestedValue(sourcePreferences, pathParts);
  if (sourceValue === undefined) {
    return deleteNestedValue(targetPreferences, pathParts);
  }

  setNestedValue(targetPreferences, pathParts, cloneJsonValue(sourceValue));
  return true;
}

function getNestedValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value;
  for (const pathPart of pathParts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, pathPart)) {
      return undefined;
    }
    current = current[pathPart];
  }

  return current;
}

function setNestedValue(target: Record<string, unknown>, pathParts: string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (const pathPart of pathParts.slice(0, -1)) {
    if (!isRecord(current[pathPart])) {
      current[pathPart] = {};
    }
    current = current[pathPart] as Record<string, unknown>;
  }

  current[pathParts[pathParts.length - 1]] = value;
}

function deleteNestedValue(target: Record<string, unknown>, pathParts: string[]): boolean {
  let current: Record<string, unknown> = target;
  for (const pathPart of pathParts.slice(0, -1)) {
    if (!isRecord(current[pathPart])) {
      return false;
    }
    current = current[pathPart] as Record<string, unknown>;
  }

  const finalPart = pathParts[pathParts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, finalPart)) {
    return false;
  }

  delete current[finalPart];
  return true;
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function summarizeAccountSyncBackup(metadata: AccountSyncBackupMetadata): AccountSyncBackupSummary {
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    path: metadata.path,
    targetProfileId: metadata.targetProfileId,
    targetProfileName: metadata.targetProfileName,
    targetProfilePath: metadata.targetProfilePath,
    itemCount: metadata.itemCount
  };
}

async function removeExtensionReferencesFromProfilePreferences(profilePath: string, extensionId: string): Promise<void> {
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

function removeExtensionReferences(value: unknown, extensionId: string): boolean {
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

async function getMigratedExtensionLaunchArgs(profile: StoredProfile): Promise<string[]> {
  const extensionPaths = uniqueStrings((profile.migratedExtensions || []).map((extension) => extension.path));
  const existingPaths: string[] = [];
  for (const extensionPath of extensionPaths) {
    if (await exists(path.join(extensionPath, "manifest.json"))) {
      existingPaths.push(extensionPath);
    }
  }

  return existingPaths.length ? [`--load-extension=${existingPaths.join(",")}`] : [];
}

function summarizeExtensionMigrationBackup(metadata: ExtensionMigrationBackupMetadata): ExtensionMigrationBackupSummary {
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    path: metadata.path,
    targetProfileId: metadata.targetProfileId,
    targetProfileName: metadata.targetProfileName,
    targetProfilePath: metadata.targetProfilePath,
    itemCount: metadata.itemCount
  };
}

function chromeWebStoreUrl(extensionId: string): string {
  return `https://chromewebstore.google.com/detail/${extensionId}`;
}

function makeStoredMigratedExtensionId(extensionId: string): string {
  return `migrated:${extensionId}`;
}

function makePathSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function versionFromExtensionPath(extensionPath: string | null): string | null {
  if (!extensionPath) {
    return null;
  }

  return path.basename(extensionPath).replace(/_\d+$/, "") || null;
}

function compareVersionDirectoryNames(a: string, b: string): number {
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

function isLikelyExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function copyPath(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
}

async function copyAccountSyncPath(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => path.basename(source) !== "LOCK"
  });
}

function normalizeSafeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    !normalized ||
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new ProfileManagerError("备份路径不安全，已停止操作。", "UNSAFE_PATH");
  }

  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeNativeProfileMetadata(input: Record<string, unknown>): Record<string, NativeProfileMetadata> {
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

async function scanNativeChromeProfiles(): Promise<NativeChromeProfile[]> {
  const userDataDir = nativeChromeUserDataDir();
  const localState = await readChromeLocalState();
  const infoCache = localState.profile?.info_cache || {};

  return Object.entries(infoCache)
    .map(([dirName, profile]) => ({
      dirName,
      name: typeof profile.name === "string" && profile.name.trim() ? profile.name : dirName,
      userName: typeof profile.user_name === "string" && profile.user_name.trim() ? profile.user_name : null,
      path: path.join(userDataDir, dirName),
      isDefault: dirName === "Default"
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

async function readChromeLocalState(): Promise<ChromeLocalState> {
  try {
    const raw = await fs.readFile(nativeChromeLocalStatePath(), "utf8");
    return JSON.parse(raw) as ChromeLocalState;
  } catch {
    return {};
  }
}

async function writeChromeLocalState(localState: ChromeLocalState): Promise<void> {
  const localStatePath = nativeChromeLocalStatePath();
  const backupPath = `${localStatePath}.cpm-backup-${Date.now()}`;
  const raw = await fs.readFile(localStatePath, "utf8");
  await fs.writeFile(backupPath, raw, "utf8");
  const tmpPath = `${localStatePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(localState, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, localStatePath);
}

async function removeNativeProfileFromLocalState(dirName: string): Promise<void> {
  const localState = await readChromeLocalState();
  if (!localState.profile?.info_cache?.[dirName]) {
    return;
  }

  delete localState.profile.info_cache[dirName];
  await writeChromeLocalState(localState);
}

function nativeChromeLocalStatePath(): string {
  return path.join(nativeChromeUserDataDir(), "Local State");
}

function nativeChromeUserDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "google-chrome");
}

function parseProfileId(profileId: string): ProfileRef {
  if (profileId.startsWith("native:")) {
    return { source: "native", dirName: profileId.slice("native:".length) };
  }

  if (profileId.startsWith("isolated:")) {
    return { source: "isolated", id: profileId.slice("isolated:".length) };
  }

  return { source: "isolated", id: profileId };
}

function makeNativeProfileId(dirName: string): string {
  return `native:${dirName}`;
}

function makeIsolatedProfileId(id: string): string {
  return `isolated:${id}`;
}

function makeNativeRuntimeKey(dirName: string): string {
  return `native:${dirName}`;
}

function parseRuntimeProcess(line: string): (RuntimeProfile & { pid: number; command: string }) | null {
  const match = line.match(
    /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
  );
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const startedAt = parsePsStartTime(match[2]);
  const command = match[3];

  return {
    pid,
    pids: [pid],
    startedAt,
    cdpPort: parseRemoteDebuggingPort(command),
    listeningPorts: [],
    command
  };
}

function parsePsStartTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function addRuntimeProcess(
  runtime: Map<string, RuntimeProfile>,
  key: string,
  processInfo: RuntimeProfile & { pid: number }
): void {
  const profile = runtime.get(key) || emptyRuntimeProfile();
  if (!profile.pids.includes(processInfo.pid)) {
    profile.pids.push(processInfo.pid);
  }
  profile.startedAt = earlierIsoDate(profile.startedAt, processInfo.startedAt);
  profile.cdpPort = profile.cdpPort || processInfo.cdpPort;
  profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(processInfo.listeningPorts)).sort(compareNumbers);
  runtime.set(key, profile);
}

async function attachListeningPorts(runtime: Map<string, RuntimeProfile>): Promise<void> {
  const knownPids = new Set<number>();
  for (const profile of runtime.values()) {
    for (const pid of profile.pids) {
      knownPids.add(pid);
    }
  }

  if (!knownPids.size) {
    return;
  }

  const portsByPid = await getListeningPortsByPid(knownPids);
  for (const profile of runtime.values()) {
    const listeningPorts = profile.pids.flatMap((pid) => portsByPid.get(pid) || []);
    profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(listeningPorts)).sort(compareNumbers);
  }
}

async function getListeningPortsByPid(targetPids: Set<number>): Promise<Map<number, number[]>> {
  const portsByPid = new Map<number, number[]>();

  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      maxBuffer: 1024 * 1024 * 8
    });

    for (const line of stdout.split("\n")) {
      const pid = parseLsofPid(line);
      if (!pid || !targetPids.has(pid)) {
        continue;
      }

      const port = parseLsofListeningPort(line);
      if (!port) {
        continue;
      }

      portsByPid.set(pid, uniqueNumbers([...(portsByPid.get(pid) || []), port]).sort(compareNumbers));
    }
  } catch {
    return portsByPid;
  }

  return portsByPid;
}

function parseLsofPid(line: string): number | null {
  const match = line.trim().match(/^\S+\s+(\d+)\s+/);
  if (!match || line.trim().startsWith("COMMAND")) {
    return null;
  }

  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseLsofListeningPort(line: string): number | null {
  const match = line.match(/TCP\s+.*:(\d+)\s+\(LISTEN\)$/);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  return isValidTcpPort(port) ? port : null;
}

function mergeRuntimeProfiles(...profiles: Array<RuntimeProfile | undefined>): RuntimeProfile {
  return profiles.reduce<RuntimeProfile>(
    (merged, profile) => {
      if (!profile) {
        return merged;
      }

      return {
        pids: uniqueNumbers(merged.pids.concat(profile.pids)),
        startedAt: earlierIsoDate(merged.startedAt, profile.startedAt),
        cdpPort: merged.cdpPort || profile.cdpPort,
        listeningPorts: uniqueNumbers(merged.listeningPorts.concat(profile.listeningPorts)).sort(compareNumbers)
      };
    },
    emptyRuntimeProfile()
  );
}

function emptyRuntimeProfile(): RuntimeProfile {
  return { pids: [], startedAt: null, cdpPort: null, listeningPorts: [] };
}

function parseRemoteDebuggingPort(command: string): number | null {
  const match = command.match(/--remote-debugging-port(?:=|\s+)(\d{1,5})(?:\s|$)/);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  return isValidCdpPort(port) ? port : null;
}

function makeCdpUrl(port: number | null): string | null {
  return port ? `http://127.0.0.1:${port}` : null;
}

function normalizeCdpPortInput(portInput?: number | null): number | null {
  if (portInput === undefined || portInput === null) {
    return null;
  }

  const port = Number(portInput);
  if (!isValidCdpPort(port)) {
    throw new ProfileManagerError("CDP 端口必须是 1024-65535 之间的整数。", "INVALID_CDP_PORT");
  }

  return port;
}

function isValidCdpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

async function findAvailableCdpPort(startPort: number): Promise<number> {
  const firstPort = isValidCdpPort(startPort) ? startPort : 9222;
  for (let port = firstPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new ProfileManagerError("没有找到可用的 CDP 端口。", "NO_CDP_PORT_AVAILABLE");
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: "127.0.0.1", port });
  });
}

async function describePortOwner(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      maxBuffer: 1024 * 1024
    });
    const ownerLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("COMMAND"));
    const match = ownerLine?.match(/^(\S+)\s+(\d+)\s+/);
    if (!match) {
      return null;
    }

    const commandName = match[1];
    const pid = Number(match[2]);
    const label = await processLabelForPid(pid, commandName);
    return `${label} (PID ${pid})`;
  } catch {
    return null;
  }
}

async function processLabelForPid(pid: number, fallback: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      maxBuffer: 1024 * 1024
    });
    const command = stdout.trim();
    if (command.includes("Google Chrome.app")) {
      return "Google Chrome";
    }
    if (command.includes("Electron.app")) {
      return "Electron";
    }
    if (command.includes("node")) {
      return "node";
    }
  } catch {
    // Fall through to lsof's command name.
  }

  return fallback;
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await requestCdpVersion(port);
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }

  const detail = lastError instanceof Error && lastError.message ? `最后一次错误：${lastError.message}` : "";
  throw new ProfileManagerError(
    `Chrome 已启动，但 CDP 没有在 127.0.0.1:${port} 响应。${detail}`,
    "CDP_NOT_READY"
  );
}

function requestCdpVersion(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json/version",
        timeout: 700
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${response.statusCode || "unknown"}`));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);
  });
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function earlierIsoDate(current: string | null, next: string | null): string | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return Date.parse(next) < Date.parse(current) ? next : current;
}

function isImplicitDefaultChromeProcess(command: string): boolean {
  return (
    isGoogleChromeMainProcess(command) &&
    !command.includes("--profile-directory=") &&
    !command.includes("--user-data-dir=")
  );
}

function isGoogleChromeMainProcess(command: string): boolean {
  if (command.includes("--type=") || command.includes("chrome_crashpad_handler")) {
    return false;
  }

  if (process.platform === "darwin") {
    return command.includes("/Google Chrome.app/Contents/MacOS/Google Chrome");
  }

  if (process.platform === "win32") {
    return /(^|[\\\s])chrome\.exe(\s|$)/i.test(command);
  }

  return /(^|\s)(\/\S+\/)?(google-chrome|google-chrome-stable|chromium|chromium-browser|chrome)(\s|$)/.test(
    command
  );
}

async function isChromeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8
    });
    return stdout
      .split("\n")
      .some((line) => line.includes("Google Chrome.app/Contents/MacOS/Google Chrome") || line.includes("Google Chrome Helper"));
  } catch {
    return true;
  }
}
