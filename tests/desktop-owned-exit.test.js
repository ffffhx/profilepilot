const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('owned identity exit wait is bounded, PID-reuse-safe and pure under fake processes', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-owned-exit-pure-')), executable = path.join(directory, 'OwnedExitPure.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..'), framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/platform:x64', '/target:exe', '/warnaserror+', '/main:DesktopOwnedExitTests', `/out:${executable}`,
    '/r:System.Management.dll', '/r:System.Web.Extensions.dll', path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs'),
    path.join(__dirname, 'helpers/desktop-owned-exit-tests.cs')], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  assert.equal(result.ok, true); assert.equal(result.pure, true); assert.equal(result.processesOpened, 0); assert.equal(result.checks.length, 8);
  t.diagnostic(result.checks.join('; '));
});
