using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using ProfilePilot.Desktop;

// Pure serialization and in-memory image tests. This entry point never starts
// DesktopHost, observes a window, captures a screen, or invokes input APIs.
public static class DesktopProtocolTests {
    const string Id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const string PrivateMarker="PRIVATE_PAYLOAD_MUST_NOT_LEAK";
    static readonly List<string> Checks=new List<string>();
    [Serializable] public sealed class ThrowingResult {public string Value {get{throw new InvalidOperationException(PrivateMarker);}}}
    sealed class ThrowingMetadataException : Exception {public override IDictionary Data {get{throw new InvalidOperationException(PrivateMarker);}}}
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static int Bytes(string line){return Encoding.UTF8.GetByteCount(line+Environment.NewLine);}
    static Dictionary<string,object> Parse(string line){
        Assert(!line.Contains("\r") && !line.Contains("\n"),"A reply contains a raw newline");
        Assert(Bytes(line)<=AutomationJson.MaxResponseBytes,"Response exceeded the UTF-8 budget");
        return (Dictionary<string,object>)AutomationJson.Json.DeserializeObject(line);
    }
    static void Failure(string line,string code){
        var reply=Parse(line);Assert((bool)reply["ok"]==false && (string)reply["code"]==code,"Wrong failure classification: "+line);
        Assert(Bytes(line)<=AutomationJson.MaxErrorResponseBytes,"Error response exceeded its smaller budget");
        Assert(!line.Contains(PrivateMarker),"Original result/exception text leaked into an error");
    }
    static object[] Nodes(char character){
        return Enumerable.Range(0,512).Select(i=>(object)new {reference="e"+i,name=new string(character,512),automationId=new string(character,256),text=new string(character,64),role="Edit",actions=new[]{"set_value"},password=false,enabled=true,offscreen=false,focused=false,bounds=new[]{1,2,3,4}}).ToArray();
    }
    static byte[] Jpeg(){
        using(var bitmap=new Bitmap(1600,1000,PixelFormat.Format24bppRgb)){
            var data=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.WriteOnly,PixelFormat.Format24bppRgb);
            try{
                var pixels=new byte[data.Stride*data.Height];uint seed=123456789;
                for(int index=0;index<pixels.Length;index++){seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;pixels[index]=(byte)seed;}
                Marshal.Copy(pixels,0,data.Scan0,pixels.Length);
            }finally{bitmap.UnlockBits(data);}
            var codec=ImageCodecInfo.GetImageEncoders().First(item=>item.FormatID==ImageFormat.Jpeg.Guid);
            foreach(long quality in new long[]{97,96,95,94,93,92,90})using(var parameters=new EncoderParameters(1))using(var bytes=new MemoryStream()){
                parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,quality);bitmap.Save(bytes,codec,parameters);
                if(bytes.Length<=2200000 && bytes.Length>=1750000)return bytes.ToArray();
            }
            throw new Exception("Could not create the bounded high-entropy JPEG fixture");
        }
    }
    public static int Main(string[] args){
        string directory=args[0];
        string baseline=AutomationJson.SuccessReply(Id,"windows",new {text=""});
        int padding=AutomationJson.MaxResponseBytes-Bytes(baseline);
        string exact=AutomationJson.SuccessReply(Id,"windows",new {text=new string('a',padding)});
        Assert(Bytes(exact)==AutomationJson.MaxResponseBytes && (bool)Parse(exact)["ok"],"Exact UTF-8 boundary was rejected");
        File.WriteAllText(Path.Combine(directory,"boundary.json"),exact+Environment.NewLine,new UTF8Encoding(false));
        Checks.Add("complete success exactly at the UTF-8 boundary is admitted");

        Failure(AutomationJson.SuccessReply(Id,"windows",new {text=new string('a',padding+1)}),"DESKTOP_RESPONSE_TOO_LARGE");
        Checks.Add("one byte over the response boundary produces a small explicit failure");

        string unicode="\u4e2d\u6587\ud83d\ude42\0\n\"\\\u0001";
        string encoded=AutomationJson.SuccessReply(Id,"window.observe",new {text=unicode});
        Assert((string)((Dictionary<string,object>)Parse(encoded)["result"])["text"]==unicode,"Unicode or escaped controls did not round-trip");
        Checks.Add("CJK, surrogate pairs and escaped control characters round-trip without raw line breaks");

        Failure(AutomationJson.SuccessReply(Id,"window.observe",new {text=new string('\u4e2d',AutomationJson.MaxResponseBytes/3)}),"DESKTOP_RESPONSE_TOO_LARGE");
        Checks.Add("CJK UTF-8 bytes are limited even below the serializer character limit");

        Failure(AutomationJson.SuccessReply(Id,"window.observe",new {text=new string('\u0001',800000)}),"DESKTOP_RESPONSE_TOO_LARGE");
        Checks.Add("escaped controls exceeding MaxJsonLength still receive a size error");

        byte[] jpeg=Jpeg();
        using(var bytes=new MemoryStream(jpeg))using(var decoded=Image.FromStream(bytes))Assert(decoded.RawFormat.Guid==ImageFormat.Jpeg.Guid && decoded.Width==1600 && decoded.Height==1000,"Generated image was not a decodable JPEG");
        object image=new {mimeType="image/jpeg",data=Convert.ToBase64String(jpeg),width=1600,height=1000,windowWidth=1600,windowHeight=1000};
        string imageReply=AutomationJson.SuccessReply(Id,"window.screenshot",new {version=new string('b',32),image,elements=new object[0]});
        Assert((bool)Parse(imageReply)["ok"],"A bounded JPEG-only reply was rejected");
        File.WriteAllText(Path.Combine(directory,"jpeg.json"),imageReply+Environment.NewLine,new UTF8Encoding(false));
        Checks.Add("real in-memory JPEG payload is decodable and accepted below the byte limit");

        object combined=new {version=new string('b',32),image,elements=Nodes('\u4e2d')};
        string raw=AutomationJson.Json.Serialize(new {id=Id,ok=true,result=combined});int combinedBytes=Bytes(raw),combinedCharacters=raw.Length;
        Assert(combinedCharacters<4*1024*1024 && combinedBytes>AutomationJson.MaxResponseBytes,"Mixed CJK/JPEG fixture did not exercise the byte/character mismatch");
        Failure(AutomationJson.SuccessReply(Id,"window.screenshot",combined),"DESKTOP_RESPONSE_TOO_LARGE");
        Checks.Add("bounded UIA fields plus a real JPEG reject by UTF-8 size instead of interrupting the driver");

        Failure(AutomationJson.SuccessReply(Id,"window.screenshot",new {image,elements=Nodes('\u0001')}),"DESKTOP_RESPONSE_TOO_LARGE");
        Checks.Add("control-character UIA fields plus JPEG reject without emitting partial JSON");

        Failure(AutomationJson.SuccessReply(Id,"window.action",combined),"DESKTOP_OUTCOME_UNKNOWN");
        Checks.Add("oversized action results never claim that input did not execute");

        Failure(AutomationJson.SuccessReply(Id,"window.observe",new ThrowingResult()),"DESKTOP_RESPONSE_SERIALIZATION_FAILED");
        Failure(AutomationJson.SuccessReply(Id,"window.action",new ThrowingResult()),"DESKTOP_OUTCOME_UNKNOWN");
        Checks.Add("throwing result getters become safe read failures or unknown action outcomes");

        var circular=new Dictionary<string,object>();circular["self"]=circular;
        Failure(AutomationJson.SuccessReply(Id,"windows",circular),"DESKTOP_RESPONSE_SERIALIZATION_FAILED");
        Checks.Add("circular result graphs produce a complete small error");

        var nativeFailure=new AutomationFault("DESKTOP_FOCUS_REQUIRED","FOREGROUND_NOT_CONFIRMED");nativeFailure.Data["diagnostics"]=new Dictionary<string,object>{{"activation",new {confirmed=false}}};
        string normalFailure=AutomationJson.ErrorReply(Id,"window.action",nativeFailure);Failure(normalFailure,"DESKTOP_FOCUS_REQUIRED");
        Assert(normalFailure.Contains("FOREGROUND_NOT_CONFIRMED") && normalFailure.Contains("activation"),"Small safe diagnostics were discarded");
        Checks.Add("normal bounded failure codes and diagnostics are preserved");

        nativeFailure=new AutomationFault("DESKTOP_PROVIDER_FAILED");nativeFailure.Data["diagnostics"]=new Dictionary<string,object>{{"text",""}};
        int errorPadding=AutomationJson.MaxErrorResponseBytes-Bytes(AutomationJson.ErrorReply(Id,"windows",nativeFailure));
        nativeFailure.Data["diagnostics"]=new Dictionary<string,object>{{"text",new string('a',errorPadding)}};
        string exactError=AutomationJson.ErrorReply(Id,"windows",nativeFailure);Failure(exactError,"DESKTOP_PROVIDER_FAILED");
        Assert(Bytes(exactError)==AutomationJson.MaxErrorResponseBytes,"Exact error boundary was rejected");
        nativeFailure.Data["diagnostics"]=new Dictionary<string,object>{{"text",new string('a',errorPadding+1)}};
        Assert(AutomationJson.ErrorReply(Id,"windows",nativeFailure).Contains("ERROR_RESPONSE_TOO_LARGE"),"An oversized error was not reduced");
        Checks.Add("error diagnostics honor the exact smaller byte boundary");

        nativeFailure=new AutomationFault("DESKTOP_OUTCOME_UNKNOWN","INPUT_FAILED");nativeFailure.Data["diagnostics"]=new Dictionary<string,object>{{"text",PrivateMarker+new string('\u4e2d',100000)}};
        string omitted=AutomationJson.ErrorReply(Id,"window.action",nativeFailure);Failure(omitted,"DESKTOP_OUTCOME_UNKNOWN");
        Assert(omitted.Contains("ERROR_RESPONSE_TOO_LARGE") && Bytes(omitted)<1024,"Oversized diagnostics were not replaced with a small omission marker");
        Checks.Add("oversized error diagnostics are omitted while unknown input remains unknown");

        nativeFailure=new AutomationFault("DESKTOP_PROVIDER_FAILED");nativeFailure.Data["diagnostics"]=new ThrowingResult();
        Failure(AutomationJson.ErrorReply(Id,"window.observe",nativeFailure),"DESKTOP_PROVIDER_FAILED");
        Failure(AutomationJson.ErrorReply(Id,"window.action",new ThrowingMetadataException()),"DESKTOP_OUTCOME_UNKNOWN");
        Checks.Add("error serialization and even error-metadata access cannot leak provider text");

        nativeFailure=new AutomationFault(PrivateMarker,PrivateMarker+" invalid cause");
        string malformed=AutomationJson.ErrorReply(new string('\u0001',90000),"window.observe",nativeFailure);Failure(malformed,"DESKTOP_PROVIDER_FAILED");
        Assert((string)Parse(malformed)["id"]=="" && Bytes(malformed)<1024,"Malformed oversized correlation data escaped the error budget");
        Checks.Add("malformed failure identifiers and codes cannot make the fallback unbounded");

        Assert(AutomationJson.MaxRequestBytes==65536 && AutomationJson.RequestLineFits(new string('a',65536)) && !AutomationJson.RequestLineFits(new string('a',65537)),"ASCII request budget changed");
        Assert(AutomationJson.RequestLineFits(new string('\u4e2d',21845)) && !AutomationJson.RequestLineFits(new string('\u4e2d',21846)),"Multibyte request widened the 64 KiB limit");
        Checks.Add("requests remain limited to 64 KiB including multibyte text");

        Console.WriteLine(AutomationJson.Json.Serialize(new {ok=true,checks=Checks,metrics=new {maximumBytes=AutomationJson.MaxResponseBytes,errorMaximumBytes=AutomationJson.MaxErrorResponseBytes,newlineBytes=Encoding.UTF8.GetByteCount(Environment.NewLine),exactBytes=Bytes(exact),jpegBytes=jpeg.Length,jpegReplyBytes=Bytes(imageReply),combinedCharacters,combinedBytes}}));
        return 0;
    }
}
