using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Acceptance only. No hooks are installed. One explicit nonce authorizes one
// synthetic foreign-marked F24 pair, addressed only while this Edit is focused.
public sealed class TakeoverRequest {
    public string action, nonce, marker, hwnd, startedUtcTicks;
    public int pid;
    public long expiresAt;
}
public sealed class TakeoverPreflight {
    public bool ownedForeground, ownedFocus, defaultDesktop, sameProcess, interactive, visible, enabled;
    public int heldCount;
    public string foregroundHwnd, focusHwnd;
    public long capturedAt;
}
public static class TakeoverPolicy {
    public static void Require(bool condition, string reason) { if (!condition) throw new InvalidOperationException(reason); }
    public static void Validate(TakeoverRequest request, string nonce, string marker, int pid, string hwnd, string ticks, long now, TakeoverPreflight state) {
        Require(request != null && state != null, "TAKEOVER_EVIDENCE_MISSING");
        Require(Regex.IsMatch(nonce ?? "", "^[a-f0-9]{32}$") && Regex.IsMatch(marker ?? "", "^[a-f0-9]{16}$") &&
            UInt64.Parse(marker, System.Globalization.NumberStyles.HexNumber) > UInt32.MaxValue && Convert.ToUInt32(marker.Substring(8), 16) != 0,
            "TAKEOVER_EXPECTATION_INVALID");
        Require(request.action == "foreign-f24" && request.nonce == nonce && request.marker == marker, "TAKEOVER_TOKEN_MISMATCH");
        Require(pid > 0 && request.pid == pid && request.hwnd == hwnd && request.startedUtcTicks == ticks, "TAKEOVER_IDENTITY_CHANGED");
        Require(request.expiresAt > now && request.expiresAt - now <= 5000, "TAKEOVER_REQUEST_EXPIRED");
        Require(state.ownedForeground && state.ownedFocus && state.sameProcess, "TAKEOVER_OWNED_FOCUS_REQUIRED");
        Require(state.defaultDesktop && !state.interactive && state.visible && state.enabled, "TAKEOVER_INPUT_STATE_UNAVAILABLE");
        Require(state.heldCount == 0, "TAKEOVER_HELD_INPUT");
    }
}
// A pure one-shot sender seam: retries can release an attempted F24, never
// repeat its down. Count != 2 remains unknown even if cleanup inserts an up.
public sealed class TakeoverPairOnce {
    public bool Attempted;
    public uint? Inserted, CleanupInserted;
    public string Outcome = "not_attempted";
    public void Send(Func<uint> pair, Func<uint> release) {
        TakeoverPolicy.Require(!Attempted, "TAKEOVER_INPUT_ALREADY_ATTEMPTED");
        Attempted = true;
        try { Inserted = pair(); }
        catch { Outcome = "unknown"; try { CleanupInserted = release(); } catch { } throw; }
        if (Inserted == 2) { Outcome = "inserted_not_yet_received"; return; }
        Outcome = Inserted == 0 ? "not_inserted" : "unknown";
        if (Inserted != 0) try { CleanupInserted = release(); } catch { }
        throw new InvalidOperationException("TAKEOVER_INPUT_NOT_CONFIRMED_NO_RETRY");
    }
}

public static class DesktopTakeoverFixture {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThread { public int Size, Flags; public IntPtr Active, Focus, Capture, Menu, MoveSize, Caret; public Rect CaretRect; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public Keyboard Keyboard; [FieldOffset(0)] public Mouse Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
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

    sealed class MarkerCount { public string marker; public int down, up; }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly List<MarkerCount> Markers = new List<MarkerCount>();
    static readonly List<object> ForeignEvents = new List<object>();
    static readonly TakeoverPairOnce Pair = new TakeoverPairOnce();
    static Form Form;
    static TextBox Edit;
    static IntPtr Window;
    static string FileBase, Nonce, Marker, StartedTicks, Error;
    static ulong MarkerValue;
    static bool Seen, Dirty, MarkerOverflow, Complete, Released;
    static int Sequence, TextChanges, ForeignDown, ForeignUp, UnmatchedF24, NonForeground;
    static long AttemptAt, ReceivedAt;
    static TakeoverPreflight Preflight;

    static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
    static void Save(string suffix, object value) {
        string file = FileBase + suffix, temporary = file + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    sealed class ReceiptEdit : TextBox {
        protected override bool IsInputKey(Keys key) { return (key & Keys.KeyCode) == Keys.F24 || base.IsInputKey(key); }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x100 || message.Msg == 0x101) {
                ulong actual = unchecked((ulong)GetMessageExtraInfo().ToInt64());
                string marker = actual.ToString("x16");
                var count = Markers.FirstOrDefault(value => value.marker == marker);
                if (count == null && Markers.Count < 16) { count = new MarkerCount { marker = marker }; Markers.Add(count); }
                if (count == null) MarkerOverflow = true; else if (message.Msg == 0x100) count.down++; else count.up++;
                if (message.WParam.ToInt32() == 0x87) {
                    string match = OwnedWindowMessageMarker.Match(actual, MarkerValue);
                    bool owned = GetForegroundWindow() == Window;
                    if (!owned) NonForeground++;
                    if (!Seen || !Pair.Attempted || match == null) UnmatchedF24++;
                    else if (message.Msg == 0x100) ForeignDown++; else ForeignUp++;
                    if (ForeignEvents.Count < 8) ForeignEvents.Add(new { kind = message.Msg == 0x100 ? "down" : "up", actualMarker = marker,
                        matchMode = match ?? "unmatched", targetWasForeground = owned, receivedAt = Now() });
                    else MarkerOverflow = true;
                }
                Sequence++; Dirty = true;
            }
            base.WndProc(ref message);
        }
    }
    static object Receipt() { return new { version = 1, pid = Process.GetCurrentProcess().Id, hwnd = Window.ToInt64().ToString(), nonce = Nonce,
        sequence = Sequence, text = Edit.Text, textChanges = TextChanges, editFocused = Edit.Focused, targetWasForeground = GetForegroundWindow() == Window,
        markerEvidence = new { source = "GetMessageExtraInfo", pointerBits = IntPtr.Size * 8, lowLevelHookEvidence = false, counts = Markers.ToArray(), overflow = MarkerOverflow },
        foreign = new { requested = Seen, sentMarker = Marker, markerBits = 64, provenance = "fixture-synthetic-SendInput", hardwareInput = false,
            attempted = Pair.Attempted, inserted = Pair.Inserted, cleanupInserted = Pair.CleanupInserted, outcome = Pair.Outcome,
            attemptAt = AttemptAt, receivedAt = ReceivedAt, down = ForeignDown, up = ForeignUp, unmatched = UnmatchedF24, nonForeground = NonForeground,
            complete = Complete, released = Released, error = Error, preflight = Preflight, events = ForeignEvents.ToArray() } }; }
    static void Flush() { if (Dirty) { Save(".input.json", Receipt()); Dirty = false; } }
    static TakeoverPreflight ObservePreflight() {
        IntPtr foreground = GetForegroundWindow(); uint pid;
        uint thread = GetWindowThreadProcessId(Form.Handle, out pid);
        var queue = new GuiThread { Size = Marshal.SizeOf(typeof(GuiThread)) };
        bool known = GetGUIThreadInfo(thread, ref queue), desktopDefault = false;
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop != IntPtr.Zero) try {
            int needed; var name = new StringBuilder(256);
            desktopDefault = GetUserObjectInformation(desktop, 2, name, 512, out needed) && name.ToString() == "Default";
        } finally { CloseDesktop(desktop); }
        int held = 0;
        for (int key = 1; key <= 254; key++) if ((GetAsyncKeyState(key) & 0x8000) != 0) held++;
        return new TakeoverPreflight { ownedForeground = foreground == Form.Handle && GetForegroundWindow() == Form.Handle,
            ownedFocus = known && queue.Focus == Edit.Handle && Edit.Focused, sameProcess = pid == Process.GetCurrentProcess().Id,
            defaultDesktop = desktopDefault, interactive = !known || queue.Capture != IntPtr.Zero || queue.Menu != IntPtr.Zero || queue.MoveSize != IntPtr.Zero || (queue.Flags & 0x1e) != 0,
            visible = Form.Visible && Form.WindowState != FormWindowState.Minimized, enabled = Form.Enabled && Edit.Enabled,
            heldCount = held, foregroundHwnd = foreground.ToInt64().ToString(), focusHwnd = queue.Focus.ToInt64().ToString(), capturedAt = Now() };
    }
    static Input Key(bool up) { return new Input { Type = 1, Data = new InputData { Keyboard = new Keyboard { Vk = 0x87, Flags = up ? 2U : 0U, Extra = new UIntPtr(MarkerValue) } } }; }
    static void Tick() {
        if (File.Exists(FileBase + ".close")) { Form.Close(); return; }
        if (File.Exists(FileBase + ".heartbeat") && DateTime.UtcNow - File.GetLastWriteTimeUtc(FileBase + ".heartbeat") > TimeSpan.FromSeconds(90)) { Form.Close(); return; }
        if (!Seen && File.Exists(FileBase + ".foreign.request.json")) {
            Seen = true; Dirty = true;
            try {
                var info = new FileInfo(FileBase + ".foreign.request.json");
                TakeoverPolicy.Require(info.Length > 0 && info.Length <= 4096 && (info.Attributes & FileAttributes.ReparsePoint) == 0, "TAKEOVER_REQUEST_FILE_INVALID");
                var request = Json.Deserialize<TakeoverRequest>(File.ReadAllText(info.FullName));
                Preflight = ObservePreflight();
                TakeoverPolicy.Validate(request, Nonce, Marker, Process.GetCurrentProcess().Id, Form.Handle.ToInt64().ToString(), StartedTicks, Now(), Preflight);
                TakeoverPolicy.Require(GetForegroundWindow() == Form.Handle, "TAKEOVER_FOREGROUND_CHANGED_BEFORE_INPUT");
                AttemptAt = Now();
                Pair.Send(() => SendInput(2, new[] { Key(false), Key(true) }, Marshal.SizeOf(typeof(Input))),
                    () => SendInput(1, new[] { Key(true) }, Marshal.SizeOf(typeof(Input))));
            } catch (Exception error) { Error = error.Message; }
        }
        if (Pair.Attempted && !Complete && Error == null) {
            Released = (GetAsyncKeyState(0x87) & 0x8000) == 0;
            if (ForeignDown == 1 && ForeignUp == 1 && UnmatchedF24 == 0 && NonForeground == 0 && !MarkerOverflow && Released) {
                Complete = true; ReceivedAt = Now(); Pair.Outcome = "received_by_owned_edit"; Dirty = true;
            } else if (Now() - AttemptAt > 2000) { Error = "TAKEOVER_RECEIPT_UNKNOWN_NO_RETRY"; Pair.Outcome = "unknown"; Dirty = true; }
        }
        Flush();
    }
    static void PureChecks(string output) {
        int checks = 0;
        string nonce = new string('a', 32), marker = "b22345678901def0";
        Func<TakeoverRequest> request = () => new TakeoverRequest { action = "foreign-f24", nonce = nonce, marker = marker, pid = 42, hwnd = "123", startedUtcTicks = "456", expiresAt = 6000 };
        Func<TakeoverPreflight> state = () => new TakeoverPreflight { ownedForeground = true, ownedFocus = true, sameProcess = true, defaultDesktop = true, visible = true, enabled = true };
        Action<TakeoverRequest, TakeoverPreflight> validate = (r, s) => TakeoverPolicy.Validate(r, nonce, marker, 42, "123", "456", 1000, s);
        Action<Action, string> rejects = (action, code) => { try { action(); } catch (InvalidOperationException error) { TakeoverPolicy.Require(error.Message == code, "Unexpected pure failure: " + error.Message); checks++; return; } throw new Exception("Missing rejection: " + code); };
        validate(request(), state()); checks++;
        foreach (string field in new[] { "nonce", "marker", "action", "pid", "hwnd", "ticks", "expired", "future" }) {
            var r = request();
            if (field == "nonce") r.nonce = new string('b', 32); if (field == "marker") r.marker = "c33456789012ef01"; if (field == "action") r.action = "anything";
            if (field == "pid") r.pid++; if (field == "hwnd") r.hwnd = "999"; if (field == "ticks") r.startedUtcTicks = "999";
            if (field == "expired") r.expiresAt = 1000; if (field == "future") r.expiresAt = 6001;
            rejects(() => validate(r, state()), field == "nonce" || field == "marker" || field == "action" ? "TAKEOVER_TOKEN_MISMATCH" : field == "expired" || field == "future" ? "TAKEOVER_REQUEST_EXPIRED" : "TAKEOVER_IDENTITY_CHANGED");
        }
        foreach (string field in new[] { "foreground", "focus", "process", "desktop", "interactive", "visible", "enabled", "held" }) {
            var s = state(); if (field == "foreground") s.ownedForeground = false; if (field == "focus") s.ownedFocus = false; if (field == "process") s.sameProcess = false;
            if (field == "desktop") s.defaultDesktop = false; if (field == "interactive") s.interactive = true; if (field == "visible") s.visible = false; if (field == "enabled") s.enabled = false; if (field == "held") s.heldCount = 1;
            rejects(() => validate(request(), s), field == "foreground" || field == "focus" || field == "process" ? "TAKEOVER_OWNED_FOCUS_REQUIRED" : field == "held" ? "TAKEOVER_HELD_INPUT" : "TAKEOVER_INPUT_STATE_UNAVAILABLE");
        }
        foreach (uint sent in new uint[] { 0, 1, 2, 3 }) {
            var pair = new TakeoverPairOnce(); int calls = 0, releases = 0;
            Action run = () => pair.Send(() => { calls++; return sent; }, () => { releases++; return 1; });
            if (sent == 2) { run(); checks++; } else rejects(run, "TAKEOVER_INPUT_NOT_CONFIRMED_NO_RETRY");
            rejects(run, "TAKEOVER_INPUT_ALREADY_ATTEMPTED");
            TakeoverPolicy.Require(calls == 1 && releases == (sent == 1 || sent == 3 ? 1 : 0), "Unexpected input retry"); checks++;
        }
        var throwing = new TakeoverPairOnce(); int cleanup = 0;
        rejects(() => throwing.Send(() => { throw new InvalidOperationException("unknown-submit"); }, () => { cleanup++; return 1; }), "unknown-submit");
        TakeoverPolicy.Require(cleanup == 1 && throwing.Outcome == "unknown", "Unknown submission cleanup missing"); checks++;
        MarkerValue = Convert.ToUInt64(marker, 16);
        TakeoverPolicy.Require(IntPtr.Size == 8 && Marshal.SizeOf(typeof(Input)) == 40 && Key(false).Data.Keyboard.Extra.ToUInt64() == MarkerValue && Key(true).Data.Keyboard.Flags == 2, "64-bit INPUT layout invalid"); checks++;
        File.WriteAllText(output, Json.Serialize(new { ok = true, checks, guiStarted = false, inputSent = false, hooksInstalled = false }), new UTF8Encoding(false));
    }
    [STAThread] static void Main(string[] args) {
        if (args.Length == 2 && args[0] == "--check") { PureChecks(args[1]); return; }
        if (args.Length != 3 && !(args.Length == 4 && args[3] == "--assisted-foreground")) throw new ArgumentException("Expected fileBase nonce marker [--assisted-foreground]");
        FileBase = Path.GetFullPath(args[0]); Nonce = args[1]; Marker = args[2]; MarkerValue = Convert.ToUInt64(Marker, 16);
        TakeoverPolicy.Require(Regex.IsMatch(Nonce, "^[a-f0-9]{32}$") && Regex.IsMatch(Marker, "^[a-f0-9]{16}$") && MarkerValue > UInt32.MaxValue && (uint)MarkerValue != 0, "TAKEOVER_EXPECTATION_INVALID");
        TakeoverPolicy.Require(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator), "TAKEOVER_MEDIUM_REQUIRED");
        StartedTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString();
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        using (Form = new Form { Text = "ProfilePilot takeover verification", ClientSize = new Size(680, 240), StartPosition = FormStartPosition.CenterScreen, AutoScaleMode = AutoScaleMode.None }) {
            Form.Controls.Add(new Label { Left = 24, Top = 20, Width = 630, Height = 55, Text = "Owned takeover fixture: one explicitly requested synthetic F24 pair.\r\nNo physical-hardware claim; no additional input hook." });
            Edit = new ReceiptEdit { Left = 24, Top = 95, Width = 630, AccessibleName = "Takeover owned edit", MaxLength = 512 };
            Edit.TextChanged += (s, e) => { TextChanges++; Sequence++; Dirty = true; };
            Form.Controls.Add(Edit);
            new AssistedForegroundFixture(Form, FileBase, args.Length == 4);
            var timer = new Timer { Interval = 15 }; timer.Tick += (s, e) => { try { Tick(); } catch (Exception error) { Error = error.Message; Dirty = true; try { Flush(); } finally { Form.Close(); } } };
            Form.Shown += (s, e) => {
                Window = Form.Handle;
                using (var graphics = Form.CreateGraphics()) Save(".environment.json", new { pid = Process.GetCurrentProcess().Id, hwnd = Form.Handle.ToInt64().ToString(),
                    startedUtcTicks = StartedTicks, administrator = false, dpi = graphics.DpiX, nonce = Nonce, marker = Marker, pointerBits = IntPtr.Size * 8,
                    hooksInstalled = false, executable = Process.GetCurrentProcess().MainModule.FileName });
                Dirty = true; Flush(); timer.Start();
            };
            Form.FormClosed += (s, e) => { timer.Stop(); Dirty = true; Flush(); Save(".closed.json", new { pid = Process.GetCurrentProcess().Id, nonce = Nonce, at = Now(), foreignOutcome = Pair.Outcome }); timer.Dispose(); };
            Application.Run(Form);
        }
    }
}
