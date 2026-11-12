// Windows UI Automation driver adapted from ClipRelay contributors (MIT).
// ProfilePilot owns this implementation and its process/session lifecycle.
// See the accompanying LICENSE.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace ProfilePilot.Desktop {
    public sealed class AutomationWindows : IDisposable {
        sealed class Target { public IntPtr Handle;public int Pid;public long Started; }
        sealed class Element { public AutomationElement Value;public string Fingerprint;public IntPtr RootHandle;public bool ObservedIconic;public DesktopWindowState.Snapshot Window;public int[] RuntimeId; }
        sealed class ObservationBudgetException : Exception {}
        sealed class MutableState {
            public string ValueStatus="unsupported",ToggleStatus="unsupported",SelectionStatus="unsupported",ExpandCollapseStatus="unsupported";
            public string ValueText="",ValueDigest,ValueEvidence="unconfirmed",ValueTextPattern;
            public bool ValueTextPatternTruncated;
            public bool? ReadOnly,Selected;
            public int? Toggle,Expanded;
            public readonly List<string> Gaps=new List<string>();
            public DesktopWindowState.Snapshot Window=new DesktopWindowState.Snapshot();
            public bool WindowObserved;
            public bool Complete {get{return Gaps.Count==0;}}
            public object Output(){
                var result=new Dictionary<string,object>{{"valueStatus",ValueStatus},{"valueEvidence",ValueEvidence},{"readOnly",ReadOnly},{"toggleStatus",ToggleStatus},{"toggle",Toggle},{"selectionStatus",SelectionStatus},{"selected",Selected},{"expandCollapseStatus",ExpandCollapseStatus},{"expanded",Expanded}};
                // Window evidence is root-only; avoid multiplying empty metadata
                // across every child in a potentially large observation.
                if(WindowObserved)result["window"]=Window.Output();return result;
            }
        }
        sealed class ElementSnapshot {
            public int[] RuntimeId;
            public int ProcessId,ControlTypeId;
            public string Role,Name,AutomationId,Text,TextStatus="unsupported",TextSource="none";
            public bool Enabled,Offscreen,Password,Focused,TextOmitted,TextWasTruncated,WindowIconic;
            public double[] Bounds;
            public string[] Actions;
            public MutableState State;
            public object Output(string reference,int parent){
                var truncated=new List<string>();
                if(!Password && Name!=null && Name.Length>512)truncated.Add("name");
                if(AutomationId!=null && AutomationId.Length>256)truncated.Add("automationId");
                if(!Password && TextWasTruncated)truncated.Add("text");
                return new {reference,parent,role=Role,name=Password?"":Limit(Name,512),automationId=Limit(AutomationId,256),enabled=Enabled,offscreen=Offscreen,password=Password,focused=Focused,text=Password?"":Text,textStatus=Password?"redacted":TextStatus,textSource=Password?"none":TextSource,truncatedFields=truncated.ToArray(),actions=Actions,bounds=Bounds,state=State.Output(),stateGaps=State.Gaps.ToArray()};
            }
        }
        readonly Dictionary<string,Target> targets=new Dictionary<string,Target>();
        readonly Dictionary<string,Element> elements=new Dictionary<string,Element>();
        Target selected;
        string selectedId;
        string version="";
        long observed;
        bool imageReady;
        Target backgroundTarget;
        string backgroundWindowId;
        static bool BackgroundAction(string kind){return kind=="invoke" || kind=="set_value" || kind=="toggle" || kind=="select" || kind=="expand" || kind=="collapse" || kind=="scroll";}
        void CheckBackground(){
            if(backgroundTarget==null)return;
            AutomationJson.Require(Valid(backgroundTarget),"DESKTOP_WINDOW_CHANGED");
            uint pid=0;IntPtr foreground=GetForegroundWindow();
            AutomationJson.Require(foreground!=IntPtr.Zero && GetWindowThreadProcessId(foreground,out pid)!=0,"DESKTOP_BACKGROUND_TARGET_ACTIVE");
            AutomationJson.Require(pid!=(uint)backgroundTarget.Pid,"DESKTOP_BACKGROUND_TARGET_ACTIVE");
        }
        Rect imageBounds;
        bool physicalCoordinates;
        readonly UIntPtr inputMarker;
        public AutomationWindows():this(DesktopHost.InputMarker(new string[0])){}
        public AutomationWindows(UIntPtr marker){if(marker==UIntPtr.Zero)throw new ArgumentException("Input marker must be nonzero");inputMarker=marker;}
        public Func<bool> Allowed=()=>true;
        void CheckControl(){AutomationJson.Require(Allowed(),"DESKTOP_USER_STOPPED");AutomationJson.Require(DesktopHost.IsInteractiveDesktop(),"DESKTOP_DESKTOP_LOCKED");CheckBackground();}
        readonly Stopwatch clock=Stopwatch.StartNew();
        public bool HasObservation {get{return selected!=null && clock.ElapsedMilliseconds-observed<30000;}}
        delegate bool EnumProc(IntPtr handle,IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle,uint relation);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle,StringBuilder text,int count);
        [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr handle,int index);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref KeyboardQueue state);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out Rect rect);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle,IntPtr dc,uint flags);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowPlacement(IntPtr handle,ref WindowPlacement placement);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr handle,out Rect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr handle,ref Point point);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowDisplayAffinity(IntPtr handle,out uint affinity);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle,uint flag);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point,uint flags);
        [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
        [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code,uint mapType);
        [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
        [StructLayout(LayoutKind.Sequential)] struct WindowPlacement {public int Size,Flags,ShowCommand;public Point MinPosition,MaxPosition;public Rect NormalPosition;}
        [StructLayout(LayoutKind.Sequential)] struct KeyboardQueue {public int Size,Flags;public IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret;public Rect CaretBounds;}
        [StructLayout(LayoutKind.Sequential)] struct Input {public uint Type;public InputUnion Data;}
        [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public Mouse Mouse;[FieldOffset(0)]public Key Key;}
        [StructLayout(LayoutKind.Sequential)] struct Mouse {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
        [StructLayout(LayoutKind.Sequential)] struct Key {public ushort Vk,Scan;public uint Flags,Time;public UIntPtr Extra;}
        static readonly AutomationProperty[] PatternAvailability={AutomationElement.IsInvokePatternAvailableProperty,AutomationElement.IsValuePatternAvailableProperty,AutomationElement.IsTogglePatternAvailableProperty,AutomationElement.IsSelectionItemPatternAvailableProperty,AutomationElement.IsExpandCollapsePatternAvailableProperty,AutomationElement.IsScrollPatternAvailableProperty,AutomationElement.IsTextPatternAvailableProperty};
        static readonly string[] PatternNames={"invoke","set_value","toggle","select","expand","scroll","text"};
        static string Limit(string value,int max){return value==null?"":value.Length<=max?value:value.Substring(0,max);}
        static bool Valid(Target target){
            try{
                uint pid;if(target==null || !IsWindow(target.Handle) || GetWindowThreadProcessId(target.Handle,out pid)==0 || pid!=target.Pid)return false;
                using(var process=Process.GetProcessById((int)pid))return process.StartTime.ToUniversalTime().Ticks==target.Started;
            }catch{return false;}
        }
        static T StateProperty<T>(Func<string,object> read,string property,Action checkpoint){checkpoint();object value=read(property);checkpoint();if(!(value is T))throw new InvalidOperationException("UIA state property unavailable");return (T)value;}
        static bool PatternAvailable(object value){
            // GetCachedPropertyValue(..., true) returns this sentinel when the
            // provider omits an availability property. These UIA properties have
            // a documented false default. Only this exact sentinel is defaulted;
            // null, bad types and exceptions still mean an unreadable property.
            if(Object.ReferenceEquals(value,AutomationElement.NotSupported))return false;
            if(value is bool)return (bool)value;
            throw new InvalidOperationException("UIA pattern availability unreadable");
        }
        static bool ReadPatternAvailable(Func<string,object> read,string property,Action checkpoint){return PatternAvailable(StateProperty<object>(read,property,checkpoint));}
        static void ReadStatePart(MutableState state,string name,Action read,Action unavailable){
            try{read();return;}
            catch(ElementNotAvailableException){}
            catch(InvalidOperationException){}
            catch(COMException){}
            catch(ArgumentException){}
            catch(UnauthorizedAccessException){}
            catch(NotSupportedException){}
            unavailable();state.Gaps.Add(name);
        }
        // The reader is also used by pure tests. In particular, the password
        // branch never requests value.text, so it cannot retain or hash a secret.
        static MutableState ReadMutableState(bool password,Func<string,object> read,Action checkpoint){
            var state=new MutableState();
            ReadStatePart(state,"value",()=>{
                if(!ReadPatternAvailable(read,"value.available",checkpoint))return;
                state.ReadOnly=StateProperty<bool>(read,"value.readOnly",checkpoint);
                if(password){state.ValueStatus="redacted";return;}
                state.ValueText=StateProperty<string>(read,"value.text",checkpoint);
                state.ValueDigest=AutomationJson.Hash(state.ValueText);state.ValueStatus="readable";state.ValueEvidence="value";
            },()=>{state.ValueStatus="unavailable";state.ReadOnly=null;state.ValueText="";state.ValueDigest=null;});
            ReadStatePart(state,"toggle",()=>{
                if(!ReadPatternAvailable(read,"toggle.available",checkpoint))return;
                int value=StateProperty<int>(read,"toggle.state",checkpoint);if(value<0 || value>2)throw new InvalidOperationException();
                state.Toggle=value;state.ToggleStatus="readable";
            },()=>{state.ToggleStatus="unavailable";state.Toggle=null;});
            ReadStatePart(state,"selection",()=>{
                if(!ReadPatternAvailable(read,"selection.available",checkpoint))return;
                state.Selected=StateProperty<bool>(read,"selection.selected",checkpoint);state.SelectionStatus="readable";
            },()=>{state.SelectionStatus="unavailable";state.Selected=null;});
            ReadStatePart(state,"expandCollapse",()=>{
                if(!ReadPatternAvailable(read,"expandCollapse.available",checkpoint))return;
                int value=StateProperty<int>(read,"expandCollapse.state",checkpoint);if(value<0 || value>3)throw new InvalidOperationException();
                state.Expanded=value;state.ExpandCollapseStatus="readable";
            },()=>{state.ExpandCollapseStatus="unavailable";state.Expanded=null;});
            return state;
        }
        static string Fingerprint(ElementSnapshot snapshot){
            var state=snapshot.State;
            // JSON encoding avoids delimiter collisions in names or values.
            // Focus and truncated display text are intentionally not identity:
            // activation changes focus, and text limits depend on earlier nodes.
            return AutomationJson.Hash(AutomationJson.Json.Serialize(new object[]{snapshot.RuntimeId,snapshot.ProcessId,snapshot.ControlTypeId,snapshot.Password?"":snapshot.Name,snapshot.AutomationId,snapshot.Bounds,snapshot.Enabled,snapshot.Offscreen,snapshot.Password,state.ValueStatus,snapshot.Password?null:state.ValueDigest,state.ReadOnly,state.ToggleStatus,state.Toggle,state.SelectionStatus,state.Selected,state.ExpandCollapseStatus,state.Expanded,DesktopWindowState.Identity(state.Window),snapshot.WindowIconic}));
        }
        static void ReadValueEvidence(ElementSnapshot snapshot,Action checkpoint,Func<int,string> readDocumentText){
            var state=snapshot.State;
            // The Framework HWND Edit proxy silently limits Value to 2000
            // characters. Its separate TextPattern can provide supplementary
            // identity evidence; never replace Value semantics or trim text.
            if(snapshot.Password || state.ValueStatus!="readable" || state.ValueText.Length!=2000)return;
            const int maximum=16385;
            state.ValueEvidence="unconfirmed";state.ValueDigest=null;state.ValueTextPattern=null;state.ValueTextPatternTruncated=false;
            ReadStatePart(state,"value_evidence",()=>{
                checkpoint();string text=readDocumentText(maximum);checkpoint();
                if(text==null || !text.StartsWith(state.ValueText,StringComparison.Ordinal))throw new InvalidOperationException("UIA Value/Text evidence unavailable");
                if(text.Length>=maximum){
                    state.ValueTextPattern=Limit(text,maximum);state.ValueTextPatternTruncated=true;
                    throw new InvalidOperationException("UIA Text evidence exceeds identity limit");
                }
                state.ValueTextPattern=text;
                state.ValueDigest=AutomationJson.Hash(AutomationJson.Json.Serialize(new object[]{"value_and_text","value",state.ValueText,"text_pattern",text}));
                state.ValueEvidence="value_and_text";
            },()=>{state.ValueEvidence="unconfirmed";state.ValueDigest=null;});
        }
        static void ReadSnapshotText(ElementSnapshot snapshot,int textLimit,Action checkpoint,Func<int,string> readDocumentText){
            // Identity confirmation is required even when ValidateElement uses
            // a zero display budget. This read never moves/selects a text range.
            ReadValueEvidence(snapshot,checkpoint,readDocumentText);
            ReadDisplayText(snapshot,textLimit,checkpoint,maximum=>{
                string text=readDocumentText(maximum);if(text==null)return false;
                snapshot.Text=text;return true;
            });
        }
        static void ReadDisplayText(ElementSnapshot snapshot,int textLimit,Action checkpoint,Func<int,bool> readDocumentText){
            snapshot.TextOmitted=false;snapshot.TextWasTruncated=false;snapshot.TextStatus="unsupported";snapshot.TextSource="none";
            if(snapshot.Password){snapshot.TextStatus="redacted";return;}
            if(snapshot.State.ValueStatus=="readable"){
                var state=snapshot.State;
                snapshot.Text=state.ValueTextPattern??state.ValueText;snapshot.TextSource=state.ValueTextPattern==null?"value":"text_pattern";
                snapshot.TextStatus=state.ValueEvidence=="unconfirmed"?(state.ValueTextPatternTruncated?"truncated":"unavailable"):"readable";
                snapshot.TextOmitted=state.ValueTextPatternTruncated;
            }
            else if(snapshot.State.ValueStatus=="unavailable" || snapshot.State.ValueStatus=="redacted")snapshot.TextStatus=snapshot.State.ValueStatus;
            else if(snapshot.State.ValueStatus=="unsupported" && snapshot.ControlTypeId==ControlType.Document.Id){
                if(textLimit>0){
                    checkpoint();
                    if(readDocumentText(textLimit+1)){snapshot.TextStatus="readable";snapshot.TextSource="text_pattern";checkpoint();}
                    else snapshot.TextStatus=snapshot.Actions.Contains("text")?"unavailable":"unsupported";
                }
                // No text query is permitted after the display budget runs out.
                // The known pattern means text may have been omitted, even if
                // the earlier nodes exactly filled the budget without overflow.
                else if(snapshot.Actions.Contains("text")){snapshot.TextOmitted=true;snapshot.TextStatus="truncated";}
            }
        }
        static bool TextTruncated(ElementSnapshot snapshot,int limit){return snapshot.TextOmitted || snapshot.Text.Length>limit;}
        static bool LimitDisplayText(ElementSnapshot snapshot,int limit){
            bool truncated=TextTruncated(snapshot,limit);snapshot.TextWasTruncated=truncated;
            if(truncated && !snapshot.Password)snapshot.TextStatus="truncated";
            snapshot.Text=Limit(snapshot.Text,limit);return truncated;
        }
        static readonly AutomationProperty[] WindowProperties={AutomationElement.IsWindowPatternAvailableProperty,AutomationElement.NativeWindowHandleProperty,WindowPattern.WindowVisualStateProperty,WindowPattern.CanMinimizeProperty,WindowPattern.CanMaximizeProperty,WindowPattern.IsModalProperty,WindowPattern.WindowInteractionStateProperty};
        static DesktopWindowState.Snapshot ReadWindowState(AutomationElement cached,Action checkpoint){
            return DesktopWindowState.Read(key=>{
                AutomationProperty property;
                switch(key){
                    case "available":property=AutomationElement.IsWindowPatternAvailableProperty;break;
                    case "nativeHandle":property=AutomationElement.NativeWindowHandleProperty;break;
                    case "visual":property=WindowPattern.WindowVisualStateProperty;break;
                    case "canMinimize":property=WindowPattern.CanMinimizeProperty;break;
                    case "canMaximize":property=WindowPattern.CanMaximizeProperty;break;
                    case "modal":property=WindowPattern.IsModalProperty;break;
                    case "interaction":property=WindowPattern.WindowInteractionStateProperty;break;
                    default:throw new InvalidOperationException();
                }
                object value=cached.GetCachedPropertyValue(property,true);
                if(property==AutomationElement.IsWindowPatternAvailableProperty && value==AutomationElement.NotSupported)return false;
                if(value is WindowVisualState)return (int)(WindowVisualState)value;
                if(value is WindowInteractionState)return (int)(WindowInteractionState)value;
                return value;
            },checkpoint);
        }
        static ElementSnapshot ReadSnapshot(AutomationElement element,int textLimit,Action checkpoint,IntPtr rootHandle){
            checkpoint();
            var request=new CacheRequest{TreeScope=TreeScope.Element};
            foreach(var property in new[]{AutomationElement.ProcessIdProperty,AutomationElement.ControlTypeProperty,AutomationElement.NameProperty,AutomationElement.AutomationIdProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.IsEnabledProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsPasswordProperty,AutomationElement.HasKeyboardFocusProperty,ValuePattern.IsReadOnlyProperty,TogglePattern.ToggleStateProperty,SelectionItemPattern.IsSelectedProperty,ExpandCollapsePattern.ExpandCollapseStateProperty}.Concat(PatternAvailability))request.Add(property);
            if(rootHandle!=IntPtr.Zero)foreach(var property in WindowProperties)request.Add(property);
            // Bulk-read the safe properties. Value.Value must not be included in
            // this request: IsPassword is not known until the snapshot arrives.
            var cached=element.GetUpdatedCache(request);checkpoint();var s=cached.Cached;
            var bounds=s.BoundingRectangle;
            var snapshot=new ElementSnapshot{RuntimeId=element.GetRuntimeId(),ProcessId=s.ProcessId,ControlTypeId=s.ControlType.Id,Role=s.ControlType.ProgrammaticName.Replace("ControlType.",""),Name=s.IsPassword?"":s.Name,AutomationId=s.AutomationId,Enabled=s.IsEnabled,Offscreen=s.IsOffscreen,Password=s.IsPassword,Focused=s.HasKeyboardFocus,Bounds=bounds.IsEmpty?null:new[]{bounds.X,bounds.Y,bounds.Width,bounds.Height},Text=""};
            Func<AutomationProperty,object> propertyValue=property=>cached.GetCachedPropertyValue(property,true);
            snapshot.State=ReadMutableState(snapshot.Password,key=>{
                switch(key){
                    case "value.available":return propertyValue(AutomationElement.IsValuePatternAvailableProperty);
                    case "value.readOnly":return propertyValue(ValuePattern.IsReadOnlyProperty);
                    case "value.text":return element.GetCurrentPropertyValue(ValuePattern.ValueProperty,true);
                    case "toggle.available":return propertyValue(AutomationElement.IsTogglePatternAvailableProperty);
                    case "toggle.state":{object value=propertyValue(TogglePattern.ToggleStateProperty);return value is ToggleState?(object)(int)(ToggleState)value:value;}
                    case "selection.available":return propertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty);
                    case "selection.selected":return propertyValue(SelectionItemPattern.IsSelectedProperty);
                    case "expandCollapse.available":return propertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty);
                    case "expandCollapse.state":{object value=propertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty);return value is ExpandCollapseState?(object)(int)(ExpandCollapseState)value:value;}
                    default:throw new InvalidOperationException();
                }
            },checkpoint);
            if(rootHandle!=IntPtr.Zero){snapshot.State.WindowObserved=true;snapshot.State.Window=ReadWindowState(cached,checkpoint);checkpoint();snapshot.WindowIconic=IsIconic(rootHandle);checkpoint();}
            var supported=new List<string>();
            for(int i=0;i<PatternAvailability.Length;i++){
                checkpoint();object available=propertyValue(PatternAvailability[i]);
                if(PatternAvailable(available)){supported.Add(PatternNames[i]);if(PatternNames[i]=="expand")supported.Add("collapse");}
            }
            if(rootHandle!=IntPtr.Zero && snapshot.State.Window.Status=="readable" && snapshot.State.Window.NativeHandle==unchecked((int)rootHandle.ToInt64())){
                supported.Add("restore");if(snapshot.State.Window.CanMinimize==true)supported.Add("minimize");if(snapshot.State.Window.CanMaximize==true)supported.Add("maximize");
            }
            snapshot.Actions=supported.ToArray();
            ReadSnapshotText(snapshot,textLimit,checkpoint,maximum=>{
                object pattern;if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern))return null;
                var textPattern=pattern as TextPattern;if(textPattern==null)return null;
                var range=textPattern.DocumentRange;if(range==null)return null;
                return range.GetText(maximum);
            });
            checkpoint();return snapshot;
        }
        ElementSnapshot ValidateElement(Element element,string kind=null){
            ElementSnapshot snapshot;
            try{snapshot=ReadSnapshot(element.Value,0,CheckControl,element.RootHandle);}
            catch(ElementNotAvailableException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_ELEMENT_UNAVAILABLE");}
            catch(InvalidOperationException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(COMException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(ArgumentException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(UnauthorizedAccessException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(NotSupportedException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            AutomationJson.Require(snapshot.State.Complete,"DESKTOP_ELEMENT_UNAVAILABLE");
            AutomationJson.Require(Fingerprint(snapshot)==element.Fingerprint,"DESKTOP_ELEMENT_CHANGED");
            if(DesktopWindowState.Desired(kind)>=0){
                bool exact=element.RootHandle!=IntPtr.Zero && element.RootHandle==selected.Handle && snapshot.ProcessId==selected.Pid && snapshot.State.Window.NativeHandle==unchecked((int)selected.Handle.ToInt64());
                string rejection=DesktopWindowState.Rejection(kind,element.Window,snapshot.State.Window,exact,snapshot.Enabled,snapshot.Offscreen,element.ObservedIconic,snapshot.WindowIconic);
                if(rejection!=null)throw new AutomationFault(rejection);
            }else AutomationJson.Require(snapshot.Enabled && !snapshot.Offscreen,"DESKTOP_ELEMENT_UNAVAILABLE");
            return snapshot;
        }
        object Windows(){
            targets.Clear();var list=new List<object>();var gaps=new HashSet<string>();
            int session;using(var currentProcess=Process.GetCurrentProcess())session=currentProcess.SessionId;
            bool stopped=false;
            bool enumerated=EnumWindows((handle,unused)=>{
                if(list.Count>=256){stopped=true;gaps.Add("window_limit");return false;}
                if(!Allowed()){stopped=true;gaps.Add("cancelled");return false;}
                try{
                    if(!IsWindowVisible(handle))return true;
                    // WS_VISIBLE also includes windows DWM has cloaked, such as
                    // ThumbnailDeviceHelperWnd and windows on other desktops.
                    if(DesktopDiagnostics.Cloaked(handle)==true)return true;
                    // Owner-drawn utilities and popup menus often have no caption.
                    // Keep visible, nonempty windows discoverable by process/class.
                    Rect bounds;if(!GetWindowRect(handle,out bounds) || bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top)return true;
                    var title=new StringBuilder(512);GetWindowText(handle,title,title.Capacity);var className=new StringBuilder(256);GetClassName(handle,className,className.Capacity);
                    if(title.Length==title.Capacity-1)gaps.Add("window_title_limit");
                    if(className.Length==className.Capacity-1)gaps.Add("window_class_limit");
                    uint pid;GetWindowThreadProcessId(handle,out pid);
                    using(var process=Process.GetProcessById((int)pid)){
                        if(process.SessionId!=session)return true;
                        long started=process.StartTime.ToUniversalTime().Ticks;string id=AutomationJson.Hash(handle.ToInt64()+":"+pid+":"+started).Substring(0,32);
                        var target=new Target{Handle=handle,Pid=(int)pid,Started=started};
                        // Diagnostic samples only: an owned window is not
                        // necessarily modal, and its HWND grants no authority.
                        bool enabled=IsWindowEnabled(handle),minimized=IsIconic(handle);
                        IntPtr owner=GetWindow(handle,4); // GW_OWNER, not parent.
                        string processName=process.ProcessName;
                        if(!Valid(target)){gaps.Add("window_changed");return true;}
                        targets[id]=target;
                        list.Add(new {id,title=title.Length>0?title.ToString():className.ToString(),className=className.ToString(),process=processName,pid,nativeHandle=handle.ToInt64().ToString(),enabled,minimized,ownerNativeHandle=owner==IntPtr.Zero?null:owner.ToInt64().ToString()});
                    }
                }catch{gaps.Add("window_unavailable");}return true;
            },IntPtr.Zero);
            if(!enumerated && !stopped)gaps.Add("window_enumeration_failed");
            CheckControl();return new {windows=list,truncated=gaps.Count>0,gaps=gaps.OrderBy(x=>x).ToArray()};
        }
        object Observe(Dictionary<string,object> p,bool screenshot){
            AutomationJson.Fields(p,"windowId,screenshot,screenshotOnly");string id=AutomationJson.Text(p,"windowId");Target target;
            bool screenshotOnly=AutomationJson.Flag(p,"screenshotOnly");AutomationJson.Require(!screenshotOnly || screenshot);
            AutomationJson.Require(targets.TryGetValue(id,out target) && Valid(target),"DESKTOP_WINDOW_CHANGED");
            if(backgroundTarget!=null)AutomationJson.Require(id==backgroundWindowId,"DESKTOP_WINDOW_CHANGED");
            selected=null;elements.Clear();version=Guid.NewGuid().ToString("N");imageReady=false;
            var nodes=new List<object>();var gaps=new HashSet<string>();var queue=new Queue<Tuple<AutomationElement,int,int>>();
            var watch=Stopwatch.StartNew();int textBudget=32768;
            // Check between provider calls, including sibling traversal. A
            // synchronous UIA provider call itself can still exceed this budget.
            Action checkpoint=()=>{CheckControl();if(watch.ElapsedMilliseconds>=4000)throw new ObservationBudgetException();};
            try{
            if(screenshotOnly)gaps.Add("uia_skipped");
            else try{checkpoint();queue.Enqueue(Tuple.Create(AutomationElement.FromHandle(target.Handle),0,-1));checkpoint();}
            catch(ElementNotAvailableException){gaps.Add("uia_element_unavailable");}
            catch(InvalidOperationException){gaps.Add("uia_provider_error");}
            catch(COMException){gaps.Add("uia_provider_error");}
            catch(ArgumentException){gaps.Add("uia_provider_error");}
            catch(UnauthorizedAccessException){gaps.Add("uia_provider_error");}
            catch(NotSupportedException){gaps.Add("uia_provider_error");}
            while(queue.Count>0 && nodes.Count<512 && watch.ElapsedMilliseconds<4000){
                checkpoint();
                try{
                var item=queue.Dequeue();var element=item.Item1;int limit=Math.Min(4096,textBudget);
                IntPtr rootHandle=item.Item3==-1?target.Handle:IntPtr.Zero;
                var snapshot=ReadSnapshot(element,limit,checkpoint,rootHandle);
                if(backgroundTarget!=null)snapshot.Actions=snapshot.Actions.Where(action=>action=="text" || BackgroundAction(action)).ToArray();
                // UIA subtrees in Chromium and hosted Windows apps may be owned
                // by renderer processes. Scope by the observed window ancestry.
                string reference="e"+nodes.Count;int index=nodes.Count;
                if(LimitDisplayText(snapshot,limit))gaps.Add("text_limit");textBudget-=snapshot.Text.Length;
                if(snapshot.Name!=null && snapshot.Name.Length>512)gaps.Add("name_limit");
                if(snapshot.AutomationId!=null && snapshot.AutomationId.Length>256)gaps.Add("automation_id_limit");
                if(!snapshot.State.Complete)gaps.Add("uia_state_unavailable");
                if(snapshot.State.Window.Status=="unavailable")gaps.Add("uia_window_state_unavailable");
                nodes.Add(snapshot.Output(reference,item.Item3));
                // Output and fingerprint use this same collected snapshot; no
                // second read can silently attach a newer state to an old node.
                elements[reference]=new Element{Value=element,Fingerprint=Fingerprint(snapshot),RootHandle=rootHandle,Window=snapshot.State.Window,ObservedIconic=snapshot.WindowIconic,RuntimeId=snapshot.RuntimeId};
                if(!snapshot.Password){
                    checkpoint();var child=TreeWalker.ControlViewWalker.GetFirstChild(element);checkpoint();int count=0;
                    if(item.Item2>=20){if(child!=null)gaps.Add("depth_limit");}
                    else{
                        while(child!=null && count<256 && queue.Count<1024){checkpoint();queue.Enqueue(Tuple.Create(child,item.Item2+1,index));count++;child=TreeWalker.ControlViewWalker.GetNextSibling(child);checkpoint();}
                        if(child!=null){if(count>=256)gaps.Add("children_limit");if(queue.Count>=1024)gaps.Add("queue_limit");}
                    }
                }
                }catch(ElementNotAvailableException){gaps.Add("uia_element_unavailable");}
                catch(InvalidOperationException){gaps.Add("uia_provider_error");}
                catch(COMException){gaps.Add("uia_provider_error");}
                catch(ArgumentException){gaps.Add("uia_provider_error");}
                catch(UnauthorizedAccessException){gaps.Add("uia_provider_error");}
                catch(NotSupportedException){gaps.Add("uia_provider_error");}
            }
            if(queue.Count>0){if(nodes.Count>=512)gaps.Add("node_limit");if(watch.ElapsedMilliseconds>=4000)gaps.Add("time_limit");}
            }catch(ObservationBudgetException){gaps.Add("time_limit");}
            CheckControl();
            object image=null;if(screenshot || AutomationJson.Flag(p,"screenshot")){image=Capture(target,out imageBounds);imageReady=true;}
            AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");selected=target;selectedId=id;observed=clock.ElapsedMilliseconds;
            return new {windowId=id,version,elements=nodes,truncated=gaps.Any(g=>g!="uia_skipped"),gaps=gaps.OrderBy(x=>x).ToArray(),image};
        }
        sealed class CaptureSnapshot {
            public Rect Window,Client;
            public bool Visible,Minimized;
            public bool? Cloaked;
            public uint? Dpi,DisplayAffinity;
            public int? DisplayAffinityError;
            public object Output(){return new {visible=Visible,minimized=Minimized,cloaked=Cloaked,dpi=Dpi,
                displayAffinity=DisplayAffinity,displayAffinityError=DisplayAffinityError,
                protectionStatus=DisplayAffinity.HasValue?(DisplayAffinity.Value==0?"none":"protected"):"unknown",
                windowRect=new{x=Window.Left,y=Window.Top,width=Window.Right-Window.Left,height=Window.Bottom-Window.Top},
                clientRect=new{x=Client.Left,y=Client.Top,width=Client.Right-Client.Left,height=Client.Bottom-Client.Top}};}
        }
        static string CaptureSnapshotIssue(CaptureSnapshot state){
            if(state==null)return "state_unavailable";
            if(!state.Visible)return "window_hidden";
            if(state.Minimized)return "window_minimized";
            if(state.Cloaked==true)return "window_cloaked";
            if(state.DisplayAffinity.HasValue && state.DisplayAffinity.Value!=0)return "capture_protected";
            if(state.Window.Right<=state.Window.Left || state.Window.Bottom<=state.Window.Top ||
                state.Client.Right<state.Client.Left || state.Client.Bottom<state.Client.Top)return "geometry_unavailable";
            return null;
        }
        static bool SameCaptureSnapshot(CaptureSnapshot before,CaptureSnapshot after){
            return before!=null && after!=null && SameRect(before.Window,after.Window) && SameRect(before.Client,after.Client) &&
                before.Visible==after.Visible && before.Minimized==after.Minimized && before.Cloaked==after.Cloaked &&
                before.Dpi==after.Dpi && before.DisplayAffinity==after.DisplayAffinity && before.DisplayAffinityError==after.DisplayAffinityError;
        }
        static void RequireCaptureSnapshot(CaptureSnapshot before,CaptureSnapshot after){
            string issue=CaptureSnapshotIssue(after);
            if(issue==null && before!=null && !SameCaptureSnapshot(before,after))issue="window_changed";
            if(issue==null)return;
            var details=new Dictionary<string,object>{{"capture",new {source="window-state",status=issue,
                before=before==null?null:before.Output(),after=after==null?null:after.Output()}}};
            throw DesktopDiagnostics.Fault(issue=="window_changed"?"DESKTOP_WINDOW_CHANGED":"DESKTOP_SCREENSHOT_UNAVAILABLE","CAPTURE_"+issue.ToUpperInvariant(),details);
        }
        CaptureSnapshot ReadCaptureSnapshot(Target target){
            CheckControl();AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");
            var state=new CaptureSnapshot{Visible=IsWindowVisible(target.Handle),Minimized=IsIconic(target.Handle),Cloaked=DesktopDiagnostics.Cloaked(target.Handle)};
            Point origin=new Point(0,0);Rect client=new Rect();
            AutomationJson.Require(GetWindowRect(target.Handle,out state.Window) && GetClientRect(target.Handle,out client) && ClientToScreen(target.Handle,ref origin),"DESKTOP_WINDOW_CHANGED");
            state.Client=new Rect{Left=origin.X,Top=origin.Y,Right=origin.X+client.Right-client.Left,Bottom=origin.Y+client.Bottom-client.Top};
            try{uint dpi=GetDpiForWindow(target.Handle);if(dpi!=0)state.Dpi=dpi;}catch(EntryPointNotFoundException){}
            // GetWindowDisplayAffinity can fail for a non-layered window or
            // unavailable DWM composition. Failure is unknown, never WDA_NONE.
            try{
                uint affinity;DesktopDiagnostics.SetLastError(0);
                if(GetWindowDisplayAffinity(target.Handle,out affinity))state.DisplayAffinity=affinity;
                else state.DisplayAffinityError=Marshal.GetLastWin32Error();
            }catch(EntryPointNotFoundException){state.DisplayAffinityError=127;}
            AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");
            return state;
        }
        void CheckCaptureSnapshot(Target target,CaptureSnapshot before){RequireCaptureSnapshot(before,ReadCaptureSnapshot(target));}
        static object WgcImage(WgcCaptureResult captured,Rect outer,CaptureSnapshot state){
            var geometry=captured.Geometry;
            AutomationJson.Require(captured.Success && captured.Jpeg!=null && captured.Jpeg.Length>0,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            AutomationJson.Require(geometry!=null && geometry.Window!=null && geometry.Window.X==outer.Left && geometry.Window.Y==outer.Top && geometry.Window.Width==outer.Right-outer.Left && geometry.Window.Height==outer.Bottom-outer.Top,"DESKTOP_WINDOW_CHANGED");
            AutomationJson.Require(captured.Width>0 && captured.Height>0 && captured.Width<=1600 && captured.Height<=1600 && captured.Jpeg.Length<=2200000,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            // The prototype's coordinate authority remains false until the
            // integrated App/image/action path is separately qualified.
            return new {mimeType="image/jpeg",data=Convert.ToBase64String(captured.Jpeg),width=captured.Width,height=captured.Height,
                windowWidth=outer.Right-outer.Left,windowHeight=outer.Bottom-outer.Top,windowX=outer.Left,windowY=outer.Top,
                coordinateInputAvailable=false,source="windows-graphics-capture",captureState=state.Output(),
                captureDiagnostics=new {status=captured.Status,geometryStatus=captured.GeometryStatus,colorMode=captured.ColorMode,
                    contentWidth=captured.ContentWidth,contentHeight=captured.ContentHeight,frameTimestampTicks=captured.FrameTimestampTicks.ToString(),
                    elapsedMs=captured.ElapsedMs,candidateCaptureRect=captured.CandidateCaptureRect}};
        }
        static string WgcFallbackReason(WgcCaptureResult captured){
            if(captured!=null && !captured.Success && (captured.Status=="unsupported_api" || captured.Status=="unsupported_capture" || captured.Status=="device_unsupported"))return "windows_graphics_capture_"+captured.Status;
            var details=new Dictionary<string,object>{{"capture",captured==null?null:new {source=captured.Source,status=captured.Status,stage=captured.Stage,hresult=captured.HResult,elapsedMs=captured.ElapsedMs}}};
            // Protected/closed/changed/failed captures are explicit. Only a
            // classified unavailable backend may use the compositor fallback.
            throw DesktopDiagnostics.Fault("DESKTOP_SCREENSHOT_UNAVAILABLE","WGC_"+(captured==null?"failed":captured.Status??"failed").ToUpperInvariant(),details);
        }
        object Capture(Target target,out Rect r){
            var before=ReadCaptureSnapshot(target);RequireCaptureSnapshot(null,before);r=before.Window;
            int width=r.Right-r.Left,height=r.Bottom-r.Top;
            AutomationJson.Require(width>0 && height>0 && width<=8192 && height<=8192 && (long)width*height<=24000000,"DESKTOP_SCREENSHOT_UNAVAILABLE");
            var className=new StringBuilder(256);GetClassName(target.Handle,className,className.Capacity);
            bool chromium=className.ToString().StartsWith("Chrome_WidgetWin",StringComparison.Ordinal);
            string fallbackReason=null;
            if(chromium){
                var captured=WgcWindowCapture.Capture(target.Handle,()=>!Allowed());
                CheckCaptureSnapshot(target,before);
                if(captured.Success)return WgcImage(captured,r,before);
                fallbackReason=WgcFallbackReason(captured);
            }
            using(var bitmap=new Bitmap(width,height)){
                bool printed;
                using(var graphics=Graphics.FromImage(bitmap)){IntPtr dc=graphics.GetHdc();try{printed=PrintWindow(target.Handle,dc,2);}finally{graphics.ReleaseHdc(dc);}}
                CheckCaptureSnapshot(target,before);AutomationJson.Require(printed,"DESKTOP_SCREENSHOT_UNAVAILABLE");
                double scale=Math.Min(1,1600.0/Math.Max(width,height));
                using(var output=new Bitmap(bitmap,new Size(Math.Max(1,(int)(width*scale)),Math.Max(1,(int)(height*scale)))))
                using(var bytes=new MemoryStream()){
                    output.Save(bytes,ImageFormat.Jpeg);AutomationJson.Require(bytes.Length<=2200000,"DESKTOP_SCREENSHOT_TOO_LARGE");
                    string data=Convert.ToBase64String(bytes.ToArray());CheckCaptureSnapshot(target,before);
                    return new {mimeType="image/jpeg",data,width=output.Width,height=output.Height,windowWidth=width,windowHeight=height,windowX=r.Left,windowY=r.Top,captureRect=new{x=0,y=0,width,height},physicalPixelsAvailable=physicalCoordinates,coordinateInputAvailable=!chromium && physicalCoordinates,source="native-window",captureFallback=fallbackReason,captureState=before.Output()};
                }
            }
        }
        void Send(Input[] inputs){
            var marked=inputs.Select(input=>MarkInput(input,inputMarker)).ToArray();
            DesktopDiagnostics.SetLastError(0);
            uint sent=SendInput((uint)marked.Length,marked,Marshal.SizeOf(typeof(Input)));
            int error=Marshal.GetLastWin32Error();
            if(sent==inputs.Length)return;
            var details=DesktopDiagnostics.Snapshot(selected==null?IntPtr.Zero:selected.Handle,selectedId);
            details["input"]=new {requested=inputs.Length,sent,win32Error=error,possibleUipi=DesktopDiagnostics.PossibleUipi(details)};
            // SendInput does not report whether UIPI caused a failure. Preserve
            // observed facts instead of presenting an inferred permission cause.
            throw DesktopDiagnostics.Fault("DESKTOP_INPUT_FAILED","SEND_INPUT_REJECTED_OR_PARTIAL",details);
        }
        static Input MarkInput(Input input,UIntPtr marker){
            if(marker==UIntPtr.Zero)throw new ArgumentException("Input marker must be nonzero");
            if(input.Type==0){
                // Windows mouse delivery can truncate dwExtraInfo to 32 bits,
                // including MSLLHOOKSTRUCT on x64. Send that dedicated value
                // explicitly; the observer registers it separately from keys.
                ulong source=marker.ToUInt64();uint low=unchecked((uint)source);
                input.Data.Mouse.Extra=new UIntPtr(low!=0?low:(uint)(source>>32));
            }
            else if(input.Type==1)input.Data.Key.Extra=marker;
            else throw new ArgumentException("Unsupported input packet type");
            return input;
        }
        uint InsertOne(Input input,out int error){
            input=MarkInput(input,inputMarker);
            DesktopDiagnostics.SetLastError(0);
            uint sent=SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)));
            error=Marshal.GetLastWin32Error();return sent;
        }
        static bool BelongsToWindow(AutomationElement element, Target target){
            var root=AutomationElement.FromHandle(target.Handle);
            for(int depth=0;element!=null && depth<64;depth++,element=TreeWalker.ControlViewWalker.GetParent(element))if(Automation.Compare(element,root))return true;
            return false;
        }
        IntPtr KeyboardFocusHandle(){
            var queue=new KeyboardQueue{Size=Marshal.SizeOf(typeof(KeyboardQueue))};
            return GetGUIThreadInfo(0,ref queue)?queue.Focus:IntPtr.Zero;
        }
        void CheckKeyboardFocus(AutomationElement expected,IntPtr nativeFocus){
            CheckControl();
            AutomationJson.Require(GetForegroundWindow()==selected.Handle,"DESKTOP_FOCUS_CHANGED");
            AutomationJson.Require(nativeFocus!=IntPtr.Zero && KeyboardFocusHandle()==nativeFocus,"DESKTOP_FOCUS_CHANGED");
            var current=AutomationElement.FocusedElement;
            AutomationJson.Require(current!=null && Automation.Compare(current,expected),"DESKTOP_FOCUS_CHANGED");
            // A focused-element provider read can block or let the destination
            // change. Check cancellation and top-level focus again before input.
            CheckControl();AutomationJson.Require(GetForegroundWindow()==selected.Handle && KeyboardFocusHandle()==nativeFocus,"DESKTOP_FOCUS_CHANGED");
        }
        void YieldAfterTextScalar(AutomationElement expected,IntPtr nativeFocus){
            // SendInput confirms insertion, not processing by the application.
            // Yield after a complete Unicode scalar to reduce queueing ahead of
            // focus-changing handlers, checking both native and UIA focus. This
            // is race mitigation, not a delivery acknowledgement or a guarantee
            // against a later asynchronous focus change.
            var yielded=Stopwatch.StartNew();
            do {Thread.Sleep(2);CheckKeyboardFocus(expected,nativeFocus);} while(yielded.ElapsedMilliseconds<10);
        }
        static bool ValidTypedText(string value){
            if(String.IsNullOrEmpty(value) || value.Length>512 || value.Any(Char.IsControl))return false;
            for(int i=0;i<value.Length;i++){
                if(Char.IsHighSurrogate(value[i])){if(i+1>=value.Length || !Char.IsLowSurrogate(value[++i]))return false;}
                else if(Char.IsLowSurrogate(value[i]))return false;
            }
            return true;
        }
        void Activate(Target target,bool required=true){
            if(GetForegroundWindow()==target.Handle)return;
            CheckControl();var watch=Stopwatch.StartNew();bool accepted=SetForegroundWindow(target.Handle);
            // Cross-queue foreground activation is asynchronous. Wait for the
            // actual state, without joining input queues or injecting other keys.
            while(watch.ElapsedMilliseconds<350){
                CheckControl();AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");
                if(GetForegroundWindow()==target.Handle)return;
                Thread.Sleep(10);
            }
            CheckControl();bool confirmed=GetForegroundWindow()==target.Handle;
            if(required && !confirmed){
                var details=DesktopDiagnostics.Snapshot(target.Handle,selectedId);
                details["activation"]=new {requested=true,apiAccepted=accepted,confirmed,elapsedMs=watch.ElapsedMilliseconds,reason="foreground_not_confirmed"};
                throw DesktopDiagnostics.Fault("DESKTOP_FOCUS_REQUIRED","FOREGROUND_NOT_CONFIRMED",details);
            }
        }
        static bool CanActivateForClick(Target target){
            var name=new StringBuilder(256);GetClassName(target.Handle,name,name.Capacity);
            // Activating a native menu steals focus from its owner and dismisses
            // the menu before the click. Explicit nonactivating windows likewise
            // keep their owner's keyboard focus while accepting pointer input.
            return name.ToString()!="#32768" && (GetWindowLongW(target.Handle,-20)&0x08000000)==0;
        }
        static Input Keyboard(ushort code,bool up,bool unicode){
            bool extended=!unicode && (code>=33 && code<=40 || code==46);
            // SDL-based clients identify physical keys from the scan code even
            // when Windows receives a virtual-key packet. Preserve VK/layout
            // semantics while supplying the corresponding hardware identity.
            ushort scan=unicode?code:(ushort)MapVirtualKeyW(code,0);
            AutomationJson.Require(unicode || scan!=0,"DESKTOP_KEY_UNSUPPORTED");
            return new Input{Type=1,Data=new InputUnion{Key=new Key{Vk=unicode?(ushort)0:code,Scan=scan,Flags=(up?2u:0u)|(unicode?4u:0u)|(extended?1u:0u)}}};
        }
        static ushort KeyCode(string key){
            var names=new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase){{"CTRL",17},{"CONTROL",17},{"ALT",18},{"SHIFT",16},{"ENTER",13},{"TAB",9},{"ESC",27},{"ESCAPE",27},{"BACKSPACE",8},{"DELETE",46},{"LEFT",37},{"UP",38},{"RIGHT",39},{"DOWN",40},{"HOME",36},{"END",35},{"PAGEUP",33},{"PAGEDOWN",34},{"SPACE",32}};
            ushort code;if(names.TryGetValue(key,out code))return code;if(key.Length==1 && Char.IsLetterOrDigit(key[0]) && key[0]<128)return (ushort)Char.ToUpperInvariant(key[0]);
            int f;if(key.Length>=2 && key.Length<=3 && (key[0]=='F' || key[0]=='f') && key[1]>='1' && key[1]<='9' && key.Skip(1).All(c=>c>='0' && c<='9') && Int32.TryParse(key.Substring(1),out f) && f>=1 && f<=12)return (ushort)(111+f);throw new AutomationFault("DESKTOP_KEY_UNSUPPORTED");
        }
        static bool SameRect(Rect a,Rect b){return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom;}
        static bool Inside(Point point,Rect bounds){return point.X>=bounds.Left && point.Y>=bounds.Top && point.X<bounds.Right && point.Y<bounds.Bottom;}
        static Input MouseInput(uint flags,int data=0){return new Input{Data=new InputUnion{Mouse=new Mouse{Flags=flags,Data=unchecked((uint)data)}}};}
        static int[] VirtualDesktop(){return new[]{GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(78),GetSystemMetrics(79)};}
        static void CheckVirtualDesktop(int[] expected){AutomationJson.Require(expected.SequenceEqual(VirtualDesktop()),"DESKTOP_DISPLAY_CHANGED");}
        static Input AbsolutePointer(Point point,int[] desktop){
            DesktopAbsolutePointer prepared;
            try{prepared=DesktopPointerCoordinates.Normalize(point.X,point.Y,desktop[0],desktop[1],desktop[2],desktop[3]);}
            catch(ArgumentOutOfRangeException){throw new AutomationFault("DESKTOP_DISPLAY_UNSUPPORTED");}
            return new Input{Data=new InputUnion{Mouse=new Mouse{X=prepared.X,Y=prepared.Y,Flags=prepared.Flags}}};
        }
        void ConfirmPointer(Point point,Rect bounds,int[] desktop){
            CheckPointer(point,bounds);CheckVirtualDesktop(desktop);Point current;
            AutomationJson.Require(GetCursorPos(out current),"DESKTOP_INPUT_STATE_UNKNOWN");
            AutomationJson.Require(current==point,"DESKTOP_POINTER_CHANGED");
            CheckControl();
        }
        void MovePointer(Point point,Rect bounds,int[] desktop){
            CheckPointer(point,bounds);CheckVirtualDesktop(desktop);
            // The virtual rectangle may contain gaps between real monitors.
            // Never let Windows clamp a point from such a gap onto another app.
            AutomationJson.Require(MonitorFromPoint(point,0)!=IntPtr.Zero,"DESKTOP_DISPLAY_UNSUPPORTED");
            Input input=AbsolutePointer(point,desktop);CheckControl();Send(new[]{input});
            // SendInput confirms insertion, not processing. Wait only for this
            // one move; never inject a second move to force the cursor back.
            var watch=Stopwatch.StartNew();
            for(;;){
                CheckControl();CheckVirtualDesktop(desktop);Point current;
                AutomationJson.Require(GetCursorPos(out current),"DESKTOP_INPUT_STATE_UNKNOWN");
                if(current==point)break;
                AutomationJson.Require(watch.ElapsedMilliseconds<100,"DESKTOP_POINTER_CHANGED");
                Thread.Sleep(2);
            }
            ConfirmPointer(point,bounds,desktop);
        }
        Point PointerPoint(Dictionary<string,object> p,Element element,Rect bounds){
            if(element!=null){var r=element.Value.Current.BoundingRectangle;return new Point((int)(r.X+r.Width/2),(int)(r.Y+r.Height/2));}
            AutomationJson.Require(imageReady,"DESKTOP_SCREENSHOT_REQUIRED");
            AutomationJson.Require(SameRect(bounds,imageBounds),"DESKTOP_WINDOW_CHANGED");
            int x=AutomationJson.Number(p,"x",-1),y=AutomationJson.Number(p,"y",-1);
            AutomationJson.Require(x>=0 && y>=0 && x<bounds.Right-bounds.Left && y<bounds.Bottom-bounds.Top);
            return new Point(bounds.Left+x,bounds.Top+y);
        }
        void CheckPointer(Point point,Rect expected){
            CheckControl();Rect current;
            AutomationJson.Require(Valid(selected) && GetWindowRect(selected.Handle,out current) && SameRect(current,expected),"DESKTOP_WINDOW_CHANGED");
            AutomationJson.Require(Inside(point,expected),"DESKTOP_BAD_REQUEST");
            AutomationJson.Require(GetAncestor(WindowFromPoint(point),2)==selected.Handle,"DESKTOP_WINDOW_OCCLUDED");
        }
        static object InputStateDetails(DesktopInputState.Snapshot state,DesktopInputState.Decision decision){
            return new {allowed=decision.Allowed,reason=decision.Reason,gaps=state.Gaps.ToString(),limitations=state.Limitations.ToString(),
                conflictingKeys=decision.ConflictingKeys,downKeys=state.DownKeys,probedKeys=state.ProbedKeys,
                mouseButtonsSwapped=state.MouseButtonsSwapped,
                foreground=state.Foreground.ToInt64().ToString(),
                foregroundCapture=state.ForegroundQueue==null?null:state.ForegroundQueue.Capture.ToInt64().ToString(),
                targetCapture=state.TargetQueue==null?null:state.TargetQueue.Capture.ToInt64().ToString(),
                elapsedMs=(state.CompletedTimestamp-state.StartedTimestamp)*1000.0/Stopwatch.Frequency};
        }
        void CheckInitialInput(Dictionary<string,object> p,string kind){
            int[] keys=new int[0];
            if(kind=="press_key")keys=((object[])p["keys"]).Cast<string>().Select(key=>(int)KeyCode(key)).Where(key=>key!=16 && key!=17 && key!=18).Distinct().ToArray();
            // Generic modifier aliases are already covered by both exact sides
            // in ProtectedKeyCodes. Nothing has been pressed by this action yet.
            var state=DesktopInputState.Read(selected.Handle,keys);
            var decision=DesktopInputState.Evaluate(state);
            if(decision.Allowed)return;
            var details=DesktopDiagnostics.Snapshot(selected.Handle,selectedId);
            details["inputState"]=InputStateDetails(state,decision);
            throw DesktopDiagnostics.Fault(decision.Code,decision.Reason,details);
        }
        static string ValidateAction(Dictionary<string,object> p){
            // Validate the entire per-kind shape before consuming the observation
            // or activating a window. Ignored fields can change user intent.
            string kind=AutomationJson.Text(p,"kind"),allowed="version,kind";
            bool pointer=false,requiresRef=false;
            switch(kind){
                case "invoke":case "toggle":case "select":case "expand":case "collapse":case "focus":case "restore":case "minimize":case "maximize":
                    allowed+=",ref";requiresRef=true;break;
                case "set_value":allowed+=",ref,value";requiresRef=true;break;
                case "scroll":allowed+=",ref,horizontal,vertical";requiresRef=true;break;
                case "click":case "double_click":allowed+=",ref,x,y,button";pointer=true;break;
                case "move":allowed+=",ref,x,y";pointer=true;break;
                case "drag":allowed+=",ref,x,y,toX,toY,button";pointer=true;break;
                case "wheel":allowed+=",ref,x,y,deltaX,deltaY";pointer=true;break;
                case "type_text":allowed+=",ref,value";break;
                case "press_key":allowed+=",ref,keys";break;
                default:throw new AutomationFault("DESKTOP_BAD_REQUEST");
            }
            AutomationJson.Fields(p,allowed);
            string observedVersion=AutomationJson.Text(p,"version");
            AutomationJson.Require(observedVersion.Length==32 && observedVersion.All(c=>c>='0' && c<='9' || c>='a' && c<='f'));
            bool hasRef=p.ContainsKey("ref"),hasX=p.ContainsKey("x"),hasY=p.ContainsKey("y");
            if(hasRef){string reference=AutomationJson.Text(p,"ref");AutomationJson.Require(reference.Length>1 && reference[0]=='e' && reference.Skip(1).All(c=>c>='0' && c<='9'));}
            if(requiresRef)AutomationJson.Require(hasRef);
            if(pointer){AutomationJson.Require(hasX==hasY && hasRef!=(hasX && hasY));}
            foreach(string coordinate in new[]{"x","y","toX","toY"})if(p.ContainsKey(coordinate)){
                int value=AutomationJson.Number(p,coordinate);AutomationJson.Require(value>=0 && value<=8191);
            }
            if(kind=="drag")AutomationJson.Require(p.ContainsKey("toX") && p.ContainsKey("toY"));
            if(p.ContainsKey("button")){string button=AutomationJson.Text(p,"button");AutomationJson.Require(button=="left" || button=="right" || button=="middle");}
            if(kind=="set_value" || kind=="type_text"){
                AutomationJson.Require(p.ContainsKey("value"));string value=AutomationJson.Text(p,"value");AutomationJson.Require(value.Length<=16384);
                if(kind=="type_text")AutomationJson.Require(ValidTypedText(value));
            }
            if(kind=="scroll"){
                int h=AutomationJson.Number(p,"horizontal",2),v=AutomationJson.Number(p,"vertical",2);
                AutomationJson.Require(h>=0 && h<=4 && v>=0 && v<=4 && (h!=2 || v!=2));
            }
            if(kind=="wheel"){
                int x=AutomationJson.Number(p,"deltaX"),y=AutomationJson.Number(p,"deltaY");
                AutomationJson.Require(x>=-1200 && x<=1200 && y>=-1200 && y<=1200 && (x!=0 || y!=0));
            }
            if(kind=="press_key"){
                object raw;AutomationJson.Require(p.TryGetValue("keys",out raw) && raw is object[]);var keys=(object[])raw;
                AutomationJson.Require(keys.Length>0 && keys.Length<=5 && keys.All(key=>key is string && ((string)key).Length>0 && ((string)key).Length<=20));
                var codes=keys.Cast<string>().Select(KeyCode).ToArray();AutomationJson.Require(codes.Distinct().Count()==codes.Length);
            }
            return kind;
        }
        static WindowPattern RequireWindowPattern(AutomationElement element){
            try{object supported;AutomationJson.Require(element.TryGetCurrentPattern(WindowPattern.Pattern,out supported) && supported is WindowPattern,"DESKTOP_ACTION_UNSUPPORTED");return (WindowPattern)supported;}
            catch(ElementNotAvailableException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_ELEMENT_UNAVAILABLE");}
            catch(InvalidOperationException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(COMException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(ArgumentException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(UnauthorizedAccessException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
            catch(NotSupportedException){throw new AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE","UIA_PROVIDER_ERROR");}
        }
        void ConfirmWindowState(Element element,Target target,int desired,Dictionary<string,object> evidence){
            var watch=Stopwatch.StartNew();
            while(true){
                CheckControl();AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");
                var request=new CacheRequest{TreeScope=TreeScope.Element};
                foreach(var property in WindowProperties)request.Add(property);
                request.Add(AutomationElement.ProcessIdProperty);
                // Refresh the same root provider. Do not use generic element
                // eligibility here: minimization is expected to make it offscreen.
                var currentRoot=AutomationElement.FromHandle(target.Handle);CheckControl();
                var cached=currentRoot.GetUpdatedCache(request);CheckControl();
                var state=ReadWindowState(cached,CheckControl);
                AutomationJson.Require(cached.Cached.ProcessId==target.Pid && element.RuntimeId.SequenceEqual(currentRoot.GetRuntimeId()),"DESKTOP_ELEMENT_CHANGED");
                AutomationJson.Require(state.Status=="readable" && state.NativeHandle==unchecked((int)target.Handle.ToInt64()),"DESKTOP_WINDOW_STATE_UNCONFIRMED");
                var placement=new WindowPlacement{Size=Marshal.SizeOf(typeof(WindowPlacement))};
                bool read=GetWindowPlacement(target.Handle,ref placement);int error=read?0:Marshal.GetLastWin32Error();
                evidence["after"]=new{uia=state.Output(),placementAvailable=read,showCommand=read?(int?)placement.ShowCommand:null,win32Error=read?(int?)null:error};
                evidence["foregroundAfter"]=GetForegroundWindow().ToInt64().ToString();evidence["elapsedMs"]=watch.ElapsedMilliseconds;
                CheckControl();AutomationJson.Require(Valid(target),"DESKTOP_WINDOW_CHANGED");
                AutomationJson.Require(read,"DESKTOP_WINDOW_STATE_UNCONFIRMED");
                AutomationJson.Require(watch.ElapsedMilliseconds<=400,"DESKTOP_WINDOW_STATE_UNCONFIRMED");
                if(DesktopWindowState.Confirmed(desired,state.Visual.Value,placement.ShowCommand)){evidence["confirmed"]=true;return;}
                if(watch.ElapsedMilliseconds>=400)throw new AutomationFault("DESKTOP_WINDOW_STATE_UNCONFIRMED");
                // Only repeat read-only confirmation, never SetWindowVisualState.
                // A synchronous provider call can exceed this polling budget;
                // the worker deadline remains the outer isolation boundary.
                System.Threading.Thread.Sleep(25);CheckControl();
            }
        }
        object Action(Dictionary<string,object> p){
            CheckControl();
            string kind=ValidateAction(p);
            if(backgroundTarget!=null){AutomationJson.Require(BackgroundAction(kind),"DESKTOP_BACKGROUND_ACTION_DENIED");CheckBackground();}
            AutomationJson.Require(HasObservation && Valid(selected) && AutomationJson.Text(p,"version")==version,"DESKTOP_OBSERVATION_STALE");
            string reference=AutomationJson.Text(p,"ref");Element element=null;WindowPattern windowPattern=null;bool shellInvoke=false;
            if(reference!=""){
                AutomationJson.Require(elements.TryGetValue(reference,out element),"DESKTOP_ELEMENT_CHANGED");
                if(DesktopWindowState.Desired(kind)>=0){
                    // Check provider support before consuming the version, and
                    // validate the fresh fingerprint after retrieving the pattern.
                    AutomationJson.Require(element.RootHandle==selected.Handle,"DESKTOP_ACTION_UNSUPPORTED");
                    AutomationJson.Require(element.Window.Status=="readable",element.Window.Status=="unsupported"?"DESKTOP_ACTION_UNSUPPORTED":"DESKTOP_ELEMENT_UNAVAILABLE");
                    windowPattern=RequireWindowPattern(element.Value);
                }
                var current=ValidateElement(element,kind);
                if(kind=="set_value")AutomationJson.Require(current.State.ReadOnly!=true,"DESKTOP_ELEMENT_UNAVAILABLE");
                AutomationJson.Require(BelongsToWindow(element.Value,selected),"DESKTOP_ELEMENT_CHANGED");
                if(windowPattern!=null)AutomationJson.Require(IsWindowEnabled(selected.Handle) && Valid(selected),"DESKTOP_ELEMENT_UNAVAILABLE");
                if(kind=="invoke"){
                    var rootClass=new StringBuilder(256);
                    AutomationJson.Require(GetClassName(selected.Handle,rootClass,rootClass.Capacity)>0,"DESKTOP_WINDOW_CHANGED");
                    shellInvoke=DesktopShellInvocation.UsesPointer(rootClass.ToString(),current.Role,current.Actions.Contains("invoke"));
                    if(backgroundTarget!=null)AutomationJson.Require(!shellInvoke,"DESKTOP_BACKGROUND_ACTION_DENIED");
                    if(shellInvoke)kind="click";
                }
            }
            bool physical=kind=="click" || kind=="double_click" || kind=="move" || kind=="drag" || kind=="wheel" || kind=="type_text" || kind=="press_key";
            if(backgroundTarget!=null){AutomationJson.Require(!physical && selectedId==backgroundWindowId,"DESKTOP_BACKGROUND_ACTION_DENIED");CheckBackground();}
            if(physical)CheckInitialInput(p,kind);
            CheckControl();
            version=""; // Consume BEFORE input. An unknown result cannot replay this observation.
            bool inputStarted=false;Exception failure=null;var deliveryFailures=new List<object>();Dictionary<string,object> windowState=null;
            var delivery=new InputDelivery<Input>(input=>{
                int error;uint sent=InsertOne(input,out error);
                if(sent!=1)deliveryFailures.Add(new {requested=1,sent,win32Error=error});
                return sent;
            });
            try{
            object pattern;
            if(windowPattern!=null){
                int desired=DesktopWindowState.Desired(kind);
                windowState=new Dictionary<string,object>{{"requested",DesktopWindowState.Name(desired)},{"before",element.Window.Output()},{"after",null},{"confirmed",false},{"foregroundBefore",GetForegroundWindow().ToInt64().ToString()},{"foregroundAfter",null},{"elapsedMs",0}};
                CheckControl();AutomationJson.Require(Valid(selected),"DESKTOP_WINDOW_CHANGED");inputStarted=true;
                windowPattern.SetWindowVisualState((WindowVisualState)desired);
                ConfirmWindowState(element,selected,desired,windowState);
            }else if(kind=="invoke" && element!=null && element.Value.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)){CheckControl();inputStarted=true;((InvokePattern)pattern).Invoke();}
            else if(kind=="set_value" && element!=null && element.Value.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)){
                string value=AutomationJson.Text(p,"value");AutomationJson.Require(value.Length<=16384 && !((ValuePattern)pattern).Current.IsReadOnly);CheckControl();inputStarted=true;((ValuePattern)pattern).SetValue(value);
            }else if(kind=="toggle" && element!=null && element.Value.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)){CheckControl();inputStarted=true;((TogglePattern)pattern).Toggle();}
            else if(kind=="select" && element!=null && element.Value.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)){CheckControl();inputStarted=true;((SelectionItemPattern)pattern).Select();}
            else if((kind=="expand" || kind=="collapse") && element!=null && element.Value.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)){CheckControl();inputStarted=true;if(kind=="expand")((ExpandCollapsePattern)pattern).Expand();else ((ExpandCollapsePattern)pattern).Collapse();}
            else if(kind=="scroll" && element!=null && element.Value.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern)){
                int h=AutomationJson.Number(p,"horizontal",2),v=AutomationJson.Number(p,"vertical",2);AutomationJson.Require(h>=0 && h<=4 && v>=0 && v<=4);CheckControl();inputStarted=true;((ScrollPattern)pattern).Scroll((ScrollAmount)h,(ScrollAmount)v);
            }else if(kind=="focus" && element!=null){CheckControl();inputStarted=true;element.Value.SetFocus();}
            else if(kind=="click" || kind=="double_click" || kind=="move" || kind=="drag" || kind=="wheel" || kind=="type_text" || kind=="press_key"){
                if(kind!="type_text" && kind!="press_key"){
                    AutomationJson.Require(physicalCoordinates,"DESKTOP_DPI_UNAVAILABLE");
                    Rect bounds;AutomationJson.Require(GetWindowRect(selected.Handle,out bounds),"DESKTOP_WINDOW_CHANGED");
                    int[] desktop=VirtualDesktop();CheckVirtualDesktop(desktop);
                    Point point=PointerPoint(p,element,bounds),end=point;
                    AutomationJson.Require(Inside(point,bounds),"DESKTOP_BAD_REQUEST");
                    string button=shellInvoke?DesktopShellInvocation.PrimaryButton(GetSystemMetrics(23)!=0):AutomationJson.Text(p,"button","left");AutomationJson.Require(button=="left" || button=="right" || button=="middle");
                    uint down=button=="left"?2u:button=="right"?8u:32u,up=button=="left"?4u:button=="right"?16u:64u;
                    int deltaX=AutomationJson.Number(p,"deltaX"),deltaY=AutomationJson.Number(p,"deltaY");
                    if(kind=="wheel")AutomationJson.Require(deltaX>=-1200 && deltaX<=1200 && deltaY>=-1200 && deltaY<=1200 && (deltaX!=0 || deltaY!=0));
                    if(kind=="drag"){
                        AutomationJson.Require(imageReady,"DESKTOP_SCREENSHOT_REQUIRED");AutomationJson.Require(SameRect(bounds,imageBounds),"DESKTOP_WINDOW_CHANGED");
                        int toX=AutomationJson.Number(p,"toX",-1),toY=AutomationJson.Number(p,"toY",-1);
                        AutomationJson.Require(toX>=0 && toY>=0 && toX<bounds.Right-bounds.Left && toY<bounds.Bottom-bounds.Top);
                        end=new Point(bounds.Left+toX,bounds.Top+toY);
                    }
                    // Validate both endpoints before consuming any mouse input.
                    AbsolutePointer(point,desktop);AbsolutePointer(end,desktop);
                    // A visible topmost dialog may still sit above an elevated
                    // foreground app. Try to activate it before SendInput, but
                    // do not require activation for tray/nonactivating popups.
                    bool canActivate=CanActivateForClick(selected);
                    // Wheel delivery can follow keyboard focus when Windows'
                    // inactive-window scrolling is disabled. Do not scroll an
                    // unrelated foreground window just because the pointer fits.
                    if(kind=="wheel")AutomationJson.Require(canActivate,"DESKTOP_FOCUS_REQUIRED");
                    // Tray flyouts and WS_EX_NOACTIVATE windows accept pointer
                    // input without becoming the keyboard foreground window.
                    // Activate only when the observed point is actually covered.
                    bool covered=GetAncestor(WindowFromPoint(point),2)!=selected.Handle;
                    if(covered)AutomationJson.Require(canActivate,"DESKTOP_WINDOW_OCCLUDED");
                    if(canActivate)Activate(selected,covered || kind=="wheel");
                    if(element!=null)ValidateElement(element);
                    CheckPointer(point,bounds);if(kind=="drag")CheckPointer(end,bounds);
                    // Activation/provider reads may take time. Recheck before
                    // the first event while this action still owns no down keys.
                    CheckInitialInput(p,kind);
                    CheckControl();
                    inputStarted=true;MovePointer(point,bounds,desktop);
                    if(kind=="wheel"){
                        // Windows wheel units: +Y scrolls up; +X scrolls right.
                        if(deltaY!=0){ConfirmPointer(point,bounds,desktop);AutomationJson.Require(GetForegroundWindow()==selected.Handle,"DESKTOP_FOCUS_CHANGED");Send(new[]{MouseInput(0x0800,deltaY)});}
                        if(deltaX!=0){ConfirmPointer(point,bounds,desktop);AutomationJson.Require(GetForegroundWindow()==selected.Handle,"DESKTOP_FOCUS_CHANGED");Send(new[]{MouseInput(0x1000,deltaX)});}
                    }else if(kind=="drag"){
                        ConfirmPointer(point,bounds,desktop);
                        delivery.Press(MouseInput(down),MouseInput(up),InputReleaseLabel.Mouse(button));
                        for(int step=1;step<=20;step++){
                            Point next=new Point(point.X+(end.X-point.X)*step/20,point.Y+(end.Y-point.Y)*step/20);
                            MovePointer(next,bounds,desktop);Thread.Sleep(10);
                        }
                        CheckPointer(end,bounds);delivery.ReleaseLast();
                    }else if(kind!="move"){
                        int count=kind=="double_click"?2:1;
                        for(int click=0;click<count;click++){
                            ConfirmPointer(point,bounds,desktop);delivery.Press(MouseInput(down),MouseInput(up),InputReleaseLabel.Mouse(button));delivery.ReleaseLast();
                            if(click+1<count)Thread.Sleep((int)Math.Min(50u,Math.Max(1u,GetDoubleClickTime()/4)));
                        }
                    }
                }else{
                    Activate(selected);
                    var focused=AutomationElement.FocusedElement;AutomationJson.Require(focused!=null && BelongsToWindow(focused,selected),"DESKTOP_FOCUS_REQUIRED");
                    if(element!=null)AutomationJson.Require(Automation.Compare(focused,element.Value),"DESKTOP_FOCUS_REQUIRED");
                    if(element!=null)ValidateElement(element);
                    CheckInitialInput(p,kind);
                    IntPtr nativeFocus=KeyboardFocusHandle();AutomationJson.Require(nativeFocus!=IntPtr.Zero,"DESKTOP_FOCUS_REQUIRED");
                    if(kind=="type_text"){
                        string value=AutomationJson.Text(p,"value");AutomationJson.Require(ValidTypedText(value),"DESKTOP_BAD_REQUEST");
                        for(int index=0;index<value.Length;index++){
                            CheckKeyboardFocus(focused,nativeFocus);
                            int units=Char.IsHighSurrogate(value[index])?2:1;
                            for(int unit=0;unit<units;unit++){
                                char c=value[index+unit];inputStarted=true;
                                delivery.Press(Keyboard(c,false,true),Keyboard(c,true,true),InputReleaseLabel.Unicode());delivery.ReleaseLast();
                            }
                            index+=units-1;YieldAfterTextScalar(focused,nativeFocus);
                        }
                    }else{
                        object raw;AutomationJson.Require(p.TryGetValue("keys",out raw) && raw is object[]);var keys=(object[])raw;AutomationJson.Require(keys.Length>0 && keys.Length<=5 && keys.All(x=>x is string));var codes=keys.Cast<string>().Select(KeyCode).ToArray();
                        foreach(var code in codes){CheckKeyboardFocus(focused,nativeFocus);inputStarted=true;delivery.Press(Keyboard(code,false,false),Keyboard(code,true,false),InputReleaseLabel.Key(code));}
                    }
                }
            }else throw new AutomationFault("DESKTOP_ACTION_UNSUPPORTED");
            CheckControl();CheckBackground();
            }catch(Exception error){failure=error;}
            finally{
                // A zero-count down was not inserted and must not get a stray up.
                // Confirmed/unknown downs are unwound even after cancellation.
                // Release insertion is not proof that Windows has processed it.
                failure=delivery.Cleanup(failure);
            }
            if(failure!=null){
                if(inputStarted){
                    var details=failure.Data["diagnostics"] as Dictionary<string,object> ?? DesktopDiagnostics.Snapshot(selected==null?IntPtr.Zero:selected.Handle,selectedId);
                    details["inputCleanup"]=delivery.LastCleanup;
                    if(shellInvoke){details["requestedAction"]="invoke";details["inputRoute"]="marked-pointer";}
                    if(windowState!=null){windowState["foregroundAfter"]=GetForegroundWindow().ToInt64().ToString();details["windowState"]=windowState;}
                    if(deliveryFailures.Count>0)details["inputDeliveryFailures"]=deliveryFailures.ToArray();
                    failure.Data["diagnostics"]=details;
                }
                if(!failure.Data.Contains("diagnostics") && (failure.Message=="DESKTOP_FOCUS_REQUIRED" || failure.Message=="DESKTOP_FOCUS_CHANGED"))failure.Data["diagnostics"]=DesktopDiagnostics.Snapshot(selected==null?IntPtr.Zero:selected.Handle,selectedId);
                if(inputStarted){var fault=failure as AutomationFault;var deliveryFault=failure as InputDeliveryException;var uncertain=new AutomationFault("DESKTOP_OUTCOME_UNKNOWN",deliveryFault!=null?deliveryFault.Cause:fault==null?failure.GetType().Name:fault.Cause??fault.Message);uncertain.Data["diagnostics"]=failure.Data["diagnostics"];throw uncertain;}
                throw failure;
            }
            if(windowState!=null)return new {executed=true,requiresObservation=true,windowState};
            if(shellInvoke)return new {executed=true,requiresObservation=true,requestedAction="invoke",inputRoute="marked-pointer"};
            return new {executed=true,requiresObservation=true};
        }
        public object Handle(string op,Dictionary<string,object> p){
            IntPtr previous=IntPtr.Zero;try{
                try{previous=SetThreadDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
                physicalCoordinates=previous!=IntPtr.Zero;
                if(op=="diagnostics"){
                    AutomationJson.Require(Allowed(),"DESKTOP_USER_STOPPED");
                    AutomationJson.Fields(p,"windowId");string id=AutomationJson.Text(p,"windowId");Target target=null;
                    if(id!="")AutomationJson.Require(targets.TryGetValue(id,out target) && Valid(target),"DESKTOP_WINDOW_CHANGED");
                    var details=DesktopDiagnostics.Snapshot(target==null?IntPtr.Zero:target.Handle,id==""?null:id);
                    details["coordinates"]=new {physicalPixelsAvailable=physicalCoordinates,maximumVirtualSpan=DesktopPointerCoordinates.MaximumSpan};
                    if(target!=null){var state=DesktopInputState.Read(target.Handle);details["inputState"]=InputStateDetails(state,DesktopInputState.Evaluate(state));}
                    return details;
                }
                CheckControl();if(op=="windows"){AutomationJson.Fields(p,"");return Windows();}
                if(op=="control.background"){
                    AutomationJson.Fields(p,"windowId");string id=AutomationJson.Text(p,"windowId");Target target;
                    AutomationJson.Require(targets.TryGetValue(id,out target) && Valid(target),"DESKTOP_WINDOW_CHANGED");
                    AutomationJson.Require(backgroundTarget==null || backgroundWindowId==id,"DESKTOP_MODE_CONFLICT");
                    backgroundTarget=target;backgroundWindowId=id;version="";imageReady=false;
                    CheckBackground();
                    return new {mode="background",backgroundTarget=new {pid=target.Pid,window=target.Handle.ToInt64().ToString()}};
                }
                if(op=="window.observe" || op=="window.screenshot")return Observe(p,op=="window.screenshot");
                if(op=="window.action")return Action(p);
                throw new AutomationFault("DESKTOP_BAD_REQUEST");
            }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
        }
        public void Dispose(){selected=null;selectedId=null;elements.Clear();targets.Clear();version="";}
    }
}
