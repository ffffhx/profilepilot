export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
  fixedCdpPort?: number | null;
  clonedFromProfileId?: string | null;
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
  // 全局快捷键 ⌘⌥N 直启的槽位（1~9）；未指派为 null。
  quickLaunchSlot: number | null;
  clonedFromProfileId: string | null;
  clonedFromName: string | null;
  cloneCount: number;
  projectTag: string | null;
  cdpClients: CdpClientInfo[];
  livePrimaryUrl: string | null;
  liveTabCount: number | null;
  // 多会话争用判定（主进程算好）：contention=观察到抢写同一标签页；risk=两个活跃会话共用。
  cdpContention: CdpContentionInfo | null;
  // 正在驱动这个 Profile 的 agent 的实时活动（会话 tail 解析结果）；无 agent 驱动时为 null。
  agentActivity: AgentActivity | null;
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

export interface AgentOverlayRevealEvent {
  profileId: string;
  profileName: string;
  at: string;
}

// tab 争用观测里“最抖”的那个标签页：观察窗口内 URL 变化次数与往返翻转（A→B→A）次数。
export interface CdpContentionChurn {
  title: string;
  url: string;
  changes: number;
  flipBacks: number;
}

export interface CdpContentionInfo {
  activeClientCount: number;
  observing: boolean;
  churn: CdpContentionChurn | null;
  level: "contention" | "risk" | null;
}

export interface CdpClientInfo {
  pid: number;
  label: string;
  // 这条连接背后是哪个 AI 工具的哪个会话（能解析出来时才有），用于悬停 tooltip。
  agent?: string;
  project?: string;
  title?: string;
  // 使用方自报的命名 session（agent-browser --session <名>）；tooltip 里单独一行。
  session?: string;
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

// 会话识别 shell 集成（~/.zshenv 托管块）状态：
// installed=注入已生效（含手动配置）；managed=本工具托管，可一键移除。
export interface ShellIntegrationStatus {
  supported: boolean;
  installed: boolean;
  managed: boolean;
  path: string;
  error: string | null;
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
  setAgentOverlayEnabled(enabled: boolean): Promise<AppState>;
  setShellIntegrationEnabled(enabled: boolean): Promise<AppState>;
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
      kind: "profile";
      action: "close" | "delete" | "delete-after-chrome-exit";
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
  | { kind: "extension-migration" }
  | { kind: "clone-pool" }
  | { kind: "clone-tag"; profileId: string }
  | { kind: "global-instructions" }
  | { kind: "takeover-history" }
  | { kind: "live-zoom"; profileId: string }
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
