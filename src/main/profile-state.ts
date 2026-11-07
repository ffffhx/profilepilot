import { app } from "electron";
import { promises as fs } from 'node:fs';
import path from "node:path";
import { normalizeQuickLaunchShortcuts } from "../shared/quick-launch-shortcut";
import type { AppState, CdpClientInfo, ExternalChromeInstance, NativeChromeProfile, PublicProfile, Registry, StoredProfile } from "../shared/types";
import { readActiveAgentBrowserProfileOccupancySync } from "./agent-browser-lease";
import { isAgentOverlayClient } from "./agent-overlay";
import { type GatewayControlResponse } from "./browser-gateway-client";
import { makeCdpUrl, requestCdpTargets } from "./cdp-client";
import { resolveCdpContention } from "./cdp-contention";
import { frontmostMacProcessId, getDirectChromeCommand, makeIsolatedProfileId, makeIsolatedSubProfileId, makeNativeProfileId, nativeChromeUserDataDir, readIsolatedProfileUserName, resolveIsolatedProfileDataPath, scanChromeProfilesInDir, scanNativeChromeProfiles } from "./chrome-launch";
import { isSameFilesystemPath, isSafePathSegment } from "./fs-util";
import { RuntimeProfile } from "./internal-types";
import { addRuntimeProcess, attachListeningPorts, createControlRuntimeScan, emptyRuntimeProfile, findExternalChromeInstances, getCdpClientsByPort, getOpenProfilePidsByPath, isGoogleChromeMainProcess, isImplicitDefaultChromeProcess, listRuntimeProcesses, makeNativeRuntimeKey, mergeRuntimeProfiles, parseProfileDirectoryFlag, parseUserDataDirFlag, type RuntimeScanOptions, type ControlDiscovery } from "./process-scan";
import { readProfileAvatar } from "./profile-avatar";
import { compatibilityCdpPorts, enrichCdpClientSessionIdentities, filterCdpDriverClients, gatewayConnectedClients, gatewayControlsByPort, gatewayManagedPortSet, gatewayOverlayClients, gatewayProfilesFromResponse, stripManagedCdpRuntimeMetadata } from "./profile-connections";
import { normalizeMiniProfileIds, normalizeProfileOrder } from "./profile-layout";
import { getShellIntegrationStatus } from "./shell-integration";
import type { WindowsControlSample } from './windows-platform';
import { profileFileProcessChanged } from './profile-process-change';
import { requireWindowsRuntimeIdentity } from './process-scan';
export interface CollectedProfileState { state: AppState; gatewayStatus: GatewayControlResponse | null; controlDiscovery?: ControlDiscovery; }
export type ControlAdmissionProfile = Pick<PublicProfile, 'id' | 'source' | 'pids' | 'browserPids' | 'cdpPort' | 'fixedCdpPort' | 'gatewayControl' | 'agentBrowserOccupancy' | 'cdpClients'>;
export interface ControlAdmissionState {
  profiles: ControlAdmissionProfile[];
  externalInstances: Pick<ExternalChromeInstance, 'pid' | 'cdpPort' | 'cdpClients'>[];
  controlDiscovery: ControlDiscovery;
}

function controlProfile(profile: ControlAdmissionProfile): ControlAdmissionProfile {
  const { id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients } = profile;
  return { id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients };
}

interface ProfileStateInput {
  dataDir: string;
  profilesDir: string;
  loadRegistry(strict?: boolean): Promise<Registry>;
  readGatewayStatus(): Promise<GatewayControlResponse | null>;
  getActivity(clients: CdpClientInfo[]): PublicProfile["agentActivity"];
}

/** Collects observations only. Registry repair, connection cleanup and overlays live in ProfileRuntimeMaintenance. */
export class ProfileStateReader {
  constructor(private readonly input: ProfileStateInput) {}
  private isolatedProfilePath(profile: StoredProfile): string {
    return path.join(this.input.profilesDir, profile.dirName);
  }
  async collect(options: { strictDiscovery?: boolean } = {}): Promise<CollectedProfileState> {
    return this.collectInternal({ ...options, admissionOnly: false });
  }
  async collectForControlAdmission(windowsSample?: Promise<WindowsControlSample>): Promise<ControlAdmissionState> {
    return this.collectInternal({ strictDiscovery: true, admissionOnly: true, windowsSample });
  }
  private async collectInternal(options: { strictDiscovery: true; admissionOnly: true; windowsSample?: Promise<WindowsControlSample> }): Promise<ControlAdmissionState>;
  private async collectInternal(options: { strictDiscovery?: boolean; admissionOnly: false }): Promise<CollectedProfileState>;
  private async collectInternal(options: { strictDiscovery?: boolean; admissionOnly: boolean; windowsSample?: Promise<WindowsControlSample> }): Promise<CollectedProfileState | ControlAdmissionState> {
    const strict = options.strictDiscovery === true;
    const gatewayStatus = await this.input.readGatewayStatus();
    const registry = await this.input.loadRegistry(strict);
    const scan: RuntimeScanOptions = strict ? await createControlRuntimeScan(options.windowsSample) : {};
    const nativeChromeProfiles = strict ? await this.scanProfilesForControl(nativeChromeUserDataDir()) : await scanNativeChromeProfiles();
    const nativePaths = nativeChromeProfiles.map((profile) => profile.path);
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const runtime = await this.getRuntime(nativePaths.concat(isolatedPaths), nativeChromeProfiles, scan);
    if (strict) {
      const mapped = new Set([...runtime.values()].flatMap(value => value.pids));
      const nativeRoot = nativeChromeUserDataDir();
      for (const item of scan.processes || []) {
        if (!isGoogleChromeMainProcess(item.command)) continue;
        const userDataDir = parseUserDataDirFlag(item.command);
        if ((!userDataDir || await this.sameControlPath(userDataDir, nativeRoot)) && !mapped.has(item.pid)) throw new Error('PROFILE_NATIVE_PROCESS_UNRESOLVED');
      }
    }
    await this.mergeGatewayRuntime(runtime, registry, gatewayStatus);

    const nativeProfiles = nativeChromeProfiles.map((profile) => this.toNativePublicProfile(profile, registry, runtime));
    const isolatedRows = options.admissionOnly
      ? { kind: 'control' as const, profiles: registry.profiles.slice().sort((a, b) => {
          const time = (profile: StoredProfile) => runtime.get(this.isolatedProfilePath(profile))?.startedAt || profile.lastLaunchedAt || profile.createdAt || '';
          return time(b).localeCompare(time(a));
        }).map(profile => this.toIsolatedControlProfile(profile, runtime)) }
      : { kind: 'display' as const, profiles: (await Promise.all(
        registry.profiles.map((profile) => this.toIsolatedPublicProfile(profile, runtime))
      )).sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt || "";
        const bTime = b.lastLaunchedAt || b.createdAt || "";
        return bTime.localeCompare(aTime);
      }) };
    // 隔离 user-data-dir 里额外的子 profile（在 Chrome 里手动新建、本工具没登记的）也枚举出来，
    // 挂到各自所属的隔离目录组下，和系统 Profile 一样成行展示（支持启动/显示）。
    const isolatedSubProfiles = await this.buildIsolatedSubProfiles(registry, runtime, scan);
    const rows = isolatedRows.kind === 'control'
      ? { kind: 'control' as const, profiles: [...nativeProfiles.map(controlProfile), ...isolatedRows.profiles, ...isolatedSubProfiles.map(controlProfile)] }
      : { kind: 'display' as const, isolatedCount: isolatedRows.profiles.length, profiles: [...nativeProfiles, ...isolatedRows.profiles, ...isolatedSubProfiles] };
    if (rows.kind === 'display') {
      const profiles = rows.profiles;
      const frontmostPid = strict || process.env.CPM_E2E_DETERMINISTIC === "1"
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
      });
    }
    const profiles = rows.profiles;
    profiles.forEach((profile) => {
      const candidatePort = profile.cdpPort ?? (profile.source === "isolated" ? profile.fixedCdpPort : null);
      if (candidatePort !== null) {
        profile.agentBrowserOccupancy = readActiveAgentBrowserProfileOccupancySync(candidatePort);
      }
    });

    const externalInstances = !strict && process.env.CPM_E2E_DETERMINISTIC === "1"
      ? []
      : await findExternalChromeInstances([
          ...isolatedPaths,
          nativeChromeUserDataDir(),
          this.input.dataDir
        ], scan, { includeDisplayCdpUrl: !options.admissionOnly });

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
    const cdpClientsByPort = await getCdpClientsByPort(compatibilityPorts, scan, { includeActivityRepository: !options.admissionOnly });
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
    // Canonical archive representations and diagnostics are presentation only;
    // admission retains the original session/owner/client evidence above.
    if (!options.admissionOnly) await enrichCdpClientSessionIdentities([
      ...profiles.flatMap((profile) => profile.cdpClients),
      ...externalInstances.flatMap((instance) => instance.cdpClients || [])
    ]);
    // Publish only after every strict mapping and ownership-related read above
    // succeeds. Presentation fields are neither fabricated nor collected for
    // this path; the original process sampling time is preserved unchanged.
    if (rows.kind === 'control') {
      if (!scan.controlDiscovery) throw new Error('PROFILE_DISCOVERY_INCOMPLETE');
      return { profiles: rows.profiles, externalInstances: externalInstances.map(({ pid, cdpPort, cdpClients }) => ({ pid, cdpPort, cdpClients })),
        controlDiscovery: scan.controlDiscovery };
    }
    const displayProfiles = rows.profiles;
    // 实时摘要：每个有 CDP 端口的 Profile 当前停在哪个页面、开了几个标签（轻量，不抓截图）。
    // 给表格行 / 悬浮窗卡片 / 「在飞中」总览统一供数；详情侧栏的画面截图仍走独立的 getCdpLiveView。
    const liveSummaryByPort = new Map<number, { primaryUrl: string | null; tabCount: number }>();
    await Promise.all(
      (strict ? [] : [...new Set(profileCdpPorts)]).map(async (port) => {
        const targets = await requestCdpTargets(port).catch(() => []);
        const pages = targets.filter((target) => target.type === "page");
        liveSummaryByPort.set(port, { primaryUrl: pages[0]?.url || null, tabCount: pages.length });
      })
    );
    displayProfiles.forEach((profile) => {
      if (profile.cdpPort === null) {
        return;
      }
      const summary = liveSummaryByPort.get(profile.cdpPort);
      profile.livePrimaryUrl = summary?.primaryUrl ?? null;
      profile.liveTabCount = summary?.tabCount ?? null;
    });

    displayProfiles.forEach((profile) => {
      if (profile.cdpPort !== null && profile.cdpUrl) {
        profile.cdpContention = resolveCdpContention(profile.cdpPort, profile.cdpClients);
      }
    });

    const agentOverlayEnabled = registry.agentOverlayEnabled !== false;
    displayProfiles.forEach((profile) => {
      profile.agentActivity = agentOverlayEnabled
        ? this.input.getActivity(gatewayOverlayClients(profile)) : null;
    });
    externalInstances.forEach((instance) => {
      instance.agentActivity = agentOverlayEnabled
        ? this.input.getActivity((instance.cdpClients || []).filter(isAgentOverlayClient)) : null;
    });

    const runningProfiles = displayProfiles.filter((profile) => profile.running);
    const lastLaunchedProfile = displayProfiles.find((profile) => profile.lastLaunchedAt) || null;
    const validProfileIds = new Set(displayProfiles.map((profile) => profile.id));
    const miniProfileIds = normalizeMiniProfileIds(registry.miniProfileIds, validProfileIds);
    const miniProfileOrder = normalizeProfileOrder(registry.miniProfileOrder, validProfileIds);
    const mainProfileOrder = normalizeProfileOrder(registry.mainProfileOrder, validProfileIds);
    const miniProfileIdSet = new Set(miniProfileIds);
    const shortcuts = normalizeQuickLaunchShortcuts(registry.quickLaunchShortcuts, undefined, process.platform, validProfileIds);
    displayProfiles.forEach((profile) => {
      profile.pinnedToMini = miniProfileIdSet.has(profile.id);
      profile.quickLaunchShortcut = shortcuts[profile.id] ?? null;
    });

    const state: AppState = {
      platform: process.platform,
      appTitle: "ProfilePilot",
      dataDir: this.input.dataDir,
      profilesDir: this.input.profilesDir,
      profiles: displayProfiles,
      nativeProfileCount: nativeProfiles.length,
      isolatedProfileCount: rows.isolatedCount,
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
    // Scoped process gaps are published only after the remaining strict
    // Local State, file-lock, registry, external and TCP discovery has finished.
    if (strict && !scan.controlDiscovery) throw new Error('PROFILE_DISCOVERY_INCOMPLETE');
    return { state, gatewayStatus, ...(strict ? { controlDiscovery: scan.controlDiscovery } : {}) };
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

  private pathKey(value: string): string {
    const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  private async sameControlPath(left: string, right: string): Promise<boolean> {
    if (this.pathKey(left) === this.pathKey(right)) return true;
    const resolve = async (value: string): Promise<string | null> => {
      try { return await fs.realpath(value); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return null; throw error; }
    };
    const [resolvedLeft, resolvedRight] = await Promise.all([resolve(left), resolve(right)]);
    // An absent directory cannot alias a differently named running directory.
    // Permission/I/O failures above still leave the association unknown.
    if (resolvedLeft === null || resolvedRight === null) return false;
    return this.pathKey(resolvedLeft) === this.pathKey(resolvedRight);
  }
  async scanProfilesForControl(userDataDir: string): Promise<NativeChromeProfile[]> {
    let raw: string;
    try { raw = await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8'); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return []; throw error; }
    const value = JSON.parse(raw) as { profile?: { info_cache?: unknown } };
    const cache = value?.profile?.info_cache;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('PROFILE_LOCAL_STATE_INCOMPLETE');
    return Object.entries(cache).map(([dirName, item]) => {
      if (!isSafePathSegment(dirName) || !item || typeof item !== 'object' || Array.isArray(item)) throw new Error('PROFILE_LOCAL_STATE_INVALID');
      const info = item as { name?: unknown; user_name?: unknown };
      return { dirName, name: typeof info.name === 'string' && info.name.trim() ? info.name : dirName,
        userName: typeof info.user_name === 'string' && info.user_name.trim() ? info.user_name : null,
        path: path.join(userDataDir, dirName), userDataDir, isDefault: dirName === 'Default' };
    });
  }
  async getRuntime(profilePaths: string[], nativeProfiles: NativeChromeProfile[], options: RuntimeScanOptions = {}): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const nativeDirNames = nativeProfiles.map((profile) => profile.dirName);
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const processesByPid = new Map<number, RuntimeProfile & { pid: number; command: string }>();
      const processes = await listRuntimeProcesses(options);
      for (const processInfo of processes) {
        processesByPid.set(processInfo.pid, processInfo);

        const { command } = processInfo;
        const userDataDir = parseUserDataDirFlag(command);
        const profileDirectory = parseProfileDirectoryFlag(command);
        const nativeProcess = !options.strict || !userDataDir || await this.sameControlPath(userDataDir, nativeChromeUserDataDir());

        // A normally opened Chrome often does not include --profile-directory.
        // Treat that main browser process as the Default profile.
        if (defaultNativeKey && (isImplicitDefaultChromeProcess(command) ||
          (options.strict && nativeProcess && isGoogleChromeMainProcess(command) && !profileDirectory))) {
          addRuntimeProcess(runtime, defaultNativeKey, processInfo);
        }

        for (const profilePath of profilePaths) {
          if (!userDataDir || !(await (options.strict ? this.sameControlPath(userDataDir, profilePath) : isSameFilesystemPath(userDataDir, profilePath)))) {
            continue;
          }
          addRuntimeProcess(runtime, profilePath, processInfo);
        }

        for (const dirName of nativeDirNames) {
          if (profileDirectory !== dirName || !nativeProcess) {
            continue;
          }
          addRuntimeProcess(runtime, makeNativeRuntimeKey(dirName), processInfo);
        }
      }

      const nativeProfilesByPath = new Map(nativeProfiles.map((profile) => [profile.path, profile]));
      const openProfilePids = await getOpenProfilePidsByPath(nativeProfiles.map((profile) => profile.path), options);
      for (const [profilePath, pids] of openProfilePids) {
        const profile = nativeProfilesByPath.get(profilePath);
        if (!profile) {
          continue;
        }
        for (const pid of pids) {
          const processInfo = processesByPid.get(pid);
          if (processInfo) {
            requireWindowsRuntimeIdentity(processInfo, options);
            addRuntimeProcess(runtime, makeNativeRuntimeKey(profile.dirName), processInfo);
          } else if (options.strict) throw profileFileProcessChanged('profile_runtime_pid_join', pid, processesByPid.size, options.controlDiscovery);
        }
      }

      await attachListeningPorts(runtime, options);
    } catch (error) {
      if (options.strict) throw error;
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

  private toIsolatedControlProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): ControlAdmissionProfile {
    const runtimeProfile = runtime.get(this.isolatedProfilePath(profile)) || emptyRuntimeProfile();
    return { id: makeIsolatedProfileId(profile.id), source: 'isolated', pids: runtimeProfile.pids,
      browserPids: runtimeProfile.browserPids || [], cdpPort: runtimeProfile.cdpPort,
      fixedCdpPort: profile.fixedCdpPort ?? null, gatewayControl: null, agentBrowserOccupancy: null, cdpClients: [] };
  }

  async toIsolatedPublicProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): Promise<PublicProfile> {
    const profilePath = this.isolatedProfilePath(profile);
    const runtimeProfile = runtime.get(profilePath) || emptyRuntimeProfile();
    const userName = await readIsolatedProfileUserName(profilePath);
    const profileDataPath = await resolveIsolatedProfileDataPath(profilePath);

    return {
      ...this.toIsolatedControlProfile(profile, runtime),
      avatarDataUrl: await readProfileAvatar(profileDataPath),
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
      cdpUrl: makeCdpUrl(runtimeProfile.cdpPort),
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
      livePrimaryUrl: null,
      liveTabCount: null,
      cdpContention: null,
      agentActivity: null
    };
  }

  async buildIsolatedSubProfiles(
    registry: Registry,
    runtime: Map<string, RuntimeProfile>,
    options: RuntimeScanOptions = {}
  ): Promise<PublicProfile[]> {
    if (options.strict && process.platform === 'win32') {
      // One bounded RM stream for the whole strict collection. Starting one
      // helper per parent would overflow the bounded client queue and fragment
      // cross-parent process identity evidence.
      const groups = await Promise.all(registry.profiles.map(async parent => {
        const userDataDir = this.isolatedProfilePath(parent);
        const extras = (await this.scanProfilesForControl(userDataDir)).filter(sub => sub.dirName !== 'Default');
        return { parent, userDataDir, extras };
      }));
      const openPids = await getOpenProfilePidsByPath(groups.flatMap(group => group.extras.map(sub => sub.path)), options);
      return groups.flatMap(({ parent, userDataDir, extras }) => {
        const parentRuntime = runtime.get(userDataDir) || emptyRuntimeProfile();
        return extras.map(sub => this.toIsolatedSubPublicProfile(parent, sub, userDataDir,
          openPids.get(sub.path) || [], parentRuntime.browserPids || [], parentRuntime.cdpPort));
      });
    }
    const rows = await Promise.all(
      registry.profiles.map(async (parent) => {
        const userDataDir = this.isolatedProfilePath(parent);
        // 登记 Profile 代表的是 Default 子目录——排除它，只留 Chrome 里额外新建的子 profile，
        // 避免和已展示的登记 Profile 重复。（直接排除 Default，省掉每轮的磁盘打分开销。）
        const extras = (await (options.strict ? this.scanProfilesForControl(userDataDir) : scanChromeProfilesInDir(userDataDir))).filter((sub) => sub.dirName !== "Default");
        if (!extras.length) {
          return [];
        }
        // 子 profile 是否运行：按各自的 profile 目录看有没有被 Chrome 进程打开（与父实例共享 CDP 端口）。
        const openPids = await getOpenProfilePidsByPath(extras.map((sub) => sub.path), options);
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
