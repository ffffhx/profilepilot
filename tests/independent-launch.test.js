const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const launcherUrl = pathToFileURL(path.resolve(__dirname, "../scripts/start-independent.mjs")).href;

test("Windows independent launcher escapes arguments and starts outside the caller Job through WMI", async () => {
  const launcher = await import(launcherUrl);
  assert.equal(launcher.quoteWindowsArgument("plain"), "plain");
  assert.equal(launcher.quoteWindowsArgument("C:\\Program Files\\Electron\\"), '"C:\\Program Files\\Electron\\\\"');
  assert.equal(launcher.quoteWindowsArgument('say "hello"'), '"say \\"hello\\""');

  const bootstrap = launcher.buildWindowsBootstrap({
    executable: "C:\\Program Files\\Electron\\electron.exe",
    repoRoot: "C:\\Code\\Profile Pilot",
    resultPath: "C:\\Temp\\result.json",
    environment: {
      CPM_DATA_DIR: "C:\\Profile Data",
      PROFILEPILOT_LOG_ROOT: "C:\\Logs",
      PROFILEPILOT_SECRET: "must-not-leak",
      PATH: "ignored"
    }
  });
  assert.match(bootstrap, /Start-Process/);
  assert.match(bootstrap, /\$electronArguments/);
  assert.match(bootstrap, /-ArgumentList \$electronArguments/);
  assert.match(bootstrap, /\$env:CPM_DATA_DIR/);
  assert.match(bootstrap, /\$env:PROFILEPILOT_LOG_ROOT/);
  assert.doesNotMatch(bootstrap, /PROFILEPILOT_SECRET|must-not-leak/);

  const invocation = launcher.buildWindowsCimInvocation({
    bootstrapScript: bootstrap,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  });
  const encoded = invocation.args.at(-1);
  const cimScript = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(cimScript, /Invoke-CimMethod -ClassName Win32_Process/);
  assert.match(cimScript, /Win32_ProcessStartup/);
  assert.match(cimScript, /-Property @\{ ShowWindow = \[uint16\]0 \}/);
});

test("macOS and Linux independent launcher uses a detached session with closed stdio", async () => {
  const launcher = await import(launcherUrl);
  const invocation = launcher.buildPosixInvocation({
    executable: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    repoRoot: "/repo"
  });
  assert.deepEqual(invocation.args, ["/repo"]);
  assert.equal(invocation.options.cwd, "/repo");
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, "ignore");
});

test("background launch reaches Electron on Windows and macOS without displaying a launcher window", async () => {
  const launcher = await import(launcherUrl);
  const bootstrap = launcher.buildWindowsBootstrap({
    executable: "C:\\Electron\\electron.exe", repoRoot: "C:\\Code\\Profile Pilot",
    resultPath: "C:\\Temp\\result.json", environment: {}, background: true
  });
  const encodedArguments = bootstrap.match(/\$electronArguments = .*FromBase64String\('([^']+)'\)/)[1];
  assert.equal(Buffer.from(encodedArguments, "base64").toString("utf8"), '"C:\\Code\\Profile Pilot" --background');
  assert.match(bootstrap, /Start-Process .* -WindowStyle Hidden -PassThru/);
  const invocation = launcher.buildPosixInvocation({ executable: "/Electron", repoRoot: "/repo", background: true });
  assert.deepEqual(invocation.args, ["/repo", "--background"]);
  assert.equal(invocation.options.detached, true);
});
