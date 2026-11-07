import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GPUI_CHANNEL, GPUI_CHANGED } from '../../shared/gpui';
import { MacInputGuard } from '../input-guard';
import { isWorkspaceShell } from '../workspace-shell';
import { GpuiService, type GpuiServiceOptions } from './service';
import { GpuiControlNotice } from './notice';
import { GpuiAnnotationIndicator } from './indicator';
import { GpuiMcpClient } from './mcp';

export function registerGpui(options: Pick<GpuiServiceOptions, 'directory' | 'guardFactory' | 'occupied'> & { openPanel(): Promise<void> }): GpuiService {
  const root = path.resolve(__dirname, '../../../public');
  const notice: GpuiControlNotice = new GpuiControlNotice({
    icon: path.join(root, 'assets/profilepilot-icon-512.png'),
    openPanel: options.openPanel,
    status: () => service.status(), pauseAll: reason => service.pauseAll(reason),
    stopAll: async () => {
      // Stop only the sessions present when the user chose the tray command.
      for (const { name } of service.status().sessions) {
        const current = service.status().sessions.find(item => item.name === name);
        if (current) await service.control('stop', current.name, current.revision);
      }
    }
  });
  const trusted = (url: string) => {
    try { return path.resolve(fileURLToPath(url)) === path.join(root, 'gpui.html') || isWorkspaceShell(url, root); } catch { return false; }
  };
  const service: GpuiService = new GpuiService({ ...options,
    defaultBackend: path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../..'), 'native', 'gpui', process.platform === 'win32' ? 'gpui-mcp.exe' : 'gpui-mcp'),
    guardFactory: options.guardFactory || (process.platform === 'darwin' ? callbacks => new MacInputGuard(callbacks) : undefined),
    prepareNotice: () => notice.prepare(),
    indicatorFactory: (backend, target, unavailable) => new GpuiAnnotationIndicator(new GpuiMcpClient(backend, { timeoutMs: 4000 }), target, unavailable),
    onChanged: state => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && trusted(win.webContents.getURL())) win.webContents.send(GPUI_CHANGED, state);
      notice.update(state);
    }
  });
  ipcMain.handle(GPUI_CHANNEL, async (event, method: string, input?: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame?.url || '')) throw new Error('GPUI 管理仅允许本地工作区调用。');
    if (method === 'ready') return; // Compatibility for an already loaded older renderer.
    if (method === 'status') return service.status();
    if (method === 'apps') return service.apps();
    if (method === 'configure') {
      const result = await dialog.showOpenDialog({ title: '选择 gpui-mcp 后端', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'gpui-mcp', extensions: ['exe'] }] } : {}) });
      return result.canceled ? null : service.configure(result.filePaths[0]);
    }
    if (method === 'control') {
      const command = z.object({ action: z.enum(['takeover', 'return', 'stop']), session: z.string(), revision: z.number().int().nonnegative() }).strict().parse(input);
      return service.control(command.action, command.session, command.revision);
    }
    throw new Error('未知 GPUI 管理操作。');
  });
  const close = service.close.bind(service);
  service.close = () => { notice.close(); close(); ipcMain.removeHandler(GPUI_CHANNEL); };
  return service;
}
