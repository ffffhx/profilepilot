export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
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

export interface Registry {
  profiles: StoredProfile[];
  nativeProfiles?: Record<string, NativeProfileMetadata>;
}

export type ProfileSource = "native" | "isolated";

export interface PublicProfile {
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

export interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  isDefault: boolean;
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
}

export interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
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
}

export interface ExtensionMigrationBackupItem {
  relativePath: string;
  existed: boolean;
}

export interface ExtensionMigrationBackupSummary {
  id: string;
  createdAt: string;
  path: string;
  targetProfileId: string;
  targetProfileName: string;
  targetProfilePath: string;
  itemCount: number;
}

export interface ExtensionMigrationBackupMetadata extends ExtensionMigrationBackupSummary {
  items: ExtensionMigrationBackupItem[];
  targetMigratedExtensions?: StoredMigratedExtension[];
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

export interface ExtensionMigrationSkippedExtension {
  id: string;
  name: string;
  reason: string;
}

export interface ExtensionMigrationResult {
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

export interface ExtensionDeleteResult {
  profileId: string;
  profileName: string;
  extensionId: string;
  extensionName: string;
  deletedPaths: string[];
  backup: ExtensionMigrationBackupSummary;
  scan: ExtensionScanResult;
  state: AppState;
}

export interface ExtensionMigrationRestoreResult {
  backup: ExtensionMigrationBackupSummary;
  state: AppState;
}

export interface AccountSyncRequest {
  sourceProfileId: string;
  targetProfileId: string;
  launchTarget: boolean;
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

export interface AccountSyncBackupItem {
  relativePath: string;
  existed: boolean;
}

export interface AccountSyncBackupSummary {
  id: string;
  createdAt: string;
  path: string;
  targetProfileId: string;
  targetProfileName: string;
  targetProfilePath: string;
  itemCount: number;
}

export interface AccountSyncBackupMetadata extends AccountSyncBackupSummary {
  targetUserDataPath: string;
  items: AccountSyncBackupItem[];
}

export interface AccountSyncResult {
  sourceProfileId: string;
  targetProfileId: string;
  copiedItems: AccountSyncCopiedItem[];
  skippedItems: AccountSyncSkippedItem[];
  backup: AccountSyncBackupSummary;
  launchedTarget: boolean;
  state: AppState;
}

export interface AccountSyncRestoreResult {
  backup: AccountSyncBackupSummary;
  state: AppState;
}

export interface ProfileManagerApi {
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
