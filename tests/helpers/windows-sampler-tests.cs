using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ProfilePilot.WindowsSampler;

// Links only model.cs + protocol.cs. This assembly has no P/Invoke, WMI,
// Restart Manager, process enumeration, GUI, hook or input implementation.
public static class WindowsSamplerTests {
    static readonly List<string> Checks=new List<string>();
    const string Birth="134377839627263613", OtherBirth="134377839627263614";
    const string Id="1cec77a4-1582-4ab7-a1d8-c972c6cda96b";
    static void Check(string name,Action body){try{body();Checks.Add(name);}catch(Exception error){throw new Exception(name,error);}}
    static void Equal<T>(T expected,T actual){if(!Object.Equals(expected,actual))throw new Exception("Expected "+expected+", got "+actual);}
    static void True(bool condition){if(!condition)throw new Exception("Assertion failed");}
    static Failure Fails(Action action,string code=null) {
        try{action();}catch(Failure failure){if(code!=null)Equal(code,failure.Code);return failure;}
        throw new Exception("Expected Failure");
    }
    static Dictionary<string,object> ObjectAt(object value){return (Dictionary<string,object>)value;}
    static Dictionary<string,object> First(Dictionary<string,object> value){return ObjectAt(((List<object>)value["processes"])[0]);}
    sealed class Clock:IClock { public long Now;public long Milliseconds{get{return Now;}} }
    sealed class Handle:IProcessHandle {
        public string Birth=WindowsSamplerTests.Birth,Image="C:\\Owned\\fallback.exe";
        public readonly Queue<object> Alive=new Queue<object>();
        public Exception BirthError,ImageError,CloseError;public bool Closed;public int Closes;
        public string CreationFileTime(){if(BirthError!=null)throw BirthError;return Birth;}
        public bool IsAlive(){if(Alive.Count==0)return true;object next=Alive.Dequeue();if(next is Exception)throw (Exception)next;return (bool)next;}
        public string ImagePath(){if(ImageError!=null)throw ImageError;return Image;}
        public void Dispose(){Closes++;Closed=true;if(CloseError!=null)throw CloseError;}
    }
    sealed class Processes:IProcessProvider {
        public IList<uint> Ids=new uint[]{42};public IList<CimRow> Rows=new[]{Row(42)};
        public readonly Dictionary<uint,Handle> Handles=new Dictionary<uint,Handle>{{42,new Handle()}};
        public readonly Dictionary<uint,Exception> OpenErrors=new Dictionary<uint,Exception>();
        public readonly List<uint> Opens=new List<uint>();
        public Action BeforeCim,OnOpen;public Exception CimError;public int CimCalls;
        public IList<uint> EnumerateIds(Budget budget){return Ids;}
        public IProcessHandle Open(uint pid){Opens.Add(pid);if(OnOpen!=null)OnOpen();Exception error;if(OpenErrors.TryGetValue(pid,out error))throw error;return Handles[pid];}
        public IList<CimRow> ReadCim(Budget budget){CimCalls++;if(BeforeCim!=null)BeforeCim();if(CimError!=null)throw CimError;return Rows;}
    }
    static CimRow Row(uint pid){return new CimRow{Pid=pid,ParentPid=0,Name="owned.exe",ExecutablePath="C:\\Owned\\owned.exe",CommandLine="owned.exe",CommandLineAvailable=true,StartedAt="2026-10-29T13:46:02.7263610Z"};}
    static Dictionary<string,object> Snapshot(Processes provider,Clock clock=null){return SnapshotSampler.Run(provider,new Budget(clock??new Clock()));}
    sealed class Session:IRestartSession {
        public readonly Queue<LockReply> Replies=new Queue<LockReply>();public readonly List<uint> Capacities=new List<uint>();
        public Exception RegisterError,CloseError;public Action OnQuery;public bool Closed;public int Closes;
        public void Register(string path){if(RegisterError!=null)throw RegisterError;}
        public LockReply Query(uint capacity){Capacities.Add(capacity);if(OnQuery!=null)OnQuery();return Replies.Dequeue();}
        public void Dispose(){Closed=true;Closes++;if(CloseError!=null)throw CloseError;}
    }
    sealed class Restart:IRestartProvider {
        public readonly Queue<Session> Sessions=new Queue<Session>();public Exception StartError;public int Starts;
        public IRestartSession Start(){Starts++;if(StartError!=null)throw StartError;return Sessions.Dequeue();}
    }
    static LockReply Reply(uint status,uint needed,uint count,params LockIdentity[] rows){return new LockReply{Status=status,Needed=needed,Count=count,Rows=rows};}
    static LockIdentity Lock(uint pid=42,string birth=Birth){return new LockIdentity{Pid=pid,CreationFileTime=birth};}
    static Session With(params LockReply[] replies){var value=new Session();foreach(var reply in replies)value.Replies.Enqueue(reply);return value;}
    static Dictionary<string,object> Locks(Session session,Clock clock=null){var source=new Restart();source.Sessions.Enqueue(session);return FileLockSampler.Run(source,new[]{"C:\\Owned\\file"},new Budget(clock??new Clock()));}
    static Request Parse(string text){return Protocol.Parse(Encoding.UTF8.GetBytes(text),new Header());}
    static string Request(string operation="snapshot",string parameters="{}") {return "{\"version\":1,\"requestId\":\""+Id+"\",\"operation\":\""+operation+"\",\"params\":"+parameters+"}";}
    static Dictionary<string,object> Decode(byte[] data){return ObjectAt(new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(data)));}
    public static void Main() {
        Check("raw FILETIME combines unsigned halves without Number/Date",delegate{
            Equal("18446744073709551615",Identity.FromParts(-1,-1));Equal("4294967295",Identity.FromParts(0,-1));
            True(Identity.Valid(Birth));True(Identity.Valid(OtherBirth));True(Identity.Valid("18446744073709551615"));
            foreach(string value in new[]{null,"","0","01","+1"," 1","1.0","1e1","18446744073709551616"})True(!Identity.Valid(value));
        });
        Check("snapshot pins all handles before CIM and closes all after output",delegate{
            var source=new Processes{Ids=new uint[]{42,43},Rows=new[]{Row(42),Row(43)}};source.Handles.Add(43,new Handle{Birth=OtherBirth});
            source.BeforeCim=delegate{Equal(2,source.Opens.Count);foreach(var h in source.Handles.Values)True(!h.Closed);};
            var value=Snapshot(source);Equal(true,value["complete"]);Equal(Birth,(string)First(value)["creationFileTime"]);
            foreach(var h in source.Handles.Values){True(h.Closed);Equal(1,h.Closes);}
        });
        Check("CIM-added PID stays not_pinned; no post-query open or birth repair",delegate{
            var source=new Processes{Rows=new[]{Row(99)}};var row=First(Snapshot(source));
            Equal("unavailable",row["identityStatus"]);Equal("not_pinned",row["identityReason"]);Equal(null,row["creationFileTime"]);
            Equal(1,source.Opens.Count);Equal((uint)42,source.Opens[0]);True(source.Handles[42].Closed);
        });
        Check("unreadable High/PPL-like row remains present and unavailable",delegate{
            var source=new Processes();source.OpenErrors.Add(42,new QueryFailure(5));var row=First(Snapshot(source));
            Equal("unavailable",row["identityStatus"]);Equal("open_failed",row["identityReason"]);Equal((uint)5,row["identityWin32Error"]);Equal(null,row["creationFileTime"]);
        });
        Check("birth failures never use CIM display time",delegate{
            var source=new Processes();source.Handles[42].BirthError=new QueryFailure(5);var row=First(Snapshot(source));
            Equal("birth_failed",row["identityReason"]);Equal(null,row["creationFileTime"]);True(source.Handles[42].Closed);
            source=new Processes();source.Handles[42].Birth="0";Equal("birth_failed",First(Snapshot(source))["identityReason"]);
        });
        Check("exit during CIM revokes exact identity without opening a replacement",delegate{
            var source=new Processes();source.Handles[42].Alive.Enqueue(true);source.Handles[42].Alive.Enqueue(false);
            var row=First(Snapshot(source));Equal("exited",row["identityReason"]);Equal(null,row["creationFileTime"]);Equal(1,source.Opens.Count);
        });
        Check("failed process wait is unknown, never an exited or readable process",delegate{
            var source=new Processes();source.Handles[42].Alive.Enqueue(new QueryFailure(6));var row=First(Snapshot(source));
            Equal("wait_failed",row["identityReason"]);Equal((uint)6,row["identityWin32Error"]);Equal(null,row["creationFileTime"]);
        });
        Check("image fallback uses the pinned handle and never invents command-line access",delegate{
            var source=new Processes();source.Rows[0].ExecutablePath=null;source.Rows[0].CommandLine=null;source.Rows[0].CommandLineAvailable=false;
            var row=First(Snapshot(source));Equal("C:\\Owned\\fallback.exe",row["executablePath"]);Equal(false,row["commandLineAvailable"]);Equal(row["executablePath"],row["commandLine"]);
            source=new Processes();source.Rows[0].ExecutablePath=null;source.OpenErrors.Add(42,new QueryFailure(5));Equal(null,First(Snapshot(source))["executablePath"]);
        });
        Check("CIM exception closes every pin and does not expose provider text",delegate{
            var source=new Processes{CimError=new Exception("C:\\Secret\\profile --secret-command")};var failure=Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_PROVIDER_FAILED");
            Equal("process_cim",failure.Stage);True(source.Handles[42].Closed);
            string error=Encoding.UTF8.GetString(Protocol.Error(new Header(),failure));True(!error.Contains("Secret"));True(!error.Contains("command"));
        });
        Check("cleanup failures preserve the original failure and all closes are attempted",delegate{
            var source=new Processes{Ids=new uint[]{42,43},CimError=new Failure("WINDOWS_SAMPLER_CIM_INVALID","process_cim")};
            source.Handles.Add(43,new Handle{CloseError=new QueryFailure(6)});source.Handles[42].CloseError=new QueryFailure(5);
            var failure=Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_CIM_INVALID");True(failure.CleanupFailed);Equal((uint?)6,failure.CleanupWin32Error);
            foreach(var h in source.Handles.Values)Equal(1,h.Closes);
        });
        Check("close failure cannot yield a successful snapshot",delegate{
            var source=new Processes();source.Handles[42].CloseError=new QueryFailure(6);var failure=Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_CLEANUP_FAILED");Equal("process_close",failure.Stage);True(failure.CleanupFailed);
        });
        Check("deadline during pin or CIM releases handles without a replacement query",delegate{
            var clock=new Clock();var source=new Processes();source.OnOpen=delegate{clock.Now=8000;};Fails(delegate{Snapshot(source,clock);},"WINDOWS_SAMPLER_DEADLINE");Equal(0,source.CimCalls);True(source.Handles[42].Closed);
            clock=new Clock();source=new Processes();source.BeforeCim=delegate{clock.Now=8000;};Fails(delegate{Snapshot(source,clock);},"WINDOWS_SAMPLER_DEADLINE");Equal(1,source.CimCalls);True(source.Handles[42].Closed);
        });
        Check("duplicate enumeration and duplicate CIM rows are rejected",delegate{
            var source=new Processes{Ids=new uint[]{42,42}};Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_PROCESS_INVALID");Equal(0,source.Opens.Count);
            source=new Processes{Rows=new[]{Row(42),Row(42)}};Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_CIM_INVALID");True(source.Handles[42].Closed);
        });
        Check("CIM output limits and malformed Unicode fail rather than truncate",delegate{
            var source=new Processes();source.Rows[0].Name=new string('x',513);Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_CIM_INVALID");True(source.Handles[42].Closed);
            source=new Processes();source.Rows[0].CommandLine="bad\ud800";Fails(delegate{Snapshot(source);},"WINDOWS_SAMPLER_CIM_INVALID");
        });
        Check("RM success retains exact raw identities and closes its session",delegate{
            var session=With(Reply(234,1,0),Reply(0,1,1,Lock()));var value=Locks(session);Equal(true,value["complete"]);
            Equal(Birth,ObjectAt(((List<object>)value["rows"])[0])["creationFileTime"]);True(session.Closed);Equal(1,session.Closes);Equal("0,1",String.Join(",",session.Capacities));
        });
        Check("RM duplicate same birth deduplicates; conflicting birth fails",delegate{
            var session=With(Reply(234,2,0),Reply(0,2,2,Lock(),Lock()));Equal(1,((List<object>)Locks(session)["rows"]).Count);
            session=With(Reply(234,2,0),Reply(0,2,2,Lock(),Lock(42,OtherBirth)));var error=Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_IDENTITY_CONFLICT");Equal((uint?)42,error.Pid);True(session.Closed);
        });
        Check("conflicting births across requested files reject the whole result",delegate{
            var source=new Restart();var first=With(Reply(234,1,0),Reply(0,1,1,Lock()));var second=With(Reply(234,1,0),Reply(0,1,1,Lock(42,OtherBirth)));
            source.Sessions.Enqueue(first);source.Sessions.Enqueue(second);Fails(delegate{FileLockSampler.Run(source,new[]{"C:\\Owned\\one","C:\\Owned\\two"},new Budget(new Clock()));},"WINDOWS_SAMPLER_IDENTITY_CONFLICT");True(first.Closed);True(second.Closed);
        });
        Check("RM growing list ignores partial identities and bounds retries",delegate{
            var session=With(Reply(234,1,0),Reply(234,2,1,Lock(0,"bad")),Reply(0,2,2,Lock(),Lock(43,OtherBirth)));
            Equal(2,((List<object>)Locks(session)["rows"]).Count);Equal("0,1,2",String.Join(",",session.Capacities));
            session=With(Reply(234,1,0),Reply(234,2,1),Reply(234,3,2),Reply(234,4,3));
            var failure=Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_RM_LIST_FAILED");Equal((uint?)234,failure.Win32Error);Equal(4,session.Capacities.Count);True(session.Closed);
        });
        Check("RM malformed capacity, zero identity and overflow do not appear as empty",delegate{
            foreach(var session in new[]{With(Reply(234,0,0)),With(Reply(234,16385,0)),With(Reply(234,1,0),Reply(0,2,1,Lock())),
                With(Reply(234,1,0),Reply(0,1,2,Lock(),Lock())),With(Reply(234,1,0),Reply(0,1,1,Lock(42,"0")))}){
                Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_RM_INVALID");True(session.Closed);
            }
        });
        Check("RM start/register/list/cleanup failures retain their stage and release owned session",delegate{
            var source=new Restart{StartError=new Failure("WINDOWS_SAMPLER_RM_START_FAILED","rm_start",null,5)};
            Fails(delegate{FileLockSampler.Run(source,new[]{"C:\\Owned\\one"},new Budget(new Clock()));},"WINDOWS_SAMPLER_RM_START_FAILED");
            var session=With();session.RegisterError=new Failure("WINDOWS_SAMPLER_RM_REGISTER_FAILED","rm_register",null,5);session.CloseError=new QueryFailure(6);
            var error=Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_RM_REGISTER_FAILED");True(error.CleanupFailed);Equal((uint?)6,error.CleanupWin32Error);True(session.Closed);
            session=With(Reply(5,0,0));Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_RM_LIST_FAILED");True(session.Closed);
            session=With(Reply(0,0,0));session.CloseError=new QueryFailure(6);Fails(delegate{Locks(session);},"WINDOWS_SAMPLER_CLEANUP_FAILED");
        });
        Check("RM deadline closes the session and empty input starts no session",delegate{
            var clock=new Clock();var session=With(Reply(0,0,0));session.OnQuery=delegate{clock.Now=8000;};Fails(delegate{Locks(session,clock);},"WINDOWS_SAMPLER_DEADLINE");True(session.Closed);
            var provider=new Restart();Equal(0,((List<object>)FileLockSampler.Run(provider,new string[0],new Budget(new Clock()))["rows"]).Count);Equal(0,provider.Starts);
        });
        Check("aggregate RM output cap applies across otherwise valid files",delegate{
            var firstRows=new LockIdentity[8192];var nextRows=new LockIdentity[8193];
            for(uint i=0;i<firstRows.Length;i++)firstRows[i]=Lock(i+1);
            for(uint i=0;i<nextRows.Length;i++)nextRows[i]=Lock(i+8193);
            var first=With(Reply(234,8192,0),Reply(0,8192,8192,firstRows));
            var second=With(Reply(234,8193,0),Reply(0,8193,8193,nextRows));
            var provider=new Restart();provider.Sessions.Enqueue(first);provider.Sessions.Enqueue(second);
            Fails(delegate{FileLockSampler.Run(provider,new[]{"C:\\Owned\\one","C:\\Owned\\two"},new Budget(new Clock()));},"WINDOWS_SAMPLER_ROW_LIMIT");True(first.Closed);True(second.Closed);
        });
        Check("protocol accepts only v1 operation-specific fields and canonical UUID",delegate{
            Equal("snapshot",Parse(Request()).Operation);Equal(0,Parse(Request("fileLocks","{\"paths\":[]}")).Paths.Count);
            Equal("C:\\Owned\\file",Parse(Request("fileLocks","{\"paths\":[\"C:\\\\Owned\\\\file\"]}")).Paths[0]);
            foreach(string text in new[]{Request().Replace("\"version\":1","\"version\":2"),Request().Replace(Id,Id.ToUpperInvariant()),Request("other"),
                Request("snapshot","{\"paths\":[]}"),Request("fileLocks"),Request().Replace("\"params\":{}","\"params\":{},\"extra\":1")})Fails(delegate{Parse(text);},"WINDOWS_SAMPLER_BAD_REQUEST");
        });
        Check("duplicate escaped keys and non-JSON primitive syntax are rejected",delegate{
            foreach(string text in new[]{Request().Replace("\"version\":1","\"version\":1,\"version\":1"),
                Request().Replace("\"version\":1","\"version\":1,\"\\u0076ersion\":1"),Request().Replace("\"version\":1","\"version\":01"),
                Request().Replace("\"version\":1","\"version\":+1"),Request().Replace("\"version\":1","\"version\":1.0"),
                Request().Replace("snapshot","snap\\x73hot")})Fails(delegate{Parse(text);},"WINDOWS_SAMPLER_BAD_REQUEST");
        });
        Check("one UTF8 request refuses extra frames, truncated UTF8 and oversized stdin",delegate{
            Equal("snapshot",Parse(Request()+"\r\n").Operation);
            foreach(string text in new[]{Request()+"\n\n",Request()+"\n"+Request(),"\ufeff"+Request(),Request()+"\0"})Fails(delegate{Parse(text);},"WINDOWS_SAMPLER_BAD_REQUEST");
            Fails(delegate{Protocol.Parse(new byte[]{0xc3},new Header());},"WINDOWS_SAMPLER_BAD_REQUEST");
            Fails(delegate{Protocol.Read(new MemoryStream(new byte[Limits.RequestBytes+1]));},"WINDOWS_SAMPLER_REQUEST_TOO_LARGE");
        });
        Check("paths require bounded unique absolute Unicode strings",delegate{
            foreach(string parameters in new[]{"{\"paths\":[\"relative\"]}","{\"paths\":[\"C:relative\"]}","{\"paths\":[null]}",
                "{\"paths\":[\"C:\\\\one\",\"C:\\\\one\"]}","{\"paths\":[\"C:\\\\bad\\u0001\"]}","{\"paths\":[\"C:\\\\bad\\ud800\"]}"})Fails(delegate{Parse(Request("fileLocks",parameters));},"WINDOWS_SAMPLER_BAD_REQUEST");
            var paths=new List<string>();for(int i=0;i<257;i++)paths.Add("C:\\Owned\\"+i);
            string many=new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"paths",paths}});Fails(delegate{Parse(Request("fileLocks",many));},"WINDOWS_SAMPLER_BAD_REQUEST");
        });
        Check("valid escaped supplementary and CJK paths retain exact identity",delegate{
            var value=Parse(Request("fileLocks","{\"paths\":[\"C:\\\\Owned\\\\\\ud83d\\ude80\\u4e2d.txt\"]}"));
            Equal("C:\\Owned\\\ud83d\ude80\u4e2d.txt",value.Paths[0]);
            Equal("\\\\server\\share\\file",Parse(Request("fileLocks","{\"paths\":[\"\\\\\\\\server\\\\share\\\\file\"]}")).Paths[0]);
        });
        Check("response budget counts UTF8 bytes including one newline, never truncates JSON",delegate{
            var header=new Header{RequestId=Id,Operation="snapshot"};var result=new Dictionary<string,object>{{"text",new string('\u4e2d',100)}};
            byte[] bytes=Protocol.Success(header,result);Equal((byte)'\n',bytes[bytes.Length-1]);Equal(true,Decode(bytes)["ok"]);
            True(bytes.Length>Encoding.UTF8.GetString(bytes).Length);
            Fails(delegate{Protocol.Success(header,result,bytes.Length-1);},"WINDOWS_SAMPLER_RESPONSE_TOO_LARGE");
            Equal(bytes.Length,Protocol.Success(header,result,bytes.Length).Length);
        });
        Check("error envelope is bounded and cannot echo raw exception paths or command text",delegate{
            var header=new Header{RequestId=Id,Operation="fileLocks"};var error=Failure.Safe(new Exception("C:\\Secret --token=secret"),"rm_list");
            byte[] bytes=Protocol.Error(header,error);True(bytes.Length<4096);string text=Encoding.UTF8.GetString(bytes);True(!text.Contains("Secret"));True(!text.Contains("token"));Equal(false,Decode(bytes)["ok"]);
            Equal("WINDOWS_SAMPLER_INTERNAL_ERROR",ObjectAt(Decode(Protocol.Error(header,new Failure("secret","path")))["error"])["code"]);
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,checks=Checks,nativeCalls=0,guiStarted=false,hooksInstalled=false}));
    }
}
