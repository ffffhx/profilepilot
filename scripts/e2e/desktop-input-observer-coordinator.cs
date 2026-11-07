using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Acceptance coordinator only. It creates no windows, never samples foreground
// or keys, and never injects input. --run-native-lifecycle explicitly starts the
// owned native helper, whose hooks make this a gated/manual acceptance test.
public static class DesktopInputObserverCoordinator {
    [StructLayout(LayoutKind.Sequential)] struct JobBasic { public long PerProcessTime, PerJobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperation, WriteOperation, OtherOperation, ReadTransfer, WriteTransfer, OtherTransfer; }
    [StructLayout(LayoutKind.Sequential)] struct JobExtended { public JobBasic Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobExtended information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeInfo(SafeFileHandle pipe, out uint flags, out uint outputBuffer, out uint inputBuffer, out uint instances);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PeekNamedPipe(SafeFileHandle pipe, IntPtr buffer, uint length, IntPtr read, out uint available, IntPtr remaining);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Dictionary<string, object> Report = new Dictionary<string, object>();
    static readonly List<Dictionary<string, object>> Cases = new List<Dictionary<string, object>>();
    static readonly List<Dictionary<string, object>> Children = new List<Dictionary<string, object>>();
    static string ReportFile, Helper;
    static IntPtr Job;
    static Timer Watchdog;
    const string Epoch = "lifecycle-test", Marker = "ab1234567890cdef";
    const int ExitLimit = 2500;

    sealed class AcceptanceFailure : Exception { public AcceptanceFailure(string reason) : base(reason) { } }
    static void Require(bool condition, string reason) { if (!condition) throw new AcceptanceFailure(reason); }
    static void Save() {
        string temporary = ReportFile + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(Report), new UTF8Encoding(false));
        if (File.Exists(ReportFile)) File.Replace(temporary, ReportFile, null); else File.Move(temporary, ReportFile);
    }
    static int TokenNumber(IntPtr token, int kind) {
        int length; GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
        Require(length > 0 && length <= 65536, "token_size_unavailable");
        IntPtr data = Marshal.AllocHGlobal(length);
        try {
            Require(GetTokenInformation(token, kind, data, length, out length), "token_read_unavailable");
            if (kind != 25) return Marshal.ReadInt32(data);
            IntPtr sid = Marshal.ReadIntPtr(data); byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            Require(count > 0, "token_integrity_unavailable"); return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
        } finally { Marshal.FreeHGlobal(data); }
    }
    static object MediumToken(IntPtr process) {
        IntPtr token; Require(OpenProcessToken(process, 8, out token), "token_open_unavailable");
        try {
            int rid = TokenNumber(token, 25), elevated = TokenNumber(token, 20), uiAccess = TokenNumber(token, 26);
            Require(rid == 8192 && elevated == 0 && uiAccess == 0, "ordinary_medium_token_required");
            return new { rid, elevated = false, uiAccess = false };
        } finally { CloseHandle(token); }
    }
    static void OwnChildJob() {
        Job = CreateJobObject(IntPtr.Zero, null); Require(Job != IntPtr.Zero, "cleanup_job_create_failed");
        var info = new JobExtended(); info.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Require(SetInformationJobObject(Job, 9, ref info, (uint)Marshal.SizeOf(typeof(JobExtended))), "cleanup_job_configure_failed");
        // Every subsequently created child inherits this job. The job handle is
        // not inheritable; killing this coordinator also terminates its helpers.
        Require(AssignProcessToJobObject(Job, GetCurrentProcess()), "cleanup_job_attach_failed");
        Report["cleanupJobAttached"] = true;
        // Keep the last job handle until process exit, otherwise it kills us too.
    }
    sealed class Child : IDisposable {
        public Process Process;
        public readonly Dictionary<string, object> Receipt;
        readonly List<object> messages = new List<object>();
        Thread errors;
        int errorBytes;
        public Child(string name) {
            var info = new ProcessStartInfo(Helper, "--stdio-observer") { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false, true), StandardErrorEncoding = new UTF8Encoding(false, true) };
            Process = Process.Start(info); Require(Process != null, "child_start_failed");
            Receipt = new Dictionary<string, object> { { "case", name }, { "pid", Process.Id }, { "executable", Helper },
                { "startedUtc", DateTime.UtcNow.ToString("o") }, { "messages", messages }, { "exitConfirmed", false } };
            Children.Add(Receipt); Save();
            Receipt["integrity"] = MediumToken(Process.Handle);
            // Discard stderr content; count only, with no user input or text logs.
            errors = new Thread(() => { try { var buffer = new char[256]; int count; while ((count = Process.StandardError.Read(buffer, 0, buffer.Length)) > 0) Interlocked.Add(ref errorBytes, count); } catch { } });
            errors.IsBackground = true; errors.Start();
        }
        public void Send(string command) { Process.StandardInput.WriteLine(command); Process.StandardInput.Flush(); }
        public Dictionary<string, object> Read(string expectedType, string generation = null) {
            string line = null; Exception failure = null;
            using (var done = new ManualResetEvent(false)) {
                var reader = new Thread(() => {
                    try {
                        var text = new StringBuilder(); int value;
                        while ((value = Process.StandardOutput.Read()) >= 0 && value != '\n') { Require(text.Length < 2048, "stdout_line_limit"); text.Append((char)value); }
                        if (value >= 0 || text.Length > 0) line = text.ToString().TrimEnd('\r');
                    } catch (Exception error) { failure = error; }
                    finally { try { done.Set(); } catch (ObjectDisposedException) { } }
                });
                reader.IsBackground = true; reader.Start(); Require(done.WaitOne(2500), "stdout_response_timeout");
            }
            if (failure != null) throw new InvalidOperationException("stdout_read_failed");
            Require(line != null, "unexpected_stdout_eof");
            var value_ = Json.DeserializeObject(line) as Dictionary<string, object>; Require(value_ != null, "stdout_json_invalid");
            string type = value_.ContainsKey("type") ? value_["type"] as string : null;
            if (type == "input-activity") {
                // Record classification only. No marker, raw key, text or pointer
                // coordinate is copied, even if a future helper emits extra data.
                Receipt["interferenceObserved"] = true;
                string kind = value_.ContainsKey("kind") ? value_["kind"] as string : null;
                if (kind != "keyboard" && kind != "pointer" && kind != "button" && kind != "wheel") kind = "unknown";
                Receipt["interference"] = new { kind, injected = value_.ContainsKey("injected") && value_["injected"] is bool ? value_["injected"] : null };
                throw new AcceptanceFailure("external_activity_during_no_input_case");
            }
            if (expectedType == "ready") Require(type == "status" && (string)value_["status"] == "ready", "ready_not_received");
            else if (expectedType == "sync") Require(type == "status" && (string)value_["status"] == "sync-complete" && Convert.ToInt32(value_["activeCount"]) == 0, "sync_not_received");
            else Require(type == expectedType && (string)value_["epoch"] == Epoch && (string)value_["generation"] == generation, "arm_ack_mismatch");
            messages.Add(new { type, status = type == "status" ? value_["status"] : null, generation,
                sequence = type == "desktop-armed" ? value_["sequence"] : null });
            Receipt["lastLineUtf8Bytes"] = Encoding.UTF8.GetByteCount(line + Environment.NewLine); Save(); return value_;
        }
        public void Arm(string generation) { Send("ARM " + Epoch + " " + generation + " " + Marker); Read("desktop-armed", generation); }
        public void Exit(string termination) {
            var time = Stopwatch.StartNew();
            if (termination == "quit") Send("QUIT"); else Process.StandardInput.Close();
            bool exited = Process.WaitForExit(ExitLimit); time.Stop();
            Receipt["termination"] = termination; Receipt["exitElapsedMs"] = time.ElapsedMilliseconds; Receipt["exitConfirmed"] = exited;
            if (exited) { Receipt["exitCode"] = Process.ExitCode; Receipt["stderrCharacters"] = Interlocked.CompareExchange(ref errorBytes, 0, 0); }
            Save(); Require(exited, "graceful_exit_timeout"); Require(Process.ExitCode == 0, "nonzero_native_exit");
        }
        public void BlockOutput() {
            // Measure the actual anonymous pipe capacity. A paused reader alone
            // is not evidence of backpressure; the pipe must fill to that size.
            Send("SET"); Read("sync");
            var stream = Process.StandardOutput.BaseStream as FileStream; Require(stream != null, "stdout_pipe_handle_unavailable");
            uint flags, outbound, inbound, instances;
            Require(GetNamedPipeInfo(stream.SafeFileHandle, out flags, out outbound, out inbound, out instances), "stdout_pipe_capacity_unavailable");
            uint capacity = Math.Max(outbound, inbound); Require(capacity >= 256 && capacity <= 65536, "stdout_pipe_capacity_outside_test_bounds");
            int lineBytes = Convert.ToInt32(Receipt["lastLineUtf8Bytes"]), count = (int)capacity / lineBytes + 48;
            Require(count <= 2048, "stdout_fill_command_bound");
            Receipt["stdoutPipeCapacity"] = capacity; Receipt["stdoutFillCommands"] = count; Save();
            // Each SET has one small status; pacing avoids manufacturing command
            // queue overflow instead of testing a blocked output pipe.
            for (int i = 0; i < count; i++) { Require(!Process.HasExited, "child_exited_during_stdout_fill"); Send("SET"); Thread.Sleep(5); }
            uint available = 0; var deadline = Stopwatch.StartNew();
            while (deadline.ElapsedMilliseconds < 2000) {
                Require(PeekNamedPipe(stream.SafeFileHandle, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero), "stdout_pipe_probe_failed");
                if (available > capacity - lineBytes) break; Thread.Sleep(20);
            }
            Receipt["unreadStdoutBytes"] = available; Receipt["stdoutPipeSaturated"] = available > capacity - lineBytes; Save();
            Require(available > capacity - lineBytes && !Process.HasExited, "stdout_backpressure_not_demonstrated");
        }
        public void Dispose() {
            if (Process == null) return;
            try {
                if (!Process.HasExited) {
                    try { Process.StandardInput.Close(); } catch { }
                    if (!Process.WaitForExit(1000)) { Receipt["cleanupKilled"] = true; Process.Kill(); Require(Process.WaitForExit(2500), "cleanup_exit_unconfirmed"); }
                }
                Receipt["cleanupExitConfirmed"] = Process.HasExited; Receipt["cleanupExitCode"] = Process.ExitCode; Save();
            } finally { Process.Dispose(); Process = null; }
        }
    }
    static void Case(string name, Action<Child> body) {
        var record = new Dictionary<string, object> { { "name", name }, { "ok", false }, { "startedUtc", DateTime.UtcNow.ToString("o") } };
        Cases.Add(record); Save();
        using (var child = new Child(name)) { body(child); }
        record["ok"] = true; Save();
    }
    public static int Main(string[] args) {
        if (args.Length != 3 || args[0] != "--run-native-lifecycle") return 2;
        ReportFile = Path.GetFullPath(args[2]); Helper = Path.GetFullPath(args[1]);
        Report["ok"] = false; Report["mode"] = "no-input-lifecycle"; Report["coordinatorPid"] = Process.GetCurrentProcess().Id;
        Report["cases"] = Cases; Report["children"] = Children; Report["startedUtc"] = DateTime.UtcNow.ToString("o");
        Report["injectionPerformed"] = false; Report["windowsCreated"] = false;
        Report["limitations"] = new[] {
            "Process exit proves no helper remains alive; this harness does not enumerate hooks or prove each UnhookWindowsHookEx returned true.",
            "ARM acknowledges installation at that moment, not continuous hook health, physical-event provenance or delivery through other processes' hook chains.",
            "Owned/foreign injected markers and browser blocking are not exercised by this no-input matrix.",
            "Blocked stdout cases intentionally do not drain activity messages; ambient input may already have paused that generation. They do not prove the keyboard hook remained armed until exit.",
            "No App integration, foreground activation, UIA, clipboard, screenshots, real key text or pointer coordinates are inspected."
        };
        try {
            Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8, "windows_x64_required");
            Report["coordinatorIntegrity"] = MediumToken(GetCurrentProcess()); OwnChildJob(); Save();
            Watchdog = new Timer(_ => Environment.Exit(3), null, 60000, Timeout.Infinite);
            Case("arm-disarm-rearm-quit", child => { child.Read("ready"); child.Arm("g1"); child.Send("DISARM " + Epoch + " g1"); child.Arm("g2"); child.Send("DISARM " + Epoch + " g2"); child.Exit("quit"); });
            Case("armed-eof", child => { child.Read("ready"); child.Arm("g1"); child.Exit("eof"); });
            Case("startup-eof", child => { child.Exit("eof"); });
            Case("blocked-stdout-quit", child => { child.Read("ready"); child.Arm("g1"); child.BlockOutput(); child.Exit("quit"); });
            Case("blocked-stdout-eof", child => { child.Read("ready"); child.Arm("g1"); child.BlockOutput(); child.Exit("eof"); });
            Report["ok"] = true; Report["completedUtc"] = DateTime.UtcNow.ToString("o"); Save(); return 0;
        } catch (Exception error) {
            // Messages originate only in the fixed assertions above. Do not emit
            // framework/pipe text that could contain incidental environment data.
            Report["failure"] = error is AcceptanceFailure ? error.Message : error.GetType().Name;
            Report["completedUtc"] = DateTime.UtcNow.ToString("o"); Save(); return 1;
        } finally { if (Watchdog != null) Watchdog.Dispose(); }
    }
}
