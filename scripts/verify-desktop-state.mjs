import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { runDesktopCliProcess } from './e2e/desktop-cli.mjs';

if(process.platform!=='win32')throw new Error('Desktop state verification requires Windows.');
const textProbe=process.argv.length===4 && process.argv[2]==='--run' && process.argv[3]==='--text-probe';
const capabilityProbe=process.argv.length===4 && process.argv[2]==='--run' && process.argv[3]==='--capability-probe';
assert.ok(process.argv.length===2 || process.argv.length===3 && process.argv[2]==='--run' || textProbe || capabilityProbe,'Use --run [--text-probe | --capability-probe], or no arguments for compile-only.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const home=await mkdtemp(path.join(os.tmpdir(),'pp-desktop-state-'));
const output=path.join(root,'.tools','desktop-verification',path.basename(home));
await mkdir(output,{recursive:true});
const executable=path.join(home,'DesktopStateFixture.exe'), state=path.join(home,'state');
const identityExecutable=path.join(home,'StateIdentity.exe');
const framework=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
execFileSync(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/platform:x64',`/out:${executable}`,'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',path.join(root,'scripts/e2e/desktop-state-fixture.cs')],{windowsHide:true});
execFileSync(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64',`/out:${identityExecutable}`,'/r:System.Management.dll','/r:System.Web.Extensions.dll',path.join(root,'scripts/e2e/desktop-observer-fault-identity.cs')],{windowsHide:true});
if(process.argv.length===2){console.log(JSON.stringify({ok:true,mode:'compile-only',output,guiStarted:false}));process.exit(0);}
await assertDesktopAcceptanceWindow();
const env={...process.env};delete env.PROFILEPILOT_MANAGEMENT_ROOT;
const session='state-'+randomUUID();
const nonce=randomBytes(16).toString('hex');
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const report={ok:false,startedAt:new Date().toISOString(),scope:'Ordinary-token owned WinForms controls through the actual development App; no physical input.',checks:[],limitations:['Current Windows display only; no macOS or mixed-DPI claim.','State changes use an owned fixture channel independent of ProfilePilot input.']};
if(textProbe){report.mode='text-length-diagnostic';report.scope+=' Diagnostic-only run; completion does not establish correct long-text behavior.';}
if(capabilityProbe)report.mode='text-pattern-capability';
report.hashes={cli:await digest(path.join(root,'dist/main/profilepilot-cli.cjs')),desktop:await digest(path.join(root,'dist/native/ProfilePilot.Desktop.exe')),
  harness:await digest(fileURLToPath(import.meta.url)),fixture:await digest(executable)};
let fixture,fixtureIdentity,heartbeat;
const identity=args=>JSON.parse(execFileSync(identityExecutable,args,{windowsHide:true,encoding:'utf8',timeout:10000}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function cli(args,expected=0){
  try{return (await runDesktopCliProcess({entry:path.join(root,'dist/main/profilepilot-cli.cjs'),args:[...args,'--json'],env,expectedExitCode:expected})).response;}
  catch(error){report.lastFailure={args,code:error.exitCode,errorCode:error.code,outcome:error.outcome,response:error.response};throw error;}
}
const desktop=(args,expected)=>cli(['desktop',...args],expected);
const observe=async()=>(await desktop(['observe','--session',session])).result;
const find=(snapshot,name)=>{const value=snapshot.elements.find(element=>element.name===name);assert.ok(value,`Missing ${name}`);return value;};
async function poll(file,predicate,timeout=10000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){try{const value=JSON.parse(await readFile(file,'utf8'));if(predicate(value))return value;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}await sleep(40);}
  throw new Error('Fixture response timed out: '+file);
}
async function mutate(operation,value){
  const id=randomUUID();await writeFile(state+'.command.json',JSON.stringify({nonce,id,operation,value}));
  const ack=await poll(state+'.ack.json',value=>value.id===id&&value.nonce===nonce&&value.pid===fixture.pid);assert.equal(ack.ok,true,ack.error);
  return ack;
}
async function action(snapshot,name,kind,extra={},expected=0){
  const file=path.join(home,'action-'+randomUUID()+'.json');
  await writeFile(file,JSON.stringify({version:snapshot.version,ref:find(snapshot,name).reference,kind,...extra}));
  return desktop(['action','--session',session,'--params-file',file],expected);
}
try{
  const runtime=await cli(['status']);assert.equal(runtime.ok,true);
  assert.equal(path.resolve(runtime.data.build.entry).toLowerCase(),path.join(root,'dist/main/entry.js').toLowerCase());
  report.appBuild={pid:runtime.data.pid,buildId:runtime.data.build.buildId,startedAt:runtime.data.build.startedAt};
  const manifest=JSON.parse(await readFile(path.join(root,'dist/main/control-build.json'),'utf8'));
  assert.equal(manifest.buildId,report.appBuild.buildId);assert.equal(manifest.cliSha256,report.hashes.cli);
  assert.equal(manifest.components['dist/native/ProfilePilot.Desktop.exe'],report.hashes.desktop);
  report.appIdentity=identity(['--inspect',String(runtime.data.pid)]);
  assert.equal(report.appIdentity.ok,true);assert.equal(report.appIdentity.pid,runtime.data.pid);
  assert.equal(path.resolve(report.appIdentity.executable).toLowerCase(),path.join(root,'node_modules/electron/dist/electron.exe').toLowerCase());
  assert.equal(report.appIdentity.sha256,await digest(report.appIdentity.executable));
  assert.equal(report.appIdentity.integrityRid,8192);assert.equal(report.appIdentity.elevated,false);assert.equal(report.appIdentity.uiAccess,false);
  assert.equal((await desktop(['status'])).result.session,null,'Do not replace an existing desktop task');
  await writeFile(state+'.heartbeat',nonce);
  heartbeat=setInterval(()=>{void writeFile(state+'.heartbeat',nonce).catch(error=>{report.heartbeatError=error.message;});},2000);
  fixture=await launchWindowsUserProcess(executable,[state,nonce],root);
  fixtureIdentity=report.fixtureIdentity=identity(['--inspect',String(fixture.pid)]);
  assert.equal(fixtureIdentity.ok,true);assert.equal(fixtureIdentity.pid,fixture.pid);
  assert.equal(path.resolve(fixtureIdentity.executable).toLowerCase(),executable.toLowerCase());assert.equal(fixtureIdentity.sha256,report.hashes.fixture);
  assert.equal(fixtureIdentity.integrityRid,8192);assert.equal(fixtureIdentity.elevated,false);assert.equal(fixtureIdentity.uiAccess,false);
  report.environment=await poll(state+'.environment.json',value=>value.pid===fixture.pid&&value.nonce===nonce);
  assert.equal(report.environment.startedUtcTicks,fixtureIdentity.startedUtcTicks);
  assert.equal(report.environment.administrator,false);
  const windows=(await desktop(['windows'])).result.windows;
  const target=windows.find(window=>window.pid===fixture.pid&&window.nativeHandle===report.environment.hwnd&&window.title==='ProfilePilot state verification');assert.ok(target);
  await desktop(['claim','--session',session,'--window',target.id]);
  report.preflight=(await desktop(['doctor','--window',target.id])).result;
  if(capabilityProbe){
    const waited=(await desktop(['wait','--session',session,'--name','State value','--has-action','text','--timeout-ms','10000'])).result;
    assert.equal(waited.matched,true);const element=find(waited.observation,'State value');assert.ok(element.actions.includes('text'));
    report.capabilityWait=waited;report.checks.push('CLI wait matches the actual native TextPattern capability');
    report.invalidTextAction=await action(waited.observation,'State value','text',{},2);
    assert.equal(report.invalidTextAction.code,'DESKTOP_INVALID_ARGUMENTS');
    assert.equal(find(await observe(),'State value').text,'initial');
    report.checks.push('TextPattern is not an input action; invalid text action leaves the fixture unchanged');
  }else if(textProbe){
    report.textProbe=[];
    for(const length of [1999,2000,2001,4097]){
      const ack=await mutate('value','X'.repeat(length));const observed=await observe();const element=find(observed,'State value');
      report.textProbe.push({requestedLength:length,fixture:ack,returnedLength:element.text.length,element,gaps:observed.gaps});
    }
    const beforeValue='X'.repeat(2000)+'A',changedValue='X'.repeat(2000)+'B';
    const beforeAck=await mutate('value',beforeValue),beforeObserve=await observe();
    const changedAck=await mutate('value',changedValue);
    assert.equal(beforeAck.valueSha256,createHash('sha256').update(beforeValue).digest('hex'));
    assert.equal(changedAck.valueSha256,createHash('sha256').update(changedValue).digest('hex'));
    const staleAction=await action(beforeObserve,'State value','set_value',{value:'probe overwritten suffix'},null);
    const afterObserve=await observe();
    report.staleSuffixProbe={beforeFixture:beforeAck,changedFixture:changedAck,before:find(beforeObserve,'State value'),response:staleAction,after:find(afterObserve,'State value')};
    report.staleSuffixProbe.regressionReproduced=staleAction.ok===true&&staleAction.result?.executed===true&&report.staleSuffixProbe.after.text==='probe overwritten suffix';
    report.checks.push('Collected four diagnostic lengths and suffix mutation outcome; no long-text correctness claim');
  }else{
  let snapshot=await observe();report.initialElements=snapshot.elements;
  assert.ok(!JSON.stringify(snapshot).includes('state-password-never-return'));
  const password=snapshot.elements.find(element=>element.password);assert.ok(password);
  assert.equal(password.name,'');assert.equal(password.text,'');assert.equal(password.state.valueStatus,'redacted');
  assert.deepEqual(find(snapshot,'State value').stateGaps,[],'Unsupported patterns must not become unreadable state');
  report.checks.push('Password value omitted from returned observation');

  for(const check of [
    {operation:'value',value:'external edit',name:'State value',kind:'set_value',extra:{value:'must not overwrite'}},
    {operation:'readOnly',value:true,name:'State value',kind:'set_value',extra:{value:'must not overwrite'}},
    {operation:'toggle',value:true,name:'State toggle',kind:'toggle'},
    {operation:'selection',value:1,name:'Choice one',kind:'select'},
    {operation:'expanded',value:true,name:'State branch',kind:'expand'}
  ]){
    snapshot=await observe();await mutate(check.operation,check.value);
    const response=await action(snapshot,check.name,check.kind,check.extra,75);
    assert.equal(response.code,'DESKTOP_ELEMENT_CHANGED',JSON.stringify(response));
    report.checks.push(`External ${check.operation} change rejects the old control reference`);
  }
  await mutate('readOnly',false);snapshot=await observe();
  await action(snapshot,'State value','set_value',{value:'fresh edit'});
  assert.equal(find(await observe(),'State value').text,'fresh edit');
  report.checks.push('Fresh observation permits the requested edit after state changes');

  snapshot=await observe();await action(snapshot,'Start delayed save','invoke');
  const waited=(await desktop(['wait','--session',session,'--name','Saved 1','--timeout-ms','10000','--interval-ms','100'])).result;
  assert.equal(waited.matched,true);assert.equal(waited.requiresObservation,false);
  assert.ok(waited.observation.elements.some(element=>element.name==='Saved 1'));
  report.wait=waited;assert.equal((await poll(state+'.saved.json',value=>value.saves===1&&value.nonce===nonce&&value.pid===fixture.pid)).saves,1);
  report.checks.push('Read-only wait observes asynchronous UIA Invoke effects without repeating input');
  const timedOut=(await desktop(['wait','--session',session,'--name','Never appears','--timeout-ms','200','--interval-ms','100'],75)).result;
  assert.equal(timedOut.timedOut,true);assert.equal(timedOut.requiresObservation,true);
  assert.equal((await desktop(['status'])).result.session.state,'active');
  assert.ok((await observe()).elements.length>0);
  report.checks.push('Bounded wait timeout leaves the owner active and allows a fresh observation');

  const longName='N'.repeat(512)+'-actual-suffix';
  await mutate('buttonName',longName);snapshot=await observe();
  const limitedName=find(snapshot,longName.slice(0,512));
  assert.ok(limitedName.truncatedFields?.includes('name'));
  const nameWait=(await desktop(['wait','--session',session,'--name',longName.slice(0,512),'--timeout-ms','5000','--interval-ms','2000'],75)).result;
  assert.equal(nameWait.matched,false);assert.equal(nameWait.timedOut,true);
  assert.ok(nameWait.observation?.elements.some(element=>element.name===longName.slice(0,512)&&element.truncatedFields?.includes('name')));
  report.nameWait=nameWait;
  const otherName=(await desktop(['wait','--session',session,'--name','State value','--timeout-ms','10000'])).result;
  assert.equal(otherName.matched,true);assert.ok(otherName.observation.gaps.includes('name_limit'));
  report.checks.push('A truncated name prefix cannot match, while a complete sibling name still can');
  await mutate('buttonName','Start delayed save');

  const longText='X'.repeat(4097);report.longTextFixture=await mutate('value',longText);snapshot=await observe();report.longTextObservation=snapshot;
  const limitedText=find(snapshot,'State value');assert.equal(limitedText.text,longText.slice(0,4096));
  assert.equal(limitedText.textStatus,'truncated');assert.ok(limitedText.truncatedFields.includes('text'));
  assert.equal(limitedText.textSource,'text_pattern');assert.equal(limitedText.state.valueEvidence,'value_and_text');
  const textWait=(await desktop(['wait','--session',session,'--name','State value','--text',longText.slice(0,4096),'--timeout-ms','5000','--interval-ms','2000'],75)).result;
  assert.equal(textWait.matched,false);assert.equal(textWait.timedOut,true);
  assert.ok(textWait.observation?.elements.some(element=>element.name==='State value'&&element.textStatus==='truncated'));
  report.textWait=textWait;report.checks.push('A truncated supplementary TextPattern prefix is not an exact text match');

  const exactBoundary='B'.repeat(2000);await mutate('value',exactBoundary);
  const boundaryWait=(await desktop(['wait','--session',session,'--name','State value','--text',exactBoundary,'--timeout-ms','10000'])).result;
  assert.equal(boundaryWait.matched,true);const boundary=find(boundaryWait.observation,'State value');
  assert.equal(boundary.text,exactBoundary);assert.equal(boundary.textStatus,'readable');assert.equal(boundary.state.valueEvidence,'value_and_text');
  report.boundaryWait=boundaryWait;report.checks.push('Exactly 2000 characters remain a complete match after independent text confirmation');

  const beforeValue='X'.repeat(2000)+'A',changedValue='X'.repeat(2000)+'B';
  const beforeAck=await mutate('value',beforeValue);snapshot=await observe();
  const changedAck=await mutate('value',changedValue);
  assert.equal(beforeAck.valueSha256,createHash('sha256').update(beforeValue).digest('hex'));
  assert.equal(changedAck.valueSha256,createHash('sha256').update(changedValue).digest('hex'));
  const suffixResponse=await action(snapshot,'State value','set_value',{value:'must not overwrite changed suffix'},75);
  assert.equal(suffixResponse.code,'DESKTOP_ELEMENT_CHANGED');
  const suffixAfter=find(await observe(),'State value');assert.equal(suffixAfter.text,changedValue);
  report.suffixIdentity={beforeFixture:beforeAck,changedFixture:changedAck,response:suffixResponse,after:suffixAfter};
  report.checks.push('A changed suffix beyond character 2000 rejects the old reference and preserves the external edit');

  report.evidenceBoundary=[];
  for(const length of [16384,16385]){
    const fixtureAck=await mutate('value','C'.repeat(length));assert.equal(fixtureAck.valueLength,length);snapshot=await observe();
    const element=find(snapshot,'State value');assert.equal(element.text.length,4096);assert.equal(element.textStatus,'truncated');
    let response;
    if(length===16384){
      assert.equal(element.state.valueEvidence,'value_and_text');assert.deepEqual(element.stateGaps,[]);
      response=await action(snapshot,'State value','set_value',{value:'confirmed boundary edit'});
      assert.equal(find(await observe(),'State value').text,'confirmed boundary edit');
    }else{
      assert.equal(element.state.valueEvidence,'unconfirmed');assert.ok(element.stateGaps.includes('value_evidence'));
      response=await action(snapshot,'State value','set_value',{value:'must not overwrite unconfirmed text'},75);
      assert.equal(response.code,'DESKTOP_ELEMENT_UNAVAILABLE');
      const unchanged=await mutate('readOnly',false);assert.equal(unchanged.valueLength,length);assert.equal(unchanged.valueSha256,fixtureAck.valueSha256);
    }
    report.evidenceBoundary.push({length,fixture:fixtureAck,element,response});
  }
  report.checks.push('16384-character evidence permits a fresh edit; a 16385-character bound refuses it without mutation');
  await observe();await mutate('value','');
  const emptyWait=(await desktop(['wait','--session',session,'--name','State value','--text','','--timeout-ms','10000'])).result;
  assert.equal(emptyWait.matched,true);const empty=find(emptyWait.observation,'State value');
  assert.equal(empty.text,'');assert.equal(empty.textStatus,'readable');assert.deepEqual(empty.truncatedFields,[]);
  report.emptyWait=emptyWait;report.checks.push('Explicit CLI empty text matches an actually readable empty value');

  const readStarted=performance.now();await observe();const baselineReadMs=performance.now()-readStarted;
  const intervalTimeoutMs=Math.min(19000,Math.max(1000,Math.ceil(baselineReadMs+500)));
  const intervalTimeout=(await desktop(['wait','--session',session,'--name','Never appears','--timeout-ms',String(intervalTimeoutMs),'--interval-ms','2000'],75)).result;
  const afterTimeout=(await desktop(['status'])).result;
  report.intervalTimeout={baselineReadMs,timeoutMs:intervalTimeoutMs,result:intervalTimeout,status:afterTimeout};
  assert.equal(intervalTimeout.timedOut,true);assert.equal(intervalTimeout.attempts,1,'The measured interval case must finish one observation');
  assert.ok(intervalTimeout.observation);assert.equal(afterTimeout.inputObservation.phase,'ready','This case must exercise interval timeout without a pending read');
  const staleAfterTimeout=await action(intervalTimeout.observation,'Start delayed save','invoke',{},75);
  assert.equal(staleAfterTimeout.code,'DESKTOP_FRESH_OBSERVATION_REQUIRED');
  assert.equal((await poll(state+'.saved.json',value=>value.nonce===nonce&&value.pid===fixture.pid)).saves,1);
  snapshot=await observe();await action(snapshot,'State value','set_value',{value:'fresh after timeout'});
  assert.equal(find(await observe(),'State value').text,'fresh after timeout');
  report.checks.push('Interval timeout rejects the previous version without invoking again; a fresh observation restores actions');
  }
  await desktop(['complete','--session',session,'--require-active']);
  const finalRuntime=await cli(['status']);assert.equal(finalRuntime.data.pid,report.appBuild.pid);
  assert.equal(finalRuntime.data.build.buildId,report.appBuild.buildId);assert.equal(finalRuntime.data.build.startedAt,report.appBuild.startedAt);
  assert.equal(await digest(path.join(root,'dist/main/profilepilot-cli.cjs')),report.hashes.cli);
  assert.equal(await digest(path.join(root,'dist/native/ProfilePilot.Desktop.exe')),report.hashes.desktop);
  const finalApp=identity(['--inspect',String(report.appBuild.pid)]);assert.equal(finalApp.ok,true);
  assert.equal(finalApp.startedUtcTicks,report.appIdentity.startedUtcTicks);assert.equal(finalApp.sha256,report.appIdentity.sha256);report.ok=true;
}catch(error){report.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally{
  report.cleanup={};
  try{
    const current=(await desktop(['status'])).result.session;
    if(current?.name===session)await desktop(['release','--session',session]);
    report.cleanup.session=(await desktop(['status'])).result.session;
    assert.notEqual(report.cleanup.session?.name,session,'This fixture session must be released');
  }catch(error){report.cleanup.sessionError=String(error);report.ok=false;process.exitCode=1;}
  if(fixture){
    try{
      await writeFile(state+'.close',nonce);
      report.cleanup.fixtureReceipt=await poll(state+'.closed.json',value=>value.pid===fixture.pid&&value.nonce===nonce&&value.startedUtcTicks===fixtureIdentity?.startedUtcTicks);
    }catch(error){report.cleanup.fixtureReceiptError=String(error);report.ok=false;process.exitCode=1;}
    try{
      assert.ok(fixtureIdentity?.ok,'No verified identity for fixture cleanup');
      let exited;
      try{exited=identity(['--wait-owned-exit',String(fixture.pid),fixtureIdentity.startedUtcTicks,'5000']);}
      catch(error){report.cleanup.fixtureWaitError=error.message;}
      if(!exited?.ok || !exited.originalExited){
        report.cleanup.forced=identity(['--cleanup-owned',String(fixture.pid),fixtureIdentity.startedUtcTicks,executable,fixtureIdentity.sha256,String(fixtureIdentity.parentPid)]);
        throw new Error('Normal fixture retirement was not confirmed; forced cleanup attempted');
      }
      report.cleanup.fixtureExit=exited;
    }catch(error){report.cleanup.fixtureError=String(error);report.ok=false;process.exitCode=1;}
  }
  clearInterval(heartbeat);
  report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:report.ok,report:path.join(output,'report.json'),checks:report.checks.length,cleanup:report.cleanup},null,2));
}
