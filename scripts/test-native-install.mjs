import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-install-tests-'));
try {
  await build({ entryPoints: ['src/main/tasks/native-installer.ts', 'src/main/tasks/native-onboarding.ts'], outdir: directory, bundle: true, platform: 'node', format: 'cjs' });
  const child = spawn(process.execPath, ['--test', 'tests/native-installer.test.js', 'tests/native-onboarding.test.js', 'tests/native-install-persistence.test.js'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, PROFILEPILOT_INSTALL_TEST_BUILD: directory }
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected temporary build path');
  await rm(directory, { recursive: true, force: true });
}
