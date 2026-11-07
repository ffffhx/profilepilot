const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('window state collector and eligibility are pure and fail closed', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-window-state-pure-'));
  const executable = path.join(directory, 'WindowStateTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', path.join(root, 'native/desktop/window-state.cs'), path.join(__dirname, 'helpers/desktop-window-state-tests.cs')],
  { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(result.ok, true); assert.equal(result.checks.length, 6); t.diagnostic(result.checks.join('; '));
});
