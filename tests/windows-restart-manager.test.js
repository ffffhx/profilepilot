const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { findWindowsProcessesLockingPaths } = loadCli('src/main/windows-platform.ts');

test('Windows Restart Manager compiles both strict modes and keeps multiple owned file paths separate', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-restart-manager-'));
  const files = Array.from({ length: 3 }, (_, index) => path.join(directory, `owned ${index}.txt`));
  try {
    await Promise.all(files.map(file => fs.writeFile(file, 'Owned diagnostic fixture.')));
    for (const strict of [false, true]) {
      const result = await findWindowsProcessesLockingPaths(files, { strict });
      assert.ok(result instanceof Map);
      for (const file of files) assert.deepEqual(result.get(file) || [], []);
    }
    const held = await fs.open(files[1], 'r');
    try {
      const result = await findWindowsProcessesLockingPaths(files, { strict: true });
      assert.ok(result.get(files[1])?.includes(process.pid), 'The held file must identify this test process');
      assert.deepEqual(result.get(files[0]) || [], []);
      assert.deepEqual(result.get(files[2]) || [], []);
    } finally { await held.close(); }
  } finally {
    await Promise.all(files.map(file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    await fs.rmdir(directory);
  }
});
