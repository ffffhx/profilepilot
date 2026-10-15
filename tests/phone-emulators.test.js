const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { findEmulator, AndroidEmulators } = loadCli('src/main/phones/emulators.ts');
const { ensureEmulatorWindowVisible, ensureRunningEmulatorWindowVisible } = loadCli('src/main/phones/emulator-window.ts');
const { executePhoneCommand } = loadCli('src/main/phones/management.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function fixture(t, running = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-emulator-'));
  let launched = 0;
  const calls = [], fitted = [];
  const emulators = { list: async () => ['Test_AVD'], launch: async () => { launched++; running = true; },
    ensureVisible: async (...args) => { fitted.push(args); } };
  const service = new PhonesService({ root, apkPath: '',
    emulators,
    adb: { run: async args => {
      calls.push(args);
      if (args[0] === 'devices') return 'REAL-PHONE device model:Real_Phone\nemulator-5556 device model:Other_Emulator' + (running ? '\nemulator-5554 device model:Test_Emulator' : '');
      if (args[2] === 'emu') return args[1] === 'emulator-5554' ? 'Test_AVD\nOK' : 'Other_AVD\nOK';
      if (args[3] === "'getprop' 'ro.serialno'" && args[1] === 'REAL-PHONE') return 'REAL-PHONE';
      throw Error('Unexpected device operation: ' + args.join(' '));
    } }
  });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, calls, fitted, emulators, launched: () => launched };
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
  assert.deepEqual(h.fitted, [['Test_AVD', 'emulator-5554']]);
  assert.ok(h.calls.every(args => !args.includes('install') && !args.includes('am')));
});

test('window verification failure is visible and reopening can recover without restarting the emulator', async t => {
  const h = fixture(t, true);
  h.emulators.ensureVisible = async () => { throw Error('Window remains outside monitor'); };
  await assert.rejects(h.service.connectEmulator('Test_AVD'), /outside monitor/);
  h.emulators.ensureVisible = async (...args) => { h.fitted.push(args); };
  assert.equal((await h.service.connectEmulator('Test_AVD')).id, 'emulator-5554');
  assert.equal(h.launched(), 0);
  assert.deepEqual(h.fitted, [['Test_AVD', 'emulator-5554']]);
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

test('window placement is scoped to the newly spawned emulator and does not change its launch arguments', async t => {
  const { EventEmitter } = require('node:events');
  const child = Object.assign(new EventEmitter(), { pid: 12345, unref() {} });
  const spawned = [], fitted = [];
  t.mock.method(require('node:child_process'), 'spawn', (file, args, options) => {
    spawned.push({ file, args, options });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const emulator = new AndroidEmulators('C:\\Android SDK\\emulator.exe', async (...args) => { fitted.push(args); });
  emulator.list = async () => ['Test_AVD'];
  await emulator.launch('Test_AVD');
  assert.deepEqual(fitted, [[12345, 'Test_AVD']]);
  assert.deepEqual(spawned[0].args, ['-avd', 'Test_AVD']);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.windowsHide, true);
  // A failed spawn must not start a helper against a stale/missing PID.
  t.mock.method(require('node:child_process'), 'spawn', () => {
    queueMicrotask(() => child.emit('error', new Error('launch failed')));
    return child;
  });
  await assert.rejects(emulator.launch('Test_AVD'), /启动失败/);
  assert.equal(fitted.length, 1);
});

test('Windows window helper rejects malformed targets and is not invoked on macOS', async () => {
  for (const [pid, name] of [[0, 'Test'], [NaN, 'Test'], [123, "Test'; exit"]]) {
    await assert.rejects(ensureEmulatorWindowVisible(pid, name, 'win32'), /Invalid/);
  }
  await ensureEmulatorWindowVisible(12345, 'Test_AVD', 'darwin');
  for (const [name, id] of [['Test', 'REAL_PHONE'], ['Test', 'emulator-65536'], ['Test', 'emulator-1'], ["Test'; exit", 'emulator-5554']]) {
    await assert.rejects(ensureRunningEmulatorWindowVisible(name, id, 'win32'), /Invalid/);
  }
  await ensureRunningEmulatorWindowVisible('Test_AVD', 'emulator-5554', 'darwin');
});

test('runtime never swallows failed window correction or kills a launched emulator', async t => {
  const { EventEmitter } = require('node:events');
  let killed = false;
  const child = Object.assign(new EventEmitter(), { pid: 12345, unref() {}, kill() { killed = true; } });
  t.mock.method(require('node:child_process'), 'spawn', () => {
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  const runtime = new AndroidEmulators('emulator', async () => { throw Error('window timeout'); }, async () => { throw Error('window timeout'); });
  runtime.list = async () => ['Test_AVD'];
  await assert.rejects(runtime.launch('Test_AVD'), /窗口完整可见/);
  await assert.rejects(runtime.ensureVisible('Test_AVD', 'emulator-5554'), /移回屏幕/);
  assert.equal(killed, false);
});

test('CLI emulator entry uses the same verified service path and rejects unrelated device/control flags', async t => {
  const h = fixture(t, true), commands = [];
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const request = async command => {
    commands.push(command);
    return { version: 1, id: 'test', ok: true, data: await executePhoneCommand(command, h.service) };
  };
  assert.equal(await runPhoneCli(['emulator-list'], request, io), 0);
  assert.equal(await runPhoneCli(['emulator-connect', '--name', 'Test_AVD'], request, io), 0);
  assert.deepEqual(h.fitted, [['Test_AVD', 'emulator-5554']]);
  assert.equal(h.launched(), 0);
  for (const args of [
    ['emulator-connect'], ['emulator-connect', '--name', 'Test_AVD; anything'],
    ['emulator-connect', '--name', 'Test_AVD', '--device', 'REAL_PHONE'],
    ['emulator-connect', '--name', 'Test_AVD', '--backend', 'basic'],
    ['emulator-list', '--name', 'Test_AVD']
  ]) assert.equal(await runPhoneCli(args, request, io), 1);
  assert.equal(commands.length, 2);
});

test('Windows access denial explains elevation mismatch and preserves diagnostic cause', async () => {
  for (const message of ['Access is denied', '拒绝访问。']) {
    const cause = Error(message);
    const runtime = new AndroidEmulators('emulator', undefined, async () => { throw cause; });
    await assert.rejects(runtime.ensureVisible('Test_AVD', 'emulator-5554'), error => {
      assert.match(error.message, /管理员权限/);
      assert.equal(error.cause, cause); return true;
    });
  }
});
