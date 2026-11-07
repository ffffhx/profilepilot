using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using ProfilePilot.TcpPrototype;

public static class WindowsTcpPrototypeTests {
    sealed class FakeClock:IClock {public long Time;public long Milliseconds{get{return Time;}}}
    sealed class Step { public int Family; public uint Code,Size; public byte[] Bytes; public long Advance; }
    sealed class Api:ITableApi {
        public List<Step> Steps=new List<Step>();public int Calls;public FakeClock Clock=new FakeClock();
        public uint Query(int family,byte[] buffer,ref uint bytes) {
            if(Calls>=Steps.Count)throw new Exception("Unexpected API call");var step=Steps[Calls++];
            Equal(family,step.Family);Clock.Time+=step.Advance;
            if(buffer!=null && step.Bytes!=null)Array.Copy(step.Bytes,buffer,Math.Min(buffer.Length,step.Bytes.Length));bytes=step.Size;return step.Code;
        }
        public void Add(int family,byte[] bytes) {Steps.Add(new Step{Family=family,Code=122,Size=(uint)bytes.Length});Steps.Add(new Step{Family=family,Code=0,Size=(uint)bytes.Length,Bytes=bytes});}
    }
    static List<string> checks=new List<string>();
    static void Equal(object actual,object expected){if(!Object.Equals(actual,expected))throw new Exception("Expected "+expected+", actual "+actual);}
    static void Assert(bool value){if(!value)throw new Exception("Assertion failed");}
    static void Check(string name,Action run){run();checks.Add(name);}
    static Failure Throws(string code,Action run){try{run();}catch(Failure failure){Equal(failure.Code,code);return failure;}throw new Exception("Expected "+code);}
    static void U32(byte[] bytes,int offset,uint value){Array.Copy(BitConverter.GetBytes(value),0,bytes,offset,4);}
    static byte[] Table(int family,uint state=2,uint count=1) {
        var result=new byte[4+(int)count*(family==2?24:56)];U32(result,0,count);
        for(int i=0;i<count;i++) {int at=4+i*(family==2?24:56);U32(result,at+(family==2?0:48),state);U32(result,at+(family==2?20:52),42);
            U32(result,at+(family==2?8:20),0xabcd3412);if(family==2){result[at+4]=127;result[at+7]=1;}else result[at+15]=1;}
        return result;
    }
    static List<TcpRow> Parse(int family,byte[] bytes){int count;return Reader.Parse(family,bytes,(uint)bytes.Length,out count);}
    public static int Main() {
        try {
            Check("x64 SDK layout offsets and strides",delegate{Layout.Check();Equal(Layout.Offset(2),4);Equal(Layout.Offset(23),4);Equal(Layout.Stride(2),24);Equal(Layout.Stride(23),56);});
            Check("two valid empty families are complete",delegate{var api=new Api();api.Add(2,Table(2,1,0));api.Add(23,Table(23,1,0));var result=Reader.Read(api,new Budget(api.Clock,100));Equal(result.families.Count,2);Equal(result.families[0].rowCount,0);Equal(api.Calls,4);Assert(result.complete&&!result.processBirthJoined);});
            Check("IPv4 failure returns DWORD and never reports partial success",delegate{var api=new Api();api.Steps.Add(new Step{Family=2,Code=5});var e=Throws("TCP_PROTOTYPE_SIZE_QUERY_FAILED",delegate{Reader.Read(api,new Budget(api.Clock,100));});Equal(e.NativeReturn,(uint?)5);Equal(api.Calls,1);});
            Check("IPv6 failure invalidates successful IPv4",delegate{var api=new Api();api.Add(2,Table(2));api.Steps.Add(new Step{Family=23,Code=50});var e=Throws("TCP_PROTOTYPE_SIZE_QUERY_FAILED",delegate{Reader.Read(api,new Budget(api.Clock,100));});Equal(e.Stage,"tcp6");Equal(e.NativeReturn,(uint?)50);});
            Check("fill error preserves direct API DWORD",delegate{var api=new Api();api.Steps.Add(new Step{Family=2,Code=122,Size=28});api.Steps.Add(new Step{Family=2,Code=87,Size=28});Equal(Throws("TCP_PROTOTYPE_TABLE_FAILED",delegate{Reader.Read(api,new Budget(api.Clock,100));}).NativeReturn,(uint?)87);});
            Check("bounded resize discards previous buffer",delegate{var api=new Api();api.Steps.Add(new Step{Family=2,Code=122,Size=4});api.Steps.Add(new Step{Family=2,Code=122,Size=28});api.Steps.Add(new Step{Family=2,Code=0,Size=28,Bytes=Table(2)});api.Add(23,Table(23,1,0));var result=Reader.Read(api,new Budget(api.Clock,100));Equal(result.families[0].apiCalls,3);Equal(result.families[0].rowCount,1);});
            Check("resize exhausts exactly four fills",delegate{var api=new Api();for(int i=0;i<5;i++)api.Steps.Add(new Step{Family=2,Code=122,Size=28});Throws("TCP_PROTOTYPE_RESIZE_EXHAUSTED",delegate{Reader.Read(api,new Budget(api.Clock,100));});Equal(api.Calls,5);});
            Check("oversized requested buffer rejected before allocation",delegate{var api=new Api();api.Steps.Add(new Step{Family=2,Code=122,Size=UInt32.MaxValue});Throws("TCP_PROTOTYPE_TOO_LARGE",delegate{Reader.Read(api,new Budget(api.Clock,100));});Equal(api.Calls,1);});
            Check("null size-query success does not mean empty",delegate{var api=new Api();api.Steps.Add(new Step{Family=2,Code=0,Size=0});Throws("TCP_PROTOTYPE_SIZE_QUERY_FAILED",delegate{Reader.Read(api,new Budget(api.Clock,100));});});
            Check("short header fails",delegate{Throws("TCP_PROTOTYPE_TABLE_INVALID",delegate{Parse(2,new byte[3]);});});
            Check("returned size beyond allocation fails",delegate{int count;Throws("TCP_PROTOTYPE_TABLE_INVALID",delegate{Reader.Parse(2,new byte[4],8,out count);});});
            Check("count arithmetic cannot overflow",delegate{var bytes=new byte[4];U32(bytes,0,UInt32.MaxValue);Throws("TCP_PROTOTYPE_TOO_LARGE",delegate{Parse(2,bytes);});});
            Check("truncated count payload fails",delegate{var bytes=new byte[4];U32(bytes,0,1);Throws("TCP_PROTOTYPE_TABLE_INVALID",delegate{Parse(23,bytes);});});
            Check("reserved 100 is not guessed as BOUND",delegate{var e=Throws("TCP_PROTOTYPE_RESERVED_STATE",delegate{Parse(2,Table(2,100));});Equal(e.State,(uint?)100);});
            Check("unknown state is not silently filtered",delegate{foreach(uint state in new uint[]{0,13,UInt32.MaxValue})Throws("TCP_PROTOTYPE_UNKNOWN_STATE",delegate{Parse(23,Table(23,state));});});
            Check("known nonassociated states validated then omitted",delegate{foreach(uint state in new uint[]{1,3,4,6,7,8,9,10,11,12})Equal(Parse(2,Table(2,state)).Count,0);});
            Check("port upper DWORD bits are ignored",delegate{Equal(Reader.Port(0xabcd3412),0x1234);Equal(Reader.Port(0xffff0000),0);Equal(Reader.Port(0x1234ffff),65535);Equal(Parse(2,Table(2))[0].localPort,0x1234);});
            Check("IPv4 address byte order is preserved",delegate{Equal(Parse(2,Table(2))[0].localAddressHex,"7f000001");});
            Check("IPv6 raw nonzero scopes are never swapped",delegate{var bytes=Table(23,5);U32(bytes,4+16,0x01020304);U32(bytes,4+40,0xa1b2c3d4);var row=Parse(23,bytes)[0];Equal(row.localScopeRaw,(uint)0x01020304);Equal(row.remoteScopeRaw,(uint)0xa1b2c3d4);});
            Check("listener peer fields are explicitly normalized",delegate{var bytes=Table(23);for(int i=24;i<48;i++)bytes[4+i]=255;var row=Parse(23,bytes)[0];Equal(row.remotePort,0);Equal(row.remoteScopeRaw,(uint)0);Equal(row.remoteAddressHex,new string('0',32));Assert(!row.remoteMeaningful);});
            Check("two families share original deadline",delegate{var api=new Api();api.Add(2,Table(2));api.Add(23,Table(23));foreach(var step in api.Steps)step.Advance=1;var e=Throws("TCP_PROTOTYPE_TIMEOUT",delegate{Reader.Read(api,new Budget(api.Clock,4));});Equal(e.Stage,"tcp6");Equal(api.Calls,4);});
            Check("expired budget prevents first API call",delegate{var api=new Api();Throws("TCP_PROTOTYPE_TIMEOUT",delegate{Reader.Read(api,new Budget(api.Clock,0));});Equal(api.Calls,0);});
            Check("combined row cap applies across families",delegate{var api=new Api();api.Add(2,Table(2,1,65536));api.Add(23,Table(23,1,1));Throws("TCP_PROTOTYPE_TOO_LARGE",delegate{Reader.Read(api,new Budget(api.Clock,100));});});
            Check("prototype envelope is distinct and rejects production v1",delegate{string id="11111111-1111-4111-8111-111111111111";Equal(Wire.Request("{\"protocol\":\"profilepilot.windows-tcp-prototype\",\"version\":1,\"requestId\":\""+id+"\",\"operation\":\"tcp\",\"params\":{}}\n"),id);Throws("TCP_PROTOTYPE_REQUEST_INVALID",delegate{Wire.Request("{\"version\":1,\"requestId\":\""+id+"\",\"operation\":\"snapshot\",\"params\":{}}");});});
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,checks=checks,nativeCalls=0,guiStarted=false,hooksInstalled=false}));return 0;
        }catch(Exception error){Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=false,error=error.Message,checks=checks}));return 1;}
    }
}
