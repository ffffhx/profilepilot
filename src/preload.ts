import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS } from "./shared/ipc";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  AppState,
  CancelOperationRequest,
  ControlOperationRequest,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationDiffResult,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionScanResult,
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
  focusProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.focusProfile, id),
  closeProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.closeProfile, id),
  openProfileFolder: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.openProfileFolder, id),
  openProfileExtensionsPage: (id: string): Promise<AppState> =>
    ipcRenderer.invoke(IPC_CHANNELS.openProfileExtensionsPage, id),
  openPath: (targetPath: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.openPath, targetPath),
  deleteProfile: (id: string): Promise<DeleteProfileResult> => ipcRenderer.invoke(IPC_CHANNELS.deleteProfile, id),
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
