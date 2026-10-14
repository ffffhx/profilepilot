const assert = require('node:assert/strict');
const test = require('node:test');
const { realpathSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadTsModule } = require('./helpers/load-ts-module');

test('Windows snapshot recovers a real image path when CIM omits it, preserving commands and denied queries', { skip: process.platform !== 'win32' }, async () => {
  const execute = promisify(execFile);
  const { getWindowsSystemSnapshot } = loadTsModule('src/main/windows-platform.ts', { stubs: {
    'node:util': { promisify: () => async (executable, args, options) => {
      if (executable === 'netstat') return { stdout: '' };
      const shim = `function Get-CimInstance {
        [pscustomobject]@{ ProcessId=${process.pid}; ParentProcessId=1; Name='node.exe'; ExecutablePath=$null; CommandLine=$null }
        [pscustomobject]@{ ProcessId=2147483647; ParentProcessId=1; Name='blocked.exe'; ExecutablePath=$null; CommandLine=$null }
        [pscustomobject]@{ ProcessId=123; ParentProcessId=1; Name='app.exe'; ExecutablePath='C:\\应用\\app.exe'; CommandLine='original arguments' }
      }\n`;
      return execute(executable, [...args.slice(0, -1), shim + args.at(-1)], options);
    } }
  } });
  const snapshot = await getWindowsSystemSnapshot();
  assert.equal(snapshot.processesAvailable, true);
  const recovered = snapshot.processes.find(item => item.pid === process.pid);
  assert.equal(realpathSync.native(recovered.executablePath).toLowerCase(), realpathSync.native(process.execPath).toLowerCase());
  assert.equal(recovered.commandLine, recovered.executablePath, 'do not invent unavailable command-line arguments');
  const denied = snapshot.processes.find(item => item.pid === 2147483647);
  assert.equal(denied.executablePath, null);
  assert.equal(denied.commandLine, 'blocked.exe');
  const provided = snapshot.processes.find(item => item.pid === 123);
  assert.equal(provided.executablePath, 'C:\\应用\\app.exe');
  assert.equal(provided.commandLine, 'original arguments');
});
