using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace ProfilePilot.WindowsSampler {
    public sealed class Request {
        public string RequestId, Operation;
        public IList<string> Paths = new List<string>();
    }
    public sealed class Header { public string RequestId, Operation; }
    public static class Protocol {
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false,true);
        static JavaScriptSerializer Json(int limit) { return new JavaScriptSerializer { MaxJsonLength = limit, RecursionLimit = 16 }; }
        static Failure Invalid() { return new Failure("WINDOWS_SAMPLER_BAD_REQUEST","protocol"); }
        static void Keys(Dictionary<string,object> value, params string[] allowed) {
            var keys = new HashSet<string>(allowed,StringComparer.Ordinal);
            foreach (string key in value.Keys) if (!keys.Contains(key)) throw Invalid();
            if (value.Count != allowed.Length) throw Invalid();
        }
        public static byte[] Read(Stream stream) {
            using (var output = new MemoryStream()) {
                var buffer = new byte[4096]; int count;
                while ((count = stream.Read(buffer,0,buffer.Length)) > 0) {
                    if (output.Length + count > Limits.RequestBytes) throw new Failure("WINDOWS_SAMPLER_REQUEST_TOO_LARGE","protocol");
                    output.Write(buffer,0,count);
                }
                return output.ToArray();
            }
        }
        public static Request Parse(byte[] bytes, Header header) {
            if (bytes == null || bytes.Length == 0 || bytes.Length > Limits.RequestBytes) throw Invalid();
            try {
                string text = Utf8.GetString(bytes);
                if (text.EndsWith("\n",StringComparison.Ordinal)) { text = text.Substring(0,text.Length-1); if(text.EndsWith("\r",StringComparison.Ordinal))text=text.Substring(0,text.Length-1); }
                if (text.IndexOf('\n') >= 0 || text.IndexOf('\r') >= 0 || text.IndexOf('\0') >= 0) throw Invalid();
                new UniqueKeys(text).Check();
                var value = Json(Limits.RequestBytes).DeserializeObject(text) as Dictionary<string,object>;
                if (value == null) throw Invalid(); Keys(value,"version","requestId","operation","params");
                if (!(value["version"] is int) || (int)value["version"] != 1) throw Invalid();
                string id = value["requestId"] as string, operation = value["operation"] as string; Guid guid;
                if (id == null || !Guid.TryParseExact(id,"D",out guid) || guid == Guid.Empty || guid.ToString("D") != id) throw Invalid();
                header.RequestId = id;
                if (operation != "snapshot" && operation != "fileLocks") throw Invalid(); header.Operation = operation;
                var parameters = value["params"] as Dictionary<string,object>; if (parameters == null) throw Invalid();
                var request = new Request { RequestId = id, Operation = operation };
                if (operation == "snapshot") Keys(parameters);
                else {
                    Keys(parameters,"paths"); var paths = parameters["paths"] as object[];
                    if (paths == null || paths.Length > Limits.Paths) throw Invalid();
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (object item in paths) {
                        string path = item as string;
                        if (String.IsNullOrEmpty(path) || path.Length > Limits.Text || !Identity.WellFormed(path) || !seen.Add(path)) throw Invalid();
                        foreach (char c in path) if (Char.IsControl(c)) throw Invalid();
                        bool drive = path.Length >= 3 && ((path[0]>='A' && path[0]<='Z') || (path[0]>='a' && path[0]<='z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
                        bool unc = path.Length > 4 && path.StartsWith("\\\\",StringComparison.Ordinal) && path.IndexOf('\\',2) > 2;
                        if (!drive && !unc) throw Invalid();
                        request.Paths.Add(path);
                    }
                }
                return request;
            } catch (Failure) { throw; } catch { throw Invalid(); }
        }
        public static byte[] Success(Header header, object result, int maxBytes = Limits.ResponseBytes) {
            byte[] bytes;
            try {
                var envelope = new Dictionary<string,object>{{"version",1},{"requestId",header.RequestId},{"operation",header.Operation},{"ok",true},{"result",result}};
                bytes = Utf8.GetBytes(Json(Limits.ResponseBytes).Serialize(envelope) + "\n");
            } catch { throw new Failure("WINDOWS_SAMPLER_SERIALIZE_FAILED","serialize"); }
            if (bytes.Length > maxBytes) throw new Failure("WINDOWS_SAMPLER_RESPONSE_TOO_LARGE","serialize");
            return bytes;
        }
        static readonly HashSet<string> Stages = new HashSet<string>(new [] {"protocol","process_enumeration","process_pin","process_cim","process_identity","process_close","rm_start","rm_register","rm_list","rm_end","serialize"},StringComparer.Ordinal);
        public static byte[] Error(Header header, Failure failure) {
            if (failure == null || !Regex.IsMatch(failure.Code ?? "","^WINDOWS_SAMPLER_[A-Z0-9_]{1,64}$") || !Stages.Contains(failure.Stage ?? ""))
                failure = new Failure("WINDOWS_SAMPLER_INTERNAL_ERROR","serialize");
            var error = new Dictionary<string,object>{{"code",failure.Code},{"stage",failure.Stage}};
            if (failure.Pid.HasValue && failure.Pid.Value > 0) error.Add("pid",failure.Pid.Value);
            if (failure.Win32Error.HasValue) error.Add("win32Error",failure.Win32Error.Value);
            if (failure.CleanupFailed) { error.Add("cleanupFailed",true); if(failure.CleanupWin32Error.HasValue)error.Add("cleanupWin32Error",failure.CleanupWin32Error.Value); }
            return Utf8.GetBytes(Json(4096).Serialize(new Dictionary<string,object>{{"version",1},{"requestId",header.RequestId},{"operation",header.Operation},{"ok",false},{"error",error}}) + "\n");
        }
        // JavaScriptSerializer otherwise accepts duplicate object keys. Check
        // decoded property names before deserializing the bounded request.
        sealed class UniqueKeys {
            readonly string text; int index;
            public UniqueKeys(string text) { this.text = text; }
            int Hex() {
                int value=0;
                for(int i=0;i<4;i++){
                    if(index>=text.Length || !Uri.IsHexDigit(text[index]))throw Invalid();
                    char c=text[index++];value=(value<<4)+(c<='9'?c-'0':Char.ToLowerInvariant(c)-'a'+10);
                }
                return value;
            }
            void Space() { while(index<text.Length && (text[index]==' ' || text[index]=='\t'))index++; }
            void Need(char token) { Space();if(index>=text.Length || text[index++]!=token)throw Invalid(); }
            string String() {
                Space();int start=index;Need('"');bool done=false;
                while(index<text.Length) {
                    char c=text[index++];if(c=='"'){done=true;break;}if(c<' ')throw Invalid();
                    if(c=='\\'){
                        if(index>=text.Length)throw Invalid();char escape=text[index++];
                        if(escape=='u'){
                            int value=Hex();
                            if(value>=0xd800 && value<=0xdbff){
                                if(index+1>=text.Length || text[index++]!='\\' || text[index++]!='u')throw Invalid();
                                int low=Hex();if(low<0xdc00 || low>0xdfff)throw Invalid();
                            }else if(value>=0xdc00 && value<=0xdfff)throw Invalid();
                        }
                        else if("\"\\/bfnrt".IndexOf(escape)<0)throw Invalid();
                    }
                }
                if(!done)throw Invalid();return Json(Limits.RequestBytes).Deserialize<string>(text.Substring(start,index-start));
            }
            void Value(int depth) {
                if(depth>8)throw Invalid();Space();if(index>=text.Length)throw Invalid();char c=text[index];
                if(c=='{') {
                    index++;Space();var keys=new HashSet<string>(StringComparer.Ordinal);
                    if(index<text.Length && text[index]=='}'){index++;return;}
                    for(;;){string key=String();if(!keys.Add(key))throw Invalid();Need(':');Value(depth+1);Space();
                        if(index<text.Length && text[index]=='}'){index++;return;}Need(',');}
                } else if(c=='[') {
                    index++;Space();if(index<text.Length && text[index]==']'){index++;return;}
                    for(;;){Value(depth+1);Space();if(index<text.Length && text[index]==']'){index++;return;}Need(',');}
                } else if(c=='"')String();
                else {
                    int start=index;while(index<text.Length && text[index]!=',' && text[index]!=']' && text[index]!='}' && text[index]!=' ' && text[index]!='\t')index++;
                    if(index==start)throw Invalid();string token=text.Substring(start,index-start);
                    if(token!="true" && token!="false" && token!="null" && !Regex.IsMatch(token,@"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"))throw Invalid();
                }
            }
            public void Check(){Value(0);Space();if(index!=text.Length)throw Invalid();}
        }
    }
}
