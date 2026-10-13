const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { ScreenCamera, cameraStartSchema, cameraCommandSchema } = loadCli('src/main/phones/screen-camera.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function harness(t, sdk = 36) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-camera-'));
  const dexPath = path.join(root, 'camera.dex'); fs.writeFileSync(dexPath, 'fixture dex');
  const h = { root, sdk, allowed: true, commands: [], captured: [], closed: 0, workers: [], captureError: null };
  const lease = h.lease = { id: 'camera-test-device', sessionId: 'owned-session', generation: 4 };
  h.camera = new ScreenCamera({ root, dexPath,
    adb: { run: async args => args.join(' ').includes('version.sdk') ? String(sdk) : args.join(' ').includes('version.release') ? '16' : '' },
    authorize: async input => { assert.equal(input.sessionId, lease.sessionId); await h.beforeAuthorize?.(); if (!h.allowed) throw Error('phone paused'); return { instanceId: 'instance', token: 'a'.repeat(64) }; },
    capture: { sources: async () => [{ id: 'window:123:0', name: 'Work Profile', thumbnail: 'data:image/png;base64,AAAA' }],
      capture: async (id, crop) => { h.captured.push({ id, crop }); if (h.captureError) throw h.captureError; return 'AAAA'; } },
    spawnWorker: () => {
      const worker = { request: async (op, params) => {
        h.commands.push({ op, params });
        await h.beforeRequest?.(op);
        if (op === 'probe') return { supported: true, sdk, release: '16', reason: '' };
        if (op === 'preview') return { mime: 'image/jpeg', base64: 'AAAA', width: 720, height: 1280 };
        return { displayId: 5, cameraId: 'virtual-camera', width: 720, height: 1280, framesReceived: op === 'frame' ? 1 : 0, framesRendered: 0, streams: 0, error: '' };
      }, close: () => { h.closed++; } }; h.workers.push(worker); return worker;
    }
  });
  t.after(() => { h.camera.stop(); fs.rmSync(root, { recursive: true, force: true }); }); return h;
}

test('old Android rejects camera without creating a worker or pretending to scan an album', async t => {
  const h = harness(t, 33); const support = await h.camera.probe(h.lease.id);
  assert.equal(support.supported, false); assert.match(support.reason, /Android 16/); assert.equal(h.workers.length, 0);
  await assert.rejects(h.camera.start(h.lease), /Android 16/); assert.equal(h.workers.length, 0);
});
test('camera preserves selected source and normalized crop; rejects takeover and stale input', async t => {
  const h = harness(t), crop = { x: .25, y: .1, width: .4, height: .6 };
  const state = await h.camera.start({ ...h.lease, sourceId: 'window:123:0', crop });
  assert.equal(state.active, true); assert.deepEqual(h.captured[0], { id: 'window:123:0', crop });
  await assert.rejects(h.camera.start(h.lease), /已有/);
  await assert.rejects(h.camera.command({ ...h.lease, generation: 3, op: 'tap', x: 1, y: 1 }), /会话已改变/);
  assert.equal(h.commands.some(c => c.op === 'tap'), false);
  h.allowed = false;
  await assert.rejects(h.camera.command({ ...h.lease, op: 'tap', x: 1, y: 1 }), /paused/);
  assert.equal(h.commands.some(c => c.op === 'tap'), false);
  await h.camera.command({ ...h.lease, op: 'stop' });
  assert.equal(h.camera.snapshot(h.lease.id).active, false);
});
test('lost source ends camera rather than switching to another window or monitor', async t => {
  const h = harness(t); h.captureError = Error('selected window closed');
  await assert.rejects(h.camera.start({ ...h.lease, sourceId: 'window:123:0' }), /selected window closed/);
  assert.equal(h.camera.snapshot(h.lease.id).active, false); assert.equal(h.commands.some(c => c.op === 'frame'), false);
});
test('file frame mode leaves desktop uncaptured and accepts only bounded commands', async t => {
  const h = harness(t); await h.camera.start(h.lease);
  assert.equal(h.captured.length, 0);
  await h.camera.command({ ...h.lease, op: 'frame', base64: 'AAAA' });
  assert.equal(h.commands.filter(c => c.op === 'frame').length, 1);
  assert.throws(() => cameraStartSchema.parse({ ...h.lease, crop: { x: .8, y: 0, width: .5, height: .5 } }));
  assert.throws(() => cameraCommandSchema.parse({ ...h.lease, op: 'launch', component: 'com.test/.Main; reboot' }));
  assert.throws(() => cameraCommandSchema.parse({ ...h.lease, op: 'tap', x: 720, y: 0 }));
});
test('CLI uses BOM-safe JSON and binary image reads, never shell redirection', async t => {
  const h = harness(t), params = path.join(h.root, 'current session.json'), png = path.join(h.root, 'qr code.png');
  fs.writeFileSync(params, '\ufeff' + JSON.stringify(h.lease)); fs.writeFileSync(png, Buffer.from([137,80,78,71]));
  let sent, stdout = '', stderr = '';
  const code = await runPhoneCli(['camera', 'frame', '--params-file', params, '--file', png], async command => {
    sent = command; return { ok: true, data: {} };
  }, { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } });
  assert.equal(code, 0, stderr); assert.equal(sent.method, 'camera-command'); assert.equal(sent.params.base64, 'iVBORw==');
  assert.equal(sent.params.sessionId, h.lease.sessionId); assert.ok(JSON.parse(stdout).ok);
});

test('closing the owner during startup cancels before creating a camera and detaches listeners', async t => {
  const h = harness(t), controller = new AbortController();
  let release, entered, detached = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.beforeAuthorize = () => new Promise(resolve => { release = resolve; entered(); });
  const starting = h.camera.start(h.lease, { signal: controller.signal, detached: () => detached++ });
  await waiting; controller.abort(); release();
  await assert.rejects(starting, /取消/);
  assert.equal(detached, 1); assert.equal(h.commands.some(c => c.op === 'start'), false);
  h.beforeAuthorize = undefined;
  await h.camera.start(h.lease); assert.equal(h.camera.snapshot(h.lease.id).active, true);
});

test('stop arriving while authorizing input prevents that input from reaching Android', async t => {
  const h = harness(t); await h.camera.start(h.lease);
  h.beforeAuthorize = () => { h.camera.stopFor(h.lease.id, 'phone paused'); };
  await assert.rejects(h.camera.command({ ...h.lease, op: 'tap', x: 1, y: 1 }), /已停止/);
  assert.equal(h.commands.some(c => c.op === 'tap'), false);
});

test('ending an inactive old device does not cancel another device starting', async t => {
  const h = harness(t); await h.camera.start(h.lease); h.camera.stop();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.beforeAuthorize = () => new Promise(resolve => { release = resolve; entered(); });
  const next = { ...h.lease, id: 'second-camera-device' }, starting = h.camera.start(next);
  await waiting; h.camera.stopFor(h.lease.id); h.beforeAuthorize = undefined; release();
  assert.equal((await starting).active, true); assert.equal(h.camera.snapshot(next.id).active, true);
});

test('owner teardown is removed when a camera stops and cannot cancel a later session', async t => {
  const h = harness(t), controller = new AbortController(); let detached = 0;
  await h.camera.start(h.lease, { signal: controller.signal, detached: () => detached++ });
  h.camera.stop(); assert.equal(detached, 1);
  await h.camera.start(h.lease); controller.abort();
  assert.equal(h.camera.snapshot(h.lease.id).active, true);
});
