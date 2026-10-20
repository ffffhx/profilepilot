const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { crc32, deflateSync } = require('node:zlib');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { Adb } = loadCli('src/main/phones/adb.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function harness(t, appPhase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-basic-'));
  const chunk = (type, data) => {
    const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);
    b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1080);header.writeUInt32BE(2400,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((1080*4+1)*2400))),chunk('IEND',Buffer.alloc(0))]);
  const h = { root, id:'SERIAL-1', calls:[], online:true, now:1000, png, inputHook:null, screenshotHook:null };
  if (appPhase) fs.writeFileSync(path.join(root,'devices.json'),JSON.stringify({[h.id]:{token:'a'.repeat(64)}}));
  h.appState={protocol:1,instanceId:'app-instance',sessionId:appPhase==='idle'?null:'app-session',generation:1,phase:appPhase||'idle',mode:'control',computer:'pc',controller:'Existing',task:'Existing task',startedAt:1000,lastAction:'',permissions:{overlay:true,notifications:true,accessibility:true}};
  const adb = { run: async args => {
    h.calls.push(args); if (args[0] === 'devices') return h.online ? `${h.id} device model:Test` : '';
    if (args.includes('tcp:0')) return '18762';
    if (args[2] === 'shell' && args[3].startsWith("'input'")) return h.inputHook ? h.inputHook(args) : '';
    return '';
  }, runBinary: async args => { h.calls.push(args); return h.screenshotHook ? h.screenshotHook() : h.png; } };
  h.service = new PhonesService({root, apkPath:path.join(root,'phone.apk'), adb, now:()=>h.now, request:async(_port,_token,method)=>{
    if (method==='pause'||method==='stop') {h.appState.phase=method==='pause'?'paused':'stopped';h.appState.generation++;}
    return {ok:true,state:structuredClone(h.appState)};
  }});
  h.state = () => h.service.snapshot().devices.find(d=>d.id===h.id).basic;
  h.start = (mode='control') => h.service.basicStart(h.id,mode,'Test','basic test');
  h.action = (action, overrides={}) => { const state = h.state(); return h.service.basicPerform({id:h.id,sessionId:state.sessionId,generation:state.generation,requestId:randomUUID(),action,...overrides}); };
  t.after(async()=>{await h.service.close();fs.rmSync(root,{recursive:true,force:true});}); return h;
}

test('basic control works without a paired companion and never installs/launches an APK', async t=>{
  const h=harness(t), started=await h.start();
  assert.equal(started.companion,'unknown'); assert.equal(started.state,null); assert.equal(started.basic.phase,'controlling');
  await assert.rejects(h.action({kind:'tap',x:1,y:2}),/先刷新/);
  const shot=await h.action({kind:'screenshot'}); assert.equal(shot.result.mime,'image/png'); assert.equal(shot.result.width,1080);
  await h.action({kind:'tap',x:10,y:20});
  assert.ok(h.calls.some(a=>a[3]==="'input' 'tap' '10' '20'"));
  await assert.rejects(h.action({kind:'tap',x:1,y:2}),/先刷新/);
  assert.equal(h.calls.some(a=>a.includes('install') || a.includes('forward') || a.join(' ').includes("'am' 'start'")),false);
  assert.equal(fs.existsSync(path.join(h.root,'devices.json')),false);
});

test('sidebar screen reads without starting a session, installing an App, or authorizing input', async t=>{
  const h=harness(t);await h.service.refresh();
  const before=h.service.snapshot().devices[0];
  const screen=await h.service.screen(h.id);
  assert.equal(screen.width,1080);assert.equal(screen.height,2400);assert.equal(screen.capturedAt,h.now);
  assert.equal(screen.base64,h.png.toString('base64'));
  assert.deepEqual(h.service.snapshot().devices[0],before);
  assert.equal(h.calls.some(a=>a.includes('install')||a.includes('forward')||a.join(' ').includes("'am' 'start'")),false);
  await h.start();await h.service.screen(h.id);
  await assert.rejects(h.action({kind:'tap',x:10,y:20}),/先刷新/,'passive screen is not an input frame');
});

test('sidebar captures preserve active App sessions and respect a newly reported pause', async t=>{
  const h=harness(t,'idle');await h.service.refresh();
  Object.assign(h.appState,{phase:'controlling',sessionId:'existing-task',generation:2});await h.service.refresh();
  const before=structuredClone(h.appState);await h.service.screen(h.id);assert.deepEqual(h.appState,before);
  h.appState.phase='paused';h.appState.generation++;
  const captures=h.calls.filter(a=>a.includes('screencap')).length;
  await assert.rejects(h.service.screen(h.id),/暂停/);
  assert.equal(h.calls.filter(a=>a.includes('screencap')).length,captures,'fresh pause prevents screenshot transport');
});

test('sidebar rejects overlapping, stale, disconnected and invalid captures', async t=>{
  const h=harness(t);await h.start();let release;
  h.screenshotHook=()=>new Promise(resolve=>release=resolve);
  const first=h.service.screen(h.id);
  await assert.rejects(h.service.screen(h.id),/正在获取/);
  h.service.basicControl(h.id,'pause');release(h.png);await assert.rejects(first,/暂停/);
  h.service.basicControl(h.id,'resume');
  const second=h.service.screen(h.id);h.online=false;await h.service.refresh();release(h.png);await assert.rejects(second);
  h.online=true;await h.service.refresh();h.service.basicControl(h.id,'stop');
  h.screenshotHook=null;h.png=Buffer.from('not a screen');
  await assert.rejects(h.service.screen(h.id),/有效画面/);
});

test('basic view, bounds, freshness and unsupported input restrictions are enforced in service', async t=>{
  const h=harness(t);await h.start('view');await h.action({kind:'screenshot'});
  await assert.rejects(h.action({kind:'key',key:'home'}),/仅查看/);
  h.service.basicControl(h.id,'stop');await h.start();await h.action({kind:'screenshot'});
  await assert.rejects(h.action({kind:'swipe',x:0,y:0,toX:1080,toY:1}),/超出/);
  h.now+=30001;await assert.rejects(h.action({kind:'tap',x:1,y:1}),/刷新/);
  await assert.rejects(h.action({kind:'text',text:'中文'}),/中文/);
  await assert.rejects(h.action({kind:'text',text:'literal%s'}),/基础英文/);
  await assert.rejects(h.action({kind:'find',selector:{text:'OK'}}),/控件识别/);
  await h.action({kind:'text',text:"a b'$(echo injected)"});
  assert.ok(h.calls.at(-1)[3].includes("'input' 'text' 'a%sb'\\''$(echo%sinjected)'"));
});

test('pause, resume, duplicate IDs and disconnect never replay old input', async t=>{
  const h=harness(t);await h.start();const generation=h.state().generation,requestId=randomUUID();
  await h.action({kind:'key',key:'back'},{requestId});
  await assert.rejects(h.action({kind:'key',key:'back'},{requestId}),/重复执行/);
  h.service.basicControl(h.id,'pause');await assert.rejects(h.action({kind:'key',key:'home'}),/暂停/);
  h.service.basicControl(h.id,'resume');await assert.rejects(h.action({kind:'key',key:'home'},{generation}),/已改变/);
  h.online=false;await h.service.refresh();assert.equal(h.state().phase,'disconnected');
  h.online=true;await h.service.refresh();assert.throws(()=>h.service.basicControl(h.id,'resume'),/断线/);
  await assert.rejects(h.action({kind:'key',key:'home'}),/断开/);
  assert.equal(h.calls.filter(a=>a[3]?.startsWith("'input'")).length,1);
});

test('mode switching retains the session, revokes old frames and enforces view-only input', async t=>{
  const h=harness(t);await h.start('view');
  const original=h.state();
  const switchMode=(mode,overrides={})=>h.service.basicSetMode({id:h.id,sessionId:h.state().sessionId,generation:h.state().generation,mode,...overrides});
  await h.action({kind:'screenshot'});
  switchMode('control');
  assert.equal(h.state().sessionId,original.sessionId);
  assert.equal(h.state().phase,'controlling');
  assert.ok(h.state().generation>original.generation);
  await assert.rejects(h.action({kind:'tap',x:10,y:20}),/先刷新/);
  await h.action({kind:'screenshot'});await h.action({kind:'tap',x:10,y:20});
  switchMode('view');
  assert.equal(h.state().phase,'viewing');
  await assert.rejects(h.action({kind:'key',key:'home'}),/仅查看/);
  assert.throws(()=>switchMode('control',{generation:original.generation}),/已改变/);
  h.service.basicControl(h.id,'pause');switchMode('view');assert.equal(h.state().phase,'viewing');
  h.service.basicControl(h.id,'stop');assert.throws(()=>switchMode('control'),/结束或断开/);
  await h.start('view');assert.throws(()=>switchMode('control',{sessionId:original.sessionId}),/已改变/);
  h.online=false;await h.service.refresh();assert.throws(()=>switchMode('control'));
});

test('a mode change discards pending captures and never replays in-flight input', async t=>{
  const h=harness(t);await h.start();
  const switchMode=mode=>h.service.basicSetMode({id:h.id,sessionId:h.state().sessionId,generation:h.state().generation,mode});
  let release;
  h.screenshotHook=()=>new Promise(resolve=>release=resolve);
  const capture=h.action({kind:'screenshot'});switchMode('view');release(h.png);
  await assert.rejects(capture,/已改变/);
  switchMode('control');h.screenshotHook=null;
  await assert.rejects(h.action({kind:'tap',x:10,y:20}),/先刷新/);
  h.inputHook=()=>new Promise(resolve=>release=resolve);
  const input=h.action({kind:'key',key:'home'});switchMode('view');release('');
  await assert.rejects(input,/已改变/);
  assert.equal(h.state().phase,'viewing');
  assert.equal(h.calls.filter(a=>a[3]?.startsWith("'input'")).length,1);
});

test('late screenshots after pause are discarded and uncertain inputs pause control', async t=>{
  const h=harness(t);await h.start();let release;
  h.screenshotHook=()=>new Promise(r=>release=r);
  const pending=h.action({kind:'screenshot'});h.service.basicControl(h.id,'pause');release(h.png);
  await assert.rejects(pending,/已改变/);assert.equal(h.state().phase,'paused');
  h.service.basicControl(h.id,'resume');h.inputHook=()=>{throw new Error('uncertain timeout');};
  await assert.rejects(h.action({kind:'key',key:'home'}),/uncertain/);assert.equal(h.state().phase,'paused');
  assert.equal(h.calls.filter(a=>a[3]?.startsWith("'input'")).length,1);
});

test('App setup and control cannot run over an active basic session; stop allows setup', async t=>{
  const h=harness(t);await h.start();
  await assert.rejects(h.service.prepare(h.id),/先结束免安装/);
  await assert.rejects(h.service.start(h.id,'control','Other','task'),/先结束免安装/);
  await assert.rejects(h.service.preview(h.id),/先结束免安装/);
  h.service.basicControl(h.id,'stop');
  await assert.rejects(h.service.prepare(h.id),/缺少手机配套安装包/);
});

test('invalid screenshot bytes never enable coordinate input',async t=>{
  const h=harness(t);await h.start();await h.action({kind:'screenshot'});h.png=Buffer.from('permission denied');
  await assert.rejects(h.action({kind:'screenshot'}),/有效画面/);
  await assert.rejects(h.action({kind:'tap',x:1,y:1}),/刷新/);
});

test('basic mode cannot bypass a paused App session, including after polling',async t=>{
  const h=harness(t,'paused');await assert.rejects(h.start(),/先结束已有/);
  assert.equal(h.state(),undefined);assert.equal(h.appState.phase,'paused');
  assert.equal(h.calls.some(a=>a.includes('exec-out')||a[3]?.startsWith("'input'")),false);
});

test('a newly observed App session revokes basic control before further input',async t=>{
  const h=harness(t,'idle');await h.start();h.appState.phase='controlling';h.appState.sessionId='new-owner';
  await h.service.refresh();assert.equal(h.state().phase,'disconnected');
  await assert.rejects(h.action({kind:'key',key:'home'}),/断开/);
});

test('binary process output preserves PNG bytes on Windows and macOS paths',async t=>{
  const h=harness(t), file=path.join(h.root,'binary output.cjs');
  fs.writeFileSync(file,`process.stdout.write(Buffer.from(${JSON.stringify([...h.png,0,255,128,13,10])}));`);
  const result=await new Adb(process.execPath).runBinary([file]);assert.deepEqual(result,Buffer.concat([h.png,Buffer.from([0,255,128,13,10])]));
});

test('CLI requires explicit basic backend and dispatches lifecycle without installing',async()=>{
  const calls=[],io={stdout:{write(){}},stderr:{write(){}}};
  const request=async c=>{calls.push(c);return {ok:true,data:{}};};
  assert.equal(await runPhoneCli(['start','--device','SERIAL-1','--backend','basic'],request,io),0);
  assert.equal(calls[0].method,'basic-start');
  assert.equal(await runPhoneCli(['stop','--device','SERIAL-1','--backend','basic'],request,io),0);
  assert.equal(calls[1].method,'basic-stop');
  assert.equal(await runPhoneCli(['connect','--device','SERIAL-1','--backend','basic'],request,io),1);
  assert.equal(await runPhoneCli(['start','--device','SERIAL-1','--backend','other'],request,io),1);
});

test('basic following uses fresh screenshots and bounded strokes, rejects replay and stops on pause',async t=>{
  const h=harness(t);
  const {lease,device}=await h.service.startWrapper(h.id,'control','Test','follow','basic');
  const generation=device.state.generation;
  const live=command=>h.service.followLive(lease,generation,command);
  const touch={op:'touch',sequence:1,ttlMs:1200,points:[{id:0,fromX:100,fromY:200,x:150,y:250}]};
  assert.equal((await live({op:'probe'})).maxStrokeMs,350);
  await assert.rejects(live(touch),/先刷新/);
  await live({op:'frame'});
  await live({...touch,sequence:2});
  assert.ok(h.calls.some(a=>a[3]==="'input' 'swipe' '100' '200' '150' '250' '350'"));
  await assert.rejects(live({...touch,sequence:2}),/重复执行/);
  await assert.rejects(live({...touch,sequence:3}),/先刷新/);
  await live({op:'touch',sequence:4,ttlMs:1200,points:[]});
  assert.equal(h.calls.filter(a=>a[3]?.startsWith("'input'")).length,1);
  h.service.basicControl(h.id,'pause');
  await assert.rejects(live({op:'frame'}),/暂停/);
  await assert.rejects(live({...touch,sequence:5}),/暂停/);
  await h.service.stopWrapper(lease);
  assert.equal(h.state().phase,'stopped');
});

test('basic observe never sends touches and stale wrapper generations cannot control',async t=>{
  const h=harness(t);
  const {lease,device}=await h.service.startWrapper(h.id,'view','Test','observe','basic');
  await h.service.followLive(lease,device.state.generation,{op:'frame'});
  await assert.rejects(h.service.followLive(lease,device.state.generation,{op:'touch',sequence:1,ttlMs:1200,points:[]}),/仅查看/);
  h.service.basicSetMode({id:h.id,sessionId:h.state().sessionId,generation:h.state().generation,mode:'control'});
  await assert.rejects(h.service.followLive(lease,device.state.generation,{op:'frame'}),/会话/);
  assert.equal(h.calls.filter(a=>a[3]?.startsWith("'input'")).length,0);
  await h.service.stopWrapper(lease);
});
