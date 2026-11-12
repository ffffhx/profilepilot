import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_UPDATE_CHANNEL } from '../shared/app-update';
import { AppUpdateManager } from './app-update-manager';
import { ManualMacUpdater } from './manual-mac-update';

let manager: AppUpdateManager | undefined;
let opening: Promise<void> | undefined;
let manualMac: ManualMacUpdater | undefined;
export function finishRequestedAppUpdate(clean: boolean): boolean {
  if (!clean || !manager?.installRequested) return false;
  manager.finishInstall();
  return true;
}
export function initializeAppUpdates(): void {
  let commit = '';
  try { commit = JSON.parse(readFileSync(path.join(__dirname, 'build-channel.json'), 'utf8')).commit || ''; } catch { /* Old/local build. */ }
  if (app.isPackaged && process.platform === 'darwin') manualMac = new ManualMacUpdater(app.getVersion(), path.join(app.getPath('userData'), 'updates'));
  const updater = app.isPackaged ? manualMac || require('electron-updater').autoUpdater : undefined;
  manager = new AppUpdateManager(app.getVersion(), commit, updater, state => {
    for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(state.phase === 'downloading' ? (state.percent || 0) / 100 : -1);
  });
  ipcMain.handle(APP_UPDATE_CHANNEL, async (_event, action: string) => {
    if (action === 'status') return { ...manager!.state };
    if (action === 'open') {
      return showUpdates();
    }
    throw new Error('不支持的更新操作');
  });
  if (!updater) return;
  let lastNotified = '';
  const check = async () => {
    const state = await manager!.check();
    if (state.phase === 'available' && state.nextVersion !== lastNotified && Notification.isSupported()) {
      lastNotified = state.nextVersion || '';
      const notice = new Notification({ title: `ProfilePilot ${state.nextVersion} 已发布`, body: '点击查看更新内容，由你选择下载安装时间。' });
      notice.on('click', () => { void showUpdates(); });
      notice.show();
    }
  };
  const startup = setTimeout(() => void check(), 15_000);
  const timer = setInterval(() => void check(), 4 * 60 * 60 * 1000);
  startup.unref(); timer.unref();
  app.once('before-quit', () => { clearTimeout(startup); clearInterval(timer); });
}

function showUpdates(): Promise<void> {
  if (!opening) opening = openUpdates().catch(async error => {
    await dialog.showMessageBox({type: 'error', title: 'ProfilePilot 更新', message: '更新未完成', detail: error instanceof Error ? error.message : String(error)});
  }).finally(() => { opening = undefined; });
  return opening;
}

async function openUpdates(): Promise<void> {
  let state = manager!.state;
  if (state.channel === 'development') {
    await dialog.showMessageBox({ type: 'info', title: 'ProfilePilot 开发版', message: `开发版 ${state.version}${state.commit ? ` · ${state.commit.slice(0, 8)}` : ''}`,
      detail: '此版本使用本地代码。通过开发启动更新界面、CLI 和后台，不安装线上正式版。', buttons: ['知道了'] });
    return;
  }
  if (!['available', 'downloaded', 'downloading'].includes(state.phase)) state = await manager!.check();
  if (state.phase === 'available') {
    const result = await dialog.showMessageBox({ type: 'info', title: 'ProfilePilot 更新', message: `发现新版本 ${state.nextVersion}`,
      detail: (state.notes || '包含最新功能和修复。').slice(0, 12000), buttons: ['下载更新', '稍后'], defaultId: 0, cancelId: 1 });
    if (result.response !== 0) return;
    state = await manager!.download();
  }
  if (state.phase === 'downloaded') {
    if (manualMac) {
      const result = await dialog.showMessageBox({type: 'info', title: '安装包已下载并校验', message: '打开 ProfilePilot 安装包？',
        detail: '退出当前 App 后，将新版拖到“应用程序”并替换旧版。个人配置会保留。', buttons: ['打开安装包', '稍后'], cancelId: 1});
      if (result.response === 0) await manualMac.openInstaller();
      return;
    }
    const result = await dialog.showMessageBox({ type: 'info', title: '更新已下载', message: '安装更新并重启 ProfilePilot？',
      detail: '将先保存状态并结束当前控制连接。你也可以稍后再安装。', buttons: ['安装并重启', '稍后'], defaultId: 1, cancelId: 1 });
    if (result.response === 0 && manager!.requestInstall()) app.quit();
  } else if (state.phase === 'idle' || state.phase === 'error') {
    await dialog.showMessageBox({ type: state.error ? 'error' : 'info', title: 'ProfilePilot 更新',
      message: state.error ? '更新未完成' : `当前已是最新版本 ${state.version}`, detail: state.error || '', buttons: ['关闭'] });
  }
}
