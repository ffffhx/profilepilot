import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const repo = process.cwd();
const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || '')) throw new Error('Supply a disposable emulator serial. This test refuses physical phones.');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Android/Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Android/sdk') : path.join(os.homedir(), 'Android/Sdk'));
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const output = path.join(repo, 'artifacts/android-home-verification');
await mkdir(output, { recursive: true });
const run = args => new Promise((resolve, reject) => {
  const child = spawn(adb, ['-s', serial, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
  const timer = setTimeout(() => { child.kill(); reject(new Error('Android command timed out')); }, 180000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(logs) : reject(new Error(logs)); });
});

assert.equal((await run(['shell', 'getprop', 'sys.boot_completed'])).trim(), '1', 'Emulator must finish booting first');
assert.equal((await run(['shell', 'getprop', 'ro.kernel.qemu'])).trim(), '1', 'Refusing a non-emulator device');
// The instrumentation resets only this disposable emulator's companion pairing.
// No runtime permission grants, uninstalls or signature-check bypasses are used.
await run(['install', '-r', path.join(repo, 'dist/android/profilepilot-phone.apk')]);
await run(['install', '-r', path.join(repo, 'android-phone/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
const logs = await run(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
  'io.github.profilepilot.phone.MobileWorkflowTest', 'io.github.profilepilot.phone.debug.test/androidx.test.runner.AndroidJUnitRunner']);
await writeFile(path.join(output, 'android-instrumentation.log'), logs);
assert.match(logs, /OK \(8 tests\)/, logs);
for (const name of ['home', 'wifi', 'connected', 'disconnected', 'auto-connected']) {
  const result = await promisify(execFile)(adb, ['-s', serial, 'exec-out', 'run-as', 'io.github.profilepilot.phone.debug', 'cat',
    `files/mobile-verification/android-${name}.png`], { windowsHide: true, encoding: 'buffer', maxBuffer: 12 * 1024 * 1024 });
  assert.equal(result.stdout[0], 137, `Screenshot unavailable: ${name}`);
  await writeFile(path.join(output, `android-${name}.png`), result.stdout);
}
await run(['shell', 'am', 'start', '-n', 'io.github.profilepilot.phone.debug/io.github.profilepilot.phone.MainActivity']);
console.log('Passed native home, USB/Wi-Fi settings, connection evidence, automatic debugging pairing, public-entry isolation and session preservation.');
