const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');

async function fixture(t, foreign = false, install = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-internet-service-'));
  const adbCalls = [], methods = [], id = 'internet-' + randomUUID(), epoch = randomUUID();
  const service = new PhonesService({ root, apkPath: path.join(root, 'phone.apk'), computer: 'cloud',
    adb: { run: async args => { adbCalls.push(args); throw new Error('ADB is not installed on this cloud host'); } } });
  const broker = service.internet.broker, abort = new AbortController();
  let closing = false;
  broker.connect(id, epoch);
  const state = { protocol: 1, instanceId: randomUUID(), sessionId: foreign ? randomUUID() : null, generation: 0,
    phase: foreign ? 'controlling' : 'idle', mode: 'control', computer: foreign ? 'local' : 'cloud', controller: 'Codex', task: foreign ? 'other task' : '',
    startedAt: null, lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true },
    readiness: { unlocked: true, computerConnected: true, usbConnected: false, wifiConnected: false, developerOptions: 'disabled', usbDebugging: 'disabled', wirelessDebugging: 'disabled', accessibilityService: 'running', appVersion: '1.0', sdk: 33 } };
  const worker = (async () => {
    try { while (!abort.signal.aborted) {
      const command = await broker.poll(id, epoch, abort.signal); if (!command) continue;
      methods.push(command.method); const { method, body } = command;
      let result = method === 'sync' ? { peerOwnsSession: !foreign } : method === 'package-inspect' ? { status: 'installed', packageName: body.packageName } : { accepted: true };
      if (method === 'package-install') install.artifact = body.artifact;
      if (method === 'package-install-status' || method === 'package-install-receipt') {
        result = { status: 'awaiting-confirmation', sha256: install.artifact.sha256, jobId: body.jobId };
        if (install.pause && state.phase !== 'paused') {
          state.phase = 'paused'; state.pauseCause = install.pause; state.generation++;
          if (install.pause === 'permission') state.permissions.overlay = false;
        }
      }
      if (method === 'start') Object.assign(state, body, { phase: body.mode === 'view' ? 'viewing' : 'controlling', generation: state.generation + 1, startedAt: Date.now() });
      if (method === 'stop' || method === 'pause') { state.phase = method === 'pause' ? 'paused' : 'stopped'; state.generation++; }
      broker.respond(id, epoch, command.id, { ok: true, state: structuredClone(state), result });
    } } catch (error) { if (!abort.signal.aborted && !closing) throw error; }
  })();
  t.after(async () => { closing = true; await service.close(); abort.abort(); await worker; if (foreign) assert.ok(!methods.includes('stop')); fs.rmSync(root, { recursive: true, force: true }); });
  await service.internetConnected(id, 'Realme', epoch);
  return { service, id, state, adbCalls, methods, broker, epoch, root };
}
test('internet control observes, inputs and inspects without any device ADB route', async t => {
  const f = await fixture(t);
  await f.service.refresh();
  const readiness = await f.service.readiness(f.id);
  assert.equal(readiness.readyToStart, true); assert.equal(readiness.capabilities.screenshot, 'available');
  const device = await f.service.start(f.id, 'control', 'Codex', 'cloud acceptance', 'external');
  assert.equal(device.transport, 'internet');
  const result = await f.service.perform({ id: f.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'snapshot' } });
  assert.equal(result.result.accepted, true);
  assert.equal((await f.service.inspectPhone(f.id, 'app', { packageName: 'com.example.app' })).status, 'installed');
  await f.service.control(f.id, 'pause');
  await assert.rejects(f.service.perform({ id: f.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'tap', x: 1, y: 1 } }), e => e.code === 'PHONE_USER_IN_CONTROL');
  assert.equal(f.methods.filter(m => m === 'action').length, 1);
  assert.ok(f.adbCalls.every(args => !args.includes('-s')), 'no phone-specific ADB requests');
});

for (const pause of [undefined, 'permission', 'manual']) test('internet install hands off system confirmation but respects manual takeover: ' + pause, async t => {
  const f = await fixture(t, false, { pause });
  const apk = path.join(f.root, 'app.apk'), bytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
  fs.writeFileSync(apk, bytes);
  const task = await f.service.startWrapper(f.id, 'control', 'Codex', 'install test');
  await f.service.installWrapper(task.lease, task.device.state.generation, apk, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  let result;
  for (let n = 0; n < 50; n++) {
    result = f.service.installWrapperStatus(task.lease);
    if (result.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (pause === 'manual') {
    assert.notEqual(result.status, 'awaiting-user');
    assert.ok(f.methods.includes('package-install-cancel'));
  } else {
    assert.equal(result.status, 'awaiting-user');
    assert.match(result.jobId, /^[a-f0-9-]{36}$/);
    assert.ok(!f.methods.includes('package-install-cancel'));
  }
  await f.service.stopWrapper(task.lease);
  assert.equal(f.state.phase, 'stopped');
  assert.ok(f.adbCalls.every(args => !args.includes('-s')));
});
test('connecting the cloud does not pause or inherit another computer session', async t => {
  const f = await fixture(t, true);
  assert.equal(f.state.phase, 'controlling'); assert.ok(!f.methods.includes('pause'));
  await assert.rejects(f.service.start(f.id, 'control', 'Codex', 'other'), e => e.code === 'PHONE_SESSION_CONFLICT');
  await assert.rejects(f.service.basicStart(f.id, 'control', 'Codex', 'basic'), e => e.code === 'PHONE_OPERATION_UNSUPPORTED');
  assert.ok(!f.methods.includes('start'));
  // Teardown must not send control to a foreign phone lease; the real phone
  // peer policy rejects it too, independently of host behavior.
});
