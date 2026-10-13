import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

// Dedicated disposable AVD only. Never changes a physical phone or a user's AVD.
const require = createRequire(import.meta.url);
const { loadCli } = require('../tests/cli-test-build.cjs');
const { Adb, deviceShell } = loadCli('src/main/phones/adb.ts');
const { ScreenCamera } = loadCli('src/main/phones/screen-camera.ts');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
const android16 = process.argv.includes('--android16');
const avdName = android16 ? 'profilepilot_screen_camera_test16' : 'profilepilot_screen_camera_test';
const port = android16 ? 5592 : 5590;
const serial = `emulator-${port}`;
const root = path.resolve('artifacts/screen-camera', android16 ? 'android16' : '.'); mkdirSync(root, { recursive: true });
const adb = new Adb();
const run = (args, timeout = 20000, input) => adb.run(['-s', serial, ...args], timeout, input);
const shell = (...args) => run(['shell', deviceShell(args)]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv.includes('--shutdown')) {
  assert.equal((await run(['emu', 'avd', 'name'])).split(/\r?\n/)[0].trim(), avdName);
  await run(['emu', 'kill']); console.log('Stopped isolated camera test emulator'); process.exit(0);
}
if (process.argv.includes('--prepare')) {
  const avdDir = path.join(root, 'avd'); mkdirSync(avdDir, { recursive: true });
  const image = process.env.PROFILEPILOT_CAMERA_TEST_IMAGE;
  assert.ok(image, 'Set PROFILEPILOT_CAMERA_TEST_IMAGE to an Android 16+ image directory');
  assert.ok(existsSync(path.join(image, 'system.img')), 'Set PROFILEPILOT_CAMERA_TEST_IMAGE to an Android 16+ image');
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  writeFileSync(path.join(avdDir, 'config.ini'), `avd.ini.encoding=UTF-8\nAvdId=${avdName}\nhw.cpu.arch=x86_64\nabi.type=x86_64\nhw.cpu.ncore=4\nhw.ramSize=2048\nhw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=280\nhw.keyboard=yes\nhw.gpu.enabled=yes\nhw.gpu.mode=auto\nhw.camera.back=emulated\nhw.camera.front=emulated\nhw.audioInput=no\nhw.battery=yes\nhw.gps=no\ndisk.dataPartition.size=4G\nimage.sysdir.1=${image}\nshowDeviceFrame=no\nPlayStore.enabled=true\ntag.id=google_apis_playstore\n`);
  const configFile = path.join(avdDir, 'config.ini');
  const tag = /^SystemImage.TagId=(.+)$/m.exec(readFileSync(path.join(image, 'source.properties'), 'utf8'))?.[1].trim() || 'google_apis';
  writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('hw.cpu.arch=x86_64', `hw.cpu.arch=${abi === 'arm64-v8a' ? 'arm64' : abi}`).replace('abi.type=x86_64', `abi.type=${abi}`).replace('PlayStore.enabled=true', `PlayStore.enabled=${tag === 'google_apis_playstore'}`).replace('tag.id=google_apis_playstore', `tag.id=${tag}`));
  const avdIndex = path.join(os.homedir(), '.android', 'avd'); mkdirSync(avdIndex, { recursive: true });
  writeFileSync(path.join(avdIndex, avdName + '.ini'), `avd.ini.encoding=UTF-8\npath=${avdDir}\n`);
  // ADB can retain an offline row after the emulator process has exited.
  const runningAvd = await run(['emu', 'avd', 'name'], 2000).then(value => value.split(/\r?\n/)[0].trim()).catch(() => null);
  if (runningAvd) assert.equal(runningAvd, avdName, 'Refuse another emulator on the test port');
  let launched;
  if (!runningAvd) {
    const emulator = path.join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
    const log = openSync(path.join(root, 'emulator-launch.log'), 'w');
    const child = launched = spawn(emulator, ['-avd', avdName, '-port', String(port), '-memory', '1536', '-cores', '2', '-gpu', process.env.PROFILEPILOT_CAMERA_TEST_GPU || 'auto',
      ...(process.env.PROFILEPILOT_CAMERA_TEST_GUEST_ANGLE === '1' ? ['-feature', 'GuestAngle'] : []),
      '-show-kernel', '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot'], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    closeSync(log);
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.unref(); console.log(`Started isolated camera test emulator (PID ${child.pid})`);
  }
  let booted = false;
  for (let i = 0; i < 150; i++) {
    if ((await shell('getprop', 'sys.boot_completed').catch(() => '')).trim() === '1') { booted = true; break; }
    if (launched?.exitCode != null) throw Error(`Emulator exited (${launched.exitCode}); see ${path.join(root, 'emulator-launch.log')}`);
    await wait(1000);
  }
  assert.ok(booted, 'Isolated test emulator did not boot');
  assert.equal((await run(['emu', 'avd', 'name'])).split(/\r?\n/)[0].trim(), avdName, 'Refuse another emulator on the test port');
  console.log('Isolated camera test emulator is ready');
  process.exit(0);
}
assert.equal((await run(['emu', 'avd', 'name'])).split(/\r?\n/)[0].trim(), avdName, 'Refuse another emulator');
assert.equal((await shell('getprop', 'sys.boot_completed')).trim(), '1');
if (process.argv.includes('--diagnostics')) {
  console.log(await shell('cmd', 'companiondevice', 'list', '0'));
  console.log((await shell('logcat', '-d', '-t', '500', '-s', 'CDM_AssociationRequestsProcessor:V', 'CDM_AssociationStore:V', 'CompanionDeviceManagerService:V', 'RoleControllerService:V')).slice(-15000));
  process.exit(0);
}
const probe = new ScreenCamera({ adb, root, dexPath: path.resolve('dist/android/profilepilot-screen-camera.dex'), authorize: async () => { throw Error('No test session yet'); } });
const capabilities = await probe.probe(serial); console.log(JSON.stringify(capabilities));
if (process.argv.includes('--probe')) process.exit(0);
assert.equal(capabilities.supported, true, capabilities.reason);

await run(['install', '-r', path.resolve('android-phone/app/build/outputs/apk/debug/app-debug.apk')], 120000);
const pkg = 'io.github.profilepilot.phone', token = randomBytes(32).toString('hex'), computer = 'ScreenCameraRegression';
await shell('am', 'force-stop', pkg);
await run(['shell', deviceShell(['run-as', pkg, 'sh', '-c', 'mkdir -p shared_prefs; cat > shared_prefs/MainActivity.xml'])], 8000,
  `<?xml version="1.0" encoding="utf-8"?><map><string name="token">${token}</string><string name="computer">${computer}</string></map>`);
await shell('appops', 'set', pkg, 'SYSTEM_ALERT_WINDOW', 'allow');
await shell('pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
await shell('pm', 'grant', pkg, 'android.permission.CAMERA');
await shell('settings', 'put', 'secure', 'enabled_accessibility_services', pkg + '/.PhoneAccessibility');
await shell('settings', 'put', 'secure', 'accessibility_enabled', '1');
await shell('input', 'keyevent', '224'); await shell('wm', 'dismiss-keyguard');
await shell('am', 'start', '-n', pkg + '/.MainActivity', '--es', 'token', token, '--es', 'computer', computer);
await shell('settings', 'put', 'secure', 'enabled_accessibility_services', '');
await shell('settings', 'put', 'secure', 'enabled_accessibility_services', pkg + '/.PhoneAccessibility');
const serviceRoot = path.join(root, 'service'); mkdirSync(serviceRoot, { recursive: true });
writeFileSync(path.join(serviceRoot, 'devices.json'), JSON.stringify({ [serial]: { token } }));
const phones = new PhonesService({ root: serviceRoot, apkPath: path.resolve('dist/android/profilepilot-phone.apk'), adb, computer });
phones.startPolling();
try {
  let device;
  for (let i = 0; i < 30; i++) {
    device = (await phones.refresh()).devices.find(d => d.id === serial);
    if (device?.companion === 'ready' && device.state?.readiness?.accessibilityService === 'running') break;
    await wait(500);
  }
  assert.equal(device?.companion, 'ready', JSON.stringify(device));
  const started = await phones.start(serial, 'control', 'ScreenCameraRegression', 'Verify computer QR through Android camera');
  const lease = { id: serial, sessionId: started.state.sessionId, generation: started.state.generation };
  const camera = await phones.cameraStart(lease); console.log(JSON.stringify(camera));
  assert.ok(camera.cameraId); assert.ok(camera.displayId > 0);
  const QRCode = require('qrcode');
  const payload = 'PROFILEPILOT_SCREEN_CAMERA_' + Date.now();
  const png = await QRCode.toBuffer(payload, { width: 700, margin: 4 });
  writeFileSync(path.join(root, 'qr.png'), png);
  await phones.cameraCommand({ ...lease, op: 'frame', base64: png.toString('base64') });
  if (process.argv.includes('--create-only')) {
    console.log('Virtual camera and virtual display created successfully');
  } else {
    await shell('run-as', pkg, 'rm', '-f', 'files/screen-camera-result.json');
    await phones.cameraCommand({ ...lease, op: 'launch', component: pkg + '/.ScreenCameraBenchmarkActivity' });
    let decoded;
    for (let i = 0; i < 60; i++) {
      try { decoded = JSON.parse(await shell('run-as', pkg, 'cat', 'files/screen-camera-result.json')); } catch { }
      if (decoded?.text === payload) break;
      await wait(500);
    }
    assert.equal(decoded?.text, payload, 'A real Android camera consumer must decode the computer frame');
    const state = await phones.cameraCommand({ ...lease, op: 'status' });
    assert.ok(state.framesRendered > 0, 'Camera must have rendered frames');
    const preview = await phones.cameraCommand({ ...lease, op: 'preview' });
    writeFileSync(path.join(root, 'android-camera-preview.jpg'), Buffer.from(preview.base64, 'base64'));
    await phones.control(serial, 'pause');
    await assert.rejects(phones.cameraCommand({ ...lease, op: 'frame', base64: png.toString('base64') }));
    writeFileSync(path.join(root, 'result.json'), JSON.stringify({ capabilities, camera: state, decoded, pauseRevoked: true }, null, 2));
    console.log('PASS: computer QR decoded via real Android virtual camera; pause revoked camera input');
  }
} finally { await phones.close(); }
