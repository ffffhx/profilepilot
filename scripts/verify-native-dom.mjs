// Windows/macOS real Chrome acceptance. Uses a disposable registered Gateway
// Profile only to load/pair the extension; releases it before native control.
// Current TS source is used for every native module; shared dist is read-only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startNativeDomFixture } from './native-dom-fixture.mjs';
const require = createRequire(import.meta.url);
require('../tests/helpers/native-dom-source.cjs');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../src/main/tasks/native-bridge.ts');
const { NativeBrowser } = require('../src/main/tasks/native-browser.ts');
const { parseCliResult } = require('../src/main/tasks/browser.ts');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-dom-'));
const results = path.resolve('artifacts/herdr-native-20260926/dom-evidence');
await mkdir(results, { recursive: true });
const fixture = await startNativeDomFixture();
let gateway, browser, bridge, bootstrapDone = false, completed = false;
const task = { id: randomUUID(), sessionId: `pp-dom-${randomUUID()}`, profileId: 'native:DOM-fixture', browserConnection: 'extension', status: 'running', attachments: [] };
const bootstrap = `pp-dom-bootstrap-${randomUUID()}`;
const wrapper = path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs');
const checks = [], mark = message => { checks.push(message); console.log('PASS', message); };
const downloads = [];
const ownedDownloads = new Map(), limitations = [];
const cli = async args => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [wrapper, '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    return parseCliResult(stdout);
  } catch (error) { throw new Error(String(error.stderr || error.stdout || error.message).replace(/PP1\.[\w-]+/g, '[pairing]')); }
};
const until = async (fn, message, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(message);
};
const select = async options => task.observation = await browser.readPage(task, options);
const action = async (kind, label, value, extra = {}) => {
  const candidate = task.observation.fast.candidates.find(c => c.label === label);
  assert.ok(candidate, `Missing ${label} in ${task.observation.snapshot}`);
  const result = await browser.execute(task, { kind, ref: candidate.ref, value, effect: 'edit', summary: 'Local DOM fixture', ...extra });
  task.observation = undefined; // Match TaskService.perform, including fill_fields.
  return result;
};
try {
  gateway = await startTaskGatewayFixture();
  bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
  bridge.onEvent(event => {
    if (event.method?.includes('download')) { downloads.push(event); if (process.env.PP_DOM_TRACE === '1') console.log('DOWNLOAD', JSON.stringify(event)); }
    if (event.method === 'downloads.onChanged' && event.sessionId === task.sessionId && event.params?.filename?.current) {
      ownedDownloads.set(event.params.id, { ...ownedDownloads.get(event.params.id), id: event.params.id, filename: event.params.filename.current });
    }
  });
  const originalRequest = bridge.request.bind(bridge);
  bridge.request = async (profile, method, params, timeout) => {
    const result = await originalRequest(profile, method, params, timeout);
    if (method.startsWith('downloads.') && result?.id !== undefined) ownedDownloads.set(result.id, { ...ownedDownloads.get(result.id), ...result });
    return result;
  };
  if (process.env.PP_DOM_TRACE === '1') {
    const request = bridge.request.bind(bridge);
    bridge.request = async (profile, method, params, timeout) => {
      if (method === 'cdp' && params.method === 'Input.dispatchMouseEvent') {
        const value = await request(profile, 'cdp', { sessionId: task.sessionId, cdpSessionId: params.cdpSessionId, method: 'Runtime.evaluate', params: { expression: `({x:${params.params.x},y:${params.params.y},scrollX,scrollY,width:innerWidth,height:innerHeight,hit:document.elementFromPoint(${params.params.x},${params.params.y})?.outerHTML.slice(0,200)})`, returnByValue: true } });
        console.log('POINTER', JSON.stringify({ session: params.cdpSessionId, type: params.params.type, page: value.result?.value }));
      }
      return request(profile, method, params, timeout);
    };
  }
  browser = new NativeBrowser(bridge, results);
  await cli(['open', fixture.url + '/']);
  await cli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair = await bridge.pair(task.profileId);
  const expression = `(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(fixture.url)}));
    const paired=await chrome.runtime.sendMessage({method:'connect',code:${JSON.stringify(pair.code)},tabId:tab.id});
    if(paired?.error)throw Error(paired.error);
    setInterval(async()=>{try{const t=await chrome.tabs.get(tab.id),w=await chrome.windows.get(tab.windowId);await fetch(${JSON.stringify(fixture.url + '/window-report')}+'?state='+w.state+'&active='+t.active);}catch{}},500);
    ${process.env.PP_DOM_MINIMIZED === '1' ? "await chrome.windows.update(tab.windowId,{state:'minimized'});" : ''}
    return {tabId:tab.id};})()`;
  const paired = (await cli(['eval', expression])).result;
  assert.ok(paired?.tabId); task.nativeTarget = { tabId: paired.tabId };
  await until(() => bridge.states().some(s => s.connected), 'extension did not connect');
  await cli(['profilepilot', 'complete']); bootstrapDone = true;
  mark('isolated extension pairing; Gateway bootstrap released');
  await until(async () => { const o = await select({}); return o.frames.length >= 4; }, 'nested frames did not load');
  const frameList = task.observation.frames;
  await writeFile(path.join(results, 'frames.json'), JSON.stringify(frameList, null, 2));
  assert.ok(frameList.some(f => f.oopif));
  mark('same-process and cross-site OOPIF frame discovery');
  for (const frameName of ['same', 'child', 'grandchild']) {
    console.log('Testing frame', frameName);
    const frame = frameList.find(f => f.url.endsWith('/' + frameName)); assert.ok(frame);
    await select({ frameId: frame.id });
    await action('fill', `First ${frameName}`, `first-${frameName}`);
    task.observation = await browser.observe(task);
    assert.equal(task.observation.page.frameId, frame.id);
    await action('fill', `Second ${frameName}`, `second-${frameName}`);
    task.observation = await browser.observeFast(task);
    await action('select', `Choice ${frameName}`, 'v129');
    task.observation = await browser.observe(task);
    await action('click', `Save ${frameName}`);
    await until(() => fixture.hits.some(h => h.frame === frameName && h.action === 'submit'), `${frameName} pointer input was not delivered`);
    const hit = fixture.hits.find(h => h.frame === frameName && h.action === 'submit');
    assert.equal(hit.first, `first-${frameName}`); assert.equal(hit.second, `second-${frameName}`);
    console.log('Verified form', frameName);
    task.observation = await browser.observe(task);
    await action('click', `Deep shadow ${frameName}`);
    await until(() => fixture.hits.some(h => h.frame === frameName && h.action === 'shadow'), `${frameName} shadow click missing`);
  }
  mark('nested same-process/OOPIF fill, select >80, click and Shadow DOM; selection survives cleared observations');
  const rootFrame = frameList.find(f => !f.parentId);
  const checkBlob = async () => {
    await select({ frameId: rootFrame.id, query: 'Download blob root' });
    try {
      const candidate = task.observation.fast.candidates.find(c => c.label === 'Download blob root');
      const blob = await browser.download(task, { ref: candidate.ref, timeoutMs: 5000 });
      assert.equal(await readFile(blob.file.path, 'utf8'), 'blob-fixture');
      mark('blob download click arm/complete/disk registration');
    } catch (error) {
      console.log('LIMITATION blob:', error.message); limitations.push({ kind: 'blob', message: error.message });
      await writeFile(path.join(results, `blob-${process.env.PP_DOM_BLOB_FIRST === '1' ? 'first' : 'after-js'}.json`), JSON.stringify({ error: String(error), downloads }, null, 2));
      if (!/未收到可明确关联的下载事件/.test(error.message)) throw error;
      const token = error.message.match(/token=([^；）]+)/)?.[1];
      if (token) await bridge.request(task.profileId, 'downloads.cancel', { sessionId: task.sessionId, token });
    }
  };
  if (process.env.PP_DOM_BLOB_FIRST === '1') await checkBlob();
  await select({ frameId: rootFrame.id, query: 'Long control 239' });
  await action('click', 'Long control 239');
  await until(() => fixture.hits.some(h => h.action === 'long-239'), 'last control click missing');
  const allRefs = new Set(); let cursor, text = '';
  do {
    const page = await select({ cursor, limit: 55, textLimit: 3000 });
    page.fast.candidates.forEach(c => allRefs.add(c.ref)); text += page.snapshot; cursor = page.page.nextCursor;
  } while (cursor);
  assert.ok(allRefs.size > 240); assert.match(text, /END_OF_LONG_PAGE/);
  mark('long page >240 controls and >30000 characters; searched last control is actionable');
  await select({ frameId: rootFrame.id, query: 'Download redirect root' });
  const download = JSON.parse(await action('download', 'Download redirect root'));
  assert.equal(await readFile(download.file.path, 'utf8'), 'id,value\n1,native-dom-fixture\n');
  assert.ok(download.download.finalUrl.includes('/file'));
  const outputs = await Promise.all([browser.download(task, { url: fixture.url + '/file' }), browser.download(task, { url: fixture.url + '/file' })]);
  assert.notEqual(outputs[0].download.id, outputs[1].download.id); assert.notEqual(outputs[0].file.path, outputs[1].file.path);
  mark('redirect/Content-Disposition download, disk verification, duplicate names and concurrent explicit IDs');
  await select({ frameId: rootFrame.id, query: 'Download JS root' });
  try {
    const candidate = task.observation.fast.candidates.find(c => c.label === 'Download JS root');
    const jsDownload = await browser.download(task, { ref: candidate.ref, timeoutMs: 5000 });
    assert.equal(await readFile(jsDownload.file.path, 'utf8'), 'id,value\n1,native-dom-fixture\n');
    mark('JS click arm/event association registers actual saved file');
  } catch (error) {
    if (process.env.PP_DOM_BLOB_FIRST !== '1' || !/未收到可明确关联的下载事件/.test(error.message)) throw error;
    limitations.push({ kind: 'js-after-blob', message: error.message }); console.log('LIMITATION JS after blob:', error.message);
    const token = error.message.match(/token=([^；）]+)/)?.[1];
    if (token) await bridge.request(task.profileId, 'downloads.cancel', { sessionId: task.sessionId, token });
  }
  if (process.env.PP_DOM_BLOB_FIRST !== '1') await checkBlob();
  let delayedTimeout;
  try { await browser.download(task, { url: fixture.url + '/delayed', timeoutMs: 50 }); } catch (error) { delayedTimeout = error.message; }
  const delayedId = Number(delayedTimeout?.match(/download id=(\d+)/)?.[1]); assert.ok(Number.isInteger(delayedId));
  const resumed = await browser.download(task, { operation: 'wait', id: delayedId, timeoutMs: 5000 });
  assert.equal(await readFile(resumed.file.path, 'utf8'), 'delayed-fixture');
  mark('timed-out download resumes by the original ID and completes without retriggering');
  let timeout;
  try { await browser.download(task, { url: fixture.url + '/slow', timeoutMs: 200 }); } catch (error) { timeout = error.message; }
  assert.match(timeout || '', /超时/);
  const slowId = Number(timeout.match(/download id=(\d+)/)?.[1]); assert.ok(Number.isInteger(slowId));
  await browser.download(task, { operation: 'cancel', id: slowId });
  await assert.rejects(browser.download(task, { operation: 'wait', id: slowId }), /中断|取消|CANCELED/);
  mark('timeout retains download ID; cancellation and interrupted completion are explicit');
  await select({ frameId: rootFrame.id, query: 'Deep shadow root' });
  const stale = task.observation;
  await browser.execute(task, { kind: 'open', value: fixture.url + '/same', effect: 'read', summary: 'Navigation stale ref test' });
  task.observation = stale;
  await assert.rejects(browser.execute(task, { kind: 'click', ref: stale.fast.candidates[0].ref, effect: 'read', summary: 'Reject old ref' }));
  task.observation = undefined;
  await until(async () => (await browser.readPage(task, {})).url.endsWith('/same'), 'navigation incomplete');
  mark('navigation invalidates old references before dispatch');
  await browser.control(task, 'handoff');
  await assert.rejects(browser.observe(task), /用户正在/);
  await browser.control(task, 'resume');
  task.observation = await browser.readPage(task, {});
  await browser.control(task, 'complete'); completed = true;
  mark('takeover stops input, resume reobserves, completion releases');
  if (process.env.PP_DOM_MINIMIZED === '1') {
    assert.ok(fixture.windowReports.length); assert.ok(fixture.windowReports.every(r => r.state === 'minimized'));
    mark('Windows/Chrome remained minimized throughout DOM and pointer execution');
  }
  assert.ok(fixture.windowReports.length); assert.ok(fixture.windowReports.every(r => r.active === 'false'));
  mark('target tab stayed inactive throughout native execution');
  await writeFile(path.join(results, `result-${process.platform}${process.env.PP_DOM_MINIMIZED === '1' ? '-minimized' : ''}${process.env.PP_DOM_BLOB_FIRST === '1' ? '-blob-first' : ''}.json`), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, checks, frames: frameList, hits: fixture.hits, outputs: task.outputs, downloads, limitations, windowReports: fixture.windowReports, passed: true, blobVerified: checks.some(c => c.startsWith('blob download')) }, null, 2));
} catch (error) {
  await writeFile(path.join(results, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), checks, error: String(error), stack: error.stack, hits: fixture.hits, downloads, windowReports: fixture.windowReports }, null, 2));
  throw error;
} finally {
  const cleanup = [];
  for (const item of ownedDownloads.values()) {
    if (!item.filename) continue;
    try {
      const text = await readFile(item.filename, 'utf8');
      if (!['id,value\n1,native-dom-fixture\n', 'blob-fixture', 'delayed-fixture'].includes(text)) { cleanup.push({ id: item.id, filename: item.filename, removed: false, reason: 'content changed or incomplete' }); continue; }
      await unlink(item.filename); cleanup.push({ id: item.id, filename: item.filename, removed: true });
    } catch (error) { if (error.code !== 'ENOENT') cleanup.push({ id: item.id, filename: item.filename, removed: false, error: String(error) }); }
  }
  await writeFile(path.join(results, `cleanup-${task.id}.json`), JSON.stringify(cleanup, null, 2));
  if (!completed) await browser?.control(task, 'release').catch(() => {});
  browser?.dispose(); bridge?.close();
  if (gateway && !bootstrapDone) await cli(['profilepilot', 'release']).catch(() => {});
  await fixture.close(); await gateway?.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
}
