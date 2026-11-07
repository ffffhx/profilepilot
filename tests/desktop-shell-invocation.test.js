const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('shell invocation routing is narrow and respects swapped primary buttons', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shell-invocation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..'), output = path.join(directory, 'ShellInvocationTests.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  // Only pure routing code is linked; this test cannot read or control a desktop.
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${output}`,
    path.join(root, 'native/desktop/shell-invocation.cs'), path.join(__dirname, 'helpers/desktop-shell-invocation-tests.cs')],
    { windowsHide: true, stdio: 'pipe', timeout: 20000 });
  t.diagnostic(execFileSync(output, [], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim());
});
