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
}

interface ExtensionMigrationBackupSummary {
  id: string;
  createdAt: string;
  path: string;
  targetProfileId: string;
  targetProfileName: string;
  targetProfilePath: string;
  itemCount: number;
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

interface ExtensionMigrationSkippedExtension {
  id: string;
  name: string;
  reason: string;
}

interface ExtensionMigrationResult {
  sourceProfileId: string;
  targetProfileId: string;
  selectedCount: number;
  copiedExtensions: ExtensionMigrationCopiedExtension[];
  dataCopies: ExtensionMigrationDataCopy[];
  webStoreInstallUrls: string[];
  skippedExtensions: ExtensionMigrationSkippedExtension[];
  backup: ExtensionMigrationBackupSummary;
  openedInstallPages: boolean;
  state: AppState;
}

interface ExtensionDeleteResult {
  profileId: string;
  profileName: string;
  extensionId: string;
  extensionName: string;
  deletedPaths: string[];
  backup: ExtensionMigrationBackupSummary;
  scan: ExtensionScanResult;
  state: AppState;
}

interface ExtensionMigrationRestoreResult {
  backup: ExtensionMigrationBackupSummary;
  state: AppState;
}

interface AccountSyncRequest {
  sourceProfileId: string;
  targetProfileId: string;
  launchTarget: boolean;
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

interface AccountSyncBackupSummary {
  id: string;
  createdAt: string;
  path: string;
  targetProfileId: string;
  targetProfileName: string;
  targetProfilePath: string;
  itemCount: number;
}

interface AccountSyncResult {
  sourceProfileId: string;
  targetProfileId: string;
  copiedItems: AccountSyncCopiedItem[];
  skippedItems: AccountSyncSkippedItem[];
  backup: AccountSyncBackupSummary;
  launchedTarget: boolean;
  state: AppState;
}

interface AccountSyncRestoreResult {
  backup: AccountSyncBackupSummary;
  state: AppState;
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
  deleteProfile(id: string): Promise<DeleteProfileResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  listExtensionMigrationBackups(): Promise<ExtensionMigrationBackupSummary[]>;
  restoreExtensionMigrationBackup(backupId: string): Promise<ExtensionMigrationRestoreResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
  listAccountSyncBackups(): Promise<AccountSyncBackupSummary[]>;
  restoreAccountSyncBackup(backupId: string): Promise<AccountSyncRestoreResult>;
}

interface Window {
  profileManager: ProfileManagerApi;
}

type ConfirmAction = "close" | "delete";
type BusyState = {
  key: string;
  message: string;
  profileId?: string;
  extensionId?: string;
  backupId?: string;
};
type ModalState =
  | { kind: "new" }
  | { kind: "rename"; profileId: string }
  | { kind: "cdp"; profileId: string }
  | { kind: "extension-migration" }
  | {
      kind: "confirm";
      action: ConfirmAction;
      profileId: string;
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
let extensionMigrationResult: ExtensionMigrationResult | null = null;
let extensionMigrationBackups: ExtensionMigrationBackupSummary[] = [];
let openProfileMenuId: string | null = null;
let migrationSourceMenuOpen = false;
let accountSyncSourceId: string | null = null;
let accountSyncTargetId: string | null = null;
let launchSyncedProfile = true;
let accountSyncResult: AccountSyncResult | null = null;
let accountSyncBackups: AccountSyncBackupSummary[] = [];

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

async function loadState(): Promise<void> {
  const [nextState, backups, accountBackups] = await Promise.all([
    profileApi().getState(),
    profileApi().listExtensionMigrationBackups(),
    profileApi().listAccountSyncBackups()
  ]);
  state = nextState;
  extensionMigrationBackups = backups;
  accountSyncBackups = accountBackups;
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
    migrationSourceMenuOpen = false;
    return;
  }

  if (!profiles.some((profile) => profile.id === migrationSourceId)) {
    migrationSourceId = selectedId || profiles[0].id;
    extensionScan = null;
    selectedExtensionIds.clear();
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

function renderBusyBanner(): string {
  if (!busyState) {
    return "";
  }

  return `
    <div class="busy-banner" role="status" aria-live="polite">
      <span class="sync-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(busyState.message)}</span>
    </div>
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

      ${renderBusyBanner()}

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
  const canSync = Boolean(sourceProfile && targetProfile && sourceProfile.id !== targetProfile.id && !runningBlocker);
  const syncingAccount = isBusyAction("account-sync");

  return `
    <section class="account-sync-panel" data-account-sync aria-busy="${syncingAccount ? "true" : "false"}">
      <div class="section-head">
        <div>
          <h2>账号同步</h2>
          <span class="section-subtitle">Account session</span>
        </div>
      </div>

      <div class="account-sync-grid">
        <div class="field compact">
          <label for="account-sync-source">源 Profile</label>
          <select id="account-sync-source" data-account-sync-source ${busy || !profiles.length ? "disabled" : ""}>
            ${renderProfileOptions(profiles, sourceId)}
          </select>
        </div>
        <div class="field compact">
          <label for="account-sync-target">目标 Profile</label>
          <select id="account-sync-target" data-account-sync-target ${busy || profiles.length < 2 ? "disabled" : ""}>
            ${renderProfileOptions(profiles, targetId, sourceId)}
          </select>
        </div>
        <label class="check-control account-sync-launch">
          <input type="checkbox" data-launch-synced-profile ${launchSyncedProfile ? "checked" : ""} ${busy ? "disabled" : ""} />
          <span>同步后启动目标</span>
        </label>
        <button type="button" class="primary ${syncingAccount ? "loading" : ""}" data-action="sync-account" ${busy || !canSync ? "disabled" : ""}>
          ${renderButtonLabel(syncingAccount, "同步账号", "同步中…")}
        </button>
      </div>

      ${syncingAccount ? renderAccountSyncLoading(sourceProfile, targetProfile) : ""}

      <div class="account-sync-note ${runningBlocker ? "warn" : ""}">
        ${escapeHtml(accountSyncNote(sourceProfile, targetProfile, runningBlocker))}
      </div>

      ${accountSyncResult ? renderAccountSyncResult(accountSyncResult) : ""}
      ${renderAccountSyncBackups()}
    </section>
  `;
}

function renderAccountSyncLoading(sourceProfile: PublicProfile | null, targetProfile: PublicProfile | null): string {
  const sourceName = sourceProfile?.name || "源 Profile";
  const targetName = targetProfile?.name || "目标 Profile";

  return `
    <div class="account-sync-loading" role="status" aria-live="polite">
      <span class="sync-spinner" aria-hidden="true"></span>
      <span>正在同步 ${escapeHtml(sourceName)} 到 ${escapeHtml(targetName)}…</span>
    </div>
  `;
}

function accountSyncNote(
  sourceProfile: PublicProfile | null,
  targetProfile: PublicProfile | null,
  runningBlocker: PublicProfile | null
): string {
  if (!sourceProfile || !targetProfile) {
    return "至少需要两个 Profile 才能同步账号。";
  }

  if (runningBlocker) {
    return `请先关闭目标 ${runningBlocker.name}，再刷新后同步。`;
  }

  if (sourceProfile.running) {
    return `会同步 ${sourceProfile.name} 当前已落盘的登录态到 ${targetProfile.name}，并自动创建目标备份。`;
  }

  return `会用 ${sourceProfile.name} 的登录态覆盖 ${targetProfile.name} 的登录态，并自动创建目标备份。`;
}

function renderAccountSyncResult(result: AccountSyncResult): string {
  const restoring = isBusyAction("restore-account-backup", { backupId: result.backup.id });

  return `
    <div class="account-sync-result">
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
      <div class="migration-result-body">
        <div>
          <strong>备份</strong>
          <code class="path-box compact">${escapeHtml(result.backup.path)}</code>
        </div>
        <button type="button" class="action-button warn ${restoring ? "loading" : ""}" data-action="restore-account-backup" data-backup-id="${escapeHtml(result.backup.id)}" ${busy ? "disabled" : ""}>
          ${renderButtonLabel(restoring, "恢复这个备份", "恢复中…")}
        </button>
      </div>
      ${result.skippedItems.length ? renderAccountSyncSkippedItems(result.skippedItems) : ""}
    </div>
  `;
}

function renderAccountSyncSkippedItems(items: AccountSyncSkippedItem[]): string {
  return `
    <div class="skipped-list">
      ${items
        .slice(0, 8)
        .map((item) => `<span><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.reason)}</span>`)
        .join("")}
      ${items.length > 8 ? `<span>还有 ${items.length - 8} 项未在源 Profile 中找到。</span>` : ""}
    </div>
  `;
}

function renderAccountSyncBackups(): string {
  const backups = accountSyncBackups.slice(0, 4);
  if (!backups.length) {
    return "";
  }

  return `
    <div class="backup-strip">
      <span class="backup-strip-title">账号备份</span>
      ${backups
        .map(
          (backup) => {
            const restoring = isBusyAction("restore-account-backup", { backupId: backup.id });

            return `
            <button type="button" class="backup-chip ${restoring ? "loading" : ""}" data-action="restore-account-backup" data-backup-id="${escapeHtml(backup.id)}" ${busy ? "disabled" : ""}>
              ${renderButtonLabel(restoring, `${backup.targetProfileName} · ${formatDate(backup.createdAt)}`, "恢复中…")}
            </button>
          `;
          }
        )
        .join("")}
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
            <th>类型</th>
            <th>状态</th>
            <th>最近启动</th>
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
        <span class="source-pill ${profile.source}">${sourceLabel(profile)}</span>
      </td>
      <td>
        <span class="state-pill ${profile.running ? "running" : ""}">
          ${profileStatusLabel(profile)}
        </span>
      </td>
      <td class="date-cell">${formatDate(profile.lastLaunchedAt)}</td>
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
            <span class="action-tooltip" data-tooltip="${escapeHtml(closeButtonTitle(profile))}">
              <button type="button" class="action-button warn ${closing ? "loading" : ""}" data-action="close-profile" data-id="${profile.id}" ${busy ? "disabled" : ""}>
                ${renderButtonLabel(closing, "关闭", "关闭中…")}
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
      <button type="button" class="action-button menu-button" data-action="toggle-profile-menu" data-id="${profile.id}" aria-expanded="${menuOpen ? "true" : "false"}" ${busy ? "disabled" : ""}>更多</button>
      ${
        menuOpen
          ? `
            <div class="action-menu" role="menu">
              <span class="action-tooltip" data-tooltip="${escapeHtml(cdpLaunchButtonTitle(profile))}">
                <button type="button" class="${launchingCdp ? "loading" : ""}" data-action="launch-cdp" data-id="${profile.id}" ${cdpLaunchDisabled ? "disabled" : ""}>
                  ${renderButtonLabel(launchingCdp, "CDP启动", "启动中…")}
                </button>
              </span>
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

  return `
    <section class="migration-panel" data-extension-migration>
      <div class="section-head">
        <div>
          <h2>插件迁移</h2>
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

      ${activeScan ? renderExtensionScan(activeScan, selectedCount, allSelected, canMigrate) : renderExtensionScanEmpty()}
      ${extensionMigrationResult ? renderExtensionMigrationResult(extensionMigrationResult) : ""}
      ${renderExtensionBackups()}
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

function renderProfileOptions(profiles: PublicProfile[], selectedProfileId: string, excludedProfileId?: string): string {
  const options = profiles
    .filter((profile) => profile.id !== excludedProfileId)
    .map(
      (profile) =>
        `<option value="${escapeHtml(profile.id)}" ${profile.id === selectedProfileId ? "selected" : ""}>${escapeHtml(profile.name)} · ${sourceLabel(profile)}</option>`
    )
    .join("");

  return options || '<option value="">无可用 Profile</option>';
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
        <span>没有扫描到可迁移插件。</span>
      </div>
    `;
  }

  return `
    <div class="extension-scan-head">
      <div>
        <strong>${escapeHtml(scan.profileName)}</strong>
        <span>${scan.extensions.length} 个插件 · 已选 ${selectedCount}</span>
      </div>
      <div class="migration-actions">
        <button type="button" data-action="select-all-extensions" ${busy ? "disabled" : ""}>${allSelected ? "取消全选" : "一键全选"}</button>
        <button type="button" class="primary" data-action="migrate-extensions" ${busy || !canMigrate ? "disabled" : ""}>迁移所选插件</button>
      </div>
    </div>
    <div class="extensions-table-wrap">
      <table class="extensions-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>插件</th>
            <th>状态</th>
            <th>来源</th>
            <th>数据</th>
            <th>迁移能力</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${scan.extensions.map(renderExtensionRow).join("")}
        </tbody>
      </table>
    </div>
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
  const copiedLocalCount = result.copiedExtensions.length - copiedWebStoreCount;
  const restoring = isBusyAction("restore-extension-backup", { backupId: result.backup.id });

  return `
    <div class="migration-result">
      <div class="migration-result-grid">
        <div>
          <span>已选</span>
          <strong>${result.selectedCount}</strong>
        </div>
        <div>
          <span>商店静默</span>
          <strong>${copiedWebStoreCount}</strong>
        </div>
        <div>
          <span>本地挂载</span>
          <strong>${copiedLocalCount}</strong>
        </div>
        <div>
          <span>安装页兜底</span>
          <strong>${result.webStoreInstallUrls.length}</strong>
        </div>
      </div>
      <div class="migration-result-body">
        <div>
          <strong>备份</strong>
          <code class="path-box compact">${escapeHtml(result.backup.path)}</code>
        </div>
        <button type="button" class="action-button warn ${restoring ? "loading" : ""}" data-action="restore-extension-backup" data-backup-id="${escapeHtml(result.backup.id)}" ${busy ? "disabled" : ""}>
          ${renderButtonLabel(restoring, "恢复这个备份", "恢复中…")}
        </button>
      </div>
      ${result.skippedExtensions.length ? renderSkippedExtensions(result.skippedExtensions) : ""}
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

function renderExtensionBackups(): string {
  const backups = extensionMigrationBackups.slice(0, 4);
  if (!backups.length) {
    return "";
  }

  return `
    <div class="backup-strip">
      <span class="backup-strip-title">最近备份</span>
      ${backups
        .map(
          (backup) => {
            const restoring = isBusyAction("restore-extension-backup", { backupId: backup.id });

            return `
            <button type="button" class="backup-chip ${restoring ? "loading" : ""}" data-action="restore-extension-backup" data-backup-id="${escapeHtml(backup.id)}" ${busy ? "disabled" : ""}>
              ${renderButtonLabel(restoring, `${backup.targetProfileName} · ${formatDate(backup.createdAt)}`, "恢复中…")}
            </button>
          `;
          }
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
          <span>本机监听端口</span>
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
  const selectedExtensions = activeScan?.extensions.filter((extension) => selectedExtensionIds.has(extension.id)) || [];
  const selectedWithData = selectedExtensions.filter((extension) => extension.hasLocalData).length;
  const migrating = isBusyAction("migrate-extensions");

  if (!sourceProfile || !activeScan || !selectedExtensions.length) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal migration-modal" data-extension-migration-form>
        <span class="modal-kicker">插件迁移</span>
        <h2>选择目标 Profile</h2>
        <p class="modal-copy">从 ${escapeHtml(sourceProfile.name)} 迁移 ${selectedExtensions.length} 个已选插件。</p>
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
            <span>含本地数据</span>
            <strong>${selectedWithData}</strong>
          </div>
        </div>
        <div class="field">
          <label for="migration-target">目标 Profile</label>
          <select id="migration-target" name="targetProfileId" data-migration-target ${busy ? "disabled" : ""}>
            ${renderProfileOptions(profiles, targetId, sourceId)}
          </select>
        </div>
        <div class="migration-modal-options">
          <label class="check-control">
            <input type="checkbox" name="includeData" data-include-extension-data ${includeExtensionData ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span>同时迁移插件数据</span>
          </label>
          <label class="check-control">
            <input type="checkbox" name="openInstallPages" data-open-install-pages ${openInstallPages ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span>无法静默时打开安装页</span>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="submit" class="primary ${migrating ? "loading" : ""}" ${busy || !targetId ? "disabled" : ""}>
            ${renderButtonLabel(migrating, "开始迁移", "迁移中…")}
          </button>
        </div>
      </form>
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

function renderConfirmModal(confirm: Extract<ModalState, { kind: "confirm" }>): string {
  const profile = state?.profiles.find((item) => item.id === confirm.profileId);
  if (!profile) {
    return "";
  }

  const copy = confirm.action === "close" ? closeConfirmCopy(profile) : deleteConfirmCopy(profile);
  const confirmClass = confirm.action === "delete" ? "danger solid" : "warn solid";

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span class="modal-kicker">二次确认</span>
        <h2 id="confirm-title">${escapeHtml(copy.title)}</h2>
        <p class="modal-copy">${escapeHtml(copy.body)}</p>
        <div class="confirm-summary">
          <div>
            <span>Profile</span>
            <strong>${escapeHtml(profile.name)}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>${sourceDetail(profile)}</strong>
          </div>
          <div>
            <span>状态</span>
            <strong>${profileStatusLabel(profile)}</strong>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" data-action="close-modal">取消</button>
          <button type="button" class="${confirmClass}" data-action="confirm-profile-action">
            ${escapeHtml(copy.confirmLabel)}
          </button>
        </div>
      </section>
    </div>
  `;
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
  if (extension.fromWebStore && extension.canCopyLocally) {
    return "可静默复制";
  }

  if (extension.canCopyLocally) {
    return "可复制挂载";
  }

  if (extension.fromWebStore) {
    return "可打开安装页";
  }

  return "不可自动迁移";
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
    return "Profile 未运行时不会占用本机监听端口。";
  }

  if (!profile.listeningPorts.length) {
    return "未发现该 Profile 关联进程正在监听本机 TCP 端口。";
  }

  if (profile.cdpPort && profile.listeningPorts.includes(profile.cdpPort)) {
    return `其中 ${profile.cdpPort} 是当前可用于 CDP 连接的调试端口。`;
  }

  return "这些端口由该 Profile 关联的 Chrome 进程占用；它们不一定是可用的 CDP 调试端口。";
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
  if (openProfileMenuId && !target?.closest("[data-profile-actions]")) {
    openProfileMenuId = null;
  }
  if (migrationSourceMenuOpen && !target?.closest("[data-migration-source-select]")) {
    migrationSourceMenuOpen = false;
  }

  const actionTarget = target?.closest<HTMLElement>("[data-action]");
  if (!actionTarget || !state) {
    if ((hadOpenProfileMenu && !openProfileMenuId) || (hadMigrationSourceMenu && !migrationSourceMenuOpen)) {
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

  if (action === "new-profile") {
    modal = { kind: "new" };
    render();
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#profile-name")?.focus(), 0);
    return;
  }

  if (action === "close-modal") {
    if (event.target === actionTarget || actionTarget.tagName === "BUTTON") {
      modal = null;
      render();
    }
    return;
  }

  if (action === "confirm-profile-action" && modal?.kind === "confirm") {
    const profileId = modal.profileId;
    const confirmAction = modal.action;
    const profile = state.profiles.find((item) => item.id === profileId);
    modal = null;

    if (!profile) {
      render();
      return;
    }

    if (confirmAction === "close") {
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
    if (targetProfile.running) {
      setToast("同步前请先关闭目标 Profile，然后刷新列表。", "error");
      return;
    }
    if (
      !window.confirm(
        `用 ${sourceProfile.name} 的登录态覆盖 ${targetProfile.name}？目标 Profile 会先自动备份。`
      )
    ) {
      return;
    }

    void withBusy(async () => {
      const result = await profileApi().syncAccount({
        sourceProfileId: sourceId,
        targetProfileId: targetId,
        launchTarget: launchSyncedProfile
      });
      accountSyncResult = result;
      state = result.state;
      selectedId = result.targetProfileId;
      accountSyncBackups = await profileApi().listAccountSyncBackups();
    }, launchSyncedProfile ? "账号同步完成，已启动目标 Profile" : "账号同步完成", {
      key: "account-sync",
      message: `正在同步 ${sourceProfile.name} 到 ${targetProfile.name}…`,
      profileId: targetProfile.id
    });
    return;
  }

  if (action === "restore-account-backup") {
    const backupId = actionTarget.dataset.backupId;
    if (!backupId) {
      return;
    }

    const backup = accountSyncBackups.find((item) => item.id === backupId) || accountSyncResult?.backup;
    const label = backup ? `${backup.targetProfileName} ${formatDate(backup.createdAt)}` : backupId;
    if (!window.confirm(`恢复账号备份 ${label}？目标 Profile 当前登录态会被替换。`)) {
      return;
    }

    void withBusy(async () => {
      const result = await profileApi().restoreAccountSyncBackup(backupId);
      state = result.state;
      selectedId = result.backup.targetProfileId;
      accountSyncResult = null;
      accountSyncBackups = await profileApi().listAccountSyncBackups();
    }, "已恢复账号同步备份", {
      key: "restore-account-backup",
      message: `正在恢复账号备份 ${label}…`,
      backupId
    });
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
      extensionMigrationResult = null;
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
    render();
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
      setToast("先选择要迁移的插件", "error");
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
    modal = { kind: "extension-migration" };
    render();
    window.setTimeout(() => document.querySelector<HTMLSelectElement>("#migration-target")?.focus(), 0);
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
    if (!window.confirm(`从 ${profile.name} 删除插件“${extension.name}”？删除前会自动创建备份。`)) {
      return;
    }

    void withBusy(async () => {
      const result = await profileApi().deleteProfileExtension(profileId, extensionId);
      extensionScan = result.scan;
      selectedExtensionIds.delete(extensionId);
      extensionMigrationResult = null;
      state = result.state;
      selectedId = result.profileId;
      extensionMigrationBackups = await profileApi().listExtensionMigrationBackups();
    }, `已删除插件 ${extension.name}`, {
      key: "delete-extension",
      message: `正在删除插件 ${extension.name}…`,
      profileId,
      extensionId
    });
    return;
  }

  if (action === "restore-extension-backup") {
    const backupId = actionTarget.dataset.backupId;
    if (!backupId) {
      return;
    }

    const backup = extensionMigrationBackups.find((item) => item.id === backupId) || extensionMigrationResult?.backup;
    const label = backup ? `${backup.targetProfileName} ${formatDate(backup.createdAt)}` : backupId;
    if (!window.confirm(`恢复备份 ${label}？目标 Profile 当前改动会被替换。`)) {
      return;
    }

    void withBusy(async () => {
      const result = await profileApi().restoreExtensionMigrationBackup(backupId);
      state = result.state;
      selectedId = result.backup.targetProfileId;
      extensionMigrationResult = null;
      extensionMigrationBackups = await profileApi().listExtensionMigrationBackups();
    }, "已恢复备份", {
      key: "restore-extension-backup",
      message: `正在恢复插件备份 ${label}…`,
      backupId
    });
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

    modal = { kind: "confirm", action: "close", profileId: id };
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

    modal = { kind: "confirm", action: "delete", profileId: id };
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
  extensionMigrationResult = null;
}

appRoot.addEventListener("change", (event) => {
  const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target || !state) {
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-migration-source]")) {
    migrationSourceId = target.value || null;
    if (migrationTargetId === migrationSourceId) {
      migrationTargetId = state.profiles.find((profile) => profile.id !== migrationSourceId)?.id || null;
    }
    extensionScan = null;
    selectedExtensionIds.clear();
    extensionMigrationResult = null;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-account-sync-source]")) {
    accountSyncSourceId = target.value || null;
    if (accountSyncTargetId === accountSyncSourceId) {
      accountSyncTargetId = state.profiles.find((profile) => profile.id !== accountSyncSourceId)?.id || null;
    }
    accountSyncResult = null;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-account-sync-target]")) {
    accountSyncTargetId = target.value || null;
    accountSyncResult = null;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-launch-synced-profile]")) {
    launchSyncedProfile = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-migration-target]")) {
    migrationTargetId = target.value || null;
    extensionMigrationResult = null;
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
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-include-extension-data]")) {
    includeExtensionData = target.checked;
    render();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-open-install-pages]")) {
    openInstallPages = target.checked;
    render();
  }
});

appRoot.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && migrationSourceMenuOpen) {
    migrationSourceMenuOpen = false;
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
    const extensionIds = activeScan?.extensions
      .filter((extension) => selectedExtensionIds.has(extension.id))
      .map((extension) => extension.id) || [];

    if (!sourceId || !activeScan) {
      setToast("先扫描源 Profile 的插件", "error");
      return;
    }
    if (!targetProfileId || targetProfileId === sourceId) {
      setToast("请选择一个不同的目标 Profile", "error");
      return;
    }
    if (!extensionIds.length) {
      setToast("先选择要迁移的插件", "error");
      return;
    }

    includeExtensionData = data.has("includeData");
    openInstallPages = data.has("openInstallPages");
    migrationTargetId = targetProfileId;
    modal = null;

    void withBusy(async () => {
      const result = await profileApi().migrateExtensions({
        sourceProfileId: sourceId,
        targetProfileId,
        extensionIds,
        includeData: includeExtensionData,
        openInstallPages
      });
      extensionMigrationResult = result;
      state = result.state;
      selectedId = result.targetProfileId;
      extensionMigrationBackups = await profileApi().listExtensionMigrationBackups();
    }, "插件迁移完成", {
      key: "migrate-extensions",
      message: "正在迁移插件…",
      profileId: targetProfileId
    });
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
