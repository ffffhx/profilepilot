using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Test-only window. The single editable value is changed solely through the
// real App's UIA set_value action. No hooks, input injection or activation.
public static class DesktopLeaseFixture {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    sealed class QuietWindow : Form { protected override bool ShowWithoutActivation { get { return true; } } }
    static void Save(string file, object value) {
        string temporary = file + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    [STAThread] public static int Main(string[] args) {
        // Reuse the established identity-pinned, read-only sampler without
        // modifying the cycle fixture or starting its GUI entry point.
        if (args.Length > 0 && args[0] == "--sample") return DesktopSessionCycleFixture.Main(args);
        string fileBase = args.Length > 0 ? args[0] : null;
        try {
            if (args.Length != 2 || !Regex.IsMatch(args[1], "^[a-f0-9]{32}$")) throw new ArgumentException("FIXTURE_ARGUMENTS");
            string nonce = args[1];
            bool administrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
            if (administrator) throw new InvalidOperationException("MEDIUM_FIXTURE_REQUIRED");
            SetProcessDpiAwarenessContext(new IntPtr(-4)); Application.EnableVisualStyles();
            using (var process = Process.GetCurrentProcess()) using (var form = new QuietWindow()) using (var timer = new Timer()) {
                int pid = process.Id, changes = 0, sequence = 0, ticksSinceSave = 0;
                string startedUtcTicks = process.StartTime.ToUniversalTime().Ticks.ToString(), hwnd = null, closeReason = null;
                form.Text = "ProfilePilot lease expiry verification"; form.AccessibleName = form.Text;
                form.StartPosition = FormStartPosition.Manual; form.Size = new Size(500, 180);
                var area = Screen.PrimaryScreen.WorkingArea;
                form.Location = new Point(area.Left + Math.Max(0, (area.Width - form.Width) / 2), area.Top + Math.Max(0, (area.Height - form.Height) / 2));
                form.Controls.Add(new Label { Text = "Owned lease fixture " + nonce, AutoSize = true, Location = new Point(15, 20) });
                var value = new TextBox { Name = "LeaseValue", AccessibleName = "Lease value", Text = "initial", Location = new Point(15, 55), Width = 450 };
                form.Controls.Add(value);
                Action snapshot = delegate {
                    if (hwnd == null) return;
                    Save(fileBase + ".state.json", new { nonce, pid, hwnd, startedUtcTicks, sequence = ++sequence,
                        capturedAt = DateTime.UtcNow.ToString("o"), value = value.Text, changes });
                };
                value.TextChanged += delegate { changes++; snapshot(); };
                form.Shown += delegate {
                    hwnd = form.Handle.ToInt64().ToString(); snapshot();
                    Save(fileBase + ".ready.json", new { nonce, pid, hwnd, startedUtcTicks, administrator,
                        hooksInstalled = false, inputInjected = false, ttlMinutes = 30 });
                };
                form.FormClosed += delegate {
                    Save(fileBase + ".closed.json", new { nonce, pid, hwnd, startedUtcTicks, closeReason,
                        value = value.Text, changes, sequence });
                };
                timer.Interval = 200;
                timer.Tick += delegate {
                    try {
                        if (File.Exists(fileBase + ".close") && File.ReadAllText(fileBase + ".close").Trim() == nonce) closeReason = "nonce_close";
                        else if (!File.Exists(fileBase + ".heartbeat") || DateTime.UtcNow - File.GetLastWriteTimeUtc(fileBase + ".heartbeat") > TimeSpan.FromSeconds(30)) closeReason = "heartbeat_expired";
                        else if (DateTime.UtcNow - process.StartTime.ToUniversalTime() > TimeSpan.FromMinutes(30)) closeReason = "hard_ttl";
                        if (closeReason != null) { form.Close(); return; }
                        if (++ticksSinceSave >= 5) { ticksSinceSave = 0; snapshot(); }
                    } catch (Exception error) {
                        closeReason = "fixture_failure";
                        Save(fileBase + ".failure.json", new { nonce, pid, message = error.Message }); form.Close();
                    }
                };
                timer.Start(); Application.Run(form);
            }
            return 0;
        } catch (Exception error) {
            if (fileBase != null) Save(fileBase + ".failure.json", new { message = error.Message });
            return 1;
        }
    }
}
