const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { NativeControlService } = loadCli('src/main/native-control/service.ts');
const { FastBrowser } = loadCli('src/main/tasks/fast-browser.ts');
const workerText = fs.readFileSync('tests/native-control.test.js', 'utf8');
const worker = new Function('fs', 'vm', `${workerText.slice(workerText.indexOf('async function worker()'), workerText.indexOf("test('full-access"))}; return worker;`)(fs, vm);
const domText = fs.readFileSync('tests/browser-dom-semantics.test.js', 'utf8');
const pageFixture = new Function('vm', 'FastBrowser', `${domText.slice(domText.indexOf('function pageFixture()'), domText.indexOf('const action ='))}; return pageFixture;`)(vm, FastBrowser);

async function fixture(t) {
  const w = await worker(), listeners = new Set(), calls = [], frames = { root: pageFixture(), child: pageFixture() };
  frames.root.node('A', 'Read article', { href: '/article/1' }); frames.child.node('A', 'Child article', { href: '/article/2' });
  let state = { ...await w.state(), ownerSessionId: undefined }, suppressFrames = false, liveSession = 'old-child', beforeSnapshot;
  const emit = event => { for (const listener of listeners) listener(event); };
  const push = w.messages.push.bind(w.messages);
  w.messages.push = message => {
    push(message);
    if (message.type === 'state') {
      state = { ...message.state, ownerSessionId: message.state.sessionId };
      emit({ ...message, profileId: 'native:fixture', sessionId: state.ownerSessionId });
    } else if (message.type === 'cdp' && !(suppressFrames && message.method.startsWith('Target.'))) emit({ ...message, profileId: 'native:fixture' });
    return w.messages.length;
  };
  w.chrome.debugger.sendCommand = async (target, method, params = {}) => {
    calls.push({ target, method, params });
    if (target.sessionId && target.sessionId !== liveSession) throw Error('Session with given id not found');
    if (method === 'Target.setAutoAttach' && !target.sessionId && liveSession) {
      w.chrome.debugger.onEvent.fire({ tabId: 8 }, 'Target.attachedToTarget', { sessionId: liveSession, targetInfo: { type: 'iframe' } });
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: target.sessionId ? 'child' : 'root', parentId: target.sessionId ? 'root' : undefined, url: 'https://fixture.test/feed', loaderId: target.sessionId || 'root-document' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: target.sessionId ? 2 : 1 };
    if (method === 'Runtime.evaluate') return params.expression.includes('profilepilot-paint:') ? { result: { value: true } } : frames[target.sessionId ? 'child' : 'root'].evaluate(params.expression);
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 9 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments ? { x: params.arguments[0].value, y: params.arguments[1].value } : undefined } };
    return {};
  };
  const bridge = {
    states: () => [state], onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (_profile, method, params) => {
      if (method === 'cdp' && params.method === 'ProfilePilot.getFrameSessions') { calls.push({ method: params.method }); await beforeSnapshot?.(); }
      const result = await w.handle(method, params);
      if (['claim', 'control', 'switch'].includes(method)) {
        state = { ...await w.state(), ownerSessionId: (await w.state()).sessionId };
        emit({ type: 'state', state, profileId: 'native:fixture', sessionId: state.ownerSessionId });
      }
      return result;
    }
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-frame-recovery-'));
  const service = new NativeControlService(bridge, root);
  const request = (method, params = {}) => service.request({ method, params, profileId: 'native:fixture', sessionId: 'task', requestId: randomUUID() });
  t.after(() => { service.close(); w.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await request('claim', { tabId: 8 });
  const changeFrame = (next = 'new-child') => {
    suppressFrames = true;
    w.chrome.debugger.onEvent.fire({ tabId: 8 }, 'Target.detachedFromTarget', { sessionId: liveSession });
    liveSession = next;
    if (next) w.chrome.debugger.onEvent.fire({ tabId: 8 }, 'Target.attachedToTarget', { sessionId: next, targetInfo: { type: 'iframe' } });
    suppressFrames = false;
  };
  return { w, request, calls, frames, changeFrame, beforeSnapshot: fn => { beforeSnapshot = fn; }, bridge };
}

test('service observe/read repairs a missed child detach from the same owned extension snapshot once', async t => {
  const f = await fixture(t);
  const old = await f.request('observe'); f.changeFrame();
  const current = await f.request('read', { frameId: 'child' });
  assert.equal(current.page.frameId, 'child'); assert.equal(current.frames.length, 2);
  assert.notEqual(current.version, old.version);
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions').length, 1);
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 0);
  assert.equal((await f.w.state()).ownership, 'agent');
  await f.request('observe');
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions').length, 1, 'stale cache does not recur');
  assert.equal(f.w.calls.some(c => c === 'focus' || c[0] === 'update'), false);
});

test('service action never repairs or replays input on a stale child binding', async t => {
  const f = await fixture(t);
  const old = await f.request('read', { frameId: 'child' }); f.changeFrame();
  await assert.rejects(f.request('action', { kind: 'click', version: old.version, ref: old.fast.candidates[0].ref }), error => error.code === 'NATIVE_FRAME_SESSION_STALE');
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions' || c.method.startsWith('Input.')).length, 0);
  await f.request('observe');
  await assert.rejects(f.request('action', { kind: 'click', version: old.version, ref: old.fast.candidates[0].ref }), error => error.code === 'NATIVE_OBSERVATION_STALE');
});

test('frame recovery is bounded even when the new child also disappears', async t => {
  const f = await fixture(t); await f.request('observe'); f.changeFrame();
  const original = f.bridge.request;
  f.bridge.request = async (...args) => {
    const result = await original(...args);
    if (args[1] === 'cdp' && args[2].method === 'ProfilePilot.getFrameSessions') f.changeFrame('third-child');
    return result;
  };
  await assert.rejects(f.request('observe'), error => error.code === 'NATIVE_FRAME_SESSION_STALE' && error.recovery.actionOutcome === 'not-applicable');
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions').length, 1);
});

test('older extensions fail with update guidance before issuing unsupported recovery commands', async t => {
  const f = await fixture(t); await f.request('observe'); f.changeFrame();
  const states = f.bridge.states;
  f.bridge.states = () => states().map(state => ({ ...state, capabilities: state.capabilities.filter(value => value !== 'frameSessionSnapshot') }));
  await assert.rejects(f.request('observe'), error => error.code === 'NATIVE_EXTENSION_UPDATE_REQUIRED' && error.recovery.nextStep === 'repair-installation');
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions' || c.method.startsWith('Input.')).length, 0);
  assert.equal((await f.w.state()).ownership, 'agent');
});

test('a child session lost during input preserves unknown outcome and never retries the input', async t => {
  const f = await fixture(t), old = await f.request('read', { frameId: 'child' });
  const send = f.w.chrome.debugger.sendCommand;
  f.w.chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await send(target, method, params);
    if (target.sessionId && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') throw Error('Session with given id not found');
    return result;
  };
  await assert.rejects(f.request('action', { kind: 'click', version: old.version, ref: old.fast.candidates[0].ref }), error => error.code === 'NATIVE_FRAME_SESSION_STALE' && error.recovery.actionOutcome === 'unknown' && !error.recovery.automaticReplay);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'ProfilePilot.getFrameSessions').length, 0);
  assert.equal(f.w.calls.filter(c => c[0] === 'attach').length, 1);
});

test('takeover while frame recovery is pending prevents discovery and never resumes or claims', async t => {
  const f = await fixture(t); await f.request('observe'); f.changeFrame();
  f.beforeSnapshot(async () => { await f.request('control', { action: 'handoff' }); });
  const attaches = f.w.calls.filter(c => c[0] === 'attach').length;
  await assert.rejects(f.request('observe'), error => error.code === 'NATIVE_USER_IN_CONTROL');
  assert.equal((await f.w.state()).ownership, 'user');
  assert.equal(f.w.calls.filter(c => c[0] === 'attach').length, attaches);
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 0);
});

test('immediate service observe/action tolerates unrelated live content and preserves target guards', async t => {
  const f = await fixture(t), old = await f.request('observe');
  f.frames.root.doc.body.innerText = 'Unrelated timer 12:34'; f.frames.root.node('BUTTON', 'Another item');
  await f.request('action', { kind: 'click', version: old.version, ref: old.fast.candidates[0].ref });
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 2);
  const fresh = await f.request('observe'); f.frames.root.nodes[0].attrs.href = '/different-account';
  await assert.rejects(f.request('action', { kind: 'click', version: fresh.version, ref: fresh.fast.candidates[0].ref }), error => error.code === 'NATIVE_OBSERVATION_STALE');
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 2);
});

test('extension removes descendant sessions and keeps stale-frame failures separate from root reconnect', async t => {
  const f = await fixture(t); await f.request('observe');
  f.w.chrome.debugger.onEvent.fire({ tabId: 8, sessionId: 'old-child' }, 'Target.attachedToTarget', { sessionId: 'grandchild', targetInfo: { type: 'iframe' } });
  f.changeFrame();
  await assert.rejects(f.w.handle('cdp', { sessionId: 'task', cdpSessionId: 'grandchild', method: 'Runtime.evaluate' }), error => error.code === 'NATIVE_FRAME_SESSION_STALE');
  const result = await f.w.handle('cdp', { sessionId: 'task', method: 'ProfilePilot.getFrameSessions' });
  assert.deepEqual(Array.from(result.sessions, s => s.sessionId), ['new-child']);
  assert.equal(f.w.calls.filter(c => c[0] === 'attach').length, 1);
});
