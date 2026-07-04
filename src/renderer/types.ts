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
  agentConfigPort: number | null;
  listeningPorts: number[];
  pinnedToMini: boolean;
  clonedFromProfileId: string | null;
  clonedFromName: string | null;
  cloneCount: number;
  projectTag: string | null;
  cdpClients: CdpClientInfo[];
  livePrimaryUrl: string | null;
  liveTabCount: number | null;
}

export interface CdpClientInfo {
  pid: number;
  label: string;
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

export type ProfileSource = "native" | "isolated";

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

export interface SetupAgentBrowserRequest {
  sourceProfileId: string;
  targetName?: string;
  port: number;
  includeExtensions?: boolean;
}

export interface SetupAgentBrowserResult {
  profileId: string;
  profileName: string;
  port: number;
  cdpUrl: string | null;
  copiedItems: AccountSyncCopiedItem[];
  extensionResult: ExtensionMigrationResult | null;
  state: AppState;
}

export interface CloneProfilesRequest {
  sourceProfileId: string;
  count: number;
  namePrefix?: string;
  basePort?: number | null;
  includeExtensions?: boolean;
  launchAfter?: boolean;
  setAgentEndpoint?: boolean;
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
  createProfile(name: string): Promise<AppState>;
  renameProfile(id: string, name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null): Promise<AppState>;
  connectRunningSystemChrome(id: string): Promise<AppState>;
  suggestCdpPort(preferredPort?: number | null): Promise<CdpPortSuggestion>;
  setAgentBrowserConfig(id: string, port: number): Promise<AppState>;
  clearAgentBrowserConfig(id: string): Promise<AppState>;
  setMiniProfilePinned(id: string, pinned: boolean): Promise<AppState>;
  setMiniProfileOrder(ids: string[]): Promise<AppState>;
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
  openProfileFolder(id: string): Promise<AppState>;
  openProfileExtensionsPage(id: string): Promise<AppState>;
  openPath(path: string): Promise<boolean>;
  deleteProfile(id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
  setupAgentBrowser(request: SetupAgentBrowserRequest): Promise<SetupAgentBrowserResult>;
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
}

export type ConfirmIntent =
  | {
      kind: "profile";
      action: "close" | "delete" | "delete-after-chrome-exit";
      profileId: string;
    }
  | {
      kind: "account-sync";
      sourceProfileId: string;
      targetProfileId: string;
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
      setAgentEndpoint: boolean;
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
  | { kind: "agent-config"; profileId: string; portSuggestion: CdpPortSuggestion | null }
  | { kind: "agent-browser-setup"; portSuggestion: CdpPortSuggestion }
  | { kind: "clone-pool" }
  | { kind: "clone-tag"; profileId: string }
  | { kind: "global-instructions" }
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
