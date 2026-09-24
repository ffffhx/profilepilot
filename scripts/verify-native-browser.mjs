import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';
const require = createRequire(import.meta.url);
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require('../dist/main/tasks/native-bridge');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { NativePreviewStream } = require('../dist/main/tasks/native-preview');
const { parseCliResult } = require('../dist/main/tasks/browser');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-test-'));
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const bridge = new NativeBrowserBridge(root, { read: () => ({}), write: () => {} });
bridge.server.on('upgrade', req => { if (process.env.PP_NATIVE_TRACE) console.log('Extension handshake origin:', req.headers.origin); });
const browser = new NativeBrowser(bridge, root);
const task = { id: randomUUID(), sessionId: `pp-extension-${randomUUID()}`, profileId: 'native:Default', browserConnection: 'extension', status: 'running', attachments: [] };
const bootstrap = `pp-native-bootstrap-${randomUUID()}`;
const wrapper = path.resolve('dist/main/profilepilot-agent-browser-wrapper.cjs');
const cli = async args => {
  try {
    const result = await promisify(execFile)(process.execPath, [wrapper, '--session', bootstrap, '--cdp', String(gateway.port), '--json', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    return parseCliResult(result.stdout);
  } catch (error) { throw new Error(String(error.stderr || error.stdout || 'Browser fixture command failed').replace(/PP1\.[\w-]+/g, '[pairing code]')); }
};
const evaluate = async expression => (await cli(['eval', expression])).result;
const until = async (check, label, timeout = 20000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(label); };
let stream, bootstrapDone = false;
try {
  await cli(['open', fixture.url + '/apply']);
  const loaded = await cli(['profilepilot', 'extension', 'load-unpacked', path.resolve('extensions/profilepilot')]);
  console.log('PASS test extension loaded through registered Gateway');
  await cli(['tab', 'new', `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html`]);
  const pair = await bridge.pair(task.profileId);
  // Exercise the same extension popup message as an explicit user pairing. The
  // disposable fixture has no user accounts, history or real-world side effects.
  const paired = await evaluate(`(async () => { const tabs = await chrome.tabs.query({}); const tab = tabs.find(t => t.url?.startsWith(${JSON.stringify(fixture.url)})); return chrome.runtime.sendMessage({ method: 'connect', code: ${JSON.stringify(pair.code)}, tabId: tab.id }); })()`);
  if (process.env.PP_NATIVE_TRACE) console.log('Pairing result:', JSON.stringify(paired));
  if (paired?.error) throw new Error(paired.error);
  await until(() => bridge.states().some(s => s.connected), 'Extension did not authenticate');
  // Release the test bootstrap driver before the new extension begins control.
  await cli(['profilepilot', 'complete']); bootstrapDone = true;
  console.log('PASS real extension pairing; bootstrap browser driver released');
  task.observation = await browser.observe(task, true, false);
  assert.match(task.observation.snapshot, /姓名/);
  assert.ok(task.observation.screenshotDataUrl.startsWith('data:image/png;base64,'));
  const action = async (kind, label, value, extra = {}) => {
    task.observation = await browser.observe(task);
    const candidate = task.observation.fast.candidates.find(c => c.label.includes(label));
    assert.ok(candidate, `Missing control: ${label}`);
    return browser.execute(task, { kind, ref: candidate.ref, value, effect: 'edit', summary: 'Local extension fixture', ...extra });
  };
  await action('fill', '姓名', 'Extension test');
  await action('fill', '邮箱', 'fixture@example.test');
  await action('select', '城市', '上海');
  await action('check', '确认资料正确');
  const attachment = path.join(root, 'fixture.txt'); await writeFile(attachment, 'Local extension test');
  task.attachments.push({ id: 'fixture-file', name: 'fixture.txt', path: attachment, size: 20 });
  await action('upload', '附件', undefined, { attachmentId: 'fixture-file' });
  await action('click', '提交申请');
  await until(async () => (await browser.observe(task)).snapshot.includes('提交成功'), 'Native form was not submitted');
  console.log('PASS native observe, image, fill, select, check, upload and submit');
  await assert.rejects(browser.observe({ ...task, sessionId: 'another-task' }), /另一个任务/);
  await browser.control(task, 'handoff');
  await assert.rejects(browser.observe(task), /用户正在/);
  await browser.control(task, 'resume');
  await browser.execute(task, { kind: 'open', value: fixture.url + '/live', effect: 'read', summary: 'Preview fixture' });
  const frames = [];
  stream = new NativePreviewStream(bridge, () => task, update => { if (update.frame) { frames.push(update.frame); queueMicrotask(() => stream.ack(update.frameId)); } });
  stream.start(); await until(() => new Set(frames).size >= 3, 'Live frames did not arrive');
  await browser.control(task, 'handoff'); const count = frames.length;
  await until(() => frames.length > count + 1, 'Preview stopped during handoff');
  await assert.rejects(browser.tabs(task), /用户正在/);
  await browser.control(task, 'resume');
  console.log('PASS lease isolation, takeover blocks input, live preview continues and resume works');
  stream.close(); await browser.control(task, 'complete');
  assert.equal(bridge.states()[0].ownerSessionId, undefined);
  await browser.observe({ ...task, sessionId: 'new-test-session' });
  await browser.control({ ...task, sessionId: 'new-test-session' }, 'complete');
  await bridge.disconnect(task.profileId);
  assert.equal(bridge.states().length, 0);
  await assert.rejects(browser.observe(task), /未连接/);
  console.log('PASS completion releases session, next task connects, unpair stops the extension');
} finally {
  stream?.close(); await browser.control(task, 'release').catch(() => {}); bridge.close();
  if (!bootstrapDone) await cli(['profilepilot', 'release']).catch(() => {});
  await fixture.close(); await gateway.close();
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
}
