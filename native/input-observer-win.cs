using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ProfilePilot.InputObservation {
    // Shared protocol/state code has no P/Invoke, hooks, process queries or I/O.
    // The test entrypoint compiles this file with a different /main and exercises
    // only these classes. The production Windows App uses the host below.
    public sealed class InputCommand {
        public string Kind, Epoch, Generation, PreviousGeneration;
        public ulong Marker;
        public uint[] Pids = new uint[0], FailedPids = new uint[0];
        public static bool Identity(string value) {
            return !String.IsNullOrEmpty(value) && value.Length <= 100 && value.All(c => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-');
        }
        public static InputCommand Parse(string line) {
            if (line == null || line.Length > 4096 || line.Any(c => c > 127 || c < 32 && c != '\t')) return new InputCommand { Kind = "INVALID" };
            string[] parts = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 1 && String.Equals(parts[0], "QUIT", StringComparison.OrdinalIgnoreCase)) return new InputCommand { Kind = "QUIT" };
            if (parts.Length > 0 && String.Equals(parts[0], "SET", StringComparison.OrdinalIgnoreCase)) {
                if (parts.Length > 257) return new InputCommand { Kind = "INVALID" };
                var pids = new HashSet<uint>();
                for (int i = 1; i < parts.Length; i++) {
                    uint pid;
                    if (!UInt32.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0) return new InputCommand { Kind = "INVALID_PID" };
                    pids.Add(pid);
                }
                return new InputCommand { Kind = "SET", Pids = pids.OrderBy(pid => pid).ToArray() };
            }
            if (parts.Length == 4 && parts[0] == "ARM" && Identity(parts[1]) && Identity(parts[2])) {
                ulong marker;
                if (parts[3].Length < 1 || parts[3].Length > 16 || !parts[3].All(Uri.IsHexDigit)
                    || !UInt64.TryParse(parts[3], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out marker) || marker == 0) return new InputCommand { Kind = "INVALID" };
                return new InputCommand { Kind = "ARM", Epoch = parts[1], Generation = parts[2], Marker = marker };
            }
            if (parts.Length == 5 && parts[0] == "REARM" && Identity(parts[1]) && Identity(parts[2]) && Identity(parts[3]) && parts[2] != parts[3]) {
                ulong marker;
                if (parts[4].Length < 1 || parts[4].Length > 16 || !parts[4].All(Uri.IsHexDigit)
                    || !UInt64.TryParse(parts[4], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out marker) || marker == 0) return new InputCommand { Kind = "INVALID" };
                return new InputCommand { Kind = "REARM", Epoch = parts[1], PreviousGeneration = parts[2], Generation = parts[3], Marker = marker };
            }
            if (parts.Length == 3 && parts[0] == "DISARM" && Identity(parts[1]) && Identity(parts[2])) return new InputCommand { Kind = "DISARM", Epoch = parts[1], Generation = parts[2] };
            return new InputCommand { Kind = "INVALID" };
        }
    }

    public sealed class InputLineReader {
        readonly StringBuilder line = new StringBuilder();
        bool invalid;
        readonly Action<InputCommand> command;
        public InputLineReader(Action<InputCommand> callback) { command = callback; }
        public int BufferedCharacters { get { return line.Length; } }
        public void Feed(char value) {
            if (value == '\n') {
                string text = line.ToString(); if (text.EndsWith("\r", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
                command(invalid ? new InputCommand { Kind = "INVALID" } : InputCommand.Parse(text));
                line.Length = 0; invalid = false; return;
            }
            if (invalid) return;
            if (line.Length >= 4096 || value > 127 || value < 32 && value != '\t' && value != '\r') { invalid = true; line.Length = 0; return; }
            line.Append(value);
        }
        // EOF discards incomplete commands. It is a lifetime stop signal in the
        // host; an unfinished ARM must never take effect after its owner leaves.
        public void End() { line.Length = 0; invalid = false; }
    }

    public sealed class OutputRecord {
        public string Type, Status, Epoch, Generation, Kind, Reason, Phase;
        public ulong Sequence, Marker;
        public bool Injected, HasWindow;
        public uint Pid;
        public int? ActiveCount;
        public int Button, X, Y, WindowX, WindowY, Width, Height;
        public long WindowId, Timestamp;
        public double DisplayScale;
        public static OutputRecord LegacyStatus(string status, uint pid = 0, int? count = null) { return new OutputRecord { Type = "status", Status = status, Pid = pid, ActiveCount = count }; }
        // No owner identity, paths, token information or free-form error text.
        public static object InstanceGateFailure(int error) { return new { type = "startup-failure", stage = "instance-gate", win32Error = unchecked((uint)error) }; }
        public object WireValue() {
            if (Type == "desktop-armed") return new { type = Type, epoch = Epoch, generation = Generation, sequence = Sequence.ToString(CultureInfo.InvariantCulture) };
            if (Type == "observer-fault") return new { type = Type, epoch = Epoch, generation = Generation, reason = Reason };
            if (Type == "input-activity") {
                var value = new Dictionary<string, object> { { "type", Type }, { "epoch", Epoch }, { "generation", Generation },
                    { "sequence", Sequence.ToString(CultureInfo.InvariantCulture) }, { "kind", Kind }, { "injected", Injected } };
                if (Injected) value["marker"] = Marker.ToString("x16", CultureInfo.InvariantCulture);
                return value;
            }
            if (Type == "status") {
                var value = new Dictionary<string, object> { { "type", Type }, { "status", Status }, { "pid", Pid } };
                if (ActiveCount.HasValue) value["activeCount"] = ActiveCount.Value;
                return value;
            }
            if (Type == "mouse") return new { type = Type, pid = Pid, phase = Phase, button = Button, x = X, y = Y, windowId = WindowId,
                timestamp = Timestamp, displayScale = DisplayScale,
                window = HasWindow ? (object)new { x = WindowX, y = WindowY, width = Width, height = Height } : null };
            throw new InvalidOperationException("Unknown output record type");
        }
    }

    public interface IOutputQueue {
        bool TryEnqueue(OutputRecord record);
        void Critical(OutputRecord record);
    }
    public sealed class BoundedOutputQueue : IOutputQueue {
        public const int Capacity = 1024;
        readonly ConcurrentQueue<OutputRecord> queue = new ConcurrentQueue<OutputRecord>();
        OutputRecord critical;
        int count;
        public int Count { get { return Interlocked.CompareExchange(ref count, 0, 0); } }
        public bool TryEnqueue(OutputRecord record) {
            if (Interlocked.Increment(ref count) > Capacity) { Interlocked.Decrement(ref count); return false; }
            queue.Enqueue(record); return true;
        }
        // One reserved fault slot cannot be crowded out by legacy mouse/status
        // messages. Latest generation wins; no unbounded emergency queue exists.
        public void Critical(OutputRecord record) { Interlocked.Exchange(ref critical, record); }
        public bool TryDequeue(out OutputRecord record) {
            record = Interlocked.Exchange(ref critical, null);
            if (record != null) return true;
            if (!queue.TryDequeue(out record)) return false;
            Interlocked.Decrement(ref count); return true;
        }
    }

    public sealed class MouseDecision {
        public bool Suppress, Emit;
        public uint Pid;
        public long Window;
        public string Phase;
        public int Button;
    }
    public sealed class BrowserGuardState {
        readonly HashSet<uint> pids = new HashSet<uint>();
        uint capturedPid;
        long capturedWindow;
        public uint[] Pids { get { return pids.OrderBy(pid => pid).ToArray(); } }
        public int Count { get { return pids.Count; } }
        public void Set(uint[] next) {
            pids.Clear(); foreach (uint pid in next) pids.Add(pid);
            if (!pids.Contains(capturedPid)) { capturedPid = 0; capturedWindow = 0; }
        }
        public MouseDecision Mouse(int message, uint pid, long window) {
            bool down = message == 0x201 || message == 0x204 || message == 0x207 || message == 0x20b;
            bool up = message == 0x202 || message == 0x205 || message == 0x208 || message == 0x20c;
            bool guarded = pids.Contains(pid), gesture = false;
            if (down && guarded) { capturedPid = pid; capturedWindow = window; }
            if ((message == 0x200 || up) && capturedPid != 0) { gesture = true; pid = capturedPid; window = capturedWindow; guarded = pids.Contains(pid); }
            var result = new MouseDecision { Pid = pid, Window = window, Emit = guarded && (down || up && gesture), Phase = down ? "down" : "up",
                Button = message == 0x201 || message == 0x202 ? 0 : message == 0x204 || message == 0x205 ? 1 : 2,
                Suppress = down && guarded || (message == 0x200 || up) && gesture || guarded && (message == 0x20a || message == 0x20e) };
            if (up) { capturedPid = 0; capturedWindow = 0; }
            return result;
        }
    }

    public sealed class InputObserverProtocol {
        public const int MarkerLimit = 256, GenerationLimit = 1024;
        readonly IOutputQueue output;
        readonly bool browserGeometryAvailable;
        readonly HashSet<ulong> markers = new HashSet<ulong>();
        readonly HashSet<ulong> pointerMarkers = new HashSet<ulong>();
        readonly HashSet<string> generations = new HashSet<string>(StringComparer.Ordinal);
        string epoch, generation;
        ulong marker, sequence;
        bool active, latched;
        public readonly BrowserGuardState Browser = new BrowserGuardState();
        public bool ShutdownRequested { get; private set; }
        public bool KeyboardNeeded { get { return active && !latched && !ShutdownRequested; } }
        public int RegisteredMarkerCount { get { return markers.Count; } }
        public static ulong PointerMarker(ulong value) {
            if(value==0)throw new ArgumentException("A nonzero source marker is required");
            uint low=unchecked((uint)value);return low!=0?low:(uint)(value>>32);
        }
        void RegisterMarker(ulong value) { markers.Add(value); pointerMarkers.Add(PointerMarker(value)); }
        public InputObserverProtocol(IOutputQueue queue, ulong initialSequence = 0, bool physicalBrowserGeometry = true) { output = queue; sequence = initialSequence; browserGeometryAvailable = physicalBrowserGeometry; }
        public void Status(string value, uint pid = 0, int? count = null) { Publish(OutputRecord.LegacyStatus(value, pid, count)); }
        public void Set(InputCommand command) {
            if (!browserGeometryAvailable) {
                // LL pointer locations are physical pixels. Without the matching
                // thread DPI context, legacy rectangles/hit tests are unproven;
                // no browser PID may become protected under that mismatch.
                foreach (uint failed in command.Pids.Concat(command.FailedPids).Distinct()) Status("tap-create-failed", failed);
                foreach (uint previous in Browser.Pids) Status("tap-removed", previous);
                Browser.Set(new uint[0]); Status("sync-complete", 0, 0); return;
            }
            var next = new HashSet<uint>(command.Pids);
            foreach (uint failed in command.FailedPids) Status("tap-create-failed", failed);
            foreach (uint previous in Browser.Pids) if (!next.Contains(previous)) Status("tap-removed", previous);
            var old = new HashSet<uint>(Browser.Pids);
            foreach (uint pid in command.Pids) if (!old.Contains(pid)) Status("tap-active", pid);
            Browser.Set(command.Pids); Status("sync-complete", 0, Browser.Count);
        }
        public void Arm(InputCommand command, Func<bool> installKeyboard) {
            if (ShutdownRequested) return;
            if (epoch != null && epoch != command.Epoch) { Status("invalid-command"); return; }
            if (generations.Contains(command.Generation)) {
                // An exact live duplicate may repeat the acknowledgement. A
                // paused/disarmed generation can never be armed a second time.
                if (generation == command.Generation && marker == command.Marker && KeyboardNeeded) Acknowledge();
                else Status("invalid-command");
                return;
            }
            epoch = command.Epoch; generation = command.Generation; marker = command.Marker; active = false; latched = false;
            if (generations.Count >= GenerationLimit || !markers.Contains(marker) && markers.Count >= MarkerLimit) { Fail("unavailable"); return; }
            generations.Add(generation);
            bool installed;
            try { installed = installKeyboard(); } catch { installed = false; }
            if (!installed) { Fail("unavailable"); return; }
            RegisterMarker(marker); active = true; Acknowledge();
        }
        void Acknowledge() { Publish(new OutputRecord { Type = "desktop-armed", Epoch = epoch, Generation = generation, Sequence = sequence }); }
        public void Rearm(InputCommand command) {
            // Runs on the same thread as hook callbacks. Input observed before
            // this command latches the predecessor and forbids replacement;
            // input observed afterward belongs to the new generation. No
            // keyboard hook is removed/reinstalled during this transition.
            if (!KeyboardNeeded || epoch != command.Epoch || generation != command.PreviousGeneration
                || generations.Contains(command.Generation) || generations.Count >= GenerationLimit
                || !markers.Contains(command.Marker) && markers.Count >= MarkerLimit) {
                // Route refusal to the pending successor, including when the
                // predecessor has already emitted its last activity message.
                // The transport retires on this unknown observer failure.
                active = false; latched = true;
                output.Critical(new OutputRecord { Type = "observer-fault", Epoch = command.Epoch, Generation = command.Generation, Reason = "unavailable" });
                return;
            }
            generations.Add(command.Generation); RegisterMarker(command.Marker);
            generation = command.Generation; marker = command.Marker; Acknowledge();
        }
        public void Disarm(InputCommand command) {
            if (command.Epoch != epoch || command.Generation != generation) return;
            active = false; latched = true;
        }
        public bool Activity(string kind, bool injected, ulong extraInfo) {
            if (!KeyboardNeeded) return false;
            // Actual x64 Windows mouse delivery can retain only 32 bits of
            // dwExtraInfo. The sender uses a separate nonzero 32-bit pointer
            // marker; keyboard markers remain full-width. Compare the received
            // value exactly, never mask arbitrary external high bits. Markers
            // correlate our injected events; they are not authentication.
            if (injected && (kind=="keyboard"?markers:pointerMarkers).Contains(extraInfo)) return false;
            if (sequence == UInt64.MaxValue) { Fail("overflow"); return true; }
            sequence++; latched = true;
            Publish(new OutputRecord { Type = "input-activity", Epoch = epoch, Generation = generation, Sequence = sequence, Kind = kind, Injected = injected, Marker = extraInfo });
            return true;
        }
        public void LegacyMouse(OutputRecord message) { Publish(message); }
        public void Fail(string reason) {
            active = false; latched = true;
            if (epoch != null && generation != null) output.Critical(new OutputRecord { Type = "observer-fault", Epoch = epoch, Generation = generation, Reason = reason });
            else output.Critical(OutputRecord.LegacyStatus("tap-disabled"));
        }
        public void OverflowAndStop() { Fail("overflow"); ShutdownRequested = true; }
        void Publish(OutputRecord record) { if (!output.TryEnqueue(record)) OverflowAndStop(); }
    }

    // Windows-only host. Only the installing message thread touches hook handles,
    // BrowserGuardState or protocol generations. Reader/writer threads communicate
    // through bounded queues and atomic flags; callbacks never wait for stdout.
    // Hook installation is an acknowledgement of that operation, not proof of
    // continuous observation: Windows may silently remove a timed-out LL hook,
    // and another process's earlier hook can prevent delivery to this helper.
    // Window queries below are limited to the pointer hit/root and its geometry
    // for existing browser subscribers; no window enumeration/UIA runs here.
    public static class InputObserverInstanceGate {
        // Fixed across App data directories, builds and integrity levels. Local
        // names are scoped to the interactive Windows logon session.
        public const string Name = @"Local\ProfilePilot.InputObserver";
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateMutexW(IntPtr attributes, bool initialOwner, string name);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        static IntPtr lifetimeHandle;
        public static bool TryEnter(out int error) {
            if (lifetimeHandle != IntPtr.Zero) { error = 183; return false; }
            IntPtr handle = CreateMutexW(IntPtr.Zero, false, Name);
            error = Marshal.GetLastWin32Error();
            if (handle == IntPtr.Zero) return false;
            if (error == 183) { CloseHandle(handle); return false; }
            // Existence, not mutex ownership, is the lease. Never Wait/Release.
            // NULL attributes make the handle non-inheritable. Keep the raw
            // handle until process exit, including unsuccessful unhook cleanup.
            lifetimeHandle = handle; return true;
        }
    }

    public static class InputObserverWindowsHost {
        const int MouseHook = 14, KeyboardHook = 13, WorkMessage = 0x8001, QuitMessage = 0x12;
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardData { public uint Vk, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
        delegate IntPtr HookCallback(int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookCallback callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint minimum, uint maximum, uint remove);
        [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll", SetLastError = true)] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

        static readonly HookCallback MouseCallback = Mouse, KeyboardCallback = Keyboard;
        static readonly ConcurrentQueue<InputCommand> Commands = new ConcurrentQueue<InputCommand>();
        static readonly BoundedOutputQueue Output = new BoundedOutputQueue();
        static readonly AutoResetEvent OutputReady = new AutoResetEvent(false);
        static InputObserverProtocol Protocol;
        static IntPtr mouseHook, keyboardHook;
        static uint threadId;
        static int commandCount, stopRequested, commandOverflow, writerDone;

        sealed class SignallingOutput : IOutputQueue {
            public bool TryEnqueue(OutputRecord record) { bool result = Output.TryEnqueue(record); if (result) OutputReady.Set(); return result; }
            public void Critical(OutputRecord record) { Output.Critical(record); OutputReady.Set(); }
        }
        static void Wake() { PostThreadMessage(threadId, WorkMessage, UIntPtr.Zero, IntPtr.Zero); }
        static void Stop() { Interlocked.Exchange(ref stopRequested, 1); PostThreadMessage(threadId, QuitMessage, UIntPtr.Zero, IntPtr.Zero); }
        static void ReadCommands() {
            try {
                var parser = new InputLineReader(command => {
                    if (command.Kind == "QUIT") { Stop(); return; }
                    if (command.Kind == "SET") {
                        // Match legacy PID existence checks off the hook thread.
                        // No process title, command line or document is inspected.
                        var live = new List<uint>(); var failed = new List<uint>();
                        foreach (uint pid in command.Pids) {
                            try { using (Process process = Process.GetProcessById(checked((int)pid))) { live.Add(pid); } }
                            catch { failed.Add(pid); }
                        }
                        command.Pids = live.ToArray(); command.FailedPids = failed.ToArray();
                    }
                    if (Interlocked.Increment(ref commandCount) > 64) { Interlocked.Decrement(ref commandCount); Interlocked.Exchange(ref commandOverflow, 1); Wake(); return; }
                    Commands.Enqueue(command); Wake();
                });
                int value;
                while (Interlocked.CompareExchange(ref stopRequested, 0, 0) == 0 && (value = Console.In.Read()) >= 0) parser.Feed((char)value);
                parser.End();
            } catch { Interlocked.Exchange(ref commandOverflow, 1); Wake(); }
            finally { Stop(); }
        }
        static void WriteOutput() {
            var serializer = new JavaScriptSerializer();
            try {
                while (true) {
                    OutputRecord record;
                    if (Output.TryDequeue(out record)) {
                        string line = serializer.Serialize(record.WireValue());
                        if (Encoding.UTF8.GetByteCount(line) > 2048) { Stop(); return; }
                        Console.Out.WriteLine(line); continue;
                    }
                    if (Interlocked.CompareExchange(ref writerDone, 0, 0) != 0) return;
                    OutputReady.WaitOne(50);
                }
            } catch { Stop(); }
        }
        static bool InstallKeyboard() {
            // A replacement generation can reuse this one hook on the same
            // message thread. Never install a second hook over a live handle.
            if (keyboardHook != IntPtr.Zero) return true;
            keyboardHook = SetWindowsHookEx(KeyboardHook, KeyboardCallback, GetModuleHandle(null), 0);
            return keyboardHook != IntPtr.Zero;
        }
        static bool RemoveKeyboard() {
            if (keyboardHook == IntPtr.Zero) return true;
            if (!UnhookWindowsHookEx(keyboardHook)) return false;
            keyboardHook = IntPtr.Zero; return true;
        }
        static void ProcessCommands() {
            if (Interlocked.CompareExchange(ref commandOverflow, 0, 0) != 0) { Protocol.OverflowAndStop(); Stop(); return; }
            // One posted command per message-loop turn leaves opportunities for
            // sent low-level hook callbacks between bounded configuration batches.
            InputCommand command;
            if (Commands.TryDequeue(out command)) {
                Interlocked.Decrement(ref commandCount);
                if (command.Kind == "SET") Protocol.Set(command);
                else if (command.Kind == "ARM") Protocol.Arm(command, InstallKeyboard);
                else if (command.Kind == "REARM") Protocol.Rearm(command);
                else if (command.Kind == "DISARM") Protocol.Disarm(command);
                else Protocol.Status(command.Kind == "INVALID_PID" ? "invalid-pid" : "invalid-command");
            }
            if (!Protocol.KeyboardNeeded && !RemoveKeyboard()) { Protocol.Fail("unavailable"); Stop(); }
            if (Protocol.ShutdownRequested) Stop();
        }
        static string MouseKind(int message) { return message == 0x200 ? "pointer" : message == 0x20a || message == 0x20e ? "wheel" : "button"; }
        static bool EstablishPhysicalBrowserGeometry() {
            try {
                var perMonitorV2 = new IntPtr(-4);
                SetThreadDpiAwarenessContext(perMonitorV2);
                return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), perMonitorV2);
            } catch (EntryPointNotFoundException) { return false; }
        }
        static bool BrowserMouse(MouseData mouse,int message) {
            // Windows can invoke the LL callback under a different DPI context
            // from the message loop that installed it. Establish PMv2 around
            // every hit test and rectangle query, then restore before chaining
            // to another hook. A one-time startup check is insufficient.
            IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
            if(previous==IntPtr.Zero)throw new InvalidOperationException("Pointer DPI context unavailable");
            try {
                if(!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4)))throw new InvalidOperationException("Pointer DPI context unconfirmed");
                IntPtr window = GetAncestor(WindowFromPoint(mouse.Point), 2); uint pid = 0;
                if (window != IntPtr.Zero) GetWindowThreadProcessId(window, out pid);
                MouseDecision decision = Protocol.Browser.Mouse(message, pid, window.ToInt64());
                if (decision.Emit) {
                    Rect bounds = new Rect(); IntPtr owner = new IntPtr(decision.Window);
                    bool hasBounds = owner != IntPtr.Zero && GetWindowRect(owner, out bounds);
                    if (!hasBounds) bounds = new Rect();
                    double scale = 1;
                    uint dpi = GetDpiForWindow(owner); if (dpi > 0) scale = dpi / 96.0;
                    Protocol.LegacyMouse(new OutputRecord { Type = "mouse", Pid = decision.Pid, Phase = decision.Phase, Button = decision.Button,
                        X = mouse.Point.X, Y = mouse.Point.Y, WindowId = decision.Window, DisplayScale = scale,
                        Timestamp = (long)(Stopwatch.GetTimestamp() * (1000000000.0 / Stopwatch.Frequency)),
                        HasWindow = hasBounds && bounds.Right > bounds.Left && bounds.Bottom > bounds.Top,
                        WindowX = bounds.Left, WindowY = bounds.Top, Width = bounds.Right - bounds.Left, Height = bounds.Bottom - bounds.Top });
                }
                return decision.Suppress;
            } finally { SetThreadDpiAwarenessContext(previous); }
        }
        static IntPtr Mouse(int code, IntPtr messageValue, IntPtr data) {
            if (code < 0) return CallNextHookEx(mouseHook, code, messageValue, data);
            try {
                var mouse = (MouseData)Marshal.PtrToStructure(data, typeof(MouseData));
                int message = messageValue.ToInt32();
                // Observe before legacy suppression: a guarded browser click
                // must still pause an unrelated desktop generation.
                if (Protocol.Activity(MouseKind(message), (mouse.Flags & 3) != 0, mouse.Extra.ToUInt64())) Wake();
                if (Protocol.ShutdownRequested) { Stop(); return CallNextHookEx(mouseHook, code, messageValue, data); }
                if (Protocol.Browser.Count == 0) return CallNextHookEx(mouseHook, code, messageValue, data);
                bool suppress=BrowserMouse(mouse,message);
                if (Protocol.ShutdownRequested) Stop();
                return suppress ? new IntPtr(1) : CallNextHookEx(mouseHook, code, messageValue, data);
            } catch {
                // A broken callback may also invalidate legacy browser guarding.
                // Retire the shared helper so every subscriber sees lost health.
                Protocol.Fail("unavailable"); Stop(); return CallNextHookEx(mouseHook, code, messageValue, data);
            }
        }
        static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
            if (code < 0) return CallNextHookEx(keyboardHook, code, message, data);
            try {
                var keyboard = (KeyboardData)Marshal.PtrToStructure(data, typeof(KeyboardData));
                if (Protocol.Activity("keyboard", (keyboard.Flags & 0x12) != 0, keyboard.Extra.ToUInt64())) Wake();
                if (Protocol.ShutdownRequested) Stop();
            } catch { Protocol.Fail("unavailable"); Stop(); }
            // Desktop observation never swallows keyboard input.
            return CallNextHookEx(keyboardHook, code, message, data);
        }
        public static int Run() {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) return 2;
            Console.InputEncoding = new UTF8Encoding(false, true); Console.OutputEncoding = new UTF8Encoding(false);
            int instanceError;
            if (!InputObserverInstanceGate.TryEnter(out instanceError)) {
                // Synchronous and bounded: emitted before hooks, reader or writer
                // threads exist. Failure to write still exits without a hook.
                try { Console.Out.WriteLine(new JavaScriptSerializer().Serialize(OutputRecord.InstanceGateFailure(instanceError))); Console.Out.Flush(); } catch { }
                try { Console.Error.WriteLine("INPUT_OBSERVER_INSTANCE_UNAVAILABLE:" + instanceError.ToString(CultureInfo.InvariantCulture)); } catch { }
                return 2;
            }
            threadId = GetCurrentThreadId();
            Message ignored; PeekMessage(out ignored, IntPtr.Zero, 0, 0, 0); // Queue exists before EOF/QUIT can be posted.
            Protocol = new InputObserverProtocol(new SignallingOutput(), 0, EstablishPhysicalBrowserGeometry());
            var writer = new Thread(WriteOutput) { IsBackground = true, Name = "ProfilePilot input observer output" }; writer.Start();
            try {
                mouseHook = SetWindowsHookEx(MouseHook, MouseCallback, GetModuleHandle(null), 0);
                if (mouseHook == IntPtr.Zero) { Protocol.Status("hook-create-failed"); return 2; }
                Protocol.Status("ready");
                var reader = new Thread(ReadCommands) { IsBackground = true, Name = "ProfilePilot input observer commands" }; reader.Start();
                Message message; int result = 0;
                while (Interlocked.CompareExchange(ref stopRequested, 0, 0) == 0 && (result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) {
                    if (message.Id == WorkMessage) ProcessCommands();
                    else { TranslateMessage(ref message); DispatchMessage(ref message); }
                }
                if (result < 0) { Protocol.Fail("unavailable"); return 2; }
                return Protocol.ShutdownRequested ? 2 : 0;
            } finally {
                RemoveKeyboard(); if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero;
                Interlocked.Exchange(ref writerDone, 1); OutputReady.Set(); writer.Join(200);
                // The writer/reader are background threads. A blocked owner pipe
                // cannot prevent process exit after hooks have been uninstalled.
            }
        }
    }

    public static class InputObserverWindowsProgram {
        [MTAThread] public static int Main(string[] args) {
            // An explicit switch prevents accidental execution during inspection.
            if (args.Length != 1 || args[0] != "--stdio-observer") return 2;
            return InputObserverWindowsHost.Run();
        }
    }
}
