const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { ManagedAdbJobs } = loadCli('src/main/phones/adb-jobs.ts');
const { adbCommand } = loadCli('src/main/phones/adb-command.ts');
const { spawnAdb } = loadCli('src/main/phones/adb-process.ts');

function harness(t) {
  const h = { phase:'active',generation:1,mode:'control',calls:[],released:0,processes:[] };
  const adb = {spawn:(args,options)=>{
    h.calls.push(args); let resolve;
    const p = {options,writes:[],ended:false,done:new Promise(r=>resolve=r),write:async b=>p.writes.push(b),end:()=>p.ended=true,
      abort:()=>{p.aborted=true;resolve({code:130,signal:'SIGTERM'});},finish:code=>resolve({code,signal:null})};
    h.processes.push(p);return p;
  }};
  h.jobs = new ManagedAdbJobs(adb,async(lease,generation,mode,acquire)=>{
    if(h.phase!=='active'||generation!==h.generation||mode==='control'&&h.mode==='view') throw new Error('revoked');
    return {id:'PHONE',release:()=>{if(acquire)h.released++;}};
  });
  h.lease=randomUUID();h.input=(args,extra={})=>({lease:h.lease,generation:1,requestId:randomUUID(),args,...extra});
  h.start=async(args,extra)=>{const {jobId}=await h.jobs.start(h.input(args,extra));return jobId;};
  t.after(()=>h.jobs.close());return h;
}
async function terminal(h,id) {
  for(let n=0;n<100;n++){const r=h.jobs.status(h.lease,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,10));}
  throw new Error('job failed to finish');
}
test('shell queries are classified conservatively; arbitrary syntax and mutations require control',()=>{
  for(const args of [['shell','getprop'],['shell','dumpsys','package','io.example'],['shell','settings','get','global','adb_enabled'],['pull','/sdcard/file','local'],['logcat','-d','-t','20']]) assert.equal(adbCommand(args).mode,'view');
  for(const args of [['shell','getprop; reboot'],['shell','date','010112302026'],['logcat','-c'],['logcat','--buffer-size=1M'],['logcat','-d;reboot'],['shell','settings','put','global','adb_enabled','0'],['exec-in','sh']]) assert.equal(adbCommand(args).mode,'control');
  for(const args of [['-s','OTHER','shell'],['kill-server'],['reconnect','offline'],['shell','a\0b']]) assert.throws(()=>adbCommand(args));
});
test('native execution preserves target, binary output, stderr, remote exit code and acknowledged output',async t=>{
  const h=harness(t),id=await h.start(['exec-out','cat','/sdcard/a']);
  assert.deepEqual(h.calls[0],['-s','PHONE','exec-out','cat','/sdcard/a']);
  const p=h.processes[0],bytes=Buffer.from([0,10,13,128,255]);p.options.stdout(bytes);p.options.stderr(Buffer.from('error'));p.finish(17);
  const r=await terminal(h,id);assert.equal(r.status,'completed');assert.equal(r.code,17);assert.deepEqual(Buffer.from(r.chunks[0].data,'base64'),bytes);
  assert.deepEqual(h.jobs.status(h.lease,id).chunks,r.chunks,'observation retries do not lose bytes');
  assert.equal(h.jobs.status(h.lease,id,r.nextOffset).chunks.length,0);assert.equal(h.released,1);
});
test('phone pause cancels a streaming job and old generation cannot be replayed',async t=>{
  const h=harness(t),input=h.input(['logcat']),{jobId}=await h.jobs.start(input);h.phase='paused';h.generation++;
  const r=await terminal(h,jobId);assert.equal(r.status,'interrupted');assert.equal(h.processes[0].aborted,true);
  h.phase='active';await assert.rejects(h.jobs.start(input),/重放/);await assert.rejects(h.jobs.start(h.input(['logcat'])),/revoked/);
  assert.equal(h.calls.length,1);
});
test('view leases cannot execute shell mutations or receive stdin; failed startup launches nothing',async t=>{
  const h=harness(t);h.mode='view';
  await assert.rejects(h.start(['shell','rm','/data/local/tmp/probe']),/revoked/);
  await assert.rejects(h.start(['shell','getprop'],{stdin:true}),/revoked/);
  assert.equal(h.calls.length,0);
});
test('stdin bytes are ordered, duplicate chunks refused and pause checked before every write',async t=>{
  const h=harness(t),id=await h.start(['exec-in','cat'],{stdin:true}),bytes=Buffer.from([0,255,10]);
  await h.jobs.input(h.lease,id,0,bytes.toString('base64'));
  assert.deepEqual(h.processes[0].writes,[bytes]);
  await assert.rejects(h.jobs.input(h.lease,id,0,bytes.toString('base64')),/重复/);
  h.phase='paused';await assert.rejects(h.jobs.input(h.lease,id,1,'',true),/revoked/);
  assert.equal(h.processes[0].ended,false);
});
test('deadline, explicit stop, lost owner and output limit stop native processes',async t=>{
  const h=harness(t),id=await h.start(['logcat'],{timeoutMs:100});
  assert.equal((await terminal(h,id)).status,'interrupted');
  const second=await h.start(['logcat']);h.processes[1].options.stdout(Buffer.alloc(9*1024*1024));
  assert.equal(h.jobs.status(h.lease,second).status,'interrupted');assert.equal(h.processes[1].aborted,true);
  const third=await h.start(['logcat']);await h.jobs.release(h.lease);assert.equal(h.processes[2].aborted,true);
  assert.throws(()=>h.jobs.status(h.lease,third));assert.equal(h.released,3);
});
test('real native process supports binary stdin/stdout and preserves exit code without a host shell',async()=>{
  const out=[],err=[],bytes=Buffer.from([0,10,128,255]);
  const p=spawnAdb(process.execPath,['-e',"process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>{process.stderr.write('stderr');process.exitCode=23})"],{stdout:b=>out.push(b),stderr:b=>err.push(b)});
  await p.write(bytes);p.end();assert.equal((await p.done).code,23);assert.deepEqual(Buffer.concat(out),bytes);assert.equal(Buffer.concat(err).toString(),'stderr');
});
