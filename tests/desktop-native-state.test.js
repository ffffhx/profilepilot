const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native UIA state identity and password handling use one stable snapshot', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-state-test-'));
  const executable = path.join(directory, 'DesktopStateTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const { resolveWindowsWinrtReferences } = await import('../scripts/windows-winrt-contracts.mjs');
  const winrt = await resolveWindowsWinrtReferences(root, { framework });
  const { desktopSourceFiles } = await import('../scripts/desktop-source-files.mjs');
  const sources = desktopSourceFiles.map(file => path.join(root, 'native', 'desktop', file));
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopStateTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', '/r:System.Drawing.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(file => `/r:${path.join(framework, 'WPF', file)}`),
    ...winrt.references.map(file => `/r:${file}`),
    ...sources, path.join(__dirname, 'helpers', 'desktop-state-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 44);
  t.diagnostic(result.checks.join('; '));
});
