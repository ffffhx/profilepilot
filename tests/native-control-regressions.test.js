require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { NativeControlService } = require('../src/main/native-control/service.ts');
const { nativeControlError } = require('../src/main/native-control/errors.ts');
const { NATIVE_REQUIRED_CAPABILITIES } = require('../src/main/tasks/native-compatibility.ts');
const { domControlEffect } = require('../src/main/tasks/fast-browser.ts');

async function fixture(t) {
  const state = { profileId: 'native:fixture', connected: true, ownership: 'user', taskTabs: true,
    extensionVersion: '0.2.1', capabilities: [...NATIVE_REQUIRED_CAPABILITIES] };
  const calls = [];
  let navigation = { frameId: 'frame', loaderId: 'new-document' };
  const bridge = { states: () => [state], onEvent: () => () => {}, request: async (_profile, method, params) => {
    calls.push({ method, params });
    if (method === 'claim') Object.assign(state, { ownership: 'agent', ownerSessionId: params.sessionId });
    return ['open', 'newTab', 'switch'].includes(method) ? navigation : {};
  } };
  const service = new NativeControlService(bridge, os.tmpdir());
  t.after(() => service.close());
  const request = (method, params = {}, extra = {}) => service.request({ requestId: randomUUID(), method, params, sessionId: 'audit', ...extra });
  await request('claim');
  return { service, request, calls, state, setNavigation: value => { navigation = value; } };
}

test('direct observations omit internal guards but retain exact links and server-side action checks', async t => {
  const { service, request } = await fixture(t);
  const guard = 'private DOM guard '.repeat(2000);
  const observation = { version: 'version-1', snapshot: 'Release notes', url: 'https://example.test/releases',
    page: { nextCursor: 'next-page', totalControls: 1, totalText: 13 },
    fast: { guard, native: { localGuard: guard }, slice: { query: 'release' }, candidates: [
      { ref: 'e1', kind: 'click', role: 'link', label: 'Release', href: 'https://example.test/releases?version=2#notes',
        dom: { tag: 'A', search: false } }
    ] } };
  service.browser.observe = async () => observation;
  service.browser.execute = async task => {
    assert.equal(task.observation.fast.guard, guard);
    assert.equal(task.observation.fast.native.localGuard, guard);
    return 'verified';
  };
  const result = await request('observe');
  assert.equal(result.fast.guard, undefined);
  assert.equal(result.fast.native, undefined);
  assert.equal(result.fast.candidates[0].dom, undefined);
  assert.equal(result.fast.candidates[0].href, observation.fast.candidates[0].href);
  assert.equal(result.page.nextCursor, 'next-page');
  assert.ok(JSON.stringify(result).length < 1000);
  assert.equal(await request('action', { kind: 'click', ref: 'e1', version: result.version }), 'verified');
  await assert.rejects(request('action', { kind: 'click', ref: 'e1', version: result.version }), error => error.code === 'NATIVE_OBSERVATION_STALE');
});

test('compact observations retain ambiguous destructive button semantics without exposing or mutating guards', async t => {
  const { service, request } = await fixture(t);
  const candidate = { ref: 'e1', kind: 'click', role: 'button', label: 'OK',
    dom: { tag: 'BUTTON', type: 'button', search: false, popup: false, toggle: false, download: false, command: 'delete' } };
  candidate.dom.effect = domControlEffect(candidate);
  const observation = { version: 'delete-button', snapshot: 'Controls:\n- button "OK" [ref=e1]',
    fast: { document: 'document', guard: 'private-guard', native: { localGuard: 'private-local-guard' }, candidates: [candidate] } };
  service.browser.observe = async () => observation;
  service.browser.execute = async task => {
    assert.equal(task.observation.fast.candidates[0].dom.effect, 'delete');
    assert.equal(task.observation.fast.guard, 'private-guard');
    assert.equal(task.observation.fast.native.localGuard, 'private-local-guard');
    return 'verified';
  };
  const result = await request('observe');
  assert.deepEqual(result.fast.candidates[0].semantics, { effect: 'delete', enterEffect: undefined,
    search: false, popup: false, toggle: false, download: false, command: 'delete' });
  assert.equal(result.fast.candidates[0].dom, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-guard|private-local-guard/);
  result.fast.candidates[0].semantics.effect = 'read';
  assert.equal(await request('action', { kind: 'click', ref: 'e1', version: result.version }), 'verified');
});

test('semantic navigation clears old read state on success and on committed error documents', async t => {
  const { service, request, setNavigation } = await fixture(t);
  const resets = [];
  service.browser.resetObservation = task => { task.observation = undefined; resets.push(task.sessionId); };
  service.browser.observe = async () => ({ version: 'old-filter', snapshot: 'filtered old page' });
  await request('observe');
  await request('open', { url: 'https://example.test/new?q=full#section' });
  assert.deepEqual(resets, ['audit']);
  await assert.rejects(request('action', { kind: 'scroll', version: 'old-filter' }), error => error.code === 'NATIVE_OBSERVATION_STALE');
  setNavigation({ frameId: 'frame', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  await assert.rejects(request('open', { url: 'https://missing.invalid/' }), error =>
    error.code === 'NATIVE_BROWSER_ERROR' && nativeControlError(error).exitCode === 1 && /ERR_NAME_NOT_RESOLVED/.test(error.message));
  assert.equal(resets.length, 2);
  setNavigation({});
  await request('newTab');
  await request('switch', { tabId: 12 });
  assert.equal(resets.length, 4);
});

test('invalid methods and navigation inputs are input errors before session lookup or browser commands', async t => {
  const { request, calls } = await fixture(t);
  const before = calls.length;
  for (const [method, params, extra] of [
    ['unknown-version-method', {}, { sessionId: undefined }], ['open', {}],
    ['open', { url: 'file:///private.txt' }], ['open', { url: 'https://user:secret@example.test/' }],
    ['switch', { tabId: null }], ['switch', { tabId: -1 }], ['observe', []]
  ]) await assert.rejects(request(method, params, extra), error => error.code === 'NATIVE_INVALID_REQUEST' && nativeControlError(error).exitCode === 64);
  assert.equal(calls.length, before);
});

test('direct screenshots use the stabilized browser capture instead of raw CDP', async t => {
  const { service, request, calls } = await fixture(t);
  let captured;
  service.browser.screenshot = async (task, params) => { captured = { session: task.sessionId, params }; return { data: 'image' }; };
  assert.deepEqual(await request('screenshot', { format: 'png' }), { data: 'image' });
  assert.deepEqual(captured, { session: 'audit', params: { format: 'png' } });
  assert.equal(calls.some(c => c.method === 'cdp'), false);
});
