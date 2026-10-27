// Isolated renderer, real discovery orchestration, simulated phone/network responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';
const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pp-nearby-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-nearby-${process.pid}` : path.join(fixture, 'driver.sock');
const output = path.join(repoRoot, 'artifacts', 'phone-nearby');
await mkdir(output, { recursive: true });
const child = spawn(require('electron'), [path.join(repoRoot, 'scripts/e2e/fixtures/phone-ui-main.cjs')], {
  cwd: repoRoot, windowsHide: true, env: { ...process.env, PHONE_UI_FIXTURE: fixture, PHONE_UI_SOCKET: socket }, stdio: ['ignore', 'pipe', 'pipe']
});
let driver, logs = '';
child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw Error(logs);
    try {
      driver = new ElectronDriver(await new Promise((resolve, reject) => {
        const client = net.createConnection(socket);
        client.once('connect', () => resolve(client)); client.once('error', error => { client.destroy(); reject(error); });
      })); break;
    } catch { await delay(50); }
  }
  assert.ok(driver, logs);
  await driver.waitFor('[data-phone-row]');
  await driver.evaluate('window.phoneDiscoveryFixture.set("")');
  await driver.evaluate(`window.phoneNearbyFixture.set([{ id: 'b5547b10-3843-487b-ab31-46ec92cf5854', name: '测试手机 <&>', ip: '192.168.1.8', version: '0.3.6-dev', variant: 'debug', wirelessDebugging: 'disabled' }])`);
  const open = async () => {
    await driver.domClick('.phone-list-tools [data-action="add-device"]'); await driver.domClick('[data-connect="wifi"]');
    await driver.waitFor('.phone-wireless-dialog[open]');
  };
  await open();
  await driver.waitFor('[data-nearby-app="0"]');
  assert.match((await driver.query('[data-nearby-app="0"]')).text, /测试手机 <&>.*未开启无线调试/s);
  assert.equal((await driver.query('[data-candidate]')).count, 0);
  assert.ok(await driver.evaluate('window.phoneNearbyFixture.scans()') > 0, 'entry automatically scans');
  await driver.domClick('[data-nearby-app="0"]');
  assert.match((await driver.query('[data-selected-app]')).text, /已发现手机 App/);
  assert.equal(await driver.evaluate('document.querySelector(".wireless-setup").open'), true);
  await driver.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(150);
  await writeFile(path.join(output, 'app-without-debugging.png'), Buffer.from((await driver.screenshot()).pngBase64, 'base64'));
  // Device enables wireless debugging while the discovery page stays open.
  await driver.evaluate('window.phoneDiscoveryFixture.set(null)');
  await driver.waitFor('[data-candidate]', value => value.count === 2, { timeoutMs: 12000 });
  await driver.domClick('[data-candidate="0"]');
  await driver.waitFor('[data-pair-form]');
  assert.equal((await driver.query('[name="pairAddress"]')).value, '192.168.1.8:37123');
  const before = await driver.evaluate('window.phoneNearbyFixture.scans()');
  await driver.domClick('.phone-wireless-dialog [data-close]');
  await delay(5600);
  assert.equal(await driver.evaluate('window.phoneNearbyFixture.scans()'), before, 'closed dialog stops automatic discovery');
  await open();
  await driver.domClick('.phone-wireless-dialog [data-close]');
  await delay(900);
  assert.equal((await driver.query('.phone-wireless-dialog')).exists, false, 'late results cannot reopen the dialog');
  const calls = await driver.evaluate('window.phoneBasicFixture.calls()');
  assert.equal(calls.some(args => ['pair', 'connect', 'install'].includes(args[0])), false, 'discovery and selection never pair, connect or install');
  console.log(JSON.stringify({ ok: true, checks: ['automatic discovery', 'App visible with debugging disabled', 'escaped names', 'selection guidance', 'automatic refresh', 'selected pairing address', 'close cancels refresh', 'late results ignored'], screenshots: output }));
} finally {
  try { await driver?.request('quit'); } catch { }
  driver?.close();
  for (let attempt = 0; child.exitCode === null && attempt < 40; attempt++) await delay(50);
  if (child.exitCode === null) child.kill();
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
