const {contextBridge,ipcRenderer} = require('electron');
const call = (method, ...args) => ipcRenderer.invoke('chat-fixture:request',method,...args);
const subscribe = (channel,listener) => {const handler = (_,value) => listener(value); ipcRenderer.on(channel,handler); return ()=>ipcRenderer.removeListener(channel,handler);};
contextBridge.exposeInMainWorld('tasks', {
  ...Object.fromEntries(['snapshot','listModels','watchPreview','ackPreview','control','openLink','reply'].map(method=>[method,(...args)=>call(method,...args)])),
  onChanged:listener=>subscribe('chat-fixture:changed',listener),onStream:listener=>subscribe('chat-fixture:stream',listener),onPreview:()=>()=>{}
});
contextBridge.exposeInMainWorld('profileManager', {getInitialState:async()=>({profiles:[],liveById:{},nativeBrowsers:[],config:{}}),onStateChanged:()=>()=>{}});
contextBridge.exposeInMainWorld('chatFixture', (action,value)=>call('fixture',action,value));
