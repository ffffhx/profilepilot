import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS } from "./shared/ipc";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  SetupAgentBrowserRequest,
  SetupAgentBrowserResult,
  AppState,
  CancelOperationRequest,
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
  GlobalInstructionsSnapshot,
  OperationProgress,
  ProfileManagerApi
} from "./shared/types";

const profileManagerApi: ProfileManagerApi = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.getState),
  createProfile: (name: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.createProfile, name),
  renameProfile: (id: string, name: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.renameProfile, id, name),
  launchProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.launchProfile, id),
  launchProfileWithCdp: (id: string, port?: number | null): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.launchProfileWithCdp, id, port),
  connectRunningSystemChrome: (id: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.connectRunningSystemChrome, id),
  suggestCdpPort: (preferredPort?: number | null): Promise<CdpPortSuggestion> =>
    ipcRenderer.invoke(IPC_CHANNELS.suggestCdpPort, preferredPort),
  setAgentBrowserConfig: (id: string, port: number): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setAgentBrowserConfig, id, port),
  clearAgentBrowserConfig: (id: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.clearAgentBrowserConfig, id),
  setMiniProfilePinned: (id: string, pinned: boolean): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniProfilePinned, id, pinned),
  showMiniWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.showMiniWindow),
  showMainWindow: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.showMainWindow),
  setMiniWindowPanelOpen: (open: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setMiniWindowPanelOpen, open),
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
  ensureClaudeInstructionShell: (): Promise<GlobalInstructionsSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.ensureClaudeInstructionShell),
  focusProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.focusProfile, id),
  isProfileFrontmost: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.isProfileFrontmost, id),
  closeProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.closeProfile, id),
  focusExternalInstance: (userDataDir: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.focusExternalInstance, userDataDir),
  closeExternalInstance: (userDataDir: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.closeExternalInstance, userDataDir),
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
  setupAgentBrowser: (request: SetupAgentBrowserRequest): Promise<SetupAgentBrowserResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.setupAgentBrowser, request),
  cancelOperation: (request: CancelOperationRequest): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelOperation, request),
  controlOperation: (request: ControlOperationRequest): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.controlOperation, request),
  onOperationProgress: (listener: (progress: OperationProgress) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: OperationProgress): void => {
      listener(progress);
    };

    ipcRenderer.on(IPC_CHANNELS.operationProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.operationProgress, handler);
  }
};

contextBridge.exposeInMainWorld("profileManager", profileManagerApi);
