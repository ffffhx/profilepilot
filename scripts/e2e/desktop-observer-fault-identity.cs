using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

// Identity of one explicitly supplied PID. The optional cleanup path requires
// the captured full process identity before stopping the owned fixture only.
// No HWND, input, hook, elevation, or command-line disclosure is performed.
public static class ObserverFaultIdentity {
    // Passive, bounded waiting is separate from the existing force-cleanup
    // command. Pin a process handle before reading its birth identity so PID
    // reuse cannot make WaitForExit wait for a replacement process.
    public interface IOwnedExitProcess : IDisposable {
        bool HasExited { get; }
        long StartedUtcTicks { get; }
        bool WaitForExit(int milliseconds);
    }
    sealed class OwnedExitProcess : IOwnedExitProcess {
        readonly Process process;
        public OwnedExitProcess(int pid) {
            process = Process.GetProcessById(pid);
            try {
                try { IntPtr pinned = process.Handle; }
                catch (InvalidOperationException) { if (!process.HasExited) throw; }
            }
            catch { process.Dispose(); throw; }
        }
        public bool HasExited { get { return process.HasExited; } }
        public long StartedUtcTicks { get { return process.StartTime.ToUniversalTime().Ticks; } }
        public bool WaitForExit(int milliseconds) { return process.WaitForExit(milliseconds); }
        public void Dispose() { process.Dispose(); }
    }
    public sealed class OwnedExitResult {
        public bool ok = true, originalExited, replacementUntouched, timedOut;
    }
    public static OwnedExitResult WaitOwnedExit(int pid, long ticks, int milliseconds, Func<int, IOwnedExitProcess> open) {
        if (pid <= 0 || ticks <= 0 || milliseconds < 1 || milliseconds > 10000 || open == null) throw new ArgumentException("Invalid owned exit wait");
        IOwnedExitProcess process;
        try { process = open(pid); }
        catch (ArgumentException) { return new OwnedExitResult { originalExited = true }; }
        using (process) {
            if (process.HasExited) return new OwnedExitResult { originalExited = true };
            if (process.StartedUtcTicks != ticks) return new OwnedExitResult { originalExited = true, replacementUntouched = true };
            bool exited = process.WaitForExit(milliseconds);
            return new OwnedExitResult { originalExited = exited, timedOut = !exited };
        }
    }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr Information(IntPtr token,int kind) {
        int needed; GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
        if(needed<=0 || needed>65536)throw new InvalidOperationException("Token information unavailable");
        IntPtr value=Marshal.AllocHGlobal(needed);
        if(!GetTokenInformation(token,kind,value,needed,out needed)){Marshal.FreeHGlobal(value);throw new InvalidOperationException("Token information unavailable");}
        return value;
    }
    static int Number(IntPtr token,int kind){IntPtr data=Information(token,kind);try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
    public static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "--wait-owned-exit") {
                int waitPid, milliseconds; long ticks;
                if (args.Length != 4 || !Int32.TryParse(args[1], out waitPid) || !Int64.TryParse(args[2], out ticks) || !Int32.TryParse(args[3], out milliseconds)) throw new ArgumentException("Expected PID, birth ticks and wait milliseconds");
                Console.WriteLine(new JavaScriptSerializer().Serialize(WaitOwnedExit(waitPid, ticks, milliseconds, ownedPid => new OwnedExitProcess(ownedPid))));
                return 0;
            }
            bool cleanup=args.Length==6 && args[0]=="--cleanup-owned";
            int pid; if(!(args.Length==2 && args[0]=="--inspect") && !cleanup || !Int32.TryParse(args[1],out pid) || pid<=0)throw new ArgumentException("Expected one owned PID");
            if(cleanup){try{using(var probe=Process.GetProcessById(pid)){if(probe.StartTime.ToUniversalTime().Ticks.ToString()!=args[2]){Console.WriteLine("{\"ok\":true,\"originalExited\":true,\"replacementUntouched\":true}");return 0;}}}catch(ArgumentException){Console.WriteLine("{\"ok\":true,\"originalExited\":true}");return 0;}}
            using(Process process=Process.GetProcessById(pid)) {
                string started=process.StartTime.ToUniversalTime().Ticks.ToString(), executable=process.MainModule.FileName;
                uint parent; using(var management=new ManagementObject("Win32_Process.Handle='"+pid+"'")){management.Get();parent=Convert.ToUInt32(management["ParentProcessId"]);}
                string hash; using(var sha=SHA256.Create())using(var file=File.Open(executable,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))hash=BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();
                IntPtr token; if(!OpenProcessToken(process.Handle,8,out token))throw new InvalidOperationException("Owned token unavailable");
                int rid;bool elevated,uiAccess;
                try{IntPtr data=Information(token,25);try{IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(count==0)throw new InvalidOperationException("Integrity SID unavailable");rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{Marshal.FreeHGlobal(data);}elevated=Number(token,20)!=0;uiAccess=Number(token,26)!=0;}finally{CloseHandle(token);}
                if(process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString()!=started)throw new InvalidOperationException("Owned process changed");
                if(cleanup){
                    if(started!=args[2] || !String.Equals(Path.GetFullPath(executable),Path.GetFullPath(args[3]),StringComparison.OrdinalIgnoreCase) || hash!=args[4] || parent.ToString()!=args[5] || rid!=8192 || elevated || uiAccess)throw new InvalidOperationException("Refusing cleanup of a different process identity");
                    process.Kill();if(!process.WaitForExit(5000))throw new InvalidOperationException("Owned cleanup exit unconfirmed");
                    Console.WriteLine("{\"ok\":true,\"originalExited\":true,\"forced\":true}");return 0;
                }
                Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,pid=pid,parentPid=parent,startedUtcTicks=started,executable=executable,sha256=hash,integrityRid=rid,elevated=elevated,uiAccess=uiAccess}));
                return 0;
            }
        } catch(Exception error){Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=false,error=error.Message}));return 1;}
    }
}
