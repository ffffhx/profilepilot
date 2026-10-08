import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';

// A real Chrome, disposable Profile and the shipped extension. Gateway is used
// only to install/pair; its lease ends before the native transport takes over.
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.PP_CONTROL_BUILD || 'dist');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require(path.join(build, 'main/tasks/native-bridge'));
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-control-live-'));
const reportDir = path.resolve('artifacts/herdr-native-20260926/control-evidence');
await mkdir(reportDir, { recursive: true });
const checks = [], record = name => { checks.push(name); console.log(`PASS ${name}`); };
const fixture = http.createServer((req, res) => {
  if (req.url === '/network') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="direct-control.csv"' }); res.end('name,value\nfixture,42\n'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Direct control fixture</title><label>Name <input aria-label="Name"></label><button id="submit" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('input').value;console.log('fixture-saved');fetch('/network')">Save</button><p id="result">Waiting</p><a href="/download" download>Download report</a>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let gateway, bridge, bootstrapDone = false, sessionClaimed = false;
let downloadedFile;
const bootstrap = `control-bootstrap-${randomUUID()}`;
const session = `control-${randomUUID()}`;
const exec = promisify(execFile);
const wrapper = path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs');
const bootstrapCli = async args => {
  const { stdout } = await exec(process.execPath, [wrapper, '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(stdout); if (data.success === false || data.ok === false) throw new Error(JSON.stringify(data)); return data.data ?? data;
};
const cli = async (method, params = {}, extra = []) => {
  // Passing JSON by argv through execFile avoids shell quoting/interpolation.
  const { stdout } = await exec(process.execPath, [path.join(build, 'main/native-control/cli.js'), '--root', root, '--session', session, method, '--params', JSON.stringify(params), ...extra], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 35000, maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout); assert.equal(data.ok, true); return data.result;
};
const until = async (check, label, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw Error(label); };
try {
  gateway = await startTaskGatewayFixture();
  bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  await bootstrapCli(['open', url]);
  await bootstrapCli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await bootstrapCli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair = await bridge.pair('native:control-fixture');
  const paired = await bootstrapCli(['eval', `(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(url)}));const reply=await chrome.runtime.sendMessage({method:'connect',code:${JSON.stringify(pair.code)}});await chrome.tabs.update(tab.id,{active:true});return {reply,tabId:tab.id};})()`]);
  const value = paired.result ?? paired;
  if (value.reply?.error) throw Error(value.reply.error);
  assert.ok(value.tabId, 'fixture tab ID');
  await until(() => bridge.states().some(s => s.connected && s.extensionVersion === '0.2.0'), 'extension connection/version');
  await bootstrapCli(['profilepilot', 'complete']); bootstrapDone = true;
  record('isolated Gateway bootstrap released; extension 0.2.0 authenticated');
  const status = await cli('status'); assert.equal(status.profiles[0].profileId, 'native:control-fixture');
  await cli('claim', { tabId: value.tabId }); sessionClaimed = true;
  const tabs = await cli('tabs'); assert.ok(tabs.some(t => Number(t.id) === value.tabId));
  record('direct CLI discovers exact paired Profile and claims existing tab');
  await cli('debug');
  let observation = await cli('observe');
  const name = observation.fast.candidates.find(c => c.label === 'Name'); assert.ok(name);
  await cli('action', { kind: 'fill', ref: name.ref, value: 'External Agent', version: observation.version });
  await assert.rejects(cli('action', { kind: 'fill', ref: name.ref, value: 'Replay', version: observation.version }));
  observation = await cli('observe');
  const save = observation.fast.candidates.find(c => c.label === 'Save'); assert.ok(save);
  await cli('action', { kind: 'click', ref: save.ref, version: observation.version });
  await until(async () => (await cli('observe')).snapshot.includes('Saved External Agent'), 'click result not observed');
  record('real CLI observe -> fill -> observe -> click -> verify, stale version rejected');
  const screenshot = await cli('screenshot'); assert.ok(Buffer.from(screenshot.data, 'base64').length > 100);
  await writeFile(path.join(reportDir, 'direct-control.png'), Buffer.from(screenshot.data, 'base64'));
  record('real screenshot via direct CLI');
  const events = await cli('events', { since: 0, limit: 1000 });
  assert.ok(events.events.some(e => e.method === 'Runtime.consoleAPICalled' && JSON.stringify(e.params).includes('fixture-saved')));
  assert.ok(events.events.some(e => e.method === 'Network.responseReceived' && e.params.response.url.endsWith('/network')));
  const metrics = await cli('cdp', {}, ['Performance.getMetrics']); assert.ok(metrics.metrics.length);
  record('console/network event retrieval and Performance CDP metrics');
  const history = await cli('history', { query: 'Direct control fixture', startTime: Date.now() - 3600000, endTime: Date.now() + 1000, maxResults: 20 });
  assert.ok(history.some(h => h.url.startsWith(url)));
  record('real Profile history search by query/time/limit');
  const download = await cli('download', { url: url + '/download', filename: `profilepilot-control-fixture-${randomUUID()}.csv` });
  downloadedFile = download.download.filename;
  assert.match(await readFile(download.file.path, 'utf8'), /fixture,42/);
  record('explicit download ID -> completed file -> registered readable artifact');
  await cli('handoff');
  await assert.rejects(cli('observe'));
  await assert.rejects(cli('claim', {}, ['--profile', 'native:control-fixture']));
  await cli('resume');
  await assert.rejects(cli('action', { kind: 'click', ref: save.ref, version: observation.version }));
  await cli('observe');
  record('takeover stops operations, explicit resume requires fresh observation');
  bridge.connections.get('native:control-fixture').peer.close(4000, 'fixture disconnect');
  await until(() => !bridge.states().some(s => s.connected), 'disconnect state');
  await assert.rejects(cli('observe'));
  record('actual native WebSocket disconnection blocks input without replay');
  await cli('release'); sessionClaimed = false;
  await writeFile(path.join(reportDir, 'result.json'), JSON.stringify({ platform: process.platform, at: new Date().toISOString(), build, checks, macOS: process.platform === 'darwin' ? 'tested' : 'not tested' }, null, 2));
} finally {
  if (sessionClaimed) await cli('release').catch(() => {});
  bridge?.close();
  if (gateway && !bootstrapDone) await bootstrapCli(['profilepilot', 'release']).catch(() => {});
  await gateway?.close(); await new Promise(r => fixture.close(r));
  if (downloadedFile && path.basename(downloadedFile).startsWith('profilepilot-control-fixture-')) await rm(downloadedFile, { force: true }).catch(() => {});
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true }).catch(() => {});
}
