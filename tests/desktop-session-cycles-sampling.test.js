const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A review candidate can be checked without editing the live acceptance script.
// These tests execute only extracted functions with fake time and fake child I/O.
const entry = process.env.PROFILEPILOT_CYCLE_TEST_SOURCE || path.resolve(__dirname, '../scripts/verify-desktop-session-cycles.mjs');
const source = fs.readFileSync(entry, 'utf8');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Expected production function boundaries');
  return source.slice(first, last);
}
const functions = extract('async function poll(', 'const json =') + extract('function sample()', 'async function persist()');
function fixture(outputs = [JSON.stringify({ ok: true, children: [] })]) {
  const state = { now: 0, calls: 0, delays: [], accepts: 0 };
  const report = { app: { pid: 123 }, samplingUnstableCount: 0, samplingUnstable: [] };
  const context = vm.createContext({ assert, path, JSON, SyntaxError,
    Date: class extends Date { static now() { return state.now; } },
    delay: async ms => { state.delays.push(ms); state.now += ms; },
    report, appIdentity: null, executable: 'owned-fixture.exe', root: 'owned-root', hashes: {},
    execFileSync() {
      const value = outputs[state.calls++];
      if (value instanceof Error) throw value;
      assert.notEqual(value, undefined, 'Unexpected sample retry');
      return value;
    }
  });
  vm.runInContext(functions, context);
  return { state, report, context, run: code => vm.runInContext(code, context) };
}

test('cycle sample classifies malformed completed stdout as a non-retryable protocol error', () => {
  for (const raw of ['', '{', 'not-json']) {
    const f = fixture([raw]);
    assert.throws(() => f.run('sample()'), error => error.code === 'SAMPLE_PROTOCOL_ERROR');
    assert.equal(f.state.calls, 1); assert.equal(f.report.samplingUnstableCount, 0);
  }
});

test('cycle poll cannot wash malformed completed stdout into a later successful sample', async () => {
  const f = fixture(['{', JSON.stringify({ ok: true, children: [] })]);
  await assert.rejects(f.run('poll(sample, () => true, "native sample")'), error => error.code === 'SAMPLE_PROTOCOL_ERROR');
  assert.equal(f.state.calls, 1); assert.equal(f.report.samplingUnstableCount, 0);
});

test('cycle poll cannot mistake native execution ENOENT for a transient ready-file absence', async () => {
  const failed = Object.assign(new Error('Owned executable missing'), { code: 'ENOENT' });
  const f = fixture([failed, JSON.stringify({ ok: true, children: [] })]);
  await assert.rejects(f.run('poll(sample, () => true, "native sample")'), error => error.code === 'SAMPLE_EXECUTION_ERROR' && error.cause === failed);
  assert.equal(f.state.calls, 1); assert.equal(f.report.samplingUnstableCount, 0);
  assert.deepEqual(f.state.delays, []);
});

test('cycle poll rejects results arriving at or beyond the original deadline before accepting them', async () => {
  for (const arrival of [10000, 15000]) {
    const f = fixture();
    f.context.read = async () => { f.state.now = arrival; return { ok: true }; };
    f.context.accept = () => { f.state.accepts++; return true; };
    await assert.rejects(f.run('poll(read, accept, "native retirement", 10000)'), /native retirement timed out/);
    assert.equal(f.state.accepts, 0); assert.deepEqual(f.state.delays, []);
  }
});

test('cycle poll still accepts a valid result before its original deadline', async () => {
  const f = fixture();
  f.context.read = async () => { f.state.now = 9999; return { ok: true }; };
  assert.equal((await f.run('poll(read, () => true, "sample", 10000)')).ok, true);
});

test('confirmed unstable native sample remains retryable and recorded', async () => {
  const unstable = Object.assign(new Error('Child exited'), { stdout: JSON.stringify({ code: 'SAMPLE_UNSTABLE', message: 'Child exited' }) });
  const f = fixture([unstable, JSON.stringify({ ok: true, children: [] })]);
  assert.equal((await f.run('poll(sample, () => true, "sample")')).ok, true);
  assert.equal(f.state.calls, 2); assert.equal(f.report.samplingUnstableCount, 1); assert.equal(f.report.samplingUnstable.length, 1);
});

test('ready file temporary JSON and ENOENT failures retain bounded retries', async () => {
  const f = fixture(); let calls = 0;
  f.context.read = async () => {
    calls++;
    if (calls === 1) throw new SyntaxError('Incomplete ready file');
    if (calls === 2) throw Object.assign(new Error('Not yet ready'), { code: 'ENOENT' });
    return { ready: true };
  };
  assert.equal((await f.run('poll(read, value => value.ready, "ready file", 1000)')).ready, true);
  assert.equal(calls, 3); assert.equal(f.state.now, 200);
});

test('ready file retries do not reset the original polling budget', async () => {
  const f = fixture(); let calls = 0;
  f.context.read = async () => { calls++; f.state.now += 450; throw new SyntaxError('Incomplete ready file'); };
  await assert.rejects(f.run('poll(read, () => true, "ready file", 1000)'), /ready file timed out/);
  assert.equal(calls, 2);
});

test('non-unstable native failures and parsed negative responses still fail immediately', async () => {
  for (const failed of [new Error('Native process failed'), new SyntaxError('Native execution failure'),
    ...['ENOENT', 'EACCES', 'ETIMEDOUT'].map(code => Object.assign(new Error('Native process failed'), { code }))]) {
    const rawSentinel = 'RAW_STDOUT_MUST_NOT_BE_REPORTED';
    failed.stdout = JSON.stringify({ code: 'SAMPLE_FAILED', message: 'Denied' });
    failed.stderr = rawSentinel; failed.message += ': ' + rawSentinel;
    const f = fixture([failed]);
    await assert.rejects(f.run('poll(sample, () => true, "sample")'), error => {
      assert.equal(error.code, 'SAMPLE_EXECUTION_ERROR'); assert.equal(error.cause, failed);
      assert.equal(error.sampleFailure.code, 'SAMPLE_FAILED');
      assert.equal(Object.hasOwn(error, 'stdout'), false); assert.equal(Object.hasOwn(error, 'stderr'), false);
      assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
      assert.doesNotMatch(error.message + JSON.stringify(error), /RAW_STDOUT_MUST_NOT_BE_REPORTED/);
      return true;
    });
    assert.equal(f.state.calls, 1); assert.equal(f.report.samplingUnstableCount, 0);
  }
  const negative = fixture([JSON.stringify({ ok: false, children: [] })]);
  await assert.rejects(negative.run('poll(sample, () => true, "sample")'));
  assert.equal(negative.state.calls, 1);
});
