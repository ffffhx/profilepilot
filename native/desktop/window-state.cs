using System;
using System.Linq;
using System.Runtime.InteropServices;

namespace ProfilePilot.Desktop {
    // Pure policy over one collected window snapshot. No HWND/UIA/input calls.
    internal static class DesktopWindowState {
        internal sealed class Snapshot {
            public string Status="unsupported";
            public int? NativeHandle,Visual,Interaction;
            public bool? CanMinimize,CanMaximize,Modal;
            public object Output(){return new{status=Status,visualState=Visual.HasValue?Name(Visual.Value):null,canMinimize=CanMinimize,canMaximize=CanMaximize,isModal=Modal,interactionState=Interaction,nativeHandle=NativeHandle.HasValue?unchecked((uint)NativeHandle.Value).ToString():null};}
        }
        internal static string Name(int value){return value==0?"normal":value==1?"maximized":value==2?"minimized":null;}
        internal static int Desired(string kind){return kind=="restore"?0:kind=="maximize"?1:kind=="minimize"?2:-1;}
        static T Property<T>(Func<string,object> read,string key,Action checkpoint){checkpoint();object value=read(key);checkpoint();if(!(value is T))throw new InvalidOperationException("Unknown window property");return (T)value;}
        internal static Snapshot Read(Func<string,object> read,Action checkpoint){
            try{
                if(!Property<bool>(read,"available",checkpoint))return new Snapshot();
                var state=new Snapshot{NativeHandle=Property<int>(read,"nativeHandle",checkpoint),Visual=Property<int>(read,"visual",checkpoint),CanMinimize=Property<bool>(read,"canMinimize",checkpoint),CanMaximize=Property<bool>(read,"canMaximize",checkpoint),Modal=Property<bool>(read,"modal",checkpoint),Interaction=Property<int>(read,"interaction",checkpoint)};
                if(state.NativeHandle==0 || state.Visual<0 || state.Visual>2 || state.Interaction<0 || state.Interaction>4)throw new InvalidOperationException("Unknown window state");
                state.Status="readable";return state;
            }catch(COMException){return new Snapshot{Status="unavailable"};}
            catch(InvalidOperationException){return new Snapshot{Status="unavailable"};}
            catch(ArgumentException){return new Snapshot{Status="unavailable"};}
            catch(UnauthorizedAccessException){return new Snapshot{Status="unavailable"};}
            catch(NotSupportedException){return new Snapshot{Status="unavailable"};}
        }
        internal static object[] Identity(Snapshot state){return new object[]{state.Status,state.NativeHandle,state.Visual,state.CanMinimize,state.CanMaximize,state.Modal,state.Interaction};}
        internal static string Rejection(string kind,Snapshot observed,Snapshot current,bool exactRoot,bool enabled,bool offscreen,bool observedIconic,bool currentIconic){
            if(Desired(kind)<0 || !exactRoot)return "DESKTOP_ACTION_UNSUPPORTED";
            if(observed.Status=="unsupported" || current.Status=="unsupported")return "DESKTOP_ACTION_UNSUPPORTED";
            if(observed.Status!="readable" || current.Status!="readable")return "DESKTOP_ELEMENT_UNAVAILABLE";
            if(!Identity(observed).SequenceEqual(Identity(current)))return "DESKTOP_ELEMENT_CHANGED";
            if(observedIconic!=(observed.Visual==2) || currentIconic!=(current.Visual==2))return "DESKTOP_ELEMENT_UNAVAILABLE";
            if(!enabled || current.Modal!=false || current.Interaction!=2)return "DESKTOP_ELEMENT_UNAVAILABLE";
            // Only restoring the selected, enabled iconic root may cross the
            // existing offscreen gate. This never permits child input/focus.
            if(offscreen && !(kind=="restore" && observed.Visual==2 && current.Visual==2 && observedIconic && currentIconic))return "DESKTOP_ELEMENT_UNAVAILABLE";
            if(kind=="minimize" && current.CanMinimize!=true || kind=="maximize" && current.CanMaximize!=true)return "DESKTOP_ACTION_UNSUPPORTED";
            return null;
        }
        internal static bool Confirmed(int requested,int uiaState,int showCommand){return requested>=0 && requested<=2 && requested==uiaState && showCommand==(requested==0?1:requested==1?3:2);}
    }
}
