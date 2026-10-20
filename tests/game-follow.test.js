const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadCli } = require('./cli-test-build.cjs');
const { GameFollower, gameFollowConfigSchema } = loadCli('src/main/phones/game-follow.ts');
const { runGameFollowCli } = loadCli('src/main/phones/game-follow-cli.ts');
const python = process.env.PROFILEPILOT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let fixture;
try { fixture = JSON.parse(execFileSync(python, ['tests/game-follow-vision.py', '--fixture'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
const vision = fixture ? {} : { skip: 'Python/OpenCV not installed; run tests/game-follow-vision.py in the vision environment' };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 80; i++) { if (await fn()) return; await wait(75); } throw Error('condition timed out'); }

test('validates map, dimensions, obstacles, and joystick extent before starting', vision, () => {
  assert.ok(gameFollowConfigSchema.safeParse(fixture.config).success);
  for (const patch of [{ width: Infinity }, { map: {...fixture.config.map,x:.9} },
    { joystick: {...fixture.config.joystick,x:0} }, { grid: {...fixture.config.grid,blocked:[1600]} },
    { confidence:.1 }, { intervalMs:10 }]) assert.equal(gameFollowConfigSchema.safeParse({...fixture.config,...patch}).success,false);
});
test('OpenCV finds image targets, routes around obstacles and rejects ambiguous frames', vision, () => {
  execFileSync(python, ['tests/game-follow-vision.py'], { windowsHide: true, stdio: 'pipe' });
});
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'pp-follow-'));
  let generation = 3, stopped = 0, captures = 0, phase = 'controlling';
  const points = [];
  const host = {
    startWrapper: async (_,mode) => { phase = mode === 'view' ? 'viewing':'controlling'; return { lease:randomUUID(),device:{state:{generation}} }; },
    pulseWrapper: () => ({state:{generation,phase}}),
    stopWrapper: async () => { stopped++; phase='stopped'; },
    live: async (_,expected,command) => {
      assert.equal(expected,3);
      if (command.op==='probe') return {protocol:1};
      if (command.op==='frame') { captures++; if(options.fail && captures===3) throw Error('device lost'); if(options.delay)await wait(options.delay); return options.frame || fixture.frame; }
      points.push(command); return {accepted:true};
    }
  };
  const manager = new GameFollower(root, host);
  manager.script = path.resolve('public/vision/game_follower.py');
  t.after(async()=>{await manager.close();fs.rmSync(root,{recursive:true,force:true});});
  return { manager, host, points, pause:()=>{generation++;phase='paused';}, stopped:()=>stopped, captures:()=>captures };
}
test('observe runs real vision without sending touch, and stops its own lease once', vision, async t => {
  const h=harness(t);
  const started=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await until(async()=> (await h.manager.command({op:'status'})).frames>=2);
  await h.manager.command({op:'stop',runId:started.runId});
  assert.equal(h.points.length,0);assert.equal(h.stopped(),1);
  assert.equal((await h.manager.command({op:'status'})).running,false);
});
test('control confirms target first, sends bounded strokes, and cannot replay after pause', vision, async t => {
  const h=harness(t);
  await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  await until(()=>h.points.length>=2);
  assert.deepEqual(h.points[0].points,[]);assert.equal(h.points[1].points.length,1);
  assert.ok(h.points.every((p,i)=>p.sequence===i+1 && p.ttlMs<=1500));
  h.pause();
  await until(async()=> !(await h.manager.command({op:'status'})).running);
  const count=h.points.length;await wait(450);assert.equal(h.points.length,count);assert.equal(h.stopped(),1);
});
test('capture failure stops, stale stop IDs cannot stop another run', vision, async t => {
  const h=harness(t,{fail:true});
  const state=await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  await assert.rejects(h.manager.command({op:'stop',runId:randomUUID()}),/已改变/);
  await until(async()=> !(await h.manager.command({op:'status'})).running);
  assert.match((await h.manager.command({op:'status'})).error,/device lost/);
  assert.equal(h.stopped(),1);assert.ok(state.runId);
});
test('closing during startup releases a late lease before close resolves', vision, async t => {
  const h=harness(t);
  let release, entered=false;
  const pending=new Promise(resolve=>release=resolve);
  const start=h.host.startWrapper;
  h.host.startWrapper=async(...args)=>{entered=true;await pending;return start(...args);};
  const starting=h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  const rejected=assert.rejects(starting,/已停止/);
  await until(()=>entered);
  let closed=false;const closing=h.manager.close().then(()=>closed=true);
  await wait(50);assert.equal(closed,false);
  release();await rejected;await closing;
  assert.equal(h.stopped(),1);assert.equal(h.captures(),0);
});
test('screen rotation or a scaled capture stops before sending physical touches', vision, async t => {
  const h=harness(t,{frame:{...fixture.frame,width:1280,height:720}});
  await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  await until(async()=>!(await h.manager.command({op:'status'})).running);
  assert.match((await h.manager.command({op:'status'})).error,/分辨率/);
  assert.equal(h.points.length,0);assert.equal(h.stopped(),1);
});
test('CLI defaults to observation and validates before requesting a phone', vision, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-follow-cli-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'校准 config.json');fs.writeFileSync(file,'\ufeff'+JSON.stringify(fixture.config));
  const calls=[];const io={stdout:{write(){}},stderr:{write(){}}};
  const request=async c=>{calls.push(c);return {ok:true,data:{}};};
  assert.equal(await runGameFollowCli(['start','--device','phone','--config',file],request,io),0);
  assert.equal(calls[0].params.mode,'observe');
  assert.equal(calls[0].params.backend,'app');
  assert.equal(await runGameFollowCli(['stop','--run-id','bad'],request,io),1);assert.equal(calls.length,1);
  assert.equal(await runGameFollowCli(['start','--device','phone','--config',file,'--backend','basic'],request,io),0);
  assert.equal(calls[1].params.backend,'basic');
  assert.equal(await runGameFollowCli(['start','--device','phone','--config',file,'--backend','automatic'],request,io),1);
  assert.equal(calls.length,2);
});

test('basic backend is explicitly carried to the owned wrapper and reported in status',vision,async t=>{
  const h=harness(t),start=h.host.startWrapper;let backend;
  h.host.startWrapper=async(...args)=>{backend=args[4];return start(...args);};
  const state=await h.manager.command({op:'start',id:'emulator',mode:'observe',backend:'basic',config:fixture.config});
  assert.equal(backend,'basic');assert.equal(state.backend,'basic');
  await until(async()=> (await h.manager.command({op:'status'})).frames>=1);
  await h.manager.command({op:'stop',runId:state.runId});
  assert.equal(h.points.length,0);assert.equal(h.stopped(),1);
});

test('basic follow permits slow emulator captures while retaining bounded touch requests',vision,async t=>{
  const h=harness(t,{delay:1100});
  const state=await h.manager.command({op:'start',id:'emulator',mode:'control',backend:'basic',config:fixture.config});
  await until(()=>h.points.length>=2);
  assert.deepEqual(h.points[0].points,[]);assert.equal(h.points[1].points.length,1);
  await h.manager.command({op:'stop',runId:state.runId});
  assert.equal(h.stopped(),1);
});
test('management carries calibration images above 1 MiB while keeping ordinary requests bounded', vision, async t => {
  const { startProfilePilotManagementServer }=require('../dist/main/profilepilot-management-server');
  const { requestProfilePilotManagement }=require('../dist/main/profilepilot-cli');
  const h=harness(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-fm-'));
  const env={PROFILEPILOT_MANAGEMENT_ROOT:root};
  const server=await startProfilePilotManagementServer({profileManager:{},homeDir:root,env,getPhoneService:()=>({gameFollower:h.manager})});
  t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true});});
  const config={...fixture.config,selfTemplate:'A'.repeat(1_100_000)};
  const response=await requestProfilePilotManagement({action:'phone',method:'follow-command',params:{op:'save',config}},root,env);
  assert.equal(response.ok,true);assert.equal(response.data.selfTemplate.length,1_100_000);
  const loaded=await requestProfilePilotManagement({action:'phone',method:'follow-command',params:{op:'load'}},root,env);
  assert.equal(loaded.data.selfTemplate,config.selfTemplate);
  const oversized=await requestProfilePilotManagement({action:'ping',padding:'a'.repeat(1_100_000)},root,env);
  assert.equal(oversized.error.code,'MANAGEMENT_REQUEST_TOO_LARGE');
});
