import { Menu, nativeImage, Tray } from 'electron';
import type { GpuiStatus } from '../../shared/gpui';

interface NoticeOptions {
  icon: string; status(): GpuiStatus; openPanel(): Promise<void>;
  pauseAll(reason: string): void; stopAll(): Promise<void>;
}

/** Controls live in the existing workspace and tray, never a separate window. */
export class GpuiControlNotice {
  private tray?: Tray;
  private closed = false;
  constructor(private options: NoticeOptions) {}
  async prepare(): Promise<void> {
    if (this.closed) throw new Error('GPUI 控制已关闭。');
    if (!this.options.status().sessions.length) throw new Error('当前没有 GPUI 控制会话。');
    if (this.tray && !this.tray.isDestroyed()) return;
    const source = nativeImage.createFromPath(this.options.icon);
    if (source.isEmpty()) throw new Error('GPUI 托盘图标不可用。');
    const size = process.platform === 'darwin' ? 18 : 20;
    this.tray = new Tray(source.resize({ width: size, height: size }));
    this.tray.on('click', () => this.openPanel());
    this.update(this.options.status());
  }
  private openPanel() {
    void this.options.openPanel().catch(() => this.options.pauseAll('GPUI 管理页无法打开，已暂停。'));
  }
  update(state: GpuiStatus) {
    if (!state.sessions.length) { this.dispose(); return; }
    if (!this.tray || this.tray.isDestroyed()) return;
    const active = state.sessions.filter(item => item.state === 'active').length;
    this.tray.setToolTip(`ProfilePilot · GPUI：${active} 个运行中，${state.sessions.length - active} 个暂停或准备中`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 GPUI 应用页', click: () => this.openPanel() },
      { type: 'separator' },
      { label: '暂停全部 GPUI 会话', enabled: state.sessions.some(item => item.state !== 'paused'), click: () => this.options.pauseAll('用户从托盘暂停。') },
      { label: '停止全部 GPUI 会话', click: () => {
        void this.options.stopAll().catch(() => { this.options.pauseAll('停止未完成，请在 GPUI 应用页检查。'); this.openPanel(); });
      } }
    ]));
  }
  private dispose() { const tray = this.tray; this.tray = undefined; if (tray && !tray.isDestroyed()) tray.destroy(); }
  close() { this.closed = true; this.dispose(); }
}
