const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native input-state policy refuses held input, foreign capture and unknown samples', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-input-state-test-'));
  const executable = path.join(directory, 'DesktopInputStateTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  // Compile existing diagnostics dependencies, but execute only the pure policy
  // entry point. No HWND, desktop, token or GUI APIs are called by these tests.
  const { resolveWindowsWinrtReferences } = await import('../scripts/windows-winrt-contracts.mjs');
  const winrt = await resolveWindowsWinrtReferences(root, { framework });
  const { desktopSourceFiles } = await import('../scripts/desktop-source-files.mjs');
  const sources = desktopSourceFiles.map(file => path.join(root, 'native', 'desktop', file));
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopInputStateTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/r:${path.join(framework, 'WPF', file)}`),
    ...winrt.references.map(file => `/r:${file}`),
    ...sources, path.join(__dirname, 'helpers', 'desktop-input-state-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 29);
  t.diagnostic(result.checks.join('; '));
});
