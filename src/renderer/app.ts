interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
  migratedExtensions?: StoredMigratedExtension[];
}

interface StoredMigratedExtension {
  id: string;
  sourceProfileId: string;
  sourceExtensionId: string;
  name: string;
  version: string;
  path: string;
  migratedAt: string;
  includeData: boolean;
}

interface PublicProfile {
  id: string;
  source: ProfileSource;
  name: string;
  dirName: string;
  path: string;
  createdAt: string | null;
  lastLaunchedAt: string | null;
  userName: string | null;
  isDefault: boolean;
  deletable: boolean;
  running: boolean;
  pids: number[];
  cdpPort: number | null;
  cdpUrl: string | null;
  listeningPorts: number[];
}

type ProfileSource = "native" | "isolated";

interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  isDefault: boolean;
}

interface AccountSyncRecord {
  sourceProfileId: string;
  targetProfileId: string;
  syncedAt: string;
  copiedCount: number;
  skippedCount: number;
  launchedTarget: boolean;
  sourceFingerprints?: Record<string, string | null>;
}

interface ExternalChromeInstance {
  userDataDir: string;
  label: string;
  browser: string;
  pid: number;
  startedAt: string | null;
  cdpPort: number | null;
  cdpUrl: string | null;
}

interface AppState {
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
}

interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
}

interface ExtensionDataPath {
  label: string;
  relativePath: string;
  path: string;
}

type ProfileExtensionInstallType = "web_store" | "local" | "profile" | "component" | "unknown";

interface ProfileExtensionInfo {
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
}

interface ExtensionScanResult {
  profileId: string;
  profileName: string;
  profilePath: string;
  extensions: ProfileExtensionInfo[];
}

interface ExtensionMigrationRequest {
  sourceProfileId: string;
  targetProfileId: string;
  extensionIds: string[];
  includeData: boolean;
  openInstallPages: boolean;
  onlyChanged?: boolean;
}

type ExtensionMigrationDiffStatus =
  | "missing"
  | "version_changed"
  | "data_changed"
  | "same"
  | "needs_install_page"
  | "manual_load_required"
  | "unsupported";

interface ExtensionMigrationDiffItem {
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

interface ExtensionMigrationDiffTargetOnlyItem {
  id: string;
  name: string;
  version: string;
}

interface ExtensionMigrationDiffResult {
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

interface ExtensionMigrationCopiedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  fromWebStore: boolean;
}

interface ExtensionMigrationDataCopy {
  id: string;
  name: string;
  relativePath: string;
}

interface ExtensionMigrationLoadedExtension {
  id: string;
  loadedId: string;
  name: string;
  version: string;
  path: string;
  via: "cdp_runtime";
}

interface ExtensionMigrationSkippedExtension {
  id: string;
  name: string;
  reason: string;
}

interface ExtensionMigrationManualLoadExtension {
  id: string;
  name: string;
  path: string;
}

interface ExtensionMigrationResult {
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
  state: AppState;
}

interface ExtensionDeleteResult {
  profileId: string;
  profileName: string;
  extensionId: string;
  extensionName: string;
  deletedPaths: string[];
  scan: ExtensionScanResult;
  state: AppState;
}

interface AccountSyncRequest {
  sourceProfileId: string;
  targetProfileId: string;
  launchTarget: boolean;
  onlyChanged?: boolean;
}

interface CancelOperationRequest {
  key: string;
  profileId?: string;
}

type ControlOperationAction = "pause" | "resume";

interface ControlOperationRequest {
  key: string;
  profileId?: string;
  action: ControlOperationAction;
}

interface AccountSyncCopiedItem {
  label: string;
  relativePath: string;
}

interface AccountSyncSkippedItem {
  label: string;
  relativePath: string;
  reason: string;
}

interface AccountSyncResult {
  sourceProfileId: string;
  targetProfileId: string;
  copiedItems: AccountSyncCopiedItem[];
  skippedItems: AccountSyncSkippedItem[];
  launchedTarget: boolean;
  state: AppState;
}

interface OperationProgress {
  key: string;
  message: string;
  profileId?: string;
  step?: string;
  stepIndex?: number;
  stepCount?: number;
  paused?: boolean;
}

interface ProfileManagerApi {
  getState(): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  renameProfile(id: string, name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null): Promise<AppState>;
  focusProfile(id: string): Promise<AppState>;
  closeProfile(id: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  openProfileExtensionsPage(id: string): Promise<AppState>;
  openPath(path: string): Promise<boolean>;
  deleteProfile(id: string): Promise<DeleteProfileResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
  cancelOperation(request: CancelOperationRequest): Promise<boolean>;
  controlOperation(request: ControlOperationRequest): Promise<boolean>;
  onOperationProgress(listener: (progress: OperationProgress) => void): () => void;
}

interface Window {
  profileManager: ProfileManagerApi;
}

type ConfirmIntent =
  | {
      kind: "profile";
      action: "close" | "delete";
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
    };
type BusyState = {
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
type BusyProgressStep = {
  label: string;
  status: "pending" | "active" | "done";
};
type ModalState =
  | { kind: "new" }
  | { kind: "rename"; profileId: string }
  | { kind: "cdp"; profileId: string }
  | { kind: "extension-migration" }
  | {
      kind: "confirm";
      intent: ConfirmIntent;
      returnTo?: "extension-migration";
    }
  | null;
type ToastKind = "normal" | "error";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Missing #app root.");
}

const appRoot: HTMLDivElement = root;

let state: AppState | null = null;
let selectedId: string | null = null;
let modal: ModalState = null;
let busy = false;
let busyState: BusyState | null = null;
let toast: string | null = null;
let toastKind: ToastKind = "normal";
let toastTimer: number | undefined;
let migrationSourceId: string | null = null;
let migrationTargetId: string | null = null;
let extensionScan: ExtensionScanResult | null = null;
let selectedExtensionIds = new Set<string>();
let includeExtensionData = false;
let openInstallPages = true;
let extensionSyncOnlyChanged = true;
let extensionMigrationDiff: ExtensionMigrationDiffResult | null = null;
let extensionMigrationDiffLoading = false;
let extensionMigrationDiffKey = "";
let extensionMigrationDiffRequestId = 0;
let extensionMigrationResult: ExtensionMigrationResult | null = null;
let extensionScanPreviewCollapsed = false;
let openProfileMenuId: string | null = null;
let migrationSourceMenuOpen = false;
let migrationTargetMenuOpen = false;
let accountSyncMenuOpen: "source" | "target" | null = null;
let accountSyncSourceId: string | null = null;
let accountSyncTargetId: string | null = null;
let launchSyncedProfile = true;
let accountSyncScopeExpanded = false;
let accountSyncResult: AccountSyncResult | null = null;

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

function profileApi(): ProfileManagerApi {
  if (!window.profileManager) {
    throw new Error("Desktop bridge is not available.");
  }

  return window.profileManager;
}

profileApi().onOperationProgress((progress) => {
  if (!busyState || busyState.key !== progress.key) {
    return;
  }
  if (progress.profileId && busyState.profileId && progress.profileId !== busyState.profileId) {
    return;
  }

  const previousStepIndex = busyState.stepIndex;
  const previousStepCount = busyState.stepCount;
  const previousPaused = busyState.paused;
  const previousStepsKey = busyStepsKey(busyState.steps);
  const nextSteps = progress.step ? activateBusyStep(busyState.steps || [], progress.step) : busyState.steps;
  const activeStepIndex = progress.step
    ? nextSteps?.findIndex((step) => step.label === progress.step)
    : -1;

  busyState = {
    ...busyState,
    message: progress.message || busyState.message,
    stepIndex: activeStepIndex !== undefined && activeStepIndex >= 0 ? activeStepIndex + 1 : progress.stepIndex || busyState.stepIndex,
    stepCount: nextSteps?.length || progress.stepCount || busyState.stepCount,
    steps: nextSteps,
    paused: progress.paused ?? busyState.paused
  };

  const nextStepsKey = busyStepsKey(busyState.steps);
  if (
    previousStepIndex !== busyState.stepIndex ||
    previousStepCount !== busyState.stepCount ||
    previousPaused !== busyState.paused ||
    previousStepsKey !== nextStepsKey ||
    !updateBusyProgressDom()
  ) {
    render();
  }
});

async function loadState(): Promise<void> {
  state = await profileApi().getState();
  const profiles = state.profiles || [];

  if (!profiles.some((profile) => profile.id === selectedId)) {
    selectedId = state.currentProfile?.id || profiles[0]?.id || null;
  }
  if (openProfileMenuId && !profiles.some((profile) => profile.id === openProfileMenuId)) {
    openProfileMenuId = null;
  }

  normalizeMigrationProfileSelection(profiles);
  normalizeAccountSyncProfileSelection(profiles);
  render();
}

function normalizeMigrationProfileSelection(profiles: PublicProfile[]): void {
  if (!profiles.length) {
    migrationSourceId = null;
    migrationTargetId = null;
    extensionScan = null;
    selectedExtensionIds.clear();
    extensionScanPreviewCollapsed = false;
    migrationSourceMenuOpen = false;
    return;
  }

  if (!profiles.some((profile) => profile.id === migrationSourceId)) {
    migrationSourceId = selectedId || profiles[0].id;
    extensionScan = null;
    selectedExtensionIds.clear();
    extensionScanPreviewCollapsed = false;
    migrationSourceMenuOpen = false;
  }

  if (!profiles.some((profile) => profile.id === migrationTargetId) || migrationTargetId === migrationSourceId) {
    migrationTargetId = profiles.find((profile) => profile.id !== migrationSourceId)?.id || null;
  }
}

function normalizeAccountSyncProfileSelection(profiles: PublicProfile[]): void {
  if (!profiles.length) {
    accountSyncSourceId = null;
    accountSyncTargetId = null;
    accountSyncResult = null;
    accountSyncMenuOpen = null;
    return;
  }

  if (!profiles.some((profile) => profile.id === accountSyncSourceId)) {
    accountSyncSourceId = profiles.find((profile) => profile.userName)?.id || selectedId || profiles[0].id;
  }

  if (!profiles.some((profile) => profile.id === accountSyncTargetId) || accountSyncTargetId === accountSyncSourceId) {
    accountSyncTargetId =
      profiles.find((profile) => profile.id !== accountSyncSourceId && profile.source === "isolated")?.id ||
      profiles.find((profile) => profile.id !== accountSyncSourceId)?.id ||
      null;
  }
}

async function refreshExtensionMigrationDiff(): Promise<void> {
  const activeScan = extensionScan?.profileId === migrationSourceId ? extensionScan : null;
  const extensionIds = activeScan?.extensions
    .filter((extension) => selectedExtensionIds.has(extension.id))
    .map((extension) => extension.id) || [];
  if (!state || !migrationSourceId || !migrationTargetId || migrationSourceId === migrationTargetId || !extensionIds.length) {
    extensionMigrationDiff = null;
    extensionMigrationDiffLoading = false;
    extensionMigrationDiffKey = "";
    render();
    return;
  }

  const key = [
    migrationSourceId,
    migrationTargetId,
    includeExtensionData ? "data" : "nodata",
    openInstallPages ? "openpages" : "noopenpages",
    extensionIds.slice().sort().join(",")
  ].join("::");
  if (extensionMigrationDiffKey === key && (extensionMigrationDiff || extensionMigrationDiffLoading)) {
    return;
  }

  const requestId = extensionMigrationDiffRequestId + 1;
  extensionMigrationDiffRequestId = requestId;
  extensionMigrationDiffKey = key;
  extensionMigrationDiffLoading = true;
  render();

  try {
    const diff = await profileApi().inspectExtensionMigrationDiff({
      sourceProfileId: migrationSourceId,
      targetProfileId: migrationTargetId,
      extensionIds,
      includeData: includeExtensionData,
      openInstallPages,
      onlyChanged: extensionSyncOnlyChanged
    });
    if (extensionMigrationDiffRequestId !== requestId) {
      return;
    }
    extensionMigrationDiff = diff;
  } catch {
    if (extensionMigrationDiffRequestId !== requestId) {
      return;
    }
    extensionMigrationDiff = null;
  } finally {
    if (extensionMigrationDiffRequestId === requestId) {
      extensionMigrationDiffLoading = false;
      render();
    }
  }
}

function invalidateExtensionMigrationDiff(): void {
  extensionMigrationDiffRequestId += 1;
  extensionMigrationDiff = null;
  extensionMigrationDiffKey = "";
}

function setToast(message: string, kind: ToastKind = "normal"): void {
  toast = message;
  toastKind = kind;
  render();

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    render();
  }, 3200);
}

function activateBusyStep(steps: BusyProgressStep[], activeLabel: string): BusyProgressStep[] {
  const existingIndex = steps.findIndex((step) => step.label === activeLabel);
  const nextSteps = existingIndex >= 0 ? [...steps] : [...steps, { label: activeLabel, status: "pending" as const }];
  const activeIndex = existingIndex >= 0 ? existingIndex : nextSteps.length - 1;

  return nextSteps.map((step, index) => ({
    ...step,
    status: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending"
  }));
}

function pendingBusySteps(labels: string[]): BusyProgressStep[] {
  return labels.map((label, index) => ({ label, status: index === 0 ? "active" : "pending" }));
}

function doneBusySteps(labels: string[]): BusyProgressStep[] {
  return labels.map((label) => ({ label, status: "done" }));
}

function accountSyncProgressSteps(): string[] {
  return ["检查 Profile", "确认覆盖", "复制账号数据", "合并偏好", "写入浏览器状态", "完成"];
}

function accountSyncProgressStepsForTarget(targetProfile: PublicProfile | null): string[] {
  const steps = accountSyncProgressSteps();
  return targetProfile?.running ? ["关闭目标", ...steps] : steps;
}

function extensionSyncProgressSteps(): string[] {
  return ["检查 Profile", "扫描插件", "确认覆盖", "同步插件", "写入配置", "完成"];
}

function extensionSyncProgressStepsForTarget(targetProfile: PublicProfile | null): string[] {
  const steps = extensionSyncProgressSteps();
  return targetProfile?.running ? ["关闭目标", ...steps] : steps;
}

function updateBusyState(patch: Partial<BusyState>): void {
  if (!busyState) {
    return;
  }

  busyState = {
    ...busyState,
    ...patch
  };
  render();
}

async function withBusy(work: () => Promise<unknown>, successMessage?: string, nextBusyState?: BusyState): Promise<void> {
  if (busy) {
    return;
  }

  busy = true;
  busyState = nextBusyState || {
    key: "generic",
    message: "正在处理…"
  };
  render();

  try {
    await work();
    if (successMessage) {
      if (busyState?.steps?.length) {
        busyState = {
          ...busyState,
          message: successMessage,
          steps: doneBusySteps(busyState.steps.map((step) => step.label))
        };
        render();
      }
      setToast(successMessage);
    }
  } catch (error) {
    setToast(formatErrorMessage(error), "error");
  } finally {
    busy = false;
    busyState = null;
    await loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }
}

function isBusyAction(key: string, match: Partial<Omit<BusyState, "key" | "message">> = {}): boolean {
  const activeBusyState = busyState;
  if (!activeBusyState || activeBusyState.key !== key) {
    return false;
  }

  return Object.entries(match).every(([field, value]) => activeBusyState[field as keyof BusyState] === value);
}

function busyStepsKey(steps: BusyProgressStep[] | undefined): string {
  return steps?.map((step) => `${step.label}:${step.status}`).join("|") || "";
}

function updateBusyProgressDom(): boolean {
  if (!busyState) {
    return false;
  }

  const messageNodes = appRoot.querySelectorAll<HTMLElement>("[data-busy-message]");
  if (!messageNodes.length) {
    return false;
  }

  messageNodes.forEach((node) => {
    node.textContent = busyState?.message || "";
  });

  const countText = busyState.stepIndex && busyState.stepCount ? `${busyState.stepIndex}/${busyState.stepCount}` : "";
  appRoot.querySelectorAll<HTMLElement>("[data-busy-count]").forEach((node) => {
    node.textContent = countText;
  });

  return true;
}

function renderBusyBanner(): string {
  if (!busyState) {
    return "";
  }

  return `
    <div class="busy-banner ${busyState.paused ? "paused" : ""}" role="status" aria-live="polite">
      <span class="sync-spinner" aria-hidden="true"></span>
      <span data-busy-message>${escapeHtml(busyState.message)}</span>
      ${busyState.stepIndex && busyState.stepCount ? `<span class="busy-step-count" data-busy-count>${busyState.stepIndex}/${busyState.stepCount}</span>` : ""}
    </div>
  `;
}

function renderOperationProgress(key: string, title: string): string {
  const activeBusyState = busyState?.key === key ? busyState : null;
  if (!activeBusyState) {
    return "";
  }

  return `
    <div class="operation-progress ${activeBusyState.paused ? "paused" : ""}" role="status" aria-live="polite">
      <div class="operation-progress-head">
        <span class="sync-spinner" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span data-busy-message>${escapeHtml(activeBusyState.message)}</span>
        </div>
        ${activeBusyState.stepIndex && activeBusyState.stepCount ? `<em data-busy-count>${activeBusyState.stepIndex}/${activeBusyState.stepCount}</em>` : ""}
      </div>
      ${activeBusyState.steps?.length ? renderOperationProgressSteps(activeBusyState.steps) : ""}
    </div>
  `;
}

function renderOperationProgressSteps(steps: BusyProgressStep[]): string {
  return `
    <ol class="operation-progress-steps">
      ${steps
        .map(
          (step) => `
            <li class="${step.status}">
              <span aria-hidden="true"></span>
              <strong>${escapeHtml(step.label)}</strong>
            </li>
          `
        )
        .join("")}
    </ol>
  `;
}

function renderButtonLabel(isLoading: boolean, idleLabel: string, loadingLabel: string): string {
  if (!isLoading) {
    return escapeHtml(idleLabel);
  }

  return `<span class="inline-spinner" aria-hidden="true"></span><span>${escapeHtml(loadingLabel)}</span>`;
}

function formatErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const ipcPrefix = /^Error invoking remote method '[^']+':\s*/;
  const classPrefix = /^(ProfileManagerError|Error):\s*/;
  const cleaned = rawMessage.replace(ipcPrefix, "").replace(classPrefix, "").trim();
  if (cleaned.includes("ENOENT") && cleaned.includes(".profilepilot-sync-")) {
    return "同步临时文件已被系统清理或上次任务中断，请重新点击同步，ProfilePilot 会先恢复临时状态再继续。";
  }

  return cleaned || "操作失败，请稍后重试。";
}

function render(): void {
  if (!state) {
    appRoot.innerHTML = '<div class="app-loading">Loading...</div>';
    return;
  }

  const profiles = state.profiles || [];
  const selected = profiles.find((profile) => profile.id === selectedId) || null;
  const runningNames = state.runningProfiles.map((profile) => profile.name).join("、");
  const currentLabel = state.runningProfiles.length ? runningNames : "无";
  const currentNote = state.runningProfiles.length
    ? `${state.runningProfiles.length} 个 Profile 正在运行`
    : "当前没有正在运行的 Profile";
  const refreshing = isBusyAction("refresh");
  const busyHasEmbeddedProgress = busyState?.key === "account-sync" || busyState?.key === "migrate-extensions";

  appRoot.className = "";
  appRoot.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div class="brand-lockup">
          <img class="brand-mark" src="./assets/profilepilot-mark.svg" alt="" />
          <div class="brand-copy">
            <p class="eyebrow">Browser Profile Desk</p>
            <h1>ProfilePilot</h1>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="${refreshing ? "loading" : ""}" data-action="refresh" ${busy ? "disabled" : ""}>
            ${renderButtonLabel(refreshing, "刷新", "刷新中…")}
          </button>
          <button type="button" class="primary" data-action="new-profile" ${busy ? "disabled" : ""}>新建独立 Profile</button>
        </div>
      </header>

      ${busyHasEmbeddedProgress ? "" : renderBusyBanner()}

      <section class="status-grid" aria-label="Profile status">
        <div class="status-item current">
          <span class="status-label">当前运行</span>
          <strong class="status-value">${escapeHtml(currentLabel)}</strong>
          <span class="status-note">${escapeHtml(currentNote)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Profiles</span>
          <strong class="status-value">${profiles.length}</strong>
          <span class="status-note">本机所有可管理的 Chrome Profile</span>
        </div>
        <div class="status-item">
          <span class="status-label">运行中</span>
          <strong class="status-value">${state.runningProfiles.length}</strong>
          <span class="status-note">可以点击“显示”拉到屏幕最前面</span>
        </div>
      </section>

      ${renderAccountSyncPanel(profiles)}
      ${renderExtensionMigrationPanel(profiles)}

      <main class="layout">
        <section>
          <div class="section-head">
            <h2>Profiles</h2>
            <span class="count">${profiles.length}</span>
          </div>
          ${profiles.length ? renderTable(profiles) : renderEmpty()}
          ${renderExternalInstances(state.externalInstances || [])}
        </section>
        ${renderDetails(selected)}
      </main>
    </div>
    ${modal?.kind === "new" ? renderNewModal() : ""}
    ${modal?.kind === "rename" ? renderRenameModal(modal.profileId) : ""}
    ${modal?.kind === "cdp" ? renderCdpModal(modal.profileId) : ""}
    ${modal?.kind === "extension-migration" ? renderExtensionMigrationModal(profiles) : ""}
    ${modal?.kind === "confirm" ? renderConfirmModal(modal) : ""}
    ${toast ? `<div class="toast ${toastKind === "error" ? "error" : ""}" role="status">${escapeHtml(toast)}</div>` : ""}
  `;
}

function renderAccountSyncPanel(profiles: PublicProfile[]): string {
  const sourceId = accountSyncSourceId || profiles[0]?.id || "";
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const targetId =
    accountSyncTargetId && accountSyncTargetId !== sourceId
      ? accountSyncTargetId
      : profiles.find((profile) => profile.id !== sourceId)?.id || "";
  const targetProfile = profiles.find((profile) => profile.id === targetId) || null;
  const runningBlocker = targetProfile?.running ? targetProfile : null;
  const canSync = Boolean(sourceProfile && targetProfile && sourceProfile.id !== targetProfile.id);
  const syncingAccount = isBusyAction("account-sync");
  const accountSyncRecord =
    state?.accountSyncRecords.find((record) => record.sourceProfileId === sourceId && record.targetProfileId === targetId) ||
    null;
  const syncButtonLabel = "同步";
  const syncingLabel = runningBlocker ? "关闭并同步中…" : "同步中…";
  const launchLabel = runningBlocker ? "同步后重新启动目标" : "同步后启动目标";
  const cancelRequested = Boolean(syncingAccount && busyState?.cancelRequested);
  const pausedAccountSync = Boolean(syncingAccount && busyState?.paused);

  return `
    <section class="account-sync-panel" data-account-sync aria-busy="${syncingAccount ? "true" : "false"}">
      <div class="section-head">
        <div>
          <h2>账号同步</h2>
          <span class="section-subtitle">Account session</span>
        </div>
      </div>

      <div class="account-sync-layout ${syncingAccount ? "syncing" : ""}">
        <div class="account-sync-fields">
          <div class="field compact">
            <span class="picker-label" id="account-sync-source-label">源 Profile</span>
            ${renderAccountSyncPicker("source", profiles, sourceId)}
          </div>
          <div class="field compact">
            <span class="picker-label" id="account-sync-target-label">目标 Profile</span>
            ${renderAccountSyncPicker("target", profiles, targetId, sourceId)}
          </div>
        </div>

        <div class="account-sync-controls">
          <div class="account-sync-options">
            <label class="check-control account-sync-launch">
              <input type="checkbox" data-launch-synced-profile ${launchSyncedProfile ? "checked" : ""} ${busy ? "disabled" : ""} />
              <span>${launchLabel}</span>
            </label>
          </div>

          <div class="account-sync-actions">
            <button type="button" class="primary ${syncingAccount ? "loading" : ""}" data-action="sync-account" ${busy || !canSync ? "disabled" : ""}>
              ${renderButtonLabel(syncingAccount, syncButtonLabel, syncingLabel)}
            </button>
            ${
              syncingAccount
                ? `<button type="button" class="action-button account-sync-pause ${pausedAccountSync ? "accent" : "cdp"}" data-action="toggle-account-sync-pause" ${cancelRequested ? "disabled" : ""}>
                    ${pausedAccountSync ? "继续同步" : "暂停同步"}
                  </button>
                  <button type="button" class="action-button warn account-sync-cancel ${cancelRequested ? "loading" : ""}" data-action="cancel-account-sync" ${cancelRequested ? "disabled" : ""}>
                    ${renderButtonLabel(cancelRequested, "终止同步", "正在终止…")}
                  </button>`
                : ""
            }
          </div>
        </div>
      </div>

      ${syncingAccount ? renderAccountSyncLoading(sourceProfile, targetProfile) : ""}

      <div class="account-sync-note ${runningBlocker ? "warn" : ""}">
        ${escapeHtml(accountSyncNote(sourceProfile, targetProfile, runningBlocker, accountSyncRecord))}
      </div>

      ${renderAccountSyncScopeToggle()}
      ${accountSyncScopeExpanded ? renderAccountSyncScope() : ""}

      ${accountSyncResult ? renderAccountSyncResult(accountSyncResult) : ""}
    </section>
  `;
}

function renderAccountSyncLoading(sourceProfile: PublicProfile | null, targetProfile: PublicProfile | null): string {
  const sourceName = sourceProfile?.name || "源 Profile";
  const targetName = targetProfile?.name || "目标 Profile";
  return renderOperationProgress("account-sync", `账号同步：${sourceName} 到 ${targetName}`);
}

function accountSyncNote(
  sourceProfile: PublicProfile | null,
  targetProfile: PublicProfile | null,
  runningBlocker: PublicProfile | null,
  accountSyncRecord: AccountSyncRecord | null
): string {
  if (!sourceProfile || !targetProfile) {
    return "至少需要两个 Profile 才能同步账号。";
  }

  if (runningBlocker) {
    if (accountSyncRecord) {
      return `目标 ${runningBlocker.name} 正在运行，且上次已在 ${formatDate(accountSyncRecord.syncedAt)} 从 ${sourceProfile.name} 同步过。重新同步会先关闭目标再覆盖刷新，不会重复叠加。`;
    }

    return `目标 ${runningBlocker.name} 正在运行。同步时会先关闭目标，写入完成后再按设置重新启动。`;
  }

  if (accountSyncRecord) {
    return `上次已在 ${formatDate(accountSyncRecord.syncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。再次同步会重新覆盖目标，不会重复叠加。`;
  }

  if (sourceProfile.running) {
    return "目标 Profile 的登录态会被源 Profile 覆盖。";
  }

  return `会用 ${sourceProfile.name} 的登录态覆盖 ${targetProfile.name} 的登录态。`;
}

function renderAccountSyncScope(): string {
  const syncedItems = [
    "Google 登录态、Cookie、头像和账号身份状态",
    "站点会话数据：Local/Session Storage、IndexedDB、Service Worker、WebStorage",
    "账号与同步数据：Accounts、Sync Data、Sync App/Extension Settings、Trusted Vault",
    "书签、历史记录、下载记录、快捷方式、常用网站和网站图标",
    "浏览器设置和主题：Preferences、Secure Preferences，以及 Local State 中的登录字段"
  ];
  const excludedItems = [
    "打开的标签页或窗口",
    "保存的密码库 Login Data、证书、系统钥匙串权限",
    "扩展安装包本体、插件本地数据和插件列表迁移",
    "尚未落盘的数据"
  ];

  return `
    <div class="account-sync-scope" aria-label="账号同步范围">
      ${renderAccountSyncScopeGroup("会同步", syncedItems)}
      ${renderAccountSyncScopeGroup("不会同步", excludedItems)}
    </div>
  `;
}

function renderAccountSyncScopeToggle(): string {
  return `
    <div class="account-sync-scope-toggle">
      <button type="button" class="diff-more-button" data-action="toggle-account-sync-scope" aria-expanded="${accountSyncScopeExpanded ? "true" : "false"}">
        ${accountSyncScopeExpanded ? "收起同步范围" : "查看同步范围"}
      </button>
    </div>
  `;
}

function renderAccountSyncScopeGroup(title: string, items: string[]): string {
  return `
    <div class="account-sync-scope-group">
      <strong>${escapeHtml(title)}</strong>
      <ul>
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderAccountSyncResult(result: AccountSyncResult): string {
  return `
    <div class="account-sync-result">
      <div class="result-complete">
        <strong>账号同步完成</strong>
        <span>${result.launchedTarget ? "目标 Profile 已启动。" : "目标 Profile 已更新。"}</span>
      </div>
      <div class="migration-result-grid account-sync-result-grid">
        <div>
          <span>已同步</span>
          <strong>${result.copiedItems.length}</strong>
        </div>
        <div>
          <span>跳过</span>
          <strong>${result.skippedItems.length}</strong>
        </div>
        <div>
          <span>目标启动</span>
          <strong>${result.launchedTarget ? "是" : "否"}</strong>
        </div>
      </div>
      ${result.skippedItems.length ? renderAccountSyncSkippedItems(result.skippedItems) : ""}
    </div>
  `;
}

function renderAccountSyncSkippedItems(items: AccountSyncSkippedItem[]): string {
  return `
    <div class="skipped-list">
      <span>未复制项目</span>
      ${items
        .slice(0, 8)
        .map((item) => `<span><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.reason)}</span>`)
        .join("")}
      ${items.length > 8 ? `<span>还有 ${items.length - 8} 项未复制。</span>` : ""}
    </div>
  `;
}

function renderTable(profiles: PublicProfile[]): string {
  return `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${profiles.map(renderProfileRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProfileRow(profile: PublicProfile): string {
  const selected = profile.id === selectedId;
  return `
    <tr class="${selected ? "selected" : ""}" data-action="select" data-id="${profile.id}" data-profile-row tabindex="0" aria-selected="${selected ? "true" : "false"}">
      <td>
        <div class="profile-pick">
          <span class="profile-name-line">
            <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
            <span class="profile-name">${escapeHtml(profile.name)}</span>
            ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
          </span>
          <span class="profile-dir">${escapeHtml(profile.userName || profile.dirName)}</span>
        </div>
      </td>
      <td>
        <span class="state-pill ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td>
        ${renderProfileActions(profile)}
      </td>
    </tr>
  `;
}

function renderProfileActions(profile: PublicProfile): string {
  const menuOpen = openProfileMenuId === profile.id;
  const cdpLaunchDisabled = busy || profile.running || profile.source !== "isolated";
  const deleteDisabled = busy || profile.running || !profile.deletable;
  const focusing = isBusyAction("focus-profile", { profileId: profile.id });
  const closing = isBusyAction("close-profile", { profileId: profile.id });
  const launching = isBusyAction("launch-profile", { profileId: profile.id });
  const launchingCdp = isBusyAction("launch-cdp", { profileId: profile.id });
  const openingFolder = isBusyAction("open-folder", { profileId: profile.id });
  const renaming = isBusyAction("rename-profile", { profileId: profile.id });
  const deleting = isBusyAction("delete-profile", { profileId: profile.id });

  return `
    <div class="profile-actions" data-profile-actions>
      ${
        profile.running
          ? `
            <span class="action-tooltip" data-tooltip="${escapeHtml(focusButtonTitle(profile))}">
              <button type="button" class="action-button accent ${focusing ? "loading" : ""}" data-action="focus-profile" data-id="${profile.id}" ${busy ? "disabled" : ""}>
                ${renderButtonLabel(focusing, "显示", "显示中…")}
              </button>
            </span>
          `
          : `
            <span class="action-tooltip" data-tooltip="${escapeHtml(launchButtonTitle(profile))}">
              <button type="button" class="action-button accent ${launching ? "loading" : ""}" data-action="launch" data-id="${profile.id}" ${busy ? "disabled" : ""}>
                ${renderButtonLabel(launching, "启动", "启动中…")}
              </button>
            </span>
          `
      }
      <span class="action-tooltip" data-tooltip="${escapeHtml(closeButtonTitle(profile))}">
        <button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-profile" data-id="${profile.id}" ${busy || !profile.running ? "disabled" : ""}>
          ${renderButtonLabel(closing, "关闭", "关闭中…")}
        </button>
      </span>
      <span class="action-tooltip" data-tooltip="${escapeHtml(cdpLaunchButtonTitle(profile))}">
        <button type="button" class="action-button cdp ${launchingCdp ? "loading" : ""}" data-action="launch-cdp" data-id="${profile.id}" ${cdpLaunchDisabled ? "disabled" : ""}>
          ${renderButtonLabel(launchingCdp, "CDP启动", "启动中…")}
        </button>
      </span>
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu" role="menu">
              <button type="button" class="${openingFolder ? "loading" : ""}" data-action="open-folder" data-id="${profile.id}" ${busy ? "disabled" : ""}>
                ${renderButtonLabel(openingFolder, "打开目录", "打开中…")}
              </button>
              <button type="button" class="${renaming ? "loading" : ""}" data-action="rename-profile" data-id="${profile.id}" ${busy ? "disabled" : ""}>
                ${renderButtonLabel(renaming, "修改名称", "保存中…")}
              </button>
              <span class="action-tooltip" data-tooltip="${escapeHtml(deleteButtonTitle(profile))}">
                <button type="button" class="danger ${deleting ? "loading" : ""}" data-action="delete" data-id="${profile.id}" ${deleteDisabled ? "disabled" : ""}>
                  ${renderButtonLabel(deleting, "删除 Profile", "删除中…")}
                </button>
              </span>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderEmpty(): string {
  return `
    <div class="empty-state">
      <strong>还没有 Profile</strong>
      <button type="button" class="primary" data-action="new-profile">新建独立 Profile</button>
    </div>
  `;
}

function renderExternalInstances(instances: ExternalChromeInstance[]): string {
  if (!instances.length) {
    return "";
  }

  return `
    <section class="external-panel" aria-label="外部 Chrome 实例">
      <div class="external-panel-head">
        <div>
          <h3>外部 Chrome 实例</h3>
          <span>由其他工具自管的 Chromium 实例（agent-browser 等），仅供查看，不支持迁移和同步。</span>
        </div>
        <span class="count">${instances.length}</span>
      </div>
      <div class="external-list">
        ${instances.map((instance) => renderExternalInstance(instance)).join("")}
      </div>
    </section>
  `;
}

function renderExternalInstance(instance: ExternalChromeInstance): string {
  const cdpNote =
    instance.cdpPort !== null && !instance.cdpUrl ? ` · 声明 CDP 端口 ${instance.cdpPort}（当前未响应）` : "";

  return `
    <div class="external-item">
      <div class="external-item-head">
        <span class="status-dot running"></span>
        <strong>${escapeHtml(instance.label)}</strong>
        <span class="source-pill">${escapeHtml(instance.browser)}</span>
        ${instance.cdpUrl ? '<span class="source-pill isolated">CDP 可连接</span>' : ""}
      </div>
      <span class="external-item-meta">PID ${instance.pid} · 启动于 ${formatDate(instance.startedAt)}${escapeHtml(cdpNote)}</span>
      ${instance.cdpUrl ? `<code class="path-box compact accent">${escapeHtml(instance.cdpUrl)}</code>` : ""}
      <code class="path-box compact">${escapeHtml(instance.userDataDir)}</code>
    </div>
  `;
}

function renderExtensionMigrationPanel(profiles: PublicProfile[]): string {
  const sourceId = migrationSourceId || profiles[0]?.id || "";
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const activeScan = extensionScan?.profileId === sourceId ? extensionScan : null;
  const selectedCount = activeScan
    ? activeScan.extensions.filter((extension) => selectedExtensionIds.has(extension.id)).length
    : 0;
  const allSelected = Boolean(
    activeScan?.extensions.length && activeScan.extensions.every((extension) => selectedExtensionIds.has(extension.id))
  );
  const hasAvailableTarget = profiles.some((profile) => profile.id !== sourceId);
  const canMigrate = Boolean(sourceProfile && activeScan && selectedCount && hasAvailableTarget);
  const scanning = isBusyAction("scan-extensions");
  const migrating = isBusyAction("migrate-extensions");

  return `
    <section class="migration-panel" data-extension-migration aria-busy="${migrating ? "true" : "false"}">
      <div class="section-head">
        <div>
          <h2>插件同步</h2>
          <span class="section-subtitle">Extensions</span>
        </div>
      </div>

      <div class="migration-source-bar">
        <div class="migration-source-field">
          <span id="migration-source-label">源 Profile</span>
          ${renderMigrationSourcePicker(profiles, sourceId, sourceProfile)}
        </div>
        <button type="button" class="${scanning ? "loading" : ""}" data-action="scan-extensions" ${busy || !sourceProfile ? "disabled" : ""}>
          ${renderButtonLabel(scanning, "扫描源 Profile 插件", "扫描中…")}
        </button>
        ${sourceProfile ? renderMigrationSourceSummary(sourceProfile, activeScan) : ""}
      </div>

      ${migrating ? renderOperationProgress("migrate-extensions", "插件同步进度") : ""}
      ${activeScan ? renderExtensionScan(activeScan, selectedCount, allSelected, canMigrate) : renderExtensionScanEmpty()}
      ${extensionMigrationResult ? renderExtensionMigrationResult(extensionMigrationResult) : ""}
    </section>
  `;
}

function renderMigrationSourcePicker(
  profiles: PublicProfile[],
  selectedProfileId: string,
  selectedProfile: PublicProfile | null
): string {
  const expanded = migrationSourceMenuOpen && profiles.length > 0;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-migration-source-select>
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-migration-source-menu"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="migration-source-label"
        ${busy || !profiles.length ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${expanded ? renderMigrationSourceMenu(profiles, selectedProfileId) : ""}
    </div>
  `;
}

function renderMigrationSourceMenu(profiles: PublicProfile[], selectedProfileId: string): string {
  return `
    <div class="profile-select-menu" id="migration-source-menu" role="listbox" aria-labelledby="migration-source-label">
      ${profiles.map((profile) => renderMigrationSourceOption(profile, selectedProfileId)).join("")}
    </div>
  `;
}

function renderMigrationSourceOption(profile: PublicProfile, selectedProfileId: string): string {
  const selected = profile.id === selectedProfileId;

  return `
    <button
      type="button"
      class="profile-select-option ${selected ? "selected" : ""}"
      data-action="select-migration-source"
      data-id="${escapeHtml(profile.id)}"
      role="option"
      aria-selected="${selected ? "true" : "false"}"
      ${busy ? "disabled" : ""}
    >
      <span class="profile-select-option-main">
        <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
        <strong>${escapeHtml(profile.name)}</strong>
        ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
      </span>
      <span class="profile-select-option-meta">
        ${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${formatDate(profile.lastLaunchedAt)}
      </span>
    </button>
  `;
}

function renderMigrationSourceSummary(profile: PublicProfile, scan: ExtensionScanResult | null): string {
  const extensionCount = scan ? `${scan.extensions.length} 个插件` : "未扫描";

  return `
    <div class="migration-source-summary">
      <strong>${escapeHtml(profile.name)}</strong>
      <span>${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${extensionCount}</span>
    </div>
  `;
}

function renderAccountSyncPicker(
  kind: "source" | "target",
  profiles: PublicProfile[],
  selectedProfileId: string,
  excludedProfileId?: string
): string {
  const options = profiles.filter((profile) => profile.id !== excludedProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || null;
  const disabled = busy || (kind === "source" ? !profiles.length : profiles.length < 2);
  const expanded = accountSyncMenuOpen === kind && options.length > 0 && !disabled;
  const labelId = `account-sync-${kind}-label`;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-account-sync-select="${kind}">
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-account-sync-menu"
        data-kind="${kind}"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="${labelId}"
        ${disabled ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${expanded ? renderAccountSyncMenu(kind, options, selectedProfileId, labelId) : ""}
    </div>
  `;
}

function renderAccountSyncMenu(
  kind: "source" | "target",
  options: PublicProfile[],
  selectedProfileId: string,
  labelId: string
): string {
  return `
    <div class="profile-select-menu" role="listbox" aria-labelledby="${labelId}">
      ${options.map((profile) => renderAccountSyncOption(kind, profile, selectedProfileId)).join("")}
    </div>
  `;
}

function renderAccountSyncOption(kind: "source" | "target", profile: PublicProfile, selectedProfileId: string): string {
  const selected = profile.id === selectedProfileId;

  return `
    <button
      type="button"
      class="profile-select-option ${selected ? "selected" : ""}"
      data-action="select-account-sync-profile"
      data-kind="${kind}"
      data-id="${escapeHtml(profile.id)}"
      role="option"
      aria-selected="${selected ? "true" : "false"}"
      ${busy ? "disabled" : ""}
    >
      <span class="profile-select-option-main">
        <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
        <strong>${escapeHtml(profile.name)}</strong>
        ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
      </span>
      <span class="profile-select-option-meta">
        ${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${formatDate(profile.lastLaunchedAt)}
      </span>
    </button>
  `;
}

function renderMigrationTargetPicker(profiles: PublicProfile[], targetId: string, excludedProfileId?: string): string {
  const options = profiles.filter((profile) => profile.id !== excludedProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === targetId) || null;
  const expanded = migrationTargetMenuOpen && options.length > 0 && !busy;

  return `
    <div class="profile-select ${expanded ? "open" : ""}" data-migration-target-select>
      <button
        type="button"
        class="profile-select-trigger"
        data-action="toggle-migration-target-menu"
        aria-haspopup="listbox"
        aria-expanded="${expanded ? "true" : "false"}"
        aria-labelledby="migration-target-label"
        ${busy || !options.length ? "disabled" : ""}
      >
        <span class="profile-select-trigger-copy">
          <strong>${escapeHtml(selectedProfile?.name || "无可用 Profile")}</strong>
          <span>${selectedProfile ? `${sourceLabel(selectedProfile)} · ${profileStatusLabel(selectedProfile)}` : "先创建 Profile"}</span>
        </span>
        <span class="profile-select-caret" aria-hidden="true"></span>
      </button>
      ${
        expanded
          ? `<div class="profile-select-menu" role="listbox" aria-labelledby="migration-target-label">
              ${options.map((profile) => renderMigrationTargetOption(profile, targetId)).join("")}
            </div>`
          : ""
      }
    </div>
  `;
}

function renderMigrationTargetOption(profile: PublicProfile, targetId: string): string {
  const selected = profile.id === targetId;

  return `
    <button
      type="button"
      class="profile-select-option ${selected ? "selected" : ""}"
      data-action="select-migration-target"
      data-id="${escapeHtml(profile.id)}"
      role="option"
      aria-selected="${selected ? "true" : "false"}"
      ${busy ? "disabled" : ""}
    >
      <span class="profile-select-option-main">
        <span class="status-dot ${profile.running ? "running" : profile.source === "native" ? "native" : ""}"></span>
        <strong>${escapeHtml(profile.name)}</strong>
        ${profile.isDefault ? '<span class="native-badge">Default</span>' : ""}
      </span>
      <span class="profile-select-option-meta">
        ${sourceLabel(profile)} · ${profileStatusLabel(profile)} · ${formatDate(profile.lastLaunchedAt)}
      </span>
    </button>
  `;
}

function renderExtensionScanEmpty(): string {
  return `
    <div class="extension-scan-empty">
      <strong>未扫描</strong>
      <span>选择源 Profile 后扫描插件。</span>
    </div>
  `;
}

function renderExtensionScan(
  scan: ExtensionScanResult,
  selectedCount: number,
  allSelected: boolean,
  canMigrate: boolean
): string {
  if (!scan.extensions.length) {
    return `
      <div class="extension-scan-empty">
        <strong>${escapeHtml(scan.profileName)}</strong>
        <span>没有扫描到可同步插件。</span>
      </div>
    `;
  }

  return `
    <div class="extension-scan-head ${extensionScanPreviewCollapsed ? "collapsed" : ""}">
      <div>
        <strong>${escapeHtml(scan.profileName)}</strong>
        <span>${scan.extensions.length} 个插件 · 已选 ${selectedCount}</span>
      </div>
      <div class="migration-actions">
        <button type="button" class="diff-more-button muted" data-action="toggle-extension-scan-preview" aria-expanded="${extensionScanPreviewCollapsed ? "false" : "true"}">
          ${extensionScanPreviewCollapsed ? "展开预览" : "收起预览"}
        </button>
        <button type="button" data-action="select-all-extensions" ${busy ? "disabled" : ""}>${allSelected ? "取消全选" : "一键全选"}</button>
        <button type="button" class="primary" data-action="migrate-extensions" ${busy || !canMigrate ? "disabled" : ""}>同步所选插件</button>
      </div>
    </div>
    ${
      extensionScanPreviewCollapsed
        ? ""
        : `<div class="extensions-table-wrap">
      <table class="extensions-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>插件</th>
            <th>状态</th>
            <th>来源</th>
            <th>数据</th>
            <th>同步能力</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${scan.extensions.map(renderExtensionRow).join("")}
        </tbody>
      </table>
    </div>`
    }
  `;
}

function renderExtensionRow(extension: ProfileExtensionInfo): string {
  const selected = selectedExtensionIds.has(extension.id);
  const dataLabels = extension.dataPaths.map((item) => item.label).join("、");
  const deleting = isBusyAction("delete-extension", { extensionId: extension.id });

  return `
    <tr>
      <td>
        <input type="checkbox" data-extension-select data-extension-id="${escapeHtml(extension.id)}" ${selected ? "checked" : ""} ${busy ? "disabled" : ""} />
      </td>
      <td>
        <strong class="extension-name">${escapeHtml(extension.name)}</strong>
        <code class="extension-id">${escapeHtml(extension.id)}</code>
      </td>
      <td>
        <span class="state-pill ${extension.enabled ? "running" : ""}">${extension.enabled ? "启用" : "停用"}</span>
        <small class="extension-meta">${escapeHtml(extension.version)}</small>
      </td>
      <td>
        <span class="source-pill ${extension.fromWebStore ? "native" : "isolated"}">${extensionInstallTypeLabel(extension)}</span>
      </td>
      <td>
        <strong class="extension-data-state">${extension.hasLocalData ? "有数据" : "无数据"}</strong>
        ${dataLabels ? `<small class="extension-meta">${escapeHtml(dataLabels)}</small>` : ""}
      </td>
      <td>
        <strong class="extension-plan">${escapeHtml(extensionMigrationCapabilityLabel(extension))}</strong>
      </td>
      <td>
        <button type="button" class="action-button danger ${deleting ? "loading" : ""}" data-action="delete-extension" data-extension-id="${escapeHtml(extension.id)}" ${busy ? "disabled" : ""}>
          ${renderButtonLabel(deleting, "删除", "删除中…")}
        </button>
      </td>
    </tr>
  `;
}

function renderExtensionMigrationResult(result: ExtensionMigrationResult): string {
  const copiedWebStoreCount = result.copiedExtensions.filter((extension) => extension.fromWebStore).length;
  const runtimeLoadCount = result.loadedLocalExtensions.length;
  const autoWrittenCount = result.copiedExtensions.length + result.dataCopies.length + runtimeLoadCount;
  const manualLoadCount = result.manualLoadExtensions.length;
  const hasManualOnlyResult = manualLoadCount > 0 && autoWrittenCount === 0 && result.webStoreInstallUrls.length === 0;
  const title = hasManualOnlyResult ? "插件同步需要手动处理" : "插件同步已处理";
  let detail = result.openedInstallPages ? "已打开需要手动确认的页面。" : "目标 Profile 已更新。";
  if (runtimeLoadCount && manualLoadCount) {
    detail = `已登记 ${runtimeLoadCount} 个本地插件为运行时自动加载；仍有 ${manualLoadCount} 个需要手动处理。`;
  } else if (runtimeLoadCount) {
    detail = `已登记 ${runtimeLoadCount} 个本地插件。目标 Profile 下次由 ProfilePilot 启动时会自动加载。`;
  } else if (manualLoadCount) {
    detail = `下面 ${manualLoadCount} 个本地未打包插件无法自动加载，需要手动选择源目录。`;
  }

  return `
    <div class="migration-result">
      <div class="result-complete">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
      <div class="migration-result-grid">
        <div>
          <span>已处理</span>
          <strong>${result.selectedCount}</strong>
        </div>
        <div>
          <span>自动写入</span>
          <strong>${autoWrittenCount}</strong>
        </div>
        <div>
          <span>运行时加载</span>
          <strong>${runtimeLoadCount}</strong>
        </div>
        <div>
          <span>需手动加载</span>
          <strong>${manualLoadCount}</strong>
        </div>
        <div>
          <span>安装页</span>
          <strong>${copiedWebStoreCount + result.webStoreInstallUrls.length}</strong>
        </div>
      </div>
      ${result.loadedLocalExtensions.length ? renderLoadedLocalExtensions(result.loadedLocalExtensions) : ""}
      ${result.manualLoadExtensions.length ? renderManualLoadExtensions(result) : ""}
      ${result.skippedExtensions.length ? renderSkippedExtensions(result.skippedExtensions) : ""}
    </div>
  `;
}

function renderLoadedLocalExtensions(extensions: ExtensionMigrationLoadedExtension[]): string {
  return `
    <div class="loaded-local-panel">
      <strong>已登记为运行时自动加载</strong>
      <div class="loaded-local-list">
        ${extensions
          .map(
            (extension) => `
              <span>
                <strong>${escapeHtml(extension.name)}</strong>
                <code>${escapeHtml(extension.loadedId)}</code>
              </span>
            `
          )
          .join("")}
      </div>
      <small>Chrome 137+ 不支持静默持久安装本地未打包插件。ProfilePilot 会在启动目标 Profile 时通过 CDP 加载这些源插件目录。</small>
    </div>
  `;
}

function renderManualLoadExtensions(result: ExtensionMigrationResult): string {
  return `
    <div class="manual-load-panel">
      <div class="manual-load-head">
        <strong>手动加载未打包插件</strong>
        <button type="button" data-action="open-target-extensions-page" data-profile-id="${escapeHtml(result.targetProfileId)}" ${busy ? "disabled" : ""}>
          打开目标扩展页
        </button>
      </div>
      <ol class="manual-load-list">
        ${result.manualLoadExtensions
          .map(
            (extension) => `
              <li>
                <div>
                  <strong>${escapeHtml(extension.name)}</strong>
                  <code>${escapeHtml(extension.path)}</code>
                </div>
                <div class="manual-load-actions">
                  <button type="button" data-action="open-manual-extension-folder" data-path="${escapeHtml(extension.path)}" ${busy ? "disabled" : ""}>打开目录</button>
                  <button type="button" data-action="copy-manual-extension-path" data-path="${escapeHtml(extension.path)}">复制路径</button>
                </div>
              </li>
            `
          )
          .join("")}
      </ol>
      <small>在目标 Chrome 的 chrome://extensions 中点击“加载未打包的扩展程序”，选择上面的原始目录。这样 Chrome 才会生成和源 Profile 一致的插件 ID。</small>
    </div>
  `;
}

function renderSkippedExtensions(skippedExtensions: ExtensionMigrationSkippedExtension[]): string {
  return `
    <div class="skipped-list">
      ${skippedExtensions
        .map(
          (extension) =>
            `<span><strong>${escapeHtml(extension.name)}</strong> ${escapeHtml(extension.reason)}</span>`
        )
        .join("")}
    </div>
  `;
}

function renderDetails(profile: PublicProfile | null): string {
  if (!profile) {
    return `
      <aside class="details">
        <div class="detail-title">
          <h2>详情</h2>
        </div>
        <div class="detail-list">
          <div class="detail-row">
            <span>状态</span>
            <strong>未选择</strong>
          </div>
        </div>
      </aside>
    `;
  }

  return `
    <aside class="details">
      <div class="detail-title">
        <h2>${escapeHtml(profile.name)}</h2>
        <span class="detail-status ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </div>
      <div class="detail-list">
        <div class="detail-row">
          <span>来源</span>
          <strong>${sourceDetail(profile)}</strong>
        </div>
        <div class="detail-row">
          <span>ID</span>
          <strong>${escapeHtml(profile.id)}</strong>
        </div>
        <div class="detail-row">
          <span>账号</span>
          <strong>${escapeHtml(profile.userName || "未登录")}</strong>
        </div>
        <div class="detail-row">
          <span>创建时间</span>
          <strong>${profile.createdAt ? formatDate(profile.createdAt) : "由 Chrome 管理"}</strong>
        </div>
        <div class="detail-row">
          <span>最近启动</span>
          <strong>${formatDate(profile.lastLaunchedAt)}</strong>
        </div>
        <div class="detail-row">
          <span>${processLabel(profile)}</span>
          <strong>${profile.pids.length ? profile.pids.join(", ") : "无"}</strong>
          <small class="detail-note">${processNote(profile)}</small>
        </div>
        <div class="detail-row">
          <span>关联进程监听端口</span>
          <strong>${profile.listeningPorts.length ? profile.listeningPorts.join(", ") : "无"}</strong>
          <small class="detail-note">${listeningPortsNote(profile)}</small>
        </div>
        ${profile.source === "isolated" ? renderCdpDetail(profile) : ""}
        <div class="detail-row">
          <span>目录</span>
          <code class="path-box">${escapeHtml(profile.path)}</code>
        </div>
      </div>
    </aside>
  `;
}

function renderNewModal(): string {
  const creating = isBusyAction("create-profile");

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-create-form>
        <h2>新建独立 Profile</h2>
        <div class="field">
          <label for="profile-name">名称</label>
          <input id="profile-name" name="name" type="text" maxlength="80" autocomplete="off" required />
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${creating ? "loading" : ""}" ${busy ? "disabled" : ""}>
            ${renderButtonLabel(creating, "创建", "创建中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderRenameModal(profileId: string): string {
  const profile = state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const renaming = isBusyAction("rename-profile", { profileId });

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-rename-form data-profile-id="${escapeHtml(profile.id)}">
        <h2>修改 Profile 名称</h2>
        <div class="field">
          <label for="profile-rename">名称</label>
          <input id="profile-rename" name="name" type="text" maxlength="80" autocomplete="off" required value="${escapeHtml(profile.name)}" />
          <span class="field-note">只修改本工具里的显示名称，不改变 Profile 目录。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${renaming ? "loading" : ""}" ${busy ? "disabled" : ""}>
            ${renderButtonLabel(renaming, "保存", "保存中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderCdpModal(profileId: string): string {
  const profile = state?.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return "";
  }
  const launching = isBusyAction("launch-cdp", { profileId });

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" data-cdp-form data-profile-id="${escapeHtml(profile.id)}">
        <span class="modal-kicker">Chrome DevTools Protocol</span>
        <h2>启动 ${escapeHtml(profile.name)} 的 CDP</h2>
        <p class="modal-copy">留空会从 9222 开始自动选择可用端口；填写端口则按你指定的端口启动。</p>
        <div class="field">
          <label for="cdp-port">监听端口</label>
          <input id="cdp-port" name="port" type="number" min="1024" max="65535" inputmode="numeric" placeholder="自动选择（默认从 9222 起）" />
          <span class="field-note">启动后会监听在 127.0.0.1，仅供本机 CDP / Agent Browser 工具连接。</span>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="solid ${launching ? "loading" : ""}" ${busy ? "disabled" : ""}>
            ${renderButtonLabel(launching, "启动 CDP", "启动中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderExtensionMigrationModal(profiles: PublicProfile[]): string {
  const sourceId = migrationSourceId || profiles[0]?.id || "";
  const activeScan = extensionScan?.profileId === sourceId ? extensionScan : null;
  const sourceProfile = profiles.find((profile) => profile.id === sourceId) || null;
  const targetId =
    migrationTargetId && migrationTargetId !== sourceId
      ? migrationTargetId
      : profiles.find((profile) => profile.id !== sourceId)?.id || "";
  const targetProfile = profiles.find((profile) => profile.id === targetId) || null;
  const selectedExtensions = activeScan?.extensions.filter((extension) => selectedExtensionIds.has(extension.id)) || [];
  const plannedExtensions = plannedExtensionMigrationExtensions(selectedExtensions);
  const plannedCount = plannedExtensions?.length ?? 0;
  const hasUsableDiff = !extensionSyncOnlyChanged || Boolean(plannedExtensions);
  const submitDisabled = busy || !targetId || !hasUsableDiff || (extensionSyncOnlyChanged && plannedCount === 0);
  const migrating = isBusyAction("migrate-extensions");

  if (!sourceProfile || !activeScan || !selectedExtensions.length) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal migration-modal" data-extension-migration-form>
        <span class="modal-kicker">插件同步</span>
        <h2>选择目标 Profile</h2>
        <p class="modal-copy">
          ${
            extensionSyncOnlyChanged
              ? `从 ${escapeHtml(sourceProfile.name)} 同步 ${plannedExtensions ? plannedCount : "正在检查"} 个变更插件。已选 ${selectedExtensions.length} 个，已一致插件会跳过。`
              : `从 ${escapeHtml(sourceProfile.name)} 同步 ${selectedExtensions.length} 个已选插件。目标 Profile 的同名插件信息会被覆盖。`
          }
        </p>
        <div class="migration-modal-summary">
          <div>
            <span>源 Profile</span>
            <strong>${escapeHtml(sourceProfile.name)}</strong>
          </div>
          <div>
            <span>已选插件</span>
            <strong>${selectedExtensions.length}</strong>
          </div>
          <div>
            <span>${extensionSyncOnlyChanged ? "待同步" : "含本地数据"}</span>
            <strong>${extensionSyncOnlyChanged ? (plannedExtensions ? plannedCount : "检查中") : selectedExtensions.filter((extension) => extension.hasLocalData).length}</strong>
          </div>
        </div>
        <div class="field">
          <span class="picker-label" id="migration-target-label">目标 Profile</span>
          ${renderMigrationTargetPicker(profiles, targetId, sourceId)}
          ${
            targetProfile?.running
              ? `<p class="modal-note warn">目标 ${escapeHtml(targetProfile.name)} 正在运行。开始同步后会先关闭目标 Profile，写入完成后再继续。</p>`
              : ""
          }
        </div>
        <div class="migration-modal-options">
          <label class="check-control">
            <input type="checkbox" name="onlyChanged" data-extension-only-changed ${extensionSyncOnlyChanged ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span>仅同步变更插件</span>
          </label>
          <label class="check-control">
            <input type="checkbox" name="includeData" data-include-extension-data ${includeExtensionData ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span>同时同步插件数据</span>
          </label>
          <label class="check-control">
            <input type="checkbox" name="openInstallPages" data-open-install-pages ${openInstallPages ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span>无法静默时打开安装页</span>
          </label>
        </div>
        ${renderExtensionMigrationDiffPreview()}
        ${
          extensionSyncOnlyChanged && plannedExtensions && plannedCount === 0
            ? `<p class="modal-note">当前没有需要同步的变更插件。需要强制覆盖时，可以取消勾选“仅同步变更插件”。</p>`
            : ""
        }
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${migrating ? "loading" : ""}" ${submitDisabled ? "disabled" : ""}>
            ${renderButtonLabel(migrating, "开始同步", "同步中…")}
          </button>
        </div>
      </form>
    </div>
  `;
}

function plannedExtensionMigrationExtensions(selectedExtensions: ProfileExtensionInfo[]): ProfileExtensionInfo[] | null {
  if (!extensionSyncOnlyChanged) {
    return selectedExtensions;
  }
  if (!extensionMigrationDiff) {
    return null;
  }

  const actionIds = new Set(
    extensionMigrationDiff.items
      .filter(isExtensionMigrationActionItem)
      .map((item) => item.id)
  );
  return selectedExtensions.filter((extension) => actionIds.has(extension.id));
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

function renderExtensionMigrationDiffPreview(): string {
  if (extensionMigrationDiffLoading) {
    return `
      <div class="diff-preview modal-diff-preview" aria-live="polite">
        <div class="diff-preview-head">
          <strong>插件差异预览</strong>
          <span><span class="inline-spinner" aria-hidden="true"></span> 正在检查插件差异…</span>
        </div>
      </div>
    `;
  }

  if (!extensionMigrationDiff) {
    return `
      <div class="diff-preview modal-diff-preview">
        <div class="diff-preview-head">
          <strong>插件差异预览</strong>
          <span>选择目标或同步选项后会检查本次差异。</span>
        </div>
      </div>
    `;
  }

  const changedItems = extensionMigrationDiff.items.filter(isExtensionMigrationActionItem);
  const visibleItems = (changedItems.length ? changedItems : extensionMigrationDiff.items).slice(0, 5);
  const syncableCount = changedItems.length;
  const modeText = extensionSyncOnlyChanged ? "已一致插件会跳过" : "已关闭，仅用于预览；同步时会重新覆盖可同步插件";

  return `
    <div class="diff-preview modal-diff-preview">
      <div class="diff-preview-head">
        <strong>插件差异预览</strong>
        <span>${escapeHtml(modeText)}</span>
      </div>
      <div class="diff-summary-grid extension-diff-summary">
        <div>
          <span>待处理</span>
          <strong>${syncableCount}</strong>
        </div>
        <div>
          <span>目标缺少</span>
          <strong>${extensionMigrationDiff.summary.missingCount}</strong>
        </div>
        <div>
          <span>有变化</span>
          <strong>${extensionMigrationDiff.summary.changedCount}</strong>
        </div>
        <div>
          <span>运行时加载</span>
          <strong>${extensionMigrationDiff.summary.cdpLoadCount}</strong>
        </div>
        <div>
          <span>需手动</span>
          <strong>${extensionMigrationDiff.summary.manualLoadCount}</strong>
        </div>
        <div>
          <span>安装页</span>
          <strong>${extensionMigrationDiff.summary.needsInstallPageCount}</strong>
        </div>
        <div>
          <span>已一致</span>
          <strong>${extensionMigrationDiff.summary.sameCount}</strong>
        </div>
      </div>
      ${
        visibleItems.length
          ? `<div class="diff-item-list">
              ${visibleItems.map((item) => renderDiffItem(item.name, item.reason, item.status)).join("")}
              ${changedItems.length > visibleItems.length ? `<span>还有 ${changedItems.length - visibleItems.length} 个插件会处理。</span>` : ""}
              ${extensionMigrationDiff.summary.unsupportedCount ? `<span>${extensionMigrationDiff.summary.unsupportedCount} 个插件没有可自动同步的插件目录。</span>` : ""}
            </div>`
          : ""
      }
    </div>
  `;
}

function renderCdpDetail(profile: PublicProfile): string {
  if (profile.cdpUrl) {
    return `
      <div class="detail-row">
        <span>CDP 地址</span>
        <code class="path-box compact">${escapeHtml(profile.cdpUrl)}</code>
        <small class="detail-note">AI/browser agent 工具可以通过这个本机地址连接该 Profile。</small>
      </div>
    `;
  }

  return `
    <div class="detail-row">
      <span>CDP 地址</span>
      <strong>未开启</strong>
      <small class="detail-note">点击“CDP启动”后会显示本机连接地址。</small>
    </div>
  `;
}

type ConfirmModalTone = "primary" | "warn" | "danger";

interface ConfirmModalView {
  kicker: string;
  title: string;
  body: string[];
  confirmLabel: string;
  tone: ConfirmModalTone;
  summary: Array<{ label: string; value: string }>;
}

function renderConfirmModal(confirm: Extract<ModalState, { kind: "confirm" }>): string {
  const view = confirmModalView(confirm.intent);
  if (!view) {
    return "";
  }

  const confirmClass = `${view.tone === "primary" ? "solid" : `${view.tone} solid`}`;

  return `
    <div class="modal-backdrop app-modal-backdrop" data-action="close-modal">
      <section class="modal confirm-modal confirm-dialog ${view.tone}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-dialog-head">
          <span class="confirm-dialog-icon" aria-hidden="true"></span>
          <div>
            <span class="modal-kicker">${escapeHtml(view.kicker)}</span>
            <h2 id="confirm-title">${escapeHtml(view.title)}</h2>
          </div>
        </div>
        <div class="modal-copy confirm-copy">
          ${view.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
        </div>
        <div class="confirm-summary">
          ${view.summary
            .map(
              (item) => `
                <div>
                  <span>${escapeHtml(item.label)}</span>
                  <strong>${escapeHtml(item.value)}</strong>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" data-action="close-modal">取消</button>
          <button type="button" class="${confirmClass}" data-action="confirm-modal-action">
            ${escapeHtml(view.confirmLabel)}
          </button>
        </div>
      </section>
    </div>
  `;
}

function confirmModalView(intent: ConfirmIntent): ConfirmModalView | null {
  if (!state) {
    return null;
  }

  if (intent.kind === "profile") {
    const profile = state.profiles.find((item) => item.id === intent.profileId);
    if (!profile) {
      return null;
    }
    const copy = intent.action === "close" ? closeConfirmCopy(profile) : deleteConfirmCopy(profile);
    return {
      kicker: intent.action === "close" ? "关闭 Profile" : "删除 Profile",
      title: copy.title,
      body: [copy.body],
      confirmLabel: copy.confirmLabel,
      tone: intent.action === "delete" ? "danger" : "warn",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "来源", value: sourceDetail(profile) },
        { label: "状态", value: profileStatusLabel(profile) }
      ]
    };
  }

  if (intent.kind === "account-sync") {
    const sourceProfile = state.profiles.find((profile) => profile.id === intent.sourceProfileId);
    const targetProfile = state.profiles.find((profile) => profile.id === intent.targetProfileId);
    if (!sourceProfile || !targetProfile) {
      return null;
    }

    const overwriteLine = intent.existingRecordSyncedAt
      ? `上次已在 ${formatDate(intent.existingRecordSyncedAt)} 从 ${sourceProfile.name} 同步到 ${targetProfile.name}。继续会覆盖刷新目标登录态，不会重复叠加。`
      : `${targetProfile.name} 当前登录态会被 ${sourceProfile.name} 的登录态替换。`;
    const closeLine = intent.shouldCloseTarget
      ? `目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标，写入完成后再按设置处理启动。`
      : "同步开始后会写入目标 Profile 的账号数据。";
    const modeLine = "本次会用源 Profile 重新覆盖目标中可同步的账号数据。";

    return {
      kicker: "账号同步确认",
      title: `同步 ${sourceProfile.name} 到 ${targetProfile.name}`,
      body: [closeLine, overwriteLine, modeLine],
      confirmLabel: "同步",
      tone: "warn",
      summary: [
        { label: "源 Profile", value: sourceProfile.name },
        { label: "目标 Profile", value: targetProfile.name },
        { label: "完成后", value: intent.launchTarget ? "启动目标" : "不启动目标" }
      ]
    };
  }

  if (intent.kind === "delete-extension") {
    const profile = state.profiles.find((item) => item.id === intent.profileId);
    const extension = extensionScan?.extensions.find((item) => item.id === intent.extensionId);
    if (!profile || !extension) {
      return null;
    }

    return {
      kicker: "删除插件",
      title: `删除 ${extension.name}`,
      body: [`将从 ${profile.name} 移除这个插件文件和相关配置。此操作只影响这个 Profile。`],
      confirmLabel: "确认删除插件",
      tone: "danger",
      summary: [
        { label: "Profile", value: profile.name },
        { label: "插件", value: extension.name },
        { label: "版本", value: extension.version || "未知" }
      ]
    };
  }

  const sourceProfile = state.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const targetProfile = state.profiles.find((profile) => profile.id === intent.targetProfileId);
  const activeScan = extensionScan?.profileId === intent.sourceProfileId ? extensionScan : null;
  if (!sourceProfile || !targetProfile || !activeScan) {
    return null;
  }

  const selectedExtensions = activeScan.extensions.filter((extension) => intent.extensionIds.includes(extension.id));
  const selectedWithData = selectedExtensions.filter((extension) => extension.hasLocalData).length;
  const plannedDiffItems = extensionMigrationDiff?.items.filter((item) => intent.extensionIds.includes(item.id)) || [];
  const cdpLoadCount = plannedDiffItems.length
    ? plannedDiffItems.filter((item) => item.willLoadViaCdp).length
    : selectedExtensions.filter((extension) => extension.installType === "local" && extension.path && targetProfile.source === "isolated").length;
  const manualLoadCount = plannedDiffItems.length
    ? plannedDiffItems.filter((item) => item.status === "manual_load_required").length
    : selectedExtensions.filter((extension) => extension.installType === "local" && targetProfile.source !== "isolated").length;
  const plannedCount = intent.extensionIds.length;
  const closeLine = intent.shouldCloseTarget
    ? `目标 ${targetProfile.name} 正在运行。开始同步前会先帮你关闭目标，写入完成后再继续。`
    : "同步开始后会写入目标 Profile 的插件配置。";
  const dataLine = extensionMigrationConfirmDataLine(cdpLoadCount, manualLoadCount, intent.includeData);
  const modeLine = intent.onlyChanged
    ? `本次只同步 ${plannedCount} 个变更插件，${Math.max(intent.selectedCount - plannedCount, 0)} 个已一致插件会跳过。`
    : "会重新覆盖所有可同步的已选插件。";

  return {
    kicker: "插件同步确认",
    title: `同步 ${plannedCount} 个插件到 ${targetProfile.name}`,
    body: [closeLine, dataLine, modeLine],
    confirmLabel: "同步",
    tone: "warn",
    summary: [
      { label: "源 Profile", value: sourceProfile.name },
      { label: "目标 Profile", value: targetProfile.name },
      { label: "待同步", value: String(plannedCount) },
      { label: "已选插件", value: String(intent.selectedCount) },
      { label: "运行时加载", value: String(cdpLoadCount) },
      { label: "含数据", value: String(selectedWithData) }
    ]
  };
}

function extensionMigrationConfirmDataLine(
  cdpLoadCount: number,
  manualLoadCount: number,
  includeData: boolean
): string {
  const dataText = includeData ? "插件配置和插件数据会被源 Profile 覆盖。" : "插件配置会被源 Profile 覆盖，插件数据不会同步。";
  if (cdpLoadCount && manualLoadCount) {
    return `${dataText} ${cdpLoadCount} 个本地插件会登记为目标启动时自动加载，${manualLoadCount} 个仍需要手动加载源目录。`;
  }
  if (cdpLoadCount) {
    return `${dataText} ${cdpLoadCount} 个本地插件会登记为目标启动时自动加载。`;
  }
  if (manualLoadCount) {
    return `${dataText} ${manualLoadCount} 个本地未打包插件无法自动加载；会打开目标扩展程序页，请手动加载源插件目录。`;
  }

  return dataText;
}

function closeModalFromUi(): void {
  if (modal?.kind === "confirm" && modal.returnTo === "extension-migration") {
    modal = { kind: "extension-migration" };
  } else {
    modal = null;
  }
  migrationTargetMenuOpen = false;
  render();
}

function executeConfirmIntent(intent: ConfirmIntent): void {
  if (intent.kind === "profile") {
    executeProfileConfirm(intent);
    return;
  }

  if (intent.kind === "account-sync") {
    executeAccountSyncConfirm(intent);
    return;
  }

  if (intent.kind === "delete-extension") {
    executeDeleteExtensionConfirm(intent);
    return;
  }

  executeExtensionMigrationConfirm(intent);
}

function executeProfileConfirm(intent: Extract<ConfirmIntent, { kind: "profile" }>): void {
  const profile = state?.profiles.find((item) => item.id === intent.profileId);
  modal = null;

  if (!profile) {
    render();
    return;
  }

  if (intent.action === "close") {
    void withBusy(() => profileApi().closeProfile(profile.id), `已请求关闭 ${profile.name}`, {
      key: "close-profile",
      message: `正在关闭 ${profile.name}…`,
      profileId: profile.id
    });
    return;
  }

  void withBusy(() => profileApi().deleteProfile(profile.id), `已删除 ${profile.name}`, {
    key: "delete-profile",
    message: `正在删除 ${profile.name}…`,
    profileId: profile.id
  });
}

function executeAccountSyncConfirm(intent: Extract<ConfirmIntent, { kind: "account-sync" }>): void {
  const sourceProfile = state?.profiles.find((profile) => profile.id === intent.sourceProfileId);
  const targetProfile = state?.profiles.find((profile) => profile.id === intent.targetProfileId);
  modal = null;

  if (!sourceProfile || !targetProfile) {
    render();
    setToast("请选择两个不同的 Profile", "error");
    return;
  }

  const progressSteps = accountSyncProgressStepsForTarget(targetProfile);
  void withBusy(async () => {
    if (intent.shouldCloseTarget) {
      await profileApi().closeProfile(intent.targetProfileId);
      const nextSteps = activateBusyStep(busyState?.steps || [], "检查 Profile");
      updateBusyState({
        message: `已关闭 ${targetProfile.name}，正在开始同步…`,
        stepIndex: nextSteps.findIndex((step) => step.label === "检查 Profile") + 1,
        stepCount: nextSteps.length,
        steps: nextSteps
      });
    }

    const result = await profileApi().syncAccount({
      sourceProfileId: intent.sourceProfileId,
      targetProfileId: intent.targetProfileId,
      launchTarget: intent.launchTarget,
      onlyChanged: false
    });
    accountSyncResult = result;
    state = result.state;
    selectedId = result.targetProfileId;
  }, intent.launchTarget
    ? intent.existingRecordSyncedAt
      ? "账号重新同步完成，已启动目标 Profile"
      : "账号同步完成，已启动目标 Profile"
    : intent.existingRecordSyncedAt
      ? "账号重新同步完成"
      : "账号同步完成", {
    key: "account-sync",
    message: intent.shouldCloseTarget ? `正在关闭 ${targetProfile.name} 后同步账号…` : "正在同步账号…",
    profileId: intent.targetProfileId,
    stepIndex: 1,
    stepCount: progressSteps.length,
    steps: pendingBusySteps(progressSteps)
  });
}

function executeDeleteExtensionConfirm(intent: Extract<ConfirmIntent, { kind: "delete-extension" }>): void {
  const profile = state?.profiles.find((item) => item.id === intent.profileId);
  const extension = extensionScan?.extensions.find((item) => item.id === intent.extensionId);
  modal = null;

  if (!profile || !extension) {
    render();
    setToast("没有找到要删除的插件", "error");
    return;
  }

  void withBusy(async () => {
    const result = await profileApi().deleteProfileExtension(intent.profileId, intent.extensionId);
    extensionScan = result.scan;
    selectedExtensionIds.delete(intent.extensionId);
    extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    state = result.state;
    selectedId = result.profileId;
  }, `已删除插件 ${extension.name}`, {
    key: "delete-extension",
    message: `正在删除插件 ${extension.name}…`,
    profileId: intent.profileId,
    extensionId: intent.extensionId
  });
}

function executeExtensionMigrationConfirm(intent: Extract<ConfirmIntent, { kind: "extension-migration" }>): void {
  const targetProfile = state?.profiles.find((profile) => profile.id === intent.targetProfileId);
  modal = null;

  if (!targetProfile) {
    render();
    setToast("没有找到目标 Profile", "error");
    return;
  }

  migrationTargetId = intent.targetProfileId;
  const progressSteps = extensionSyncProgressStepsForTarget(targetProfile);

  void withBusy(async () => {
    if (intent.shouldCloseTarget) {
      state = await profileApi().closeProfile(intent.targetProfileId);
      const nextSteps = activateBusyStep(busyState?.steps || [], "检查 Profile");
      updateBusyState({
        message: `已关闭 ${targetProfile.name}，正在开始同步插件…`,
        stepIndex: nextSteps.findIndex((step) => step.label === "检查 Profile") + 1,
        stepCount: nextSteps.length,
        steps: nextSteps
      });
    }

    const result = await profileApi().migrateExtensions({
      sourceProfileId: intent.sourceProfileId,
      targetProfileId: intent.targetProfileId,
      extensionIds: intent.extensionIds,
      includeData: intent.includeData,
      openInstallPages: intent.openInstallPages,
      onlyChanged: intent.onlyChanged
    });
    extensionMigrationResult = result;
    invalidateExtensionMigrationDiff();
    state = result.state;
    selectedId = result.targetProfileId;

    if (intent.shouldCloseTarget && !result.openedInstallPages) {
      updateBusyState({
        message: `插件已写入，正在重新启动 ${targetProfile.name}…`
      });
      state = targetProfile.cdpPort
        ? await profileApi().launchProfileWithCdp(intent.targetProfileId, targetProfile.cdpPort)
        : await profileApi().launchProfile(intent.targetProfileId);
      selectedId = result.targetProfileId;
    }
  }, "插件同步完成", {
    key: "migrate-extensions",
    message: intent.shouldCloseTarget ? `正在关闭 ${targetProfile.name} 后同步插件…` : "正在同步插件…",
    profileId: intent.targetProfileId,
    stepIndex: 1,
    stepCount: progressSteps.length,
    steps: pendingBusySteps(progressSteps)
  });
}

function profileStatusLabel(profile: PublicProfile): string {
  return profile.running ? "运行中" : "未运行";
}

function sourceLabel(profile: PublicProfile): string {
  return profile.source === "native" ? "系统" : "独立";
}

function sourceDetail(profile: PublicProfile): string {
  return profile.source === "native" ? "系统 Profile（由 Google Chrome 管理）" : "工具独立 Profile（由本工具创建）";
}

function extensionInstallTypeLabel(extension: ProfileExtensionInfo): string {
  if (extension.fromWebStore) {
    return "商店";
  }

  if (extension.installType === "local") {
    return "本地";
  }

  if (extension.installType === "profile") {
    return "Profile";
  }

  if (extension.installType === "component") {
    return "组件";
  }

  return "未知";
}

function extensionMigrationCapabilityLabel(extension: ProfileExtensionInfo): string {
  if (extension.installType === "local") {
    return "本地目录";
  }

  if (extension.fromWebStore && extension.canCopyLocally) {
    return "可静默复制";
  }

  if (extension.canCopyLocally) {
    return "可复制挂载";
  }

  if (extension.fromWebStore) {
    return "可打开安装页";
  }

  return "不可自动同步";
}

function renderDiffItem(label: string, reason: string, status: string): string {
  return `
    <span class="diff-item ${diffStatusClass(status)}">
      <strong>${escapeHtml(label)}</strong>
      <em>${escapeHtml(reason)}</em>
    </span>
  `;
}

function diffStatusClass(status: string): string {
  if (status === "same") {
    return "same";
  }
  if (status === "source_missing" || status === "unsupported") {
    return "muted";
  }
  if (status === "needs_install_page" || status === "manual_load_required") {
    return "warn";
  }

  return "changed";
}

function processLabel(profile: PublicProfile): string {
  return profile.source === "native" ? "主进程 PID" : "关联进程 PID";
}

function processNote(profile: PublicProfile): string {
  if (profile.source === "native") {
    return "系统 Profile 仅展示可安全确认的 Chrome 主进程；Chrome Helper 子进程可能由多个系统 Profile 共享。";
  }

  return "这些是带有同一独立目录标记的 Chrome 主进程和 Helper 进程，不是端口号。";
}

function listeningPortsNote(profile: PublicProfile): string {
  if (!profile.running) {
    return "Profile 未运行时不会占用本机 TCP 监听端口。";
  }

  if (!profile.listeningPorts.length) {
    return "未发现该 Profile 关联进程正在监听本机 TCP 端口。";
  }

  if (profile.cdpPort && profile.listeningPorts.includes(profile.cdpPort)) {
    return `其中 ${profile.cdpPort} 是 ProfilePilot 以 CDP 模式启动并验证过的调试端口。`;
  }

  if (profile.source === "native") {
    return "这些只是系统 Chrome 主进程占用的本机 TCP 端口；它们不是 ProfilePilot 已验证的 CDP 地址。";
  }

  return "这些端口由该独立 Profile 的 Chrome 进程占用；只有通过 CDP 启动并显示 CDP 地址的端口才可用于调试连接。";
}

function launchButtonTitle(profile: PublicProfile): string {
  return profile.running ? "这个 Profile 已经在运行中" : "启动这个 Profile";
}

function cdpLaunchButtonTitle(profile: PublicProfile): string {
  if (profile.source !== "isolated") {
    return "CDP 启动仅支持工具独立 Profile；系统 Profile 请先新建独立 Profile";
  }
  if (profile.running) {
    return profile.cdpUrl
      ? `CDP 已开启：${profile.cdpUrl}`
      : "需要先关闭这个 Profile，再用 CDP 模式重新启动；CDP 端口只能在启动 Chrome 时指定";
  }

  return "启动这个 Profile，并开启本机 CDP 监听端口";
}

function focusButtonTitle(profile: PublicProfile): string {
  return profile.running ? "把这个 Profile 的 Chrome 窗口显示到最前面" : "这个 Profile 当前未运行";
}

function closeButtonTitle(profile: PublicProfile): string {
  return profile.running ? "关闭这个 Profile 的 Chrome 实例" : "这个 Profile 当前未运行";
}

function deleteButtonTitle(profile: PublicProfile): string {
  if (profile.running) {
    return "先关闭这个 Profile 的 Chrome 窗口，再刷新后删除";
  }
  if (profile.isDefault) {
    return "Default 本机 Chrome Profile 受保护，不能删除";
  }
  if (!profile.deletable) {
    return "这个 Profile 不能删除";
  }

  return "删除这个 Profile";
}

function closeConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  if (profile.source === "native" && profile.isDefault) {
    return {
      title: `关闭 ${profile.name}`,
      body: "这会退出当前本机 Google Chrome 实例。未保存的网页内容可能会丢失。",
      confirmLabel: "确认关闭"
    };
  }

  return {
    title: `关闭 ${profile.name}`,
    body: "这会结束这个 Profile 对应的 Chrome 实例。未保存的网页内容可能会丢失。",
    confirmLabel: "确认关闭"
  };
}

function deleteConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  return {
    title: `删除 ${profile.name}`,
    body: "这个 Profile 的目录会先移到废纸篓。删除前请确认它没有正在运行的 Chrome 窗口。",
    confirmLabel: "确认删除"
  };
}

function formatDate(value: string | null): string {
  if (!value) {
    return "从未";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }

  return dateFormatter.format(date);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

appRoot.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const hadOpenProfileMenu = Boolean(openProfileMenuId);
  const hadMigrationSourceMenu = migrationSourceMenuOpen;
  const hadAccountSyncMenu = Boolean(accountSyncMenuOpen);
  if (openProfileMenuId && !target?.closest("[data-profile-actions]")) {
    openProfileMenuId = null;
  }
  if (migrationSourceMenuOpen && !target?.closest("[data-migration-source-select]")) {
    migrationSourceMenuOpen = false;
  }
  const hadMigrationTargetMenu = migrationTargetMenuOpen;
  if (migrationTargetMenuOpen && !target?.closest("[data-migration-target-select]")) {
    migrationTargetMenuOpen = false;
  }
  if (accountSyncMenuOpen && !target?.closest(`[data-account-sync-select="${accountSyncMenuOpen}"]`)) {
    accountSyncMenuOpen = null;
  }

  const actionTarget = target?.closest<HTMLElement>("[data-action]");
  if (!actionTarget || !state) {
    if (
      (hadOpenProfileMenu && !openProfileMenuId) ||
      (hadMigrationSourceMenu && !migrationSourceMenuOpen) ||
      (hadMigrationTargetMenu && !migrationTargetMenuOpen) ||
      (hadAccountSyncMenu && !accountSyncMenuOpen)
    ) {
      render();
    }
    return;
  }

  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id || null;
  if (action !== "toggle-profile-menu" && actionTarget.closest("[data-profile-actions]")) {
    openProfileMenuId = null;
  }

  if (action === "toggle-migration-source-menu") {
    migrationSourceMenuOpen = !migrationSourceMenuOpen;
    accountSyncMenuOpen = null;
    openProfileMenuId = null;
    render();
    return;
  }

  if (action === "select-migration-source" && id) {
    setMigrationSource(id);
    migrationSourceMenuOpen = false;
    render();
    return;
  }

  if (action === "toggle-migration-target-menu") {
    migrationTargetMenuOpen = !migrationTargetMenuOpen;
    render();
    return;
  }

  if (action === "select-migration-target" && id) {
    migrationTargetId = id;
    migrationTargetMenuOpen = false;
    extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
    return;
  }

  if (action === "toggle-account-sync-menu") {
    const kind = actionTarget.dataset.kind === "target" ? "target" : "source";
    accountSyncMenuOpen = accountSyncMenuOpen === kind ? null : kind;
    migrationSourceMenuOpen = false;
    openProfileMenuId = null;
    render();
    return;
  }

  if (action === "select-account-sync-profile" && id) {
    if (actionTarget.dataset.kind === "target") {
      accountSyncTargetId = id;
    } else {
      accountSyncSourceId = id;
      if (accountSyncTargetId === accountSyncSourceId) {
        accountSyncTargetId = state.profiles.find((profile) => profile.id !== accountSyncSourceId)?.id || null;
      }
    }
    accountSyncResult = null;
    accountSyncMenuOpen = null;
    render();
    return;
  }

  if (action === "new-profile") {
    modal = { kind: "new" };
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#profile-name")?.focus(), 0);
    return;
  }

  if (action === "close-modal") {
    if (event.target === actionTarget || actionTarget.tagName === "BUTTON") {
      closeModalFromUi();
    }
    return;
  }

  if (action === "confirm-modal-action" && modal?.kind === "confirm") {
    executeConfirmIntent(modal.intent);
    return;
  }

  if (action === "toggle-account-sync-scope") {
    accountSyncScopeExpanded = !accountSyncScopeExpanded;
    render();
    return;
  }

  if (action === "toggle-extension-scan-preview") {
    extensionScanPreviewCollapsed = !extensionScanPreviewCollapsed;
    render();
    return;
  }

  if (action === "sync-account") {
    const sourceId = accountSyncSourceId;
    const targetId = accountSyncTargetId;
    const sourceProfile = state.profiles.find((profile) => profile.id === sourceId);
    const targetProfile = state.profiles.find((profile) => profile.id === targetId);
    if (!sourceId || !targetId || !sourceProfile || !targetProfile || sourceId === targetId) {
      setToast("请选择两个不同的 Profile", "error");
      return;
    }
    const shouldCloseTarget = targetProfile.running;
    const existingRecord =
      state.accountSyncRecords.find((record) => record.sourceProfileId === sourceId && record.targetProfileId === targetId) ||
      null;
    modal = {
      kind: "confirm",
      intent: {
        kind: "account-sync",
        sourceProfileId: sourceId,
        targetProfileId: targetId,
        shouldCloseTarget,
        existingRecordSyncedAt: existingRecord?.syncedAt || null,
        launchTarget: launchSyncedProfile
      }
    };
    render();
    return;
  }

  if (action === "cancel-account-sync") {
    const activeBusyState = busyState;
    if (!activeBusyState || activeBusyState.key !== "account-sync") {
      return;
    }

    updateBusyState({
      cancelRequested: true,
      message: "正在终止同步…未完成的临时数据会在下次同步前恢复或清理。"
    });

    void profileApi()
      .cancelOperation({ key: "account-sync", profileId: activeBusyState.profileId })
      .then((cancelled) => {
        if (!cancelled) {
          setToast("同步已经结束，未找到可终止的任务。", "error");
        }
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "toggle-account-sync-pause") {
    const activeBusyState = busyState;
    if (!activeBusyState || activeBusyState.key !== "account-sync" || activeBusyState.cancelRequested) {
      return;
    }

    const nextPaused = !activeBusyState.paused;
    updateBusyState({
      paused: nextPaused,
      message: nextPaused ? "正在暂停同步…当前文件复制完成后会停住。" : "正在继续同步…"
    });

    void profileApi()
      .controlOperation({
        key: "account-sync",
        profileId: activeBusyState.profileId,
        action: nextPaused ? "pause" : "resume"
      })
      .then((controlled) => {
        if (!controlled) {
          updateBusyState({
            paused: !nextPaused,
            message: "同步已经结束，未找到可控制的任务。"
          });
          setToast("同步已经结束，未找到可控制的任务。", "error");
        }
      })
      .catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
    return;
  }

  if (action === "scan-extensions") {
    const sourceId = migrationSourceId;
    if (!sourceId) {
      setToast("先选择源 Profile", "error");
      return;
    }

    void withBusy(async () => {
      const scan = await profileApi().scanProfileExtensions(sourceId);
      extensionScan = scan;
      selectedExtensionIds = new Set(scan.extensions.map((extension) => extension.id));
      extensionScanPreviewCollapsed = false;
      extensionMigrationResult = null;
      invalidateExtensionMigrationDiff();
    }, "已扫描插件", {
      key: "scan-extensions",
      message: "正在扫描源 Profile 插件…"
    });
    return;
  }

  if (action === "select-all-extensions") {
    const activeScan = extensionScan?.profileId === migrationSourceId ? extensionScan : null;
    if (!activeScan) {
      return;
    }

    const allSelected = activeScan.extensions.every((extension) => selectedExtensionIds.has(extension.id));
    selectedExtensionIds = allSelected ? new Set() : new Set(activeScan.extensions.map((extension) => extension.id));
    invalidateExtensionMigrationDiff();
    render();
    if (modal?.kind === "extension-migration") {
      void refreshExtensionMigrationDiff();
    }
    return;
  }

  if (action === "migrate-extensions") {
    const activeScan = extensionScan?.profileId === migrationSourceId ? extensionScan : null;
    if (!migrationSourceId || !activeScan) {
      setToast("先扫描源 Profile 的插件", "error");
      return;
    }

    const selectedCount = activeScan.extensions.filter((extension) => selectedExtensionIds.has(extension.id)).length;
    if (!selectedCount) {
      setToast("先选择要同步的插件", "error");
      return;
    }

    const targetId =
      migrationTargetId && migrationTargetId !== migrationSourceId
        ? migrationTargetId
        : state.profiles.find((profile) => profile.id !== migrationSourceId)?.id || null;
    if (!targetId) {
      setToast("没有可用的目标 Profile", "error");
      return;
    }

    migrationTargetId = targetId;
    migrationTargetMenuOpen = false;
    modal = { kind: "extension-migration" };
    render();
    void refreshExtensionMigrationDiff();
    window.setTimeout(
      () => document.querySelector<HTMLButtonElement>("[data-migration-target-select] .profile-select-trigger")?.focus(),
      0
    );
    return;
  }

  if (action === "delete-extension") {
    const profileId = extensionScan?.profileId || migrationSourceId;
    const extensionId = actionTarget.dataset.extensionId;
    const extension = extensionScan?.extensions.find((item) => item.id === extensionId);
    if (!profileId || !extensionId || !extension) {
      setToast("请先扫描并选择要删除的插件", "error");
      return;
    }

    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) {
      setToast("没有找到这个 Profile", "error");
      return;
    }
    if (profile.running) {
      setToast("删除插件前请先关闭这个 Profile，然后刷新列表。", "error");
      return;
    }
    modal = {
      kind: "confirm",
      intent: {
        kind: "delete-extension",
        profileId,
        extensionId
      }
    };
    render();
    return;
  }

  if (action === "open-target-extensions-page") {
    const profileId = actionTarget.dataset.profileId;
    if (!profileId) {
      setToast("没有找到目标 Profile", "error");
      return;
    }

    void withBusy(async () => {
      state = await profileApi().openProfileExtensionsPage(profileId);
      selectedId = profileId;
    }, "已打开目标扩展页", {
      key: "open-extensions-page",
      message: "正在打开目标 Profile 的扩展程序页面…",
      profileId
    });
    return;
  }

  if (action === "open-manual-extension-folder") {
    const targetPath = actionTarget.dataset.path;
    if (!targetPath) {
      setToast("没有找到插件目录", "error");
      return;
    }

    void withBusy(() => profileApi().openPath(targetPath), "已打开插件目录", {
      key: "open-extension-folder",
      message: "正在打开插件目录…"
    });
    return;
  }

  if (action === "copy-manual-extension-path") {
    const targetPath = actionTarget.dataset.path;
    if (!targetPath) {
      setToast("没有找到插件目录", "error");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setToast("当前环境不能直接复制，请手动选中路径复制", "error");
      return;
    }

    void navigator.clipboard
      .writeText(targetPath)
      .then(() => setToast("已复制插件目录路径"))
      .catch(() => setToast("复制失败，请手动选中路径复制", "error"));
    return;
  }

  if (action === "refresh") {
    void withBusy(() => loadState(), "已刷新", {
      key: "refresh",
      message: "正在刷新 Profile 状态…"
    });
    return;
  }

  if (action === "toggle-profile-menu" && id) {
    openProfileMenuId = openProfileMenuId === id ? null : id;
    selectedId = id;
    render();
    return;
  }

  if (action === "rename-profile" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }

    modal = { kind: "rename", profileId: id };
    render();
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>("#profile-rename");
      input?.focus();
      input?.select();
    }, 0);
    return;
  }

  if (action === "select" && id) {
    selectedId = id;
    render();
    return;
  }

  if (action === "launch" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (profile?.running) {
      setToast(`${profile.name} 已经在运行中`);
      return;
    }
    void withBusy(() => profileApi().launchProfile(id), `已启动 ${profile?.name || "Profile"}`, {
      key: "launch-profile",
      message: `正在启动 ${profile?.name || "Profile"}…`,
      profileId: id
    });
    return;
  }

  if (action === "launch-cdp" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (profile.source !== "isolated") {
      setToast("CDP 启动仅支持工具独立 Profile", "error");
      return;
    }
    if (profile.running) {
      setToast(profile.cdpUrl ? `${profile.name} 已开启 CDP：${profile.cdpUrl}` : `先关闭 ${profile.name}，再以 CDP 模式启动`, profile.cdpUrl ? "normal" : "error");
      return;
    }

    modal = { kind: "cdp", profileId: id };
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#cdp-port")?.focus(), 0);
    return;
  }

  if (action === "focus-profile" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${profile.name} 当前未运行`);
      return;
    }

    selectedId = id;
    void withBusy(async () => {
      state = await profileApi().focusProfile(id);
      selectedId = id;
    }, `已显示 ${profile.name}`, {
      key: "focus-profile",
      message: `正在显示 ${profile.name}…`,
      profileId: id
    });
    return;
  }

  if (action === "close-profile" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (!profile.running) {
      setToast(`${profile.name} 当前未运行`);
      return;
    }

    modal = {
      kind: "confirm",
      intent: {
        kind: "profile",
        action: "close",
        profileId: id
      }
    };
    render();
    return;
  }

  if (action === "open-folder" && id) {
    const profile = state.profiles.find((item) => item.id === id);

    void withBusy(() => profileApi().openProfileFolder(id), "已打开目录", {
      key: "open-folder",
      message: `正在打开 ${profile?.name || "Profile"} 的目录…`,
      profileId: id
    });
    return;
  }

  if (action === "delete" && id) {
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    if (profile.running) {
      setToast(`先关闭 ${profile.name} 的 Chrome 窗口，再刷新后删除`, "error");
      return;
    }
    if (!profile.deletable) {
      setToast(deleteButtonTitle(profile), "error");
      return;
    }

    modal = {
      kind: "confirm",
      intent: {
        kind: "profile",
        action: "delete",
        profileId: id
      }
    };
    render();
  }
});

function setMigrationSource(sourceId: string): void {
  migrationSourceId = sourceId || null;
  if (!state) {
    return;
  }

  if (migrationTargetId === migrationSourceId) {
    migrationTargetId = state.profiles.find((profile) => profile.id !== migrationSourceId)?.id || null;
  }

  extensionScan = null;
  selectedExtensionIds.clear();
  extensionScanPreviewCollapsed = false;
  extensionMigrationResult = null;
  invalidateExtensionMigrationDiff();
}

appRoot.addEventListener("change", (event) => {
  const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target || !state) {
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-launch-synced-profile]")) {
    launchSyncedProfile = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-extension-select]")) {
    const extensionId = target.dataset.extensionId;
    if (!extensionId) {
      return;
    }
    if (target.checked) {
      selectedExtensionIds.add(extensionId);
    } else {
      selectedExtensionIds.delete(extensionId);
    }
    extensionMigrationResult = null;
    invalidateExtensionMigrationDiff();
    render();
    if (modal?.kind === "extension-migration") {
      void refreshExtensionMigrationDiff();
    }
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-include-extension-data]")) {
    includeExtensionData = target.checked;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-extension-only-changed]")) {
    extensionSyncOnlyChanged = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-open-install-pages]")) {
    openInstallPages = target.checked;
    invalidateExtensionMigrationDiff();
    render();
    void refreshExtensionMigrationDiff();
  }
});

appRoot.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (migrationSourceMenuOpen || migrationTargetMenuOpen || accountSyncMenuOpen)) {
    migrationSourceMenuOpen = false;
    migrationTargetMenuOpen = false;
    accountSyncMenuOpen = null;
    render();
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest<HTMLElement>("[data-profile-row]");
  if (!row || !state || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }

  event.preventDefault();
  const id = row.dataset.id;
  if (id) {
    selectedId = id;
    render();
  }
});

appRoot.addEventListener("submit", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const createForm = target?.closest<HTMLFormElement>("[data-create-form]");
  const renameForm = target?.closest<HTMLFormElement>("[data-rename-form]");
  const cdpForm = target?.closest<HTMLFormElement>("[data-cdp-form]");
  const extensionMigrationForm = target?.closest<HTMLFormElement>("[data-extension-migration-form]");
  if (!createForm && !renameForm && !cdpForm && !extensionMigrationForm) {
    return;
  }

  event.preventDefault();

  if (extensionMigrationForm) {
    const sourceId = migrationSourceId;
    const activeScan = extensionScan?.profileId === sourceId ? extensionScan : null;
    const data = new FormData(extensionMigrationForm);
    const targetProfileId = String(data.get("targetProfileId") || "").trim();
    let extensionIds = activeScan?.extensions
      .filter((extension) => selectedExtensionIds.has(extension.id))
      .map((extension) => extension.id) || [];
    const originallySelectedCount = extensionIds.length;

    if (!sourceId || !activeScan) {
      setToast("先扫描源 Profile 的插件", "error");
      return;
    }
    if (!targetProfileId || targetProfileId === sourceId) {
      setToast("请选择一个不同的目标 Profile", "error");
      return;
    }
    if (!extensionIds.length) {
      setToast("先选择要同步的插件", "error");
      return;
    }

    includeExtensionData = data.has("includeData");
    openInstallPages = data.has("openInstallPages");
    extensionSyncOnlyChanged = data.has("onlyChanged");
    const sourceProfile = state?.profiles.find((profile) => profile.id === sourceId) || null;
    const targetProfile = state?.profiles.find((profile) => profile.id === targetProfileId) || null;
    if (!targetProfile) {
      setToast("没有找到目标 Profile", "error");
      return;
    }
    if (includeExtensionData && sourceProfile?.running) {
      setToast("同步插件数据前请先关闭源 Profile，或取消勾选“同时同步插件数据”。", "error");
      return;
    }

    if (extensionSyncOnlyChanged) {
      if (extensionMigrationDiffLoading || !extensionMigrationDiff) {
        setToast("插件差异还在检查，请稍后再同步。", "error");
        void refreshExtensionMigrationDiff();
        return;
      }

      const selectedActionIds = new Set(extensionMigrationDiff.items.filter(isExtensionMigrationActionItem).map((item) => item.id));
      extensionIds = extensionIds.filter((extensionId) => selectedActionIds.has(extensionId));
      if (!extensionIds.length) {
        setToast("当前没有需要同步的变更插件。", "normal");
        render();
        return;
      }
    }

    const shouldCloseTarget = targetProfile.running;
    migrationTargetId = targetProfileId;
    modal = {
      kind: "confirm",
      returnTo: "extension-migration",
      intent: {
        kind: "extension-migration",
        sourceProfileId: sourceId,
        targetProfileId,
        extensionIds,
        selectedCount: originallySelectedCount,
        includeData: includeExtensionData,
        openInstallPages,
        onlyChanged: extensionSyncOnlyChanged,
        shouldCloseTarget
      }
    };
    render();
    return;
  }

  if (cdpForm) {
    const profileId = cdpForm.dataset.profileId;
    if (!profileId) {
      return;
    }

    const profile = state?.profiles.find((item) => item.id === profileId);
    const data = new FormData(cdpForm);
    const rawPort = String(data.get("port") || "").trim();
    let port: number | null = null;
    if (rawPort) {
      const parsedPort = Number(rawPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
        setToast("CDP 端口必须是 1024-65535 之间的整数", "error");
        return;
      }
      port = parsedPort;
    }

    modal = null;
    void withBusy(() => profileApi().launchProfileWithCdp(profileId, port), `已以 CDP 启动 ${profile?.name || "Profile"}`, {
      key: "launch-cdp",
      message: `正在以 CDP 启动 ${profile?.name || "Profile"}…`,
      profileId
    });
    return;
  }

  if (renameForm) {
    const profileId = renameForm.dataset.profileId;
    const profile = state?.profiles.find((item) => item.id === profileId);
    if (!profileId || !profile) {
      return;
    }

    const data = new FormData(renameForm);
    const name = String(data.get("name") || "").trim();

    void withBusy(async () => {
      const nextState = await profileApi().renameProfile(profileId, name);
      state = nextState;
      selectedId = profileId;
      modal = null;
    }, `已改名为 ${name}`, {
      key: "rename-profile",
      message: "正在保存名称…",
      profileId
    });
    return;
  }

  const data = new FormData(createForm as HTMLFormElement);
  const name = String(data.get("name") || "").trim();

  void withBusy(async () => {
    const nextState = await profileApi().createProfile(name);
    state = nextState;
    selectedId = state.profiles[0]?.id || null;
    modal = null;
  }, `已创建 ${name}`, {
    key: "create-profile",
    message: `正在创建 ${name}…`
  });
});

loadState().catch((error: unknown) => {
  appRoot.innerHTML = `<div class="app-loading">${escapeHtml(formatErrorMessage(error))}</div>`;
});
