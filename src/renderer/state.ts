import { AccountSyncDiffResult, AccountSyncResult, AppState, BusyState, CdpLiveView, ExtensionMigrationDiffResult, ExtensionMigrationResult, ExtensionScanResult, GlobalInstructionFileId, GlobalInstructionsSnapshot, ModalState, ToastKind } from "./types";

export const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Missing #app root.");
}

export const appRoot: HTMLDivElement = root;

// 单个 Profile 的实时观测缓存条目（独立于 AppState，不进全局轮询）。
export interface LiveViewEntry {
  data: CdpLiveView | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number;
}

export interface RendererState {
  viewMode: "main" | "mini";
  miniExpanded: boolean;
  miniPanelOpen: boolean;
  miniPanelPinned: boolean;
  miniScrollTop: number;
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
  migrationTargetMenuOpen: boolean;
  accountSyncMenuOpen: "source" | "target" | null;
  accountSyncSourceId: string | null;
  accountSyncTargetId: string | null;
  launchSyncedProfile: boolean;
  // 合并同步面板的内容开关：默认账号登录态和插件都同步，允许只勾其一。
  syncAccountPart: boolean;
  syncExtensionsPart: boolean;
  // 账号同步差异扫描（源 vs 目标）：手动触发，换源/换目标/同步完成后清空。
  accountSyncDiff: AccountSyncDiffResult | null;
  accountSyncDiffLoading: boolean;
  accountSyncDiffCollapsed: boolean;
  accountSyncResult: AccountSyncResult | null;
  clonePoolSourceId: string | null;
  clonePoolMenuOpen: boolean;
  clonePoolCount: number;
  clonePoolIncludeExtensions: boolean;
  clonePoolLaunchAfter: boolean;
  clonePoolRecycleDays: number;
  globalInstructions: GlobalInstructionsSnapshot | null;
  globalInstructionsLoading: boolean;
  globalInstructionsSaving: boolean;
  activeGlobalInstructionId: GlobalInstructionFileId;
  editingGlobalInstructionId: GlobalInstructionFileId | null;
  globalInstructionDraft: string;
  // profileId -> 实时观测缓存；按需拉取，主轮询全量重渲染时从这里恢复，避免截图闪烁。
  liveView: Record<string, LiveViewEntry>;
  liveViewShowScreenshot: boolean;
  // Cockpit 当前查看/激活的标签页：profileId -> targetId（用户在标签列表里点选的那个）。
  liveActiveTab: Record<string, string>;
}

export const store: RendererState = {
  viewMode: new URLSearchParams(window.location.search).get("mode") === "mini" ? "mini" : "main",
  miniExpanded: false,
  miniPanelOpen: false,
  miniPanelPinned: false,
  miniScrollTop: 0,
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
  migrationTargetMenuOpen: false,
  accountSyncMenuOpen: null,
  accountSyncSourceId: null,
  accountSyncTargetId: null,
  launchSyncedProfile: true,
  syncAccountPart: true,
  syncExtensionsPart: true,
  accountSyncDiff: null,
  accountSyncDiffLoading: false,
  accountSyncDiffCollapsed: false,
  accountSyncResult: null,
  clonePoolSourceId: null,
  clonePoolMenuOpen: false,
  clonePoolCount: 3,
  clonePoolIncludeExtensions: false,
  clonePoolLaunchAfter: false,
  clonePoolRecycleDays: 7,
  globalInstructions: null,
  globalInstructionsLoading: false,
  globalInstructionsSaving: false,
  activeGlobalInstructionId: "codex-agents",
  editingGlobalInstructionId: null,
  globalInstructionDraft: "",
  liveView: {},
  liveViewShowScreenshot: true,
  liveActiveTab: {}
};

export const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
