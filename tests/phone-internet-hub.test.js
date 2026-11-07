const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { InternetPhoneHub, internetEndpoint } = loadCli('src/main/phones/internet-hub.ts');
const { InternetPhoneBroker } = loadCli('src/main/phones/internet-broker.ts');
const token = () => randomBytes(32).toString('hex');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-internet-'));
  let now = Date.now();
  const events = [];
  const make = () => new InternetPhoneHub({ root, computer: 'Cloud PC', pairingScheme: 'profilepilot-dev', now: () => now,
    broker: new InternetPhoneBroker({ pollTimeoutMs: 30, requestTimeoutMs: 2000 }),
    connected: (id, name, epoch) => events.push({ event: 'connect', id, name, epoch }),
    disconnected: (id, epoch) => events.push({ event: 'disconnect', id, epoch }) });
  let hub = make();
  t.after(async () => { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.configure({ enabled: true, port: 0, advertisedUrl: 'https://127.0.0.1:18770' });
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'internet-identity.json'), 'utf8'));
  const transport = (route, body, credential, pin) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = https.request({ hostname: '127.0.0.1', port: hub.status().port, path: route, method: 'POST', ca: identity.cert, agent: false,
      checkServerIdentity: (_host, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === (pin || hub.status().fingerprint) ? undefined : new Error('Certificate pin mismatch'),
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, ...(credential ? { Authorization: 'Bearer ' + credential } : {}) }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.setTimeout(4000, () => request.destroy(new Error('Test request timed out')));
    request.end(bytes);
  });
  const invite = hub.pair(), pairToken = new URL(invite.uri).searchParams.get('token');
  const phoneToken = token(), deviceId = randomUUID(), connectionId = randomUUID();
  const pairBody = { serverId: hub.status().id, deviceId, name: 'Test phone', token: phoneToken };
  assert.equal((await transport('/v1/pair', pairBody, pairToken)).ok, true);
  const phone = (route, extra = {}, credential = phoneToken) => transport(route, { deviceId, connectionId, ...extra }, credential);
  return { root, events, transport, invite, pairToken, pairBody, phoneToken, deviceId, connectionId, phone,
    id: 'internet-' + deviceId, get hub() { return hub; }, advance(ms) { now += ms; },
    async restart() { await hub.close(); hub = make(); await hub.start(); } };
}

test('HTTPS pairing pins the computer, scopes phone authority, and stores no bearer token', async t => {
  const f = await fixture(t);
  assert.match(f.invite.uri, /^profilepilot-dev:\/\/internet\?/);
  assert.equal((await f.transport('/v1/pair', f.pairBody, f.pairToken)).ok, true, 'same pairing can recover a lost reply');
  assert.equal((await f.transport('/v1/pair', { ...f.pairBody, deviceId: randomUUID() }, f.pairToken)).ok, false);
  assert.equal((await f.phone('/v1/connect', {}, token())).status, 401);
  assert.equal((await f.phone('/v1/connect', { deviceId: randomUUID() })).ok, false);
  assert.equal((await f.transport('/v1/request', {}, f.phoneToken)).status, 404, 'phone cannot call desktop management APIs');
  await assert.rejects(f.transport('/v1/connect', { deviceId: f.deviceId, connectionId: f.connectionId }, f.phoneToken, '0'.repeat(64)), /pin mismatch/);
  const stored = fs.readFileSync(path.join(f.root, 'internet-control.json'), 'utf8');
  assert.ok(!stored.includes(f.phoneToken)); assert.ok(!stored.includes(f.pairToken));
  assert.ok(!JSON.stringify(f.hub.status()).includes(f.phoneToken));
});
test('phone pulls commands across HTTPS, replies once, and disconnect revokes its connection', async t => {
  const f = await fixture(t);
  assert.equal((await f.phone('/v1/connect')).ok, true);
  const expected = { ok: true, state: { phase: 'idle' } };
  const pending = f.hub.request(f.id, 'sync', { transport: 'internet' });
  const packet = await f.phone('/v1/poll');
  assert.equal(packet.command.method, 'sync');
  assert.equal(packet.command.body.transport, 'internet');
  assert.equal((await f.phone('/v1/result', { requestId: packet.command.id, result: expected })).ok, true);
  assert.deepEqual(await pending, expected);
  assert.equal((await f.phone('/v1/result', { requestId: packet.command.id, result: expected })).ok, true);
  assert.equal((await f.phone('/v1/poll')).command, null);
  assert.equal((await f.phone('/v1/disconnect')).ok, true);
  assert.equal(f.hub.status().devices[0].connected, false);
  assert.equal((await f.phone('/v1/poll')).ok, false);
  assert.deepEqual(f.events.map(e => e.event), ['connect', 'disconnect']);
});
test('reconnect and server restart preserve pairing but never recover pending input', async t => {
  const f = await fixture(t);
  await f.phone('/v1/connect');
  const pending = f.hub.request(f.id, 'action', { action: { kind: 'tap', x: 1, y: 2 } });
  const rejected = assert.rejects(pending, e => e.actionOutcome === 'unknown');
  const packet = await f.phone('/v1/poll');
  const replacement = randomUUID();
  assert.equal((await f.phone('/v1/connect', { connectionId: replacement })).ok, true);
  await rejected;
  assert.equal((await f.phone('/v1/result', { requestId: packet.command.id, result: { ok: true } })).ok, false);
  assert.equal((await f.phone('/v1/poll', { connectionId: replacement })).command, null);
  const pin = f.hub.status().fingerprint, port = f.hub.status().port;
  await f.restart();
  assert.equal(f.hub.status().fingerprint, pin); assert.equal(f.hub.status().port, port);
  assert.equal(f.hub.status().devices[0].connected, false);
  assert.equal((await f.phone('/v1/connect', { connectionId: randomUUID() })).ok, true);
  assert.equal((await f.transport('/v1/pair', f.pairBody, f.pairToken)).status, 401, 'old invitations do not survive restart');
});
test('APK transfer requires the exact phone, connection and continuing session authority', async t => {
  const f = await fixture(t); await f.phone('/v1/connect');
  const file = path.join(f.root, 'test.apk'), contents = Buffer.alloc(800000, 23);
  fs.writeFileSync(file, contents);
  let allowed = true;
  const artifact = f.hub.offerArtifact(f.id, file, contents.length, 'a'.repeat(64), async () => { if (!allowed) throw new Error('lease revoked'); });
  const first = await f.phone('/v1/artifact', { artifactId: artifact.artifactId, offset: 0 });
  assert.equal(first.ok, true); assert.deepEqual(Buffer.from(first.base64, 'base64'), contents.subarray(0, 768 * 1024));
  assert.equal((await f.phone('/v1/artifact', { artifactId: artifact.artifactId, offset: 0, deviceId: randomUUID() })).ok, false);
  assert.equal((await f.phone('/v1/artifact', { artifactId: artifact.artifactId, offset: 0, connectionId: randomUUID() })).ok, false);
  allowed = false;
  assert.equal((await f.phone('/v1/artifact', { artifactId: artifact.artifactId, offset: 768 * 1024 })).ok, false);
  allowed = true; f.hub.revokeArtifact(artifact.artifactId);
  assert.equal((await f.phone('/v1/artifact', { artifactId: artifact.artifactId, offset: 0 })).ok, false);
});
test('expiry, disabling and explicit unpairing prevent later control access', async t => {
  const f = await fixture(t);
  const other = f.hub.pair();
  f.advance(180001);
  assert.equal((await f.transport('/v1/pair', { ...f.pairBody, deviceId: randomUUID(), token: token() }, new URL(other.uri).searchParams.get('token'))).status, 401);
  await f.phone('/v1/connect');
  const queued = f.hub.request(f.id, 'start', {});
  const rejected = assert.rejects(queued, e => e.actionOutcome === 'not-executed');
  f.hub.forget(f.id); await rejected;
  assert.equal((await f.phone('/v1/connect')).status, 401);
  await f.hub.configure({ enabled: false });
  assert.equal(f.hub.status().listening, false);
  assert.throws(() => f.hub.pair(), /先配置/);
});
test('public endpoint parsing rejects insecure URLs and embedded credentials', () => {
  assert.equal(internetEndpoint('https://cloud.example:18770/'), 'https://cloud.example:18770');
  for (const value of ['http://cloud.example', 'https://user:pass@cloud.example', 'https://cloud.example/path', 'https://cloud.example?token=secret', 'https://cloud.example/#fragment', 'https://cloud.example:0'])
    assert.throws(() => internetEndpoint(value));
});
