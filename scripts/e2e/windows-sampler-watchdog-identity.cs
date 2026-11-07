using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

// Independent, exact-identity waiting. No CIM/WMI, enumeration, GUI or hooks.
// The optional force path acts only on the pinned original process, and its
// receipt remains a test failure even when the process is successfully killed.
public static class WindowsSamplerWatchdogIdentity {
    public interface IOwnedProcess : IDisposable {
        bool HasExited { get; }
        string StartTicks { get; }
        string Executable { get; }
        string Sha256 { get; }
        int ExitCode { get; }
        string ExitUtcTicks { get; }
        bool Wait(int milliseconds);
        void Kill();
    }
    public sealed class Result {
        public bool ok=true,originalExited,replacementUntouched,timedOut,forced,closeConfirmed;
        public int? exitCode;
        public string startedUtcTicks,exitedUtcTicks;
        public string error;
    }
    sealed class OwnedProcess : IOwnedProcess {
        readonly Process value;
        public OwnedProcess(int pid) {
            value=Process.GetProcessById(pid);
            try { IntPtr pinned=value.Handle; } catch { value.Dispose();throw; }
        }
        public bool HasExited { get {return value.HasExited;} }
        public string StartTicks { get {return value.StartTime.ToUniversalTime().Ticks.ToString();} }
        public string Executable { get {return value.MainModule.FileName;} }
        public string Sha256 { get {
            using(var sha=SHA256.Create())using(var input=File.Open(Executable,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
                return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();
        } }
        public int ExitCode { get {return value.ExitCode;} }
        public string ExitUtcTicks { get {return value.ExitTime.ToUniversalTime().Ticks.ToString();} }
        public bool Wait(int milliseconds) {return value.WaitForExit(milliseconds);}
        public void Kill() {value.Kill();}
        public void Dispose() {value.Dispose();}
    }
    public static Result WaitOwned(int pid,string ticks,string executable,string sha,int milliseconds,bool force,Func<int,IOwnedProcess> open) {
        long birth;
        if(pid<=0 || !Int64.TryParse(ticks,out birth) || birth<=0 || milliseconds<1 || milliseconds>10000
            || String.IsNullOrEmpty(executable) || sha==null || sha.Length!=64 || open==null)throw new ArgumentException("INVALID_OWNED_WAIT");
        foreach(char c in sha)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("INVALID_OWNED_HASH");
        IOwnedProcess process;
        try {process=open(pid);}catch(ArgumentException){return new Result {originalExited=true,closeConfirmed=true};}
        using(process) {
            if(process.StartTicks!=ticks)return new Result {originalExited=true,replacementUntouched=true,closeConfirmed=true};
            if(process.HasExited)return Exited(process,ticks);
            if(!String.Equals(Path.GetFullPath(process.Executable),Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase)
                || process.Sha256!=sha)throw new InvalidOperationException("OWNED_IDENTITY_MISMATCH");
            if(process.Wait(milliseconds))return Exited(process,ticks);
            var result=new Result {timedOut=true};
            if(force) {
                result.forced=true;
                try {process.Kill();result.closeConfirmed=process.Wait(2000);result.originalExited=result.closeConfirmed;if(result.closeConfirmed){result.exitCode=process.ExitCode;result.startedUtcTicks=ticks;result.exitedUtcTicks=process.ExitUtcTicks;}}
                catch {result.error="OWNED_CLEANUP_FAILED";}
            }
            return result;
        }
    }
    static Result Exited(IOwnedProcess process,string ticks) {return new Result {originalExited=true,closeConfirmed=true,exitCode=process.ExitCode,
        startedUtcTicks=ticks,exitedUtcTicks=process.ExitUtcTicks};}
    public static int Main(string[] args) {
        try {
            int pid,milliseconds;
            if((args.Length!=6 && args.Length!=7) || args[0]!="--wait-owned-exit" || !Int32.TryParse(args[1],out pid)
                || !Int32.TryParse(args[5],out milliseconds) || args.Length==7 && args[6]!="--force-if-timeout")throw new ArgumentException("INVALID_OWNED_WAIT");
            Console.WriteLine(new JavaScriptSerializer().Serialize(WaitOwned(pid,args[2],args[3],args[4],milliseconds,args.Length==7,id=>new OwnedProcess(id))));return 0;
        }catch {Console.WriteLine("{\"ok\":false,\"error\":\"OWNED_WAIT_FAILED\"}");return 1;}
    }
}
