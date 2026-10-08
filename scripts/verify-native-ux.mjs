// Real Chrome extension UI + authenticated transport. TaskService/model responses are fixture data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
const require = createRequire(import.meta.url);
const { parseCliResult } = require('../dist/main/tasks/browser');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-ux-'));
const extension = path.join(root, 'extension');
const output = path.resolve('artifacts/herdr-native-20260926/ux-fixture');
const checks = [], commands = [];
let gateway, bridge, completed = false;
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>UX fixture current page</title><h1>当前页上下文</h1><p id="selection">这是选中文字。只在本地 fixture 使用。</p><input aria-label="测试输入">');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const session = 'pp-native-ux-' + randomUUID();
const wrapper = path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs');
const cli = async args => {
  try {
    const result = await promisify(execFile)(process.execPath, [wrapper, '--session', session, '--cdp', String(gateway.port), '--json', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024
    });
    return parseCliResult(result.stdout);
  } catch (error) {
    throw new Error(String(error.stderr || error.stdout || error.message).replace(/PP1\.[\w-]+/g, '[pairing code]'));
  }
};
const evaluate = async expression => (await cli(['eval', expression])).result;
const until = async (check, name, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(name);
};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  await mkdir(output, { recursive: true });
  // The shared source can change while another agent works. Freeze this run's
  // extension assets so recorded hashes describe exactly what Chrome loaded.
  await cp(path.resolve('extensions/profilepilot'), extension, { recursive: true });
  await build({ entryPoints: ['src/main/tasks/native-bridge.ts'], outfile: path.join(root, 'bridge.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require(path.join(root, 'bridge.cjs'));
  bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  let ui = { events: [], access: { allowedOrigins: [], blockedOrigins: [], confirmActions: false } };
  bridge.configureUi(async (profileId, method, params) => {
    assert.equal(profileId, 'native:Default');
    if (method !== 'getUiState') commands.push({ method, params });
    if (method === 'startTask') ui = { ...ui, task: { id: randomUUID(), title: params.prompt, status: 'running' },
      events: [{ kind: 'user', text: params.prompt }, { kind: 'assistant', text: '已收到当前页任务（fixture 回应）。' }] };
    if (method === 'taskMessage') ui.events.push({ kind: 'user', text: params.message });
    if (method === 'taskControl') ui.task.status = params.action === 'resume' ? 'running' : 'paused';
    if (method === 'taskReply') { ui.task.pending = undefined; ui.task.status = 'running'; }
    if (method === 'setAccess') ui.access = params;
    return structuredClone(ui);
  });
  gateway = await startTaskGatewayFixture();
  await cli(['open', url]);
  await cli(['profilepilot', 'extension', 'load-unpacked', extension]);
  await cli(['tab', 'new', 'chrome-extension://' + NATIVE_EXTENSION_ID + '/sidepanel.html']);
  const pairing = await bridge.pair('native:Default');
  const paired = await evaluate('(async () => {const code=' + JSON.stringify(pairing.code) + '; document.querySelector("#code").value=code; document.querySelector("#connect").requestSubmit(); return true;})()');
  assert.equal(paired, true);
  await until(() => bridge.states().some(s => s.connected), 'Extension pairing failed');
  await until(async () => await evaluate('!document.querySelector("#controls").hidden'), 'Connected UI was not displayed');
  pass('real Chrome sidepanel document pairs through authenticated bridge');

  // Make the local fixture the actual active tab without focusing the Chrome window.
  // Gateway keeps the agent attached to the extension document for UI inspection.
  const fixtureTab = await evaluate('(async () => { const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(' + JSON.stringify(url) + ')); await chrome.tabs.update(tab.id,{active:true}); return tab.id; })()');
  await until(async () => (await evaluate('document.querySelector("#page-title").textContent')).includes('UX fixture'), 'Current tab context missing');
  await evaluate('document.querySelector("#prompt").value="总结当前页"; document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#compose").requestSubmit(); true');
  await until(() => commands.some(c => c.method === 'startTask'), 'UI startTask not received');
  assert.equal(commands.find(c => c.method === 'startTask').params.tabId, fixtureTab);
  assert.ok(commands.find(c => c.method === 'startTask').params.requestId);
  await until(async () => (await evaluate('document.querySelector("#messages").textContent')).includes('fixture 回应'), 'Task events not rendered');
  pass('current-page submission uses the existing tab and renders backend event envelope');

  await evaluate('document.querySelector("#prompt").value="继续检查标题"; document.querySelector("#compose").requestSubmit(); true');
  await until(() => commands.some(c => c.method === 'taskMessage'), 'Follow-up not received');
  assert.equal(commands.find(c => c.method === 'taskMessage').params.taskId, ui.task.id);
  await evaluate('document.querySelector("#takeover").click(); true');
  await until(() => commands.some(c => c.method === 'taskControl' && c.params.action === 'stop'), 'Immediate stop missing');
  await until(async () => (await evaluate('document.querySelector("#task-status").textContent')).includes('已停止'), 'Stopped state not rendered');
  pass('same-task follow-up and immediate stop reach bridge and update status');

  await evaluate('document.querySelector("#new-task").click(); true');
  const selected = '这是选中文字。只在本地 fixture 使用。';
  await evaluate('(async()=>{await chrome.scripting.executeScript({target:{tabId:' + fixtureTab + '},func:()=>{const range=document.createRange();range.selectNodeContents(document.querySelector("#selection"));window.getSelection().removeAllRanges();window.getSelection().addRange(range);}});document.querySelector("#refresh-context").click();return true;})()');
  await until(async () => (await evaluate('document.querySelector("#selection").textContent')) === selected, 'Real page selection not read');
  pass('getPageContext reads actual selected text from the existing page');
  await evaluate('(async()=>{await chrome.storage.session.set({nativeTaskContext:{tabId:' + fixtureTab + ',title:"UX fixture current page",url:' + JSON.stringify(url) + ',selection:' + JSON.stringify(selected) + '}});return true;})()');
  await until(async () => (await evaluate('document.querySelector("#selection").textContent')) === selected, 'Selection context not rendered');
  await evaluate('document.querySelector("#prompt").value="解释选中文字"; document.querySelector("#compose").requestSubmit(); true');
  await until(() => commands.filter(c => c.method === 'startTask').length === 2, 'Selection task not received');
  assert.equal(commands.filter(c => c.method === 'startTask')[1].params.selection, selected);
  pass('right-click context storage contract populates selected text and task payload');

  await evaluate('document.querySelector("#blocked-origins").value="https://blocked.example"; document.querySelector("#allowed-origins").value=""; document.querySelector("#confirm-actions").checked=true; document.querySelector("#access-form").requestSubmit(); true');
  await until(() => commands.some(c => c.method === 'setAccess'), 'Access settings not received');
  const access = await evaluate('(async()=> (await chrome.storage.local.get("nativeAccess")).nativeAccess)()');
  assert.deepEqual(access.blockedOrigins, ['https://blocked.example']); assert.equal(access.confirmActions, true);
  pass('optional site denial and confirmation persist in the real extension after backend acknowledgment');

  ui.task.status = 'waiting_user'; ui.task.pending = { id: randomUUID(), kind: 'confirmation', title: '确认 fixture 操作', details: '仅用于验证侧边栏确认按钮。' };
  await until(async () => !(await evaluate('document.querySelector("#decision-controls").hidden')), 'Confirmation controls missing');
  await evaluate('document.querySelector("#deny").click(); true');
  await until(() => commands.some(c => c.method === 'taskReply'), 'Explicit reply missing');
  assert.equal(commands.find(c => c.method === 'taskReply').params.approved, false);
  pass('optional confirmation rejects through explicit taskReply');

  // Gateway deliberately preserves the real browser window's viewport. Constrain
  // only this disposable extension document's content column for a narrow UI check.
  const narrowLayout = await evaluate('(()=>{document.body.style.width="380px";document.body.style.maxWidth="380px";return {width:document.body.clientWidth,scrollWidth:document.body.scrollWidth};})()');
  assert.equal(narrowLayout.width, 380); assert.ok(narrowLayout.scrollWidth <= 380);
  await cli(['screenshot', path.join(output, 'sidepanel-document.png')]);
  pass('sidepanel content has no horizontal overflow in a verified 380 CSS-pixel column');
  await cli(['tab', 'new', 'chrome-extension://' + NATIVE_EXTENSION_ID + '/popup.html']);
  await until(async () => await evaluate('Boolean(document.querySelector("#open-side-panel"))'), 'Popup entry missing');
  await evaluate('document.querySelector("#open-side-panel").addEventListener("click",event=>{window.nativeUxClick={trusted:event.isTrusted,at:Date.now()};}); true');
  await cli(['click', '#open-side-panel']);
  try { await until(async () => (await evaluate('(async()=>await chrome.runtime.getContexts({contextTypes:["SIDE_PANEL"]}))()')).length > 0, 'Native Chrome side panel did not open'); }
  catch (error) {
    const diagnostic = await evaluate('(async()=>({click:window.nativeUxClick,error:document.querySelector("#error").textContent,contexts:await chrome.runtime.getContexts({}),active:(await chrome.tabs.query({active:true,lastFocusedWindow:true})).map(t=>({id:t.id,url:t.url}))}))()');
    await writeFile(path.join(output, 'sidepanel-open-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    throw new Error(error.message + ': ' + JSON.stringify(diagnostic));
  }
  pass('popup click opens a real Chrome SIDE_PANEL context');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const hashes = {};
  for (const file of ['popup.js', 'popup.css', 'sidepanel.html', 'background.js', 'manifest.json']) hashes[file] = createHash('sha256').update(await readFile(path.join(extension, file))).digest('hex');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', at: new Date().toISOString(), platform: process.platform, extensionVersion: manifest.version, checks, hashes,
    scope: 'Real Chrome extension document/runtime/authenticated transport; TaskService/model responses are fixture data.',
    references: ['https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts', 'https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open'],
    notVerified: ['physical context-menu click', 'real TaskService execution', 'macOS hardware', 'background/minimized pointer behavior (owned by chrome-dom)'] }, null, 2));
  await cli(['profilepilot', 'complete']); completed = true;
  console.log('Evidence: ' + path.join(output, 'result.json'));
} catch (error) {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', at: new Date().toISOString(), platform: process.platform, checks, error: error.message,
    scope: 'Real Chrome extension UI and authenticated transport; TaskService/model responses are fixture data.' }, null, 2));
  throw error;
} finally {
  bridge?.close();
  if (gateway && !completed) await cli(['profilepilot', 'release']).catch(() => {});
  await gateway?.close();
  await new Promise(resolve => server.close(resolve));
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
}
