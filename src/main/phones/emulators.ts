import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureEmulatorWindowVisible } from "./emulator-window";
import { androidSdkRoots } from "./android-paths";

export interface EmulatorRuntime {
  list(): Promise<string[]>;
  launch(name: string): Promise<void>;
}

export function findEmulator(env = process.env, platform = process.platform): string {
  if (env.PROFILEPILOT_EMULATOR_PATH) return env.PROFILEPILOT_EMULATOR_PATH;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "emulator.exe" : "emulator";
  const roots = androidSdkRoots(env, platform);
  for (const root of roots) if (root && fs.existsSync(paths.join(root, "emulator", executable))) return paths.join(root, "emulator", executable);
  return executable;
}

export class AndroidEmulators implements EmulatorRuntime {
  constructor(private overrideExecutable?: string, private fitWindow = ensureEmulatorWindowVisible) {}
  private get executable(): string { return this.overrideExecutable || findEmulator(); }
  list(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(this.executable, ["-list-avds"], { windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(new Error(error.code === "ENOENT" ? "尚未安装 Android 模拟器，请在“创建新设备”中安装环境。" : "无法读取模拟器列表，请检查 Android 环境后重试。")); return; }
        resolve([...new Set(stdout.split(/\r?\n/).map(name => name.trim()).filter(name => /^[\w.-]{1,200}$/.test(name)))]);
      });
    });
  }
  async launch(name: string): Promise<void> {
    // Only launch a configured AVD; never interpret a device name as shell code.
    if (!(await this.list()).includes(name)) throw new Error("模拟器不存在，请重新选择虚拟设备。");
    const pid = await new Promise<number>((resolve, reject) => {
      const child = spawn(this.executable, ["-avd", name], { detached: true, windowsHide: true, stdio: "ignore", shell: false });
      child.once("error", () => reject(new Error("模拟器启动失败，请在 Android Studio 的 Device Manager 中检查虚拟设备。")));
      child.once("spawn", () => { child.unref(); resolve(child.pid!); });
    });
    // A window placement failure must not discard an otherwise usable emulator.
    await this.fitWindow(pid, name).catch(() => console.warn("Could not fit the Android emulator window to the desktop."));
  }
}
