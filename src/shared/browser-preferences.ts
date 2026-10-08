export interface BrowserPreferencesSnapshot {
  content: string;
  revision: string;
  exists: boolean;
  path: string;
  locations: Array<{ label: string; path: string }>;
  differs: boolean;
}

export interface BrowserPreferencesUpdate {
  content: string;
  expectedRevision: string;
  syncAll: boolean;
}
