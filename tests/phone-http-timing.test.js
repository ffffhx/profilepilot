const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { loadCli } = require('./cli-test-build.cjs');
const { phoneRequest, phoneRequestTimings } = loadCli('src/main/phones/adb.ts');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('HTTP diagnostics separate header wait, first data and remaining body without retaining private values', async t => {
  const secret = 'private-token-and-body', response = Buffer.from('{"ok":true}');
  const port = await listen(t, async (request, reply) => {
    for await (const ignored of request) { /* Drain the same POST framing as the companion. */ }
    await delay(90);
    reply.writeHead(200, { 'Content-Length': response.length, Connection: 'close' }); reply.flushHeaders();
    await delay(90); reply.write(response.subarray(0, 6));
    await delay(90); reply.end(response.subarray(6));
  });
  const since = Date.now();
  assert.deepEqual(await phoneRequest(port, secret, 'follow', { op: 'frame', secret }), { ok: true });
  const timing = phoneRequestTimings(since).at(-1);
  assert.equal(timing.operation, 'follow-frame'); assert.equal(timing.outcome, 'complete');
  assert.equal(timing.responseBytes, response.length);
  assert.ok(timing.socketMs >= 0 && timing.connectedMs >= timing.socketMs);
  assert.ok(timing.sentMs >= timing.connectedMs);
  assert.ok(timing.headersMs - timing.sentMs >= 60, JSON.stringify(timing));
  assert.ok(timing.firstDataMs - timing.headersMs >= 60, JSON.stringify(timing));
  assert.ok(timing.endMs - timing.firstDataMs >= 60, JSON.stringify(timing));
  assert.ok(timing.totalMs >= timing.endMs);
  assert.ok(!JSON.stringify(timing).includes(secret));
  assert.deepEqual(Object.keys(timing).sort(), ['at', 'operation', 'socketMs', 'connectedMs', 'sentMs', 'headersMs', 'firstDataMs', 'endMs', 'totalMs', 'responseBytes', 'outcome'].sort());
});

test('a truncated HTTP response records partial transfer once and still rejects', async t => {
  const port = await listen(t, (request, reply) => {
    request.resume();
    reply.writeHead(200, { 'Content-Length': 100, Connection: 'close' });
    reply.write('{"ok":'); setTimeout(() => reply.destroy(new Error('private-error')), 70);
  });
  const since = Date.now();
  await assert.rejects(phoneRequest(port, 'private-token', 'follow', { op: 'touch', points: [] }));
  const observed = phoneRequestTimings(since).filter(value => value.operation === 'follow-touch');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].outcome, 'error'); assert.equal(observed[0].responseBytes, 6);
  assert.equal(observed[0].endMs, undefined); assert.ok(observed[0].firstDataMs >= observed[0].headersMs);
  assert.ok(!JSON.stringify(observed).includes('private'));
});

test('HTTP history is bounded, uses fixed operation labels and returns detached records', async t => {
  const port = await listen(t, (request, reply) => { request.resume(); reply.end('{}'); });
  for (let i = 0; i < 14; i++) await phoneRequest(port, 'private-token', 'private-method', { op: 'private-operation', text: 'private-body' });
  const observed = phoneRequestTimings(0);
  assert.equal(observed.length, 12); assert.ok(observed.every(value => value.operation === 'other'));
  assert.ok(!JSON.stringify(observed).includes('private'));
  observed[0].operation = 'private-mutation';
  assert.equal(phoneRequestTimings(0)[0].operation, 'other');
});

test('late completion from an earlier run is excluded by request start time', async t => {
  let arrived, release;
  const ready = new Promise(resolve => { arrived = resolve; });
  const port = await listen(t, (request, reply) => {
    request.resume(); release = () => reply.end('{}'); arrived();
  });
  const pending = phoneRequest(port, 'private-token', 'sync');
  await ready; await delay(20);
  const nextRunAt = Date.now(); release(); await pending;
  assert.equal(phoneRequestTimings(nextRunAt).length, 0);
});

test('cancelling a recovery request closes its socket and never accepts the late response', async t => {
  let arrived, closed, lateReply;
  const ready = new Promise(resolve => { arrived = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const port = await listen(t, (request, reply) => {
    request.resume(); reply.on('close', closed);
    lateReply = () => reply.end('{"ok":true}'); arrived();
  });
  const controller = new AbortController(), since = Date.now();
  const pending = phoneRequest(port, 'private-token', 'sync', {}, controller.signal);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await ready; controller.abort(); await rejected; await disconnected;
  lateReply(); await delay(20);
  const observed = phoneRequestTimings(since);
  assert.equal(observed.length, 1); assert.equal(observed[0].outcome, 'error');
  assert.equal(observed[0].responseBytes, 0);
});
