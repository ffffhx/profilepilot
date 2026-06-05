import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./shared/ipc";
import type { AppState, DeleteProfileResult, ProfileManagerApi } from "./shared/types";

const profileManagerApi: ProfileManagerApi = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.getState),
  createProfile: (name: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.createProfile, name),
  launchProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.launchProfile, id),
  closeProfile: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.closeProfile, id),
  openProfileFolder: (id: string): Promise<AppState> => ipcRenderer.invoke(IPC_CHANNELS.openProfileFolder, id),
  deleteProfile: (id: string): Promise<DeleteProfileResult> => ipcRenderer.invoke(IPC_CHANNELS.deleteProfile, id)
};

contextBridge.exposeInMainWorld("profileManager", profileManagerApi);
