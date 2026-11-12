import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';

const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pp-default-phone-ui-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-phone-ui-${process.pid}` : path.join(fixture, 'driver.sock');
const child = spawn(require('electron'), [path.join(repoRoot, 'scripts/e2e/fixtures/phone-ui-main.cjs')], { cwd: repoRoot, windowsHide: true, env: { ...process.env, PHONE_UI_FIXTURE: fixture, PHONE_UI_SOCKET: socket }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', driver;
child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
try {
  for (let tries = 0; tries < 200; tries++) {
    if (child.exitCode !== null) throw new Error(`Phone UI fixture exited: ${logs}`);
    try {
      const connection = await new Promise((resolve, reject) => { const client = net.createConnection(socket); client.once('connect', () => resolve(client)); client.once('error', error => { client.destroy(); reject(error); }); });
      driver = new ElectronDriver(connection); break;
    } catch { await delay(50); }
  }
  assert.ok(driver, `Fixture driver did not start: ${logs}`);
  await driver.waitFor('[data-phone-row]');
  await driver.domClick('[data-action="device-menu"][data-device-id="UI-TEST-1"]');
  await driver.domClick('[data-action="set-default-device"]');
  await driver.waitFor('[data-phone-default]', item => item.text?.includes('默认设备：'));
  assert.equal((await driver.evaluate('window.phones.snapshot()')).defaultDevice.saved.id, 'UI-TEST-1');
  assert.equal((await driver.query('.phone-default-badge')).count, 1);
  await driver.domClick('[data-action="device-menu"][data-device-id="UI-TEST-2"]');
  await driver.domClick('[data-action="set-default-device"]');
  await driver.waitFor('[data-phone-row="UI-TEST-2"] .phone-default-badge');
  assert.equal((await driver.query('.phone-default-badge')).count, 1);
  await driver.domClick('[data-action="clear-default-device"]');
  await driver.waitFor('.phone-default-badge', item => !item.exists);
  assert.equal((await driver.evaluate('window.phones.snapshot()')).defaultDevice.saved, null);
  await driver.domClick('[data-action="device-menu"][data-device-id="UI-TEST-1"]');
  await driver.domClick('[data-action="set-default-device"]');
  await driver.waitFor('.phone-default-badge');
  const before = await driver.evaluate('window.phones.snapshot()');
  await driver.evaluate('window.phoneFixture.setConnection(false)');
  assert.equal((await driver.evaluate('window.phones.snapshot()')).defaultDevice.saved.id, 'UI-TEST-1');
  assert.equal((await driver.evaluate('window.phones.snapshot()')).defaultDevice.available, true, 'verified Wi-Fi route still identifies the same phone');
  await driver.evaluate('window.phoneFixture.setOffline()');
  await driver.waitFor('[data-phone-default]', item => item.text?.includes('当前未连接'));
  const after = await driver.evaluate('window.phones.snapshot()');
  assert.equal(after.defaultDevice.saved.id, 'UI-TEST-1');
  assert.equal(after.defaultDevice.available, false);
  assert.equal(after.devices.find(device => device.id === 'UI-TEST-2').state.sessionId, before.devices.find(device => device.id === 'UI-TEST-2').state.sessionId);
  console.log('PASS: phone default set/switch/clear, offline notice, and unchanged other device session');
} finally {
  driver?.close(); child.kill();
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  child.stdout.destroy(); child.stderr.destroy();
  if (path.dirname(path.resolve(fixture)) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('pp-default-phone-ui-')) throw new Error('Unexpected fixture path');
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
