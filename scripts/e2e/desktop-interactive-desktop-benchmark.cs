using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Read-only benchmark, run explicitly by the acceptance coordinator at Medium.
// No window, hook, input, UIA element, process enumeration, or App entry point.
// Arguments: absolute-result-base nonce absolute-ProfilePilot.Desktop.exe
public static class DesktopInteractiveDesktopBenchmark {
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr Information(IntPtr token,int kind) {
        int needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
        if(needed<=0 || needed>65536)throw new InvalidOperationException("TOKEN_INFORMATION_UNAVAILABLE");
        IntPtr data=Marshal.AllocHGlobal(needed);
        if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new InvalidOperationException("TOKEN_INFORMATION_UNAVAILABLE");}
        return data;
    }
    static int Number(IntPtr token,int kind){IntPtr data=Information(token,kind);try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
    static string Sha256(string file){using(var hash=SHA256.Create())using(var input=File.OpenRead(file))return BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
    static object Batch(Func<bool> query,int iterations,ref int calls) {
        int yes=0,no=0;var watch=Stopwatch.StartNew();
        for(int index=0;index<iterations;index++){calls++;if(query())yes++;else no++;}
        watch.Stop();return new {iterations,trueCount=yes,falseCount=no,elapsedTicks=watch.ElapsedTicks,
            elapsedMilliseconds=watch.Elapsed.TotalMilliseconds,microsecondsPerCall=watch.Elapsed.TotalMilliseconds*1000/iterations};
    }
    public static int Main(string[] args) {
        if(args.Length!=3 || !Path.IsPathRooted(args[0]) || !Regex.IsMatch(args[1],"^[a-f0-9]{32}$") || !Path.IsPathRooted(args[2]))return 2;
        string output=args[0]+".result.json",nonce=args[1],native=Path.GetFullPath(args[2]);
        int nativeQueryCalls=0;
        var report=new Dictionary<string,object>{{"ok",false},{"nonce",nonce},{"guiStarted",false},{"hooksInstalled",false},{"inputInjected",false},{"nativeQueryCalls",0}};
        try {
            if(!String.Equals(Path.GetFileName(native),"ProfilePilot.Desktop.exe",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("NATIVE_FILENAME_MISMATCH");
            using(var process=Process.GetCurrentProcess()) {
                report["pid"]=process.Id;report["startedUtcTicks"]=process.StartTime.ToUniversalTime().Ticks.ToString();
                IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new InvalidOperationException("TOKEN_UNAVAILABLE");
                int rid;bool elevated,uiAccess;
                try {
                    IntPtr data=Information(token,25);
                    try{IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(count==0)throw new InvalidOperationException("TOKEN_SID_UNAVAILABLE");rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}
                    finally{Marshal.FreeHGlobal(data);}
                    elevated=Number(token,20)!=0;uiAccess=Number(token,26)!=0;
                }finally{CloseHandle(token);}
                report["integrityRid"]=rid;report["elevated"]=elevated;report["uiAccess"]=uiAccess;
                if(rid!=8192 || elevated || uiAccess)throw new InvalidOperationException("MEDIUM_REQUIRED");
            }
            string hash=Sha256(native);var assembly=Assembly.LoadFrom(native);
            var type=assembly.GetType("ProfilePilot.Desktop.DesktopHost",true);
            var method=type.GetMethod("IsInteractiveDesktop",BindingFlags.Static|BindingFlags.Public);
            if(method==null || method.ReturnType!=typeof(bool) || method.GetParameters().Length!=0)throw new InvalidOperationException("METHOD_SIGNATURE_CHANGED");
            var query=(Func<bool>)Delegate.CreateDelegate(typeof(Func<bool>),method);
            report["nativeExecutable"]=native;report["nativeSha256"]=hash;
            report["nativeModuleVersionId"]=method.Module.ModuleVersionId.ToString();
            report["stopwatchFrequency"]=Stopwatch.Frequency;report["warmupCalls"]=10;
            int warmupTrue=0;for(int index=0;index<10;index++){nativeQueryCalls++;if(query())warmupTrue++;}
            report["warmupTrue"]=warmupTrue;report["warmupFalse"]=10-warmupTrue;
            report["batches"]=new[]{Batch(query,100,ref nativeQueryCalls),Batch(query,1000,ref nativeQueryCalls)};
            if(hash!=Sha256(native))throw new InvalidOperationException("NATIVE_FILE_CHANGED");
            report["ok"]=true;
            report["limitation"]="Warmed synchronous delegate wall time includes OS scheduling. This does not measure UIA provider or whole observation latency.";
        }catch(Exception error){report["errorType"]=error.GetType().Name;report["error"]=error.Message;}
        report["nativeQueryCalls"]=nativeQueryCalls;report["finishedAt"]=DateTime.UtcNow.ToString("o");
        try{File.WriteAllText(output,new JavaScriptSerializer().Serialize(report),new UTF8Encoding(false));}
        catch{return 3;}
        return (bool)report["ok"]?0:1;
    }
}
