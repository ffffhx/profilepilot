import path from "node:path";
import type { BrowserKind, StoredProfile } from "../shared/types";
import { browserMacAppName, normalizeBrowserKind, readBrowserMajorVersion } from "./chrome-launch";
import { exists, uniqueStrings } from "./fs-util";
import type { MigratedExtensionLaunchPlan } from "./internal-types";

export let cachedCanAutoLoadUnpackedExtensions: boolean | null = null;
const cachedAutoLoadByBrowserKind = new Map<BrowserKind, boolean>();

export async function canAutoLoadUnpackedExtensions(kind: BrowserKind = "chrome"): Promise<boolean> {
  const normalizedKind = normalizeBrowserKind(kind);
  if (normalizedKind === "chrome" && cachedCanAutoLoadUnpackedExtensions !== null) {
    return cachedCanAutoLoadUnpackedExtensions;
  }
  const cached = cachedAutoLoadByBrowserKind.get(normalizedKind);
  if (cached !== undefined) {
    return cached;
  }

  const detected = await detectAutoLoadUnpackedExtensionSupport(normalizedKind);
  cachedAutoLoadByBrowserKind.set(normalizedKind, detected);
  if (normalizedKind === "chrome") {
    cachedCanAutoLoadUnpackedExtensions = detected;
  }
  return detected;
}

export async function detectAutoLoadUnpackedExtensionSupport(kind: BrowserKind = "chrome"): Promise<boolean> {
  const normalizedKind = normalizeBrowserKind(kind);
  if (normalizedKind === "chromium") {
    return true;
  }

  const binaryOverride =
    normalizedKind === "edge"
      ? process.env.EDGE_BINARY
      : normalizedKind === "brave"
        ? process.env.BRAVE_BINARY
        : process.env.CHROME_BINARY;
  const launcherName = (binaryOverride ? path.basename(binaryOverride) : browserMacAppName(normalizedKind)).toLowerCase();

  if (launcherName.includes("chromium") || launcherName.includes("chrome for testing")) {
    return true;
  }

  const majorVersion = await readBrowserMajorVersion(normalizedKind);
  if (launcherName.includes("google chrome") || majorVersion !== null) {
    return majorVersion !== null ? majorVersion < 137 : false;
  }

  return true;
}

export async function getMigratedExtensionLaunchPlan(profile: StoredProfile): Promise<MigratedExtensionLaunchPlan> {
  const extensionPaths = uniqueStrings((profile.migratedExtensions || []).map((extension) => extension.path));
  const existingPaths: string[] = [];
  for (const extensionPath of extensionPaths) {
    if (await exists(path.join(extensionPath, "manifest.json"))) {
      existingPaths.push(extensionPath);
    }
  }

  if (!existingPaths.length) {
    return { launchArgs: [], runtimeLoadPaths: [] };
  }

  if (await canAutoLoadUnpackedExtensions(normalizeBrowserKind(profile.browserKind))) {
    return { launchArgs: [`--load-extension=${existingPaths.join(",")}`], runtimeLoadPaths: [] };
  }

  return { launchArgs: [], runtimeLoadPaths: existingPaths };
}
