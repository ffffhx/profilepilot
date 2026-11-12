// Disposable visual scenarios only: never starts applications or connects devices.
const {contextBridge}=require('electron');
const option=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const scenario=option('review-scenario')||'ready', platform=option('review-platform')||'win32';
const empty=scenario==='empty'||scenario==='empty-default'||scenario==='loading'||scenario==='error';
const result=value=>scenario==='loading'?new Promise(()=>{}):scenario==='error'?Promise.reject(new Error('连接暂时不可用，请重新检查连接。')):Promise.resolve(value);
const noEvents=()=>()=>{};
const names=['工作应用（审查样本）','资料整理（审查样本）','很长的中文与 English 项目名称 — 设计审查示例'];
const apps=empty?[]:names.map((name,index)=>({id:`sample-${index}`,name,mode:'launch',cwd:'/sample',command:'sample',environment:'',cdpPort:9333+index,agentPort:9444+index,inspectPort:null,managed:false,controls:{start:true,stop:false,restart:false},runtime:{status:'stopped'},debug:{renderer:false,main:false,targets:[]},agent:{connected:false}}));
contextBridge.exposeInMainWorld('localApps',{list:()=>result(apps),onChanged:noEvents,preview:async()=>({screenshot:null,title:'',capturedAt:'',error:''})});
const startup={supported:true,enabled:true,requiresApproval:false,error:null};
const browserState={platform,profiles:[],externalInstances:[],runningProfiles:[],currentProfile:null,defaultProfile:scenario==='empty-default'?{id:'missing',name:'已离线的默认浏览器（样本）'}:null};
contextBridge.exposeInMainWorld('profileManager',{
  getStartupSettings:()=>result(startup),setStartupEnabled:async enabled=>({...startup,enabled}),
  getInitialState:()=>result(browserState),getState:()=>new Promise(resolve=>setTimeout(()=>resolve(browserState),800)),
  setDefaultProfile:async id=>{if(id!==null)throw Error('Fixture only clears a saved default');browserState.defaultProfile=null;return browserState;},
  onStateChanged:noEvents,onOperationProgress:noEvents,onAgentTakeover:noEvents,onAgentOverlayReveal:noEvents
});
contextBridge.exposeInMainWorld('browserConnection',{snapshot:async()=>({nativeBrowsers:[],nativeInstallations:[]}),onChanged:noEvents});
window.addEventListener('DOMContentLoaded',()=>localStorage.setItem('profilepilot:onboarding:v1:seen','1'));
contextBridge.exposeInMainWorld('gpuiControl',{status:()=>result({backend:scenario==='empty'?'':'/sample/gpui',sessions:[]}),apps:()=>result({apps:[]}),onChanged:noEvents});
contextBridge.exposeInMainWorld('desktopControl',{
  status:()=>result({available:platform==='win32',supported:platform==='win32',platform,reason:platform==='darwin'?'当前仅支持 Windows':'',inputObservation:{available:true,phase:'idle'},session:null}),
  windows:()=>result({windows:empty?[]:names.map((title,index)=>({id:`sample-${index}`,title,process:'sample.exe',pid:index+1})),truncated:false,gaps:[]}),onStatus:noEvents,onChanged:noEvents
});
const devices=empty?[]:names.map((name,index)=>({id:`sample-${index}`,name:name.replace('应用','手机'),model:'Android 示例设备',transport:index===1?'emulator':'usb',connection:index===2?'unauthorized':'offline',companion:'unknown',state:null,confirmedAt:null,pending:null,error:''}));
const phoneSnapshot={devices,adbAvailable:true,error:'',computer:'审查样本',defaultDevice:{saved:scenario==='empty-default'?{id:'missing',name:'已离线的默认手机（样本）'}:null,available:false,deviceId:null}};
contextBridge.exposeInMainWorld('phones',{
  snapshot:()=>result(phoneSnapshot),onChanged:noEvents,
  setDefault:async id=>{if(id!==null)throw Error('Fixture only clears a saved default');phoneSnapshot.defaultDevice.saved=null;return phoneSnapshot;},
  discoverWireless:async()=>({services:[],apps:[],error:''}),discoverDevices:async()=>({apps:[],appError:''}),
  iphoneUsbStatus:async()=>[],iphoneDoctor:async()=>({platform,installed:true,version:'sample',devices:[],nextStep:'连接工具已就绪',error:''})
});
