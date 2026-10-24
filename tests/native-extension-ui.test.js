const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const { NativeExtensionUi } = loadCli('src/main/native-control/extension-ui.ts');
const { NativeControlService } = loadCli('src/main/native-control/service.ts');
const { NATIVE_REQUIRED_CAPABILITIES } = loadCli('src/main/tasks/native-compatibility.ts');
const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const worker = new Function('fs', 'vm', `${source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"))}; return worker;`)(fs, vm);
const tick = () => new Promise(r => setImmediate(r));
const extensionId = 'a'.repeat(32);
function fixture(t, connect) {
  const state = { profileId: 'native:fixture', ownerSessionId: 'one', connected: true, ownership: 'agent', controlGeneration: 'g', capabilities: ['extensionUi', ...NATIVE_REQUIRED_CAPABILITIES], extensionVersion: '0.2.13', taskTabs: true };
  const binding = { targetId: 'page', tabId: 7, url: 'https://fixture.test/', generation: 'g' };
  const frame = { id: 'child', loaderId: 'child1', url: `chrome-extension://${extensionId}/frame.html` };
  const root = { id: 'page', loaderId: 'page1', url: binding.url };
  const calls = [];
  const client = { closed: false, onDisconnect: null, close() { this.closed = true; }, async send(method, p, _timeout, session) {
    calls.push({ method, p, session });
    if (method === 'Target.getTargetInfo') return { targetInfo: { ...binding, type: 'page' } };
    if (method === 'Target.attachToTarget') return { sessionId: p.targetId };
    if (method === 'Page.getFrameTree') return { frameTree: structuredClone(session === 'child' ? { frame } : { frame: root }) };
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'child', type: 'iframe', url: frame.url, parentId: 'page' }, { targetId: 'unrelated', type: 'iframe', url: frame.url, parentId: 'other-page' }] };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') return { result: { value: p.userGesture ? true : [{ index: 0, label: 'Other logins', role: 'button' }] } };
    throw Error(method);
  } };
  const bridge = { states: () => [state], onEvent: () => () => {}, async request(_profile, method) { calls.push({ method }); return { ...binding }; } };
  const ui = new NativeExtensionUi(bridge, { endpoint: async () => 'ws://127.0.0.1:1/devtools/browser/test', connect: connect || (async () => client) });
  t.after(() => ui.close());
  return { ui, state, binding, frame, root, client, calls, bridge };
}
test('extension mode maps exact tab target, refuses normal debugger and honors takeover', async t => {
  const w = await worker(); t.after(w.close);
  w.chrome.debugger.getTargets = async () => [{ id: 'exact', tabId: 7, type: 'page' }, { id: 'wrong', tabId: 8, type: 'page' }];
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  const params = { sessionId: 'one', token: 'a'.repeat(64) };
  await w.handle('extensionUi.begin', params);
  assert.equal((await w.handle('extensionUi.check', params)).targetId, 'exact');
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate' }), /扩展界面模式/);
  await assert.rejects(w.handle('extensionUi.check', { ...params, token: 'b'.repeat(64) }), /失效/);
  await w.ui({ method: 'takeover' });
  await assert.rejects(w.handle('extensionUi.check', params), /用户正在/);
});
test('connect returns while authorization is pending and cancellation closes a late socket', async t => {
  let resolve, signal;
  const f = fixture(t, (_url, _timeout, s) => { signal = s; return new Promise(r => { resolve = r; }); });
  assert.equal((await f.ui.start(f.state.profileId, 'one', extensionId)).stage, 'authorizing');
  f.ui.cancel('one'); assert.equal(signal.aborted, true);
  resolve(f.client); await tick();
  assert.equal(f.client.closed, true);
  assert.equal(f.calls.some(c => c.method === 'Target.attachToTarget'), false);
});
test('versioned clicks are consumed once; navigation and target replacement invalidate them', async t => {
  const f = fixture(t);
  await f.ui.start(f.state.profileId, 'one', extensionId); await tick();
  assert.equal(f.ui.status('one').stage, 'ready');
  let obs = await f.ui.observe('one');
  await f.ui.click('one', { version: obs.version, ref: 'x1' });
  await assert.rejects(f.ui.click('one', { version: obs.version, ref: 'x1' }), { code: 'NATIVE_OBSERVATION_STALE' });
  assert.equal(f.calls.filter(c => c.p?.userGesture).length, 1);
  assert.equal(f.calls.some(c => c.method === 'Target.attachToTarget' && c.p.targetId === 'unrelated'), false);
  obs = await f.ui.observe('one'); f.root.loaderId = 'new-page';
  // Simulate protocol serialization: an earlier observation owns its snapshot.
  f.ui.connections.get('one').rootFrame = { ...f.root, loaderId: 'page1' };
  await assert.rejects(f.ui.click('one', { version: obs.version, ref: 'x1' }), { code: 'NATIVE_OBSERVATION_STALE' });
  f.binding.targetId = 'replacement';
  await assert.rejects(f.ui.observe('one'), { code: 'NATIVE_OBSERVATION_STALE' });
  assert.equal(f.calls.filter(c => c.p?.userGesture).length, 1);
});
test('takeover before click prevents input, disconnect never silently reconnects', async t => {
  const f = fixture(t); await f.ui.start(f.state.profileId, 'one', extensionId); await tick();
  const obs = await f.ui.observe('one'); f.state.ownership = 'user';
  await assert.rejects(f.ui.click('one', { version: obs.version, ref: 'x1' }), { code: 'NATIVE_USER_IN_CONTROL' });
  assert.equal(f.calls.some(c => c.p?.userGesture), false);
  f.client.onDisconnect(); await tick();
  assert.equal(f.ui.status('one').stage, 'failed'); assert.equal(f.client.closed, true);
  await assert.rejects(f.ui.observe('one'), { code: 'NATIVE_EXTENSION_UI_NOT_READY' });
});
test('missing capability never attempts a connection or changes extension mode', async t => {
  const f = fixture(t); f.state.capabilities = [];
  await assert.rejects(f.ui.start(f.state.profileId, 'one', extensionId), { code: 'NATIVE_EXTENSION_UPDATE_REQUIRED' });
  assert.equal(f.calls.length, 0);
});
test('service blocks page route, publishes companion status, and cancels on handoff', async t => {
  const f = fixture(t), service = new NativeControlService(f.bridge, require('node:os').tmpdir());
  t.after(() => service.close());
  service.extensionUi.close(); service.extensionUi = f.ui;
  let id = 0; const request = (method, params = {}) => service.request({ requestId: `ui-${++id}`, method, params, sessionId: 'one' });
  await request('claim'); await request('extension-ui', { action: 'connect', extensionId }); await tick();
  assert.equal((await request('status')).sessions[0].extensionUi.stage, 'ready');
  await assert.rejects(request('cdp', { method: 'Runtime.evaluate' }), { code: 'NATIVE_EXTENSION_UI_ACTIVE' });
  await request('control', { action: 'handoff' });
  assert.equal(f.client.closed, true); assert.equal(f.ui.has('one'), false);
});
