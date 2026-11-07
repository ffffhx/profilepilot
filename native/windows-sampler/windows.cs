using System;
using System.Collections.Generic;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

namespace ProfilePilot.WindowsSampler {
    [StructLayout(LayoutKind.Sequential)]
    struct NativeTime { public int Low, High; public string Value { get { return Identity.FromParts(High,Low); } } }
    sealed class ProcessHandle : IProcessHandle {
        IntPtr handle;
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out NativeTime creation,out NativeTime exit,out NativeTime kernel,out NativeTime user);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder image,ref uint length);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
        static QueryFailure Error(){return new QueryFailure(unchecked((uint)Marshal.GetLastWin32Error()));}
        public ProcessHandle(uint pid) {
            handle=OpenProcess(0x1000|0x00100000,false,pid);
            if(handle==IntPtr.Zero)throw Error();
        }
        public string CreationFileTime() {
            NativeTime creation,exit,kernel,user;
            if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user))throw Error();
            return creation.Value;
        }
        public bool IsAlive() {
            uint wait=WaitForSingleObject(handle,0);
            if(wait==0)return false;if(wait==258)return true;
            if(wait==UInt32.MaxValue)throw Error();throw new QueryFailure(13);
        }
        public string ImagePath() {
            var image=new StringBuilder(Limits.Text);uint size=(uint)image.Capacity;
            if(!QueryFullProcessImageName(handle,0,image,ref size))throw Error();return image.ToString();
        }
        public void Dispose() {
            if(handle==IntPtr.Zero)return;IntPtr closing=handle;handle=IntPtr.Zero;
            if(!CloseHandle(closing))throw Error();
        }
    }
    public sealed class WindowsProcesses : IProcessProvider {
        [DllImport("psapi.dll",SetLastError=true)] static extern bool EnumProcesses([Out]uint[] ids,uint bytes,out uint needed);
        public IList<uint> EnumerateIds(Budget budget) {
            int capacity=1024;
            for(;;) {
                budget.Check("process_enumeration");var ids=new uint[capacity];uint needed;
                if(!EnumProcesses(ids,(uint)(ids.Length*4),out needed))throw new Failure("WINDOWS_SAMPLER_ENUMERATE_FAILED","process_enumeration",null,unchecked((uint)Marshal.GetLastWin32Error()));
                if(needed%4!=0 || needed>ids.Length*4)throw new Failure("WINDOWS_SAMPLER_PROCESS_INVALID","process_enumeration");
                if(needed<ids.Length*4) {
                    if(needed/4>Limits.Processes)throw new Failure("WINDOWS_SAMPLER_PROCESS_LIMIT","process_enumeration");
                    var result=new List<uint>();for(int i=0;i<needed/4;i++)result.Add(ids[i]);return result;
                }
                if(capacity>Limits.Processes)throw new Failure("WINDOWS_SAMPLER_PROCESS_LIMIT","process_enumeration");
                capacity=Math.Min(capacity*2,Limits.Processes+1);
            }
        }
        public IProcessHandle Open(uint pid){return new ProcessHandle(pid);}
        static string Value(ManagementBaseObject row,string name) { object value=row[name];return value==null?null:Convert.ToString(value,CultureInfo.InvariantCulture); }
        public IList<CimRow> ReadCim(Budget budget) {
            var result=new List<CimRow>();
            // This timeout is cooperative/provider-dependent. The parent must
            // enforce an absolute child deadline and confirm its actual exit.
            var options=new EnumerationOptions { ReturnImmediately=true, Rewindable=false, Timeout=TimeSpan.FromMilliseconds(budget.Remaining) };
            using(var search=new ManagementObjectSearcher(new ManagementScope("\\\\.\\root\\cimv2"),
                new ObjectQuery("SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process"),options))
            using(var rows=search.Get()) foreach(ManagementBaseObject row in rows) using(row) {
                budget.Check("process_cim");if(result.Count>=Limits.Processes)throw new Failure("WINDOWS_SAMPLER_PROCESS_LIMIT","process_cim");
                string command=Value(row,"CommandLine"),started=null,date=Value(row,"CreationDate");
                if(date!=null)try{started=ManagementDateTimeConverter.ToDateTime(date).ToUniversalTime().ToString("o",CultureInfo.InvariantCulture);}catch{ }
                // CreationDate is display-only. It never supplies or repairs
                // the GetProcessTimes creation identity.
                if(row["ProcessId"]==null || row["ParentProcessId"]==null)throw new Failure("WINDOWS_SAMPLER_CIM_INVALID","process_cim");
                result.Add(new CimRow { Pid=Convert.ToUInt32(row["ProcessId"],CultureInfo.InvariantCulture),
                    ParentPid=Convert.ToUInt32(row["ParentProcessId"],CultureInfo.InvariantCulture),Name=Value(row,"Name"),
                    ExecutablePath=Value(row,"ExecutablePath"),CommandLine=command,
                    CommandLineAvailable=!String.IsNullOrEmpty(command),StartedAt=started });
            }
            return result;
        }
    }
    public sealed class WindowsRestartManager : IRestartProvider {
        public IRestartSession Start(){return new RestartSession();}
        sealed class RestartSession : IRestartSession {
            [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public uint Pid;public NativeTime Started; }
            [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessInfo {
                public UniqueProcess Process;
                [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)]public string AppName;
                [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)]public string ServiceName;
                public uint ApplicationType,AppStatus,SessionId;
                [MarshalAs(UnmanagedType.Bool)]public bool Restartable;
            }
            [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern uint RmStartSession(out uint handle,uint flags,StringBuilder key);
            [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern uint RmRegisterResources(uint handle,uint files,string[] names,uint applications,IntPtr processes,uint services,string[] serviceNames);
            [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint handle,out uint needed,ref uint count,[In,Out]ProcessInfo[] entries,ref uint reasons);
            [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint handle);
            uint handle;bool opened;
            public RestartSession() {
                uint status=RmStartSession(out handle,0,new StringBuilder(33));
                if(status!=0)throw new Failure("WINDOWS_SAMPLER_RM_START_FAILED","rm_start",null,status);opened=true;
            }
            public void Register(string path) {
                uint status=RmRegisterResources(handle,1,new[]{path},0,IntPtr.Zero,0,null);
                if(status!=0)throw new Failure("WINDOWS_SAMPLER_RM_REGISTER_FAILED","rm_register",null,status);
            }
            public LockReply Query(uint capacity) {
                if(capacity>Limits.LockRows)throw new Failure("WINDOWS_SAMPLER_RM_INVALID","rm_list");
                ProcessInfo[] entries=capacity==0?null:new ProcessInfo[capacity];uint needed,count=capacity,reasons=0;
                uint status=RmGetList(handle,out needed,ref count,entries,ref reasons);
                var result=new LockReply {Status=status,Needed=needed,Count=count,Rows=new List<LockIdentity>()};
                // Do not read partial/error rows or marshal a count beyond the
                // buffer. The pure reader validates every returned count.
                if(status==0 && count<=capacity)for(int i=0;i<count;i++)result.Rows.Add(new LockIdentity {
                    Pid=entries[i].Process.Pid,CreationFileTime=entries[i].Process.Started.Value });
                return result;
            }
            public void Dispose(){if(!opened)return;opened=false;uint status=RmEndSession(handle);if(status!=0)throw new Failure("WINDOWS_SAMPLER_RM_END_FAILED","rm_end",null,status);}
        }
    }
}
