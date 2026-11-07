const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
test('TCP prototype pure ABI/parser/provider checks never call its real entry point', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const root = path.resolve(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tcp-pure-')), executable = path.join(home, 'Pure.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(home); });
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/main:WindowsTcpPrototypeTests', '/out:' + executable, '/r:System.Web.Extensions.dll',
      path.join(root, 'scripts/e2e/windows-tcp-prototype.cs'), path.join(__dirname, 'helpers/windows-tcp-prototype-tests.cs')], { windowsHide: true, timeout: 20000 });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 8000 }));
  assert.equal(result.ok, true); assert.equal(result.checks.length, 24); assert.equal(result.nativeCalls, 0);
  assert.equal(result.guiStarted, false); assert.equal(result.hooksInstalled, false); t.diagnostic(result.checks.join('; '));
});
