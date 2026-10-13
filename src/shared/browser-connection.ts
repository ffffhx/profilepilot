import type { CdpLiveView } from "./types";

export interface NativeBrowserState {
  taskTabs?: boolean;
  /** Extension worker identity plus its latest stop generation. */
  controlGeneration?: string;
  tabId?: number;
  pausedByBrowser?: boolean;
  profileId: string;
  connected: boolean;
  ownerSessionId?: string;
  ownership: "agent" | "user";
  tabTitle?: string;
  url?: string;
}

export interface BrowserConnectionSnapshot {
  nativeBrowsers: NativeBrowserState[];
  nativeInstallations: Array<{ profileId: string; stage: string; message: string }>;
}

export interface BrowserConnectionApi {
  snapshot(): Promise<BrowserConnectionSnapshot>;
  pairNativeBrowser(profileId: string): Promise<{ code: string; expiresAt: string }>;
  getNativeLiveView(profileId: string): Promise<CdpLiveView>;
  authorizeNativeBrowser(profileId: string): Promise<{ expiresAt: string }>;
  disconnectNativeBrowser(profileId: string): Promise<void>;
  openNativeExtensionFolder(): Promise<void>;
  onChanged(listener: (snapshot: BrowserConnectionSnapshot) => void): () => void;
}

export const BROWSER_CONNECTION_CHANNEL = "browser-connection:request";
export const BROWSER_CONNECTION_CHANGED = "browser-connection:changed";

declare global { interface Window { browserConnection: BrowserConnectionApi; } }
