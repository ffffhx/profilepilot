const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { inspectApk } = loadCli('src/main/phones/apk.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-apk-'));
  const id = '192.168.1.8:40123', token = 'b'.repeat(64), calls = [];
  const apk = path.join(root, '手机 更新 $test.apk');
  fs.writeFileSync(apk, Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ [id]: { token } }));
  const h = { root, apk, id, calls, install: async () => 'Performing Streamed Install\nSuccess',
    state: { protocol: 1, instanceId: 'phone', sessionId: null, generation: 0, phase: 'idle', mode: 'control', computer: 'pc', controller: '', task: '', startedAt: null, lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true } } };
  h.service = new PhonesService({ root, apkPath: path.join(root, 'companion.apk'), adb: { run: async (args, timeout, input, signal) => {
    calls.push(args);
    if (args[0] === 'devices') return `${id} device model:Phone`;
    if (args.includes('tcp:0')) return '18762';
    if (args[2] === 'install') return h.install(args, signal);
    return '';
  } }, request: async (_port, _token, method, body) => {
    if (method === 'start') Object.assign(h.state, { ...body, generation: h.state.generation + 1, phase: body.mode === 'view' ? 'viewing' : 'controlling' });
    if (['stop', 'pause'].includes(method)) { h.state.generation++; h.state.phase = method === 'stop' ? 'stopped' : 'paused'; }
    return { ok: true, state: structuredClone(h.state) };
  } });
  t.after(async () => { await h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}
async function owner(h, mode = 'control') { return h.service.startWrapper(h.id, mode, 'test', 'install APK'); }
async function finished(service, lease) {
  for (let i = 0; i < 100; i++) {
    const value = service.installWrapperStatus(lease);
    if (value.status !== 'running') return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('install did not settle');
}

test('managed installer stages exact bytes, replaces without clearing data, and never launches an app', async t => {
  const h = harness(t), checked = await inspectApk(h.apk), task = await owner(h);
  h.install = async (args, signal) => {
    assert.deepEqual(args.slice(0, 4), ['-s', h.id, 'install', '-r']);
    assert.equal(args.length, 5); assert.equal(signal.aborted, false);
    assert.deepEqual(fs.readFileSync(args[4]), fs.readFileSync(h.apk));
    assert.notEqual(args[4], h.apk);
    return 'Success';
  };
  await h.service.installWrapper(task.lease, task.device.state.generation, h.apk, checked.sha256);
  assert.equal((await finished(h.service, task.lease)).status, 'installed');
  await h.service.stopWrapper(task.lease);
  assert.equal(h.state.phase, 'stopped');
  assert.equal(h.calls.filter(args => args[2] === 'install').length, 1);
  assert.ok(!h.calls.some(args => args.includes('uninstall') || args.includes('-g') || args.includes('-d')));
});

test('view, paused and stale-generation sessions cannot install', async t => {
  const h = harness(t), checked = await inspectApk(h.apk), view = await owner(h, 'view');
  await assert.rejects(h.service.installWrapper(view.lease, view.device.state.generation, h.apk, checked.sha256), /控制会话/);
  await h.service.stopWrapper(view.lease);
  const task = await owner(h);
  await assert.rejects(h.service.installWrapper(task.lease, task.device.state.generation + 1, h.apk, checked.sha256), /会话已改变/);
  await h.service.control(h.id, 'pause');
  await assert.rejects(h.service.installWrapper(task.lease, h.state.generation, h.apk, checked.sha256), /已暂停/);
  assert.equal(h.calls.filter(args => args[2] === 'install').length, 0);
});

test('changed APK is rejected before installation; request cannot be replayed in the same lease', async t => {
  const h = harness(t), checked = await inspectApk(h.apk), task = await owner(h);
  fs.appendFileSync(h.apk, 'changed');
  await h.service.installWrapper(task.lease, task.device.state.generation, h.apk, checked.sha256);
  assert.match((await finished(h.service, task.lease)).error, /APK 已改变/);
  await assert.rejects(h.service.installWrapper(task.lease, task.device.state.generation, h.apk, checked.sha256), /不要重试/);
  assert.equal(h.calls.filter(args => args[2] === 'install').length, 0);
});

test('phone-side pause aborts the install process, preserves pause and reports uncertain result without retry', async t => {
  const h = harness(t), checked = await inspectApk(h.apk), task = await owner(h);
  h.install = async (_args, signal) => {
    h.state.phase = 'paused'; h.state.generation++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  await h.service.installWrapper(task.lease, task.device.state.generation, h.apk, checked.sha256);
  const result = await finished(h.service, task.lease);
  assert.equal(result.status, 'interrupted'); assert.match(result.error, /核对手机上的安装结果/);
  assert.equal(h.state.phase, 'paused');
  assert.equal(h.calls.filter(args => args[2] === 'install').length, 1);
});

test('Android failure output is not reported as success', async t => {
  const h = harness(t), checked = await inspectApk(h.apk), task = await owner(h);
  h.install = async () => 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]';
  await h.service.installWrapper(task.lease, task.device.state.generation, h.apk, checked.sha256);
  const result = await finished(h.service, task.lease);
  assert.equal(result.status, 'failed'); assert.match(result.error, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
});

test('CLI manages one lease and resolves Unicode paths without exposing arbitrary ADB flags', async t => {
  const h = harness(t), calls = [], stdout = [], stderr = [];
  const request = async command => {
    calls.push(command);
    const data = command.method === 'wrapper-start' ? { lease: 'owner', device: { state: { generation: 3 } } }
      : command.method === 'wrapper-install-status' ? { status: 'installed', ...(await inspectApk(h.apk)) } : {};
    return { ok: true, data };
  };
  const io = { stdout: { write: v => stdout.push(v) }, stderr: { write: v => stderr.push(v) } };
  assert.equal(await runPhoneCli(['install', '--device', h.id, '--apk', h.apk], request, io), 0);
  assert.deepEqual(calls.map(c => c.method), ['wrapper-start', 'wrapper-install', 'wrapper-install-status', 'wrapper-stop']);
  assert.equal(calls[1].params.apk, h.apk);
  calls.length = 0;
  assert.equal(await runPhoneCli(['install', '--device', h.id, '--apk', h.apk, '-g'], request, io), 1);
  assert.equal(calls.length, 0);
});

test('non-APK, folders and malformed archives fail before acquiring phone control', async t => {
  const h = harness(t);
  await assert.rejects(inspectApk(h.root), /APK/);
  fs.writeFileSync(h.apk, 'not a zip');
  await assert.rejects(inspectApk(h.apk), /APK/);
});
