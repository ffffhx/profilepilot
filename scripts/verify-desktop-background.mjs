import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess, terminateOwnedWindowsProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';

// Compile-only by default. --run exercises real UIA and the production input
// observer on an owned window. No physical input or foreground activation.
const args=process.argv.slice(2);
assert.ok(args.length<=1 && args.every(x=>['--check','--run'].includes(x)));
assert.equal(process.platform,'win32','Native background verification requires Windows.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(path.join(os.tmpdir(),'pp-background-'));
const executable=path.join(directory,'BackgroundFixture.exe'),base=path.join(directory,'fixture');
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo','/codepage:65001','/target:winexe','/platform:x64',`/out:${executable}`,
    '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',path.join(root,'scripts/e2e/desktop-background-fixture.cs')],
  {windowsHide:true,timeout:30000});
if(!args.includes('--run')){console.log(JSON.stringify({ok:true,mode:'compile-only',executable,guiStarted:false,inputSent:false}));process.exit(0);}
await assertDesktopAcceptanceWindow();
const require=createRequire(import.meta.url);
const {DesktopService}=require('../dist/main/desktop/service.js');
const {DesktopWorker}=require('../dist/main/desktop/worker.js');
const {WindowsInputRuntime}=require('../dist/main/desktop/input-runtime.js');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(read,accept){const end=Date.now()+8000;while(Date.now()<end){try{const value=await read();if(accept(value))return value;}catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;}await delay(60);}throw new Error('Fixture evidence timeout');}
const nonce=randomUUID(),session='background-'+randomUUID();
const report={ok:false,mode:'native-service-background',physicalInputSent:false,foregroundActivated:false,
  scope:'Production DesktopService, DesktopWorker and WindowsInputRuntime; fixture replaces the App notice and admission UI. App UI is checked separately.',
  limitations:['No physical keyboard hardware tested. Target activation and unrelated-input decisions also have deterministic protocol tests.'],checks:[]};
let fixture,service,runtime,native;
const state=async()=>{const result=JSON.parse(await readFile(base+'.state.json','utf8'));assert.equal(result.nonce,nonce);assert.equal(result.pid,fixture.pid);return result;};
const command=(method,extra={})=>service.execute({action:'desktop',method,session,...extra});
try {
  fixture=await launchWindowsUserProcess(executable,[base,nonce],root);
  await poll(state,x=>x.hwnd);
  runtime=new WindowsInputRuntime();
  service=new DesktopService({inputObserver:runtime.observeDesktop,prepareControlNotice:async()=>{},
    admission:async target=>{assert.equal(target.pid,fixture.pid);return {status:'available',matches:[],gaps:[]};}});
  const windows=await command('windows'),target=windows.windows.find(x=>x.pid===fixture.pid);
  assert.ok(target,'Owned target must be catalogued');
  const before=await state();assert.notEqual(before.foreground,before.hwnd,'Fixture must stay in background');
  const claimed=await command('claim',{windowId:target.id,mode:'background'});
  assert.equal(claimed.inputObservation.phase,'ready');assert.equal(claimed.session.mode,'background');
  report.checks.push('Production scoped observer acknowledged the exact background target');
  let snapshot=await command('observe');
  for(const [name,kind,value] of [['Background owned edit','set_value','Background semantic value'],['Background owned button','invoke',undefined]]) {
    const element=snapshot.elements.find(x=>x.name===name && x.actions.includes(kind));assert.ok(element,`Missing ${kind} provider`);
    assert.ok(snapshot.elements.every(x=>x.actions.every(a=>!['focus','click','type_text','press_key','minimize','maximize','restore'].includes(a))));
    const result=await command('action',{requestId:randomUUID(),params:{version:snapshot.version,ref:element.reference,kind,...(value===undefined?{}:{value})}});
    assert.equal(result.executed,true);
    assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'available');
    assert.notEqual(result.observation.version,snapshot.version);
    snapshot=result.observation;
  }
  const after=await poll(state,x=>x.text==='Background semantic value' && x.clicks===1);
  assert.equal(after.foreground,before.foreground);assert.deepEqual(after.cursor,before.cursor);
  assert.equal(service.status().session.state,'active');
  report.checks.push('Real UIA SetValue and Invoke changed only the owned target; foreground and pointer stayed unchanged');
  snapshot=await command('observe');
  await assert.rejects(command('action',{requestId:randomUUID(),params:{version:snapshot.version,kind:'press_key',keys:['ENTER']}}),{code:'DESKTOP_BACKGROUND_ACTION_DENIED'});
  report.checks.push('Service rejected physical input without dispatch');
  native=new DesktopWorker();await native.request('windows',{});await native.request('control.background',{windowId:target.id});
  await assert.rejects(native.request('window.action',{kind:'press_key',keys:['ENTER'],version:snapshot.version}),{code:'DESKTOP_BACKGROUND_ACTION_DENIED'});
  report.checks.push('Native driver independently rejected physical input');
  service.control('takeover');assert.equal(service.status().session.state,'paused');
  await assert.rejects(command('observe'),{code:'DESKTOP_USER_IN_CONTROL'});
  report.checks.push('Explicit user takeover paused and barred further work');
  report.ok=true;report.before=before;report.after=after;
} catch(error){report.error={message:error.message,code:error.code,stack:error.stack};process.exitCode=1;}
finally {
  await native?.close();await service?.close();await runtime?.dispose();
  if(fixture){await writeFile(base+'.close',nonce);try{await poll(async()=>JSON.parse(await readFile(base+'.closed.json','utf8')),x=>x.nonce===nonce);}catch{terminateOwnedWindowsProcess(fixture.pid,executable);}}
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,reportPath:path.join(directory,'report.json')},null,2));
}
