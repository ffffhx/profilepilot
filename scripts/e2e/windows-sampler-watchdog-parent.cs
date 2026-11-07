using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using ProfilePilot.WindowsSampler;

// The parent is deliberately killable. It neither kills its child on exit nor
// forwards stdin; the child blocks inside the independent provider fixture.
public static class WindowsSamplerWatchdogParent {
    [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    static bool PreventParentPipeInheritance(out object[] states) {
        var rows=new List<object>();states=null;
        foreach(int kind in new[]{-10,-11,-12}) {
            IntPtr handle=GetStdHandle(kind);uint before,after;
            if(handle==IntPtr.Zero || handle==new IntPtr(-1) || !GetHandleInformation(handle,out before)
                || !SetHandleInformation(handle,1,0) || !GetHandleInformation(handle,out after) || (after&1)!=0)return false;
            rows.Add(new{standard=kind,inheritedBefore=(before&1)!=0,inheritedAfter=(after&1)!=0});
        }
        states=rows.ToArray();return true;
    }
    static string Hash(string file) {
        using(var sha=SHA256.Create())using(var input=File.Open(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();
    }
    public static int Main(string[] args) {
        using(var lifetime=new ProcessWatchdog()) {
            Guid nonce;
            if(args.Length!=2 || !Guid.TryParseExact(args[0],"N",out nonce))return 3;
            string executable=Path.GetFullPath(args[1]), own=Process.GetCurrentProcess().MainModule.FileName;
            if(!String.Equals(Path.GetDirectoryName(executable),Path.GetDirectoryName(own),StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(executable)!="SamplerWatchdogFixture.exe")return 3;
            var json=new JavaScriptSerializer();
            // Framework Process.Start can inherit additional inheritable
            // handles. The child must not keep our Node-facing pipes open:
            // parent process exit and parent stdio close are separate events.
            // Its explicitly redirected standard streams are created below.
            object[] inheritance;if(!PreventParentPipeInheritance(out inheritance))return 4;
            using(var child=Process.Start(new ProcessStartInfo { FileName=executable, Arguments="block "+args[0],
                WorkingDirectory=Path.GetDirectoryName(executable), UseShellExecute=false, CreateNoWindow=true,
                RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true })) {
                IntPtr pinned=child.Handle;
                string ticks=child.StartTime.ToUniversalTime().Ticks.ToString(), actual=child.MainModule.FileName, sha=Hash(actual);
                if(!String.Equals(Path.GetFullPath(actual),executable,StringComparison.OrdinalIgnoreCase))return 3;
                string ready=child.StandardOutput.ReadLine();
                if(ready==null || ready.Length>4096 || child.HasExited)return 3;
                Console.WriteLine(json.Serialize(new { kind="parent-ready", nonce=args[0], parentPid=Process.GetCurrentProcess().Id,
                    handleInheritance=inheritance,child=new { pid=child.Id,startTicks=ticks,executable=actual,sha256=sha }, childReady=json.DeserializeObject(ready) }));
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
            }
        }
        return 0;
    }
}
