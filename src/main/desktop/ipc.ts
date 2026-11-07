import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DESKTOP_CHANNEL, DESKTOP_CHANGED, type DesktopStatus } from '../../shared/desktop';
import { isWorkspaceShell } from '../workspace-shell';
import { writeDiagnosticLog } from '../diagnostic-log';
import { DesktopService, type DesktopServiceOptions } from './service';
import { captureDesktopWindow } from './capture';
import { DesktopControlNotice } from './notice';

export function registerDesktop(options: Pick<DesktopServiceOptions, 'admission' | 'inputObserver'> = {}): DesktopService {
  let notice: DesktopControlNotice | undefined;
  let closing = false;
  let stopShortcutAvailable = false;
  const root = path.resolve(__dirname, '../../../public');
  const diagnostic = (event: string, message: string, error: unknown) => {
    try { writeDiagnosticLog('error', 'desktop', event, message, { error }); }
    catch { /* Diagnostic teardown must not interrupt the remaining cleanup. */ }
  };
  const trusted = (url: string) => {
    try {
      const source = path.resolve(fileURLToPath(url));
      return source === path.join(root, 'desktop.html') || source === path.join(root, 'desktop-control.html') || isWorkspaceShell(url, root);
    } catch { return false; }
  };
  const update = (status: DesktopStatus) => {
    if (closing) return;
    // Covered Chromium windows can throttle timers. Deliver control changes
    // directly to our local documents; polling remains a recovery fallback.
    try {
      for (const window of BrowserWindow.getAllWindows()) {
        try {
          if (!window.isDestroyed() && trusted(window.webContents.getURL())) window.webContents.send(DESKTOP_CHANGED, status);
        } catch { /* A renderer may finish closing during notification. */ }
      }
      if (status.session?.window.pid === process.pid) app.setAccessibilitySupportEnabled(true);
    } catch (error) { diagnostic('desktop.notice.unavailable', '桌面状态通知暂不可用。', error); }
    // Preparation owns construction. Ordinary state broadcasts cannot throw a
    // BrowserWindow/load error through an already executed action's receipt.
    try { notice?.update(status); }
    catch (error) { diagnostic('desktop.notice.unavailable', '桌面控制条状态更新失败。', error); }
  };
  const service = new DesktopService({ ...options, onChanged: update, capture: captureDesktopWindow, stopShortcutAvailable: () => stopShortcutAvailable,
    prepareControlNotice: signal => notice!.prepare(signal) });
  notice = new DesktopControlNotice({ file: path.join(root, 'desktop-control.html'), status: () => service.status(),
    onUnavailable: () => { service.noticeUnavailable(); }, onUserClose: () => { service.control('takeover'); },
    diagnostic: error => diagnostic('desktop.notice.unavailable', '桌面控制条已关闭或暂不可用。', error),
    create: () => {
      const area = screen.getPrimaryDisplay().workArea;
      const created = new BrowserWindow({ width: 390, height: 200, x: area.x + area.width - 406, y: area.y + 16,
        show: false, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
        title: 'ProfilePilot · 桌面控制', backgroundColor: '#ffffff',
        // Readiness and stop/takeover feedback must remain responsive while the
        // initially hidden toolbar is loading or another cloud window covers it.
        webPreferences: { preload: path.resolve(__dirname, '../../desktop-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      return created;
    } });
  ipcMain.handle(DESKTOP_CHANNEL, async (event, method: string, arg?: unknown) => {
    let source = '';
    try { source = path.resolve(fileURLToPath(event.senderFrame!.url)); } catch { /* rejected below */ }
    const toolbar = source === path.join(root, 'desktop-control.html');
    if (event.senderFrame !== event.sender.mainFrame || !toolbar && source !== path.join(root, 'desktop.html') && !isWorkspaceShell(event.senderFrame?.url || '', root)) throw new Error('桌面接口只能由 ProfilePilot 本地工作区调用。');
    const preparingControl = method === 'control' && (arg === 'stop' || arg === 'takeover');
    // Even a hidden, detached document must revoke itself before a later owner
    // can reuse it; nonce + exact WebContents still excludes old instances.
    if (toolbar && method === 'notice-unavailable') {
      const value = z.object({ documentNonce: z.string().uuid() }).strict().parse(arg);
      notice!.documentUnavailable(event.sender, value.documentNonce); return;
    }
    if (toolbar && !notice?.acceptsToolbar(event.sender, method !== 'status' && method !== 'notice-ready' && method !== 'notice-unavailable' && !preparingControl)) throw new Error('这个桌面控制条已失效，请从当前 ProfilePilot 工作区检查控制状态。');
    if (toolbar && method === 'notice-ready') {
      const value = z.object({ generation: z.string().min(1).max(128), documentNonce: z.string().uuid() }).strict().parse(arg);
      notice!.acknowledge(event.sender, value.generation, value.documentNonce); return;
    }
    if (method === 'status') return service.status();
    if (method === 'control') {
      // Stop/takeover revoke control even while preparation is incomplete.
      // Returning control grants it and must be bound to the displayed owner.
      const command = z.union([z.enum(['takeover', 'stop']), z.object({
        action: z.literal('return'), session: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
        generation: z.string().min(1).max(128), revision: z.number().int().nonnegative().safe()
      }).strict()]).parse(arg);
      if (typeof command === 'string') return service.control(command);
      const { action: _action, ...expected } = command;
      return service.resume(expected);
    }
    if (toolbar) throw new Error('控制条仅允许接管和停止。');
    if (method === 'windows') return service.windows();
    if (method === 'preview') return service.preview(z.string().regex(/^[a-f0-9]{32}$/).parse(arg));
    throw new Error('未知桌面操作。');
  });
  if (process.platform === 'win32' && process.env.CPM_ELECTRON_SMOKE_TEST !== '1') stopShortcutAvailable = globalShortcut.register('Control+Alt+Escape', () => service.control('stop'));
  app.once('will-quit', () => {
    closing = true;
    const current = notice; notice = undefined;
    try {
      try { void service.close().catch(error => diagnostic('desktop.shutdown.unconfirmed', '桌面驱动退出状态尚未确认。', error)); }
      catch (error) { diagnostic('desktop.shutdown.unconfirmed', '桌面驱动退出状态尚未确认。', error); }
      try { current?.close(); }
      catch (error) { diagnostic('desktop.notice.unavailable', '桌面控制条关闭状态尚未确认。', error); }
    } finally {
      try { globalShortcut.unregister('Control+Alt+Escape'); }
      catch (error) { diagnostic('desktop.shutdown.unconfirmed', '桌面停止快捷键注销状态尚未确认。', error); }
    }
  });
  return service;
}
