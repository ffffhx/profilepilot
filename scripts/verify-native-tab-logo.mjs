// Real Chrome favicon verification in a disposable registered QA Profile.
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
const output = path.resolve('artifacts/tab-logo-20261006');
await mkdir(output, { recursive: true });
const siteIcon = await readFile('extensions/profilepilot/icons/icon-16.png');
const checks = [];
const server = createServer((req, res) => {
  if (/\.(png|ico)$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(siteIcon); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.includes('strict')) res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'");
  res.end(`<!doctype html><head><title>ProfilePilot 标签图标验收</title>${req.url.includes('no-icon') ? '' : '<link id="website-icon" rel="icon" type="image/png" sizes="16x16" href="/site.png">'}</head><body><h1>标签图标验收</h1><p>这是专用测试页面。</p></body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const session = `tab-logo-qa-${randomUUID()}`;
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
const tab = id => evaluate(`chrome.tabs.get(${id}).then(t => ({id:t.id,active:t.active,favIconUrl:t.favIconUrl,url:t.url}))`);
const logo = `chrome-extension://${NATIVE_EXTENSION_ID}/icons/icon-32.png`;
try {
  gateway = await startTaskGatewayFixture({ extensionPaths: [path.resolve('extensions/profilepilot')] });
  await cli(['open', url]);
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const oldTab = await evaluate(`chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === ${JSON.stringify(url + '/')})?.id)`);
  assert.ok(oldTab);
  bridge = new NativeBrowserBridge(output, { read: () => ({}), write: () => {} });
  const pairing = await bridge.pair('native:LogoFixture');
  const paired = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ method: 'connect', code: pairing.code })})`);
  assert.ok(!paired.error, paired.error);
  await until(() => bridge.states().some(s => s.connected), 'Test extension did not connect');
  const request = (method, params = {}) => bridge.request('native:LogoFixture', method, { sessionId: session, ...params });
  const raw = expression => request('cdp', { method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
  const activeBefore = await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(t=>t.id))');

  await request('claim', { tabId: oldTab });
  await until(async () => (await tab(oldTab)).favIconUrl === logo, 'Existing tab did not display the ProfilePilot favicon');
  pass('Chrome reports the ProfilePilot favicon on the controlled background tab');

  await raw("document.querySelector('#website-icon').href='/changed.png'; document.querySelector('#website-icon').sizes='48x48'");
  await until(async () => (await raw("document.querySelector('#website-icon').href")).result.value === logo, 'Site icon update replaced the task logo');
  await request('control', { action: 'handoff' });
  await until(async () => (await tab(oldTab)).favIconUrl === `${url}/changed.png`, 'Handoff did not restore the latest website favicon');
  const attrs = await evaluate(`chrome.scripting.executeScript({target:{tabId:${oldTab}},func:()=>({size:document.querySelector('#website-icon').getAttribute('sizes'),count:document.querySelectorAll('link[rel=icon]').length})}).then(r=>r[0].result)`);
  assert.deepEqual(attrs, { size: '48x48', count: 1 });
  pass('Dynamic website icon and its attributes are restored on handoff');

  await request('control', { action: 'resume', controlGeneration: bridge.states()[0].controlGeneration });
  const created = await request('newTab', { url: `${url}/created` });
  await until(async () => (await tab(created.tabId)).favIconUrl === logo, 'Created tab did not display the logo');
  await request('cdp', { method: 'Page.reload' });
  await until(async () => (await tab(created.tabId)).favIconUrl === logo, 'Reload lost the logo');
  await request('control', { action: 'complete' });
  assert.equal((await tab(created.tabId)).favIconUrl, logo);
  pass('New task tabs retain their logo after reload and task completion');

  const strict = await evaluate(`chrome.tabs.create({url:${JSON.stringify(url + '/strict')},active:false}).then(t=>t.id)`);
  await until(async () => (await tab(strict)).favIconUrl === `${url}/site.png`, 'Strict CSP fixture did not finish loading');
  await request('claim', { tabId: strict });
  await until(async () => (await tab(strict)).favIconUrl === logo, 'Strict CSP prevented favicon marking');
  await request('control', { action: 'complete' });
  await until(async () => (await tab(strict)).favIconUrl === `${url}/site.png`, 'Strict CSP favicon was not restored');
  pass('Marking and restoration work with a strict img-src CSP');

  const noIcon = await evaluate(`chrome.tabs.create({url:${JSON.stringify(url + '/no-icon')},active:false}).then(t=>t.id)`);
  await until(async () => (await tab(noIcon)).favIconUrl === `${url}/favicon.ico`, 'Default favicon fixture did not load');
  await request('claim', { tabId: noIcon });
  await until(async () => (await tab(noIcon)).favIconUrl === logo, 'Iconless page was not marked');
  await request('control', { action: 'complete' });
  await until(async () => (await tab(noIcon)).favIconUrl === `${url}/favicon.ico`, 'Default website favicon was not restored');
  pass('Pages without icon links recover the site default favicon');
  assert.deepEqual(await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(t=>t.id))'), activeBefore);
  pass('All marking, switching and restoration leave the foreground tab unchanged');

  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform, checks, extensionVersion: '0.2.4', notVerified: ['macOS hardware', 'user default Profile (another task is active)'] }, null, 2));
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
