using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Alternate entrypoint: every process object and wait callback below is fake.
// No PID lookup, process handle, waiting, hook or window API is invoked.
public static class DesktopOwnedExitTests {
    sealed class Fake : ObserverFaultIdentity.IOwnedExitProcess {
        public bool Exited, WaitResult, Disposed, ReadBirth;
        public long Ticks = 123;
        public int Waits, Timeout;
        public Exception Failure;
        public bool HasExited { get { return Exited; } }
        public long StartedUtcTicks { get { ReadBirth = true; return Ticks; } }
        public bool WaitForExit(int milliseconds) { Waits++; Timeout = milliseconds; if (Failure != null) throw Failure; return WaitResult; }
        public void Dispose() { Disposed = true; }
    }
    static readonly List<string> Checks = new List<string>();
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    static void Check(string label, Action body) { body(); Checks.Add(label); }
    static ObserverFaultIdentity.OwnedExitResult Wait(Fake process) { return ObserverFaultIdentity.WaitOwnedExit(42, 123, 5000, pid => { Assert(pid == 42, "PID changed"); return process; }); }
    public static int Main() {
        Check("absent original is exited without retry", () => {
            int calls = 0;
            var result = ObserverFaultIdentity.WaitOwnedExit(42, 123, 5000, pid => { calls++; throw new ArgumentException("No process"); });
            Assert(result.ok && result.originalExited && !result.timedOut && calls == 1, "absence");
        });
        Check("already exited handle is neither queried for birth nor waited", () => {
            var process = new Fake { Exited = true }; var result = Wait(process);
            Assert(result.originalExited && !process.ReadBirth && process.Waits == 0 && process.Disposed, "already exited");
        });
        Check("replacement birth is left untouched and never waited", () => {
            var process = new Fake { Ticks = 124 }; var result = Wait(process);
            Assert(result.originalExited && result.replacementUntouched && process.Waits == 0 && process.Disposed, "replacement");
        });
        Check("exact original normal exit uses one bounded passive wait", () => {
            var process = new Fake { WaitResult = true }; var result = Wait(process);
            Assert(result.originalExited && !result.timedOut && !result.replacementUntouched && process.Waits == 1 && process.Timeout == 5000 && process.Disposed, "normal wait");
        });
        Check("timeout does not claim original exited", () => {
            var process = new Fake(); var result = Wait(process);
            Assert(!result.originalExited && result.timedOut && process.Waits == 1 && process.Disposed, "timeout");
        });
        Check("access failure is not mistaken for process absence", () => {
            bool failed = false;
            try { ObserverFaultIdentity.WaitOwnedExit(42, 123, 5000, pid => { throw new Win32Exception(5); }); } catch (Win32Exception) { failed = true; }
            Assert(failed, "access error swallowed");
        });
        Check("wait errors propagate and always dispose the pinned process", () => {
            var process = new Fake { Failure = new InvalidOperationException("unknown") }; bool failed = false;
            try { Wait(process); } catch (InvalidOperationException) { failed = true; }
            Assert(failed && process.Disposed, "wait error");
        });
        Check("invalid PID birth and timeout never open a process", () => {
            foreach (var values in new[] { new long[] { 0, 123, 5000 }, new long[] { 42, 0, 5000 }, new long[] { 42, 123, 0 }, new long[] { 42, 123, 10001 } }) {
                int opens = 0; bool failed = false;
                try { ObserverFaultIdentity.WaitOwnedExit((int)values[0], values[1], (int)values[2], pid => { opens++; return new Fake(); }); } catch (ArgumentException) { failed = true; }
                Assert(failed && opens == 0, "invalid arguments opened process");
            }
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, checks = Checks, pure = true, processesOpened = 0 })); return 0;
    }
}
