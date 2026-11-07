export const DESKTOP_CHANNEL = 'desktop:request';
export const DESKTOP_CHANGED = 'desktop:changed';
export interface DesktopWindow {
  id: string; title: string; process: string; pid: number; className: string; nativeHandle?: string;
  /** Fresh catalog samples; ownership is a Win32 window relation, not control permission or proof of modality. */
  enabled?: boolean; minimized?: boolean; ownerNativeHandle?: string | null;
}
export interface DesktopWindowList { windows: DesktopWindow[]; truncated?: boolean; gaps?: string[]; }
export interface DesktopImage {
  mimeType: string; data: string; width: number; height: number; windowWidth: number; windowHeight: number;
  windowX?: number; windowY?: number; coordinateInputAvailable?: boolean; source?: string;
  physicalPixelsAvailable?: boolean;
  captureRect?: { x: number; y: number; width: number; height: number };
  captureFallback?: string | null;
  captureState?: {
    visible: boolean; minimized: boolean; cloaked: boolean | null; dpi: number | null;
    displayAffinity: number | null; displayAffinityError: number | null;
    protectionStatus: 'none' | 'protected' | 'unknown';
    windowRect: { x: number; y: number; width: number; height: number };
    clientRect: { x: number; y: number; width: number; height: number };
  };
  captureDiagnostics?: {
    status: string; geometryStatus: string; colorMode: string;
    contentWidth: number; contentHeight: number; frameTimestampTicks: string; elapsedMs: number;
    candidateCaptureRect?: { X: number; Y: number; Width: number; Height: number } | null;
  };
}
export interface DesktopObservation {
  windowId: string; version: string; truncated: boolean; image: DesktopImage | null;
  gaps?: string[];
  elements: Array<{
    reference: string; name: string; role: string; text: string; actions: string[]; password: boolean; bounds?: number[] | null;
    automationId?: string; enabled?: boolean; offscreen?: boolean; focused?: boolean; parent?: number;
    truncatedFields?: Array<'name' | 'automationId' | 'text'>;
    textStatus?: 'readable' | 'unsupported' | 'redacted' | 'unavailable' | 'truncated';
    textSource?: 'value' | 'text_pattern' | 'none';
    state?: {
      valueStatus: 'unsupported' | 'readable' | 'redacted' | 'unavailable'; readOnly: boolean | null;
      /** Evidence for a readable Value; TextPattern remains a separate source. */
      valueEvidence?: 'value' | 'value_and_text' | 'unconfirmed';
      toggleStatus: 'unsupported' | 'readable' | 'unavailable'; toggle: 0 | 1 | 2 | null;
      selectionStatus: 'unsupported' | 'readable' | 'unavailable'; selected: boolean | null;
      expandCollapseStatus: 'unsupported' | 'readable' | 'unavailable'; expanded: 0 | 1 | 2 | 3 | null;
      /** WindowPattern evidence collected with this selected root's snapshot. State does not grant foreground input. */
      window?: {
        status: 'unsupported' | 'readable' | 'unavailable';
        visualState: 'normal' | 'maximized' | 'minimized' | null;
        canMinimize: boolean | null; canMaximize: boolean | null; isModal: boolean | null;
        interactionState: 0 | 1 | 2 | 3 | 4 | null; nativeHandle: string | null;
      };
    };
    stateGaps?: string[];
  }>;
}
export interface DesktopStatus {
  supported: boolean; available: boolean; platform: string; reason?: string;
  stopShortcutAvailable: boolean;
  inputObservation: {
    available: boolean; phase: 'idle' | 'arming' | 'ready' | 'pending' | 'paused' | 'unavailable';
    generation?: string; epoch?: string; reason?: string; message?: string; certainty?: 'observed' | 'unknown';
    unobservedTestDriver?: true;
  };
  session: null | { name: string; window: DesktopWindow; state: 'active' | 'paused'; expiresAt: number; revision: number; };
}
/** Bind the user's return click to the exact state displayed in that document. */
export interface DesktopReturnExpectation { session: string; generation: string; revision: number; }
export interface DesktopApi {
  status(): Promise<DesktopStatus>;
  /** Sandboxed toolbar only: acknowledge handlers and first state render. */
  noticeReady?(generation: string): Promise<void>;
  /** Sandboxed toolbar only: permanently revoke its own document readiness. */
  noticeFailed?(): void;
  windows(): Promise<DesktopWindowList>;
  preview(windowId: string): Promise<DesktopObservation>;
  control(action: 'return', expected: DesktopReturnExpectation): Promise<DesktopStatus>;
  control(action: 'takeover' | 'stop'): Promise<DesktopStatus>;
  onChanged(listener: (status: DesktopStatus) => void): () => void;
}
declare global { interface Window { desktopControl: DesktopApi; } }
