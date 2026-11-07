const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('pure native pointer normalization preserves physical pixels and rejects unsupported geometry', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-pointer-test-'));
  const executable = path.join(directory, 'DesktopPointerTests.exe');
  t.after(() => {
    if (fs.existsSync(executable)) fs.unlinkSync(executable);
    fs.rmdirSync(directory);
  });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  // No production driver, WinRT metadata, UIA, P/Invoke, display reader or hook
  // code is linked. The only executable entry point performs arithmetic tests.
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/checked+', '/main:DesktopPointerTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll',
    path.join(root, 'native', 'desktop', 'pointer-coordinates.cs'), path.join(__dirname, 'helpers', 'desktop-pointer-tests.cs')
  ], { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 20000, encoding: 'utf8' });
  const report = JSON.parse(execFileSync(executable, [], { windowsHide: true, stdio: 'pipe', timeout: 5000, encoding: 'utf8' }));
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 12);
  assert.equal(report.roundTripPoints, 480192);
  assert.equal(report.flags, 0xc001);
  assert.equal(report.osInputTest, false);
  t.diagnostic(report.checks.join('; '));
});
