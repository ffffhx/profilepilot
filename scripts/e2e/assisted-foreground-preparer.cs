using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

// Acceptance setup only. Inherits the runner token; contains no elevation,
// foreground API, AttachThreadInput, Alt key or global foreground setting.
public static class AssistedForegroundPreparer {
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
    [StructLayout(LayoutKind.Sequential)] struct Gui {public uint size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public Rect caretRect;}
    [StructLayout(LayoutKind.Sequential)] struct Mouse {public int x,y;public uint data,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Explicit)] struct Union {[FieldOffset(0)]public Mouse mouse;}
    [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Union data;}
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point,uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool GetClipCursor(out Rect rect);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref Gui gui);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,uint length,out uint needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int information,IntPtr value,int length,out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int length);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static readonly Dictionary<string,object> Report=new Dictionary<string,object>();
    static readonly List<object> Sends=new List<object>();
    static readonly List<object> WindowEvidence=new List<object>();
    sealed class Receipt {public string nonce,marker,foregroundHwnd;public int downCount,upCount,unmatchedEvents,messageExtraInfoPointerBits;public long unmatchedMarkerOverflowEvents;public object[] unmatchedMarkers;public bool topMostRestored,targetWasForeground;}
    static AssistedExpected Expected;static AssistedManifest Manifest;static ulong Marker;static bool PathsVerified;
    static long Now(){return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;}
    static void Require(bool value,string code){AssistedForegroundPolicy.Require(value,code);}
    static int[] Bounds(Rect r){return new[]{r.left,r.top,r.right-r.left,r.bottom-r.top};}
    static int[] Virtual(){return new[]{GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79)};}
    static string Handle(IntPtr value){return value.ToInt64().ToString(CultureInfo.InvariantCulture);}
    static int Integrity(int pid){
        IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero,buffer=IntPtr.Zero;
        try {
            Require(process!=IntPtr.Zero && OpenProcessToken(process,8,out token),"ASSISTED_INTEGRITY_UNAVAILABLE");
            int needed;GetTokenInformation(token,25,IntPtr.Zero,0,out needed);Require(needed>0 && needed<=65536,"ASSISTED_INTEGRITY_UNAVAILABLE");
            buffer=Marshal.AllocHGlobal(needed);Require(GetTokenInformation(token,25,buffer,needed,out needed),"ASSISTED_INTEGRITY_UNAVAILABLE");
            IntPtr sid=Marshal.ReadIntPtr(buffer);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            Require(count>0,"ASSISTED_INTEGRITY_UNAVAILABLE");return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
        }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token);if(process!=IntPtr.Zero)CloseHandle(process);}
    }
    static bool SameDesktop(){
        IntPtr input=OpenInputDesktop(0,false,1);if(input==IntPtr.Zero)return false;
        try{uint needed;var a=new StringBuilder(512);var b=new StringBuilder(512);
            return GetUserObjectInformation(input,2,a,1024,out needed) && GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,b,1024,out needed) && a.ToString()==b.ToString();
        }finally{CloseDesktop(input);}
    }
    static void Save(string phase){Require(PathsVerified,"ASSISTED_DIRECTORY_NOT_OWNED");Report["phase"]=phase;Report["sendResults"]=Sends.ToArray();File.WriteAllText(Expected.fileBase+".foreground.preparer.json",Json.Serialize(Report),new UTF8Encoding(false));}
    static void SafeSave(string phase){try{Save(phase);}catch{Report["evidenceWriteFailed"]=true;}}
    static AssistedObserved Observe(){
        IntPtr hwnd=new IntPtr(Int64.Parse(Manifest.hwnd)),pad=new IntPtr(Int64.Parse(Manifest.padHwnd));
        uint pid,padPid,foregroundPid;uint thread=GetWindowThreadProcessId(hwnd,out pid);GetWindowThreadProcessId(pad,out padPid);
        IntPtr foreground=GetForegroundWindow();uint foregroundThread=GetWindowThreadProcessId(foreground,out foregroundPid);
        Require(pid==Expected.pid && padPid==pid && thread!=0 && foregroundThread!=0 && foregroundPid>0,"ASSISTED_WINDOW_CHANGED");
        var info=new Gui{size=(uint)Marshal.SizeOf(typeof(Gui))};var foregroundInfo=info;
        Require(GetGUIThreadInfo(thread,ref info) && GetGUIThreadInfo(foregroundThread,ref foregroundInfo),"ASSISTED_INPUT_STATE_UNAVAILABLE");
        Rect window=new Rect(),client=new Rect(),padRect=new Rect(),clip=new Rect();Point origin=new Point(),cursor=new Point();
        Require(GetWindowRect(hwnd,out window) && GetClientRect(hwnd,out client) && ClientToScreen(hwnd,ref origin) && GetWindowRect(pad,out padRect) &&
            GetCursorPos(out cursor) && GetClipCursor(out clip),"ASSISTED_GEOMETRY_UNAVAILABLE");
        int cloaked;Require(DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0,"ASSISTED_WINDOW_STATE_UNAVAILABLE");
        int[] point=AssistedForegroundPolicy.Point(Manifest),desktop=Virtual();var pixel=new Point{x=point[0],y=point[1]};
        Require(MonitorFromPoint(pixel,0)!=IntPtr.Zero,"ASSISTED_PAD_OFFSCREEN");IntPtr hit=WindowFromPoint(pixel);
        if(WindowEvidence.Count<4)WindowEvidence.Add(new{capturedAt=Now(),target=AssistedWindowDiagnostics.Snapshot(hwnd),pad=AssistedWindowDiagnostics.Snapshot(pad),
            pointWindow=AssistedWindowDiagnostics.Snapshot(hit),pointRoot=AssistedWindowDiagnostics.Snapshot(GetAncestor(hit,2)),foreground=AssistedWindowDiagnostics.Snapshot(foreground)});
        Report["windowEvidence"]=WindowEvidence.ToArray();
        int held=0;for(int key=1;key<=254;key++)if((GetAsyncKeyState(key)&0x8000)!=0)held++;
        using(var target=Process.GetProcessById(Expected.pid))return new AssistedObserved{
            pid=target.Id,executable=target.MainModule.FileName,startedUtcTicks=target.StartTime.ToUniversalTime().Ticks.ToString(),
            hwnd=Handle(hwnd),padHwnd=Handle(pad),pointRoot=Handle(GetAncestor(hit,2)),pointWindow=Handle(hit),dpi=(int)GetDpiForWindow(hwnd),
            sourceRid=Integrity(Process.GetCurrentProcess().Id),targetRid=Integrity(target.Id),foregroundRid=Integrity((int)foregroundPid),
            visible=IsWindowVisible(hwnd)&&IsWindowVisible(pad),enabled=IsWindowEnabled(hwnd)&&IsWindowEnabled(pad),minimized=IsIconic(hwnd),cloaked=cloaked!=0,
            pixelContext=AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4)) && AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hwnd),new IntPtr(-4)),
            sameDesktop=SameDesktop(),captureActive=AssistedForegroundPolicy.CaptureOrInteractiveMode(info.capture!=IntPtr.Zero || foregroundInfo.capture!=IntPtr.Zero,info.flags|foregroundInfo.flags),
            heldCount=held,clipUnrestricted=Bounds(clip).SequenceEqual(desktop),windowBounds=Bounds(window),
            clientBounds=new[]{origin.x,origin.y,client.right-client.left,client.bottom-client.top},padBounds=Bounds(padRect),virtualBounds=desktop,cursorX=cursor.x,cursorY=cursor.y};
    }
    static uint Send(string kind,int x=0,int y=0,uint flags=0){
        if(kind=="down")flags=2;else if(kind=="up")flags=4;
        SafeSave(kind+"_attempted");
        uint count=SendInput(1,new[]{new Input{type=0,data=new Union{mouse=new Mouse{x=x,y=y,flags=flags,extra=new UIntPtr(Marker)}}}},Marshal.SizeOf(typeof(Input)));
        Sends.Add(new{kind,count,lastError=Marshal.GetLastWin32Error()});SafeSave(kind+"_returned");return count;
    }
    static void ConfirmReceipt(){
        Receipt receipt=null;long deadline=Math.Min(Manifest.expiresAt,Now()+1500);
        while(Now()<deadline){
            try{string file=Expected.fileBase+".foreground.receipt.json";if(File.Exists(file)){Require(new FileInfo(file).Length<=16384,"ASSISTED_RECEIPT_TOO_LARGE");receipt=Json.Deserialize<Receipt>(File.ReadAllText(file));if(receipt!=null && receipt.nonce==Expected.nonce && receipt.topMostRestored)break;}}
            catch(ArgumentException){}catch(IOException){}
            Thread.Sleep(10);
        }
        Report["fixtureReceipt"]=receipt;
        Require(receipt!=null && receipt.nonce==Expected.nonce && receipt.marker==Expected.marker && receipt.downCount==1 && receipt.upCount==1 &&
            receipt.unmatchedEvents==0 && receipt.topMostRestored && receipt.targetWasForeground && receipt.foregroundHwnd==Manifest.hwnd,"ASSISTED_DELIVERY_NOT_CONFIRMED");
        Require(Handle(GetForegroundWindow())==Manifest.hwnd,"ASSISTED_FOREGROUND_NOT_CONFIRMED");
        uint pid;uint thread=GetWindowThreadProcessId(new IntPtr(Int64.Parse(Manifest.hwnd)),out pid);
        var gui=new Gui{size=(uint)Marshal.SizeOf(typeof(Gui))};Require(pid==Expected.pid && GetGUIThreadInfo(thread,ref gui),"ASSISTED_WINDOW_CHANGED");
        Require(!AssistedForegroundPolicy.CaptureOrInteractiveMode(gui.capture!=IntPtr.Zero,gui.flags),"ASSISTED_CAPTURE_ACTIVE");
        for(int key=1;key<=254;key++)Require((GetAsyncKeyState(key)&0x8000)==0,"ASSISTED_RELEASE_NOT_CONFIRMED");
        using(var process=Process.GetProcessById(Expected.pid))Require(process.StartTime.ToUniversalTime().Ticks.ToString()==Expected.startedUtcTicks,"ASSISTED_PROCESS_CHANGED");
        Require(!Report.ContainsKey("evidenceWriteFailed"),"ASSISTED_EVIDENCE_WRITE_FAILED");
        Report["releaseObserved"]=true;Report["foregroundConfirmed"]=true;
    }
    static void Paths(string expectedPath){
        string directory=Path.GetFullPath(Expected.directory),temp=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        Require(directory.StartsWith(temp,StringComparison.OrdinalIgnoreCase) && Path.GetDirectoryName(directory).TrimEnd(Path.DirectorySeparatorChar)==temp.TrimEnd(Path.DirectorySeparatorChar),"ASSISTED_DIRECTORY_NOT_OWNED");
        Require(Regex.IsMatch(Path.GetFileName(directory),"^(pp-desktop-|profilepilot-desktop-|pp-input-markers-)[A-Za-z0-9_-]+$") &&
            Path.GetDirectoryName(Path.GetFullPath(expectedPath))==directory && Path.GetDirectoryName(Path.GetFullPath(Expected.fileBase))==directory &&
            Path.GetDirectoryName(Path.GetFullPath(Expected.executable))==directory,"ASSISTED_DIRECTORY_NOT_OWNED");
        Require(new[]{"DesktopFixture.exe","DesktopKeyboardFixture.exe","InputMarkerFixture.exe"}.Contains(Path.GetFileName(Expected.executable)),"ASSISTED_EXECUTABLE_MISMATCH");
        foreach(string entry in new[]{directory,Expected.executable,expectedPath})Require((File.GetAttributes(entry)&FileAttributes.ReparsePoint)==0,"ASSISTED_REPARSE_POINT");
    }
    public static int Main(string[] args){
        if(args.Length==1 && args[0]=="--check"){Console.WriteLine("{\"ok\":true,\"mode\":\"check\",\"guiStarted\":false,\"inputAttempted\":false}");return 0;}
        if(args.Length!=2 || args[0]!="--prepare")throw new ArgumentException("Explicit test-only --prepare expected.json required.");
        bool ok=false;
        try {
            Require(new FileInfo(args[1]).Length<=16384,"ASSISTED_EXPECTATION_TOO_LARGE");Expected=Json.Deserialize<AssistedExpected>(File.ReadAllText(args[1]));Paths(args[1]);PathsVerified=true;
            Require(new FileInfo(Expected.fileBase+".foreground.manifest.json").Length<=16384,"ASSISTED_MANIFEST_TOO_LARGE");
            Manifest=Json.Deserialize<AssistedManifest>(File.ReadAllText(Expected.fileBase+".foreground.manifest.json"));
            Require(UInt64.TryParse(Expected.marker,NumberStyles.HexNumber,CultureInfo.InvariantCulture,out Marker) && Marker!=0 && Marker<=UInt32.MaxValue,"ASSISTED_TOKEN_MISMATCH");
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Report["assistedForeground"]=true;Report["productAutonomousActivationProven"]=false;Report["preparerPid"]=Process.GetCurrentProcess().Id;
            Report["preparerIntegrityRid"]=Integrity(Process.GetCurrentProcess().Id);Report["preparerPointerBits"]=IntPtr.Size*8;Report["targetPid"]=Expected.pid;Report["marker"]=Expected.marker;Report["nonce"]=Expected.nonce;
            Report["markerBits"]=32;Report["markerEvidence"]="owned-window-message-extra-info";Report["lowLevelHookEvidence"]=false;
            var initial=Observe();Report["preflight"]=initial;Save("preflight");
            var cleanup=AssistedForegroundPolicy.ClickOnce(
                ()=>AssistedForegroundPolicy.Validate(Expected,Manifest,Observe(),Now(),false),
                ()=>{int[] point=AssistedForegroundPolicy.Point(Manifest);var absolute=DesktopPointerCoordinates.Normalize(point[0],point[1],Manifest.virtualBounds[0],Manifest.virtualBounds[1],Manifest.virtualBounds[2],Manifest.virtualBounds[3]);Require(Send("move",absolute.X,absolute.Y,absolute.Flags)==1,"ASSISTED_MOVE_REJECTED");Thread.Sleep(30);},
                ()=>{Require(!Report.ContainsKey("evidenceWriteFailed"),"ASSISTED_EVIDENCE_WRITE_FAILED");AssistedForegroundPolicy.Validate(Expected,Manifest,Observe(),Now(),true);},kind=>Send(kind));
            Report["cleanup"]=cleanup;Save("click_inserted");ConfirmReceipt();ok=true;
        }catch(Exception error){Report["error"]=Regex.IsMatch(error.Message??"","^(ASSISTED|DESKTOP)_[A-Z_]+$")?error.Message:"ASSISTED_PREPARATION_FAILED";if(error.Data.Contains("cleanup"))Report["cleanup"]=Json.DeserializeObject((string)error.Data["cleanup"]);}
        Report["ok"]=ok;Report["assistedForeground"]=true;Report["productAutonomousActivationProven"]=false;
        if(PathsVerified)try{Save(ok?"confirmed":"failed");}catch{Report["evidenceWriteFailed"]=true;ok=false;Report["ok"]=false;}
        Console.WriteLine(Json.Serialize(Report));return ok?0:1;
    }
}
