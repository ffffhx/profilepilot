const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('isolated sampler pure protocol and identity lifecycle reject mixed evidence and preserve cleanup', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-windows-sampler-pure-'));
  const executable = path.join(directory, 'SamplerPureTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  // Deliberately excludes windows.cs, program.cs and System.Management.dll.
  execFileSync(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/main:WindowsSamplerTests', `/out:${executable}`,
    '/r:System.Web.Extensions.dll', path.join(root, 'native/windows-sampler/model.cs'), path.join(root, 'native/windows-sampler/protocol.cs'),
    path.join(__dirname, 'helpers/windows-sampler-tests.cs')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const report = JSON.parse(execFileSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  assert.equal(report.ok, true); assert.equal(report.checks.length, 29); assert.equal(report.nativeCalls, 0);
  assert.equal(report.guiStarted, false); assert.equal(report.hooksInstalled, false); t.diagnostic(report.checks.join('; '));
});
