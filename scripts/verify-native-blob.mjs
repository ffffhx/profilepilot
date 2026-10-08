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
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-blob-fixture-'));
const evidence = path.resolve('artifacts/herdr-native-20260926/dom-evidence'); await mkdir(evidence, { recursive: true });
const fixture = await startNativeDomFixture(), gateway = await startTaskGatewayFixture();
const bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
const browser = new NativeBrowser(bridge, evidence), events = [];
const task = { id: randomUUID(), sessionId: `blob-test-${randomUUID()}`, profileId: 'native:blob-fixture', browserConnection: 'extension', attachments: [] };
const bootstrap = `blob-bootstrap-${randomUUID()}`;
let released = false, result, errorText;
const cli = async args => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs'), '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  return parseCliResult(stdout);
};
bridge.onEvent(event => { if (event.type === 'cdp' && /download|exception|console|Log\.|Security\./.test(event.method)) events.push(event); });
try {
  await cli(['open', fixture.url + '/blob-only']);
  await cli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair = await bridge.pair(task.profileId);
  const tabId = (await cli(['eval', `(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(fixture.url)}));const response=await chrome.runtime.sendMessage({method:'connect',code:${JSON.stringify(pair.code)}});if(response?.error)throw Error(response.error);return tab.id;})()`])).result;
  assert.ok(Number.isInteger(tabId)); task.nativeTarget = { tabId };
  await cli(['profilepilot', 'complete']); released = true;
  task.observation = await browser.readPage(task, { query: 'Download blob root' });
  for (const method of ['Runtime.enable', 'Log.enable', 'Security.enable']) {
    await bridge.request(task.profileId, 'cdp', { sessionId: task.sessionId, method, params: {} }).catch(error => events.push({ method, error: error.message }));
  }
  const candidate = task.observation.fast.candidates.find(c => c.label === 'Download blob root'); assert.ok(candidate);
  try { result = await browser.download(task, { ref: candidate.ref, timeoutMs: 5000 }); }
  catch (error) { errorText = error.message; }
  const report = { at: new Date().toISOString(), fixtureUrl: fixture.url, events, hits: fixture.hits, result, error: errorText };
  await writeFile(path.join(evidence, 'blob-diagnostic.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ hits: fixture.hits, result, error: errorText, diagnosticEvents: events.filter(e => !e.method?.startsWith('Page.downloadProgress')) }, null, 2));
  if (result?.download?.filename) {
    assert.equal(await readFile(result.download.filename, 'utf8'), 'blob-fixture');
    await unlink(result.download.filename);
  }
  assert.equal(result?.download?.state, 'complete', errorText || 'Blob download did not complete');
  assert.ok(fixture.hits.some(hit => hit.action === 'blob-handler-end' && hit.activation === 'true'));
} finally {
  await browser.control(task, 'release').catch(() => {}); browser.dispose(); bridge.close();
  if (!released) await cli(['profilepilot', 'release']).catch(() => {});
  await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
}
