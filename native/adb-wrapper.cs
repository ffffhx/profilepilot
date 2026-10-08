// A real Windows executable so CreateProcess/execFile/Python subprocess can
// launch adb without cmd.exe interpreting arguments or corrupting PNG output.
using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
public static class ProfilePilotAdb {
    static string Quote(string value) {
        var s = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            s.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; s.Append(c);
        }
        s.Append('\\', slashes * 2); return s.Append('"').ToString();
    }
    public static int Main(string[] args) {
        try {
            var runtime = Environment.GetEnvironmentVariable("PROFILEPILOT_PHONE_RUNTIME");
            var cli = Environment.GetEnvironmentVariable("PROFILEPILOT_PHONE_CLI");
            if (String.IsNullOrEmpty(runtime) || String.IsNullOrEmpty(cli)) {
                Console.Error.WriteLine("[ppilot phone CLI] Launch this tool with ppilot phone wrap --device ID -- PROGRAM ARGS."); return 1;
            }
            var arguments = new StringBuilder(Quote(cli) + " phone adb");
            foreach (var arg in args) arguments.Append(" ").Append(Quote(arg));
            var info = new ProcessStartInfo(runtime, arguments.ToString()) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (var child = Process.Start(info)) {
                // Explicit byte streams also work when our parent uses anonymous
                // pipes. StreamReader/TextWriter would corrupt screenshot bytes.
                var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream).ContinueWith(task => {
                    try { child.StandardInput.Close(); } catch { }
                });
                child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("[ppilot phone CLI] " + error.Message); return 1; }
    }
}
