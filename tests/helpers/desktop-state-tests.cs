using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using ProfilePilot.Desktop;

// Pure state/identity and input-packet tests: no AutomationElement, HWND, desktop
// observation or input is created. Only read-only Windows scan-code lookup is
// used by the packet builder; Action/Handle and native input APIs are not called.
// Reflection exercises the production collectors, validator and packet builder.
public static class DesktopStateTests {
    static readonly Type Driver=typeof(AutomationWindows);
    static readonly Type SnapshotType=Driver.GetNestedType("ElementSnapshot",BindingFlags.NonPublic);
    static readonly MethodInfo Read=Driver.GetMethod("ReadMutableState",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo ReadDisplay=Driver.GetMethod("ReadDisplayText",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo ReadSnapshotText=Driver.GetMethod("ReadSnapshotText",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo Truncated=Driver.GetMethod("TextTruncated",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo LimitDisplay=Driver.GetMethod("LimitDisplayText",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo Hash=Driver.GetMethod("Fingerprint",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo Keyboard=Driver.GetMethod("Keyboard",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo KeyCode=Driver.GetMethod("KeyCode",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo ValidateAction=Driver.GetMethod("ValidateAction",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo MarkInput=Driver.GetMethod("MarkInput",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly MethodInfo MouseInput=Driver.GetMethod("MouseInput",BindingFlags.NonPublic|BindingFlags.Static);
    static readonly List<string> Checks=new List<string>();
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Set(object target,string field,object value){target.GetType().GetField(field).SetValue(target,value);}
    static object Get(object target,string field){return target.GetType().GetField(field).GetValue(target);}
    static Dictionary<string,object> Values(){return new Dictionary<string,object>{
        {"value.available",true},{"value.readOnly",false},{"value.text","original text"},
        {"toggle.available",true},{"toggle.state",0},{"selection.available",true},{"selection.selected",false},
        {"expandCollapse.available",true},{"expandCollapse.state",0}
    };}
    static object State(Dictionary<string,object> values,bool password=false,Func<string,object> reader=null,Action checkpoint=null){
        return Read.Invoke(null,new object[]{password,reader??(key=>values[key]),checkpoint??(()=>{})});
    }
    static object Snapshot(object state,bool password=false){
        object snapshot=Activator.CreateInstance(SnapshotType,true);
        Set(snapshot,"RuntimeId",new[]{1,2});Set(snapshot,"ProcessId",42);Set(snapshot,"ControlTypeId",50004);
        Set(snapshot,"Role","Edit");Set(snapshot,"Name","Label");Set(snapshot,"AutomationId","stable-id");
        Set(snapshot,"Enabled",true);Set(snapshot,"Offscreen",false);Set(snapshot,"Password",password);Set(snapshot,"Focused",false);
        Set(snapshot,"Bounds",new double[]{1.25,2.5,30,40});Set(snapshot,"Text","original text");Set(snapshot,"Actions",new[]{"set_value"});Set(snapshot,"State",state);
        return snapshot;
    }
    static string Fingerprint(object snapshot){return (string)Hash.Invoke(null,new[]{snapshot});}
    static string Output(object snapshot){return AutomationJson.Json.Serialize(SnapshotType.GetMethod("Output").Invoke(snapshot,new object[]{"e1",-1}));}
    static bool Complete(object state){return (bool)state.GetType().GetProperty("Complete").GetValue(state,null);}
    static void Display(object snapshot,int limit,Func<int,bool> read,Action checkpoint=null){ReadDisplay.Invoke(null,new object[]{snapshot,limit,checkpoint??(()=>{}),read});}
    static bool TextTruncated(object snapshot,int limit){return (bool)Truncated.Invoke(null,new object[]{snapshot,limit});}
    static bool ApplyLimit(object snapshot,int limit){return (bool)LimitDisplay.Invoke(null,new object[]{snapshot,limit});}
    static void SnapshotText(object snapshot,int limit,Func<int,string> read,Action checkpoint=null){
        if(ReadSnapshotText!=null)ReadSnapshotText.Invoke(null,new object[]{snapshot,limit,checkpoint??(()=>{}),read});
        else Display(snapshot,limit,maximum=>{string value=read(maximum);Set(snapshot,"Text",value);return value!=null;},checkpoint);
    }
    static object CappedValue(string text){var values=Values();values["value.text"]=text;return Snapshot(State(values));}
    static object Document(bool password=false,bool textAvailable=true){
        var values=Values();values["value.available"]=false;
        object snapshot=Snapshot(State(values,password),password);
        Set(snapshot,"ControlTypeId",ControlType.Document.Id);Set(snapshot,"Role","Document");Set(snapshot,"Text","");
        Set(snapshot,"Actions",textAvailable?new[]{"text"}:new string[0]);return snapshot;
    }
    static void TextBudgetChecks(){
        int budget=32768;
        for(int index=0;index<8;index++){
            var values=Values();values["value.text"]=new string('x',4096);
            object value=Snapshot(State(values));int limit=Math.Min(4096,budget);
            Display(value,limit,maximum=>{throw new Exception("Value node queried TextPattern");});
            Assert(!TextTruncated(value,limit),"Exactly fitting Value text was truncated");
            budget-=Math.Min(limit,((string)Get(value,"Text")).Length);
        }
        Assert(budget==0,"Counterexample did not exactly exhaust text budget");
        object document=Document();string identity=Fingerprint(document);int reads=0,checkpoints=0;
        Display(document,budget,maximum=>{reads++;Set(document,"Text","nonempty document");return true;},()=>checkpoints++);
        Assert(reads==0 && checkpoints==0,"Zero text budget queried a provider or changed checkpoint behavior");
        Assert(TextTruncated(document,budget),"Exactly exhausted budget silently omitted supported Document text");
        Assert(Complete(Get(document,"State")) && identity==Fingerprint(document),"Display omission changed action state or fingerprint");
        Assert((string)Get(document,"Text")=="","Omitted document retained text");
        Checks.Add("exactly exhausted display budget reports supported Document text omission without changing identity");

        foreach(int limit in new[]{0,4096}){
            object password=Document(true);
            Display(password,limit,maximum=>{throw new Exception("Password queried TextPattern");},()=>{throw new Exception("Password entered text checkpoint");});
            Assert(!TextTruncated(password,limit) && !(bool)Get(password,"TextOmitted") && (string)Get(password,"Text")=="","Password was treated as omitted document text");
        }
        document=Document(false,false);
        Display(document,0,maximum=>{throw new Exception("Unsupported document queried TextPattern");});
        Assert(!TextTruncated(document,0),"Absent TextPattern acquired a budget gap");
        Checks.Add("password and known unsupported document text never query TextPattern or add display omission gaps");

        document=Document();reads=0;checkpoints=0;
        Display(document,4,maximum=>{reads++;Assert(maximum==5,"Document read lost its one-character overflow probe");Set(document,"Text","12345");return true;},()=>checkpoints++);
        Assert(reads==1 && checkpoints==2 && TextTruncated(document,4),"Positive budget changed bounded text reads or checkpoints");
        Assert(!(bool)Get(document,"TextOmitted"),"Read document text was marked unattempted");
        document=Document();checkpoints=0;
        Display(document,4,maximum=>false,()=>checkpoints++);
        Assert(checkpoints==1 && !TextTruncated(document,4),"Absent current pattern changed existing checkpoint behavior");
        Checks.Add("positive document budgets retain bounded provider calls and the existing checkpoint sequence");
    }
    static void Changed(string property,object value,string label){
        var values=Values();string before=Fingerprint(Snapshot(State(values)));values[property]=value;
        Assert(before!=Fingerprint(Snapshot(State(values))),label+" did not change identity");Checks.Add(label);
    }
    static void WindowStateChecks(){
        object state=State(Values());object snapshot=Snapshot(state);
        var window=new DesktopWindowState.Snapshot{Status="readable",NativeHandle=123,Visual=0,CanMinimize=true,CanMaximize=true,Modal=false,Interaction=2};
        Assert(!Output(snapshot).Contains("\"window\":"),"Child output gained irrelevant window metadata");
        Set(state,"Window",window);Set(state,"WindowObserved",true);string original=Fingerprint(snapshot);
        window.CanMaximize=false;Assert(Fingerprint(snapshot)!=original,"Window capability omitted from production element fingerprint");window.CanMaximize=true;
        window.Visual=2;Assert(Fingerprint(snapshot)!=original,"Window visual state omitted from production fingerprint");window.Visual=0;
        window.Modal=true;Assert(Fingerprint(snapshot)!=original,"Modal state omitted from production fingerprint");window.Modal=false;
        window.Interaction=3;Assert(Fingerprint(snapshot)!=original,"Interaction state omitted from production fingerprint");window.Interaction=2;
        window.NativeHandle=456;Assert(Fingerprint(snapshot)!=original,"UIA HWND omitted from production fingerprint");window.NativeHandle=123;
        Set(snapshot,"WindowIconic",true);Assert(Fingerprint(snapshot)!=original,"Iconic evidence omitted from production fingerprint");Set(snapshot,"WindowIconic",false);
        Assert(Fingerprint(snapshot)==original && Output(snapshot).Contains("\"visualState\":\"normal\""),"Window output does not match original state snapshot");
        Checks.Add("production fingerprint retains window capabilities modal interaction native handle and iconic evidence from the output snapshot");
        foreach(string kind in new[]{"restore","minimize","maximize"}){
            var action=new Dictionary<string,object>{{"version",new string('a',32)},{"kind",kind},{"ref","e0"}};
            Assert((string)ValidateAction.Invoke(null,new object[]{action})==kind,"Window action shape rejected");
            foreach(string field in new[]{"keys","value","x","y","button","toX","deltaY"}){
                action[field]=field=="keys"?(object)new object[]{"ALT"}:field=="value" || field=="button"?(object)"x":1;
                bool rejected=false;try{ValidateAction.Invoke(null,new object[]{action});}catch(TargetInvocationException error){rejected=error.InnerException is AutomationFault;}
                Assert(rejected,"Ignored field accepted for window action: "+field);action.Remove(field);
            }
            action.Remove("ref");bool missing=false;try{ValidateAction.Invoke(null,new object[]{action});}catch(TargetInvocationException error){missing=error.InnerException is AutomationFault;}Assert(missing,"Window action without ref accepted");
        }
        Checks.Add("native window action preflight requires ref/version and rejects ignored input fields");
    }
    static void TextEvidenceChecks(){
        var values=Values();values["value.text"]="";
        object value=Snapshot(State(values));Display(value,4096,maximum=>{throw new Exception("Value queried TextPattern");});ApplyLimit(value,4096);
        Assert(Output(value).Contains("\"textStatus\":\"readable\"") && Output(value).Contains("\"truncatedFields\":[]"),"Empty Value lacks readable evidence");
        object document=Document();Display(document,4096,maximum=>true);ApplyLimit(document,4096);
        Assert((string)Get(document,"TextStatus")=="readable" && (string)Get(document,"Text")=="","Successfully read empty Document lacks readable evidence");
        Checks.Add("empty Value and successfully read empty Document have explicit readable text evidence");

        document=Document();Display(document,4096,maximum=>false);
        Assert((string)Get(document,"TextStatus")=="unavailable" && Complete(Get(document,"State")),"Missing advertised TextPattern became empty readable text or changed action state");
        document=Document(false,false);Display(document,4096,maximum=>false);
        Assert((string)Get(document,"TextStatus")=="unsupported","Unknown TextPattern was declared readable");
        value=Snapshot(State(Values(),false,key=>{if(key=="value.text")throw new COMException("unavailable");return Values()[key];}));
        Display(value,4096,maximum=>{throw new Exception("Unavailable Value queried TextPattern");});
        Assert((string)Get(value,"TextStatus")=="unavailable","Unavailable Value became a readable empty string");
        Checks.Add("unavailable Value and missing TextPattern retain distinct non-readable evidence");

        values=Values();values["value.text"]=new string('x',4097);value=Snapshot(State(values));
        Set(value,"Name",new string('n',513));Set(value,"AutomationId",new string('i',257));
        string identity=Fingerprint(value);Display(value,4096,maximum=>false);
        Assert(ApplyLimit(value,4096),"Overlong Value did not record display truncation");
        string output=Output(value);
        Assert(output.Contains("\"truncatedFields\":[\"name\",\"automationId\",\"text\"]") && output.Contains("\"textStatus\":\"truncated\""),"Field truncation evidence was lost after Limit");
        Assert(((string)Get(value,"Text")).Length==4096 && identity==Fingerprint(value) && Complete(Get(value,"State")),"Display evidence changed input identity/state");
        values["value.text"]=new string('x',4096);value=Snapshot(State(values));Set(value,"Name",new string('n',512));Set(value,"AutomationId",new string('i',256));
        Display(value,4096,maximum=>false);Assert(!ApplyLimit(value,4096) && Output(value).Contains("\"truncatedFields\":[]"),"Exactly fitting fields were marked truncated");
        Checks.Add("per-node name id and text truncation survives display limits without changing fingerprints or complete state");

        document=Document();identity=Fingerprint(document);Display(document,0,maximum=>{throw new Exception("Zero budget queried TextPattern");});
        Assert(ApplyLimit(document,0) && Output(document).Contains("\"truncatedFields\":[\"text\"]") && (string)Get(document,"TextStatus")=="truncated","Omitted Document text lost its per-node gap");
        Assert(identity==Fingerprint(document) && Complete(Get(document,"State")),"Omitted text evidence changed action identity");
        Checks.Add("zero-budget supported Document reports truncated text without querying a provider");

        object password=Document(true);Set(password,"Name",new string('s',513));
        Display(password,4096,maximum=>{throw new Exception("Password text queried");},()=>{throw new Exception("Password text checkpoint entered");});ApplyLimit(password,4096);
        output=Output(password);
        Assert(output.Contains("\"textStatus\":\"redacted\"") && output.Contains("\"truncatedFields\":[]") && !output.Contains(new string('s',10)),"Password display evidence exposed content or hidden name length");
        Checks.Add("password display evidence is redacted without reading text or exposing hidden name truncation");
    }
    static void ValueEvidenceChecks(){
        string prefix=new string('x',2000);
        foreach(int length in new[]{2001,4097,16384})foreach(int limit in new[]{0,4096}){
            string common=prefix+new string('y',length-2001);
            object first=CappedValue(prefix),second=CappedValue(prefix);
            SnapshotText(first,limit,maximum=>common+"A");SnapshotText(second,limit,maximum=>common+"B");
            Assert(Fingerprint(first)!=Fingerprint(second),"A changed suffix beyond the 2000-character Value proxy limit retained its old identity");
            Assert(Complete(Get(first,"State")) && Complete(Get(second,"State")),"Confirmed supplementary identity became unavailable");
        }
        Checks.Add("same-prefix suffix changes invalidate identity even during zero-display-budget action validation");

        foreach(int length in new[]{1999,2000,2001,4097,16384}){
            string full=new string('x',length),raw=full.Substring(0,Math.Min(length,2000));
            object snapshot=CappedValue(raw);int reads=0,checkpoints=0;
            SnapshotText(snapshot,4096,maximum=>{reads++;Assert(maximum==16385,"Supplementary read is unbounded or lost overflow confirmation");return full;},()=>checkpoints++);
            object state=Get(snapshot,"State");string identity=Fingerprint(snapshot);
            Assert((string)Get(state,"ValueText")==raw,"TextPattern replaced the raw Value semantics");
            Assert(Complete(state) && (string)Get(state,"ValueStatus")=="readable","Confirmed Value evidence lost readable state");
            Assert(reads==(length==1999?0:1) && checkpoints==(length==1999?0:2),"Unexpected evidence query/checkpoint count");
            Assert((string)Get(state,"ValueEvidence")== (length==1999?"value":"value_and_text"),"Value evidence source missing");
            Assert((string)Get(snapshot,"TextSource")== (length==1999?"value":"text_pattern") && (string)Get(snapshot,"Text")==full,"Display did not retain the declared text source");
            ApplyLimit(snapshot,4096);
            Assert(((string)Get(snapshot,"Text")).Length==Math.Min(length,4096),"Display text has an incorrect cap");
            Assert((string)Get(snapshot,"TextStatus")== (length>4096?"truncated":"readable"),"Confirmed text has incorrect completeness");
            Assert(identity==Fingerprint(snapshot),"Display limiting changed the evidence fingerprint");
        }
        Checks.Add("1999 2000 2001 4097 and 16384 boundaries preserve raw Value and bounded TextPattern evidence");

        foreach(int length in new[]{16385,17000})foreach(int limit in new[]{0,4096}){
            object snapshot=CappedValue(prefix);SnapshotText(snapshot,limit,maximum=>new string('x',length));
            object state=Get(snapshot,"State");ApplyLimit(snapshot,limit);
            Assert(!Complete(state) && Get(state,"ValueDigest")==null && ((List<string>)Get(state,"Gaps")).Contains("value_evidence"),"At-cap prefix retained input authority");
            Assert((string)Get(state,"ValueEvidence")=="unconfirmed" && (string)Get(snapshot,"TextStatus")=="truncated","At-cap unknown completeness was erased");
            Assert((string)Get(snapshot,"TextSource")=="text_pattern" && Output(snapshot).Contains("\"truncatedFields\":[\"text\"]"),"At-cap truncation was erased by display initialization/limit");
            Assert(((string)Get(snapshot,"Text")).Length<=limit,"At-cap provider output escaped the display budget");
        }
        Checks.Add("16385 and over-cap replies remain unconfirmed truncated and non-actionable after display limiting");

        foreach(Func<int,string> read in new Func<int,string>[] {
            maximum=>null, maximum=>"", maximum=>new string('x',1999), maximum=>"different", maximum=>"\r\n"+prefix,
            maximum=>{throw new COMException("provider");},maximum=>{throw new InvalidOperationException("provider");},
            maximum=>{throw new ArgumentException("provider");},maximum=>{throw new UnauthorizedAccessException("provider");},
            maximum=>{throw new NotSupportedException("provider");},maximum=>{throw new ElementNotAvailableException("provider");}
        }){
            object snapshot=CappedValue(prefix);SnapshotText(snapshot,4096,read);object state=Get(snapshot,"State");ApplyLimit(snapshot,4096);
            Assert(!Complete(state) && Get(state,"ValueDigest")==null && (string)Get(state,"ValueEvidence")=="unconfirmed","Missing or inconsistent evidence acquired a prefix identity");
            Assert((string)Get(snapshot,"TextStatus")=="unavailable" && (string)Get(snapshot,"TextSource")=="value","Failed evidence became exact display text");
            Assert(((List<string>)Get(state,"Gaps")).Contains("value_evidence"),"Evidence failure lost its state gap");
        }
        Checks.Add("null absent exceptions short or inconsistent TextPattern replies cannot authorize a Value prefix");

        object password=Snapshot(State(Values(),true),true);
        SnapshotText(password,0,maximum=>{throw new Exception("Password requested supplemental text");},()=>{throw new Exception("Password entered text checkpoint");});
        Assert((string)Get(password,"TextSource")=="none" && (string)Get(password,"TextStatus")=="redacted" && Get(Get(password,"State"),"ValueDigest")==null,"Password acquired text evidence");
        foreach(string raw in new[]{"",new string('x',1999),new string('x',2001),new string('x',4097)}){
            object snapshot=CappedValue(raw);SnapshotText(snapshot,0,maximum=>{throw new Exception("Non-boundary Value requested TextPattern");});
            Assert(Complete(Get(snapshot,"State")),"Non-boundary Value acquired an evidence gap");
        }
        Checks.Add("password and non-boundary Value reads never request supplementary TextPattern evidence");

        foreach(Exception error in new Exception[]{new AutomationFault("DESKTOP_USER_IN_CONTROL"),(Exception)Activator.CreateInstance(Driver.GetNestedType("ObservationBudgetException",BindingFlags.NonPublic),true)})foreach(int stage in new[]{1,2}){
            object snapshot=CappedValue(prefix);int checkpoints=0,reads=0;
            try{SnapshotText(snapshot,0,maximum=>{reads++;return prefix;},()=>{if(++checkpoints==stage)throw error;});Assert(false,"Control/budget interruption was swallowed");}
            catch(TargetInvocationException wrapped){Assert(Object.ReferenceEquals(wrapped.InnerException,error),"Control/budget interruption was reclassified");}
            Assert(reads==stage-1 && !((List<string>)Get(Get(snapshot,"State"),"Gaps")).Contains("value_evidence"),"Cancelled evidence was treated as a provider gap or read again");
        }
        Checks.Add("control and observation-budget interruptions propagate before or after the bounded evidence read");
    }
    static void Packet(ushort code,bool up,bool unicode,uint expectedFlags){
        object input=Keyboard.Invoke(null,new object[]{code,up,unicode});
        object key=Get(Get(input,"Data"),"Key");
        Assert((uint)Get(input,"Type")==1,"Keyboard packet has the wrong input type");
        Assert((ushort)Get(key,"Vk")== (unicode?0:code),"Packet virtual key mismatch");
        ushort scan=(ushort)Get(key,"Scan");
        Assert(unicode?scan==code:scan!=0,"Packet is missing its scan code or UTF-16 unit");
        if(!unicode && code==67)Assert(scan==0x2e,"C must carry its hardware scan code for SDL clients");
        Assert((uint)Get(key,"Flags")==expectedFlags,"Packet flags mismatch for key "+code);
    }
    static Dictionary<string,object> Chord(string[] keys){
        return new Dictionary<string,object>{{"version",new string('b',32)},{"kind","press_key"},{"ref","e1"},{"keys",Array.ConvertAll(keys,key=>(object)key)}};
    }
    public static int Main(){
        TextBudgetChecks();
        WindowStateChecks();
        TextEvidenceChecks();
        ValueEvidenceChecks();
        Changed("value.text","external replacement","value changes invalidate an old reference");
        Changed("value.readOnly",true,"read-only changes invalidate an old reference");
        Changed("toggle.state",1,"toggle changes invalidate an old reference");
        Changed("selection.selected",true,"selection changes invalidate an old reference");
        Changed("expandCollapse.state",1,"expand/collapse changes invalidate an old reference");

        var values=Values();object state=State(values),snapshot=Snapshot(state);string original=Fingerprint(snapshot),output=Output(snapshot);
        values["value.text"]="changed after collection";values["toggle.state"]=2;
        Assert(Fingerprint(snapshot)==original && Output(snapshot)==output,"Output or identity performed a second provider read");
        Assert(output.Contains("\"toggle\":0") && output.Contains("\"selected\":false") && output.Contains("\"expanded\":0"),"Collected states missing from output");
        Checks.Add("output and identity retain the same collected snapshot");

        Set(snapshot,"Focused",true);Set(snapshot,"Text","");
        Assert(original==Fingerprint(snapshot),"Focus or display-text budget invalidated identity");
        CultureInfo beforeCulture=CultureInfo.CurrentCulture;
        try{System.Threading.Thread.CurrentThread.CurrentCulture=new CultureInfo("fr-FR");Assert(original==Fingerprint(snapshot),"Identity changed with culture");}
        finally{System.Threading.Thread.CurrentThread.CurrentCulture=beforeCulture;}
        Checks.Add("identity ignores focus and display truncation and remains culture-independent");

        values=Values();values["value.text"]=new string('a',5000)+"one";object longA=Snapshot(State(values));Set(longA,"Text",new string('a',4096));
        values["value.text"]=new string('a',5000)+"two";object longB=Snapshot(State(values));Set(longB,"Text",new string('a',4096));
        Assert(Fingerprint(longA)!=Fingerprint(longB),"Value changes past the display limit were lost");
        Checks.Add("full non-password value changes survive display truncation");

        values=Values();int secretReads=0;state=State(values,true,key=>{if(key=="value.text"){secretReads++;throw new Exception("password value was read");}return values[key];});
        Assert(secretReads==0 && (string)Get(state,"ValueStatus")=="redacted" && Get(state,"ValueDigest")==null && (string)Get(state,"ValueText")=="","Password was read, retained, or hashed");
        snapshot=Snapshot(state,true);Set(snapshot,"Name","secret name");Set(snapshot,"Text","secret value");original=Fingerprint(snapshot);
        Set(state,"ValueDigest","injected secret digest");Set(snapshot,"Name","different secret name");
        Assert(original==Fingerprint(snapshot),"Password identity incorporated a secret");
        Assert(!Output(snapshot).Contains("secret"),"Password output exposed sensitive fields");
        Checks.Add("password values are never requested, hashed, retained, or output");

        values=Values();foreach(string key in new[]{"value.available","toggle.available","selection.available","expandCollapse.available"})values[key]=false;
        int unsupportedReads=0;state=State(values,false,key=>{unsupportedReads++;Assert(key.EndsWith(".available"),"Unsupported pattern property was read");return values[key];});
        Assert(unsupportedReads==4 && Complete(state),"Unsupported patterns incorrectly made the state unavailable");
        Assert(Fingerprint(Snapshot(state))==Fingerprint(Snapshot(State(values))),"Unsupported state is not stable");
        Checks.Add("unsupported patterns have stable markers without property reads");

        values=Values();foreach(string key in new[]{"value.available","toggle.available","selection.available","expandCollapse.available"})values[key]=AutomationElement.NotSupported;
        unsupportedReads=0;state=State(values,false,key=>{unsupportedReads++;Assert(key.EndsWith(".available"),"NotSupported availability triggered a state read");return values[key];});
        Assert(unsupportedReads==4 && Complete(state),"UIA NotSupported availability was mistaken for provider failure");
        original=Fingerprint(Snapshot(state));foreach(string key in new[]{"value.available","toggle.available","selection.available","expandCollapse.available"})values[key]=false;
        Assert(original==Fingerprint(Snapshot(State(values))),"NotSupported and default false availability have different identities");
        Checks.Add("actual UIA NotSupported availability uses the documented false default");

        values=Values();foreach(string key in new[]{"toggle.available","selection.available","expandCollapse.available"})values[key]=AutomationElement.NotSupported;
        state=State(values);Assert(Complete(state) && (string)Get(state,"ValueStatus")=="readable","Ordinary Edit with only ValuePattern was blocked");
        original=Fingerprint(Snapshot(state));values["value.text"]="changed edit";
        Assert(original!=Fingerprint(Snapshot(State(values))),"Default unsupported modes disabled Edit value protection");
        Checks.Add("Edit controls with unsupported other patterns retain readable state and change protection");

        foreach(object invalid in new object[]{null,new object(),"false",0}){
            values=Values();values["toggle.available"]=invalid;state=State(values);
            Assert(!Complete(state) && (string)Get(state,"ToggleStatus")=="unavailable","Arbitrary availability failure was treated as false");
        }
        values=Values();state=State(values,false,key=>{if(key=="toggle.available")throw new COMException("availability read failed");return values[key];});
        Assert(!Complete(state) && (string)Get(state,"ToggleStatus")=="unavailable","Availability exception was treated as an unsupported pattern");
        Checks.Add("unknown availability values and provider exceptions remain fail-closed");

        foreach(string part in new[]{"value","toggle","selection","expandCollapse"}){
            values=Values();string failPart=part;Func<string,object> failing=key=>{if(key.StartsWith(failPart+".") && !key.EndsWith(".available"))throw new COMException("provider unavailable");return values[key];};
            state=State(values,false,failing);Assert(!Complete(state),"Unreadable supported state allowed a reference action");
            Assert(((List<string>)Get(state,"Gaps")).Contains(part),"Missing unreadable-state gap");
            Assert(Fingerprint(Snapshot(state))==Fingerprint(Snapshot(State(values,false,failing))),"Failure generated a random identity");
        }
        Checks.Add("unreadable supported states fail closed with stable gaps");

        values=Values();values["value.readOnly"]=AutomationElement.NotSupported;state=State(values);
        Assert((string)Get(state,"ValueStatus")=="unavailable" && Get(state,"ReadOnly")==null,"An unsupported property default became a real false value");
        values=Values();values["toggle.state"]=99;state=State(values);
        Assert((string)Get(state,"ToggleStatus")=="unavailable","Invalid provider enum was accepted");
        Checks.Add("unknown properties and invalid enums remain unavailable");

        state=State(Values());snapshot=Snapshot(state);original=Fingerprint(snapshot);Set(snapshot,"Enabled",false);
        Assert(Fingerprint(snapshot)!=original && Output(snapshot).Contains("\"enabled\":false"),"Disabled state was lost");
        Checks.Add("disabled controls remain observable with a distinct identity");

        int checkpoints=0,reads=0;bool cancelled=false;
        try{State(Values(),false,key=>{reads++;return Values()[key];},()=>{if(++checkpoints==3)throw new AutomationFault("DESKTOP_USER_STOPPED");});}
        catch(TargetInvocationException error){cancelled=error.InnerException is AutomationFault && error.InnerException.Message=="DESKTOP_USER_STOPPED";}
        Assert(cancelled && reads==1,"Cancellation was swallowed as unavailable state or allowed another read");
        Checks.Add("cancellation interrupts between state reads without becoming a provider gap");

        bool budgetStopped=false;Type budget=Driver.GetNestedType("ObservationBudgetException",BindingFlags.NonPublic);
        try{State(Values(),false,null,()=>{throw (Exception)Activator.CreateInstance(budget,true);});}
        catch(TargetInvocationException error){budgetStopped=error.InnerException.GetType()==budget;}
        Assert(budgetStopped,"Observation budget was swallowed as unavailable state");
        Checks.Add("observation budget interruption propagates to the partial-observation handler");

        foreach(string name in new[]{"PAGEUP","PAGEDOWN","END","HOME","LEFT","UP","RIGHT","DOWN","DELETE"}){
            ushort code=(ushort)KeyCode.Invoke(null,new object[]{name});Packet(code,false,false,1);Packet(code,true,false,3);
        }
        Checks.Add("navigation key down and up packets both retain the extended-key flag");

        foreach(string name in new[]{"BACKSPACE","TAB","ENTER","CTRL","ALT","SHIFT","ESCAPE","SPACE","0","9","A","C","z","F1","F12"}){
            ushort code=(ushort)KeyCode.Invoke(null,new object[]{name});Packet(code,false,false,0);Packet(code,true,false,2);
        }
        foreach(string name in new[]{"F01","F+1","F 1","F0","F13"}){
            bool rejected=false;
            try{KeyCode.Invoke(null,new object[]{name});}
            catch(TargetInvocationException error){rejected=error.InnerException is AutomationFault && error.InnerException.Message=="DESKTOP_KEY_UNSUPPORTED";}
            Assert(rejected,"Unsupported function key spelling was accepted");
        }
        Checks.Add("ordinary key and modifier packets do not acquire an extended-key flag");
        Checks.Add("named key packets carry nonzero scan codes for SDL input on both down and up");

        foreach(ushort code in new ushort[]{33,34,35,36,37,38,39,40,46,65,0x4e2d,0xd83d,0xde42}){
            Packet(code,false,true,4);Packet(code,true,true,6);
        }
        Checks.Add("Unicode packets preserve UTF-16 units with VK zero and only Unicode/up flags");

        foreach(string[] keys in new[]{new[]{"CTRL","CONTROL"},new[]{"ctrl","control"},new[]{"ESC","ESCAPE"},new[]{"A","a"},new[]{"SHIFT","shift"},new[]{"F1","f1"}}){
            var request=Chord(keys);string before=AutomationJson.Json.Serialize(request);bool rejected=false;
            try{ValidateAction.Invoke(null,new object[]{request});}
            catch(TargetInvocationException error){rejected=error.InnerException is AutomationFault && error.InnerException.Message=="DESKTOP_BAD_REQUEST";}
            Assert(rejected,"Duplicate chord was accepted: "+String.Join("+",keys));
            Assert(before==AutomationJson.Json.Serialize(request),"Validation mutated the request");
        }
        Checks.Add("native chord validation rejects repeated virtual keys and aliases without mutating the request");

        foreach(string[] keys in new[]{new[]{"CONTROL","a"},new[]{"ESCAPE","ENTER"},new[]{"CTRL","SHIFT","A"},new[]{"F1","F12"}}){
            var request=Chord(keys);string before=AutomationJson.Json.Serialize(request);
            Assert((string)ValidateAction.Invoke(null,new object[]{request})=="press_key","Distinct chord rejected");
            Assert(before==AutomationJson.Json.Serialize(request),"Validation rewrote a valid chord");
        }
        Checks.Add("native chord validation preserves distinct modifiers and keys");

        foreach(string text in new[]{new string('x',512),String.Concat(System.Linq.Enumerable.Repeat("\ud83d\ude42",256)),"A\ud83d\ude42\u4e2d"}){
            var request=new Dictionary<string,object>{{"version",new string('b',32)},{"kind","type_text"},{"value",text}};
            string before=AutomationJson.Json.Serialize(request);
            Assert((string)ValidateAction.Invoke(null,new object[]{request})=="type_text","Valid bounded Unicode text rejected");
            Assert(before==AutomationJson.Json.Serialize(request),"Text preflight mutated request");
        }
        foreach(string text in new[]{new string('x',513),String.Concat(System.Linq.Enumerable.Repeat("\ud83d\ude42",256))+"x","\ud83d","\ude42","\ud83dx","x\ude42","\ude42\ud83d"}){
            var request=new Dictionary<string,object>{{"version",new string('b',32)},{"kind","type_text"},{"value",text}};bool rejected=false;
            try{ValidateAction.Invoke(null,new object[]{request});}
            catch(TargetInvocationException error){rejected=error.InnerException is AutomationFault && error.InnerException.Message=="DESKTOP_BAD_REQUEST";}
            Assert(rejected,"Oversized or unpaired-surrogate text passed preflight");
        }
        Checks.Add("native typing preflight accepts at most 512 UTF16 units and rejects unpaired surrogates before input");

        ulong marker=0xfedcba9876543210UL;
        Assert(DesktopHost.InputMarker(new[]{"--input-marker","fedcba9876543210"}).ToUInt64()==marker,"64-bit marker lost precision");
        Assert(DesktopHost.InputMarker(new[]{"--input-marker","ffffffffffffffff"}).ToUInt64()==UInt64.MaxValue,"Unsigned marker rejected");
        Assert(DesktopHost.InputMarker(new string[0])!=UIntPtr.Zero,"Legacy startup generated a zero marker");
        Checks.Add("helper startup preserves nonzero 64-bit hexadecimal markers without numeric JSON");
        foreach(string[] args in new[]{new[]{"--input-marker"},new[]{"--input-marker","0"},new[]{"--input-marker","0000000000000000"},new[]{"--input-marker","FEDCBA9876543210"},new[]{"--input-marker","fedcba987654321g"},new[]{"--input-marker","fedcba9876543210","extra"},new[]{"--marker","fedcba9876543210"}}){
            bool rejected=false;try{DesktopHost.InputMarker(args);}catch(ArgumentException){rejected=true;}
            Assert(rejected,"Invalid helper startup marker accepted");
        }
        Checks.Add("malformed, zero, truncated and extra marker startup arguments are rejected");
        var packets=new List<object>();
        foreach(bool unicode in new[]{false,true})foreach(bool up in new[]{false,true})
            packets.Add(Keyboard.Invoke(null,new object[]{(ushort)(unicode?0xd83d:37),up,unicode}));
        foreach(uint flags in new uint[]{1,2,4,8,16,32,64,0x0800,0x1000})packets.Add(MouseInput.Invoke(null,new object[]{flags,flags>=0x0800?-120:0}));
        var pointerBuilder=Driver.GetMethod("AbsolutePointer",BindingFlags.NonPublic|BindingFlags.Static);
        object movement=pointerBuilder.Invoke(null,new object[]{new System.Drawing.Point(-100,200),new[]{-1920,0,3840,1080}});
        object mouseMovement=Get(Get(movement,"Data"),"Mouse");
        var normalized=DesktopPointerCoordinates.Normalize(-100,200,-1920,0,3840,1080);
        Assert((int)Get(mouseMovement,"X")==normalized.X && (int)Get(mouseMovement,"Y")==normalized.Y && (uint)Get(mouseMovement,"Flags")==0xc001u,"Absolute movement packet changed physical pixel mapping");
        packets.Add(movement);
        foreach(ulong source in new[]{marker,0xfedcba9800000000UL,0x0000000100000000UL,0xffffffff80000000UL,UInt64.MaxValue})foreach(object packet in packets){
            bool keyboard=(uint)Get(packet,"Type")==1;
            object before=Get(Get(packet,"Data"),keyboard?"Key":"Mouse");
            object marked=MarkInput.Invoke(null,new object[]{packet,new UIntPtr(source)});
            object after=Get(Get(marked,"Data"),keyboard?"Key":"Mouse");
            // Expected wire markers are explicit vectors, independent of the
            // production masking/fallback implementation.
            ulong pointer=source==marker?0x76543210UL:source==0xfedcba9800000000UL?0xfedcba98UL:source==0x0000000100000000UL?1UL:source==0xffffffff80000000UL?0x80000000UL:0xffffffffUL;
            Assert(((UIntPtr)Get(after,"Extra")).ToUInt64()==(keyboard?source:pointer),"Marker width or input union offset mismatch");
            Assert((UIntPtr)Get(before,"Extra")==UIntPtr.Zero,"Marker changed the original release template");
            foreach(string field in keyboard?new[]{"Vk","Scan","Flags","Time"}:new[]{"X","Y","Data","Flags","Time"})
                Assert(Get(before,field).Equals(Get(after,field)),"Marker changed input payload "+field);
        }
        bool zeroRejected=false;try{MarkInput.Invoke(null,new object[]{packets[0],UIntPtr.Zero});}catch(TargetInvocationException error){zeroRejected=error.InnerException is ArgumentException;}
        Assert(zeroRejected,"Zero marker packet accepted");
        Checks.Add("pointer packets use nonzero uint32 markers while keyboard and Unicode retain full uint64 at distinct union offsets");
        Console.WriteLine(AutomationJson.Json.Serialize(new {ok=true,checks=Checks}));return 0;
    }
}
