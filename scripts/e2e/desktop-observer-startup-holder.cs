using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Test only. The holding mode creates one named object, never a hook, HWND or
// input event. --self-test is pure; --inventory/--check-exit are read-only.
public static class DesktopObserverStartupHolder {
    public const string GateName = @"Local\ProfilePilot.InputObserver";
    public const int HeartbeatSeconds = 30, HardLifetimeSeconds = 180;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateMutexW(IntPtr attributes, bool initialOwner, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    public static bool ValidNonce(string value) { return value != null && value.Length == 32 && Regex.IsMatch(value, "^[a-f0-9]{32}$"); }
    public static bool FreshHeartbeat(string content, string nonce, DateTime modified, DateTime now) {
        return ValidNonce(nonce) && content == nonce && modified <= now && now - modified <= TimeSpan.FromSeconds(HeartbeatSeconds);
    }
    public static bool LifetimeExpired(DateTime started, DateTime now) { return now < started || now - started >= TimeSpan.FromSeconds(HardLifetimeSeconds); }
    static void Save(string file, object value) {
        string temporary = file + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    static string ReadNonce(string file) {
        var info = new FileInfo(file); if (!info.Exists || info.Length != 32) return null;
        return File.ReadAllText(file, Encoding.ASCII);
    }
    static Dictionary<string, object> InspectSelf() {
        // Reuse the same token, executable hash, parent and start identity code
        // used by the runner's independent verifier; no alternate token path.
        var text = new StringWriter(CultureInfo.InvariantCulture); var original = Console.Out;
        int result;
        try { Console.SetOut(text); result = ObserverFaultIdentity.Main(new[] { "--inspect", Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) }); }
        finally { Console.SetOut(original); }
        Require(result == 0, "SELF_IDENTITY_UNAVAILABLE");
        var identity = Json.Deserialize<Dictionary<string, object>>(text.ToString());
        Require(Convert.ToBoolean(identity["ok"]) && Convert.ToInt32(identity["integrityRid"]) == 8192
            && !Convert.ToBoolean(identity["elevated"]) && !Convert.ToBoolean(identity["uiAccess"]), "MEDIUM_HOLDER_REQUIRED");
        return identity;
    }
    static void Inventory() {
        int session = Process.GetCurrentProcess().SessionId;
        var candidates = new List<object>(); var gaps = new List<string>();
        using (var query = new ManagementObjectSearcher("SELECT ProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process WHERE SessionId = " + session))
        using (var rows = query.Get()) foreach (ManagementObject row in rows) using (row) {
            string name = Convert.ToString(row["Name"]), executable = Convert.ToString(row["ExecutablePath"]), command = Convert.ToString(row["CommandLine"]);
            string lowerPath = executable.ToLowerInvariant(), lowerCommand = command.ToLowerInvariant();
            bool shell = name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase);
            bool observer = lowerPath.Contains("profilepilot-input-observer-runtime") || name.Equals("ProfilePilot.InputObserver.exe", StringComparison.OrdinalIgnoreCase)
                || name.Equals("profilepilot-input-observer.exe", StringComparison.OrdinalIgnoreCase) || lowerCommand.Contains("--stdio-observer");
            bool legacy = shell && lowerCommand.Contains("input-guard-win.ps1");
            if (observer || legacy) candidates.Add(new { pid = Convert.ToInt32(row["ProcessId"]), kind = observer ? "input-observer" : "legacy-input-guard" });
            if (shell && String.IsNullOrWhiteSpace(command)) gaps.Add("shell_command_unavailable");
        }
        Console.WriteLine(Json.Serialize(new { ok = true, sessionId = session, candidates, gaps, sampledAt = DateTime.UtcNow.ToString("o"),
            scope = "Known ProfilePilot helpers in this Windows session; not an inventory of arbitrary hooks" }));
    }
    static void CheckExit(string[] args) {
        int pid; long ticks;
        Require(args.Length == 3 && Int32.TryParse(args[1], out pid) && pid > 0 && Int64.TryParse(args[2], out ticks) && ticks > 0, "EXIT_ARGUMENTS");
        pid = Int32.Parse(args[1]); ticks = Int64.Parse(args[2]);
        try { using (var process = Process.GetProcessById(pid)) {
            bool replacement = process.StartTime.ToUniversalTime().Ticks != ticks;
            Console.WriteLine(Json.Serialize(new { ok = true, originalExited = replacement || process.HasExited, replacementUntouched = replacement }));
        } } catch (ArgumentException) { Console.WriteLine("{\"ok\":true,\"originalExited\":true}"); }
    }
    static int Hold(string[] args) {
        Require(args.Length == 4 && args[0] == "--hold" && (args[1] == "mutex" || args[1] == "event") && ValidNonce(args[3]), "HOLDER_ARGUMENTS");
        string mode = args[1], fileBase = Path.GetFullPath(args[2]), nonce = args[3];
        Require(String.Equals(Path.GetDirectoryName(fileBase), AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
            && Path.GetFileName(fileBase) == "holder-" + nonce, "HOLDER_BASE_NOT_OWNED");
        var identity = InspectSelf();
        DateTime started = DateTime.UtcNow;
        string firstHeartbeat = ReadNonce(fileBase + ".heartbeat"); DateTime firstModified = File.GetLastWriteTimeUtc(fileBase + ".heartbeat");
        Require(FreshHeartbeat(firstHeartbeat, nonce, firstModified, DateTime.UtcNow), "INITIAL_HEARTBEAT_REQUIRED");
        var lifetime = Stopwatch.StartNew();
        IntPtr handle = mode == "mutex" ? CreateMutexW(IntPtr.Zero, false, GateName) : CreateEventW(IntPtr.Zero, false, false, GateName);
        int error = Marshal.GetLastWin32Error();
        if (handle == IntPtr.Zero || error == 183) {
            if (handle != IntPtr.Zero) CloseHandle(handle); // Never retain an existing object.
            Save(fileBase + ".ready.json", new { ok = false, nonce, mode, identity, win32Error = unchecked((uint)error), acquired = false,
                hooksInstalled = false, inputInjected = false });
            return 2;
        }
        string reason = "unknown"; bool closed = false;
        try {
            Save(fileBase + ".ready.json", new { ok = true, nonce, mode, identity, acquired = true, gateName = GateName,
                heartbeatSeconds = HeartbeatSeconds, hardLifetimeSeconds = HardLifetimeSeconds, hooksInstalled = false, inputInjected = false });
            for (;;) {
                if (ReadNonce(fileBase + ".close") == nonce) { reason = "requested"; break; }
                string heartbeat = ReadNonce(fileBase + ".heartbeat"); DateTime modified = File.GetLastWriteTimeUtc(fileBase + ".heartbeat"), now = DateTime.UtcNow;
                if (lifetime.Elapsed.TotalSeconds >= HardLifetimeSeconds || LifetimeExpired(started, now)) { reason = "hard_ttl"; break; }
                if (!FreshHeartbeat(heartbeat, nonce, modified, now)) { reason = "heartbeat_expired"; break; }
                Thread.Sleep(100);
            }
        } finally {
            closed = CloseHandle(handle);
            Save(fileBase + ".closed.json", new { ok = closed, nonce, mode, identity, handleClosed = closed, reason,
                hooksInstalled = false, inputInjected = false, finishedAt = DateTime.UtcNow.ToString("o") });
        }
        return closed && reason == "requested" ? 0 : 3;
    }
    static void SelfTest() {
        string nonce = new string('a', 32); DateTime now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        int checks = 0; Action<bool, string> check = (value, label) => { Require(value, label); checks++; };
        check(ValidNonce(nonce), "VALID_NONCE"); check(!ValidNonce(new string('a', 31)), "SHORT_NONCE");
        check(!ValidNonce(new string('A', 32)), "UPPER_NONCE"); check(!ValidNonce(nonce + "\n"), "NEWLINE_NONCE");
        check(FreshHeartbeat(nonce, nonce, now, now), "FRESH_HEARTBEAT"); check(FreshHeartbeat(nonce, nonce, now.AddSeconds(-30), now), "HEARTBEAT_BOUNDARY");
        check(!FreshHeartbeat(nonce, nonce, now.AddSeconds(-31), now), "EXPIRED_HEARTBEAT");
        check(!FreshHeartbeat(nonce, nonce, now.AddSeconds(1), now), "FUTURE_HEARTBEAT");
        check(!FreshHeartbeat(new string('b', 32), nonce, now, now), "WRONG_HEARTBEAT");
        check(!LifetimeExpired(now, now.AddSeconds(179)), "BEFORE_TTL"); check(LifetimeExpired(now, now.AddSeconds(180)), "TTL_BOUNDARY");
        check(LifetimeExpired(now, now.AddSeconds(-1)), "REVERSED_CLOCK");
        Console.WriteLine(Json.Serialize(new { ok = true, checks, mode = "pure", namedObjectCreated = false, hooksInstalled = false, guiStarted = false }));
    }
    public static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") { SelfTest(); return 0; }
            Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8, "WINDOWS_X64_REQUIRED");
            if (args.Length == 1 && args[0] == "--inventory") { Inventory(); return 0; }
            if (args.Length > 0 && args[0] == "--check-exit") { CheckExit(args); return 0; }
            return Hold(args);
        } catch (Exception error) {
            Console.WriteLine(Json.Serialize(new { ok = false, code = "STARTUP_HOLDER_FAILED", message = error.Message })); return 1;
        }
    }
}
