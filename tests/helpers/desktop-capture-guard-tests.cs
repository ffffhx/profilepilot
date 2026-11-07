using System;
using System.Collections.Generic;
using System.Reflection;
using ProfilePilot.Desktop;

// Pure values only: no HWND, Capture, UIA, process enumeration or P/Invoke.
public static class DesktopCaptureGuardTests {
    static readonly Type Driver=typeof(AutomationWindows);
    static readonly Type State=Driver.GetNestedType("CaptureSnapshot",BindingFlags.NonPublic);
    static readonly Type Rect=Driver.GetNestedType("Rect",BindingFlags.NonPublic);
    static readonly MethodInfo Same=Driver.GetMethod("SameCaptureSnapshot",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo Guard=Driver.GetMethod("RequireCaptureSnapshot",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly List<string> Checks=new List<string>();
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Set(object value,string field,object data){value.GetType().GetField(field).SetValue(value,data);}
    static object Box(int left,int top,int right,int bottom){var value=Activator.CreateInstance(Rect);Set(value,"Left",left);Set(value,"Top",top);Set(value,"Right",right);Set(value,"Bottom",bottom);return value;}
    static object Snapshot(){var value=Activator.CreateInstance(State);Set(value,"Window",Box(100,80,800,600));Set(value,"Client",Box(108,110,792,592));Set(value,"Visible",true);Set(value,"Minimized",false);Set(value,"Cloaked",false);Set(value,"Dpi",120u);Set(value,"DisplayAffinity",0u);return value;}
    static bool Equal(object before,object after){return (bool)Same.Invoke(null,new[]{before,after});}
    static void Accept(object before,object after){Guard.Invoke(null,new[]{before,after});}
    static AutomationFault Reject(object before,object after,string code,string cause){
        try{Accept(before,after);}catch(TargetInvocationException error){var fault=error.InnerException as AutomationFault;Assert(fault!=null && fault.Message==code && fault.Cause==cause,"Unexpected capture rejection: "+error.InnerException);return fault;}
        throw new Exception("Capture unexpectedly passed: "+cause);
    }
    static Dictionary<string,object> Output(object value){return (Dictionary<string,object>)AutomationJson.Json.DeserializeObject(AutomationJson.Json.Serialize(State.GetMethod("Output").Invoke(value,new object[0])));}
    static void Run(string name,Action action){action();Checks.Add(name);}
    public static int Main(){
        Run("equal native capture states and initial reads pass",()=>{Assert(Equal(Snapshot(),Snapshot()),"Equal snapshots differ");Accept(null,Snapshot());Accept(Snapshot(),Snapshot());});
        Run("every outer and client rectangle edge is compared",()=>{
            foreach(string box in new[]{"Window","Client"})foreach(string edge in new[]{"Left","Top","Right","Bottom"}){
                var next=Snapshot();var rect=State.GetField(box).GetValue(next);Set(rect,edge,(int)Rect.GetField(edge).GetValue(rect)+1);Set(next,box,rect);
                Assert(!Equal(Snapshot(),next),"Changed "+box+"."+edge+" matched");Reject(Snapshot(),next,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");
            }
        });
        Run("DPI changes and knownness transitions reject",()=>{foreach(object dpi in new object[]{144u,null}){var next=Snapshot();Set(next,"Dpi",dpi);Reject(Snapshot(),next,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");}});
        Run("hidden minimized and cloaked states refuse initial and later capture",()=>{
            foreach(var entry in new[]{Tuple.Create("Visible",false,"WINDOW_HIDDEN"),Tuple.Create("Minimized",true,"WINDOW_MINIMIZED"),Tuple.Create("Cloaked",true,"WINDOW_CLOAKED")}){
                var next=Snapshot();Set(next,entry.Item1,entry.Item2);Reject(null,next,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_"+entry.Item3);Reject(Snapshot(),next,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_"+entry.Item3);
            }
        });
        Run("all nonzero known affinity values refuse capture",()=>{foreach(uint affinity in new uint[]{1,0x11,0xffffffff}){var next=Snapshot();Set(next,"DisplayAffinity",affinity);Reject(null,next,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_CAPTURE_PROTECTED");Reject(Snapshot(),next,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_CAPTURE_PROTECTED");Assert((string)Output(next)["protectionStatus"]=="protected","Known protection lost");}});
        Run("stable unreadable affinity remains unknown rather than protected or none",()=>{
            var first=Snapshot();var next=Snapshot();foreach(var value in new[]{first,next}){Set(value,"DisplayAffinity",null);Set(value,"DisplayAffinityError",87);}
            Accept(null,first);Accept(first,next);Assert(Equal(first,next),"Stable unavailable affinity changed");var output=Output(next);
            Assert(output["displayAffinity"]==null && (int)output["displayAffinityError"]==87 && (string)output["protectionStatus"]=="unknown","Read failure became known affinity");
        });
        Run("affinity knownness and unreadable error changes reject",()=>{
            var unknown=Snapshot();Set(unknown,"DisplayAffinity",null);Set(unknown,"DisplayAffinityError",87);
            Reject(Snapshot(),unknown,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");Reject(unknown,Snapshot(),"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");
            var changed=Snapshot();Set(changed,"DisplayAffinity",null);Set(changed,"DisplayAffinityError",5);Reject(unknown,changed,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");
        });
        Run("unknown DWM cloaking remains distinct from known visible",()=>{var unknown=Snapshot();Set(unknown,"Cloaked",null);Accept(null,unknown);Assert(!Equal(Snapshot(),unknown),"Unknown cloaking became false");Reject(Snapshot(),unknown,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");});
        Run("null and invalid geometry cannot authorize capture",()=>{
            Assert(!Equal(null,Snapshot()) && !Equal(Snapshot(),null),"Missing snapshot matched");Reject(null,null,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_STATE_UNAVAILABLE");
            foreach(var box in new[]{Box(100,80,100,600),Box(100,80,800,80),Box(100,80,99,600)}){var next=Snapshot();Set(next,"Window",box);Reject(null,next,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_GEOMETRY_UNAVAILABLE");}
            var client=Snapshot();Set(client,"Client",Box(108,110,107,592));Reject(null,client,"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_GEOMETRY_UNAVAILABLE");
        });
        Run("negative desktop origins retain their exact geometry",()=>{var first=Snapshot();var next=Snapshot();foreach(var value in new[]{first,next}){Set(value,"Window",Box(-900,-600,-200,-80));Set(value,"Client",Box(-892,-570,-208,-88));}Accept(first,next);var box=(Dictionary<string,object>)Output(next)["windowRect"];Assert((int)box["x"]==-900 && (int)box["width"]==700,"Negative origin changed");});
        Run("failure diagnostics preserve before and after metadata without image bytes",()=>{
            var next=Snapshot();Set(next,"Window",Box(101,80,801,600));var fault=Reject(Snapshot(),next,"DESKTOP_WINDOW_CHANGED","CAPTURE_WINDOW_CHANGED");
            string json=AutomationJson.Json.Serialize(fault.Data["diagnostics"]);Assert(json.Contains("window-state") && json.Contains("before") && json.Contains("after") && !json.Contains("image/jpeg"),"Incomplete or pixel-bearing diagnostics");
        });
        Run("known zero affinity is the only explicit none status",()=>{var output=Output(Snapshot());Assert((string)output["protectionStatus"]=="none" && (int)output["displayAffinity"]==0 && output["displayAffinityError"]==null,"Known zero affinity changed");});
        Run("fixture mutates only explicit print messages or OS-confirmed print redirection",()=>{
            foreach(int message in new[]{0x317,0x318})foreach(bool? redirected in new bool?[]{true,false,null})Assert(DesktopCaptureFixture.IsCapturePrintMessage(message,redirected),"Explicit print callback was ignored");
            foreach(int message in new[]{0xf,0x85,0x113,0x1}){
                Assert(DesktopCaptureFixture.IsCapturePrintMessage(message,true),"Confirmed print redirection was ignored");
                Assert(!DesktopCaptureFixture.IsCapturePrintMessage(message,false) && !DesktopCaptureFixture.IsCapturePrintMessage(message,null),"Ordinary or unknown paint became print evidence");
            }
        });
        Run("external geometry stress remains inside its owned display work area and changes real bounds",()=>{
            var initial=new System.Drawing.Rectangle(-900,80,658,487);var work=new System.Drawing.Rectangle(-1000,0,1000,900);
            var previous=initial;
            for(int sequence=1;sequence<=120;sequence++){
                var next=DesktopCaptureFixture.GeometryStressBounds(initial,work,sequence);
                Assert(work.Contains(next) && next.Width>0 && next.Height>0,"Stress geometry escaped the work area");
                Assert(next!=previous,"Stress timer repeated identical geometry");previous=next;
            }
        });
        Console.WriteLine(AutomationJson.Json.Serialize(new{ok=true,checks=Checks}));return 0;
    }
}
