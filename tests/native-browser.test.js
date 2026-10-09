const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { randomBytes, createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const build = process.env.PP_CONTROL_BUILD || path.resolve('dist');
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require(path.join(build, 'main/tasks/native-bridge'));
const { NativeBrowser, RoutedBrowser } = require(path.join(build, 'main/tasks/native-browser'));
const { hasTaskBrowser } = require(path.join(build, 'shared/tasks'));
const { NATIVE_REQUIRED_CAPABILITIES } = require(path.join(build, 'main/tasks/native-compatibility'));
const { requestNativeControl } = require(path.join(build, 'main/native-control/cli'));

function open(port, origin = `chrome-extension://${NATIVE_EXTENSION_ID}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/profilepilot', headers: { Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('error', reject); req.on('response', () => reject(new Error('Upgrade denied')));
    req.on('upgrade', (_response, socket, head) => {
      let buffer = head, messages = [], readers = [];
      const closed = new Promise(resolve => socket.once('close', resolve));
      const parse = () => {
        while (buffer.length >= 2) {
          let length = buffer[1] & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0] & 15, payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.end(); return; }
          if (opcode !== 1) continue;
          const message = JSON.parse(payload.toString()); const reader = readers.shift(); reader ? reader(message) : messages.push(message);
        }
      };
      socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); parse(); });
      socket.on('error', () => {});
      resolve({ closed, close: () => socket.destroy(), end: () => socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0])), next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => readers.push(resolve)), send: value => {
        const data = Buffer.from(JSON.stringify(value)); const mask = randomBytes(4), header = Buffer.alloc(data.length < 126 ? 2 : 4);
        header[0] = 0x81; header[1] = 0x80 | (data.length < 126 ? data.length : 126); if (data.length >= 126) header.writeUInt16BE(data.length, 2);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; socket.write(Buffer.concat([header, mask, data]));
      } }); parse();
    }); req.end();
  });
}
test('extension origin, short-lived pairing, persistence, duplicate connections and revocation', { timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-native-unit-')); let secrets = {}, client, duplicate, bridge;
  const vault = { read: () => secrets, write: value => { secrets = { ...value }; } };
  try {
    bridge = new NativeBrowserBridge(root, vault);
    const invitations = await Promise.all(Array.from({ length: 5 }, () => bridge.authorize('native:Default', 'Daily Chrome')));
    const invitation = invitations[0];
    assert.ok(invitations.every(item => item.url === invitation.url));
    assert.equal((await bridge.authorize('native:Default', 'Daily Chrome')).url, invitation.url);
    assert.equal((await fetch(invitation.url)).status, 200);
    const response = await fetch(invitation.url + '/pair', { headers: { Origin: `chrome-extension://${NATIVE_EXTENSION_ID}` } });
    const pair = { ...await response.json(), expiresAt: invitation.expiresAt };
    const config = JSON.parse(Buffer.from(pair.code.slice(4), 'base64url').toString());
    assert.ok(Date.parse(pair.expiresAt) > Date.now());
    await assert.rejects(open(config.port, 'https://attacker.example'), /hang up|denied/i);
    client = await open(config.port); client.send({ type: 'hello', ...config, token: '0'.repeat(64) }); await client.closed;
    assert.deepEqual(bridge.states(), []);
    client = await open(config.port); client.send({ type: 'hello', ...config }); assert.equal((await client.next()).type, 'welcome');
    assert.equal(secrets['native:Default'], config.token);
    assert.equal(JSON.stringify(bridge.states()).includes(config.token), false);
    duplicate = await open(config.port); duplicate.send({ type: 'hello', ...config }); await duplicate.closed;
    assert.equal(bridge.states()[0].connected, true);
    client.send({ type: 'state', state: { taskTabs: true, extensionVersion: '0.2.0', capabilities: [...NATIVE_REQUIRED_CAPABILITIES], ownership: 'agent', sessionId: 'task', tabId: 7 } });
    const result = bridge.request('native:Default', 'tabs'); const command = await client.next();
    client.send({ id: command.id, result: [{ id: '7' }] }); assert.deepEqual(await result, [{ id: '7' }]);
    await assert.rejects(bridge.pair('native:Default'), /结束/);
    const reused = await bridge.authorize('native:Default', 'Daily Chrome');
    assert.equal((await (await fetch(reused.url + '/status')).json()).stage, 'connected');
    assert.equal((await fetch(reused.url + '/pair', { headers: { Origin: `chrome-extension://${NATIVE_EXTENSION_ID}` } })).status, 403);
    assert.equal(secrets['native:Default'], config.token);
    assert.equal(bridge.states()[0].ownerSessionId, 'task');
    const inFlight = assert.rejects(bridge.request('native:Default', 'cdp'), /中断/);
    client.close(); await inFlight;
    bridge.close(); bridge = new NativeBrowserBridge(root, vault); await bridge.start();
    client = await open(config.port); client.send({ type: 'hello', ...config }); assert.equal((await client.next()).type, 'welcome');
    assert.equal(bridge.states()[0].ownership, 'user');
    const revoke = bridge.disconnect('native:Default'); const disconnection = await client.next();
    client.send({ id: disconnection.id, result: {} }); await revoke;
    assert.deepEqual(secrets, {}); assert.deepEqual(bridge.states(), []);
    client = await open(config.port); client.send({ type: 'hello', ...config }); await client.closed;
    assert.deepEqual(bridge.states(), []);
  } finally { client?.close(); duplicate?.close(); bridge?.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); rmSync(root, { recursive: true, force: true }); }
});

test('legacy and modern handshakes distinguish readiness without losing pairing or ownership', { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-native-handshake-'));
  const profileId = 'native:Legacy', token = randomBytes(32).toString('hex');
  let writes = 0, client;
  const bridge = new NativeBrowserBridge(root, { read: () => ({ [profileId]: token }), write: () => { writes++; } });
  t.after(() => { client?.close(); bridge.close(); });
  const bounded = async (promise, stage) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Handshake fixture timed out: ${stage}`)), 2000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await bridge.start();
    // A still-pending invitation must not bypass the legacy connection check.
    await bridge.authorize(profileId, 'Legacy Chrome');
    const pendingPairing = bridge.pairings.get(profileId);
    const { port } = JSON.parse(readFileSync(path.join(root, 'extension-listener.json'), 'utf8'));
    client = await open(port); client.send({ type: 'hello', profileId, token });
    assert.equal((await bounded(client.next(), 'saved pairing welcome')).type, 'welcome');
    assert.equal(bridge.states()[0].taskTabs, false, 'authentication alone is not execution readiness');
    const publish = state => bounded(new Promise(resolve => {
      const unsubscribe = bridge.onEvent(event => { if (event.type === 'state') { unsubscribe(); resolve(event.state); } });
      client.send({ type: 'state', state });
    }), 'state advertisement');
    const owner = { taskTabs: true, ownership: 'user', sessionId: 'legacy-owner', pausedByBrowser: true, tabId: 7, tabTitle: 'Legacy page' };
    const legacy = await publish(owner);
    assert.equal(legacy.connected, true); assert.equal(legacy.taskTabs, false);
    assert.equal(legacy.ownerSessionId, owner.sessionId); assert.equal(legacy.ownership, 'user');
    assert.equal(legacy.pausedByBrowser, true); assert.equal(legacy.tabId, 7);
    assert.equal(legacy.extensionVersion, undefined); assert.equal(legacy.capabilities, undefined);
    await assert.rejects(bridge.authorize(profileId, 'Legacy Chrome'), error => error.code === 'NATIVE_EXTENSION_UPDATE_REQUIRED');
    assert.equal(bridge.pairings.get(profileId), pendingPairing, 'no replacement pairing is created');
    const status = await requestNativeControl({ method: 'status', requestId: 'legacy-status' }, root);
    assert.deepEqual(status.profiles, JSON.parse(JSON.stringify(bridge.states())));
    await assert.rejects(requestNativeControl({ method: 'claim', profileId, sessionId: 'direct', requestId: 'legacy-claim' }, root), error => error.code === 'NATIVE_EXTENSION_UPDATE_REQUIRED' && /更新或重新加载/.test(error.message));
    assert.equal(bridge.isDirectSession(profileId, 'direct'), false);
    // A heartbeat must be the very next wire message: rejection sent no claim.
    client.send({ type: 'heartbeat' }); assert.deepEqual(await bounded(client.next(), 'no claim on wire'), { type: 'heartbeat' });
    assert.equal(writes, 0); assert.equal(bridge.states()[0].ownerSessionId, owner.sessionId);

    const modern = { ...owner, extensionVersion: '0.2.0', capabilities: [...NATIVE_REQUIRED_CAPABILITIES] };
    for (const capability of NATIVE_REQUIRED_CAPABILITIES) {
      const state = await publish({ ...modern, capabilities: modern.capabilities.filter(item => item !== capability) });
      assert.equal(state.taskTabs, false, `missing ${capability}`); assert.equal(state.ownerSessionId, owner.sessionId);
    }
    for (const extensionVersion of [undefined, '0.1.99', '0.0.99', 'garbage', '0.2.0-beta', '70000.0']) {
      assert.equal((await publish({ ...modern, extensionVersion })).taskTabs, false);
    }
    assert.equal((await publish({ ...modern, taskTabs: false })).taskTabs, false);
    for (const extensionVersion of ['0.2.0', '0.2.0.1', '0.10.0', '1.0']) {
      const ready = await publish({ ...modern, extensionVersion });
      assert.equal(ready.taskTabs, true); assert.equal(ready.ownerSessionId, owner.sessionId);
      assert.equal(ready.connected, true); assert.equal(ready.pausedByBrowser, true);
    }
    assert.equal((await publish(owner)).taskTabs, false, 'a later legacy advertisement cannot retain stale readiness');
    assert.equal(writes, 0, 'capability negotiation never rotates the pairing token');
    const disconnected = new Promise(resolve => { const stop = bridge.onEvent(event => { if (event.type === 'disconnected') { stop(); resolve(); } }); });
    client.end(); await bounded(disconnected, 'disconnect');
    client = await open(port); client.send({ type: 'hello', profileId, token });
    assert.equal((await bounded(client.next(), 'upgrade reconnect')).type, 'welcome'); assert.equal(writes, 0);
    assert.equal((await publish(modern)).taskTabs, true, 'the same pairing reconnects after upgrade');
  } finally { client?.close(); bridge.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); rmSync(root, { recursive: true, force: true }); }
});

test('manifest identity matches bridge and cannot be loaded by remote pages', () => {
  const manifest = JSON.parse(readFileSync('extensions/profilepilot/manifest.json', 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  assert.equal([...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''), NATIVE_EXTENSION_ID);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://127.0.0.1/profilepilot-connect/*']);
  // captureVisibleTab requires this exact permission for desktop background
  // previews; http/https wildcard permissions alone do not authorize capture.
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.permissions.includes('debugger'), true);
});

async function extension(fetcher = fetch, timerScale = 1, storage = { local: {}, session: {} }) {
  let receive, detached, calls = [];
  const replies = new Map(); let transport;
  class WorkerSocket {
    static OPEN = 1;
    listeners = new Map(); readyState = 0;
    constructor() {
      transport = this;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.listeners.get('open')?.(); this.receive({ type: 'welcome' }); });
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(json) { const message = JSON.parse(json); if (message.id) { replies.get(message.id)?.(message); replies.delete(message.id); } }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const event = () => ({ listener: undefined, addListener(fn) { this.listener = fn; } });
  const area = name => ({ get: async key => ({ [key]: storage[name][key] }), set: async data => { Object.assign(storage[name], JSON.parse(JSON.stringify(data))); }, remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[name][key]; } });
  const created = [], removed = new Set(); let nextTabId = 100;
  const chrome = {
    runtime: { id: NATIVE_EXTENSION_ID, getURL: file => `chrome-extension://${NATIVE_EXTENSION_ID}/${file}`, onMessage: { addListener: listener => { receive = listener; } } },
    storage: { local: area('local'), session: area('session') },
    alarms: { onAlarm: event(), create: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: { update: async () => {} },
    tabs: { get: async id => { if (removed.has(id)) throw Error('No tab'); return { id, url: 'https://fixture.test', title: 'fixture' }; }, create: async options => { const tab = { id: nextTabId++, ...options }; created.push(tab); return tab; }, update: async id => ({ id, windowId: 1 }), remove: async id => { removed.add(id); chrome.tabs.onRemoved.listener(id); }, onUpdated: event(), onReplaced: event(), onCreated: event(), onRemoved: event() },
    debugger: { attach: async () => calls.push('attach'), detach: async () => calls.push('detach'), sendCommand: async (_target, method) => { calls.push(method); return {}; }, onEvent: event(), onDetach: { addListener: fn => { detached = fn; } } }
  };
  const context = vm.createContext({ chrome, crypto: require('node:crypto').webcrypto, URL, setInterval, clearInterval, setTimeout: (callback, ms) => setTimeout(callback, ms * timerScale), clearTimeout, WebSocket: WorkerSocket, atob, fetch: fetcher });
  // Parsing the actual worker as a script also catches unsupported top-level await.
  vm.runInContext(readFileSync('extensions/profilepilot/background.js', 'utf8') + '\nglobalThis.fixture = { handle, select: id => { taskTabs.set("one", {tabId:id,tabs:[id]}); }, state, connect: () => { config = {port: 12345, profileId: "native:Default", token: "fixture"}; return connect(); } };', context);
  await new Promise(resolve => setImmediate(resolve));
  return { ...context.fixture, calls, created, storage, detach: () => detached({ tabId: 7 }, 'canceled_by_user'), message: receive, chrome,
    close: () => transport?.close(), command: message => new Promise(resolve => { replies.set(message.id, resolve); transport.receive(message); }) };
}

test('native connection never activates a sleeping tab in the background', async () => {
  for (const condition of ['discarded', 'frozen', 'live']) {
    const ext = await extension(); ext.select(7); let sleeping = condition !== 'live';
    ext.chrome.tabs.get = async id => ({ id, url: 'https://fixture.test', discarded: condition === 'discarded' && sleeping, frozen: condition === 'frozen' && sleeping, status: sleeping ? 'unloaded' : 'complete' });
    ext.chrome.tabs.update = async (id, changes) => { assert.equal(id, 7); assert.deepEqual(JSON.parse(JSON.stringify(changes)), { active: true }); ext.calls.push('restore'); sleeping = false; };
    if (sleeping) {
      await assert.rejects(ext.handle('claim', { sessionId: 'one' }), /休眠/);
      assert.deepEqual(ext.calls, []);
      sleeping = false;
      await ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
    } else await ext.handle('claim', { sessionId: 'one' });
    assert.deepEqual(ext.calls, ['attach']);
    await ext.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate' });
    assert.equal(ext.calls.filter(c => c === 'restore').length, 0);
  }
});

test('a restored renderer can attach while resources still load; no reload or new tab is needed', async () => {
  for (const condition of ['discarded', 'frozen']) {
    const ext = await extension(); ext.select(7); let sleeping = true;
    ext.chrome.tabs.get = async id => ({ id, url: 'https://fixture.test', [condition]: sleeping, status: sleeping ? 'unloaded' : 'loading' });
    ext.chrome.tabs.update = async id => { assert.equal(id, 7); sleeping = false; ext.calls.push('wake'); };
    await assert.rejects(ext.handle('claim', { sessionId: 'one' }), /休眠/);
    sleeping = false;
    await ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
    assert.deepEqual(ext.calls, ['attach']);
    assert.equal((await ext.state()).ownership, 'agent'); assert.equal(ext.created.length, 0);
    await ext.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate' });
    assert.equal(ext.calls.at(-1), 'Runtime.evaluate');
  }
});

test('connection failure is reported as a browser pause, not a user takeover', async () => {
  const ext = await extension(); ext.select(7);
  ext.chrome.debugger.attach = async () => { throw new Error('Renderer unavailable'); };
  await assert.rejects(ext.handle('claim', { sessionId: 'one' }), /Renderer unavailable/);
  assert.equal((await ext.state()).ownership, 'user'); assert.equal((await ext.state()).pausedByBrowser, true);
  await assert.rejects(ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration }), /Renderer unavailable/);
  assert.equal((await ext.state()).pausedByBrowser, true);
  ext.chrome.debugger.attach = async () => {};
  await ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
  assert.equal((await ext.state()).pausedByBrowser, false); assert.equal((await ext.state()).ownership, 'agent');
});

test('old extension wake timeout retries only the authorized resume once, preserving session', async () => {
  let attempts = 0;
  const state = { connected: true, taskTabs: true, controlGeneration: 'fixture:0', profileId: 'native:Default', ownerSessionId: 'original' };
  const bridge = { onEvent: () => () => {}, states: () => [state], request: async (profile, method, params) => {
    assert.equal(profile, 'native:Default'); assert.equal(method, 'control'); assert.equal(params.action, 'resume'); assert.equal(params.sessionId, 'original');
    if (++attempts === 1) throw new Error('授权标签页正在从休眠恢复，请等待页面加载后继续当前任务。');
  } };
  const browser = new NativeBrowser(bridge, '.');
  await browser.control({ profileId: 'native:Default', sessionId: 'original' }, 'resume'); assert.equal(attempts, 2);
  attempts = 0;
  bridge.request = async () => { attempts++; throw new Error('用户正在操作浏览器'); };
  await assert.rejects(browser.control({ profileId: 'native:Default', sessionId: 'original' }, 'resume'), /用户正在/); assert.equal(attempts, 1);
  attempts = 0;
  bridge.request = async () => { attempts++; throw new Error('授权标签页正在从休眠恢复'); };
  await assert.rejects(browser.control({ profileId: 'native:Default', sessionId: 'original' }, 'resume'), /休眠/); assert.equal(attempts, 2);
  attempts = 0; state.ownerSessionId = 'another';
  await assert.rejects(browser.control({ profileId: 'native:Default', sessionId: 'original' }, 'resume'), /休眠/); assert.equal(attempts, 1);
});

test('explicit new-tab tasks preserve pages and can select existing ordinary tabs without takeover', async () => {
  const ext = await extension();
  const targets = [];
  ext.chrome.debugger.sendCommand = async (target, method, params) => { targets.push({ id: target.tabId, method, params }); return {}; };
  assert.equal((await ext.state()).tabId, undefined);
  await ext.handle('claim', { sessionId: 'news', newTab: true });
  const first = (await ext.state()).tabId;
  assert.deepEqual(ext.created, [{ id: first, url: 'about:blank', active: false }]);
  await ext.handle('open', { sessionId: 'news', url: 'https://x.com/' });
  assert.equal(targets[0].id, first);
  await assert.rejects(ext.handle('closeTab', { sessionId: 'news', tabId: 7 }), /未授权/);
  await ext.handle('switch', { sessionId: 'news', tabId: 7 });
  await ext.handle('switch', { sessionId: 'news', tabId: first });
  await ext.handle('claim', { sessionId: 'news' });
  assert.equal(ext.created.length, 1, 'repeated claim cannot create duplicates');
  ext.chrome.tabs.onCreated.listener({ id: 150, openerTabId: first });
  await ext.handle('switch', { sessionId: 'news', tabId: 150 });
  await ext.handle('control', { sessionId: 'news', action: 'complete' });
  await ext.handle('claim', { sessionId: 'jobs', newTab: true });
  assert.notEqual((await ext.state()).tabId, first);
  assert.equal(ext.created.length, 2);
  const ids = (await ext.handle('tabs', { sessionId: 'jobs' })).map(t => t.id);
  assert.deepEqual(Array.from(ids), [String(ext.created[1].id)]);
  await ext.handle('switch', { sessionId: 'jobs', tabId: first });
  await ext.handle('control', { sessionId: 'jobs', action: 'complete' });
  await ext.handle('control', { sessionId: 'news', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
  assert.equal((await ext.state()).tabId, 150);
  assert.equal(ext.created.length, 2, 'continuation restores the saved task tab');
  await ext.handle('switch', { sessionId: 'news', tabId: first });
});

test('closing a task page pauses input, explicit resume creates a replacement without selecting user tabs', async () => {
  const ext = await extension();
  await ext.handle('claim', { sessionId: 'news' });
  const first = (await ext.state()).tabId;
  await ext.chrome.tabs.remove(first);
  await assert.rejects(ext.handle('cdp', { sessionId: 'news', method: 'Input.insertText' }), /用户正在/);
  await assert.rejects(ext.handle('claim', { sessionId: 'other' }), /另一个任务/);
  await ext.handle('control', { sessionId: 'news', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
  assert.notEqual((await ext.state()).tabId, first);
  assert.equal(ext.created.length, 2);
  assert.equal((await ext.state()).ownership, 'agent');
});

test('new task waits for pending about:blank to commit before debugger attachment', async () => {
  const ext = await extension(); let reads = 0;
  ext.chrome.tabs.get = async id => ++reads < 3 ? { id, pendingUrl: 'about:blank' } : { id, url: 'about:blank' };
  ext.chrome.debugger.attach = async () => { assert.ok(reads >= 3); ext.calls.push('attach'); };
  await ext.handle('claim', { sessionId: 'news' });
  assert.equal(ext.created.length, 1);
  assert.ok(ext.calls.includes('attach'));
  assert.equal((await ext.state()).ownership, 'agent');
});

test('expired tab preparation reports its created tab without closing a potentially user-owned page or attaching', async () => {
  const ext = await extension(); let expired = false, removed;
  ext.chrome.tabs.create = async () => { expired = true; return { id: 200, url: 'about:blank' }; };
  ext.chrome.tabs.remove = async id => { removed = id; };
  await assert.rejects(ext.handle('claim', { sessionId: 'news' }, () => { if (expired) throw Error('expired'); }), error => {
    assert.match(error.message, /expired.*ID: 200.*勿重复新建/);
    assert.equal(error.createdTabId, 200);
    return true;
  });
  assert.equal(removed, undefined, 'Cancellation may be a takeover; never close the page the user could now be using');
  assert.equal(ext.calls.includes('attach'), false);
  assert.equal((await ext.state()).sessionId, undefined);
});

test('paired extension restores task pages after worker suspension but ignores legacy selection after Chrome restart', async () => {
  const connection = { port: 12345, profileId: 'native:Default', token: 'a'.repeat(64) };
  const storage = { local: { connection }, session: {
    selection: { profileId: 'native:Default', sessionId: 'news', tabId: 71 },
    taskTabs: { profileId: 'native:Default', tasks: [['news', { tabId: 71, tabs: [70, 71] }]] }
  } };
  const ext = await extension(fetch, 1, storage);
  try {
    assert.equal((await ext.state()).sessionId, 'news');
    assert.equal((await ext.state()).ownership, 'user');
    await assert.rejects(ext.handle('claim', { sessionId: 'news' }), /用户正在/);
    await ext.handle('control', { sessionId: 'news', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
    assert.equal((await ext.state()).tabId, 71);
    assert.equal(ext.created.length, 0);
  } finally { ext.close(); }
  for (const session of [{}, { selection: { profileId: 'native:Default', tabId: 7 } }]) {
    const restarted = await extension(fetch, 1, { local: { connection }, session });
    try {
      assert.equal((await restarted.state()).connected, true);
      assert.equal((await restarted.state()).tabId, undefined);
      await restarted.handle('claim', { sessionId: 'news' });
      assert.equal(restarted.created.length, 1);
      assert.notEqual((await restarted.state()).tabId, 7);
    } finally { restarted.close(); }
  }
});

test('Profile pairing no longer requires selecting an existing tab or attaching its debugger', async () => {
  const ext = await extension();
  const connection = { version: 1, port: 12345, profileId: 'native:Default', token: 'a'.repeat(64) };
  const sender = { id: NATIVE_EXTENSION_ID, url: `chrome-extension://${NATIVE_EXTENSION_ID}/popup.html` };
  try {
    const reply = await new Promise(resolve => ext.message({ method: 'connect', code: 'PP1.' + Buffer.from(JSON.stringify(connection)).toString('base64url') }, sender, resolve));
    assert.equal(reply.error, undefined);
    assert.equal((await ext.state()).taskTabs, true);
    assert.equal((await ext.state()).tabId, undefined);
    assert.deepEqual(ext.calls, []);
    assert.deepEqual(ext.created, []);
    const select = await new Promise(resolve => ext.message({ method: 'selectTab', tabId: 7 }, sender, resolve));
    assert.equal(select.error, undefined);
    assert.equal(select.result.tabId, 7);
  } finally { ext.close(); }
});

test('native adapter can claim without tab selection but rejects old extensions before navigation', async () => {
  const state = { profileId: 'native:Default', connected: true, taskTabs: true, ownership: 'user' }, calls = [];
  const bridge = { onEvent: () => () => {}, states: () => [state], request: async (_profile, method, params) => { calls.push(method); if (method === 'claim') { state.ownerSessionId = params.sessionId; state.ownership = 'agent'; } return {}; } };
  const native = new NativeBrowser(bridge, os.tmpdir());
  const task = { profileId: state.profileId, sessionId: 'news' };
  await native.tabs(task);
  assert.deepEqual(calls, ['claim', 'tabs']);
  state.taskTabs = false;
  await assert.rejects(native.tabs(task), /重新加载/);
  assert.deepEqual(calls, ['claim', 'tabs']);
});

test('Agent close restores an authorized parent, but user close still pauses', async () => {
  const ext = await extension(); ext.select(7);
  await ext.handle('claim', { sessionId: 'one' });
  ext.chrome.tabs.onCreated.listener({ id: 8, openerTabId: 7 });
  await ext.handle('switch', { sessionId: 'one', tabId: 8 });
  ext.chrome.tabs.get = async id => ({ id, url: 'https://fixture.test', openerTabId: id === 8 ? 7 : undefined });
  ext.chrome.tabs.remove = async id => ext.chrome.tabs.onRemoved.listener(id);
  await ext.handle('closeTab', { sessionId: 'one', tabId: 8 });
  assert.equal((await ext.state()).tabId, 7);
  assert.equal((await ext.state()).ownership, 'agent');
  await ext.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate' });
  await ext.handle('control', { sessionId: 'one', action: 'complete' });
  await ext.handle('claim', { sessionId: 'two' });
  assert.equal((await ext.state()).sessionId, 'two');
  ext.chrome.tabs.onRemoved.listener((await ext.state()).tabId);
  assert.equal((await ext.state()).ownership, 'user');
  assert.equal((await ext.state()).tabId, undefined);
  await assert.rejects(ext.handle('cdp', { sessionId: 'two', method: 'Input.insertText' }), /用户正在/);
});

test('native pointer preparation stays in background, foreground is explicit, and takeover stops input', async () => {
  const ext = await extension(); ext.select(7);
  await ext.handle('claim', { sessionId: 'one' });
  ext.chrome.tabs.get = async id => ({ id, windowId: 42, url: 'https://fixture.test', active: false });
  let minimized = true, activated = [];
  ext.chrome.windows.get = async id => { assert.equal(id, 42); return { state: minimized ? 'minimized' : 'normal' }; };
  ext.chrome.windows.update = async () => assert.fail('Must not focus or restore a user window');
  ext.chrome.tabs.update = async (id, changes) => { activated.push(id); assert.equal(changes.active, true); };
  await ext.handle('preparePointer', { sessionId: 'one' });
  assert.deepEqual(activated, []);
  minimized = false;
  await ext.handle('preparePointer', { sessionId: 'one' });
  assert.deepEqual(activated, []);
  await ext.handle('preparePointer', { sessionId: 'one', foreground: true });
  assert.deepEqual(activated, [7]);
  await ext.handle('control', { sessionId: 'one', action: 'handoff' });
  await assert.rejects(ext.handle('preparePointer', { sessionId: 'one' }), /用户正在/);
  assert.deepEqual(activated, [7]);
});

test('hung page reads release the queue, expired input is skipped and the original session can resume', { timeout: 2000 }, async () => {
  const ext = await extension(fetch, 0.005); ext.select(7); await ext.connect();
  try {
    await ext.command({ id: 1, method: 'claim', params: { sessionId: 'one' } });
    let hang = true;
    ext.chrome.debugger.sendCommand = async (_target, method) => { ext.calls.push(method); if (hang && method === 'Runtime.evaluate') return new Promise(() => {}); return {}; };
    const reading = ext.command({ id: 2, method: 'cdp', params: { sessionId: 'one', method: 'Runtime.evaluate' } });
    const expired = ext.command({ id: 3, method: 'cdp', params: { sessionId: 'one', method: 'Input.insertText' }, expiresAt: Date.now() - 1 });
    assert.match((await reading).error, /无响应/);
    assert.match((await expired).error, /请求已超时|已停止或接管/);
    assert.equal(ext.calls.includes('Input.insertText'), false);
    assert.ok(ext.calls.includes('detach'));
    assert.equal((await ext.state()).ownership, 'user');
    hang = false;
    assert.equal((await ext.command({ id: 4, method: 'control', params: { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration } })).error, undefined);
    assert.equal((await ext.command({ id: 5, method: 'cdp', params: { sessionId: 'one', method: 'Runtime.evaluate' } })).error, undefined);
    assert.equal((await ext.state()).sessionId, 'one');
  } finally { ext.close(); }
});

test('unresponsive preview cannot block page reading or task release', { timeout: 2000 }, async () => {
  const ext = await extension(fetch, 0.005); ext.select(7); await ext.connect();
  try {
    await ext.command({ id: 1, method: 'claim', params: { sessionId: 'one' } });
    ext.chrome.debugger.sendCommand = async (_target, method) => { ext.calls.push(method); return method.startsWith('Page.') ? new Promise(() => {}) : {}; };
    const preview = ext.command({ id: 2, method: 'preview', params: { sessionId: 'one', method: 'Page.startScreencast' } });
    const read = ext.command({ id: 3, method: 'cdp', params: { sessionId: 'one', method: 'Runtime.evaluate' } });
    assert.match((await preview).error, /实时画面无响应/);
    assert.equal((await read).error, undefined);
    assert.equal((await ext.command({ id: 4, method: 'control', params: { sessionId: 'one', action: 'release' } })).error, undefined);
    assert.equal((await ext.state()).sessionId, undefined);
    assert.ok(ext.calls.includes('detach'));
    assert.equal(ext.calls.includes('Page.stopScreencast'), false, 'release must detach without waiting for an unresponsive page');
  } finally { ext.close(); }
});

test('a hung screenshot leaves the same task in control and lets subsequent DOM reads proceed', { timeout: 2000 }, async () => {
  const ext = await extension(fetch, 0.005); ext.select(7); await ext.connect();
  try {
    await ext.command({ id: 1, method: 'claim', params: { sessionId: 'one' } });
    ext.chrome.debugger.sendCommand = async (_target, method) => {
      ext.calls.push(method);
      return method === 'Page.captureScreenshot' ? new Promise(() => {}) : { result: { value: 'Readable page' } };
    };
    const capture = ext.command({ id: 2, method: 'cdp', params: { sessionId: 'one', method: 'Page.captureScreenshot' } });
    const read = ext.command({ id: 3, method: 'cdp', params: { sessionId: 'one', method: 'Runtime.evaluate' } });
    assert.match((await capture).error, /截图无响应/);
    assert.equal((await read).result.result.value, 'Readable page');
    assert.equal((await ext.state()).ownership, 'agent');
    assert.equal((await ext.state()).sessionId, 'one');
    assert.equal((await ext.state()).pausedByBrowser, false);
    assert.equal(ext.calls.includes('detach'), false);
    await ext.handle('control', { sessionId: 'one', action: 'handoff' });
    await assert.rejects(ext.handle('cdp', { sessionId: 'one', method: 'Page.captureScreenshot' }), /用户正在/);
  } finally { ext.close(); }
});

test('automatic pairing only accepts the top-level loopback invitation and leaves Profile confirmation to the user', async () => {
  let fetched, saved, destination;
  const ext = await extension(async url => { fetched = url; return { ok: true, json: async () => ({ code: 'PP1.fixture', profileName: 'Daily', expiresAt: Date.now() + 10000 }) }; });
  ext.chrome.storage.session.set = async value => { saved = value; };
  ext.chrome.tabs.update = async (id, value) => { destination = { id, ...value }; };
  const url = `http://127.0.0.1:12345/profilepilot-connect/${'a'.repeat(48)}`;
  const sender = { id: NATIVE_EXTENSION_ID, url, frameId: 0, tab: { id: 9, incognito: false } };
  for (const bad of [{ ...sender, url: 'https://attacker.example' }, { ...sender, frameId: 1 }, { ...sender, tab: { id: 9, incognito: true } }]) {
    assert.equal(ext.message({ method: 'onboarding' }, bad, () => assert.fail('must not respond')), undefined);
  }
  assert.equal(fetched, undefined);
  const reply = await new Promise(resolve => ext.message({ method: 'onboarding' }, sender, resolve));
  assert.equal(reply.error, undefined);
  assert.equal(fetched, url + '/pair'); assert.equal(destination.id, 9);
  assert.ok(destination.url.startsWith(`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html#setup=`));
  assert.equal(destination.url.includes('PP1.'), false);
  assert.equal(Object.values(saved)[0].code, 'PP1.fixture');
  assert.equal((await ext.state()).connected, false);
  assert.deepEqual(ext.calls, [], 'detection must not attach to a user tab');
});
test('extension enforces session scope, handoff and browser stop while allowing full Chrome-supported CDP', async () => {
  const ext = await extension(); ext.select(7);
  await ext.handle('claim', { sessionId: 'one' });
  await assert.rejects(ext.handle('claim', { sessionId: 'two' }), /另一个任务/);
  await ext.handle('switch', { sessionId: 'one', tabId: 8 });
  await ext.handle('switch', { sessionId: 'one', tabId: 7 });
  await ext.handle('cdp', { sessionId: 'one', method: 'Network.enable' });
  await assert.rejects(ext.handle('cdp', { sessionId: 'one', method: 'not a method' }), /无效/);
  await ext.handle('control', { sessionId: 'one', action: 'handoff' });
  await assert.rejects(ext.handle('cdp', { sessionId: 'one', method: 'Input.insertText' }), /用户正在/);
  await assert.rejects(ext.handle('claim', { sessionId: 'one' }), /用户正在/);
  await ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration }); ext.detach();
  await assert.rejects(ext.handle('preview', { sessionId: 'one', method: 'Page.startScreencast' }), /已由你停止/);
  await assert.rejects(ext.handle('cdp', { sessionId: 'one', method: 'Input.insertText' }), /用户正在/);
  await ext.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await ext.state()).controlGeneration });
  await ext.handle('cdp', { sessionId: 'one', method: 'Input.insertText' });
  await ext.handle('control', { sessionId: 'one', action: 'complete' });
  assert.equal((await ext.state()).sessionId, undefined); assert.ok(ext.calls.includes('detach'));
  await ext.handle('claim', { sessionId: 'two' });
  assert.equal(ext.message({ method: 'connect' }, { id: NATIVE_EXTENSION_ID, url: 'https://attacker.test', tab: {} }, () => assert.fail()), undefined);
});
test('native tasks route without a logical port and never acquire after user takeover', async () => {
  const calls = [], state = { profileId: 'native:Default', taskTabs: true, tabId: 7, connected: true, ownerSessionId: 'task', ownership: 'user' };
  const bridge = { onEvent: () => () => {}, states: () => [state], request: async (...args) => { calls.push(args); return {}; } };
  const native = new NativeBrowser(bridge, os.tmpdir());
  const task = { profileId: state.profileId, sessionId: 'task', browserConnection: 'extension' };
  assert.equal(hasTaskBrowser(task), true);
  await assert.rejects(native.observe(task), /用户正在/); assert.equal(calls.length, 0);
  const routed = new RoutedBrowser({ tabs: async () => 'gateway' }, native);
  state.ownership = 'agent'; await routed.tabs(task); assert.equal(calls[0][1], 'tabs');
  assert.equal(await routed.tabs({ profileId: 'isolated:test', port: 9223 }), 'gateway');
});

test('a fresh blank task page is observed without waiting for a missing screenshot frame', async () => {
  const calls = [];
  const native = new NativeBrowser({ onEvent: () => () => {}, states: () => [], request: async (...args) => { calls.push(args); throw Error('Blank page has no compositor frame'); } }, os.tmpdir());
  native.fast.reobserve = async () => ({ url: 'about:blank', snapshot: '', fast: { candidates: [], guard: 'blank' } });
  const observation = await native.observe({ sessionId: 'new' }, true, true);
  assert.equal(observation.url, 'about:blank');
  assert.match(observation.snapshot, /空白任务页/);
  assert.equal(observation.screenshotDataUrl, undefined);
  assert.equal(calls.length, 0);
});

test('optional screenshot failure retains DOM, but a concurrent takeover or disconnect is not swallowed', async () => {
  const state = { profileId: 'native:Default', taskTabs: true, connected: true, ownership: 'agent', ownerSessionId: 'news' };
  const task = { profileId: state.profileId, sessionId: 'news' };
  let changeState = () => {}, requests = 0;
  const native = new NativeBrowser({ onEvent: () => () => {}, states: () => [state], request: async (_profile, method, params) => {
    assert.equal(method, 'cdp'); assert.equal(params.method, 'Page.captureScreenshot');
    requests++; changeState(); throw Error('Screenshot timed out');
  } }, os.tmpdir());
  native.fast.reobserve = async () => ({ url: 'https://fixture.test', snapshot: 'Readable page', fast: { candidates: [{ ref: 'e1' }], guard: 'page' } });
  native.fast.captureScreenshot = () => native.raw(task, 'Page.captureScreenshot', { format: 'png' });
  const observed = await native.observe(task, true);
  assert.match(observed.snapshot, /Readable page/); assert.match(observed.snapshot, /截图暂不可用/);
  assert.equal(observed.fast.candidates[0].ref, 'e1');
  assert.equal(observed.screenshotDataUrl, undefined); assert.equal(requests, 1);
  for (const mutation of [{ ownership: 'user' }, { connected: false }, { ownerSessionId: 'other' }, { pausedByBrowser: true }]) {
    Object.assign(state, { ownership: 'agent', connected: true, ownerSessionId: 'news', pausedByBrowser: false });
    changeState = () => Object.assign(state, mutation);
    await assert.rejects(native.observe(task, true), /Screenshot timed out/);
  }
});

test('task service preserves native ownership during pause, resume, cancellation and desktop shutdown', async () => {
  const { TaskStore } = require('../dist/main/tasks/store');
  const { TaskService } = require('../dist/main/tasks/service');
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-native-service-'));
  const store = new TaskStore(root), calls = [];
  const task = store.create({ profileId: 'native:Default', prompt: 'Read local fixture' }, 'Native');
  task.browserConnection = 'extension'; task.status = 'running';
  const service = new TaskService(store, { browser: { control: async (_t, action) => calls.push(action) }, profileName: async () => 'Native', prepareProfile: async () => ({ name: 'Native', browserConnection: 'extension' }), apiKey: () => '', changed: () => {}, notify: () => {}, closeBrowser: () => calls.push('close') });
  service.tick = async () => {};
  try {
    await service.control(task.id, 'takeover'); assert.equal(task.pending.kind, 'handoff');
    assert.deepEqual(calls, ['handoff']);
    await service.control(task.id, 'resume'); assert.equal(task.status, 'queued'); assert.equal(calls.at(-1), 'resume');
    task.status = 'running'; service.externalControl(task.sessionId, 'user', 'active', 'extension-takeover');
    assert.equal(task.status, 'waiting_user'); assert.equal(task.pending.kind, 'handoff');
    await service.close(); assert.deepEqual(calls.slice(-2), ['handoff', 'close']);
  } finally { await service.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); rmSync(root, { recursive: true, force: true }); }
});
