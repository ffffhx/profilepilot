import { execFile, spawn } from "node:child_process";

export type ProfileRef =
  | { source: "native"; dirName: string }
  | { source: "isolated"; id: string }
  // 隔离 user-data-dir 里、非本工具登记的额外子 profile（在 Chrome 里手动新建的）：
  // parentId=所属隔离 Profile 的 registry id，dirName=子 profile 目录（如 "Profile 2"）。
  | { source: "isolated-sub"; parentId: string; dirName: string };

export interface RuntimeProfile {
  pids: number[];
  startedAt: string | null;
  cdpPort: number | null;
  listeningPorts: number[];
}

export interface MigratedExtensionLaunchPlan {
  launchArgs: string[];
  runtimeLoadPaths: string[];
}

export interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
}

export interface CdpTargetListEntry {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  faviconUrl?: string;
  webSocketDebuggerUrl?: string;
}

export interface ProfileRestartPlan {
  profileId: string;
  profileName: string;
  cdpPort: number | null;
  urls: string[];
}

export interface CdpRuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: unknown;
}

export interface CdpResponse<T> {
  id?: number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  // CDP 事件推送（无 id 的消息）：method=事件名（如 Target.targetInfoChanged），params=事件负载。
  method?: string;
  params?: unknown;
}

export interface CdpPendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ChromeLocalState {
  profile?: {
    info_cache?: Record<
      string,
      {
        [key: string]: unknown;
        name?: unknown;
        user_name?: unknown;
        is_using_default_name?: unknown;
      }
    >;
    last_active_profiles?: unknown;
    last_used?: unknown;
    profiles_order?: unknown;
    [key: string]: unknown;
  };
}

export interface ChromePreferences {
  extensions?: {
    settings?: Record<string, ChromeExtensionSetting>;
    ui?: Record<string, unknown>;
    [key: string]: unknown;
  };
  protection?: {
    macs?: {
      extensions?: {
        settings?: Record<string, unknown>;
        settings_encrypted_hash?: Record<string, unknown>;
        ui?: Record<string, unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export interface JsonPropertySnapshot {
  exists: boolean;
  value: unknown;
}

export interface AccountSyncExtensionPreferenceFileSnapshot {
  extensions: JsonPropertySnapshot;
  protectedExtensions: JsonPropertySnapshot;
}

export type AccountSyncPreferenceFileName = "Preferences" | "Secure Preferences";
export type AccountSyncExtensionPreferencesSnapshot = Record<
  AccountSyncPreferenceFileName,
  AccountSyncExtensionPreferenceFileSnapshot
>;

export interface ChromeExtensionSetting {
  [key: string]: unknown;
  state?: unknown;
  disable_reasons?: unknown;
  disable_reason?: unknown;
  from_webstore?: unknown;
  location?: unknown;
  path?: unknown;
  manifest?: ChromeExtensionManifest;
}

export interface ChromeExtensionManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  default_locale?: unknown;
  update_url?: unknown;
}

export interface ProtectedExtensionInstallRecord {
  setting: ChromeExtensionSetting;
  settingMac: string;
  encryptedHashMac: string;
}

export interface ProtectedDeveloperModeRecord {
  developerMode: true;
  developerModeMac: string;
  encryptedHashMac: string;
}

export interface AccountSyncPathSpec {
  label: string;
  relativePath: string;
}

export interface AccountSyncDataLocation {
  userDataPath: string;
  profilePath: string;
  profileDirName: string;
}

export interface CopyStats {
  files: number;
  bytes: number;
}

export interface AccountSyncCopyPlan {
  spec: AccountSyncPathSpec;
  index: number;
  sourcePath: string;
  targetPath: string;
  stats: CopyStats;
}

export const ACCOUNT_SYNC_WORK_PREFIX = ".profilepilot-sync-";
export const ACCOUNT_SYNC_PARTIAL_SUFFIX = ".partial";
export const ACCOUNT_SYNC_PREVIOUS_SUFFIX = ".previous";
export const ACCOUNT_SYNC_PREFERENCE_FILES: AccountSyncPreferenceFileName[] = ["Preferences", "Secure Preferences"];
export const ACCOUNT_SYNC_DISK_SPACE_BUFFER_RATIO = 0.05;
export const ACCOUNT_SYNC_DISK_SPACE_MIN_BUFFER_BYTES = 64 * 1024 * 1024;
export const ACCOUNT_SYNC_DISK_SPACE_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

export interface TemporaryChromeCdpLaunch {
  child: ReturnType<typeof spawn>;
  port: number;
  stderr: () => string;
}
