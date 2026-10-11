import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function androidSdkRoots(env = process.env, platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const standard = platform === "win32" ? p.join(env.LOCALAPPDATA || p.join(os.homedir(), "AppData", "Local"), "Android", "Sdk")
    : platform === "darwin" ? p.join(os.homedir(), "Library", "Android", "sdk") : p.join(os.homedir(), "Android", "Sdk");
  const fromPath = (env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").flatMap(dir => {
    const clean = dir.replace(/^"|"$/g, "");
    const name = p.basename(clean).toLowerCase();
    return ["platform-tools", "emulator"].includes(name) && fs.existsSync(p.join(clean, (name === "emulator" ? "emulator" : "adb") + (platform === "win32" ? ".exe" : ""))) ? [p.dirname(clean)] : [];
  });
  return [...new Set([env.PROFILEPILOT_ADB_PATH ? p.dirname(p.dirname(env.PROFILEPILOT_ADB_PATH)) : "", env.ANDROID_HOME, env.ANDROID_SDK_ROOT, standard, ...fromPath].filter((v): v is string => !!v))];
}
export function setupSdkRoot(env = process.env, platform = process.platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const roots = androidSdkRoots(env, platform);
  // A standalone platform-tools folder (for example WinGet) is not an SDK install location.
  return roots.find(root => ["emulator", "cmdline-tools"].some(dir => fs.existsSync(p.join(root, dir))))
    || env.ANDROID_HOME || env.ANDROID_SDK_ROOT || androidSdkRoots({ ...env, PROFILEPILOT_ADB_PATH: undefined, PATH: "", Path: "" }, platform)[0];
}
export function androidAvdHome(env = process.env): string {
  return env.ANDROID_AVD_HOME || path.join(env.ANDROID_EMULATOR_HOME || env.ANDROID_USER_HOME || path.join(os.homedir(), ".android"), "avd");
}
