const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { WirelessServerLog, wirelessServerEvidence, adbServerLogPath } = loadCli('src/main/phones/wireless-server-log.ts');
const { Adb } = loadCli('src/main/phones/adb.ts');
const { connectWireless, pairWireless } = loadCli('src/main/phones/wireless.ts');
const address = '192.168.0.101:37231';
const line = (body, thread = 8244, pid = 25996) => `10-29 23:55:17.363 ${pid} ${thread} E adb : ${body}\n`;
const auth = () => line('tls_connection.cpp:290 [client]: Post-handshake SSL_peek failed [SSLV3_ALERT_CERTIFICATE_UNKNOWN]');
const kick = (target = address, thread = 8244, pid = 25996) => line(`transport.cpp:1123 kicking transport 0x1950a60 ${target}`, thread, pid);
function fixture(t, existing = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wireless-log-'));
  const file = path.join(root, 'adb.log'); fs.writeFileSync(file, existing);
  const log = new WirelessServerLog(async () => `log_absolute_path: ${JSON.stringify(file)}\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file, log };
}

test('the observed Windows TLS failure is correlated to the exact endpoint and server thread', () => {
  const found = wirelessServerEvidence(auth() + kick(), 'connect', address);
  assert.deepEqual(found, { source: 'adb-server', reason: 'AUTH_REQUIRED', signature: 'SSLV3_ALERT_CERTIFICATE_UNKNOWN' });
  for (const suffix of [kick('192.168.0.102:37231'), kick(address, 3), kick(address, 8244, 3)])
    assert.equal(wirelessServerEvidence(auth() + suffix, 'connect', address), undefined);
  assert.equal(wirelessServerEvidence(auth() + kick('192.168.0.102:37231') + kick(), 'connect', address), undefined);
  assert.equal(wirelessServerEvidence(auth() + kick(), 'pair', address), undefined);
});

for (const [name, error] of [['Windows', 'actively refused it. (10061)'], ['macOS', 'Connection refused']])
  test(`${name} pairing refusal uses only the requested pairing endpoint`, () => {
    const log = line(`pairing_client.cpp:133 Failed to start pairing connection client [cannot connect to 192.168.0.101:39361: ${error}]`);
    assert.equal(wirelessServerEvidence(log, 'pair', '192.168.0.101:39361').reason, 'CONNECTION_REFUSED');
    assert.equal(wirelessServerEvidence(log, 'pair', '192.168.0.101:3936'), undefined);
    assert.equal(wirelessServerEvidence(log, 'connect', '192.168.0.101:39361'), undefined);
  });

test('server status paths decode Windows, POSIX, spaces and protobuf UTF-8 octal escapes', () => {
  assert.equal(adbServerLogPath('log_absolute_path: "C:\\\\Users\\\\a b\\\\adb.log"'), 'C:\\Users\\a b\\adb.log');
  assert.equal(adbServerLogPath('log_absolute_path: "/var/folders/a b/adb.501.log"'), '/var/folders/a b/adb.501.log');
  assert.equal(adbServerLogPath('log_absolute_path: "/tmp/\\346\\265\\213\\350\\257\\225/adb.log"'), '/tmp/测试/adb.log');
  assert.equal(adbServerLogPath('log_absolute_path: "C:\\\\123\\\\\\346\\265\\213\\350\\257\\225\\\\adb.log"'), 'C:\\123\\测试\\adb.log');
  for (const value of ['error', 'log_absolute_path: "relative.log"', 'log_absolute_path: "http://localhost/adb.log"'])
    assert.equal(adbServerLogPath(value), undefined);
});

test('historical TLS errors never contaminate a new command', async t => {
  const h = fixture(t, auth() + kick()); const cursor = await h.log.capture();
  assert.equal(await h.log.finish(cursor, 'connect', address, true), undefined);
});

test('only new matched signatures escape; keys, tokens and unrelated log lines do not', async t => {
  const h = fixture(t); const cursor = await h.log.capture();
  fs.appendFileSync(h.file, line('public_key=PRIVATE-KEY token=private-token code=654321') + auth() + kick());
  const evidence = await h.log.finish(cursor, 'connect', address, true);
  assert.equal(evidence.reason, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|private|654321|192\.168|25996/);
});

test('rotation, truncation and excessive concurrent log output stay unclassified', async t => {
  const h = fixture(t, 'x'.repeat(1000));
  let cursor = await h.log.capture();
  fs.writeFileSync(h.file, auth() + kick());
  assert.equal(await h.log.finish(cursor, 'connect', address, true), undefined);
  cursor = await h.log.capture();
  fs.renameSync(h.file, h.file + '.old'); fs.writeFileSync(h.file, auth() + kick());
  assert.equal(await h.log.finish(cursor, 'connect', address, true), undefined);
  cursor = await h.log.capture(); fs.appendFileSync(h.file, 'x'.repeat(256 * 1024) + auth() + kick());
  assert.equal(await h.log.finish(cursor, 'connect', address, true), undefined);
});

test('a successful connection is not turned into a failure by concurrent server errors', async t => {
  const h = fixture(t), cursor = await h.log.capture(); fs.appendFileSync(h.file, auth() + kick());
  assert.equal(await h.log.finish(cursor, 'connect', address, false), undefined);
});

test('unavailable server-status/log is optional and never requires resetting the shared ADB server', async () => {
  const log = new WirelessServerLog(async () => { throw Error('unsupported command'); });
  assert.equal(await log.capture(), undefined);
  assert.equal(await log.finish(undefined, 'connect', address, true), undefined);
});

test('real zero-exit generic connect failure becomes actionable using fresh server evidence', async t => {
  const h = fixture(t);
  const adb = new Adb('fake', (_exe, args, _opts, callback) => {
    assert.deepEqual(args, ['connect', address]);
    fs.appendFileSync(h.file, auth() + kick());
    queueMicrotask(() => callback(null, `failed to connect to ${address}`, ''));
    return { stdin: { on() {}, end() {} } };
  }, h.log);
  await assert.rejects(connectWireless(adb, { address }), error => {
    assert.equal(error.code, 'PHONE_WIFI_AUTH_REQUIRED');
    assert.equal(error.details.wireless.evidence.exitCode, 0);
    assert.equal(error.details.wireless.evidence.server.source, 'adb-server');
    return true;
  });
});

test('observed protocol-fault pairing error reports closed port instead of blaming the code', async t => {
  const h = fixture(t), pairingAddress = '192.168.0.101:39361';
  const adb = new Adb('fake', (_exe, args, _opts, callback) => {
    assert.deepEqual(args, ['pair', pairingAddress]);
    fs.appendFileSync(h.file, line(`pairing_client.cpp:133 cannot connect to ${pairingAddress}: (10061)`));
    queueMicrotask(() => callback(Object.assign(Error('hidden'), { code: 1 }), 'Enter pairing code:', "error: protocol fault (couldn't read status message): No error"));
    return { stdin: { on() {}, end(input) { assert.equal(input, '654321\n'); } } };
  }, h.log);
  await assert.rejects(pairWireless(adb, { address: pairingAddress, code: '654321' }), error => {
    assert.equal(error.code, 'PHONE_WIFI_CONNECTION_REFUSED');
    assert.doesNotMatch(JSON.stringify(error), /654321/);
    assert.match(error.message, /配对地址/);
    return true;
  });
});
