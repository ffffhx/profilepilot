const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const compiled = esbuild.buildSync({stdin:{contents:'export * from "./src/main/tasks/feed"; export * from "./src/shared/task-feed"; export * from "./src/renderer/task-data"; export * from "./src/shared/task-search";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
const loaded = new Module(path.resolve('tests/task-feed-bundle.cjs'), module); loaded.filename=loaded.id; loaded._compile(compiled.outputFiles[0].text,loaded.filename);
const {TaskListFeed,TaskDetailCursor,applyTaskListUpdate,applyTaskDetailUpdate,TaskData,findTaskHit} = loaded.exports;
const makeTask = id => ({id,title:id,profileId:'p',profileName:'Profile',status:'paused',createdAt:'2026-01-01',updatedAt:'2026-01-01',prompt:'prompt',events:[],items:[],receipts:[],plan:[],attachments:[],materials:[],usage:{elapsedMs:0},limits:{}});
function fixture() {
  const a=makeTask('a'),b=makeTask('b'),state={tasks:[a,b],metadata:{materials:[],attachments:[],schedules:[],templates:[],settings:{model:'model'}}};
  return {a,b,state,feed:new TaskListFeed(()=>state)};
}
const turn = () => new Promise(resolve=>setImmediate(resolve));

test('list reads and metadata notifications never touch any conversation history',()=>{
  const f=fixture();
  for (const task of f.state.tasks) for (const key of ['events','receipts','observation','evidencePages','prompt']) Object.defineProperty(task,key,{get(){throw Error('history read');},enumerable:true});
  const initial=f.feed.snapshot(); assert.equal(initial.tasks.length,2); assert.equal(initial.tasks[0].events,undefined);
  f.state.metadata.settings.model='new';
  const change=f.feed.update(new Set()); assert.deepEqual(change.tasks,[]); assert.equal(change.metadata.settings.model,'new');
  f.a.title='renamed'; assert.equal(f.feed.update(new Set(['a'])).tasks[0].title,'renamed');
  assert.equal(f.feed.update(new Set()),undefined,'no-op reads must not advance revisions');
});
test('list changes replay creates, deletes and metadata without mutating earlier snapshots',()=>{
  const f=fixture(), initial=f.feed.snapshot();
  f.state.tasks=[makeTask('c'),f.a]; f.a.title='new title';
  const delta=f.feed.update(new Set(['a','c'])),next=applyTaskListUpdate(initial,delta);
  assert.deepEqual(next.tasks.map(t=>t.id),['c','a']); assert.equal(initial.tasks[0].title,'a');
  assert.equal(next.tasks[1].title,'new title'); assert.deepEqual(delta.removed,['b']);
  assert.equal(applyTaskListUpdate(next,delta),next);
  assert.equal(applyTaskListUpdate(initial,{...delta,revision:delta.revision+1}),undefined);
});
test('token ledger notifications include only changed records and retain deleted-task totals',()=>{
  const f=fixture(); f.state.metadata.tokenRecords=[{taskId:'a',inputTokens:1,costRecords:[{id:'a-cost'}]},{taskId:'b',inputTokens:2,costRecords:[{id:'b-cost'}]}];
  const feed=new TaskListFeed(()=>f.state),initial=feed.snapshot();
  f.state.metadata.tokenRecords=[{...f.state.metadata.tokenRecords[0],inputTokens:3},f.state.metadata.tokenRecords[1]];
  const update=feed.update(new Set(['a'])); assert.equal(update.metadata.tokenRecords,undefined); assert.deepEqual(update.tokenRecords.updated.map(r=>r.taskId),['a']);
  const next=applyTaskListUpdate(initial,update); assert.equal(next.tokenRecords[0].inputTokens,3); assert.equal(initial.tokenRecords[0].inputTokens,1);
  f.state.tasks=[f.b]; const deletion=feed.update(new Set()); assert.equal(deletion.tokenRecords,undefined); assert.equal(feed.snapshot().tokenRecords.length,2);
});
test('detail append transfers only the new suffix, with immutable previous snapshots',()=>{
  const task=makeTask('a'),cursor=new TaskDetailCursor();
  task.events=Array.from({length:2000},(_,i)=>({id:String(i),text:'history'.repeat(100)}));
  let state=applyTaskDetailUpdate(undefined,cursor.read(task)); const prior=state;
  task.events.push({id:'new',text:'new response'}); task.status='completed';
  const delta=cursor.read(task,state.version); state=applyTaskDetailUpdate(state,delta);
  assert.equal(delta.task,undefined); assert.equal(delta.arrays.events.from,2000); assert.equal(delta.arrays.events.values.length,1);
  assert.ok(JSON.stringify(delta).length<500); assert.equal(state.task.events.length,2001); assert.equal(prior.task.events.length,2000);
  assert.equal(state.task.status,'completed');
});
test('detail patches support rewinds, edits, removed optional fields and array replacement',()=>{
  const task=makeTask('a'),cursor=new TaskDetailCursor(); task.events=[{id:'1',text:'one'},{id:'2',text:'two'}]; task.pending={kind:'question'};
  let state=applyTaskDetailUpdate(undefined,cursor.read(task));
  task.events[0].text='edited'; task.events.pop(); delete task.pending; task.plan=['new'];
  const delta=cursor.read(task,state.version); state=applyTaskDetailUpdate(state,delta);
  assert.deepEqual(state.task,task); assert.equal(delta.arrays.events.from,0); assert.ok(delta.removed.includes('pending'));
  assert.equal(applyTaskDetailUpdate({...state,version:0},delta),undefined);
  assert.ok(cursor.read(task,0).task,'unknown cursors receive a complete selected task');
});
test('switching detail cursors releases the previous task and never patches a different task',()=>{
  const cursor=new TaskDetailCursor(),a=makeTask('a'),b=makeTask('b');
  const first=cursor.read(a); const next=cursor.read(b,first.version); assert.equal(next.task.id,'b');
  const back=cursor.read(a,next.version); assert.equal(back.task.id,'a');
});
test('search covers historical messages, evidence and results with stable DOM targets',()=>{
  const task=makeTask('a'); task.events=[{id:'event',text:'archived message needle'}];
  task.evidencePages=[{title:'page',url:'https://example.test',snapshot:'evidence word'}]; task.result={summary:'answer',evidence:['verified'],remaining:[]};
  assert.equal(findTaskHit(task,'needle').id,'event-event'); assert.equal(findTaskHit(task,'evidence word').id,'task-evidence');
  assert.equal(findTaskHit(task,'verified').id,'task-result'); assert.equal(findTaskHit(task,'ＮＥＥＤＬＥ').id,'event-event');
});
function clientFixture() {
  const f=fixture(),cursor=new TaskDetailCursor(); let changed,stream,reads=0,lists=0;
  const api={list:async()=>{lists++;return f.feed.snapshot();},detail:async(id,version)=>{reads++;return cursor.read(f.state.tasks.find(t=>t.id===id),version);},onChanged:fn=>{changed=fn;return()=>{};},onStream:fn=>{stream=fn;return()=>{};}};
  const client=new TaskData(api,()=>{});
  return {...f,api,client,emit:ids=>changed(f.feed.update(new Set(ids))),send:value=>changed(value),stream:value=>stream(value),reads:()=>reads,lists:()=>lists};
}
test('renderer requests only selected task details and leaves other updates as summaries',async()=>{
  const f=clientFixture(); await f.client.refresh(); assert.equal(f.reads(),0);
  f.client.select('a'); await turn(); const reads=f.reads();
  f.b.events.push({id:'b-event',text:'private other history'}); f.emit(['b']); await turn(); assert.equal(f.reads(),reads);
  f.a.events.push({id:'a-event',text:'visible'}); f.emit(['a']); await turn(); assert.equal(f.client.get('a').events.length,1);
  assert.equal(f.client.get('b'),undefined); f.client.dispose();
});
test('rapid task switches discard stale responses and load the final selection',async()=>{
  const f=clientFixture(); await f.client.refresh(); let release;
  const real=f.api.detail; f.api.detail=(id,version)=>id==='a'?new Promise(resolve=>release=()=>real(id,version).then(resolve)):real(id,version);
  f.client.select('a'); f.client.select('b'); release(); await turn(); await turn();
  assert.equal(f.client.detail.task.id,'b'); assert.equal(f.client.get('a'),undefined); f.client.dispose();
});
test('coalesced background notifications trigger a list resync and fresh selected detail',async()=>{
  const f=clientFixture(); await f.client.refresh(); f.client.select('a'); await turn();
  f.a.events.push({id:'a-event',text:'background'}); f.feed.update(new Set(['a']));
  f.b.title='changed while hidden'; f.emit(['b']); await turn(); await turn();
  assert.equal(f.lists(),2); assert.equal(f.client.get('a').events.length,1); assert.equal(f.client.list.tasks[1].title,'changed while hidden'); f.client.dispose();
});
test('notifications racing the first list response are replayed in revision order',async()=>{
  const f=clientFixture(); const initial=f.feed.snapshot(); let release;
  f.api.list=()=>new Promise(resolve=>release=()=>resolve(initial)); const loading=f.client.refresh();
  f.a.title='new'; f.emit(['a']); release(); await loading;
  assert.equal(f.client.list.tasks[0].title,'new'); f.client.dispose();
});
test('selected stream stays live during detail reads and disappears after event commit',async()=>{
  const f=clientFixture(); await f.client.refresh(); f.client.select('a'); await turn();
  f.stream({taskId:'a',stream:{id:'s',text:'live',updatedAt:'2026-01-01'}}); assert.equal(f.client.stream.text,'live');
  f.a.events.push({id:'done',text:'live',streamId:'s'}); f.emit(['a']); await turn(); assert.equal(f.client.stream,undefined);
  f.stream({taskId:'a',stream:{id:'s',text:'late',updatedAt:'2026-01-02'}}); assert.equal(f.client.stream,undefined); f.client.dispose();
});
test('deleting a selected task clears its retained history',async()=>{
  const f=clientFixture(); await f.client.refresh(); f.client.select('a'); await turn();
  f.state.tasks=[f.b]; f.emit([]); assert.equal(f.client.detail,undefined); assert.equal(f.client.get('a'),undefined); f.client.dispose();
});
test('a failed detail request exposes its error and can be retried without losing list state',async()=>{
  const f=clientFixture(); await f.client.refresh(); const real=f.api.detail;
  f.api.detail=async()=>{throw Error('read failed');}; f.client.select('a'); await turn(); assert.match(f.client.error,/read failed/); assert.equal(f.client.list.tasks.length,2);
  f.api.detail=real; await f.client.refreshDetail(); assert.equal(f.client.error,''); assert.equal(f.client.get('a').id,'a'); f.client.dispose();
});
test('the production service publishes summaries without calling full snapshot or inspecting idle histories',async t=>{
  const fs=require('node:fs'),os=require('node:os');
  const {TaskStore}=require('../dist/main/tasks/store'),{TaskService}=require('../dist/main/tasks/service');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-feed-service-')); const store=new TaskStore(root),updates=[];
  const active=store.create({prompt:'active',profileId:'test'},'Test'),idle=store.create({prompt:'idle',profileId:'other'},'Other'); active.status=idle.status='completed';store.save();
  const service=new TaskService(store,{browser:{},apiKey:()=>'',notify:()=>{},changed:update=>updates.push(update)});
  const original=Object.getOwnPropertyDescriptor(idle,'events');
  t.after(async()=>{Object.defineProperty(idle,'events',original);await service.close();fs.rmSync(root,{recursive:true,force:true});});
  store.snapshot=()=>{throw Error('full snapshot requested');};
  Object.defineProperty(idle,'events',{get(){throw Error('idle history inspected');},configurable:true,enumerable:true});
  store.event(active,'assistant','new answer');service.publish(active);await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(updates.length,1);assert.deepEqual(updates[0].tasks.map(task=>task.id),[active.id]);assert.equal(updates[0].tasks[0].events,undefined);
  store.data.settings.notifications=false;service.publish([]);await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(updates[1].tasks,[]);assert.equal(updates[1].metadata.settings.notifications,false);assert.equal(service.list().tasks.length,2);
});
