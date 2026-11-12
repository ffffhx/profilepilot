// All APIs in this window are fixtures. No real applications/devices are used.
const { contextBridge } = require('electron');
const platform = process.argv.find(value => value.startsWith('--layout-platform='))?.split('=')[1] || 'win32';
let hold = '', pending;
const events = [];
function call(name, value) {
  events.push(name);
  if (name !== hold) return Promise.resolve(value);
  return new Promise((resolve, reject) => { pending = { name, resolve: result => resolve(result === undefined ? value : result), reject }; });
}
contextBridge.exposeInMainWorld('layoutFixture', {
  hold: name => { if (pending) throw Error('Unsettled fixture call'); hold = name; },
  pending: () => pending?.name || '',
  settle: (error, value) => { const request = pending; pending = undefined; hold = ''; if (!request) throw Error('No pending fixture call'); error ? request.reject(new Error(error)) : request.resolve(value); },
  events: () => events,
  attachApp: () => { app.mode = 'attach'; app.runtime.status = 'running'; app.controls.start = false; }
});
const noEvents = () => () => {};
const app = { id: 'fixture', name: '布局测试应用', mode: 'launch', cwd: '/fixture', command: 'fixture', environment: '', cdpPort: 9333, inspectPort: null, agentPort: 9444,
  managed: false, controls: { start: true, stop: false, restart: false }, runtime: { status: 'stopped' }, debug: { renderer: false, main: false, targets: [] }, agent: { connected: false } };
contextBridge.exposeInMainWorld('localApps', {
  list: options => options?.cached ? Promise.resolve([app]) : call('apps-list', [app]),
  start: () => call('apps-start'), showWindow: () => call('apps-show'),
  save: () => call('apps-save','fixture'), connect: () => call('apps-connect', { status: 'restart-required', confirmationToken: 'fixture' }),
  preview: () => Promise.resolve({ screenshot: null, title: '', capturedAt: '', error: '' }), onChanged: noEvents
});
const startup = { supported: true, enabled: true, requiresApproval: false, error: null };
contextBridge.exposeInMainWorld('profileManager', {
  getStartupSettings: () => call('settings-read', startup), setStartupEnabled: enabled => call('settings-save', { ...startup, enabled })
});
const desktopState = { available: platform === 'win32', supported: platform === 'win32', platform, reason: platform === 'darwin' ? '当前仅支持 Windows' : '', inputObservation: { available: true, phase: 'idle' }, session: null };
contextBridge.exposeInMainWorld('desktopControl', {
  status: () => call('desktop-status',desktopState), windows: () => call('desktop-windows',{ windows: [{ id:'fixture', title:'布局测试窗口', process:'fixture', pid:1 }], truncated:false, gaps:[] }),
  onStatus: noEvents, onChanged: noEvents,
  preview: () => call('desktop-preview',{ image: { mimeType:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8y0AAAAASUVORK5CYII=' } })
});
const gpuiState = { backend: '/fixture/gpui', sessions: [] };
contextBridge.exposeInMainWorld('gpuiControl', { status: () => call('gpui-status',gpuiState), apps: () => call('gpui-apps',{apps:[]}), onChanged:noEvents });
const setup = { supported:true, platformLabel: platform, sdkRoot:'/fixture/sdk', javaReady:true, toolsReady:true, adbReady:true, emulatorReady:true, ready:true, catalogLoaded:true, catalogError:'', images:[{id:'fixture',label:'测试镜像',abi:'x86_64',installed:true,bytes:0}],licenses:[],licenseToken:'fixture',job:null };
const iphoneTools = { platform, installed:true, version:'fixture', devices:[], nextStep:'连接工具已就绪', error:'' };
contextBridge.exposeInMainWorld('phones', {
  snapshot: () => call('phones-refresh',{ devices:[], adbAvailable:true, error:'', computer:'Fixture' }), onChanged:noEvents,
  discoverWireless: () => call('wireless-scan',{services:[],apps:[],error:''}), pairWireless: () => call('wireless-pair',{address:'192.0.2.1:12345'}),
  connectWireless: () => call('wireless-connect',{id:'fixture',name:'Fixture'}), autoConnectWireless: () => call('wireless-auto',{id:'fixture',name:'Fixture'}),
  androidSetupSnapshot: () => Promise.resolve(setup), androidSetupCatalog: () => call('emulator-catalog',setup),
  androidSetupStart: () => call('emulator-create',setup), listEmulators: () => call('emulator-list',['Fixture_AVD']), connectEmulator: () => call('emulator-connect',{id:'fixture',name:'Fixture'}),
  iphoneDoctor: () => call('iphone-tools',iphoneTools), iphoneSetup: () => call('iphone-setup',iphoneTools), iphoneUsbStatus: () => Promise.resolve([])
});
