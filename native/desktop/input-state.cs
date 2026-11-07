using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace ProfilePilot.Desktop {
    // Read-only, Windows-only observations. This module never activates a window,
    // injects input, releases a key, installs a hook, or changes desktop access.
    public static class DesktopInputState {
        [Flags] public enum Gap {
            None=0,UnsupportedPlatform=1,TargetUnavailable=2,ForegroundUnavailable=4,
            DesktopAccessUnknown=8,DesktopNotInteractive=16,IntegrityUnknown=32,
            ForegroundIntegrityHigher=64,QueueUnavailable=128,CaptureUnavailable=256,
            ContextChanged=512,KeyStateChanged=1024,InvalidKeyRequest=2048,CollectionTooSlow=4096
        }
        [Flags] public enum Limitation {
            None=0,CurrentStateNotInputOrigin=1,ForegroundAndTargetQueuesOnly=2,
            NonAtomic=4,SameKeyTakeoverNotDistinguishable=8,ZeroMayMeanReadFailure=16
        }
        public const Limitation Limits=Limitation.CurrentStateNotInputOrigin|Limitation.ForegroundAndTargetQueuesOnly|
            Limitation.NonAtomic|Limitation.SameKeyTakeoverNotDistinguishable|Limitation.ZeroMayMeanReadFailure;
        // Mouse VKs are physical button identities as returned by GetAsyncKeyState.
        // Generic SHIFT/CTRL/ALT are deliberately absent: they lose side identity.
        static readonly int[] ProtectedKeys={1,2,4,5,6,91,92,160,161,162,163,164,165};
        public static int[] ProtectedKeyCodes(){return (int[])ProtectedKeys.Clone();}

        public sealed class QueueSnapshot {
            public uint ThreadId;
            public bool Available;
            public int? Error;
            public int Flags;
            public IntPtr Capture;
            public bool CaptureIsTargetOrChild;
        }
        public sealed class AccessSnapshot {
            public bool? CallingDesktopActive,ForegroundDesktopActive,TargetDesktopActive,DefaultInputDesktop;
            public bool DesktopReadAccess;
            public int? SourceIntegrity,ForegroundIntegrity,SourceIntegrityError,ForegroundIntegrityError,DesktopError;
        }
        public sealed class Snapshot {
            public bool Supported;
            public IntPtr Target,Foreground;
            public uint TargetPid,ForegroundPid;
            public QueueSnapshot TargetQueue,ForegroundQueue;
            public AccessSnapshot Access;
            public bool MouseButtonsSwapped;
            public int[] ProbedKeys=new int[0],DownKeys=new int[0];
            public Gap Gaps;
            public Limitation Limitations=Limits;
            public long StartedTimestamp,CompletedTimestamp;
        }
        public sealed class Ownership {
            public IntPtr Target;
            // Only this action's successfully inserted AND subsequently observed
            // down exact VKs belong here: SendInput may return before async state
            // updates. Never populate this set from arbitrary observed down keys.
            // Generic modifier VKs and logical mouse button names are invalid.
            public int[] ConfirmedDownKeys=new int[0];
            // Unknown or not-yet-observed SendInput attempts may require caller
            // cleanup, but cannot authorize continuation. Cleanup is external.
            public int[] UncertainDownKeys=new int[0];
            public bool AllowTargetCapture;
            public bool? InitialMouseButtonsSwapped;
        }
        public sealed class Decision {
            public bool Allowed;
            public string Code,Reason;
            public int[] ConflictingKeys=new int[0];
            public IntPtr Capture;
            public Gap Gaps;
        }

        [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
        [StructLayout(LayoutKind.Sequential)] struct GuiThread {
            public int Size,Flags;
            public IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret;
            public Rect CaretBounds;
        }
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,ref GuiThread state);
        [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",SetLastError=true)]
        static extern bool DesktopActive(IntPtr desktop,int index,out int value,int length,out int needed);
        [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern bool DesktopName(IntPtr desktop,int index,StringBuilder value,int length,out int needed);

        static bool IsMouse(int key){return key==1 || key==2 || key==4 || key==5 || key==6;}
        static bool ExactKey(int key){return key>0 && key<255 && key!=16 && key!=17 && key!=18;}
        static bool ValidKeys(int[] keys){
            if(keys==null || keys.Length>32)return false;
            foreach(int key in keys)if(!ExactKey(key))return false;
            return true;
        }
        static int[] Sorted(HashSet<int> values){var result=new int[values.Count];values.CopyTo(result);Array.Sort(result);return result;}
        static bool SameKeys(int[] a,int[] b){
            if(a.Length!=b.Length)return false;
            for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;
            return true;
        }
        static Decision Deny(string code,string reason,Gap gaps=Gap.None){return new Decision{Code=code,Reason=reason,Gaps=gaps};}

        // Pure access predicate. Equal/lower foreground integrity is evidence
        // against a documented failure cause, not proof of every OS condition.
        // No caller-provided "assume readable" flag enters the native reader.
        public static Gap AccessGaps(AccessSnapshot access){
            if(access==null)return Gap.DesktopAccessUnknown|Gap.IntegrityUnknown;
            Gap gaps=Gap.None;
            if(!access.DesktopReadAccess || !access.CallingDesktopActive.HasValue || !access.ForegroundDesktopActive.HasValue ||
                !access.TargetDesktopActive.HasValue || !access.DefaultInputDesktop.HasValue)gaps|=Gap.DesktopAccessUnknown;
            if(access.CallingDesktopActive==false || access.ForegroundDesktopActive==false || access.TargetDesktopActive==false ||
                access.DefaultInputDesktop==false)gaps|=Gap.DesktopNotInteractive;
            if(!access.SourceIntegrity.HasValue || !access.ForegroundIntegrity.HasValue)gaps|=Gap.IntegrityUnknown;
            else if(access.SourceIntegrity.Value<access.ForegroundIntegrity.Value)gaps|=Gap.ForegroundIntegrityHigher;
            return gaps;
        }

        // Pure decision. Initial checks use no ownership and must run before
        // version consumption, activation or movement. After dispatch, re-read
        // immediately before each next event; never cache a successful decision.
        public static Decision Evaluate(Snapshot snapshot,Ownership ownership=null){
            if(snapshot==null)return Deny("DESKTOP_INPUT_STATE_UNKNOWN","missing_snapshot");
            if(!snapshot.Supported)return Deny("DESKTOP_UNSUPPORTED","windows_only",Gap.UnsupportedPlatform);
            Gap gaps=snapshot.Gaps|AccessGaps(snapshot.Access);
            if(snapshot.Target==IntPtr.Zero || snapshot.TargetQueue==null || snapshot.TargetQueue.ThreadId==0)gaps|=Gap.TargetUnavailable;
            if(snapshot.Foreground==IntPtr.Zero || snapshot.ForegroundQueue==null || snapshot.ForegroundQueue.ThreadId==0)gaps|=Gap.ForegroundUnavailable;
            if(snapshot.TargetQueue==null || !snapshot.TargetQueue.Available || snapshot.ForegroundQueue==null || !snapshot.ForegroundQueue.Available)gaps|=Gap.QueueUnavailable;
            if(!ValidKeys(snapshot.ProbedKeys) || !ValidKeys(snapshot.DownKeys))gaps|=Gap.InvalidKeyRequest;
            if(gaps!=Gap.None)return Deny("DESKTOP_INPUT_STATE_UNKNOWN","incomplete_snapshot",gaps);
            var probed=new HashSet<int>(snapshot.ProbedKeys);
            var down=new HashSet<int>(snapshot.DownKeys);
            foreach(int key in ProtectedKeys)if(!probed.Contains(key))return Deny("DESKTOP_INPUT_STATE_UNKNOWN","protected_key_not_sampled");
            if(!down.IsSubsetOf(probed))return Deny("DESKTOP_INPUT_STATE_UNKNOWN","down_key_not_sampled");
            var owned=new HashSet<int>();
            if(ownership!=null){
                if(ownership.Target!=snapshot.Target || !ValidKeys(ownership.ConfirmedDownKeys) || !ValidKeys(ownership.UncertainDownKeys))
                    return Deny("DESKTOP_INPUT_STATE_UNKNOWN","invalid_ownership");
                if(ownership.UncertainDownKeys.Length!=0)return Deny("DESKTOP_INPUT_STATE_UNKNOWN","unconfirmed_input_attempt");
                owned.UnionWith(ownership.ConfirmedDownKeys);
                if(!owned.IsSubsetOf(probed))return Deny("DESKTOP_INPUT_STATE_UNKNOWN","owned_key_not_sampled");
            }
            var foreign=new HashSet<int>(down);foreign.ExceptWith(owned);
            if(foreign.Count!=0){var result=Deny("DESKTOP_INPUT_CONFLICT","unowned_key_down");result.ConflictingKeys=Sorted(foreign);return result;}
            var released=new HashSet<int>(owned);released.ExceptWith(down);
            if(released.Count!=0){var result=Deny("DESKTOP_INPUT_STATE_CHANGED","owned_key_released");result.ConflictingKeys=Sorted(released);return result;}
            bool ownMouse=false;foreach(int key in owned)if(IsMouse(key))ownMouse=true;
            if(ownMouse && (!ownership.InitialMouseButtonsSwapped.HasValue || ownership.InitialMouseButtonsSwapped.Value!=snapshot.MouseButtonsSwapped))
                return Deny("DESKTOP_INPUT_STATE_UNKNOWN","mouse_mapping_unverified_or_changed");
            foreach(var queue in new[]{snapshot.ForegroundQueue,snapshot.TargetQueue}){
                if((queue.Flags&2)!=0)return Deny("DESKTOP_INPUT_CONFLICT","window_move_or_size_in_progress");
                if(queue.Capture==IntPtr.Zero)continue;
                if(ownership!=null && ownership.AllowTargetCapture && ownMouse && queue.CaptureIsTargetOrChild)continue;
                var result=Deny("DESKTOP_INPUT_CONFLICT","unexpected_mouse_capture");result.Capture=queue.Capture;return result;
            }
            return new Decision{Allowed=true};
        }

        static bool? ActiveDesktop(uint thread,AccessSnapshot access){
            if(thread==0)return null;
            IntPtr desktop=GetThreadDesktop(thread);int value,needed;
            if(desktop==IntPtr.Zero || !DesktopActive(desktop,6,out value,4,out needed)){
                access.DesktopError=Marshal.GetLastWin32Error();return null;
            }
            // GetThreadDesktop returns a borrowed handle; do not close it.
            return value!=0;
        }
        static AccessSnapshot ReadAccess(uint sourcePid,uint sourceThread,uint foregroundPid,uint foregroundThread,uint targetThread){
            var result=new AccessSnapshot();
            result.CallingDesktopActive=ActiveDesktop(sourceThread,result);
            result.ForegroundDesktopActive=ActiveDesktop(foregroundThread,result);
            result.TargetDesktopActive=ActiveDesktop(targetThread,result);
            // Request the documented GetAsyncKeyState desktop prerequisite.
            // Opening for access verification does not install a hook.
            IntPtr input=OpenInputDesktop(0,false,0x0001|0x0008);
            if(input==IntPtr.Zero)result.DesktopError=Marshal.GetLastWin32Error();
            else try{
                result.DesktopReadAccess=true;
                var name=new StringBuilder(256);int needed;
                if(DesktopName(input,2,name,name.Capacity*2,out needed))result.DefaultInputDesktop=String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);
                else result.DesktopError=Marshal.GetLastWin32Error();
            }finally{CloseDesktop(input);}
            var source=DesktopDiagnostics.ProcessIntegrity((int)sourcePid);
            var foreground=sourcePid==foregroundPid?source:DesktopDiagnostics.ProcessIntegrity((int)foregroundPid);
            result.SourceIntegrity=source.rid;result.SourceIntegrityError=source.error;
            result.ForegroundIntegrity=foreground.rid;result.ForegroundIntegrityError=foreground.error;
            return result;
        }
        static QueueSnapshot ReadQueue(uint thread,IntPtr target,ref Gap gaps){
            var result=new QueueSnapshot{ThreadId=thread};
            var state=new GuiThread{Size=Marshal.SizeOf(typeof(GuiThread))};
            if(thread==0 || !GetGUIThreadInfo(thread,ref state)){
                result.Error=thread==0?87:Marshal.GetLastWin32Error();gaps|=Gap.QueueUnavailable;return result;
            }
            result.Available=true;result.Flags=state.Flags;result.Capture=state.Capture;
            if(state.Capture!=IntPtr.Zero){
                if(!IsWindow(state.Capture))gaps|=Gap.CaptureUnavailable;
                else result.CaptureIsTargetOrChild=state.Capture==target || IsChild(target,state.Capture);
            }
            return result;
        }
        static bool SameQueue(QueueSnapshot a,QueueSnapshot b){
            return a.Available==b.Available && a.Capture==b.Capture && a.CaptureIsTargetOrChild==b.CaptureIsTargetOrChild && (a.Flags&0x1e)==(b.Flags&0x1e);
        }
        static int[] ReadDown(int[] keys){
            var down=new List<int>();
            // Only the high bit is current state. The historical low bit is not
            // reliable and cannot establish user input or helper ownership.
            foreach(int key in keys)if(GetAsyncKeyState(key)<0)down.Add(key);
            return down.ToArray();
        }

        // additionalKeys must include every non-protected key that this action
        // may press, before its initial check, plus any owned key while running.
        // Use exact VKs; Unicode packets have no useful ownership VK here.
        // All unknown reads fail closed. These observations cannot distinguish
        // physical/injected input, prove other queues have no capture, or close
        // the race between reading state and dispatching the next event.
        public static Snapshot Read(IntPtr target,int[] additionalKeys=null){
            var result=new Snapshot{Target=target,StartedTimestamp=Stopwatch.GetTimestamp(),Supported=Environment.OSVersion.Platform==PlatformID.Win32NT};
            if(!result.Supported){result.Gaps=Gap.UnsupportedPlatform;result.CompletedTimestamp=Stopwatch.GetTimestamp();return result;}
            if(additionalKeys==null)additionalKeys=new int[0];
            if(!ValidKeys(additionalKeys)){result.Gaps=Gap.InvalidKeyRequest;result.CompletedTimestamp=Stopwatch.GetTimestamp();return result;}
            var keys=new HashSet<int>(ProtectedKeys);keys.UnionWith(additionalKeys);result.ProbedKeys=Sorted(keys);
            // Keep sampling bounded even when an internal caller supplies too
            // many distinct additional keys.
            if(result.ProbedKeys.Length>32){result.Gaps=Gap.InvalidKeyRequest;result.CompletedTimestamp=Stopwatch.GetTimestamp();return result;}
            try{
                result.Foreground=GetForegroundWindow();
                uint targetThread=GetWindowThreadProcessId(target,out result.TargetPid);
                uint foregroundThread=GetWindowThreadProcessId(result.Foreground,out result.ForegroundPid);
                if(target==IntPtr.Zero || !IsWindow(target) || targetThread==0)result.Gaps|=Gap.TargetUnavailable;
                if(result.Foreground==IntPtr.Zero || foregroundThread==0)result.Gaps|=Gap.ForegroundUnavailable;
                uint sourcePid;using(var process=Process.GetCurrentProcess())sourcePid=(uint)process.Id;
                result.Access=ReadAccess(sourcePid,GetCurrentThreadId(),result.ForegroundPid,foregroundThread,targetThread);
                result.Gaps|=AccessGaps(result.Access);
                result.MouseButtonsSwapped=GetSystemMetrics(23)!=0;
                var firstTarget=ReadQueue(targetThread,target,ref result.Gaps);
                var firstForeground=targetThread==foregroundThread?firstTarget:ReadQueue(foregroundThread,target,ref result.Gaps);
                int[] before=ReadDown(result.ProbedKeys);
                result.TargetQueue=ReadQueue(targetThread,target,ref result.Gaps);
                result.ForegroundQueue=targetThread==foregroundThread?result.TargetQueue:ReadQueue(foregroundThread,target,ref result.Gaps);
                result.DownKeys=ReadDown(result.ProbedKeys);
                if(!SameQueue(firstTarget,result.TargetQueue) || !SameQueue(firstForeground,result.ForegroundQueue))result.Gaps|=Gap.ContextChanged;
                if(!SameKeys(before,result.DownKeys))result.Gaps|=Gap.KeyStateChanged;
                uint endTargetPid,endForegroundPid;
                if(GetForegroundWindow()!=result.Foreground || GetWindowThreadProcessId(target,out endTargetPid)!=targetThread || endTargetPid!=result.TargetPid ||
                    GetWindowThreadProcessId(result.Foreground,out endForegroundPid)!=foregroundThread || endForegroundPid!=result.ForegroundPid ||
                    (GetSystemMetrics(23)!=0)!=result.MouseButtonsSwapped)result.Gaps|=Gap.ContextChanged;
                // Recheck the active desktop after sampling, including lock or
                // desktop switches that occurred during the access checks.
                if(ActiveDesktop(GetCurrentThreadId(),result.Access)!=true)result.Gaps|=Gap.DesktopNotInteractive;
            }catch(DllNotFoundException){result.Gaps|=Gap.UnsupportedPlatform;}
            catch(EntryPointNotFoundException){result.Gaps|=Gap.UnsupportedPlatform;}
            finally{
                result.CompletedTimestamp=Stopwatch.GetTimestamp();
                if((result.CompletedTimestamp-result.StartedTimestamp)*1000.0/Stopwatch.Frequency>100)result.Gaps|=Gap.CollectionTooSlow;
            }
            return result;
        }
    }
}
