using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

// Alternate Main: only pure policy/geometry methods; no desktop/PInvoke calls.
public static class DesktopScreenRegionTests {
    static readonly List<string> checks=new List<string>();
    static void Check(bool value,string name){if(!value)throw new Exception(name);checks.Add(name);}
    static DesktopScreenRegionProbe.Box Box(int x,int y,int width,int height){return new DesktopScreenRegionProbe.Box{x=x,y=y,width=width,height=height};}
    static DesktopScreenRegionProbe.Snapshot State(){return new DesktopScreenRegionProbe.Snapshot{
        pid=42,hwnd="123",foreground="123",startedUtcTicks="123456",identity=true,interactive=true,physicalPixels=true,visible=true,minimized=false,cloaked=false,
        compositionEnabled=true,dpi=120,displayAffinity=0,exStyle=0,window=Box(-1520,120,1016,540),client=Box(-1512,150,1000,500),gaps=new string[0],
        monitors=new[]{new DesktopScreenRegionProbe.Monitor{handle="1",device="DISPLAY1",bounds=Box(-1920,0,1920,1080)}}};}
    static bool Rejected(DesktopScreenRegionProbe.Snapshot value,string reason){return DesktopScreenRegionProbe.Eligibility(value).Contains(reason);}
    public static int Main(){try{
        Check(DesktopScreenRegionProbe.Eligibility(State()).Length==0,"known-zero nonlayered window is eligible without mutating its style");
        var s=State();s.displayAffinity=null;s.displayAffinityError=87;Check(Rejected(s,"protection_unknown"),"unknown affinity is not treated as WDA_NONE");
        s=State();s.displayAffinity=1;Check(Rejected(s,"capture_protected"),"WDA_MONITOR rejects capture");
        s=State();s.displayAffinity=17;Check(Rejected(s,"capture_protected"),"WDA_EXCLUDEFROMCAPTURE rejects capture");
        s=State();s.exStyle=0x80000;Check(s.layered==true&&DesktopScreenRegionProbe.Eligibility(s).Length==0,"layered flag is observed rather than required as a repair");
        s=State();s.foreground="456";Check(Rejected(s,"foreground_required"),"background target is rejected without activation");
        s=State();s.interactive=false;Check(Rejected(s,"interactive_desktop_unavailable"),"locked or unavailable input desktop rejects capture");
        s=State();s.physicalPixels=false;Check(Rejected(s,"physical_coordinates_unavailable"),"failed PMv2 setup rejects capture");
        s=State();s.identity=false;Check(Rejected(s,"identity_changed"),"changed process or window identity rejects capture");
        s=State();s.cloaked=null;Check(Rejected(s,"window_not_visible_or_unknown"),"unknown cloak state rejects capture");
        s=State();s.minimized=true;Check(Rejected(s,"window_not_visible_or_unknown"),"minimized target rejects capture");
        s=State();s.compositionEnabled=null;Check(Rejected(s,"composition_unavailable_or_unknown"),"unknown DWM state rejects capture");
        s=State();s.gaps=new[]{"monitor_info_unknown"};Check(Rejected(s,"snapshot_incomplete"),"partial topology never silently becomes complete");
        s=State();s.client=Box(-2000,150,1000,500);Check(Rejected(s,"client_geometry_unsupported")&&Rejected(s,"single_display_required"),"offscreen client is not clamped or cropped");
        s=State();s.client=Box(-1512,150,1601,500);Check(Rejected(s,"client_geometry_unsupported"),"capture pixel dimensions are bounded");
        s=State();s.client=null;Check(Rejected(s,"client_geometry_unsupported"),"missing geometry fails closed without null exception");
        var relative=DesktopScreenRegionProbe.RelativeClient(State());Check(relative.x==8&&relative.y==30&&relative.width==1000,"negative screen origin maps to positive window relative offset");
        s=State();s.monitors=new[]{new DesktopScreenRegionProbe.Monitor{handle="a",device="A",bounds=Box(-1920,0,1000,1080)},new DesktopScreenRegionProbe.Monitor{handle="b",device="B",bounds=Box(-920,0,1000,1080)}};Check(Rejected(s,"single_display_required"),"client spanning adjacent monitors is explicitly unsupported");
        var a=State();var b=State();b.monitors=new[]{new DesktopScreenRegionProbe.Monitor{handle="other",device="DISPLAY1",bounds=Box(-1920,0,1920,1080)}};Check(!DesktopScreenRegionProbe.SameSnapshot(a,b),"monitor identity change is not hidden by equal virtual bounds");
        b=State();b.client.x++;Check(!DesktopScreenRegionProbe.SameSnapshot(a,b),"client moves invalidate the sampled region");
        b=State();b.foreground="other";Check(!DesktopScreenRegionProbe.SameSnapshot(a,b),"foreground changes invalidate captured pixels");
        b=State();b.dpi=144;Check(!DesktopScreenRegionProbe.SameSnapshot(a,b),"DPI changes invalidate captured pixels");
        b=State();b.displayAffinity=null;b.displayAffinityError=5;Check(!DesktopScreenRegionProbe.SameSnapshot(a,b),"post-capture affinity failure invalidates the image");
        Check(!DesktopScreenRegionProbe.Contains(Box(Int32.MaxValue-1,0,10,5),Box(0,0,1,1)),"rectangle overflow cannot pass containment");
        string nonce=new string('a',32);var m=new DesktopScreenRegionProbe.Manifest{nonce=nonce,pid=42,hwnd="123",startedUtcTicks="123456",title="ProfilePilot screen region "+nonce,executable=@"C:\owned\electron.exe",sha256=new string('b',64)};
        DesktopScreenRegionProbe.ValidateManifest(m,nonce);Check(true,"self nonce and exact identity manifest accepted");
        bool failed=false;try{DesktopScreenRegionProbe.ValidateManifest(m,new string('c',32));}catch(ArgumentException){failed=true;}Check(failed,"foreign nonce rejected before any OS call");
        m.hwnd="0";failed=false;try{DesktopScreenRegionProbe.ValidateManifest(m,nonce);}catch(ArgumentException){failed=true;}Check(failed,"zero HWND rejected before any OS call");
        Check(DesktopScreenRegionProbe.RasterOperation==(0x00CC0020u|0x40000000u),"capture uses explicit SRCCOPY plus CAPTUREBLT");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,checks,noOSCalls=true}));return 0;
    }catch(Exception error){Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=false,error=error.Message,checks,noOSCalls=true}));return 1;}}
}
