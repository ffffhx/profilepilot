const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const windows = require('../dist/main/windows-platform');
const shell = require('../dist/main/shell-integration');
const onlyWindows = { skip: process.platform !== 'win32' };
const managed = [path.dirname(shell.agentBrowserLauncherPath()), path.dirname(shell.profilePilotCliLauncherPath())];

function restoreEnvironment(t) {
  const originalPath = process.env.PATH;
  const fakePath = process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
  delete process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (fakePath === undefined) delete process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH;
    else process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = fakePath;
  });
}

test('checking an up-to-date Windows PATH neither rewrites nor broadcasts it', onlyWindows, async t => {
  restoreEnvironment(t);
  const current = [...managed, '%USERPROFILE%\\Tools', 'C:\\中文 工具'].join(';');
  const calls = t.mock.method(windows, 'runWindowsPowerShell', async script => {
    assert.ok(script.includes("OpenSubKey('Environment')"), 'only a read is needed');
    return current;
  });
  assert.equal((await shell.setShellIntegrationEnabled(true)).installed, true);
  assert.ok(calls.mock.callCount() > 0);
  for (const entry of managed) assert.ok(process.env.PATH.split(';').includes(entry));
});

test('a broadcast timeout cannot fail a verified Windows PATH update', onlyWindows, async t => {
  restoreEnvironment(t);
  let current = '%USERPROFILE%\\Tools;C:\\中文 工具', writes = 0, broadcasts = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(windows, 'runWindowsPowerShell', async (script, options) => {
    if (script.includes("OpenSubKey('Environment')")) return current;
    if (script.includes("CreateSubKey('Environment')")) {
      writes++;
      current = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
      return '';
    }
    broadcasts++;
    assert.ok(options.timeout <= 3000);
    throw Object.assign(new Error('Command failed: internal environment command'), { killed: true });
  });
  const status = await shell.setShellIntegrationEnabled(true);
  assert.equal(status.installed, true);
  assert.match(status.warning, /PATH 已保存/);
  assert.match(status.warning, /WINDOWS_ENVIRONMENT_NOTIFY_FAILED/);
  assert.doesNotMatch(status.warning, /Command failed/);
  assert.equal(current, [...managed, '%USERPROFILE%\\Tools', 'C:\\中文 工具'].join(';'));
  assert.equal(writes, 1); assert.equal(broadcasts, 1);
  await shell.setShellIntegrationEnabled(true);
  assert.equal(writes, 1); assert.equal(broadcasts, 1);
  assert.equal((await shell.setShellIntegrationEnabled(false)).installed, false);
  assert.equal(current, '%USERPROFILE%\\Tools;C:\\中文 工具');
});

test('real Windows PATH failures stay failures with a concise error', onlyWindows, async t => {
  restoreEnvironment(t);
  const originalPath = process.env.PATH;
  let broadcasts = 0;
  t.mock.method(windows, 'runWindowsPowerShell', async script => {
    if (script.includes("OpenSubKey('Environment')")) return 'C:\\Keep';
    if (script.includes('SendMessageTimeout')) broadcasts++;
    throw Object.assign(new Error('Command failed: powershell.exe private PATH contents'), {
      code: 1, stderr: "Access to the registry key is denied.\nFullyQualifiedErrorId: UnauthorizedAccessException\nFromBase64String('U0VDUkVUX1BBVEg=')"
    });
  });
  await assert.rejects(shell.setShellIntegrationEnabled(true), error => {
    assert.equal(error.code, 'WINDOWS_USER_PATH_WRITE_FAILED');
    assert.match(error.message, /无法保存 Windows 用户 PATH/);
    assert.doesNotMatch(error.message, /powershell|private|Command failed/);
    assert.match(error.message, /UnauthorizedAccessException/);
    assert.match(error.message, /退出码：1/);
    assert.doesNotMatch(error.message, /U0VDUkVUX1BBVEg=/);
    assert.match(error.message, /PATH 已省略/);
    return true;
  });
  assert.equal(broadcasts, 0);
  assert.equal(process.env.PATH, originalPath);
});

test('a writer timeout after saving is reconciled with the persisted PATH', onlyWindows, async t => {
  restoreEnvironment(t);
  let current = 'C:\\Keep', broadcasts = 0;
  t.mock.method(windows, 'runWindowsPowerShell', async script => {
    if (script.includes("OpenSubKey('Environment')")) return current;
    if (script.includes("CreateSubKey('Environment')")) {
      current = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
      throw Object.assign(new Error('Command failed: write timed out'), { killed: true });
    }
    broadcasts++;
    return '';
  });
  const status = await shell.setShellIntegrationEnabled(true);
  assert.equal(status.installed, true);
  assert.equal(status.warning, null);
  assert.equal(broadcasts, 1);
  for (const entry of managed) assert.ok(process.env.PATH.split(';').includes(entry));
});

test('unreadable PATH after a failed write reports an unknown outcome', onlyWindows, async t => {
  restoreEnvironment(t);
  const originalPath = process.env.PATH;
  let writing = false;
  t.mock.method(windows, 'runWindowsPowerShell', async script => {
    if (!writing && script.includes("OpenSubKey('Environment')")) return 'C:\\Keep';
    writing = true;
    throw Object.assign(new Error('Command failed: private command'), { code: 1, stderr: 'Registry unavailable' });
  });
  await assert.rejects(shell.setShellIntegrationEnabled(true), error => {
    assert.equal(error.code, 'WINDOWS_USER_PATH_VERIFY_FAILED');
    assert.match(error.message, /无法确认/);
    assert.match(error.message, /Registry unavailable/);
    return true;
  });
  assert.equal(process.env.PATH, originalPath);
});

test('native Windows notification failure is surfaced without undoing installation', onlyWindows, async t => {
  restoreEnvironment(t);
  const run = windows.runWindowsPowerShell;
  let current = 'C:\\Keep';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(windows, 'runWindowsPowerShell', async (script, options) => {
    if (script.includes("OpenSubKey('Environment')")) return current;
    if (script.includes("CreateSubKey('Environment')")) {
      current = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
      return '';
    }
    // Compile the production P/Invoke in real PowerShell and target an invalid
    // window handle, without broadcasting to the user's other applications.
    return run(script.replace('[IntPtr]0xffff', '[IntPtr]0x123'), { ...options, timeout: 10000 });
  });
  const status = await shell.setShellIntegrationEnabled(true);
  assert.equal(status.installed, true);
  assert.match(status.warning, /Environment notification failed/);
});

test('Windows registry I/O preserves Unicode, quotes and expandable PATH entries', onlyWindows, async t => {
  restoreEnvironment(t);
  const run = windows.runWindowsPowerShell;
  // Exercise the actual PowerShell scripts against a disposable key, never HKCU\Environment.
  const registryKey = `Software\\ProfilePilot-Path-Test-${randomUUID()}`;
  const original = '%USERPROFILE%\\bin;C:\\中文 工具;C:\\O\'Brien\\$literal';
  const encoded = Buffer.from(original, 'utf8').toString('base64');
  try {
    await run(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${registryKey}'); $key.SetValue('Path',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')),[Microsoft.Win32.RegistryValueKind]::ExpandString); $key.Dispose()`);
    t.mock.method(windows, 'runWindowsPowerShell', (script, options) => script.includes('SendMessageTimeout')
      ? Promise.resolve('') : run(script.replaceAll("'Environment'", `'${registryKey}'`), options));
    assert.equal((await shell.setShellIntegrationEnabled(true)).installed, true);
    assert.equal((await shell.setShellIntegrationEnabled(false)).installed, false);
    const result = JSON.parse(await run(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${registryKey}'); @{value=$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=[string]$key.GetValueKind('Path')} | ConvertTo-Json -Compress; $key.Dispose()`));
    assert.equal(result.value, original);
    assert.equal(result.kind, 'ExpandString');
  } finally {
    await run(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('${registryKey}', $false)`);
  }
});
