const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { GameFollower, gameFollowConfigSchema } = loadCli('src/main/phones/game-follow.ts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await wait(10); }
  throw Error('camera integration condition timed out');
}
function config() {
  const image = 'A'.repeat(16);
  return { version: 1, name: 'camera integration', width: 1000, height: 500,
    map: { x: .1, y: 0, width: .4, height: .8 }, selfTemplate: image, targetTemplate: image,
    selfRotates: false, grid: { columns: 20, rows: 20, blocked: [], clearance: 0 },
    joystick: { x: .2, y: .85, radius: .06, rotation: 0 }, confidence: .9,
    stopDistance: .1, intervalMs: 350,
    cameraAssist: { referenceWidth: 1000, referenceHeight: 500, targetLabel: image, healthBarTemplate: image,
      healthBar: { width: 60, height: 12, offsetX: 0, offsetY: 20 },
      region: { x: .1, y: .1, width: .8, height: .8 }, matrix: [[.02, 0], [0, .02], [-10, -5]],
      anchorBounds: { x: 0, y: 0, width: 1000, height: 500 } } };
}
function proof(sequence, frame, patch = {}) {
  return { version: 1, epoch: 7, sequence, x: 300, y: 200, heldSinceUptimeMs: 100000,
    capturedAtUptimeMs: 100000 + frame * 400, expiresAtUptimeMs: 101500 + frame * 400, ...patch };
}
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-camera-integration-'));
  const log = path.join(root, 'worker.jsonl'), worker = path.join(root, 'worker.cjs');
  // Only vision is simulated. Exercise the real GameFollower loop, state machine,
  // capability gate, frame/ACK handling and merged native touch arrays. The worker
  // intentionally emits camera directions even without a context to challenge
  // the host's independent movement gate, not duplicate its implementation.
  fs.writeFileSync(worker, `
const fs=require('node:fs'), readline=require('node:readline'); let frames=0;
readline.createInterface({input:process.stdin}).on('line', line=>{
 const req=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(req)+'\\n');
 let data={ready:true};
 if(req.op==='analyze') {
  frames++; const lost=frames===2, camera=frames>=3 && frames<${options.fullAt ?? 1000000};
  data={phase:lost?'lost':'following',message:'fixture',self:{x:.2,y:.2,confidence:.99},
   target:lost?null:{x:.5+(camera?${options.cameraOffset ?? 0}:0),y:.5,confidence:.99},targetSource:camera?'camera':'template',
   source:'minimap',direction:lost?null:{x:1,y:0},path:[],elapsedMs:1};
  Object.assign(data, ${JSON.stringify(options.frames ?? [])}[frames-1] || {});
 }
 process.stdout.write(JSON.stringify({id:req.id,ok:true,data})+'\\n');
});`);
  const h = { calls: [], captures: 0, stopped: 0, starts: 0, touches: [], recoveries: 0 };
  const device = { state: { generation: 3, phase: 'controlling' } };
  const host = {
    startWrapper: async (_, mode) => { h.starts++; device.state.phase = mode === 'view' ? 'viewing' : 'controlling'; return { lease: 'test-owner', device }; },
    pulseWrapper: () => device, syncWrapper: async () => device,
    stopWrapper: async () => { h.stopped++; device.state.phase = 'stopped'; },
    recoverWrapper: async () => { h.recoveries++; return device; },
    live: async (_, generation, command) => {
      assert.equal(generation, 3); h.calls.push(structuredClone(command));
      if (command.op === 'probe') return { protocol: 1, ...(options.capability === false ? {} : { cameraFrameProvenance: 1 }) };
      if (command.op === 'frame') {
        h.captures++;
        const cameraProof = options.frameProof?.(h);
        return { mime: 'image/jpeg', width: 1000, height: 500, base64: 'A'.repeat(16), ...(cameraProof ? { cameraProof } : {}) };
      }
      h.touches.push(structuredClone(command));
      if (options.touch) return options.touch(command, h);
      return { accepted: true, acceptedSequence: command.sequence };
    }
  };
  h.manager = new GameFollower(root, host);
  // Drive the real JSON-lines subprocess protocol without a Python dependency.
  h.manager.python = { executable: process.execPath, args: [worker] };
  h.requests = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  h.start = (extra = {}) => h.manager.command({ op: 'start', id: 'test-phone', mode: 'control', config: config(), ...extra });
  h.stop = started => h.manager.command({ op: 'stop', runId: started.runId });
  t.after(async () => { await h.manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('camera integration rejects missing capability and basic backend before capturing or touching', async t => {
  const old = harness(t, { capability: false });
  await assert.rejects(old.start(), /镜头画面凭据/);
  assert.equal(old.captures, 0); assert.equal(old.touches.length, 0); assert.equal(old.stopped, 1);
  const basic = harness(t);
  await assert.rejects(basic.start({ backend: 'basic' }), /App/);
  assert.equal(basic.starts, 0); assert.equal(basic.captures, 0); assert.equal(basic.touches.length, 0);
});

test('camera observe requests negotiated full frames but cannot touch or acquire a held-camera context', async t => {
  const h = harness(t, { frameProof: h => proof(1, h.captures) });
  const started = await h.start({ mode: 'observe' });
  await until(async () => (await h.manager.command({ op: 'status' })).frames >= 3); await h.stop(started);
  assert.equal(h.touches.length, 0);
  assert.ok(h.calls.filter(c => c.op === 'frame').every(c => c.cameraFrameProvenance === 1 && !('region' in c)));
  assert.ok(h.requests().filter(r => r.op === 'analyze').every(r => !r.cameraContext));
  assert.equal((await h.manager.command({ op: 'status' })).actions, 0);
});

test('full portrait restoration releases only camera, retains current joystick, and publishes transition counts', async t => {
  const h = harness(t, { fullAt: 5, frameProof: h => h.captures < 3 ? undefined : proof(h.touches.at(-1).sequence, h.captures) });
  const started = await h.start();
  await until(() => h.touches.length >= 7);
  assert.deepEqual(h.touches[4].points.map(p => p.id), [0, 1]);
  assert.deepEqual(h.touches[5].points.map(p => p.id), [0, 1]);
  assert.deepEqual(h.touches[6].points.map(p => p.id), [0], 'full current direction is not dropped when id1 is released');
  const status = await h.manager.command({ op: 'status' });
  assert.equal(status.camera.armAttempts, 1); assert.equal(status.camera.releaseRequests, 1);
  assert.deepEqual(status.camera.releaseReasons, { 'full-target-restored': 1 });
  assert.equal(status.camera.state, 'idle'); assert.equal(status.camera.frameTarget, 'full');
  assert.equal(status.camera.searchRemainingMs, 0);
  await h.stop(started);
});

test('real follower allows current camera proof and blocks stale or changed-hold directions independently of vision', async t => {
  const h = harness(t, { frameProof: h => h.captures < 3 ? undefined
    : proof(h.captures === 4 ? 2 : h.touches.at(-1).sequence, h.captures, h.captures === 6 ? { epoch: 8 } : {}) });
  const started = await h.start();
  await until(() => h.touches.length >= 6); await h.stop(started);
  const ids = index => h.touches[index].points.map(p => p.id);
  assert.deepEqual(ids(0), [0]); assert.deepEqual(ids(1), [1]);
  assert.deepEqual(ids(2), [0, 1], 'current acknowledged/applied camera may support movement');
  assert.deepEqual(ids(3), [1], 'old sequence cannot drive joystick even when vision supplies a direction');
  assert.deepEqual(ids(4), [0, 1]);
  assert.deepEqual(ids(5), [], 'changed phone hold epoch releases both touches');
  const analyses = h.requests().filter(r => r.op === 'analyze');
  assert.equal(analyses[1].cameraContext, undefined);
  assert.equal(analyses[2].cameraContext.sequence, 2);
  assert.equal(analyses[3].cameraContext, undefined);
  assert.equal(analyses[4].cameraContext.sequence, 4);
  assert.equal(analyses[5].cameraContext, undefined);
  assert.ok(h.calls.filter(c => c.op === 'frame').every(c => c.cameraFrameProvenance === 1 && !c.region));
});

test('an uncertain camera ACK stops once without replaying its hold', async t => {
  const h = harness(t, { touch: c => ({ accepted: true, acceptedSequence: c.sequence === 2 ? 1 : c.sequence }) });
  await h.start();
  await until(async () => !(await h.manager.command({ op: 'status' })).running);
  assert.equal(h.touches.length, 2); assert.deepEqual(h.touches[1].points.map(p => p.id), [1]);
  assert.equal(h.stopped, 1); assert.match((await h.manager.command({ op: 'status' })).error, /未确认/);
});

test('recovery releases uncertain camera input and cannot reuse pre-gap proof or vision direction', async t => {
  let failed = false;
  const h = harness(t, { frameProof: h => h.captures >= 3 ? proof(2, h.captures) : undefined,
    touch: c => { if (c.sequence === 3 && !failed) { failed = true; throw Error('transport lost'); }
      return { accepted: true, acceptedSequence: c.sequence }; } });
  const started = await h.start({ recoverTransport: true });
  await until(() => h.touches.length >= 5); await h.stop(started);
  assert.equal(h.recoveries, 1);
  assert.equal(h.touches.filter(c => c.sequence === 3).length, 1);
  assert.deepEqual(h.touches[3].points, [], 'explicit release precedes a post-gap capture');
  assert.deepEqual(h.touches[4].points, [], 'old camera output cannot move after recovery');
  const lost = h.calls.findIndex(c => c.op === 'touch' && c.sequence === 3);
  assert.equal(h.calls[lost + 1].op, 'touch'); assert.deepEqual(h.calls[lost + 1].points, []);
  assert.equal(h.calls[lost + 2].op, 'frame');
  const analyses = h.requests().filter(r => r.op === 'analyze');
  assert.equal(analyses[3].cameraContext, undefined);
});

test('recenter keeps this frame direction and waits only for the new applied stable proof on following frames', async t => {
  const h = harness(t, { cameraOffset: .02, frameProof: h => {
    if (h.captures < 3) return;
    const prior = h.touches.at(-1), point = prior.points.find(p => p.id === 1);
    return proof(prior.sequence, h.captures, h.captures === 3 ? {} : {
      x: point.x, y: point.y, epoch: 8, heldSinceUptimeMs: 101200,
      capturedAtUptimeMs: h.captures === 4 ? 101400 : 101800+(h.captures-5)*400 });
  } });
  const started = await h.start();
  await until(() => h.touches.length >= 5); await h.stop(started);
  assert.deepEqual(h.touches[1].points.map(p => p.id), [1]);
  assert.deepEqual(h.touches[2].points.map(p => p.id), [0, 1]);
  assert.equal(h.touches[2].points[1].x, 308, 'current edge target becomes the new centered hold');
  assert.deepEqual(h.touches[3].points.map(p => p.id), [1], 'new point is not settled for 250ms yet');
  assert.deepEqual(h.touches[4].points.map(p => p.id), [0, 1], 'one valid stable new proof resumes current movement');
  const requests = h.requests().filter(r => r.op === 'analyze');
  assert.equal(requests[2].cameraContext.point.x, 300);
  assert.equal(requests[3].cameraContext, undefined);
  assert.equal(requests[4].cameraContext.point.x, 308);
});

test('initial arm applies calibrated center offset instead of assuming the label lies at projection zero', async t => {
  const h = harness(t), c = config(); c.cameraAssist.matrix[2] = [-8, -4];
  const started = await h.start({ config: c });
  await until(() => h.touches.length >= 2); await h.stop(started);
  assert.deepEqual(h.touches[1].points, [{ id: 1, x: 298, y: 199, fromX: 298, fromY: 199 }]);
});

test('two current full portraits can lead id1 after loss but never supply a joystick coordinate', async t => {
  const h = harness(t, { frames: [
    { target: { x: .45, y: .5, confidence: .99 }, targetSource: 'template' },
    { target: { x: .5, y: .5, confidence: .99 }, targetSource: 'template', direction: { x: 1, y: 0 } },
    // Deliberately challenge the host with a direction despite no current target.
    { target: null, targetSource: 'template', direction: { x: 1, y: 0 } }
  ] });
  const started = await h.start();
  await until(() => h.touches.length >= 4); await h.stop(started);
  assert.deepEqual(h.touches[0].points.map(p => p.id), [0]);
  assert.deepEqual(h.touches[1].points.map(p => p.id), [0]);
  assert.deepEqual(h.touches[2].points.map(p => p.id), [1]);
  assert.ok(h.touches[2].points[0].x > 300 && h.touches[2].points[0].x < 500);
  assert.equal(h.touches[2].ttlMs, 1200);
  assert.deepEqual(h.touches[3].points.map(p => p.id), [1], 'next camera direction still needs its own applied proof');
  assert.ok(h.requests().filter(r => r.op === 'analyze').every(r => !r.cameraContext));
});

test('self camera is independently opt-in with mandatory green identity and reference bounds', () => {
  const c = config(); c.selfCameraAssist = { ...c.cameraAssist, team: 'green' }; delete c.cameraAssist;
  assert.ok(gameFollowConfigSchema.safeParse(c).success);
  for (const patch of [{ team: undefined }, { team: 'blue' }, { referenceWidth: 999 }, { anchorBounds: { x: 950, y: 0, width: 100, height: 100 } }])
    assert.equal(gameFollowConfigSchema.safeParse({ ...c, selfCameraAssist: { ...c.selfCameraAssist, ...patch } }).success, false);
  assert.equal(gameFollowConfigSchema.safeParse({ ...config(), cameraAssist: { ...config().cameraAssist, team: 'green' } }).success, false);
});

test('self-only assistance uses full frames, validates its own proof and retains camera until both identities return', async t => {
  const fullTarget = { target: { x: .5, y: .5, confidence: .99 }, targetSource: 'template', direction: { x: 1, y: 0 } };
  const cameraSelf = { ...fullTarget, self: { x: .2, y: .2, confidence: .85 }, selfSource: 'camera' };
  const markerSelf = { ...fullTarget, self: { x: .2, y: .2, confidence: .7 }, selfSource: 'marker' };
  const h = harness(t, { frames: [{ ...fullTarget, selfSource: 'template' }, { ...fullTarget, self: null },
    cameraSelf, cameraSelf, cameraSelf, cameraSelf, cameraSelf, markerSelf, markerSelf, markerSelf],
    frameProof: h => h.captures < 3 ? undefined : proof(h.captures === 4 ? 2 : h.touches.at(-1).sequence,
      h.captures, { x: 180, y: 80 }) });
  const c = config(); c.selfCameraAssist = { ...c.cameraAssist, team: 'green' }; delete c.cameraAssist;
  const started = await h.start({ config: c });
  await until(() => h.touches.length >= 10);
  assert.ok(h.calls.filter(c => c.op === 'frame').every(c => c.cameraFrameProvenance === 1 && !c.region));
  assert.deepEqual(h.touches[1].points.map(p => p.id), [1]); assert.equal(h.touches[1].points[0].x, 180);
  assert.deepEqual(h.touches[2].points.map(p => p.id), [0, 1], 'camera locator threshold is independent of portrait threshold');
  assert.deepEqual(h.touches[3].points.map(p => p.id), [1], 'stale sequence cannot authorize own camera coordinates');
  assert.deepEqual(h.touches[6].points.map(p => p.id), [0, 1], 'full target alone does not release self camera');
  assert.deepEqual(h.touches[7].points.map(p => p.id), [0, 1], 'current marker may confirm restoration without avatar confidence');
  assert.deepEqual(h.touches[9].points.map(p => p.id), [0]);
  const status = await h.manager.command({ op: 'status' });
  assert.equal(status.camera.releaseReasons['full-pair-restored'], 1);
  await h.stop(started);
});

test('self assistance alone still requires capability and cannot use the basic backend', async t => {
  const c = config(); c.selfCameraAssist = { ...c.cameraAssist, team: 'green' }; delete c.cameraAssist;
  const old = harness(t, { capability: false }); await assert.rejects(old.start({ config: c }), /镜头画面凭据/);
  assert.equal(old.captures, 0); assert.equal(old.touches.length, 0);
  const basic = harness(t); await assert.rejects(basic.start({ config: c, backend: 'basic' }), /App/);
  assert.equal(basic.starts, 0);
});

test('target camera proof cannot opt into an unconfigured self camera locator', async t => {
  const h = harness(t, { frames: [{}, {}, { selfSource: 'camera' }],
    frameProof: h => h.captures < 3 ? undefined : proof(h.touches.at(-1).sequence, h.captures) });
  const started = await h.start(); await until(() => h.touches.length >= 3); await h.stop(started);
  assert.deepEqual(h.touches[2].points.map(p => p.id), [1], 'a target proof does not enable a different unconfigured identity source');
});

test('full target restoration while self disappears switches the held camera directly without release or stale movement', async t => {
  const fullTarget = { target: { x: .5, y: .5, confidence: .99 }, targetSource: 'template', direction: { x: 1, y: 0 } };
  const ownCamera = { ...fullTarget, self: { x: .2, y: .2, confidence: .85 }, selfSource: 'camera' };
  const h = harness(t, { frames: [{ selfSource: 'template' }, { selfSource: 'template' },
    { ...fullTarget, self: null }, ownCamera, ownCamera, ownCamera], frameProof: h => {
      if (h.captures < 3) return;
      return proof(h.touches.at(-1).sequence, h.captures, h.captures < 5 ? {} : {
        x: 180, y: 80, epoch: 8, heldSinceUptimeMs: 101200 });
    } });
  const c = config(); c.selfCameraAssist = { ...c.cameraAssist, team: 'green' };
  const started = await h.start({ config: c }); await until(() => h.touches.length >= 6);
  assert.equal(h.touches[1].points[0].x, 300, 'first search uses target calibration');
  assert.deepEqual(h.touches[2].points, [{ id: 1, x: 180, y: 80, fromX: 180, fromY: 80 }]);
  assert.deepEqual(h.touches[3].points.map(p => p.id), [1], 'previous target-view proof cannot supply current self');
  assert.deepEqual(h.touches[4].points.map(p => p.id), [0, 1]);
  assert.deepEqual(h.touches[5].points.map(p => p.id), [0, 1], 'full target does not release a camera still needed for self');
  const status = await h.manager.command({ op: 'status' });
  assert.equal(status.camera.role, 'self'); assert.equal(status.camera.armAttempts, 2);
  assert.equal(status.camera.releaseRequests, 0);
  await h.stop(started);
});
