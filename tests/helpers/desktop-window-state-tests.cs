using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using ProfilePilot.Desktop;

// Pure policy/collector tests. No HWND, AutomationElement, hook or input API.
static class DesktopWindowStateTests {
    static readonly List<string> Checks=new List<string>();
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static Dictionary<string,object> Values(){return new Dictionary<string,object>{{"available",true},{"nativeHandle",123},{"visual",0},{"canMinimize",true},{"canMaximize",true},{"modal",false},{"interaction",2}};}
    static DesktopWindowState.Snapshot Read(Dictionary<string,object> values){return DesktopWindowState.Read(key=>values[key],()=>{});}
    static string Reject(string kind,DesktopWindowState.Snapshot before,DesktopWindowState.Snapshot after,bool root=true,bool enabled=true,bool offscreen=false,bool wasIconic=false,bool iconic=false){return DesktopWindowState.Rejection(kind,before,after,root,enabled,offscreen,wasIconic,iconic);}
    public static void Main(){
        var values=Values();var normal=Read(values);
        Assert(normal.Status=="readable" && normal.NativeHandle==123 && DesktopWindowState.Desired("restore")==0 && DesktopWindowState.Desired("maximize")==1 && DesktopWindowState.Desired("minimize")==2,"state mapping");
        Assert(Reject("maximize",normal,normal)==null && Reject("minimize",normal,normal)==null,"normal transition");Checks.Add("readable root capabilities support explicit normal/min/max mappings");
        foreach(string key in new[]{"nativeHandle","visual","canMinimize","canMaximize","modal","interaction"}){
            values=Values();values[key]=key=="nativeHandle"?(object)124:key=="visual"?(object)1:key=="interaction"?(object)0:!(bool)values[key];var changed=Read(values);
            Assert(!DesktopWindowState.Identity(normal).SequenceEqual(DesktopWindowState.Identity(changed)),key+" missing from identity");
            Assert(Reject("maximize",normal,changed)=="DESKTOP_ELEMENT_CHANGED",key+" old snapshot accepted");
        }Checks.Add("each window capability visual/modal/interaction/native identity change rejects the old snapshot");
        values=Values();values["visual"]=2;var minimized=Read(values);
        Assert(Reject("restore",minimized,minimized,true,true,true,true,true)==null,"minimized root restore blocked");
        Assert(Reject("restore",minimized,minimized,false,true,true,true,true)!=null,"child exception");
        Assert(Reject("restore",minimized,minimized,true,false,true,true,true)!=null,"disabled exception");
        Assert(Reject("restore",minimized,minimized,true,true,true,false,true)!=null,"old iconic missing");
        Assert(Reject("restore",minimized,minimized,true,true,true,true,false)!=null,"current iconic missing");
        Assert(Reject("maximize",minimized,minimized,true,true,true,true,true)!=null && Reject("minimize",minimized,minimized,true,true,true,true,true)!=null,"offscreen other action");
        Assert(Reject("restore",normal,normal,true,true,true,true,true)!=null,"non-minimized offscreen exception");Checks.Add("offscreen exception is only enabled exact root restore with old/new minimized and iconic evidence");
        Assert(Reject("restore",normal,normal,true,true,false,false,true)!=null && Reject("restore",minimized,minimized,true,true,false,true,false)!=null,"incoherent UIA and native minimized evidence accepted");
        foreach(int interaction in new[]{0,1,3,4}){values=Values();values["interaction"]=interaction;var state=Read(values);Assert(Reject("restore",state,state)!=null,"non-ready accepted");}
        values=Values();values["modal"]=true;var modal=Read(values);Assert(Reject("restore",modal,modal)!=null,"modal accepted");
        values=Values();values["canMaximize"]=false;var fixedSize=Read(values);Assert(Reject("maximize",fixedSize,fixedSize)=="DESKTOP_ACTION_UNSUPPORTED","unsupported maximize accepted");
        values["canMinimize"]=false;fixedSize=Read(values);Assert(Reject("minimize",fixedSize,fixedSize)=="DESKTOP_ACTION_UNSUPPORTED","unsupported minimize accepted");Checks.Add("non-ready modal and disabled capability preflights fail before dispatch");
        values=Values();values["available"]=false;int calls=0;var unsupported=DesktopWindowState.Read(key=>{calls++;return values[key];},()=>{});Assert(unsupported.Status=="unsupported" && calls==1,"unsupported pattern queried state");
        Assert(Reject("restore",unsupported,unsupported)=="DESKTOP_ACTION_UNSUPPORTED","missing pattern fallback");
        foreach(string key in Values().Keys){var malformed=DesktopWindowState.Read(k=>k==key?null:Values()[k],()=>{});Assert(malformed.Status=="unavailable" && malformed.Visual==null,"unknown coerced to normal");}
        var failed=DesktopWindowState.Read(key=>{throw new COMException("provider");},()=>{});Assert(failed.Status=="unavailable","provider failure not recorded");
        bool cancelled=false;try{DesktopWindowState.Read(key=>Values()[key],()=>{throw new ApplicationException("cancel");});}catch(ApplicationException){cancelled=true;}Assert(cancelled,"checkpoint swallowed");Checks.Add("unsupported never reads properties and malformed/provider failures stay unknown without swallowing cancellation");
        Assert(DesktopWindowState.Confirmed(0,0,1) && DesktopWindowState.Confirmed(1,1,3) && DesktopWindowState.Confirmed(2,2,2),"matching confirmation failed");
        Assert(!DesktopWindowState.Confirmed(0,0,3) && !DesktopWindowState.Confirmed(1,0,3) && !DesktopWindowState.Confirmed(2,2,0),"one-sided or unknown confirmation passed");Checks.Add("postcondition needs matching UIA and successful Win32 placement show state");
        Console.WriteLine(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new{ok=true,checks=Checks}));
    }
}
