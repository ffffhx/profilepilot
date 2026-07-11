import path from "node:path";
import type { StoredProfile } from "../shared/types";
import { readChromeMajorVersion } from "./chrome-launch";
import { exists, uniqueStrings } from "./fs-util";
import type { MigratedExtensionLaunchPlan } from "./internal-types";

export let cachedCanAutoLoadUnpackedExtensions: boolean | null = null;

export async function canAutoLoadUnpackedExtensions(): Promise<boolean> {
  if (cachedCanAutoLoadUnpackedExtensions !== null) {
    return cachedCanAutoLoadUnpackedExtensions;
  }

  cachedCanAutoLoadUnpackedExtensions = await detectAutoLoadUnpackedExtensionSupport();
  return cachedCanAutoLoadUnpackedExtensions;
}

export async function detectAutoLoadUnpackedExtensionSupport(): Promise<boolean> {
  const launcherName = (process.env.CHROME_BINARY
    ? path.basename(process.env.CHROME_BINARY)
    : process.env.CHROME_APP_NAME || "Google Chrome"
  ).toLowerCase();

  if (launcherName.includes("chromium") || launcherName.includes("chrome for testing")) {
    return true;
  }

  const majorVersion = await readChromeMajorVersion();
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

  if (await canAutoLoadUnpackedExtensions()) {
    return { launchArgs: [`--load-extension=${existingPaths.join(",")}`], runtimeLoadPaths: [] };
  }

  return { launchArgs: [], runtimeLoadPaths: existingPaths };
}
