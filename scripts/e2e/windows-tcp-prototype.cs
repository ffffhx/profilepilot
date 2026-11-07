using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Independent read-only experiment. This is NOT WindowsSampler v1 and does
// not hold process handles while reading TCP or certify process birth joins.
namespace ProfilePilot.TcpPrototype {
    public sealed class Failure : Exception {
        public readonly string Code, Stage;
        public readonly uint? NativeReturn, State;
        public Failure(string code, string stage, uint? nativeReturn = null, uint? state = null) : base(code) {
            Code=code; Stage=stage; NativeReturn=nativeReturn; State=state;
        }
        public object Wire() { var result=new Dictionary<string,object>{{"code",Code},{"stage",Stage}};
            if(NativeReturn.HasValue)result.Add("nativeReturn",NativeReturn.Value); if(State.HasValue)result.Add("state",State.Value); return result; }
    }
    public interface IClock { long Milliseconds { get; } }
    public sealed class Clock : IClock { readonly Stopwatch clock=Stopwatch.StartNew(); public long Milliseconds { get { return clock.ElapsedMilliseconds; } } }
    public sealed class Budget {
        readonly IClock clock; readonly long deadline;
        public Budget(IClock clock,long milliseconds) { this.clock=clock; deadline=checked(clock.Milliseconds+milliseconds); }
        public long Now { get { return clock.Milliseconds; } }
        public void Check(string stage) { if(clock.Milliseconds>=deadline)throw new Failure("TCP_PROTOTYPE_TIMEOUT",stage); }
    }
    public interface ITableApi { uint Query(int family,byte[] buffer,ref uint bytes); }
    [StructLayout(LayoutKind.Sequential)] public struct Row4 { public uint State,LocalAddress,LocalPort,RemoteAddress,RemotePort,Pid; }
    [StructLayout(LayoutKind.Sequential)] public struct Row6 {
        [MarshalAs(UnmanagedType.ByValArray,SizeConst=16)] public byte[] LocalAddress;
        public uint LocalScope,LocalPort;
        [MarshalAs(UnmanagedType.ByValArray,SizeConst=16)] public byte[] RemoteAddress;
        public uint RemoteScope,RemotePort,State,Pid;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Table4 { public uint Count; public Row4 FirstEntry; }
    [StructLayout(LayoutKind.Sequential)] public struct Table6 { public uint Count; public Row6 FirstEntry; }
    public static class Layout {
        public static int Offset(int family) { return Marshal.OffsetOf(family==2?typeof(Table4):typeof(Table6),"FirstEntry").ToInt32(); }
        public static int Stride(int family) { return Marshal.SizeOf(family==2?typeof(Row4):typeof(Row6)); }
        public static void Check() {
            if(!BitConverter.IsLittleEndian || IntPtr.Size!=8 || Offset(2)!=4 || Offset(23)!=4 || Stride(2)!=24 || Stride(23)!=56 ||
                Marshal.OffsetOf(typeof(Row4),"Pid").ToInt32()!=20 || Marshal.OffsetOf(typeof(Row6),"Pid").ToInt32()!=52)
                throw new Failure("TCP_PROTOTYPE_ABI_UNSUPPORTED","abi");
        }
    }
    public sealed class TcpRow {
        public int family; public uint state,pid; public int localPort,remotePort;
        // Raw address bytes in network order. No DNS or scope normalization.
        public string localAddressHex,remoteAddressHex;
        public uint localScopeRaw,remoteScopeRaw;
        public bool remoteMeaningful;
    }
    public sealed class TableResult {
        public int family,apiCalls,bufferBytes,rowCount; public long elapsedMs;
        public List<TcpRow> rows=new List<TcpRow>();
    }
    public sealed class Result {
        public bool complete=true,processBirthJoined=false;
        public string scopeEncoding="raw-DWORD-uninterpreted";
        public List<TableResult> families=new List<TableResult>();
        public double elapsedMs;
    }
    public static class Reader {
        public const int MaxBufferBytes=8*1024*1024, MaxRows=65536, MaxFillAttempts=4;
        public const uint InsufficientBuffer=122;
        static uint U32(byte[] value,int at) { return BitConverter.ToUInt32(value,at); }
        public static int Port(uint value) { return (int)(((value&255)<<8)|((value>>8)&255)); }
        static string Hex(byte[] value,int at,int count) { var text=new StringBuilder(count*2);for(int i=0;i<count;i++)text.Append(value[at+i].ToString("x2",CultureInfo.InvariantCulture));return text.ToString(); }
        public static List<TcpRow> Parse(int family,byte[] bytes,uint returnedBytes,out int count) {
            if(family!=2 && family!=23)throw new Failure("TCP_PROTOTYPE_FAMILY_INVALID","parse");
            Layout.Check(); string stage=family==2?"tcp4":"tcp6";
            int offset=Layout.Offset(family),stride=Layout.Stride(family);
            if(bytes==null || returnedBytes>bytes.Length || returnedBytes<offset)throw new Failure("TCP_PROTOTYPE_TABLE_INVALID",stage);
            uint rows=U32(bytes,0);
            if(rows>MaxRows)throw new Failure("TCP_PROTOTYPE_TOO_LARGE",stage);
            if((ulong)offset+(ulong)rows*(uint)stride>returnedBytes)throw new Failure("TCP_PROTOTYPE_TABLE_INVALID",stage);
            count=(int)rows;var result=new List<TcpRow>();
            for(int i=0;i<count;i++) {
                int at=checked(offset+i*stride); uint state=U32(bytes,at+(family==2?0:48));
                if(state==100)throw new Failure("TCP_PROTOTYPE_RESERVED_STATE",stage,null,state);
                if(state<1 || state>12)throw new Failure("TCP_PROTOTYPE_UNKNOWN_STATE",stage,null,state);
                // Validate the entire table before selecting the two states
                // consumed by ProfilePilot. Reserved is NOT guessed as BOUND.
                if(state!=2 && state!=5)continue;
                var row=new TcpRow { family=family,state=state,pid=U32(bytes,at+(family==2?20:52)),
                    localPort=Port(U32(bytes,at+(family==2?8:20))),remoteMeaningful=state!=2,
                    localAddressHex=Hex(bytes,at+(family==2?4:0),family==2?4:16),
                    localScopeRaw=family==2?0:U32(bytes,at+16) };
                // LISTEN has no meaningful peer: do not expose padding or
                // unspecified peer fields as if they were real endpoints.
                row.remoteAddressHex=state==2?new string('0',family==2?8:32):Hex(bytes,at+(family==2?12:24),family==2?4:16);
                row.remotePort=state==2?0:Port(U32(bytes,at+(family==2?16:44)));
                row.remoteScopeRaw=state==2 || family==2?0:U32(bytes,at+40);
                result.Add(row);
            }
            return result;
        }
        static TableResult ReadFamily(ITableApi api,int family,Budget budget) {
            string stage=family==2?"tcp4":"tcp6";long began=budget.Now;
            uint bytes=0;budget.Check(stage);uint code=api.Query(family,null,ref bytes);budget.Check(stage);
            var result=new TableResult {family=family,apiCalls=1};
            if(code!=InsufficientBuffer)throw new Failure("TCP_PROTOTYPE_SIZE_QUERY_FAILED",stage,code);
            for(int attempt=0;attempt<MaxFillAttempts;attempt++) {
                budget.Check(stage);
                if(bytes<Layout.Offset(family))throw new Failure("TCP_PROTOTYPE_TABLE_INVALID",stage);
                if(bytes>MaxBufferBytes)throw new Failure("TCP_PROTOTYPE_TOO_LARGE",stage);
                var buffer=new byte[(int)bytes];uint returned=bytes;
                code=api.Query(family,buffer,ref returned);result.apiCalls++;budget.Check(stage);
                if(code==InsufficientBuffer) { bytes=returned;continue; }
                // GetExtendedTcpTable returns its error DWORD directly. Never
                // use Marshal.GetLastWin32Error to replace this value.
                if(code!=0)throw new Failure("TCP_PROTOTYPE_TABLE_FAILED",stage,code);
                int count;result.rows=Parse(family,buffer,returned,out count);result.rowCount=count;
                result.bufferBytes=buffer.Length;result.elapsedMs=budget.Now-began;return result;
            }
            throw new Failure("TCP_PROTOTYPE_RESIZE_EXHAUSTED",stage,code);
        }
        public static Result Read(ITableApi api,Budget budget) {
            Layout.Check();var result=new Result();long began=budget.Now;int count=0;
            foreach(int family in new int[]{2,23}) {
                var table=ReadFamily(api,family,budget);count=checked(count+table.rowCount);
                if(count>MaxRows)throw new Failure("TCP_PROTOTYPE_TOO_LARGE","tcp_total");result.families.Add(table);
            }
            budget.Check("complete");result.elapsedMs=budget.Now-began;return result;
        }
    }
    public sealed class WindowsTables : ITableApi {
        [DllImport("iphlpapi.dll",ExactSpelling=true)] static extern uint GetExtendedTcpTable(IntPtr buffer,ref uint bytes,[MarshalAs(UnmanagedType.Bool)]bool order,uint family,uint tableClass,uint reserved);
        public uint Query(int family,byte[] buffer,ref uint bytes) {
            if(buffer==null)return GetExtendedTcpTable(IntPtr.Zero,ref bytes,false,(uint)family,5,0);
            var pinned=GCHandle.Alloc(buffer,GCHandleType.Pinned);
            try{return GetExtendedTcpTable(pinned.AddrOfPinnedObject(),ref bytes,false,(uint)family,5,0);}finally{pinned.Free();}
        }
    }
    public static class Wire {
        public const string Protocol="profilepilot.windows-tcp-prototype";
        public const int RequestBytes=4096,ResponseBytes=32*1024*1024;
        public static string Request(string text) {
            // Canonical prototype-only request, deliberately no permissive
            // JSON aliases/duplicates/extra operations or production v1 reuse.
            var match=Regex.Match(text,"^\\{\"protocol\":\"profilepilot.windows-tcp-prototype\",\"version\":1,\"requestId\":\"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\",\"operation\":\"tcp\",\"params\":\\{\\}\\}\\n?$");
            if(!match.Success || match.Groups[1].Value==Guid.Empty.ToString())throw new Failure("TCP_PROTOTYPE_REQUEST_INVALID","protocol");
            return match.Groups[1].Value;
        }
        public static byte[] Reply(string id,object result,Failure error,object identity) {
            var value=new Dictionary<string,object>{{"protocol",Protocol},{"version",1},{"requestId",id},{"operation","tcp"},{"ok",error==null},{"identity",identity}};
            value.Add(error==null?"result":"error",error==null?result:error.Wire());
            var serializer=new JavaScriptSerializer {MaxJsonLength=ResponseBytes,RecursionLimit=32};
            byte[] bytes=new UTF8Encoding(false,true).GetBytes(serializer.Serialize(value)+"\n");
            if(bytes.Length>ResponseBytes)throw new Failure("TCP_PROTOTYPE_RESPONSE_TOO_LARGE","serialize");return bytes;
        }
    }
    public static class Program {
        [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr process,uint exitCode);
        [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int length,out int needed);
        [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
        [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
        static uint TokenValue(IntPtr token,int kind) {
            int needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);
            if(needed<=0 || needed>4096)throw new Failure("TCP_PROTOTYPE_TOKEN_UNKNOWN","identity");
            IntPtr data=Marshal.AllocHGlobal(needed);
            try {
                if(!GetTokenInformation(token,kind,data,needed,out needed))throw new Failure("TCP_PROTOTYPE_TOKEN_UNKNOWN","identity");
                if(kind!=25)return unchecked((uint)Marshal.ReadInt32(data));
                IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if(count==0)throw new Failure("TCP_PROTOTYPE_TOKEN_UNKNOWN","identity");
                return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)count-1)));
            }finally{Marshal.FreeHGlobal(data);}
        }
        static object Identity() {
            using(var process=Process.GetCurrentProcess()) {
                IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new Failure("TCP_PROTOTYPE_TOKEN_UNKNOWN","identity");
                try {
                    uint rid=TokenValue(token,25),elevated=TokenValue(token,20),ui=TokenValue(token,26);
                    if(rid!=8192 || elevated!=0 || ui!=0)throw new Failure("TCP_PROTOTYPE_MEDIUM_REQUIRED","identity");
                    string file=process.MainModule.FileName,sha;using(var algorithm=SHA256.Create())using(var input=File.OpenRead(file))sha=BitConverter.ToString(algorithm.ComputeHash(input)).Replace("-","").ToLowerInvariant();
                    return new {pid=process.Id,startedUtcTicks=process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),executable=file,sha256=sha,integrityRid=rid,elevated=false,uiAccess=false};
                }finally{CloseHandle(token);}
            }
        }
        public static int Main(string[] args) {
            string id=null;object result=null,identity=null;Failure failure=null;
            // The actual acceptance parent additionally enforces its original
            // deadline and waits for child close. This is not a hard RT bound.
            using(var watchdog=new System.Threading.Timer(delegate { TerminateProcess(GetCurrentProcess(),2); },null,10000,System.Threading.Timeout.Infinite)) {
                try {
                    if(args.Length!=0)throw new Failure("TCP_PROTOTYPE_REQUEST_INVALID","protocol");
                    var input=Console.OpenStandardInput();var bytes=new List<byte>();int next;
                    while((next=input.ReadByte())!=-1){if(bytes.Count>=Wire.RequestBytes)throw new Failure("TCP_PROTOTYPE_REQUEST_TOO_LARGE","protocol");bytes.Add((byte)next);}
                    id=Wire.Request(new UTF8Encoding(false,true).GetString(bytes.ToArray()));identity=Identity();
                    var timing=Stopwatch.StartNew();var tcp=Reader.Read(new WindowsTables(),new Budget(new Clock(),8000));
                    tcp.elapsedMs=timing.Elapsed.TotalMilliseconds;result=tcp;
                }catch(Failure error){failure=error;}catch{failure=new Failure("TCP_PROTOTYPE_UNAVAILABLE","unknown");}
                try {byte[] output=Wire.Reply(id,result,failure,identity);Console.OpenStandardOutput().Write(output,0,output.Length);}
                catch{return 2;}return failure==null?0:2;
            }
        }
    }
}
