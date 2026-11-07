import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 750;

export interface WindowsProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string | null;
  commandLine: string;
  commandLineAvailable?: boolean;
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
  processesAvailable?: boolean;
  tcpAvailable?: boolean;
  processesComplete?: boolean;
  tcpComplete?: boolean;
}

export type WindowsSystemEvidence = Readonly<Omit<WindowsSystemSnapshot, 'processes' | 'tcp'>> & {
  readonly processes: readonly Readonly<WindowsProcessInfo>[];
  readonly tcp: readonly Readonly<WindowsTcpConnection>[];
};
export interface WindowsControlSample {
  readonly snapshotId: string;
  readonly capturedAt: number;
  readonly snapshot: WindowsSystemEvidence;
}

/** A control round owns this read. Never reuse or retimestamp the UI TTL cache.
 * CIM and netstat still observe a time interval, not an atomic OS transaction. */
export async function collectWindowsControlSample(): Promise<WindowsControlSample> {
  if (process.platform !== 'win32') throw new Error('PROFILE_WINDOWS_SAMPLE_UNSUPPORTED');
  const capturedAt = Date.now(), snapshotId = randomUUID();
  const value = await loadWindowsSystemSnapshot();
  const snapshot = Object.freeze({ ...value,
    processes: Object.freeze(value.processes.map(row => Object.freeze({ ...row }))),
    tcp: Object.freeze(value.tcp.map(row => Object.freeze({ ...row }))) });
  return Object.freeze({ snapshotId, capturedAt, snapshot });
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
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`],
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
  const promise = loadWindowsSystemSnapshot().then((snapshot) => {
    // A CIM scan can take longer than the TTL. Reuse its in-flight request and
    // start the freshness window only once the result is available.
    if (snapshotCache?.promise === promise) snapshotCache.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
    return snapshot;
  }).catch((error) => {
    if (snapshotCache?.promise === promise) snapshotCache = null;
    throw error;
  });
  snapshotCache = { expiresAt: Infinity, promise };
  return promise;
}

async function loadWindowsSystemSnapshot(): Promise<WindowsSystemSnapshot> {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
# CIM can hide image paths for elevated processes even when a limited query is
# permitted. Only request the image path; command-line access may still be denied.
try {
  Add-Type -ErrorAction Stop @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ProfilePilotProcessImage {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static string Read(uint processId) {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (handle == IntPtr.Zero) return null;
    try {
      var image = new StringBuilder(32768);
      uint length = (uint)image.Capacity;
      return QueryFullProcessImageName(handle, 0, image, ref length) ? image.ToString() : null;
    } finally { CloseHandle(handle); }
  }
}
'@
} catch { }
$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  $imagePath = $_.ExecutablePath
  if (-not $imagePath) {
    try { $imagePath = [ProfilePilotProcessImage]::Read([uint32]$_.ProcessId) } catch { }
  }
  $started = $null
  if ($_.CreationDate) {
    try { $started = $_.CreationDate.ToUniversalTime().ToString('o') } catch {}
  }
  [PSCustomObject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = if ($imagePath) { [string]$imagePath } else { $null }
    commandLine = if ($_.CommandLine) { [string]$_.CommandLine } elseif ($imagePath) { [string]$imagePath } else { [string]$_.Name }
    commandLineAvailable = [bool]$_.CommandLine
    startedAt = $started
  }
})
[PSCustomObject]@{ processes = $processes } | ConvertTo-Json -Compress -Depth 4
`;
  const [stdout, netstat] = await Promise.all([
    runWindowsPowerShell(script, { timeout: 8_000, maxBuffer: 32 * 1024 * 1024 }),
    readWindowsNetstat()
  ]);
  const snapshot = parseWindowsSystemSnapshot(stdout);
  snapshot.tcp = netstat?.connections || [];
  snapshot.processesAvailable = snapshot.processes.length > 0;
  snapshot.tcpAvailable = netstat !== null;
  snapshot.tcpComplete = netstat !== null && netstat.complete;
  return snapshot;
}

export function windowsNetstatComplete(input: string, protocol?: 'tcp' | 'tcpv6'): boolean {
  // Other TCP states are irrelevant to listening/established ownership, but a
  // malformed TCP row cannot be silently removed from a strict control read.
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Column labels are localized, but netstat's last PID column is not. An
  // empty table needs this envelope; arbitrary nonempty stdout is not evidence.
  const header = lines.findIndex(line => /\sPID$/i.test(line) && line.split(/\s{2,}/).length >= 4);
  if (header < 0) return false;
  return lines.slice(header + 1).every(line => {
    const match = line.trim().match(/^TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/i);
    if (!match) return false;
    const local = parseWindowsNetstatAddress(match[1]), remote = parseWindowsNetstatAddress(match[2]);
    const validState = /^(?:LISTENING|LISTEN|ESTABLISHED|CLOSED|SYN_SENT|SYN_RECEIVED|SYN_RCVD|FIN_WAIT_1|FIN_WAIT_2|CLOSE_WAIT|CLOSING|LAST_ACK|TIME_WAIT|DELETE_TCB|BOUND)$/i.test(match[3]);
    const familyMatches = !protocol || local && remote &&
      local.address.includes(':') === (protocol === 'tcpv6') && remote.address.includes(':') === (protocol === 'tcpv6');
    return Boolean(validState && local && remote && familyMatches && local.port <= 65535 && remote.port <= 65535 && nonNegativeInteger(match[4]) !== null);
  });
}

async function readWindowsNetstat(): Promise<{ connections: WindowsTcpConnection[]; complete: boolean } | null> {
  // Windows -p tcp excludes IPv6. Both independent tables must be complete
  // before absence of a listener can certify a control route as unused.
  const tables = await Promise.all((['tcp', 'tcpv6'] as const).map(async protocol => {
    try {
      const { stdout, stderr } = await execFileAsync("netstat", ["-ano", "-p", protocol], {
        windowsHide: true, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024
      });
      const text = String(stdout || "");
      return { connections: parseWindowsNetstat(text), complete: !String(stderr || "").trim() && windowsNetstatComplete(text, protocol) };
    } catch { return null; }
  }));
  if (tables.every(table => table === null)) return null;
  // Preserve useful partial evidence for display/diagnosis without duplicating
  // rows or promoting one successful address family to a complete snapshot.
  const rows = tables.flatMap(table => table?.connections || []);
  return { connections: [...new Map(rows.map(row => [JSON.stringify(row), row])).values()],
    complete: tables.every(table => table !== null && table.complete) };
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
    return { processes: [], tcp: [], processesComplete: false };
  }
  if (!isRecord(value)) return { processes: [], tcp: [], processesComplete: false };
  let processesComplete = Array.isArray(value.processes);
  const processes = arrayValue(value.processes).flatMap((entry) => {
    if (!isRecord(entry)) { processesComplete = false; return []; }
    // PID 0 is the real System Idle Process and is intentionally not targetable.
    if (entry.pid === 0) return [];
    const pid = positiveInteger(entry.pid);
    if (!pid) { processesComplete = false; return []; }
    if (!stringValue(entry.name) || nonNegativeInteger(entry.parentPid) === null) processesComplete = false;
    return [{
      pid,
      parentPid: nonNegativeInteger(entry.parentPid) ?? 0,
      name: stringValue(entry.name) || "process",
      executablePath: stringValue(entry.executablePath),
      commandLine: stringValue(entry.commandLine) || stringValue(entry.executablePath) || stringValue(entry.name) || "",
      commandLineAvailable: typeof entry.commandLineAvailable === 'boolean' ? entry.commandLineAvailable : Boolean(stringValue(entry.commandLine)),
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
  if (new Set(processes.map(item => item.pid)).size !== processes.length) processesComplete = false;
  return { processes, tcp, processesComplete };
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
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class ProfilePilotWindowFocus {
  private const int SW_RESTORE = 9;
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  public static bool WaitForForeground(int[] processIds, int timeoutMs) {
    var targets = new HashSet<int>(processIds);
    var elapsed = Stopwatch.StartNew();
    while (true) {
      var foreground = GetForegroundWindow();
      uint foregroundPid;
      if (foreground != IntPtr.Zero &&
          GetWindowThreadProcessId(foreground, out foregroundPid) != 0 &&
          targets.Contains((int)foregroundPid)) return true;
      if (elapsed.ElapsedMilliseconds >= timeoutMs) return false;
      Thread.Sleep(25);
    }
  }
  public static bool Focus(int[] processIds) {
    // CDP 的异步激活可在启动 helper 期间完成，此时无需再激活一次。
    if (WaitForForeground(processIds, 0)) return true;
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
    // 跨线程输入队列的激活通知是异步处理的，等待前台 PID 再判定结果。
    return WaitForForeground(processIds, 750);
  }
}
'@
$targets = @(${targets.join(",")})
$focusElapsed = [Diagnostics.Stopwatch]::StartNew()
if ([ProfilePilotWindowFocus]::Focus([int[]]$targets)) {
  [Console]::Out.WriteLine('true')
  exit 0
}
foreach ($targetPid in $targets) {
  if ($focusElapsed.ElapsedMilliseconds -ge 2000) { break }
  try {
    [Microsoft.VisualBasic.Interaction]::AppActivate([int]$targetPid)
    $waitMs = [int][Math]::Max(0, [Math]::Min(500, 2000 - $focusElapsed.ElapsedMilliseconds))
    if ([ProfilePilotWindowFocus]::WaitForForeground([int[]]$targets, $waitMs)) { [Console]::Out.WriteLine('true'); exit 0 }
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

export async function findWindowsProcessesLockingPaths(paths: string[], options: { strict?: boolean } = {}): Promise<Map<string, number[]>> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const result = new Map<string, number[]>();
  if (process.platform !== "win32" || !uniquePaths.length) return result;
  const encoded = Buffer.from(JSON.stringify(uniquePaths), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = '${options.strict ? 'Stop' : 'Continue'}'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static partial class ProfilePilotRestartManager {
  private const int ERROR_MORE_DATA = 234;
  private static readonly bool Strict = ${options.strict ? 'true' : 'false'};
  private static int[] Failed(string phase, int code) { if (Strict) throw new InvalidOperationException("PROFILE_FILE_SCAN_"+phase+"_FAILED_"+code); return new int[0]; }
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
  private static extern int RmStartSession(out uint handle, uint flags, StringBuilder sessionKey);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint handle, uint fileCount, string[] fileNames, uint appCount, IntPtr applications, uint serviceCount, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] affectedApps, ref uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint handle);
  private delegate int ListQuery(out uint needed, ref uint count, RM_PROCESS_INFO[] entries, ref uint reasons);
  private static int[] ReadProcesses(ListQuery read) {
    uint needed = 0;
    uint count = 0;
    uint reasons = 0;
    RM_PROCESS_INFO[] entries = null;
    // RmGetList refreshes the list on every call. Capacity can grow between
    // sizing and filling; retry only ERROR_MORE_DATA in this same RM session.
    // The caller's discovery timestamp remains the start of the entire read.
    for (var attempt = 0; attempt < 4; attempt++) {
      uint capacity = entries == null ? 0 : (uint)entries.Length;
      count = capacity;
      var status = read(out needed, ref count, entries, ref reasons);
      if (status == 0) {
        if (needed > count || count > capacity) return Failed("LIST", 13);
        var pids = new HashSet<int>();
        for (var index = 0; index < count; index++) {
          var pid = entries[index].Process.ProcessId;
          if (pid <= 0) return Failed("LIST", 13);
          pids.Add(pid);
        }
        var result = new int[pids.Count];
        pids.CopyTo(result);
        return result;
      }
      if (status != ERROR_MORE_DATA) return Failed("LIST", status);
      if (needed <= capacity || needed > 16384) return Failed("LIST", 13);
      if (attempt == 3) return Failed("LIST", ERROR_MORE_DATA);
      entries = new RM_PROCESS_INFO[needed];
    }
    return Failed("LIST", ERROR_MORE_DATA);
  }
  public static int[] GetLockingProcesses(string filePath) {
    uint handle;
    var key = new StringBuilder(33);
    var start = RmStartSession(out handle, 0, key);
    if (start != 0) return Failed("START", start);
    try {
      var registered = RmRegisterResources(handle, 1, new [] { filePath }, 0, IntPtr.Zero, 0, new string[0]);
      if (registered != 0) return Failed("REGISTER", registered);
      return ReadProcesses(delegate(out uint needed, ref uint count, RM_PROCESS_INFO[] entries, ref uint reasons) {
        return RmGetList(handle, out needed, ref count, entries, ref reasons);
      });
    } finally {
      RmEndSession(handle);
    }
  }
}
'@
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
# Windows PowerShell 5.1 emits a JSON array as one pipeline object. Wrapping
# that pipeline with @() nests it and casts all paths to one joined string.
$paths = ConvertFrom-Json -InputObject $json
$rows = @()
foreach ($filePath in $paths) {
  foreach ($lockingPid in [ProfilePilotRestartManager]::GetLockingProcesses([string]$filePath)) {
    $rows += [PSCustomObject]@{ path = [string]$filePath; pid = [int]$lockingPid }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
  try {
    const stdout = await runWindowsPowerShell(script, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) as unknown : [];
    if (options.strict && (!stdout.trim() || !Array.isArray(parsed))) throw new Error('PROFILE_FILE_SCAN_INVALID');
    for (const row of arrayValue(parsed)) {
      if (!isRecord(row)) { if (options.strict) throw new Error('PROFILE_FILE_SCAN_INVALID'); continue; }
      const filePath = stringValue(row.path);
      const pid = positiveInteger(row.pid);
      if (!filePath || !pid || !uniquePaths.includes(filePath)) { if (options.strict) throw new Error('PROFILE_FILE_SCAN_INVALID'); continue; }
      result.set(filePath, [...new Set([...(result.get(filePath) || []), pid])]);
    }
  } catch (error) {
    if (options.strict) {
      const reason = String((error as NodeJS.ErrnoException & { stderr?: unknown }).stderr || '').match(/PROFILE_FILE_SCAN_(?:START|REGISTER|LIST)_FAILED_\d{1,10}/)?.[0];
      if (reason) throw new Error(reason);
      throw error;
    }
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
