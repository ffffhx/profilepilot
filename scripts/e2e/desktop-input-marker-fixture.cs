using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Isolated acceptance only. Custom dwExtraInfo values are deliberately injected
// and never called physical hardware. No App, browser profile or user document
// is opened. Only this owned foreground window is an allowed input target.
public static class DesktopInputMarkerFixture {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThread { public int Size, Flags; public IntPtr Active, Focus, Capture, Menu, MoveSize, Caret; public Rect CaretRect; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public Keyboard Keyboard; [FieldOffset(0)] public Mouse Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
    [StructLayout(LayoutKind.Sequential)] struct JobBasic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct JobExtended { public JobBasic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetMessageExtraInfo();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr value, int kind, StringBuilder data, int bytes, out int needed);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect value);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect value);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point value);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point value);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point value);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobExtended value, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    const ulong OwnA = 0xa11234567890cdefUL, ForeignB = 0xb22345678901def0UL, OwnC = 0xc33456789012ef01UL;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Dictionary<string, object> Report = new Dictionary<string, object>();
    static readonly List<object> Checks = new List<object>();
    static readonly List<Dictionary<string, object>> Children = new List<Dictionary<string, object>>();
    static readonly object EventsLock = new object();
    static readonly Dictionary<ulong, int[]> KeyEvents = new Dictionary<ulong, int[]>();
    sealed class WindowMarkerReceipt { public string sentMarker,receivedMarker,matchMode;public int down,up,nonForeground; }
    static readonly List<WindowMarkerReceipt> WindowMarkerReceipts=new List<WindowMarkerReceipt>();
    static bool WindowMarkerOverflow;
    static IntPtr Window, PadWindow, Job;
    static string HelperPath, ReportPath, AssistedFile;
    static bool Geometry,Assisted;
    static int MouseDowns, MouseUps;
    static Form Fixture;
    static System.Threading.Timer Watchdog;
    sealed class Failure : Exception { public Failure(string reason) : base(reason) { } }
    static void Require(bool value, string reason) { if (!value) throw new Failure(reason); }
    static void Save() { string temp = ReportPath + ".tmp"; File.WriteAllText(temp, Json.Serialize(Report), new UTF8Encoding(false)); if (File.Exists(ReportPath)) File.Replace(temp, ReportPath, null); else File.Move(temp, ReportPath); }
    static int Number(IntPtr token, int kind) {
        int length; GetTokenInformation(token, kind, IntPtr.Zero, 0, out length); Require(length > 0 && length < 65536, "token_size_unknown");
        IntPtr data = Marshal.AllocHGlobal(length);
        try { Require(GetTokenInformation(token, kind, data, length, out length), "token_unknown"); if (kind != 25) return Marshal.ReadInt32(data);
            IntPtr sid = Marshal.ReadIntPtr(data); byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid)); Require(count > 0, "integrity_unknown"); return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
        } finally { Marshal.FreeHGlobal(data); }
    }
    static object Medium(IntPtr process) {
        IntPtr token; Require(OpenProcessToken(process, 8, out token), "token_open_unknown");
        try { int rid = Number(token, 25), elevated = Number(token, 20), uiAccess = Number(token, 26);
            Require(rid == 8192 && elevated == 0 && uiAccess == 0, "ordinary_medium_required"); return new { rid, elevated = false, uiAccess = false };
        } finally { CloseHandle(token); }
    }
    static void OwnJob() {
        Job = CreateJobObject(IntPtr.Zero, null); Require(Job != IntPtr.Zero, "job_create_failed");
        var value = new JobExtended(); value.Basic.Flags = 0x2000;
        Require(SetInformationJobObject(Job, 9, ref value, (uint)Marshal.SizeOf(typeof(JobExtended))), "job_configure_failed");
        Require(AssignProcessToJobObject(Job, GetCurrentProcess()), "job_attach_failed"); Report["cleanupJobAttached"] = true;
        // Non-inheritable last handle is intentionally kept until process exit.
    }
    static readonly ulong[] TestMarkers=new[]{OwnA,ForeignB,OwnC};
    sealed class InputPad : Control {
        public InputPad() { SetStyle(ControlStyles.Selectable, true); TabStop = true; BackColor = Color.FromArgb(34, 88, 128); }
        protected override void WndProc(ref Message message) {
            // Inspect only our test F24 messages, never decode or log text/other
            // key identities. Markers are test constants, not an authenticity claim.
            if ((message.Msg == 0x100 || message.Msg == 0x101) && message.WParam.ToInt32() == 0x87) {
                ulong marker = unchecked((ulong)GetMessageExtraInfo().ToInt64());
                // WM_* delivery can discard upper bits on the measured system.
                // Keep the actual value and matching mode; hook assertions below
                // still require injected=true and the complete 64-bit marker.
                ulong expected=0;string mode=null;
                foreach(ulong candidate in TestMarkers){mode=OwnedWindowMessageMarker.Match(marker,candidate);if(mode!=null){expected=candidate;break;}}
                bool foreground=GetForegroundWindow()==Window;
                lock (EventsLock) {
                    if(expected!=0){
                        int[] values;if(!KeyEvents.TryGetValue(expected,out values))KeyEvents[expected]=values=new int[3];
                        values[message.Msg==0x100?0:1]++;if(!foreground)values[2]++;
                    }
                    string actual=marker.ToString("x16");WindowMarkerReceipt receipt=null;
                    foreach(var value in WindowMarkerReceipts)if(value.receivedMarker==actual){receipt=value;break;}
                    if(receipt==null && WindowMarkerReceipts.Count<16){receipt=new WindowMarkerReceipt{sentMarker=expected==0?null:expected.ToString("x16"),receivedMarker=actual,matchMode=mode??"unmatched"};WindowMarkerReceipts.Add(receipt);}
                    if(receipt==null)WindowMarkerOverflow=true;
                    else {if(message.Msg==0x100)receipt.down++;else receipt.up++;if(!foreground)receipt.nonForeground++;}
                }
            }
            if (message.Msg == 0x201) Interlocked.Increment(ref MouseDowns);
            if (message.Msg == 0x202) Interlocked.Increment(ref MouseUps);
            base.WndProc(ref message);
        }
    }
    static int[] Counts(ulong marker) { lock (EventsLock) { int[] result; return KeyEvents.TryGetValue(marker, out result) ? (int[])result.Clone() : new int[3]; } }
    static void InputPreflight() {
        Require(GetForegroundWindow() == Window, "owned_window_not_foreground");
        IntPtr desktop = OpenInputDesktop(0, false, 1); Require(desktop != IntPtr.Zero, "input_desktop_unknown");
        try { int needed; var name = new StringBuilder(256); Require(GetUserObjectInformation(desktop, 2, name, 512, out needed) && name.ToString() == "Default", "input_desktop_not_default"); } finally { CloseDesktop(desktop); }
        foreach (int key in new[] { 1, 2, 4, 5, 6, 0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x87 }) Require((GetAsyncKeyState(key) & 0x8000) == 0, "held_input_conflict");
        uint pid; uint thread = GetWindowThreadProcessId(Window, out pid); var queue = new GuiThread { Size = Marshal.SizeOf(typeof(GuiThread)) };
        Require(GetGUIThreadInfo(thread, ref queue) && queue.Focus == PadWindow && queue.Capture == IntPtr.Zero && (queue.Flags & 0x1e) == 0, "owned_focus_or_capture_changed");
        Require(GetForegroundWindow() == Window, "foreground_changed_before_input");
    }
    static Input Key(ulong marker, bool up) { return new Input { Type = 1, Data = new InputData { Keyboard = new Keyboard { Vk = 0x87, Flags = up ? 2U : 0U, Extra = new UIntPtr(marker) } } }; }
    static void Pair(ulong marker) {
        InputPreflight(); var before = Counts(marker); uint sent = SendInput(2, new[] { Key(marker, false), Key(marker, true) }, Marshal.SizeOf(typeof(Input)));
        if (sent != 2) {
            if (sent == 1) SendInput(1, new[] { Key(marker, true) }, Marshal.SizeOf(typeof(Input))); // Release only our attempted F24.
            throw new Failure("injection_outcome_unknown_no_retry");
        }
        var wait = Stopwatch.StartNew(); int[] after;
        do { after = Counts(marker); if (after[0] == before[0] + 1 && after[1] == before[1] + 1) break; Thread.Sleep(10); } while (wait.ElapsedMilliseconds < 1500);
        Require(after[0] == before[0] + 1 && after[1] == before[1] + 1 && after[2] == 0, "test_key_not_received_by_owned_foreground_pad");
    }
    sealed class Observer : IDisposable {
        public readonly Process Process;
        public readonly string Epoch;
        readonly Queue<Dictionary<string, object>> queue = new Queue<Dictionary<string, object>>();
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        readonly Dictionary<string, object> receipt;
        string readFailure;
        bool ended;
        public Observer(string epoch) {
            Epoch = epoch; Process = Process.Start(new ProcessStartInfo(HelperPath, "--stdio-observer") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true });
            Require(Process != null, "observer_start_failed");
            receipt = new Dictionary<string, object> { { "pid", Process.Id }, { "executable", HelperPath }, { "epoch", epoch }, { "exitConfirmed", false } };
            Children.Add(receipt); Save(); receipt["integrity"] = Medium(Process.Handle);
            var reader = new Thread(() => {
                try {
                    var serializer = new JavaScriptSerializer(); var text = new StringBuilder(); int value;
                    while ((value = Process.StandardOutput.Read()) >= 0) {
                        if (value != '\n') { if (text.Length >= 2048) throw new Failure("protocol_line_limit"); text.Append((char)value); continue; }
                        var message = serializer.DeserializeObject(text.ToString().TrimEnd('\r')) as Dictionary<string, object>; text.Length = 0;
                        if (message == null) throw new Failure("protocol_json_invalid");
                        lock (queue) { if (queue.Count >= 64) throw new Failure("protocol_queue_limit"); queue.Enqueue(message); } signal.Set();
                    }
                } catch { lock (queue) readFailure = "protocol_reader_failed"; }
                finally { lock (queue) ended = true; signal.Set(); }
            }); reader.IsBackground = true; reader.Start();
            var errors = new Thread(() => { try { while (Process.StandardError.Read() >= 0) { } } catch { } }); errors.IsBackground = true; errors.Start();
            Expect("status", "ready");
        }
        public void Send(string value) { Process.StandardInput.WriteLine(value); Process.StandardInput.Flush(); }
        public Dictionary<string, object> Next(int milliseconds) {
            var watch = Stopwatch.StartNew();
            do {
                lock (queue) { Require(readFailure == null, "observer_reader_failed"); if (queue.Count > 0) return queue.Dequeue(); Require(!ended, "observer_exited_early"); }
                signal.WaitOne(Math.Min(20, milliseconds));
            } while (watch.ElapsedMilliseconds < milliseconds);
            return null;
        }
        public Dictionary<string, object> Expect(string type, string status = null, string generation = null) {
            var value = Next(2500);
            if(value == null || (string)value["type"] != type || status != null && (string)value["status"] != status
                || generation != null && ((string)value["epoch"] != Epoch || (string)value["generation"] != generation)) {
                receipt["unexpected"] = new { expectedType = type, expectedStatus = status, expectedGeneration = generation, received = value }; Save();
            }
            Require(value != null && (string)value["type"] == type, "unexpected_observer_event");
            if (status != null) Require((string)value["status"] == status, "unexpected_observer_status");
            if (generation != null) Require((string)value["epoch"] == Epoch && (string)value["generation"] == generation, "observer_generation_mismatch");
            return value;
        }
        public void Quiet() {
            var value=Next(200);
            if(value!=null){receipt["unexpected"]=new{expectedType="quiet",received=value};Save();}
            Require(value == null, "unexpected_activity_or_status");
        }
        public void Arm(string generation, ulong marker) { Send("ARM " + Epoch + " " + generation + " " + marker.ToString("x16")); Expect("desktop-armed", null, generation); }
        public void Active(string generation, ulong marker) { Quiet(); Arm(generation, marker); }
        public void External(string generation, ulong marker) {
            var value = Expect("input-activity", null, generation);
            Require((string)value["kind"] == "keyboard" && (bool)value["injected"] && (string)value["marker"] == marker.ToString("x16"), "external_classification_mismatch");
            ulong sequence; Require(UInt64.TryParse(value["sequence"] as string, out sequence) && sequence > 0, "external_sequence_invalid");
            Require(value.Count == 7, "desktop_activity_contains_unexpected_fields"); Quiet();
            Checks.Add(new { name = "external-injected-pause", epoch = Epoch, generation, sequence = sequence.ToString(), injected = true, kind = "keyboard" }); Save();
        }
        public void Dispose() {
            try {
                if (!Process.HasExited) { Send("QUIT"); if (!Process.WaitForExit(2500)) { receipt["cleanupKilled"] = true; Process.Kill(); Require(Process.WaitForExit(2500), "observer_cleanup_unconfirmed"); } }
                receipt["exitConfirmed"] = Process.HasExited; receipt["exitCode"] = Process.ExitCode; Save();
            } finally { Process.Dispose(); }
        }
    }
    static void GeometryCase(Observer observer, string generation) {
        uint dpi = GetDpiForWindow(Window);
        var record = new Dictionary<string, object> { { "requested", Geometry }, { "covered", false }, { "actualDpi", dpi }, { "requiredDpi", 120 } };
        Report["browserGeometry"] = record; Save();
        if (!Geometry || dpi != 120) { record["reason"] = Geometry ? "actual_monitor_is_not_125_percent" : "not_requested"; return; }
        InputPreflight(); Require(AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)), "fixture_geometry_not_pmv2");
        Rect outer = new Rect(), client = new Rect(); Require(GetWindowRect(Window, out outer) && GetClientRect(PadWindow, out client), "owned_geometry_unknown");
        record["expectedWindowRect"]=new{x=outer.Left,y=outer.Top,width=outer.Right-outer.Left,height=outer.Bottom-outer.Top};
        var geometryMessages=new List<object>();record["receivedMessages"]=geometryMessages;Save();
        var target = new Point { X = client.Right / 2, Y = client.Bottom / 2 }; Require(ClientToScreen(PadWindow, ref target), "owned_point_unknown");
        observer.Send("SET " + Process.GetCurrentProcess().Id); observer.Expect("status", "tap-active"); var sync = observer.Expect("status", "sync-complete"); Require(Convert.ToInt32(sync["activeCount"]) == 1, "browser_guard_not_active");
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        Require(width > 0 && height > 0 && width <= 65535 && height <= 65535, "virtual_screen_unrepresentable");
        Require(target.X >= left && target.X < left + width && target.Y >= top && target.Y < top + height, "point_outside_virtual_screen");
        int x = (int)(((long)(target.X - left) * 2 + 1) * 65536 / (width * 2L)), y = (int)(((long)(target.Y - top) * 2 + 1) * 65536 / (height * 2L));
        uint pointerMarker=unchecked((uint)OwnC);
        record["pointerMarker"]=((ulong)pointerMarker).ToString("x16");
        record["pointerMarkerBits"]=32;
        var move = new Input { Type = 0, Data = new InputData { Mouse = new Mouse { X = x, Y = y, Flags = 0xc001, Extra = new UIntPtr(pointerMarker) } } };
        Require(SendInput(1, new[] { move }, Marshal.SizeOf(typeof(Input))) == 1, "mouse_move_outcome_unknown"); Thread.Sleep(50);
        Point actual; Require(GetCursorPos(out actual) && actual.X == target.X && actual.Y == target.Y && GetAncestor(WindowFromPoint(actual), 2) == Window, "owned_pointer_target_not_confirmed");
        InputPreflight(); int downs = Interlocked.CompareExchange(ref MouseDowns, 0, 0), ups = Interlocked.CompareExchange(ref MouseUps, 0, 0);
        var down = new Input { Type = 0, Data = new InputData { Mouse = new Mouse { Flags = 2, Extra = new UIntPtr(pointerMarker) } } };
        var up = new Input { Type = 0, Data = new InputData { Mouse = new Mouse { Flags = 4, Extra = new UIntPtr(pointerMarker) } } };
        uint sent = SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(Input)));
        if (sent == 1) SendInput(1, new[] { up }, Marshal.SizeOf(typeof(Input)));
        Require(sent == 2, "mouse_pair_outcome_unknown");
        foreach (string phase in new[] { "down", "up" }) {
            var value = observer.Expect("mouse");
            geometryMessages.Add(value);Save();
            Require((string)value["phase"] == phase && Convert.ToInt32(value["pid"]) == Process.GetCurrentProcess().Id && Convert.ToInt64(value["windowId"]) == Window.ToInt64(), "legacy_mouse_identity_mismatch");
            Require(Convert.ToInt32(value["x"]) == target.X && Convert.ToInt32(value["y"]) == target.Y && Math.Abs(Convert.ToDouble(value["displayScale"]) - 1.25) < 0.0001, "legacy_physical_point_or_scale_mismatch");
            var bounds = value["window"] as Dictionary<string, object>; Require(bounds != null && Convert.ToInt32(bounds["x"]) == outer.Left && Convert.ToInt32(bounds["y"]) == outer.Top && Convert.ToInt32(bounds["width"]) == outer.Right - outer.Left && Convert.ToInt32(bounds["height"]) == outer.Bottom - outer.Top, "legacy_physical_rectangle_mismatch");
        }
        Thread.Sleep(100); Require(MouseDowns == downs && MouseUps == ups, "guarded_mouse_was_delivered_to_fixture"); observer.Active(generation, OwnC);
        observer.Send("SET"); observer.Expect("status", "tap-removed"); observer.Expect("status", "sync-complete");
        record["covered"] = true; record["ownTestPoint"] = new { x = target.X, y = target.Y };
        record["ownedWindowRect"] = new { x = outer.Left, y = outer.Top, width = outer.Right - outer.Left, height = outer.Bottom - outer.Top };
        record["mouseMessages"] = 2; record["fixtureMouseDelivered"] = 0; Save();
    }
    static void RunCases() {
        try {
            if(Assisted){
                var waiting=Stopwatch.StartNew();
                while(!File.Exists(AssistedFile+".foreground.accepted") && waiting.ElapsedMilliseconds<20000)Thread.Sleep(20);
                Require(File.Exists(AssistedFile+".foreground.accepted"),"assisted_preparation_not_confirmed");
                var receipt=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(AssistedFile+".foreground.receipt.json"));
                Require((string)receipt["nonce"]==File.ReadAllText(AssistedFile+".foreground.accepted") && (bool)receipt["topMostRestored"] &&
                    Convert.ToInt32(receipt["downCount"])==1 && Convert.ToInt32(receipt["upCount"])==1,"assisted_receipt_invalid");
                var focused=new ManualResetEventSlim(false);bool focusSucceeded=false;
                Fixture.BeginInvoke(new Action(()=>{try{var control=Control.FromHandle(PadWindow);focusSucceeded=control!=null && control.Focus();}finally{focused.Set();}}));
                // On timeout the fixture exits; do not dispose an event that a
                // still-pending UI callback may signal during teardown.
                Require(focused.Wait(2000),"owned_pad_focus_timeout");focused.Dispose();Require(focusSucceeded,"owned_pad_focus_failed");
                // The observer children and their counters start only below,
                // after setup has ended and the owned test pad regains focus.
                Report["assistedPreparationConfirmed"]=true;Save();
            }
            var activation = Stopwatch.StartNew();
            while (GetForegroundWindow() != Window && activation.ElapsedMilliseconds < 350) Thread.Sleep(10);
            InputPreflight(); Report["targetForegroundConfirmed"] = true; Report["dpi"] = GetDpiForWindow(Window); Save();
            using (var observer = new Observer("epoch-one")) {
                observer.Arm("g1", OwnA); Pair(OwnA); observer.Active("g1", OwnA); Checks.Add(new { name = "own-marker-ignored", epoch = observer.Epoch, generation = "g1", injected = true }); Save();
                Pair(ForeignB); observer.External("g1", ForeignB);
                Pair(ForeignB); observer.Quiet(); observer.Send("ARM epoch-one g1 " + OwnA.ToString("x16")); observer.Expect("status", "invalid-command");
                Checks.Add(new { name = "foreign-latches-once-no-same-generation-revival" }); Save();
                observer.Send("REARM epoch-one g1 g-refused " + OwnC.ToString("x16"));
                var refused=observer.Expect("observer-fault",null,"g-refused");
                Require((string)refused["reason"]=="unavailable","latched_predecessor_rearm_not_refused");observer.Quiet();
                Checks.Add(new{name="latched-predecessor-refuses-continuous-rearm"});Save();
                observer.Arm("g2", OwnC); Pair(OwnA); observer.Active("g2", OwnC);
                observer.Send("DISARM epoch-one g1"); Pair(OwnC); observer.Active("g2", OwnC);
                Checks.Add(new { name = "same-child-old-marker-retained-and-stale-disarm-ignored" }); Save();
                observer.Send("REARM epoch-one g2 g2-next " + OwnC.ToString("x16"));
                observer.Expect("desktop-armed",null,"g2-next");Pair(OwnA);observer.Active("g2-next",OwnC);
                observer.Send("DISARM epoch-one g2");Pair(OwnC);observer.Active("g2-next",OwnC);
                Checks.Add(new{name="continuous-rearm-retains-marker-and-ignores-old-stop"});Save();
                GeometryCase(observer, "g2-next");
            }
            using (var observer = new Observer("epoch-two")) {
                observer.Arm("g3", OwnC); Pair(OwnA); observer.External("g3", OwnA);
                Checks.Add(new { name = "new-child-old-marker-is-external" }); Save();
                observer.Arm("g4", OwnA); Pair(OwnA); observer.Active("g4", OwnA);
                Checks.Add(new { name = "explicit-new-generation-and-registration-required" }); Save();
            }
            Report["ok"] = true;
        } catch (Exception error) { Report["failure"] = error is Failure ? error.Message : error.GetType().Name; }
        finally {
            var events = new List<object>(); foreach (ulong marker in new[] { OwnA, ForeignB, OwnC }) { var count = Counts(marker); events.Add(new { marker = marker.ToString("x16"), down = count[0], up = count[1], nonForeground = count[2] }); }
            Report["ownedTestKeyReceipts"] = events;
            lock(EventsLock)Report["windowMessageMarkerEvidence"]=new{source="GetMessageExtraInfo",pointerBits=IntPtr.Size*8,lowLevelHookEvidence=false,
                candidateLowWordsDistinct=true,events=WindowMarkerReceipts.ToArray(),overflow=WindowMarkerOverflow};
            Report["completedUtc"] = DateTime.UtcNow.ToString("o"); Save();
            Fixture.BeginInvoke(new Action(() => Fixture.Close()));
        }
    }
    [STAThread] public static int Main(string[] args) {
        if (args.Length < 3 || args.Length > 5 || args[0] != "--run-owned-markers") return 2;
        var flags=new HashSet<string>();for(int index=3;index<args.Length;index++)if(!flags.Add(args[index]) || args[index]!="--browser-geometry" && args[index]!="--assisted-foreground")return 2;
        HelperPath = Path.GetFullPath(args[1]); ReportPath = Path.GetFullPath(args[2]); Geometry = flags.Contains("--browser-geometry");Assisted=flags.Contains("--assisted-foreground");
        AssistedFile=Path.Combine(Path.GetDirectoryName(HelperPath),"assisted-fixture");
        Report["ok"] = false; Report["mode"] = "owned-injected-markers"; Report["fixturePid"] = Process.GetCurrentProcess().Id;
        Report["checks"] = Checks; Report["children"] = Children; Report["startedUtc"] = DateTime.UtcNow.ToString("o");
        Report["assistedForeground"]=Assisted;Report["productAutonomousActivationProven"]=false;
        Report["markerEvidenceSeparation"]="Owned WM delivery receipts allow only exact64 or zero-extended-low32 correlation; observer child protocol asserts full64 separately.";
        Report["limitations"] = new[] { "All test input is injected. Physical hardware takeover is not covered.", "Foreground and receipt checks cannot remove the OS scheduling race between checking and dispatching input.", "This isolated native helper is not connected to the ProfilePilot App or browser registry.", "Geometry exercises the legacy browser PID guard on an owned WinForms window, not Chrome/Electron ownership or application behavior.", "125% DPI geometry is covered only when --browser-geometry is requested and the actual target monitor reports 120 DPI." };
        try {
            OwnedWindowMessageMarker.ValidateCandidates(TestMarkers);
            Require(IntPtr.Size == 8 && Marshal.SizeOf(typeof(Input)) == 40, "x64_input_layout_required"); Report["fixtureIntegrity"] = Medium(GetCurrentProcess()); OwnJob();
            Require(SetProcessDpiAwarenessContext(new IntPtr(-4)) || AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)), "fixture_pmv2_unavailable");
            Save(); Watchdog = new System.Threading.Timer(_ => Environment.Exit(3), null, 60000, Timeout.Infinite);
            Application.EnableVisualStyles();
            using (Fixture = new Form { Text = "ProfilePilot owned input-marker acceptance", ClientSize = new Size(620, 320), StartPosition = FormStartPosition.CenterScreen, AutoScaleMode = AutoScaleMode.None }) {
                var pad = new InputPad { Dock = DockStyle.Fill }; Fixture.Controls.Add(pad);
                new AssistedForegroundFixture(Fixture,AssistedFile,Assisted);
                Fixture.Shown += (sender, event_) => {
                    Window = Fixture.Handle; PadWindow = pad.Handle;
                    // Normal activation of our newly created window only. No ALT,
                    // ASFW grant, AttachThreadInput, elevation or other target.
                    if(!Assisted){Fixture.Activate();pad.Focus();}
                    File.WriteAllText(AssistedFile+".environment.json",Json.Serialize(new{pid=Process.GetCurrentProcess().Id,
                        startedUtcTicks=Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),hwnd=Window.ToInt64().ToString()}),new UTF8Encoding(false));
                    var runner = new Thread(RunCases); runner.IsBackground = true; runner.Start();
                };
                Application.Run(Fixture);
            }
            return Report.ContainsKey("ok") && (bool)Report["ok"] ? 0 : 1;
        } catch (Exception error) { Report["failure"] = error is Failure ? error.Message : error.GetType().Name; Report["completedUtc"] = DateTime.UtcNow.ToString("o"); Save(); return 1; }
        finally { if (Watchdog != null) Watchdog.Dispose(); }
    }
}
