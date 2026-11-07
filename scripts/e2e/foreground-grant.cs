using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using ProfilePilot.Desktop;

// Controlled experiment only. Grants foreground permission to one already
// verified ProfilePilot child; never activates a window or injects input.
public static class ForegroundGrantExperiment {
    [DllImport("user32.dll",SetLastError=true)] static extern bool AllowSetForegroundWindow(uint processId);
    public static int Main(string[] args){
        int targetPid,appPid;
        if(args.Length!=2 || !Int32.TryParse(args[0],out targetPid) || targetPid<=0 || !Int32.TryParse(args[1],out appPid) || appPid<=0)throw new ArgumentException("Expected exact helper PID and owning App PID.");
        using(var target=Process.GetProcessById(targetPid)){
            long started=target.StartTime.ToUniversalTime().Ticks;
            string executable=target.MainModule.FileName;
            string runtime=Path.Combine(Path.GetTempPath(),"profilepilot-desktop-runtime");
            if(!String.Equals(Path.GetDirectoryName(executable),runtime,StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(executable),"^[a-f0-9]{64}\\.exe$"))throw new InvalidOperationException("Target is not a ProfilePilot runtime helper.");
            int parent=0;
            using(var query=new ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId="+targetPid))using(var rows=query.Get())foreach(ManagementObject row in rows)parent=Convert.ToInt32(row["ParentProcessId"]);
            if(parent!=appPid || target.HasExited || target.StartTime.ToUniversalTime().Ticks!=started)throw new InvalidOperationException("Helper ownership changed.");
            var before=DesktopDiagnostics.Snapshot(IntPtr.Zero);
            var targetIntegrity=DesktopDiagnostics.ProcessIntegrity(targetPid);
            DesktopDiagnostics.SetLastError(0);
            bool granted=AllowSetForegroundWindow((uint)targetPid);
            int win32Error=Marshal.GetLastWin32Error();
            Console.WriteLine(AutomationJson.Json.Serialize(new {caller=before["source"],target=new{pid=targetPid,parentPid=parent,startedUtcTicks=started,integrity=targetIntegrity},foregroundBefore=before["foreground"],granted,win32Error,foregroundAfter=DesktopDiagnostics.Snapshot(IntPtr.Zero)["foreground"]}));
            return 0;
        }
    }
}
