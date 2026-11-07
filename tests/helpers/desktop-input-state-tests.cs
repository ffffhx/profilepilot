using System;
using System.Collections.Generic;
using System.Linq;
using ProfilePilot.Desktop;

// Pure policy tests only: no Read(), HWND lookup, desktop observation, input,
// process-token query, window creation or UI Automation call is performed.
public static class DesktopInputStateTests {
    static readonly List<string> Checks=new List<string>();
    static readonly IntPtr Target=new IntPtr(100),Foreground=new IntPtr(200),Child=new IntPtr(101),Other=new IntPtr(300);
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Check(string name,Action body){body();Checks.Add(name);}
    static DesktopInputState.AccessSnapshot Access(){return new DesktopInputState.AccessSnapshot{
        CallingDesktopActive=true,ForegroundDesktopActive=true,TargetDesktopActive=true,
        DefaultInputDesktop=true,DesktopReadAccess=true,SourceIntegrity=8192,ForegroundIntegrity=8192
    };}
    static DesktopInputState.Snapshot State(params int[] down){return new DesktopInputState.Snapshot{
        Supported=true,Target=Target,Foreground=Foreground,TargetPid=10,ForegroundPid=20,Access=Access(),
        TargetQueue=new DesktopInputState.QueueSnapshot{Available=true,ThreadId=10},
        ForegroundQueue=new DesktopInputState.QueueSnapshot{Available=true,ThreadId=20},
        ProbedKeys=DesktopInputState.ProtectedKeyCodes(),DownKeys=down
    };}
    static DesktopInputState.Ownership Owned(params int[] down){return new DesktopInputState.Ownership{
        Target=Target,ConfirmedDownKeys=down,InitialMouseButtonsSwapped=false
    };}
    static DesktopInputState.Decision Denied(DesktopInputState.Snapshot state,string reason,DesktopInputState.Ownership owned=null){
        var decision=DesktopInputState.Evaluate(state,owned);
        Assert(!decision.Allowed && decision.Reason==reason,"Expected "+reason+", got "+decision.Reason);
        return decision;
    }
    static void Capture(DesktopInputState.QueueSnapshot queue,IntPtr window,bool within){queue.Capture=window;queue.CaptureIsTargetOrChild=within;}
    public static int Main(){
        Check("clean initial sample preserves the separate foreground policy",()=>{
            var state=State();Assert(state.Target!=state.Foreground && DesktopInputState.Evaluate(state).Allowed,"Guard changed foreground policy");
        });
        Check("every protected mouse button and sided modifier blocks initial input",()=>{
            foreach(int key in DesktopInputState.ProtectedKeyCodes()){
                var decision=Denied(State(key),"unowned_key_down");
                Assert(decision.Code=="DESKTOP_INPUT_CONFLICT" && decision.ConflictingKeys.SequenceEqual(new[]{key}),"Held key missing");
            }
        });
        Check("an ordinary planned key already down also blocks",()=>{
            var state=State(65);state.ProbedKeys=state.ProbedKeys.Concat(new[]{65}).ToArray();
            Denied(state,"unowned_key_down");
        });
        Check("initial target capture is foreign even with no held button",()=>{
            var state=State();Capture(state.TargetQueue,Target,true);Denied(state,"unexpected_mouse_capture");
        });
        Check("initial foreground capture is foreign",()=>{
            var state=State();Capture(state.ForegroundQueue,Other,false);
            Assert(Denied(state,"unexpected_mouse_capture").Capture==Other,"Capture identity omitted");
        });
        Check("confirmed mouse-down may continue without capture",()=>Assert(DesktopInputState.Evaluate(State(1),Owned(1)).Allowed,"Own button rejected"));
        Check("target and target child capture may continue a confirmed gesture",()=>{
            foreach(IntPtr window in new[]{Target,Child}){
                var state=State(1);Capture(state.TargetQueue,window,true);var owned=Owned(1);owned.AllowTargetCapture=true;
                Assert(DesktopInputState.Evaluate(state,owned).Allowed,"Target gesture capture rejected");
            }
        });
        Check("capture cannot be allowed without an owned button",()=>{
            var state=State(162);Capture(state.TargetQueue,Child,true);var owned=Owned(162);owned.AllowTargetCapture=true;
            Denied(state,"unexpected_mouse_capture",owned);
        });
        Check("owned mouse does not implicitly authorize capture",()=>{
            var state=State(1);Capture(state.TargetQueue,Child,true);Denied(state,"unexpected_mouse_capture",Owned(1));
        });
        Check("same-process sibling or owned popup is still outside target",()=>{
            var state=State(1);Capture(state.ForegroundQueue,Other,false);var owned=Owned(1);owned.AllowTargetCapture=true;
            Denied(state,"unexpected_mouse_capture",owned);
        });
        Check("ownership from a different selected window is rejected",()=>{
            var owned=Owned(1);owned.Target=Other;Denied(State(1),"invalid_ownership",owned);
        });
        Check("new foreign modifier stops an active gesture",()=>{
            var decision=Denied(State(1,163),"unowned_key_down",Owned(1));
            Assert(decision.ConflictingKeys.SequenceEqual(new[]{163}),"Own button incorrectly marked foreign");
        });
        Check("right modifier cannot be mistaken for owned left modifier",()=>Denied(State(162,163),"unowned_key_down",Owned(162)));
        Check("generic modifier ownership is rejected",()=>{
            foreach(int key in new[]{16,17,18})Denied(State(162),"invalid_ownership",Owned(key));
        });
        Check("unexpected release of a confirmed key stops continuation",()=>{
            var result=Denied(State(),"owned_key_released",Owned(162));
            Assert(result.Code=="DESKTOP_INPUT_STATE_CHANGED" && result.ConflictingKeys.SequenceEqual(new[]{162}),"Release detail missing");
        });
        Check("unknown input attempts cannot authorize continuation or capture",()=>{
            var state=State(1);Capture(state.TargetQueue,Child,true);var owned=Owned();owned.UncertainDownKeys=new[]{1};owned.AllowTargetCapture=true;
            Denied(state,"unconfirmed_input_attempt",owned);
        });
        Check("owned ordinary keys must be included in the sample",()=>{
            Denied(State(),"owned_key_not_sampled",Owned(65));
            var state=State(65);state.ProbedKeys=state.ProbedKeys.Concat(new[]{65}).ToArray();
            Assert(DesktopInputState.Evaluate(state,Owned(65)).Allowed,"Sampled ordinary key rejected");
        });
        Check("changed or missing mouse mapping blocks an active mouse gesture",()=>{
            var state=State(1);state.MouseButtonsSwapped=true;Denied(state,"mouse_mapping_unverified_or_changed",Owned(1));
            var owned=Owned(1);owned.InitialMouseButtonsSwapped=null;Denied(State(1),"mouse_mapping_unverified_or_changed",owned);
            owned.InitialMouseButtonsSwapped=true;
            Assert(DesktopInputState.Evaluate(state,owned).Allowed,"Stable physical-VK mapping rejected");
        });
        Check("swapped buttons do not weaken the initial held-button guard",()=>{
            var state=State(2);state.MouseButtonsSwapped=true;Denied(state,"unowned_key_down");
        });
        Check("an existing window move or resize loop blocks input",()=>{
            foreach(bool foreground in new[]{false,true}){
                var state=State();(foreground?state.ForegroundQueue:state.TargetQueue).Flags=2;
                Denied(state,"window_move_or_size_in_progress");
            }
        });
        Check("queue failure is unknown, not capture-free",()=>{
            var state=State();state.TargetQueue.Available=false;state.TargetQueue.Error=5;
            var result=Denied(state,"incomplete_snapshot");Assert((result.Gaps&DesktopInputState.Gap.QueueUnavailable)!=0,"Queue gap missing");
        });
        Check("missing target and foreground are unknown",()=>{
            var state=State();state.Target=IntPtr.Zero;Denied(state,"incomplete_snapshot");
            state=State();state.Foreground=IntPtr.Zero;Denied(state,"incomplete_snapshot");
        });
        Check("all-zero keys never override uncertain access prerequisites",()=>{
            var state=State();state.Access.SourceIntegrity=null;
            var result=Denied(state,"incomplete_snapshot");Assert((result.Gaps&DesktopInputState.Gap.IntegrityUnknown)!=0,"Integrity gap missing");
            state=State();state.Access.ForegroundIntegrity=12288;Denied(state,"incomplete_snapshot");
            state=State();state.Access.DesktopReadAccess=false;Denied(state,"incomplete_snapshot");
        });
        Check("inactive or unreadable desktops fail closed",()=>{
            var state=State();state.Access.CallingDesktopActive=false;Denied(state,"incomplete_snapshot");
            state=State();state.Access.ForegroundDesktopActive=null;Denied(state,"incomplete_snapshot");
            state=State();state.Access.TargetDesktopActive=false;Denied(state,"incomplete_snapshot");
            state=State();state.Access.DefaultInputDesktop=false;Denied(state,"incomplete_snapshot");
        });
        Check("state races, invalid capture handles and slow samples fail closed",()=>{
            foreach(var gap in new[]{DesktopInputState.Gap.ContextChanged,DesktopInputState.Gap.KeyStateChanged,
                DesktopInputState.Gap.CaptureUnavailable,DesktopInputState.Gap.CollectionTooSlow}){
                var state=State();state.Gaps=gap;Assert((Denied(state,"incomplete_snapshot").Gaps&gap)!=0,"Gap lost");
            }
        });
        Check("incomplete key coverage and inconsistent samples fail closed",()=>{
            var state=State();state.ProbedKeys=state.ProbedKeys.Where(key=>key!=163).ToArray();Denied(state,"protected_key_not_sampled");
            Denied(State(65),"down_key_not_sampled");
            state=State();state.ProbedKeys=null;Denied(state,"incomplete_snapshot");
        });
        Check("macOS and unsupported platform snapshots reject without native calls",()=>{
            var state=State();state.Supported=false;
            Assert(Denied(state,"windows_only").Code=="DESKTOP_UNSUPPORTED","Platform boundary lost");
        });
        Check("policy does not mutate observations or ownership for cleanup",()=>{
            var state=State(1,163);var owned=Owned(1);int[] down=(int[])state.DownKeys.Clone(),keys=(int[])owned.ConfirmedDownKeys.Clone();
            Denied(state,"unowned_key_down",owned);
            Assert(state.DownKeys.SequenceEqual(down) && owned.ConfirmedDownKeys.SequenceEqual(keys),"Policy modified caller cleanup state");
        });
        Check("limitations include source ambiguity and restricted capture scope",()=>{
            var limits=State().Limitations;
            foreach(var flag in new[]{DesktopInputState.Limitation.CurrentStateNotInputOrigin,DesktopInputState.Limitation.ForegroundAndTargetQueuesOnly,
                DesktopInputState.Limitation.NonAtomic,DesktopInputState.Limitation.SameKeyTakeoverNotDistinguishable,DesktopInputState.Limitation.ZeroMayMeanReadFailure})
                Assert((limits&flag)!=0,"Observation limitation omitted");
        });
        Console.WriteLine(AutomationJson.Json.Serialize(new{ok=true,checks=Checks}));return 0;
    }
}
