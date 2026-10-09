const { contextBridge, ipcRenderer } = require('electron');
const call = (method, params) => ipcRenderer.invoke('phone-ui:request', method, params);
contextBridge.exposeInMainWorld('phoneBasicFixture', { calls: () => call('fixture-adb-calls'), frame: options => call('fixture-basic-frame', options) });
contextBridge.exposeInMainWorld('mobile', {
  openApkFolder: () => call('fixture-apk-export'),
  snapshot: async () => ({ enabled: false, listening: false, endpoints: [], devices: [], error: '' }),
  onChanged: () => () => {}
});
contextBridge.exposeInMainWorld('phones', {
  basicStart: (id, mode, controller, task) => call('basic-start', { id, mode, controller, task }),
  basicControl: (id, command) => call(`basic-${command}`, { id }),
  basicPerform: input => call('basic-action', input),
  cloudPair: () => call('cloud-pair'),
  snapshot: () => call('snapshot'), prepare: id => call('connect', { id }),
  inspect: id => call('inspect', { id }),
  listEmulators: () => call('emulator-list'), connectEmulator: name => call('emulator-connect', { name }),
  preview: id => call('preview', { id }), openSettings: (id, setting) => call('settings', { id, setting }),
  discoverWireless: id => call('wireless-discover', id ? {id} : {}),
  autoConnectWireless: id => call('wireless-connect', {id}),
  pairWireless: (address, code) => call('wireless-pair', { address, code }),
  connectWireless: address => call('wireless-connect', { address }),
  rename: (id, name) => call('rename', { id, name }),
  start: (id, mode, controller, task) => call('start', { id, mode, controller, task }),
  control: (id, method) => call(method, { id }), perform: input => call('action', input),
  onChanged: listener => { const handle = (_, value) => listener(value); ipcRenderer.on('phone-ui:changed', handle); return () => ipcRenderer.removeListener('phone-ui:changed', handle); }
});
contextBridge.exposeInMainWorld('phoneFixture', { setUnresponsive: (id, enabled) => ipcRenderer.invoke('phone-ui:unresponsive', id, enabled), previewCalls: () => ipcRenderer.invoke('phone-ui:preview-calls'), previewBehavior: value => ipcRenderer.invoke('phone-ui:preview-behavior', value), setCloud: (age, readiness) => ipcRenderer.invoke('phone-ui:cloud', age, readiness), setState: (id, changes) => ipcRenderer.invoke('phone-ui:fixture', id, changes), setConnection: usb => ipcRenderer.invoke('phone-ui:connection', usb), setOffline: () => ipcRenderer.invoke('phone-ui:offline') });
