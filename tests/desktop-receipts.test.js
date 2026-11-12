const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const target = { id: 'a'.repeat(32), title: 'Fixture', process: 'fixture', pid: 1, className: 'Form' };
const version = 'b'.repeat(32);
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'receipt-test', ...extra });
const action = requestId => command('action', { requestId, observeAfter: false, params: { version, ref: 'e1', kind: 'invoke' } });
function fixture(request) {
  let clock = 100, calls = 0;
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, now: () => clock, driver: () => ({ close() {}, async request(op, params) {
    calls++; if (op === 'windows') return { windows: [target] }; return request(op, params);
  } }) });
  return { service, get calls() { return calls; }, advance(ms) { clock += ms; } };
}

test('receipt query reports pending immediately without input or lease renewal', async () => {
  let complete, started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const f = fixture(async () => new Promise(resolve => { complete = resolve; started(); }));
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const requestId = randomUUID(), pending = f.service.execute(action(requestId));
    await dispatched;
    const expiresAt = f.service.status().session.expiresAt, before = f.calls;
    f.advance(10000);
    const receipt = await f.service.execute(command('receipt', { requestId }));
    assert.equal(receipt.state, 'pending'); assert.equal(receipt.historical, true);
    assert.equal(f.calls, before); assert.equal(f.service.status().session.expiresAt, expiresAt);
    complete({ executed: true }); await pending;
  } finally { f.service.close(); }
});

test('confirmed receipt remains queryable after completion and never reactivates a task', async () => {
  const f = fixture(async () => ({ executed: true }));
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const requestId = randomUUID(); await f.service.execute(action(requestId));
    await f.service.execute(command('complete')); const calls = f.calls;
    const receipt = await f.service.execute(command('receipt', { requestId }));
    assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.result.executed, true);
    assert.equal(receipt.requiresObservation, true); assert.equal(f.calls, calls);
    assert.equal(f.service.status().session, null);
  } finally { f.service.close(); }
});

test('unknown outcome is available as a failed receipt while user control remains paused', async () => {
  const details = { cause: 'INPUT_FAILED', diagnostics: { requested: 2, sent: 1 } };
  const f = fixture(async () => { throw Object.assign(new Error('uncertain'), { code: 'DESKTOP_OUTCOME_UNKNOWN', details }); });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const requestId = randomUUID();
    await assert.rejects(f.service.execute(action(requestId)), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    const calls = f.calls, receipt = await f.service.execute(command('receipt', { requestId }));
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_OUTCOME_UNKNOWN');
    assert.deepEqual(receipt.error.details, details); assert.equal(f.calls, calls);
    assert.equal(f.service.status().session.state, 'paused');
  } finally { f.service.close(); }
});

test('an action rejected as busy is not permanently cached before dispatch', async () => {
  let finishRead, inputs = 0;
  const f = fixture(async op => {
    if (op === 'window.observe') return new Promise(resolve => { finishRead = resolve; });
    inputs++; return { executed: true };
  });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const read = f.service.execute(command('observe')); await new Promise(resolve => setImmediate(resolve));
    const requestId = randomUUID(); await assert.rejects(f.service.execute(action(requestId)), { code: 'DESKTOP_BUSY' });
    await assert.rejects(f.service.execute(command('receipt', { requestId })), { code: 'DESKTOP_RECEIPT_UNAVAILABLE' });
    finishRead({ version, elements: [] }); await read;
    await f.service.execute(action(requestId)); await f.service.execute(action(requestId));
    assert.equal(inputs, 1);
  } finally { f.service.close(); }
});

test('missing receipts make no assertion that input was unexecuted', async () => {
  const f = fixture(async () => assert.fail('receipt query dispatched to driver'));
  try {
    await assert.rejects(f.service.execute(command('receipt', { requestId: randomUUID() })), error => {
      assert.equal(error.code, 'DESKTOP_RECEIPT_UNAVAILABLE'); assert.match(error.message, /不表示操作未执行/); return true;
    });
    assert.equal(f.calls, 0);
  } finally { f.service.close(); }
});

test('receipt CLI requires only the session and ID, without action parameters', async () => {
  const calls = []; const requestId = randomUUID();
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const request = async input => { calls.push(input); return { ok: true, data: { state: 'pending' } }; };
  assert.equal(await runDesktopCli(['receipt', '--session', 'old-task', '--request-id', requestId], request, io), 0);
  assert.equal(calls[0].requestId, requestId); assert.equal(calls[0].params, undefined);
  for (const args of [['receipt', '--session', 'old-task'], ['receipt', '--session', 'old-task', '--request-id', requestId, '--observe']]) assert.equal(await runDesktopCli(args, request, io), 2);
  assert.equal(calls.length, 1);
});
