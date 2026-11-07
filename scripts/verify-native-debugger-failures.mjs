// Exercise the Chrome security boundary in a disposable QA Profile. The second
// extension is a local fixture with no permissions or user data, never 1Password.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { BrowserGatewayDaemon } = require('../dist/main/browser-gateway-daemon');
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client');
const { getDirectChromeCommand } = require('../dist/main/chrome-launch');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-debugger-conflict-'));
const gatewayHome = path.join(root, 'gateway'); await mkdir(gatewayHome);
const output = path.resolve('artifacts/native-debugger-failures');
await mkdir(output, { recursive: true });
const foreign = path.join(root, 'foreign'); await mkdir(foreign);
await writeFile(path.join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local foreign-frame fixture', version: '1.0.0',
  web_accessible_resources: [{ resources: ['frame.html'], matches: ['http://127.0.0.1/*'] }] }));
await writeFile(path.join(foreign, 'frame.html'), '<!doctype html><title>Local extension fixture</title><p>Test extension frame</p>');
let foreignId, report = {}, submissions = 0;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  if (req.url.startsWith('/report?')) { report = JSON.parse(new URL(req.url, 'http://fixture').searchParams.get('value')); res.end('ok'); return; }
  if (pathname === '/submitted') submissions++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Debugger conflict fixture</title><body>
    <svg width="20" height="20"><path d="M0 0L20 20" stroke="black"/></svg><math><mi>x</mi></math>
    <label>School <input aria-label="School" role="combobox" aria-haspopup="listbox" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false"></label>
    <p id="options" hidden>School option opened</p>
    <label>Attachment<input id="upload" type="file" multiple></label>
    <input aria-label="Unrelated" id="unrelated"><span id="ticker"></span>
    <style>@keyframes pulse{from{opacity:1}to{opacity:.5}}#ticker{animation:pulse .2s infinite alternate}</style>
    <script>setInterval(()=>{document.querySelector('#ticker').textContent=Date.now();document.querySelector('#unrelated').value=Date.now()},40)</script>
    ${pathname === '/submitted' ? '<h1>Submission completed</h1>' : ''}
    ${pathname === '/conflict' ? `<form action="/submitted"><button>Submit once</button></form><iframe id="foreign" src="chrome-extension://${foreignId}/frame.html"></iframe>
    <iframe id="ordinary" srcdoc="<p>Ordinary site frame</p>"></iframe>
    <script>
      let shadow, edits = 0;
      window.addForeignOverlay = () => {
        const host = document.createElement('fixture-overlay'); shadow = host.attachShadow({mode:'closed'});
        const frame = document.createElement('iframe'); frame.src = 'chrome-extension://${foreignId}/frame.html';
        shadow.append(frame); document.body.append(host);
      };
      document.querySelector('input[aria-label="School"]').addEventListener('input', () => { edits++; window.addForeignOverlay(); });
      setInterval(()=>fetch('/report?value='+encodeURIComponent(JSON.stringify({foreign:!!document.querySelector('#foreign'),
        shadow:!!shadow?.querySelector('iframe'),ordinary:!!document.querySelector('#ordinary'),edits}))),100);
    </script>` : ''}
  </body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const profileId = 'native:DebuggerFixture', bootstrap = `debugger-bootstrap-${randomUUID()}`;
const task = { id: randomUUID(), sessionId: `debugger-qa-${randomUUID()}`, profileId, browserConnection: 'extension', status: 'running', attachments: [] };
const checks = [];
let gateway, bridge, browser, daemon, bootstrapDone = false;
const bootstrapIdentity = { sessionId: bootstrap, daemonInstanceId: randomUUID() };
let bootstrapTarget;
const gatewayRequest = async body => {
  const response = await requestBrowserGateway(body, { homeDir: gatewayHome, timeoutMs: 30000 });
  if (!response.ok) throw Object.assign(new Error(response.message || response.error_code), { code: response.error_code });
  return response;
};
// Bootstrap through the guarded Gateway API with an explicit storage root.
// No HOME overrides or independently launched browser engine are required.
const cli = async args => {
  const identity = { publicPort: gateway.port, ...bootstrapIdentity };
  if (args[0] === 'profilepilot' && ['complete', 'release'].includes(args[1])) {
    return gatewayRequest({ action: 'control', sessionId: bootstrap, command: 'complete' });
  }
  if (args[0] === 'profilepilot' && args[1] === 'extension') {
    const response = await gatewayRequest({ action: 'load-unpacked-extension', ...identity, extensionPath: args[3] });
    return { extension_id: response.result.id };
  }
  if (args[0] === 'open' || args[0] === 'tab') {
    const response = await gatewayRequest({ action: 'raw-cdp', ...identity, method: 'Target.createTarget',
      params: { url: args.at(-1), background: true } });
    bootstrapTarget = response.result.targetId; return response.result;
  }
  if (args[0] === 'eval') {
    const response = await gatewayRequest({ action: 'raw-cdp', ...identity, targetId: bootstrapTarget,
      method: 'Runtime.evaluate', params: { expression: Buffer.from(args[2], 'base64').toString('utf8'), awaitPromise: true, returnByValue: true } });
    assert.ok(!response.result.exceptionDetails, 'Bootstrap page evaluation failed');
    return { result: response.result.result.value };
  }
  throw Error('Unknown fixture bootstrap command');
};
const until = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(label);
};
const pass = name => { checks.push(name); console.log('PASS', name); };
try {
  daemon = new BrowserGatewayDaemon(gatewayHome); await daemon.start();
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  // Automation mode retains the pipe when Windows starts from an elevated
  // test runner; the retired AutoDeElevate feature flag no longer does so.
  await gatewayRequest({ action: 'launch-profile', profileId: 'debugger-fixture', profileName: 'Debugger conflict fixture', publicPort: port,
    executable: getDirectChromeCommand(), args: [`--user-data-dir=${path.join(root, 'chrome')}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--enable-automation', '--enable-unsafe-extension-debugging', 'about:blank'] });
  gateway = { port, close: () => gatewayRequest({ action: 'unregister-profile', publicPort: port, closeChrome: true }) };
  await gatewayRequest({ action: 'acquire', publicPort: port, ...bootstrapIdentity, driverKind: 'agent-browser', driverLabel: 'Isolated extension verification' });
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
  task.observation = await browser.observe(task);
  assert.match(task.observation.snapshot, /School/);
  await until(() => report.foreign === false && report.ordinary === true, 'Automatic frame suppression');
  assert.equal(bridge.states()[0].controlIssue, undefined);
  pass('Existing foreign-extension frame is suspended before attach; ordinary iframe remains');
  const school = task.observation.fast.candidates.find(c => c.label === 'School');
  try { await browser.execute(task, {kind:'fill',ref:school.ref,value:'one edit',effect:'edit',summary:'Trigger test-only extension overlay'}); }
  catch (error) { assert.equal(error.code, 'NATIVE_DEBUGGER_RECOVERED', error.message); }
  assert.match((await browser.observe(task)).snapshot, /School/);
  await until(() => report.edits === 1 && report.shadow === false, 'Closed shadow overlay suppression');
  assert.equal(bridge.states()[0].ownership, 'agent');
  pass('Typing creates a closed-shadow extension frame; connection recovers automatically without replaying input');
  await browser.control(task, 'handoff');
  await until(() => report.foreign === true && report.shadow === true, 'Restore extension frames on handoff');
  assert.equal(bridge.states()[0].controlIssue, undefined);
  await assert.rejects(browser.observe(task), /用户正在/);
  pass('Handoff restores both overlays and continues to block agent input');
  await browser.control(task, 'resume');
  assert.match((await browser.observe(task)).snapshot, /School/);
  await until(() => report.foreign === false && report.shadow === false, 'Resume suppresses restored overlays');
  assert.equal(report.edits, 1);
  pass('Explicit return suppresses restored overlays again without repeating the edit');
  await browser.control(task, 'complete');
  await until(() => report.foreign === true && report.shadow === true, 'Restore extension frames on completion');
  // Reclaim explicitly for a separate navigation: the old guard's pagehide
  // restores suspended frames while Chrome replaces the document. A new page
  // has no lastRemovedAt evidence and must still remain controllable.
  task.id = randomUUID(); task.sessionId = `navigation-qa-${randomUUID()}`;
  await browser.request(task, 'cdp', {method:'Runtime.evaluate',params:{expression:'for(let i=1;i<1000;i++)clearInterval(i);document.querySelector("#ticker").remove()',returnByValue:true}});
  task.observation = await browser.observe(task);
  const submit = task.observation.fast.candidates.find(c => c.label === 'Submit once');
  assert.ok(submit);
  try { await browser.execute(task, {kind:'click',ref:submit.ref,effect:'submit',summary:'Submit local fixture once'}); }
  catch (error) { assert.equal(error.code, 'NATIVE_DEBUGGER_RECOVERED', error.message); }
  await until(async () => {
    try { task.observation = await browser.observe(task); return task.observation.snapshot.includes('Submission completed'); }
    catch (error) { if (error.code === 'NATIVE_DEBUGGER_RECOVERED') return false; throw error; }
  }, 'Observe new document after submit');
  assert.equal(submissions, 1, 'Navigation submission is never replayed');
  assert.equal(bridge.states()[0].ownership, 'agent');
  const navigationDiagnostic = bridge.states()[0].debuggerDiagnostic;
  await browser.control(task, 'complete');
  pass('Real Chrome navigates away from suspended extension frames and reads the new document without replaying submission');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform, extensionVersion: JSON.parse(await readFile('extensions/profilepilot/manifest.json','utf8')).version, checks,
    navigationDiagnostic,
    notVerified: ['macOS hardware', 'user default Profile extension update'], boundary: 'Chrome foreign-extension frame restriction is retained; no other extension is disabled or inspected.' }, null, 2));
} finally {
  await browser?.control(task, 'release').catch(() => {}); browser?.dispose(); bridge?.close();
  if (gateway && !bootstrapDone) await cli(['profilepilot', 'release']).catch(() => {});
  await gateway?.close(); await daemon?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (root.startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true }).catch(() => {});
}
