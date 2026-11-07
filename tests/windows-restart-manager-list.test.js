const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');

// Run the actual embedded C# list reader with synthetic RmGetList replies.
// No Windows process/file occupancy APIs are invoked by these cases.
async function embeddedSource(strict) {
  let script;
  const execFile = () => assert.fail('Unexpected native command');
  execFile[promisify.custom] = async (_file, args) => { script = args.at(-1); return { stdout: '[]' }; };
  const file = path.resolve(__dirname, '../src/main/windows-platform.ts');
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  const requireStub = id => id === 'node:child_process' ? { execFile }
    : id === './windows-sampler' ? { sampleWindowsProcesses: () => assert.fail('Unexpected sampler'), sampleWindowsFileLocks: () => assert.fail('Unexpected sampler') }
    : id === './profile-process-change' || id === './windows-sampler-protocol' ? require('./cli-test-build.cjs').loadCli(`src/main/${id.slice(2)}.ts`) : require(id);
  vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: file })(
    requireStub, module, module.exports, { platform: 'win32', env: {} });
  await module.exports.findWindowsProcessesLockingPaths(['C:\\OwnedFixture\\file'], { strict });
  const match = script?.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, 'The production PowerShell script must contain its C# reader');
  return match[1];
}
for (const strict of [false, true]) test(`Restart Manager list changes remain bounded and fail closed (strict=${strict})`,
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-restart-list-pure-'));
    const source = path.join(directory, 'Production.cs'), executable = path.join(directory, 'ListTests.exe');
    t.after(() => { for (const file of [source, executable]) if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); });
    fs.writeFileSync(source, await embeddedSource(strict));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/platform:x64', '/target:exe', '/main:RestartManagerListTests', `/out:${executable}`,
      source, path.join(__dirname, 'helpers/windows-restart-manager-list-tests.cs')],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
    assert.equal(result.ok, true); assert.equal(result.checks, 17); assert.equal(result.nativeCalls, 0);
  });
