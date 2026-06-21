import { AccountSyncResult, AppState, BusyState, ExtensionMigrationDiffResult, ExtensionMigrationResult, ExtensionScanResult, ModalState, ToastKind } from "./types";

export const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Missing #app root.");
}

export const appRoot: HTMLDivElement = root;

export interface RendererState {
  state: AppState | null;
  selectedId: string | null;
  selectedExternalDir: string | null;
  modal: ModalState;
  busy: boolean;
  busyState: BusyState | null;
  toast: string | null;
  toastKind: ToastKind;
  toastTimer: number | undefined;
  migrationSourceId: string | null;
  migrationTargetId: string | null;
  extensionScan: ExtensionScanResult | null;
  selectedExtensionIds: Set<string>;
  includeExtensionData: boolean;
  openInstallPages: boolean;
  extensionSyncOnlyChanged: boolean;
  extensionMigrationDiff: ExtensionMigrationDiffResult | null;
  extensionMigrationDiffLoading: boolean;
  extensionMigrationDiffKey: string;
  extensionMigrationDiffRequestId: number;
  extensionMigrationResult: ExtensionMigrationResult | null;
  extensionScanPreviewCollapsed: boolean;
  openProfileMenuId: string | null;
  migrationSourceMenuOpen: boolean;
  migrationTargetMenuOpen: boolean;
  accountSyncMenuOpen: "source" | "target" | null;
  accountSyncSourceId: string | null;
  accountSyncTargetId: string | null;
  launchSyncedProfile: boolean;
  accountSyncScopeExpanded: boolean;
  accountSyncResult: AccountSyncResult | null;
}

export const store: RendererState = {
  state: null,
  selectedId: null,
  selectedExternalDir: null,
  modal: null,
  busy: false,
  busyState: null,
  toast: null,
  toastKind: "normal",
  toastTimer: undefined,
  migrationSourceId: null,
  migrationTargetId: null,
  extensionScan: null,
  selectedExtensionIds: new Set<string>(),
  includeExtensionData: false,
  openInstallPages: true,
  extensionSyncOnlyChanged: true,
  extensionMigrationDiff: null,
  extensionMigrationDiffLoading: false,
  extensionMigrationDiffKey: "",
  extensionMigrationDiffRequestId: 0,
  extensionMigrationResult: null,
  extensionScanPreviewCollapsed: false,
  openProfileMenuId: null,
  migrationSourceMenuOpen: false,
  migrationTargetMenuOpen: false,
  accountSyncMenuOpen: null,
  accountSyncSourceId: null,
  accountSyncTargetId: null,
  launchSyncedProfile: true,
  accountSyncScopeExpanded: false,
  accountSyncResult: null
};

export const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
