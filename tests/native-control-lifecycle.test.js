const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { NativeControlService } = loadCli('src/main/native-control/service.ts');
const { nativeControlError } = loadCli('src/main/native-control/errors.ts');
const { NATIVE_REQUIRED_CAPABILITIES } = loadCli('src/main/tasks/native-compatibility.ts');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, intercept = async () => {}) {
  const states = ['native:first', 'native:second'].map(profileId => ({ profileId, connected: true,
    ownership: 'user', taskTabs: true, controlGeneration: 'fixture:0', extensionVersion: '0.2.1', capabilities: [...NATIVE_REQUIRED_CAPABILITIES] }));
  const calls = [];
  let listener;
  const bridge = {
    states: () => states,
    onEvent: handler => { listener = handler; return () => { listener = undefined; }; },
    request: async (profileId, method, params) => {
      calls.push({ profileId, method, params });
      await intercept(profileId, method, params);
      const state = states.find(item => item.profileId === profileId);
      if (method === 'claim') Object.assign(state, { ownership: 'agent', ownerSessionId: params.sessionId });
      if (method === 'control') {
        state.ownership = params.action === 'resume' ? 'agent' : 'user';
        if (['complete', 'release'].includes(params.action)) state.ownerSessionId = undefined;
      }
      return { method };
    }
  };
  // This service alone does not open sockets or write any discovery descriptor.
  const service = new NativeControlService(bridge, os.tmpdir());
  t.after(() => service.close());
  const request = (method, params = {}, extra = {}) => service.request({
    requestId: randomUUID(), method, params, sessionId: 'audit', profileId: states[0].profileId, ...extra
  });
  const publish = (patch, type = 'state') => {
    Object.assign(states[0], patch);
    listener?.({ type, profileId: states[0].profileId, sessionId: states[0].ownerSessionId,
      ...(type === 'state' ? { state: { ...states[0] } } : {}) });
  };
  return { service, request, calls, states, publish };
}

test('complete and release invalidate a resume queued behind active page work', async t => {
  for (const action of ['complete', 'release']) await t.test(action, async t => {
    const started = deferred(), finish = deferred();
    const { service, request, calls, states } = fixture(t, async (_profile, method) => {
      if (method === 'cdp') { started.resolve(); await finish.promise; }
    });
    await request('claim');
    const work = request('cdp', { method: 'Runtime.evaluate', params: { expression: 'busy' } });
    await started.promise;
    const resumed = assert.rejects(request('control', { action: 'resume' }), error =>
      error.code === 'NATIVE_SESSION_CONFLICT' && nativeControlError(error).exitCode === 75);
    await request('control', { action });
    assert.equal(states[0].ownership, 'user');
    assert.equal(service.ownsSession(states[0].profileId, 'audit'), false);
    finish.resolve();
    await Promise.all([work, resumed]);
    assert.equal(calls.filter(call => call.method === 'control' && call.params.action === 'resume').length, 0);
    assert.equal(states[0].ownership, 'user');
  });
});

test('handoff invalidates prior queued resume while an explicitly later resume remains usable', async t => {
  const started = deferred(), finish = deferred();
  const { request, calls, states } = fixture(t, async (_profile, method) => {
    if (method === 'cdp') { started.resolve(); await finish.promise; }
  });
  await request('claim');
  const work = request('cdp', { method: 'Runtime.evaluate' });
  await started.promise;
  const oldResume = assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_USER_IN_CONTROL' });
  await request('control', { action: 'handoff' });
  finish.resolve();
  await Promise.all([work, oldResume]);
  assert.equal(states[0].ownership, 'user');
  await request('control', { action: 'resume' });
  assert.equal(states[0].ownership, 'agent');
  assert.equal(calls.filter(call => call.method === 'control' && call.params.action === 'resume').length, 1);
});

test('UI control loss and disconnect invalidate old queued resume, not later authorization or repeated user state', async t => {
  for (const loss of ['takeover', 'disconnect']) await t.test(loss, async t => {
    const started = deferred(), finish = deferred();
    const { request, calls, publish, states } = fixture(t, async (_profile, method) => {
      if (method === 'cdp') { started.resolve(); await finish.promise; }
    });
    await request('claim');
    const work = request('cdp', { method: 'Runtime.evaluate' });
    await started.promise;
    const oldResume = assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_USER_IN_CONTROL' });
    if (loss === 'disconnect') {
      publish({ connected: false, ownership: 'user' }, 'disconnected');
      publish({ connected: true, ownership: 'user', ownerSessionId: 'audit' });
    } else publish({ ownership: 'user' });
    const freshResume = request('control', { action: 'resume' });
    publish({ ownership: 'user' });
    publish({ ownership: 'user' });
    finish.resolve();
    await Promise.all([work, oldResume, freshResume]);
    assert.equal(states[0].ownership, 'agent');
    assert.equal(calls.filter(call => call.method === 'control' && call.params.action === 'resume').length, 1);
  });
});

test('concurrent termination and old receipt replay cannot delete a same-name new session', async t => {
  const started = deferred(), finish = deferred();
  const { service, request, calls, states } = fixture(t, async (_profile, method, params) => {
    if (method === 'control' && params.action === 'complete') { started.resolve(); await finish.promise; }
  });
  await request('claim');
  const oldSession = service.sessions.get('audit');
  const first = request('control', { action: 'complete' }, { requestId: 'old-complete' });
  await started.promise;
  const second = request('control', { action: 'release' }, { requestId: 'old-release' });
  await assert.rejects(request('claim'), /已经存在/);
  await assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_SESSION_CONFLICT' });
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.filter(call => call.method === 'control').length, 1, 'termination joins one extension command');
  await request('claim');
  const freshSession = service.sessions.get('audit');
  assert.notEqual(freshSession, oldSession);
  await request('control', { action: 'complete' }, { requestId: 'old-complete' });
  await request('control', { action: 'release' }, { requestId: 'old-release' });
  assert.equal(service.sessions.get('audit'), freshSession);
  assert.equal(states[0].ownership, 'agent');
  assert.equal(calls.filter(call => call.method === 'control').length, 1);
});

test('each explicit stop invalidates queued resume even while ownership was already user', async t => {
  for (const generation of ['fixture:2', 'restarted-worker:0']) await t.test(generation, async t => {
    const started = deferred(), finish = deferred();
    const { request, calls, publish, states } = fixture(t, async (_profile, method) => {
      if (method === 'cdp') { started.resolve(); await finish.promise; }
    });
    await request('claim');
    const work = request('cdp', { method: 'Runtime.evaluate' });
    await started.promise;
    publish({ ownership: 'user', controlGeneration: 'fixture:1' });
    const stale = assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_USER_IN_CONTROL' });
    publish({ ownership: 'user', controlGeneration: generation });
    finish.resolve(); await Promise.all([work, stale]);
    assert.equal(states[0].ownership, 'user');
    assert.equal(calls.filter(call => call.params.action === 'resume').length, 0);
    await request('control', { action: 'resume' });
    assert.equal(calls.at(-1).params.controlGeneration, generation);
    assert.equal(states[0].ownership, 'agent');
  });
});

test('legacy extension can claim and stop, but cannot silently resume without stop generations', async t => {
  const { request, states, calls } = fixture(t);
  delete states[0].controlGeneration;
  await request('claim');
  await request('control', { action: 'handoff' });
  await assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_EXTENSION_UPDATE_REQUIRED' });
  assert.equal(calls.some(call => call.params.action === 'resume'), false);
  await request('control', { action: 'release' });
  assert.equal(states[0].ownerSessionId, undefined);
});

test('offline termination keeps cleanup identity until explicit release after reconnect', async t => {
  for (const action of ['complete', 'release']) await t.test(action, async t => {
    const { service, request, states, publish, calls } = fixture(t);
    await request('claim');
    publish({ connected: false, ownership: 'user' }, 'disconnected');
    const failed = { requestId: `offline-${action}` };
    await assert.rejects(request('control', { action }, failed), error =>
      error.code === 'NATIVE_DISCONNECTED' && nativeControlError(error).exitCode === 69);
    assert.equal(service.ownsSession(states[0].profileId, 'audit'), true);
    assert.equal((await request('status')).sessions[0].ending, true);
    assert.equal(calls.filter(call => call.method === 'control').length, 0);
    publish({ connected: true, ownership: 'user', controlGeneration: 'fixture:1' });
    await assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_SESSION_CONFLICT' });
    await assert.rejects(request('control', { action }, failed), { code: 'NATIVE_DISCONNECTED' });
    await request('control', { action: 'release' });
    assert.equal(service.sessions.size, 0);
    assert.equal(states[0].ownerSessionId, undefined);
    assert.deepEqual(calls.filter(call => call.method === 'control').map(call => call.params.action), ['release']);
    await request('claim', {}, { sessionId: 'next-task' });
    assert.equal(states[0].ownerSessionId, 'next-task');
  });
});

test('a late failed claim cannot delete a newer same-name session on another profile', async t => {
  const started = deferred(), finish = deferred();
  const { service, request, states } = fixture(t, async (profile, method) => {
    if (method === 'claim' && profile === 'native:first') { started.resolve(); await finish.promise; }
  });
  const first = assert.rejects(request('claim'), /old attach failed/);
  await started.promise;
  await request('control', { action: 'complete' });
  await request('claim', {}, { profileId: 'native:second' });
  const current = service.sessions.get('audit');
  finish.reject(new Error('old attach failed'));
  await first;
  assert.equal(service.sessions.get('audit'), current);
  assert.equal(service.ownsSession(states[1].profileId, 'audit'), true);
});

test('failed termination keeps a stoppable reservation and never reopens queued work', async t => {
  const { service, request, calls } = fixture(t, async (_profile, method, params) => {
    if (method === 'control' && params.action === 'complete') throw new Error('fixture transport failed');
  });
  await request('claim');
  await assert.rejects(request('control', { action: 'complete' }, { requestId: 'failed-complete' }), /transport failed/);
  assert.equal(service.sessions.size, 1);
  await assert.rejects(request('control', { action: 'resume' }), { code: 'NATIVE_SESSION_CONFLICT' });
  await assert.rejects(request('cdp', { method: 'Input.insertText' }), { code: 'NATIVE_SESSION_CONFLICT' });
  await request('control', { action: 'release' });
  assert.equal(service.sessions.size, 0);
  await assert.rejects(request('control', { action: 'complete' }, { requestId: 'failed-complete' }), /transport failed/);
  assert.deepEqual(calls.filter(call => call.method === 'control').map(call => call.params.action), ['complete', 'release']);
});

test('late claim failure retains a reservation while its termination is still in flight', async t => {
  const claiming = deferred(), finishClaim = deferred(), stopping = deferred(), finishStop = deferred();
  const { service, request } = fixture(t, async (_profile, method) => {
    if (method === 'claim') { claiming.resolve(); await finishClaim.promise; }
    if (method === 'control') { stopping.resolve(); await finishStop.promise; }
  });
  const claim = assert.rejects(request('claim'), /attach failed/);
  await claiming.promise;
  const complete = request('control', { action: 'complete' });
  await stopping.promise;
  finishClaim.reject(new Error('attach failed'));
  await claim;
  assert.equal(service.sessions.size, 1, 'same name stays reserved until the old control finishes');
  await assert.rejects(request('claim', {}, { profileId: 'native:second' }), /已经存在/);
  finishStop.resolve();
  await complete;
  assert.equal(service.sessions.size, 0);
});

test('long-running status polling stays bounded without consuming action receipts', async t => {
  const { service, request, calls } = fixture(t);
  await request('claim');
  for (let index = 0; index < 11000; index++) await request('status', {}, { requestId: `poll-${index}` });
  assert.equal(service.receipts.size, 1);
  assert.ok(service.statusReceipts.size <= 256);
  await request('cdp', { method: 'Input.insertText', params: { text: 'once' } }, { requestId: 'edit' });
  for (let index = 0; index < 300; index++) await request('status');
  await request('cdp', { method: 'Input.insertText', params: { text: 'once' } }, { requestId: 'edit' });
  assert.equal(calls.filter(call => call.method === 'cdp').length, 1);
  await request('control', { action: 'complete' });
});

test('full action ledger keeps diagnostics and shutdown usable without evicting side effects', async t => {
  const { service, request, calls, states } = fixture(t);
  await request('claim');
  const edit = { method: 'Input.insertText', params: { text: 'once' } };
  for (let index = 0; index < 9999; index++) await request('cdp', edit, { requestId: `edit-${index}` });
  assert.equal(service.receipts.size, 10000);
  const before = calls.length;
  await assert.rejects(request('cdp', edit), { code: 'NATIVE_REQUEST_CAPACITY' });
  await request('cdp', edit, { requestId: 'edit-0' });
  assert.equal(calls.length, before, 'old side effects remain cached at capacity');
  assert.equal((await request('status')).sessions.length, 1);
  await request('control', { action: 'handoff' }, { requestId: 'stop-at-cap' });
  assert.equal(states[0].ownership, 'user');
  await request('control', { action: 'release' }, { requestId: 'release-at-cap' });
  assert.equal((await request('status')).sessions.length, 0);
  const after = calls.length;
  await request('control', { action: 'handoff' }, { requestId: 'stop-at-cap' });
  await request('control', { action: 'release' }, { requestId: 'release-at-cap' });
  await request('cdp', edit, { requestId: 'edit-0' });
  assert.equal(calls.length, after, 'shutdown/action replays never reach the browser');
  await assert.rejects(request('cdp', { method: 'Input.insertText', params: { text: 'different' } }, { requestId: 'edit-0' }), /requestId/);
  await assert.rejects(request('claim'), { code: 'NATIVE_REQUEST_CAPACITY' });
  await assert.rejects(request('control', { action: 'release' }), error =>
    nativeControlError(error).code === 'NATIVE_SESSION_CONFLICT');
  assert.equal(service.receipts.size, 10002, 'missing-session shutdown errors do not grow the full ledger');
});

test('claim validates newTab before reserving a session or touching the browser', async t => {
  const { service, request, calls } = fixture(t);
  for (const newTab of ['true', 'false', 1, 0, null, [], {}]) {
    await assert.rejects(request('claim', { newTab }), error =>
      error.code === 'NATIVE_INVALID_REQUEST' && nativeControlError(error).exitCode === 64);
    assert.equal(service.sessions.size, 0);
    assert.equal(calls.length, 0);
  }
  for (const newTab of [true, false]) {
    await request('claim', { newTab });
    assert.equal(calls.at(-1).params.newTab, newTab);
    await request('control', { action: 'release' });
  }
});
