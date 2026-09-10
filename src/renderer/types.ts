export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
  fixedCdpPort?: number | null;
  bifrostProxy?: ProfileBifrostProxyConfig | null;
  upstreamProxy?: ProfileUpstreamProxyConfig | null;
  directConnection?: boolean;
  clonedFromProfileId?: string | null;
  projectTag?: string | null;
  agentAccessDisabled?: boolean;
  migratedExtensions?: StoredMigratedExtension[];
}

export interface ProfileBifrostProxyConfig {
  listenerPort: number;
  rules: string[];
  groupRules: string[];
  disabledRules?: string[];
  disabledGroupRules?: string[];
}

export interface ProfileUpstreamProxyConfig {
  server: string;
  bypassList?: string | null;
}

export type ProfileProxyConfig =
  | ({ kind: "bifrost" } & ProfileBifrostProxyConfig)
  | ({ kind: "upstream" } & ProfileUpstreamProxyConfig)
  | { kind: "direct" };

export interface BifrostPortBindingInfo {
  port: number;
  host: string | null;
  name: string | null;
  status: string | null;
}

export type BifrostRuleDestinationKind = "local" | "ppe" | "boe" | "mixed" | "other";

export interface BifrostRuleDestination {
  kind: BifrostRuleDestinationKind;
  label: string;
  details: string[];
}

export interface BifrostActiveRuleInfo {
  name: string;
  ruleCount: number;
}

export interface SystemProxyRoute {
  protocol: "http" | "https";
  kind: "direct" | "http" | "https" | "socks4" | "socks5" | "quic" | "unknown";
  endpoint: string | null;
}

export interface SystemProxySnapshot {
  mode: "direct" | "proxy" | "mixed" | "unknown";
  routes: SystemProxyRoute[];
}

export interface BifrostSnapshot {
  installed: boolean;
  running: boolean;
  version: string | null;
  binaryPath: string | null;
  mainPort: number | null;
  ports: BifrostPortBindingInfo[];
  localRules: string[];
  error: string | null;
  upstreamHealth?: Record<string, boolean>;
  ruleDestinations?: Record<string, BifrostRuleDestination>;
  mainRules?: BifrostActiveRuleInfo[];
  mainRuleDestination?: BifrostRuleDestination | null;
  systemProxy?: SystemProxySnapshot;
}

export interface LaunchProfileOptions {
  // Bifrost 不可用时的直连逃生口：本次启动跳过代理注入，不修改已保存的分流配置。
  bypassProxy?: boolean;
  // Bifrost 未运行时由 ProfilePilot 启动 daemon，再恢复专属入口并继续启动。
  startBifrost?: boolean;
}

export interface ProfileAgentSettings {
  agentAccessDisabled: boolean;
}

export interface StoredMigratedExtension {
  id: string;
  sourceProfileId: string;
  sourceExtensionId: string;
  name: string;
  version: string;
  path: string;
  migratedAt: string;
  includeData: boolean;
}

export interface PublicProfile {
  id: string;
  source: ProfileSource;
  name: string;
  dirName: string;
  path: string;
  userDataDir: string;
  profileDataPath: string;
  createdAt: string | null;
  lastLaunchedAt: string | null;
  userName: string | null;
  isDefault: boolean;
  deletable: boolean;
  running: boolean;
  windowActivation: "foreground" | "background" | "not_running" | "unknown";
  pids: number[];
  cdpPort: number | null;
  cdpUrl: string | null;
  fixedCdpPort: number | null;
  bifrostProxy: ProfileBifrostProxyConfig | null;
  upstreamProxy: ProfileUpstreamProxyConfig | null;
  directConnection: boolean;
  listeningPorts: number[];
  pinnedToMini: boolean;
  // 全局快捷键 ⌘⌥N 直启的槽位（1~9）；未指派为 null。
  quickLaunchSlot: number | null;
  clonedFromProfileId: string | null;
  clonedFromName: string | null;
  cloneCount: number;
  projectTag: string | null;
  agentAccessDisabled: boolean;
  cdpClients: CdpClientInfo[];
  gatewayControl: GatewayProfileControlState | null;
  agentBrowserOccupancy: AgentBrowserProfileOccupancy | null;
  livePrimaryUrl: string | null;
  liveTabCount: number | null;
  // 多会话争用判定（主进程算好）：contention=观察到抢写同一标签页；risk=两个活跃会话共用。
  cdpContention: CdpContentionInfo | null;
  // 正在驱动这个 Profile 的 agent 的实时活动（会话 tail 解析结果）；无 agent 驱动时为 null。
  agentActivity: AgentActivity | null;
}

export interface GatewayProfileControlState {
  publicPort: number;
  ownership: "agent" | "user";
  sessionStatus: "active" | "stopped";
  agentHealth: "online" | "waiting" | "offline";
  driverState: "disconnected" | "connecting" | "connected" | "reconnecting" | "parked";
  reconnectAttempt: number | null;
  reconnectDeadlineAt: string | null;
  connectionActive: boolean;
  ownerSessionId: string | null;
  daemonInstanceId: string | null;
  daemonPid: number | null;
  driverKind: BrowserDriverKind | null;
  driverLabel: string | null;
  agent: string | null;
  project: string | null;
  agentTarget: {
    targetId: string;
    title: string;
    url: string;
  } | null;
  pendingUserAction: string | null;
  updatedAt: string;
}

export type SessionRepresentationSource =
  | "default-codex-home"
  | "configured-codex-home"
  | "orca-codex-home"
  | "claude-home";

export interface SessionRepresentation {
  source: SessionRepresentationSource;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionIdentityDiagnostic {
  code: "SESSION_CORE_UNAVAILABLE" | "SESSION_REPRESENTATION_NOT_FOUND";
  severity: "warning" | "error";
  message: string;
}

export interface CanonicalSessionIdentity {
  canonicalSessionId: string;
  engine: "codex" | "claude";
  nativeSessionId: string;
  representations: SessionRepresentation[];
  diagnostics: SessionIdentityDiagnostic[];
}

export interface AgentBrowserProfileOccupancy {
  cdpPort: number;
  profileId: string;
  profileName: string;
  session: string;
  ownership: "agent" | "user";
  agent: string | null;
  project: string | null;
  command: string | null;
  holderPid: number;
  daemonPid: number | null;
  updatedAt: string;
}

export interface AgentActivity {
  agent?: string;
  project?: string;
  session?: string;
  sessionTitle?: string;
  currentAction?: string;
  currentStep?: string;
  nextStep?: string;
  todoDone?: number;
  todoTotal?: number;
  lastMessage?: string;
  updatedAt?: string;
}

export interface AgentTakeoverEvent {
  profileId: string;
  profileName: string;
  session?: string;
  sessionTitle?: string;
  agent?: string;
  at: string;
}

export interface TakeoverAgentConnectionFailure {
  pid: number;
  label: string;
  session?: string;
  agent?: string;
  error: string;
}

export interface TakeoverAgentConnectionsResult {
  profileId: string;
  profileName: string;
  session?: string;
  targetCount: number;
  successCount: number;
  failureCount: number;
  allStopped: boolean;
  takeovers: AgentTakeoverEvent[];
  failures: TakeoverAgentConnectionFailure[];
}

export interface TakeoverAgentConnectionsResponse extends TakeoverAgentConnectionsResult {
  state: AppState;
}

export type AgentControlNoticeReason =
  | "user_takeover"
  | "agent_complete"
  | "user_stop"
  | "user_disconnect"
  | "user_return"
  | "driver_disconnected"
  | "driver_reconnected"
  | "driver_reconnect_exhausted";

export interface TakeoverAgentConnectionsRequest {
  session?: string;
  pids?: number[];
  reason?: AgentControlNoticeReason;
}

export interface AgentOverlayRevealEvent {
  profileId: string;
  profileName: string;
  at: string;
}

// AI 对某个 tab / Profile 的归属（借鉴 ego-lite 的三值枚举，取代散落的布尔+时间窗）。
export type Ownership = "agent" | "agentDelegatedToUser" | "user";

// tab 争用观测里“最抖”的那个标签页：观察窗口内 URL 变化次数与往返翻转（A→B→A）次数。
export interface CdpContentionChurn {
  title: string;
  url: string;
  changes: number;
  flipBacks: number;
  // 观察窗口内驱动过这个 tab 的 owner 会话标识；≥2 个不同 owner＝被多会话争抢。
  owners: string[];
}

// 面向 agent 的稳定信号（借鉴 ego-lite 的 EGO_* 契约模型，主进程 agent-signals.ts 产出）：
// code 稳定，message 给人看，action 是一句机器可照做的指令，hardStop=是否必须停手照 action 处理。
export interface ProfilePilotSignalInfo {
  code: string;
  message: string;
  action?: string;
  hardStop: boolean;
}

export interface CdpContentionInfo {
  activeClientCount: number;
  observing: boolean;
  churn: CdpContentionChurn | null;
  level: "contention" | "risk" | null;
  // 面向 agent 的稳定信号（由 level 映射）：level=null 时为 null；UI 优先突出 hardStop 的 action。
  signal: ProfilePilotSignalInfo | null;
}

export type BrowserDriverKind = "agent-browser" | "playwright-cli" | "chrome-devtools-mcp";
export type AgentSkillKey = BrowserDriverKind | "profilepilot-cli";

export interface CdpClientInfo {
  pid: number;
  label: string;
  driverKind?: BrowserDriverKind;
  duplicatePids?: number[];
  // 这条连接背后是哪个 AI 工具的哪个会话（能解析出来时才有），用于悬停 tooltip。
  agent?: string;
  project?: string;
  title?: string;
  // 使用方自报的命名 session（agent-browser --session <名>）；tooltip 里单独一行。
  session?: string;
  canonicalSessionId?: string;
  sessionRepresentations?: SessionRepresentation[];
  sessionDiagnostics?: SessionIdentityDiagnostic[];
  // 会话档案最后活动时间（ISO）＝该会话最近一次动静，用来区分活会话与残留连接。
  lastActive?: string;
  // 归属可信度说明（共享 daemon 推测归属/归属未知的人话解释），UI 拼进 tooltip。
  note?: string;
}

export interface CdpLiveTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  primary: boolean;
}

export interface CdpLiveView {
  port: number;
  capturedAt: string;
  tabCount: number;
  tabs: CdpLiveTab[];
  primaryTitle: string | null;
  primaryUrl: string | null;
  screenshot: string | null;
  screenshotError: string | null;
  error: string | null;
}

export interface CdpLiveViewOptions {
  screenshot?: boolean;
  targetId?: string;
}

export type ProfileSource = "native" | "isolated" | "isolated-sub";

export interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  userDataDir: string;
  isDefault: boolean;
}

export interface AccountSyncRecord {
  sourceProfileId: string;
  targetProfileId: string;
  syncedAt: string;
  copiedCount: number;
  skippedCount: number;
  launchedTarget: boolean;
  sourceFingerprints?: Record<string, string | null>;
}

export interface ExternalChromeInstance {
  userDataDir: string;
  label: string;
  browser: string;
  pid: number;
  startedAt: string | null;
  cdpPort: number | null;
  cdpUrl: string | null;
  cdpClients?: CdpClientInfo[];
  agentActivity?: AgentActivity | null;
  headless: boolean;
}

export interface AppState {
  platform?: string;
  appTitle: string;
  dataDir: string;
  profilesDir: string;
  profiles: PublicProfile[];
  nativeProfileCount: number;
  isolatedProfileCount: number;
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
  accountSyncRecords: AccountSyncRecord[];
  externalInstances: ExternalChromeInstance[];
  miniProfileIds: string[];
  miniProfileOrder: string[];
  mainProfileOrder: string[];
  agentOverlayEnabled: boolean;
  shellIntegration: ShellIntegrationStatus;
}

// 会话识别 shell 集成（~/.zshenv 托管块）状态：
// installed=注入已生效（含手动配置）；managed=本工具托管，可一键移除。
export interface ShellIntegrationStatus {
  supported: boolean;
  installed: boolean;
  managed: boolean;
  path: string;
  error: string | null;
}

export type AgentToolAvailability = "installed" | "missing" | "error";

export interface AgentToolDiagnostic {
  key: BrowserDriverKind;
  label: string;
  availability: AgentToolAvailability;
  executablePath: string | null;
  version: string | null;
  source: "binary" | null;
  installCommand: string;
  verifyCommand: string;
  error: string | null;
}

export interface AgentWrapperDiagnostic {
  key: BrowserDriverKind;
  label: string;
  wrapperPath: string;
  launcherPath: string;
  wrapperInstalled: boolean;
  launcherInstalled: boolean;
}

export type AgentSkillHost = "shared" | "codex" | "claude";

export interface AgentSkillTargetDiagnostic {
  host: AgentSkillHost;
  label: string;
  path: string;
  installed: boolean;
  managed: boolean;
  upToDate: boolean;
}

export interface AgentSkillDiagnostic {
  key: AgentSkillKey;
  label: string;
  skillId: string;
  installed: boolean;
  managed: boolean;
  upToDate: boolean;
  installedTargetCount: number;
  managedTargetCount: number;
  targetCount: number;
  installPath: string;
  targets: AgentSkillTargetDiagnostic[];
  error: string | null;
}

export interface ProfilePilotCliDiagnostic {
  installed: boolean;
  bundleInstalled: boolean;
  launcherInstalled: boolean;
  upToDate: boolean;
  bundlePath: string;
  launcherPath: string;
  skill: AgentSkillDiagnostic;
  error: string | null;
}

export interface InputGuardPermissionDiagnostic {
  platform?: string;
  supported: boolean;
  granted: boolean;
  appName: string;
  appPath: string | null;
  inspectedAt: string;
  error: string | null;
}

export interface AgentIntegrationDiagnostic {
  inspectedAt: string;
  ready: boolean;
  shellIntegration: ShellIntegrationStatus;
  wrapperDirectory: string;
  tools: AgentToolDiagnostic[];
  wrappers: AgentWrapperDiagnostic[];
  skills: AgentSkillDiagnostic[];
  managementCli: ProfilePilotCliDiagnostic;
  inputGuard: InputGuardPermissionDiagnostic;
}

export interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
}

export interface DeleteProfileOptions {
  quitChromeBeforeDelete?: boolean;
}

export interface ExtensionDataPath {
  label: string;
  relativePath: string;
  path: string;
}

export type ProfileExtensionInstallType = "web_store" | "local" | "profile" | "component" | "unknown";

export interface ProfileExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  fromWebStore: boolean;
  installType: ProfileExtensionInstallType;
  storeUrl: string | null;
  path: string | null;
  hasLocalData: boolean;
  dataPaths: ExtensionDataPath[];
  canCopyLocally: boolean;
  canPersistInstall: boolean;
}

export interface ExtensionScanResult {
  profileId: string;
  profileName: string;
  profilePath: string;
  extensions: ProfileExtensionInfo[];
}

export interface ExtensionMigrationRequest {
  sourceProfileId: string;
  targetProfileId: string;
  extensionIds: string[];
  includeData: boolean;
  openInstallPages: boolean;
  onlyChanged?: boolean;
}

export type ExtensionMigrationDiffStatus =
  | "missing"
  | "version_changed"
  | "data_changed"
  | "same"
  | "needs_install_page"
  | "manual_load_required"
  | "unsupported";

export interface ExtensionMigrationDiffItem {
  id: string;
  name: string;
  sourceVersion: string;
  targetVersion: string | null;
  status: ExtensionMigrationDiffStatus;
  reason: string;
  willCopyLocally: boolean;
  willLoadViaCdp: boolean;
  willOpenInstallPage: boolean;
}

export interface ExtensionMigrationDiffTargetOnlyItem {
  id: string;
  name: string;
  version: string;
}

export interface ExtensionMigrationDiffResult {
  sourceProfileId: string;
  targetProfileId: string;
  includeData: boolean;
  items: ExtensionMigrationDiffItem[];
  targetOnlyItems: ExtensionMigrationDiffTargetOnlyItem[];
  summary: {
    missingCount: number;
    changedCount: number;
    sameCount: number;
    needsInstallPageCount: number;
    cdpLoadCount: number;
    manualLoadCount: number;
    unsupportedCount: number;
    targetOnlyCount: number;
  };
}

export interface ExtensionMigrationCopiedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  fromWebStore: boolean;
}

export interface ExtensionMigrationDataCopy {
  id: string;
  name: string;
  relativePath: string;
}

export interface ExtensionMigrationLoadedExtension {
  id: string;
  loadedId: string;
  name: string;
  version: string;
  path: string;
  via: "cdp_runtime";
}

export interface ExtensionMigrationSkippedExtension {
  id: string;
  name: string;
  reason: string;
}

export interface ExtensionMigrationManualLoadExtension {
  id: string;
  name: string;
  path: string;
}

export interface ExtensionMigrationResult {
  sourceProfileId: string;
  targetProfileId: string;
  selectedCount: number;
  copiedExtensions: ExtensionMigrationCopiedExtension[];
  loadedLocalExtensions: ExtensionMigrationLoadedExtension[];
  dataCopies: ExtensionMigrationDataCopy[];
  webStoreInstallUrls: string[];
  manualLoadExtensions: ExtensionMigrationManualLoadExtension[];
  skippedExtensions: ExtensionMigrationSkippedExtension[];
  openedInstallPages: boolean;
  reopenedTarget: boolean;
  reopenedSource: boolean;
  restoredTargetTabs: number;
  restoredSourceTabs: number;
  state: AppState;
}

export interface ExtensionDeleteResult {
  profileId: string;
  profileName: string;
  extensionId: string;
  extensionName: string;
  deletedPaths: string[];
  scan: ExtensionScanResult;
  state: AppState;
}

export interface AccountSyncRequest {
  sourceProfileId: string;
  targetProfileId: string;
  launchTarget: boolean;
  onlyChanged?: boolean;
}

export type AccountSyncDiffStatus = "changed" | "same" | "source_missing" | "target_missing";

export interface AccountSyncDiffItem {
  label: string;
  relativePath: string;
  status: AccountSyncDiffStatus;
  reason: string;
}

export interface AccountSyncDiffResult {
  sourceProfileId: string;
  targetProfileId: string;
  items: AccountSyncDiffItem[];
  summary: {
    changedCount: number;
    sameCount: number;
    sourceMissingCount: number;
    targetMissingCount: number;
    syncableCount: number;
  };
}

export interface CancelOperationRequest {
  key: string;
  profileId?: string;
}

export type ControlOperationAction = "pause" | "resume";

export interface ControlOperationRequest {
  key: string;
  profileId?: string;
  action: ControlOperationAction;
}

export interface AccountSyncCopiedItem {
  label: string;
  relativePath: string;
}

export interface AccountSyncSkippedItem {
  label: string;
  relativePath: string;
  reason: string;
}

export interface AccountSyncResult {
  sourceProfileId: string;
  targetProfileId: string;
  copiedItems: AccountSyncCopiedItem[];
  skippedItems: AccountSyncSkippedItem[];
  launchedTarget: boolean;
  restoredTargetTabs: number;
  state: AppState;
}

export interface CloneProfilesRequest {
  sourceProfileId: string;
  count: number;
  namePrefix?: string;
  basePort?: number | null;
  includeExtensions?: boolean;
  launchAfter?: boolean;
}

export interface ClonedProfileInfo {
  profileId: string;
  name: string;
  port: number | null;
  launched: boolean;
}

export interface CloneProfilesResult {
  sourceProfileId: string;
  created: ClonedProfileInfo[];
  state: AppState;
}

export interface RefreshClonesResult {
  sourceProfileId: string;
  refreshedCount: number;
  skippedCount: number;
  refreshed: Array<{ profileId: string; name: string; copiedCount: number }>;
  state: AppState;
}

export interface RecycleIdleClonesResult {
  days: number;
  deleted: Array<{ profileId: string; name: string }>;
  state: AppState;
}

export interface LaunchClonesResult {
  sourceProfileId: string;
  launched: Array<{ profileId: string; name: string; port: number | null }>;
  failed: Array<{ profileId: string; name: string; reason: string }>;
  state: AppState;
}

export type GlobalInstructionFileId = "codex-agents" | "claude-memory";
export type GlobalInstructionFileRole = "primary" | "reference";

export interface GlobalInstructionFile {
  id: GlobalInstructionFileId;
  title: string;
  fileName: string;
  path: string;
  role: GlobalInstructionFileRole;
  editable: boolean;
  referenceTargetPath: string | null;
  referenceShellContent: string | null;
  isReferenceShell: boolean | null;
  exists: boolean;
  content: string;
  sizeBytes: number;
  updatedAt: string | null;
  error: string | null;
  revision: string;
  sourceLabel: string;
  diagnostics: GlobalInstructionDiagnostic[];
}

export interface GlobalInstructionsSnapshot {
  readAt: string;
  files: GlobalInstructionFile[];
  canUndo: boolean;
  undoAvailableIds: GlobalInstructionFileId[];
  lastBackupAt: string | null;
}

export interface GlobalInstructionUpdateRequest {
  id: GlobalInstructionFileId;
  content: string;
  expectedRevision?: string;
}

export interface GlobalInstructionUndoRequest {
  id: GlobalInstructionFileId;
  expectedRevision?: string;
}

export interface GlobalInstructionDiagnostic {
  code: "REFERENCE_SHELL_DIVERGED" | "REFERENCE_SHELL_MISSING" | "PRIMARY_SOURCE_MISSING";
  severity: "info" | "warning";
  message: string;
}

export type ProfileReadinessStatus = "pass" | "fail" | "unknown" | "not_applicable";
export type ProfileReadinessOverall = "ready" | "degraded" | "blocked";

export interface ProfileReadinessExtensionRequirement {
  id: string;
  name?: string;
  minVersion?: string;
}

export interface ProfileReadinessExpectation {
  requireRunning?: boolean;
  requireCdp?: boolean;
  requireAgentControl?: boolean;
  requireForeground?: boolean;
  requireBrowserAccount?: boolean;
  expectedLogicalPort?: number | null;
  expectedProxyKind?: "system" | "bifrost" | "upstream" | "direct";
  requiredBifrostRules?: string[];
  expectedTargetUrlIncludes?: string;
  expectedLoginLabel?: string;
  requiredExtensions?: ProfileReadinessExtensionRequirement[];
}

export interface ProfileReadinessRequest {
  profileId: string;
  expectation?: ProfileReadinessExpectation;
}

export interface ProfileReadinessCheck {
  id: string;
  code: string;
  label: string;
  status: ProfileReadinessStatus;
  required: boolean;
  expected: string | null;
  actual: string;
  evidence?: string | null;
  action: string | null;
}

export interface ProfileReadinessReceipt {
  version: 1;
  receiptId: string;
  generatedAt: string;
  overall: ProfileReadinessOverall;
  target: {
    profileId: string;
    profileName: string;
    expectedLogicalPort: number | null;
    expectedProxyKind: ProfileReadinessExpectation["expectedProxyKind"] | null;
    expectedTargetUrl: string | null;
    expectedLogin: string | null;
  };
  checks: ProfileReadinessCheck[];
  blockerCodes: string[];
  unknownCodes: string[];
  sessionIdentity: CanonicalSessionIdentity | null;
}

export interface CdpPortSuggestion {
  preferredPort: number;
  port: number;
  preferredAvailable: boolean;
  preferredOwner: string | null;
  // 端口被占时的稳定信号（CDP_PORT_UNAVAILABLE）：带建议命令，但要求先征得用户同意；可用时 null。
  signal: ProfilePilotSignalInfo | null;
}

export interface OperationProgress {
  key: string;
  message: string;
  profileId?: string;
  step?: string;
  stepIndex?: number;
  stepCount?: number;
  paused?: boolean;
}

export interface ProfileManagerApi {
  getState(): Promise<AppState>;
  onStateChanged(listener: (state: AppState) => void): () => void;
  getTakeoverHistory(): Promise<AgentTakeoverEvent[]>;
  createProfile(name: string): Promise<AppState>;
  renameProfile(id: string, name: string): Promise<AppState>;
  launchProfile(id: string, options?: LaunchProfileOptions): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null, options?: LaunchProfileOptions): Promise<AppState>;
  connectRunningSystemChrome(id: string): Promise<AppState>;
  suggestCdpPort(preferredPort?: number | null): Promise<CdpPortSuggestion>;
  getBifrostSnapshot(): Promise<BifrostSnapshot>;
  disableBifrostRule(ruleName: string): Promise<BifrostSnapshot>;
  setProfileProxy(id: string, config: ProfileProxyConfig | null): Promise<AppState>;
  setProfileAgentSettings(id: string, settings: ProfileAgentSettings): Promise<AppState>;
  setMiniProfilePinned(id: string, pinned: boolean): Promise<AppState>;
  setMiniProfileOrder(ids: string[]): Promise<AppState>;
  setMainProfileOrder(ids: string[]): Promise<AppState>;
  setQuickLaunchSlot(id: string, slot: number | null): Promise<AppState>;
  setMiniPanelPinned(pinned: boolean): Promise<void>;
  onMiniPanelPinnedChanged(listener: (pinned: boolean) => void): () => void;
  showMiniWindow(): Promise<void>;
  hideMiniWindow(): Promise<void>;
  showMainWindow(): Promise<void>;
  setMiniWindowPanelOpen(open: boolean): Promise<void>;
  resizeMiniPanel(height: number): Promise<void>;
  requestMiniWindowPanelClose(): Promise<void>;
  dragMiniWindow(screenX: number, screenY: number, phase: "start" | "move" | "end"): Promise<void>;
  isMiniWindowPointerInside(): Promise<boolean>;
  onMiniWindowPanelOpenChanged(listener: (open: boolean) => void): () => void;
  readGlobalInstructions(): Promise<GlobalInstructionsSnapshot>;
  writeGlobalInstruction(request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot>;
  undoGlobalInstruction(request: GlobalInstructionUndoRequest): Promise<GlobalInstructionsSnapshot>;
  ensureClaudeInstructionShell(): Promise<GlobalInstructionsSnapshot>;
  inspectProfileReadiness(request: ProfileReadinessRequest): Promise<ProfileReadinessReceipt>;
  focusProfile(id: string): Promise<void>;
  isProfileFrontmost(id: string): Promise<boolean>;
  closeProfile(id: string): Promise<AppState>;
  focusExternalInstance(userDataDir: string): Promise<AppState>;
  closeExternalInstance(userDataDir: string): Promise<AppState>;
  // 结束某条 CDP 驱动连接：对该客户端进程发信号使其断开，不动 Chrome。
  disconnectCdpClient(profileId: string, pid: number): Promise<AppState>;
  takeoverAgentConnections(
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse>;
  resumeAgentConnections(
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse>;
  setAgentOverlayEnabled(enabled: boolean): Promise<AppState>;
  setShellIntegrationEnabled(enabled: boolean): Promise<AppState>;
  inspectAgentIntegration(): Promise<AgentIntegrationDiagnostic>;
  setAgentWrapperEnabled(tool: BrowserDriverKind, enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setAgentSkillEnabled(tool: BrowserDriverKind, enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setProfilePilotCliEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setProfilePilotCliSkillEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  requestInputGuardPermission(): Promise<AgentIntegrationDiagnostic>;
  openInputGuardSettings(): Promise<boolean>;
  prepareProfileForAgent(profileId: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  openProfileExtensionsPage(id: string): Promise<AppState>;
  openPath(path: string): Promise<boolean>;
  deleteProfile(id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
  inspectAccountSyncDiff(request: AccountSyncRequest): Promise<AccountSyncDiffResult>;
  cloneProfiles(request: CloneProfilesRequest): Promise<CloneProfilesResult>;
  refreshClones(sourceProfileId: string): Promise<RefreshClonesResult>;
  resetClone(profileId: string): Promise<AccountSyncResult>;
  recycleIdleClones(days: number): Promise<RecycleIdleClonesResult>;
  setProfileTag(profileId: string, tag: string): Promise<AppState>;
  launchClones(sourceProfileId: string): Promise<LaunchClonesResult>;
  cancelOperation(request: CancelOperationRequest): Promise<boolean>;
  controlOperation(request: ControlOperationRequest): Promise<boolean>;
  getCdpLiveView(port: number, options?: CdpLiveViewOptions): Promise<CdpLiveView>;
  onOperationProgress(listener: (progress: OperationProgress) => void): () => void;
  onAgentTakeover(listener: (event: AgentTakeoverEvent) => void): () => void;
  onAgentOverlayReveal(listener: (event: AgentOverlayRevealEvent) => void): () => void;
}

export type ConfirmIntent =
  | {
      kind: "disable-bifrost-rule";
      ruleName: string;
      ruleCount: number;
    }
  | {
      kind: "remove-profile-bifrost-rule";
      profileId: string;
      ruleKind: "local" | "group";
      ruleRef: string;
    }
  | {
      kind: "profile";
      action: "close" | "delete" | "delete-after-chrome-exit";
      profileId: string;
    }
  | {
      kind: "close-profile-for-bifrost";
      profileId: string;
    }
  | {
      kind: "profile-sync";
      sourceProfileId: string;
      targetProfileId: string;
      syncAccount: boolean;
      syncExtensions: boolean;
      shouldCloseTarget: boolean;
      existingRecordSyncedAt: string | null;
      launchTarget: boolean;
    }
  | {
      kind: "delete-extension";
      profileId: string;
      extensionId: string;
    }
  | {
      kind: "extension-migration";
      sourceProfileId: string;
      targetProfileId: string;
      extensionIds: string[];
      selectedCount: number;
      includeData: boolean;
      openInstallPages: boolean;
      onlyChanged: boolean;
      shouldCloseTarget: boolean;
      shouldCloseSource: boolean;
    }
  | {
      kind: "clone-profiles";
      sourceProfileId: string;
      count: number;
      namePrefix: string;
      includeExtensions: boolean;
      launchAfter: boolean;
    }
  | {
      kind: "refresh-clones";
      sourceProfileId: string;
    }
  | {
      kind: "reset-clone";
      profileId: string;
    }
  | {
      kind: "recycle-clones";
      days: number;
    }
  | {
      kind: "disconnect-client";
      profileId: string;
      pid: number;
    }
  | {
      kind: "agent-takeover";
      profileId: string;
    }
  | {
      // Bifrost 启动失败后的直连逃生口确认：cdpPort 为 null 表示普通启动，数字表示以 CDP 模式沿用该端口重试。
      kind: "bifrost-bypass-launch";
      profileId: string;
      cdpPort: number | null;
      errorMessage: string;
    };
export type BusyState = {
  key: string;
  message: string;
  profileId?: string;
  extensionId?: string;
  steps?: BusyProgressStep[];
  stepIndex?: number;
  stepCount?: number;
  cancelRequested?: boolean;
  paused?: boolean;
};
export type BusyProgressStep = {
  label: string;
  status: "pending" | "active" | "done";
};
export type ModalState =
  | { kind: "new" }
  | { kind: "rename"; profileId: string }
  | { kind: "cdp"; profileId: string; portSuggestion: CdpPortSuggestion | null }
  | { kind: "bifrost-proxy"; profileId: string; snapshot: BifrostSnapshot | null }
  | { kind: "extension-migration" }
  | { kind: "clone-pool" }
  | { kind: "clone-tag"; profileId: string }
  | { kind: "global-instructions" }
  | { kind: "onboarding" }
  | { kind: "agent-integration" }
  | { kind: "profile-details"; profileId: string }
  | { kind: "external-details"; userDataDir: string }
  | { kind: "live-zoom"; profileId: string; returnTo?: "profile-details" }
  | {
      kind: "confirm";
      intent: ConfirmIntent;
      returnTo?: "extension-migration" | "clone-pool";
    }
  | null;
export type ToastKind = "normal" | "error";

export type ConfirmModalTone = "primary" | "warn" | "danger";

export type ConfirmBodyLine = string | { text: string; tone: "danger" };

export interface ConfirmModalView {
  kicker: string;
  title: string;
  body: ConfirmBodyLine[];
  confirmLabel: string;
  tone: ConfirmModalTone;
  summary: Array<{ label: string; value: string }>;
}
