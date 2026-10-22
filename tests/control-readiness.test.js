const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadCli } = require('./cli-test-build.cjs');
const { phoneReadiness } = loadCli('src/shared/phone-readiness.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const { browserReadiness, createBrowserDoctor, waitForBrowserControl } = loadCli('src/main/control-doctor.ts');
const { NATIVE_REQUIRED_CAPABILITIES } = loadCli('src/main/tasks/native-compatibility.ts');

const device = () => ({ id: 'device-1', hardwareId: 'hardware-1', connection: 'device', transport: 'wifi', companion: 'ready',
  state: { phase: 'idle', sessionId: null, permissions: { accessibility: true, overlay: true, notifications: true }, readiness: { appVersion: '0.3.6-dev', unlocked: true } } });

test('phone readiness separates live transport, permissions, boot and legacy screenshot capabilities', () => {
  const current = device(); current.state.permissions.overlay = false; current.state.permissions.notifications = false;
  const report = phoneReadiness(current, { sdk: 29, bootCompleted: true });
  assert.equal(report.readyToStart, false);
  assert.deepEqual(report.checks.filter(c => c.status === 'blocked').map(c => c.id), ['overlay', 'notifications']);
  assert.equal(report.capabilities.nativeSelectors, 'available'); assert.equal(report.capabilities.screenshot, 'unavailable');
  const offline = phoneReadiness({ ...device(), connection: 'offline' }, { sdk: 35 });
  assert.equal(offline.capabilities.input, 'unavailable'); assert.equal(offline.runtime.app.versionName, null);
  assert.equal(offline.checks.find(c => c.id === 'accessibility').status, 'unknown');
  assert.equal(phoneReadiness(device(), { bootCompleted: false, sdk: 35 }).readyToStart, false);
  const unreachable = phoneReadiness(device(), { responding: false });
  assert.equal(unreachable.readyToStart, false); assert.equal(unreachable.capabilities.input, 'unavailable');
  assert.equal(unreachable.checks.find(c => c.id === 'device-response').status, 'blocked');
});

test('a paused App session remains occupied when inspecting basic mode', () => {
  const current = device(); Object.assign(current.state, { sessionId: 'one', phase: 'paused', controller: 'Other', task: 'Existing task' });
  assert.equal(phoneReadiness(current, {}, 'basic').readyToStart, false);
  assert.equal(phoneReadiness(current, {}, 'basic').automaticBackendSwitch, false);
});

test('phone doctor is read-only and a null session is rejected locally before device dispatch', async t => {
  const calls = [], output = [];
  const io = { stdout: { write: s => output.push(s) }, stderr: { write: s => output.push(s) } };
  const request = async c => { calls.push(c); return { ok: true, data: { readyToStart: false } }; };
  assert.equal(await runPhoneCli(['doctor', '--device', 'device-1', '--backend', 'basic'], request, io), 0);
  assert.deepEqual(calls, [{ action: 'phone', method: 'readiness', params: { id: 'device-1', backend: 'basic' } }]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone readiness 空格 ')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '动作.json'); fs.writeFileSync(file, JSON.stringify({ id: 'device-1', sessionId: null, generation: 1, requestId: 'new', action: { kind: 'tap', x: 1, y: 1 } }));
  assert.equal(await runPhoneCli(['action', '--params-file', file], request, io), 1);
  assert.equal(calls.length, 1); const failure = JSON.parse(output.at(-1));
  assert.equal(failure.code, 'PHONE_INVALID_REQUEST'); assert.equal(failure.recovery.actionOutcome, 'not-executed');
});

test('browser diagnostics distinguish incompatible, stale, occupied and technically interrupted targets', () => {
  const profile = { profileId: 'native:fixture', connected: true, taskTabs: true, extensionVersion: '0.2.9', capabilities: [...NATIVE_REQUIRED_CAPABILITIES], installationType: 'development' };
  assert.equal(browserReadiness({ profiles: [profile] }, '0.2.9')[0].readyToClaim, true);
  assert.equal(browserReadiness({ profiles: [{ ...profile, capabilities: [] }] }, '0.2.9')[0].readyToClaim, false);
  const occupied = { ...profile, ownerSessionId: 'one', ownership: 'user', controlIssue: { code: 'NATIVE_EXTENSION_FRAME_CONFLICT', message: 'extension conflict' } };
  const report = browserReadiness({ profiles: [occupied], sessions: [{ sessionId: 'one', title: 'Upload', controller: 'Codex' }] }, '0.2.10')[0];
  assert.equal(report.readyToClaim, false); assert.equal(report.owner.title, 'Upload');
  assert.equal(report.checks.find(c => c.id === 'extension-version').status, 'warning');
  assert.equal(report.checks.find(c => c.id === 'control').status, 'error');
  assert.equal(report.observationVerified, false);
});

test('doctor checks the live service and wait-control observes release without claiming or resuming', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser readiness 空格 ')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; let owner = 'other';
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const c = JSON.parse(text); calls.push(c.method);
    res.end(JSON.stringify({ ok: true, result: c.method === 'ping' ? { pid: process.pid, build: { buildId: 'old' } } : {
      profiles: [{ profileId: 'native:test', connected: true, ownerSessionId: owner, ownership: 'agent', taskTabs: true, capabilities: [...NATIVE_REQUIRED_CAPABILITIES], extensionVersion: '0.2.9' }], sessions: []
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, 'native-control.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, token: 'a'.repeat(64) }));
  const report = await createBrowserDoctor({ root }); assert.equal(report.service.build.buildId, 'old');
  assert.equal(report.checks.find(c => c.id === 'service-build').status, 'warning');
  setTimeout(() => { owner = undefined; }, 25);
  const ready = await waitForBrowserControl({ root, profileId: 'native:test', sessionId: 'self', timeoutMs: 1000 });
  assert.equal(ready.available, true); assert.equal(ready.claimed, false); assert.equal(ready.resumed, false);
  assert.ok(calls.every(c => ['ping', 'status'].includes(c)));
});
