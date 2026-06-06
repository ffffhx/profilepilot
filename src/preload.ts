import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./shared/ipc";
import type {
  AppState,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationBackupSummary,
  ExtensionMigrationRequest,
  ExtensionMigrationRestoreResult,
  ExtensionMigrationResult,
  ExtensionScanResult,
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
  deleteProfile: (id: string): Promise<DeleteProfileResult> => ipcRenderer.invoke(IPC_CHANNELS.deleteProfile, id),
  scanProfileExtensions: (profileId: string): Promise<ExtensionScanResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.scanProfileExtensions, profileId),
  migrateExtensions: (request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.migrateExtensions, request),
  deleteProfileExtension: (profileId: string, extensionId: string): Promise<ExtensionDeleteResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProfileExtension, profileId, extensionId),
  listExtensionMigrationBackups: (): Promise<ExtensionMigrationBackupSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listExtensionMigrationBackups),
  restoreExtensionMigrationBackup: (backupId: string): Promise<ExtensionMigrationRestoreResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreExtensionMigrationBackup, backupId)
};

contextBridge.exposeInMainWorld("profileManager", profileManagerApi);
