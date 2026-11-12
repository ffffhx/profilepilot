using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;
using ProfilePilot.InputObservation;

// This alternate /main executes only in-memory protocol/state code. It never
// calls InputObserverWindowsHost, P/Invoke, process lookup or a hook API.
public static class InputObserverWindowsTests {
    static readonly List<string> Checks = new List<string>();
    static readonly List<object> Samples = new List<object>();
    static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Check(string name, Action body) { body(); Checks.Add(name); }
    static InputCommand Arm(string generation = "g1", ulong marker = 0xfedcba9876543210UL, string epoch = "epoch") {
        return InputCommand.Parse("ARM " + epoch + " " + generation + " " + marker.ToString("x16"));
    }
    static List<OutputRecord> Drain(BoundedOutputQueue output) {
        var values = new List<OutputRecord>(); OutputRecord value;
        while (output.TryDequeue(out value)) values.Add(value);
        return values;
    }
    static OutputRecord Only(BoundedOutputQueue output, string type) {
        var values = Drain(output); Assert(values.Count == 1 && values[0].Type == type, "Expected one " + type); return values[0];
    }
    public static int Main() {
        Check("instance gate startup failure contains only bounded public fields", () => {
            foreach (int error in new[] { 0, 5, 183, Int32.MaxValue, -1 }) {
                object value = OutputRecord.InstanceGateFailure(error);
                var serializer = new JavaScriptSerializer(); string json = serializer.Serialize(value);
                var decoded = serializer.Deserialize<Dictionary<string, object>>(json);
                Assert(json.Length < 128 && decoded.Count == 3, "unbounded startup frame");
                Assert((string)decoded["type"] == "startup-failure" && (string)decoded["stage"] == "instance-gate", "startup envelope");
                Assert(Convert.ToUInt64(decoded["win32Error"]) == unchecked((uint)error), "DWORD not exact");
                Samples.Add(value);
            }
        });
        Check("strict command grammar preserves SET/QUIT compatibility", () => {
            Assert(InputCommand.Parse("sEt 20 10 20").Pids.SequenceEqual(new uint[] { 10, 20 }), "SET dedupe/order");
            Assert(InputCommand.Parse("SET").Pids.Length == 0 && InputCommand.Parse("quit").Kind == "QUIT", "legacy commands");
            foreach (string text in new[] { "SET 0", "SET -1", "SET 1.0", "SET 4294967296", "SET +1" }) Assert(InputCommand.Parse(text).Kind == "INVALID_PID", text);
            foreach (string text in new[] { "ARM e g 0", "ARM e g 10000000000000000", "ARM e g xyz", "ARM e g 0x1", "ARM e g 1 extra", "DISARM e", "QUIT extra", "ARM e g\u00e9 1" }) Assert(InputCommand.Parse(text).Kind == "INVALID", text);
            Assert(Arm().Marker == 0xfedcba9876543210UL, "64 bit marker lost precision");
            Assert(InputCommand.Parse("ARM " + new string('e', 101) + " g 1").Kind == "INVALID", "identity length");
            Assert(InputCommand.Parse(new string(' ', 4097)).Kind == "INVALID", "command byte bound");
        });
        Check("PID command aggregate is bounded at 256", () => {
            string pids = String.Join(" ", Enumerable.Range(1, 256));
            Assert(InputCommand.Parse("SET " + pids).Pids.Length == 256, "256 allowed");
            Assert(InputCommand.Parse("SET " + pids + " 257").Kind == "INVALID", "257 refused");
        });
        Check("REARM grammar requires distinct exact generations and a nonzero marker", () => {
            var command = InputCommand.Parse("REARM epoch g1 g2 fedcba9876543210");
            Assert(command.Kind == "REARM" && command.PreviousGeneration == "g1" && command.Generation == "g2" && command.Marker == 0xfedcba9876543210UL, "rearm fields");
            foreach (string text in new[] { "REARM e g g 1", "REARM e g1 g2 0", "REARM e g1 g2", "REARM e g1 g2 1 extra", "REARM e g1 g2 10000000000000000" }) Assert(InputCommand.Parse(text).Kind == "INVALID", text);
        });
        Check("continuous REARM retains the hook state and old release marker", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm("g1", 1), () => true); Drain(output);
            state.Rearm(InputCommand.Parse("REARM epoch g1 g2 2"));
            var ack = Only(output, "desktop-armed");
            Assert(state.KeyboardNeeded && ack.Generation == "g2" && ack.Sequence == 0 && state.RegisteredMarkerCount == 2, "continuous swap");
            Assert(!state.Activity("keyboard", true, 1) && !state.Activity("keyboard", true, 2), "release marker forgotten");
            state.Disarm(InputCommand.Parse("DISARM epoch g1")); Assert(state.KeyboardNeeded, "old stop disabled successor");
            Assert(state.Activity("button", false, 0), "new activity ignored");
            var activity = Only(output, "input-activity"); Assert(activity.Generation == "g2" && activity.Sequence == 1, "successor activity route");
        });
        Check("activity before REARM prevents a successor acknowledgement", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm("g1", 1), () => true); Drain(output);
            state.Activity("keyboard", false, 0);
            state.Rearm(InputCommand.Parse("REARM epoch g1 g2 2"));
            var values = Drain(output);
            Assert(values.Count == 2 && values[0].Type == "observer-fault" && values[0].Generation == "g2", "pending successor must receive refusal");
            Assert(values[1].Type == "input-activity" && values[1].Generation == "g1" && !state.KeyboardNeeded && state.RegisteredMarkerCount == 1, "predecessor activity lost or new marker trusted");
        });
        Check("REARM rejects stopped wrong-epoch wrong-predecessor and reused generations", () => {
            foreach (string variant in new[] { "stopped", "epoch", "predecessor", "reused" }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm("g0", 3), () => true); state.Arm(Arm("g1", 1), () => true); Drain(output);
                if (variant == "stopped") state.Disarm(InputCommand.Parse("DISARM epoch g1"));
                string text = variant == "epoch" ? "REARM wrong g1 g2 2" : variant == "predecessor" ? "REARM epoch wrong g2 2" : variant == "reused" ? "REARM epoch g1 g0 2" : "REARM epoch g1 g2 2";
                state.Rearm(InputCommand.Parse(text));
                var fault = Only(output, "observer-fault"); Assert(fault.Reason == "unavailable" && !state.KeyboardNeeded && state.RegisteredMarkerCount == 2, "invalid continuity accepted: " + variant);
            }
        });
        Check("framing supports fragmented CRLF and discards incomplete EOF", () => {
            var seen = new List<InputCommand>(); var reader = new InputLineReader(seen.Add);
            foreach (char c in "ARM e g fedcba9876543210\r\nSET 2\nARM e unfinished 1") reader.Feed(c);
            reader.End(); Assert(seen.Count == 2 && seen[0].Kind == "ARM" && seen[1].Kind == "SET", "framing or EOF");
            Assert(reader.BufferedCharacters == 0, "EOF buffer retained");
        });
        Check("oversized or nonASCII framing recovers only after newline", () => {
            var seen = new List<InputCommand>(); var reader = new InputLineReader(seen.Add);
            foreach (char c in new string('A', 100000)) { reader.Feed(c); Assert(reader.BufferedCharacters <= 4096, "unbounded line"); }
            foreach (char c in "\nSET\nARM e g \u00e9\nSET\nSET 1\r2\n") reader.Feed(c);
            Assert(seen.Select(c => c.Kind).SequenceEqual(new[] { "INVALID", "SET", "INVALID", "SET", "INVALID" }), "line resync");
        });
        Check("queue reserves a critical fault slot outside its fixed 1024 records", () => {
            var output = new BoundedOutputQueue();
            for (int i = 0; i < BoundedOutputQueue.Capacity; i++) Assert(output.TryEnqueue(OutputRecord.LegacyStatus("tap-active", (uint)i + 1)), "early full");
            Assert(!output.TryEnqueue(OutputRecord.LegacyStatus("ready")) && output.Count == 1024, "queue overflow unbounded");
            output.Critical(new OutputRecord { Type = "observer-fault", Epoch = "e", Generation = "g", Reason = "overflow" });
            var values = Drain(output); Assert(values.Count == 1025 && values[0].Type == "observer-fault" && output.Count == 0, "reserved fault lost");
        });
        Check("queue writer and producer preserve every accepted record", () => {
            var output = new BoundedOutputQueue(); int consumed = 0; Exception failure = null;
            var writer = new Thread(() => { try { while (consumed < 10000) { OutputRecord record; if (output.TryDequeue(out record)) { Assert(record.Pid == (uint)consumed + 1, "queue order"); consumed++; } else Thread.Yield(); } } catch (Exception error) { failure = error; } });
            writer.IsBackground = true; writer.Start();
            for (uint i = 1; i <= 10000; i++) while (!output.TryEnqueue(OutputRecord.LegacyStatus("tap-active", i))) { if (failure != null) throw failure; Thread.Yield(); }
            Assert(writer.Join(5000), "queue worker did not finish"); if (failure != null) throw failure;
            Assert(consumed == 10000 && output.Count == 0, "queue accounting");
        });
        Check("maximum SET replacement fits even before writer scheduling", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Set(new InputCommand { Pids = Enumerable.Range(1, 256).Select(i => (uint)i).ToArray() });
            state.Set(new InputCommand { Pids = Enumerable.Range(257, 256).Select(i => (uint)i).ToArray() });
            Assert(output.Count == 770 && !state.ShutdownRequested, "257+513 batch must fit");
            var values = Drain(output); Assert(values.Count(v => v.Status == "sync-complete") == 2 && values.Last().ActiveCount == 256, "legacy statuses");
        });
        Check("SET reports unavailable PID without claiming it protected", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Set(new InputCommand { Pids = new uint[] { 2 }, FailedPids = new uint[] { 3 } });
            var values = Drain(output); Assert(values[0].Status == "tap-create-failed" && values[0].Pid == 3 && state.Browser.Pids.SequenceEqual(new uint[] { 2 }), "failed PID retained");
        });
        Check("transport ready does not arm desktop or classify input", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Status("ready"); Assert(!state.KeyboardNeeded && !state.Activity("keyboard", false, 0), "ready armed desktop");
            Assert(Only(output, "status").Status == "ready", "ready status");
        });
        Check("ARM acknowledgement follows successful keyboard installation", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output); int calls = 0;
            state.Arm(Arm(), () => { Assert(output.Count == 0 && !state.KeyboardNeeded, "ack before installation"); calls++; return true; });
            var ack = Only(output, "desktop-armed"); Assert(calls == 1 && state.KeyboardNeeded && ack.Generation == "g1", "arm result"); Samples.Add(ack.WireValue());
        });
        Check("failed or throwing installer cannot acknowledge readiness", () => {
            foreach (bool throws in new[] { false, true }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm(), () => { if (throws) throw new Exception("private error"); return false; });
                Assert(!state.KeyboardNeeded && Only(output, "observer-fault").Reason == "unavailable", "failed install ready");
                Assert(state.RegisteredMarkerCount == 0, "failed installation trusted marker");
                state.Arm(Arm("g2", 0x123456789abcdef0UL), () => true); Only(output, "desktop-armed");
                Assert(state.Activity("button", true, 0x76543210UL), "failed installation seeded a pointer alias");
                Only(output, "input-activity");
            }
        });
        Check("first physical activity latches generation without a flood", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output);
            Assert(state.Activity("keyboard", false, 0) && !state.KeyboardNeeded, "physical did not latch");
            for (int i = 0; i < 5000; i++) Assert(!state.Activity("pointer", false, 0), "repeated activity");
            var activity = Only(output, "input-activity"); Assert(activity.Sequence == 1 && !activity.Injected, "activity payload"); Samples.Add(activity.WireValue());
        });
        Check("own injected markers are ignored and retained across generations", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm("g1", 1), () => true); Drain(output); state.Disarm(InputCommand.Parse("DISARM epoch g1"));
            state.Arm(Arm("g2", 2), () => true); Drain(output);
            Assert(!state.Activity("button", true, 1) && !state.Activity("keyboard", true, 2) && state.KeyboardNeeded && output.Count == 0, "own release classified external");
            Assert(state.RegisteredMarkerCount == 2, "old marker forgotten");
        });
        Check("matching marker without injected flag is still external physical activity", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output);
            Assert(state.Activity("pointer", false, Arm().Marker), "physical trusted by marker");
            var value = (Dictionary<string, object>)Only(output, "input-activity").WireValue(); Assert(!value.ContainsKey("marker"), "physical marker disclosure");
        });
        Check("unknown injected marker pauses with exact full-width identity", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm("g1", 1), () => true); Drain(output);
            Assert(state.Activity("wheel", true, UInt64.MaxValue), "unknown injection ignored");
            var record = Only(output, "input-activity"); Assert(record.Marker == UInt64.MaxValue && record.Injected, "marker precision"); Samples.Add(record.WireValue());
        });
        Check("zero injection marker is untrusted", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output); Assert(state.Activity("keyboard", true, 0), "zero trusted");
            Samples.Add(Only(output, "input-activity").WireValue());
        });
        Check("pointer marker derivation uses exact nonzero uint32 boundary vectors", () => {
            ulong[] sources = { 0xfedcba9876543210UL, UInt64.MaxValue, 0xfedcba9800000000UL, 0x0000000100000000UL, 0x0000000080000000UL, 1 };
            ulong[] expected = { 0x76543210UL, 0xffffffffUL, 0xfedcba98UL, 1, 0x80000000UL, 1 };
            for (int i = 0; i < sources.Length; i++) Assert(InputObserverProtocol.PointerMarker(sources[i]) == expected[i], "pointer marker vector " + i);
            bool rejected = false; try { InputObserverProtocol.PointerMarker(0); } catch (ArgumentException) { rejected = true; }
            Assert(rejected, "zero source accepted");
        });
        Check("registered keyboard64 and pointer32 markers are matched by event kind", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output);
            Assert(!state.Activity("keyboard", true, 0xfedcba9876543210UL), "keyboard64 own event paused");
            foreach (string kind in new[] { "pointer", "button", "wheel" }) Assert(!state.Activity(kind, true, 0x76543210UL), "pointer32 own event paused: " + kind);
            Assert(output.Count == 0 && state.KeyboardNeeded, "own markers changed ready state");
        });
        Check("external pointer high bits are never masked into a trusted low word", () => {
            foreach (string kind in new[] { "pointer", "button", "wheel" }) foreach (ulong external in new[] { 0xfedcba9876543210UL, 0x1234567876543210UL, 0xffffffff76543210UL }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm(), () => true); Drain(output);
                Assert(state.Activity(kind, true, external), "external high bits ignored: " + kind);
                var value = Only(output, "input-activity"); Assert(value.Marker == external && value.Injected && !state.KeyboardNeeded, "external marker changed or failed to latch"); Samples.Add(value.WireValue());
            }
        });
        Check("keyboard aliases and matching low words cannot replace the full marker", () => {
            foreach (ulong external in new[] { 0x76543210UL, 0x1234567876543210UL, 0xfedcba9800000000UL }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm(), () => true); Drain(output);
                Assert(state.Activity("keyboard", true, external), "keyboard alias trusted");
                Assert(Only(output, "input-activity").Marker == external, "keyboard marker changed");
            }
        });
        Check("matching pointer32 without injection always latches physical activity", () => {
            foreach (string kind in new[] { "pointer", "button", "wheel" }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm(), () => true); Drain(output);
                Assert(state.Activity(kind, false, 0x76543210UL), "physical pointer alias trusted");
                var value = (Dictionary<string, object>)Only(output, "input-activity").WireValue();
                Assert(!value.ContainsKey("marker") && !state.KeyboardNeeded, "physical marker disclosed or not paused");
            }
        });
        Check("retired pointer aliases survive ARM and continuous REARM in the same child", () => {
            foreach (bool continuous in new[] { false, true }) {
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm(), () => true); Drain(output);
                if (continuous) state.Rearm(InputCommand.Parse("REARM epoch g1 g2 123456789abcdef0"));
                else { state.Disarm(InputCommand.Parse("DISARM epoch g1")); state.Arm(Arm("g2", 0x123456789abcdef0UL), () => true); }
                Only(output, "desktop-armed");
                foreach (string kind in new[] { "pointer", "button", "wheel" }) Assert(!state.Activity(kind, true, 0x76543210UL), "retired pointer release lost");
                Assert(!state.Activity("keyboard", true, 0xfedcba9876543210UL) && state.KeyboardNeeded && output.Count == 0, "retired keyboard release lost");
            }
        });
        Check("replacement protocol instance forgets keyboard and pointer marker trust", () => {
            foreach (string kind in new[] { "keyboard", "pointer", "button", "wheel" }) {
                var oldOutput = new BoundedOutputQueue(); var oldState = new InputObserverProtocol(oldOutput);
                oldState.Arm(Arm(), () => true); Drain(oldOutput);
                var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
                state.Arm(Arm("g2", 0x123456789abcdef0UL, "new-epoch"), () => true); Drain(output);
                Assert(state.Activity(kind, true, kind == "keyboard" ? 0xfedcba9876543210UL : 0x76543210UL), "new child inherited old marker: " + kind);
                Assert(Only(output, "input-activity").Epoch == "new-epoch", "old marker activity routed to old epoch");
            }
        });
        Check("low-zero sources register a nonzero high-word pointer alias while retaining keyboard64", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm("g1", 0xfedcba9800000000UL), () => true); Drain(output);
            Assert(!state.Activity("keyboard", true, 0xfedcba9800000000UL), "keyboard marker truncated");
            foreach (string kind in new[] { "pointer", "button", "wheel" }) Assert(!state.Activity(kind, true, 0xfedcba98UL), "fallback alias not trusted");
            Assert(state.Activity("pointer", true, 0), "zero pointer alias trusted"); Only(output, "input-activity");
        });
        Check("live duplicate ARM is idempotent but paused generation cannot resume", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output); int installs = 0;
            state.Arm(Arm(), () => { installs++; return true; }); Drain(output);
            state.Arm(Arm(), () => { installs++; return true; }); Only(output, "desktop-armed"); Assert(installs == 1, "duplicate hook install");
            state.Activity("button", false, 0); Drain(output); state.Arm(Arm(), () => { installs++; return true; });
            Assert(Only(output, "status").Status == "invalid-command" && installs == 1 && !state.KeyboardNeeded, "paused generation resumed");
        });
        Check("stale DISARM cannot turn off a new generation", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); state.Arm(Arm("g2"), () => true); Drain(output);
            state.Disarm(InputCommand.Parse("DISARM epoch g1")); state.Disarm(InputCommand.Parse("DISARM stale g2"));
            Assert(state.KeyboardNeeded && output.Count == 0, "stale disarm active");
            state.Disarm(InputCommand.Parse("DISARM epoch g2")); Assert(!state.KeyboardNeeded, "matching disarm ignored");
        });
        Check("child epoch cannot be rebound by another ARM", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output); state.Arm(Arm("g2", 2, "foreign"), () => { throw new Exception("must not run"); });
            Assert(Only(output, "status").Status == "invalid-command" && state.KeyboardNeeded, "epoch rebound");
        });
        Check("browser SET empty and desktop DISARM have independent lifetimes", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Set(InputCommand.Parse("SET 12")); state.Arm(Arm(), () => true); Drain(output);
            state.Set(InputCommand.Parse("SET")); Assert(state.KeyboardNeeded, "empty browser stopped desktop");
            state.Set(InputCommand.Parse("SET 12")); state.Disarm(InputCommand.Parse("DISARM epoch g1"));
            Assert(!state.KeyboardNeeded && state.Browser.Count == 1, "desktop stopped browser");
        });
        Check("marker retention limit fails new arm without evicting cleanup identities", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            for (int i = 1; i <= 256; i++) { state.Arm(Arm("g" + i, (ulong)i), () => true); Drain(output); }
            state.Arm(Arm("overflow", 257), () => { throw new Exception("must not install"); });
            Assert(Only(output, "observer-fault").Reason == "unavailable" && state.RegisteredMarkerCount == 256 && !state.KeyboardNeeded, "marker cap eviction");
            state.Arm(Arm("reuse-known", 1), () => true); Drain(output);
            Assert(!state.Activity("keyboard", true, 256) && state.KeyboardNeeded, "old marker lost after cap");
        });
        Check("generation history has a fixed bound and never reuses a paused identity", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            for (int i = 0; i < 1024; i++) { state.Arm(Arm("g" + i, 1), () => true); Drain(output); }
            state.Arm(Arm("one-too-many", 1), () => { throw new Exception("must not install"); });
            Assert(!state.KeyboardNeeded && Only(output, "observer-fault").Reason == "unavailable", "generation bound");
        });
        Check("64-bit sequence is exact and overflow faults without wrapping", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output, UInt64.MaxValue - 1);
            state.Arm(Arm(), () => true); Samples.Add(Only(output, "desktop-armed").WireValue());
            state.Activity("keyboard", false, 0); var last = Only(output, "input-activity"); Assert(last.Sequence == UInt64.MaxValue, "sequence precision"); Samples.Add(last.WireValue());
            state.Arm(Arm("next"), () => true); Drain(output); state.Activity("button", false, 0);
            var fault = Only(output, "observer-fault"); Assert(fault.Reason == "overflow" && !state.KeyboardNeeded, "sequence wrapped"); Samples.Add(fault.WireValue());
        });
        Check("output overflow latches fault and refuses subsequent ARM", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output);
            state.Arm(Arm(), () => true); Drain(output);
            for (int i = 0; i < 1025; i++) state.Status("ready");
            Assert(state.ShutdownRequested && !state.KeyboardNeeded, "overflow still armed");
            var records = Drain(output); Assert(records.Count == 1025 && records[0].Type == "observer-fault" && records[0].Reason == "overflow", "fault lost");
            state.Arm(Arm("later"), () => { throw new Exception("must not install"); }); Assert(output.Count == 0, "shutdown rearmed");
        });
        Check("desktop wire format cannot leak fields stored for legacy mouse", () => {
            var message = new OutputRecord { Type = "input-activity", Epoch = "e", Generation = "g", Sequence = 1, Kind = "pointer", Injected = false,
                X = 123, Y = 456, Pid = 99, WindowId = 888, WindowX = 500, Width = 200, Status = "private", Phase = "private" };
            string json = new JavaScriptSerializer().Serialize(message.WireValue());
            foreach (string key in new[] { "\"x\"", "\"y\"", "\"pid\"", "window", "status", "phase", "scan", "text", "vk", "private" }) Assert(!json.Contains(key), "leaked " + key);
            Samples.Add(message.WireValue());
        });
        Check("legacy browser hover is allowed while guarded down is swallowed", () => {
            var browser = new BrowserGuardState(); browser.Set(new uint[] { 10 });
            Assert(!browser.Mouse(0x200, 10, 100).Suppress, "hover suppressed");
            var down = browser.Mouse(0x201, 10, 100); Assert(down.Suppress && down.Emit && down.Pid == 10 && down.Button == 0 && down.Phase == "down", "guarded down");
        });
        Check("legacy captured drag and up stay with originating browser window", () => {
            var browser = new BrowserGuardState(); browser.Set(new uint[] { 10 }); browser.Mouse(0x201, 10, 100);
            var move = browser.Mouse(0x200, 20, 200); Assert(move.Suppress && !move.Emit && move.Pid == 10 && move.Window == 100, "drag escaped");
            var up = browser.Mouse(0x202, 20, 200); Assert(up.Suppress && up.Emit && up.Pid == 10 && up.Window == 100 && up.Phase == "up", "up target lost");
            Assert(!browser.Mouse(0x200, 20, 200).Suppress, "capture retained after up");
        });
        Check("legacy foreign down/up does not become a captured guarded gesture", () => {
            var browser = new BrowserGuardState(); browser.Set(new uint[] { 10 });
            Assert(!browser.Mouse(0x201, 20, 200).Suppress, "foreign down blocked");
            var up = browser.Mouse(0x202, 10, 100); Assert(!up.Suppress && !up.Emit, "foreign gesture captured");
        });
        Check("legacy wheel and horizontal wheel block only guarded targets", () => {
            var browser = new BrowserGuardState(); browser.Set(new uint[] { 10 });
            foreach (int message in new[] { 0x20a, 0x20e }) { var guarded = browser.Mouse(message, 10, 100); Assert(guarded.Suppress && !guarded.Emit && !browser.Mouse(message, 20, 200).Suppress, "wheel behavior"); }
        });
        Check("legacy right/middle/X buttons and removed PID capture remain compatible", () => {
            var browser = new BrowserGuardState(); browser.Set(new uint[] { 10 });
            foreach (int down in new[] { 0x204, 0x207, 0x20b }) { var result = browser.Mouse(down, 10, 100); Assert(result.Emit && result.Suppress && result.Button == (down == 0x204 ? 1 : 2), "button mapping"); browser.Mouse(down + 1, 10, 100); }
            browser.Mouse(0x201, 10, 100); browser.Set(new uint[0]); Assert(!browser.Mouse(0x202, 20, 200).Suppress, "removed PID capture retained");
        });
        Check("unverified DPI geometry refuses browser guarding while desktop observation can arm", () => {
            var output = new BoundedOutputQueue(); var state = new InputObserverProtocol(output, 0, false);
            state.Set(InputCommand.Parse("SET 1 2"));
            var messages = Drain(output);
            Assert(messages.Count == 3 && messages[0].Status == "tap-create-failed" && messages[1].Status == "tap-create-failed" && messages[2].ActiveCount == 0, "browser geometry failure not reported");
            Assert(state.Browser.Count == 0 && !state.Browser.Mouse(0x201, 1, 10).Suppress, "unverified geometry blocked input");
            state.Arm(Arm(), () => true); Only(output, "desktop-armed"); Assert(state.KeyboardNeeded, "DPI changed activity observation");
        });
        Check("background ARM binds a bounded process and window and echoes its scope", () => {
            var command=InputCommand.Parse("ARM e bg 1234 BACKGROUND 42 8765");
            Assert(command.Kind=="ARM" && command.BackgroundPid==42 && command.BackgroundWindow==8765,"scope lost");
            var output=new BoundedOutputQueue();var state=new InputObserverProtocol(output);
            state.Arm(command,()=>true);var ack=Only(output,"desktop-armed");
            Assert(ack.BackgroundPid==42 && ack.BackgroundWindow==8765,"unscoped acknowledgement");Samples.Add(ack.WireValue());
            foreach(string suffix in new[]{"BACKGROUND 0 2","BACKGROUND 2 0","BACKGROUND 2 -1","BACKGROUND 2 9223372036854775808","BACKGROUND 2 3 extra"})
                Assert(InputCommand.Parse("ARM e bg 1234 "+suffix).Kind=="INVALID","bad scope accepted");
        });
        Check("background ignores unrelated input but target input latches takeover", () => {
            var output=new BoundedOutputQueue();var state=new InputObserverProtocol(output);
            state.Arm(InputCommand.Parse("ARM e bg 1234 BACKGROUND 42 8765"),()=>true);Drain(output);
            foreach(string kind in new[]{"keyboard","pointer","button","wheel"})Assert(!state.Activity(kind,false,0,false) && state.KeyboardNeeded,"unrelated input paused task");
            Assert(output.Count==0,"unrelated input leaked");
            Assert(state.Activity("button",false,0,true) && !state.KeyboardNeeded,"target input did not pause");Only(output,"input-activity");
            Assert(!state.Activity("keyboard",false,0,false) && !state.KeyboardNeeded,"pause automatically cleared");
        });
        Check("interactive still yields to unrelated input and target activation pauses background", () => {
            var output=new BoundedOutputQueue();var state=new InputObserverProtocol(output);
            state.Arm(Arm("interactive",1234,"e"),()=>true);Drain(output);Assert(state.Activity("keyboard",false,0,false),"interactive lost global guard");Drain(output);
            state.Arm(InputCommand.Parse("ARM e bg 1234 BACKGROUND 42 8765"),()=>true);Drain(output);
            state.Fail("target_active");var fault=Only(output,"observer-fault");Assert(fault.Reason=="target_active" && !state.KeyboardNeeded,"foreground did not pause");Samples.Add(fault.WireValue());
        });
        Check("background REARM updates scope atomically and refuses changed duplicate", () => {
            var output=new BoundedOutputQueue();var state=new InputObserverProtocol(output);
            state.Arm(InputCommand.Parse("ARM e bg 1234 BACKGROUND 42 8765"),()=>true);Drain(output);
            state.Rearm(InputCommand.Parse("REARM e bg bg2 5678 BACKGROUND 43 8766"));
            var ack=Only(output,"desktop-armed");Assert(ack.BackgroundPid==43 && ack.BackgroundWindow==8766,"scope retained");
            state.Arm(InputCommand.Parse("ARM e bg2 5678 BACKGROUND 44 8766"),()=>true);var refusal=Only(output,"status");Assert(refusal.Status=="invalid-command","duplicate changed scope");
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, checks = Checks, messages = Samples }));
        return 0;
    }
}
