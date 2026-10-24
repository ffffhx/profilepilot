import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {debugFixture,verifyBrowserDebug} from './browser-debug-checks.mjs';
const require=createRequire(import.meta.url);
const {NativeBrowserBridge,NATIVE_EXTENSION_ID}=require('../dist/main/tasks/native-bridge');
const {nativeExtensionReady}=require('../dist/main/tasks/native-compatibility');
const {requestNativeControl,nativeControlRoot}=require('../dist/main/native-control/cli');
const {BrowserGatewayDaemon}=require('../dist/main/browser-gateway-daemon');
const {requestBrowserGateway}=require('../dist/main/browser-gateway-client');
const {getDirectChromeCommand}=require('../dist/main/chrome-launch');
const root=await mkdtemp(path.join(os.tmpdir(),'pp-native-debug-'));
const fixtureHome=path.join(root,'home');await mkdir(fixtureHome);
const env={...process.env,HOME:fixtureHome,PROFILEPILOT_GATEWAY_HOME:fixtureHome,CPM_DATA_DIR:path.join(root,'data'),AGENT_BROWSER_SOCKET_DIR:path.join(fixtureHome,'.agent-browser'),ELECTRON_RUN_AS_NODE:'1'};
const server=http.createServer((req,res)=>{if(debugFixture(req,res))return;res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>ProfilePilot debug acceptance</title><h1>Browser debug fixture</h1>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl=`http://127.0.0.1:${server.address().port}`;
const bootstrap=`debug-bootstrap-${randomUUID()}`,sessionId=`debug-${randomUUID()}`;
let gateway,bridge,bootstrapDone=false,claimed=false;
const bootstrapCli=async args=>{
  const {stdout}=await promisify(execFile)(process.execPath,[path.resolve('dist/main/profilepilot-cli.cjs'),'browser','--session',bootstrap,'--cdp',String(gateway.port),'--json',...args],{env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  const result=JSON.parse(stdout);if(result.success===false||result.ok===false)throw Error(JSON.stringify(result));return result.data??result;
};
const connected=process.argv.includes('--connected');
const command=async(method,params={})=>{
  if(!connected)return requestNativeControl({requestId:randomUUID(),sessionId,method,params},root);
  const args=method==='cdp'?['cdp',params.method,'--params',JSON.stringify(params.params||{})]:[method,'--params',JSON.stringify(params)];
  const {stdout}=await promisify(execFile)(process.execPath,[path.resolve('dist/main/profilepilot-cli.cjs'),'browser','--session',sessionId,...args],{windowsHide:true,timeout:40000,maxBuffer:8*1024*1024});
  const result=JSON.parse(stdout);assert.equal(result.ok,true);return result.result;
};
try{
  let tabId;
  if(connected){
    let status;
    for(let attempt=0;attempt<90;attempt++){
      status=await requestNativeControl({requestId:randomUUID(),method:'status'},nativeControlRoot());
      if(status.profiles.some(p=>p.connected&&nativeExtensionReady(p)))break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.equal(status.sessions.length,0,'Do not interrupt existing browser sessions');
    assert.equal(status.profiles.filter(p=>p.connected&&nativeExtensionReady(p)).length,1,'Select an unambiguous compatible connected Profile');
  }else{
  const daemon=new BrowserGatewayDaemon(fixtureHome);await daemon.start();
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  gateway={port,close:async()=>{await requestBrowserGateway({action:'unregister-profile',publicPort:port,closeChrome:true},{homeDir:fixtureHome}).catch(()=>{});await daemon.stop();}};
  await requestBrowserGateway({action:'launch-profile',profileId:'debug-fixture',profileName:'Debug acceptance fixture',publicPort:port,executable:getDirectChromeCommand(),args:[`--user-data-dir=${path.join(root,'chrome')}`,'--headless=new','--site-per-process','--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check',...(process.platform==='win32'?['--disable-features=AutoDeElevate']:[]),'about:blank']},{homeDir:fixtureHome,timeoutMs:15000});
  bridge=new NativeBrowserBridge(root,{read:()=>({}),write:()=>{}});
  await bootstrapCli(['open',baseUrl]);await bootstrapCli(['extension','load-unpacked',path.resolve('extensions/profilepilot')]);
  await bootstrapCli(['tab','new',`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair=await bridge.pair('native:debug-fixture');
  const response=await bootstrapCli(['eval',`(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(baseUrl)}));const reply=await chrome.runtime.sendMessage({method:'connect',code:${JSON.stringify(pair.code)}});return{reply,tabId:tab.id};})()`]);
  const value=response.result??response;if(value.reply?.error)throw Error(value.reply.error);
  for(let i=0;!bridge.states().some(nativeExtensionReady);i++){if(i>100)throw Error('Extension connection timeout');await new Promise(r=>setTimeout(r,100));}
  await bootstrapCli(['complete']);bootstrapDone=true;
  tabId=value.tabId;
  }
  await command('claim',connected?{newTab:true,task:'验证 Network 调试功能',controller:'Codex'}:{tabId});claimed=true;
  if(connected)await command('open',{url:baseUrl});
  await verifyBrowserDebug({command,baseUrl,navigate:url=>command('open',{url}),
    evaluate:async expression=>{const result=await command('cdp',{method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;},
    outputDir:path.resolve('artifacts',`browser-debug-${Date.now()}`,'extension')});
  await command('network',{action:'har',operation:'start'});await command('handoff');
  await assert.rejects(command('network'));
  await command('complete');claimed=false;console.log('PASS debug: actual extension takeover blocks queries; session completed');
}finally{
  if(claimed)await command('release').catch(()=>{});bridge?.close();
  if(gateway&&!bootstrapDone)await bootstrapCli(['release']).catch(()=>{});
  await gateway?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(path.dirname(root)===path.resolve(os.tmpdir()))await rm(root,{recursive:true,force:true}).catch(()=>{});
}
