const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { CameraSampler, cameraSampleCommandSchema } = loadCli('src/main/phones/camera-sample.ts');
const { runGameFollowCli } = loadCli('src/main/phones/game-follow-cli.ts');
const { followCommandSchema } = loadCli('src/main/phones/game-follow.ts');

// Protocol fixture only. This does not claim the game reacts to Android MOVE.
const jpeg = Buffer.from([255,216,255,192,0,11,8,4,216,10,212,1,1,17,0,255,217]);
const frame = () => ({ mime: 'image/jpeg', width: 2772, height: 1240, base64: jpeg.toString('base64') });
const steps = () => [
  { x: 316, y: 218, mode: 'release-newdown' },
  { x: 308, y: 218, mode: 'continue' },
  { x: 316, y: 218, mode: 'continue' },
  { x: 292, y: 218, mode: 'continue' },
  { x: 316, y: 218, mode: 'continue' },
  { x: 316, y: 218, mode: 'release-newdown' },
  { x: 308, y: 218, mode: 'release-newdown' },
  { x: 316, y: 218, mode: 'release-newdown' }
];
async function fixture(t, hooks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-camera-sequence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = { op: 'camera-sample', id: 'phone', x: 316, y: 218, steps: steps(), outputDir: path.join(root, 'sequence') };
  const state = { instanceId: 'instance', sessionId: 'private-session', generation: 7, mode: 'control', phase: 'controlling' };
  let now = 0, epoch = 0, held, holdNumber = 0;
  const calls = [], context = { state, tick: ms => { now += ms; }, now: () => now };
  const host = {
    async startWrapper(...args) { calls.push(['start', args]); if (hooks.start) await hooks.start(context); return { lease: 'private-lease', device: { state } }; },
    pulseWrapper(lease) { calls.push(['pulse', lease]); return { state }; },
    async live(lease, generation, input) {
      calls.push(['live', lease, generation, structuredClone(input), now]);
      if (input.op === 'probe') return { protocol: 1, cameraFrameProvenance: 1, ...(hooks.probe || {}) };
      if (input.op === 'touch') {
        const point = input.points[0];
        if (point) holdNumber++;
        if (hooks.touch) await hooks.touch(input, { ...context, holdNumber });
        if (held && now >= held.expires) { held = undefined; epoch++; }
        if (!point) { held = undefined; epoch++; }
        else if (!held || held.x !== point.x || held.y !== point.y) {
          epoch++; held = { ...point, since: now + 80, expires: now + input.ttlMs, sequence: input.sequence };
        } else { held.expires = now + input.ttlMs; held.sequence = input.sequence; }
        now += 15;
        return { accepted: true, acceptedSequence: input.sequence };
      }
      const result = frame();
      if (held && now + 30 < held.expires) result.cameraProof = { version: 1, epoch, sequence: held.sequence,
        x: held.x, y: held.y, heldSinceUptimeMs: 10000 + held.since,
        capturedAtUptimeMs: 10000 + now + 30, expiresAtUptimeMs: 10000 + held.expires };
      now += 500;
      if (hooks.frame) await hooks.frame(result, { ...context, holdNumber });
      return result;
    },
    async stopWrapper(lease) { calls.push(['stop', lease]); if (hooks.stop) await hooks.stop(context); },
    async syncWrapper(lease) { calls.push(['sync', lease]); if (hooks.sync) await hooks.sync(context); return { state }; },
    async recoverWrapper() { throw new Error('no implicit recovery'); }
  };
  const sampler = new CameraSampler(host, { now: () => now, wait: async (ms, signal) => {
    calls.push(['wait', ms, now]); now += ms;
    if (hooks.wait) await hooks.wait(signal, context);
  } });
  const touches = () => calls.filter(c => c[0] === 'live' && c[3].op === 'touch').map(c => ({ ...c[3], at: c[4] }));
  const manifest = async () => JSON.parse(await fs.readFile(path.join(command.outputDir, 'sequence.json'), 'utf8'));
  return { root, command, state, sampler, calls, touches, manifest };
}

test('eight-step plan uses one lease/id1, preserves native bytes, changes epoch for MOVE and fresh DOWN', async t => {
  const f = await fixture(t), result = await f.sampler.sample(f.command);
  assert.equal(result.complete, true);
  assert.equal(result.ttlMs, 1500);
  assert.equal(result.nativeCameraPointChange, 'legacy-unreported');
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'stop').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'sync').length, 8);
  assert.equal(f.calls.find(c => c[0] === 'start')[1].at(-1), false);
  const touches = f.touches(), holds = touches.filter(c => c.points.length);
  assert.deepEqual(holds.map(c => c.points), f.command.steps.map(({ x, y }) => [{ id: 1, x, y }]));
  assert.ok(holds.every(c => c.ttlMs === 1500));
  assert.deepEqual(touches.map(c => c.sequence), Array.from({ length: touches.length }, (_, i) => i + 1));
  assert.equal(touches.filter(c => !c.points.length).length, 4); // Three transitions and final cleanup.
  assert.equal(touches.at(-1).points.length, 0);
  const metadata = [];
  for (let i = 1; i <= 8; i++) {
    const directory = path.join(f.command.outputDir, `step-${String(i).padStart(2, '0')}`);
    assert.deepEqual(await fs.readFile(path.join(directory, 'sample.jpg')), jpeg);
    metadata.push(JSON.parse(await fs.readFile(path.join(directory, 'sample.json'), 'utf8')));
    assert.equal(metadata.at(-1).valid, true);
    assert.equal(metadata.at(-1).width, 2772); assert.equal(metadata.at(-1).height, 1240);
    assert.equal(metadata.at(-1).sha256, createHash('sha256').update(jpeg).digest('hex'));
  }
  assert.deepEqual(metadata.map(x => x.cameraProof.epoch), [1, 2, 3, 4, 5, 7, 9, 11]);
  assert.deepEqual(metadata.map(x => x.touchAck.sequence), [1, 2, 3, 4, 5, 7, 9, 11]);
  for (const i of [6, 7, 8]) {
    const released = JSON.parse(await fs.readFile(path.join(f.command.outputDir, `step-0${i}`, 'release.json'), 'utf8'));
    assert.equal(released.proofAbsent, true);
    assert.equal(released.releaseWaitMs, 695);
    assert.deepEqual(await fs.readFile(path.join(f.command.outputDir, `step-0${i}`, 'release.jpg')), jpeg);
  }
  assert.equal(JSON.stringify(result).includes('private-'), false);
  const plan = JSON.parse(await fs.readFile(path.join(f.command.outputDir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.steps, steps()); assert.equal(plan.ttlMs, 1500);
});

test('rejects invalid sequence length, first step, extra fields and all out-of-screen points before input', async t => {
  for (const count of [0, 5, 10]) assert.throws(() => cameraSampleCommandSchema.parse({ op: 'camera-sample', id: 'x', x: 1, y: 1,
    outputDir: path.resolve('x'), steps: Array.from({ length: count }, () => steps()[0]) }));
  for (const change of [s => { s[0].mode = 'continue'; }, s => { s[0].x++; }, s => { s[7].x = 2772; }]) {
    const f = await fixture(t); change(f.command.steps);
    await assert.rejects(f.sampler.sample(f.command));
    assert.equal(f.touches().length, 0);
  }
  const f = await fixture(t); f.command.steps[0].id = 0;
  assert.throws(() => f.sampler.sample(f.command)); assert.equal(f.touches().length, 0);
});

test('schema/CLI accept explicit array and preserve it across management boundary', async t => {
  const f = await fixture(t), file = path.join(f.root, 'steps.json');
  await fs.writeFile(file, JSON.stringify(steps()));
  assert.deepEqual(followCommandSchema.parse(f.command), f.command);
  const requests = [];
  assert.equal(await runGameFollowCli(['camera-sample', '--device', 'phone', '--x', '316', '--y', '218',
    '--output', f.command.outputDir, '--steps-file', file], async c => { requests.push(c); return { ok: true }; },
    { stdout: { write() {} }, stderr: { write() {} } }), 0);
  assert.deepEqual(requests[0].params, f.command);
});

test('diagnostic records native re-press capability independently of host continue mode', async t => {
  for (const strategy of ['release-newdown', 'future-unknown']) {
    const f = await fixture(t, { probe: { cameraPointChange: strategy } });
    const result = await f.sampler.sample(f.command);
    const expected = strategy === 'release-newdown' ? strategy : 'unrecognized';
    assert.equal(result.nativeCameraPointChange, expected);
    const probe = JSON.parse(await fs.readFile(path.join(f.command.outputDir, 'probe.json'), 'utf8'));
    assert.equal(probe.nativeCameraPointChange, expected);
    const second = JSON.parse(await fs.readFile(path.join(f.command.outputDir, 'step-02/sample.json'), 'utf8'));
    assert.equal(second.mode, 'continue'); assert.equal(second.nativeCameraPointChange, expected);
    assert.equal(result.hostContinueMeaning, 'update-desired-point-without-host-release');
  }
});

test('expired continue is not silently converted to a new DOWN and preserves labelled partial images', async t => {
  const f = await fixture(t, { frame(value, { holdNumber, tick }) { if (holdNumber === 2) tick(550); } });
  await assert.rejects(f.sampler.sample(f.command), /1500ms/);
  assert.equal(f.touches().filter(c => c.points.length).length, 2);
  assert.equal(f.touches().at(-1).points.length, 0);
  const report = await f.manifest(); assert.equal(report.complete, false);
  assert.deepEqual(report.steps.map(s => s.status), ['captured', 'failed']);
  const bad = JSON.parse(await fs.readFile(path.join(f.command.outputDir, 'step-02/sample.json'), 'utf8'));
  assert.equal(bad.valid, false); assert.match(bad.error, /1500ms/);
  assert.deepEqual(await fs.readFile(path.join(f.command.outputDir, 'step-02/sample.jpg')), jpeg);
});

test('sequence capture accepts 1499ms but rejects the exact 1500ms host deadline', async t => {
  for (const extra of [534, 535]) { // Normal hold receipt takes 965ms in this fixture.
    const f = await fixture(t, { frame(value, { holdNumber, tick }) { if (holdNumber === 1 && value.cameraProof) tick(extra); } });
    f.command.steps.forEach(step => { step.mode = 'release-newdown'; });
    if (extra === 534) {
      const result = await f.sampler.sample(f.command); assert.equal(result.complete, true);
      const first = JSON.parse(await fs.readFile(path.join(f.command.outputDir, 'step-01/sample.json'), 'utf8'));
      assert.equal(first.timing.holdToFrameMs, 1499);
    } else {
      await assert.rejects(f.sampler.sample(f.command), /1500ms/);
      assert.equal(f.touches().filter(c => c.points.length).length, 1);
      assert.equal((await f.manifest()).steps[0].status, 'failed');
    }
  }
});

test('246ms observed MOVE ACK fits sequence TTL; continuation still rejects the exact previous 1500ms deadline', async t => {
  for (const extra of [231, 519, 520]) {
    const f = await fixture(t, { touch(input, { holdNumber, tick }) { if (input.points.length && holdNumber === 2) tick(extra); } });
    // Normal first hold=965ms, next ACK=15ms+extra. Relative to previous
    // send the ACK is 1211, 1499 or 1500ms, respectively.
    if (extra < 520) {
      const result = await f.sampler.sample(f.command); assert.equal(result.complete, true);
      assert.equal(result.events.find(e => e.kind === 'touch-ack' && e.sequence === 2).elapsedMs, 15 + extra);
    } else {
      await assert.rejects(f.sampler.sample(f.command), /确认超过前一保持时限/);
      assert.equal(f.touches().filter(c => c.points.length).length, 2);
      assert.equal((await f.manifest()).steps[1].status, 'failed');
    }
  }
});

test('sequence keeps stable250 proof threshold and rejects new proof lifetime above1500', async t => {
  for (const kind of ['stable250', 'stable249', 'ttl1501']) {
    const f = await fixture(t, { frame(value, { holdNumber }) {
      if (holdNumber !== 1 || !value.cameraProof) return;
      const p = value.cameraProof;
      if (kind === 'ttl1501') p.expiresAtUptimeMs = p.heldSinceUptimeMs + 1501;
      else p.heldSinceUptimeMs = p.capturedAtUptimeMs - (kind === 'stable250' ? 250 : 249);
    } });
    if (kind === 'stable250') assert.equal((await f.sampler.sample(f.command)).complete, true);
    else { await assert.rejects(f.sampler.sample(f.command), /稳定的凭据/); assert.equal(f.touches().filter(c => c.points.length).length, 1); }
  }
});

test('late continuation ACK and expired/recreated epoch fail without subsequent step or replay', async t => {
  for (const kind of ['late-ack', 'epoch-jump', 'old-point', 'same-epoch']) {
    const f = await fixture(t, {
      touch(input, { holdNumber, tick }) { if (kind === 'late-ack' && input.points.length && holdNumber === 2) tick(550); },
      frame(value, { holdNumber }) {
        if (holdNumber !== 2 || !value.cameraProof) return;
        if (kind === 'epoch-jump') value.cameraProof.epoch++;
        if (kind === 'old-point') value.cameraProof.x = 316;
        if (kind === 'same-epoch') value.cameraProof.epoch--;
      }
    });
    await assert.rejects(f.sampler.sample(f.command));
    assert.equal(f.touches().filter(c => c.points.length).length, 2);
    assert.equal(f.touches().at(-1).points.length, 0);
    assert.equal((await f.manifest()).complete, false);
  }
});

test('slow lease heartbeat never extends the held pointer deadline or starts a fresh continuation', async t => {
  let synced = 0;
  const f = await fixture(t, { sync({ tick }) { if (++synced === 2) tick(550); } });
  await assert.rejects(f.sampler.sample(f.command), /连续镜头保持已过期/);
  assert.equal(f.touches().filter(c => c.points.length).length, 1);
  assert.equal(f.touches().at(-1).points.length, 0);
  assert.equal((await f.manifest()).steps.at(-1).status, 'failed');
});

test('release-newdown waits across the previous hold deadline and refuses residual proof', async t => {
  let oldProof;
  const f = await fixture(t, { frame(value, { holdNumber }) {
    if (holdNumber === 5 && value.cameraProof) oldProof = value.cameraProof;
    else if (holdNumber === 5) value.cameraProof = oldProof;
  } });
  await assert.rejects(f.sampler.sample(f.command), /释放后仍有/);
  assert.equal(f.touches().filter(c => c.points.length).length, 5);
  const report = await f.manifest(); assert.equal(report.steps.at(-1).status, 'failed');
  assert.equal(report.events.some(e => e.kind === 'release-wait'), true);
});

test('same-point continuation retains epoch and heldSince while renewing only explicit next step', async t => {
  const f = await fixture(t); f.command.steps[1].x = 316;
  const result = await f.sampler.sample(f.command);
  assert.equal(result.complete, true);
  assert.equal(result.steps[1].cameraProof.epoch, result.steps[0].cameraProof.epoch);
  assert.equal(result.steps[1].cameraProof.heldSinceUptimeMs, result.steps[0].cameraProof.heldSinceUptimeMs);
  assert.ok(result.steps[1].cameraProof.expiresAtUptimeMs - result.steps[1].cameraProof.heldSinceUptimeMs > 1500);
});

test('pause/stop/replacement never receives cleanup touch; stop is limited to original lease', async t => {
  for (const change of [s => { s.phase = 'paused'; }, s => { s.phase = 'stopped'; }, s => { s.sessionId = 'other'; },
    s => { s.instanceId = 'other'; }, s => { s.generation++; }]) {
    const f = await fixture(t, { frame(value, { holdNumber, state }) { if (holdNumber === 2) change(state); } });
    await assert.rejects(f.sampler.sample(f.command), /会话已改变/);
    assert.equal(f.touches().length, 2);
    assert.deepEqual(f.calls.at(-1), ['stop', 'private-lease']);
    const report = await f.manifest(); assert.equal(report.complete, false);
    assert.ok(report.events.some(e => e.kind === 'cleanup-release-skipped'));
  }
});

test('uncertain MOVE is never replayed and abort cancels future steps while retaining partial ledger', async t => {
  const f = await fixture(t, { touch(input, { holdNumber }) { if (input.points.length && holdNumber === 2) throw new Error('socket hang up'); } });
  await assert.rejects(f.sampler.sample(f.command), /socket hang up/);
  assert.equal(f.touches().filter(c => c.points.length).length, 2);
  assert.equal(f.touches().at(-1).sequence, 3); assert.equal(f.touches().at(-1).points.length, 0);
  assert.equal((await f.manifest()).steps.length, 2);
  let ready, finish;
  const entered = new Promise(r => { ready = r; }), deferred = new Promise(r => { finish = r; });
  const g = await fixture(t, { async frame(value, { holdNumber }) { if (holdNumber === 2) { ready(); await deferred; } } });
  const pending = g.sampler.sample(g.command); await entered;
  const closing = g.sampler.close(); finish();
  await assert.rejects(pending, /取消/); await closing;
  assert.equal(g.touches().filter(c => c.points.length).length, 2);
  assert.equal(g.touches().at(-1).points.length, 0);
  assert.equal((await g.manifest()).complete, false);
});

test('existing output and phone task are never overwritten, resumed or stopped', async t => {
  const f = await fixture(t); await fs.mkdir(f.command.outputDir);
  await assert.rejects(f.sampler.sample(f.command), /EEXIST/); assert.equal(f.calls.length, 0);
  const g = await fixture(t, { start() { throw new Error('PHONE_SESSION_CONFLICT'); } });
  await assert.rejects(g.sampler.sample(g.command), /SESSION_CONFLICT/);
  assert.equal(g.calls.filter(c => c[0] === 'stop').length, 0); assert.equal(g.touches().length, 0);
  assert.equal((await g.manifest()).complete, false);
});

test('output collision and cleanup error cannot label a completed sequence successful', async t => {
  let f;
  f = await fixture(t, { async stop() { await fs.writeFile(path.join(f.command.outputDir, 'baseline.jpg'), 'other writer'); } });
  await assert.rejects(f.sampler.sample(f.command), /保存失败/);
  assert.equal(await fs.readFile(path.join(f.command.outputDir, 'baseline.jpg'), 'utf8'), 'other writer');
  const report = await f.manifest(); assert.equal(report.complete, false); assert.equal(report.outputErrors.length, 1);
  assert.ok(report.savedFiles.includes('step-08/sample.jpg'));
  const g = await fixture(t, { stop() { throw new Error('stop failed'); } });
  await assert.rejects(g.sampler.sample(g.command), /stop failed/);
  assert.equal((await g.manifest()).complete, false);
});
