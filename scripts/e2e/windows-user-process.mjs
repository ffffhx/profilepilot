import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWindowsCimInvocation, quoteWindowsArgument } from '../start-independent.mjs';

const ps = value => `'${String(value).replaceAll("'", "''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Launch an owned verification fixture at the desktop user's ordinary token,
// even when the test runner was started by an elevated terminal. The Explorer
// bootstrap is the same one used by ProfilePilot's independent App launcher.
export async function launchWindowsUserProcess(executable, args, cwd) {
  if (process.platform !== 'win32') throw new Error('Windows desktop-user launcher requires Windows.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-desktop-user-launch-'));
  const resultFile = path.join(directory, 'result.json');
  try {
    const bootstrapScript = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '  $principal = [Security.Principal.WindowsPrincipal]::new($identity)',
      "  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Fixture must run without administrator privileges.' }",
      '  $info = [Diagnostics.ProcessStartInfo]::new()',
      `  $info.FileName = ${ps(path.resolve(executable))}`,
      `  $info.Arguments = ${ps(args.map(quoteWindowsArgument).join(' '))}`,
      `  $info.WorkingDirectory = ${ps(path.resolve(cwd))}`,
      '  $info.UseShellExecute = $false',
      '  $info.CreateNoWindow = $true',
      '  $started = [Diagnostics.Process]::Start($info)',
      '  $result = @{ok=$true;pid=$started.Id;administrator=$false} | ConvertTo-Json -Compress',
      '} catch { $result = @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }',
      `[IO.File]::WriteAllText(${ps(resultFile)}, $result, [Text.UTF8Encoding]::new($false))`
    ].join('\n');
    const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath: powershell() });
    const launched = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (launched.error) throw launched.error;
    if (launched.status !== 0) throw new Error(String(launched.stderr || launched.stdout));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await readFile(resultFile, 'utf8'));
        if (!result.ok || !Number.isSafeInteger(result.pid)) throw new Error(result.error || 'Fixture launch did not return a PID.');
        return result;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await sleep(100);
    }
    throw new Error('Desktop-user fixture launcher did not respond.');
  } finally { await rm(resultFile, { force: true }); await rmdir(directory); }
}

// A fallback for a hung test fixture only. Recheck its executable before using
// a PID, since a detached child is not represented by a Node ChildProcess.
export function terminateOwnedWindowsProcess(pid, executable) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process PID.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    'if ($null -eq $owned) { exit 0 }',
    `if ($owned.ExecutablePath -ne ${ps(path.resolve(executable))}) { throw 'Refusing to terminate a process with a different executable.' }`,
    `$stopped = Stop-Process -Id ${pid} -PassThru`,
    "if (-not $stopped.WaitForExit(5000)) { throw 'Owned process termination was not confirmed.' }"
  ].join('\n');
  const result = spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}
