import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAdb } from "./adb";

export interface EmulatorRuntime {
  list(): Promise<string[]>;
  launch(name: string): Promise<void>;
}

export function findEmulator(env = process.env, platform = process.platform): string {
  if (env.PROFILEPILOT_EMULATOR_PATH) return env.PROFILEPILOT_EMULATOR_PATH;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "emulator.exe" : "emulator";
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    platform === "win32" ? paths.join(env.LOCALAPPDATA || paths.join(os.homedir(), "AppData", "Local"), "Android", "Sdk")
      : platform === "darwin" ? paths.join(os.homedir(), "Library", "Android", "sdk") : paths.join(os.homedir(), "Android", "Sdk")];
  if (env.PROFILEPILOT_ADB_PATH) roots.unshift(paths.dirname(paths.dirname(findAdb(env, platform))));
  for (const root of roots) if (root && fs.existsSync(paths.join(root, "emulator", executable))) return paths.join(root, "emulator", executable);
  return executable;
}

export class AndroidEmulators implements EmulatorRuntime {
  constructor(private executable = findEmulator()) {}
  list(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(this.executable, ["-list-avds"], { windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(new Error(error.code === "ENOENT" ? "未找到 Android 模拟器。请先在 Android Studio 的 Device Manager 中安装并创建虚拟设备。" : "无法读取模拟器列表，请在 Android Studio 的 Device Manager 中检查虚拟设备。")); return; }
        resolve([...new Set(stdout.split(/\r?\n/).map(name => name.trim()).filter(name => /^[\w.-]{1,200}$/.test(name)))]);
      });
    });
  }
  async launch(name: string): Promise<void> {
    // Only launch a configured AVD; never interpret a device name as shell code.
    if (!(await this.list()).includes(name)) throw new Error("模拟器不存在，请重新选择虚拟设备。");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, ["-avd", name], { detached: true, windowsHide: true, stdio: "ignore", shell: false });
      child.once("error", () => reject(new Error("模拟器启动失败，请在 Android Studio 的 Device Manager 中检查虚拟设备。")));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}
