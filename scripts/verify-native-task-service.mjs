// Real TaskService + NativeBrowser + shipped Chrome extension. Only the model
// worker is controlled, so this proves tool execution, not model intelligence.
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';

const require = createRequire(import.meta.url);
const build = path.resolve(process.env.PP_NATIVE_TASK_BUILD || 'dist');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require(path.join(build, 'main/tasks/native-bridge'));
const { NativeBrowser } = require(path.join(build, 'main/tasks/native-browser'));
const { TaskStore } = require(path.join(build, 'main/tasks/store'));
const { TaskService } = require(path.join(build, 'main/tasks/service'));
const { executeNativeUiCommand } = require(path.join(build, 'main/tasks/management'));
const { parseCliResult } = require(path.join(build, 'main/tasks/browser'));
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-service-'));
const output = path.resolve('artifacts/herdr-native-20260926/task-service-evidence');
await mkdir(output, { recursive: true });
const checks = [], hits = [], downloads = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const until = async (check, label, timeoutMs = 20000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(label);
};
class ControlledWorker extends EventEmitter {
  connected = true; exitCode = null; signalCode = null; pending = new Map(); started = false;
  send(message) {
    if (message.kind === 'start') { this.started = true; return; }
    if (message.kind === 'tool_result') { this.pending.get(message.id)?.(message.result); this.pending.delete(message.id); }
    if (message.kind === 'stop') queueMicrotask(() => this.finish());
  }
  tool(name, args = {}) {
    assert.equal(this.connected, true, 'controlled model must be running');
    return new Promise(resolve => {
      const id = randomUUID(); this.pending.set(id, resolve);
      this.emit('message', { kind: 'tool', id, name, args });
    });
  }
  finish() {
    if (!this.connected) return;
    this.connected = false; this.exitCode = 0;
    this.emit('exit', 0);
  }
  kill() { this.finish(); return true; }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/hit') { hits.push(Object.fromEntries(url.searchParams)); res.end('ok'); return; }
  if (url.pathname === '/download') {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="profilepilot-service-fixture.csv"' });
    res.end('name,value\nservice,verified\n'); return;
  }
  const child = url.pathname === '/frame';
  const form = `<form onsubmit="event.preventDefault();document.querySelector('#receipt').textContent='SERVICE_SAVED';fetch('/hit?first='+encodeURIComponent(this.first.value)+'&second='+encodeURIComponent(this.second.value))"><label>First name<input name="first"></label><label>Second name<input name="second"></label><button>Save fixture</button></form><p id="receipt">Awaiting fixture</p>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><title>Task service ${child ? 'frame' : 'root'}</title><style>body{font:16px sans-serif}input,button{padding:8px;margin:5px}iframe{width:700px;height:220px}</style><h1>Task service fixture</h1>${child ? form : '<iframe title="Service form" src="/frame"></iframe><a href="/download" download>Service download</a>' + Array.from({ length: 150 }, (_, i) => `<button>Service control ${i}</button>`).join('')}`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
const profileId = 'native:service-fixture', bootstrap = 'service-bootstrap-' + randomUUID();
let gateway, bridge, browser, service, bootstrapReleased = false;
const workers = [];
const wrapper = path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs');
const bootstrapCli = async args => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [wrapper, '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024
    });
    return parseCliResult(stdout);
  } catch (error) { throw new Error(String(error.stderr || error.stdout || error.message).replace(/PP1\.[\w-]+/g, '[pairing code]')); }
};
const decoded = result => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const text = result.content?.find(c => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
};
try {
  gateway = await startTaskGatewayFixture();
  bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  browser = new NativeBrowser(bridge, path.join(root, 'artifacts'));
  const controls = [], control = browser.control.bind(browser);
  browser.control = async (task, action) => { controls.push({ taskId: task.id, action }); return control(task, action); };
  const store = new TaskStore(path.join(root, 'tasks'));
  service = new TaskService(store, {
    browser, apiKey: () => 'controlled-worker-no-network',
    profileName: async id => { assert.equal(id, profileId); return 'Service fixture'; },
    prepareProfile: async id => { assert.equal(id, profileId); return { name: 'Service fixture', browserConnection: 'extension' }; },
    changed: () => {}, notify: () => {},
    worker: () => { const worker = new ControlledWorker(); workers.push(worker); return worker; }
  });
  bridge.configureUi((id, method, params) => executeNativeUiCommand(id, method, params, service));
  await bootstrapCli(['open', url]);
  await bootstrapCli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await bootstrapCli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair = await bridge.pair(profileId);
  const connected = await bootstrapCli(['eval', `(async()=>{const t=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(url)}));const response=await chrome.runtime.sendMessage({method:'connect',code:${JSON.stringify(pair.code)}});if(response.error)throw Error(response.error);await chrome.tabs.update(t.id,{active:true});return t.id;})()`]);
  const tabId = connected.result;
  assert.ok(Number.isInteger(tabId));
  await until(() => bridge.states().some(s => s.connected), 'Extension did not connect');
  await bootstrapCli(['profilepilot', 'complete']); bootstrapReleased = true;
  pass('isolated Chrome paired; Gateway bootstrap released before native task');

  const ui = (method, params = {}) => executeNativeUiCommand(profileId, method, params, service);
  const answerState = await ui('startTask', { requestId: randomUUID(), prompt: 'Answer only; do not use the browser', tabId });
  const answerTask = store.get(answerState.task.id);
  await until(() => workers[0]?.started, 'Answer worker did not start');
  decoded(await workers[0].tool('finish', { status: 'completed', responseOnly: true, summary: 'Controlled answer verified', evidence: [], remaining: [] }));
  workers[0].finish();
  await until(() => !service.runs.has(answerTask.id), 'Answer worker did not drain');
  assert.equal(answerTask.status, 'completed'); assert.equal(answerTask.result.kind, 'answer');
  assert.equal(controls.length, 0, 'An answer without browser I/O must not release an unclaimed session');
  assert.equal(answerTask.events.some(event => event.kind === 'error'), false);
  pass('controlled answer finishes without releasing an unclaimed browser session or emitting a false error');

  const requestId = randomUUID();
  const input = { requestId, prompt: 'Fill the embedded form and verify the fixture', selection: 'Selected fixture context', tabId };
  const created = await ui('startTask', input);
  const task = store.get(created.task.id);
  const repeat = await ui('startTask', input);
  assert.equal(repeat.task.id, task.id); assert.equal(store.data.tasks.length, 2);
  assert.equal(task.nativeTarget.tabId, tabId); assert.match(task.prompt, /Selected fixture context/);
  await until(() => workers[1]?.started, 'TaskService did not start controlled worker');
  const worker = workers[1];
  pass('real TaskService task creation preserves existing tab, selection and request idempotency');

  const initial = decoded(await worker.tool('read_page', {}));
  const frame = initial.frames.find(f => f.url.endsWith('/frame')); assert.ok(frame);
  let observation = decoded(await worker.tool('read_page', { frameId: frame.id }));
  const ref = name => observation.fast.candidates.find(c => c.label === name)?.ref;
  const first = ref('First name'), second = ref('Second name'); assert.ok(first && second);
  const filled = decoded(await worker.tool('fill_fields', { version: observation.version, fields: [{ ref: first, value: 'Alice' }, { ref: second, value: 'Agent' }] }));
  if (filled.filled !== 2) await writeFile(path.join(output, 'fill-failure.json'), JSON.stringify({ before: observation, after: task.observation, filled }, null, 2));
  assert.equal(filled.filled, 2, JSON.stringify(filled));
  assert.equal(task.pending, undefined);
  observation = decoded(await worker.tool('observe', {}));
  assert.equal(observation.page.frameId, frame.id);
  assert.match(observation.snapshot, /Alice/); assert.match(observation.snapshot, /Agent/);
  pass('service read_page -> iframe fill_fields -> observe retains frame across both real edits');
  const save = ref('Save fixture'); assert.ok(save);
  decoded(await worker.tool('browser_action', { kind: 'click', ref: save, version: observation.version, effect: 'submit', summary: 'Submit local fixture' }));
  await until(() => hits.some(h => h.first === 'Alice' && h.second === 'Agent'), 'Real form submission never arrived');
  assert.equal(task.pending, undefined);
  observation = decoded(await worker.tool('observe', {})); assert.match(observation.snapshot, /SERVICE_SAVED/);
  pass('default browser access executes submit through real TaskService and checks server receipt');

  observation = decoded(await worker.tool('read_page', { query: 'Service control 149' }));
  assert.ok(observation.fast.candidates.some(c => c.label === 'Service control 149'));
  decoded(await worker.tool('browser_action', { kind: 'click', ref: ref('Service control 149'), version: observation.version, effect: 'read', summary: 'Click last long-page control' }));
  pass('service action revalidation preserves searched controls beyond the old page limit');

  observation = decoded(await worker.tool('read_page', { query: 'Service download' }));
  decoded(await worker.tool('browser_action', { kind: 'download', ref: ref('Service download'), version: observation.version, effect: 'edit', summary: 'Download local fixture' }));
  assert.ok(task.attachments.length || task.outputs.length);
  const file = [...task.attachments, ...task.outputs].find(f => f.name?.endsWith('.csv'));
  assert.ok(file); assert.match(await readFile(file.path, 'utf8'), /service,verified/);
  const original = await bridge.request(profileId, 'downloads.search', { sessionId: task.sessionId });
  for (const item of original) if (path.basename(item.filename || '').startsWith('profilepilot-service-fixture')) downloads.push(item.filename);
  pass('task download registers a real completed readable CSV artifact');

  await ui('setAccess', { requestId: randomUUID(), blockedOrigins: [url] });
  const blocked = await worker.tool('observe', {}); assert.equal(blocked.isError, true);
  await ui('setAccess', { requestId: randomUUID(), blockedOrigins: [] });
  decoded(await worker.tool('read_page', { frameId: frame.id }));
  const screenshot = await bridge.request(profileId, 'cdp', { sessionId: task.sessionId, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } });
  await writeFile(path.join(output, 'service-result.png'), Buffer.from(screenshot.data, 'base64'));
  await ui('taskControl', { taskId: task.id, action: 'stop', requestId: randomUUID() });
  await until(() => !service.runs.has(task.id), 'Stopped worker did not drain');
  assert.equal(task.status, 'paused');
  assert.equal(bridge.states().find(s => s.profileId === profileId).ownership, 'user');
  const stopped = await ui('getUiState', { taskId: task.id }); assert.equal(stopped.task.status, 'paused');
  pass('optional site policy is enforced in service; stop reaches worker and browser ownership');

  await writeFile(path.join(output, 'result.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, build, checks, model: 'controlled worker; no model request', macOS: process.platform === 'darwin' ? 'tested' : 'not tested' }, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), checks, error: String(error.stack || error) }, null, 2));
  throw error;
} finally {
  await service?.close(); browser?.dispose(); bridge?.close();
  if (gateway && !bootstrapReleased) await bootstrapCli(['profilepilot', 'release']).catch(() => {});
  await gateway?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  for (const filename of downloads) await rm(filename, { force: true }).catch(() => {});
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true }).catch(() => {});
}
