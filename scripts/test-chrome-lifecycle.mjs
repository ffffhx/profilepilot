import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

export async function waitForTestChrome({
  child, spawnError, probe, timeoutMs, port,
  platform = process.platform, now = Date.now, sleep = delay
}) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    const error = spawnError();
    if (error) throw error;
    if (child.signalCode) throw new Error(`Chrome terminated before CDP became ready: ${child.signalCode}.`);
    // Windows Chrome can relaunch into a new browser process and let its initial
    // launcher exit successfully. Readiness belongs to CDP, not that launch PID.
    if (child.exitCode !== null && !(platform === 'win32' && child.exitCode === 0)) {
      throw new Error(`Chrome exited before CDP became ready, exit code ${child.exitCode}.`);
    }
    try {
      const version = await probe();
      if (!version?.webSocketDebuggerUrl) throw new Error('Chrome has not exposed its CDP websocket yet.');
      return version;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(100, Math.max(0, deadline - now())));
    }
  }
  const launcher = child.exitCode === 0 ? ' The launcher exited normally, but no ready browser was found.' : '';
  throw new Error(`Timed out waiting for Chrome CDP on 127.0.0.1:${port}.${launcher}${lastError instanceof Error ? ` Last error: ${lastError.message}` : ''}`);
}

export function windowsTestChromeCleanupScript(tempDir) {
  const base = path.resolve(os.tmpdir());
  const target = path.resolve(tempDir);
  const relative = path.relative(base, target);
  if (path.isAbsolute(relative) || relative.startsWith('..') || path.dirname(relative) !== '.' ||
      !/^pp-(?:e2e-overlay(?:-stress)?|overlay-doctor|bench-overlay)-[\w-]+$/.test(relative)) {
    throw new Error(`Refusing Chrome cleanup outside an overlay test's temporary profile: ${target}`);
  }
  const encodedPath = Buffer.from(target, 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$testProfilePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$escapedProfile = [regex]::Escape($testProfilePath)
$profileArgument = '(?i)(?:^|\\s)(?:"--user-data-dir=' + $escapedProfile + '"|--user-data-dir="' + $escapedProfile + '"|--user-data-dir=' + $escapedProfile + ')(?=\\s|$)'
$testProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -match $profileArgument })
foreach ($testProcess in $testProcesses) {
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $testProcess.ProcessId)
  if ($current -and $current.CreationDate -eq $testProcess.CreationDate -and $current.CommandLine -match $profileArgument) {
    Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`;
}

export async function cleanupRelaunchedTestChrome(tempDir) {
  if (process.platform !== 'win32') return;
  const script = windowsTestChromeCleanupScript(tempDir);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await promisify(execFile)(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { windowsHide: true, timeout: 15000 });
}
