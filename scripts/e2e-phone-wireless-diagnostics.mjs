// Isolated Electron renderer + real phone service; all device I/O is simulated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ElectronDriver, delay, repoRoot } from './e2e/lib/electron-driver.mjs';

const require = createRequire(import.meta.url);
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pp-wui-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pp-wui-${process.pid}` : path.join(fixture, 'driver.sock');
const output = path.join(repoRoot, 'artifacts', 'wireless-diagnostics');
await mkdir(output, {recursive:true});
const child = spawn(require('electron'), [path.join(repoRoot, 'scripts/e2e/fixtures/phone-ui-main.cjs')], {
  cwd:repoRoot, windowsHide:true, env:{...process.env, PHONE_UI_FIXTURE:fixture, PHONE_UI_SOCKET:socket}, stdio:['ignore','pipe','pipe']
});
let logs = '', driver;
child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw Error(`Fixture exited: ${logs}`);
    try {
      const connection = await new Promise((resolve, reject) => {
        const client = net.createConnection(socket);
        client.once('connect', () => resolve(client)); client.once('error', error => {client.destroy(); reject(error);});
      });
      driver = new ElectronDriver(connection); break;
    } catch {await delay(50);}
  }
  assert.ok(driver, `Fixture did not start: ${logs}`);
  const captureFailure = async name => {
    await driver.evaluate('document.querySelector(".wireless-error").scrollIntoView({block:"center"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(150);
    await writeFile(path.join(output,name), Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  };
  await driver.waitFor('[data-phone-row]');
  await driver.domClick('.phone-inspector [data-action="details"]');
  await driver.domClick('.phone-route [data-action="wifi"]');
  await driver.waitFor('.phone-wireless-dialog[open]');
  await driver.domClick('[data-first-pair]');
  assert.match((await driver.query('.wireless-note')).text, /网络授权.*6 位码/);
  await driver.domClick('[data-next]');
  await driver.waitFor('[data-candidate="0"]');
  await driver.domClick('[data-candidate="0"]');
  await driver.domInput('[name="pairCode"]', '654321');
  await driver.domClick('[data-pair-form] button[type="submit"]');
  await driver.waitFor('.wireless-error', item => /未确认配对成功/.test(item.text));
  assert.match((await driver.query('.wireless-error')).text, /原因尚未确认/);
  assert.doesNotMatch((await driver.query('.wireless-error')).text, /654321|Error invoking/);
  assert.equal((await driver.query('[name="pairCode"]')).value, '');
  await driver.domClick('.wireless-error summary');
  assert.match((await driver.query('.wireless-error details')).text, /诊断编号：[a-f0-9-]+/);
  assert.match((await driver.query('.wireless-error details')).text, /阶段：无线调试配对/);
  await captureFailure('pairing-failure.png');
  await driver.domInput('[name="pairCode"]', '123456');
  await driver.domClick('[data-pair-form] button[type="submit"]');
  await driver.waitFor('[data-connect-form]');
  await driver.waitFor('[data-candidate="0"]');
  assert.equal(await driver.evaluate('document.querySelector(".wireless-error").hidden'), true);
  await driver.domInput('[name="connectAddress"]', '192.168.1.8:37123');
  await driver.domClick('[data-connect-form] button[type="submit"]');
  await driver.waitFor('.wireless-error', item => /未建立无线连接/.test(item.text));
  assert.match((await driver.query('.wireless-error')).text, /PHONE_WIFI_UNKNOWN/);
  await driver.domClick('.wireless-error summary');
  await captureFailure('connection-failure.png');
  await driver.domInput('[name="connectAddress"]', '192.168.1.8:40235');
  await driver.domClick('[data-connect-form] button[type="submit"]');
  await driver.waitFor('[data-finish]');
  const device = (await driver.evaluate('window.phones.snapshot()')).devices.find(d => d.id === '192.168.1.8:40235');
  assert.equal(device.state, null, 'recovery does not start control');
  assert.equal(await driver.evaluate('document.querySelector(".wireless-error").hidden'), true);
  console.log(JSON.stringify({ok:true, checks:['network consent guidance','pair failure and cleared code','collapsed diagnostic details','IPC error formatting','connection failure','successful retry without stale errors or control'], screenshots:output}));
} finally {
  try {await driver?.request('quit');} catch {}
  driver?.close();
  for (let attempt=0; child.exitCode===null && attempt<40; attempt++) await delay(50);
  if (child.exitCode===null) child.kill();
  await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
