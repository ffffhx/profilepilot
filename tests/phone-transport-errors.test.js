const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadCli } = require('./cli-test-build.cjs');
const { phoneRequest } = loadCli('src/main/phones/adb.ts');

test('connection failure before request bytes is not-executed; lost reply after action bytes remains unknown', async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    request.resume(); request.once('end', () => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(phoneRequest(port, 'fixture', 'action', { action: { kind: 'tap', x: 1, y: 2 } }), error => {
      assert.equal(error.code, 'PHONE_EXECUTION_UNCERTAIN');
      assert.equal(error.details.recovery.actionOutcome, 'unknown');
      assert.equal(error.details.recovery.automaticReplay, false); return true;
    });
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(phoneRequest(port, 'fixture', 'action', { action: { kind: 'tap', x: 1, y: 2 } }), error => {
    assert.equal(error.code, 'PHONE_CONNECT_FAILED');
    assert.equal(error.details.recovery.actionOutcome, 'not-executed'); return true;
  });
});

test('failed sync cannot claim that a user action may have run', async () => {
  const server = http.createServer((request, response) => {
    request.resume(); request.once('end', () => response.end('malformed response'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(phoneRequest(server.address().port, 'fixture', 'sync', {}), error => {
      assert.equal(error.details.recovery.actionOutcome, 'not-executed'); return true;
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
