using System;
using System.Drawing;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Security.Principal;
using System.Diagnostics;
using System.Text.RegularExpressions;

public static class DesktopFixture {
    public static bool AssistedPopupRequestMatches(Dictionary<string,object> request,Dictionary<string,object> preparation,int pid,string hwnd,string startedUtcTicks){
        if(request==null || preparation==null)return false;
        object nonce,requestPid,requestHwnd,requestStart,receiptNonce,restored,foreground,receiptHwnd,down,up,unmatched;
        return request.TryGetValue("nonce",out nonce) && nonce is string && Regex.IsMatch((string)nonce,"^[a-f0-9]{32}$") &&
            request.TryGetValue("pid",out requestPid) && requestPid is int && (int)requestPid==pid &&
            request.TryGetValue("hwnd",out requestHwnd) && Object.Equals(requestHwnd,hwnd) &&
            request.TryGetValue("startedUtcTicks",out requestStart) && Object.Equals(requestStart,startedUtcTicks) &&
            preparation.TryGetValue("nonce",out receiptNonce) && Object.Equals(receiptNonce,nonce) &&
            preparation.TryGetValue("topMostRestored",out restored) && Object.Equals(restored,true) &&
            preparation.TryGetValue("targetWasForeground",out foreground) && Object.Equals(foreground,true) &&
            preparation.TryGetValue("foregroundHwnd",out receiptHwnd) && Object.Equals(receiptHwnd,hwnd) &&
            preparation.TryGetValue("downCount",out down) && Object.Equals(down,1) &&
            preparation.TryGetValue("upCount",out up) && Object.Equals(up,1) &&
            preparation.TryGetValue("unmatchedEvents",out unmatched) && Object.Equals(unmatched,0);
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetMessageExtraInfo();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Save(string file, object value) { File.WriteAllText(file, Json.Serialize(value), new System.Text.UTF8Encoding(false)); }
    sealed class MarkerCount { public string kind,marker;public int count; }
    static readonly List<MarkerCount> InputMarkers=new List<MarkerCount>();
    static string MarkerFile;
    static bool MarkersDirty=true,MarkerOverflow;
    // Only messages delivered to our own controls are counted. A zero marker,
    // especially on a synthesized WM_MOUSEMOVE, is unattributed, not evidence
    // of physical input. Never record key payloads or screen coordinates here.
    static void RecordInputMarker(Message message){
        string kind=null;
        switch(message.Msg){
            case 0x200:kind="move";break;
            case 0x201:kind="left_down";break;case 0x202:kind="left_up";break;case 0x203:kind="left_double";break;
            case 0x204:kind="right_down";break;case 0x205:kind="right_up";break;case 0x206:kind="right_double";break;
            case 0x207:kind="middle_down";break;case 0x208:kind="middle_up";break;case 0x209:kind="middle_double";break;
            case 0x20a:kind="wheel_y";break;case 0x20e:kind="wheel_x";break;
            case 0x100:case 0x104:kind=message.WParam.ToInt64()==231?"unicode_down":"key_down";break;
            case 0x101:case 0x105:kind=message.WParam.ToInt64()==231?"unicode_up":"key_up";break;
        }
        if(kind==null)return;
        string marker=unchecked((ulong)GetMessageExtraInfo().ToInt64()).ToString("x16");
        var entry=InputMarkers.FirstOrDefault(value=>value.kind==kind && value.marker==marker);
        if(entry!=null)entry.count++;
        else if(InputMarkers.Count<128)InputMarkers.Add(new MarkerCount{kind=kind,marker=marker,count=1});
        else MarkerOverflow=true;
        MarkersDirty=true;
    }
    static void FlushMarkers(){
        if(!MarkersDirty || MarkerFile==null)return;
        Save(MarkerFile,new {source="GetMessageExtraInfo",pointerBits=IntPtr.Size*8,lowLevelHookEvidence=false,events=InputMarkers.ToArray(),overflow=MarkerOverflow});MarkersDirty=false;
    }
    sealed class MarkerTextBox : TextBox {
        protected override void WndProc(ref Message message){RecordInputMarker(message);base.WndProc(ref message);}
    }
    sealed class MarkerLabel : Label {
        protected override void WndProc(ref Message message){RecordInputMarker(message);base.WndProc(ref message);}
    }

    // Decode captured bytes without creating a window. Assertions use real
    // JPEG/PNG pixels independently of the desktop helper's image metadata.
    static void InspectImage(string file) {
        using (var bitmap = new Bitmap(file)) {
            var colors = new[] { new[] {33,160,80}, new[] {34,119,187}, new[] {215,50,70} };
            var markers = colors.Select(rgb => {
                int count=0,left=bitmap.Width,top=bitmap.Height,right=-1,bottom=-1; long sx=0,sy=0;
                for(int y=0;y<bitmap.Height;y++) for(int x=0;x<bitmap.Width;x++) {
                    var c=bitmap.GetPixel(x,y);
                    if(Math.Abs(c.R-rgb[0])<=20 && Math.Abs(c.G-rgb[1])<=20 && Math.Abs(c.B-rgb[2])<=20) {
                        count++;sx+=x;sy+=y;left=Math.Min(left,x);top=Math.Min(top,y);right=Math.Max(right,x);bottom=Math.Max(bottom,y);
                    }
                }
                return new {rgb,count,x=count==0?-1:(double)sx/count,y=count==0?-1:(double)sy/count,left,top,right,bottom};
            }).ToArray();
            Console.WriteLine(Json.Serialize(new {width=bitmap.Width,height=bitmap.Height,format=bitmap.RawFormat.Guid.ToString(),markers}));
        }
    }
    sealed class PointerSurface : Control {
        readonly string stateFile;
        Rectangle green=new Rectangle(30,32,48,48);
        bool dragging,held; Point start;
        int downs,ups,moves,doubles,middles,drags,wheelY,wheelX,lastX,lastY;
        public PointerSurface(string file) {
            stateFile=file;BackColor=Color.FromArgb(243,240,220);TabStop=true;
            AccessibleName="Desktop pointer surface";AccessibleRole=AccessibleRole.Pane;
            SetStyle(ControlStyles.StandardClick|ControlStyles.StandardDoubleClick|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Selectable,true);
            Persist();
        }
        void Persist() { Save(stateFile,new {downs,ups,moves,doubles,middles,drags,wheelY,wheelX,lastX,lastY,held,greenX=green.X+green.Width/2,greenY=green.Y+green.Height/2}); }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            using(var brush=new SolidBrush(Color.FromArgb(33,160,80)))e.Graphics.FillRectangle(brush,green);
            using(var brush=new SolidBrush(Color.FromArgb(34,119,187)))e.Graphics.FillRectangle(brush,new Rectangle(290,32,48,48));
            using(var brush=new SolidBrush(Color.FromArgb(215,50,70)))e.Graphics.FillRectangle(brush,new Rectangle(420,32,48,48));
        }
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);Focus();downs++;held=true;start=e.Location;lastX=e.X;lastY=e.Y;
            dragging=e.Button==MouseButtons.Left && green.Contains(e.Location);
            if(dragging)Capture=true;Persist();
        }
        protected override void OnMouseMove(MouseEventArgs e) {
            base.OnMouseMove(e);moves++;lastX=e.X;lastY=e.Y;
            if(dragging){green.Location=new Point(e.X-green.Width/2,e.Y-green.Height/2);Invalidate();}
            Persist();
        }
        protected override void OnMouseUp(MouseEventArgs e) {
            base.OnMouseUp(e);ups++;held=false;lastX=e.X;lastY=e.Y;
            if(e.Button==MouseButtons.Middle)middles++;
            if(dragging && (Math.Abs(e.X-start.X)>8 || Math.Abs(e.Y-start.Y)>8))drags++;
            dragging=false;Capture=false;Persist();
        }
        protected override void OnMouseDoubleClick(MouseEventArgs e) { base.OnMouseDoubleClick(e);doubles++;Persist(); }
        protected override void OnMouseWheel(MouseEventArgs e) { base.OnMouseWheel(e);wheelY+=e.Delta;Persist(); }
        protected override void WndProc(ref Message message) {
            RecordInputMarker(message);
            if(message.Msg==0x20E){wheelX+=unchecked((short)(message.WParam.ToInt64()>>16));Persist();message.Result=IntPtr.Zero;return;}
            base.WndProc(ref message);
        }
    }
    sealed class NoActivatePopup : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
        // Keep managed TopMost false: Form.SetVisibleCore otherwise calls
        // FocusActiveControlInternal even when ShowWithoutActivation is true.
        // Initial native WS_EX_TOPMOST avoids that managed activation path.
        protected override CreateParams CreateParams { get { var p=base.CreateParams;p.ExStyle|=0x08000000|0x80|0x8;return p; } }
        protected override void WndProc(ref Message message){
            if(message.Msg==0x21){message.Result=new IntPtr(3);return;}
            base.WndProc(ref message);
        }
    }
    [STAThread] public static void Main(string[] args){
        if(args.Length==2 && args[0]=="--inspect-image"){InspectImage(args[1]);return;}
        if(args.Length==1 && args[0]=="--input-state") {
            Console.WriteLine(Json.Serialize(new {left=(GetAsyncKeyState(1)&0x8000)!=0,right=(GetAsyncKeyState(2)&0x8000)!=0,middle=(GetAsyncKeyState(4)&0x8000)!=0,shift=(GetAsyncKeyState(16)&0x8000)!=0,control=(GetAsyncKeyState(17)&0x8000)!=0,alt=(GetAsyncKeyState(18)&0x8000)!=0}));return;
        }
        bool detached=args.Skip(1).Contains("--detached"),assisted=args.Skip(1).Contains("--assisted-foreground");
        if(args.Length<1 || args.Skip(1).Any(value=>value!="--detached" && value!="--assisted-foreground") || args.Skip(1).Distinct().Count()!=args.Length-1)
            throw new ArgumentException("Expected receipt path [--detached] [--assisted-foreground], --input-state or --inspect-image path");
        MarkerFile=args[0]+".markers.json";
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){SetProcessDPIAware();}
        Application.EnableVisualStyles();
        using(var form=new Form{Text="ProfilePilot desktop verification",ClientSize=new Size(620,430),StartPosition=FormStartPosition.CenterScreen,AutoScaleMode=AutoScaleMode.None}){
            var input=new MarkerTextBox{Left=24,Top=25,Width=540,AccessibleName="Desktop test input"};
            var apply=new Button{Left=24,Top=72,Width=170,Height=36,Text="Apply",AccessibleName="Desktop test apply"};
            var populate=new Button{Left=220,Top=72,Width=200,Height=36,Text="Populate 300 controls",AccessibleName="Desktop test populate"};
            var result=new Label{Left=24,Top=125,Width=540,Height=44,Text="Ready",AccessibleName="Desktop test result"};
            var password=new TextBox{Left=24,Top=180,Width=540,UseSystemPasswordChar=true,Text="fixture-password-should-be-omitted",AccessibleName="Password"};
            var surface=new PointerSurface(args[0]+".input.json"){Left=24,Top=235,Width=540,Height=160};
            int clicks=0;apply.Click+=(s,e)=>{result.Text="Applied "+(++clicks)+": "+input.Text;File.WriteAllText(args[0],clicks+"\n"+input.Text,new System.Text.UTF8Encoding(false));};
            populate.Click+=(s,e)=>{
                var panel=new Panel{Left=24,Top=230,Width=560,Height=180,AccessibleName="Desktop truncation parent"};
                for(int i=0;i<300;i++)panel.Controls.Add(new Button{Left=i%20*28,Top=i/20*12,Width=28,Height=12,Text=i.ToString(),AccessibleName="Budget child "+i});
                form.Controls.Add(panel);panel.BringToFront();populate.Enabled=false;
            };
            form.Controls.AddRange(new Control[]{input,apply,populate,result,password,surface});
            new AssistedForegroundFixture(form,args[0],assisted);
            bool popupAttempted=false;
            Action<string> showPopup=nonce=>{
                var popup=new NoActivatePopup{Text="",AccessibleName="Untitled desktop popup",FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Left=20,Top=60,Width=250,Height=90};
                var popupButton=new MarkerLabel{Left=20,Top=20,Width=210,Height=45,Text="Popup action",AccessibleName="Desktop popup action",BackColor=Color.LightBlue,TextAlign=ContentAlignment.MiddleCenter};
                popupButton.Click+=(sender,eventArgs)=>File.WriteAllText(args[0]+".popup",GetForegroundWindow()==form.Handle?"clicked-without-activation":"focus-stolen");
                popup.Controls.Add(popupButton);popup.Show(form);
                if(assisted)using(var process=Process.GetCurrentProcess())Save(args[0]+".popup.ready.json",new{ok=true,nonce,pid=process.Id,
                    startedUtcTicks=process.StartTime.ToUniversalTime().Ticks.ToString(),ownerHwnd=form.Handle.ToInt64().ToString(),popupHwnd=popup.Handle.ToInt64().ToString(),
                    foregroundHwnd=GetForegroundWindow().ToInt64().ToString(),managedTopMost=popup.TopMost,native=AssistedWindowDiagnostics.Snapshot(popup.Handle)});
            };
            var markerTimer=new System.Windows.Forms.Timer{Interval=20};
            markerTimer.Tick+=(s,e)=>{
                FlushMarkers();
                if(!assisted || popupAttempted || !File.Exists(args[0]+".popup.show"))return;
                popupAttempted=true; // A failed setup request never retries creation.
                try{
                    string requestFile=args[0]+".popup.show",preparationFile=args[0]+".foreground.receipt.json";
                    if(new FileInfo(requestFile).Length>2048 || new FileInfo(preparationFile).Length>16384)throw new InvalidOperationException("POPUP_SETUP_INVALID");
                    var request=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(requestFile));
                    var preparation=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(preparationFile));
                    using(var process=Process.GetCurrentProcess())if(!AssistedPopupRequestMatches(request,preparation,process.Id,form.Handle.ToInt64().ToString(),process.StartTime.ToUniversalTime().Ticks.ToString()))throw new InvalidOperationException("POPUP_SETUP_INVALID");
                    if(GetForegroundWindow()!=form.Handle)throw new InvalidOperationException("POPUP_SETUP_FOREGROUND_CHANGED");
                    showPopup((string)request["nonce"]);
                }catch(Exception error){Save(args[0]+".popup.ready.json",new{ok=false,error=error is InvalidOperationException?error.Message:"POPUP_SETUP_FAILED"});}
            };
            form.FormClosed+=(s,e)=>{markerTimer.Stop();FlushMarkers();markerTimer.Dispose();};
            form.Shown+=(s,e)=>{
                if(!assisted){popupAttempted=true;showPopup(null);}
                FlushMarkers();markerTimer.Start();
                using(var graphics=form.CreateGraphics())Save(args[0]+".environment.json",new {pid=Process.GetCurrentProcess().Id,startedUtcTicks=Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),hwnd=form.Handle.ToInt64().ToString(),administrator=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),dpiX=graphics.DpiX,dpiY=graphics.DpiY,screenCount=Screen.AllScreens.Length,screen=Screen.FromControl(form).DeviceName,windowBounds=new[]{form.Left,form.Top,form.Width,form.Height}});
                Console.WriteLine("READY");Console.Out.Flush();
                if(detached){
                    var timer=new System.Windows.Forms.Timer{Interval=100};
                    timer.Tick+=(sender,eventArgs)=>{if(File.Exists(args[0]+".close")){timer.Stop();form.Close();}};
                    form.FormClosed+=(sender,eventArgs)=>timer.Dispose();timer.Start();
                }else new Thread(()=>{while(Console.ReadLine()!=null){}if(!form.IsDisposed)form.BeginInvoke(new Action(form.Close));}){IsBackground=true}.Start();
            };
            Application.Run(form);
        }
    }
}
