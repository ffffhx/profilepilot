// Disposable renderer test: all device I/O is in memory. Never launches ADB.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { PhonesService } = require('../../../dist/main/phones/service');
const { executePhoneCommand } = require('../../../dist/main/phones/management');
const { startE2eDriver } = require('../../../dist/main/e2e-driver');
const fixture = process.env.PHONE_UI_FIXTURE;
if (!fixture || !process.env.PHONE_UI_SOCKET) throw new Error('Only run through scripts/e2e-phones.mjs');
app.setPath('userData', path.join(fixture, 'electron'));
const ids = ['UI-TEST-1', 'UI-TEST-2', 'emulator-5554'];
const wifiAlias = '192.168.1.9:40236';
let usbConnected = true, aliasConnected = false;
const root = path.join(fixture, 'phones'); fs.mkdirSync(root, { recursive: true });
const adbCalls = [];
fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ ...Object.fromEntries(ids.map(id => [id, { token: 'a'.repeat(64), hardwareId: id }])), [wifiAlias]: { token: 'a'.repeat(64), hardwareId: ids[0] } }));
const states = ids.map((id, index) => ({ protocol: 1, instanceId: `ui-instance-${index}`, sessionId: null, generation: 0, phase: 'idle', mode: 'view', computer: 'UI-TEST-PC', controller: '', task: '', startedAt: null, lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true }, readiness: { unlocked: true, computerConnected: true, usbConnected: true, wifiConnected: false, developerOptions: 'enabled', usbDebugging: 'enabled', wirelessDebugging: 'enabled', accessibilityService: 'running' } }));
if (process.env.PHONE_UI_NO_APP === '1') fs.writeFileSync(path.join(root, 'devices.json'), '{}');
fs.writeFileSync(path.join(root, 'phone.apk'), Buffer.from([0x50,0x4b,3,4]));
let window, driverClose;
let wirelessConnected = false;
let emulatorConnected = false;
let previewCalls = 0, previewBehavior = {};
let basicFrame = { width: 320, height: 640, shade: 128 }, basicFrameBehavior = {};
const unresponsive = new Set();
let appInstalled = process.env.PHONE_UI_NO_APP !== '1';
const service = new PhonesService({ root, apkPath: process.env.PHONE_UI_NO_APP === '1' ? path.join(root, 'phone.apk') : '', computer: 'UI-TEST-PC',
  probeWireless: async () => ({reachable:true,reason:'Fixture port available'}),
  emulators: { list: async () => ['Fixture_AVD'], launch: async () => { emulatorConnected = true; } },
  adb: { run: async (args, timeout, input) => {
    adbCalls.push(args);
    if (args[2] === 'install') { appInstalled = true; return 'Success'; }
    if (args[2] === 'shell' && args[3].startsWith("'pm' 'path'")) return appInstalled ? 'package:/fixture/profilepilot.apk' : '';
    if (args[0] === 'mdns') return 'fixture _adb-tls-pairing._tcp 192.168.1.8:37123\nfixture _adb-tls-connect._tcp 192.168.1.8:40235';
    if (args[0] === 'pair') return input === '123456\n' ? 'Successfully paired to 192.168.1.8:37123' : 'Failed to pair';
    if (args[0] === 'connect') {
      if (args[1] !== '192.168.1.8:40235') return 'failed to connect';
      wirelessConnected = true; return 'connected to 192.168.1.8:40235';
    }
    if (args[0] === 'devices') return ids.filter(id => (id !== ids[0] || usbConnected) && (id !== 'emulator-5554' || emulatorConnected)).map(id => `${id} device model:UI_Test_Phone_${ids.indexOf(id) + 1}`).join('\n') + (wirelessConnected ? '\n192.168.1.8:40235 device model:Wireless_Test_Phone' : '') + (aliasConnected ? `\n${wifiAlias} device model:UI_Test_Phone_1` : '');
    if (args[2] === 'emu') return 'Fixture_AVD\nOK';
    if (args[3] === "'getprop' 'ro.serialno'") return args[1] === wifiAlias ? ids[0] : args[1];
    return args.includes('tcp:0') ? String(args[1] === wifiAlias ? 19001 : 19001 + ids.indexOf(args[1])) : '';
  }, runBinary: async args => {
    adbCalls.push(args);
    const behavior = basicFrameBehavior; basicFrameBehavior = {};
    if (behavior.delay) await new Promise(resolve => setTimeout(resolve, behavior.delay));
    const png = nativeImage.createFromBitmap(Buffer.alloc(basicFrame.width * basicFrame.height * 4, basicFrame.shade), basicFrame).toPNG();
    return behavior.corrupt ? png.subarray(0, 33) : png;
  } },
  request: async (port, token, method, body) => {
    if (unresponsive.has(ids[port - 19001])) throw new Error('手机 App 超过 7 秒没有回复。请解锁手机并打开 ProfilePilot，再检查连接是否恢复。');
    const state = states[port - 19001]; let result = null;
    if (method === 'start') Object.assign(state, body, { phase: body.mode === 'view' ? 'viewing' : 'controlling', generation: state.generation + 1, startedAt: Date.now() });
    if (['pause', 'resume', 'stop'].includes(method)) { state.generation++; state.phase = method === 'pause' ? 'paused' : method === 'stop' ? 'stopped' : state.mode === 'view' ? 'viewing' : 'controlling'; }
    if (method === 'action' && body.action.kind === 'screenshot') result = { mime: 'image/jpeg', width: 320, height: 640, base64: nativeImage.createFromBitmap(Buffer.alloc(320 * 640 * 4, 128), { width: 320, height: 640 }).toJPEG(70).toString('base64') };
    return { ok: true, state: structuredClone(state), result };
  }, onChanged: value => { if (window && !window.isDestroyed()) window.webContents.send('phone-ui:changed', value); }
});
ipcMain.handle('phone-ui:request', async (_, method, params) => {
  if (method === 'fixture-adb-calls') return adbCalls;
  if (method === 'fixture-basic-frame') {
    const { delay, corrupt, ...frame } = params;
    basicFrame = { ...basicFrame, ...frame }; basicFrameBehavior = { delay, corrupt }; return;
  }
  if (method === 'fixture-apk-export') return;
  if (method === 'preview') {
    previewCalls++;
    const behavior = previewBehavior; previewBehavior = {};
    if (behavior.fail) throw new Error('Fixture screenshot unavailable');
    const response = await executePhoneCommand({ action: 'phone', method, params }, service);
    if (behavior.delay) await new Promise(resolve => setTimeout(resolve, behavior.delay));
    return response;
  }
  return method === 'cloud-pair' ? { id: '00000000-0000-0000-0000-000000000001', uri: 'profilepilot://status?fixture=1', qrCode: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 128), {width:16,height:16}).toDataURL(), expiresAt: Date.now()+180000 } : method === 'snapshot' ? service.snapshot() : executePhoneCommand({ action: 'phone', method, params }, service);
});
ipcMain.handle('phone-ui:preview-calls', () => previewCalls);
ipcMain.handle('phone-ui:preview-behavior', (_, value) => { previewBehavior = value; });
ipcMain.handle('phone-ui:unresponsive', (_, id, enabled) => { if (enabled) unresponsive.add(id); else unresponsive.delete(id); return service.refresh(); });
ipcMain.handle('phone-ui:fixture', async (_, id, changes) => { Object.assign(states[ids.indexOf(id)], changes); return service.refresh(); });
ipcMain.handle('phone-ui:connection', async (_, usb) => { aliasConnected = true; usbConnected = usb; return service.refresh(); });
ipcMain.handle('phone-ui:offline', async () => { aliasConnected = false; usbConnected = false; return service.refresh(); });
ipcMain.handle('phone-ui:cloud', (_, age, readiness = {}) => {
  const cloud = { id: 'cloud-ui-test', name: 'Cloud Test Phone', model: 'Cloud Test Phone', transport: 'cloud', connection: 'missing', companion: 'unavailable', state: null, confirmedAt: null, pending: null, error: '', cloud: { paired: true, reportedAt: Date.now() - age, report: { deviceId: 'diagnostic-fixture', name: 'Cloud Test Phone', permissions: { overlay: true, notifications: true, accessibility: true }, readiness: { unlocked: true, computerConnected: false, usbConnected: false, wifiConnected: false, developerOptions: 'unconfirmed', usbDebugging: 'unconfirmed', wirelessDebugging: 'unconfirmed', accessibilityService: 'running' } } } };
  Object.assign(cloud.cloud.report.readiness, readiness);
  const value = service.snapshot(); value.devices.push(cloud);
  window.webContents.send('phone-ui:changed', value);
});
app.whenReady().then(async () => {
  await service.refresh();
  window = new BrowserWindow({ width: 1440, height: 1080, show: false, webPreferences: { preload: path.join(__dirname, 'phone-ui-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_, detail) => { console.error(detail); app.exit(1); });
  await window.loadFile(path.join(__dirname, '../../../public/phones.html'));
  driverClose = startE2eDriver({ socketPath: process.env.PHONE_UI_SOCKET, mode: process.env.PHONE_UI_NO_APP === '1' ? 'desktop' : 'background', getWindow: () => window, getWindowSnapshot: () => ({ main: { visible: window.isVisible(), focused: window.isFocused() } }), triggerMiniHotkeyHandler: async () => {} });
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => driverClose?.());
