// Exercise the Chrome security boundary in a disposable QA Profile. The second
// extension is a local fixture with no permissions or user data, never 1Password.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { parseCliResult } = require('../dist/main/tasks/browser');
const { BrowserGatewayDaemon } = require('../dist/main/browser-gateway-daemon');
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client');
const { getDirectChromeCommand } = require('../dist/main/chrome-launch');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-debugger-conflict-'));
const home = path.join(root, 'home'); await mkdir(home);
const env = { ...process.env, HOME: home, PROFILEPILOT_GATEWAY_HOME: home, CPM_DATA_DIR: path.join(root, 'data'),
  AGENT_BROWSER_SOCKET_DIR: path.join(home, '.agent-browser'), ELECTRON_RUN_AS_NODE: '1' };
const output = path.resolve('artifacts/native-debugger-failures');
await mkdir(output, { recursive: true });
const foreign = path.join(root, 'foreign'); await mkdir(foreign);
await writeFile(path.join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local foreign-frame fixture', version: '1.0.0',
  web_accessible_resources: [{ resources: ['frame.html'], matches: ['http://127.0.0.1/*'] }] }));
await writeFile(path.join(foreign, 'frame.html'), '<!doctype html><title>Local extension fixture</title><p>Test extension frame</p>');
let foreignId, dismiss = false, dismissed = false;
const server = createServer((req, res) => {
  if (req.url === '/mode') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ dismiss })); return; }
  if (req.url === '/dismissed') { dismissed = true; res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Debugger conflict fixture</title><body>
    <label>School <input aria-label="School" role="combobox" aria-haspopup="listbox" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false"></label>
    <p id="options" hidden>School option opened</p>
    <label>Attachment<input id="upload" type="file" multiple></label>
    <input aria-label="Unrelated" id="unrelated"><span id="ticker"></span>
    <style>@keyframes pulse{from{opacity:1}to{opacity:.5}}#ticker{animation:pulse .2s infinite alternate}</style>
    <script>setInterval(()=>{document.querySelector('#ticker').textContent=Date.now();document.querySelector('#unrelated').value=Date.now()},40)</script>
    ${req.url === '/conflict' ? `<iframe id="foreign" src="chrome-extension://${foreignId}/frame.html"></iframe>
    <script>setInterval(async()=>{if((await(await fetch('/mode')).json()).dismiss){document.querySelector('#foreign')?.remove();document.body.dataset.dismissed='true';await fetch('/dismissed');}},100)</script>` : ''}
  </body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const profileId = 'native:DebuggerFixture', bootstrap = `debugger-bootstrap-${randomUUID()}`;
const task = { id: randomUUID(), sessionId: `debugger-qa-${randomUUID()}`, profileId, browserConnection: 'extension', status: 'running', attachments: [] };
const checks = [];
let gateway, bridge, browser, daemon, bootstrapDone = false;
const cli = async args => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs'), '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args],
      { windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024, env });
    return parseCliResult(stdout);
  } catch (error) { throw Error(String(error.stderr || error.stdout || error.message).replace(/PP1\.[\w-]+/g, '[pairing]')); }
};
const until = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(label);
};
const pass = name => { checks.push(name); console.log('PASS', name); };
try {
  // Register the disposable browser explicitly, with the same home for the
  // daemon and child CLI. Windows os.homedir() does not follow HOME.
  daemon = new BrowserGatewayDaemon(home); await daemon.start();
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  await requestBrowserGateway({ action: 'launch-profile', profileId: 'debugger-fixture', profileName: 'Debugger conflict fixture', publicPort: port,
    executable: getDirectChromeCommand(), args: [`--user-data-dir=${path.join(root, 'chrome')}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
      ...(process.platform === 'win32' ? ['--disable-features=AutoDeElevate'] : []), 'about:blank'] }, { homeDir: home, timeoutMs: 15000 });
  gateway = { port, close: () => requestBrowserGateway({ action: 'unregister-profile', publicPort: port, closeChrome: true }, { homeDir: home }) };
  await cli(['open', url + '/clean']);
  const loaded = await cli(['profilepilot', 'extension', 'load-unpacked', foreign]);
  foreignId = loaded.extension_id;
  assert.match(foreignId || '', /^[a-p]{32}$/, 'fixture extension ID');
  await cli(['tab', 'new', url + '/conflict']);
  await cli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  browser = new NativeBrowser(bridge, output);
  const pair = await bridge.pair(profileId);
  const expression = `(async()=>{const result=await chrome.runtime.sendMessage(${JSON.stringify({ method: 'connect', code: pair.code })});if(result.error)throw Error(result.error);return (await chrome.tabs.query({})).filter(t=>t.url?.startsWith(${JSON.stringify(url)})).map(t=>({id:t.id,url:t.url}));})()`;
  const tabs = (await cli(['eval', '-b', Buffer.from(expression).toString('base64')])).result;
  await until(() => bridge.states().some(s => s.connected), 'Extension pairing');
  await cli(['profilepilot', 'complete']); bootstrapDone = true;
  task.nativeTarget = { tabId: tabs.find(t => t.url.endsWith('/clean')).id };
  task.observation = await browser.observe(task);
  const field = task.observation.fast.candidates.find(c => c.label === 'School');
  assert.equal(field.role, 'combobox');
  await browser.execute(task, { kind: 'click', ref: field.ref, effect: 'edit', summary: 'Open local school chooser' });
  assert.match((await browser.observe(task)).snapshot, /School option opened/);
  pass('Real Chrome clicks an editable combobox to open its options');
  task.observation = await browser.observe(task, true);
  assert.equal(task.observation.availability.screenshot.status, 'available');
  assert.equal(task.observation.availability.coordinates.status, 'unavailable');
  await writeFile(path.join(output, 'dynamic.png'), Buffer.from(task.observation.screenshotDataUrl.split(',')[1], 'base64'));
  await assert.rejects(browser.pointer(task, {kind:'click', x:5, y:5, version:task.observation.version}), /截图/);
  pass('Dynamic background page returns fresh PNG and DOM while coordinate actions remain blocked');
  await browser.control(task, 'complete');
  const directSession = `contract-${randomUUID()}`;
  const direct = (method, params = {}, extra = {}) => bridge.control.request({requestId:randomUUID(), method, sessionId:directSession, profileId, params, ...extra});
  await direct('claim', {tabId:task.nativeTarget.tabId, controller:'Regression', task:'Common file selection'});
  const owner = (await direct('status')).sessions.find(s=>s.sessionId===directSession);
  assert.equal(owner.controller, 'Regression');
  await assert.rejects(direct('claim', {}, {sessionId:directSession+'-other'}), e=>e.code==='NATIVE_SESSION_CONFLICT' && e.recovery.nextStep==='wait-for-owner');
  let observed = await direct('observe');
  await direct('action', {kind:'fill',version:observed.version,ref:observed.fast.candidates.find(c=>c.label==='School').ref,value:'中文 "literal"'});
  await assert.rejects(direct('action', {kind:'fill',version:observed.version,ref:'e1',value:'must not replay'}), e=>e.code==='NATIVE_OBSERVATION_STALE');
  // Remove fixture-only dynamic mutations before the deliberately strict upload guard.
  await direct('cdp', {method:'Runtime.evaluate',params:{expression:'for(let i=1;i<1000;i++)clearInterval(i);document.querySelector("#ticker").remove()',returnByValue:true}});
  observed = await direct('observe');
  const upload = path.join(root, '文件 with spaces.txt'); await writeFile(upload, 'local acceptance fixture');
  await direct('action', {kind:'upload',version:observed.version,ref:observed.fast.candidates.find(c=>c.role==='fileupload').ref,files:[upload]});
  const selected = await direct('cdp', {method:'Runtime.evaluate',params:{expression:'document.querySelector("#upload").files[0].name',returnByValue:true}});
  assert.equal(selected.result.value, path.basename(upload));
  await direct('control', {action:'complete'});
  pass('Direct service reports task owner/conflict, accepts Chinese field/file paths, and rejects reused versions');
  task.nativeTarget = { tabId: tabs.find(t => t.url.endsWith('/conflict')).id };
  await assert.rejects(browser.observe(task), error => error.code === 'NATIVE_EXTENSION_FRAME_CONFLICT');
  assert.equal(bridge.states()[0].controlIssue.code, 'NATIVE_EXTENSION_FRAME_CONFLICT');
  await assert.rejects(browser.observe(task), error => error.code === 'NATIVE_EXTENSION_FRAME_CONFLICT');
  pass('Actual foreign-extension iframe is classified correctly; repeated reads do not claim user takeover');
  // Emulate the user dismissing this test-only frame via the fixture's own UI.
  dismiss = true; await until(() => dismissed, 'Fixture frame dismissal');
  await browser.control(task, 'resume');
  assert.equal(bridge.states()[0].controlIssue, undefined);
  assert.match((await browser.observe(task)).snapshot, /School/);
  pass('Explicit resume succeeds after the conflicting test frame is gone');
  await browser.control(task, 'handoff');
  assert.equal(bridge.states()[0].controlIssue, undefined);
  await assert.rejects(browser.observe(task), /用户正在/);
  pass('Real handoff continues to block input');
  await browser.control(task, 'complete');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform, extensionVersion: JSON.parse(await readFile('extensions/profilepilot/manifest.json','utf8')).version, checks,
    notVerified: ['macOS hardware', 'user default Profile extension update'], boundary: 'Chrome foreign-extension frame restriction is retained; no other extension is disabled or inspected.' }, null, 2));
} finally {
  await browser?.control(task, 'release').catch(() => {}); browser?.dispose(); bridge?.close();
  if (gateway && !bootstrapDone) await cli(['profilepilot', 'release']).catch(() => {});
  await gateway?.close(); await daemon?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (root.startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true }).catch(() => {});
}
