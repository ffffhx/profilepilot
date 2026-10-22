const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadCli } = require('./cli-test-build.cjs');
const { GameFollower, gameFollowConfigSchema, followCommandSchema, assembleScreenshot } = loadCli('tests/fixtures/game-follow-entry.ts');
const { runGameFollowCli } = loadCli('src/main/phones/game-follow-cli.ts');
const python = process.env.PROFILEPILOT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let fixture;
try { fixture = JSON.parse(execFileSync(python, ['tests/game-follow-vision.py', '--fixture'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
const vision = fixture ? {} : { skip: 'Python/OpenCV not installed; run tests/game-follow-vision.py in the vision environment' };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeoutMs = 6000) { const deadline=Date.now()+timeoutMs; while(Date.now()<deadline) { if (await fn()) return; await wait(75); } throw Error('condition timed out'); }

test('validates map, dimensions, obstacles, and joystick extent before starting', vision, () => {
  assert.ok(gameFollowConfigSchema.safeParse(fixture.config).success);
  for (const capture of ['auto','full']) assert.equal(gameFollowConfigSchema.parse({...fixture.config,capture}).capture,capture);
  for (const patch of [{ width: Infinity }, { map: {...fixture.config.map,x:.9} },
    { joystick: {...fixture.config.joystick,x:0} }, { grid: {...fixture.config.grid,blocked:[1600]} },
    { confidence:.1 }, { intervalMs:10 }, { capture:'scaled' }, { capture:true }]) assert.equal(gameFollowConfigSchema.safeParse({...fixture.config,...patch}).success,false);
});

test('partial target recognition is opt-in and requires bounded ring and living-HUD calibration', vision, () => {
  assert.equal(gameFollowConfigSchema.parse(fixture.config).targetPartial, undefined);
  const config = fixture.partialConfig, partial = config.targetPartial;
  assert.deepEqual(gameFollowConfigSchema.parse(config).targetPartial, partial);
  for (const targetPartial of [true, {}, { ring: partial.ring }, { ...partial, confidence: .6 },
    { ...partial, ring: { ...partial.ring, radiusPixels: 0 } },
    { ...partial, ring: { ...partial.ring, hueMin: 131, hueMax: 130 } },
    { ...partial, ring: { ...partial.ring, valueMin: 0 } },
    { ...partial, alive: { ...partial.alive, portraitTemplate: '' } },
    { ...partial, alive: { ...partial.alive, portraitTemplate: 'A'.repeat(256004) } },
    { ...partial, alive: { ...partial.alive, portraitRegion: { x: .99, y: 0, width: .1, height: .1 } } },
    { ...partial, alive: { ...partial.alive, healthBarRegion: { x: 0, y: 0, width: 0, height: .1 } } }])
    assert.equal(gameFollowConfigSchema.safeParse({ ...config, targetPartial }).success, false);
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
    syncWrapper: async () => ({state:{generation,phase}}),
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

async function chunkedFrame(delayMs) {
  const state = { instanceId: 'fixture', sessionId: 'session', generation: 3, phase: 'controlling' };
  const { base64, ...image } = fixture.frame, id = randomUUID(), chunkSize = 48 * 1024;
  const response = await assembleScreenshot({ state, result: { ...image,
    transfer: { protocol: 1, id, length: base64.length, chunkSize, ttlMs: 15000 } } }, state,
  async ({ offset }) => {
    if (offset === 0) await wait(delayMs);
    return { state, result: { id, offset, base64: base64.slice(offset, offset + chunkSize), done: offset + chunkSize >= base64.length } };
  }, () => true);
  return response.result;
}
test('observe runs real vision without sending touch, and stops its own lease once', vision, async t => {
  const h=harness(t);
  const live=h.host.live, requests=[];
  h.host.live=(...args)=>{if(args[2].op==='frame')requests.push(args[2]);return live(...args);};
  const started=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await until(async()=> (await h.manager.command({op:'status'})).frames>=2);
  await h.manager.command({op:'stop',runId:started.runId});
  assert.equal(h.points.length,0);assert.equal(h.stopped(),1);
  assert.equal((await h.manager.command({op:'status'})).running,false);
  assert.deepEqual(requests[0].region,{x:0,y:0,width:200,height:200});
  assert.equal((await h.manager.command({op:'status'})).frame.region,undefined,'old companions may still return full frames');
});

test('opt-in recovery discards uncertain touch and requires two freshly captured frames', vision, async t => {
  const h = harness(t), original = h.host.live, calls = []; let recoveries = 0;
  h.host.live = async (...args) => {
    const command = args[2]; calls.push(structuredClone(command));
    if (command.op === 'touch' && command.sequence === 2) throw new Error('TLS transport lost');
    if (command.op === 'frame') return chunkedFrame(80);
    return original(...args);
  };
  h.host.recoverWrapper = async () => { recoveries++; return { state: { generation: 3, phase: 'controlling' } }; };
  const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'control', recoverTransport: true, config: { ...fixture.config, capture: 'full' } });
  await until(() => h.points.some(command => command.sequence >= 4 && command.points.length));
  await h.manager.command({ op: 'stop', runId: started.runId });
  const failed = calls.findIndex(command => command.op === 'touch' && command.sequence === 2);
  assert.equal(calls[failed].points.length, 1);
  assert.equal(calls[failed + 1].op, 'frame');
  assert.deepEqual(calls[failed + 2].points, []);
  assert.equal(calls[failed + 2].sequence, 3);
  assert.equal(calls[failed + 3].op, 'frame');
  assert.equal(calls[failed + 4].points.length, 1);
  assert.equal(calls[failed + 4].sequence, 4);
  assert.equal(calls.filter(command => command.op === 'touch' && command.sequence === 2).length, 1);
  assert.equal(recoveries, 1); assert.equal((await h.manager.command({ op: 'status' })).recoveries, 1);
  assert.ok(calls.filter(command => command.op === 'touch').every(command => command.ttlMs === 1200));
});

test('stop during an opted-in reconnect never captures or touches after late recovery', vision, async t => {
  const h = harness(t, { fail: true }); let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  h.host.recoverWrapper = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'control', recoverTransport: true, config: fixture.config });
  await arrived;
  const count = h.points.length, captures = h.captures();
  const stopped = h.manager.command({ op: 'stop', runId: started.runId });
  release({ state: { generation: 3, phase: 'controlling' } }); await stopped;
  assert.equal(h.points.length, count); assert.equal(h.captures(), captures);
  assert.equal((await h.manager.command({ op: 'status' })).running, false);
});

test('heartbeat recovery discards a frame already in flight before reconfirming movement', vision, async t => {
  const h = harness(t), original = h.host.live, calls = []; let captures = 0, release, entered;
  const heldFrame = new Promise(resolve => { entered = resolve; });
  h.host.live = async (...args) => {
    const command = args[2]; calls.push(structuredClone(command));
    if (command.op === 'frame' && ++captures === 3) {
      entered(); return new Promise(resolve => { release = resolve; });
    }
    return original(...args);
  };
  let heartbeats = 0;
  h.host.syncWrapper = async () => {
    if (++heartbeats === 1) { await heldFrame; throw new Error('heartbeat transport lost'); }
    return { state: { generation: 3, phase: 'controlling' } };
  };
  h.host.recoverWrapper = async () => ({ state: { generation: 3, phase: 'controlling' } });
  const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'control', recoverTransport: true, config: fixture.config });
  await until(async () => (await h.manager.command({ op: 'status' })).recoveries === 1);
  const gap = calls.length;
  release(fixture.frame);
  await until(() => h.points.some(command => command.sequence >= 4 && command.points.length));
  await h.manager.command({ op: 'stop', runId: started.runId });
  assert.equal(calls[gap].op, 'frame', 'the pending old frame must not produce a decision');
  assert.equal(calls[gap + 1].sequence, 3); assert.deepEqual(calls[gap + 1].points, []);
  assert.equal(calls[gap + 2].op, 'frame'); assert.equal(calls[gap + 3].points.length, 1);
  assert.equal((await h.manager.command({ op: 'status' })).error, '');
});

test('native region frames retain screen dimensions through live vision and preview analysis', vision, async t => {
  const region={x:0,y:0,width:200,height:200};
  const base64=execFileSync(python,['-c',
    'import sys,json,base64,cv2,numpy as np; v=json.load(sys.stdin); im=cv2.imdecode(np.frombuffer(base64.b64decode(v["base64"]),np.uint8),cv2.IMREAD_COLOR); print(base64.b64encode(cv2.imencode(".png",im[:200,:200])[1]).decode())'],
    {input:JSON.stringify(fixture.frame),encoding:'utf8',windowsHide:true}).trim();
  const cropped={...fixture.frame,base64,region};
  const h=harness(t,{frame:cropped});
  const started=await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  await until(async()=>{const s=await h.manager.command({op:'status'});return s.frames>=2||!s.running;});
  const status=await h.manager.command({op:'status'});
  assert.equal(status.error,''); assert.equal(status.frame.width,fixture.config.width);
  assert.deepEqual(status.frame.region,region); assert.ok(status.analysis.self); assert.ok(status.analysis.target);
  await until(()=>h.points.length>=2);
  assert.equal(h.points[1].points.length,1);
  await h.manager.command({op:'stop',runId:started.runId});
  const preview=await h.manager.command({op:'analyze',config:fixture.config,frame:cropped});
  assert.ok(preview.self); assert.ok(preview.target);
});

test('full capture preserves native screen pixels while analyzing the configured minimap', vision, async t => {
  const h=harness(t), requests=[], live=h.host.live, analyses=[];
  h.host.live=(...args)=>{if(args[2].op==='frame')requests.push(args[2]);return live(...args);};
  for (const capture of ['auto','full']) {
    requests.length=0;
    const config={...fixture.config,capture};
    const started=await h.manager.command({op:'start',id:'phone',mode:'observe',config});
    await until(async()=>{const s=await h.manager.command({op:'status'});return s.frames>=2||!s.running;});
    const status=await h.manager.command({op:'status'});
    assert.equal(status.error,''); assert.ok(status.frames>=2);
    assert.deepEqual(requests[0].region,capture==='auto'?{x:0,y:0,width:200,height:200}:undefined);
    assert.equal(status.frame.width,fixture.config.width); assert.equal(status.frame.height,fixture.config.height);
    assert.equal(status.frame.base64,fixture.frame.base64); assert.equal(status.frame.region,undefined);
    const {elapsedMs,...analysis}=status.analysis;
    analyses.push(analysis);
    await h.manager.command({op:'stop',runId:started.runId});
  }
  assert.deepEqual(analyses[1],analyses[0],'capture mode does not enlarge the vision map or change coordinates');
  assert.ok(analyses[1].self); assert.ok(analyses[1].target); assert.ok(analyses[1].direction);
  assert.equal(h.points.length,0);
});

test('region requests include half-pixel crop boundaries and nearby recognition retains full frames', vision, async t => {
  const h=harness(t), requests=[], live=h.host.live;
  h.host.live=(...args)=>{if(args[2].op==='frame')requests.push(args[2]);return live(...args);};
  const config={...fixture.config,map:{x:35.5/640,y:35.5/360,width:21.5/640,height:21.5/360}};
  const first=await h.manager.command({op:'start',id:'phone',mode:'observe',config});
  await until(()=>requests.length>0);
  assert.deepEqual(requests[0].region,{x:35,y:35,width:23,height:23});
  await h.manager.command({op:'stop',runId:first.runId});
  requests.length=0;
  const nearby={selfLabel:fixture.config.selfTemplate,targetLabel:fixture.config.targetTemplate,
    region:{x:0,y:0,width:1,height:1},pixelsPerMapUnit:600};
  const next=await h.manager.command({op:'start',id:'phone',mode:'observe',config:{...fixture.config,nearby}});
  await until(()=>requests.length>0);
  assert.equal(requests[0].region,undefined);
  await h.manager.command({op:'stop',runId:next.runId});
  requests.length=0;
  const basic=await h.manager.command({op:'start',id:'phone',mode:'observe',backend:'basic',config:fixture.config});
  await until(()=>requests.length>0);
  assert.equal(requests[0].region,undefined);
  await h.manager.command({op:'stop',runId:basic.runId});
});

test('opt-in partial identity captures the full living HUD and exposes its current target source', vision, async t => {
  const h = harness(t, { frame: fixture.partialFrame }), requests = [], live = h.host.live;
  h.host.live = (...args) => { if (args[2].op === 'frame') requests.push(args[2]); return live(...args); };
  const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'observe', config: fixture.partialConfig });
  await until(async () => (await h.manager.command({ op: 'status' })).analysis?.targetSource === 'partial');
  const result = await h.manager.command({ op: 'status' });
  await h.manager.command({ op: 'stop', runId: started.runId });
  assert.equal(result.error, '');
  assert.ok(result.frames >= 3);
  assert.ok(requests.every(request => request.region === undefined));
  assert.ok(result.analysis.target.confidence >= .97);
  assert.equal(h.points.length, 0, 'observe must not send input while exercising real vision');
});

test('invalid region metadata or mismatched encoded pixels stop before any touch', vision, async t => {
  for(const region of [{x:-1,y:0,width:200,height:200},{x:0.5,y:0,width:200,height:200},
    {x:0,y:0,width:0,height:200},{x:639,y:0,width:2,height:200}])
    assert.equal(followCommandSchema.safeParse({op:'analyze',config:fixture.config,frame:{...fixture.frame,region}}).success,false);
  for(const region of [{x:639,y:0,width:2,height:200},{x:0,y:0,width:200,height:200}]) {
    // Second case claims a 200px image while the encoded pixels are still 640px wide.
    const h=harness(t,{frame:{...fixture.frame,region}});
    await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
    await until(async()=>!(await h.manager.command({op:'status'})).running);
    assert.notEqual((await h.manager.command({op:'status'})).error,'');
    assert.equal(h.points.length,0); assert.equal(h.stopped(),1);
  }
});
test('app screenshots respect the phone interval when consecutive Wi-Fi requests have different delays', vision, async t => {
  const h=harness(t), live=h.host.live;
  const arrivals=[];
  h.host.live=async(...args)=>{
    if(args[2].op==='frame') {
      // The first request reaches Android late; the second reaches it immediately.
      // Spacing host request starts alone would compress the phone-side interval.
      if(arrivals.length===0) await wait(300);
      const now=performance.now(), previous=arrivals.at(-1);
      arrivals.push(now);
      if(previous!==undefined && now-previous<333) throw Error('Android screenshot interval too short');
    }
    return live(...args);
  };
  const state=await h.manager.command({op:'start',id:'phone',mode:'observe',config:{...fixture.config,intervalMs:400}});
  await until(async()=>{const s=await h.manager.command({op:'status'});return s.frames>=3 || !s.running;});
  const status=await h.manager.command({op:'status'});
  assert.equal(status.error,'');
  assert.ok(status.frames>=3);
  assert.ok(arrivals.slice(1).every((at,i)=>at-arrivals[i]>=333));
  await h.manager.command({op:'stop',runId:state.runId});
  assert.equal(h.stopped(),1);
});

test('full chunked cadence counts page download time while ROI keeps the post-response interval', vision, async t => {
  for (const { capture, downloadMs } of [{ capture: 'full', downloadMs: 200 },
    { capture: 'full', downloadMs: 430 }, { capture: 'auto', downloadMs: 200 }]) {
    const h = harness(t), live = h.host.live, requests = [], ready = [], finished = [];
    h.host.live = async (...args) => {
      if (args[2].op !== 'frame') return live(...args);
      requests.push(performance.now());
      if (requests.length === 1) await wait(180); // first capture reaches Android later
      ready.push(performance.now());
      const frame = await chunkedFrame(downloadMs);
      finished.push(performance.now()); return frame;
    };
    const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'observe',
      config: { ...fixture.config, intervalMs: 350, capture } });
    await until(async () => (await h.manager.command({ op: 'status' })).frames >= 3);
    await h.manager.command({ op: 'stop', runId: started.runId });
    for (let i = 1; i < requests.length; i++) {
      assert.ok(requests[i] - ready[i - 1] >= 333, 'phone capture completion still precedes the next request by the interval');
      if (capture === 'auto') assert.ok(requests[i] - finished[i - 1] >= 333, 'ROI cadence is unchanged even if a companion returns a full chunked frame');
      else if (downloadMs < 350) assert.ok(requests[i] - ready[i - 1] < 450, 'fast pages leave only the remaining part of the interval');
      else assert.ok(requests[i] - finished[i - 1] < 200, 'slow pages must not incur a second 350ms wait');
    }
    assert.equal((await h.manager.command({ op: 'status' })).error, '');
  }
});

test('chunked cadence does not relax the one-second movement age or trust a JSON timestamp', vision, async t => {
  const h = harness(t), live = h.host.live;
  h.host.live = (...args) => args[2].op === 'frame' ? chunkedFrame(1100) : live(...args);
  const started = await h.manager.command({ op: 'start', id: 'phone', mode: 'control', config: { ...fixture.config, capture: 'full' } });
  await until(() => h.points.length >= 2);
  const status = await h.manager.command({ op: 'status' });
  assert.ok(status.analysis.direction); assert.ok(h.points.every(command => !command.points.length));
  assert.equal(status.actions, 0);
  await h.manager.command({ op: 'stop', runId: started.runId });
  const fake = harness(t, { frame: { ...fixture.frame, captureReadyAt: performance.now() - 60000 } });
  await fake.manager.command({ op: 'start', id: 'phone', mode: 'control', config: { ...fixture.config, capture: 'full' } });
  await until(async () => !(await fake.manager.command({ op: 'status' })).running);
  assert.equal(fake.points.length, 0); assert.notEqual((await fake.manager.command({ op: 'status' })).error, '');
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

test('follow renews the phone heartbeat independently while capture is pending', vision, async t => {
  const h=harness(t,{delay:2500});
  let heartbeats=0;
  const sync=h.host.syncWrapper;
  h.host.syncWrapper=async(...args)=>{heartbeats++;return sync(...args);};
  const started=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await until(()=>heartbeats>=2,2400);
  assert.equal((await h.manager.command({op:'status'})).frames,0);
  await h.manager.command({op:'stop',runId:started.runId});
});

test('host diagnostics distinguish timer blocking from a slow phone response', vision, async t => {
  const h=harness(t);
  const started=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await wait(50); // Let the histogram establish its 20ms sampling timer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
  await until(async()=> (await h.manager.command({op:'status'})).timings?.maxHeartbeatTimerLagMs>=150,2000);
  const status=await h.manager.command({op:'status'});
  assert.ok(status.timings.eventLoopMaxDelayMs>=1000);
  assert.equal(status.running,true);assert.equal(status.error,'');
  assert.equal(h.points.length,0,'diagnostics do not authorize input');
  await h.manager.command({op:'stop',runId:started.runId});
  const next=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await until(async()=> (await h.manager.command({op:'status'})).timings?.eventLoopMaxDelayMs!==undefined);
  assert.ok((await h.manager.command({op:'status'})).timings.eventLoopMaxDelayMs<1000,'new run resets its histogram');
  await h.manager.command({op:'stop',runId:next.runId});
});

test('a failed phone heartbeat stops following without automatically restarting', vision, async t => {
  const h=harness(t);
  h.host.syncWrapper=async()=>{throw Error('phone heartbeat lost');};
  await h.manager.command({op:'start',id:'phone',mode:'control',config:fixture.config});
  await until(async()=>!(await h.manager.command({op:'status'})).running,2500);
  assert.match((await h.manager.command({op:'status'})).error,/phone heartbeat lost/);
  const count=h.points.length;
  await wait(1100);
  assert.equal(h.points.length,count);
  assert.equal(h.stopped(),1);
});

test('heartbeat requests do not overlap and a late failure cannot stop a newer run', vision, async t => {
  const h=harness(t);
  let reject, calls=0;
  const pending=new Promise((_,no)=>reject=no);
  h.host.syncWrapper=()=>{calls++;return pending;};
  const first=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  await until(()=>calls===1);
  await wait(1100);
  assert.equal(calls,1);
  await h.manager.command({op:'stop',runId:first.runId});
  h.host.syncWrapper=async()=>h.host.pulseWrapper();
  const next=await h.manager.command({op:'start',id:'phone',mode:'observe',config:fixture.config});
  reject(Error('old heartbeat failed'));
  await wait(100);
  const status=await h.manager.command({op:'status'});
  assert.equal(status.runId,next.runId);assert.equal(status.running,true);assert.equal(status.error,'');
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
  assert.equal(calls[0].params.recoverTransport,undefined);
  for(const value of ['true','false']) {
    assert.equal(await runGameFollowCli(['start','--device','phone','--config',file,'--recover-transport',value],request,io),0);
    assert.equal(calls.at(-1).params.recoverTransport,value==='true');
  }
  for(const value of ['yes','1','TRUE'])
    assert.equal(await runGameFollowCli(['start','--device','phone','--config',file,'--recover-transport',value],request,io),1);
  assert.equal(calls.length,4);
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
  const h=harness(t,{delay:2100});
  const state=await h.manager.command({op:'start',id:'emulator',mode:'control',backend:'basic',config:fixture.config});
  await until(()=>h.points.length>=2);
  assert.deepEqual(h.points[0].points,[]);assert.equal(h.points[1].points.length,1);
  await h.manager.command({op:'stop',runId:state.runId});
  assert.equal(h.stopped(),1);
});

for (const [backend, delay] of [['app',1100],['basic',3100]]) {
  test(`${backend} follow releases input when a recognized frame exceeds its age limit`,vision,async t=>{
    const h=harness(t,{delay});
    const state=await h.manager.command({op:'start',id:'phone',mode:'control',backend,config:fixture.config});
    await until(()=>h.points.length>=2,10000);
    const status=await h.manager.command({op:'status'});
    assert.ok(status.analysis.direction,'vision recognized a direction, but capture was too slow to use it');
    assert.ok(h.points.every(p=>p.points.length===0));
    assert.equal(status.actions,0);
    assert.ok(status.timings.captureMs>=delay-30);
    assert.ok(status.timings.analysisMs>=0);
    await h.manager.command({op:'stop',runId:state.runId});
  });
}
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
