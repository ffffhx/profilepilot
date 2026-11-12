import type { AppUpdateState } from '../shared/app-update';

export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(name: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, restart?: boolean): void;
}

/** No updater is constructed in a development run. Downloads and installs need an explicit user action. */
export class AppUpdateManager {
  state: AppUpdateState;
  private pending?: Promise<AppUpdateState>;
  installRequested = false;
  constructor(version: string, commit: string, private readonly updater?: UpdateAdapter,
    private readonly changed: (state: AppUpdateState) => void = () => {}) {
    this.state = { channel: updater ? 'stable' : 'development', version, commit, phase: updater ? 'idle' : 'development' };
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on('update-available', info => this.set({ phase: 'available', nextVersion: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes || []).map((note: { note: string }) => note.note).join('\n') }));
    updater.on('update-not-available', () => this.set({ phase: 'idle', nextVersion: undefined, notes: undefined }));
    updater.on('download-progress', progress => this.set({ phase: 'downloading', percent: progress.percent }));
    updater.on('update-downloaded', () => this.set({ phase: 'downloaded', percent: 100 }));
    updater.on('error', error => this.set({ phase: 'error', error: error.message || String(error) }));
  }
  private set(patch: Partial<AppUpdateState>): void { this.state = { ...this.state, error: undefined, ...patch }; this.changed({ ...this.state }); }
  private run(action: () => Promise<unknown>): Promise<AppUpdateState> {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(action).catch(error => this.set({ phase: 'error', error: error.message || String(error) }))
      .then(() => ({ ...this.state })).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  check(): Promise<AppUpdateState> {
    if (!this.updater || ['downloading', 'downloaded', 'installing'].includes(this.state.phase)) return Promise.resolve({ ...this.state });
    return this.run(() => { this.set({ phase: 'checking' }); return this.updater!.checkForUpdates(); });
  }
  download(): Promise<AppUpdateState> {
    if (!this.updater || !['available', 'error'].includes(this.state.phase) || !this.state.nextVersion) return Promise.resolve({ ...this.state });
    return this.run(() => { this.set({ phase: 'downloading', percent: 0 }); return this.updater!.downloadUpdate(); });
  }
  requestInstall(): boolean {
    if (!this.updater || this.state.phase !== 'downloaded') return false;
    this.installRequested = true;
    this.set({ phase: 'installing' });
    return true;
  }
  /** Called only after the application's asynchronous shutdown has completed successfully. */
  finishInstall(): void {
    if (!this.installRequested || !this.updater) throw new Error('没有已确认安装的更新');
    this.updater.quitAndInstall(false, true);
  }
}
