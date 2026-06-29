import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import { promises as dnsPromises } from "node:dns";
import net from "node:net";
import path from "node:path";
import { app, shell } from "electron";
import type {
  AccountSyncCopiedItem,
  AccountSyncDiffResult,
  AccountSyncRecord,
  AccountSyncRequest,
  AccountSyncResult,
  AccountSyncSkippedItem,
  AppState,
  CdpPortSuggestion,
  ClonedProfileInfo,
  CloneProfilesRequest,
  CloneProfilesResult,
  DeleteProfileOptions,
  DeleteProfileResult,
  LaunchClonesResult,
  RecycleIdleClonesResult,
  RefreshClonesResult,
  ExtensionDeleteResult,
  ExtensionMigrationCopiedExtension,
  ExtensionMigrationDataCopy,
  ExtensionMigrationDiffItem,
  ExtensionMigrationDiffResult,
  ExtensionMigrationLoadedExtension,
  ExtensionMigrationManualLoadExtension,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionMigrationSkippedExtension,
  ExtensionScanResult,
  ExternalChromeInstance,
  NativeChromeProfile,
  OperationPauseSignal,
  OperationProgressUpdate,
  ProfileExtensionInfo,
  PublicProfile,
  Registry,
  SetupAgentBrowserRequest,
  SetupAgentBrowserResult,
  StoredMigratedExtension,
  StoredProfile
} from "../shared/types";
import { accountSyncCopySpecs, accountSyncDataScore, accountSyncRecordKey, applyAccountSyncRecordBaseline, assertAccountSyncDiskSpace, collectAccountSyncPathStats, copyAccountSyncPath, inspectAccountLocalStateDiff, inspectAccountSyncPathDiff, mergeAccountLocalStateValues, recoverInterruptedAccountSyncArtifactsForProfile, restoreAccountSyncExtensionPreferences, shouldApplyAccountDiffItem, snapshotAccountSyncExtensionPreferences, snapshotAccountSyncSourceFingerprints, summarizeAccountSyncDiff } from "./account-sync";
import { describePortOwner, findAvailableCdpPort, isPortAvailable, makeCdpUrl, normalizeCdpPortInput, requestCdpTargets, waitForCdp } from "./cdp-client";
import { appendUniqueExtraUrls, bringCdpPageToFront, loadUnpackedExtensionsOverCdp, snapshotRestorableTabUrls } from "./cdp-page";
import { focusProfileWindow, hasRendererProcessForProfile, isAnyMacProcessFrontmost, launchChrome, makeIsolatedProfileId, makeNativeProfileId, nativeChromeUserDataDir, openChromeUrl, parseProfileId, readAgentBrowserConfig, readIsolatedProfileUserName, removeAgentBrowserConfigFile, removeNativeProfileFromLocalState, requestIsolatedProfileWindow, resolveIsolatedProfileDataPath, scanNativeChromeProfiles, writeAgentBrowserConfigFile } from "./chrome-launch";
import { canAutoLoadUnpackedExtensions, canLoadLocalExtensionViaCdp, canPersistExtensionInstall, copyExtensionDataPath, copyExtensionPackageToProfile, extensionDataDiffers, getMigratedExtensionLaunchPlan, getProtectedDeveloperModeRecord, inspectExtensionMigrationItem, isExtensionMigrationActionItem, isManualLoadSkipReason, isProfileRelativeExtensionSetting, makeStoredMigratedExtensionId, manualLoadExtensionReason, readProtectedExtensionInstallRecord, removeExtensionReferencesFromProfilePreferences, summarizeExtensionMigrationDiff, writeProtectedExtensionInstallRecord } from "./extension-migration";
import { extensionDeleteRelativePaths, isLikelyExtensionId, scanProfileExtensions } from "./extension-scan";
import { copyPath, throwIfAborted, waitIfPaused } from "./fs-copy";
import { POSIX_LOCALE_ENV, chromeProfileDirName, defaultDataDir, execFileAsync, exists, isProcessGoneError, isSafePathSegment, isSameFilesystemPath, makePathSegment, makeSlug, normalizeAccountSyncRecords, normalizeNativeProfileMetadata, normalizeProfile, normalizeProfileName, normalizeSafeRelativePath, shouldCopyLocalExtensionPackagePath, sleep, uniqueStrings } from "./fs-util";
import { AccountSyncCopyPlan, AccountSyncDataLocation, ProfileRef, ProfileRestartPlan, RuntimeProfile } from "./internal-types";
import { addRuntimeProcess, attachListeningPorts, emptyRuntimeProfile, findExternalChromeInstances, getCdpClientsByPort, getChromeProcessPids, getOpenProfilePidsByPath, isChromeRunning, isImplicitDefaultChromeProcess, makeNativeRuntimeKey, mergeRuntimeProfiles, parseRuntimeProcess } from "./process-scan";
import { ProfileManagerError } from "./profile-manager-error";

export { ProfileManagerError } from "./profile-manager-error";

export const APP_TITLE = "ProfilePilot";
const CHROME_REMOTE_DEBUGGING_URL = "chrome://inspect/#remote-debugging";
const MINI_PROFILE_LIMIT = 3;

// 实时摘要的“域名 ↔ IP”解析缓存：getState 高频调用，缓存解析结果，避免每轮都打 DNS。
const liveAddrCache = new Map<string, { value: { host: string | null; ip: string | null }; at: number }>();
const LIVE_ADDR_TTL_MS = 5 * 60 * 1000;

// 把当前页 URL 的主机名解析成“域名 + IP”两种表示，供前端点击切换：
// URL 用域名 → lookup 出 IP；URL 用 IP → reverse(PTR) 反查域名（公网 IP 多半反查到云厂商 PTR，不保证是访问的域名）。
// 带超时与 5 分钟缓存，任一步失败即返回 null，绝不阻塞 getState。
async function resolveLiveAddr(url: string | null): Promise<{ host: string | null; ip: string | null }> {
  if (!url) {
    return { host: null, ip: null };
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { host: null, ip: null };
  }
  if (!hostname) {
    return { host: null, ip: null };
  }

  const cached = liveAddrCache.get(hostname);
  if (cached && Date.now() - cached.at < LIVE_ADDR_TTL_MS) {
    return cached.value;
  }

  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

  let value: { host: string | null; ip: string | null };
  if (net.isIP(hostname)) {
    const names = await withTimeout(dnsPromises.reverse(hostname), 900);
    value = { host: names && names.length ? names[0] : null, ip: hostname };
  } else {
    // 优先 IPv4（更短、更眼熟）；没有 A 记录再退回系统默认（可能是 IPv6）。
    const lookup =
      (await withTimeout(dnsPromises.lookup(hostname, { family: 4 }), 900)) ||
      (await withTimeout(dnsPromises.lookup(hostname), 900));
    value = { host: hostname, ip: lookup ? lookup.address : null };
  }

  liveAddrCache.set(hostname, { value, at: Date.now() });
  return value;
}

export class ProfileManager {
  private readonly profilesDir: string;
  private readonly registryPath: string;
  // 防止同一 Profile 被并发启动（两次快速点击各自通过“未运行”检查后同时拉起 Chrome）。
  private readonly inFlightLaunches = new Set<string>();
  // 防止同一 Profile 被并发删除（并发删除时回滚会把对方已删的条目错误恢复，造成 registry 与磁盘不一致）。
  private readonly inFlightDeletions = new Set<string>();
  // 串行化 registry 写入，避免并发写交错或临时文件相互覆盖。
  private registryWriteChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir = defaultDataDir()) {
    this.profilesDir = path.join(dataDir, "profiles");
    this.registryPath = path.join(dataDir, "profiles.json");
  }

  private acquireLaunchLock(profileId: string): void {
    if (this.inFlightLaunches.has(profileId)) {
      throw new ProfileManagerError("这个 Profile 正在启动中，请稍候再试。", "PROFILE_LAUNCH_IN_FLIGHT");
    }
    this.inFlightLaunches.add(profileId);
  }

  private signalPids(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!isProcessGoneError(error)) {
          throw error;
        }
      }
    }
  }

  async getState(): Promise<AppState> {
    const registry = await this.loadRegistry();
    const nativeChromeProfiles = await scanNativeChromeProfiles();
    const nativePaths = nativeChromeProfiles.map((profile) => profile.path);
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const runtime = await this.getRuntime(nativePaths.concat(isolatedPaths), nativeChromeProfiles);

    const nativeProfiles = nativeChromeProfiles.map((profile) => this.toNativePublicProfile(profile, registry, runtime));
    const isolatedProfiles = (await Promise.all(
      registry.profiles.map((profile) => this.toIsolatedPublicProfile(profile, runtime))
    )).sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt || "";
        const bTime = b.lastLaunchedAt || b.createdAt || "";
        return bTime.localeCompare(aTime);
      });
    const profiles = [...nativeProfiles, ...isolatedProfiles];

    // 补算副本组信息：每个副本解析出源名，每个源统计有多少副本指向它。
    const profileNameById = new Map(profiles.map((profile) => [profile.id, profile.name]));
    const cloneCountBySource = new Map<string, number>();
    for (const profile of profiles) {
      if (profile.clonedFromProfileId) {
        cloneCountBySource.set(profile.clonedFromProfileId, (cloneCountBySource.get(profile.clonedFromProfileId) || 0) + 1);
      }
    }
    profiles.forEach((profile) => {
      profile.clonedFromName = profile.clonedFromProfileId ? profileNameById.get(profile.clonedFromProfileId) || null : null;
      profile.cloneCount = cloneCountBySource.get(profile.id) || 0;
    });

    // 标记“谁在持久连接这些 Profile 的 CDP 端口”（agent-browser 等驱动工具）。
    const cdpPorts = profiles
      .filter((profile) => profile.cdpPort !== null)
      .map((profile) => profile.cdpPort as number);
    const cdpClientsByPort = await getCdpClientsByPort(cdpPorts);
    // ProfilePilot 自己也会连这些 CDP 端口去抓实时观测数据（标签页 / 截图），
    // 这些自连接不是“外部驱动工具”，必须排除，否则会把自己显示成“驱动中：Electron”。
    const selfPids = new Set(app.getAppMetrics().map((metric) => metric.pid));
    profiles.forEach((profile) => {
      if (profile.cdpPort === null) {
        return;
      }
      const profilePids = new Set(profile.pids);
      // 排除 Chrome 自己的 socket 和 ProfilePilot 自身进程，只留真正的外部驱动工具（agent-browser 等）。
      profile.cdpClients = (cdpClientsByPort.get(profile.cdpPort) || []).filter(
        (client) => !profilePids.has(client.pid) && !selfPids.has(client.pid)
      );
    });

    // 实时摘要：每个有 CDP 端口的 Profile 当前停在哪个页面、开了几个标签（轻量，不抓截图）。
    // 给表格行 / 悬浮窗卡片 / 「在飞中」总览统一供数；详情侧栏的画面截图仍走独立的 getCdpLiveView。
    const liveSummaryByPort = new Map<number, { primaryUrl: string | null; tabCount: number }>();
    await Promise.all(
      [...new Set(cdpPorts)].map(async (port) => {
        const targets = await requestCdpTargets(port).catch(() => []);
        const pages = targets.filter((target) => target.type === "page");
        liveSummaryByPort.set(port, { primaryUrl: pages[0]?.url || null, tabCount: pages.length });
      })
    );
    await Promise.all(
      profiles.map(async (profile) => {
        if (profile.cdpPort === null) {
          return;
        }
        const summary = liveSummaryByPort.get(profile.cdpPort);
        profile.livePrimaryUrl = summary?.primaryUrl ?? null;
        profile.liveTabCount = summary?.tabCount ?? null;
        const addr = await resolveLiveAddr(summary?.primaryUrl ?? null);
        profile.liveHost = addr.host;
        profile.liveIp = addr.ip;
      })
    );

    // 标记当前写入全局 AGENTS.md 的 Agent 调试端点指向哪个 Profile。
    const agentConfig = await readAgentBrowserConfig();
    if (agentConfig) {
      const target = profiles.find((profile) => profile.id === agentConfig.profileId);
      if (target) {
        target.agentConfigPort = agentConfig.port;
      }
    }

    const runningProfiles = profiles.filter((profile) => profile.running);
    const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;
    const externalInstances = await findExternalChromeInstances([
      ...isolatedPaths,
      nativeChromeUserDataDir(),
      this.dataDir
    ]);
    const validProfileIds = new Set(profiles.map((profile) => profile.id));
    const miniProfileIds = normalizeMiniProfileIds(registry.miniProfileIds, validProfileIds);
    const miniProfileIdSet = new Set(miniProfileIds);
    profiles.forEach((profile) => {
      profile.pinnedToMini = miniProfileIdSet.has(profile.id);
    });

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
      externalInstances,
      miniProfileIds
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

    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: false });
    try {
      registry.profiles.push(profile);
      await this.saveRegistry(registry);
    } catch (error) {
      // 登记失败时清理刚建好的目录，避免留下未登记的孤儿 Profile 目录。
      await fs.rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

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
    this.acquireLaunchLock(profileId);
    try {
      await this.recoverAccountSyncArtifactsBeforeLaunch(profileId);
      const ref = parseProfileId(profileId);

      if (ref.source === "native") {
        await this.launchNativeProfile(ref.dirName);
        return;
      }

      await this.launchIsolatedProfile(ref.id);
    } finally {
      this.inFlightLaunches.delete(profileId);
    }
  }

  async launchProfileWithCdp(profileId: string, portInput?: number | null): Promise<void> {
    const ref = parseProfileId(profileId);
    if (ref.source === "native") {
      throw new ProfileManagerError(
        "CDP 启动只支持工具独立 Profile。请先创建独立 Profile，再用于 Agent/browser 自动化。",
        "CDP_NATIVE_UNSUPPORTED"
      );
    }

    this.acquireLaunchLock(profileId);
    try {
      await this.recoverAccountSyncArtifactsBeforeLaunch(profileId);
      await this.launchIsolatedProfileWithCdp(ref.id, portInput);
    } finally {
      this.inFlightLaunches.delete(profileId);
    }
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

  async suggestCdpPort(preferredPortInput?: number | null): Promise<CdpPortSuggestion> {
    const preferredPort = normalizeCdpPortInput(preferredPortInput) ?? 9223;
    const port = await findAvailableCdpPort(preferredPort);
    const preferredAvailable = port === preferredPort;
    return {
      preferredPort,
      port,
      preferredAvailable,
      preferredOwner: preferredAvailable ? null : await describePortOwner(preferredPort)
    };
  }

  // 把该独立 Profile 绑定为固定调试端口，并写入全局 AGENTS.md，
  // 让 Claude Code 在用浏览器时优先连这个常驻 CDP 端点。
  async setAgentBrowserConfig(profileId: string, port: number): Promise<void> {
    const ref = parseProfileId(profileId);
    if (ref.source !== "isolated") {
      throw new ProfileManagerError("只有工具独立 Profile 才能设为 Agent 调试端点。", "ISOLATED_PROFILE_REQUIRED");
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new ProfileManagerError("调试端口必须是 1024-65535 之间的整数。", "INVALID_CDP_PORT");
    }

    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, ref.id);
    profile.fixedCdpPort = port;
    await this.saveRegistry(registry);

    await writeAgentBrowserConfigFile({ profileId: makeIsolatedProfileId(profile.id), name: profile.name, port });
  }

  async clearAgentBrowserConfig(_profileId: string): Promise<void> {
    // 只移除 AGENTS.md 里的指令块；Profile 的固定端口设置保留。
    await removeAgentBrowserConfigFile();
  }

  async setMiniProfilePinned(profileId: string, pinned: boolean): Promise<void> {
    const state = await this.getState();
    const validProfileIds = new Set(state.profiles.map((profile) => profile.id));
    if (!validProfileIds.has(profileId)) {
      throw new ProfileManagerError("没有找到这个 Profile。", "PROFILE_NOT_FOUND");
    }

    const registry = await this.loadRegistry();
    const current = normalizeMiniProfileIds(registry.miniProfileIds, validProfileIds);
    const hasProfile = current.includes(profileId);
    const next = pinned
      ? hasProfile
        ? current
        : [...current, profileId]
      : current.filter((id) => id !== profileId);

    if (next.length > MINI_PROFILE_LIMIT) {
      throw new ProfileManagerError(`Mini 最多只能固定 ${MINI_PROFILE_LIMIT} 个 Profile。`, "MINI_PROFILE_LIMIT");
    }

    await this.saveRegistry({
      ...registry,
      miniProfileIds: next
    });
  }

  async closeProfile(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      throw new ProfileManagerError("这个 Profile 当前未运行。", "PROFILE_NOT_RUNNING");
    }

    // 优雅关闭：让 Chrome 自己把 Cookies / 登录态 / 会话落盘并合并 WAL 后再退出，
    // 避免强杀打断写入导致登录态丢失（需要手动重开才恢复）。给足时间窗口。
    await this.requestGracefulClose(profile);
    if (await this.waitUntilProfileStops(profile.id, 9000)) {
      await this.settleAfterClose();
      return;
    }

    // 优雅退出超时（可能卡在 beforeunload 弹窗等）：补发 SIGTERM 再等一会。
    const afterGraceful = await this.getPublicProfile(profileId);
    if (!afterGraceful.running || !afterGraceful.pids.length) {
      await this.settleAfterClose();
      return;
    }
    this.signalPids(afterGraceful.pids, "SIGTERM");
    if (await this.waitUntilProfileStops(profile.id, 4000)) {
      await this.settleAfterClose();
      return;
    }

    // 仍未退出，强制结束残留进程，避免 UI 误报“已关闭”但 Chrome 仍在运行。
    const still = await this.getPublicProfile(profileId);
    if (!still.running || !still.pids.length) {
      await this.settleAfterClose();
      return;
    }
    this.signalPids(still.pids, "SIGKILL");
    if (!(await this.waitUntilProfileStops(profile.id, 1500))) {
      throw new ProfileManagerError("无法结束这个 Profile 的 Chrome 进程，请手动关闭后重试。", "PROFILE_CLOSE_FAILED");
    }
    await this.settleAfterClose();
  }

  // 发起一次优雅关闭请求。macOS 上的系统 Chrome 优先用 AppleScript `quit`
  //（等同 ⌘Q 的干净退出），失败再退回 SIGTERM；其它情况直接发 SIGTERM。
  private async requestGracefulClose(profile: PublicProfile): Promise<void> {
    if (profile.source === "native" && process.platform === "darwin") {
      try {
        const appName = process.env.CHROME_APP_NAME || "Google Chrome";
        await execFileAsync("osascript", ["-e", `tell application "${appName}" to quit`], { timeout: 4000 });
        return;
      } catch {
        // AppleScript 退出失败或超时，退回信号方式。
      }
    }
    this.signalPids(profile.pids, "SIGTERM");
  }

  // Chrome 进程从进程表消失，不代表文件锁已释放、Cookies WAL 已合并完成。
  // 关闭后稍作等待再返回，避免随后的重新启动读到尚未落盘的半成品状态。
  private async settleAfterClose(): Promise<void> {
    await sleep(900);
  }

  private async closeChromeBeforeNativeDelete(): Promise<void> {
    const state = await this.getState();
    for (const profile of state.profiles.filter((item) => item.running)) {
      await this.closeProfileIfRunning(profile.id);
    }

    for (const instance of state.externalInstances.filter((item) => item.browser.startsWith("Google Chrome"))) {
      await this.closeExternalInstance(instance.userDataDir).catch((error) => {
        if (error instanceof ProfileManagerError && error.code === "EXTERNAL_INSTANCE_NOT_RUNNING") {
          return;
        }
        throw error;
      });
    }

    if (process.platform === "darwin") {
      try {
        const appName = process.env.CHROME_APP_NAME || "Google Chrome";
        await execFileAsync("osascript", ["-e", `tell application "${appName}" to quit`], { timeout: 4000 });
      } catch {
        // 若 AppleScript 没有权限或超时，继续用进程信号兜底。
      }
    }

    if (await this.waitUntilChromeStops(7000)) {
      await this.settleAfterClose();
      return;
    }

    const remainingPids = await getChromeProcessPids();
    if (remainingPids.length) {
      this.signalPids(remainingPids, "SIGTERM");
    }
    if (await this.waitUntilChromeStops(4000)) {
      await this.settleAfterClose();
      return;
    }

    const stuckPids = await getChromeProcessPids();
    if (stuckPids.length) {
      this.signalPids(stuckPids, "SIGKILL");
    }
    if (!(await this.waitUntilChromeStops(1500))) {
      throw new ProfileManagerError("无法结束正在运行的 Chrome，请手动关闭后重试。", "CHROME_CLOSE_FAILED");
    }
    await this.settleAfterClose();
  }

  private async waitUntilChromeStops(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isChromeRunning())) {
        return true;
      }
      await sleep(250);
    }

    return !(await isChromeRunning());
  }

  private async captureProfileRestartPlan(profile: PublicProfile): Promise<ProfileRestartPlan> {
    const urls = profile.cdpPort ? await snapshotRestorableTabUrls(profile.cdpPort).catch(() => []) : [];
    return {
      profileId: profile.id,
      profileName: profile.name,
      cdpPort: profile.cdpPort,
      urls
    };
  }

  private async closeProfileIfRunning(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      return;
    }

    await this.closeProfile(profileId);
  }

  private async restoreProfileFromRestartPlan(plan: ProfileRestartPlan, extraUrls: string[] = []): Promise<number> {
    await this.recoverAccountSyncArtifactsBeforeLaunch(plan.profileId);
    this.acquireLaunchLock(plan.profileId);
    try {
      const urls = appendUniqueExtraUrls(plan.urls, extraUrls);
      const ref = parseProfileId(plan.profileId);

      if (ref.source === "native") {
        if (urls.length) {
          await this.launchNativeProfileWithUrls(ref.dirName, urls);
        } else {
          await this.launchNativeProfile(ref.dirName);
        }
        return plan.urls.length;
      }

      if (urls.length) {
        await this.launchIsolatedProfileWithUrls(ref.id, urls, {
          cdpPort: plan.cdpPort,
          forceCdp: Boolean(plan.cdpPort)
        });
      } else if (plan.cdpPort) {
        await this.launchIsolatedProfileWithCdp(ref.id, plan.cdpPort);
      } else {
        await this.launchIsolatedProfile(ref.id);
      }
      return plan.urls.length;
    } finally {
      this.inFlightLaunches.delete(plan.profileId);
    }
  }

  async focusProfile(profileId: string): Promise<void> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      throw new ProfileManagerError("这个 Profile 当前未运行。", "PROFILE_NOT_RUNNING");
    }

    if (profile.cdpPort) {
      await bringCdpPageToFront(profile.cdpPort).catch(() => false);
    }

    if (profile.source === "native") {
      const raisedWindow = await focusProfileWindow(profile.pids);
      if (raisedWindow) {
        return;
      }

      throw new ProfileManagerError(
        "macOS 没有把这个系统 Chrome Profile 精确显示到最前面。多个 Google Chrome.app 实例同时运行时，系统的应用级激活可能会落到其它 Profile；请给 ProfilePilot 授予“辅助功能”权限，或先关闭其它 Chrome 实例后重试。",
        "FOCUS_PROFILE_UNCONFIRMED"
      );
    }

    const raisedWindow = await focusProfileWindow(profile.pids);
    if (raisedWindow) {
      return;
    }

    if (!(await hasRendererProcessForProfile(profile.path))) {
      await requestIsolatedProfileWindow(profile);
    }
    await sleep(700);

    const refreshedProfile = await this.getPublicProfile(profileId);
    const raisedAfterRequest = await focusProfileWindow(refreshedProfile.pids.length ? refreshedProfile.pids : profile.pids);
    if (raisedAfterRequest) {
      return;
    }

    throw new ProfileManagerError(
      "macOS 没有把这个独立 Profile 精确显示到最前面。若同一个 Google Chrome.app 同时开了多个实例，请先用 CDP 启动这个 Profile，或给 ProfilePilot 授予“辅助功能”权限后重试。",
      "FOCUS_PROFILE_UNCONFIRMED"
    );
  }

  async isProfileFrontmost(profileId: string): Promise<boolean> {
    const profile = await this.getPublicProfile(profileId);
    if (!profile.running || !profile.pids.length) {
      return false;
    }

    return isAnyMacProcessFrontmost(profile.pids);
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

    this.signalPids([instance.pid], "SIGTERM");
    if (await this.waitUntilExternalStops(userDataDir, 1800)) {
      return;
    }

    // 优雅关闭超时，强制结束。
    const still = await this.locateExternalInstance(userDataDir);
    if (still) {
      this.signalPids([still.pid], "SIGKILL");
      await this.waitUntilExternalStops(userDataDir, 1200);
    }
  }

  private async waitUntilExternalStops(userDataDir: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.locateExternalInstance(userDataDir))) {
        return true;
      }
      await sleep(200);
    }
    return false;
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

    // 渲染层传入的路径不可信：限制只能打开用户目录或本工具数据目录内的路径，
    // 防止被构造成打开系统任意位置。
    const resolved = path.resolve(targetPath);
    const allowedRoots = [path.resolve(os.homedir()), path.resolve(this.dataDir)];
    const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) {
      throw new ProfileManagerError("只允许打开用户目录内的路径。", "PATH_NOT_ALLOWED");
    }

    if (!(await exists(resolved))) {
      throw new ProfileManagerError(`路径不存在：${resolved}`, "PATH_NOT_FOUND");
    }

    const error = await shell.openPath(resolved);
    if (error) {
      throw new ProfileManagerError(`打开路径失败：${error}`, "OPEN_PATH_FAILED");
    }
  }

  async deleteProfile(profileId: string, options: DeleteProfileOptions = {}): Promise<DeleteProfileResult> {
    if (this.inFlightDeletions.has(profileId)) {
      throw new ProfileManagerError("这个 Profile 正在删除中，请稍候。", "PROFILE_DELETE_IN_FLIGHT");
    }
    this.inFlightDeletions.add(profileId);
    try {
      const ref = parseProfileId(profileId);
      if (ref.source === "native") {
        return await this.deleteNativeProfile(ref.dirName, options);
      }
      return await this.deleteIsolatedProfile(ref.id);
    } finally {
      this.inFlightDeletions.delete(profileId);
    }
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
          openInstallPages
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
      report(`正在记录并关闭目标 ${targetProfile.name}…`, "关闭目标", 2);
    }
    const targetRestartPlan = targetProfile.running ? await this.captureProfileRestartPlan(targetProfile) : null;
    const sourceRestartPlan =
      includeData && sourceProfile.running ? await this.captureProfileRestartPlan(sourceProfile) : null;
    if (targetProfile.running) {
      await this.closeProfileIfRunning(targetProfileId);
    }
    if (includeData && sourceProfile.running) {
      report(`正在记录并关闭源 ${sourceProfile.name} 以读取插件数据…`, "关闭源", 2);
      await this.closeProfileIfRunning(sourceProfileId);
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

    const persistExtensionInstall = async (extension: ProfileExtensionInfo): Promise<boolean> => {
      if (!extension.path) {
        return false;
      }
      if (!(await exists(path.join(extension.path, "manifest.json")))) {
        skippedExtensions.push({
          id: extension.id,
          name: extension.name,
          reason: "源插件目录缺少 manifest.json，无法写入持久安装记录"
        });
        return false;
      }

      const installRecord = await readProtectedExtensionInstallRecord(sourceProfileDataPath, extension.id);
      if (!installRecord) {
        return false;
      }

      report(`正在写入插件持久安装记录：${extension.name}`, "同步插件", 4);
      let installedPath = extension.path;
      if (extension.fromWebStore || isProfileRelativeExtensionSetting(installRecord.setting)) {
        installedPath = await copyExtensionPackageToProfile(extension, sourceProfileDataPath, targetProfileDataPath);
      }

      const developerModeRecord = extension.fromWebStore ? null : await getProtectedDeveloperModeRecord(targetProfileDataPath);
      await removeExtensionReferencesFromProfilePreferences(targetProfileDataPath, extension.id);
      await writeProtectedExtensionInstallRecord(targetProfileDataPath, extension.id, installRecord, developerModeRecord);
      await this.removeMigratedExtensionReference(targetProfile, extension.id);

      copiedExtensions.push({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        path: installedPath,
        fromWebStore: extension.fromWebStore
      });
      await copyExtensionData(extension);
      return true;
    };

    // 复制插件的可同步数据（Local/Sync Extension Settings、IndexedDB 等）。
    // 商店重装后扩展 ID 与源一致，预先铺好数据目录，装完即可读到原配置。
    const copyExtensionData = async (extension: ProfileExtensionInfo): Promise<void> => {
      if (!includeData) {
        return;
      }
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

        if (canPersistExtensionInstall(extension)) {
          if (await persistExtensionInstall(extension)) {
            continue;
          }
        }

        if (diffItem?.status === "needs_install_page") {
          if (extension.storeUrl) {
            webStoreInstallUrls.push(extension.storeUrl);
          }
          // 即便走商店安装，也先把配置数据铺好，避免装完是一个空配置的插件。
          await copyExtensionData(extension);
          skippedExtensions.push({
            id: extension.id,
            name: extension.name,
            reason: openInstallPages ? "需要在打开的安装页确认安装" : "需要打开安装页后手动确认安装"
          });
          continue;
        }

        if (canLoadLocalExtensionViaCdp(extension, targetProfile)) {
          await copyExtensionData(extension);
          await registerLocalExtensionForRuntimeLoad(extension);
          continue;
        }

        if (extension.path && !canAutoLoadUnpacked) {
          if (extension.fromWebStore && extension.storeUrl) {
            webStoreInstallUrls.push(extension.storeUrl);
            // 官方 Chrome 只能从商店重装，但配置数据仍可预先复制（ID 一致）。
            await copyExtensionData(extension);
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

        await copyExtensionData(extension);
      }

      if (extensionsForRegistry.length) {
        report(`正在写入 ${targetProfile.name} 的插件启动配置…`, "写入配置", 5);
        await this.mergeMigratedExtensions(targetProfile, extensionsForRegistry);
      }

      let openedInstallPages = false;
      let reopenedTarget = false;
      let reopenedSource = false;
      let restoredTargetTabs = 0;
      let restoredSourceTabs = 0;
      const manualLoadNeeded = skippedExtensions.some((extension) => isManualLoadSkipReason(extension.reason));
      const pagesToOpen = uniqueStrings([...webStoreInstallUrls, ...(manualLoadNeeded ? ["chrome://extensions/"] : [])]);
      const installPagesToOpen = openInstallPages ? pagesToOpen : [];
      if (targetRestartPlan) {
        report(
          installPagesToOpen.length
            ? `正在恢复 ${targetProfile.name} 的标签页并打开确认页面…`
            : `正在重新打开 ${targetProfile.name} 并恢复标签页…`,
          "完成",
          6
        );
        restoredTargetTabs = await this.restoreProfileFromRestartPlan(targetRestartPlan, installPagesToOpen);
        reopenedTarget = true;
        openedInstallPages = installPagesToOpen.length > 0;
      } else if (installPagesToOpen.length) {
        report(`正在打开 ${targetProfile.name} 需要确认的页面…`, "写入配置", 5);
        await this.launchProfileWithUrls(targetProfile.id, installPagesToOpen);
        reopenedTarget = true;
        openedInstallPages = true;
      }

      if (sourceRestartPlan) {
        report(`正在重新打开源 ${sourceProfile.name} 并恢复标签页…`, "完成", 6);
        restoredSourceTabs = await this.restoreProfileFromRestartPlan(sourceRestartPlan);
        reopenedSource = true;
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
        reopenedTarget,
        reopenedSource,
        restoredTargetTabs,
        restoredSourceTabs,
        state: await this.getState()
      };
    } catch (error) {
      try {
        await this.discardMigratedExtensions(targetProfile, extensionsForRegistry);
      } catch (rollbackError) {
        // 回滚失败不掩盖原始迁移错误，但记录下来，便于排查残留状态。
        console.error("[profilepilot] 插件迁移回滚失败：", rollbackError);
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

    const targetRestartPlan =
      targetProfile.running && launchTarget ? await this.captureProfileRestartPlan(targetProfile) : null;
    if (targetProfile.running) {
      report(`正在关闭 ${targetProfile.name} 以写入账号数据…`, "关闭目标", 2, 7);
      await this.closeProfileIfRunning(targetProfileId);
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
    const targetExtensionPreferences = await snapshotAccountSyncExtensionPreferences(targetLocation.profilePath);
    const copyPlans: AccountSyncCopyPlan[] = [];

    for (const [index, spec] of copySpecs.entries()) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      const itemPosition = `${index + 1}/${copySpecs.length}`;
      report(`正在预估账号数据大小 ${itemPosition}：${spec.label}…`, "磁盘预检测", 3);
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
      const stats = await collectAccountSyncPathStats(sourcePath, abortSignal, pauseSignal);
      copyPlans.push({ spec, index, sourcePath, targetPath, stats });
    }

    report("正在检查目标磁盘空间…", "磁盘预检测", 3);
    await assertAccountSyncDiskSpace(targetLocation.profilePath, copyPlans, abortSignal, pauseSignal);

    for (const plan of copyPlans) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      const itemPosition = `${plan.index + 1}/${copySpecs.length}`;
      const reportCopyProgress = (detail: string): void => {
        report(`正在复制账号数据 ${itemPosition}：${plan.spec.label}${detail ? ` · ${detail}` : ""}`, "复制账号数据", 3);
      };
      reportCopyProgress("准备中");
      await copyAccountSyncPath(plan.sourcePath, plan.targetPath, reportCopyProgress, abortSignal, pauseSignal, plan.stats);
      copiedItems.push({
        label: plan.spec.label,
        relativePath: plan.spec.relativePath
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

    report("正在保留目标插件状态…", "写入浏览器状态", 5);
    const restoredExtensionPreferences = await restoreAccountSyncExtensionPreferences(
      targetLocation.profilePath,
      targetExtensionPreferences
    );
    skippedItems.push({
      label: "插件安装状态",
      relativePath: "Preferences / Secure Preferences",
      reason: restoredExtensionPreferences
        ? "账号同步已保留目标 Profile 原有插件状态，未复制源 Profile 的插件安装记录"
        : "账号同步不会复制源 Profile 的插件安装记录"
    });

    let launchedTarget = false;
    let restoredTargetTabs = 0;
    if (launchTarget) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      report(
        targetRestartPlan
          ? `正在重新打开 ${targetProfile.name} 并恢复标签页…`
          : `正在启动 ${targetProfile.name}…`,
        "完成",
        6
      );
      if (targetRestartPlan) {
        restoredTargetTabs = await this.restoreProfileFromRestartPlan(targetRestartPlan);
      } else {
        await this.launchProfile(targetProfileId);
      }
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
      restoredTargetTabs,
      state: await this.getState()
    };
  }

  // “一键造 Agent 浏览器”：新建独立 Profile → 从源同步登录态 → 按需同步插件 →
  // 绑定固定端口并写入全局 AGENTS.md → 以 CDP 模式启动，得到一个登录态就绪、可直接给 agent 连接的浏览器。
  async setupAgentBrowser(
    request: SetupAgentBrowserRequest,
    onProgress?: (progress: OperationProgressUpdate) => void,
    abortSignal?: AbortSignal,
    pauseSignal?: OperationPauseSignal
  ): Promise<SetupAgentBrowserResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const requestedPort = normalizeCdpPortInput(request.port);
    let port = requestedPort === null ? null : await findAvailableCdpPort(requestedPort);
    const includeExtensions = request.includeExtensions !== false;
    if (requestedPort === null || port === null) {
      throw new ProfileManagerError("固定调试端口必须是 1024-65535 之间的整数。", "INVALID_CDP_PORT");
    }

    const TOTAL = includeExtensions ? 5 : 4;
    const report = (message: string, step: string, stepIndex: number): void => {
      onProgress?.({ message, step, stepIndex, stepCount: TOTAL });
    };

    const state = await this.getState();
    const source = state.profiles.find((profile) => profile.id === sourceProfileId);
    if (!source) {
      throw new ProfileManagerError("没有找到作为登录态来源的 Profile。", "PROFILE_NOT_FOUND");
    }

    report("正在创建 Agent 专用 Profile…", "创建 Profile", 1);
    if (port !== requestedPort) {
      report(`端口 ${requestedPort} 已被占用，已自动改用 ${port}。`, "创建 Profile", 1);
    }
    const name = normalizeProfileName(request.targetName || `agent-${source.name}`);
    const created = await this.createProfile(name);
    const targetId = makeIsolatedProfileId(created.id);

    let copiedItems: AccountSyncCopiedItem[] = [];
    let extensionResult: ExtensionMigrationResult | null = null;
    try {
      report("正在从源 Profile 同步登录态…", "同步登录态", 2);
      const syncResult = await this.syncAccount(
        { sourceProfileId, targetProfileId: targetId, launchTarget: false, onlyChanged: false },
        (update) => report(update.message, "同步登录态", 2),
        abortSignal,
        pauseSignal
      );
      copiedItems = syncResult.copiedItems;

      if (includeExtensions) {
        report("正在扫描并同步插件…", "同步插件", 3);
        const scan = await this.scanProfileExtensions(sourceProfileId);
        const extensionIds = scan.extensions.map((extension) => extension.id);
        if (extensionIds.length) {
          extensionResult = await this.migrateExtensions(
            {
              sourceProfileId,
              targetProfileId: targetId,
              extensionIds,
              includeData: false,
              openInstallPages: false,
              onlyChanged: false
            },
            (update) => report(update.message, "同步插件", 3)
          );
        }
      }

      const configStep = includeExtensions ? 4 : 3;
      const launchStep = includeExtensions ? 5 : 4;
      const latestAvailablePort = await findAvailableCdpPort(port);
      if (latestAvailablePort !== port) {
        report(`端口 ${port} 已被占用，已自动改用 ${latestAvailablePort}。`, "写入配置", configStep);
        port = latestAvailablePort;
      }
      report("正在写入 Agent 调试配置（AGENTS.md）…", "写入配置", configStep);
      await this.setAgentBrowserConfig(targetId, port);

      report("正在以 CDP 模式启动…", "CDP 启动", launchStep);
      await this.launchProfileWithCdp(targetId, port);
    } catch (error) {
      // 任何一步失败（含用户中止）都清理掉这个半成品 Agent Profile，避免留下垃圾。
      await this.deleteProfile(targetId).catch(() => undefined);
      throw error;
    }

    const finalState = await this.getState();
    const profile = finalState.profiles.find((item) => item.id === targetId) || null;
    return {
      profileId: targetId,
      profileName: name,
      port,
      cdpUrl: profile?.cdpUrl || makeCdpUrl(port),
      copiedItems,
      extensionResult,
      state: finalState
    };
  }

  // 副本池：把一个登录态 Profile 批量克隆成 N 份隔离副本，每份独立 CDP 端口、登录态一致。
  // 复用单份链路 createProfile → syncAccount →（可选）migrateExtensions，再绑定固定端口与副本来源。
  async cloneProfiles(
    request: CloneProfilesRequest,
    onProgress?: (progress: OperationProgressUpdate) => void,
    abortSignal?: AbortSignal,
    pauseSignal?: OperationPauseSignal
  ): Promise<CloneProfilesResult> {
    const sourceProfileId = String(request.sourceProfileId || "");
    const count = Math.floor(Number(request.count));
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new ProfileManagerError("副本份数必须是 1-20 之间的整数。", "INVALID_CLONE_COUNT");
    }
    const includeExtensions = Boolean(request.includeExtensions);
    const launchAfter = Boolean(request.launchAfter);
    const setAgentEndpoint = Boolean(request.setAgentEndpoint);

    const state = await this.getState();
    const source = state.profiles.find((profile) => profile.id === sourceProfileId);
    if (!source) {
      throw new ProfileManagerError("没有找到作为登录态来源的 Profile。", "PROFILE_NOT_FOUND");
    }

    const prefix = normalizeProfileName(request.namePrefix || source.name).slice(0, 70);
    let nextPortSeed = normalizeCdpPortInput(request.basePort) ?? (await findAvailableCdpPort(9223));
    const report = (message: string, stepIndex: number): void => {
      onProgress?.({ message, step: `克隆 ${stepIndex}/${count}`, stepIndex, stepCount: count });
    };

    const created: ClonedProfileInfo[] = [];
    const usedNames = new Set(state.profiles.map((profile) => profile.name));

    for (let i = 0; i < count; i += 1) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      const name = nextUniqueCloneName(prefix, usedNames);
      usedNames.add(name);
      report(`正在创建副本 ${i + 1}/${count}：${name}…`, i + 1);
      const createdProfile = await this.createProfile(name);
      const targetId = makeIsolatedProfileId(createdProfile.id);
      try {
        report(`正在为 ${name} 同步登录态（${i + 1}/${count}）…`, i + 1);
        await this.syncAccount(
          { sourceProfileId, targetProfileId: targetId, launchTarget: false, onlyChanged: false },
          (update) => report(update.message, i + 1),
          abortSignal,
          pauseSignal
        );

        if (includeExtensions) {
          report(`正在为 ${name} 同步插件（${i + 1}/${count}）…`, i + 1);
          const scan = await this.scanProfileExtensions(sourceProfileId);
          const extensionIds = scan.extensions.map((extension) => extension.id);
          if (extensionIds.length) {
            await this.migrateExtensions(
              {
                sourceProfileId,
                targetProfileId: targetId,
                extensionIds,
                includeData: false,
                openInstallPages: false,
                onlyChanged: false
              },
              (update) => report(update.message, i + 1)
            );
          }
        }

        const port = await findAvailableCdpPort(nextPortSeed);
        nextPortSeed = port + 1;
        await this.setStoredCloneMeta(targetId, { fixedCdpPort: port, clonedFromProfileId: sourceProfileId });

        let launched = false;
        if (launchAfter) {
          report(`正在以 CDP 启动 ${name}（${i + 1}/${count}）…`, i + 1);
          await this.launchProfileWithCdp(targetId, port);
          launched = true;
          nextPortSeed = port + 1;
        }
        created.push({ profileId: targetId, name, port, launched });
      } catch (error) {
        // 当前这份失败（含用户中止）：清理半成品；前面已成功的副本保留。
        await this.deleteProfile(targetId).catch(() => undefined);
        throw error;
      }
    }

    // 可选：把第一份副本写入全局 AGENTS.md，作为 Agent 的固定调试端点（等同旧「一键造 Agent 浏览器」）。
    if (setAgentEndpoint && created[0]?.port) {
      await this.setAgentBrowserConfig(created[0].profileId, created[0].port);
    }

    return { sourceProfileId, created, state: await this.getState() };
  }

  // 副本池：以源为准，把该源的全部副本登录态刷新一遍（onlyChanged 走增量，快）。
  async refreshClones(
    sourceProfileId: string,
    onProgress?: (progress: OperationProgressUpdate) => void,
    abortSignal?: AbortSignal,
    pauseSignal?: OperationPauseSignal
  ): Promise<RefreshClonesResult> {
    const sourceId = String(sourceProfileId || "");
    const registry = await this.loadRegistry();
    const clones = registry.profiles.filter((profile) => profile.clonedFromProfileId === sourceId);
    if (!clones.length) {
      throw new ProfileManagerError("这个源 Profile 还没有任何副本。", "NO_CLONES");
    }

    const refreshed: RefreshClonesResult["refreshed"] = [];
    let skippedCount = 0;
    for (const [index, clone] of clones.entries()) {
      throwIfAborted(abortSignal);
      await waitIfPaused(pauseSignal, abortSignal);
      const targetId = makeIsolatedProfileId(clone.id);
      const report = (message: string): void => {
        onProgress?.({ message, step: `刷新 ${index + 1}/${clones.length}`, stepIndex: index + 1, stepCount: clones.length });
      };
      report(`正在刷新副本 ${index + 1}/${clones.length}：${clone.name}…`);
      try {
        const result = await this.syncAccount(
          { sourceProfileId: sourceId, targetProfileId: targetId, launchTarget: false, onlyChanged: true },
          (update) => report(update.message),
          abortSignal,
          pauseSignal
        );
        refreshed.push({ profileId: targetId, name: clone.name, copiedCount: result.copiedItems.length });
      } catch (error) {
        if (error instanceof ProfileManagerError && error.code === "ACCOUNT_SYNC_SOURCE_EMPTY") {
          skippedCount += 1;
          continue;
        }
        throw error;
      }
    }

    return { sourceProfileId: sourceId, refreshedCount: refreshed.length, skippedCount, refreshed, state: await this.getState() };
  }

  // 副本池：把某个副本重置为干净态——以它记录的源为准，重新覆盖一次登录态（onlyChanged:false）。
  async resetClone(
    profileId: string,
    onProgress?: (progress: OperationProgressUpdate) => void,
    abortSignal?: AbortSignal,
    pauseSignal?: OperationPauseSignal
  ): Promise<AccountSyncResult> {
    const ref = parseProfileId(profileId);
    if (ref.source !== "isolated") {
      throw new ProfileManagerError("只有副本（独立 Profile）支持重置。", "ISOLATED_PROFILE_REQUIRED");
    }
    const registry = await this.loadRegistry();
    const stored = this.findIsolatedProfile(registry, ref.id);
    if (!stored.clonedFromProfileId) {
      throw new ProfileManagerError("这个 Profile 不是副本，没有可重置回去的源。", "NOT_A_CLONE");
    }

    return this.syncAccount(
      { sourceProfileId: stored.clonedFromProfileId, targetProfileId: profileId, launchTarget: false, onlyChanged: false },
      onProgress,
      abortSignal,
      pauseSignal
    );
  }

  // 副本池：回收 N 天未使用的空闲副本（未运行、且最近启动/创建时间早于截止）。
  async recycleIdleClones(daysInput: number): Promise<RecycleIdleClonesResult> {
    const days = Math.floor(Number(daysInput));
    if (!Number.isInteger(days) || days < 0) {
      throw new ProfileManagerError("天数必须是大于等于 0 的整数。", "INVALID_RECYCLE_DAYS");
    }

    const state = await this.getState();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const candidates = state.profiles.filter((profile) => {
      if (profile.source !== "isolated" || !profile.clonedFromProfileId || profile.running) {
        return false;
      }
      const reference = Date.parse(profile.lastLaunchedAt || profile.createdAt || "");
      return Number.isFinite(reference) && reference <= cutoff;
    });

    const deleted: RecycleIdleClonesResult["deleted"] = [];
    for (const profile of candidates) {
      try {
        await this.deleteProfile(profile.id);
        deleted.push({ profileId: profile.id, name: profile.name });
      } catch (error) {
        console.warn(`[profilepilot] 回收闲置副本失败：${profile.name}`, error);
      }
    }

    return { days, deleted, state: await this.getState() };
  }

  // 副本池：给某个副本设置/清除项目标签（纯展示，不影响登录态）。
  async setProfileTag(profileId: string, tagInput: string): Promise<void> {
    const tag = String(tagInput || "").trim().slice(0, 40);
    await this.setStoredCloneMeta(profileId, { projectTag: tag || null });
  }

  // 副本池：批量以 CDP 启动该源下所有未运行的副本（各用自己的固定端口）。
  async launchClones(
    sourceProfileId: string,
    onProgress?: (progress: OperationProgressUpdate) => void
  ): Promise<LaunchClonesResult> {
    const sourceId = String(sourceProfileId || "");
    const state = await this.getState();
    const clones = state.profiles.filter(
      (profile) => profile.source === "isolated" && profile.clonedFromProfileId === sourceId && !profile.running
    );
    if (!clones.length) {
      throw new ProfileManagerError("没有可启动的空闲副本。", "NO_IDLE_CLONES");
    }

    const launched: LaunchClonesResult["launched"] = [];
    const failed: LaunchClonesResult["failed"] = [];
    for (const [index, clone] of clones.entries()) {
      onProgress?.({
        message: `正在启动副本 ${index + 1}/${clones.length}：${clone.name}…`,
        step: `启动 ${index + 1}/${clones.length}`,
        stepIndex: index + 1,
        stepCount: clones.length
      });
      try {
        await this.launchProfileWithCdp(clone.id, clone.fixedCdpPort ?? null);
        launched.push({ profileId: clone.id, name: clone.name, port: clone.fixedCdpPort ?? null });
      } catch (error) {
        failed.push({ profileId: clone.id, name: clone.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { sourceProfileId: sourceId, launched, failed, state: await this.getState() };
  }

  // 改写独立 Profile 的副本元数据（固定端口 / 克隆来源 / 项目标签），只动 registry，不写 AGENTS.md。
  private async setStoredCloneMeta(
    profileId: string,
    meta: { fixedCdpPort?: number | null; clonedFromProfileId?: string | null; projectTag?: string | null }
  ): Promise<void> {
    const ref = parseProfileId(profileId);
    if (ref.source !== "isolated") {
      throw new ProfileManagerError("只有工具独立 Profile 才支持副本元数据。", "ISOLATED_PROFILE_REQUIRED");
    }
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, ref.id);
    if (meta.fixedCdpPort !== undefined) {
      profile.fixedCdpPort = meta.fixedCdpPort;
    }
    if (meta.clonedFromProfileId !== undefined) {
      profile.clonedFromProfileId = meta.clonedFromProfileId;
    }
    if (meta.projectTag !== undefined) {
      profile.projectTag = meta.projectTag;
    }
    await this.saveRegistry(registry);
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

    // 用户没显式填端口时，回落到该 Profile 绑定的固定端口（用于 Agent 调试的恒定端点）。
    const requestedPort = normalizeCdpPortInput(portInput) ?? profile.fixedCdpPort ?? null;
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

  private async launchIsolatedProfileWithUrls(
    id: string,
    urls: string[],
    options: { cdpPort?: number | null; forceCdp?: boolean } = {}
  ): Promise<void> {
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, id);
    const cdpPort = await this.launchStoredIsolatedProfile(profile, {
      urls,
      cdpPort: options.cdpPort,
      forceCdp: options.forceCdp
    });
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

  private async deleteNativeProfile(dirName: string, options: DeleteProfileOptions): Promise<DeleteProfileResult> {
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.source === "native" && item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("没有找到这个 Chrome Profile。", "PROFILE_NOT_FOUND");
    }
    if (profile.isDefault) {
      throw new ProfileManagerError("默认 Chrome Profile 受保护，不能删除。", "DEFAULT_PROFILE_PROTECTED");
    }
    if (profile.running) {
      await this.closeProfileIfRunning(profile.id);
    }
    if (await isChromeRunning()) {
      if (!options.quitChromeBeforeDelete) {
        throw new ProfileManagerError("删除 Chrome Profile 前请先退出 Chrome。", "CHROME_RUNNING");
      }
      await this.closeChromeBeforeNativeDelete();
    }
    if (await isChromeRunning()) {
      throw new ProfileManagerError("删除 Chrome Profile 前请先退出 Chrome。", "CHROME_RUNNING");
    }

    const trashPath = await this.moveToTrash(profile.path, profile.dirName);
    await removeNativeProfileFromLocalState(profile.dirName);
    const registry = await this.loadRegistry();
    let registryChanged = false;
    if (registry.nativeProfiles) {
      delete registry.nativeProfiles[profile.dirName];
      registryChanged = true;
    }
    const nextMiniProfileIds = (registry.miniProfileIds || []).filter((id) => id !== profile.id);
    if (nextMiniProfileIds.length !== (registry.miniProfileIds || []).length) {
      registry.miniProfileIds = nextMiniProfileIds;
      registryChanged = true;
    }
    if (registryChanged) {
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
      await this.closeProfileIfRunning(profile.id);
    }

    const publicProfile = profile || (await this.toIsolatedPublicProfile(storedProfile, new Map()));
    const nextProfiles = registry.profiles.filter((item) => item.id !== id);
    const deletedProfileId = makeIsolatedProfileId(id);
    const accountSyncRecords = Object.fromEntries(
      Object.entries(registry.accountSyncRecords || {}).filter(
        ([, record]) => record.sourceProfileId !== deletedProfileId && record.targetProfileId !== deletedProfileId
      )
    );

    // 先从 registry 移除条目（含同步记录），再移到废纸篓：
    // 这样即便移废纸篓后崩溃，剩下的也只是无害的孤儿目录，而不是“界面里有但目录已没”的孤儿条目。
    await this.saveRegistry({
      ...registry,
      profiles: nextProfiles,
      accountSyncRecords,
      miniProfileIds: (registry.miniProfileIds || []).filter((profileId) => profileId !== deletedProfileId)
    });
    let trashPath: string | null;
    try {
      trashPath = await this.moveToTrash(this.isolatedProfilePath(storedProfile), storedProfile.dirName);
    } catch (error) {
      // 移废纸篓失败：把刚移除的条目回滚回去，保持 registry 与磁盘一致。
      await this.saveRegistry(registry).catch(() => undefined);
      throw error;
    }

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
        accountSyncRecords,
        miniProfileIds: normalizeMiniProfileIds(parsed.miniProfileIds)
      };
    } catch (error) {
      const backup = `${this.registryPath}.broken-${Date.now()}`;
      // 注册表损坏不静默吞掉：记录并把损坏文件备份到 .broken-<ts>，数据仍可人工恢复。
      console.error(`[profilepilot] profiles.json 解析失败，已备份到 ${backup} 并以空注册表启动：`, error);
      try {
        await fs.rename(this.registryPath, backup);
      } catch {
        // 无法备份损坏文件时也只能干净启动。
      }
      return { profiles: [], nativeProfiles: {}, accountSyncRecords: {}, miniProfileIds: [] };
    }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    const snapshot = `${JSON.stringify(registry, null, 2)}\n`;
    const run = async (): Promise<void> => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmpPath = `${this.registryPath}.tmp-${process.pid}`;
      try {
        await fs.writeFile(tmpPath, snapshot, "utf8");
        await fs.rename(tmpPath, this.registryPath);
      } finally {
        // rename 成功后 tmp 已不存在；失败时清理残留临时文件。
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      }
    };
    // 串行接到写入链上：并发的 saveRegistry 排队执行，不交错、不抢同名临时文件。
    const next = this.registryWriteChain.then(run, run);
    this.registryWriteChain = next.catch(() => undefined);
    return next;
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

  private async getRuntime(profilePaths: string[], nativeProfiles: NativeChromeProfile[]): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const nativeDirNames = nativeProfiles.map((profile) => profile.dirName);
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
        maxBuffer: 1024 * 1024 * 8,
        env: POSIX_LOCALE_ENV
      });

      const processesByPid = new Map<number, RuntimeProfile & { pid: number; command: string }>();
      for (const line of stdout.split("\n")) {
        const processInfo = parseRuntimeProcess(line);
        if (!processInfo) {
          continue;
        }
        processesByPid.set(processInfo.pid, processInfo);

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

      const nativeProfilesByPath = new Map(nativeProfiles.map((profile) => [profile.path, profile]));
      const openProfilePids = await getOpenProfilePidsByPath(nativeProfiles.map((profile) => profile.path));
      for (const [profilePath, pids] of openProfilePids) {
        const profile = nativeProfilesByPath.get(profilePath);
        if (!profile) {
          continue;
        }
        for (const pid of pids) {
          const processInfo = processesByPid.get(pid);
          if (processInfo) {
            addRuntimeProcess(runtime, makeNativeRuntimeKey(profile.dirName), processInfo);
          }
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
      // 默认 Profile 统一显示为“系统默认 Profile”（除非用户在本工具里手动重命名过）；
      // 其它系统 Profile 仍沿用 Chrome 自己的名字。
      name:
        registry.nativeProfiles?.[profile.dirName]?.name ||
        (profile.isDefault ? "系统默认 Profile" : profile.name),
      dirName: profile.dirName,
      path: profile.path,
      userDataDir: profile.userDataDir,
      profileDataPath: profile.path,
      createdAt: null,
      lastLaunchedAt: runtimeProfile.startedAt || registry.nativeProfiles?.[profile.dirName]?.lastLaunchedAt || null,
      userName: profile.userName,
      isDefault: profile.isDefault,
      deletable: !profile.isDefault,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids,
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      fixedCdpPort: null,
      agentConfigPort: null,
      listeningPorts: runtimeProfile.listeningPorts,
      pinnedToMini: false,
      clonedFromProfileId: null,
      clonedFromName: null,
      cloneCount: 0,
      projectTag: null,
      cdpClients: [],
      livePrimaryUrl: null,
      liveTabCount: null,
      liveHost: null,
      liveIp: null
    };
  }

  private async toIsolatedPublicProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): Promise<PublicProfile> {
    const profilePath = this.isolatedProfilePath(profile);
    const runtimeProfile = runtime.get(profilePath) || emptyRuntimeProfile();
    const userName = await readIsolatedProfileUserName(profilePath);
    const profileDataPath = await resolveIsolatedProfileDataPath(profilePath);

    return {
      id: makeIsolatedProfileId(profile.id),
      source: "isolated",
      name: profile.name,
      dirName: profile.dirName,
      path: profilePath,
      userDataDir: profilePath,
      profileDataPath,
      createdAt: profile.createdAt,
      lastLaunchedAt: runtimeProfile.startedAt || profile.lastLaunchedAt,
      userName,
      isDefault: false,
      deletable: true,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids,
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      fixedCdpPort: profile.fixedCdpPort ?? null,
      agentConfigPort: null,
      listeningPorts: runtimeProfile.listeningPorts,
      pinnedToMini: false,
      clonedFromProfileId: profile.clonedFromProfileId ?? null,
      clonedFromName: null,
      cloneCount: 0,
      projectTag: profile.projectTag ?? null,
      cdpClients: [],
      livePrimaryUrl: null,
      liveTabCount: null,
      liveHost: null,
      liveIp: null
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

    // 先以 registry 为真相源移除条目，成功后再尽力清理磁盘——避免“磁盘已清但 registry 还在”的不一致。
    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, ref.id);
    const copiedIds = new Set(copiedExtensions.map((extension) => extension.id));
    storedProfile.migratedExtensions = (storedProfile.migratedExtensions || []).filter(
      (extension) => !copiedIds.has(extension.id)
    );
    await this.saveRegistry(registry);

    // registry 已更新，再清理磁盘上已复制的扩展目录（失败仅告警，不影响已完成的回滚）。
    const migratedExtensionsDir = path.join(targetProfile.path, "Migrated Extensions");
    for (const extension of copiedExtensions) {
      // 防御：扩展 id 来自扫描结果，跳过异常格式，避免拼出越界路径。
      if (!isSafePathSegment(extension.sourceExtensionId)) {
        continue;
      }
      const extensionDir = path.join(migratedExtensionsDir, extension.sourceExtensionId);
      try {
        await fs.rm(extensionDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[profilepilot] 回滚迁移时清理磁盘文件失败：${extension.name} (${extension.sourceExtensionId})`,
          error
        );
      }
    }
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

  private async waitUntilProfileStops(profileId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(150);
      const state = await this.getState();
      const profile = state.profiles.find((item) => item.id === profileId);
      if (!profile?.running) {
        return true;
      }
    }

    return false;
  }
}

export function createProfileManager(): ProfileManager {
  return new ProfileManager(process.env.CPM_DATA_DIR || defaultDataDir());
}

// 为副本生成不与现有名字冲突的编号名：prefix-1、prefix-2…
function nextUniqueCloneName(prefix: string, used: Set<string>): string {
  let n = 1;
  let candidate = `${prefix}-${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${prefix}-${n}`;
  }
  return candidate;
}

function normalizeMiniProfileIds(input: unknown, validProfileIds?: Set<string>): string[] {
  const ids = Array.isArray(input) ? uniqueStrings(input.filter((id): id is string => typeof id === "string")) : [];
  const validIds = validProfileIds ? ids.filter((id) => validProfileIds.has(id)) : ids;
  return validIds.slice(0, MINI_PROFILE_LIMIT);
}
