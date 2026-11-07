using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace ProfilePilot.WindowsSampler {
    // Independent of the provider's cooperative budget and the parent's event
    // loop. This is a last-resort lifetime threshold, including stdin and
    // stdout stalls. Scheduling and pending I/O can delay actual exit.
    public static class WatchdogLoop {
        public const int LifetimeMilliseconds = 10000;
        public static void Run(Func<long> elapsed, Func<int,bool> wait, Func<bool> cancelled, Action<int> exit) {
            for (;;) {
                if (cancelled()) return;
                long current = elapsed();
                if (current < 0 || current >= LifetimeMilliseconds) {
                    if (!cancelled()) exit(2);
                    return;
                }
                if (wait((int)(LifetimeMilliseconds-current))) return;
            }
        }
    }
    public sealed class ProcessWatchdog : IDisposable {
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
        readonly object gate = new object();
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly Thread worker;
        bool cancelled, finished;
        public ProcessWatchdog() {
            worker = new Thread(Watch) { IsBackground=true, Name="ProfilePilot sampler lifetime" };
            try { worker.Start(); } catch { stop.Dispose(); throw; }
        }
        bool Cancelled() { lock (gate) return cancelled; }
        void Expire(int code) {
            lock (gate) {
                if (cancelled) return;
                // Only our own pseudo-handle is accepted here. Bypass DLL
                // detach when an unknown provider thread may hold its locks.
                // Success cannot return; a failed native call falls back to a
                // failed CLR exit, never a second stdout frame or success.
                // Neither path proves provider finally blocks completed.
                try { TerminateProcess(GetCurrentProcess(), 2); }
                finally { Environment.Exit(2); }
            }
        }
        void Watch() {
            try { WatchdogLoop.Run(()=>clock.ElapsedMilliseconds, milliseconds=>stop.WaitOne(milliseconds), Cancelled, Expire); }
            catch { Expire(2); }
            finally { lock (gate) { finished=true; stop.Dispose(); } }
        }
        public void Dispose() {
            lock (gate) {
                cancelled=true;
                // The worker disposes the event after leaving its wait. The
                // gate prevents cancellation from setting a disposed handle.
                if (!finished) stop.Set();
            }
        }
    }
}
