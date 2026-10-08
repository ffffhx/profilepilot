import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const output = path.join(repoRoot, 'artifacts/mobile-workspace-20261005');
await mkdir(output, { recursive: true });
const app = await launchProfilePilotE2e({ mode: 'background', env: { CPM_START_VIEW: 'phones' } });
try {
  const driver = app.driver;
  await driver.waitFor('[data-phone-options] summary');
  await driver.domClick('[data-phone-options] summary');
  await driver.domClick('[data-action="mobile"]');
  await driver.waitFor('[data-mobile="toggle"]', el => el.exists && !el.disabled);
  await driver.domClick('[data-mobile="toggle"]');
  await driver.waitFor('[data-mobile="pair"]', el => el.exists && !el.disabled);
  const state = await driver.evaluate('window.mobile.snapshot()');
  assert.equal(state.listening, true);
  const defaultAddress = await driver.evaluate('document.querySelector("[name=mobile-address]").value');
  assert.equal(new URL(defaultAddress).port, String(state.port), 'first enable uses the assigned listening port');
  await driver.domInput('[name="mobile-address"]', `https://127.0.0.1:${state.port}`);
  await driver.domClick('[data-mobile="pair"]');
  await driver.waitFor('.mobile-pair img');
  assert.match((await driver.query('[data-pair-countdown]')).text, /秒后失效/);
  await writeFile(path.join(output, 'desktop-pairing.png'), Buffer.from((await driver.screenshot()).pngBase64, 'base64'));
  const pair = await driver.evaluate(`window.mobile.pair('https://127.0.0.1:${state.port}')`);
  const certificate = JSON.parse(await readFile(path.join(app.dataDir, 'mobile/identity.json'), 'utf8'));
  const request = (route, body, token) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: state.port, path: route, method: 'POST', ca: certificate.cert,
      checkServerIdentity: (_host, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === state.fingerprint ? undefined : new Error('Pin mismatch'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text)));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const paired = await request('/v1/pair', { token: new URL(pair.uri).searchParams.get('token'), clientId: randomUUID(), name: 'Android UI verification' });
  assert.equal(paired.ok, true);
  const command = action => request('/v1/request', { requestId: randomUUID(), issuedAt: Date.now(), command: { action } }, paired.data.token);
  assert.equal((await command('sync')).ok, true);
  await driver.waitFor('.mobile-device', el => el.text.includes('Android UI verification'));
  await driver.domClick('[data-mobile="permission"]');
  await driver.waitFor('[data-mobile="permission"]', el => el.text.includes('允许操作'));
  assert.equal((await command('sync')).data.canControl, false);
  await writeFile(path.join(output, 'desktop-devices.png'), Buffer.from((await driver.screenshot()).pngBase64, 'base64'));
  await driver.domClick('[data-mobile="revoke"]');
  await driver.waitFor('.mobile-devices', el => el.text.includes('尚未连接手机'));
  assert.equal((await command('sync')).error.code, 'MOBILE_UNAUTHORIZED');
  await driver.domClick('[data-mobile="toggle"]');
  assert.equal((await driver.evaluate('window.mobile.snapshot()')).enabled, false);
  await driver.domClick('[data-mobile="close"]');
  await driver.domClick('[data-workspace="browser"]');
  await driver.waitFor('[data-workspace="browser"][aria-current="page"]');
  await assert.rejects(driver.evaluate('window.mobile.snapshot()'), /手机工作区/);
  console.log('Passed: real desktop IPC, HTTPS pairing, mobile sync, read-only, revoke, disable, cross-workspace authorization.');
} finally { await app.stop(); }
