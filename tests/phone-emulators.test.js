const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { findEmulator, AndroidEmulators } = loadCli('src/main/phones/emulators.ts');
const { executePhoneCommand } = loadCli('src/main/phones/management.ts');

function fixture(t, running = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-emulator-'));
  let launched = 0;
  const calls = [];
  const service = new PhonesService({ root, apkPath: '',
    emulators: { list: async () => ['Test_AVD'], launch: async () => { launched++; running = true; } },
    adb: { run: async args => {
      calls.push(args);
      if (args[0] === 'devices') return 'REAL-PHONE device model:Real_Phone\nemulator-5556 device model:Other_Emulator' + (running ? '\nemulator-5554 device model:Test_Emulator' : '');
      if (args[2] === 'emu') return args[1] === 'emulator-5554' ? 'Test_AVD\nOK' : 'Other_AVD\nOK';
      if (args[3] === "'getprop' 'ro.serialno'" && args[1] === 'REAL-PHONE') return 'REAL-PHONE';
      throw Error('Unexpected device operation: ' + args.join(' '));
    } }
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, calls, launched: () => launched };
}

test('emulator connection starts the selected AVD and never prepares or controls a phone', async t => {
  const h = fixture(t);
  const connected = await executePhoneCommand({ action: 'phone', method: 'emulator-connect', params: { name: 'Test_AVD' } }, h.service);
  assert.equal(connected.id, 'emulator-5554');
  assert.equal(connected.state, null);
  assert.equal(h.launched(), 1);
  assert.ok(h.calls.every(args => args[0] === 'devices' || args[2] === 'emu' || args[3] === "'pm' 'path' 'io.github.profilepilot.phone'" || args[1] === 'REAL-PHONE' && args[3] === "'getprop' 'ro.serialno'"));
});

test('an already running matching AVD is reused and different running devices are ignored', async t => {
  const h = fixture(t, true);
  assert.equal((await h.service.connectEmulator('Test_AVD')).id, 'emulator-5554');
  assert.equal(h.launched(), 0);
});

test('unknown AVDs and injected arguments fail before any launch or device request', async t => {
  const h = fixture(t);
  for (const name of ['Missing', 'Test_AVD;anything']) await assert.rejects(h.service.connectEmulator(name), /不存在/);
  await assert.rejects(executePhoneCommand({ action: 'phone', method: 'emulator-connect', params: { name: '../Test_AVD' } }, h.service));
  assert.equal(h.calls.length, 0);
  assert.equal(h.launched(), 0);
  const runtime = new AndroidEmulators('must-not-execute');
  runtime.list = async () => ['Test_AVD'];
  await assert.rejects(runtime.launch('Other_AVD'), /不存在/);
});

test('SDK emulator discovery supports Windows and macOS paths including spaces', t => {
  const windowsRoot = 'C:\\Users\\Tester\\Android SDK', macRoot = '/Users/tester/Android SDK';
  const windowsExe = path.win32.join(windowsRoot, 'emulator', 'emulator.exe');
  const macExe = path.posix.join(macRoot, 'emulator', 'emulator');
  t.mock.method(fs, 'existsSync', candidate => candidate === windowsExe || candidate === macExe);
  assert.equal(findEmulator({ ANDROID_HOME: windowsRoot }, 'win32'), windowsExe);
  assert.equal(findEmulator({ ANDROID_HOME: macRoot }, 'darwin'), macExe);
  assert.equal(findEmulator({ PROFILEPILOT_ADB_PATH: path.win32.join(windowsRoot, 'platform-tools', 'adb.exe') }, 'win32'), windowsExe);
  assert.equal(findEmulator({ PROFILEPILOT_EMULATOR_PATH: '/custom/emulator' }, 'darwin'), '/custom/emulator');
});
