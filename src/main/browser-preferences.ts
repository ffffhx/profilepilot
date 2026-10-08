// Keep the original browser-only IPC contract for existing callers.
import { readControlPreferences, writeControlPreferences } from "./control-preferences";
import type { BrowserPreferencesUpdate } from "../shared/browser-preferences";

export const readBrowserPreferences = (homeDir?: string) => readControlPreferences("browser", homeDir);
export const writeBrowserPreferences = (request: BrowserPreferencesUpdate, homeDir?: string) =>
  writeControlPreferences({ ...request, domain: "browser" }, homeDir);
