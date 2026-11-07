export const GPUI_CHANNEL = 'profilepilot:gpui';
export const GPUI_CHANGED = 'profilepilot:gpui-changed';
export interface GpuiApp { target_id: string; app_id: string; app_name: string; pid: number; capabilities?: unknown; }
export interface GpuiSession {
  name: string; app: GpuiApp; state: 'preparing' | 'active' | 'paused'; revision: number;
  reason?: string; lastUsed: number; inputGuard: 'arming' | 'active' | 'unavailable';
  indicator?: 'embedded' | 'unavailable';
  indicatorReason?: string;
  /** Identifies this pause only; changes on every takeover and service restart. */
  pauseId?: string;
}
export interface GpuiStatus { backend: string | null; sessions: GpuiSession[]; }
export interface GpuiApi {
  ready(): Promise<void>;
  status(): Promise<GpuiStatus>;
  apps(): Promise<{ apps: GpuiApp[] }>;
  configure(): Promise<GpuiStatus | null>;
  control(action: 'takeover' | 'return' | 'stop', session: string, revision: number): Promise<GpuiStatus>;
  onChanged(listener: (status: GpuiStatus) => void): () => void;
}
declare global { interface Window { gpuiControl: GpuiApi; } }
