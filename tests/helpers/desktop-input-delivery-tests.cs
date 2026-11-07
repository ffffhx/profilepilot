using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

// No native driver is linked. Every dispatched event is an in-memory fake value.
public static class DesktopInputDeliveryTests {
    static readonly List<string> Checks=new List<string>();
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Check(string name,Action body){body();Checks.Add(name);}
    static Exception Throws(Action body){try{body();}catch(Exception error){return error;}throw new Exception("Expected an exception");}
    static readonly InputReleaseLabel Ctrl=InputReleaseLabel.Key(17),Left=InputReleaseLabel.Mouse("left");
    public static int Main(){
        Check("zero inserted down never creates an orphan up",()=>{
            var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return 0;});
            var error=Throws(()=>ledger.Press(10,11,Left)) as InputDeliveryException;
            Assert(error!=null && error.SentCount==0 && error.Phase=="down","Zero count detail missing");
            Assert(ledger.PendingCount==0,"Rejected down was registered");
            Assert(Object.ReferenceEquals(error,ledger.Cleanup(error)),"Original rejected down lost");
            Assert(sent.SequenceEqual(new[]{10}) && ledger.LastCleanup.Attempts.Length==0,"An orphan up was submitted");
        });
        Check("one inserted down registers exactly one explicit release",()=>{
            var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return 1;});
            ledger.Press(10,11,Left);Assert(ledger.PendingCount==1,"Inserted down missing");
            ledger.ReleaseLast();Assert(ledger.PendingCount==0 && sent.SequenceEqual(new[]{10,11}),"Release mismatch");
            Assert(ledger.Cleanup(null)==null && ledger.LastCleanup.Attempts.Length==0,"Released input was repeated");
        });
        Check("a throwing down retains unknown release and the original exception",()=>{
            var first=new InvalidOperationException("private payload");int calls=0;
            var ledger=new InputDelivery<int>(value=>{if(++calls==1)throw first;return 1;});
            Assert(Object.ReferenceEquals(first,Throws(()=>ledger.Press(10,11,Left))),"Down exception replaced");
            Assert(ledger.PendingCount==1 && Object.ReferenceEquals(first,ledger.Cleanup(first)),"Unknown down missing");
            var attempt=ledger.LastCleanup.Attempts.Single();
            Assert(attempt.DownDisposition=="unknown" && attempt.ReleaseDisposition=="inserted" && ledger.PendingCount==0,"Unknown cleanup facts wrong");
        });
        Check("an impossible count is unknown rather than a proven rejection",()=>{
            int calls=0;var ledger=new InputDelivery<int>(value=>++calls==1?2u:1u);
            var error=Throws(()=>ledger.Press(10,11,Left)) as InputDeliveryException;
            Assert(error!=null && error.Cause=="SEND_INPUT_COUNT_INVALID" && ledger.PendingCount==1,"Invalid count omitted");
            ledger.Cleanup(error);Assert(ledger.LastCleanup.Attempts.Single().DownDisposition=="unknown","Invalid count treated as inserted");
        });
        Check("cancellation does not prevent reverse-order cleanup",()=>{
            var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return 1;});
            ledger.Press(10,11,Ctrl);ledger.Press(20,21,InputReleaseLabel.Key(65));ledger.Press(30,31,Left);
            var cancelled=new OperationCanceledException();
            Assert(Object.ReferenceEquals(cancelled,ledger.Cleanup(cancelled)),"Cancellation was erased");
            Assert(sent.SequenceEqual(new[]{10,20,30,31,21,11}),"Cleanup is not LIFO");
            Assert(ledger.LastCleanup.AllReleasesInserted,"Successful release acknowledgement missing");
        });
        Check("zero inserted release remains pending for cleanup retry",()=>{
            int calls=0;var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return ++calls==2?0u:1u;});
            ledger.Press(10,11,Left);var error=Throws(()=>ledger.ReleaseLast());
            Assert(ledger.PendingCount==1,"Failed release removed from ledger");
            Assert(Object.ReferenceEquals(error,ledger.Cleanup(error)),"Initial release failure erased");
            Assert(sent.SequenceEqual(new[]{10,11,11}) && ledger.PendingCount==0,"Release-only retry mismatch");
        });
        Check("throwing release remains pending for cleanup retry",()=>{
            int calls=0;var first=new InvalidOperationException();
            var ledger=new InputDelivery<int>(value=>{if(++calls==2)throw first;return 1;});
            ledger.Press(10,11,Left);Assert(Object.ReferenceEquals(first,Throws(()=>ledger.ReleaseLast())),"Release exception erased");
            Assert(ledger.PendingCount==1 && Object.ReferenceEquals(first,ledger.Cleanup(first)) && ledger.PendingCount==0,"Unknown release not retained");
        });
        Check("cleanup retains original failure and separately reports a rejected up",()=>{
            var ledger=new InputDelivery<int>(value=>value==10?1u:0u);ledger.Press(10,11,Left);
            var cancelled=new OperationCanceledException("do not serialize");
            Assert(Object.ReferenceEquals(cancelled,ledger.Cleanup(cancelled)),"Cleanup replaced original failure");
            var report=ledger.LastCleanup;var attempt=report.Attempts.Single();
            Assert(!report.AllReleasesInserted && report.PendingReleaseCount==1 && attempt.ReleaseDisposition=="rejected" && attempt.SentCount==0,"Release failure hidden");
        });
        Check("cleanup continues releasing other keys after one rejection",()=>{
            var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return value==21?0u:1u;});
            ledger.Press(10,11,Ctrl);ledger.Press(20,21,Left);ledger.Press(30,31,InputReleaseLabel.Key(65));
            var failure=ledger.Cleanup(null) as InputDeliveryException;
            Assert(failure!=null && sent.SequenceEqual(new[]{10,20,30,31,21,11}),"Cleanup stopped early");
            Assert(ledger.PendingCount==1 && ledger.LastCleanup.Attempts.Select(item=>item.ReleaseDisposition).SequenceEqual(new[]{"inserted","rejected","inserted"}),"Remaining release facts wrong");
        });
        Check("cleanup keeps a throwing up unknown without exposing its exception",()=>{
            var failure=new InvalidOperationException("sensitive exception");
            var ledger=new InputDelivery<int>(value=>{if(value==11)throw failure;return 1;});ledger.Press(10,11,Left);
            Assert(Object.ReferenceEquals(failure,ledger.Cleanup(null)),"Cleanup's first failure was replaced");
            var attempt=ledger.LastCleanup.Attempts.Single();
            Assert(attempt.ReleaseDisposition=="unknown" && attempt.SentCount==null && ledger.PendingCount==1,"Throwing up marked released");
            Assert(!new JavaScriptSerializer().Serialize(ledger.LastCleanup).Contains("sensitive exception"),"Exception text leaked");
        });
        Check("invalid release count cannot clear a pending key",()=>{
            var ledger=new InputDelivery<int>(value=>value==10?1u:2u);ledger.Press(10,11,Left);
            Assert(ledger.Cleanup(null) is InputDeliveryException && ledger.PendingCount==1,"Invalid up accepted");
            Assert(ledger.LastCleanup.Attempts.Single().ReleaseDisposition=="unknown","Invalid up mislabeled");
        });
        Check("later cleanup retries only unresolved releases and never a down",()=>{
            var sent=new List<int>();bool reject=true;
            var ledger=new InputDelivery<int>(value=>{sent.Add(value);return value==21 && reject?0u:1u;});
            ledger.Press(10,11,Ctrl);ledger.Press(20,21,Left);var failure=ledger.Cleanup(null);reject=false;
            Assert(Object.ReferenceEquals(failure,ledger.Cleanup(failure)),"Prior failure forgotten on retry");
            Assert(sent.SequenceEqual(new[]{10,20,21,11,21}) && ledger.PendingCount==0,"Cleanup repeated resolved events");
        });
        Check("the first cleanup error wins when no earlier action failed",()=>{
            var first=new InvalidOperationException("first");var second=new ArgumentException("second");
            var ledger=new InputDelivery<int>(value=>{if(value==21)throw first;if(value==11)throw second;return 1;});
            ledger.Press(10,11,Ctrl);ledger.Press(20,21,Left);
            Assert(Object.ReferenceEquals(first,ledger.Cleanup(null)) && ledger.LastCleanup.Attempts.Length==2,"Cleanup failure precedence changed");
        });
        Check("Unicode cleanup diagnostics contain neither payload nor character code",()=>{
            string secret="private-"+new string((char)0x4e2d,3);bool down=true;
            var ledger=new InputDelivery<string>(value=>{if(down){down=false;return 1;}throw new Exception(secret);});
            ledger.Press(secret,secret+"-release",InputReleaseLabel.Unicode());ledger.Cleanup(new Exception(secret));
            string json=new JavaScriptSerializer().Serialize(ledger.LastCleanup);
            Assert(!json.Contains(secret) && !json.Contains("20013") && !json.Contains("4e2d") && json.Contains("unicode"),"Unicode data leaked");
            Assert(ledger.LastCleanup.Attempts.Single().Label.VirtualKey==null,"Unicode VK retained");
        });
        Check("labels reject arbitrary text and out-of-range or packet key codes",()=>{
            Assert(Throws(()=>InputReleaseLabel.Mouse("private text")) is ArgumentException,"Arbitrary label accepted");
            foreach(int key in new[]{0,255,0x4e2d,231,1,2,4,5,6})Assert(Throws(()=>InputReleaseLabel.Key(key)) is ArgumentOutOfRangeException,"Bad VK accepted");
            foreach(string button in new[]{"left","right","middle"})Assert(InputReleaseLabel.Mouse(button).Button==button,"Known button rejected");
        });
        Check("invalid construction and labels dispatch no event",()=>{
            Assert(Throws(()=>new InputDelivery<int>(null)) is ArgumentNullException,"Null callback accepted");
            int calls=0;var ledger=new InputDelivery<int>(value=>{calls++;return 1;});
            Assert(Throws(()=>ledger.Press(10,11,null)) is ArgumentNullException && calls==0,"Invalid label dispatched");
            Assert(Throws(()=>ledger.ReleaseLast()) is InvalidOperationException && calls==0,"Empty release dispatched");
        });
        Check("an existing successful press survives a later rejected down",()=>{
            var sent=new List<int>();var ledger=new InputDelivery<int>(value=>{sent.Add(value);return value==20?0u:1u;});
            ledger.Press(10,11,Ctrl);var failure=Throws(()=>ledger.Press(20,21,Left));ledger.Cleanup(failure);
            Assert(sent.SequenceEqual(new[]{10,20,11}) && ledger.PendingCount==0,"Rejected down altered prior ownership");
        });
        Check("empty cleanup preserves the original failure without manufacturing attempts",()=>{
            var ledger=new InputDelivery<int>(value=>{throw new Exception("Should not dispatch");});var failure=new OperationCanceledException();
            Assert(Object.ReferenceEquals(failure,ledger.Cleanup(failure)) && ledger.LastCleanup.Attempts.Length==0 && ledger.LastCleanup.AllReleasesInserted,"Empty cleanup changed failure");
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,checks=Checks.ToArray()}));return 0;
    }
}
