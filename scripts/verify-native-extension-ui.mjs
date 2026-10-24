// Real Chrome, disposable Profile, harmless local extension UI. No vault data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { getDirectChromeCommand } = require('../dist/main/chrome-launch');
const { CdpBrowserClient } = require('../dist/main/cdp-client');
const { parseNativeDebugEndpoint } = require('../dist/main/tasks/native-installer');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { requestNativeControl } = require('../dist/main/native-control/cli');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-extension-ui-'));
const chromeData = path.join(root, 'chrome'), foreign = path.join(root, 'foreign');
await mkdir(chromeData); await mkdir(foreign);
await writeFile(path.join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local UI fixture', version: '1.0.0', web_accessible_resources: [{ resources: ['frame.html', 'frame.js'], matches: ['http://127.0.0.1/*'] }] }));
await writeFile(path.join(foreign, 'frame.html'), '<!doctype html><title>Local fixture</title><button>Other logins</button><input type="password" value="must-never-be-returned"><script src="frame.js"></script>');
await writeFile(path.join(foreign, 'frame.js'), `document.querySelector('button').onclick=()=>{document.querySelector('button').textContent='Expanded';parent.postMessage('fixture-clicked','*')}`);
let extensionId, clicks = 0, child, client;
const server = createServer((req, res) => {
  if (req.url === '/clicked') { clicks++; res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Extension UI QA</title><h1>Fixture</h1><iframe src="chrome-extension://${extensionId}/frame.html"></iframe><script>addEventListener('message',e=>{if(e.data==='fixture-clicked')fetch('/clicked')})</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
const until = async (fn, label) => { const end = Date.now() + 20000; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw Error(label); };
const command = (method, params = {}) => requestNativeControl({ requestId: randomUUID(), method, params, profileId: 'native:Default', sessionId: 'ui-qa' }, root);
try {
  await bridge.start();
  child = spawn(getDirectChromeCommand(), [`--user-data-dir=${chromeData}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', ...(process.platform === 'win32' ? ['--disable-features=AutoDeElevate'] : []), 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const endpoint = await until(async () => { try { return parseNativeDebugEndpoint(await readFile(path.join(chromeData, 'DevToolsActivePort'), 'utf8')); } catch {} }, 'Chrome startup');
  client = await CdpBrowserClient.connect(endpoint, 5000);
  extensionId = (await client.send('Extensions.loadUnpacked', { path: foreign })).id;
  await client.send('Extensions.loadUnpacked', { path: path.resolve('extensions/profilepilot') });
  const target = await client.send('Target.createTarget', { url, background: true });
  const popup = await client.send('Target.createTarget', { url: `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`, background: true });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  const pair = await bridge.pair('native:Default');
  await until(async () => (await client.send('Runtime.evaluate', { expression: '!!globalThis.chrome?.runtime?.sendMessage', returnByValue: true }, 5000, sessionId)).result.value, 'Popup startup');
  const result = await client.send('Runtime.evaluate', { expression: `(async()=>{const r=await chrome.runtime.sendMessage(${JSON.stringify({ method: 'connect', code: pair.code })});if(r.error)throw Error(r.error);return (await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(url)}).id})()`, awaitPromise: true, returnByValue: true }, 5000, sessionId);
  assert.equal(result.exceptionDetails, undefined);
  await until(() => bridge.states()[0]?.connected, 'Extension pairing');
  await client.send('Target.closeTarget', { targetId: popup.targetId }); client.close(); client = undefined;
  // The production entry always reads nativeChromeUserDataDir. Only this QA
  // instance injects the endpoint of its own disposable process.
  bridge.control.extensionUi.options.endpoint = async () => endpoint;
  await command('claim', { tabId: result.result.value });
  assert.equal((await command('extension-ui', { action: 'connect', extensionId })).stage, 'authorizing');
  await until(async () => {
    const s = await command('extension-ui', { action: 'status' }); if (s.stage === 'failed') throw Error(s.error); return s.stage === 'ready';
  }, 'Companion connection');
  await assert.rejects(command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' } }), { code: 'NATIVE_EXTENSION_UI_ACTIVE' });
  if (process.env.PP_EXTENSION_UI_TRACE) {
    const c = bridge.control.extensionUi.connections.get('ui-qa');
    console.log('tree', JSON.stringify(await c.client.send('Page.getFrameTree', {}, 5000, c.pageSession)));
    console.log('targets', JSON.stringify(await c.client.send('Target.getTargets')));
    console.log('observation', JSON.stringify(await command('extension-ui', { action: 'observe' })));
  }
  const observed = await until(async () => { const o = await command('extension-ui', { action: 'observe' }); return o.frames.some(f => f.controls.some(c => c.label === 'Other logins')) && o; }, 'Foreign extension UI readable');
  assert.doesNotMatch(JSON.stringify(observed), /must-never-be-returned/);
  const ref = observed.frames.flatMap(f => f.controls).find(c => c.label === 'Other logins').ref;
  const click = { action: 'click', version: observed.version, ref };
  const requestId = randomUUID();
  await requestNativeControl({ requestId, method: 'extension-ui', params: click, sessionId: 'ui-qa' }, root);
  await requestNativeControl({ requestId, method: 'extension-ui', params: click, sessionId: 'ui-qa' }, root);
  await until(() => clicks === 1, 'Actual extension click delivered once');
  await assert.rejects(command('extension-ui', click), { code: 'NATIVE_OBSERVATION_STALE' });
  const after = await command('extension-ui', { action: 'observe' });
  assert.ok(after.frames.flatMap(f => f.controls).some(c => c.label === 'Expanded'));
  await command('control', { action: 'handoff' });
  assert.equal((await command('extension-ui', { action: 'status' })).stage, 'disconnected');
  await assert.rejects(command('extension-ui', { action: 'observe' }), { code: 'NATIVE_USER_IN_CONTROL' });
  await command('control', { action: 'resume' });
  await command('extension-ui', { action: 'connect', extensionId });
  await until(async () => (await command('extension-ui', { action: 'status' })).stage === 'ready', 'Explicit reconnect');
  await command('extension-ui', { action: 'disconnect' });
  assert.ok((await command('observe')).version);
  await command('control', { action: 'complete' });
  console.log(JSON.stringify({ ok: true, chrome: 'real', desktopInput: false, controlsRead: true, actualClicks: clicks, duplicateRequestReplayed: false, passwordReturned: false, takeoverStops: true, normalPageRestored: true }));
} finally {
  client?.close(); bridge.close(); server.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(r => { child.once('exit', r); setTimeout(r, 3000).unref(); }); }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
