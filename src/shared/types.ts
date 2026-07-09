export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
  fixedCdpPort?: number | null;
  // 该独立 Profile 是从哪个源 Profile 克隆出来的（存源的 public id，可为 native:/isolated:）。
  // 用来定义“副本组”：批量刷新登录态、重置、回收都按这个字段聚合。
  clonedFromProfileId?: string | null;
  // 纯展示用的项目标签，标记这个副本当前在干哪个项目的活。
  projectTag?: string | null;
  migratedExtensions?: StoredMigratedExtension[];
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

export interface NativeProfileMetadata {
  lastLaunchedAt: string | null;
  name?: string | null;
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

export interface Registry {
  profiles: StoredProfile[];
  nativeProfiles?: Record<string, NativeProfileMetadata>;
  accountSyncRecords?: Record<string, AccountSyncRecord>;
  takeoverHistory?: AgentTakeoverEvent[];
  // AI 操作可见化 overlay 总开关。旧配置缺省视为开启。
  agentOverlayEnabled?: boolean;
  miniProfileIds?: string[];
  // 悬浮窗里 Profile 行的自定义排序（拖拽调整）；不在列表里的 Profile 排在末尾，保持自然顺序。
  miniProfileOrder?: string[];
  // 全局快捷键 ⌘⌥N 直启的槽位映射：键为槽位号 "1"~"9"，值为该槽位绑定的 profile 公开 id。
  // 一个槽位至多一个 profile，一个 profile 至多占一个槽位（改绑时会顶掉旧的）。
  quickLaunchSlots?: Record<string, string>;
}

// 当前持有该 Profile CDP 端口持久连接的客户端（agent-browser / Playwright / DevTools 等）。
export interface CdpClientInfo {
  pid: number;
  label: string;
  // 能解析出来时，标注这条连接背后是哪个 AI 工具的哪个会话（用于悬停 tooltip）：
  // agent=工具名（Codex / Claude Code），project=项目目录名，title=会话首句/标题。
  agent?: string;
  project?: string;
  title?: string;
  // 使用方自报的命名 session（agent-browser --session <名>）；tooltip 里单独一行。
  session?: string;
  // 会话档案最后活动时间（ISO）＝该会话最近一次动静，用来区分活会话与残留连接。
  lastActive?: string;
  // 归属可信度说明：agent-browser 走共享 daemon 时归属是按其启动目录推测的（或推测不出），
  // 这里给出人话解释，UI 拼进 tooltip；精确归属时为空。
  note?: string;
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

export interface AgentOverlayRevealEvent {
  profileId: string;
  profileName: string;
  at: string;
}

// AI 对某个 tab / Profile 的归属（借鉴 ego-lite 的三值枚举，取代散落的布尔+时间窗）：
// agent＝AI 正在驱动；agentDelegatedToUser＝用户刚接管、AI 暂让出控制权但仍持有该 tab
// （同会话重连即恢复 agent）；user＝已彻底交还 / 无 AI 驱动。
export type Ownership = "agent" | "agentDelegatedToUser" | "user";

// tab 争用观测里“最抖”的那个标签页：观察窗口内 URL 变化次数与往返翻转（A→B→A）次数。
export interface CdpContentionChurn {
  title: string;
  url: string;
  changes: number;
  flipBacks: number;
  // 观察窗口内“驱动过这个 tab”的 owner 会话标识（AGENT_BROWSER_SESSION，如 cc-/cx-<uuid>；
  // 无命名 session 的连接退化成 pid:<pid>）。≥2 个不同 owner＝这个 tab 被多会话争抢。
  owners: string[];
}

// 多会话争用判定（主进程算好给 UI 直接用）：
// level=contention：观察到同一标签页 URL 短时间反复往返改写 + ≥2 条驱动连接 → 疑似正在抢 tab；
// level=risk：≥2 条连接且其中 ≥2 个会话最近都有活动 → 有争用风险（还没观察到实际抢写）；
// level=null：单连接 / 一活一残留等正常情况。
export interface CdpContentionInfo {
  // 最近活动时间落在活跃窗口内的连接数（解析不出 lastActive 的连接不计入）。
  activeClientCount: number;
  // 争用观察者是否已连上该端口（没连上时 churn 恒为 null，判定只能靠活跃连接数）。
  observing: boolean;
  // 仅 level=contention 时给出：被抢写的标签页与其抖动读数。
  churn: CdpContentionChurn | null;
  level: "contention" | "risk" | null;
}

// 实时观测：一个正在以 CDP 运行的 Profile 当前“飞在哪”。
export interface CdpLiveTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  // /json/list 里排在最前、被当作主标签（也是截图来源）的那一个。
  primary: boolean;
}

export interface CdpLiveView {
  port: number;
  capturedAt: string;
  tabCount: number;
  tabs: CdpLiveTab[];
  primaryTitle: string | null;
  primaryUrl: string | null;
  // 主标签页的一帧 JPEG 画面（data: URL）；关掉截图或抓取失败时为 null。
  screenshot: string | null;
  screenshotError: string | null;
  // 整体读取失败（端口没响应、浏览器已关闭等）时的原因；成功时为 null。
  error: string | null;
}

export interface CdpLiveViewOptions {
  screenshot?: boolean;
  targetId?: string;
}

export type ProfileSource = "native" | "isolated" | "isolated-sub";

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
  pids: number[];
  cdpPort: number | null;
  cdpUrl: string | null;
  fixedCdpPort: number | null;
  listeningPorts: number[];
  pinnedToMini: boolean;
  // 全局快捷键 ⌘⌥N 直启的槽位（1~9）；未指派为 null。可在主窗口「更多」菜单里改绑。
  quickLaunchSlot: number | null;
  // 副本池字段：克隆来源、来源名（已解析）、作为源时有多少副本指向它、项目标签。
  clonedFromProfileId: string | null;
  clonedFromName: string | null;
  cloneCount: number;
  projectTag: string | null;
  // 正驱动这个 Profile 的 CDP 客户端（持久连接到其调试端口的外部工具）；空数组=没有工具连接。
  cdpClients: CdpClientInfo[];
  // 实时观测摘要：当前主标签页 URL 与打开的标签数（不含截图，随 getState 轮询刷新）；未运行/无 CDP 时为 null。
  livePrimaryUrl: string | null;
  liveTabCount: number | null;
  // 多会话争用判定：≥2 条驱动连接时才可能非 null 的 level；无 CDP/单连接时为 null 或 level=null。
  cdpContention: CdpContentionInfo | null;
  // 正在驱动这个 Profile 的 agent 的实时活动（会话 tail 解析结果）；无 agent 驱动时为 null。
  agentActivity: AgentActivity | null;
}

export interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  userDataDir: string;
  isDefault: boolean;
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

// 会话识别 shell 集成（~/.zshenv 托管块）的状态。
// installed=注入已生效（含用户手写版本）；managed=由本工具的标记块提供，可一键移除。
export interface ShellIntegrationStatus {
  supported: boolean;
  installed: boolean;
  managed: boolean;
  path: string;
  error: string | null;
}

export interface AppState {
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
  agentOverlayEnabled: boolean;
  shellIntegration: ShellIntegrationStatus;
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
}

export interface GlobalInstructionsSnapshot {
  readAt: string;
  files: GlobalInstructionFile[];
}

export interface GlobalInstructionUpdateRequest {
  id: GlobalInstructionFileId;
  content: string;
}

export interface CdpPortSuggestion {
  preferredPort: number;
  port: number;
  preferredAvailable: boolean;
  preferredOwner: string | null;
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

export type OperationProgressUpdate = Omit<OperationProgress, "key" | "profileId">;

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

export interface OperationPauseSignal {
  readonly paused: boolean;
  waitIfPaused(): Promise<void>;
}

export interface ProfileManagerApi {
  getState(): Promise<AppState>;
  getTakeoverHistory(): Promise<AgentTakeoverEvent[]>;
  createProfile(name: string): Promise<AppState>;
  renameProfile(id: string, name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null): Promise<AppState>;
  connectRunningSystemChrome(id: string): Promise<AppState>;
  suggestCdpPort(preferredPort?: number | null): Promise<CdpPortSuggestion>;
  setMiniProfilePinned(id: string, pinned: boolean): Promise<AppState>;
  setMiniProfileOrder(ids: string[]): Promise<AppState>;
  setQuickLaunchSlot(id: string, slot: number | null): Promise<AppState>;
  setMiniPanelPinned(pinned: boolean): Promise<void>;
  onMiniPanelPinnedChanged(listener: (pinned: boolean) => void): () => void;
  showMiniWindow(): Promise<void>;
  showMainWindow(): Promise<void>;
  setMiniWindowPanelOpen(open: boolean): Promise<void>;
  resizeMiniPanel(height: number): Promise<void>;
  requestMiniWindowPanelClose(): Promise<void>;
  dragMiniWindow(screenX: number, screenY: number, phase: "start" | "move" | "end"): Promise<void>;
  isMiniWindowPointerInside(): Promise<boolean>;
  onMiniWindowPanelOpenChanged(listener: (open: boolean) => void): () => void;
  readGlobalInstructions(): Promise<GlobalInstructionsSnapshot>;
  writeGlobalInstruction(request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot>;
  ensureClaudeInstructionShell(): Promise<GlobalInstructionsSnapshot>;
  focusProfile(id: string): Promise<AppState>;
  isProfileFrontmost(id: string): Promise<boolean>;
  closeProfile(id: string): Promise<AppState>;
  focusExternalInstance(userDataDir: string): Promise<AppState>;
  closeExternalInstance(userDataDir: string): Promise<AppState>;
  // 结束某条 CDP 驱动连接：对该客户端进程发信号使其断开，不动 Chrome。
  disconnectCdpClient(profileId: string, pid: number): Promise<AppState>;
  // 停止当前 AI 驱动连接并写入接管历史；session 缺省时停止该 Profile 的全部 AI 连接。
  takeoverAgentConnections(profileId: string, session?: string): Promise<TakeoverAgentConnectionsResponse>;
  // AI 操作可见化 overlay 总开关。
  setAgentOverlayEnabled(enabled: boolean): Promise<AppState>;
  // 启用/移除会话识别 shell 集成（~/.zshenv 托管块），返回刷新后的完整状态。
  setShellIntegrationEnabled(enabled: boolean): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  openProfileExtensionsPage(id: string): Promise<AppState>;
  openPath(path: string): Promise<boolean>;
  deleteProfile(id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult>;
  inspectAccountSyncDiff(request: AccountSyncRequest): Promise<AccountSyncDiffResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
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
