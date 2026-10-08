const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { NativeBrowserBridge } = require('../dist/main/tasks/native-bridge');
const { NATIVE_REQUIRED_CAPABILITIES } = require('../dist/main/tasks/native-compatibility');
const { BrowserServiceHost } = require('../dist/main/browser-service/host');
const { BrowserServiceClient } = require('../dist/main/browser-service/client');
const { serviceRequest, readBrowserServiceConnection } = require('../dist/main/browser-service/connection');
const { ensureBrowserService, browserServiceLaunchInfo } = require('../dist/main/browser-service/launcher');
const { acquireBrowserServiceLock } = require('../dist/main/browser-service/lock');
const { requestNativeControl } = require('../dist/main/native-control/cli');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');

async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-browser-service-'));
  let tokens = {}, stopped = false;
  const vault = { read: () => tokens, write: value => { tokens = value; } };
  const bridge = new NativeBrowserBridge(root, vault);
  const installer = { prepare: async () => ({ extensionPath: path.join(root, 'extension'), version: '0.2.3' }), install: async () => {}, openSettings: async () => {} };
  const host = new BrowserServiceHost(bridge, root, installer, () => { stopped = true; });
  await bridge.start();
  const connection = readBrowserServiceConnection(root);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    host.close(); bridge.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  });
  const desktop = async () => { const client = new BrowserServiceClient(root); clients.push(client); await client.start(); return client; };
  const direct = (method, params = {}, sessionId = 'cli-session') => requestNativeControl({ method, params, sessionId, profileId: 'native:Default', requestId: randomUUID() }, root);
  const connectExtension = async () => {
    const { result } = await serviceRequest(connection, 'pair', ['native:Default']);
    const config = JSON.parse(Buffer.from(result.code.slice(4), 'base64url'));
    const calls = [];
    let owner, ownership = 'user', intercept = async () => {};
    const publish = () => peer.onText(JSON.stringify({ type: 'state', state: { ownership, sessionId: owner, taskTabs: true,
      extensionVersion: '0.2.3', capabilities: NATIVE_REQUIRED_CAPABILITIES, tabId: 7, controlGeneration: 'fixture:1' } }));
    const peer = {
      close() { this.onClose?.(); },
      sendText(text) {
        const command = JSON.parse(text); if (!command.id) return;
        calls.push(command);
        queueMicrotask(async () => {
          try {
            await intercept(command);
            if (command.method === 'claim') {
              if (owner && owner !== command.params.sessionId) throw Error('另一个任务占用');
              owner = command.params.sessionId; ownership = 'agent'; publish();
            }
            if (command.method === 'control') {
              assert.equal(command.params.sessionId, owner);
              if (['release', 'complete'].includes(command.params.action)) owner = undefined;
              ownership = command.params.action === 'resume' ? 'agent' : 'user'; publish();
            }
            peer.onText(JSON.stringify({ id: command.id, result: command.method === 'tabs' ? [{ id: '7', title: 'fixture' }] : {} }));
          } catch (error) { peer.onText(JSON.stringify({ id: command.id, error: error.message })); }
        });
      }
    };
    bridge.authenticate(peer, { type: 'hello', ...config }); publish();
    return { calls, config, peer, intercept: fn => { intercept = fn; } };
  };
  return { root, bridge, host, connection, desktop, direct, connectExtension, tokens: () => tokens, stopped: () => stopped };
}

test('desktop disconnect/reconnect preserves CLI ownership, pairing and operations', { timeout: 10000 }, async t => {
  const f = await fixture(t), extension = await f.connectExtension();
  const desktop = await f.desktop();
  await f.direct('claim');
  await until(() => desktop.isDirectSession('native:Default', 'cli-session'), 'CLI owner must be distinguished in the App');
  await assert.rejects(desktop.request('native:Default', 'claim', { sessionId: 'pp-task-app' }), /占用/);
  await assert.rejects(desktop.request('native:Default', 'control', { sessionId: 'cli-session', action: 'release' }), /不能操作/);
  desktop.close();
  const tabs = await f.direct('tabs'); assert.equal(tabs[0].id, '7');
  const nextDesktop = await f.desktop();
  assert.equal(nextDesktop.isDirectSession('native:Default', 'cli-session'), true);
  assert.equal(nextDesktop.states()[0].ownerSessionId, 'cli-session');
  assert.equal(f.tokens()['native:Default'], extension.config.token);
  await assert.rejects(serviceRequest(f.connection, 'stop'), /仍有浏览器会话/);
  await f.direct('control', { action: 'release' });
  await serviceRequest(f.connection, 'stop');
  await until(f.stopped, 'idle service can be explicitly stopped');
});

test('App disconnect hands back only its own session; a late claim cannot leave the browser running', { timeout: 10000 }, async t => {
  const f = await fixture(t), extension = await f.connectExtension();
  const desktop = await f.desktop();
  await desktop.request('native:Default', 'claim', { sessionId: 'pp-task-app' });
  desktop.close();
  await until(() => f.bridge.states()[0].ownership === 'user', 'App disconnect must hand back its task');
  assert.equal(f.bridge.states()[0].ownerSessionId, 'pp-task-app');
  await f.bridge.request('native:Default', 'control', { sessionId: 'pp-task-app', action: 'release' });
  const late = await f.desktop(); let finish;
  extension.intercept(command => command.method === 'claim' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const claim = late.request('native:Default', 'claim', { sessionId: 'pp-task-late' });
  const failure = assert.rejects(claim, /断开|交还/);
  await until(() => finish, 'claim entered extension'); late.close();
  await assert.rejects(serviceRequest(f.connection, 'stop'), /仍有浏览器会话/);
  await until(() => f.host.clients.size === 0, 'App stream closed'); finish(); await failure;
  assert.equal(f.bridge.states()[0].ownership, 'user');
  assert.equal(f.bridge.states()[0].ownerSessionId, 'pp-task-late');
});

test('side-panel task requests reach App over the stream and report App availability separately', async t => {
  const f = await fixture(t); await f.connectExtension();
  assert.deepEqual(await f.bridge.uiHandler('native:Default', 'getUiState', {}), { taskServiceAvailable: false });
  await assert.rejects(f.bridge.uiHandler('native:Default', 'startTask', {}), /需要启动/);
  const desktop = await f.desktop();
  desktop.configureUi(async (profileId, method, params) => ({ profileId, method, params, task: { id: 'task-one' } }));
  const response = await f.bridge.uiHandler('native:Default', 'getUiState', { taskId: 'task-one' });
  assert.equal(response.taskServiceAvailable, true); assert.equal(response.task.id, 'task-one');
  const popup = await popupFixture([{ id: 7, active: true, windowId: 2, url: 'https://fixture.test' }], { state: { taskServiceAvailable: false } });
  assert.equal(popup.element('#compose').hidden, true); assert.equal(popup.element('#desktop-required').hidden, false);
  popup.setState({ taskServiceAvailable: true }); await popup.poll(); assert.equal(popup.element('#compose').hidden, false);
});

test('service rejects unauthenticated/web-origin requests and does not replay a failed action', async t => {
  const f = await fixture(t); const extension = await f.connectExtension();
  const url = `http://127.0.0.1:${f.connection.port}/native-service`;
  for (const headers of [{}, { Authorization: `Bearer ${f.connection.token}`, Origin: 'https://example.com' }]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ method: 'pair', args: ['native:Other'] }) })).status, 403);
  }
  const desktop = await f.desktop();
  extension.intercept(async command => { if (command.method === 'cdp') throw Error('uncertain action result'); });
  await assert.rejects(desktop.request('native:Default', 'cdp', { sessionId: 'pp-task-app' }), /uncertain/);
  assert.equal(extension.calls.filter(c => c.method === 'cdp').length, 1);
  const peers = await Promise.all(Array.from({ length: 5 }, () => ensureBrowserService(f.root)));
  assert.equal(new Set(peers.map(c => c.pid + ':' + c.port)).size, 1);
});

test('singleton lock preserves live owners and recovers a dead owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-service-lock-'));
  try {
    const release = acquireBrowserServiceLock(root); assert.equal(typeof release, 'function');
    assert.equal(acquireBrowserServiceLock(root), undefined); release();
    fs.writeFileSync(path.join(root, 'browser-service.lock'), JSON.stringify({ pid: 2147483647, id: 'dead' }));
    const recovered = acquireBrowserServiceLock(root); assert.equal(typeof recovered, 'function'); recovered();
  } finally { assert.ok(root.startsWith(os.tmpdir() + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows and macOS launch the service role without desktop arguments', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  for (const platform of ['win32', 'darwin']) {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    const info = browserServiceLaunchInfo('/test/project');
    assert.deepEqual(info.args, ['/test/project', '--profilepilot-browser-service']);
    assert.ok(info.executable.replaceAll('\\', '/').endsWith(platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron'));
    const packaged = browserServiceLaunchInfo('/test/resources/app.asar', '/test/ProfilePilot');
    assert.deepEqual(packaged.args, ['--profilepilot-browser-service']);
  }
});
