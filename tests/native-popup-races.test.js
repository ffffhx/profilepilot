const test = require('node:test');
const assert = require('node:assert/strict');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('slow polling is single flight and leaves the last known connection visible', async () => {
  const f = await popupFixture([]), reply = deferred();
  f.handlers.state = () => reply.promise;
  await f.poll(); await f.poll(); await f.poll();
  assert.equal(f.calls.filter(c => c.method === 'state').length, 2);
  assert.equal(f.element('#connection-label').textContent, '已连接');
  reply.resolve({ result: { ...f.state, connected: false } }); await f.flush();
  assert.equal(f.element('#connection-label').textContent, '未连接');
});

test('an old status reply cannot overwrite a newly paired Profile', async () => {
  const f = await popupFixture([], { state: { profileId: undefined, connected: false } }), old = deferred();
  f.handlers.state = () => old.promise;
  await f.poll();
  f.handlers.connect = () => ({ result: { profileId: 'native:Profile 2', connected: true } });
  f.element('#code').value = 'PP1.fixture'; await f.submit('#connect');
  old.resolve({ result: f.state }); await f.flush();
  assert.equal(f.element('#profile-name').textContent, 'Profile 2');
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.equal(f.element('#connect').hidden, true);
});

test('an old status reply cannot overwrite an explicit reconnect', async () => {
  const f = await popupFixture([], { state: { connected: false } }), old = deferred();
  f.handlers.state = () => old.promise; await f.poll();
  f.handlers.reconnect = () => ({ result: { ...f.state, connected: true } });
  await f.element('#reconnect').onclick();
  old.resolve({ result: f.state }); await f.flush();
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.equal(f.element('#reconnect').hidden, true);
});

test('duplicate pairing submits and polls cannot run during pairing', async () => {
  const f = await popupFixture([], { state: { connected: false, profileId: undefined } }), reply = deferred();
  f.handlers.connect = () => reply.promise;
  f.element('#code').value = 'PP1.fixture';
  const sending = f.submit('#connect');
  await f.submit('#connect'); await f.poll();
  assert.equal(f.element('#connect-submit').disabled, true);
  assert.deepEqual(f.calls.map(c => c.method), ['state', 'connect']);
  reply.resolve({ result: { profileId: 'native:Default', connected: true } }); await sending;
  assert.equal(f.element('#connect-submit').disabled, false);
  assert.equal(f.element('#code').value, '');
});

test('a worker error removes a stale connected indicator and recovers on the next poll', async () => {
  const f = await popupFixture([]);
  f.handlers.state = () => ({ error: 'Worker unavailable' }); await f.poll();
  assert.equal(f.element('#connection-label').textContent, '状态暂不可用');
  assert.equal(f.element('#controlled-tab').hidden, true);
  delete f.handlers.state; await f.poll();
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.equal(f.element('#controlled-tab').hidden, false);
});
