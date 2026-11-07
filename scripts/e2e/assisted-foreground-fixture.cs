using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Acceptance-only diagnostics. No titles, text, process paths, global enumeration
// or window mutation; callers supply the few handles already under inspection.
public static class AssistedWindowDiagnostics {
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",ExactSpelling=true,SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("kernel32.dll",EntryPoint="SetLastError",ExactSpelling=true)] static extern void ClearLastError(uint error);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint relation);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint relation);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    public static bool TopMost(ulong style){return (style&0x8UL)!=0;}
    public static bool NoActivate(ulong style){return (style&0x08000000UL)!=0;}
    static string Handle(IntPtr value){return value.ToInt64().ToString();}
    public static object Snapshot(IntPtr hwnd){
        bool exists=hwnd!=IntPtr.Zero && IsWindow(hwnd);
        if(!exists)return new{hwnd=Handle(hwnd),exists=false};
        uint pid;uint thread=GetWindowThreadProcessId(hwnd,out pid);
        ClearLastError(0);IntPtr value=GetWindowLongPtr(hwnd,-20);int error=Marshal.GetLastWin32Error();
        bool available=value!=IntPtr.Zero || error==0;ulong style=unchecked((ulong)value.ToInt64());
        return new{hwnd=Handle(hwnd),exists=true,pid,threadId=thread,visible=IsWindowVisible(hwnd),enabled=IsWindowEnabled(hwnd),
            exStyleAvailable=available,exStyleError=available?0:error,exStyleHex=available?((uint)style).ToString("x8"):null,
            topMost=available?(bool?)TopMost(style):null,noActivate=available?(bool?)NoActivate(style):null,
            transparent=available?(bool?)((style&0x20UL)!=0):null,layered=available?(bool?)((style&0x80000UL)!=0):null,
            ownerHwnd=Handle(GetWindow(hwnd,4)),rootHwnd=Handle(GetAncestor(hwnd,2)),rootOwnerHwnd=Handle(GetAncestor(hwnd,3)),
            previousInZOrder=Handle(GetWindow(hwnd,3)),nextInZOrder=Handle(GetWindow(hwnd,2)),firstInZOrderGroup=Handle(GetWindow(hwnd,0))};
    }
}

// Correlates only an owned fixture's WM_* receipt with predetermined test values.
// This compatibility mapping is never used to classify low-level hook input.
public static class OwnedWindowMessageMarker {
    public static void ValidateCandidates(ulong[] candidates){
        var lowWords=new HashSet<uint>();
        if(candidates==null || candidates.Length==0)throw new ArgumentException("Missing test markers.");
        foreach(ulong value in candidates)if((uint)value==0 || !lowWords.Add((uint)value))throw new ArgumentException("Test marker low words must be distinct and nonzero.");
    }
    public static string Match(ulong actual,ulong expected){
        if(actual==expected && expected!=0)return "exact64";
        return (uint)expected!=0 && actual==(ulong)(uint)expected?"zero-extended-low32":null;
    }
}

// Pure, bounded diagnostics for this owned pad only. Never records keys, text,
// coordinates, or events from any other window. Exact marker matching is separate.
public sealed class AssistedUnmatchedMarkers {
    public sealed class Record { public string kind,marker;public long count; }
    readonly List<Record> records=new List<Record>();
    public long OverflowEvents {get;private set;}
    public void Add(int message,string marker){
        if((message!=0x201 && message!=0x202) || !Regex.IsMatch(marker??"","^[a-f0-9]{16}$"))throw new ArgumentException("Invalid owned pad marker evidence.");
        string kind=message==0x201?"left_down":"left_up";
        foreach(var value in records)if(value.kind==kind && value.marker==marker){value.count++;return;}
        if(records.Count==8){OverflowEvents++;return;}
        records.Add(new Record{kind=kind,marker=marker,count=1});
    }
    public Record[] Snapshot(){return records.ToArray();}
}

// Included only in owned acceptance fixtures. The pad has no business action,
// text entry, selection or application input-marker collection.
public sealed class AssistedForegroundFixture : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
    [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int cx,int cy,uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetMessageExtraInfo();
    sealed class Request { public string nonce=null,marker=null;public long expiresAt=0; }
    sealed class Pad : Control {
        readonly AssistedForegroundFixture owner;
        public Pad(AssistedForegroundFixture owner){this.owner=owner;TabStop=false;BackColor=Color.FromArgb(225,234,242);AccessibleName="Assisted foreground preparation pad";SetStyle(ControlStyles.Selectable,false);}
        protected override void WndProc(ref Message message){
            if(message.Msg==0x201 || message.Msg==0x202)owner.Receive(message.Msg,unchecked((ulong)GetMessageExtraInfo().ToInt64()).ToString("x16"));
            base.WndProc(ref message);
        }
    }
    readonly Form form;readonly string file;readonly Timer timer;readonly Pad pad;
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly AssistedUnmatchedMarkers unmatchedMarkers=new AssistedUnmatchedMarkers();
    Request request;bool seen,raised,restored,disposed;int down,up,unmatched;
    static long Now(){return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;}
    static int[] Bounds(Rect r){return new[]{r.left,r.top,r.right-r.left,r.bottom-r.top};}
    void Save(string suffix,object value){File.WriteAllText(file+suffix,json.Serialize(value),new UTF8Encoding(false));}
    public AssistedForegroundFixture(Form form,string fileBase,bool enabled){
        this.form=form;file=Path.GetFullPath(fileBase);
        if(!enabled)return;
        if(form.TopMost)throw new InvalidOperationException("Assisted fixture must initially be non-topmost.");
        pad=new Pad(this){Left=24,Top=form.ClientSize.Height-26,Width=Math.Min(280,form.ClientSize.Width-48),Height=20,Visible=false};
        form.Controls.Add(pad);
        timer=new Timer{Interval=20};timer.Tick+=(s,e)=>Tick();
        form.Shown+=(s,e)=>timer.Start();form.FormClosed+=(s,e)=>Dispose();
    }
    void Receive(int message,string marker){
        if(request==null || restored)return;
        if(marker!=request.marker){unmatched++;unmatchedMarkers.Add(message,marker);return;}
        if(message==0x201)down++;else up++;
    }
    void Restore(){
        if(restored)return;
        restored=!raised || SetWindowPos(form.Handle,new IntPtr(-2),0,0,0,0,0x0013); // NOMOVE|NOSIZE|NOACTIVATE
        if(restored)pad.Visible=false;
    }
    void Receipt(string reason){
        Save(".foreground.receipt.json",new{version=1,nonce=request.nonce,marker=request.marker,downCount=down,upCount=up,unmatchedEvents=unmatched,
            messageExtraInfoPointerBits=IntPtr.Size*8,markerBits=32,markerEvidence="owned-window-message-extra-info",lowLevelHookEvidence=false,
            unmatchedMarkers=unmatchedMarkers.Snapshot(),unmatchedMarkerOverflowEvents=unmatchedMarkers.OverflowEvents,
            topMostRestored=restored,reason,foregroundHwnd=GetForegroundWindow().ToInt64().ToString(),targetWasForeground=GetForegroundWindow()==form.Handle,
            windowEvidence=WindowEvidence()});
    }
    object WindowEvidence(){
        var owned=form.OwnedForms;
        return new{capturedAt=Now(),managedTopMost=form.TopMost,target=AssistedWindowDiagnostics.Snapshot(form.IsHandleCreated?form.Handle:IntPtr.Zero),pad=AssistedWindowDiagnostics.Snapshot(pad.IsHandleCreated?pad.Handle:IntPtr.Zero),
            ownedWindows=owned.Take(8).Select(value=>new{managedTopMost=value.TopMost,handleCreated=value.IsHandleCreated,
                native=value.IsHandleCreated?AssistedWindowDiagnostics.Snapshot(value.Handle):null}).ToArray(),ownedWindowsTruncated=owned.Length>8};
    }
    void Tick(){
        try {
            if(request!=null){
                if(up>0 || Now()>=request.expiresAt || File.Exists(file+".foreground.done")){
                    Restore();Receipt(up>0?"click_received":"preparation_ended");if(restored)timer.Stop();
                }
                return;
            }
            if(seen || !File.Exists(file+".foreground.request.json"))return;
            Request value;
            try{value=json.Deserialize<Request>(File.ReadAllText(file+".foreground.request.json"));}catch(ArgumentException){return;}
            seen=true;
            long now=Now();
            if(value==null || !Regex.IsMatch(value.nonce??"","^[a-f0-9]{32}$") || !Regex.IsMatch(value.marker??"","^00000000[a-f0-9]{8}$") ||
                value.marker=="0000000000000000" || value.expiresAt<=now || value.expiresAt-now>10000)throw new InvalidOperationException("ASSISTED_REQUEST_INVALID");
            request=value;
            pad.Visible=true;pad.BringToFront();
            if(pad.Width<40 || pad.Height<16 || pad.Bottom>form.ClientSize.Height || pad.Right>form.ClientSize.Width)throw new InvalidOperationException("ASSISTED_PAD_OUTSIDE_CLIENT");
            object beforeRaise=WindowEvidence();
            raised=SetWindowPos(form.Handle,new IntPtr(-1),0,0,0,0,0x0013);
            if(!raised)throw new InvalidOperationException("ASSISTED_TOPMOST_FAILED");
            Rect window=new Rect(),client=new Rect(),padRect=new Rect();Point origin=new Point();
            if(!GetWindowRect(form.Handle,out window) || !GetClientRect(form.Handle,out client) || !ClientToScreen(form.Handle,ref origin) ||
                !GetWindowRect(pad.Handle,out padRect))throw new InvalidOperationException("ASSISTED_GEOMETRY_FAILED");
            using(var process=Process.GetCurrentProcess())Save(".foreground.manifest.json",new{version=1,pid=process.Id,
                executable=process.MainModule.FileName,startedUtcTicks=process.StartTime.ToUniversalTime().Ticks.ToString(),
                hwnd=form.Handle.ToInt64().ToString(),padHwnd=pad.Handle.ToInt64().ToString(),nonce=request.nonce,marker=request.marker,
                capturedAt=now,expiresAt=request.expiresAt,dpi=GetDpiForWindow(form.Handle),windowBounds=Bounds(window),
                clientBounds=new[]{origin.x,origin.y,client.right-client.left,client.bottom-client.top},padBounds=Bounds(padRect),
                virtualBounds=new[]{GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79)},
                windowEvidence=new{beforeRaise,afterRaise=WindowEvidence(),raiseReturnedSuccess=raised,raiseFlags="SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE"}});
        }catch{
            if(request!=null){Restore();Receipt("preparation_failed");}if(request==null || restored)timer.Stop();
        }
    }
    public void Dispose(){if(disposed)return;disposed=true;if(timer==null)return;timer.Stop();if(request!=null){Restore();Receipt("fixture_closed");}timer.Dispose();}
}
