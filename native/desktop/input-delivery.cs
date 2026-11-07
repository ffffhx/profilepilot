using System;
using System.Collections.Generic;

namespace ProfilePilot.Desktop {
    // Labels describe releases without retaining text or Unicode character codes.
    // Payload T is private to the ledger and is never part of a diagnostic report.
    public sealed class InputReleaseLabel {
        public readonly string Kind;
        public readonly int? VirtualKey;
        public readonly string Button;
        InputReleaseLabel(string kind,int? key,string button){Kind=kind;VirtualKey=key;Button=button;}
        public static InputReleaseLabel Unicode(){return new InputReleaseLabel("unicode",null,null);}
        public static InputReleaseLabel Key(int key){
            if(key<1 || key>254 || key==231 || key==1 || key==2 || key==4 || key==5 || key==6)throw new ArgumentOutOfRangeException("key");
            return new InputReleaseLabel("key",key,null);
        }
        public static InputReleaseLabel Mouse(string button){
            if(button!="left" && button!="right" && button!="middle")throw new ArgumentException("Unsupported mouse button","button");
            return new InputReleaseLabel("mouse",null,button);
        }
    }
    public sealed class InputDeliveryException : Exception {
        public readonly string Phase;
        public readonly uint SentCount;
        public readonly string Cause;
        public InputDeliveryException(string phase,uint sent):base("DESKTOP_INPUT_FAILED"){
            Phase=phase;SentCount=sent;Cause=sent==0?"SEND_INPUT_REJECTED":"SEND_INPUT_COUNT_INVALID";
        }
    }
    public sealed class InputReleaseAttempt {
        public readonly InputReleaseLabel Label;
        public readonly string DownDisposition;
        public readonly string ReleaseDisposition;
        public readonly uint? SentCount;
        internal InputReleaseAttempt(InputReleaseLabel label,string down,string release,uint? sent){Label=label;DownDisposition=down;ReleaseDisposition=release;SentCount=sent;}
    }
    public sealed class InputCleanupReport {
        public readonly InputReleaseAttempt[] Attempts;
        public readonly int PendingReleaseCount;
        // Inserted is SendInput's acknowledgement, not proof that Windows or the
        // destination application processed an up event or that a key is now up.
        public bool AllReleasesInserted {get{return PendingReleaseCount==0;}}
        internal InputCleanupReport(InputReleaseAttempt[] attempts,int pending){Attempts=attempts;PendingReleaseCount=pending;}
    }
    // Pure, single-threaded bookkeeping. The callback submits exactly one event
    // and returns its inserted count. No OS API, cancellation policy or retry of a
    // down event belongs here. Cleanup must remain callable after cancellation.
    public sealed class InputDelivery<T> {
        sealed class Pending {
            public T Release;
            public InputReleaseLabel Label;
            public string DownDisposition;
        }
        readonly Func<T,uint> sendOne;
        readonly List<Pending> pending=new List<Pending>();
        public int PendingCount {get{return pending.Count;}}
        public InputCleanupReport LastCleanup {get;private set;}
        public InputDelivery(Func<T,uint> sendOne){
            if(sendOne==null)throw new ArgumentNullException("sendOne");
            this.sendOne=sendOne;
        }
        public void Press(T down,T release,InputReleaseLabel label){
            if(label==null)throw new ArgumentNullException("label");
            uint sent;
            try{sent=sendOne(down);}
            catch{
                // A throwing callback cannot establish whether it inserted the
                // down. Keep a release for conservative unwinding, then preserve
                // the original exception without reading or storing its text.
                pending.Add(new Pending{Release=release,Label=label,DownDisposition="unknown"});
                throw;
            }
            if(sent==1){pending.Add(new Pending{Release=release,Label=label,DownDisposition="inserted"});return;}
            if(sent!=0)pending.Add(new Pending{Release=release,Label=label,DownDisposition="unknown"});
            // Zero explicitly means no event was inserted. Sending an up for it
            // could release input owned by somebody else.
            throw new InputDeliveryException("down",sent);
        }
        public void ReleaseLast(){
            if(pending.Count==0)throw new InvalidOperationException("No pending release");
            int index=pending.Count-1;
            uint sent=sendOne(pending[index].Release);
            if(sent!=1)throw new InputDeliveryException("release",sent);
            pending.RemoveAt(index);
        }
        public Exception Cleanup(Exception originalFailure){
            Exception failure=originalFailure;
            var attempts=new List<InputReleaseAttempt>();
            for(int index=pending.Count-1;index>=0;index--){
                var entry=pending[index];uint? sent=null;
                try{
                    sent=sendOne(entry.Release);
                    if(sent!=1)throw new InputDeliveryException("release",sent.Value);
                    pending.RemoveAt(index);
                    attempts.Add(new InputReleaseAttempt(entry.Label,entry.DownDisposition,"inserted",sent));
                }catch(Exception error){
                    if(failure==null)failure=error;
                    attempts.Add(new InputReleaseAttempt(entry.Label,entry.DownDisposition,sent==0?"rejected":"unknown",sent));
                }
            }
            LastCleanup=new InputCleanupReport(attempts.ToArray(),pending.Count);
            return failure;
        }
    }
}
