import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

const url = process.argv[2];
if (!url || !url.startsWith('https://')) throw new Error('Provide the HTTPS status service URL');
const id = randomUUID(), deviceId = randomUUID();
const reader = randomBytes(32).toString('hex'), writer = randomBytes(32).toString('hex'), pairing = randomBytes(32).toString('hex');
async function request(action, credential, extra = {}) {
  const response = await fetch(`${url}/v1/${action}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...extra }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}
let created = false;
try {
  assert.equal((await request('create', reader, { pairToken: pairing })).status, 200); created = true;
  assert.equal((await request('claim', pairing, { writeToken: writer, deviceId })).status, 200);
  const report = { deviceId, name: 'Temporary protocol verification', permissions: { accessibility: true, overlay: false, notifications: true }, readiness: { unlocked: true, computerConnected: false, usbConnected: false, wifiConnected: false, developerOptions: 'unconfirmed', usbDebugging: 'unconfirmed', wirelessDebugging: 'unconfirmed', accessibilityService: 'running' } };
  report.readiness.debugReasons = { developerOptions: 'masked-zero', usbDebugging: 'denied', wirelessDebugging: 'missing' };
  report.readiness.appVersion = '0.2.2';
  report.readiness.network = { wifiIpv4: ['192.168.1.9'], adbEndpoints: [{address:'192.168.1.9:41000',ageMs:1000}] };
  assert.equal((await request('report', writer, { report })).status, 200);
  const value = await request('status', reader);
  assert.equal(value.status, 200); assert.deepEqual(value.body.report, report); assert.ok(value.body.ageMs < 15000);
  assert.equal((await request('status', writer)).status, 401);
  assert.equal((await request('report', reader, { report })).status, 401);
  console.log('Public HTTPS pairing, diagnostic upload/read and credential isolation passed; no ADB used.');
} finally {
  if (created) {
    assert.equal((await request('revoke', reader)).status, 200);
    assert.equal((await request('status', reader)).status, 404);
    console.log('Temporary verification channel revoked.');
  }
}
