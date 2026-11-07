using System;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;
public static class MissingChildPathTests {
    static readonly Type Host=typeof(DesktopSessionCycleFixture);
    static readonly Type Probe=Host.GetNestedType("MissingChildProbe",BindingFlags.NonPublic);
    static readonly MethodInfo Failure=Host.GetMethod("MissingChildPath",BindingFlags.NonPublic|BindingFlags.Static);
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    static void Set(object probe,string key,object value){Probe.GetField(key).SetValue(probe,value);}
    static void Case(string confirmation,bool? before,bool? after,int? nativeError,bool unstable,bool readable) {
        object probe=Activator.CreateInstance(Probe,true);Set(probe,"ExitConfirmation",confirmation);
        Set(probe,"LiveAtOpen",before);Set(probe,"LiveAfterReads",after);
        if(readable){Set(probe,"Executable","C:\\owned\\not-native.exe");Set(probe,"StartedUtcTicks","639289029339962091");}
        if(nativeError.HasValue)((List<object>)Probe.GetField("Errors").GetValue(probe)).Add(new {operation="OpenProcess",win32Error=nativeError});
        var error=(Exception)Failure.Invoke(null,new object[]{123,"not-native.exe","20261029204933.996209+000",probe});
        Check((error.GetType().Name=="UnstableSample")==unstable,"Wrong disposition for "+confirmation);
        if(!unstable)Check(error.Message=="CHILD_PATH_UNAVAILABLE","Unknown child was not rejected");
        string output=new JavaScriptSerializer().Serialize(error.Data["child"]);
        Check(output.Contains("\"pid\":123")&&output.Contains("not-native.exe")&&output.Contains("20261029204933.996209+000"),"Enumeration identity was discarded");
        if(nativeError.HasValue)Check(output.Contains("\"win32Error\":"+nativeError),"Native error was discarded");
        if(readable)Check(output.Contains("639289029339962091")&&output.Contains("executable"),"Fallback identity was discarded");
    }
    public static int Main() {
        try {
            Case("none",null,null,null,false,false);
            Case("none",true,true,null,false,true);
            Case("none",null,null,5,false,false);
            Case("none",null,null,87,false,false);
            Case("pid_not_found_after_invalid_parameter",null,null,87,true,false);
            Case("signaled_process_handle",true,false,5,true,true);
            Case("unrecognized",false,false,null,false,false);
            Console.WriteLine("{\"ok\":true,\"checks\":7,\"nativeCalls\":0,\"gui\":false}");return 0;
        }catch(Exception error){while(error.InnerException!=null)error=error.InnerException;Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=false,errorType=error.GetType().Name,error=error.Message}));return 1;}
    }
}
