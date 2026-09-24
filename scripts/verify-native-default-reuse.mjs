// Explicit opt-in acceptance on the user's actual Default Profile. Browser work
// uses NativeBrowser/TaskService. Installer CDP only prepares the extension UI.
// Preserve the original paused task, pairing and selected tab; never navigate it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfiguredTaskProvider } from './task-provider-fixture.mjs';
assert.ok(process.argv.includes('--authorized-default-profile'), 'Explicit authorization for the real Default Profile is required');
const require = createRequire(import.meta.url);
const { CdpBrowserClient } = require('../dist/main/cdp-client');
const { nativeChromeUserDataDir } = require('../dist/main/chrome-launch');
const { parseNativeDebugEndpoint, prepareNativeExtension } = require('../dist/main/tasks/native-installer');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const transportOnly = process.argv.includes('--transport-only');
const provider = transportOnly ? { settings: {}, apiKey: '', jevApiKey: '' } : await loadConfiguredTaskProvider({ includeJev: true });
const output = path.resolve(process.env.PP_DOGFOOD_OUTPUT || `test-results/native-default-${Date.now()}`);
await mkdir(output, { recursive: true });
const redact = text => [provider.apiKey, provider.jevApiKey].reduce((s, key) => key ? s.replaceAll(key, '[REDACTED]') : s, text);
const requests = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method, url: req.url });
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  const page = new URL(req.url, 'http://localhost').searchParams.get('page') === '2' ? 2 : 1;
  res.end(`<!doctype html><title>ProfilePilot 专用测试页</title><style>body{font:22px system-ui;margin:70px}a{padding:20px;display:block}</style><h1>虚构验收数据 · 第 ${page}/2 页</h1><p>编号：NATIVE-${page === 1 ? '101' : '102'}</p><p>岗位：${page === 1 ? '前端工程师' : '数据分析师'}</p><p>状态：${page === 1 ? '面试中' : '已投递'}</p><a href="/?page=${page === 1 ? 2 : 1}">${page === 1 ? '下一页' : '上一页'}</a>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
let client, popupSession, original, bridge, service, activeTask;
const ownedTargets = [], results = [];
const wait = async (fn, label, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 150)); } throw Error(label); };
const evaluate = async (session, expression) => {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 10000, session);
  if (result.exceptionDetails) throw Error('Extension setup operation failed');
  return result.result.value;
};
const popupRequest = async (method, params = {}) => {
  const response = await evaluate(popupSession, `chrome.runtime.sendMessage(${JSON.stringify({ method, ...params })})`);
  if (response?.error) throw Error(response.error);
  return response?.result;
};
const createTarget = async targetUrl => { const { targetId } = await client.send('Target.createTarget', { url: targetUrl, background: true }); ownedTargets.push(targetId); return targetId; };
const openPopup = async () => {
  const popup = await createTarget(`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`);
  popupSession = (await client.send('Target.attachToTarget', { targetId: popup, flatten: true })).sessionId;
  await wait(() => evaluate(popupSession, 'typeof chrome?.tabs?.query === "function"'), 'Installed extension popup is unavailable');
};
try {
  console.log('DEFAULT_QA waiting for Chrome remote-debugging authorization');
  client = await CdpBrowserClient.connect(parseNativeDebugEndpoint(await readFile(path.join(nativeChromeUserDataDir(), 'DevToolsActivePort'), 'utf8')), 300000);
  const verification = await createTarget('chrome://version/');
  const versionSession = (await client.send('Target.attachToTarget', { targetId: verification, flatten: true })).sessionId;
  const actualPath = await wait(() => evaluate(versionSession, 'document.querySelector("#profile_path")?.textContent?.trim()'), 'Cannot verify Chrome Profile');
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  assert.equal(normalize(actualPath), normalize(path.join(nativeChromeUserDataDir(), 'Default')), 'Must use the real Default Profile');
  await client.send('Target.closeTarget', { targetId: verification });
  await openPopup();
  const state = await popupRequest('state');
  assert.notEqual(state.ownership, 'agent', 'Never interrupt a running task or steal its Profile');
  // Pairing material stays in process memory and is restored in finally.
  original = { state, config: (await evaluate(popupSession, 'chrome.storage.local.get("connection")')).connection };
  assert.ok(original.config && state.tabId, 'An existing authorized tab is required for reversible restoration');
  // Keep the rollback record in the extension's own storage, where its pairing
  // credentials already reside. Remove it only after successful restoration.
  await evaluate(popupSession, `chrome.storage.local.set({profilepilotQARollback:${JSON.stringify(original)}})`);
  await popupRequest('disconnect');
  const extensionPath = await prepareNativeExtension(path.resolve('extensions/profilepilot'), path.join(process.env.APPDATA, 'ProfilePilot/browser-tasks/native-extension'), NATIVE_EXTENSION_ID);
  const installed = (await client.send('Extensions.getExtensions')).extensions.find(e => e.id === NATIVE_EXTENSION_ID);
  if (installed?.path !== extensionPath) {
    await client.send('Extensions.loadUnpacked', { path: extensionPath }, 30000);
    // Reload destroys the old target/session, not merely its JS context.
    await openPopup();
  }
  const fixtureTarget = await createTarget(url);
  const fixtureTab = await wait(() => evaluate(popupSession, `chrome.tabs.query({}).then(t=>t.find(x=>x.url===${JSON.stringify(url)})?.id)`), 'Fixture tab was not created');
  let secrets = {};
  bridge = new NativeBrowserBridge(output, { read: () => secrets, write: value => { secrets = value; } });
  const pair = await bridge.pair('native:Default');
  await popupRequest('connect', { code: pair.code, tabId: fixtureTab });
  await wait(() => bridge.states().some(s => s.connected && s.tabId === fixtureTab), 'Native test pairing failed');
  const browser = new NativeBrowser(bridge, path.join(output, 'artifacts'));
  const store = new TaskStore(path.join(output, 'store'));
  store.data.settings = { ...store.data.settings, ...provider.settings, notifications: false };
  service = new TaskService(store, {
    browser, apiKey: () => provider.apiKey, jevApiKey: () => provider.jevApiKey,
    profileName: async () => '系统默认 Profile · 专用测试标签页',
    prepareProfile: async () => ({ name: '系统默认 Profile · 专用测试标签页', browserConnection: 'extension' }),
    changed: () => {}, notify: () => {},
  });
  bridge.onEvent(event => { if (event.state?.ownerSessionId && event.type === 'state') service.externalControl(event.state.ownerSessionId, event.state.ownership, 'active', 'native-qa'); });
  if (transportOnly) service.tick = async () => {};
  for (let round = 1; round <= 3; round++) {
    const started = Date.now();
    activeTask = await service.create({ profileId: 'native:Default', prompt: `打开 ${url}，读取全部两页虚构数据，生成 native-${round}.csv，包含编号、岗位、状态、来源链接。只读，不访问其他网站。`, limits: { minutes: 4, actions: 20, budgetUsd: 1 } });
    console.log('DEFAULT_QA started', JSON.stringify({ round, id: activeTask.id, profileId: activeTask.profileId, output }));
    if (transportOnly) {
      activeTask.status = 'running'; activeTask.browserConnection = 'extension';
      const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 };
      service.runs.set(activeTask.id, run);
      const tool = async (name, args) => { const response = await service.handleTool(activeTask, run, name, args); assert.ok(!response.isError, JSON.stringify(response)); return response; };
      await tool('browser_action', { kind: 'open', value: url, effect: 'read', summary: 'Open dedicated fixture' });
      await tool('observe', { fast: true });
      assert.match(activeTask.observation.snapshot, /NATIVE-101/);
      const link = activeTask.observation.fast.candidates.find(c => c.label === '下一页');
      assert.ok(link);
      await tool('browser_action', { kind: 'click', ref: link.ref, version: activeTask.observation.version, effect: 'read', summary: 'Click next page; direct navigation is not a substitute' });
      await wait(async () => { await tool('observe', { fast: true }); return activeTask.observation.snapshot.includes('NATIVE-102'); }, 'Native click was acknowledged but did not navigate');
      await tool('export_result', { format: 'csv', name: `native-${round}`, columns: ['编号', '岗位', '状态', '来源链接'], rows: [['NATIVE-101', '前端工程师', '面试中', url], ['NATIVE-102', '数据分析师', '已投递', `${url}?page=2`]] });
      await tool('finish', { status: 'completed', summary: 'Deterministic real-browser transport acceptance; no model invoked', evidence: ['NATIVE-101', 'NATIVE-102'], remaining: [] });
      await service.endRun(activeTask, run);
    }
    await wait(() => !['queued', 'running'].includes(activeTask.status) && !service.runs.has(activeTask.id), 'Real-model task exceeded deadline', 260000);
    const csv = (await Promise.all((activeTask.outputs || []).map(f => readFile(f.path, 'utf8')))).join('\n');
    const passed = activeTask.status === 'completed' && ['NATIVE-101', 'NATIVE-102', '前端工程师', '数据分析师'].every(v => csv.includes(v));
    results.push({ round, passed, transportOnly, elapsedMs: Date.now() - started, task: activeTask });
    await writeFile(path.join(output, 'results.json'), redact(JSON.stringify(results, null, 2)));
    console.log('DEFAULT_QA result', JSON.stringify({ round, passed, status: activeTask.status, elapsedMs: Date.now() - started }));
    assert.ok(passed, `Default Profile round ${round} failed; inspect evidence before retrying`);
    assert.equal(bridge.states()[0].ownerSessionId, undefined, 'Finished task must release the Profile');
  }
  assert.ok(requests.every(r => r.method === 'GET'));
} finally {
  if (activeTask && !['completed', 'partial', 'failed', 'cancelled'].includes(activeTask.status)) await service?.control(activeTask.id, 'cancel').catch(() => {});
  await service?.close();
  if (client && original?.config && popupSession) {
    try {
      await openPopup();
      await popupRequest('disconnect');
      const code = `PP1.${Buffer.from(JSON.stringify(original.config)).toString('base64url')}`;
      await popupRequest('connect', { code, tabId: original.state.tabId });
      await wait(async () => (await popupRequest('state')).connected, 'Original app pairing did not reconnect');
      await evaluate(popupSession, 'chrome.storage.local.remove("profilepilotQARollback")');
      console.log('DEFAULT_QA restored original pairing and authorized tab; original task remains paused');
    } catch (error) { console.error('RESTORATION_REQUIRED', String(error.message)); process.exitCode = 1; }
  }
  bridge?.close();
  for (const targetId of ownedTargets) await client?.send('Target.closeTarget', { targetId }, 2000).catch(() => {});
  client?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
