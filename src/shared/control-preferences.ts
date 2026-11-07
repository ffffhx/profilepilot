import type { BrowserPreferencesSnapshot, BrowserPreferencesUpdate } from "./browser-preferences";

export type ControlPreferencesDomain = "browser" | "electron" | "phone";
export interface ControlPreferencesSnapshot extends BrowserPreferencesSnapshot {
  domain: ControlPreferencesDomain;
  /** Showing the Skill's generic default because no personal file exists yet. */
  defaulted: boolean;
}
export interface ControlPreferencesUpdate extends BrowserPreferencesUpdate {
  domain: ControlPreferencesDomain;
}
export interface ControlPreferencesEditor {
  loading: boolean;
  saving: boolean;
  draft: string;
  snapshot: ControlPreferencesSnapshot | null;
  syncAll: boolean;
  error: string | null;
}
