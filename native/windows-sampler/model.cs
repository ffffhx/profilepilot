using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

// Isolated prototype. No UI, input, hooks or persistent service dependencies.
namespace ProfilePilot.WindowsSampler {
    public static class Limits {
        public const int RequestBytes = 256 * 1024, ResponseBytes = 32 * 1024 * 1024;
        public const int Processes = 16384, LockRows = 16384, Paths = 256, Text = 32768, Name = 512;
        public const long OperationMs = 8000;
    }
    public sealed class Failure : Exception {
        public readonly string Code, Stage;
        public uint? Pid, Win32Error, CleanupWin32Error;
        public bool CleanupFailed;
        public Failure(string code, string stage, uint? pid = null, uint? win32Error = null) : base(code) {
            Code = code; Stage = stage; Pid = pid; Win32Error = win32Error;
        }
        public static Failure Safe(Exception error, string stage) {
            return error as Failure ?? new Failure("WINDOWS_SAMPLER_PROVIDER_FAILED", stage);
        }
        public void Cleanup(Exception error) {
            CleanupFailed = true;
            var native = error as QueryFailure;
            var failure = error as Failure;
            if (!CleanupWin32Error.HasValue) CleanupWin32Error = native != null ? native.Win32Error : failure != null ? failure.Win32Error : null;
        }
    }
    public sealed class QueryFailure : Exception {
        public readonly uint? Win32Error;
        public QueryFailure(uint? error) : base("NATIVE_QUERY_FAILED") { Win32Error = error; }
    }
    public interface IClock { long Milliseconds { get; } }
    public sealed class MonotonicClock : IClock {
        readonly Stopwatch clock = Stopwatch.StartNew();
        public long Milliseconds { get { return clock.ElapsedMilliseconds; } }
    }
    public sealed class Budget {
        readonly IClock clock;
        readonly long start;
        public Budget(IClock clock) { this.clock = clock; start = clock.Milliseconds; }
        public long Elapsed { get { return clock.Milliseconds - start; } }
        public long Remaining { get { return Math.Max(1, Limits.OperationMs - Elapsed); } }
        public void Check(string stage) { if (Elapsed >= Limits.OperationMs) throw new Failure("WINDOWS_SAMPLER_DEADLINE", stage); }
    }
    public static class Identity {
        public static bool Valid(string value) {
            if (String.IsNullOrEmpty(value) || value.Length > 20 || value[0] == '0') return false;
            foreach (char c in value) if (c < '0' || c > '9') return false;
            ulong parsed;
            return UInt64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) && parsed > 0;
        }
        public static string FromParts(int high, int low) {
            return (((ulong)unchecked((uint)high) << 32) | unchecked((uint)low)).ToString(CultureInfo.InvariantCulture);
        }
        public static bool WellFormed(string text) {
            for (int i = 0; i < text.Length; i++) {
                if (Char.IsHighSurrogate(text[i])) { if (++i >= text.Length || !Char.IsLowSurrogate(text[i])) return false; }
                else if (Char.IsLowSurrogate(text[i])) return false;
            }
            return true;
        }
    }
    public sealed class CimRow {
        public uint Pid, ParentPid;
        public string Name, ExecutablePath, CommandLine, StartedAt;
        public bool CommandLineAvailable;
    }
    public interface IProcessHandle : IDisposable {
        string CreationFileTime();
        bool IsAlive();
        string ImagePath();
    }
    public interface IProcessProvider {
        IList<uint> EnumerateIds(Budget budget);
        IProcessHandle Open(uint pid);
        IList<CimRow> ReadCim(Budget budget);
    }
    sealed class Pin {
        public IProcessHandle Handle;
        public string Birth, Reason;
        public uint? Error;
    }
    public static class SnapshotSampler {
        static void Text(string value, int maximum, bool required) {
            if (value == null) { if (required) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim"); return; }
            if (value.Length > maximum || required && value.Length == 0 || !Identity.WellFormed(value))
                throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim");
        }
        public static Dictionary<string, object> Run(IProcessProvider provider, Budget budget) {
            var pins = new Dictionary<uint, Pin>(); var handles = new List<IProcessHandle>();
            var result = new List<object>(); Failure failure = null;
            string stage = "process_enumeration"; long enumerateMs = 0, pinMs = 0, cimMs = 0;
            try {
                budget.Check(stage); long phase = budget.Elapsed;
                var ids = provider.EnumerateIds(budget);
                if (ids == null || ids.Count > Limits.Processes) throw new Failure("WINDOWS_SAMPLER_PROCESS_LIMIT", stage);
                var seenIds = new HashSet<uint>();
                foreach (uint pid in ids) if (pid != 0 && !seenIds.Add(pid)) throw new Failure("WINDOWS_SAMPLER_PROCESS_INVALID", stage, pid);
                enumerateMs = budget.Elapsed - phase; phase = budget.Elapsed; stage = "process_pin";
                // All readable handles are opened before the CIM query starts.
                // Holding these objects prevents their PIDs being recycled into
                // unrelated processes while CIM metadata is collected.
                foreach (uint pid in seenIds) {
                    budget.Check(stage); var pin = new Pin(); pins.Add(pid, pin);
                    try { pin.Handle = provider.Open(pid); if (pin.Handle == null) throw new QueryFailure(null); handles.Add(pin.Handle); }
                    catch (QueryFailure error) { pin.Reason = "open_failed"; pin.Error = error.Win32Error; continue; }
                    try {
                        pin.Birth = pin.Handle.CreationFileTime();
                        if (!Identity.Valid(pin.Birth)) { pin.Birth = null; pin.Reason = "birth_failed"; }
                    } catch (QueryFailure error) { pin.Reason = "birth_failed"; pin.Error = error.Win32Error; }
                    if (pin.Reason == null) {
                        try { if (!pin.Handle.IsAlive()) pin.Reason = "exited"; }
                        catch (QueryFailure error) { pin.Reason = "wait_failed"; pin.Error = error.Win32Error; }
                    }
                }
                pinMs = budget.Elapsed - phase; phase = budget.Elapsed; stage = "process_cim";
                budget.Check(stage); var rows = provider.ReadCim(budget); budget.Check(stage);
                cimMs = budget.Elapsed - phase;
                if (rows == null || rows.Count == 0 || rows.Count > Limits.Processes) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", stage);
                var seenRows = new HashSet<uint>(); stage = "process_identity";
                foreach (var row in rows) {
                    budget.Check(stage);
                    if (row == null) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim");
                    if (row.Pid == 0) continue; // System Idle Process cannot be a window/file target.
                    if (!seenRows.Add(row.Pid)) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim", row.Pid);
                    Text(row.Name, Limits.Name, true); Text(row.ExecutablePath, Limits.Text, false);
                    Text(row.CommandLine, Limits.Text, false); Text(row.StartedAt, 128, false);
                    Pin pin; if (!pins.TryGetValue(row.Pid, out pin)) pin = new Pin { Reason = "not_pinned" };
                    if (pin.Reason == null) {
                        try { if (!pin.Handle.IsAlive()) pin.Reason = "exited"; }
                        catch (QueryFailure error) { pin.Reason = "wait_failed"; pin.Error = error.Win32Error; }
                    }
                    string image = row.ExecutablePath;
                    if (String.IsNullOrEmpty(image) && pin.Reason == null) {
                        // Never reopen by PID as an image fallback: use the
                        // same pinned handle, or leave the image unavailable.
                        try { image = pin.Handle.ImagePath(); } catch (QueryFailure) { image = null; }
                        Text(image, Limits.Text, false);
                        try { if (!pin.Handle.IsAlive()) pin.Reason = "exited"; }
                        catch (QueryFailure error) { pin.Reason = "wait_failed"; pin.Error = error.Win32Error; }
                    }
                    var item = new Dictionary<string, object> {
                        {"pid",row.Pid},{"parentPid",row.ParentPid},{"name",row.Name},{"executablePath",image},
                        {"commandLine",row.CommandLineAvailable ? row.CommandLine : image ?? row.Name},
                        {"commandLineAvailable",row.CommandLineAvailable},{"startedAt",row.StartedAt},
                        {"creationFileTime",pin.Reason == null ? pin.Birth : null},
                        {"identityStatus",pin.Reason == null ? "confirmed" : "unavailable"}
                    };
                    if (row.CommandLineAvailable && String.IsNullOrEmpty(row.CommandLine)) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim", row.Pid);
                    if (pin.Reason != null) { item.Add("identityReason", pin.Reason); if (pin.Error.HasValue) item.Add("identityWin32Error", pin.Error.Value); }
                    result.Add(item);
                }
                if (result.Count == 0) throw new Failure("WINDOWS_SAMPLER_CIM_INVALID", "process_cim");
                budget.Check(stage);
            } catch (Exception error) { failure = Failure.Safe(error, stage); }
            finally {
                for (int i = handles.Count - 1; i >= 0; i--) try { handles[i].Dispose(); }
                catch (Exception error) {
                    if (failure == null) failure = new Failure("WINDOWS_SAMPLER_CLEANUP_FAILED", "process_close");
                    failure.Cleanup(error);
                }
            }
            if (failure != null) throw failure;
            budget.Check("process_close");
            return new Dictionary<string, object> { {"processes",result},{"complete",true},
                {"timings",new Dictionary<string,object>{{"totalMs",budget.Elapsed},{"enumerateMs",enumerateMs},{"pinMs",pinMs},{"cimMs",cimMs}}} };
        }
    }
    public sealed class LockIdentity { public uint Pid; public string CreationFileTime; }
    public sealed class LockReply { public uint Status, Needed, Count; public IList<LockIdentity> Rows; }
    public interface IRestartSession : IDisposable { void Register(string path); LockReply Query(uint capacity); }
    public interface IRestartProvider { IRestartSession Start(); }
    public static class FileLockSampler {
        public static Dictionary<string, object> Run(IRestartProvider provider, IList<string> paths, Budget budget) {
            var result = new List<object>(); var allBirths = new Dictionary<uint,string>();
            foreach (string path in paths) {
                budget.Check("rm_start"); IRestartSession session = null; Failure failure = null; string stage = "rm_start";
                try {
                    session = provider.Start(); if (session == null) throw new Failure("WINDOWS_SAMPLER_RM_START_FAILED", stage);
                    budget.Check(stage); stage = "rm_register"; session.Register(path); budget.Check(stage); stage = "rm_list";
                    uint capacity = 0; bool complete = false;
                    for (int attempt = 0; attempt < 4; attempt++) {
                        budget.Check(stage); var reply = session.Query(capacity); budget.Check(stage);
                        if (reply == null) throw new Failure("WINDOWS_SAMPLER_RM_INVALID", stage);
                        if (reply.Status == 0) {
                            if (reply.Needed > reply.Count || reply.Count > capacity || reply.Rows == null || reply.Rows.Count != reply.Count)
                                throw new Failure("WINDOWS_SAMPLER_RM_INVALID", stage);
                            var seen = new Dictionary<uint,string>();
                            foreach (var row in reply.Rows) {
                                budget.Check(stage);
                                if (row == null || row.Pid == 0 || !Identity.Valid(row.CreationFileTime)) throw new Failure("WINDOWS_SAMPLER_RM_INVALID", stage);
                                string previous;
                                if (allBirths.TryGetValue(row.Pid,out previous) && previous != row.CreationFileTime)
                                    throw new Failure("WINDOWS_SAMPLER_IDENTITY_CONFLICT", stage, row.Pid);
                                allBirths[row.Pid] = row.CreationFileTime;
                                if (seen.ContainsKey(row.Pid)) continue;
                                seen.Add(row.Pid,row.CreationFileTime);
                                if (result.Count >= Limits.LockRows) throw new Failure("WINDOWS_SAMPLER_ROW_LIMIT", stage);
                                result.Add(new Dictionary<string,object>{{"path",path},{"pid",row.Pid},{"creationFileTime",row.CreationFileTime}});
                            }
                            complete = true; break;
                        }
                        if (reply.Status != 234) throw new Failure("WINDOWS_SAMPLER_RM_LIST_FAILED",stage,null,reply.Status);
                        if (reply.Needed <= capacity || reply.Needed > Limits.LockRows) throw new Failure("WINDOWS_SAMPLER_RM_INVALID",stage);
                        if (attempt == 3) throw new Failure("WINDOWS_SAMPLER_RM_LIST_FAILED",stage,null,234);
                        capacity = reply.Needed; // Ignore every partial ERROR_MORE_DATA row.
                    }
                    if (!complete) throw new Failure("WINDOWS_SAMPLER_RM_LIST_FAILED",stage,null,234);
                } catch (Exception error) { failure = Failure.Safe(error, stage); }
                finally {
                    if (session != null) try { session.Dispose(); }
                    catch (Exception error) {
                        if (failure == null) failure = new Failure("WINDOWS_SAMPLER_CLEANUP_FAILED", "rm_end");
                        failure.Cleanup(error);
                    }
                }
                if (failure != null) throw failure;
            }
            budget.Check("rm_end");
            return new Dictionary<string,object>{{"rows",result},{"complete",true},
                {"timings",new Dictionary<string,object>{{"totalMs",budget.Elapsed}}}};
        }
    }
}
