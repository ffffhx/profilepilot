const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('missing child paths require explicit exit evidence before a sample can be retried', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-process-sampler-pure-'));
  const executable = path.join(directory, 'ProcessSamplerPure.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/main:MissingChildPathTests', `/out:${executable}`,
    '/r:System.Management.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(root, 'scripts/e2e/desktop-session-cycle-fixture.cs'), path.join(__dirname, 'helpers/desktop-process-sampler-tests.cs')],
  { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  assert.equal(result.ok, true); assert.equal(result.checks, 7); assert.equal(result.nativeCalls, 0); assert.equal(result.gui, false);
});
