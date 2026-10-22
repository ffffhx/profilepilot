const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { CameraSampler } = loadCli('src/main/phones/camera-sample.ts');
const { runGameFollowCli } = loadCli('src/main/phones/game-follow-cli.ts');

// Structural JPEG header only: tests byte preservation/protocol, not image quality.
const jpeg = Buffer.from([255,216,255,192,0,11,8,4,216,10,212,1,1,17,0,255,217]);
function frame() { return { mime: 'image/jpeg', width: 2772, height: 1240, base64: jpeg.toString('base64') }; }
function proof() { return { version: 1, epoch: 8, sequence: 1, x: 316, y: 218,
  heldSinceUptimeMs: 10080, capturedAtUptimeMs: 10600, expiresAtUptimeMs: 11200 }; }
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-camera-sample-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = { op: 'camera-sample', id: 'device', x: 316, y: 218, outputDir: path.join(root, 'sample') };
  const calls = [], state = { instanceId: 'instance', sessionId: 'private-session', generation: 3, mode: 'control', phase: 'controlling' };
  let now = 0;
  const host = {
    async startWrapper(...args) { calls.push(['start', ...args]); if (overrides.start) return overrides.start(); return { lease: 'private-lease', device: { state } }; },
    pulseWrapper(lease) { calls.push(['pulse', lease]); return { state }; },
    async live(lease, generation, input) {
      calls.push(['live', lease, generation, structuredClone(input)]);
      if (overrides.live) { const result = await overrides.live(input, { state, tick: ms => { now += ms; } }); if (result !== undefined) return result; }
      if (input.op === 'probe') return { protocol: 1, cameraFrameProvenance: 1 };
      if (input.op === 'frame') {
        now += 550;
        return { ...frame(), ...(input.cameraFrameProvenance ? { cameraProof: proof() } : {}) };
      }
      return { accepted: true, acceptedSequence: input.sequence };
    },
    async stopWrapper(lease) { calls.push(['stop', lease]); if (overrides.stop) await overrides.stop(); },
    async syncWrapper() { throw new Error('sampler must not heartbeat/recover'); },
    async recoverWrapper() { throw new Error('sampler must not recover'); }
  };
  const sampler = new CameraSampler(host, { now: () => now, wait: async (ms, signal) => {
    calls.push(['wait', ms]); now += ms; if (overrides.wait) await overrides.wait(signal);
  } });
  const inputs = () => calls.filter(c => c[0] === 'live').map(c => c[3]);
  return { root, command, sampler, calls, state, inputs };
}
async function empty(outputDir) { assert.deepEqual(await fs.readdir(outputDir), []); }
function released(f) {
  const touches = f.inputs().filter(c => c.op === 'touch');
  assert.deepEqual(touches.at(-1), { op: 'touch', sequence: 2, ttlMs: 100, points: [] });
  assert.equal(touches.filter(c => c.points.length).length, 1);
  assert.equal(f.calls.at(-1)[0], 'stop');
}

test('saves exact native JPEG and matching proof only after releasing and stopping owned lease', async t => {
  const f = await fixture(t), result = await f.sampler.sample(f.command);
  assert.equal(f.sampler.busy, false);
  assert.deepEqual(await fs.readFile(result.imagePath), jpeg);
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
  assert.equal(metadata.sha256, createHash('sha256').update(jpeg).digest('hex'));
  assert.deepEqual(metadata.cameraProof, proof());
  assert.deepEqual(metadata.touchAck, { sequence: 1, point: { x: 316, y: 218 }, ttlMs: 1200 });
  assert.equal(metadata.timing.waitMs, 450);
  assert.equal(metadata.timing.holdToFrameMs, 1000);
  assert.equal(JSON.stringify(metadata).includes('private-'), false);
  assert.deepEqual(f.calls[0], ['start', 'device', 'control', '镜头标定采样', '指定镜头点的单帧标定', 'app', false]);
  assert.deepEqual(f.inputs(), [ { op: 'probe' }, { op: 'frame' },
    { op: 'touch', sequence: 1, ttlMs: 1200, points: [{ id: 1, x: 316, y: 218 }] },
    { op: 'frame', cameraFrameProvenance: 1 }, { op: 'touch', sequence: 2, ttlMs: 100, points: [] } ]);
  released(f);
});

test('existing output directory fails before acquiring phone, without overwrite', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.command.outputDir); await fs.writeFile(path.join(f.command.outputDir, 'keep'), 'existing');
  await assert.rejects(f.sampler.sample(f.command), /EEXIST/);
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.command.outputDir, 'keep'), 'utf8'), 'existing');
});

test('existing phone session is not resumed or stopped', async t => {
  const f = await fixture(t, { start() { throw new Error('PHONE_SESSION_CONFLICT'); } });
  await assert.rejects(f.sampler.sample(f.command), /SESSION_CONFLICT/);
  assert.equal(f.calls.length, 1); await empty(f.command.outputDir);
});

test('missing capability and out-of-bounds point fail before touch and stop own lease', async t => {
  for (const kind of ['capability', 'bounds']) {
    const f = await fixture(t, { live(input) { if (kind === 'capability' && input.op === 'probe') return { protocol: 1 }; } });
    if (kind === 'bounds') f.command.x = 2772;
    await assert.rejects(f.sampler.sample(f.command));
    assert.equal(f.inputs().some(c => c.op === 'touch'), false);
    assert.equal(f.calls.at(-1)[0], 'stop'); await empty(f.command.outputDir);
  }
});

test('proof must match this exact sequence/point, current TTL, stability and full frame', async t => {
  const changes = [
    p => { p.sequence = 2; }, p => { p.x++; }, p => { p.y++; }, p => { p.epoch = -1; },
    p => { p.capturedAtUptimeMs = p.expiresAtUptimeMs; }, p => { p.capturedAtUptimeMs = p.heldSinceUptimeMs + 249; },
    p => { p.expiresAtUptimeMs = p.heldSinceUptimeMs + 1201; }
  ];
  for (const change of changes) {
    const f = await fixture(t, { live(input) {
      if (input.cameraFrameProvenance) { const p = proof(); change(p); return { ...frame(), cameraProof: p }; }
    } });
    await assert.rejects(f.sampler.sample(f.command)); released(f); await empty(f.command.outputDir);
  }
  for (const change of [value => { delete value.cameraProof; }, value => { value.region = { x: 0, y: 0, width: 200, height: 200 }; },
    value => { value.width = 2000; }, value => { value.base64 = value.base64.slice(0, -4); }]) {
    const f = await fixture(t, { live(input) {
      if (input.cameraFrameProvenance) { const value = { ...frame(), cameraProof: proof() }; change(value); return value; }
    } });
    await assert.rejects(f.sampler.sample(f.command)); released(f); await empty(f.command.outputDir);
  }
});

test('1200ms host deadline discards even valid phone proof and never renews hold', async t => {
  for (const delayMs of [750, 1201]) {
    const f = await fixture(t, { live(input, { tick }) {
      if (input.cameraFrameProvenance) { tick(delayMs); return { ...frame(), cameraProof: proof() }; }
    } });
    await assert.rejects(f.sampler.sample(f.command), /1200ms/); released(f); await empty(f.command.outputDir);
  }
});

test('uncertain hold ACK is never replayed; new release and lease stop still run', async t => {
  const f = await fixture(t, { live(input) { if (input.op === 'touch' && input.sequence === 1) throw new Error('socket hang up'); } });
  await assert.rejects(f.sampler.sample(f.command), /socket hang up/);
  assert.equal(f.inputs().filter(c => c.op === 'frame').length, 1); released(f); await empty(f.command.outputDir);
});

test('paused, ended, or replaced owner during capture cannot deliver image', async t => {
  for (const change of [state => { state.phase = 'paused'; }, state => { state.phase = 'stopped'; },
    state => { state.sessionId = 'replacement'; }, state => { state.instanceId = 'replacement'; }, state => { state.generation++; }]) {
    const f = await fixture(t, { live(input, { state }) { if (input.cameraFrameProvenance) { change(state); return { ...frame(), cameraProof: proof() }; } } });
    await assert.rejects(f.sampler.sample(f.command), /会话已改变/); released(f); await empty(f.command.outputDir);
  }
});

test('close cancels pending frame, excludes concurrent samples, and waits for cleanup', async t => {
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const pendingFrame = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { live(input) { if (input.cameraFrameProvenance) { entered(); return pendingFrame; } } });
  const pending = f.sampler.sample(f.command); await ready;
  assert.equal(f.sampler.busy, true);
  assert.throws(() => f.sampler.sample({ ...f.command, outputDir: path.join(f.root, 'other') }), /正在进行/);
  const closing = f.sampler.close();
  finish({ ...frame(), cameraProof: proof() });
  await assert.rejects(pending, /取消/); await closing;
  released(f); await empty(f.command.outputDir);
  assert.throws(() => f.sampler.sample(f.command), /已关闭/);
});

test('cleanup failure cannot return success or persist a sample, stop still attempted', async t => {
  for (const kind of ['release', 'stop']) {
    const f = await fixture(t, {
      live(input) { if (kind === 'release' && input.op === 'touch' && input.sequence === 2) throw new Error('release failed'); },
      stop() { if (kind === 'stop') throw new Error('stop failed'); }
    });
    await assert.rejects(f.sampler.sample(f.command), /failed/); released(f); await empty(f.command.outputDir);
  }
});

test('late or mismatched ACK cannot start capture or retry the hold', async t => {
  for (const kind of ['late', 'sequence', 'unaccepted']) {
    const f = await fixture(t, { live(input, { tick }) {
      if (input.op === 'touch' && input.sequence === 1) {
        if (kind === 'late') tick(1200);
        return { accepted: kind !== 'unaccepted', acceptedSequence: kind === 'sequence' ? 4 : 1 };
      }
    } });
    await assert.rejects(f.sampler.sample(f.command)); released(f); await empty(f.command.outputDir);
    assert.equal(f.inputs().some(c => c.cameraFrameProvenance), false);
  }
});

test('concurrent output file is preserved and newly created image is removed on save failure', async t => {
  let f;
  f = await fixture(t, { stop: async () => { await fs.writeFile(path.join(f.command.outputDir, 'sample.json'), 'other writer'); } });
  await assert.rejects(f.sampler.sample(f.command), /EEXIST/);
  assert.deepEqual(await fs.readdir(f.command.outputDir), ['sample.json']);
  assert.equal(await fs.readFile(path.join(f.command.outputDir, 'sample.json'), 'utf8'), 'other writer');
});

test('CLI forwards only explicit native point and resolved new-directory path', async () => {
  const requests = [], io = { stdout: { write() {} }, stderr: { write() {} } };
  const code = await runGameFollowCli(['camera-sample', '--device', 'phone', '--x', '316', '--y', '218', '--output', 'sample-dir'],
    async command => { requests.push(command); return { ok: true, result: {} }; }, io);
  assert.equal(code, 0);
  assert.deepEqual(requests, [{ action: 'phone', method: 'follow-command', params: {
    op: 'camera-sample', id: 'phone', x: 316, y: 218, outputDir: path.resolve('sample-dir')
  } }]);
});

test('CLI rejects missing, fractional, negative, implicit-session and duplicate arguments without requests', async () => {
  const valid = ['camera-sample', '--device', 'phone', '--x', '316', '--y', '218', '--output', 'out'];
  const invalid = [valid.slice(0, -2), valid.filter((_, i) => i !== 1 && i !== 2),
    valid.map(value => value === '316' ? '1.5' : value), valid.map(value => value === '316' ? '-1' : value),
    valid.map(value => value === '316' ? 'NaN' : value), [...valid, '--recover-transport', 'true'],
    [...valid, '--run-id', 'existing'], [...valid, '--x', '44']];
  for (const args of invalid) {
    let called = false;
    assert.equal(await runGameFollowCli(args, async () => { called = true; return { ok: true }; },
      { stdout: { write() {} }, stderr: { write() {} } }), 1);
    assert.equal(called, false);
  }
});
