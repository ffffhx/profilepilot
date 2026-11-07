const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { loadCli } = require('./cli-test-build.cjs');
const { runInternetPhoneCli } = loadCli('src/main/phones/internet-cli.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

test('offline Internet receipts return structured recovery without an unhandled rejection', async () => {
  let output = '', error = '', calls = 0;
  const io = { stdout: { write: value => output += value }, stderr: { write: value => error += value } };
  const code = await runPhoneCli(['internet', 'install-status', '--device', 'internet-phone', '--job', 'job'], async () => {
    calls++;
    return { ok: false, error: { code: 'PHONE_CONNECTION_REQUIRED', message: 'Phone offline', details: {
      recovery: { cause: 'PHONE_CONNECTION_REQUIRED', stage: 'connection', actionOutcome: 'not-executed',
        requiresUser: false, nextStep: 'check-connection', instruction: 'Inspect connection', automaticResume: false, automaticReplay: false }
    } } };
  }, io, Readable.from([]));
  assert.notEqual(code, 0); assert.equal(calls, 1); assert.equal(output, '');
  const reply = JSON.parse(error);
  assert.equal(reply.recovery.actionOutcome, 'not-executed');
  assert.equal(reply.recovery.automaticReplay, false);
});

test('pairing secrets go only to a new private file and never overwrite existing data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-internet-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pair.json'), secret = 'd'.repeat(64), output = [];
  const io = { stdout: { write: value => output.push(value) }, stderr: { write() {} } };
  let calls = 0;
  const request = async command => {
    calls++; assert.equal(command.method, 'internet-pair');
    return { ok: true, data: { uri: 'profilepilot-dev://internet?token=' + secret, expiresAt: 123, computer: 'cloud', endpoint: 'https://example.test:18770' } };
  };
  await runInternetPhoneCli(['pair', '--output', file], request, io, Readable.from([]));
  assert.ok(fs.readFileSync(file, 'utf8').includes(secret));
  assert.ok(!output.join('').includes(secret));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(runInternetPhoneCli(['pair', '--output', file], request, io, Readable.from([])), { code: 'EEXIST' });
  assert.equal(calls, 1);
});

test('configuration accepts structured stdin and rejects conflicting or unknown flags before mutation', async () => {
  const calls = [], io = { stdout: { write() {} }, stderr: { write() {} } };
  const request = async command => { calls.push(command); return { ok: true, data: {} }; };
  await runInternetPhoneCli(['configure', '--params-stdin'], request, io, Readable.from(['{"enabled":true,"advertisedUrl":"https://example.test:18770"}']));
  assert.deepEqual(calls[0].params, { enabled: true, advertisedUrl: 'https://example.test:18770' });
  await assert.rejects(runInternetPhoneCli(['configure', '--params-stdin', '--params-file', 'unused.json'], request, io, Readable.from([])));
  await assert.rejects(runInternetPhoneCli(['forget'], request, io, Readable.from([])));
  await assert.rejects(runInternetPhoneCli(['pair', '--token', 'secret'], request, io, Readable.from([])));
  assert.equal(calls.length, 1);
});
