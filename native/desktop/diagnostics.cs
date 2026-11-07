using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ProfilePilot.Desktop {
    // Read-only metadata: no titles, document text, command lines or user SIDs.
    // Integrity compatibility is one input restriction, not proof that Windows
    // will allow activation or input injection.
    public static class DesktopDiagnostics {
        public sealed class Integrity {
            public int? rid;
            public string label="unknown";
            public bool? elevated;
            public bool? uiAccess;
            public int? error;
        }
        [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
        [StructLayout(LayoutKind.Sequential)] struct GuiThread {
            public int Size,Flags;
            public IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret;
            public Rect CaretBounds;
        }
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern void SetLastError(uint code);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,ref GuiThread info);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder value,int count);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out uint value,int length);

        static int? TokenNumber(IntPtr token,int kind,Integrity result){
            int length;GetTokenInformation(token,kind,IntPtr.Zero,0,out length);
            if(length<=0 || length>65536){result.error=Marshal.GetLastWin32Error();return null;}
            IntPtr data=Marshal.AllocHGlobal(length);
            try{
                if(!GetTokenInformation(token,kind,data,length,out length)){result.error=Marshal.GetLastWin32Error();return null;}
                if(kind!=25)return Marshal.ReadInt32(data);
                IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if(count==0){result.error=13;return null;}
                return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)count-1));
            }finally{Marshal.FreeHGlobal(data);}
        }
        public static Integrity ProcessIntegrity(int pid){
            var result=new Integrity();
            if(pid<=0){result.error=87;return result;}
            IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero;
            if(process==IntPtr.Zero){result.error=Marshal.GetLastWin32Error();return result;}
            try{
                if(!OpenProcessToken(process,8,out token)){result.error=Marshal.GetLastWin32Error();return result;}
                result.rid=TokenNumber(token,25,result);
                int? elevation=TokenNumber(token,20,result),access=TokenNumber(token,26,result);
                if(elevation.HasValue)result.elevated=elevation.Value!=0;
                if(access.HasValue)result.uiAccess=access.Value!=0;
                if(result.rid.HasValue){
                    int rid=result.rid.Value;
                    result.label=rid>=16384?"system":rid>=12288?"high":rid>=8448?"medium-plus":rid>=8192?"medium":rid>=4096?"low":"untrusted";
                }
            }finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
            return result;
        }
        public static bool? Cloaked(IntPtr window){
            try{uint value;return DwmGetWindowAttribute(window,14,out value,4)==0?(bool?)(value!=0):null;}
            catch(DllNotFoundException){return null;}
            catch(EntryPointNotFoundException){return null;}
        }
        static Dictionary<string,object> Window(IntPtr window,string id=null){
            uint pid;uint thread=GetWindowThreadProcessId(window,out pid);
            var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
            var result=new Dictionary<string,object>{{"hwnd",window.ToInt64().ToString()},{"pid",pid},{"threadId",thread},{"className",name.ToString()},
                {"integrity",ProcessIntegrity((int)pid)},{"visible",IsWindowVisible(window)},{"minimized",IsIconic(window)},{"cloaked",Cloaked(window)}};
            if(id!=null)result["windowId"]=id;
            Rect bounds;if(GetWindowRect(window,out bounds))result["bounds"]=new[]{bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top};
            return result;
        }
        static Dictionary<string,object> Queue(uint thread){
            var state=new GuiThread{Size=Marshal.SizeOf(typeof(GuiThread))};
            bool available=thread!=0 && GetGUIThreadInfo(thread,ref state);
            var result=new Dictionary<string,object>{{"flags",state.Flags},{"inMenuMode",(state.Flags&0x1c)!=0},
                {"inMoveSize",(state.Flags&2)!=0},{"hasCapture",state.Capture!=IntPtr.Zero},{"active",state.Active.ToInt64().ToString()},
                {"focus",state.Focus.ToInt64().ToString()},{"menuOwner",state.MenuOwner.ToInt64().ToString()}};
            if(!available)result["error"]=thread==0?87:Marshal.GetLastWin32Error();
            return result;
        }
        public static Dictionary<string,object> Snapshot(IntPtr target,string id=null){
            int pid;using(var process=Process.GetCurrentProcess())pid=process.Id;
            var source=ProcessIntegrity(pid);
            var foreground=Window(GetForegroundWindow());
            var result=new Dictionary<string,object>{
                {"source",new {pid,threadId=GetCurrentThreadId(),integrity=source}},
                {"foreground",foreground},{"foregroundState",Queue((uint)foreground["threadId"])},
                {"interactiveDesktop",DesktopHost.IsInteractiveDesktop()},{"integrityCompatible",null}
            };
            if(target!=IntPtr.Zero){
                var targetWindow=Window(target,id);result["target"]=targetWindow;
                var destination=(Integrity)targetWindow["integrity"];
                if(source.rid.HasValue && destination.rid.HasValue)result["integrityCompatible"]=source.rid.Value>=destination.rid.Value || source.uiAccess==true;
            }
            return result;
        }
        public static AutomationFault Fault(string code,string cause,Dictionary<string,object> diagnostics){
            var fault=new AutomationFault(code,cause);fault.Data["diagnostics"]=diagnostics;return fault;
        }
        public static bool? PossibleUipi(Dictionary<string,object> diagnostics){
            object compatible;
            if(diagnostics.TryGetValue("integrityCompatible",out compatible) && compatible is bool && !(bool)compatible)return true;
            // Equal integrity cannot establish the cause of SendInput failure.
            return null;
        }
    }
}
