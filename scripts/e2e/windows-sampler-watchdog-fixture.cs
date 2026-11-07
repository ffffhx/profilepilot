using System;
using System.Diagnostics;
using System.Threading;
using ProfilePilot.WindowsSampler;

// Test executable only; the production sampler has no fixture operation.
public static class WindowsSamplerWatchdogFixture {
    public static int Main(string[] args) {
        if(args.Length!=2 || (args[0]!="block" && args[0]!="cancel-and-hold" && args[0]!="stdout-stall"))return 3;
        Guid nonce;if(!Guid.TryParseExact(args[1],"N",out nonce))return 3;
        using(var lifetime=new ProcessWatchdog()) {
            if(args[0]=="stdout-stall") {
                using(var self=Process.GetCurrentProcess()) Console.Error.WriteLine("{\"kind\":\"ready\",\"nonce\":\""+args[1]+"\",\"pid\":"+self.Id+
                    ",\"startTicks\":\""+self.StartTime.ToUniversalTime().Ticks+"\"}");
                const int planned=16*1024*1024, chunk=64*1024;
                Console.Error.WriteLine("{\"kind\":\"write-started\",\"nonce\":\""+args[1]+"\",\"plannedBytes\":"+planned+",\"chunkBytes\":"+chunk+"}");Console.Error.Flush();
                var bytes=new byte[chunk];for(int i=0;i<bytes.Length;i++)bytes[i]=90;
                // Bounded fixed data only. The parent does not consume payload
                // before exit; Node/OS buffers may prefetch. Stderr stays drained.
                using(var output=Console.OpenStandardOutput()) {
                    for(int sent=0;sent<planned;sent+=chunk)output.Write(bytes,0,bytes.Length);
                    output.Flush();
                }
                Console.Error.WriteLine("{\"kind\":\"write-returned\",\"nonce\":\""+args[1]+"\",\"writtenBytes\":"+planned+"}");Console.Error.Flush();
                return 0;
            }
            using(var self=Process.GetCurrentProcess()) Console.WriteLine("{\"kind\":\"ready\",\"nonce\":\""+args[1]+"\",\"pid\":"+self.Id+
                ",\"startTicks\":\""+self.StartTime.ToUniversalTime().Ticks+"\"}");
            Console.Out.Flush();
            if(args[0]=="block")Thread.Sleep(Timeout.Infinite);
        }
        Console.WriteLine("{\"kind\":\"cancelled\",\"nonce\":\""+args[1]+"\"}");Console.Out.Flush();
        // Remaining alive beyond the original deadline proves Dispose cancels
        // the watchdog, rather than a quick Main exit hiding an armed timer.
        Thread.Sleep(11000);
        Console.WriteLine("{\"kind\":\"completed\",\"nonce\":\""+args[1]+"\"}");return 0;
    }
}
