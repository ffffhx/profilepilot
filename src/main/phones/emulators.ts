import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureEmulatorWindowVisible, ensureRunningEmulatorWindowVisible } from "./emulator-window";
import { androidSdkRoots } from "./android-paths";
import { TencentEmulator, TENCENT_EMULATOR } from "./tencent-emulator";

export interface EmulatorRuntime {
  list(): Promise<string[]>;
  launch(name: string): Promise<void>;
  ensureVisible(name: string, id: string): Promise<void>;
  connectLocal?(name: string): Promise<string | undefined>;
}

function placementError(error: unknown, fallback: string): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(/Access is denied|拒绝访问|访问被拒绝/i.test(reason)
    ? "Windows 阻止了窗口归位。模拟器可能以管理员权限运行，请关闭它，再从普通权限的 ProfilePilot 启动。"
    : fallback, { cause: error });
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
  private tencent = new TencentEmulator();
  constructor(private overrideExecutable?: string, private fitWindow = ensureEmulatorWindowVisible,
    private fitRunningWindow = ensureRunningEmulatorWindowVisible) {}
  private get executable(): string { return this.overrideExecutable || findEmulator(); }
  async list(): Promise<string[]> {
    const tencent = !this.overrideExecutable && await this.tencent.executable() ? [TENCENT_EMULATOR] : [];
    return new Promise((resolve, reject) => {
      execFile(this.executable, ["-list-avds"], { windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          if (tencent.length) resolve(tencent);
          else reject(new Error(error.code === "ENOENT" ? "尚未安装 Android 模拟器，请在“创建新设备”中安装环境。" : "无法读取模拟器列表，请检查 Android 环境后重试。"));
          return;
        }
        resolve([...new Set([...stdout.split(/\r?\n/).map(name => name.trim()).filter(name => /^[\w.-]{1,200}$/.test(name)), ...tencent])]);
      });
    });
  }
  async connectLocal(name: string): Promise<string | undefined> {
    return name === TENCENT_EMULATOR && !this.overrideExecutable ? this.tencent.connect() : undefined;
  }
  async launch(name: string): Promise<void> {
    // Only launch a configured AVD; never interpret a device name as shell code.
    if (!(await this.list()).includes(name)) throw new Error("模拟器不存在，请重新选择虚拟设备。");
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ppilot-emulator-")), "startup.log");
    const output = fs.openSync(log, "w");
    let pid: number;
    try {
      pid = await new Promise<number>((resolve, reject) => {
        // On Windows DETACHED_PROCESS leaves the launcher without a console, so
        // its QEMU child opens a new terminal. Let QEMU inherit the launcher's
        // hidden console instead; keep the detached session on macOS/Linux.
        const child = spawn(this.executable, ["-avd", name], { detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", output, output], shell: false });
        child.once("error", () => reject(new Error(`模拟器启动失败，请检查启动日志：${log}`)));
        child.once("spawn", () => { child.unref(); resolve(child.pid!); });
      });
    } finally { fs.closeSync(output); }
    // Keep the emulator alive on failure, but don't report a clipped preview as ready.
    try { await this.fitWindow(pid, name); }
    catch (error) { throw placementError(error, `未能确认模拟器窗口完整可见。若模拟器仍在运行，请再次使用“启动 / 连接模拟器”自动归位；若已退出，请检查启动日志：${log}`); }
  }
  async ensureVisible(name: string, id: string): Promise<void> {
    try { await this.fitRunningWindow(name, id); }
    catch (error) { throw placementError(error, "未能将模拟器窗口移回屏幕内。请结束拖拽后，再次使用“启动 / 连接模拟器”。"); }
  }
}
