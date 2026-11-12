export const APP_UPDATE_CHANNEL = 'profilepilot:app-update';
export interface AppUpdateState {
  channel: 'development' | 'stable';
  version: string;
  commit: string;
  phase: 'development' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  nextVersion?: string;
  notes?: string;
  percent?: number;
  error?: string;
}
export interface AppUpdateApi {
  status(): Promise<AppUpdateState>;
  open(): Promise<void>;
}
declare global { interface Window { appUpdate: AppUpdateApi; } }
