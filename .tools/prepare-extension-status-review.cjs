const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadTsModule } = require('../tests/helpers/load-ts-module');
const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(__dirname, 'extension-status-review-'));
const profile = {id:'native:Default',name:'系统默认 Profile',source:'native'};
const online = {profileId:profile.id,connected:true,taskTabs:true,ownership:'user',extensionVersion:'0.2.17',capabilities:['tabs']};
const store = {state:{profiles:[profile]},nativeExtensionProfileId:profile.id,nativeExtensionBrowsers:[],nativeExtensionService:{status:'connected'},nativeExtensionInstallations:[{profileId:profile.id,stage:'connected',message:'连接成功，可以返回 ProfilePilot 开始任务。'}]};
const {renderBrowserExtensionPanel} = loadTsModule('src/renderer/render/browser-extension.ts',{stubs:{'src/renderer/state.ts':{store}}});
const variants = [['offline',{...online,connected:false},{status:'connected'}],['online',online,{status:'connected'}],['update',{...online,taskTabs:false,extensionVersion:'0.1.0'},{status:'connected'}],['service-unavailable',online,{status:'disconnected'}],['paused',{...online,pausedByBrowser:true},{status:'connected'}]];
const styles = ['app.css','workspace-switcher.css','window-chrome.css','design-system.css','browser-design.css','pc-control.css','tools-design.css'].map(name=>`<link rel="stylesheet" href="${pathToFileURL(path.join(project,'public',name)).href}">`).join('');
for(const [name,browser,service] of variants){
  store.nativeExtensionBrowsers=[browser];store.nativeExtensionService=service;
  fs.writeFileSync(path.join(directory,name+'.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>扩展状态验收（临时）</title>${styles}<body class="workspace-layout" data-workspace="tools"><div id="app"><div class="shell tools-workspace"><header class="app-header"><h1>配套工具</h1></header><main id="main-content"><div class="agent-integration-page">${renderBrowserExtensionPanel()}</div></main></div></div></body></html>`);
}
fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'profilepilot-extension-status-review',main:'main.cjs',version:'1.0.0'}));
fs.writeFileSync(path.join(directory,'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=__dirname,data=path.join(root,'data');app.setPath('userData',data);app.disableHardwareAcceleration();
fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({purpose:'extension status rendering acceptance',pid:process.pid,dataDir:data}));
app.whenReady().then(async()=>{const reports=[];let window;try{
  window=new BrowserWindow({show:false,width:1150,height:600,webPreferences:{backgroundThrottling:false}});
  for(const name of ['offline','online','update','service-unavailable','paused']){
    for(const [width,zoom] of name==='offline'?[[1150,1],[640,1],[1150,2]]:[[1150,1]]){
      window.setSize(width,600);window.webContents.setZoomFactor(zoom);await window.loadFile(path.join(root,name+'.html'));
      await window.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
      await new Promise(resolve=>setTimeout(resolve,150));
      const layout=await window.webContents.executeJavaScript("(()=>{const panel=document.querySelector('.browser-extension-panel'),label=panel.querySelector('.tools-inline-status'),controls=panel.querySelector('.browser-extension-controls'),box=panel.getBoundingClientRect();return {label:label.textContent,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,panelWidth:box.width,controlsOverflow:controls.getBoundingClientRect().right>box.right,body:panel.innerText}})()");
      const filename=name+'-'+width+'-'+zoom+'.pdf';
      reports.push({name,width,zoom,visible:window.isVisible(),focused:window.isFocused(),...layout,renderedPdf:filename});
      fs.writeFileSync(path.join(root,filename),await window.webContents.printToPDF({printBackground:true,pageSize:{width:width/96,height:600/96},margins:{top:0,bottom:0,left:0,right:0}}));
    }
  }
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:reports.every(r=>!r.overflow&&!r.controlsOverflow&&!r.visible&&!r.focused),reports},null,2));
}catch(error){fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:false,error:error.stack,reports}));}finally{app.quit();}});
`);
fs.writeFileSync(path.join(directory,'launch.mjs'), `
import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {buildWindowsBootstrap,buildWindowsCimInvocation} from ${JSON.stringify(pathToFileURL(path.join(project,'scripts/start-independent.mjs')).href)};
const require=createRequire(${JSON.stringify(pathToFileURL(path.join(project,'package.json')).href)}),directory=path.dirname(fileURLToPath(import.meta.url));
const bootstrap=buildWindowsBootstrap({executable:require('electron'),repoRoot:directory,resultPath:path.join(directory,'launch.json'),environment:process.env,background:true});
const invocation=buildWindowsCimInvocation({bootstrapScript:bootstrap,powershellPath:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')});
const result=spawnSync(invocation.executable,invocation.args,{encoding:'utf8',windowsHide:true});if(result.status)throw Error(result.stderr);console.log(result.stdout);
`);
fs.writeFileSync(path.join(__dirname,'extension-status-review-path.txt'),directory);
console.log(directory);
