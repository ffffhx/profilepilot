using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ProfilePilot.Desktop {
    public sealed class AutomationFault : Exception {
        public readonly string Cause;
        public AutomationFault(string code,string cause=null):base(code){Cause=cause;}
    }
    public static class AutomationJson {
        public static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=4*1024*1024,RecursionLimit=48};
        // The worker and desktop management transport each allow 4 MiB UTF-8.
        // Leave 512 KiB for their envelopes and optional observation metadata.
        // These limits include the newline written by Console.WriteLine.
        public const int MaxResponseBytes=3584*1024;
        public const int MaxErrorResponseBytes=16*1024;
        public const int MaxRequestBytes=65536;
        static readonly int NewLineBytes=Encoding.UTF8.GetByteCount(Environment.NewLine);
        public static void Require(bool value,string code="DESKTOP_BAD_REQUEST"){if(!value)throw new AutomationFault(code);}
        public static string Text(Dictionary<string,object> map,string key,string fallback=""){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is string);return (string)value;}
        public static int Number(Dictionary<string,object> map,string key,int fallback=0){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is int);return (int)value;}
        public static bool Flag(Dictionary<string,object> map,string key,bool fallback=false){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is bool);return (bool)value;}
        public static void Fields(Dictionary<string,object> map,string keys){var allowed=new HashSet<string>(keys.Split(','));Require(map.Keys.All(allowed.Contains));}
        public static string Hash(string text){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
        public static bool RequestLineFits(string line){return line!=null && line.Length<=MaxRequestBytes && Encoding.UTF8.GetByteCount(line)<=MaxRequestBytes;}
        static bool SerializeBounded(object value,int maximum,out string line,out bool tooLarge,out int bytes){
            var output=new StringBuilder();bool serialized=false;
            try{Json.Serialize(value,output);serialized=true;}
            catch(Exception){ /* Never expose serializer exceptions or partial JSON. */ }
            string candidate=output.ToString();bytes=Encoding.UTF8.GetByteCount(candidate)+NewLineBytes;
            tooLarge=bytes>maximum;line=serialized && !tooLarge?candidate:null;
            // The StringBuilder also lets a MaxJsonLength exception be classified
            // by actual encoded size, without parsing a localized error message.
            return line!=null;
        }
        static string ReplyId(string id){return id!=null && id.Length<=128?id:"";}
        static string ReplyCode(string code){return code!=null && code.Length<=88 && code.StartsWith("DESKTOP_",StringComparison.Ordinal) && code.Skip(8).Any() && code.Skip(8).All(c=>c>='A' && c<='Z' || c>='0' && c<='9' || c=='_')?code:null;}
        static string ReplyCause(string cause){return cause!=null && cause.Length<=128 && cause.All(c=>c>='A' && c<='Z' || c>='a' && c<='z' || c>='0' && c<='9' || c=='_' || c=='.' || c==':' || c=='-')?cause:null;}
        static string SmallFailure(string id,string code,string cause,object diagnostics){
            // All fields here are bounded strings, fixed flags, or numeric size
            // evidence. No original result, exception message or partial JSON.
            string line;bool tooLarge;int bytes;
            if(SerializeBounded(new {id=ReplyId(id),ok=false,code,cause,diagnostics},MaxErrorResponseBytes,out line,out tooLarge,out bytes))return line;
            return Json.Serialize(new {id=ReplyId(id),ok=false,code,cause,diagnostics=(object)null});
        }
        public static string SuccessReply(string id,string operation,object result){
            string line;bool tooLarge;int bytes;
            if(SerializeBounded(new {id,ok=true,result},MaxResponseBytes,out line,out tooLarge,out bytes))return line;
            string code=operation=="window.action"?"DESKTOP_OUTCOME_UNKNOWN":tooLarge?"DESKTOP_RESPONSE_TOO_LARGE":"DESKTOP_RESPONSE_SERIALIZATION_FAILED";
            return SmallFailure(id,code,tooLarge?"UTF8_RESPONSE_LIMIT":"RESPONSE_SERIALIZATION_FAILED",new {response=new {limitBytes=MaxResponseBytes,observedBytes=bytes}});
        }
        public static string ErrorReply(string id,string operation,Exception error){
            var fault=error as AutomationFault;
            string code=(fault==null?null:ReplyCode(fault.Message))??(operation=="window.action"?"DESKTOP_OUTCOME_UNKNOWN":"DESKTOP_PROVIDER_FAILED");
            string cause=fault==null?null:ReplyCause(fault.Cause),line;bool tooLarge;int bytes;
            object diagnostics;
            try{diagnostics=error.Data["diagnostics"];}
            catch(Exception){return SmallFailure(id,code,cause,new {omitted=true,reason="ERROR_METADATA_UNAVAILABLE"});}
            if(SerializeBounded(new {id=ReplyId(id),ok=false,code,cause,diagnostics},MaxErrorResponseBytes,out line,out tooLarge,out bytes))return line;
            return SmallFailure(id,code,cause,new {omitted=true,reason=tooLarge?"ERROR_RESPONSE_TOO_LARGE":"ERROR_RESPONSE_SERIALIZATION_FAILED",limitBytes=MaxErrorResponseBytes});
        }
    }
    // ProfilePilot owns this child. It accepts JSON only over inherited stdin;
    // no network listener, shell execution, installed service or elevation.
    public static class DesktopHost {
        [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int length,out int needed);
        public static bool IsInteractiveDesktop(){
            IntPtr desktop=OpenInputDesktop(0,false,0x0100);if(desktop==IntPtr.Zero)return false;
            try{var name=new StringBuilder(256);int needed;return GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed) && String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);}finally{CloseDesktop(desktop);}
        }
        public static UIntPtr InputMarker(string[] args){
            if(IntPtr.Size!=8)throw new ArgumentException("64-bit input helper required");
            if(args==null || args.Length==0){
                // Compatibility for an older App's already-running read worker.
                // A future observer must explicitly register its own marker.
                var bytes=new byte[8];ulong generated;
                using(var random=RandomNumberGenerator.Create())do{random.GetBytes(bytes);generated=BitConverter.ToUInt64(bytes,0);}while(generated==0);
                return new UIntPtr(generated);
            }
            ulong marker;
            if(args.Length!=2 || args[0]!="--input-marker" || args[1]==null || args[1].Length!=16 ||
                !args[1].All(c=>c>='0' && c<='9' || c>='a' && c<='f') ||
                !UInt64.TryParse(args[1],NumberStyles.AllowHexSpecifier,CultureInfo.InvariantCulture,out marker) || marker==0)
                throw new ArgumentException("Invalid input helper startup arguments");
            return new UIntPtr(marker);
        }
        [MTAThread] public static int Main(string[] args){
            UIntPtr marker;try{marker=InputMarker(args);}catch{return 2;}
            Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
            int cancelled=0;
            var incoming=new BlockingCollection<Dictionary<string,object>>(16);
            // Read cancellation independently of slow UIA calls and pointer gestures.
            // UIA remains on this one MTA thread; the reader only parses protocol JSON.
            var reader=new Thread(()=>{
                var inputJson=new JavaScriptSerializer {MaxJsonLength=AutomationJson.MaxRequestBytes,RecursionLimit=48};
                try{
                    string line;while((line=Console.ReadLine())!=null){
                        Dictionary<string,object> request;
                        try{
                            AutomationJson.Require(AutomationJson.RequestLineFits(line));
                            request=inputJson.DeserializeObject(line) as Dictionary<string,object>;AutomationJson.Require(request!=null);
                            if(request.Count==1 && AutomationJson.Text(request,"operation")=="cancel")break;
                        }catch{request=new Dictionary<string,object>();}
                        if(!incoming.TryAdd(request))break;
                    }
                }catch{ /* Broken stdin is a cancellation, not a process crash. */ }
                finally{Interlocked.Exchange(ref cancelled,1);incoming.CompleteAdding();}
            });
            reader.IsBackground=true;reader.Start();
            using(var windows=new AutomationWindows(marker)){
                windows.Allowed=()=>Interlocked.CompareExchange(ref cancelled,0,0)==0;
                foreach(var request in incoming.GetConsumingEnumerable()){
                    if(!windows.Allowed())break;
                    string id="",operation="",reply;
                    try{
                        AutomationJson.Fields(request,"id,operation,params");id=AutomationJson.Text(request,"id");
                        object parameters;AutomationJson.Require(request.TryGetValue("params",out parameters) && parameters is Dictionary<string,object>);
                        operation=AutomationJson.Text(request,"operation");
                        var result=windows.Handle(operation,(Dictionary<string,object>)parameters);
                        reply=AutomationJson.SuccessReply(id,operation,result);
                    }catch(Exception error){
                        reply=AutomationJson.ErrorReply(id,operation,error);
                    }
                    // Write only complete envelopes. A pipe failure cannot be
                    // repaired by appending a second JSON object to a partial one.
                    Console.WriteLine(reply);
                    Console.Out.Flush();
                }
            }
            return 0;
        }
    }
}
