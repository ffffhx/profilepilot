using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Owned verification surface. A file channel deliberately changes controls
// outside ProfilePilot so stale-reference checks can be tested independently.
static class DesktopStateFixture {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static void Save(string file, object value){File.WriteAllText(file,Json.Serialize(value),new UTF8Encoding(false));}
    static string Hash(string value){using(var sha=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
    [STAThread] static void Main(string[] args){
        if(args.Length!=2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{32}$"))throw new ArgumentException("Expected owned fixture state path and nonce");
        string file=args[0],nonce=args[1],closeReason="window_closed";
        int pid;string startedTicks;using(var self=Process.GetCurrentProcess()){pid=self.Id;startedTicks=self.StartTime.ToUniversalTime().Ticks.ToString();}
        var lifetime=Stopwatch.StartNew();
        try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
        Application.EnableVisualStyles();
        using(var form=new Form{Text="ProfilePilot state verification",ClientSize=new Size(620,410),StartPosition=FormStartPosition.CenterScreen,AutoScaleMode=AutoScaleMode.None}){
            var input=new TextBox{Left=24,Top=25,Width=560,Text="initial",AccessibleName="State value"};
            var check=new CheckBox{Left=24,Top=65,Width=260,Text="Fixture toggle",AccessibleName="State toggle"};
            var choices=new ListBox{Left=24,Top=105,Width=260,Height=95,AccessibleName="State selection"};
            choices.Items.AddRange(new object[]{"Choice one","Choice two"});choices.SelectedIndex=0;
            var tree=new TreeView{Left=315,Top=65,Width=270,Height=135,AccessibleName="State tree"};
            var branch=tree.Nodes.Add("State branch");branch.Nodes.Add("State leaf");
            var asyncButton=new Button{Left=24,Top=225,Width=260,Height=38,Text="Start delayed save",AccessibleName="Start delayed save"};
            var status=new Label{Left=315,Top=225,Width=270,Height=38,Text="Waiting"};
            var password=new TextBox{Left=24,Top=290,Width=560,UseSystemPasswordChar=true,Text="state-password-never-return",AccessibleName="State password"};
            var delayed=new Timer{Interval=1200}; int saves=0;
            delayed.Tick+=(s,e)=>{delayed.Stop();status.Text="Saved "+saves;Save(file+".saved.json",new{nonce,pid,saves,text=status.Text});};
            asyncButton.Click+=(s,e)=>{saves++;status.Text="Saving "+saves;delayed.Stop();delayed.Start();};
            form.Controls.AddRange(new Control[]{input,check,choices,tree,asyncButton,status,password});
            string previous="";
            var commands=new Timer{Interval=40};
            commands.Tick+=(s,e)=>{
                if(File.Exists(file+".close") && File.ReadAllText(file+".close",Encoding.UTF8)==nonce){closeReason="requested";commands.Stop();form.Close();return;}
                if(lifetime.ElapsedMilliseconds>300000 || !File.Exists(file+".heartbeat") || DateTime.UtcNow-File.GetLastWriteTimeUtc(file+".heartbeat")>TimeSpan.FromSeconds(30)){closeReason="heartbeat_or_ttl";commands.Stop();form.Close();return;}
                if(!File.Exists(file+".command.json"))return;
                Dictionary<string,object> command;
                try{command=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file+".command.json",Encoding.UTF8));}catch(ArgumentException){return;}catch(IOException){return;}
                if(!command.ContainsKey("nonce") || Convert.ToString(command["nonce"])!=nonce || !command.ContainsKey("id"))return;
                string id=Convert.ToString(command["id"]);Guid parsedId;if(!Guid.TryParse(id,out parsedId) || id==previous)return;previous=id;
                try{
                    string operation=Convert.ToString(command["operation"]);
                    if(operation=="value")input.Text=Convert.ToString(command["value"]);
                    else if(operation=="readOnly")input.ReadOnly=Convert.ToBoolean(command["value"]);
                    else if(operation=="toggle")check.Checked=Convert.ToBoolean(command["value"]);
                    else if(operation=="selection")choices.SelectedIndex=Convert.ToInt32(command["value"]);
                    else if(operation=="expanded"){if(Convert.ToBoolean(command["value"]))branch.Expand();else branch.Collapse();}
                    else if(operation=="buttonName")asyncButton.AccessibleName=Convert.ToString(command["value"]);
                    else throw new ArgumentException("Unknown fixture operation");
                    Save(file+".ack.json",new{nonce,pid,id,ok=true,valueLength=input.Text.Length,valueSha256=Hash(input.Text)});
                }catch(Exception error){Save(file+".ack.json",new{nonce,pid,id,ok=false,error=error.Message});}
            };
            form.Shown+=(s,e)=>{
                using(var graphics=form.CreateGraphics())Save(file+".environment.json",new{nonce,pid,startedUtcTicks=startedTicks,hwnd=form.Handle.ToInt64().ToString(),administrator=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),dpi=graphics.DpiX,screenCount=Screen.AllScreens.Length});
                commands.Start();
            };
            form.FormClosed+=(s,e)=>{commands.Dispose();delayed.Dispose();Save(file+".closed.json",new{nonce,pid,startedUtcTicks=startedTicks,reason=closeReason});};
            Application.Run(form);
        }
    }
}
