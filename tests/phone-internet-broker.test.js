const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { InternetPhoneBroker } = loadCli('src/main/phones/internet-broker.ts');

function broker(t, options = {}) {
  const value = new InternetPhoneBroker({ pollTimeoutMs: 15, requestTimeoutMs: 200, ...options });
  t.after(() => value.close());
  value.connect('phone-a', 'connection-a');
  return value;
}
test('outbound phone poll delivers a request once and correlates its response', async t => {
  const value = broker(t);
  const waiting = value.poll('phone-a', 'connection-a');
  const body = { sessionId: 'owned', action: { kind: 'snapshot' } };
  const pending = value.request('phone-a', 'action', body);
  body.action.kind = 'tap';
  const command = await waiting;
  assert.equal(command.method, 'action');
  assert.equal(command.body.action.kind, 'snapshot');
  assert.equal(await value.poll('phone-a', 'connection-a'), null, 'a dispatched command is never redelivered');
  value.respond('phone-a', 'connection-a', command.id, { ok: true, result: 'snapshot' });
  assert.deepEqual(await pending, { ok: true, result: 'snapshot' });
  value.respond('phone-a', 'connection-a', command.id, { ok: true });
  assert.equal(await value.poll('phone-a', 'connection-a'), null);
});
test('disconnect distinguishes a queued request from an uncertain dispatched action', async t => {
  const value = broker(t);
  const first = value.request('phone-a', 'action', {});
  const firstFailure = assert.rejects(first, e => e.code === 'PHONE_DISCONNECTED' && e.actionOutcome === 'unknown');
  await value.poll('phone-a', 'connection-a');
  const second = value.request('phone-a', 'start', {});
  const secondFailure = assert.rejects(second, e => e.code === 'PHONE_DISCONNECTED' && e.actionOutcome === 'not-executed');
  value.disconnect('phone-a');
  await Promise.all([firstFailure, secondFailure]);
  value.connect('phone-a', 'connection-b');
  assert.equal(await value.poll('phone-a', 'connection-b'), null, 'reconnect does not replay either request');
});
test('connection replacement rejects old results and cannot disconnect the new route', async t => {
  const value = broker(t);
  const pending = value.request('phone-a', 'action', {});
  const rejected = assert.rejects(pending, e => e.actionOutcome === 'unknown');
  const command = await value.poll('phone-a', 'connection-a');
  assert.equal(value.connect('phone-a', 'connection-b').replaced, true);
  await rejected;
  assert.throws(() => value.respond('phone-a', 'connection-a', command.id, { ok: true }), /连接已改变/);
  value.disconnect('phone-a', 'connection-a');
  assert.equal(value.connection('phone-a'), 'connection-b');
  assert.equal(await value.poll('phone-a', 'connection-b'), null);
});
test('expiry before dispatch produces no command and expiry after dispatch remains unknown', async t => {
  let now = 0;
  const value = broker(t, { now: () => now, requestTimeoutMs: 30 });
  const queued = value.request('phone-a', 'start', {});
  const expired = assert.rejects(queued, e => e.code === 'PHONE_REQUEST_EXPIRED' && e.actionOutcome === 'not-executed');
  now = 31;
  assert.equal(await value.poll('phone-a', 'connection-a'), null);
  await expired;
  const sent = value.request('phone-a', 'action', {});
  const uncertain = assert.rejects(sent, e => e.code === 'PHONE_EXECUTION_UNCERTAIN' && e.actionOutcome === 'unknown');
  const command = await value.poll('phone-a', 'connection-a');
  await uncertain;
  assert.throws(() => value.respond('phone-a', 'connection-a', command.id, { ok: true }), /请求已结束/);
  assert.equal(await value.poll('phone-a', 'connection-a'), null);
});
test('cancelled requests are never requeued and cannot consume another phone response', async t => {
  const value = broker(t);
  value.connect('phone-b', 'connection-b');
  const abort = new AbortController();
  const pending = value.request('phone-a', 'action', {}, abort.signal);
  const rejected = assert.rejects(pending, e => e.actionOutcome === 'unknown');
  const command = await value.poll('phone-a', 'connection-a');
  assert.throws(() => value.respond('phone-b', 'connection-b', command.id, {}), /请求已结束/);
  abort.abort();
  await rejected;
  assert.equal(await value.poll('phone-a', 'connection-a'), null);
});
test('bounds, unsupported operations and parallel polls fail before dispatch', async t => {
  const value = broker(t, { maxPending: 1 });
  await assert.rejects(value.request('phone-a', 'exec', {}), e => e.code === 'PHONE_OPERATION_UNSUPPORTED');
  await assert.rejects(value.request('phone-a', 'action', { text: 'x'.repeat(65536) }), e => e.code === 'PHONE_INVALID_REQUEST');
  const waiting = value.poll('phone-a', 'connection-a');
  await assert.rejects(value.poll('phone-a', 'connection-a'), e => e.code === 'PHONE_TARGET_BUSY');
  const pending = value.request('phone-a', 'sync', {});
  const command = await waiting;
  await assert.rejects(value.request('phone-a', 'start', {}), e => e.code === 'PHONE_TARGET_BUSY');
  value.respond('phone-a', 'connection-a', command.id, { ok: true });
  await pending;
});
test('an aborted poll leaves the next command for a new poll, and close is final', async t => {
  const value = broker(t);
  const abort = new AbortController();
  const waiting = value.poll('phone-a', 'connection-a', abort.signal);
  abort.abort();
  assert.equal(await waiting, null);
  const pending = value.request('phone-a', 'sync', {});
  const command = await value.poll('phone-a', 'connection-a');
  value.respond('phone-a', 'connection-a', command.id, { ok: true });
  await pending;
  value.close();
  assert.throws(() => value.connect('phone-a', 'connection-c'), e => e.code === 'PHONE_SERVICE_UNAVAILABLE');
});
