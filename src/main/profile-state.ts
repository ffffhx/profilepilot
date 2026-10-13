import { app } from "electron";
import path from "node:path";
import { normalizeQuickLaunchShortcuts } from "../shared/quick-launch-shortcut";
import type { AppState, CdpClientInfo, NativeChromeProfile, PublicProfile, Registry, StoredProfile } from "../shared/types";
import { readActiveAgentBrowserProfileOccupancySync } from "./agent-browser-lease";
import { isAgentOverlayClient } from "./agent-overlay";
import { type GatewayControlResponse } from "./browser-gateway-client";
import { makeCdpUrl, requestCdpTargets } from "./cdp-client";
import { resolveCdpContention } from "./cdp-contention";
import { frontmostMacProcessId, getDirectChromeCommand, makeIsolatedProfileId, makeIsolatedSubProfileId, makeNativeProfileId, nativeChromeUserDataDir, readIsolatedProfileUserName, resolveIsolatedProfileDataPath, scanChromeProfilesInDir, scanNativeChromeProfiles } from "./chrome-launch";
import { isSameFilesystemPath } from "./fs-util";
import { RuntimeProfile } from "./internal-types";
import { addRuntimeProcess, attachListeningPorts, emptyRuntimeProfile, findExternalChromeInstances, getCdpClientsByPort, getOpenProfilePidsByPath, isImplicitDefaultChromeProcess, listRuntimeProcesses, makeNativeRuntimeKey, mergeRuntimeProfiles, parseProfileDirectoryFlag, parseUserDataDirFlag } from "./process-scan";
import { readProfileAvatar } from "./profile-avatar";
import { compatibilityCdpPorts, enrichCdpClientSessionIdentities, filterCdpDriverClients, gatewayConnectedClients, gatewayControlsByPort, gatewayManagedPortSet, gatewayOverlayClients, gatewayProfilesFromResponse, stripManagedCdpRuntimeMetadata } from "./profile-connections";
import { normalizeMiniProfileIds, normalizeProfileOrder } from "./profile-layout";
import { getShellIntegrationStatus } from "./shell-integration";
export interface CollectedProfileState { state: AppState; gatewayStatus: GatewayControlResponse | null; }

interface ProfileStateInput {
  dataDir: string;
  profilesDir: string;
  loadRegistry(): Promise<Registry>;
  readGatewayStatus(): Promise<GatewayControlResponse | null>;
  getActivity(clients: CdpClientInfo[]): PublicProfile["agentActivity"];
}

/** Collects observations only. Registry repair, connection cleanup and overlays live in ProfileRuntimeMaintenance. */
export class ProfileStateReader {
  constructor(private readonly input: ProfileStateInput) {}
  private isolatedProfilePath(profile: StoredProfile): string {
    return path.join(this.input.profilesDir, profile.dirName);
  }
  async collect(): Promise<CollectedProfileState> {
    const gatewayStatus = await this.input.readGatewayStatus();
    const registry = await this.input.loadRegistry();
    const nativeChromeProfiles = await scanNativeChromeProfiles();
    const nativePaths = nativeChromeProfiles.map((profile) => profile.path);
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const runtime = await this.getRuntime(nativePaths.concat(isolatedPaths), nativeChromeProfiles);
    await this.mergeGatewayRuntime(runtime, registry, gatewayStatus);

    const nativeProfiles = nativeChromeProfiles.map((profile) => this.toNativePublicProfile(profile, registry, runtime));
    const isolatedProfiles = (await Promise.all(
      registry.profiles.map((profile) => this.toIsolatedPublicProfile(profile, runtime))
    )).sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt || "";
        const bTime = b.lastLaunchedAt || b.createdAt || "";
        return bTime.localeCompare(aTime);
      });
    // 隔离 user-data-dir 里额外的子 profile（在 Chrome 里手动新建、本工具没登记的）也枚举出来，
    // 挂到各自所属的隔离目录组下，和系统 Profile 一样成行展示（支持启动/显示）。
    const isolatedSubProfiles = await this.buildIsolatedSubProfiles(registry, runtime);
    const profiles = [...nativeProfiles, ...isolatedProfiles, ...isolatedSubProfiles];
    const frontmostPid = process.env.CPM_E2E_DETERMINISTIC === "1"
      ? null
      : await frontmostMacProcessId();
    profiles.forEach((profile) => {
      profile.windowActivation = !profile.running
        ? "not_running"
        : (process.platform !== "darwin" && process.platform !== "win32") || frontmostPid === null
          ? "unknown"
          : profile.pids.includes(frontmostPid)
            ? "foreground"
            : "background";
    });

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
      const candidatePort = profile.cdpPort ?? (profile.source === "isolated" ? profile.fixedCdpPort : null);
      if (candidatePort !== null) {
        profile.agentBrowserOccupancy = readActiveAgentBrowserProfileOccupancySync(candidatePort);
      }
    });

    const externalInstances = process.env.CPM_E2E_DETERMINISTIC === "1"
      ? []
      : await findExternalChromeInstances([
          ...isolatedPaths,
          nativeChromeUserDataDir(),
          this.input.dataDir
        ]);

    // 标记“谁在持久连接这些 Profile / 外部实例的 CDP 端口”（agent-browser 等驱动工具）。
    const profileCdpPorts = profiles
      .filter((profile) => profile.cdpPort !== null)
      .map((profile) => profile.cdpPort as number);
    const externalCdpPorts = externalInstances
      .filter((instance) => instance.cdpPort !== null)
      .map((instance) => instance.cdpPort as number);
    const cdpPorts = profileCdpPorts.concat(externalCdpPorts);
    const gatewayManagedPorts = gatewayManagedPortSet(gatewayStatus);
    // 本地 socket/activity/lease 扫描只服务 Gateway 未管理的旧式端口。
    // 受管端口无论是 9223、9224 还是任意其它端口，都只能由 Gateway 供数。
    const compatibilityPorts = compatibilityCdpPorts(cdpPorts, gatewayStatus);
    const cdpClientsByPort = await getCdpClientsByPort(compatibilityPorts);
    const gatewayControlByPort = gatewayControlsByPort(gatewayStatus);
    // ProfilePilot 自己也会连这些 CDP 端口去抓实时观测数据（标签页 / 截图），
    // 这些自连接不是“外部驱动工具”，必须排除，否则会把自己显示成“驱动中：Electron”。
    const selfPids = new Set(app.getAppMetrics().map((metric) => metric.pid));
    profiles.forEach((profile) => {
      if (profile.cdpPort === null) {
        return;
      }
      const profilePids = new Set(profile.pids);
      profile.gatewayControl = gatewayControlByPort.get(profile.cdpPort) || null;
      // Gateway 端口只认 Gateway 的瞬时 connectionActive，不能再让旧 lease/activity
      // 合成“正在连接”；非 Gateway 端口继续沿用 lsof + 兼容记录。
      profile.cdpClients = profile.gatewayControl
        ? gatewayConnectedClients(profile.gatewayControl)
        : gatewayManagedPorts.has(profile.cdpPort)
          ? []
        : (cdpClientsByPort.get(profile.cdpPort) || []).filter(
            (client) => !profilePids.has(client.pid) && !selfPids.has(client.pid)
          );
    });
    externalInstances.forEach((instance) => {
      if (instance.cdpPort === null) {
        instance.cdpClients = [];
        instance.agentActivity = null;
        return;
      }
      const gatewayControl = gatewayControlByPort.get(instance.cdpPort) || null;
      instance.cdpClients = gatewayControl
        ? gatewayConnectedClients(gatewayControl)
        : gatewayManagedPorts.has(instance.cdpPort)
          ? []
        : filterCdpDriverClients(
            cdpClientsByPort.get(instance.cdpPort) || [],
            [instance.pid],
            selfPids
          );
      instance.agentActivity = null;
    });
    await enrichCdpClientSessionIdentities([
      ...profiles.flatMap((profile) => profile.cdpClients),
      ...externalInstances.flatMap((instance) => instance.cdpClients || [])
    ]);
    // 实时摘要：每个有 CDP 端口的 Profile 当前停在哪个页面、开了几个标签（轻量，不抓截图）。
    // 给表格行 / 悬浮窗卡片 / 「在飞中」总览统一供数；详情侧栏的画面截图仍走独立的 getCdpLiveView。
    const liveSummaryByPort = new Map<number, { primaryUrl: string | null; tabCount: number }>();
    await Promise.all(
      [...new Set(profileCdpPorts)].map(async (port) => {
        const targets = await requestCdpTargets(port).catch(() => []);
        const pages = targets.filter((target) => target.type === "page");
        liveSummaryByPort.set(port, { primaryUrl: pages[0]?.url || null, tabCount: pages.length });
      })
    );
    profiles.forEach((profile) => {
      if (profile.cdpPort === null) {
        return;
      }
      const summary = liveSummaryByPort.get(profile.cdpPort);
      profile.livePrimaryUrl = summary?.primaryUrl ?? null;
      profile.liveTabCount = summary?.tabCount ?? null;
    });

    profiles.forEach((profile) => {
      if (profile.cdpPort !== null && profile.cdpUrl) {
        profile.cdpContention = resolveCdpContention(profile.cdpPort, profile.cdpClients);
      }
    });

    const agentOverlayEnabled = registry.agentOverlayEnabled !== false;
    profiles.forEach((profile) => {
      profile.agentActivity = agentOverlayEnabled
        ? this.input.getActivity(gatewayOverlayClients(profile)) : null;
    });
    externalInstances.forEach((instance) => {
      instance.agentActivity = agentOverlayEnabled
        ? this.input.getActivity((instance.cdpClients || []).filter(isAgentOverlayClient)) : null;
    });

    const runningProfiles = profiles.filter((profile) => profile.running);
    const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;
    const validProfileIds = new Set(profiles.map((profile) => profile.id));
    const miniProfileIds = normalizeMiniProfileIds(registry.miniProfileIds, validProfileIds);
    const miniProfileOrder = normalizeProfileOrder(registry.miniProfileOrder, validProfileIds);
    const mainProfileOrder = normalizeProfileOrder(registry.mainProfileOrder, validProfileIds);
    const miniProfileIdSet = new Set(miniProfileIds);
    const shortcuts = normalizeQuickLaunchShortcuts(registry.quickLaunchShortcuts, undefined, process.platform, validProfileIds);
    profiles.forEach((profile) => {
      profile.pinnedToMini = miniProfileIdSet.has(profile.id);
      profile.quickLaunchShortcut = shortcuts[profile.id] ?? null;
    });

    const state: AppState = {
      platform: process.platform,
      appTitle: "ProfilePilot",
      dataDir: this.input.dataDir,
      profilesDir: this.input.profilesDir,
      profiles,
      nativeProfileCount: nativeProfiles.length,
      isolatedProfileCount: isolatedProfiles.length,
      nativeChromeProfiles,
      runningProfiles,
      currentProfile: runningProfiles[0] || lastLaunchedProfile,
      chromeLauncher: this.getLauncherLabel(),
      accountSyncRecords: Object.values(registry.accountSyncRecords || {}).sort((a, b) => b.syncedAt.localeCompare(a.syncedAt)),
      externalInstances,
      miniProfileIds,
      miniProfileOrder,
      mainProfileOrder,
      agentOverlayEnabled,
      shellIntegration: await getShellIntegrationStatus()
    };
    return { state, gatewayStatus };
  }
  async mergeGatewayRuntime(
    runtime: Map<string, RuntimeProfile>,
    registry: Registry,
    response: GatewayControlResponse | null
  ): Promise<void> {
    if (!response) return;
    const storedByPublicId = new Map(registry.profiles.map((profile) => [makeIsolatedProfileId(profile.id), profile]));
    const managedPorts = gatewayManagedPortSet(response);
    const activePorts = new Set(Array.isArray(response.ports) ? response.ports.map(Number) : []);
    // OS 进程扫描在这一层只保留“Chrome 是否运行”的 PID 信息；它解析到的
    // --remote-debugging-port/监听端口不能覆盖 Gateway 对受管端口的绑定结论。
    stripManagedCdpRuntimeMetadata(runtime, managedPorts);
    for (const binding of gatewayProfilesFromResponse(response)) {
      const stored = storedByPublicId.get(String(binding.profileId || ""));
      const publicPort = Number(binding.publicPort);
      if (!stored || !activePorts.has(publicPort) || !Number.isSafeInteger(publicPort) || publicPort <= 0) continue;
      const profilePath = this.isolatedProfilePath(stored);
      const current = runtime.get(profilePath) || emptyRuntimeProfile();
      const chromePid = Number(binding.chromePid);
      runtime.set(profilePath, {
        ...current,
        pids: Number.isSafeInteger(chromePid) && chromePid > 0
          ? [...new Set([...current.pids, chromePid])]
          : current.pids,
        browserPids: Number.isSafeInteger(chromePid) && chromePid > 0
          ? [...new Set([...(current.browserPids || []), chromePid])]
          : current.browserPids,
        cdpPort: publicPort,
        listeningPorts: [...new Set([...current.listeningPorts, publicPort])]
      });
    }
  }

  async getRuntime(profilePaths: string[], nativeProfiles: NativeChromeProfile[]): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const nativeDirNames = nativeProfiles.map((profile) => profile.dirName);
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const processesByPid = new Map<number, RuntimeProfile & { pid: number; command: string }>();
      const processes = await listRuntimeProcesses();
      for (const processInfo of processes) {
        processesByPid.set(processInfo.pid, processInfo);

        const { command } = processInfo;
        const userDataDir = parseUserDataDirFlag(command);
        const profileDirectory = parseProfileDirectoryFlag(command);

        // A normally opened Chrome often does not include --profile-directory.
        // Treat that main browser process as the Default profile.
        if (defaultNativeKey && isImplicitDefaultChromeProcess(command)) {
          addRuntimeProcess(runtime, defaultNativeKey, processInfo);
        }

        for (const profilePath of profilePaths) {
          if (!userDataDir || !(await isSameFilesystemPath(userDataDir, profilePath))) {
            continue;
          }
          addRuntimeProcess(runtime, profilePath, processInfo);
        }

        for (const dirName of nativeDirNames) {
          if (profileDirectory !== dirName) {
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

  toNativePublicProfile(
    profile: NativeChromeProfile,
    registry: Registry,
    runtime: Map<string, RuntimeProfile>
  ): PublicProfile {
    const runtimeProfile = mergeRuntimeProfiles(runtime.get(profile.path), runtime.get(makeNativeRuntimeKey(profile.dirName)));

    return {
      id: makeNativeProfileId(profile.dirName),
      avatarDataUrl: profile.avatarDataUrl,
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
      windowActivation: runtimeProfile.pids.length ? "unknown" : "not_running",
      pids: runtimeProfile.pids,
      browserPids: runtimeProfile.browserPids || [],
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      fixedCdpPort: null,
      bifrostProxy: null,
      upstreamProxy: null,
      directConnection: false,
      listeningPorts: runtimeProfile.listeningPorts,
      pinnedToMini: false,
      quickLaunchShortcut: null,
      clonedFromProfileId: null,
      clonedFromName: null,
      cloneCount: 0,
      projectTag: null,
      agentAccessDisabled: false,
      cdpClients: [],
      gatewayControl: null,
      agentBrowserOccupancy: null,
      livePrimaryUrl: null,
      liveTabCount: null,
      cdpContention: null,
      agentActivity: null
    };
  }

  async toIsolatedPublicProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): Promise<PublicProfile> {
    const profilePath = this.isolatedProfilePath(profile);
    const runtimeProfile = runtime.get(profilePath) || emptyRuntimeProfile();
    const userName = await readIsolatedProfileUserName(profilePath);
    const profileDataPath = await resolveIsolatedProfileDataPath(profilePath);

    return {
      id: makeIsolatedProfileId(profile.id),
      avatarDataUrl: await readProfileAvatar(profileDataPath),
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
      windowActivation: runtimeProfile.pids.length ? "unknown" : "not_running",
      pids: runtimeProfile.pids,
      browserPids: runtimeProfile.browserPids || [],
      cdpPort: runtimeProfile.cdpPort,
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
      fixedCdpPort: profile.fixedCdpPort ?? null,
      bifrostProxy: profile.bifrostProxy ?? null,
      upstreamProxy: profile.upstreamProxy ?? null,
      directConnection: profile.directConnection === true,
      listeningPorts: runtimeProfile.listeningPorts,
      pinnedToMini: false,
      quickLaunchShortcut: null,
      clonedFromProfileId: profile.clonedFromProfileId ?? null,
      clonedFromName: null,
      cloneCount: 0,
      projectTag: profile.projectTag ?? null,
      agentAccessDisabled: profile.agentAccessDisabled === true,
      hideAutomation: profile.hideAutomation === true,
      cdpClients: [],
      gatewayControl: null,
      agentBrowserOccupancy: null,
      livePrimaryUrl: null,
      liveTabCount: null,
      cdpContention: null,
      agentActivity: null
    };
  }

  async buildIsolatedSubProfiles(
    registry: Registry,
    runtime: Map<string, RuntimeProfile>
  ): Promise<PublicProfile[]> {
    const rows = await Promise.all(
      registry.profiles.map(async (parent) => {
        const userDataDir = this.isolatedProfilePath(parent);
        // 登记 Profile 代表的是 Default 子目录——排除它，只留 Chrome 里额外新建的子 profile，
        // 避免和已展示的登记 Profile 重复。（直接排除 Default，省掉每轮的磁盘打分开销。）
        const extras = (await scanChromeProfilesInDir(userDataDir)).filter((sub) => sub.dirName !== "Default");
        if (!extras.length) {
          return [];
        }
        // 子 profile 是否运行：按各自的 profile 目录看有没有被 Chrome 进程打开（与父实例共享 CDP 端口）。
        const openPids = await getOpenProfilePidsByPath(extras.map((sub) => sub.path));
        const parentRuntime = runtime.get(userDataDir) || emptyRuntimeProfile();
        const parentCdpPort = parentRuntime.cdpPort;
        return extras.map((sub) =>
          this.toIsolatedSubPublicProfile(
            parent,
            sub,
            userDataDir,
            openPids.get(sub.path) || [],
            parentRuntime.browserPids || [],
            parentCdpPort
          )
        );
      })
    );
    return rows.flat();
  }

  toIsolatedSubPublicProfile(
    parent: StoredProfile,
    sub: NativeChromeProfile,
    userDataDir: string,
    pids: number[],
    browserPids: number[],
    parentCdpPort: number | null
  ): PublicProfile {
    return {
      id: makeIsolatedSubProfileId(parent.id, sub.dirName),
      avatarDataUrl: sub.avatarDataUrl,
      source: "isolated-sub",
      name: sub.name,
      dirName: sub.dirName,
      path: sub.path,
      userDataDir,
      profileDataPath: sub.path,
      createdAt: null,
      lastLaunchedAt: null,
      userName: sub.userName,
      isDefault: false,
      // 本工具没登记它，不提供同步/克隆/改名——但支持删除（删目录 + 从父目录 Local State 摘除记录）。
      deletable: true,
      running: pids.length > 0,
      windowActivation: pids.length ? "unknown" : "not_running",
      pids,
      browserPids,
      // 与父隔离实例共享同一个 CDP 端口（CDP 是浏览器实例级）。
      cdpPort: parentCdpPort,
      cdpUrl: makeCdpUrl(parentCdpPort),
      fixedCdpPort: null,
      bifrostProxy: null,
      upstreamProxy: null,
      directConnection: false,
      listeningPorts: [],
      pinnedToMini: false,
      quickLaunchShortcut: null,
      clonedFromProfileId: null,
      clonedFromName: null,
      cloneCount: 0,
      projectTag: null,
      agentAccessDisabled: false,
      cdpClients: [],
      gatewayControl: null,
      agentBrowserOccupancy: null,
      livePrimaryUrl: null,
      liveTabCount: null,
      cdpContention: null,
      agentActivity: null
    };
  }

  getLauncherLabel(): string {
    if (process.env.CHROME_BINARY) {
      return process.env.CHROME_BINARY;
    }

    if (process.platform === "darwin") {
      return process.env.CHROME_APP_NAME || "Google Chrome";
    }

    if (process.platform === "win32") {
      return getDirectChromeCommand() || "Google Chrome";
    }

    return "google-chrome";
  }
}
