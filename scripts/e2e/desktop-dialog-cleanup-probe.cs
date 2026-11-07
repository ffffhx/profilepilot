using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Standalone diagnostic only. The sole allowed client belongs to the retained
// U1qhiK acceptance report. No Show, event subscription, history enumeration or
// registry API is called. This executable is not part of the product build.
public static class DesktopDialogCleanupProbe {
    public const string AllowedClient = "121dfac2-3b7b-cd9c-745a-4c9e181e2aee";
    public interface IRawDialog : IDisposable { int SetClientGuid(Guid client); int ClearClientData(); }
    public sealed class Failure { public string stage,type;public int hresult; }
    public sealed class Result {
        public string clientGuid=AllowedClient;
        public int? initializeHresult,createHresult,setClientGuidHresult,clearClientDataHresult,rcwFinalReleaseCount;
        public bool disposeAttempted,disposeReturned,rawInterfaceAcquired,rawInterfaceReleased,rcwAcquired,rcwReleased,comUninitialized;
        public bool showCalled=false,adviseCalled=false,historyAbsenceAsserted=false;
        public List<Failure> failures=new List<Failure>();
    }
    static Failure Error(string stage,Exception error){return new Failure{stage=stage,type=error.GetType().FullName,hresult=error.HResult};}
    // Pure-test seam. Failure/unknown outcomes never re-create or retry. Only
    // exact S_OK from SetClientGuid permits the one scoped clear call.
    public static Result Run(string client,Func<Result,IRawDialog> create) {
        if(client!=AllowedClient)throw new ArgumentException("Only the retained owned client GUID is accepted");
        var result=new Result();IRawDialog dialog=null;string stage="create";
        try {
            dialog=create(result);if(dialog==null)throw new InvalidOperationException("No dialog interface");
            stage="SetClientGuid";result.setClientGuidHresult=dialog.SetClientGuid(new Guid(client));
            if(result.setClientGuidHresult==0){stage="ClearClientData";result.clearClientDataHresult=dialog.ClearClientData();}
        }catch(Exception error){result.failures.Add(Error(stage,error));}
        finally{if(dialog!=null){result.disposeAttempted=true;try{dialog.Dispose();result.disposeReturned=true;}catch(Exception error){result.failures.Add(Error("Dispose",error));}}}
        return result;
    }
    [DllImport("ole32.dll",PreserveSig=true)]static extern int CoInitializeEx(IntPtr reserved,uint flags);
    [DllImport("ole32.dll")]static extern void CoUninitialize();
    [DllImport("ole32.dll",PreserveSig=true)]static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out IntPtr value);
    sealed class NativeDialog:IRawDialog {
        readonly Result result;IntPtr raw;IFileDialog dialog;bool initialized,disposed;
        public NativeDialog(Result result) {
            this.result=result;
            try {
                int hr=CoInitializeEx(IntPtr.Zero,2);result.initializeHresult=hr;
                if(hr<0)Marshal.ThrowExceptionForHR(hr);initialized=true;
                Guid clsid=new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"),iid=typeof(IFileDialog).GUID;
                hr=CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out raw);result.createHresult=hr;result.rawInterfaceAcquired=raw!=IntPtr.Zero;
                if(hr!=0)throw new COMException("CoCreateInstance did not return S_OK",hr);
                if(raw==IntPtr.Zero)throw new InvalidOperationException("Null dialog pointer");
                dialog=(IFileDialog)Marshal.GetTypedObjectForIUnknown(raw,typeof(IFileDialog));result.rcwAcquired=true;
            }catch{Dispose();throw;}
        }
        public int SetClientGuid(Guid client){return dialog.SetClientGuid(ref client);}
        public int ClearClientData(){return dialog.ClearClientData();}
        public void Dispose() {
            if(disposed)return;disposed=true;
            try{if(dialog!=null){result.rcwFinalReleaseCount=Marshal.FinalReleaseComObject(dialog);result.rcwReleased=result.rcwFinalReleaseCount==0;}}
            catch(Exception error){result.failures.Add(Error("FinalReleaseComObject",error));}
            finally {
                try{if(raw!=IntPtr.Zero){Marshal.Release(raw);raw=IntPtr.Zero;result.rawInterfaceReleased=true;}}
                catch(Exception error){result.failures.Add(Error("ReleaseRawInterface",error));}
                finally{if(initialized){CoUninitialize();initialized=false;result.comUninitialized=true;}}
            }
        }
    }
    // HRESULT ABI and slots mirror the SDK IFileDialogVtbl (Show slot 3,
    // SetClientGuid 24, ClearClientData 25). Unused pointers remain IntPtr; no
    // string or ShellItem data is requested by this diagnostic.
    [ComImport,Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialog {
        [PreserveSig]int Show(IntPtr parent);
        [PreserveSig]int SetFileTypes(uint count,IntPtr filters);[PreserveSig]int SetFileTypeIndex(uint index);[PreserveSig]int GetFileTypeIndex(out uint index);
        [PreserveSig]int Advise(IntPtr events,out uint cookie);[PreserveSig]int Unadvise(uint cookie);[PreserveSig]int SetOptions(uint options);[PreserveSig]int GetOptions(out uint options);
        [PreserveSig]int SetDefaultFolder(IntPtr folder);[PreserveSig]int SetFolder(IntPtr folder);[PreserveSig]int GetFolder(out IntPtr folder);[PreserveSig]int GetCurrentSelection(out IntPtr item);
        [PreserveSig]int SetFileName(IntPtr name);[PreserveSig]int GetFileName(out IntPtr name);[PreserveSig]int SetTitle(IntPtr title);[PreserveSig]int SetOkButtonLabel(IntPtr text);[PreserveSig]int SetFileNameLabel(IntPtr label);
        [PreserveSig]int GetResult(out IntPtr item);[PreserveSig]int AddPlace(IntPtr item,uint placement);[PreserveSig]int SetDefaultExtension(IntPtr extension);
        [PreserveSig]int Close(int result);[PreserveSig]int SetClientGuid(ref Guid client);[PreserveSig]int ClearClientData();[PreserveSig]int SetFilter(IntPtr filter);
    }
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
    [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    static IntPtr Information(IntPtr token,int kind){int needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);if(needed<1||needed>65536)throw new InvalidOperationException();var data=Marshal.AllocHGlobal(needed);if(!GetTokenInformation(token,kind,data,needed,out needed)){Marshal.FreeHGlobal(data);throw new InvalidOperationException();}return data;}
    static int Number(IntPtr token,int kind){IntPtr data=Information(token,kind);try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
    static void RequireMedium(){using(var p=Process.GetCurrentProcess()){IntPtr token;if(!OpenProcessToken(p.Handle,8,out token))throw new InvalidOperationException();try{
        IntPtr data=Information(token,25);int rid;try{IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(count==0)throw new InvalidOperationException();rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{Marshal.FreeHGlobal(data);}
        if(rid!=8192||Number(token,20)!=0||Number(token,26)!=0)throw new InvalidOperationException("Ordinary Medium token required");
    }finally{CloseHandle(token);}}}
    static string file,nonce,birth,reason;static int pid;static volatile bool closing,mainEnded,comFinished;static long comStarted;
    static void Write(string suffix,object value){string name=file+suffix,temp=name+".new";File.WriteAllText(temp,new JavaScriptSerializer().Serialize(value),new UTF8Encoding(false));if(File.Exists(name))File.Replace(temp,name,null);else File.Move(temp,name);}
    static bool Token(string suffix,string value){try{return File.ReadAllText(file+suffix)==value;}catch(IOException){return false;}}
    static void Watch(){var watch=Stopwatch.StartNew();while(!mainEnded){
        try {
            if(!closing && Token(".close",nonce)){reason="requested";closing=true;}
            if(!closing && (watch.ElapsedMilliseconds>90000||!File.Exists(file+".heartbeat")||DateTime.UtcNow-File.GetLastWriteTimeUtc(file+".heartbeat")>TimeSpan.FromSeconds(30))){reason="heartbeat_or_ttl";closing=true;}
            long started=Interlocked.Read(ref comStarted);
            if(started!=0&&!comFinished&&(Stopwatch.GetTimestamp()-started)*1000.0/Stopwatch.Frequency>15000){
                try{Write(".failure.json",new{nonce,pid,startedUtcTicks=birth,code="COM_CALL_DEADLINE",forced=true,normalReleaseConfirmed=false});}finally{Environment.Exit(3);}
            }
        }catch{reason="watcher_failure";closing=true;}Thread.Sleep(20);
    }}
    [STAThread]public static int Main(string[] args){
        if(args.Length!=4||args[0]!="--armed"||!System.Text.RegularExpressions.Regex.IsMatch(args[2],"^[a-f0-9]{32}$")||args[3]!=AllowedClient)return 2;
        file=Path.GetFullPath(args[1]);nonce=args[2];Result result=null;bool attempted=false;
        try {
            RequireMedium();using(var p=Process.GetCurrentProcess()){pid=p.Id;birth=p.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);}
            Write(".ready.json",new{nonce,pid,startedUtcTicks=birth,clientGuid=AllowedClient,protocol="profilepilot.dialog-cleanup-probe",apartment=Thread.CurrentThread.GetApartmentState().ToString(),comAttempted=false});
            var watcher=new Thread(Watch);watcher.IsBackground=true;watcher.Start();
            while(!closing&&!Token(".go",nonce+":"+AllowedClient))Thread.Sleep(20);
            if(!closing){attempted=true;Interlocked.Exchange(ref comStarted,Stopwatch.GetTimestamp());
                try{result=Run(AllowedClient,value=>new NativeDialog(value));}finally{comFinished=true;}
                Write(".result.json",new{nonce,pid,startedUtcTicks=birth,clientGuid=AllowedClient,result});
            }
            while(!closing)Thread.Sleep(20);
            Write(".closed.json",new{nonce,pid,startedUtcTicks=birth,clientGuid=AllowedClient,reason,comAttempted=attempted,comFinished,
                normalReleaseConfirmed=!attempted || result!=null&&result.disposeReturned&&result.failures.Count==0&&result.rcwReleased&&result.rawInterfaceReleased&&result.comUninitialized});
            return reason=="requested"?0:1;
        }catch(Exception error){try{Write(".failure.json",new{nonce,pid,startedUtcTicks=birth,stage="probe",hresult=error.HResult,forced=false});}catch{}return 2;}
        finally{mainEnded=true;}
    }
}
