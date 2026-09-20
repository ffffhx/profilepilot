// Diagnostic fixture: a disposable ProfilePilot-managed Profile and Gateway.
// Never resumes, replaces or connects to the user's existing Profiles.
import { createRequire, Module } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
const require = createRequire(import.meta.url);
const baselineOverlay = process.argv.includes('--baseline-overlay');
if(baselineOverlay) {
  // Load the checked-in pre-fix overlay only in this disposable process.
  const ts=require('typescript');
  const source=execFileSync('git',['show','HEAD:src/main/agent-overlay.ts'],{encoding:'utf8',windowsHide:true});
  const filename=require.resolve('../dist/main/agent-overlay');
  const module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(path.dirname(filename));
  module._compile(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,filename);
  require.cache[filename]=module;
}
const { BrowserGatewayServer } = require('../dist/main/browser-gateway-server');
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const withOverlay = process.argv.includes('--overlay');
const cycleOverlay = process.argv.includes('--cycle-overlay');
const trace = [], trials = [];
const record = (kind, data) => trace.push({ at: Date.now(), kind, ...data });
const output = path.resolve('.cpm-data/gateway-diagnosis', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const register = BrowserGatewayServer.prototype.registerBackend;
BrowserGatewayServer.prototype.registerBackend = async function(input) {
  const send = input.backend.send.bind(input.backend);
  input.backend.send = text => {
    const m = JSON.parse(text);
    record('chrome-command', { id:m.id, method:m.method, sessionId:m.sessionId, targetId:m.params?.targetId, detached:m.params?.sessionId, autoAttach:m.params?.autoAttach });
    return send(text);
  };
  input.backend.onMessage(text => {
    const m = JSON.parse(text);
    if (m.method?.startsWith('Target.') || m.result?.sessionId || m.error) record('chrome-message', { id:m.id, method:m.method, parent:m.sessionId, sessionId:m.params?.sessionId||m.result?.sessionId, targetId:m.params?.targetInfo?.targetId||m.params?.targetId, targetType:m.params?.targetInfo?.type, error:m.error });
  });
  return register.call(this,input);
};
const handle = BrowserGatewayServer.prototype.handleClientMessage;
BrowserGatewayServer.prototype.handleClientMessage = async function(route, connection, text) {
  const m=JSON.parse(text), binding=route.targetByCdpSession.get(m.sessionId);
  record('agent-command', { id:m.id, method:m.method, sessionId:m.sessionId, detached:m.params?.sessionId, agent:connection.identity.sessionId, connection:connection.id, binding, detachedBinding:route.targetByCdpSession.get(m.params?.sessionId), reconnecting:connection.reconnecting });
  return handle.call(this,route,connection,text);
};
for(const method of ['bindCdpSession','unbindCdpSession']) {
  const original=BrowserGatewayServer.prototype[method];
  BrowserGatewayServer.prototype[method]=function(...args) {
    record(method, method==='bindCdpSession'?{cdp:args[2],target:args[3],agent:args[1].identity.sessionId,connection:args[1].id}:{cdp:args[1],binding:args[0].targetByCdpSession.get(args[1])});
    return original.apply(this,args);
  };
}
const site=createServer((_req,res)=>res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}).end('<!doctype html><title>Session diagnostic</title><main><h1>Local session diagnostic</h1><button>Read only fixture</button></main>'));
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${site.address().port}/`;
let fixture, browser, active, overlay;
try {
  fixture=await startTaskGatewayFixture();
  record('fixture',{profileId:fixture.id,port:fixture.port});
  console.log('FIXTURE',JSON.stringify({port:fixture.port,output}));
  browser=new WrapperBrowser(path.join(output,'artifacts'));
  const makeOverlay=()=>{
    const { AgentOverlayManager }=require('../dist/main/agent-overlay');
    const { requestCdpJson, requestCdpVersionInfo }=require('../dist/main/cdp-client');
    return new AgentOverlayManager({onStop:async()=>{},inputGuard:{sync(){},dispose(){}},requestTargets:port=>requestCdpJson(port,'/json/list',fixture.home),requestVersionInfo:port=>requestCdpVersionInfo(port,fixture.home)});
  };
  for(let i=0;i<12;i++) {
    active={id:randomUUID(),sessionId:`pp-diagnose-${randomUUID()}`,profileId:fixture.id,port:fixture.port};
    if(withOverlay&&!overlay)overlay=makeOverlay();
    if(overlay)overlay.sync({enabled:true,ports:[{port:fixture.port,profileId:fixture.id,profileName:'Diagnostic fixture',clients:[{pid:process.pid,label:'agent-browser',agent:'Codex',session:active.sessionId,lastActive:new Date().toISOString()}]}]});
    record('trial-start',{i,agent:active.sessionId});
    const result={i,sessionId:active.sessionId};
    try {
      await browser.execute(active,{kind:'open',value:url+'?trial='+i,effect:'read',summary:'Open local diagnostic page'});
      if(cycleOverlay&&overlay) {
        const deadline=Date.now()+2000;
        while(Date.now()<deadline&&![...overlay.ports.get(fixture.port)?.pages.values()||[]].some(p=>p.sessionId&&!p.connecting))await new Promise(resolve=>setTimeout(resolve,20));
        record('overlay-cleanup-start',{i});
        await overlay.dispose();overlay=undefined;
        record('overlay-cleanup-end',{i});
      }
      for(let j=0;j<3;j++) {
        const o=i%2?await browser.observe(active):await browser.observeFast(active);
        if(!o.snapshot.includes('Local session diagnostic'))throw new Error('Diagnostic content missing');
      }
      await browser.control(active,'complete');
      result.ok=true;active=undefined;
    } catch(error) {
      result.ok=false;result.error=String(error.message);
    }
    trials.push(result);console.log('TRIAL',JSON.stringify(result));
    if(!result.ok)break; // First failure stops; no retry/resume or alternate transport.
  }
} catch(error) {
  record('fixture-error',{error:String(error.message)});console.error('DIAGNOSTIC',error.message);process.exitCode=1;
} finally {
  await writeFile(path.join(output,'trace.json'),JSON.stringify({withOverlay,cycleOverlay,baselineOverlay,trials,trace},null,2));
  // End only this disposable diagnostic fixture; never act on the real Gateway.
  if(active&&browser)await browser.control(active,'release').catch(()=>{});
  await overlay?.dispose();
  await fixture?.close();
  await new Promise(resolve=>site.close(resolve));
  console.log('SAVED',path.join(output,'trace.json'));
}
