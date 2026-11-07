using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Acceptance fixture only: a non-activating window, no input injection or hook.
// The sample mode reads one pinned App identity and its direct native children.
public static class DesktopSessionCycleFixture {
    sealed class UnstableSample : Exception { public UnstableSample() : base("Owned child changed during sample") {} }
    sealed class MissingChildProbe {
        public string ExitConfirmation="none",Executable,StartedUtcTicks;
        public bool? LiveAtOpen,LiveAfterReads;
        public readonly List<object> Errors=new List<object>();
        public object Output(){return new {exitConfirmation=ExitConfirmation,liveAtOpen=LiveAtOpen,liveAfterReads=LiveAfterReads,
            executable=Executable,startedUtcTicks=StartedUtcTicks,errors=Errors};}
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder path,ref int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long creation,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static string Ticks(Process process) { return process.StartTime.ToUniversalTime().Ticks.ToString(); }
    static object Metrics(Process process) {
        process.Refresh();
        return new { pid = process.Id, startedUtcTicks = Ticks(process), handles = process.HandleCount,
            privateBytes = process.PrivateMemorySize64, workingSetBytes = process.WorkingSet64 };
    }
    static bool? ReadChildExit(IntPtr handle,MissingChildProbe probe,string operation) {
        uint wait=WaitForSingleObject(handle,0);
        if(wait==0){probe.ExitConfirmation="signaled_process_handle";return false;}
        if(wait==258)return true;
        probe.Errors.Add(new {operation,waitResult=wait,win32Error=wait==UInt32.MaxValue?(int?)Marshal.GetLastWin32Error():null});return null;
    }
    static MissingChildProbe ProbeMissingPath(int pid) {
        var probe=new MissingChildProbe();
        // Pin the exact process for exit, image and creation-time queries. No
        // module enumeration or all-access process handle is required.
        IntPtr handle=OpenProcess(0x00100000|0x1000,false,pid);
        if(handle==IntPtr.Zero){
            int error=Marshal.GetLastWin32Error();probe.Errors.Add(new {operation="OpenProcess",win32Error=error});
            // Invalid PID is only a hint. Require an independent explicit
            // absence result, and never turn access denied into absence.
            if(error==87 && pid>0)try{using(var process=Process.GetProcessById(pid)){} }
            catch(ArgumentException){probe.ExitConfirmation="pid_not_found_after_invalid_parameter";}
            catch(Exception failure){var native=failure as System.ComponentModel.Win32Exception;probe.Errors.Add(new {operation="ConfirmPidAbsence",errorType=failure.GetType().Name,win32Error=native==null?(int?)null:native.NativeErrorCode});}
            return probe;
        }
        try {
            probe.LiveAtOpen=ReadChildExit(handle,probe,"WaitForExitBeforeReads");
            var path=new StringBuilder(32768);int size=path.Capacity;
            if(QueryFullProcessImageName(handle,0,path,ref size))probe.Executable=path.ToString();
            else probe.Errors.Add(new {operation="QueryFullProcessImageName",win32Error=Marshal.GetLastWin32Error()});
            long creation,exit,kernel,user;
            if(GetProcessTimes(handle,out creation,out exit,out kernel,out user)){
                try{probe.StartedUtcTicks=DateTime.FromFileTimeUtc(creation).Ticks.ToString();}
                catch(ArgumentOutOfRangeException){probe.Errors.Add(new {operation="DecodeCreationTime",errorType="ArgumentOutOfRangeException"});}
            }else probe.Errors.Add(new {operation="GetProcessTimes",win32Error=Marshal.GetLastWin32Error()});
            probe.LiveAfterReads=ReadChildExit(handle,probe,"WaitForExitAfterReads");
            return probe;
        }finally{CloseHandle(handle);}
    }
    static Exception MissingChildPath(int pid,string name,string creationDate,MissingChildProbe probe) {
        // Readable fallback metadata diagnoses the WMI omission; it never makes
        // this incomplete enumeration successful or guesses a non-native child.
        bool exited=probe.ExitConfirmation=="signaled_process_handle" || probe.ExitConfirmation=="pid_not_found_after_invalid_parameter";
        Exception failure=exited?(Exception)new UnstableSample():new InvalidOperationException("CHILD_PATH_UNAVAILABLE");
        failure.Data["child"]=new Dictionary<string,object>{{"pid",pid},{"name",name},{"creationDate",creationDate},{"probe",probe.Output()}};return failure;
    }
    static void Sample(string[] args) {
        Require(args.Length == 3 || args.Length == 4, "SAMPLE_ARGUMENTS");
        int pid = Int32.Parse(args[1]); Require(pid > 0, "INVALID_PID");
        string expectedPath = Path.GetFullPath(args[2]);
        using (var process = Process.GetProcessById(pid)) {
            string ticks = Ticks(process);
            Require(String.Equals(process.MainModule.FileName, expectedPath, StringComparison.OrdinalIgnoreCase), "APP_EXECUTABLE_CHANGED");
            if (args.Length == 4) Require(ticks == args[3], "APP_START_CHANGED");
            var children = new List<object>();
            using (var search = new ManagementObjectSearcher("SELECT ProcessId, Name, CreationDate, ExecutablePath FROM Win32_Process WHERE ParentProcessId = " + pid))
            using (var rows = search.Get()) foreach (ManagementObject row in rows) using (row) {
                int childPid = Convert.ToInt32(row["ProcessId"]);
                string executable = Convert.ToString(row["ExecutablePath"]);
                if(String.IsNullOrWhiteSpace(executable))throw MissingChildPath(childPid,Convert.ToString(row["Name"]),Convert.ToString(row["CreationDate"]),ProbeMissingPath(childPid));
                string directory = Path.GetDirectoryName(executable), kind = null;
                foreach (string name in new[] { "desktop", "input-observer", "windows-sampler" }) if (String.Equals(directory,
                    Path.Combine(Path.GetTempPath(), "profilepilot-" + name + "-runtime"), StringComparison.OrdinalIgnoreCase)) kind = name;
                if (kind == null) continue;
                // A disappearing child is not a stable sample; the runner can
                // take another read, but never equate this error with absence.
                Process child;
                try { child = Process.GetProcessById(childPid); }
                catch (ArgumentException) { throw new UnstableSample(); }
                using (child) {
                    try {
                        IntPtr pinnedHandle = child.Handle;
                        if (child.HasExited || !String.Equals(child.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) throw new UnstableSample();
                        var metrics = Metrics(child);
                        if (child.HasExited) throw new UnstableSample();
                        string hash;
                        using (var sha = SHA256.Create()) using (var file = File.Open(executable, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                            hash = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                        children.Add(new { kind, metrics, executable, sha256 = hash });
                    } catch (InvalidOperationException) { if (child.HasExited) throw new UnstableSample(); throw; }
                }
            }
            Require(!process.HasExited && Ticks(process) == ticks, "APP_EXITED_DURING_SAMPLE");
            Console.WriteLine(Json.Serialize(new { ok = true, app = Metrics(process), children,
                foregroundHwnd = GetForegroundWindow().ToInt64().ToString(), capturedAt = DateTime.UtcNow.ToString("o") }));
        }
    }
    sealed class QuietWindow : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
    }
    static void Save(string file, object value) {
        string temporary = file + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    [STAThread] public static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "--sample") { Console.OutputEncoding=new UTF8Encoding(false);Sample(args);return 0; }
            Require((args.Length == 2 || args.Length == 3) && Regex.IsMatch(args[1], "^[a-f0-9]{32}$"), "FIXTURE_ARGUMENTS");
            int lifetimeMinutes=30;
            Require(args.Length==2 || Int32.TryParse(args[2],out lifetimeMinutes) && lifetimeMinutes>=1 && lifetimeMinutes<=120,"FIXTURE_LIFETIME");
            string fileBase = args[0], nonce = args[1];
            bool administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
            Require(!administrator, "MEDIUM_FIXTURE_REQUIRED");
            SetProcessDpiAwarenessContext(new IntPtr(-4)); Application.EnableVisualStyles();
            using (var process = Process.GetCurrentProcess()) using (var form = new QuietWindow()) using (var timer = new Timer()) {
                string ticks = Ticks(process); int pid = process.Id;
                form.Text = "ProfilePilot session cycle verification"; form.AccessibleName = form.Text;
                form.StartPosition = FormStartPosition.Manual; form.Size = new Size(470, 200);
                var area = Screen.PrimaryScreen.WorkingArea;
                form.Location = new Point(area.Left + Math.Max(0, (area.Width - form.Width) / 2), area.Top + Math.Max(0, (area.Height - form.Height) / 2));
                form.Controls.Add(new Label { Text = "Cycle fixture " + nonce, AccessibleName = "Cycle fixture " + nonce,
                    AutoSize = true, Location = new Point(15, 25) });
                string hwnd = null,closeReason=null;var lifetime=Stopwatch.StartNew();
                form.Shown += delegate {
                    hwnd = form.Handle.ToInt64().ToString();
                    Save(fileBase + ".ready.json", new { nonce, pid, hwnd, startedUtcTicks = ticks, administrator,
                        hooksInstalled = false, inputInjected = false, lifetimeMinutes, foregroundHwnd = GetForegroundWindow().ToInt64().ToString() });
                };
                form.FormClosed += delegate { Save(fileBase + ".closed.json", new { nonce, pid, hwnd, startedUtcTicks = ticks,closeReason }); };
                timer.Interval = 200;
                timer.Tick += delegate {
                    bool close = File.Exists(fileBase + ".close") && File.ReadAllText(fileBase + ".close").Trim() == nonce;
                    if(close)closeReason="nonce_close";
                    else if(!File.Exists(fileBase + ".heartbeat") || DateTime.UtcNow - File.GetLastWriteTimeUtc(fileBase + ".heartbeat") > TimeSpan.FromSeconds(30))closeReason="heartbeat_expired";
                    else if(lifetime.Elapsed>TimeSpan.FromMinutes(lifetimeMinutes))closeReason="hard_lifetime";
                    if(closeReason!=null)form.Close();
                };
                timer.Start(); Application.Run(form);
            }
            return 0;
        } catch (Exception error) { Console.WriteLine(Json.Serialize(new { ok = false, code = error is UnstableSample ? "SAMPLE_UNSTABLE" : "SAMPLE_FAILED", error = error.GetType().Name, message = error.Message, child=error.Data["child"] })); return 1; }
    }
}
