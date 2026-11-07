using System;
namespace ProfilePilot.WindowsSampler {
    public static class Program {
        public static int Main(string[] args) {
            // Start before parsing/reading stdin. If the parent disappears,
            // blocked work still has this independent termination attempt.
            // CLR startup, scheduling and pending I/O are not real-time bounds.
            try { using(var lifetime=new ProcessWatchdog()) return Run(args); }
            catch { return 2; } // Failure to start the lifetime bound is closed.
        }
        static int Run(string[] args) {
            var header=new Header();byte[] reply;int exitCode;
            try {
                if(args.Length!=0)throw new Failure("WINDOWS_SAMPLER_BAD_REQUEST","protocol");
                var request=Protocol.Parse(Protocol.Read(Console.OpenStandardInput()),header);
                if(Environment.OSVersion.Platform!=PlatformID.Win32NT)throw new Failure("WINDOWS_SAMPLER_PLATFORM_UNSUPPORTED","protocol");
                var budget=new Budget(new MonotonicClock());
                object result=request.Operation=="snapshot" ? SnapshotSampler.Run(new WindowsProcesses(),budget)
                    : FileLockSampler.Run(new WindowsRestartManager(),request.Paths,budget);
                reply=Protocol.Success(header,result);exitCode=0;
            } catch(Exception error) {reply=Protocol.Error(header,Failure.Safe(error,"protocol"));exitCode=2;}
            try {using(var output=Console.OpenStandardOutput()){output.Write(reply,0,reply.Length);output.Flush();}}
            catch {return 2;} // Never print a partial second response or raw exception.
            return exitCode;
        }
    }
}
