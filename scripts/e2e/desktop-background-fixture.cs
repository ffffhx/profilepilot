using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Owned, nonactivating native fixture. Never sends keyboard or mouse input.
public static class DesktopBackgroundFixture {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    sealed class QuietWindow : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Save(string file,object value) {
        string temporary=file+".tmp";
        File.WriteAllText(temporary,Json.Serialize(value),new UTF8Encoding(false));
        if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
    }
    [STAThread] public static void Main(string[] args) {
        if(args.Length!=2)return;
        string file=args[0],nonce=args[1];
        SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();
        using(var form=new QuietWindow())using(var timer=new Timer()) {
            form.Text="ProfilePilot background verification";
            form.StartPosition=FormStartPosition.Manual;form.Size=new Size(440,190);
            var area=Screen.PrimaryScreen.WorkingArea;
            form.Location=new System.Drawing.Point(area.Left+24,area.Top+24);
            var edit=new TextBox { AccessibleName="Background owned edit",Left=20,Top=20,Width=370 };
            var button=new Button { AccessibleName="Background owned button",Text="Semantic action",Left=20,Top=65,Width=180 };
            int clicks=0;button.Click+=delegate{clicks++;};
            form.Controls.Add(edit);form.Controls.Add(button);
            var lifetime=Stopwatch.StartNew();
            timer.Interval=60;
            timer.Tick+=delegate {
                if((File.Exists(file+".close") && File.ReadAllText(file+".close").Trim()==nonce) || lifetime.Elapsed.TotalSeconds>90){form.Close();return;}
                Point point;bool cursor=GetCursorPos(out point);
                Save(file+".state.json",new {nonce,pid=Process.GetCurrentProcess().Id,hwnd=form.Handle.ToInt64().ToString(),text=edit.Text,clicks,
                    foreground=GetForegroundWindow().ToInt64().ToString(),cursor=cursor?new int[]{point.X,point.Y}:null});
            };
            timer.Start();Application.Run(form);
        }
        Save(file+".closed.json",new {nonce});
    }
}
