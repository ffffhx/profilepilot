using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

public static class DesktopAssistedForegroundTests {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static readonly List<string> Checks=new List<string>();
    static void Check(bool value,string name){if(!value)throw new Exception(name);Checks.Add(name);}
    static T Copy<T>(T value){return Json.Deserialize<T>(Json.Serialize(value));}
    public static int Main(){
        string popupNonce=new string('a',32),popupStart="638970000000000000";
        var popupRequest=new Dictionary<string,object>{{"nonce",popupNonce},{"pid",10},{"hwnd","100"},{"startedUtcTicks",popupStart}};
        var popupPreparation=new Dictionary<string,object>{{"nonce",popupNonce},{"topMostRestored",true},{"targetWasForeground",true},{"foregroundHwnd","100"},{"downCount",1},{"upCount",1},{"unmatchedEvents",0}};
        Check(DesktopFixture.AssistedPopupRequestMatches(popupRequest,popupPreparation,10,"100",popupStart),"owned popup creation requires matching preparation and process identity");
        foreach(var change in new[]{new KeyValuePair<string,object>("nonce",new string('b',32)),new KeyValuePair<string,object>("pid",11),new KeyValuePair<string,object>("hwnd","101"),new KeyValuePair<string,object>("startedUtcTicks","638970000000000001")}){
            var request=new Dictionary<string,object>(popupRequest);request[change.Key]=change.Value;
            Check(!DesktopFixture.AssistedPopupRequestMatches(request,popupPreparation,10,"100",popupStart),"popup request rejects changed "+change.Key);
        }
        foreach(var change in new[]{new KeyValuePair<string,object>("topMostRestored",false),new KeyValuePair<string,object>("targetWasForeground",false),new KeyValuePair<string,object>("foregroundHwnd","101"),new KeyValuePair<string,object>("downCount",0),new KeyValuePair<string,object>("upCount",0),new KeyValuePair<string,object>("unmatchedEvents",1)}){
            var preparation=new Dictionary<string,object>(popupPreparation);preparation[change.Key]=change.Value;
            Check(!DesktopFixture.AssistedPopupRequestMatches(popupRequest,preparation,10,"100",popupStart),"popup preparation rejects incomplete "+change.Key);
        }
        Check(AssistedWindowDiagnostics.TopMost(0x8UL) && !AssistedWindowDiagnostics.TopMost(0x08000080UL),"native topmost bit is independent of noactivate and toolwindow");
        Check(AssistedWindowDiagnostics.NoActivate(0x08000088UL) && !AssistedWindowDiagnostics.NoActivate(0x8UL),"native noactivate bit is decoded independently");
        var markers=new AssistedUnmatchedMarkers();
        markers.Add(0x201,"000000008d89dc37");markers.Add(0x201,"000000008d89dc37");markers.Add(0x202,"ffffffff8d89dc37");
        Check(markers.Snapshot().Length==2 && markers.Snapshot()[0].count==2 && markers.Snapshot()[1].kind=="left_up","actual marker bits and message kind are aggregated without low-word matching");
        Check(markers.Snapshot()[0].marker=="000000008d89dc37" && markers.Snapshot()[1].marker=="ffffffff8d89dc37","zero extension and sign extension remain distinguishable");
        for(int index=0;index<8;index++)markers.Add(0x201,((ulong)index).ToString("x16"));
        Check(markers.Snapshot().Length==8 && markers.OverflowEvents==2,"unmatched marker diagnostics are capped at eight kind-marker pairs");
        markers.Add(0x201,"000000008d89dc37");Check(markers.Snapshot()[0].count==3 && markers.OverflowEvents==2,"retained aggregates still count after the cap");
        bool refusedMarker=false;try{markers.Add(0x100,"private input");}catch(ArgumentException){refusedMarker=true;}
        Check(refusedMarker,"collector rejects keyboard events and arbitrary text");
        const ulong testMarker=0xa11234567890cdefUL;
        Check(OwnedWindowMessageMarker.Match(testMarker,testMarker)=="exact64","owned WM correlation records exact full marker match");
        Check(OwnedWindowMessageMarker.Match(0x7890cdefUL,testMarker)=="zero-extended-low32","owned WM correlation explicitly records observed low32 compatibility");
        Check(OwnedWindowMessageMarker.Match(0xb11234567890cdefUL,testMarker)==null,"wrong nonzero upper bits are never ignored");
        Check(OwnedWindowMessageMarker.Match(0xffffffff9012ef01UL,0xc33456789012ef01UL)==null,"unobserved sign extension is not accepted");
        Check(OwnedWindowMessageMarker.Match(0,testMarker)==null,"zero message marker is not attributed");
        OwnedWindowMessageMarker.ValidateCandidates(new[]{testMarker,0xb22345678901def0UL,0xc33456789012ef01UL});Checks.Add("predefined full64 hook markers have nonzero distinct low words");
        bool ambiguous=false;try{OwnedWindowMessageMarker.ValidateCandidates(new[]{testMarker,0xb11234567890cdefUL});}catch(ArgumentException){ambiguous=true;}
        Check(ambiguous,"ambiguous low words cannot classify owned WM receipts");
        bool zeroWord=false;try{OwnedWindowMessageMarker.ValidateCandidates(new[]{0xa112345600000000UL});}catch(ArgumentException){zeroWord=true;}
        Check(zeroWord,"zero low word is rejected before test injection");
        var expected=new AssistedExpected{directory=Path.GetFullPath("owned-fixture"),executable=Path.GetFullPath("owned-fixture/DesktopFixture.exe"),
            pid=10,startedUtcTicks="638970000000000000",hwnd="100",nonce=new string('a',32),marker="0000000089abcdef"};
        var manifest=new AssistedManifest{version=1,pid=10,startedUtcTicks=expected.startedUtcTicks,executable=expected.executable,hwnd="100",padHwnd="101",
            nonce=expected.nonce,marker=expected.marker,capturedAt=100,expiresAt=8100,dpi=120,
            windowBounds=new[]{10,10,620,430},clientBounds=new[]{18,42,604,390},padBounds=new[]{42,400,280,20},virtualBounds=new[]{0,0,1920,1080}};
        var observed=new AssistedObserved{pid=10,startedUtcTicks=expected.startedUtcTicks,executable=expected.executable,hwnd="100",padHwnd="101",pointRoot="100",pointWindow="101",
            dpi=120,sourceRid=12288,targetRid=8192,foregroundRid=12288,visible=true,enabled=true,pixelContext=true,sameDesktop=true,clipUnrestricted=true,
            windowBounds=manifest.windowBounds,clientBounds=manifest.clientBounds,padBounds=manifest.padBounds,virtualBounds=manifest.virtualBounds,cursorX=182,cursorY=410};
        AssistedForegroundPolicy.Validate(expected,manifest,observed,200,true);Checks.Add("owned identity, Medium target and High preparer can satisfy pure preconditions");
        var wideExpected=Copy(expected);var wideManifest=Copy(manifest);wideExpected.marker=wideManifest.marker="b96f3696666dc676";
        bool wideRefused=false;try{AssistedForegroundPolicy.Validate(wideExpected,wideManifest,observed,200,true);}catch{wideRefused=true;}
        Check(wideRefused,"assisted setup rejects full64 tokens even when expected and manifest agree");
        var obscured=Copy(observed);obscured.pointRoot="6033106";obscured.pointWindow="6033106";bool obscuredRefused=false;
        try{AssistedForegroundPolicy.Validate(expected,manifest,obscured,200,false);}catch(InvalidOperationException error){obscuredRefused=error.Message=="ASSISTED_PAD_OBSCURED";}
        Check(obscuredRefused,"topmost diagnostics never waive exact owned pad hit testing before movement");
        foreach(uint flag in new uint[]{2,4,8,16})Check(AssistedForegroundPolicy.CaptureOrInteractiveMode(false,flag),"GUI capture/menu/move-size mode rejected "+flag);
        Check(AssistedForegroundPolicy.CaptureOrInteractiveMode(true,0) && !AssistedForegroundPolicy.CaptureOrInteractiveMode(false,1),"capture rejected while caret-blinking flag alone is not a capture");
        var mutations=new Action<AssistedObserved>[] {
            x=>x.pid=11,x=>x.startedUtcTicks="638970000000000001",x=>x.executable=Path.GetFullPath("other/DesktopFixture.exe"),
            x=>x.pointRoot="999",x=>x.pointWindow="102",x=>x.dpi=96,x=>x.sourceRid=8192,x=>x.targetRid=12288,x=>x.foregroundRid=0,
            x=>x.visible=false,x=>x.enabled=false,x=>x.minimized=true,x=>x.cloaked=true,x=>x.pixelContext=false,x=>x.sameDesktop=false,
            x=>x.captureActive=true,x=>x.heldCount=1,x=>x.clipUnrestricted=false,x=>x.windowBounds[0]++,x=>x.padBounds[0]++,
            x=>x.virtualBounds[2]--,x=>x.cursorX++
        };
        foreach(var mutate in mutations){var value=Copy(observed);mutate(value);bool refused=false;try{AssistedForegroundPolicy.Validate(expected,manifest,value,200,true);}catch{refused=true;}Check(refused,"changed live evidence refused "+Checks.Count);}
        foreach(var mutate in new Action<AssistedManifest>[] {x=>x.nonce=new string('b',32),x=>x.marker="0000000000000000",x=>x.marker="f0123456789abcde",x=>x.expiresAt=200,
            x=>x.capturedAt=201,x=>x.expiresAt=20000,x=>x.hwnd="200",x=>x.padBounds[2]=1,x=>x.padBounds[1]=0}){
            var value=Copy(manifest);mutate(value);bool refused=false;try{AssistedForegroundPolicy.Validate(expected,value,observed,200,true);}catch{refused=true;}Check(refused,"changed manifest refused "+Checks.Count);
        }
        var order=new List<string>();
        var cleanup=AssistedForegroundPolicy.ClickOnce(()=>order.Add("before-move"),()=>order.Add("move"),()=>order.Add("before-down"),kind=>{order.Add(kind);return 1;});
        Check(String.Join(",",order)=="before-move,move,before-down,down,up" && cleanup.PendingReleaseCount==0,"one move and one down/up in validated order");
        order.Clear();try{AssistedForegroundPolicy.ClickOnce(()=>{},()=>order.Add("move"),()=>{},kind=>{order.Add(kind);return 0;});throw new Exception("Expected refusal");}catch(InputDeliveryException){}
        Check(String.Join(",",order)=="move,down","zero inserted down never fabricates a release or retries down");
        order.Clear();var original=new InvalidOperationException("cancelled");Exception result=null;
        try{AssistedForegroundPolicy.ClickOnce(()=>{},()=>{},()=>{},kind=>{order.Add(kind);if(kind=="down")throw original;return 1;});}catch(Exception error){result=error;}
        Check(Object.ReferenceEquals(result,original) && String.Join(",",order)=="down,up","unknown down cleans up and preserves original failure");
        order.Clear();result=null;
        try{AssistedForegroundPolicy.ClickOnce(()=>{},()=>{},()=>{},kind=>{order.Add(kind);return kind=="down"?1u:0u;});}catch(Exception error){result=error;}
        var failed=Json.Deserialize<Dictionary<string,object>>((string)result.Data["cleanup"]);
        Check(String.Join(",",order)=="down,up,up" && Convert.ToInt32(failed["PendingReleaseCount"])==1 && !(bool)failed["AllReleasesInserted"],"release failure retains unresolved owned down without replaying press");
        order.Clear();try{AssistedForegroundPolicy.ClickOnce(()=>{},()=>order.Add("move"),()=>{throw original;},kind=>{order.Add(kind);return 1;});}catch(Exception error){Check(Object.ReferenceEquals(error,original),"pre-down cancellation preserved");}
        Check(String.Join(",",order)=="move","pre-down cancellation sends no down or orphan release");
        Console.WriteLine(Json.Serialize(new{ok=true,checks=Checks,guiStarted=false,inputAttempted=false}));return 0;
    }
}
