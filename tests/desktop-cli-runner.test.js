const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
let runDesktopCliProcess;
test.before(async () => { ({ runDesktopCliProcess } = await import('../scripts/e2e/desktop-cli.mjs')); });

function child() {
  const value = new EventEmitter();
  value.stdout = new PassThrough(); value.stderr = new PassThrough();
  value.killCalls = 0; value.kill = () => { value.killCalls++; return false; };
  value.unref = () => { value.unreferenced = true; };
  return value;
}
function run(fake, options = {}) {
  return runDesktopCliProcess({ entry: 'fixture.cjs', args: [], ...options }, { spawnProcess: () => fake });
}
test('acceptance CLI preserves split UTF-8 and an expected failure receipt', async () => {
  const fake = child(), pending = run(fake, { expectedExitCode: 75 });
  await new Promise(resolve => setImmediate(resolve));
  const response = { ok: false, message: '中文🧪', code: 'DESKTOP_OUTCOME_UNKNOWN' };
  for (const byte of Buffer.from(JSON.stringify(response))) fake.stdout.write(Buffer.from([byte]));
  fake.emit('close', 75, null);
  assert.deepEqual(await pending, { exitCode: 75, response });
  assert.equal(fake.killCalls, 0);
});
test('acceptance CLI deadline settles even when kill never produces close', async () => {
  const fake = child();
  const started = Date.now();
  await assert.rejects(run(fake, { timeoutMs: 15 }), { code: 'DESKTOP_CLI_TIMEOUT', outcome: 'unknown' });
  assert.ok(Date.now() - started < 1500);
  assert.equal(fake.killCalls, 1); assert.equal(fake.unreferenced, true);
  assert.equal(fake.stdout.destroyed, true); assert.equal(fake.stderr.destroyed, true);
  fake.emit('error', new Error('late failure')); fake.emit('error', new Error('another late failure'));
});
test('acceptance CLI rejects missing spawn pipes and consumes the late process error', async () => {
  const fake = child(); fake.stdout = null;
  await assert.rejects(run(fake), { code: 'DESKTOP_CLI_PIPE_UNAVAILABLE', outcome: 'unknown' });
  assert.equal(fake.killCalls, 1); fake.emit('error', new Error('spawn failure'));
  fake.stderr.emit('error', new Error('late pipe failure'));
});
test('acceptance CLI byte limit includes stderr and invalid UTF-8 cannot become a receipt', async () => {
  const fake = child(), pending = run(fake, { maxOutputBytes: 3 });
  await new Promise(resolve => setImmediate(resolve));
  fake.stderr.write(Buffer.alloc(4));
  await assert.rejects(pending, { code: 'DESKTOP_CLI_OUTPUT_LIMIT' });
  const broken = child(), invalid = run(broken);
  await new Promise(resolve => setImmediate(resolve));
  broken.stdout.write(Buffer.from([0xff])); broken.emit('close', 0);
  await assert.rejects(invalid, { code: 'DESKTOP_CLI_INVALID_OUTPUT' });
});
