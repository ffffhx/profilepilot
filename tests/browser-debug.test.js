require('./helpers/native-dom-source.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {BrowserDebugSession}=require('../src/main/browser-debug/session.ts');
const {parseDebugArgs}=require('../src/main/browser-debug/arguments.ts');
const {limits}=require('../src/main/browser-debug/records.ts');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pp-debug-unit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const calls=[];let allowed=true;
  const debug=new BrowserDebugSession({check(){if(!allowed)throw Error('user-control');},async send(method,params,sessionId){calls.push({method,params,sessionId});if(method==='Network.getResponseBody')return{body:JSON.stringify({request:params.requestId,session:sessionId||'root'}),base64Encoded:false};if(method==='Tracing.end')queueMicrotask(()=>debug.event({method:'Tracing.tracingComplete'}));return{};}},root);
  debug.bindTarget('tab');await debug.start();
  const event=(method,params,sessionId)=>debug.event({method,params,sessionId});
  const request=(id,url='/api',sessionId,extra={})=>event('Network.requestWillBeSent',{requestId:id,request:{url:'http://fixture'+url,method:'GET',headers:{}},timestamp:1,wallTime:100,type:'Fetch',...extra},sessionId);
  const finish=(id,status=200,sessionId)=>{event('Network.responseReceived',{requestId:id,response:{status,mimeType:'application/json',headers:{}},timestamp:2},sessionId);event('Network.loadingFinished',{requestId:id,timestamp:3,encodedDataLength:16},sessionId);};
  return{debug,calls,event,request,finish,root,stop(){allowed=false;debug.suspend('user-control');}};
}
test('AND filters, cursor pagination, detail body, and stable unique redirect IDs',async t=>{
  const f=await fixture(t);f.request('1');f.finish('1',404);f.request('2','/image',undefined,{type:'Image'});f.finish('2');
  f.request('3','/start');f.request('3','/end',undefined,{redirectResponse:{status:302,headers:{}},timestamp:2});f.finish('3',500);
  const result=await f.debug.command('network',{filter:'/api',type:'xhr,fetch',status:'4xx',method:'get',failed:true});assert.equal(result.requests.length,1);
  assert.equal(result.requests[0].body.text,undefined);
  const detail=await f.debug.command('network',{action:'request',id:result.requests[0].id});assert.equal(JSON.parse(detail.body.text).request,'1');
  const first=await f.debug.command('network',{limit:2});const next=await f.debug.command('network',{since:first.cursor});assert.equal(first.requests.length+next.requests.length,4);assert.equal(new Set([...first.requests,...next.requests].map(r=>r.id)).size,4);
  await assert.rejects(f.debug.command('network',{status:'599-400'}),/reversed/);
});
test('HAR keeps in-flight requests when query list is cleared and retains bodies after navigation',async t=>{
  const f=await fixture(t);await f.debug.command('network',{action:'har',operation:'start'});f.request('a');
  await f.debug.command('network',{action:'clear'});f.finish('a');await new Promise(r=>setImmediate(r));
  const result=await f.debug.command('network',{action:'har',operation:'stop'});const har=JSON.parse(await fs.readFile(result.path,'utf8'));
  assert.equal(result.entries,1);assert.equal(result.complete,true);assert.equal(JSON.parse(har.log.entries[0].response.content.text).request,'a');
  assert.equal((await f.debug.command('network')).requests.length,0);
  await assert.rejects(f.debug.command('network',{action:'har',operation:'stop',path:result.path}),/EEXIST/);
});
test('OOPIF nested sessions capture their own same-numbered requests and detach recursively',async t=>{
  const f=await fixture(t);await f.debug.command('network',{action:'har',operation:'start'});
  f.event('Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});await new Promise(r=>setImmediate(r));
  f.event('Target.attachedToTarget',{sessionId:'nested',targetInfo:{type:'iframe'}},'child');await new Promise(r=>setImmediate(r));
  f.request('1');f.request('1','/frame','nested');f.finish('1');f.finish('1',200,'nested');await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.calls.filter(c=>c.method==='Network.getResponseBody').map(c=>c.sessionId),[undefined,'nested']);
  f.event('Target.detachedFromTarget',{sessionId:'child'});f.request('2','/detached','nested');assert.equal((await f.debug.command('network')).requests.length,2);
});
test('console previews format objects without evaluating getters and exceptions include location',async t=>{
  const f=await fixture(t);f.event('Runtime.consoleAPICalled',{type:'log',args:[{type:'object',description:'Object',preview:{properties:[{name:'count',type:'number',value:'3'},{name:'name',type:'string',value:'中文'}]}}]});
  f.event('Runtime.exceptionThrown',{exceptionDetails:{text:'boom',url:'fixture',lineNumber:4}});
  assert.match((await f.debug.command('console')).messages[0].text,/count: 3, name: "中文"/);assert.equal((await f.debug.command('errors')).errors[0].line,4);
  assert.equal(f.calls.some(c=>c.method==='Runtime.evaluate'||c.method==='Runtime.getProperties'),false);
});
test('iframe navigation keeps one record when completion moves from parent to child renderer',async t=>{
  const f=await fixture(t);await f.debug.command('network',{action:'har',operation:'start'});
  f.request('navigation','/frame',undefined,{type:'Document',frameId:'frame-target'});
  f.event('Target.attachedToTarget',{sessionId:'frame-session',targetInfo:{type:'iframe',targetId:'frame-target'}});await new Promise(r=>setImmediate(r));
  f.finish('navigation',200,'frame-session');await new Promise(r=>setImmediate(r));
  const requests=(await f.debug.command('network')).requests;assert.equal(requests.length,1);assert.equal(requests[0].state,'complete');
  const detail=await f.debug.command('network',{action:'request',id:requests[0].id});assert.equal(JSON.parse(detail.body.text).session,'frame-session');
});
test('route mock, type filter passthrough, abort and unroute send correct CDP commands',async t=>{
  const f=await fixture(t);await f.debug.command('network',{action:'route',url:'*/api',body:'{"mock":true}',status:503,type:'fetch'});
  f.event('Fetch.requestPaused',{requestId:'a',request:{url:'http://fixture/api'},resourceType:'Fetch'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.at(-1).method,'Fetch.fulfillRequest');assert.equal(f.calls.at(-1).params.responseCode,503);
  f.event('Fetch.requestPaused',{requestId:'b',request:{url:'http://fixture/api'},resourceType:'Image'});await new Promise(r=>setImmediate(r));assert.equal(f.calls.at(-1).method,'Fetch.continueRequest');
  await f.debug.command('network',{action:'route',url:'*/api',abort:true});f.event('Fetch.requestPaused',{requestId:'c',request:{url:'http://fixture/api'}});await new Promise(r=>setImmediate(r));assert.equal(f.calls.at(-1).method,'Fetch.failRequest');
  await f.debug.command('network',{action:'unroute'});assert.equal(f.calls.at(-1).method,'Fetch.disable');
});
test('takeover stops background body reads and interception, marks interrupted recordings',async t=>{
  const f=await fixture(t);await f.debug.command('network',{action:'har',operation:'start'});f.request('a');f.stop();const count=f.calls.length;
  f.finish('a');f.event('Fetch.requestPaused',{requestId:'p'});await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,count);
  assert.deepEqual(f.debug.status().recording.reasons,['user-control']);await assert.rejects(f.debug.command('network'),/user-control/);
});
test('trace exports events and records budget truncation explicitly',async t=>{
  const f=await fixture(t);await f.debug.command('profiler',{action:'start'});f.event('Tracing.dataCollected',{value:[{name:'fixture',ph:'X',ts:1,dur:3}]});
  const result=await f.debug.command('profiler',{action:'stop'});assert.equal(result.complete,true);assert.equal(result.eventCount,1);assert.equal(JSON.parse(await fs.readFile(result.path,'utf8')).traceEvents[0].name,'fixture');
  const saved=limits.traceBytes;limits.traceBytes=1;t.after(()=>limits.traceBytes=saved);
  await f.debug.command('profiler',{action:'start'});f.event('Tracing.dataCollected',{value:[{name:'too-large'}]});
  const truncated=await f.debug.command('profiler',{action:'stop',path:path.join(f.root,'truncated.json')});assert.equal(truncated.complete,false);assert.equal(truncated.dropped,1);
});
test('body/query budgets are bounded and prior frame attachments are reinitialized',async t=>{
  const f=await fixture(t);await f.debug.command('debug',{action:'stop'});
  f.debug.setFrameSessions([{method:'Target.attachedToTarget',params:{sessionId:'prior-frame',targetInfo:{type:'iframe'},waitingForDebugger:true}}]);
  await f.debug.start();assert.ok(f.calls.some(c=>c.sessionId==='prior-frame'&&c.method==='Runtime.runIfWaitingForDebugger'));
  const saved={...limits};t.after(()=>Object.assign(limits,saved));limits.bodyBytes=8;limits.requests=1;
  await f.debug.command('network',{action:'har',operation:'start'});f.request('1');f.finish('1');await new Promise(r=>setImmediate(r));
  assert.equal((await f.debug.command('network')).requests[0].body.reason,'body-budget');
  f.request('2');f.finish('2');assert.equal((await f.debug.command('network')).requests.length,1);
  const har=await f.debug.command('network',{action:'har',operation:'stop'});assert.equal(har.entries,2);
  assert.equal(f.debug.current.size,0,'completed records are retained only by the bounded query/HAR stores');
});
test('CLI options keep JSON and Unicode paths portable on Windows/macOS',()=>{
  assert.deepEqual(parseDebugArgs('network',['requests','--filter','api','--type','fetch,xhr','--status','4xx','--limit','5']),{action:'requests',filter:'api',type:'fetch,xhr',status:'4xx',limit:5});
  assert.deepEqual(parseDebugArgs('network',['route','*/api','--status','503','--body','中文']),{action:'route',url:'*/api',status:503,body:'中文'});
  assert.equal(parseDebugArgs('profiler',['stop','C:\\导出 目录\\trace.json']).path,'C:\\导出 目录\\trace.json');
  assert.throws(()=>parseDebugArgs('network',['requests','--no-such-option']),/Unknown/);
});
