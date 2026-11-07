using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

public static class WgcProbe {
    [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,int length,out int needed);
    [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    delegate bool EnumerateWindow(IntPtr window,IntPtr state);
    [DllImport("user32.dll")]static extern bool EnumWindows(EnumerateWindow callback,IntPtr state);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")]static extern bool IsWindow(IntPtr window);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=1024*1024};
    static void Print(object result){Console.WriteLine(Json.Serialize(result));}
    static bool Administrator(){return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);}
    static int IntegrityRid(){
        IntPtr token,buffer=IntPtr.Zero;
        if(!OpenProcessToken(GetCurrentProcess(),8,out token))throw new System.ComponentModel.Win32Exception();
        try{
            int needed;GetTokenInformation(token,25,IntPtr.Zero,0,out needed);
            if(needed<IntPtr.Size)throw new InvalidOperationException("Token integrity size unavailable");
            buffer=Marshal.AllocHGlobal(needed);
            if(!GetTokenInformation(token,25,buffer,needed,out needed))throw new System.ComponentModel.Win32Exception();
            IntPtr sid=Marshal.ReadIntPtr(buffer);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if(count==0)throw new InvalidOperationException("Token integrity SID is empty");
            return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
        }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);CloseHandle(token);}
    }
    static string Digest(byte[] bytes){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
    static object Inspect(string path){
        using(var bitmap=new Bitmap(path)){
            var colors=new[]{new[]{33,160,80},new[]{34,119,187},new[]{215,50,70}};
            var markers=colors.Select(rgb=>{
                int count=0,left=bitmap.Width,top=bitmap.Height,right=-1,bottom=-1;long sumX=0,sumY=0;
                for(int y=0;y<bitmap.Height;y++)for(int x=0;x<bitmap.Width;x++){
                    var color=bitmap.GetPixel(x,y);
                    if(Math.Abs(color.R-rgb[0])<=20 && Math.Abs(color.G-rgb[1])<=20 && Math.Abs(color.B-rgb[2])<=20){count++;sumX+=x;sumY+=y;left=Math.Min(left,x);right=Math.Max(right,x);top=Math.Min(top,y);bottom=Math.Max(bottom,y);}
                }
                return new{rgb,count,x=count==0?-1:(double)sumX/count,y=count==0?-1:(double)sumY/count,left,top,right,bottom};
            }).ToArray();
            return new{width=bitmap.Width,height=bitmap.Height,format=bitmap.RawFormat.Guid.ToString(),markers};
        }
    }
    [MTAThread]public static int Main(string[] args){
        Console.OutputEncoding=new UTF8Encoding(false);
        try{
            if(args.Length==1 && args[0]=="--identity"){Print(new{ok=true,pid=Process.GetCurrentProcess().Id,administrator=Administrator(),integrityRid=IntegrityRid()});return 0;}
            if(args.Length==2 && args[0]=="--diagnose"){
                int expectedPid=int.Parse(args[1],CultureInfo.InvariantCulture);var handles=new List<string>();
                EnumWindows((window,ignored)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==expectedPid)handles.Add(window.ToInt64().ToString(CultureInfo.InvariantCulture));return true;},IntPtr.Zero);
                Print(new{ok=true,pid=Process.GetCurrentProcess().Id,sessionId=Process.GetCurrentProcess().SessionId,expectedPid,handles});return 0;
            }
            if(args.Length==2 && args[0]=="--inspect"){Print(new{ok=true,image=Inspect(args[1])});return 0;}
            var options=new Dictionary<string,string>();
            for(int index=0;index<args.Length;index+=2){
                if(index+1>=args.Length || !new[]{"--capture","--output","--timeout-ms","--cancel-after-ms"}.Contains(args[index]) || options.ContainsKey(args[index]))throw new ArgumentException("Expected --capture HWND --output NEW_FILE [--timeout-ms N] [--cancel-after-ms N]");
                options.Add(args[index],args[index+1]);
            }
            if(!options.ContainsKey("--capture") || !options.ContainsKey("--output"))throw new ArgumentException("An explicit HWND and output file are required.");
            long handle=long.Parse(options["--capture"],CultureInfo.InvariantCulture);
            if(handle<=0)throw new ArgumentException("HWND must be positive.");
            int timeout=options.ContainsKey("--timeout-ms")?int.Parse(options["--timeout-ms"],CultureInfo.InvariantCulture):5000;
            int cancelAfter=options.ContainsKey("--cancel-after-ms")?int.Parse(options["--cancel-after-ms"],CultureInfo.InvariantCulture):-1;
            if(cancelAfter< -1 || cancelAfter>10000)throw new ArgumentException("Cancellation must be -1 or 0..10000 ms.");
            var clock=Stopwatch.StartNew();
            var result=WgcWindowCapture.Capture(new IntPtr(handle),()=>cancelAfter>=0 && clock.ElapsedMilliseconds>=cancelAfter,timeout);
            byte[] bytes=result.Jpeg;result.Jpeg=null;
            string output=null,sha256=null;
            if(result.Success){
                output=Path.GetFullPath(options["--output"]);sha256=Digest(bytes);
                using(var file=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.Read))file.Write(bytes,0,bytes.Length);
            }
            Print(new{ok=result.Success,administrator=Administrator(),integrityRid=IntegrityRid(),pid=Process.GetCurrentProcess().Id,result,output,sha256,byteLength=bytes==null?0:bytes.Length});
            return result.Success?0:3;
        }catch(Exception error){Print(new{ok=false,error=new{code="WGC_PROBE_FAILED",message=error.Message,type=error.GetType().FullName}});return 2;}
    }
}
