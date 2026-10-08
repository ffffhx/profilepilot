import { deviceShell, type AdbRunner } from "./adb";

export type DebugSetting = "enabled" | "disabled" | "unconfirmed";
export type DebugSettings = { developerOptions: DebugSetting; usbDebugging: DebugSetting; wirelessDebugging: DebugSetting };

/** Fixed, read-only setup checks, run through the same managed ADB connection. */
export async function readDebugSettings(adb: AdbRunner, id: string): Promise<DebugSettings> {
  const keys = ["development_settings_enabled", "adb_enabled", "adb_wifi_enabled"];
  const readings = await Promise.allSettled(keys.map(async key => adb.run(["-s", id, "shell", deviceShell(["settings", "get", "global", key])], 1500)));
  const states = readings.map((result): DebugSetting => {
    if (result.status !== "fulfilled") return "unconfirmed";
    const value = result.value.trim();
    return value === "1" ? "enabled" : value === "0" ? "disabled" : "unconfirmed";
  });
  return { developerOptions: states[0], usbDebugging: states[1], wirelessDebugging: states[2] };
}
