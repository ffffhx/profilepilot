const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {loadCli}=require('./cli-test-build.cjs');
const {PhonesService}=loadCli('src/main/phones/service.ts');
function harness(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-native-service-')),h={calls:[],spawned:[],online:true};
  h.service=new PhonesService({root,apkPath:'',adb:{run:async args=>{
    h.calls.push(args);if(args[0]==='devices')return h.online?'PHONE device model:Phone transport_id:7':'';
    if(args[0]==='version')return 'Android Debug Bridge version 1.0.41';
    if(args[0]==='kill-server'){h.online=false;return '';}
    if(args[0]==='start-server'){h.online=true;return '';}
    return '';
  },spawn:(args,options)=>{
    h.spawned.push(args);let resolve;const p={done:new Promise(r=>resolve=r),end(){},write:async()=>{},abort(){h.aborted=true;resolve({code:130,signal:'SIGTERM'});}};return p;
  }}});
  t.after(async()=>{await h.service.close();fs.rmSync(root,{recursive:true,force:true});});return h;
}
test('explicit basic wrapper works without installing an App and stops a native job when desktop pauses',async t=>{
  const h=harness(t),owner=await h.service.startWrapper('PHONE','control','Test','test','basic');
  assert.equal(owner.device.state.phase,'controlling');assert.equal(owner.device.transportId,'7');
  const {jobId}=await h.service.adbJobs.start({lease:owner.lease,generation:owner.device.state.generation,requestId:randomUUID(),args:['logcat']});
  await h.service.basicControl('PHONE','pause');
  for(let i=0;i<100&&!h.aborted;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(h.aborted,true);assert.equal(h.service.adbJobs.status(owner.lease,jobId).status,'interrupted');
  assert.equal(h.calls.some(c=>c.includes('install')),false);
  await h.service.stopWrapper(owner.lease);assert.equal(h.service.snapshot().devices[0].basic.phase,'stopped');
});
test('host shutdown is refused while a task is paused, and stays stopped after all tasks end',async t=>{
  const h=harness(t);await h.service.refresh();
  const owner=await h.service.startWrapper('PHONE','view','Test','test','basic');await h.service.basicControl('PHONE','pause');
  await assert.rejects(h.service.hostCommand(['kill-server']),/先结束/);
  await h.service.stopWrapper(owner.lease);await h.service.hostCommand(['kill-server']);
  const before=h.calls.length;await h.service.refresh();await h.service.reconnectWireless();assert.equal(h.calls.length,before);
  assert.match((await h.service.hostCommand(['version'])).output,/Android Debug Bridge/);
  await h.service.hostCommand(['start-server']);assert.equal(h.service.snapshot().devices[0].connection,'device');
});
