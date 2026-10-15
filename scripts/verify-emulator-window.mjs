// Exercises real Windows/Qt geometry through the public CLI, without Android input.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { runWindowsPowerShell } = require('../dist/main/windows-platform.js');
const { ensureRunningEmulatorWindowVisible } = require('../dist/main/phones/emulator-window.js');
const [name, id] = process.argv.slice(2);
if (process.platform !== 'win32') { console.log('Windows-only window verification; macOS uses native placement.'); process.exit(0); }
assert.match(name || '', /^[\w.-]{1,200}$/);
assert.match(id || '', /^emulator-\d{4,5}$/);
const port = Number(id.slice(9)); assert.ok(port >= 1024 && port <= 65535);
const definitions = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class EmulatorWindowVerification {
  delegate bool Callback(IntPtr h, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int size; public Rect monitor, work; public uint flags; }
  public class Evidence { public Rect bounds, work; public uint dpi, pid; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
  static IntPtr Find(string name,int port) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); IntPtr found=IntPtr.Zero;
    EnumWindows(delegate(IntPtr h,IntPtr data) {
      if (!IsWindowVisible(h)) return true;
      var title=new StringBuilder(512); GetWindowText(h,title,512);
      if (title.ToString()!="Android Emulator - "+name+":"+port) return true;
      uint pid; GetWindowThreadProcessId(h,out pid);
      if (!Process.GetProcessById((int)pid).ProcessName.StartsWith("qemu-system-",StringComparison.Ordinal)) return true;
      if (IsIconic(h)) throw new InvalidOperationException("Leave minimized windows untouched; restore the test emulator first.");
      found=h; return false;
    },IntPtr.Zero);
    if (found==IntPtr.Zero) throw new InvalidOperationException("Selected running emulator window was not found.");
    return found;
  }
  public static Evidence Read(string name,int port) {
    IntPtr h=Find(name,port); Rect bounds; GetWindowRect(h,out bounds);
    var info=new MonitorInfo(); info.size=Marshal.SizeOf(typeof(MonitorInfo)); GetMonitorInfo(MonitorFromWindow(h,2),ref info);
    uint pid; GetWindowThreadProcessId(h,out pid);
    return new Evidence { bounds=bounds,work=info.work,dpi=GetDpiForWindow(h),pid=pid };
  }
  public static void Place(string name,int port,string scenario) {
    var e=Read(name,port); int x=e.bounds.left,y=e.bounds.top,w=e.bounds.right-x,h=e.bounds.bottom-y;
    if (scenario=="above") y=e.work.top-326;
    else if (scenario=="oversized") { x=e.work.left-100; y=e.work.top-100; w=(e.work.right-e.work.left)*3/4; h=(e.work.bottom-e.work.top)*3/2; }
    else throw new InvalidOperationException("Unknown verification scenario");
    if (!SetWindowPos(Find(name,port),IntPtr.Zero,x,y,w,h,0x4014)) throw new InvalidOperationException("Cannot place the test window");
  }
}
'@
`;
const read = async () => JSON.parse(await runWindowsPowerShell(`${definitions}\n[EmulatorWindowVerification]::Read('${name}',${port}) | ConvertTo-Json -Depth 4`, { timeout: 10000 }));
const fits = e => e.bounds.left >= e.work.left && e.bounds.top >= e.work.top && e.bounds.bottom <= e.work.bottom
  && e.bounds.right + Math.ceil(64 * e.dpi / 96) <= e.work.right;
const open = async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['dist/main/profilepilot-cli.cjs', 'phone', 'emulator-connect', '--name', name], { windowsHide: true, timeout: 125000 });
  const response = JSON.parse(stdout); assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.id, id, 'CLI must reuse the selected emulator');
};
const evidence = [];
const initial = await read();
try {
  for (const scenario of ['above', 'oversized', 'above']) {
    await runWindowsPowerShell(`${definitions}\n[EmulatorWindowVerification]::Place('${name}',${port},'${scenario}')`, { timeout: 10000 });
    await delay(300);
    const before = await read(); assert.equal(fits(before), false, `Fault not reproduced: ${scenario}`);
    await open();
    const after = await read(); assert.ok(fits(after), `Window still outside monitor: ${scenario}`);
    assert.equal(after.pid, initial.pid, 'Repair must not restart the emulator');
    evidence.push({ scenario, before, after });
  }
  const before = await read(); await open(); const after = await read();
  assert.deepEqual(after.bounds, before.bounds, 'An already visible window must keep its placement');
  evidence.push({ scenario: 'already-visible', before, after });
} finally {
  // Restore a usable preview even if an assertion/CLI check fails; never kill the emulator.
  await ensureRunningEmulatorWindowVisible(name, id);
}
const output = path.resolve('artifacts/emulator-window-verification');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'result.json'), JSON.stringify({ name, id, passed: evidence.length, evidence }, null, 2));
console.log(`Passed ${evidence.length} real window checks at ${initial.dpi / 96 * 100}% Windows scaling; emulator process preserved.`);
