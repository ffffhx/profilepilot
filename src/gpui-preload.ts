// The standalone control strip stays sandboxed and receives only GPUI controls.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { GpuiApi, GpuiStatus } from './shared/gpui';
const api: GpuiApi = {
  ready: () => ipcRenderer.invoke('profilepilot:gpui', 'ready'),
  status: () => ipcRenderer.invoke('profilepilot:gpui', 'status'),
  apps: () => ipcRenderer.invoke('profilepilot:gpui', 'apps'),
  configure: () => Promise.reject(new Error('请在 GPUI 管理页配置后端。')),
  control: (action, session, revision) => ipcRenderer.invoke('profilepilot:gpui', 'control', { action, session, revision }),
  onChanged: listener => {
    const handler = (_event: IpcRendererEvent, value: GpuiStatus) => listener(value);
    ipcRenderer.on('profilepilot:gpui-changed', handler);
    return () => ipcRenderer.removeListener('profilepilot:gpui-changed', handler);
  }
};
contextBridge.exposeInMainWorld('gpuiControl', api);
