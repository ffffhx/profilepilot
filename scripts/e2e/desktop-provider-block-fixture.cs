using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Owned acceptance fixture only. It blocks a real accessibility Name getter,
// not WM_GETOBJECT and not a fake DesktopService/worker response.
public static class DesktopProviderBlockFixture {
    [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    static string file,nonce,birth,rootName,reason,runId;
    static int pid,keyboard,pointer,calls,entries,returned;
    static uint uiThread;static IntPtr hwnd;static Form form;
    static readonly object sync=new object();static string phase="idle";
    static readonly ManualResetEvent gate=new ManualResetEvent(false), getterReturned=new ManualResetEvent(true);
    static volatile bool closing;static bool active;static long enteredCounter;
    static readonly Stopwatch lifetime=Stopwatch.StartNew();
    static void Write(string suffix,object value) { File.WriteAllText(file+suffix,new JavaScriptSerializer().Serialize(value),new UTF8Encoding(false)); }
    static object State() { lock(sync)return new {nonce,pid,startedUtcTicks=birth,hwnd=hwnd.ToInt64().ToString(),currentHwnd=hwnd.ToInt64().ToString(),
        runId,phase,getterActive=active,nameCalls=calls,entries,returned,keyboard,pointer,uiThreadId=uiThread,capturedAt=DateTime.UtcNow.ToString("o")}; }
    static object Marker(string mark,string source) {lock(sync)return new {nonce,pid,startedUtcTicks=birth,hwnd=hwnd.ToInt64().ToString(),runId,
        marker=mark,source,utc=DateTime.UtcNow.ToString("o"),counter=Stopwatch.GetTimestamp().ToString(),frequency=Stopwatch.Frequency,
        getterThreadId=GetCurrentThreadId(),uiThreadId=uiThread,entries,returned,getterActive=active};}
    static void Getter() {
        Interlocked.Increment(ref calls);bool enter=false;
        lock(sync)if(phase=="armed"&&!closing){phase="entered";active=true;entries++;enteredCounter=Stopwatch.GetTimestamp();getterReturned.Reset();enter=true;}
        if(!enter)return;
        try {Write(".entered.json",Marker("entered","accessible-name-getter"));gate.WaitOne();}
        finally {lock(sync){active=false;returned++;phase="returned";}try{Write(".returned.json",Marker("returned","accessible-name-getter"));}finally{getterReturned.Set();}}
    }
    static void Release(string source) {
        bool write=false;lock(sync){if(phase=="armed"||phase=="entered"){phase="released";write=true;}}
        if(write)try{Write(".released.json",Marker("released",source));}finally{gate.Set();}else gate.Set();
    }
    static void Close(string source) {
        lock(sync){if(closing)return;closing=true;reason=source;}
        Release(source);getterReturned.WaitOne(2000);
        try {form.BeginInvoke(new Action(delegate{form.Close();}));}catch(InvalidOperationException){}
    }
    sealed class BlockingControl:Control {
        public BlockingControl(){SetStyle(ControlStyles.UserPaint,true);Size=new Size(450,60);TabStop=false;}
        protected override AccessibleObject CreateAccessibilityInstance(){return new NameObject(this);}
        sealed class NameObject:ControlAccessibleObject {
            public NameObject(Control owner):base(owner){}
            public override string Name {get{Getter();return "Provider getter "+nonce;}set{}}
            public override AccessibleRole Role {get{return AccessibleRole.StaticText;}}
        }
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.DrawString("Owned accessibility provider test",Font,Brushes.Black,4,4);}
    }
    sealed class OwnedForm:Form {
        protected override bool ShowWithoutActivation {get{return true;}}
        protected override CreateParams CreateParams {get{var value=base.CreateParams;value.ExStyle|=0x08000000;return value;}}
        protected override void WndProc(ref Message message){if(message.Msg>=0x0100&&message.Msg<=0x0109)Interlocked.Increment(ref keyboard);if(message.Msg>=0x0201&&message.Msg<=0x020e)Interlocked.Increment(ref pointer);base.WndProc(ref message);}
    }
    static bool TokenFile(string suffix,string value){try{return File.ReadAllText(file+suffix)==value;}catch(IOException){return false;}}
    static void Watch() {
        while(!closing) {
            try {
                if(TokenFile(".close",nonce)){Close("requested");break;}
                if(lifetime.ElapsedMilliseconds>90000 || !File.Exists(file+".heartbeat") || DateTime.UtcNow-File.GetLastWriteTimeUtc(file+".heartbeat")>TimeSpan.FromSeconds(30)){Close("heartbeat_or_ttl");break;}
                long entry;lock(sync)entry=enteredCounter;
                if(entry!=0 && (Stopwatch.GetTimestamp()-entry)*1000.0/Stopwatch.Frequency>15000 && !getterReturned.WaitOne(0)){Close("getter_deadman");break;}
                if(TokenFile(".release",nonce+":"+runId))Release("explicit-release");
                if(File.Exists(file+".arm.json")) {
                    var info=new FileInfo(file+".arm.json");if(info.Length>4096)throw new InvalidDataException();
                    System.Collections.Generic.Dictionary<string,object> request=null;
                    try {request=new JavaScriptSerializer().DeserializeObject(File.ReadAllText(info.FullName)) as System.Collections.Generic.Dictionary<string,object>;}catch(ArgumentException){}
                    if(request!=null) {
                        object n,id,expiry;
                        if(request.Count!=3 || !request.TryGetValue("nonce",out n) || !request.TryGetValue("id",out id) || !request.TryGetValue("expiresAt",out expiry) || !Object.Equals(n,nonce))throw new InvalidDataException();
                        Guid parsed;if(!(id is string)||!Guid.TryParse((string)id,out parsed)||parsed==Guid.Empty)throw new InvalidDataException();
                        lock(sync)if(phase=="idle") {
                            if(Convert.ToDouble(expiry,CultureInfo.InvariantCulture)<(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds)throw new InvalidDataException();
                            runId=(string)id;phase="armed";gate.Reset();Write(".armed.json",State());
                        }
                    }
                }
                Write(".state.json",State());
            }catch {Close("control_error");break;}
            Thread.Sleep(20);
        }
    }
    [STAThread]public static int Main(string[] args) {
        if(args.Length!=2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{32}$"))return 2;
        file=args[0];nonce=args[1];rootName="ProfilePilot provider block "+nonce;
        try {
            try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
            using(var process=Process.GetCurrentProcess()){pid=process.Id;birth=process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);}
            uiThread=GetCurrentThreadId();IntPtr foregroundBefore=GetForegroundWindow();
            Application.EnableVisualStyles();form=new OwnedForm{Text=rootName,AccessibleName=rootName,ShowInTaskbar=false,Size=new Size(540,180),StartPosition=FormStartPosition.Manual};
            var work=Screen.PrimaryScreen.WorkingArea;form.Location=new Point(work.Left+Math.Max(0,(work.Width-form.Width)/2),work.Top+Math.Max(0,(work.Height-form.Height)/2));
            form.Controls.Add(new BlockingControl{Location=new Point(20,25)});
            form.Shown+=delegate {hwnd=form.Handle;Write(".ready.json",new {nonce,pid,startedUtcTicks=birth,hwnd=hwnd.ToInt64().ToString(),currentHwnd=hwnd.ToInt64().ToString(),rootName,
                foregroundBefore=foregroundBefore.ToInt64().ToString(),foregroundAfter=GetForegroundWindow().ToInt64().ToString(),nonactivating=true,uiThreadId=uiThread});
                var watcher=new Thread(Watch);watcher.IsBackground=true;watcher.Start();};
            Application.Run(form);lock(sync){closing=true;if(reason==null)reason="external-close";}Release("form-ended");getterReturned.WaitOne(2000);
            Write(".closed.json",new {nonce,pid,startedUtcTicks=birth,reason,originalHwndGone=!IsWindow(hwnd),getterPending=!getterReturned.WaitOne(0),entries,returned,keyboard,pointer});
            return reason=="requested"&&!IsWindow(hwnd)&&getterReturned.WaitOne(0)?0:1;
        }catch{try{Write(".error.json",new {nonce,pid,code="PROVIDER_FIXTURE_FAILED"});}catch{}return 2;}
    }
}
