import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || '')) throw new Error('This setup changes test accessibility settings and refuses physical phones. Supply a disposable emulator serial.');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const output = path.resolve(process.argv[3] || 'artifacts/phone-accessibility-regression');
const component = 'io.github.profilepilot.phone/io.github.profilepilot.phone.PhoneAccessibility';
await mkdir(output, { recursive: true });
async function run(args, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(adb, ['-s', serial, ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('Android test command timed out')); }, 180_000);
    const receive = part => { parts.push(part); onOutput?.(Buffer.concat(parts).toString('utf8')); };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const text = Buffer.concat(parts).toString('utf8');
      code === 0 ? resolve(text) : reject(new Error(text || `adb exited ${code}`));
    });
  });
}
const setting = async key => (await run(['shell', 'settings', 'get', 'secure', key])).trim();
async function restore(key, value) {
  await run(['shell', 'settings', ...(value === 'null' || !value ? ['delete', 'secure', key] : ['put', 'secure', key, value])]);
}
assert.equal((await run(['shell', 'getprop', 'sys.boot_completed'])).trim(), '1', 'Wait for emulator boot');
const sdkVersion = (await run(['shell', 'getprop', 'ro.build.version.sdk'])).trim();
const previousServices = await setting('enabled_accessibility_services');
const previousEnabled = await setting('accessibility_enabled');
let logs = '', rebound = false, rebindPromise;
const resultFile = path.join(output, `android-api${sdkVersion}-result.json`);
let result = { serial, sdkVersion, executed: 0, skipped: 0, success: false, status: 'running', startedAt: new Date().toISOString() };
await writeFile(resultFile, JSON.stringify(result, null, 2));
try {
  await run(['install', '-r', path.resolve('dist/android/profilepilot-phone.apk')]);
  await run(['install', '-r', path.resolve('android-phone/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
  logs = await run(['shell', 'am', 'instrument', '-w', '-r', '-e', 'accessibilityServiceTimeoutMs', '60000', '-e', 'class',
    'io.github.profilepilot.phone.AccessibilitySnapshotTest', 'io.github.profilepilot.phone.test/androidx.test.runner.AndroidJUnitRunner'], text => {
    logs = text;
    if (!rebound && text.includes('BENCHMARK_ACCESSIBILITY_WAITING')) {
      rebound = true;
      // am instrument force-stops the target process, leaving its service in the
      // framework's crashed set. Rebind only after instrumentation owns the new
      // process and has connected UiAutomation without suppressing services.
      rebindPromise = (async () => {
        const otherServices = previousServices === 'null' ? [] : previousServices.split(':').filter(x => x && !x.startsWith('io.github.profilepilot.phone/'));
        await restore('enabled_accessibility_services', otherServices.join(':'));
        await restore('enabled_accessibility_services', [...otherServices, component].join(':'));
        await restore('accessibility_enabled', '1');
      })();
      rebindPromise.catch(() => {}); // Await and report the failure below.
    }
  });
  await rebindPromise;
  // Some Android versions rebind the service automatically and need no marker.
  // The actual test assertions, not the setup workaround, determine success.
  if (/INSTRUMENTATION_STATUS_CODE:\s*-4\b|AssumptionViolatedException|FAILURES!!!|INSTRUMENTATION_FAILED/.test(logs) || !/OK \(9 tests\)/.test(logs)) {
    throw new Error(`Accessibility regression failed or skipped tests; inspect android-api${sdkVersion}-regression.log`);
  }
  result = { ...result, executed: 9, skipped: 0, success: true, status: 'passed', rebound };
  console.log(`Passed 9 accessibility regression tests on API ${sdkVersion}; none skipped.`);
} catch (error) {
  result = { ...result, status: 'failed', error: error.message, executed: (logs.match(/INSTRUMENTATION_STATUS_CODE:\s*(?:0|-1|-2)\b/g) || []).length, skipped: (logs.match(/INSTRUMENTATION_STATUS_CODE:\s*-4\b/g) || []).length };
  throw error;
} finally {
  if (rebindPromise) await rebindPromise.catch(() => {});
  await writeFile(path.join(output, `android-api${sdkVersion}-regression.log`), logs);
  try {
    await restore('enabled_accessibility_services', previousServices);
    await restore('accessibility_enabled', previousEnabled);
  } catch (error) {
    result = { ...result, success: false, status: 'cleanup-failed', error: error.message };
    throw error;
  } finally {
    await writeFile(resultFile, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2));
  }
}
