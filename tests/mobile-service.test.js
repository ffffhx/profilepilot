const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { loadTsModule } = require('./helpers/load-ts-module');
const { MobileService, mobileEndpoint } = loadTsModule('src/main/mobile/service.ts');
const { TaskStore } = loadTsModule('src/main/tasks/store.ts');
const { TaskService } = loadTsModule('src/main/tasks/service.ts');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mobile-'));
  const store = new TaskStore(path.join(root, 'tasks'));
  const snapshots = [];
  const tasks = new TaskService(store, { browser: { control: async () => {}, tabs: async () => [] }, apiKey: () => '', prepareProfile: async () => ({ name: 'Work', port: 9223 }), profileName: async () => 'Work', changed: s => snapshots.push(s), notify: () => {} });
  tasks.tick = async () => {};
  const options = { root: path.join(root, 'mobile'), tasks, computerName: 'Test PC', profiles: async () => [{ id: 'isolated:work', name: 'Work', source: 'isolated', ready: true }] };
  let service = new MobileService(options);
  assert.equal(service.snapshot().port, 0);
  assert.deepEqual(service.snapshot().endpoints, [], 'no unusable addresses before the OS assigns a port');
  await service.configure({ enabled: true });
  assert.ok(service.snapshot().port > 0);
  assert.ok(service.snapshot().endpoints.every(endpoint => new URL(endpoint).port !== '0'));
  const tls = JSON.parse(fs.readFileSync(path.join(options.root, 'identity.json'), 'utf8'));
  const transport = (route, body, token, headers = {}, fingerprint) => new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: service.snapshot().port, path: route, method: 'POST', ca: tls.cert, agent: false,
      checkServerIdentity: (_name, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === (fingerprint || service.snapshot().fingerprint) ? undefined : new Error('Certificate pin mismatch'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Timeout'))); request.end(JSON.stringify(body));
  });
  const pairing = await service.pair('https://127.0.0.1:' + service.snapshot().port), params = new URL(pairing.uri).searchParams;
  const pairInput = { token: params.get('token'), name: 'My phone', clientId: randomUUID() };
  const paired = await transport('/v1/pair', pairInput);
  assert.equal(paired.ok, true);
  const credential = paired.data;
  t.after(async () => { await service.close(); await tasks.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, tasks, snapshots, pairing, pairInput, credential, transport,
    get service() { return service; },
    request: (command, overrides = {}) => transport('/v1/request', { requestId: randomUUID(), issuedAt: Date.now(), command, ...overrides }, credential.token),
    restart: async () => { await service.close(); service = new MobileService(options); await service.start(); }
  };
}

test('phone creates and controls the same persisted PC task and receives its result', async t => {
  const f = await fixture(t);
  const sync = await f.request({ action: 'sync' });
  assert.equal(sync.data.computerName, 'Test PC'); assert.equal(sync.data.profiles[0].id, 'isolated:work');
  const created = await f.request({ action: 'task.create', profile: 'isolated:work', input: { prompt: '从手机创建任务', mode: 'manual' } });
  assert.equal(created.ok, true); const id = created.data.task.id;
  assert.equal(f.store.get(id).prompt, '从手机创建任务'); assert.equal(f.store.get(id).mode, 'manual');
  assert.equal((await f.request({ action: 'task.control', id, control: 'pause' })).data.task.status, 'paused');
  assert.equal((await f.request({ action: 'task.control', id, control: 'resume' })).data.task.status, 'queued');
  await f.request({ action: 'task.control', id, control: 'queue', message: '手机追加说明', requestId: randomUUID() });
  const task = f.store.get(id); task.status = 'completed'; task.result = { summary: '真实服务中的任务结果', evidence: [], remaining: [] }; f.tasks.publish();
  const detail = await f.request({ action: 'task.get', id });
  assert.equal(detail.data.task.result.summary, task.result.summary);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).tasks[0].id, id);
  assert.equal('authorization' in detail.data.task, false); assert.equal('settings' in detail.data, false);
});

test('mobile confirmation requires explicit consent and rejects a stale decision', async t => {
  const f = await fixture(t);
  const task = f.store.create({ profileId: 'isolated:work', prompt: 'Confirmation test' }, 'Work');
  task.status = 'waiting_user'; task.pending = { id: randomUUID(), kind: 'confirmation', title: '发送消息', details: '将向指定联系人发送测试消息。', createdAt: new Date().toISOString() }; f.tasks.publish();
  const state = await f.request({ action: 'sync' }); assert.equal(state.data.tasks[0].pending.id, task.pending.id);
  const command = { action: 'task.reply', id: task.id, decisionId: task.pending.id, answer: '' };
  assert.equal((await f.request(command)).error.code, 'TASK_APPROVAL_REQUIRED');
  assert.equal((await f.request({ ...command, decisionId: randomUUID(), approved: true })).ok, false);
  assert.equal((await f.request({ ...command, approved: false })).ok, true);
  assert.equal(task.pending, undefined);
});

test('retries and a server restart never create the same task twice', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const command = { action: 'task.create', profile: 'isolated:work', input: { prompt: 'Idempotent task' } };
  const results = await Promise.all([f.request(command, { requestId }), f.request(command, { requestId })]);
  assert.equal(results[0].data.task.id, results[1].data.task.id); assert.equal(f.store.data.tasks.length, 1);
  const fingerprint = f.service.snapshot().fingerprint, port = f.service.snapshot().port;
  await f.restart();
  assert.equal(f.service.snapshot().fingerprint, fingerprint); assert.equal(f.service.snapshot().port, port);
  assert.equal((await f.request(command, { requestId })).data.task.id, results[0].data.task.id);
  assert.equal((await f.request({ ...command, input: { prompt: 'Different' } }, { requestId })).error.code, 'MOBILE_REQUEST_CONFLICT');
  assert.equal(f.store.data.tasks.length, 1);
  assert.equal((await f.request(command, { issuedAt: Date.now() - 11 * 60000 })).error.code, 'MOBILE_REQUEST_EXPIRED');
});

test('pairing, certificate pinning, revocation and read-only permission are enforced', async t => {
  const f = await fixture(t);
  assert.match(f.pairing.qr, /^data:image\/png;base64,/);
  assert.equal((await f.transport('/v1/pair', f.pairInput)).data.deviceId, f.credential.deviceId);
  assert.equal((await f.transport('/v1/pair', { ...f.pairInput, clientId: randomUUID() })).error.code, 'MOBILE_PAIR_USED');
  await assert.rejects(f.transport('/v1/request', {}, f.credential.token, {}, '0'.repeat(64)), /pin mismatch/);
  f.service.updateDevice(f.credential.deviceId, { canControl: false });
  assert.equal((await f.request({ action: 'sync' })).data.canControl, false);
  assert.equal((await f.request({ action: 'task.create', profile: 'isolated:work', input: { prompt: 'Denied' } })).error.code, 'MOBILE_READ_ONLY');
  f.service.revoke(f.credential.deviceId);
  assert.equal((await f.request({ action: 'sync' })).error.code, 'MOBILE_UNAUTHORIZED');
  assert.equal((await f.transport('/v1/pair', f.pairInput)).error.code, 'MOBILE_PAIR_EXPIRED');
});

test('network clients cannot invoke desktop administration or import arbitrary local files', async t => {
  const f = await fixture(t);
  for (const command of [{ action: 'task.settings.get' }, { action: 'task.settings.update', input: { apiKey: 'forbidden' } }, { action: 'task.attachments.import', paths: ['C:/private/file'] }, { action: 'profile.delete' }]) assert.equal((await f.request(command)).ok, false);
  const body = { requestId: randomUUID(), issuedAt: Date.now(), command: { action: 'sync' } };
  assert.equal((await f.transport('/v1/request', body, undefined)).error.code, 'MOBILE_UNAUTHORIZED');
  assert.equal((await f.transport('/v1/request', body, f.credential.token, { Origin: 'https://evil.example' })).ok, false);
  assert.equal(JSON.stringify(f.service.snapshot()).includes(f.credential.token), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'mobile/mobile.json'), 'utf8').includes(f.credential.token), false);
  for (const endpoint of ['http://localhost:1234', 'https://user:pass@pc', 'https://pc/path', 'https://pc/?token=a', 'https://192.168.0.100:0']) assert.throws(() => mobileEndpoint(endpoint));
});

test('phone disconnect revokes only its credential and preserves desktop tasks', async t => {
  const f = await fixture(t);
  f.store.create({ profileId: 'isolated:work', prompt: 'Keep this task' }, 'Work');
  assert.equal((await f.request({ action: 'device.disconnect' })).data.disconnected, true);
  assert.equal((await f.request({ action: 'sync' })).error.code, 'MOBILE_UNAUTHORIZED');
  assert.equal(f.store.data.tasks.length, 1);
});

test('mobile downloads only registered task outputs and keeps PC paths private', async t => {
  const f = await fixture(t);
  const task = f.store.create({ profileId: 'isolated:work', prompt: 'Task output' }, 'Work');
  const file = { id: randomUUID(), name: 'result.txt', path: path.join(f.root, 'result.txt'), size: 6, createdAt: new Date().toISOString() };
  fs.writeFileSync(file.path, 'result'); task.outputs = [file]; f.tasks.publish();
  const detail = await f.request({ action: 'task.get', id: task.id });
  assert.equal(detail.data.task.outputs[0].path, undefined);
  const downloaded = await f.request({ action: 'task.artifact', taskId: task.id, fileId: file.id });
  assert.equal(Buffer.from(downloaded.data.base64, 'base64').toString(), 'result');
  assert.equal((await f.request({ action: 'task.artifact', taskId: task.id, fileId: randomUUID() })).ok, false);
  fs.writeFileSync(file.path, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.match((await f.request({ action: 'task.artifact', taskId: task.id, fileId: file.id })).error.message, /8 MB/);
});
