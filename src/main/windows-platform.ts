import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 750;

export interface WindowsProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string | null;
  commandLine: string;
  startedAt: string | null;
}

export interface WindowsTcpConnection {
  pid: number;
  state: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export interface WindowsSystemSnapshot {
  processes: WindowsProcessInfo[];
  tcp: WindowsTcpConnection[];
}

interface CachedWindowsSnapshot {
  expiresAt: number;
  promise: Promise<WindowsSystemSnapshot>;
}

let snapshotCache: CachedWindowsSnapshot | null = null;

export function windowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function runWindowsPowerShell(
  script: string,
  options: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}
): Promise<string> {
  const { stdout } = await execFileAsync(
    windowsPowerShellExecutable(options.env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: options.timeout ?? 5_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: options.env || process.env
    }
  );
  return String(stdout);
}

export function invalidateWindowsSystemSnapshot(): void {
  snapshotCache = null;
}

export async function getWindowsSystemSnapshot(force = false): Promise<WindowsSystemSnapshot> {
  if (process.platform !== "win32") {
    return { processes: [], tcp: [] };
  }
  const now = Date.now();
  if (!force && snapshotCache && snapshotCache.expiresAt > now) {
    return snapshotCache.promise;
  }
  const promise = loadWindowsSystemSnapshot().catch((error) => {
    if (snapshotCache?.promise === promise) snapshotCache = null;
    throw error;
  });
  snapshotCache = { expiresAt: now + SNAPSHOT_TTL_MS, promise };
  return promise;
}

async function loadWindowsSystemSnapshot(): Promise<WindowsSystemSnapshot> {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  $started = $null
  if ($_.CreationDate) {
    try { $started = $_.CreationDate.ToUniversalTime().ToString('o') } catch {}
  }
  [PSCustomObject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { $null }
    commandLine = if ($_.CommandLine) { [string]$_.CommandLine } elseif ($_.ExecutablePath) { [string]$_.ExecutablePath } else { [string]$_.Name }
    startedAt = $started
  }
})
[PSCustomObject]@{ processes = $processes } | ConvertTo-Json -Compress -Depth 4
`;
  const [stdout, netstatStdout] = await Promise.all([
    runWindowsPowerShell(script, { timeout: 8_000, maxBuffer: 32 * 1024 * 1024 }),
    readWindowsNetstat()
  ]);
  const snapshot = parseWindowsSystemSnapshot(stdout);
  snapshot.tcp = parseWindowsNetstat(netstatStdout);
  return snapshot;
}

async function readWindowsNetstat(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return String(stdout || "");
  } catch {
    return "";
  }
}

export function parseWindowsNetstat(input: string): WindowsTcpConnection[] {
  return String(input || "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.trim().match(/^TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/i);
      if (!match) return [];
      const state = netstatState(match[3]);
      if (!state) return [];
      const local = parseWindowsNetstatAddress(match[1]);
      const remote = parseWindowsNetstatAddress(match[2]);
      const pid = nonNegativeInteger(match[4]);
      if (!local || !remote || pid === null) return [];
      return [{
        pid,
        state,
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port
      } satisfies WindowsTcpConnection];
    });
}

export function parseWindowsNetstatAddress(value: string): { address: string; port: number } | null {
  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    const port = nonNegativeInteger(ipv6[2]);
    return port === null ? null : { address: ipv6[1], port };
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const port = nonNegativeInteger(value.slice(separator + 1));
  const address = value.slice(0, separator);
  return port === null || !address ? null : { address, port };
}

function netstatState(value: string): string | null {
  const state = value.trim().toUpperCase();
  if (state === "LISTENING" || state === "LISTEN") return "Listen";
  if (state === "ESTABLISHED") return "Established";
  return null;
}

export function parseWindowsSystemSnapshot(input: string): WindowsSystemSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(input.trim());
  } catch {
    return { processes: [], tcp: [] };
  }
  if (!isRecord(value)) return { processes: [], tcp: [] };
  const processes = arrayValue(value.processes).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pid = positiveInteger(entry.pid);
    if (!pid) return [];
    return [{
      pid,
      parentPid: nonNegativeInteger(entry.parentPid) ?? 0,
      name: stringValue(entry.name) || "process",
      executablePath: stringValue(entry.executablePath),
      commandLine: stringValue(entry.commandLine) || stringValue(entry.executablePath) || stringValue(entry.name) || "",
      startedAt: isoDateValue(entry.startedAt)
    } satisfies WindowsProcessInfo];
  });
  const tcp = arrayValue(value.tcp).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pid = nonNegativeInteger(entry.pid);
    const localPort = nonNegativeInteger(entry.localPort);
    const remotePort = nonNegativeInteger(entry.remotePort);
    if (pid === null || localPort === null || remotePort === null) return [];
    return [{
      pid,
      state: stringValue(entry.state) || "",
      localAddress: stringValue(entry.localAddress) || "",
      localPort,
      remoteAddress: stringValue(entry.remoteAddress) || "",
      remotePort
    } satisfies WindowsTcpConnection];
  });
  return { processes, tcp };
}

export async function windowsForegroundProcessId(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ProfilePilotForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$pidValue = [uint32]0
$window = [ProfilePilotForegroundWindow]::GetForegroundWindow()
if ($window -ne [IntPtr]::Zero) { [void][ProfilePilotForegroundWindow]::GetWindowThreadProcessId($window, [ref]$pidValue) }
[Console]::Out.WriteLine([string]$pidValue)
`;
  try {
    const pid = Number((await runWindowsPowerShell(script, { timeout: 3_000 })).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function focusWindowsProcess(pids: number[]): Promise<boolean> {
  const targets = normalizedPids(pids);
  if (process.platform !== "win32" || !targets.length) return false;
  const script = String.raw`
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProfilePilotWindowFocus {
  private const int SW_RESTORE = 9;
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  public static bool Focus(int[] processIds) {
    var targets = new HashSet<int>(processIds);
    IntPtr candidate = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (targets.Contains((int)pid) && IsWindowVisible(window)) { candidate = window; return false; }
      return true;
    }, IntPtr.Zero);
    if (candidate == IntPtr.Zero) return false;
    ShowWindowAsync(candidate, SW_RESTORE);
    SetForegroundWindow(candidate);
    var foreground = GetForegroundWindow();
    uint foregroundPid;
    GetWindowThreadProcessId(foreground, out foregroundPid);
    return targets.Contains((int)foregroundPid);
  }
}
'@
$targets = @(${targets.join(",")})
if ([ProfilePilotWindowFocus]::Focus([int[]]$targets)) {
  [Console]::Out.WriteLine('true')
  exit 0
}
foreach ($targetPid in $targets) {
  try {
    [Microsoft.VisualBasic.Interaction]::AppActivate([int]$targetPid)
    Start-Sleep -Milliseconds 60
    if ([ProfilePilotWindowFocus]::Focus([int[]]$targets)) { [Console]::Out.WriteLine('true'); exit 0 }
  } catch {}
}
[Console]::Out.WriteLine('false')
`;
  try {
    return (await runWindowsPowerShell(script, { timeout: 3_000 })).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export async function requestWindowsProcessClose(pids: number[]): Promise<boolean> {
  const targets = normalizedPids(pids);
  if (process.platform !== "win32" || !targets.length) return false;
  const script = String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProfilePilotWindowClose {
  private const uint WM_CLOSE = 0x0010;
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static int Close(int[] processIds) {
    var targets = new HashSet<int>(processIds);
    var count = 0;
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (targets.Contains((int)pid) && PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@
$count = [ProfilePilotWindowClose]::Close([int[]]@(${targets.join(",")}))
[Console]::Out.WriteLine([string]$count)
`;
  try {
    const count = Number((await runWindowsPowerShell(script, { timeout: 4_000 })).trim());
    invalidateWindowsSystemSnapshot();
    return Number.isFinite(count) && count > 0;
  } catch {
    return false;
  }
}

export async function findWindowsProcessesLockingPaths(paths: string[]): Promise<Map<string, number[]>> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const result = new Map<string, number[]>();
  if (process.platform !== "win32" || !uniquePaths.length) return result;
  const encoded = Buffer.from(JSON.stringify(uniquePaths), "utf8").toString("base64");
  const script = String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProfilePilotRestartManager {
  private const int ERROR_MORE_DATA = 234;
  [StructLayout(LayoutKind.Sequential)]
  private struct RM_UNIQUE_PROCESS {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  private enum RM_APP_TYPE {
    Unknown = 0, MainWindow = 1, OtherWindow = 2, Service = 3, Explorer = 4, Console = 5, Critical = 1000
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TssSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmStartSession(out uint handle, int flags, string sessionKey);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint handle, uint fileCount, string[] fileNames, uint appCount, IntPtr applications, uint serviceCount, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] affectedApps, ref uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint handle);
  public static int[] GetLockingProcesses(string filePath) {
    uint handle;
    var key = Guid.NewGuid().ToString("N");
    if (RmStartSession(out handle, 0, key) != 0) return new int[0];
    try {
      if (RmRegisterResources(handle, 1, new [] { filePath }, 0, IntPtr.Zero, 0, new string[0]) != 0) return new int[0];
      uint needed = 0;
      uint count = 0;
      uint reasons = 0;
      var empty = new RM_PROCESS_INFO[0];
      var status = RmGetList(handle, out needed, ref count, empty, ref reasons);
      if (status != ERROR_MORE_DATA || needed == 0) return new int[0];
      var entries = new RM_PROCESS_INFO[needed];
      count = needed;
      status = RmGetList(handle, out needed, ref count, entries, ref reasons);
      if (status != 0) return new int[0];
      var pids = new HashSet<int>();
      for (var index = 0; index < count; index++) if (entries[index].Process.ProcessId > 0) pids.Add(entries[index].Process.ProcessId);
      var result = new int[pids.Count];
      pids.CopyTo(result);
      return result;
    } finally {
      RmEndSession(handle);
    }
  }
}
'@
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$paths = @($json | ConvertFrom-Json)
$rows = @()
foreach ($filePath in $paths) {
  foreach ($lockingPid in [ProfilePilotRestartManager]::GetLockingProcesses([string]$filePath)) {
    $rows += [PSCustomObject]@{ path = [string]$filePath; pid = [int]$lockingPid }
  }
}
@($rows) | ConvertTo-Json -Compress
`;
  try {
    const stdout = await runWindowsPowerShell(script, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) as unknown : [];
    for (const row of arrayValue(parsed)) {
      if (!isRecord(row)) continue;
      const filePath = stringValue(row.path);
      const pid = positiveInteger(row.pid);
      if (!filePath || !pid) continue;
      result.set(filePath, [...new Set([...(result.get(filePath) || []), pid])]);
    }
  } catch {
    // Restart Manager is a best-effort precision layer; command-line discovery remains available.
  }
  return result;
}

export function windowsHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function normalizedPids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function isoDateValue(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
