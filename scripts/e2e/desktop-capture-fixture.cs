using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using ProfilePilot.Desktop;

// Owned fixture and probe only. The probe accepts a manifest for this same
// executable, never enumerates windows and never injects keyboard/mouse input.
public static class DesktopCaptureFixture {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect value);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out Rect value);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window,ref Point value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr window,out uint affinity);
    [DllImport("user32.dll",EntryPoint="IsWindowRedirectedForPrint")] static extern bool IsWindowRedirectedForPrint(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Write(string file,object value){string temporary=file+".tmp";File.WriteAllText(temporary,AutomationJson.Json.Serialize(value),new UTF8Encoding(false));if(File.Exists(file))File.Delete(file);File.Move(temporary,file);}
    public static void Gate(string file){
        if(String.IsNullOrWhiteSpace(file))throw new Exception("An explicit desktop acceptance gate path is required.");
        if(!File.Exists(file))return;
        var gate=(Dictionary<string,object>)AutomationJson.Json.DeserializeObject(File.ReadAllText(file));
        DateTimeOffset notBefore;object raw;
        if(!gate.TryGetValue("notBefore",out raw) || !DateTimeOffset.TryParse(Convert.ToString(raw),out notBefore))throw new Exception("Invalid desktop acceptance gate.");
        if(DateTimeOffset.UtcNow<notBefore)throw new Exception("DESKTOP_ACCEPTANCE_DEFERRED until "+notBefore.ToUniversalTime().ToString("o"));
    }
    static void Medium(){using(var identity=WindowsIdentity.GetCurrent())if(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new Exception("Desktop capture fixture/probe must run without administrator privileges.");}
    static void Dpi(){try{if(SetProcessDpiAwarenessContext(new IntPtr(-4)))return;}catch(EntryPointNotFoundException){}SetProcessDPIAware();}
    static object Box(Rect rect){return new{x=rect.Left,y=rect.Top,width=rect.Right-rect.Left,height=rect.Bottom-rect.Top};}
    public static object Bounds(IntPtr window){Rect value;GetWindowRect(window,out value);return Box(value);}
    public static object Client(IntPtr window){Rect value;GetClientRect(window,out value);Point origin=new Point();ClientToScreen(window,ref origin);return new{x=origin.X,y=origin.Y,width=value.Right-value.Left,height=value.Bottom-value.Top};}
    // Pure predicate tested without a window. Redirection is queried from the
    // OS, never inferred merely from receiving an ordinary paint message.
    public static bool IsCapturePrintMessage(int message,bool? redirected){return message==0x317 || message==0x318 || redirected==true;}
    public static bool? PrintRedirection(IntPtr window){try{return IsWindowRedirectedForPrint(window);}catch(EntryPointNotFoundException){return null;}}
    public static Rectangle GeometryStressBounds(Rectangle initial,Rectangle work,int sequence){
        int width=Math.Min(work.Width,Math.Max(160,initial.Width-2*(sequence%17)));
        int height=Math.Min(work.Height,Math.Max(120,initial.Height-(sequence%11)));
        return new Rectangle(Math.Max(work.Left,Math.Min(work.Right-width,initial.Left+sequence%7)),
            Math.Max(work.Top,Math.Min(work.Bottom-height,initial.Top+sequence%5)),width,height);
    }
    static string StartExternalGeometry(string manifestFile,Dictionary<string,object> manifest){
        object enabled;if(!manifest.TryGetValue("externalGeometryStress",out enabled) || !(enabled is bool) || !(bool)enabled)return null;
        string directory=Path.GetDirectoryName(manifestFile),id="geometry-"+Guid.NewGuid().ToString("N"),nonce=(string)manifest["nonce"];
        Write(Path.Combine(directory,"command.json"),new{id,nonce,action="geometry-start"});
        var wait=Stopwatch.StartNew();
        while(wait.ElapsedMilliseconds<2500){
            try{
                var reply=(Dictionary<string,object>)AutomationJson.Json.DeserializeObject(File.ReadAllText(Path.Combine(directory,"response.json")));
                if((string)reply["id"]==id){
                    var state=(Dictionary<string,object>)reply["state"];
                    var stress=(Dictionary<string,object>)state["geometryStress"];
                    if((string)reply["nonce"]!=nonce || Convert.ToInt32(state["pid"])!=Convert.ToInt32(manifest["pid"]) || reply["error"]!=null ||
                        (string)stress["runId"]!=id || !(bool)stress["active"])throw new Exception("Owned geometry timer handshake was invalid.");
                    return id;
                }
            }catch(IOException){}
            Thread.Sleep(10);
        }
        throw new Exception("Owned geometry timer did not acknowledge its bounded start.");
    }
    static object Capture(string manifestFile){
        var manifest=(Dictionary<string,object>)AutomationJson.Json.DeserializeObject(File.ReadAllText(manifestFile));
        int pid=Convert.ToInt32(manifest["pid"]);long started=Int64.Parse((string)manifest["startedUtcTicks"]);
        using(var targetProcess=Process.GetProcessById(pid)){
            if(!String.Equals(Path.GetFullPath(targetProcess.MainModule.FileName),Path.GetFullPath(Application.ExecutablePath),StringComparison.OrdinalIgnoreCase) || targetProcess.StartTime.ToUniversalTime().Ticks!=started)
                throw new Exception("The probe only accepts its own fixture executable and original process identity.");
        }
        IntPtr window=new IntPtr(Int64.Parse((string)manifest["hwnd"]));
        string geometryStressRunId=StartExternalGeometry(manifestFile,manifest);
        IntPtr foreground=GetForegroundWindow();var watch=Stopwatch.StartNew();
        using(var driver=new AutomationWindows()){
            // Seed only the owned HWND. The real public screenshot entry still
            // performs identity, desktop, DPI, capture and state validation.
            Type targetType=typeof(AutomationWindows).GetNestedType("Target",BindingFlags.NonPublic);
            object target=Activator.CreateInstance(targetType);
            targetType.GetField("Handle").SetValue(target,window);targetType.GetField("Pid").SetValue(target,pid);targetType.GetField("Started").SetValue(target,started);
            var targets=(IDictionary)typeof(AutomationWindows).GetField("targets",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(driver);
            string id=Guid.NewGuid().ToString("N");targets.Add(id,target);
            string captureStartedAt=DateTime.UtcNow.ToString("o");
            try{
                object result=driver.Handle("window.screenshot",new Dictionary<string,object>{{"windowId",id},{"screenshotOnly",true}});
                return new{ok=true,result,geometryStressRunId,captureStartedAt,captureFinishedAt=DateTime.UtcNow.ToString("o"),elapsedMs=watch.Elapsed.TotalMilliseconds,workerPid=Process.GetCurrentProcess().Id,
                    integrity=DesktopDiagnostics.ProcessIntegrity(Process.GetCurrentProcess().Id),foregroundBefore=foreground.ToInt64().ToString(),foregroundAfter=GetForegroundWindow().ToInt64().ToString()};
            }catch(AutomationFault fault){return new{ok=false,code=fault.Message,cause=fault.Cause,diagnostics=fault.Data["diagnostics"],geometryStressRunId,captureStartedAt,captureFinishedAt=DateTime.UtcNow.ToString("o"),elapsedMs=watch.Elapsed.TotalMilliseconds,
                workerPid=Process.GetCurrentProcess().Id,integrity=DesktopDiagnostics.ProcessIntegrity(Process.GetCurrentProcess().Id),foregroundBefore=foreground.ToInt64().ToString(),foregroundAfter=GetForegroundWindow().ToInt64().ToString()};}
        }
    }
    static object Decode(string file){
        using(var bitmap=new Bitmap(file)){
            Color[] colors={Color.FromArgb(220,30,30),Color.FromArgb(30,210,80),Color.FromArgb(30,80,220)};
            long[] counts=new long[3],sumX=new long[3],sumY=new long[3];
            for(int y=0;y<bitmap.Height;y++)for(int x=0;x<bitmap.Width;x++){
                Color pixel=bitmap.GetPixel(x,y);
                for(int i=0;i<colors.Length;i++)if(Math.Abs(pixel.R-colors[i].R)<=35 && Math.Abs(pixel.G-colors[i].G)<=35 && Math.Abs(pixel.B-colors[i].B)<=35){counts[i]++;sumX[i]+=x;sumY[i]+=y;}
            }
            var markers=new List<object>();for(int i=0;i<3;i++)markers.Add(new{count=counts[i],x=counts[i]==0?0:(double)sumX[i]/counts[i],y=counts[i]==0?0:(double)sumY[i]/counts[i]});
            return new{width=bitmap.Width,height=bitmap.Height,format=bitmap.RawFormat.Guid.ToString(),markers};
        }
    }
    [STAThread] public static int Main(string[] args){
        try{
            if(args.Length==2 && args[0]=="--decode-image"){Console.WriteLine(AutomationJson.Json.Serialize(Decode(args[1])));return 0;}
            if(args.Length!=4 || (args[0]!="--fixture" && args[0]!="--capture"))throw new Exception("Expected --fixture gate home nonce or --capture gate manifest output.");
            Gate(args[1]);Medium();Dpi();
            if(args[0]=="--capture"){
                // PrintWindow is synchronous; a standalone acceptance process
                // has a hard deadline, independent of the production worker.
                var watchdog=new Thread(()=>{Thread.Sleep(12000);Environment.Exit(124);});watchdog.IsBackground=true;watchdog.Start();
                Write(args[3],Capture(args[2]));return 0;
            }
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new CaptureForm(args[2],args[3]));return 0;
        }catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
    }
}

public sealed class CaptureForm:Form {
    readonly string home,nonce;
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer geometryTimer=new System.Windows.Forms.Timer();
    readonly Stopwatch geometryClock=new Stopwatch();
    readonly List<object> geometryEvents=new List<object>();
    Rectangle geometryInitial,geometryWork;
    string geometryRunId="";
    int geometrySequence;
    bool geometryHistoryTruncated;
    Rectangle normal;
    string lastCommand="",onPrint="";
    int printCount,paintCount,redirectedPrintCount,printMutationCount,mutations;
    bool? printRedirectionAvailable;
    object lastPrintMutation;
    bool? protectionSet;
    int? protectionSetError;
    protected override bool ShowWithoutActivation {get{return true;}}
    public CaptureForm(string directory,string token){
        home=directory;nonce=token;Text="ProfilePilot owned capture "+token;AutoScaleMode=AutoScaleMode.None;
        ClientSize=new Size(640,440);StartPosition=FormStartPosition.Manual;ShowInTaskbar=false;
        Rectangle work=Screen.PrimaryScreen.WorkingArea;Location=new Point(work.Left+Math.Min(80,Math.Max(0,work.Width-Width)),work.Top+Math.Min(80,Math.Max(0,work.Height-Height)));
        BackColor=Color.White;DoubleBuffered=true;timer.Interval=40;timer.Tick+=(sender,args)=>Command();
        geometryTimer.Interval=16;geometryTimer.Tick+=(sender,args)=>GeometryTick();
        Shown+=(sender,args)=>{normal=Bounds;Reply("ready");timer.Start();};
        FormClosed+=(sender,args)=>{timer.Dispose();geometryTimer.Dispose();};
    }
    protected override void OnPaint(PaintEventArgs args){
        base.OnPaint(args);args.Graphics.Clear(Color.White);
        using(var red=new SolidBrush(Color.FromArgb(220,30,30)))args.Graphics.FillRectangle(red,24,24,100,80);
        using(var green=new SolidBrush(Color.FromArgb(30,210,80)))args.Graphics.FillRectangle(green,ClientSize.Width-124,24,100,80);
        using(var blue=new SolidBrush(Color.FromArgb(30,80,220)))args.Graphics.FillRectangle(blue,24,ClientSize.Height-104,100,80);
        args.Graphics.DrawString("Owned native capture fixture",Font,Brushes.Black,150,190);
    }
    void Protection(uint affinity){
        if(affinity!=0)Opacity=0.99; // Queryable layered window for the protection case.
        DesktopDiagnostics.SetLastError(0);protectionSet=DesktopCaptureFixture.SetWindowDisplayAffinity(Handle,affinity);
        protectionSetError=protectionSet==true?(int?)null:Marshal.GetLastWin32Error();
    }
    void Mutation(string action){
        if(action=="resize")Bounds=new Rectangle(Left+17,Top+9,Width+80,Height+60);
        else if(action=="hide")Hide();
        else if(action=="minimize")WindowState=FormWindowState.Minimized;
        else if(action=="protect")Protection(1);
        else throw new Exception("Unknown owned mutation "+action);
        mutations++;
    }
    void GeometryTick(){
        if(geometryClock.ElapsedMilliseconds>=1500){geometryTimer.Stop();return;}
        string startedAt=DateTime.UtcNow.ToString("o");object before=DesktopCaptureFixture.Bounds(Handle);
        geometrySequence++;Bounds=DesktopCaptureFixture.GeometryStressBounds(geometryInitial,geometryWork,geometrySequence);
        var change=new{sequence=geometrySequence,startedAt,finishedAt=DateTime.UtcNow.ToString("o"),before,after=DesktopCaptureFixture.Bounds(Handle)};
        if(geometryEvents.Count==256){geometryEvents.RemoveAt(0);geometryHistoryTruncated=true;}
        geometryEvents.Add(change);
    }
    void StartGeometry(string id){
        if(!Visible || WindowState!=FormWindowState.Normal || onPrint!="")throw new Exception("Geometry stress requires a normal unarmed owned window.");
        geometryTimer.Stop();geometryInitial=Bounds;geometryWork=Screen.FromHandle(Handle).WorkingArea;geometryRunId=id;
        geometrySequence=0;geometryHistoryTruncated=false;geometryEvents.Clear();geometryClock.Restart();geometryTimer.Start();
    }
    protected override void WndProc(ref Message message){
        if(message.Msg==0x317 || message.Msg==0x318)printCount++;
        if(message.Msg==0xf)paintCount++;
        if(onPrint!=""){
            bool? redirected=DesktopCaptureFixture.PrintRedirection(Handle);printRedirectionAvailable=redirected.HasValue;
            if(redirected==true)redirectedPrintCount++;
            if(DesktopCaptureFixture.IsCapturePrintMessage(message.Msg,redirected)){
                string action=onPrint;onPrint="";string startedAt=DateTime.UtcNow.ToString("o");object before=DesktopCaptureFixture.Bounds(Handle);
                Mutation(action);printMutationCount++;
                lastPrintMutation=new{action,message=message.Msg,redirected,startedAt,finishedAt=DateTime.UtcNow.ToString("o"),
                    trigger=message.Msg==0x317 || message.Msg==0x318?"wm-print":"os-confirmed-print-redirection",before,after=DesktopCaptureFixture.Bounds(Handle)};
            }
        }
        base.WndProc(ref message);
    }
    object State(){
        uint affinity;DesktopDiagnostics.SetLastError(0);bool affinityKnown=DesktopCaptureFixture.GetWindowDisplayAffinity(Handle,out affinity);int error=Marshal.GetLastWin32Error();
        using(var process=Process.GetCurrentProcess())return new {nonce,pid=process.Id,hwnd=Handle.ToInt64().ToString(),startedUtcTicks=process.StartTime.ToUniversalTime().Ticks.ToString(),
            visible=Visible,minimized=WindowState==FormWindowState.Minimized,window=DesktopCaptureFixture.Bounds(Handle),client=DesktopCaptureFixture.Client(Handle),
            displayAffinity=affinityKnown?(uint?)affinity:null,displayAffinityError=affinityKnown?(int?)null:error,protectionSet,protectionSetError,
            printCount,paintCount,redirectedPrintCount,printMutationCount,printRedirectionAvailable,lastPrintMutation,mutations,onPrint,integrity=DesktopDiagnostics.ProcessIntegrity(process.Id),
            geometryStress=new{source="owned-ui-timer",runId=geometryRunId,active=geometryTimer.Enabled,intervalMs=16,maximumDurationMs=1500,sequence=geometrySequence,historyTruncated=geometryHistoryTruncated,events=geometryEvents.ToArray()},
            markers=new[]{new{x=74.0,y=64.0},new{x=ClientSize.Width-74.0,y=64.0},new{x=74.0,y=ClientSize.Height-64.0}}};
    }
    void Reply(string id,string error=null){DesktopCaptureFixture.Write(Path.Combine(home,"response.json"),new{id,nonce,state=State(),error});}
    void Command(){
        string file=Path.Combine(home,"command.json");if(!File.Exists(file))return;
        string id=null;
        try{
            var command=(Dictionary<string,object>)AutomationJson.Json.DeserializeObject(File.ReadAllText(file));id=(string)command["id"];
            if(id==lastCommand)return;if((string)command["nonce"]!=nonce)throw new Exception("Owned fixture nonce mismatch");lastCommand=id;
            string action=(string)command["action"];
            if(action=="normal"){geometryTimer.Stop();onPrint="";Protection(0);Opacity=1;WindowState=FormWindowState.Normal;Bounds=normal;Show();Invalidate();Update();}
            else if(action=="state"){}
            else if(action=="geometry-start")StartGeometry(id);
            else if(action=="geometry-stop")geometryTimer.Stop();
            else if(action=="close"){geometryTimer.Stop();Reply(id);Close();return;}
            else if(action.StartsWith("on-print-",StringComparison.Ordinal)){onPrint=action.Substring(9);if(onPrint=="protect")Opacity=0.99;}
            else Mutation(action);
            Reply(id);
        }catch(IOException){}catch(Exception error){if(id!=null)Reply(id,error.Message);}
    }
}
