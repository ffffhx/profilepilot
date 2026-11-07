using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

// Test-only policy. All observations and input callbacks are supplied by the
// caller; pure tests link this file without any P/Invoke implementation.
public sealed class AssistedExpected {
    public string directory,executable,fileBase,nonce,marker,startedUtcTicks,hwnd;
    public int pid;
}
public sealed class AssistedManifest {
    public int version,pid,dpi;
    public string executable,startedUtcTicks,hwnd,padHwnd,nonce,marker;
    public long capturedAt,expiresAt;
    public int[] windowBounds,clientBounds,padBounds,virtualBounds;
}
public sealed class AssistedObserved {
    public int pid,dpi,sourceRid,targetRid,foregroundRid,heldCount;
    public string executable,startedUtcTicks,hwnd,padHwnd,pointRoot,pointWindow;
    public bool visible,enabled,minimized,cloaked,pixelContext,sameDesktop,captureActive,clipUnrestricted;
    public int[] windowBounds,clientBounds,padBounds,virtualBounds;
    public int cursorX,cursorY;
}
public static class AssistedForegroundPolicy {
    public static bool CaptureOrInteractiveMode(bool captured,uint flags){return captured || (flags&0x1eu)!=0;}
    public static void Require(bool value,string code){if(!value)throw new InvalidOperationException(code);}
    static bool Equal(int[] a,int[] b){return a!=null && b!=null && a.Length==4 && b.Length==4 && a.SequenceEqual(b);}
    static bool Rect(int[] r){return r!=null && r.Length==4 && r[2]>0 && r[3]>0 && (long)r[0]+r[2]<=Int32.MaxValue && (long)r[1]+r[3]<=Int32.MaxValue;}
    public static int[] Point(AssistedManifest value){Require(Rect(value.padBounds),"ASSISTED_PAD_INVALID");return new[]{value.padBounds[0]+value.padBounds[2]/2,value.padBounds[1]+value.padBounds[3]/2};}
    public static void Validate(AssistedExpected expected,AssistedManifest manifest,AssistedObserved observed,long now,bool moved){
        Require(expected!=null && manifest!=null && observed!=null,"ASSISTED_EVIDENCE_MISSING");
        Require(manifest.version==1 && Regex.IsMatch(expected.nonce??"","^[a-f0-9]{32}$") &&
            Regex.IsMatch(expected.marker??"","^00000000[a-f0-9]{8}$") && expected.marker!="0000000000000000" &&
            manifest.nonce==expected.nonce && manifest.marker==expected.marker,"ASSISTED_TOKEN_MISMATCH");
        Require(manifest.capturedAt<=now && manifest.expiresAt>now && manifest.expiresAt-manifest.capturedAt>0 &&
            manifest.expiresAt-manifest.capturedAt<=10000,"ASSISTED_MANIFEST_EXPIRED");
        string executable=Path.GetFullPath(expected.executable),directory=Path.GetFullPath(expected.directory);
        Require(String.Equals(Path.GetDirectoryName(executable),directory,StringComparison.OrdinalIgnoreCase) &&
            String.Equals(Path.GetFullPath(manifest.executable),executable,StringComparison.OrdinalIgnoreCase) &&
            String.Equals(Path.GetFullPath(observed.executable),executable,StringComparison.OrdinalIgnoreCase),"ASSISTED_EXECUTABLE_MISMATCH");
        Require(expected.pid>0 && manifest.pid==expected.pid && observed.pid==expected.pid &&
            expected.startedUtcTicks==manifest.startedUtcTicks && observed.startedUtcTicks==expected.startedUtcTicks,"ASSISTED_PROCESS_CHANGED");
        long hwnd,pad;
        Require(Int64.TryParse(manifest.hwnd,out hwnd) && hwnd>0 && manifest.hwnd==expected.hwnd && Int64.TryParse(manifest.padHwnd,out pad) && pad>0 &&
            observed.hwnd==manifest.hwnd && observed.padHwnd==manifest.padHwnd,"ASSISTED_WINDOW_CHANGED");
        Require(observed.targetRid==8192 && observed.sourceRid>=8192 && observed.foregroundRid>0 &&
            observed.sourceRid>=observed.foregroundRid,"ASSISTED_INPUT_STATE_UNAVAILABLE");
        Require(observed.sameDesktop && observed.pixelContext && manifest.dpi>0 && observed.dpi==manifest.dpi,"ASSISTED_DPI_OR_DESKTOP_CHANGED");
        Require(observed.visible && observed.enabled && !observed.minimized && !observed.cloaked,"ASSISTED_WINDOW_UNAVAILABLE");
        Require(Rect(manifest.clientBounds) && Rect(manifest.padBounds) && manifest.padBounds[2]>=40 && manifest.padBounds[3]>=16 &&
            manifest.padBounds[0]>=manifest.clientBounds[0] && manifest.padBounds[1]>=manifest.clientBounds[1] &&
            (long)manifest.padBounds[0]+manifest.padBounds[2]<=(long)manifest.clientBounds[0]+manifest.clientBounds[2] &&
            (long)manifest.padBounds[1]+manifest.padBounds[3]<=(long)manifest.clientBounds[1]+manifest.clientBounds[3],"ASSISTED_PAD_OUTSIDE_CLIENT");
        Require(Equal(manifest.windowBounds,observed.windowBounds) && Equal(manifest.clientBounds,observed.clientBounds) &&
            Equal(manifest.padBounds,observed.padBounds) && Equal(manifest.virtualBounds,observed.virtualBounds),"ASSISTED_GEOMETRY_CHANGED");
        Require(observed.pointRoot==manifest.hwnd && observed.pointWindow==manifest.padHwnd,"ASSISTED_PAD_OBSCURED");
        Require(!observed.captureActive,"ASSISTED_CAPTURE_ACTIVE");
        Require(observed.heldCount==0,"ASSISTED_HELD_INPUT");
        Require(observed.clipUnrestricted,"ASSISTED_CURSOR_CLIPPED");
        int[] point=Point(manifest);
        DesktopPointerCoordinates.Normalize(point[0],point[1],manifest.virtualBounds[0],manifest.virtualBounds[1],manifest.virtualBounds[2],manifest.virtualBounds[3]);
        if(moved)Require(observed.cursorX==point[0] && observed.cursorY==point[1],"ASSISTED_CURSOR_NOT_CONFIRMED");
    }
    public static InputCleanupReport ClickOnce(Action validateBeforeMove,Action move,Action validateBeforeDown,Func<string,uint> send){
        var ledger=new InputDelivery<string>(send);Exception failure=null;
        try { validateBeforeMove();move();validateBeforeDown();ledger.Press("down","up",InputReleaseLabel.Mouse("left"));ledger.ReleaseLast(); }
        catch(Exception error){failure=error;}
        finally {failure=ledger.Cleanup(failure);}
        if(failure!=null){failure.Data["cleanup"]=new JavaScriptSerializer().Serialize(ledger.LastCleanup);throw failure;}
        return ledger.LastCleanup;
    }
}
