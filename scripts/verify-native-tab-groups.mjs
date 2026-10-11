// Real Chrome task-group verification in a disposable registered QA Profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';

const require = createRequire(import.meta.url);
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { parseCliResult } = require('../dist/main/tasks/browser');
const output = path.resolve('artifacts/tab-groups-20261010');
await mkdir(output, { recursive: true });
const siteIcon = await readFile('extensions/profilepilot/icons/icon-16.png');
const checks = [];
const server = createServer((req, res) => {
  if (/\.(png|ico)$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(siteIcon); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.includes('strict')) res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'");
  res.end(`<!doctype html><head><title>ProfilePilot 标签分组验收</title><link id="website-icon" rel="icon" type="image/png" sizes="16x16" href="/site.png"></head><body><h1>标签分组验收</h1><p>这是专用测试页面。</p></body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const session = `tab-groups-qa-${randomUUID()}`;
let gateway, bridge, completed = false;
const cli = async args => {
  try {
    const response = await promisify(execFile)(process.execPath, [path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs'), '--session', session, '--cdp', String(gateway.port), '--pin-tab', '--json', ...args],
      { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    return parseCliResult(response.stdout);
  } catch (error) { throw Error(String(error.stderr || error.stdout || error.message).replace(/PP1\.[\w-]+/g, '[pairing]')); }
};
const evaluate = async expression => (await cli(['eval', '-b', Buffer.from(expression).toString('base64')])).result;
const until = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 120)); }
  throw Error(label);
};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const tab = id => evaluate(`chrome.tabs.get(${id}).then(t => ({id:t.id,active:t.active,favIconUrl:t.favIconUrl,url:t.url,groupId:t.groupId}))`);
const group = id => evaluate(`chrome.tabGroups.get(${id})`);
try {
  gateway = await startTaskGatewayFixture();
  await cli(['open', url]);
  await cli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const oldTab = await evaluate(`chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === ${JSON.stringify(url + '/')})?.id)`);
  assert.ok(oldTab);
  bridge = new NativeBrowserBridge(output, { read: () => ({}), write: () => {} });
  const pairing = await bridge.pair('native:GroupFixture');
  const paired = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ method: 'connect', code: pairing.code })})`);
  assert.ok(!paired.error, paired.error);
  await until(() => bridge.states().some(s => s.connected), 'Test extension did not connect');
  const request = (method, params = {}) => bridge.request('native:GroupFixture', method, { sessionId: session, ...params });
  const raw = expression => request('cdp', { method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
  const activeBefore = await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(t=>t.id))');

  await request('claim', { tabId: oldTab, taskTitle: '标签分组验收' });
  await until(async () => (await tab(oldTab)).groupId >= 0, 'Existing task tab did not join a group');
  const groupId = (await tab(oldTab)).groupId;
  const expectColor = color => until(async () => (await group(groupId)).color === color, `Group did not turn ${color}`);
  await expectColor('blue'); pass('A real native blue group is created without activating the task tab');
  await request('taskState', { status: 'waiting_user', controlGeneration: bridge.states()[0].controlGeneration });
  await expectColor('purple');
  await request('control', { action: 'handoff' }); await expectColor('purple');
  const stoppedGeneration = bridge.states()[0].controlGeneration;
  const takeover = await evaluate(`chrome.runtime.sendMessage({method:'takeover'})`); assert.ok(!takeover.error);
  await expectColor('orange');
  await request('taskState', { status: 'running', controlGeneration: stoppedGeneration }); await expectColor('orange');
  pass('Waiting is purple; user takeover is orange and stale status cannot override it');
  await request('control', { action: 'resume', controlGeneration: bridge.states()[0].controlGeneration }); await expectColor('blue');
  const created = await request('newTab', { url: `${url}/created` });
  await until(async () => (await tab(created.tabId)).groupId === groupId, 'New tab did not join the existing group');
  await raw("document.querySelector('#website-icon').href='/changed.png'");
  await until(async () => (await tab(created.tabId)).favIconUrl === `${url}/changed.png`, 'Website favicon was replaced');
  await request('cdp', { method: 'Page.reload' });
  await until(async () => (await tab(created.tabId)).favIconUrl === `${url}/site.png`, 'Reload did not preserve the website icon');
  assert.equal((await tab(created.tabId)).groupId, groupId);
  pass('New tabs and reloads keep group identity and original website favicons');
  await request('control', { action: 'complete', groupPhase: 'failed' }); await expectColor('red');
  await request('claim', { tabId: oldTab, taskTitle: '标签分组验收' }); await expectColor('blue');
  await request('control', { action: 'complete' }); await expectColor('green');
  assert.equal((await tab(oldTab)).groupId, groupId); assert.equal((await tab(created.tabId)).groupId, groupId);
  assert.equal((await evaluate('chrome.tabGroups.query({})')).length, 1);
  pass('Failure, continuation and completion reuse the same group, ending green');
  assert.deepEqual(await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(t=>t.id))'), activeBefore);
  pass('All grouping, status updates and completion leave the foreground tab unchanged');

  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform, checks, group: await group(groupId), extensionVersion: '0.2.7', notVerified: ['macOS hardware', 'user default Profile (currently a temporary extension installation)'] }, null, 2));
  await cli(['profilepilot', 'complete']); completed = true;
} catch (error) {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', platform: process.platform, checks, error: error.message }, null, 2));
  throw error;
} finally {
  if (gateway && !completed) await cli(['profilepilot', 'release']).catch(() => {});
  bridge?.close();
  await gateway?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
