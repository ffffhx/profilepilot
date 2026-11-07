const { contextBridge, ipcRenderer } = require('electron');
const nonce = process.argv.find(value => value.startsWith('--toolbar-fixture-nonce='))?.split('=')[1];
if (!/^[a-f0-9]{32}$/.test(nonce || '')) throw new Error('Missing isolated toolbar fixture identity');
const listeners = new Set();
ipcRenderer.on('toolbar-fixture:state', (_event, payload) => {
  if (payload.nonce !== nonce) return;
  for (const listener of listeners) listener(payload.state);
  ipcRenderer.send('toolbar-fixture:applied', nonce, payload.sequence);
});
// Only this test window receives this preload. No real desktop service, hook,
// process controller or management connection is available through the stub.
contextBridge.exposeInMainWorld('desktopControl', {
  status: () => ipcRenderer.invoke('toolbar-fixture:status', nonce),
  control: action => ipcRenderer.invoke('toolbar-fixture:control', nonce, action),
  onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); }
});
