using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Standalone observation experiment. No activation, input, hook, protection
// mutation, WGC, PrintWindow, full-screen bitmap or production service entry.
public static class DesktopScreenRegionProbe {
    public const string Source="screen-region-gdi-prototype";
    public const uint RasterOperation=0x40CC0020; // SRCCOPY | CAPTUREBLT: include layered overlays.
    public sealed class Box {
        public int x,y,width,height;
        public bool Valid {get{return width>0 && height>0 && (long)x+width<=Int32.MaxValue && (long)y+height<=Int32.MaxValue;}}
    }
    public sealed class Monitor {
        public string handle,device; public Box bounds; public uint flags;
    }
    public sealed class Snapshot {
        public string hwnd,foreground,startedUtcTicks,title,className;
        public int pid; public bool identity,interactive,physicalPixels,visible,minimized;
        public bool? cloaked,compositionEnabled;
        public uint? dpi,displayAffinity,exStyle; public int? displayAffinityError,exStyleError;
        public Box window,client; public Monitor[] monitors;
        public string[] gaps;
        public bool? layered {get{return exStyle.HasValue?(bool?)((exStyle.Value&0x80000)!=0):null;}}
        public string protectionStatus {get{return displayAffinity.HasValue?(displayAffinity.Value==0?"none":"protected"):"unknown";}}
    }
    public sealed class Token {
        public int rid; public bool elevated,uiAccess;
    }
    public sealed class Manifest {
        public string nonce,hwnd,startedUtcTicks,executable,sha256,title;
        public int pid;
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MonitorInfo {
        public int size; public Rect monitor,work; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
    }
    delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr state);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetClientRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll",SetLastError=true)] static extern bool ClientToScreen(IntPtr window,ref Point point);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr window,int index);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowDisplayAffinity(IntPtr window,out uint affinity);
    [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out int value,int size);
    [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
    [DllImport("gdi32.dll",SetLastError=true)] static extern bool BitBlt(IntPtr dest,int x,int y,int width,int height,IntPtr source,int sourceX,int sourceY,uint operation);
    [DllImport("gdi32.dll")] static extern int GetMapMode(IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetLayout(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool GetViewportOrgEx(IntPtr dc,out Point point);
    [DllImport("gdi32.dll")] static extern bool GetWindowOrgEx(IntPtr dc,out Point point);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr value,int index,StringBuilder text,int size,out int needed);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=1024*1024};
    public static bool Contains(Box outer,Box inner){return outer!=null && inner!=null && outer.Valid && inner.Valid && inner.x>=outer.x && inner.y>=outer.y && (long)inner.x+inner.width<=(long)outer.x+outer.width && (long)inner.y+inner.height<=(long)outer.y+outer.height;}
    public static bool SameBox(Box a,Box b){return a!=null && b!=null && a.x==b.x && a.y==b.y && a.width==b.width && a.height==b.height;}
    static string Topology(Monitor[] monitors){return monitors==null?null:String.Join("|",monitors.Select(m=>m.handle+":"+m.device+":"+m.flags+":"+Json.Serialize(m.bounds)).OrderBy(x=>x,StringComparer.Ordinal));}
    public static string[] Eligibility(Snapshot s){
        var reasons=new List<string>();
        if(s==null)return new[]{"state_unavailable"};
        if(!s.identity)reasons.Add("identity_changed");
        if(!s.interactive)reasons.Add("interactive_desktop_unavailable");
        if(!s.physicalPixels)reasons.Add("physical_coordinates_unavailable");
        if(!s.visible || s.minimized || s.cloaked!=false)reasons.Add("window_not_visible_or_unknown");
        if(s.compositionEnabled!=true)reasons.Add("composition_unavailable_or_unknown");
        if(!s.displayAffinity.HasValue)reasons.Add("protection_unknown");
        else if(s.displayAffinity.Value!=0)reasons.Add("capture_protected");
        if(s.hwnd!=s.foreground)reasons.Add("foreground_required");
        if(!s.dpi.HasValue || !s.exStyle.HasValue)reasons.Add("window_state_unknown");
        if(!Contains(s.window,s.client) || s.client.width>1600 || s.client.height>1600 || (long)s.client.width*s.client.height>2560000)reasons.Add("client_geometry_unsupported");
        if(s.monitors==null || s.monitors.Length==0 || s.monitors.Count(m=>Contains(m.bounds,s.client))!=1)reasons.Add("single_display_required");
        if(s.gaps!=null && s.gaps.Length>0)reasons.Add("snapshot_incomplete");
        return reasons.ToArray();
    }
    public static bool SameSnapshot(Snapshot a,Snapshot b){
        return a!=null && b!=null && a.identity && b.identity && a.pid==b.pid && a.hwnd==b.hwnd && a.startedUtcTicks==b.startedUtcTicks && a.foreground==b.foreground &&
            a.interactive==b.interactive && a.physicalPixels==b.physicalPixels && a.visible==b.visible && a.minimized==b.minimized && a.cloaked==b.cloaked &&
            a.compositionEnabled==b.compositionEnabled && a.dpi==b.dpi && a.displayAffinity==b.displayAffinity && a.displayAffinityError==b.displayAffinityError &&
            a.exStyle==b.exStyle && SameBox(a.window,b.window) && SameBox(a.client,b.client) && Topology(a.monitors)==Topology(b.monitors);
    }
    public static Box RelativeClient(Snapshot s){if(!Contains(s.window,s.client))throw new ArgumentException("Client is outside window");return new Box{x=s.client.x-s.window.x,y=s.client.y-s.window.y,width=s.client.width,height=s.client.height};}
    public static void ValidateManifest(Manifest m,string nonce){
        long hwnd,ticks;
        if(m==null || nonce==null || nonce.Length!=32 || !nonce.All(c=>c>='0'&&c<='9'||c>='a'&&c<='f') || m.nonce!=nonce || m.pid<=0 ||
            !Int64.TryParse(m.hwnd,out hwnd) || hwnd<=0 || !Int64.TryParse(m.startedUtcTicks,out ticks) || ticks<=0 ||
            m.title!="ProfilePilot screen region "+nonce || String.IsNullOrEmpty(m.executable) || !Path.IsPathRooted(m.executable) ||
            m.sha256==null || m.sha256.Length!=64 || !m.sha256.All(c=>c>='0'&&c<='9'||c>='a'&&c<='f'))throw new ArgumentException("Invalid owned manifest");
    }
    static IntPtr Information(IntPtr token,int kind){
        int needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);if(needed<=0 || needed>65536)throw new InvalidOperationException("Token size unavailable");
        IntPtr data=Marshal.AllocHGlobal(needed);if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new System.ComponentModel.Win32Exception();}return data;
    }
    static int TokenNumber(IntPtr token,int kind){IntPtr data=Information(token,kind);try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
    static Token ReadToken(Process process){
        IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new System.ComponentModel.Win32Exception();
        try{IntPtr data=Information(token,25);int rid;try{IntPtr sid=Marshal.ReadIntPtr(data);byte n=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(n==0)throw new Exception("Empty integrity SID");rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(n-1)));}finally{Marshal.FreeHGlobal(data);}return new Token{rid=rid,elevated=TokenNumber(token,20)!=0,uiAccess=TokenNumber(token,26)!=0};}finally{CloseHandle(token);}
    }
    static void RequireMedium(Token token){if(token.rid!=8192 || token.elevated || token.uiAccess)throw new InvalidOperationException("Medium non-elevated non-UIAccess token required");}
    static string Hash(byte[] bytes){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
    static string FileHash(string file){using(var hash=SHA256.Create())using(var stream=File.Open(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
    static bool Interactive(){
        IntPtr desktop=OpenInputDesktop(0,false,0x100);if(desktop==IntPtr.Zero)return false;
        try{var name=new StringBuilder(256);int needed;return GetUserObjectInformation(desktop,2,name,512,out needed)&&String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);}finally{CloseDesktop(desktop);}
    }
    static Box BoxOf(Rect r){return new Box{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
    static Snapshot ReadSnapshot(Manifest m,Process process,bool physical){
        IntPtr hwnd=new IntPtr(Int64.Parse(m.hwnd));var gaps=new List<string>();
        var s=new Snapshot{pid=m.pid,hwnd=m.hwnd,startedUtcTicks=m.startedUtcTicks,physicalPixels=physical,foreground=GetForegroundWindow().ToInt64().ToString(),interactive=Interactive()};
        uint pid;GetWindowThreadProcessId(hwnd,out pid);var title=new StringBuilder(256);GetWindowText(hwnd,title,title.Capacity);s.title=title.ToString();
        var name=new StringBuilder(256);GetClassName(hwnd,name,name.Capacity);s.className=name.ToString();
        s.identity=IsWindow(hwnd)&&pid==m.pid&&!process.HasExited&&process.StartTime.ToUniversalTime().Ticks.ToString()==m.startedUtcTicks&&s.title==m.title;
        s.visible=IsWindowVisible(hwnd);s.minimized=IsIconic(hwnd);
        int cloak;if(DwmGetWindowAttribute(hwnd,14,out cloak,4)==0)s.cloaked=cloak!=0;else gaps.Add("cloaked_unknown");
        bool composition;if(DwmIsCompositionEnabled(out composition)==0)s.compositionEnabled=composition;else gaps.Add("composition_unknown");
        Rect window,client;Point origin=new Point();
        if(GetWindowRect(hwnd,out window))s.window=BoxOf(window);else gaps.Add("window_geometry_unknown");
        if(GetClientRect(hwnd,out client)&&ClientToScreen(hwnd,ref origin))s.client=new Box{x=origin.X,y=origin.Y,width=client.Right-client.Left,height=client.Bottom-client.Top};else gaps.Add("client_geometry_unknown");
        try{uint dpi=GetDpiForWindow(hwnd);if(dpi>0)s.dpi=dpi;}catch(EntryPointNotFoundException){}
        SetLastError(0);long style=GetWindowLongPtr(hwnd,-20).ToInt64();int styleError=Marshal.GetLastWin32Error();if(style!=0||styleError==0)s.exStyle=unchecked((uint)style);else s.exStyleError=styleError;
        uint affinity;SetLastError(0);if(GetWindowDisplayAffinity(hwnd,out affinity))s.displayAffinity=affinity;else s.displayAffinityError=Marshal.GetLastWin32Error();
        var monitors=new List<Monitor>();
        MonitorCallback callback=delegate(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr state){
            var info=new MonitorInfo{size=Marshal.SizeOf(typeof(MonitorInfo))};
            if(!GetMonitorInfo(monitor,ref info)){gaps.Add("monitor_info_unknown");return false;}
            monitors.Add(new Monitor{handle=monitor.ToInt64().ToString(),device=info.device,bounds=BoxOf(info.monitor),flags=info.flags});return true;
        };
        if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero))gaps.Add("monitor_enumeration_incomplete");
        s.monitors=monitors.OrderBy(x=>x.device,StringComparer.Ordinal).ToArray();s.gaps=gaps.ToArray();return s;
    }
    static void Gate(string file){
        if(!File.Exists(file))return;
        var gate=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));object value;DateTimeOffset notBefore;
        if(!gate.TryGetValue("notBefore",out value)||!DateTimeOffset.TryParse(Convert.ToString(value),out notBefore))throw new Exception("Invalid acceptance gate");
        if(DateTimeOffset.UtcNow<notBefore)throw new Exception("DESKTOP_ACCEPTANCE_DEFERRED");
    }
    static bool PixelDC(IntPtr dc){Point viewport,window;return GetMapMode(dc)==1 && GetLayout(dc)==0 && GetViewportOrgEx(dc,out viewport)&&GetWindowOrgEx(dc,out window)&&viewport.X==0&&viewport.Y==0&&window.X==0&&window.Y==0;}
    static object Inspect(byte[] encoded){
        using(var stream=new MemoryStream(encoded))using(var bitmap=new Bitmap(stream)){
            int[][] colors={new[]{33,160,80},new[]{34,119,187},new[]{215,50,70}};
            var markers=colors.Select(rgb=>{int count=0;long xsum=0,ysum=0;for(int y=0;y<bitmap.Height;y++)for(int x=0;x<bitmap.Width;x++){Color c=bitmap.GetPixel(x,y);if(Math.Abs(c.R-rgb[0])<=20&&Math.Abs(c.G-rgb[1])<=20&&Math.Abs(c.B-rgb[2])<=20){count++;xsum+=x;ysum+=y;}}return new{rgb,count,x=count==0?-1:(double)xsum/count,y=count==0?-1:(double)ysum/count};}).ToArray();
            int coverCount=0;long coverX=0,coverY=0;
            for(int y=0;y<bitmap.Height;y++)for(int x=0;x<bitmap.Width;x++){Color c=bitmap.GetPixel(x,y);if(Math.Abs(c.R-32)<=5&&Math.Abs(c.G-32)<=5&&Math.Abs(c.B-32)<=5){coverCount++;coverX+=x;coverY+=y;}}
            return new{width=bitmap.Width,height=bitmap.Height,format=bitmap.RawFormat.Guid.ToString(),markers,cover=new{count=coverCount,x=coverCount==0?-1:(double)coverX/coverCount,y=coverCount==0?-1:(double)coverY/coverCount}};
        }
    }
    static Dictionary<string,object> Execute(string mode,string gate,string manifestFile,string nonce,string output){
        Gate(gate);var m=Json.Deserialize<Manifest>(File.ReadAllText(manifestFile));ValidateManifest(m,nonce);
        if(!String.Equals(Path.GetDirectoryName(Path.GetFullPath(output)),Path.GetDirectoryName(Path.GetFullPath(manifestFile)),StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Output must stay in the owned manifest directory");
        using(var self=Process.GetCurrentProcess())using(var target=Process.GetProcessById(m.pid)){
            // Pin the process object before birth/path checks; keep it open through capture.
            IntPtr pinned=target.Handle;Token selfToken=ReadToken(self),targetToken=ReadToken(target);RequireMedium(selfToken);RequireMedium(targetToken);
            using(var parent=new ManagementObject("Win32_Process.Handle='"+self.Id+"'")){parent.Get();if(Convert.ToInt32(parent["ParentProcessId"])!=m.pid)throw new Exception("Probe must be spawned by its owned fixture");}
            if(self.SessionId!=target.SessionId)throw new Exception("Owned fixture session mismatch");
            var ownIdentity=new{nonce,pid=self.Id,parentPid=m.pid,startedUtcTicks=self.StartTime.ToUniversalTime().Ticks.ToString(),executable=self.MainModule.FileName,sha256=FileHash(self.MainModule.FileName),integrityRid=selfToken.rid,elevated=selfToken.elevated,uiAccess=selfToken.uiAccess};
            using(var receipt=new StreamWriter(new FileStream(output+".identity.json",FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false)))receipt.Write(Json.Serialize(ownIdentity));
            if(target.StartTime.ToUniversalTime().Ticks.ToString()!=m.startedUtcTicks || !String.Equals(Path.GetFullPath(target.MainModule.FileName),Path.GetFullPath(m.executable),StringComparison.OrdinalIgnoreCase)||FileHash(m.executable)!=m.sha256)throw new Exception("Owned process identity changed");
            IntPtr previous=IntPtr.Zero;try{previous=SetThreadDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
            try{
                var before=ReadSnapshot(m,target,previous!=IntPtr.Zero);string[] reasons=Eligibility(before);
                var result=new Dictionary<string,object>{{"ok",true},{"nonce",nonce},{"source",Source},{"coordinateInputAvailable",false},{"captureAttempted",false},{"probePid",self.Id},{"probeStartedUtcTicks",self.StartTime.ToUniversalTime().Ticks.ToString()},{"probeToken",selfToken},{"targetToken",targetToken},{"before",before},{"eligibility",new{allowed=reasons.Length==0,reasons}},
                    {"limitations",new[]{"Capturable screen composition may contain overlays; this is not a target-only window image.","Pre/post checks are not atomic with display composition and cannot exclude transient changes.","Only one fully containing monitor is supported; HDR, mirrored displays and arbitrary accelerated content are not qualified.","No pointer or keyboard input is authorized by this image; no protection/style/foreground changes are attempted."}}};
                if(mode=="--diagnose"){result["status"]="diagnosed";result["after"]=ReadSnapshot(m,target,previous!=IntPtr.Zero);return result;}
                if(reasons.Length!=0){result["status"]="not_captured";result["after"]=ReadSnapshot(m,target,previous!=IntPtr.Zero);return result;}
                Gate(gate);
                using(var bitmap=new Bitmap(before.client.width,before.client.height,PixelFormat.Format32bppRgb)){
                    IntPtr screen=GetDC(IntPtr.Zero);if(screen==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();
                    try{using(var graphics=Graphics.FromImage(bitmap)){IntPtr dest=graphics.GetHdc();try{
                        if(!PixelDC(screen)||!PixelDC(dest))throw new Exception("Non-pixel DC mapping is unsupported");
                        // Last checkpoint before the one bounded screen read. No full-screen allocation/crop.
                        var immediate=ReadSnapshot(m,target,previous!=IntPtr.Zero);
                        if(!SameSnapshot(before,immediate)||Eligibility(immediate).Length!=0){result["status"]="state_changed";result["after"]=immediate;return result;}
                        result["captureAttempted"]=true;result["rasterOperation"]=new{value=RasterOperation,names="SRCCOPY|CAPTUREBLT",layeredOverlays="included where supported by Windows capture"};
                        if(!BitBlt(dest,0,0,before.client.width,before.client.height,screen,before.client.x,before.client.y,RasterOperation))throw new System.ComponentModel.Win32Exception();
                    }finally{graphics.ReleaseHdc(dest);}}}finally{ReleaseDC(IntPtr.Zero,screen);}
                    byte[] png;using(var bytes=new MemoryStream()){bitmap.Save(bytes,ImageFormat.Png);png=bytes.ToArray();}
                    var after=ReadSnapshot(m,target,previous!=IntPtr.Zero);result["after"]=after;
                    if(!SameSnapshot(before,after)||Eligibility(after).Length!=0){result["status"]="state_changed";return result;}
                    Gate(gate);string image=output+".png";using(var file=new FileStream(image,FileMode.CreateNew,FileAccess.Write,FileShare.Read))file.Write(png,0,png.Length);
                    result["status"]="captured";result["sourceScreenRect"]=before.client;result["captureRect"]=RelativeClient(before);
                    result["image"]=new{path=image,mimeType="image/png",width=before.client.width,height=before.client.height,byteLength=png.Length,sha256=Hash(png),source=Source,coordinateInputAvailable=false};result["decoded"]=Inspect(png);return result;
                }
            }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
        }
    }
    public static int Main(string[] args){
        Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length!=5 || (args[0]!="--diagnose"&&args[0]!="--capture")){Console.Error.WriteLine("Expected --diagnose|--capture GATE MANIFEST NONCE NEW_RESULT");return 2;}
        var watchdog=new Thread(()=>{Thread.Sleep(12000);Environment.Exit(124);});watchdog.IsBackground=true;watchdog.Start();
        object result;int code=0;
        try{result=Execute(args[0],args[1],args[2],args[3],args[4]);}
        catch(Exception error){result=new{ok=false,nonce=args[3],source=Source,coordinateInputAvailable=false,captureAttempted=(bool?)null,status="probe_failed",error=new{type=error.GetType().FullName,message=error.Message,win32Error=error is System.ComponentModel.Win32Exception?(int?)((System.ComponentModel.Win32Exception)error).NativeErrorCode:null}};code=2;}
        try{using(var file=new StreamWriter(new FileStream(args[4],FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false)))file.Write(Json.Serialize(result));}
        catch(Exception error){Console.Error.WriteLine(error.Message);return 2;}return code;
    }
}
