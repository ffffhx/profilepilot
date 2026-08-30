$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class ProfilePilotWindowsInputGuard
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_QUIT = 0x0012;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int WM_MOUSEHWHEEL = 0x020E;
    private const uint GA_ROOT = 2;

    private static readonly object Sync = new object();
    private static readonly HashSet<int> GuardedPids = new HashSet<int>();
    private static readonly LowLevelMouseProc HookProc = HookCallback;
    private static IntPtr hook = IntPtr.Zero;
    private static uint messageThreadId;
    private static int capturedPid;
    private static IntPtr capturedWindow = IntPtr.Zero;

    private delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT Point;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr Window;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public POINT Point;
        public uint Private;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hookId, LowLevelMouseProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hookHandle);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hookHandle, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    public static int Run()
    {
        messageThreadId = GetCurrentThreadId();
        hook = SetWindowsHookEx(WH_MOUSE_LL, HookProc, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero)
        {
            EmitStatus("hook-create-failed", 0, null);
            return 2;
        }
        var inputThread = new Thread(ReadCommands);
        inputThread.IsBackground = true;
        inputThread.Name = "ProfilePilot Input Guard commands";
        inputThread.Start();
        EmitStatus("ready", 0, null);
        try
        {
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }
        return 0;
    }

    private static void ReadCommands()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (String.Equals(line, "QUIT", StringComparison.OrdinalIgnoreCase))
            {
                PostThreadMessage(messageThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                return;
            }
            if (!line.StartsWith("SET", StringComparison.OrdinalIgnoreCase) || (line.Length > 3 && !Char.IsWhiteSpace(line[3])))
            {
                EmitStatus("invalid-command", 0, null);
                continue;
            }
            var next = new HashSet<int>();
            var parts = line.Substring(3).Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            var valid = true;
            foreach (var part in parts)
            {
                int pid;
                if (!Int32.TryParse(part, out pid) || pid <= 0) { valid = false; break; }
                try { Process.GetProcessById(pid); next.Add(pid); } catch { EmitStatus("tap-create-failed", pid, null); }
            }
            if (!valid)
            {
                EmitStatus("invalid-pid", 0, null);
                continue;
            }
            lock (Sync)
            {
                foreach (var pid in GuardedPids) if (!next.Contains(pid)) EmitStatus("tap-removed", pid, null);
                foreach (var pid in next) if (!GuardedPids.Contains(pid)) EmitStatus("tap-active", pid, null);
                GuardedPids.Clear();
                foreach (var pid in next) GuardedPids.Add(pid);
                if (capturedPid != 0 && !GuardedPids.Contains(capturedPid)) { capturedPid = 0; capturedWindow = IntPtr.Zero; }
                EmitStatus("sync-complete", 0, GuardedPids.Count);
            }
        }
        PostThreadMessage(messageThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }

    private static IntPtr HookCallback(int code, IntPtr messageValue, IntPtr data)
    {
        if (code < 0) return CallNextHookEx(hook, code, messageValue, data);
        var message = messageValue.ToInt32();
        var mouse = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(MSLLHOOKSTRUCT));
        var window = GetAncestor(WindowFromPoint(mouse.Point), GA_ROOT);
        uint rawPid = 0;
        if (window != IntPtr.Zero) GetWindowThreadProcessId(window, out rawPid);
        var pid = (int)rawPid;
        var down = IsDown(message);
        var up = IsUp(message);
        var guarded = false;
        lock (Sync)
        {
            guarded = GuardedPids.Contains(pid);
            if (down && guarded) { capturedPid = pid; capturedWindow = window; }
            if ((message == WM_MOUSEMOVE || up) && capturedPid != 0)
            {
                pid = capturedPid;
                window = capturedWindow;
                guarded = GuardedPids.Contains(pid);
            }
            if (guarded && (down || up)) EmitMouse(pid, window, mouse, down ? "down" : "up", ButtonFor(message));
            if (up) { capturedPid = 0; capturedWindow = IntPtr.Zero; }
        }
        if (guarded && (down || up || message == WM_MOUSEMOVE || message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL))
            return new IntPtr(1);
        return CallNextHookEx(hook, code, messageValue, data);
    }

    private static bool IsDown(int message)
    {
        return message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN;
    }

    private static bool IsUp(int message)
    {
        return message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP;
    }

    private static int ButtonFor(int message)
    {
        if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) return 0;
        if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) return 1;
        return 2;
    }

    private static void EmitMouse(int pid, IntPtr window, MSLLHOOKSTRUCT mouse, string phase, int button)
    {
        RECT rect = new RECT();
        var hasRect = window != IntPtr.Zero && GetWindowRect(window, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top;
        var scale = 1.0;
        try { var dpi = GetDpiForWindow(window); if (dpi > 0) scale = dpi / 96.0; } catch {}
        var timestamp = (long)((double)Stopwatch.GetTimestamp() * 1000000000.0 / Stopwatch.Frequency);
        var invariant = CultureInfo.InvariantCulture;
        var windowJson = hasRect
            ? String.Format(invariant, "{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}", rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top)
            : "null";
        Console.WriteLine(String.Format(invariant,
            "{{\"type\":\"mouse\",\"pid\":{0},\"phase\":\"{1}\",\"button\":{2},\"x\":{3},\"y\":{4},\"windowId\":{5},\"timestamp\":{6},\"displayScale\":{7},\"window\":{8}}}",
            pid, phase, button, mouse.Point.X, mouse.Point.Y, window.ToInt64(), timestamp, scale, windowJson));
    }

    private static void EmitStatus(string status, int pid, int? activeCount)
    {
        var extra = activeCount.HasValue ? ",\"activeCount\":" + activeCount.Value.ToString(CultureInfo.InvariantCulture) : "";
        Console.WriteLine("{\"type\":\"status\",\"status\":\"" + status + "\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) + extra + "}");
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
exit [ProfilePilotWindowsInputGuard]::Run()
