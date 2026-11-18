import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getWindowsSystemSnapshot, runWindowsPowerShell } from "../windows-platform";
import { ensureTencentEmulatorWindowVisible, type EmulatorWindowPlacementResult } from "./emulator-window";
import { ensureTencentMemoryAvailable } from "./emulator-memory";

export const TENCENT_EMULATOR = "Tencent_GameLoop";
const REGISTRY_KEY = "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\MobileGamePC\\UI";
const CACHE_TTL_MS = 30000;
const ELEVATED_PLACEMENT_WARNING = "模拟器正以管理员权限运行，窗口已在屏幕内可见，已跳过自动缩放归位。";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function parseTencentRegistryOutput(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*InstallPath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line);
    if (match) return match[1].trim();
  }
  return undefined;
}

function defaultRegQuery(): Promise<string> {
  return new Promise(resolve => {
    execFile("reg.exe", ["query", REGISTRY_KEY, "/v", "InstallPath"], { windowsHide: true, timeout: 3000, maxBuffer: 16 * 1024, encoding: "buffer" }, (error, stdout) => {
      if (error || !stdout?.length) { resolve(""); return; }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
      catch {
        try { text = new TextDecoder("gb18030").decode(stdout); }
        catch { text = stdout.toString("utf8"); }
      }
      resolve(parseTencentRegistryOutput(text) || "");
    });
  });
}

/** Tencent's installed Windows engine; never creates an SDK AVD or alters its data. */
export class TencentEmulator {
  private cachedDirectory?: { value: string; at: number };
  private lastPlacement?: EmulatorWindowPlacementResult;

  constructor(
    private platform = process.platform,
    private powershell?: typeof runWindowsPowerShell,
    private fitWindow: (pid: number, platform?: NodeJS.Platform) => Promise<EmulatorWindowPlacementResult | void> = ensureTencentEmulatorWindowVisible,
    private snapshot = getWindowsSystemSnapshot,
    private checkMemory = ensureTencentMemoryAvailable,
    private queryRegistry: () => Promise<string> = defaultRegQuery
  ) {}

  consumePlacementWarning(): EmulatorWindowPlacementResult | undefined {
    const result = this.lastPlacement;
    this.lastPlacement = undefined;
    return result?.elevatedWindowPlacementSkipped ? result : undefined;
  }

  async executable(): Promise<string | undefined> {
    if (this.platform !== "win32") return undefined;
    let directory: string;
    if (this.powershell) {
      directory = (await this.powershell(String.raw`
$key = 'HKLM:\SOFTWARE\WOW6432Node\Tencent\MobileGamePC\UI'
if (Test-Path -LiteralPath $key) { (Get-ItemProperty -LiteralPath $key).InstallPath }
`, { timeout: 5000 })).trim();
    } else {
      const now = Date.now();
      if (!this.cachedDirectory || now - this.cachedDirectory.at > CACHE_TTL_MS) {
        this.cachedDirectory = { value: (await this.queryRegistry()).trim(), at: now };
      }
      directory = this.cachedDirectory.value;
    }
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
    this.lastPlacement = undefined;
    const executable = await this.executable();
    if (!executable) throw new Error("未找到已安装的腾讯手游助手");
    let running = await this.running(executable);
    const runPs = this.powershell ?? runWindowsPowerShell;
    if (!running) {
      await this.checkMemory();
      // Try normal medium-integrity launch first to avoid UIPI mismatch; fall back to
      // Windows UAC RunAs consent only when the binary explicitly requires elevation (Win32 740).
      await runPs(`
$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath ${quote(executable)} -ArgumentList '-vm','100' -WorkingDirectory ${quote(path.win32.dirname(executable))} -WindowStyle Hidden
} catch {
  $win32 = if ($_.Exception -is [ComponentModel.Win32Exception]) { $_.Exception } elseif ($_.Exception.InnerException -is [ComponentModel.Win32Exception]) { $_.Exception.InnerException } else { $null }
  if (($win32 -and $win32.NativeErrorCode -eq 740) -or $_.FullyQualifiedErrorId -match 'ElevationRequired' -or $_.Exception.Message -match 'elevation|740|需要提升|管理员') {
    Start-Process -FilePath ${quote(executable)} -ArgumentList '-vm','100' -WorkingDirectory ${quote(path.win32.dirname(executable))} -Verb RunAs -WindowStyle Hidden
  } else {
    throw
  }
}
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
    try {
      const placement = await this.fitWindow(running.pid);
      if (placement && placement.elevatedWindowPlacementSkipped) {
        this.lastPlacement = placement;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/Access is denied|拒绝访问|访问被拒绝/i.test(reason) && !/outside/i.test(reason)) {
        this.lastPlacement = { elevatedWindowPlacementSkipped: true, warning: ELEVATED_PLACEMENT_WARNING };
      } else {
        throw error;
      }
    }
    // This listener was verified to belong to the selected local engine.
    return `127.0.0.1:${running.port}`;
  }
}
