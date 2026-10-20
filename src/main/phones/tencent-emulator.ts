import fs from "node:fs";
import path from "node:path";
import { getWindowsSystemSnapshot, runWindowsPowerShell } from "../windows-platform";
import { ensureTencentEmulatorWindowVisible } from "./emulator-window";

export const TENCENT_EMULATOR = "Tencent_GameLoop";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Tencent's installed Windows engine; never creates an SDK AVD or alters its data. */
export class TencentEmulator {
  constructor(private platform = process.platform, private powershell = runWindowsPowerShell,
    private fitWindow = ensureTencentEmulatorWindowVisible, private snapshot = getWindowsSystemSnapshot) {}
  async executable(): Promise<string | undefined> {
    if (this.platform !== "win32") return undefined;
    const directory = (await this.powershell(String.raw`
$key = 'HKLM:\SOFTWARE\WOW6432Node\Tencent\MobileGamePC\UI'
if (Test-Path -LiteralPath $key) { (Get-ItemProperty -LiteralPath $key).InstallPath }
`, { timeout: 5000 })).trim();
    if (!directory || !path.win32.isAbsolute(directory)) return undefined;
    const file = path.win32.join(directory, "AndroidEmulator.exe");
    return fs.existsSync(file) ? file : undefined;
  }
  private async running(executable: string): Promise<{ pid: number; port: number } | undefined> {
    // The shared reader uses QUERY_LIMITED_INFORMATION when CIM hides elevated
    // image paths. A process name alone never establishes the emulator identity.
    const system = await this.snapshot(true);
    if (system.processesAvailable === false || system.tcpAvailable === false) throw new Error("无法检查本机模拟器进程和连接");
    const engines = system.processes.filter(p => p.executablePath?.toLowerCase() === executable.toLowerCase()
      && (!/\s-vm\s/.test(p.commandLine) || /\s-vm\s+100(?:\s|$)/.test(p.commandLine)));
    const ports = system.tcp.filter(t => t.state === "Listen" && t.localPort === 5555 && ["0.0.0.0", "127.0.0.1", "::"].includes(t.localAddress));
    const listeners = engines.filter(p => ports.some(t => t.pid === p.pid));
    if (listeners.length > 1) throw new Error("发现多个手游助手引擎，请先选择要连接的实例");
    if (listeners.length) return { pid: listeners[0].pid, port: 5555 };
    if (ports.length) throw new Error("本机 5555 端口属于其他进程，未连接到该设备");
    return engines.length ? { pid: engines[0].pid, port: 0 } : undefined;
  }
  async connect(): Promise<string> {
    const executable = await this.executable();
    if (!executable) throw new Error("未找到已安装的腾讯手游助手");
    let running = await this.running(executable);
    if (!running) {
      // Tencent declares requireAdministrator. Use Windows consent rather than
      // elevating ProfilePilot or disabling UAC; ShellExecute also detaches it.
      await this.powershell(`
$ErrorActionPreference = 'Stop'
Start-Process -FilePath ${quote(executable)} -ArgumentList '-vm','100' -WorkingDirectory ${quote(path.win32.dirname(executable))} -Verb RunAs -WindowStyle Hidden
`, { timeout: 60000, maxBuffer: 4096 }).catch(error => {
        throw new Error("手游助手需要 Windows 管理员授权。请确认系统授权弹窗后重试。", { cause: error });
      });
    }
    const deadline = Date.now() + 90000;
    while (!running?.port) {
      if (Date.now() >= deadline) throw new Error("手游助手调试连接尚未就绪。请检查引擎设置中的 adb 调试选项。");
      await new Promise(resolve => setTimeout(resolve, 1000));
      running = await this.running(executable);
    }
    await this.fitWindow(running.pid);
    // This listener was verified to belong to the selected local engine.
    return `127.0.0.1:${running.port}`;
  }
}
