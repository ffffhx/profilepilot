using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Self-owned nonce window. The private setup channel only alters this fixture;
// all tested transitions are requested through the actual ProfilePilot App.
static class DesktopWindowStateFixture {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr handle);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    sealed class OwnedForm:Form {
        public bool DenyRestore;
        public int QueryOpen,SizeMessages,PointerMessages,KeyboardMessages;
        public Action Changed=()=>{};
        protected override void WndProc(ref Message message){
            if(message.Msg==0x13){QueryOpen++;if(DenyRestore){message.Result=IntPtr.Zero;Changed();return;}}
            if(message.Msg==5)SizeMessages++;
            if(message.Msg>=0x200 && message.Msg<=0x20e)PointerMessages++;
            if(message.Msg>=0x100 && message.Msg<=0x109)KeyboardMessages++;
            base.WndProc(ref message);
            if(message.Msg==5 || message.Msg==0x13)Changed();
        }
    }
    static void Save(string file,object value){string temporary=file+".tmp";File.WriteAllText(temporary,Json.Serialize(value),new UTF8Encoding(false));if(File.Exists(file))File.Delete(file);File.Move(temporary,file);}
    [STAThread] static void Main(string[] args){
        if(args.Length!=2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{32}$"))throw new ArgumentException("Expected owned base and nonce");
        string file=args[0],nonce=args[1],reason="window_closed",started;int pid;
        using(var self=Process.GetCurrentProcess()){pid=self.Id;started=self.StartTime.ToUniversalTime().Ticks.ToString();}
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
        Application.EnableVisualStyles();var lifetime=Stopwatch.StartNew();IntPtr initial=IntPtr.Zero;
        using(var form=new OwnedForm{Text="ProfilePilot window-state "+nonce,AccessibleName="ProfilePilot window-state "+nonce,StartPosition=FormStartPosition.CenterScreen,ClientSize=new Size(510,230),AutoScaleMode=AutoScaleMode.None}){
            var input=new TextBox{Left=20,Top=25,Width=450,Text="owned-value-unchanged",AccessibleName="Window state child "+nonce};
            form.Controls.Add(input);var label=new Label{Left=20,Top=85,Width=450,Height=80,Text="Owned UIA window-state verification. No keyboard or pointer input is required."};form.Controls.Add(label);
            Func<object> evidence=()=>new{nonce,pid,startedUtcTicks=started,hwnd=initial.ToInt64().ToString(),currentHwnd=form.IsHandleCreated?form.Handle.ToInt64().ToString():null,state=form.WindowState.ToString().ToLowerInvariant(),minimized=form.IsHandleCreated&&IsIconic(form.Handle),maximized=form.IsHandleCreated&&IsZoomed(form.Handle),enabled=form.Enabled,canMinimize=form.MinimizeBox,canMaximize=form.MaximizeBox,denyRestore=form.DenyRestore,queryOpen=form.QueryOpen,sizeMessages=form.SizeMessages,pointerMessages=form.PointerMessages,keyboardMessages=form.KeyboardMessages,value=input.Text,foregroundHwnd=GetForegroundWindow().ToInt64().ToString()};
            form.Changed=()=>{if(initial!=IntPtr.Zero)Save(file+".state.json",evidence());};
            string previous="";var timer=new Timer{Interval=40};
            timer.Tick+=(sender,ev)=>{
                if(File.Exists(file+".close") && File.ReadAllText(file+".close",Encoding.UTF8)==nonce){reason="requested";timer.Stop();form.Close();return;}
                if(lifetime.ElapsedMilliseconds>300000 || !File.Exists(file+".heartbeat") || DateTime.UtcNow-File.GetLastWriteTimeUtc(file+".heartbeat")>TimeSpan.FromSeconds(30)){reason="heartbeat_or_ttl";timer.Stop();form.Close();return;}
                Save(file+".state.json",evidence());
                if(!File.Exists(file+".command.json") || new FileInfo(file+".command.json").Length>4096)return;
                Dictionary<string,object> command;try{command=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file+".command.json",Encoding.UTF8));}catch(ArgumentException){return;}catch(IOException){return;}
                object value;if(!command.TryGetValue("nonce",out value) || Convert.ToString(value)!=nonce || !command.TryGetValue("id",out value))return;
                string id=Convert.ToString(value);Guid parsed;if(!Guid.TryParse(id,out parsed) || id==previous)return;previous=id;
                try{
                    if(!command.ContainsKey("expiresAt") || Convert.ToInt64(command["expiresAt"])<DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())throw new ArgumentException("Expired setup");
                    string operation=Convert.ToString(command["operation"]);
                    if(operation=="canMaximize")form.MaximizeBox=(bool)command["value"];
                    else if(operation=="canMinimize")form.MinimizeBox=(bool)command["value"];
                    else if(operation=="denyRestore")form.DenyRestore=(bool)command["value"];
                    else throw new ArgumentException("Unknown setup");
                    Save(file+".ack.json",new{nonce,pid,id,ok=true,state=evidence()});
                }catch(Exception error){Save(file+".ack.json",new{nonce,pid,id,ok=false,error=error.Message});}
            };
            form.Shown+=(sender,ev)=>{initial=form.Handle;Save(file+".ready.json",evidence());Save(file+".state.json",evidence());timer.Start();};
            Application.Run(form);timer.Dispose();
        }
        Save(file+".closed.json",new{nonce,pid,startedUtcTicks=started,hwnd=initial.ToInt64().ToString(),originalHwndGone=!IsWindow(initial),reason});
    }
}
