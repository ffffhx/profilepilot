// Real Chrome integration test. Owns a fresh disposable directory and a headless
// process; never opens, copies, or changes the user's daily Chrome data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { getDirectChromeCommand } = require('../dist/main/chrome-launch');
const { CdpBrowserClient } = require('../dist/main/cdp-client');
const { NativeExtensionInstaller, parseNativeDebugEndpoint } = require('../dist/main/tasks/native-installer');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { NativePreviewStream } = require('../dist/main/tasks/native-preview');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-install-real-'));
const chromeData = path.join(root, 'chrome'); await mkdir(chromeData);
let saved = {}; let child; let client; let stream;
const vault = { read: () => saved, write: value => { saved = value; } };
let bridge = new NativeBrowserBridge(root, vault);
if (process.env.PP_INSTALL_TRACE) bridge.server.on('request', (req, res) => { if (req.url?.endsWith('/pair')) res.on('finish', () => console.log('Pair endpoint', { origin: req.headers.origin, status: res.statusCode })); });
const fixture = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><title>ProfilePilot installation test</title><h1>Installation acceptance fixture</h1><button>Fixture button</button><a href="/child" target="_blank">Open child</a>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
const until = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(label);
};
async function requestInstallation(url) {
  bridge.beginInstallation(url);
  await until(() => bridge.installationStates().some(s => s.stage === 'failed'), 'Installation choice did not appear');
  const response = await fetch(url + '/retry', { method: 'POST', headers: { Origin: new URL(url).origin, 'X-ProfilePilot-Onboarding': '1' } });
  assert.equal(response.status, 200);
}
try {
  const configureInstaller = () => bridge.configureInstallation(new NativeExtensionInstaller({ source: path.resolve('extensions/profilepilot'), destination: path.join(root, 'extension'), userDataDir: chromeData, extensionId: NATIVE_EXTENSION_ID, openSettings: async () => { throw new Error('A test must not request native user authorization'); } }), () => {});
  configureInstaller();
  const invitation = await bridge.authorize('native:Default', 'Disposable installation test');
  const displayArgs = process.env.PP_NATIVE_MINIMIZED === '1' ? [] : ['--headless=new'];
  child = spawn(getDirectChromeCommand(), [`--user-data-dir=${chromeData}`, ...displayArgs, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', invitation.url], { windowsHide: true, stdio: 'ignore' });
  const endpoint = await until(async () => { try { return parseNativeDebugEndpoint(await readFile(path.join(chromeData, 'DevToolsActivePort'), 'utf8')); } catch { return undefined; } }, 'Disposable Chrome did not start');
  client = await CdpBrowserClient.connect(endpoint, 5000);
  const version = await client.send('Browser.getVersion');
  await client.send('Target.createTarget', { url: fixtureUrl, background: true }); client.close(); client = undefined;
  await requestInstallation(invitation.url);
  await until(() => {
    const state = bridge.installationStates()[0];
    if (state?.stage === 'failed') throw new Error(state.message);
    return state?.stage === 'confirm-tab';
  }, 'Extension installation did not finish');
  client = await CdpBrowserClient.connect(endpoint, 5000);
  let popup;
  try { popup = await until(async () => (await client.send('Target.getTargets')).targetInfos.find(t => t.url.startsWith(`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html#setup=`)), 'Extension did not automatically open its authorization page'); }
  catch (error) {
    if (process.env.PP_INSTALL_TRACE) {
      console.log('Install state', bridge.installationStates());
      const targets = (await client.send('Target.getTargets')).targetInfos;
      console.log('Targets', targets.map(t => ({ type: t.type, url: t.url.replace(/[a-f0-9]{48}/g, '<ticket>') })));
      const page = targets.find(t => t.url === invitation.url);
      if (page) {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        console.log('Invitation text', (await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, 5000, sessionId)).result.value);
      }
    }
    throw error;
  }
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await until(async () => {
    const result = await client.send('Runtime.evaluate', { expression: '!!document.querySelector("#tab option")', returnByValue: true }, 5000, sessionId);
    return result.result.value;
  }, 'Authorization page did not initialize');
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, 5000, sessionId);
  await mkdir('test-results/browser-tasks', { recursive: true });
  await writeFile('test-results/browser-tasks/native-install-real.png', Buffer.from(screenshot.data, 'base64'));
  const submit = await client.send('Runtime.evaluate', { expression: `(()=>{const select=document.querySelector('#tab');const option=[...select.options].find(o=>o.textContent==='ProfilePilot installation test');if(!option)throw Error('Fixture tab missing');select.value=option.value;document.querySelector('#connect').requestSubmit();return true})()`, returnByValue: true }, 5000, sessionId);
  assert.equal(submit.result.value, true);
  await until(() => bridge.states().some(s => s.connected && s.tabId), 'Extension did not pair after authorization');
  // A daily Chrome tab may have been unloaded by Memory Saver before pairing.
  // chrome.debugger.attach succeeds on it, but Runtime.evaluate then never replies.
  const discarded = await client.send('Runtime.evaluate', { expression: `chrome.tabs.discard(${bridge.states()[0].tabId}).then(t=>({discarded:t.discarded,tabId:t.id}))`, awaitPromise: true, returnByValue: true }, 5000, sessionId);
  assert.equal(discarded.result.value?.discarded, true, JSON.stringify(discarded));
  assert.equal(discarded.result.value.error, undefined);
  await until(() => bridge.states()[0].tabId === discarded.result.value.tabId, 'Discarded tab selection did not synchronize');
  if (process.env.PP_NATIVE_MINIMIZED === '1') {
    await client.send('Runtime.evaluate', { expression: `chrome.tabs.get(${bridge.states()[0].tabId}).then(t=>chrome.windows.update(t.windowId,{state:'minimized'}))`, awaitPromise: true, returnByValue: true }, 5000, sessionId);
  }
  client.close(); client = undefined;
  const browser = new NativeBrowser(bridge, root);
  const task = { id: 'install-acceptance', sessionId: 'install-acceptance', profileId: 'native:Default', status: 'running' };
  let previewFrames = 0;
  stream = new NativePreviewStream(bridge, () => task, update => {
    if (update.frame) { previewFrames++; queueMicrotask(() => stream.ack(update.frameId)); }
  });
  stream.start();
  const observation = await browser.observe(task);
  assert.match(observation.snapshot, /Installation acceptance fixture/);
  if (process.env.PP_NATIVE_MINIMIZED !== '1') await until(() => previewFrames > 0, 'Native preview did not produce a frame');
  for (let i = 0; i < 5; i++) assert.match((await browser.observe(task)).snapshot, /Installation acceptance fixture/);
  console.log('PASS Memory Saver: authorized tab replacement, automatic restore and repeated observation; preview frames:', previewFrames);
  stream.close(); stream = undefined;
  await browser.control(task, 'complete');
  // Reuse the same installed extension and selected Profile across task owners.
  // Check handoff, child-tab scope and release rather than only first pairing.
  for (let round = 1; round <= 5; round++) {
    const next = { ...task, id: `reuse-${round}`, sessionId: `reuse-${round}` };
    next.observation = await browser.observe(next, process.env.PP_NATIVE_MINIMIZED !== '1', false);
    assert.match(next.observation.snapshot, /Installation acceptance fixture/);
    const startTab = (await browser.tabs(next)).find(t => t.current).id;
    const link = next.observation.fast.candidates.find(c => c.label === 'Open child');
    assert.ok(link, 'Child link must be observed');
    if (process.env.PP_NATIVE_MINIMIZED === '1') {
      await assert.rejects(browser.execute(next, { kind: 'click', effect: 'read', ref: link.ref, version: next.observation.version, summary: 'Minimized fixture click must stop' }), /最小化/);
      await browser.control(next, 'complete');
      console.log(`PASS minimized native Profile reuse ${round}/5: DOM reads work, pointer explicitly blocked without screenshot wait`);
      continue;
    }
    await browser.execute(next, { kind: 'click', effect: 'read', ref: link.ref, version: next.observation.version, summary: 'Open fixture child' });
    const childTab = await until(async () => (await browser.tabs(next)).find(t => t.id !== startTab), 'Child tab was not authorized');
    await browser.execute(next, { kind: 'switch_tab', value: childTab.id, effect: 'read', summary: 'Read fixture child' });
    assert.match((await browser.observe(next)).url, /\/child$/);
    await browser.control(next, 'handoff');
    await assert.rejects(browser.observe(next), /用户正在操作/);
    await browser.control(next, 'resume');
    await browser.execute(next, { kind: 'close_tab', value: childTab.id, effect: 'read', summary: 'Close fixture child' });
    await until(() => bridge.states()[0]?.tabId === Number(startTab), 'Closing child must restore authorized parent');
    assert.match((await browser.observe(next)).snapshot, /Installation acceptance fixture/);
    await browser.control(next, 'complete');
    assert.equal(bridge.states()[0].ownerSessionId, undefined);
    console.log(`PASS native Profile reuse ${round}/5: screenshot, child tab, handoff/resume, close and next owner`);
  }
  assert.equal(bridge.installationStates()[0].stage, 'connected');
  assert.ok(saved['native:Default']);
  console.log(`PASS real ${version.product}: unpacked install, automatic invitation handoff, user tab selection, paired extension observation and release`);
  // Chrome 153 intentionally removes CDP installations on restart. Verify the
  // next onboarding actually repairs this, instead of waiting for a gone worker.
  client = await CdpBrowserClient.connect(endpoint, 5000);
  const exited = new Promise(resolve => child.once('exit', resolve));
  await client.send('Browser.close', {}, 5000).catch(() => {}); client.close(); client = undefined;
  await exited;
  const listenerClosed = new Promise(resolve => bridge.server.once('close', resolve)); bridge.close(); await listenerClosed;
  bridge = new NativeBrowserBridge(root, vault); await bridge.start();
  configureInstaller();
  await rm(path.join(chromeData, 'DevToolsActivePort'), { force: true });
  child = spawn(getDirectChromeCommand(), [`--user-data-dir=${chromeData}`, ...displayArgs, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', fixtureUrl], { windowsHide: true, stdio: 'ignore' });
  const nextEndpoint = await until(async () => { try { return parseNativeDebugEndpoint(await readFile(path.join(chromeData, 'DevToolsActivePort'), 'utf8')); } catch { return undefined; } }, 'Restarted Chrome did not start');
  client = await CdpBrowserClient.connect(nextEndpoint, 5000);
  assert.equal((await client.send('Extensions.getExtensions')).extensions.some(e => e.id === NATIVE_EXTENSION_ID), false);
  assert.equal(bridge.states()[0].tabId, undefined);
  const recovery = await bridge.authorize('native:Default', 'Disposable recovery test');
  await client.send('Target.createTarget', { url: recovery.url }); client.close(); client = undefined;
  await requestInstallation(recovery.url);
  await until(() => { const state = bridge.installationStates()[0]; if (state?.stage === 'failed') throw new Error(state.message); return state?.stage === 'confirm-tab'; }, 'Reinstallation after restart failed');
  client = await CdpBrowserClient.connect(nextEndpoint, 5000);
  const recoveredPopup = await until(async () => (await client.send('Target.getTargets')).targetInfos.find(t => t.url.startsWith(`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html#setup=`)), 'Reinstalled extension did not prepare pairing');
  const recoveredSession = (await client.send('Target.attachToTarget', { targetId: recoveredPopup.targetId, flatten: true })).sessionId;
  await until(async () => (await client.send('Runtime.evaluate', { expression: '!!document.querySelector("#tab option")', returnByValue: true }, 5000, recoveredSession)).result.value, 'Recovery authorization page did not initialize');
  await client.send('Runtime.evaluate', { expression: 'document.querySelector("#connect").requestSubmit()', returnByValue: true }, 5000, recoveredSession);
  await until(() => bridge.states().some(s => s.connected && s.tabId), 'Reinstalled extension did not connect');
  assert.equal(bridge.states()[0].ownerSessionId, undefined);
  console.log('PASS Chrome and app restart: missing CDP extension automatically reinstalls on reconnect, pairs and requires fresh tab authorization');
  await writeFile(`test-results/browser-tasks/native-install-real${process.env.PP_NATIVE_MINIMIZED === '1' ? '-minimized' : ''}.json`, JSON.stringify({ browser: version.product, profile: 'disposable', installed: true, automaticPairing: true, discardedTabRecovery: true, livePreview: previewFrames > 0, reuseRounds: 5, minimizedPointerBlocked: process.env.PP_NATIVE_MINIMIZED === '1', observation: true, released: true, chromeRestartReinstall: true, appRestart: true }, null, 2));
} finally {
  stream?.close(); client?.close(); bridge.close(); fixture.close(); fixture.closeAllConnections();
  if (child && child.exitCode === null) { child.kill(); await new Promise(r => { child.once('exit', r); setTimeout(r, 2000).unref(); }); }
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
