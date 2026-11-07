using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// An owned test surface, never an input injector. Preparation uses ordinary
// control callbacks invoked through ProfilePilot; only the close file is a
// runner command. Key events record delivery, not physical/injected provenance.
static class DesktopKeyboardFixture {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetMessageExtraInfo();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly List<object> Events = new List<object>();
    sealed class MarkerCount { public string kind,marker;public int count; }
    static readonly List<MarkerCount> InputMarkers=new List<MarkerCount>();
    static bool MarkerOverflow;
    // This runs only for our two edit controls. Marker counts add no key codes,
    // text or global coordinates to the existing fixture's delivery receipts.
    sealed class MarkerTextBox : TextBox {
        protected override void WndProc(ref Message message){
            if(!Preparing && (message.Msg==0x100 || message.Msg==0x101 || message.Msg==0x104 || message.Msg==0x105)){
                bool up=message.Msg==0x101 || message.Msg==0x105;
                string kind=(message.WParam.ToInt64()==231?"unicode_":"key_")+(up?"up":"down");
                string marker=unchecked((ulong)GetMessageExtraInfo().ToInt64()).ToString("x16");
                var entry=InputMarkers.FirstOrDefault(value=>value.kind==kind && value.marker==marker);
                if(entry!=null)entry.count++;
                else if(InputMarkers.Count<128)InputMarkers.Add(new MarkerCount{kind=kind,marker=marker,count=1});
                else MarkerOverflow=true;
                Dirty=true;
            }
            base.WndProc(ref message);
        }
    }
    static Form Form;
    static TextBox Primary, Secondary;
    static string FileBase, Mode = "initial", FirstTransferText = "";
    static bool Preparing, Armed, Transferred, TransferFocusSucceeded, Dirty;
    static int Generation, Sequence;

    static int[] Units(string value) { return value.Select(c => (int)c).ToArray(); }
    static void Save(string file, object value) {
        // Sharing reads permits the runner to poll. It tolerates an incomplete
        // JSON read; the next timer write supplies a complete fresh receipt.
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value));
        using (var stream = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) stream.Write(bytes, 0, bytes.Length);
    }
    static object Box(TextBox box) {
        return new { text = box.Text, utf16 = Units(box.Text), selectionStart = box.SelectionStart, selectionLength = box.SelectionLength, focused = box.Focused };
    }
    static void Record(string kind, TextBox box, int code, int modifiers) {
        if (Preparing) return;
        IntPtr foreground = GetForegroundWindow();
        Events.Add(new { sequence = ++Sequence, kind, box = box == Primary ? "primary" : "secondary", code, modifiers,
            foregroundHwnd = foreground.ToInt64().ToString(), targetWasForeground = foreground == Form.Handle });
        Dirty = true;
    }
    static void Flush() {
        if (!Dirty) return;
        Save(FileBase + ".input.json", new { generation = Generation, mode = Mode, sequence = Sequence,
            primary = Box(Primary), secondary = Box(Secondary), armed = Armed, transferred = Transferred,
            transferFocusSucceeded = TransferFocusSucceeded, firstTransferText = FirstTransferText, events = Events.ToArray(),
            inputMarkers = new {source="GetMessageExtraInfo",pointerBits=IntPtr.Size*8,lowLevelHookEvidence=false,events=InputMarkers.ToArray(),overflow=MarkerOverflow} });
        Dirty = false;
    }
    static void Prepare(string mode) {
        Preparing = true; Armed = false;
        Primary.Text = mode == "navigation" ? "abcdef" : "";
        Secondary.Text = "";
        Primary.Focus(); Primary.Select(mode == "navigation" ? 3 : 0, 0);
        Mode = mode; Generation++; Sequence = 0; Events.Clear();InputMarkers.Clear();MarkerOverflow=false;
        Transferred = false; TransferFocusSucceeded = false; FirstTransferText = "";
        Preparing = false; Armed = mode == "transfer";
        Record("prepared", Primary, 0, 0); Flush();
    }
    static void Connect(TextBox box) {
        box.KeyDown += (s, e) => Record("keyDown", box, (int)e.KeyCode, (int)e.Modifiers);
        box.KeyUp += (s, e) => Record("keyUp", box, (int)e.KeyCode, (int)e.Modifiers);
        box.KeyPress += (s, e) => Record("keyPress", box, (int)e.KeyChar, 0);
        box.GotFocus += (s, e) => Record("gotFocus", box, 0, 0);
        box.LostFocus += (s, e) => Record("lostFocus", box, 0, 0);
        box.TextChanged += (s, e) => {
            if (Preparing) return;
            Record("textChanged", box, 0, 0);
            if (box == Primary && Armed && box.Text.Length > 0) {
                Armed = false; Transferred = true; FirstTransferText = box.Text;
                // Transfer immediately inside the first edit notification. No
                // timer, injected key, sleep, or external activation is involved.
                TransferFocusSucceeded = Secondary.Focus(); Secondary.Select(0, 0);
                Record("focusTransfer", box, 0, 0);
            }
        };
    }
    [STAThread] static void Main(string[] args) {
        if (args.Length != 1 && !(args.Length == 2 && args[1] == "--assisted-foreground")) throw new ArgumentException("Expected owned fixture receipt path [--assisted-foreground]");
        FileBase = args[0];
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        using (Form = new Form { Text = "ProfilePilot keyboard verification", ClientSize = new Size(680, 300),
            StartPosition = FormStartPosition.CenterScreen, AutoScaleMode = AutoScaleMode.None }) {
            var description = new Label { Left = 24, Top = 18, Width = 630, Height = 30,
                Text = "Owned keyboard acceptance fixture. Preparation buttons reset the event receipt." };
            Primary = new MarkerTextBox { Left = 24, Top = 60, Width = 630, AccessibleName = "Keyboard primary", MaxLength = 32767 };
            Secondary = new MarkerTextBox { Left = 24, Top = 108, Width = 630, AccessibleName = "Keyboard secondary", MaxLength = 32767 };
            Form.Controls.AddRange(new Control[] { description, Primary, Secondary });
            string[] modes = { "unicode", "navigation", "rejection", "transfer" };
            for (int index = 0; index < modes.Length; index++) {
                string mode = modes[index];
                var button = new Button { Left = 24 + (index % 2) * 325, Top = 165 + (index / 2) * 52,
                    Width = 305, Height = 38, Text = "Prepare " + mode, AccessibleName = "Prepare " + mode };
                button.Click += (s, e) => Prepare(mode);
                Form.Controls.Add(button);
            }
            Connect(Primary); Connect(Secondary);
            new AssistedForegroundFixture(Form,FileBase,args.Length==2);
            var timer = new Timer { Interval = 20 };
            timer.Tick += (s, e) => {
                if (System.IO.File.Exists(FileBase + ".close")) { timer.Stop(); Flush(); Form.Close(); return; }
                Flush();
            };
            Form.Shown += (s, e) => {
                using (var graphics = Form.CreateGraphics()) Save(FileBase + ".environment.json", new {
                    pid = Process.GetCurrentProcess().Id, hwnd = Form.Handle.ToInt64().ToString(), startedUtcTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),
                    administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),
                    dpi = graphics.DpiX, screenCount = Screen.AllScreens.Length,
                    windowBounds = new[] { Form.Bounds.X, Form.Bounds.Y, Form.Bounds.Width, Form.Bounds.Height }
                });
                Prepare("initial"); timer.Start();
            };
            Form.FormClosed += (s, e) => timer.Dispose();
            Application.Run(Form);
        }
    }
}
