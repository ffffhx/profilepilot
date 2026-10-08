const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { phoneFlowSchema, executePhoneFlow } = loadCli('src/main/phones/flow.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const parse = steps => phoneFlowSchema.parse({ version: 1, steps });
const found = count => ({ count, matches: Array.from({ length: count }, () => ({ resourceId: 'test:id/button' })) });
const target = { resourceId: 'test:id/button' };
function clock() { let time = 0; return { now: () => time, delay: async ms => { time += ms; } }; }

test('validates entire flow before any execution, including selectors and bounds', () => {
  for (const steps of [[{kind:'click',selector:{}}], [{kind:'fill',selector:target,text:3}], [{kind:'shell',command:'x'}],
    [{kind:'wait',selector:target,timeoutMs:30001}], [{kind:'scrollUntil',selector:target,container:target,maxScrolls:0}],
    [{kind:'click',selector:{resourceId:'x',index:0}}]]) assert.throws(() => parse(steps));
  assert.equal(parse([{kind:'fill',selector:target,text:''}]).steps[0].text, '');
});
test('wait repeats only observations, then performs each input once', async () => {
  const calls = []; let observations = 0;
  const report = await executePhoneFlow(parse([{kind:'wait',selector:target}, {kind:'click',selector:target}]), async action => {
    calls.push(action.kind); return action.kind === 'find' ? found(++observations === 3 ? 1 : 0) : {performed:true};
  }, clock());
  assert.equal(report.ok,true); assert.deepEqual(calls,['find','find','find','click']);
});
test('assert fails immediately and prevents all later actions', async () => {
  const calls = [];
  const report = await executePhoneFlow(parse([{kind:'assert',selector:target},{kind:'click',selector:target}]), async a => { calls.push(a.kind); return found(0); }, clock());
  assert.equal(report.failedStep,1); assert.deepEqual(calls,['find']); assert.equal(report.steps.length,1);
});
test('wait has bounded timeout; absence assertions support multiple current matches', async () => {
  const report = await executePhoneFlow(parse([{kind:'wait',selector:target,timeoutMs:400}]), async () => found(0), clock());
  assert.equal(report.ok,false); assert.equal(report.durationMs,400); assert.equal(report.steps[0].observations,3);
  const absent = await executePhoneFlow(parse([{kind:'assert',selector:target,condition:'absent'}]), async () => found(0), clock());
  assert.equal(absent.ok,true);
});
test('ambiguous and malformed observations fail without hiding errors through retries', async () => {
  for (const value of [found(2), { count:0 }, {count:1,matches:[]}, null]) {
    let count = 0;
    const report = await executePhoneFlow(parse([{kind:'wait',selector:target}]), async () => { count++; return value; }, clock());
    assert.equal(report.ok,false); assert.equal(count,1);
  }
});
test('uncertain input is not replayed and no subsequent input runs', async () => {
  const calls=[];
  const report=await executePhoneFlow(parse([{kind:'click',selector:target},{kind:'fill',selector:target,text:'secret'}]),async a=>{calls.push(a.kind);throw Error('response lost');},clock());
  assert.deepEqual(calls,['click']); assert.equal(report.error,'response lost'); assert.ok(!JSON.stringify(report).includes('secret'));
});
test('scrollUntil stops when target is found, and stops at end without repeated scroll actions', async () => {
  let scrolls=0;
  const flow=parse([{kind:'scrollUntil',selector:target,container:{scrollable:true},settleMs:100,maxScrolls:3}]);
  const success=await executePhoneFlow(flow,async a=>a.kind==='scroll'?(scrolls++,{performed:true}):found(scrolls===2?1:0),clock());
  assert.equal(success.ok,true); assert.equal(scrolls,2);
  scrolls=0;
  const end=await executePhoneFlow(flow,async a=>a.kind==='scroll'?(scrolls++,{performed:false}):found(0),clock());
  assert.equal(end.ok,false); assert.equal(scrolls,1); assert.match(end.error,/无法继续滚动/);
});
test('cancellation and global deadline stop between observations', async () => {
  const abort=new AbortController(); const timer=clock(); let calls=0;
  const stopped=await executePhoneFlow(parse([{kind:'wait',selector:target}]),async()=>{calls++;return found(0);},{...timer,signal:abort.signal,delay:async()=>abort.abort()});
  assert.equal(stopped.ok,false); assert.equal(calls,1);
  const flow=parse([{kind:'wait',selector:target}]);flow.timeoutMs=100;
  const timeout=await executePhoneFlow(flow,async()=>found(0),clock());
  assert.equal(timeout.durationMs,100);assert.match(timeout.error,/总时限/);
});

function cliHarness(t, steps) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-phone-flow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'中文 flow.json'); fs.writeFileSync(file,'\ufeff'+JSON.stringify({version:1,steps}));
  const state={instanceId:'phone-instance',sessionId:randomUUID(),generation:4,phase:'controlling',mode:'control'};
  const h={root,file,state,calls:[],out:'',err:'',action:async()=>found(1)};
  h.request=async command=>{
    h.calls.push(command);
    if(command.method==='wrapper-start')return {ok:true,data:{lease:randomUUID(),device:{id:'phone',state:structuredClone(state)}}};
    if(command.method==='wrapper-action')return {ok:true,data:{result:await h.action(command.params.action),state:structuredClone(state)}};
    if(command.method==='wrapper-state'||command.method==='wrapper-pulse')return {ok:true,data:{state:structuredClone(state),companion:'ready',connection:'device'}};
    return {ok:true,data:null};
  };
  h.run=(extra=[])=>runPhoneCli(['run','--device','phone','--file',file,...extra],h.request,{stdout:{write:s=>h.out+=s},stderr:{write:s=>h.err+=s}});
  return h;
}
test('CLI accepts BOM and paths with spaces, owns and cleans its session and writes input-free report',async t=>{
  const h=cliHarness(t,[{kind:'fill',selector:target,text:'do-not-log-this'}]);h.action=async()=>({performed:true});
  assert.equal(await h.run(['--output-dir',h.root]),0);
  assert.equal(h.calls[0].params.mode,'control'); assert.equal(h.calls.at(-1).method,'wrapper-stop');
  const data=JSON.parse(h.out).data; assert.equal(JSON.parse(fs.readFileSync(path.join(data.outputDir,'report.json'))).ok,true);
  assert.ok(!h.out.includes('do-not-log-this'));
});
test('view mode validates before starting; read-only flows automatically use view',async t=>{
  const h=cliHarness(t,[{kind:'click',selector:target}]);assert.equal(await h.run(['--mode','view']),1);assert.equal(h.calls.length,0);
  const read=cliHarness(t,[{kind:'assert',selector:target}]);assert.equal(await read.run(),0);assert.equal(read.calls[0].params.mode,'view');
});
test('phone pause during response cancels remaining steps without rebasing generation or collecting screenshots',async t=>{
  const h=cliHarness(t,[{kind:'click',selector:target},{kind:'click',selector:target}]);
  h.action=async()=>{h.state.generation++;h.state.phase='paused';return {performed:true};};
  assert.equal(await h.run(['--output-dir',h.root]),1);
  assert.equal(h.calls.filter(c=>c.method==='wrapper-action').length,1);
  assert.equal(h.calls.at(-1).method,'wrapper-stop'); assert.match(JSON.parse(h.out).data.error,/会话已改变/);
});
test('occupied device is not stopped when session acquisition fails',async t=>{
  const h=cliHarness(t,[{kind:'click',selector:target}]); h.request=async c=>{h.calls.push(c);return {ok:false,error:{message:'occupied'}};};
  assert.equal(await h.run(),1);assert.deepEqual(h.calls.map(c=>c.method),['wrapper-start']);
});

test('failed setup and cleanup always remove CLI signal handlers',async t=>{
  const h=cliHarness(t,[{kind:'assert',selector:target}]);
  const before={int:process.listenerCount('SIGINT'),term:process.listenerCount('SIGTERM')};
  h.request=async c=>c.method==='wrapper-start'
    ?{ok:true,data:{lease:randomUUID(),device:{state:null}}}
    :{ok:false,error:{message:'cleanup disconnected'}};
  assert.equal(await h.run(),1);
  assert.equal(process.listenerCount('SIGINT'),before.int);
  assert.equal(process.listenerCount('SIGTERM'),before.term);
});
