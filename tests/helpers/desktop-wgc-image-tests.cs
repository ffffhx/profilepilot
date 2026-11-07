using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using ProfilePilot.Desktop;

// Pure formatting and policy tests only. Do not call Capture/Observe/Action,
// create a window, construct an AutomationElement or invoke any P/Invoke.
public static class DesktopWgcImageTests {
    static readonly Type Driver=typeof(AutomationWindows);
    static readonly Type RectType=Driver.GetNestedType("Rect",BindingFlags.NonPublic);
    static readonly Type StateType=Driver.GetNestedType("CaptureSnapshot",BindingFlags.NonPublic);
    static readonly MethodInfo Format=Driver.GetMethod("WgcImage",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo Fallback=Driver.GetMethod("WgcFallbackReason",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly List<string> Checks=new List<string>();
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static object Outer(int x=100,int y=50,int width=1018,int height=705){
        var value=Activator.CreateInstance(RectType);
        foreach(var field in new[]{Tuple.Create("Left",x),Tuple.Create("Top",y),Tuple.Create("Right",x+width),Tuple.Create("Bottom",y+height)})RectType.GetField(field.Item1).SetValue(value,field.Item2);
        return value;
    }
    static WgcCaptureResult Image(){return new WgcCaptureResult{
        Success=true,Status="captured_unmapped",GeometryStatus="stable_dimensions_match_origin_unvalidated",ColorMode="SDR-BGRA8",
        Jpeg=new byte[]{0xff,0xd8,0xff,0xd9},Width=1002,Height=697,ContentWidth=1002,ContentHeight=697,
        FrameTimestampTicks=9223372036854775807,ElapsedMs=130.5,
        Geometry=new WgcGeometry{ProcessId=42,ProcessStartedUtcTicks=7,Dpi=120,DisplayAffinity=0,
            Window=new WgcRectangle{X=100,Y=50,Width=1018,Height=705},
            VisibleFrame=new WgcRectangle{X=108,Y=50,Width=1002,Height=697},
            Client=new WgcRectangle{X=109,Y=88,Width=1000,Height=658}},
        CandidateCaptureRect=new WgcRectangle{X=8,Y=0,Width=1002,Height=697}
    };}
    static Dictionary<string,object> Output(WgcCaptureResult image,object outer=null){
        var rectangle=outer??Outer();var state=Activator.CreateInstance(StateType);
        StateType.GetField("Window").SetValue(state,rectangle);StateType.GetField("Client").SetValue(state,rectangle);
        StateType.GetField("Visible").SetValue(state,true);StateType.GetField("Dpi").SetValue(state,120u);
        StateType.GetField("DisplayAffinityError").SetValue(state,87);
        object result=Format.Invoke(null,new[]{(object)image,rectangle,state});
        return (Dictionary<string,object>)AutomationJson.Json.DeserializeObject(AutomationJson.Json.Serialize(result));
    }
    static void Reject(WgcCaptureResult image,string code,object outer=null){
        bool rejected=false;
        try{Output(image,outer);}catch(TargetInvocationException error){var fault=error.InnerException as AutomationFault;rejected=fault!=null && fault.Message==code;}
        Assert(rejected,"Expected "+code);
    }
    static void Run(string name,Action action){action();Checks.Add(name);}
    static AutomationFault RefusedFallback(WgcCaptureResult result){
        try{Fallback.Invoke(null,new object[]{result});}
        catch(TargetInvocationException error){var fault=error.InnerException as AutomationFault;Assert(fault!=null && fault.Message=="DESKTOP_SCREENSHOT_UNAVAILABLE","Fallback used an unexpected failure code");return fault;}
        throw new Exception("A capture failure incorrectly selected fallback");
    }
    public static int Main(){
        Run("WGC bytes and source diagnostics survive native formatting",()=>{
            var value=Image();var output=Output(value);
            Assert((string)output["source"]=="windows-graphics-capture" && (string)output["mimeType"]=="image/jpeg","Wrong image source or MIME");
            Assert((string)output["data"]==Convert.ToBase64String(value.Jpeg),"JPEG bytes changed");
            Assert((int)output["width"]==1002 && (int)output["height"]==697 && (int)output["windowWidth"]==1018 && (int)output["windowHeight"]==705,"Wrong image/window dimensions");
            var diagnostics=(Dictionary<string,object>)output["captureDiagnostics"];
            Assert((string)diagnostics["status"]==value.Status && (string)diagnostics["geometryStatus"]==value.GeometryStatus && (string)diagnostics["frameTimestampTicks"]=="9223372036854775807","Capture diagnostics were lost or timestamp precision changed");
            Assert((int)diagnostics["contentWidth"]==1002 && (int)diagnostics["contentHeight"]==697 && Convert.ToDouble(diagnostics["elapsedMs"])==130.5,"Source dimensions/timing were lost");
        });
        Run("candidate capture bounds never grant coordinate authority",()=>{
            foreach(var candidate in new[]{Image().CandidateCaptureRect,new WgcRectangle{X=0,Y=0,Width=1018,Height=705},null}){
                var value=Image();value.CandidateCaptureRect=candidate;var output=Output(value);
                Assert(!(bool)output["coordinateInputAvailable"] && !output.ContainsKey("captureRect"),"Candidate bounds became coordinate authority");
                var diagnostics=(Dictionary<string,object>)output["captureDiagnostics"];
                Assert(diagnostics.ContainsKey("candidateCaptureRect"),"Candidate diagnostic was lost");
            }
        });
        Run("unknown native capture protection evidence survives WGC formatting",()=>{
            var output=Output(Image());var state=(Dictionary<string,object>)output["captureState"];
            Assert((string)state["protectionStatus"]=="unknown" && state["displayAffinity"]==null && (int)state["displayAffinityError"]==87,"Unknown protection was erased or relabeled");
            Assert((bool)state["visible"] && (int)state["dpi"]==120 && !(bool)output["coordinateInputAvailable"],"Metadata changed image input authority");
        });
        Run("all outer-window position and size changes reject the image",()=>{
            foreach(var outer in new[]{Outer(101,50),Outer(100,51),Outer(100,50,1019),Outer(100,50,1018,706)})Reject(Image(),"DESKTOP_WINDOW_CHANGED",outer);
        });
        Run("negative screen positions remain physical coordinates",()=>{
            var value=Image();value.Geometry.Window.X=-1500;value.Geometry.Window.Y=-500;
            var output=Output(value,Outer(-1500,-500));Assert((int)output["windowX"]==-1500 && (int)output["windowY"]==-500,"Negative origin changed");
        });
        Run("missing source geometry cannot format an image",()=>{
            var value=Image();value.Geometry=null;Reject(value,"DESKTOP_WINDOW_CHANGED");
            value=Image();value.Geometry.Window=null;Reject(value,"DESKTOP_WINDOW_CHANGED");
        });
        Run("failed captures and empty JPEG payloads cannot format an image",()=>{
            var value=Image();value.Success=false;Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            value=Image();value.Jpeg=null;Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            value=Image();value.Jpeg=new byte[0];Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
        });
        Run("zero negative and over-limit encoded dimensions are rejected",()=>{
            foreach(int size in new[]{0,-1,1601}){
                var value=Image();value.Width=size;Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
                value=Image();value.Height=size;Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            }
            var maximum=Image();maximum.Width=1600;maximum.Height=1600;Output(maximum);
        });
        Run("JPEG byte admission enforces its inclusive 2200000-byte cap",()=>{
            var value=Image();value.Jpeg=new byte[2200000];Output(value);
            value.Jpeg=new byte[2200001];Reject(value,"DESKTOP_SCREENSHOT_UNAVAILABLE");
        });
        Run("WGC geometry identity rejects process DPI affinity and rectangle changes",()=>{
            Assert(Image().Geometry.Same(Image().Geometry),"Equivalent geometry differs");
            foreach(Action<WgcGeometry> change in new Action<WgcGeometry>[] {
                g=>g.ProcessId++,g=>g.ProcessStartedUtcTicks++,g=>g.Dpi++,g=>g.DisplayAffinity=1,
                g=>g.Window.X++,g=>g.Window.Y++,g=>g.Window.Width++,g=>g.Window.Height++,
                g=>g.VisibleFrame.X++,g=>g.VisibleFrame.Y++,g=>g.VisibleFrame.Width++,g=>g.VisibleFrame.Height++,
                g=>g.Client.X++,g=>g.Client.Y++,g=>g.Client.Width++,g=>g.Client.Height++}){
                var first=Image().Geometry;var second=Image().Geometry;change(second);Assert(!first.Same(second),"Changed source geometry was accepted");
            }
            Assert(!Image().Geometry.Same(null),"Null geometry matched");
        });
        Run("unsupported API device loss and access denial have distinct failure statuses",()=>{
            foreach(var error in new Exception[]{new TypeLoadException(),new MissingMethodException(),new System.IO.FileNotFoundException(),new EntryPointNotFoundException(),new DllNotFoundException(),new COMException("class",unchecked((int)0x80040154)),new COMException("interface",unchecked((int)0x80004002))})
                Assert(WgcWindowCapture.ErrorStatus(error)=="unsupported_api","Missing API did not retain its unsupported status");
            Assert(WgcWindowCapture.ErrorStatus(new COMException("adapter",unchecked((int)0x887A0004)))=="device_unsupported","Unsupported adapter became device loss");
            foreach(uint code in new uint[]{0x887A0005,0x887A0006,0x887A0007,0x887A0020})Assert(WgcWindowCapture.ErrorStatus(new COMException("lost",unchecked((int)code)))=="device_lost","Lost device became unsupported platform");
            Assert(WgcWindowCapture.ErrorStatus(new UnauthorizedAccessException())=="access_denied","Access denial became unsupported platform");
            Assert(WgcWindowCapture.ErrorStatus(new InvalidOperationException())=="capture_failed","Unexpected failure became unsupported platform");
        });
        Run("only explicitly unsupported WGC backends select a reasoned fallback",()=>{
            foreach(string status in new[]{"unsupported_api","unsupported_capture","device_unsupported"}){
                var value=new WgcCaptureResult{Success=false,Status=status};
                Assert((string)Fallback.Invoke(null,new object[]{value})=="windows_graphics_capture_"+status,"The actual backend status did not select fallback");
                value.Success=true;RefusedFallback(value);
            }
        });
        Run("protected interrupted lost-device and invalid-source failures never select fallback",()=>{
            foreach(string status in new[]{"capture_protected","access_denied","window_closed","window_changed","size_changed","window_minimized","window_hidden","window_cloaked","device_lost","timeout","cancelled","empty_frame","geometry_mismatch","geometry_unavailable","dpi_context_unavailable","size_limit","pixel_format_unsupported","capture_failed","unsupported","unknown"}){
                var value=new WgcCaptureResult{Success=false,Status=status};
                Assert(RefusedFallback(value).Cause=="WGC_"+status.ToUpperInvariant(),"The capture cause was not retained");
            }
        });
        Run("capture faults retain source stage HRESULT and timing without copying image bytes",()=>{
            var value=Image();value.Success=false;value.Status="device_lost";value.Stage="readback";value.HResult="0x887A0005";
            var fault=RefusedFallback(value);
            var diagnostics=(Dictionary<string,object>)AutomationJson.Json.DeserializeObject(AutomationJson.Json.Serialize(fault.Data["diagnostics"]));
            var capture=(Dictionary<string,object>)diagnostics["capture"];
            Assert((string)capture["source"]=="windows-graphics-capture" && (string)capture["status"]=="device_lost" && (string)capture["stage"]=="readback" && (string)capture["hresult"]=="0x887A0005" && Convert.ToDouble(capture["elapsedMs"])==130.5,"Fault diagnostics were changed or omitted");
            Assert(!capture.ContainsKey("Jpeg") && !capture.ContainsKey("data") && !capture.ContainsKey("jpeg"),"Failure diagnostics copied capture bytes");
        });
        Run("null results and missing statuses fail closed with explicit failed causes",()=>{
            var fault=RefusedFallback(null);Assert(fault.Cause=="WGC_FAILED","Null result lost its failed cause");
            var diagnostics=(Dictionary<string,object>)fault.Data["diagnostics"];Assert(diagnostics.ContainsKey("capture") && diagnostics["capture"]==null,"Null result was fabricated into a successful capture");
            Assert(RefusedFallback(new WgcCaptureResult()).Cause=="WGC_FAILED","Missing status selected fallback");
        });
        Console.WriteLine(AutomationJson.Json.Serialize(new {ok=true,checks=Checks}));return 0;
    }
}
