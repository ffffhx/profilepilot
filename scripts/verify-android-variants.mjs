import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Explicitly authorized disposable AVD only; launch it through ppilot first.
const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || '')) throw Error('Supply the dedicated test emulator serial.');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const exec = promisify(execFile);
const run = async (...args) => (await exec(adb, ['-s', serial, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shell = (...args) => run('shell', args.map(quote).join(' '));
assert.equal((await run('emu', 'avd', 'name')).split(/\r?\n/)[0].trim(), 'profilepilot_mobile_test30');
assert.equal(await shell('getprop', 'ro.kernel.qemu'), '1');
const base = 'io.github.profilepilot.phone', debug = base + '.debug';
const releasePath = await shell('pm', 'path', base);
assert.match(releasePath, /^package:/, 'Keep the existing main-package test app installed for coexistence verification.');
const before = await shell('dumpsys', 'package', base);
const beforeUpdated = before.match(/lastUpdateTime=(.+)/)?.[1];
assert.ok(beforeUpdated);
const marker = 'development-data-survives-update';
await shell('run-as', debug, 'sh', '-c', `mkdir -p files && printf %s ${marker} > files/variant-retention.txt`);
assert.match(await run('install', '-r', path.resolve('dist/android/profilepilot-phone.apk')), /Success/);
assert.equal(await shell('run-as', debug, 'cat', 'files/variant-retention.txt'), marker);
assert.equal(await shell('pm', 'path', base), releasePath, 'Development install must not replace the main package');
assert.equal((await shell('dumpsys', 'package', base)).match(/lastUpdateTime=(.+)/)?.[1], beforeUpdated);
assert.match(await shell('pm', 'path', debug), /^package:/);
const output = path.resolve('artifacts/android-variant-verification'); await mkdir(output, { recursive: true });
const log = await run('shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
  `${base}.BuildVariantTest,${base}.AppUpdaterTest`, `${debug}.test/androidx.test.runner.AndroidJUnitRunner`);
await writeFile(path.join(output, 'instrumentation.log'), log);
assert.match(log, /OK \(8 tests\)/);
assert.doesNotMatch(log, /FAILURES!!!|INSTRUMENTATION_FAILED/);
await shell('am', 'start', '-W', '-n', `${debug}/${base}.MainActivity`);
await writeFile(path.join(output, 'result.json'), JSON.stringify({ serial, avd: 'profilepilot_mobile_test30',
  mainPackageUnchanged: true, debugInstalled: true, debugDataRetained: true,
  instrumentationPassed: 7, instrumentationSkipped: 1, skippedReason: 'Opt-in system installer test',
  verifiedAt: new Date().toISOString() }, null, 2));
console.log('Both packages coexist; development reinstall retains data; main package unchanged; 7 instrumentation tests passed (1 opt-in installer test skipped).');
