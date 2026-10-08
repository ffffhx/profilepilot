const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function harness() {
  const calls = [], stdout = [], stderr = [];
  return { calls, stdout, stderr,
    request: async command => { calls.push(command); return { ok: true, data: { services: [], address: '192.168.1.8:40001' } }; },
    io: { stdout: { write: value => stdout.push(value) }, stderr: { write: value => stderr.push(value) } } };
}

test('discovery and explicit connection use managed phone commands without starting a session', async () => {
  const h = harness();
  assert.equal(await runPhoneCli(['wireless-discover'], h.request, h.io), 0);
  assert.equal(await runPhoneCli(['wireless-connect', '--address', '192.168.1.8:40002'], h.request, h.io), 0);
  assert.deepEqual(h.calls, [
    { action: 'phone', method: 'wireless-discover', params: {} },
    { action: 'phone', method: 'wireless-connect', params: { address: '192.168.1.8:40002' } },
  ]);
});

test('missing or invalid endpoints and unrelated flags fail before reaching the device service', async () => {
  for (const args of [
    ['wireless-connect'], ['wireless-connect', '--address', '8.8.8.8:53'],
    ['wireless-connect', '--address', '192.168.1.8:40002;reboot'],
    ['wireless-discover', '--address', '192.168.1.8:40002'], ['wireless-pair', '--code', '012345'],
  ]) {
    const h = harness();
    assert.equal(await runPhoneCli(args, h.request, h.io), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(!h.stderr.join('').includes('012345'));
  }
});

test('pairing reads a BOM JSON file with a spaced Unicode path and preserves leading zeroes without echoing the code', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wifi-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '手机 配对.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ address: '192.168.1.8:40001', code: '012345' }));
  const h = harness();
  assert.equal(await runPhoneCli(['wireless-pair', '--params-file', file], h.request, h.io), 0);
  assert.deepEqual(h.calls, [{ action: 'phone', method: 'wireless-pair', params: { address: '192.168.1.8:40001', code: '012345' } }]);
  assert.ok(!h.stdout.join('').includes('012345'));
  assert.ok(!h.stderr.join('').includes('012345'));
});

test('malformed pairing documents do not leak the pairing code in parser errors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wifi-cli-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pair.json');
  for (const content of ['{"code":"012345", BROKEN}', '{"address":"8.8.8.8:53","code":"012345"}']) {
    fs.writeFileSync(file, content);
    const h = harness();
    assert.equal(await runPhoneCli(['wireless-pair', '--params-file', file], h.request, h.io), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(!h.stderr.join('').includes('012345'));
  }
});
