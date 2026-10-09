import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS } from "./shared/ipc";
import { LOCAL_APPS_CHANNEL, type LocalAppsApi } from "./shared/local-apps";
import { PHONE_CHANNEL, PHONE_CHANGED, type PhonesApi, type PhonesSnapshot } from "./shared/phones";
import { MOBILE_CHANNEL, MOBILE_CHANGED, type MobileApi, type MobileSnapshot } from "./shared/mobile";
import { TASK_CHANNEL, TASK_CHANGED, TASK_STREAM, TASK_PREVIEW, type TaskApi, type TaskSnapshot, type TaskPreviewUpdate, type TaskStreamUpdate } from "./shared/tasks";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  AgentIntegrationDiagnostic,
  AgentOverlayRevealEvent,
  AgentTakeoverEvent,
  CloneProfilesRequest,
  CloneProfilesResult,
  RefreshClonesResult,
  RecycleIdleClonesResult,
  LaunchClonesResult,
  AppState,
  BifrostSnapshot,
  CancelOperationRequest,
  CdpLiveView,
  CdpLiveViewOptions,
  CdpPortSuggestion,
  ControlOperationRequest,
  DeleteProfileOptions,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationDiffResult,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionScanResult,
  GlobalInstructionUpdateRequest,
  GlobalInstructionUndoRequest,
  GlobalInstructionsSnapshot,
  LaunchProfileOptions,
  OperationProgress,
  ProfileAgentSettings,
  ProfileProxyConfig,
  ProfileManagerApi,
  ProfileReadinessReceipt,
  ProfileReadinessRequest,
  TakeoverAgentConnectionsRequest,
  TakeoverAgentConnectionsResponse
} from "./shared/types";

contextBridge.exposeInMainWorld("desktopWindow", {
  platform: process.platform,
  onNavigate: (listener: (href: string) => void) => {
    const handler = (_event: IpcRendererEvent, href: string) => listener(href);
    ipcRenderer.on(IPC_CHANNELS.navigateWorkspace, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.navigateWorkspace, handler);
  },
  setAppearance: (background: string, symbols: string, guideActive = false) => {
    ipcRenderer.send(IPC_CHANNELS.setWindowAppearance, background, symbols, guideActive);
  }
});

const mobileApi: MobileApi = {
  snapshot: () => ipcRenderer.invoke(MOBILE_CHANNEL, "snapshot"),
  configure: input => ipcRenderer.invoke(MOBILE_CHANNEL, "configure", input),
  pair: endpoint => ipcRenderer.invoke(MOBILE_CHANNEL, "pair", endpoint),
  revoke: id => ipcRenderer.invoke(MOBILE_CHANNEL, "revoke", id),
  updateDevice: (id, input) => ipcRenderer.invoke(MOBILE_CHANNEL, "updateDevice", id, input),
  openApkFolder: () => ipcRenderer.invoke(MOBILE_CHANNEL, "openApkFolder"),
  onChanged: listener => { const handler = (_event: IpcRendererEvent, snapshot: MobileSnapshot) => listener(snapshot); ipcRenderer.on(MOBILE_CHANGED, handler); return () => ipcRenderer.removeListener(MOBILE_CHANGED, handler); }
};
contextBridge.exposeInMainWorld("mobile", mobileApi);

const profileManagerApi: ProfileManagerApi = {
  getStartupSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getStartupSettings),
  setStartupEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setStartupEnabled, enabled),
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.getState),
  getInitialState: (): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.getInitialState),
  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: AppState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, handler);
  },
  getTakeoverHistory: (): Promise<AgentTakeoverEvent[]> => ipcRenderer.invoke(IPC_CHANNELS.getTakeoverHistory),
  createProfile: (name: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.createProfile, name),
  renameProfile: (id: string, name: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.renameProfile, id, name),
  launchProfile: (id: string, options?: LaunchProfileOptions): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchProfile, id, options ?? null),
  launchProfileWithCdp: (id: string, port?: number | null, options?: LaunchProfileOptions): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchProfileWithCdp, id, port, options ?? null),
  connectRunningSystemChrome: (id: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.connectRunningSystemChrome, id),
  suggestCdpPort: (preferredPort?: number | null): Promise<CdpPortSuggestion> =>
    ipcRenderer.invoke(IPC_CHANNELS.suggestCdpPort, preferredPort),
  getBifrostSnapshot: (): Promise<BifrostSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.getBifrostSnapshot),
  disableBifrostRule: (ruleName: string): Promise<BifrostSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.disableBifrostRule, ruleName),
  setProfileProxy: (id: string, config: ProfileProxyConfig | null): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setProfileProxy, id, config),
  setProfileAgentSettings: (id: string, settings: ProfileAgentSettings): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setProfileAgentSettings, id, settings),
  setMiniProfilePinned: (id: string, pinned: boolean): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniProfilePinned, id, pinned),
  setMiniProfileOrder: (ids: string[]): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniProfileOrder, ids),
  setMainProfileOrder: (ids: string[]): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMainProfileOrder, ids),
  setQuickLaunchSlot: (id: string, slot: number | null): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setQuickLaunchSlot, id, slot),
  setMiniPanelPinned: (pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniPanelPinned, pinned),
  onMiniPanelPinnedChanged: (listener: (pinned: boolean) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, pinned: boolean): void => {
      listener(Boolean(pinned));
    };

    ipcRenderer.on(IPC_CHANNELS.miniPanelPinnedChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.miniPanelPinnedChanged, handler);
  },
  showMiniWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.showMiniWindow),
  hideMiniWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.hideMiniWindow),
  showMainWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.showMainWindow),
  setMiniWindowPanelOpen: (open: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniWindowPanelOpen, open),
  resizeMiniPanel: (height: number): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.resizeMiniPanel, height),
  requestMiniWindowPanelClose: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.requestMiniWindowPanelClose),
  dragMiniWindow: (screenX: number, screenY: number, phase: "start" | "move" | "end"): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.dragMiniWindow, screenX, screenY, phase),
  isMiniWindowPointerInside: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.isMiniWindowPointerInside),
  onMiniWindowPanelOpenChanged: (listener: (open: boolean) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, open: boolean): void => {
      listener(Boolean(open));
    };

    ipcRenderer.on(IPC_CHANNELS.miniWindowPanelOpenChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.miniWindowPanelOpenChanged, handler);
  },
  readGlobalInstructions: (): Promise<GlobalInstructionsSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.readGlobalInstructions),
  writeGlobalInstruction: (request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.writeGlobalInstruction, request),
  undoGlobalInstruction: (request: GlobalInstructionUndoRequest): Promise<GlobalInstructionsSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.undoGlobalInstruction, request),
  ensureClaudeInstructionShell: (): Promise<GlobalInstructionsSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.ensureClaudeInstructionShell),
  inspectProfileReadiness: (request: ProfileReadinessRequest): Promise<ProfileReadinessReceipt> =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectProfileReadiness, request),
  focusProfile: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.focusProfile, id),
  isProfileFrontmost: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.isProfileFrontmost, id),
  closeProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.closeProfile, id),
  focusExternalInstance: (userDataDir: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.focusExternalInstance, userDataDir),
  closeExternalInstance: (userDataDir: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.closeExternalInstance, userDataDir),
  disconnectCdpClient: (profileId: string, pid: number): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.disconnectCdpClient, profileId, pid),
  takeoverAgentConnections: (
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.takeoverAgentConnections, profileId, sessionOrOptions),
  resumeAgentConnections: (
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeAgentConnections, profileId, sessionOrOptions),
  setAgentOverlayEnabled: (enabled: boolean): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAgentOverlayEnabled, enabled),
  setShellIntegrationEnabled: (enabled: boolean): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setShellIntegrationEnabled, enabled),
  inspectAgentIntegration: (): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectAgentIntegration),
  readBrowserPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.readBrowserPreferences),
  readControlPreferences: domain => ipcRenderer.invoke(IPC_CHANNELS.readControlPreferences, domain),
  writeControlPreferences: request => ipcRenderer.invoke(IPC_CHANNELS.writeControlPreferences, request),
  writeBrowserPreferences: request => ipcRenderer.invoke(IPC_CHANNELS.writeBrowserPreferences, request),
  setAgentWrapperEnabled: (tool, enabled): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAgentWrapperEnabled, tool, enabled),
  setAgentSkillEnabled: (tool, enabled): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAgentSkillEnabled, tool, enabled),
  setProfilePilotCliEnabled: (enabled): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.setProfilePilotCliEnabled, enabled),
  setProfilePilotCliSkillEnabled: (enabled): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.setProfilePilotCliSkillEnabled, enabled),
  requestInputGuardPermission: (): Promise<AgentIntegrationDiagnostic> =>
    ipcRenderer.invoke(IPC_CHANNELS.requestInputGuardPermission),
  openInputGuardSettings: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.openInputGuardSettings),
  prepareProfileForAgent: (profileId: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.prepareProfileForAgent, profileId),
  openProfileFolder: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.openProfileFolder, id),
  openProfileExtensionsPage: (id: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.openProfileExtensionsPage, id),
  openPath: (targetPath: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.openPath, targetPath),
  deleteProfile: (id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProfile, id, options),
  inspectAccountSyncDiff: (request: AccountSyncRequest): Promise<AccountSyncDiffResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectAccountSyncDiff, request),
  scanProfileExtensions: (profileId: string): Promise<ExtensionScanResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.scanProfileExtensions, profileId),
  inspectExtensionMigrationDiff: (request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectExtensionMigrationDiff, request),
  migrateExtensions: (request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.migrateExtensions, request),
  deleteProfileExtension: (profileId: string, extensionId: string): Promise<ExtensionDeleteResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProfileExtension, profileId, extensionId),
  syncAccount: (request: AccountSyncRequest): Promise<AccountSyncResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.syncAccount, request),
  cloneProfiles: (request: CloneProfilesRequest): Promise<CloneProfilesResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.cloneProfiles, request),
  refreshClones: (sourceProfileId: string): Promise<RefreshClonesResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshClones, sourceProfileId),
  resetClone: (profileId: string): Promise<AccountSyncResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.resetClone, profileId),
  recycleIdleClones: (days: number): Promise<RecycleIdleClonesResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.recycleIdleClones, days),
  setProfileTag: (profileId: string, tag: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setProfileTag, profileId, tag),
  launchClones: (sourceProfileId: string): Promise<LaunchClonesResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchClones, sourceProfileId),
  cancelOperation: (request: CancelOperationRequest): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelOperation, request),
  controlOperation: (request: ControlOperationRequest): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.controlOperation, request),
  getCdpLiveView: (port: number, options?: CdpLiveViewOptions): Promise<CdpLiveView> =>
    ipcRenderer.invoke(IPC_CHANNELS.getCdpLiveView, port, options),
  onOperationProgress: (listener: (progress: OperationProgress) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: OperationProgress): void => {
      listener(progress);
    };

    ipcRenderer.on(IPC_CHANNELS.operationProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.operationProgress, handler);
  },
  onAgentTakeover: (listener: (event: AgentTakeoverEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, takeover: AgentTakeoverEvent): void => {
      listener(takeover);
    };

    ipcRenderer.on(IPC_CHANNELS.agentTakeover, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentTakeover, handler);
  },
  onAgentOverlayReveal: (listener: (event: AgentOverlayRevealEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, reveal: AgentOverlayRevealEvent): void => {
      listener(reveal);
    };

    ipcRenderer.on(IPC_CHANNELS.agentOverlayReveal, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentOverlayReveal, handler);
  }
};

contextBridge.exposeInMainWorld("profileManager", profileManagerApi);
const taskApi: TaskApi = {
  openLink: url => ipcRenderer.invoke(TASK_CHANNEL, "openLink", url),
  pairNativeBrowser: id => ipcRenderer.invoke(TASK_CHANNEL, "pairNativeBrowser", id),
  getNativeLiveView: id => ipcRenderer.invoke(TASK_CHANNEL, "getNativeLiveView", id),
  authorizeNativeBrowser: id => ipcRenderer.invoke(TASK_CHANNEL, "authorizeNativeBrowser", id),
  disconnectNativeBrowser: id => ipcRenderer.invoke(TASK_CHANNEL, "disconnectNativeBrowser", id),
  openNativeExtensionFolder: () => ipcRenderer.invoke(TASK_CHANNEL, "openNativeExtensionFolder"),
  focusTaskBrowser: id => ipcRenderer.invoke(TASK_CHANNEL, "focusTaskBrowser", id),
  watchPreview: id => ipcRenderer.invoke(TASK_CHANNEL, "watchPreview", id),
  ackPreview: (id, frameId) => ipcRenderer.invoke(TASK_CHANNEL, "ackPreview", id, frameId),
  onPreview: listener => {
    const handler = (_event: IpcRendererEvent, update: TaskPreviewUpdate): void => listener(update);
    ipcRenderer.on(TASK_PREVIEW, handler); return () => ipcRenderer.removeListener(TASK_PREVIEW, handler);
  },
  snapshot: () => ipcRenderer.invoke(TASK_CHANNEL, "snapshot"),
  create: (input) => ipcRenderer.invoke(TASK_CHANNEL, "create", input),
  retryItems: (id, items) => ipcRenderer.invoke(TASK_CHANNEL, "retryItems", id, items),
  control: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "control", ...args),
  reply: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "reply", ...args),
  queue: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "queue", ...args),
  permissions: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "permissions", ...args),
  setLimits: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "setLimits", ...args),
  setModel: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "setModel", ...args),
  previewArtifact: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "previewArtifact", ...args),
  saveMaterial: (input) => ipcRenderer.invoke(TASK_CHANNEL, "saveMaterial", input),
  deleteMaterial: (id) => ipcRenderer.invoke(TASK_CHANNEL, "deleteMaterial", id),
  importAttachments: () => ipcRenderer.invoke(TASK_CHANNEL, "importAttachments"),
  deleteAttachment: (id) => ipcRenderer.invoke(TASK_CHANNEL, "deleteAttachment", id),
  saveSettings: (input) => ipcRenderer.invoke(TASK_CHANNEL, "saveSettings", input),
  testConnection: () => ipcRenderer.invoke(TASK_CHANNEL, "testConnection"),
  listModels: () => ipcRenderer.invoke(TASK_CHANNEL, "listModels"),
  saveJevSettings: (input) => ipcRenderer.invoke(TASK_CHANNEL, "saveJevSettings", input),
  testJevConnection: () => ipcRenderer.invoke(TASK_CHANNEL, "testJevConnection"),
  openJevConsole: (page) => ipcRenderer.invoke(TASK_CHANNEL, "openJevConsole", page),
  saveSchedule: (input) => ipcRenderer.invoke(TASK_CHANNEL, "saveSchedule", input),
  deleteSchedule: (id) => ipcRenderer.invoke(TASK_CHANNEL, "deleteSchedule", id),
  saveTemplate: (input) => ipcRenderer.invoke(TASK_CHANNEL, "saveTemplate", input),
  deleteTemplate: (id) => ipcRenderer.invoke(TASK_CHANNEL, "deleteTemplate", id),
  deleteTask: (id) => ipcRenderer.invoke(TASK_CHANNEL, "deleteTask", id),
  updateTaskMetadata: (id, input) => ipcRenderer.invoke(TASK_CHANNEL, "updateTaskMetadata", id, input),
  exportData: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "exportData", ...args),
  openArtifact: (...args) => ipcRenderer.invoke(TASK_CHANNEL, "openArtifact", ...args),
  onChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, snapshot: TaskSnapshot): void => listener(snapshot);
    ipcRenderer.on(TASK_CHANGED, handler); return () => ipcRenderer.removeListener(TASK_CHANGED, handler);
  },
  onStream: listener => {
    const handler = (_event: IpcRendererEvent, update: TaskStreamUpdate) => listener(update);
    ipcRenderer.on(TASK_STREAM, handler); return () => ipcRenderer.removeListener(TASK_STREAM, handler);
  }
};
contextBridge.exposeInMainWorld("tasks", taskApi);
const localAppsApi: LocalAppsApi = {
  list: options => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "list", options),
  save: input => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "save", input),
  remove: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "remove", id),
  start: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "start", id),
  stop: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "stop", id),
  restart: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "restart", id),
  connect: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "connect", id),
  preview: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "preview", id),
  showWindow: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "showWindow", id),
  logs: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "logs", id),
  pickDirectory: () => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "pickDirectory"),
  openDirectory: id => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "openDirectory", id),
  openDebugger: (id, kind, targetId) => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "openDebugger", id, kind, targetId),
  agentControl: (id, command) => ipcRenderer.invoke(LOCAL_APPS_CHANNEL, "agentControl", id, command)
};
contextBridge.exposeInMainWorld("localApps", localAppsApi);
const phonesApi: PhonesApi = {
  basicStart: (id, mode, controller, task) => ipcRenderer.invoke(PHONE_CHANNEL, "basic-start", { id, mode, controller, task }),
  basicControl: (id, command) => ipcRenderer.invoke(PHONE_CHANNEL, `basic-${command}`, { id }),
  basicPerform: input => ipcRenderer.invoke(PHONE_CHANNEL, "basic-action", input),
  snapshot: () => ipcRenderer.invoke(PHONE_CHANNEL, "snapshot"),
  cloudPair: url => ipcRenderer.invoke(PHONE_CHANNEL, "cloud-pair", { url }),
  cloudForget: id => ipcRenderer.invoke(PHONE_CHANNEL, "cloud-forget", { id }),
  listEmulators: () => ipcRenderer.invoke(PHONE_CHANNEL, "emulator-list"),
  connectEmulator: name => ipcRenderer.invoke(PHONE_CHANNEL, "emulator-connect", { name }),
  discoverWireless: id => ipcRenderer.invoke(PHONE_CHANNEL, "wireless-discover", id ? { id } : {}),
  pairWireless: (address, code) => ipcRenderer.invoke(PHONE_CHANNEL, "wireless-pair", { address, code }),
  connectWireless: address => ipcRenderer.invoke(PHONE_CHANNEL, "wireless-connect", { address }),
  autoConnectWireless: id => ipcRenderer.invoke(PHONE_CHANNEL, "wireless-connect", { id }),
  prepare: id => ipcRenderer.invoke(PHONE_CHANNEL, "connect", { id }),
  inspect: id => ipcRenderer.invoke(PHONE_CHANNEL, "inspect", { id }),
  preview: id => ipcRenderer.invoke(PHONE_CHANNEL, "preview", { id }),
  openSettings: (id, setting) => ipcRenderer.invoke(PHONE_CHANNEL, "settings", { id, setting }),
  rename: (id, name) => ipcRenderer.invoke(PHONE_CHANNEL, "rename", { id, name }),
  start: (id, mode, controller, task) => ipcRenderer.invoke(PHONE_CHANNEL, "start", { id, mode, controller, task }),
  control: (id, command) => ipcRenderer.invoke(PHONE_CHANNEL, command, { id }),
  perform: input => ipcRenderer.invoke(PHONE_CHANNEL, "action", input),
  onChanged: listener => {
    const handler = (_event: IpcRendererEvent, snapshot: PhonesSnapshot) => listener(snapshot);
    ipcRenderer.on(PHONE_CHANGED, handler); return () => ipcRenderer.removeListener(PHONE_CHANGED, handler);
  }
};
contextBridge.exposeInMainWorld("phones", phonesApi);
