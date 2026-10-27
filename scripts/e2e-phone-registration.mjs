// Exercise the real renderer and registration service through the guarded ppilot Gateway.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), run = promisify(execFile);
const { LocalAppsService } = require('../dist/main/local-apps/service');
const { LocalAppGateway } = require('../dist/main/local-apps/gateway');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-registration-ui-'));
const output = path.join(root, 'artifacts', 'phone-registration'); await fs.mkdir(output, { recursive: true });
const freePort = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const cdpPort = await freePort(); let agentPort = await freePort(); while (agentPort === cdpPort) agentPort = await freePort();
const gateway = new LocalAppGateway(), service = new LocalAppsService(path.join(fixture, 'apps'), async () => new Set(), gateway);
const session = `phone-registration-${process.pid}`;
let id;
const cli = async (...args) => {
  const result = await run(process.execPath, [path.join(root, 'dist/main/profilepilot-cli.cjs'), 'browser', '--session', session, '--cdp', String(agentPort), ...args], { cwd: root, windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
};
const evaluate = async expression => {
  const output = await cli('eval', '-b', Buffer.from(expression).toString('base64'));
  return JSON.parse(output);
};
try {
  id = await service.save({ name: 'ProfilePilot · device registration test', mode: 'launch', cwd: fixture,
    command: `"${require('electron')}" --remote-debugging-port={cdpPort} "${path.join(root, 'scripts/e2e/fixtures/phone-ui-main.cjs')}"`,
    environment: `PHONE_UI_FIXTURE=${fixture}\nPHONE_UI_SOCKET=${process.platform === 'win32' ? `\\\\.\\pipe\\pp-registration-${process.pid}` : path.join(fixture, 'driver.sock')}`, cdpPort, inspectPort: null, agentPort });
  await service.start(id);
  for (let i = 0; i < 30; i++) { if ((await service.list())[0].debug.renderer) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  const connected = await service.connect(id);
  assert.equal(connected.status, 'connected', JSON.stringify(connected));
  assert.ok((await gateway.activeProfile(service.get(id)))?.publicPort === agentPort, 'Gateway route must be registered before CLI use');
  await cli('snapshot', '-i');
  await evaluate(`window.phoneNearbyFixture.set([{id:'b5547b10-3843-487b-ab31-46ec92cf5854',deviceId:'4adacb66-890f-4faa-8d47-d1862aeb3477',name:'测试手机 <&>',ip:'192.168.1.8',version:'0.3.6-dev',variant:'debug',wirelessDebugging:'disabled'}])`);
  await cli('click', '.phone-list-tools [data-action="add-device"]');
  assert.match(await cli('snapshot', '-i'), /添加真实设备/);
  assert.equal(await evaluate('document.querySelectorAll(".phone-connect-choices>button").length'), 2);
  await cli('screenshot', path.join(output, '01-device-types.png'));
  await cli('click', '[data-connect="real"]'); await cli('wait', '[data-add="0"]');
  assert.match(await cli('get', 'text', '[data-devices]'), /测试手机 <&>/);
  await cli('screenshot', path.join(output, '02-nearby.png'));
  await cli('click', '[data-add="0"]'); await cli('wait', '[data-done]');
  await cli('click', '[data-done]');
  const device = await evaluate('(async()=> (await window.phones.snapshot()).devices.find(d=>d.transport==="registered"))()');
  assert.equal(device.state, null); assert.equal(device.connection, 'missing');
  assert.match(await cli('get', 'text', '[data-phone-row="registered-4adacb66-890f-4faa-8d47-d1862aeb3477"]'), /已添加/);
  await cli('click', '.phone-list-tools [data-action="add-device"]'); await cli('click', '[data-connect="real"]');
  await cli('click', '[data-tab="code"]');
  await cli('screenshot', path.join(output, '03-device-code.png'));
  await cli('fill', '[name="code"]', 'WRONG'); await cli('click', '[data-code-form] button[type="submit"]');
  assert.match(await cli('get', 'text', '.phone-add-error'), /12 位/);
  await cli('click', '.phone-add-dialog [data-close]');
  const calls = await evaluate('window.phoneBasicFixture.calls()');
  assert.equal(calls.some(args => ['pair', 'connect', 'install'].includes(args[0])), false);
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  console.log(JSON.stringify({ ok: true, checks: ['two device categories', 'LAN add without debugging', 'escaped device name', 'saved device list', 'device-code form validation', 'no control authorization'], screenshots: output }));
} catch (error) { console.error(error); throw error; } finally {
  try { await cli('complete'); } catch {}
  if (id) { try { await service.stop(id); await service.remove(id); } catch (error) { console.error('Fixture cleanup:', error.message); } }
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
