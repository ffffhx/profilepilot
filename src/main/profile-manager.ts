import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  AccountSyncCopiedItem,
  AccountSyncDiffItem,
  AccountSyncDiffResult,
  AccountSyncRecord,
  AccountSyncRequest,
  AccountSyncResult,
  AccountSyncSkippedItem,
  AppState,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionDataPath,
  ExtensionMigrationCopiedExtension,
  ExtensionMigrationDataCopy,
  ExtensionMigrationDiffItem,
  ExtensionMigrationDiffResult,
  ExtensionMigrationDiffStatus,
  ExtensionMigrationLoadedExtension,
  ExtensionMigrationManualLoadExtension,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionMigrationSkippedExtension,
  ExtensionScanResult,
  ExternalChromeInstance,
  NativeChromeProfile,
  NativeProfileMetadata,
  OperationPauseSignal,
  OperationProgressUpdate,
  ProfileExtensionInfo,
  ProfileExtensionInstallType,
  PublicProfile,
  Registry,
  StoredMigratedExtension,
  StoredProfile
} from "../shared/types";

const execFileAsync = promisify(execFile);

// ps 的 lstart 等列会跟随系统语言输出（中文环境下是“四  6/11 17:13:50 2026”），
// 而解析逻辑依赖英文格式，所以调用 ps 时统一强制 POSIX locale。
const POSIX_LOCALE_ENV: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };

export const APP_TITLE = "ProfilePilot";
const APP_DATA_DIR_NAME = "ProfilePilot";
const LEGACY_APP_DATA_DIR_NAME = "Codex Chrome Profile Manager";
const CHROME_REMOTE_DEBUGGING_URL = "chrome://inspect/#remote-debugging";

type ProfileRef = { source: "native"; dirName: string } | { source: "isolated"; id: string };

interface RuntimeProfile {
  pids: number[];
  startedAt: string | null;
  cdpPort: number | null;
  listeningPorts: number[];
}

interface MigratedExtensionLaunchPlan {
  launchArgs: string[];
  runtimeLoadPaths: string[];
}

interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
}

interface CdpResponse<T> {
  id?: number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface CdpPendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<
      string,
      {
        [key: string]: unknown;
        name?: unknown;
        user_name?: unknown;
        is_using_default_name?: unknown;
      }
    >;
    last_active_profiles?: unknown;
    last_used?: unknown;
    profiles_order?: unknown;
    [key: string]: unknown;
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
  profileDirName: string;
}

interface CopyStats {
  files: number;
  bytes: number;
}

const ACCOUNT_SYNC_WORK_PREFIX = ".profilepilot-sync-";
const ACCOUNT_SYNC_PARTIAL_SUFFIX = ".partial";
const ACCOUNT_SYNC_PREVIOUS_SUFFIX = ".previous";

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

  constructor(private readonly dataDir = defaultDataDir()) {
    this.profilesDir = path.join(dataDir, "profiles");
    this.registryPath = path.join(dataDir, "profiles.json");
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
    const externalInstances = await findExternalChromeInstances([
      ...isolatedPaths,
      nativeChromeUserDataDir(),
      this.dataDir
    ]);

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
      chromeLauncher: this.getLauncherLabel(),
      accountSyncRecords: Object.values(registry.accountSyncRecords || {}).sort((a, b) => b.syncedAt.localeCompare(a.syncedAt)),
      externalInstances
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
    await this.recoverAccountSyncArtifactsBeforeLaunch(profileId);
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

    await this.recoverAccountSyncArtifactsBeforeLaunch(profileId);
    await this.launchIsolatedProfileWithCdp(ref.id, portInput);
  }

  async connectRunningSystemChrome(profileId: string): Promise<void> {
    const ref = parseProfileId(profileId);
    if (ref.source !== "native") {
      throw new ProfileManagerError("连接已运行系统 Chrome 只支持系统 Profile。", "NATIVE_PROFILE_REQUIRED");
    }

    const state = await this.getState();
    const profile = state.profiles.find((item) => item.id === makeNativeProfileId(ref.dirName));
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
    }
    if (!profile.running) {
      throw new ProfileManagerError("请先启动这个系统 Profile，再连接已运行系统 Chrome。", "PROFILE_NOT_RUNNING");
    }

    if (process.platform === "darwin") {
      await this.focusProfile(profileId);
      await sleep(250);
      await openChromeUrl(CHROME_REMOTE_DEBUGGING_URL);
      return;
    }

    await this.launchProfileWithUrls(profileId, [CHROME_REMOTE_DEBUGGING_URL]);
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

    if (profile.source === "native") {
      // 系统 Chrome 是 LaunchServices 注册的默认实例，open -a 走 LaunchServices
      // 可靠置顶且不需要任何权限；再尽力用 AXRaise 精确提升窗口（无权限则静默跳过）。
      await bringChromeAppToFront();
      await focusProfileWindow(profile.pids);
      return;
    }

    const raisedWindow = await focusProfileWindow(profile.pids);
    if (raisedWindow || (await hasRendererProcessForProfile(profile.path))) {
      return;
    }

    await requestIsolatedProfileWindow(profile);
    await sleep(700);

    const refreshedProfile = await this.getPublicProfile(profileId);
    await focusProfileWindow(refreshedProfile.pids.length ? refreshedProfile.pids : profile.pids);
  }

  async focusExternalInstance(userDataDir: string): Promise<void> {
    const instance = await this.locateExternalInstance(userDataDir);
    if (!instance) {
      throw new ProfileManagerError("这个外部实例已不在运行。", "EXTERNAL_INSTANCE_NOT_RUNNING");
    }

    await focusProfileWindow([instance.pid]);
  }

  async closeExternalInstance(userDataDir: string): Promise<void> {
    const instance = await this.locateExternalInstance(userDataDir);
    if (!instance) {
      throw new ProfileManagerError("这个外部实例已不在运行。", "EXTERNAL_INSTANCE_NOT_RUNNING");
    }

    try {
      process.kill(instance.pid, "SIGTERM");
    } catch (error) {
      if (!isProcessGoneError(error)) {
        throw error;
      }
    }

    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      if (!(await this.locateExternalInstance(userDataDir))) {
        return;
      }
      await sleep(200);
    }
  }

  // 操作前重新扫描，按 user-data-dir 拿最新 PID，避免界面里的旧 PID 误伤无关进程。
  private async locateExternalInstance(userDataDir: string): Promise<ExternalChromeInstance | null> {
    const registry = await this.loadRegistry();
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const instances = await findExternalChromeInstances([...isolatedPaths, nativeChromeUserDataDir(), this.dataDir]);
    return instances.find((instance) => instance.userDataDir === userDataDir) || null;
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

  async openProfileExtensionsPage(profileId: string): Promise<void> {
    await this.launchProfileWithUrls(profileId, ["chrome://extensions/"]);
  }

  async openPath(targetPathInput: string): Promise<void> {
    const targetPath = String(targetPathInput || "").trim();
    if (!targetPath) {
      throw new ProfileManagerError("没有可打开的路径。", "INVALID_PATH");
    }
    if (!(await exists(targetPath))) {
      throw new ProfileManagerError(`路径不存在：${targetPath}`, "PATH_NOT_FOUND");
    }

    const error = await shell.openPath(targetPath);
    if (error) {
      throw new ProfileManagerError(`打开路径失败：${error}`, "OPEN_PATH_FAILED");
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

  async inspectAccountSyncDiff(request: AccountSyncRequest): Promise<AccountSyncDiffResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    if (!sourceProfileId || !targetProfileId || sourceProfileId === targetProfileId) {
      throw new ProfileManagerError("请选择两个不同的 Profile 进行账号同步。", "INVALID_ACCOUNT_SYNC_PROFILES");
    }

    const state = await this.getState();
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetProfileId);
    if (!sourceProfile || !targetProfile) {
      throw new ProfileManagerError("没有找到源 Profile 或目标 Profile。", "PROFILE_NOT_FOUND");
    }

    const sourceLocation = await this.resolveAccountSyncLocation(sourceProfile, false);
    const targetLocation = await this.resolveAccountSyncLocation(targetProfile, false);
    const accountSyncRecord =
      request.onlyChanged !== false
        ? state.accountSyncRecords.find((record) => record.sourceProfileId === sourceProfileId && record.targetProfileId === targetProfileId) ||
          null
        : null;
    const fileItems = await Promise.all(
      accountSyncCopySpecs().map((spec) => inspectAccountSyncPathDiff(sourceLocation, targetLocation, spec))
    );
    const preferenceItems = await Promise.all([inspectAccountLocalStateDiff(sourceLocation, targetLocation)]);
    const items = accountSyncRecord
      ? await applyAccountSyncRecordBaseline([...fileItems, ...preferenceItems], sourceLocation, accountSyncRecord)
      : [...fileItems, ...preferenceItems];

    return {
      sourceProfileId,
      targetProfileId,
      items,
      summary: summarizeAccountSyncDiff(items)
    };
  }

  async inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    const includeData = Boolean(request.includeData);
    const openInstallPages = Boolean(request.openInstallPages);
    const requestedExtensionIds = uniqueStrings(request.extensionIds || []).filter(isLikelyExtensionId);

    if (!sourceProfileId || !targetProfileId || sourceProfileId === targetProfileId) {
      throw new ProfileManagerError("请选择两个不同的 Profile 进行插件同步。", "INVALID_MIGRATION_PROFILES");
    }

    const state = await this.getState();
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetProfileId);
    if (!sourceProfile || !targetProfile) {
      throw new ProfileManagerError("没有找到源 Profile 或目标 Profile。", "PROFILE_NOT_FOUND");
    }

    const sourceProfileDataPath = await this.resolveChromeProfileDataPath(sourceProfile);
    const targetProfileDataPath = await this.resolveChromeProfileDataPath(targetProfile);
    const [sourceScan, targetScan] = await Promise.all([
      this.scanProfileExtensions(sourceProfileId),
      this.scanProfileExtensions(targetProfileId)
    ]);
    const selectedExtensions = (requestedExtensionIds.length
      ? requestedExtensionIds
          .map((id) => sourceScan.extensions.find((extension) => extension.id === id))
          .filter(Boolean)
      : sourceScan.extensions) as ProfileExtensionInfo[];
    const targetById = new Map(targetScan.extensions.map((extension) => [extension.id, extension]));
    const items: ExtensionMigrationDiffItem[] = [];
    const canAutoLoadUnpacked = await canAutoLoadUnpackedExtensions();

    for (const extension of selectedExtensions) {
      const targetExtension = targetById.get(extension.id) || null;
      const dataChanged = includeData
        ? await extensionDataDiffers(sourceProfileDataPath, targetProfileDataPath, extension)
        : false;
      items.push(
        inspectExtensionMigrationItem(
          extension,
          targetExtension,
          targetProfile,
          dataChanged,
          openInstallPages,
          canAutoLoadUnpacked
        )
      );
    }

    const selectedIds = new Set(selectedExtensions.map((extension) => extension.id));
    const targetOnlyItems = targetScan.extensions
      .filter((extension) => !selectedIds.has(extension.id))
      .map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version
      }));

    return {
      sourceProfileId,
      targetProfileId,
      includeData,
      items,
      targetOnlyItems,
      summary: summarizeExtensionMigrationDiff(items, targetOnlyItems.length)
    };
  }

  async migrateExtensions(
    request: ExtensionMigrationRequest,
    onProgress?: (progress: OperationProgressUpdate) => void
  ): Promise<ExtensionMigrationResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    const extensionIds = uniqueStrings(request.extensionIds || []).filter(isLikelyExtensionId);
    const includeData = Boolean(request.includeData);
    const openInstallPages = Boolean(request.openInstallPages);
    const onlyChanged = request.onlyChanged !== false;
    const report = (message: string, step: string, stepIndex: number, stepCount = 6): void => {
      onProgress?.({ message, step, stepIndex, stepCount });
    };

    report("正在检查源 Profile 和目标 Profile…", "检查 Profile", 1);

    if (!sourceProfileId || !targetProfileId || sourceProfileId === targetProfileId) {
      throw new ProfileManagerError("请选择两个不同的 Profile 进行插件同步。", "INVALID_MIGRATION_PROFILES");
    }
    if (!extensionIds.length) {
      throw new ProfileManagerError("请至少选择一个要同步的插件。", "NO_EXTENSIONS_SELECTED");
    }

    const state = await this.getState();
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetProfileId);
    if (!sourceProfile || !targetProfile) {
      throw new ProfileManagerError("没有找到源 Profile 或目标 Profile。", "PROFILE_NOT_FOUND");
    }
    if (targetProfile.running) {
      throw new ProfileManagerError("同步插件前请先关闭目标 Profile。", "TARGET_PROFILE_RUNNING");
    }
    if (includeData && sourceProfile.running) {
      throw new ProfileManagerError("同步插件数据前请先关闭源 Profile，或取消勾选“同时同步插件数据”。", "SOURCE_PROFILE_RUNNING");
    }

    report("正在扫描源 Profile 的插件列表…", "扫描插件", 2);
    const scan = await this.scanProfileExtensions(sourceProfileId);
    const sourceProfileDataPath = await this.resolveChromeProfileDataPath(sourceProfile);
    const targetProfileDataPath = await this.resolveChromeProfileDataPath(targetProfile, true);
    const selectedExtensions = extensionIds
      .map((id) => scan.extensions.find((extension) => extension.id === id))
      .filter(Boolean) as ProfileExtensionInfo[];
    if (!selectedExtensions.length) {
      throw new ProfileManagerError("在源 Profile 里没有找到已选择的插件。", "EXTENSIONS_NOT_FOUND");
    }

    report(`已确认覆盖 ${targetProfile.name}，正在准备同步插件…`, "确认覆盖", 3);
    const migrationDiff = onlyChanged ? await this.inspectExtensionMigrationDiff(request) : null;
    const migrationDiffById = new Map((migrationDiff?.items || []).map((item) => [item.id, item]));
    const actionExtensionIds = new Set((migrationDiff?.items || []).filter(isExtensionMigrationActionItem).map((item) => item.id));
    const effectiveExtensions = onlyChanged
      ? selectedExtensions.filter((extension) => actionExtensionIds.has(extension.id))
      : selectedExtensions;
    const copiedExtensions: ExtensionMigrationCopiedExtension[] = [];
    const loadedLocalExtensions: ExtensionMigrationLoadedExtension[] = [];
    const dataCopies: ExtensionMigrationDataCopy[] = [];
    const skippedExtensions: ExtensionMigrationSkippedExtension[] = onlyChanged
      ? selectedExtensions
          .filter((extension) => !actionExtensionIds.has(extension.id))
          .map((extension) => ({
            id: extension.id,
            name: extension.name,
            reason: migrationDiffById.get(extension.id)?.reason || "目标已一致，本次无需同步"
          }))
      : [];
    const manualLoadExtensions: ExtensionMigrationManualLoadExtension[] = [];
    const webStoreInstallUrls: string[] = [];
    const now = new Date().toISOString();
    const extensionsForRegistry: StoredMigratedExtension[] = [];
    const canAutoLoadUnpacked = await canAutoLoadUnpackedExtensions();

    const recordManualLoadExtension = async (
      extension: ProfileExtensionInfo,
      reason = manualLoadExtensionReason(extension)
    ): Promise<void> => {
      await this.removeMigratedExtensionReference(targetProfile, extension.id);
      if (extension.path && !manualLoadExtensions.some((item) => item.id === extension.id)) {
        manualLoadExtensions.push({
          id: extension.id,
          name: extension.name,
          path: extension.path
        });
      }
      skippedExtensions.push({
        id: extension.id,
        name: extension.name,
        reason
      });
    };

    const registerLocalExtensionForRuntimeLoad = async (extension: ProfileExtensionInfo): Promise<boolean> => {
      if (!extension.path) {
        return false;
      }
      if (!(await exists(path.join(extension.path, "manifest.json")))) {
        skippedExtensions.push({
          id: extension.id,
          name: extension.name,
          reason: "源插件目录缺少 manifest.json，无法登记为运行时加载"
        });
        return false;
      }

      report(`正在登记本地插件运行时加载：${extension.name}`, "同步插件", 4);
      loadedLocalExtensions.push({
        id: extension.id,
        loadedId: extension.id,
        name: extension.name,
        version: extension.version,
        path: extension.path,
        via: "cdp_runtime"
      });
      extensionsForRegistry.push({
        id: makeStoredMigratedExtensionId(extension.id),
        sourceProfileId,
        sourceExtensionId: extension.id,
        name: extension.name,
        version: extension.version,
        path: extension.path,
        migratedAt: now,
        includeData
      });
      return true;
    };

    try {
      for (const [index, extension] of effectiveExtensions.entries()) {
        report(`正在同步插件 ${index + 1}/${effectiveExtensions.length}：${extension.name}`, "同步插件", 4);
        const diffItem = migrationDiffById.get(extension.id) || null;
        if (onlyChanged && diffItem?.status === "same") {
          skippedExtensions.push({
            id: extension.id,
            name: extension.name,
            reason: "目标已一致，本次无需同步"
          });
          continue;
        }

        if (diffItem?.status === "manual_load_required") {
          await recordManualLoadExtension(extension);
          continue;
        }

        if (diffItem?.status === "needs_install_page") {
          if (extension.storeUrl) {
            webStoreInstallUrls.push(extension.storeUrl);
          }
          skippedExtensions.push({
            id: extension.id,
            name: extension.name,
            reason: openInstallPages ? "需要在打开的安装页确认安装" : "需要打开安装页后手动确认安装"
          });
          continue;
        }

        if (diffItem?.willLoadViaCdp || (!canAutoLoadUnpacked && canLoadLocalExtensionViaCdp(extension, targetProfile))) {
          if (includeData) {
            for (const dataPath of extension.dataPaths) {
              report(`正在同步插件数据：${extension.name} · ${dataPath.label}`, "同步插件", 4);
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
          await registerLocalExtensionForRuntimeLoad(extension);
          continue;
        }

        if (extension.path && !canAutoLoadUnpacked) {
          if (extension.fromWebStore && extension.storeUrl) {
            webStoreInstallUrls.push(extension.storeUrl);
            skippedExtensions.push({
              id: extension.id,
              name: extension.name,
              reason: openInstallPages ? "官方 Chrome 不支持静默挂载，已打开安装页确认安装" : "官方 Chrome 不支持静默挂载，需要打开安装页确认安装"
            });
          } else {
            await recordManualLoadExtension(extension);
          }
          continue;
        }

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
            extensionsForRegistry.push({
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
            report(`正在同步插件数据：${extension.name} · ${dataPath.label}`, "同步插件", 4);
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

      if (extensionsForRegistry.length) {
        report(`正在写入 ${targetProfile.name} 的插件启动配置…`, "写入配置", 5);
        await this.mergeMigratedExtensions(targetProfile, extensionsForRegistry);
      }

      let openedInstallPages = false;
      const manualLoadNeeded = skippedExtensions.some((extension) => isManualLoadSkipReason(extension.reason));
      const pagesToOpen = uniqueStrings([...webStoreInstallUrls, ...(manualLoadNeeded ? ["chrome://extensions/"] : [])]);
      if (openInstallPages && pagesToOpen.length) {
        report(`正在打开 ${targetProfile.name} 需要确认的页面…`, "写入配置", 5);
        await this.launchProfileWithUrls(targetProfile.id, pagesToOpen);
        openedInstallPages = true;
      }

      report("正在刷新同步结果…", "完成", 6);
      return {
        sourceProfileId,
        targetProfileId,
        selectedCount: effectiveExtensions.length,
        copiedExtensions,
        loadedLocalExtensions,
        dataCopies,
        webStoreInstallUrls: uniqueStrings(webStoreInstallUrls),
        manualLoadExtensions,
        skippedExtensions,
        openedInstallPages,
        state: await this.getState()
      };
    } catch (error) {
      try {
        await this.discardMigratedExtensions(targetProfile, extensionsForRegistry);
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
    const deletedPaths: string[] = [];

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
      scan: await this.scanProfileExtensions(profileId),
      state: await this.getState()
    };
  }

  async syncAccount(
    request: AccountSyncRequest,
    onProgress?: (progress: OperationProgressUpdate) => void,
    abortSignal?: AbortSignal,
    pauseSignal?: OperationPauseSignal
  ): Promise<AccountSyncResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const targetProfileId = String(request.targetProfileId || "");
    const launchTarget = Boolean(request.launchTarget);
    const onlyChanged = request.onlyChanged !== false;
    const report = (message: string, step: string, stepIndex: number, stepCount = 6): void => {
      onProgress?.({ message, step, stepIndex, stepCount });
    };

    report("正在检查源 Profile 和目标 Profile…", "检查 Profile", 1);
    throwIfAborted(abortSignal);
    await waitIfPaused(pauseSignal, abortSignal);

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
    await recoverInterruptedAccountSyncArtifactsForProfile(targetLocation.profilePath);
    const accountDiff = await this.inspectAccountSyncDiff(request);
    const accountDiffByPath = new Map(accountDiff.items.map((item) => [item.relativePath, item]));
    if (!accountDiff.items.some((item) => item.status !== "source_missing")) {
      throw new ProfileManagerError("源 Profile 里没有找到可同步的账号数据。", "ACCOUNT_SYNC_SOURCE_EMPTY");
    }

    report(`已确认覆盖 ${targetProfile.name}，正在准备复制账号数据…`, "确认覆盖", 2);
    const copiedItems: AccountSyncCopiedItem[] = [];
    const skippedItems: AccountSyncSkippedItem[] = [];
    const copySpecs = accountSyncCopySpecs();

    for (const [index, spec] of copySpecs.entries()) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      const itemPosition = `${index + 1}/${copySpecs.length}`;
      const reportCopyProgress = (detail: string): void => {
        report(`正在复制账号数据 ${itemPosition}：${spec.label}${detail ? ` · ${detail}` : ""}`, "复制账号数据", 3);
      };
      reportCopyProgress("准备中");
      const sourcePath = path.join(sourceLocation.profilePath, spec.relativePath);
      const diffItem = accountDiffByPath.get(spec.relativePath) || null;
      if (diffItem?.status === "source_missing" || !(await exists(sourcePath))) {
        skippedItems.push({
          label: spec.label,
          relativePath: spec.relativePath,
          reason: diffItem?.reason || "源 Profile 中没有生成，本次无需同步"
        });
        continue;
      }

      if (onlyChanged && diffItem?.status === "same") {
        skippedItems.push({
          label: spec.label,
          relativePath: spec.relativePath,
          reason: "已一致，本次无需同步"
        });
        continue;
      }

      const targetPath = path.join(targetLocation.profilePath, normalizeSafeRelativePath(spec.relativePath));
      await waitIfPaused(pauseSignal, abortSignal);
      await copyAccountSyncPath(sourcePath, targetPath, reportCopyProgress, abortSignal, pauseSignal);
      copiedItems.push({
        label: spec.label,
        relativePath: spec.relativePath
      });
    }

    throwIfAborted(abortSignal);
    await waitIfPaused(pauseSignal, abortSignal);
    report("正在写入浏览器账号状态…", "写入浏览器状态", 5);
    const localStateDiff = accountDiffByPath.get("Local State") || null;
    const shouldMergeLocalState = shouldApplyAccountDiffItem(localStateDiff, onlyChanged);
    const localStateMerged = shouldMergeLocalState
      ? await mergeAccountLocalStateValues(sourceLocation, targetLocation)
      : false;
    if (localStateMerged || (shouldMergeLocalState && localStateDiff?.status === "target_missing")) {
      copiedItems.push({
        label: "浏览器账号状态",
        relativePath: "Local State"
      });
    } else {
      skippedItems.push({
        label: "浏览器账号状态",
        relativePath: "Local State",
        reason: localStateDiff?.reason || "源 Profile 中没有生成，本次无需同步"
      });
    }

    let launchedTarget = false;
    if (launchTarget) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      report(`正在启动 ${targetProfile.name}…`, "完成", 6);
      await this.launchProfile(targetProfileId);
      launchedTarget = true;
    } else {
      report("正在刷新同步结果…", "完成", 6);
    }

    await this.recordAccountSync({
      sourceProfileId,
      targetProfileId,
      syncedAt: new Date().toISOString(),
      copiedCount: copiedItems.length,
      skippedCount: skippedItems.length,
      launchedTarget,
      sourceFingerprints: await snapshotAccountSyncSourceFingerprints(sourceLocation)
    });

    return {
      sourceProfileId,
      targetProfileId,
      copiedItems,
      skippedItems,
      launchedTarget,
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
    const cdpPort = await this.launchStoredIsolatedProfile(profile);
    profile.lastLaunchedAt = new Date().toISOString();
    if (cdpPort !== null) {
      profile.lastCdpPort = cdpPort;
    }
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

    const requestedPort = normalizeCdpPortInput(portInput);
    const cdpPort = await this.launchStoredIsolatedProfile(profile, { cdpPort: requestedPort, forceCdp: true });
    profile.lastLaunchedAt = new Date().toISOString();
    profile.lastCdpPort = cdpPort;
    await this.saveRegistry(registry);
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
    const cdpPort = await this.launchStoredIsolatedProfile(profile, { urls });
    profile.lastLaunchedAt = new Date().toISOString();
    if (cdpPort !== null) {
      profile.lastCdpPort = cdpPort;
    }
    await this.saveRegistry(registry);
  }

  private async launchStoredIsolatedProfile(
    profile: StoredProfile,
    options: { urls?: string[]; cdpPort?: number | null; forceCdp?: boolean } = {}
  ): Promise<number | null> {
    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });
    const launchPlan = await getMigratedExtensionLaunchPlan(profile);
    const needsRuntimeCdp = launchPlan.runtimeLoadPaths.length > 0;
    const shouldStartCdp = Boolean(options.forceCdp || needsRuntimeCdp);
    let cdpPort: number | null = null;
    const cdpArgs: string[] = [];

    if (shouldStartCdp) {
      cdpPort = options.cdpPort ?? (await findAvailableCdpPort(profile.lastCdpPort || 9222));
      if (!(await isPortAvailable(cdpPort))) {
        const owner = await describePortOwner(cdpPort);
        const detail = owner ? `，占用者：${owner}` : "";
        throw new ProfileManagerError(`CDP 端口 ${cdpPort} 已被占用${detail}。`, "CDP_PORT_IN_USE");
      }
      cdpArgs.push("--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`);
    }

    await launchChrome([
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      ...launchPlan.launchArgs,
      ...cdpArgs,
      ...(options.urls || [])
    ]);

    if (cdpPort !== null) {
      await waitForCdp(cdpPort, 6000);
      if (launchPlan.runtimeLoadPaths.length) {
        await loadUnpackedExtensionsOverCdp(cdpPort, launchPlan.runtimeLoadPaths);
      }
    }

    return cdpPort;
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
    const deletedProfileId = makeIsolatedProfileId(id);
    const accountSyncRecords = Object.fromEntries(
      Object.entries(registry.accountSyncRecords || {}).filter(
        ([, record]) => record.sourceProfileId !== deletedProfileId && record.targetProfileId !== deletedProfileId
      )
    );
    await this.saveRegistry({ ...registry, profiles: nextProfiles, accountSyncRecords });

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
      await this.saveRegistry({ profiles: [], nativeProfiles: {}, accountSyncRecords: {} });
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
      const accountSyncRecords =
        parsed.accountSyncRecords && typeof parsed.accountSyncRecords === "object"
          ? normalizeAccountSyncRecords(parsed.accountSyncRecords)
          : {};

      return {
        profiles: Array.isArray(parsed.profiles)
          ? (parsed.profiles.map(normalizeProfile).filter(Boolean) as StoredProfile[])
          : [],
        nativeProfiles,
        accountSyncRecords
      };
    } catch {
      const backup = `${this.registryPath}.broken-${Date.now()}`;
      try {
        await fs.rename(this.registryPath, backup);
      } catch {
        // Start clean if the broken registry cannot be backed up.
      }
      return { profiles: [], nativeProfiles: {}, accountSyncRecords: {} };
    }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.registryPath);
  }

  private async recordAccountSync(record: AccountSyncRecord): Promise<void> {
    const registry = await this.loadRegistry();
    await this.saveRegistry({
      ...registry,
      accountSyncRecords: {
        ...(registry.accountSyncRecords || {}),
        [accountSyncRecordKey(record.sourceProfileId, record.targetProfileId)]: record
      }
    });
  }

  private async recoverAccountSyncArtifactsBeforeLaunch(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (profile.running) {
      return;
    }

    const location = await this.resolveAccountSyncLocation(profile, false);
    await recoverInterruptedAccountSyncArtifactsForProfile(location.profilePath);
  }

  private async getRuntime(profilePaths: string[], nativeDirNames: string[]): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
        maxBuffer: 1024 * 1024 * 8,
        env: POSIX_LOCALE_ENV
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

    const sourcePath = extension.path;
    const versionSlug = makePathSegment(extension.version || "unknown-version");
    const targetPath = path.join(targetProfile.path, "Migrated Extensions", extension.id, versionSlug);
    if (await isSameFilesystemPath(sourcePath, targetPath)) {
      return targetPath;
    }

    await fs.rm(targetPath, { recursive: true, force: true });
    await copyPath(sourcePath, targetPath, {
      shouldCopy: (candidatePath) => shouldCopyLocalExtensionPackagePath(sourcePath, candidatePath)
    });
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

  private async resolveAccountSyncLocation(
    profile: PublicProfile,
    ensureProfilePath: boolean
  ): Promise<AccountSyncDataLocation> {
    if (profile.source === "native") {
      return {
        userDataPath: nativeChromeUserDataDir(),
        profilePath: profile.path,
        profileDirName: profile.dirName
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
      profilePath,
      profileDirName: chromeProfileDirName(rootPath, profilePath)
    };
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

class CdpBrowserClient {
  private nextId = 1;
  private readonly pending = new Map<number, CdpPendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    this.socket.addEventListener("close", () => {
      this.rejectPending(new Error("CDP 连接已关闭"));
    });
  }

  static connect(url: string, timeoutMs: number): Promise<CdpBrowserClient> {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new ProfileManagerError("当前运行环境没有 WebSocket，无法连接 Chrome CDP。", "CDP_WEBSOCKET_UNAVAILABLE");
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new ProfileManagerError("连接 Chrome CDP 超时。", "CDP_CONNECT_TIMEOUT"));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve(new CdpBrowserClient(socket));
      };
      const handleError = (): void => {
        cleanup();
        reject(new ProfileManagerError("连接 Chrome CDP 失败。", "CDP_CONNECT_FAILED"));
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }

  send<T>(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new ProfileManagerError("Chrome CDP 连接未打开。", "CDP_NOT_CONNECTED"));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProfileManagerError(`Chrome CDP 调用 ${method} 超时。`, "CDP_COMMAND_TIMEOUT"));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });

      try {
        this.socket.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.rejectPending(new Error("CDP 连接已关闭"));
    try {
      this.socket.close();
    } catch {
      // The browser may already be closed.
    }
  }

  private handleMessage(event: MessageEvent): void {
    const message = parseCdpMessage(event.data);
    if (!message || typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      const detail = message.error.message || `CDP error ${message.error.code ?? ""}`.trim();
      pending.reject(new ProfileManagerError(detail, "CDP_COMMAND_FAILED"));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function parseCdpMessage(data: unknown): CdpResponse<unknown> | null {
  try {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    } else {
      text = String(data);
    }

    const parsed = JSON.parse(text);
    return isRecord(parsed) ? (parsed as CdpResponse<unknown>) : null;
  } catch {
    return null;
  }
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

async function openChromeUrl(url: string): Promise<void> {
  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, [url]);
  } else if (process.platform === "darwin") {
    await setFrontMacChromeTabUrl(url);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", url]);
  } else {
    launchDetached("google-chrome", [url]);
  }
}

async function setFrontMacChromeTabUrl(url: string): Promise<void> {
  const appName = process.env.CHROME_APP_NAME || "Google Chrome";
  const script = `
tell application ${toAppleScriptString(appName)}
  if (count of windows) is 0 then make new window
  set URL of active tab of front window to ${toAppleScriptString(url)}
  activate
end tell
`;
  await execFileAsync("osascript", ["-e", script]);
}

function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// 把系统默认 Chrome 实例带到屏幕最前。走 LaunchServices（open -a），不需要
// 辅助功能权限，且比 NSRunningApplication.activate 在新版 macOS 上更可靠。
async function bringChromeAppToFront(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  await execFileAsync("open", ["-a", process.env.CHROME_APP_NAME || "Google Chrome"]);
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
    // 窗口级 AXRaise 可能因多 profile 实例或缺少辅助功能权限失败，这属正常；
    // 调用方已用 NSRunningApplication / open -a 把 app 带到前台，不影响主流程。
    return false;
  }
}

async function hasRendererProcessForProfile(profilePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
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

async function inspectAccountSyncPathDiff(
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

async function inspectAccountLocalStateDiff(
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

function accountSyncDiffItem(
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

function accountSyncDiffReason(status: AccountSyncDiffItem["status"]): string {
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

function summarizeAccountSyncDiff(items: AccountSyncDiffItem[]): AccountSyncDiffResult["summary"] {
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

async function applyAccountSyncRecordBaseline(
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

function accountSyncBaselineSameItem(item: AccountSyncDiffItem): AccountSyncDiffItem {
  return {
    ...item,
    status: "same",
    reason: "上次同步后源 Profile 没有新变化，本次无需同步"
  };
}

function shouldApplyAccountDiffItem(item: AccountSyncDiffItem | null, onlyChanged: boolean): boolean {
  if (!item || item.status === "source_missing") {
    return false;
  }

  return !onlyChanged || item.status !== "same";
}

function inspectExtensionMigrationItem(
  extension: ProfileExtensionInfo,
  targetExtension: ProfileExtensionInfo | null,
  targetProfile: PublicProfile,
  dataChanged: boolean,
  openInstallPages: boolean,
  canAutoLoadUnpacked: boolean
): ExtensionMigrationDiffItem {
  const canCopyLocally = Boolean(
    extension.canCopyLocally && extension.path && targetProfile.source === "isolated" && canAutoLoadUnpacked
  );
  const canLoadViaCdp = canLoadLocalExtensionViaCdp(extension, targetProfile);
  const canOpenInstallPage = Boolean(extension.fromWebStore && extension.storeUrl);
  const needsManualLoad = Boolean(extension.path && !extension.fromWebStore && !canCopyLocally && !canLoadViaCdp);
  const targetVersion = targetExtension?.version || null;
  let status: ExtensionMigrationDiffStatus;

  if (!targetExtension) {
    status = canCopyLocally || canLoadViaCdp
      ? "missing"
      : needsManualLoad
        ? "manual_load_required"
        : canOpenInstallPage
          ? "needs_install_page"
          : "unsupported";
  } else if (extension.version !== targetExtension.version) {
    status = canCopyLocally || canLoadViaCdp
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
    reason: extensionMigrationDiffReason(status, Boolean(targetExtension), openInstallPages, canLoadViaCdp),
    willCopyLocally: (status === "missing" || status === "version_changed") && canCopyLocally,
    willLoadViaCdp: (status === "missing" || status === "version_changed") && canLoadViaCdp,
    willOpenInstallPage: status === "needs_install_page" && canOpenInstallPage && openInstallPages
  };
}

function extensionMigrationDiffReason(
  status: ExtensionMigrationDiffStatus,
  hasTargetExtension: boolean,
  openInstallPages: boolean,
  willLoadViaCdp = false
): string {
  switch (status) {
    case "missing":
      if (willLoadViaCdp) {
        return "目标缺少，本次会登记为启动时自动加载";
      }
      return "目标缺少，本次会同步";
    case "version_changed":
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

function isExtensionMigrationActionItem(item: ExtensionMigrationDiffItem): boolean {
  return (
    item.status === "missing" ||
    item.status === "version_changed" ||
    item.status === "data_changed" ||
    item.status === "manual_load_required" ||
    item.willOpenInstallPage
  );
}

function summarizeExtensionMigrationDiff(
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

function canLoadLocalExtensionViaCdp(extension: ProfileExtensionInfo, targetProfile: PublicProfile): boolean {
  return Boolean(extension.path && !extension.fromWebStore && targetProfile.source === "isolated");
}

function manualLoadExtensionReason(extension: ProfileExtensionInfo): string {
  const sourcePath = extension.path || "源插件目录";
  return `需要在目标 chrome://extensions 手动加载未打包目录：${sourcePath}`;
}

function isManualLoadSkipReason(reason: string): boolean {
  return reason.includes("手动加载未打包目录") || reason.includes("手动加载源目录");
}

async function extensionDataDiffers(
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

function hasAccountLocalStateValues(info: Record<string, unknown>): boolean {
  return Object.keys(info).some(isAccountLocalStateProfileInfoKey);
}

async function pathMetadataFingerprint(
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

async function appendPathMetadataFingerprint(
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

async function snapshotAccountSyncSourceFingerprints(
  sourceLocation: AccountSyncDataLocation
): Promise<Record<string, string | null>> {
  const relativePaths = uniqueStrings([...accountSyncCopySpecs().map((spec) => spec.relativePath), "Local State"]);
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => [relativePath, await accountSyncSourceFingerprint(sourceLocation, relativePath)] as const)
  );

  return Object.fromEntries(entries);
}

async function accountSyncSourceFingerprint(
  sourceLocation: AccountSyncDataLocation,
  relativePath: string
): Promise<string | null> {
  return pathMetadataFingerprint(accountSyncSourcePath(sourceLocation, relativePath), isAccountSyncComparablePath);
}

async function accountSyncSourcePathChangedAfterRecord(
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

function accountSyncSourcePath(sourceLocation: AccountSyncDataLocation, relativePath: string): string {
  if (relativePath === "Local State") {
    return path.join(sourceLocation.userDataPath, "Local State");
  }

  return path.join(sourceLocation.profilePath, normalizeSafeRelativePath(relativePath));
}

async function latestPathMtimeMs(
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

function isAccountSyncComparablePath(candidatePath: string): boolean {
  const name = path.basename(candidatePath);
  return name !== "LOCK" && !isAccountSyncWorkArtifactName(name);
}

function stableJsonStringify(value: unknown): string {
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

async function mergeAccountLocalStateValues(
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

function localStateProfileInfo(localState: ChromeLocalState, dirName: string): Record<string, unknown> | null {
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

function ensureLocalStateProfile(localState: ChromeLocalState): NonNullable<ChromeLocalState["profile"]> {
  if (!isRecord(localState.profile)) {
    localState.profile = {};
  }

  return localState.profile;
}

function ensureLocalStateInfoCache(
  profile: NonNullable<ChromeLocalState["profile"]>
): NonNullable<NonNullable<ChromeLocalState["profile"]>["info_cache"]> {
  if (!isRecord(profile.info_cache)) {
    profile.info_cache = {};
  }

  return profile.info_cache;
}

function mergeLocalStateProfileAccountInfo(
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

function isAccountLocalStateProfileInfoKey(key: string): boolean {
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

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function moveStringToFront(values: string[], item: string): string[] {
  return uniqueStrings([item, ...values.filter((value) => value !== item)]);
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
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

let cachedCanAutoLoadUnpackedExtensions: boolean | null = null;

async function canAutoLoadUnpackedExtensions(): Promise<boolean> {
  if (cachedCanAutoLoadUnpackedExtensions !== null) {
    return cachedCanAutoLoadUnpackedExtensions;
  }

  cachedCanAutoLoadUnpackedExtensions = await detectAutoLoadUnpackedExtensionSupport();
  return cachedCanAutoLoadUnpackedExtensions;
}

async function detectAutoLoadUnpackedExtensionSupport(): Promise<boolean> {
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

async function readChromeMajorVersion(): Promise<number | null> {
  const versionOutputs: string[] = [];

  const command = getDirectChromeCommand();
  if (command) {
    const output = await readCommandVersion(command, ["--version"]);
    if (output) {
      versionOutputs.push(output);
    }
  }

  if (!versionOutputs.length && process.platform === "darwin" && !process.env.CHROME_BINARY) {
    const appName = process.env.CHROME_APP_NAME || "Google Chrome";
    const plistPath = `/Applications/${appName}.app/Contents/Info.plist`;
    const output = await readCommandVersion("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      plistPath
    ]);
    if (output) {
      versionOutputs.push(output);
    }
  }

  for (const output of versionOutputs) {
    const match = output.match(/(?:Chrome|Chromium)?\s*(\d+)(?:\.|$)/i);
    const version = match ? Number.parseInt(match[1], 10) : Number.NaN;
    if (Number.isFinite(version)) {
      return version;
    }
  }

  return null;
}

async function readCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 2000 });
    return `${stdout || ""}${stderr || ""}`.trim() || null;
  } catch {
    return null;
  }
}

async function getMigratedExtensionLaunchPlan(profile: StoredProfile): Promise<MigratedExtensionLaunchPlan> {
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

async function loadUnpackedExtensionsOverCdp(port: number, extensionPaths: string[]): Promise<void> {
  if (!extensionPaths.length) {
    return;
  }

  const version = await requestCdpVersionInfo(port);
  if (!version.webSocketDebuggerUrl) {
    throw new ProfileManagerError("目标 Profile 的 CDP 没有返回 browser WebSocket 地址。", "CDP_NOT_READY");
  }

  const client = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, 5000);
  try {
    for (const extensionPath of extensionPaths) {
      await client.send("Extensions.loadUnpacked", { path: extensionPath }, 15000);
    }
  } finally {
    client.close();
  }
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

async function isSameFilesystemPath(pathA: string, pathB: string): Promise<boolean> {
  const [resolvedA, resolvedB] = await Promise.all([
    resolveComparablePath(pathA),
    resolveComparablePath(pathB)
  ]);
  return resolvedA === resolvedB;
}

async function resolveComparablePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function shouldCopyLocalExtensionPackagePath(sourceRootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(sourceRootPath, candidatePath);
  return !relativePath.split(path.sep).includes(".git");
}

async function copyPath(
  sourcePath: string,
  targetPath: string,
  options: { shouldCopy?: (sourcePath: string) => boolean } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await copyPathWithProgress(sourcePath, targetPath, options.shouldCopy || (() => true), () => undefined);
}

async function copyAccountSyncPath(
  sourcePath: string,
  targetPath: string,
  onProgress?: (detail: string) => void,
  abortSignal?: AbortSignal,
  pauseSignal?: OperationPauseSignal
): Promise<void> {
  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await recoverInterruptedAccountSyncPath(targetPath);
  const shouldCopy = (source: string): boolean => {
    const name = path.basename(source);
    return name !== "LOCK" && !isAccountSyncWorkArtifactName(name);
  };
  onProgress?.("正在统计文件");
  const stats = await collectCopyStats(sourcePath, shouldCopy, abortSignal, pauseSignal);
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
  const reportCopied = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastReportAt < 250 && copiedFiles < stats.files) {
      return;
    }
    lastReportAt = now;
    onProgress?.(
      `已复制 ${copiedFiles}/${stats.files} 个文件，${formatByteSize(copiedBytes)}/${formatByteSize(stats.bytes)}`
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

async function recoverInterruptedAccountSyncArtifactsForProfile(profilePath: string): Promise<void> {
  for (const spec of accountSyncCopySpecs()) {
    await recoverInterruptedAccountSyncPath(path.join(profilePath, normalizeSafeRelativePath(spec.relativePath)));
  }
}

async function recoverInterruptedAccountSyncPath(targetPath: string): Promise<void> {
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

  if (!(await exists(targetPath))) {
    const latestPreviousPath = previousPaths[previousPaths.length - 1];
    await fs.rename(latestPreviousPath, targetPath).catch(async () => {
      await fs.rm(latestPreviousPath, { recursive: true, force: true }).catch(() => undefined);
    });
    previousPaths.pop();
  }

  await Promise.all(previousPaths.map((previousPath) => fs.rm(previousPath, { recursive: true, force: true })));
}

async function replacePathWithStagedCopy(stagingPath: string, targetPath: string): Promise<void> {
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
    if (targetExists && !(await exists(targetPath)) && (await exists(previousPath))) {
      await fs.rename(previousPath, targetPath).catch(() => undefined);
    }
    throw error;
  }

  if (targetExists) {
    await fs.rm(previousPath, { recursive: true, force: true });
  }
}

function makeAccountSyncWorkPath(targetPath: string, suffix: string): string {
  return path.join(path.dirname(targetPath), `${accountSyncWorkPrefixForTarget(targetPath)}${Date.now()}-${randomUUID()}${suffix}`);
}

function accountSyncWorkPrefixForTarget(targetPath: string): string {
  return `${ACCOUNT_SYNC_WORK_PREFIX}${path.basename(targetPath)}-`;
}

function isAccountSyncWorkArtifactName(name: string): boolean {
  return name.startsWith(ACCOUNT_SYNC_WORK_PREFIX);
}

async function collectCopyStats(
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

async function copyPathWithProgress(
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
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    throwIfAborted(abortSignal);
    await waitIfPaused(pauseSignal, abortSignal);
    await fs.rm(targetPath, { force: true });
    await fs.symlink(linkTarget, targetPath);
    onFileCopied(0);
    return;
  }

  throwIfAborted(abortSignal);
  await waitIfPaused(pauseSignal, abortSignal);
  await fs.copyFile(sourcePath, targetPath);
  await preserveTimestamps(targetPath, stat);
  onFileCopied(stat.isFile() ? stat.size : 0);
}

function isCopyableFilesystemEntry(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

async function preserveTimestamps(targetPath: string, stat: Awaited<ReturnType<typeof fs.lstat>>): Promise<void> {
  try {
    await fs.utimes(targetPath, stat.atime, stat.mtime);
  } catch {
    // Some filesystems reject timestamp preservation for special entries; copied data is still usable.
  }
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new ProfileManagerError(
      "已终止同步。已完成替换的数据会保留，未完成的临时数据会在下次同步前恢复或清理，重新同步会继续覆盖补齐。",
      "OPERATION_CANCELLED"
    );
  }
}

async function waitIfPaused(pauseSignal?: OperationPauseSignal, abortSignal?: AbortSignal): Promise<void> {
  throwIfAborted(abortSignal);
  if (!pauseSignal?.paused) {
    return;
  }

  await pauseSignal.waitIfPaused();
  throwIfAborted(abortSignal);
}

function formatByteSize(bytes: number): string {
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

function normalizeSafeRelativePath(relativePath: string): string {
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

function chromeProfileDirName(userDataPath: string, profilePath: string): string {
  const relativePath = path.relative(userDataPath, profilePath);
  if (!relativePath || relativePath === "." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return "Default";
  }

  return relativePath.split(path.sep).filter(Boolean)[0] || "Default";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function accountSyncRecordKey(sourceProfileId: string, targetProfileId: string): string {
  return `${sourceProfileId}::${targetProfileId}`;
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

function normalizeAccountSyncRecords(input: Record<string, unknown>): Record<string, AccountSyncRecord> {
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

function normalizeAccountSyncSourceFingerprints(input: unknown): Record<string, string | null> | undefined {
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
      maxBuffer: 1024 * 1024,
      env: POSIX_LOCALE_ENV
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
    `Chrome 已启动，但 CDP 没有在 127.0.0.1:${port} 响应。` +
      `如果这个 Profile 已有 Chrome 实例在运行（包括之前 CDP 启动后未关闭的窗口），` +
      `新进程会移交给旧实例导致新端口不生效，请先关闭该 Profile 再重试。${detail}`,
    "CDP_NOT_READY"
  );
}

function requestCdpVersion(port: number): Promise<void> {
  return requestCdpVersionInfo(port).then(() => undefined);
}

function requestCdpVersionInfo(port: number): Promise<CdpVersionInfo> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json/version",
        timeout: 700
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode || "unknown"}`));
            return;
          }

          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            resolve({
              webSocketDebuggerUrl: isRecord(parsed) ? stringValue(parsed.webSocketDebuggerUrl) || undefined : undefined
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
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

const GENERIC_DIR_SEGMENTS = new Set([
  "user-data",
  "user_data",
  "userdata",
  "user data",
  "data",
  "default",
  "profile",
  "profiles",
  "browser",
  "browsers",
  "chrome",
  "chromium",
  "tmp"
]);

// 识别非本工具、非系统 Chrome 的 Chromium 系浏览器主进程（agent-browser、bb-browser 等
// 工具会用自带的 Chrome for Testing / Chromium 加自管 user-data-dir 启动）。
function isChromiumBrowserMainProcess(command: string): boolean {
  if (command.includes("--type=") || command.includes("chrome_crashpad_handler")) {
    return false;
  }

  if (process.platform === "darwin") {
    return /\/Contents\/MacOS\/(Google Chrome( for Testing| Beta| Dev| Canary)?|Chromium|Microsoft Edge|Brave Browser)(\s|$)/.test(
      command
    );
  }

  return isGoogleChromeMainProcess(command);
}

function parseExternalBrowserName(command: string): string {
  const match = command.match(
    /\/Contents\/MacOS\/(Google Chrome( for Testing| Beta| Dev| Canary)?|Chromium|Microsoft Edge|Brave Browser)(\s|$)/
  );
  return match ? match[1] : "Chromium";
}

// ps 输出不带引号，路径里可能有空格；取到下一个“ --flag”或行尾为止。
function parseUserDataDirFlag(command: string): string | null {
  const match = command.match(/--user-data-dir=(.*?)(?=\s+--|$)/);
  const value = match?.[1]?.trim();
  return value || null;
}

function externalInstanceLabel(userDataDir: string): string {
  const segments = userDataDir.split(path.sep).filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const normalized = segment.replace(/^\./, "").toLowerCase();
    if (!GENERIC_DIR_SEGMENTS.has(normalized)) {
      return segment.replace(/^\./, "");
    }
  }

  return path.basename(userDataDir) || userDataDir;
}

async function findExternalChromeInstances(knownUserDataDirs: string[]): Promise<ExternalChromeInstance[]> {
  const known = new Set(knownUserDataDirs.map((dir) => dir.replace(/\/+$/, "")));

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    }));
  } catch {
    return [];
  }

  const byDir = new Map<string, ExternalChromeInstance>();
  for (const line of stdout.split("\n")) {
    const processInfo = parseRuntimeProcess(line);
    if (!processInfo || !isChromiumBrowserMainProcess(processInfo.command)) {
      continue;
    }

    const userDataDir = parseUserDataDirFlag(processInfo.command);
    if (!userDataDir || known.has(userDataDir.replace(/\/+$/, ""))) {
      continue;
    }

    const existing = byDir.get(userDataDir);
    if (existing) {
      continue;
    }

    byDir.set(userDataDir, {
      userDataDir,
      label: externalInstanceLabel(userDataDir),
      browser: parseExternalBrowserName(processInfo.command),
      pid: processInfo.pid,
      startedAt: processInfo.startedAt,
      cdpPort: processInfo.cdpPort,
      cdpUrl: null,
      // 无头实例（agent-browser 默认 --headless=new）没有可见窗口，无法“显示”。
      headless: /--headless(=|\s|$)/.test(processInfo.command)
    });
  }

  const instances = [...byDir.values()];
  await Promise.all(
    instances.map(async (instance) => {
      if (instance.cdpPort === null) {
        return;
      }
      try {
        await requestCdpVersionInfo(instance.cdpPort);
        instance.cdpUrl = makeCdpUrl(instance.cdpPort);
      } catch {
        // 声明了端口但当前不可达，保留端口号、不给出可用地址。
      }
    })
  );

  return instances.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

async function isChromeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    });
    return stdout
      .split("\n")
      .some((line) => line.includes("Google Chrome.app/Contents/MacOS/Google Chrome") || line.includes("Google Chrome Helper"));
  } catch {
    return true;
  }
}
