const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('input delivery tracks inserted presses and preserves cleanup failures without input payloads', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-input-delivery-test-'));
  const executable = path.join(directory, 'DesktopInputDeliveryTests.exe');
  t.after(() => {
    if (fs.existsSync(executable)) fs.unlinkSync(executable);
    fs.rmdirSync(directory);
  });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  // Only the pure ledger and fake callback tests are compiled. No native driver,
  // P/Invoke, desktop reader, UIA, global hook, window or input code is linked.
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:DesktopInputDeliveryTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll',
    path.join(root, 'native', 'desktop', 'input-delivery.cs'), path.join(__dirname, 'helpers', 'desktop-input-delivery-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const report = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 18);
  t.diagnostic(report.checks.join('; '));
});
