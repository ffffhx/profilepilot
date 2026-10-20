import { runWindowsPowerShell } from "../windows-platform";

/** Qt can restore an emulator above the desktop after Windows DPI scaling.
 * Fit only the selected AVD, then leave its window under user control.
 * macOS uses the emulator's native window placement and never runs this helper.
 */
export async function ensureEmulatorWindowVisible(launcherPid: number, name: string, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0 || !/^[\w.-]{1,200}$/.test(name)) throw new Error("Invalid emulator window target");
  await fitEmulatorWindow(launcherPid, name, 0);
}

/** Reopening an existing AVD must also recover a window left off-screen by Qt. */
export async function ensureRunningEmulatorWindowVisible(name: string, id: string, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  const match = /^emulator-(\d{4,5})$/.exec(id);
  const port = Number(match?.[1]);
  if (!/^[\w.-]{1,200}$/.test(name) || !match || port < 1024 || port > 65535) throw new Error("Invalid emulator window target");
  await fitEmulatorWindow(0, name, port);
}

export async function ensureTencentEmulatorWindowVisible(pid: number, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid emulator window target");
  await fitEmulatorWindow(pid, "Tencent_GameLoop", 0);
}

async function fitEmulatorWindow(launcherPid: number, name: string, port: number): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ProfilePilotEmulatorWindow {
  public delegate bool Callback(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int size; public Rect monitor, work; public uint flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

  // 0: not created yet; 1: already fits; 2: correction requested; 3: minimized; 4: user dragging.
  public static int Fit(int[] processes, string name, int port) {
    var previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      var targets = new HashSet<int>(processes);
      IntPtr target = IntPtr.Zero;
      EnumWindows(delegate(IntPtr window, IntPtr data) {
        uint process;
        GetWindowThreadProcessId(window, out process);
        if (!targets.Contains((int)process) || !IsWindowVisible(window)) return true;
        var title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        string prefix = "Android Emulator - " + name + ":";
        if (name == "Tencent_GameLoop") {
          if (!title.ToString().StartsWith("腾讯手游助手", StringComparison.Ordinal)) return true;
        } else if (port > 0 ? title.ToString() != prefix + port : !title.ToString().StartsWith(prefix, StringComparison.Ordinal)) return true;
        target = window;
        return false;
      }, IntPtr.Zero);
      if (target == IntPtr.Zero) return 0;
      if (IsIconic(target)) return 3;
      if ((GetAsyncKeyState(1) & 0x8000) != 0) return 4;
      Rect rect;
      var info = new MonitorInfo();
      info.size = Marshal.SizeOf(typeof(MonitorInfo));
      if (!GetWindowRect(target, out rect) || !GetMonitorInfo(MonitorFromWindow(target, 2), ref info)) throw new InvalidOperationException("Cannot read emulator window bounds");
      int width = rect.right - rect.left, height = rect.bottom - rect.top;
      if (width <= 0 || height <= 0) return 0;
      double dpi = Math.Max(96, GetDpiForWindow(target)) / 96.0;
      int margin = (int)Math.Ceiling(20 * dpi), toolbar = (int)Math.Ceiling(64 * dpi);
      var work = info.work;
      if (rect.left >= work.left && rect.top >= work.top && rect.right + toolbar <= work.right && rect.bottom <= work.bottom) return 1;
      // Both rectangles are physical pixels on the same monitor, including at
      // 125/150% scaling and on displays with a negative desktop origin.
      int availableWidth = work.right - work.left - 2 * margin - toolbar;
      int availableHeight = work.bottom - work.top - 2 * margin;
      if (availableWidth <= 0 || availableHeight <= 0) return 0;
      double scale = Math.Min(1.0, Math.Min((double)availableWidth / width, (double)availableHeight / height));
      width = Math.Max(1, (int)Math.Floor(width * scale));
      height = Math.Max(1, (int)Math.Floor(height * scale));
      int x = Math.Max(work.left + margin, Math.Min(rect.left, work.right - margin - toolbar - width));
      int y = Math.Max(work.top + margin, Math.Min(rect.top, work.bottom - margin - height));
      // Preserve focus/z-order. The companion toolbar follows Qt's move event.
      if (!SetWindowPos(target, IntPtr.Zero, x, y, width, height, 0x4014)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return 2;
    } finally {
      if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }
}
'@
$launcherProcessId = ${launcherPid}
$name = '${name}'
$port = ${port}
$targets = [Collections.Generic.HashSet[int]]::new()
if ($launcherProcessId -gt 0) { [void]$targets.Add($launcherProcessId) }
$elapsed = [Diagnostics.Stopwatch]::StartNew()
$stableSince = -1
while ($elapsed.ElapsedMilliseconds -lt 20000) {
  if ($launcherProcessId -gt 0) {
    # emulator.exe creates a qemu child on Windows. Scope discovery to this launch.
    foreach ($parent in @($targets)) {
      foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent" -ErrorAction SilentlyContinue)) {
        if ($child.Name -like 'qemu-system-*.exe' -or $child.Name -eq 'emulator.exe' -or ($name -eq 'Tencent_GameLoop' -and $child.Name -eq 'AndroidEmulator.exe')) { [void]$targets.Add([int]$child.ProcessId) }
      }
    }
  } else {
    # Existing windows must match BOTH the AVD name and the observed emulator port.
    # Only emulator processes qualify; never move another application's window.
    $targets.Clear()
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'qemu-system-%.exe' OR Name = 'emulator.exe'")) {
      [void]$targets.Add([int]$candidate.ProcessId)
    }
  }
  $state = [ProfilePilotEmulatorWindow]::Fit([int[]]@($targets), $name, $port)
  if ($state -eq 3) { exit 0 }
  if ($state -eq 1) {
    if ($stableSince -lt 0) { $stableSince = $elapsed.ElapsedMilliseconds }
    if ($elapsed.ElapsedMilliseconds - $stableSince -ge 2000) { exit 0 }
  } else { $stableSince = -1 }
  if ($launcherProcessId -gt 0 -and -not (@($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count)) { throw 'The emulator exited before its window could be verified.' }
  Start-Sleep -Milliseconds 250
}
throw 'The emulator window did not become visible within the startup timeout.'
`;
  await runWindowsPowerShell(script, { timeout: 25000, maxBuffer: 128 * 1024 });
}
