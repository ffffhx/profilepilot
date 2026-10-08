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
  assert.match(cimScript, /FindWindowSW/);
  assert.match(cimScript, /windows-explorer-bootstrap/);
});

test("Windows bootstrap runs a persistent ordinary-user process even from an elevated launcher", {
  skip: process.platform !== "win32" || process.env.PROFILEPILOT_TEST_WINDOWS_LAUNCH !== "1"
}, async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const net = require("node:net");
  const { setTimeout: delay } = require("node:timers/promises");
  const launcher = await import(launcherUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-launch-"));
  const bootstrapResult = path.join(root, "bootstrap.json");
  const childResult = path.join(root, "child.json");
  const fixtureRoot = path.join(root, "fixture space 中文");
  const pipe = `\\\\.\\pipe\\pp-launch-test-${process.pid}-${Date.now()}`;
  const powershellPath = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  fs.mkdirSync(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, "index.js"), `
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const check = spawnSync(${JSON.stringify(powershellPath)}, ['-NoProfile', '-NonInteractive', '-Command',
      '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { encoding: 'utf8', windowsHide: true });
    const timer = setTimeout(() => process.exit(1), 20000);
    const server = require('node:net').createServer(socket => {
      socket.end('ready');
      server.close(() => { clearTimeout(timer); process.exit(0); });
    });
    server.listen(${JSON.stringify(pipe)}, () => fs.writeFileSync(${JSON.stringify(childResult)},
      JSON.stringify({ pid: process.pid, admin: check.stdout.trim(), status: check.status, value: process.env.CPM_LAUNCH_TEST })));
  `);
  let pid;
  try {
    const bootstrapScript = launcher.buildWindowsBootstrap({ executable: process.execPath, repoRoot: fixtureRoot,
      resultPath: bootstrapResult, environment: { CPM_LAUNCH_TEST: "空格 ' $ literal" }, background: true });
    const invocation = launcher.buildWindowsCimInvocation({ bootstrapScript, powershellPath });
    const launch = spawnSync(invocation.executable, invocation.args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(launch.status, 0, String(launch.error || launch.stderr));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(childResult) && Date.now() < deadline) await delay(100);
    const result = JSON.parse(fs.readFileSync(bootstrapResult, "utf8"));
    assert.equal(result.ok, true, result.error);
    pid = result.pid;
    const child = JSON.parse(fs.readFileSync(childResult, "utf8"));
    assert.equal(child.pid, pid);
    assert.equal(child.status, 0);
    assert.equal(child.admin, "False");
    assert.equal(child.value, "空格 ' $ literal");
    // The launching shell has already exited; the child still owns its pipe.
    assert.doesNotThrow(() => process.kill(pid, 0));
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipe);
      let data = "";
      socket.setTimeout(3000, () => socket.destroy(new Error("fixture timed out")));
      socket.on("data", chunk => { data += chunk; });
      socket.once("end", () => resolve(data));
      socket.once("error", reject);
    });
    assert.equal(response, "ready");
  } finally {
    // Only this test's exact, newly created process and temporary directory.
    if (pid) { try { process.kill(pid); } catch {} }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
