import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeExtensionHost } from '../benchmarks/agent-tasks/lib/live-sites.mjs';

const PROFILE = 'native:synthetic-private-profile', SESSION = 'pp-eval-live-host-test';
const URL = 'https://github.com/settings/profile';
const page = overrides => ({ url: URL, readyState: 'complete', login: 'synthetic-account', profileForm: true,
  browserVersion: '156.0.8078.81', browserVersionSource: 'user-agent-client-hints',
  viewport: { width: 1280, height: 804, deviceScaleFactor: 1 }, locale: 'zh-CN', timezone: 'Asia/Shanghai', ...overrides });

function fixture(options = {}) {
  const data = { commands: [], current: { profileId: PROFILE, connected: true, ownership: 'user', controlGeneration: 'test:1', extensionVersion: '0.2.0' }, clock: 0, observations: [...(options.observations || [page()])] };
  const invoke = async (args, params) => {
    data.commands.push({ args, params });
    if (args[0] === 'status') return { profiles: [{ ...data.current }] };
    if (args[0] === 'claim') {
      if (options.hangClaim) return new Promise(() => {});
      data.current = { ...data.current, ownerSessionId: SESSION, ownership: 'agent', controlGeneration: 'test:2', tabId: 42 };
      if (options.claimTakeover) data.current.ownership = 'user';
      if (options.claimError) throw options.claimError;
      return { sessionId: SESSION, profileId: PROFILE, state: { ...data.current } };
    }
    if (args[0] === 'open') return { frameId: 'frame' }; // Page.navigate has not committed yet.
    if (args[0] === 'cdp') {
      assert.deepEqual(args, ['cdp', 'Runtime.evaluate']);
      assert.equal(params.awaitPromise, true);
      assert.equal(params.returnByValue, true);
      assert.match(params.expression, /getHighEntropyValues\(\['fullVersionList','uaFullVersion'\]\)/);
      assert.ok(params.expression.includes("document.querySelector('#user_display_name, #user_profile_name')"));
      assert.equal(params.expression.includes('localStorage'), false);
      assert.equal(params.expression.includes('document.cookie'), false);
      const value = data.observations.length > 1 ? data.observations.shift() : data.observations[0];
      if (options.takeoverDuringObserve) data.current.ownership = 'user';
      return { result: { type: 'string', value: JSON.stringify(value) } };
    }
    if (args[0] === 'complete') {
      if (!options.retainAfterComplete) data.current = { ...data.current, ownerSessionId: undefined, ownership: 'user', controlGeneration: 'test:3' };
      if (options.completeError) throw options.completeError;
      return { state: { ...data.current } };
    }
    throw Error(`Unexpected operation ${args[0]}`);
  };
  const host = makeExtensionHost({ repoRoot: path.resolve('.'), profileId: PROFILE, sessionId: SESSION, privateDir: path.resolve('unused-private-dir'),
    invoke, now: () => data.clock, sleep: async ms => { data.clock += ms; }, commandTimeoutMs: options.commandTimeoutMs || 1000 });
  return { host, data, count: command => data.commands.filter(item => item.args[0] === command).length };
}

test('normal idle user ownership can claim; completion releases only the established session', async () => {
  const f = fixture();
  assert.deepEqual(await f.host.claim(), { tabId: 42, generation: 'test:2' });
  await f.host.close(); await f.host.close();
  assert.equal(f.count('claim'), 1); assert.equal(f.count('complete'), 1);
  assert.equal(f.data.commands.some(item => ['resume', 'release', 'close'].includes(item.args[0])), false);
});

test('existing owner, pause and technical control issues cannot be claimed around', async () => {
  for (const overrides of [{ ownerSessionId: 'other-session' }, { pausedByBrowser: true }, { controlIssue: { code: 'NATIVE_DEBUGGER_DETACHED' } }]) {
    const f = fixture(); Object.assign(f.data.current, overrides);
    await assert.rejects(f.host.claim(), /occupied|requires user control/);
    assert.equal(f.count('claim'), 0);
    await f.host.close(); assert.equal(f.count('complete'), 0);
  }
});

test('navigation happens once while readiness waits for the new authenticated document', async () => {
  const f = fixture({ observations: [page({ url: 'about:blank', profileForm: false, login: '' }), page({ readyState: 'loading', profileForm: false }), page({ readyState: 'interactive', profileForm: false }), page()] });
  await f.host.claim();
  const observed = await f.host.waitObserved(URL, { requireProfileForm: true });
  assert.equal(observed.browserVersion, '156.0.8078.81');
  assert.equal(f.count('open'), 1); assert.equal(f.count('cdp'), 5);
  await f.host.close();
});

test('ready pages wait through two geometry changes until observations agree without navigating again', async () => {
  const initial = { width: 1280, height: 900, deviceScaleFactor: 1 };
  const infobar = { width: 1280, height: 853, deviceScaleFactor: 1 };
  const settled = { width: 1280, height: 804, deviceScaleFactor: 1 };
  const f = fixture({ observations: [page({ viewport: initial }), page({ viewport: infobar }), page({ viewport: settled }), page({ viewport: settled })] });
  await f.host.claim();
  const observed = await f.host.waitObserved(URL, { requireProfileForm: true });
  assert.deepEqual(observed.viewport, settled);
  assert.equal(f.count('cdp'), 4); assert.equal(f.data.clock, 750); assert.equal(f.count('open'), 1);
  await f.host.close();
});

test('an intervening loading document resets stability, and browser version changes need fresh confirmation', async () => {
  const f = fixture({ observations: [page(), page({ readyState: 'loading' }), page(), page({ browserVersion: '156.0.8078.82' }), page({ browserVersion: '156.0.8078.82' })] });
  await f.host.claim();
  assert.equal((await f.host.waitObserved(URL)).browserVersion, '156.0.8078.82');
  assert.equal(f.count('cdp'), 5); assert.equal(f.data.clock, 1000); assert.equal(f.count('open'), 1);
  await f.host.close();
});

test('a single ready observation cannot bypass the overall readiness deadline', async () => {
  const f = fixture(); await f.host.claim();
  await assert.rejects(f.host.waitObserved(URL, { timeoutMs: 200 }), /deadline/);
  assert.equal(f.count('cdp'), 1); assert.equal(f.data.clock, 200); assert.equal(f.count('open'), 1);
  await f.host.close();
});

test('old completed page during a second navigation is not mistaken for a login redirect', async () => {
  const issue = 'https://github.com/microsoft/TypeScript/issues/1';
  const f = fixture({ observations: [page(), page(), page(), page({ url: issue, readyState: 'loading' }), page({ url: issue })] });
  await f.host.claim(); await f.host.waitObserved(URL, { requireProfileForm: true });
  assert.equal((await f.host.waitObserved(issue)).url, issue);
  assert.equal(f.count('open'), 2);
  await f.host.close();
});

test('stable login redirect fails promptly without credential, resume or repeated navigation actions', async () => {
  const f = fixture({ observations: [page({ url: 'https://github.com/login', readyState: 'loading' }), page({ url: 'https://github.com/login' }), page({ url: 'https://github.com/login' })] });
  await f.host.claim();
  await assert.rejects(f.host.waitObserved(URL, { requireProfileForm: true }), /redirected/);
  assert.equal(f.count('open'), 1); assert.equal(f.data.clock, 500);
  assert.equal(f.data.commands.some(item => ['fill', 'action', 'resume'].includes(item.args[0])), false);
  await f.host.close();
});

test('readiness has an overall deadline and a reduced UA cannot substitute for full version evidence', async () => {
  const f = fixture({ observations: [page({ readyState: 'loading', profileForm: false })] });
  await f.host.claim();
  await assert.rejects(f.host.waitObserved(URL, { requireProfileForm: true, timeoutMs: 500 }), /deadline/);
  assert.equal(f.data.clock, 500); assert.equal(f.count('open'), 1); await f.host.close();
  const reduced = fixture({ observations: [page({ browserVersion: null, userAgent: 'Chrome/156.0.0.0' })] });
  await reduced.host.claim();
  await assert.rejects(reduced.host.waitObserved(URL), /Full Chrome version is unavailable/);
  await reduced.host.close();
});

test('uncertain claim that acquired this session is reconciled without claim replay, then safely completed', async () => {
  const f = fixture({ claimError: { code: 'NATIVE_DISCONNECTED', recovery: { actionOutcome: 'unknown', requiresUser: false } } });
  await assert.rejects(f.host.claim(), error => {
    assert.equal(error.details.claimOutcome, 'held'); assert.equal(error.details.cleanupRequired, true);
    assert.equal(error.controlCode, 'NATIVE_DISCONNECTED'); return true;
  });
  await f.host.close();
  assert.equal(f.count('claim'), 1); assert.equal(f.count('complete'), 1);
});

test('takeover after an uncertain claim or during observation is retained for explicit reconciliation', async () => {
  const f = fixture({ claimTakeover: true, claimError: { code: 'NATIVE_USER_IN_CONTROL' } });
  await assert.rejects(f.host.claim());
  await assert.rejects(f.host.close(), error => error.details.cleanupRequired === true);
  assert.equal(f.count('complete'), 0);
  const observed = fixture({ takeoverDuringObserve: true });
  await observed.host.claim(); await assert.rejects(observed.host.observe(), /ownership changed/);
  await assert.rejects(observed.host.close(), /ownership changed/);
  assert.equal(observed.count('complete'), 0);
});

test('completion response loss reconciles release; unresolved completion is never replayed automatically', async () => {
  const error = { code: 'NATIVE_DISCONNECTED', recovery: { actionOutcome: 'unknown' } };
  const released = fixture({ completeError: error });
  await released.host.claim(); await released.host.close(); await released.host.close();
  assert.equal(released.count('complete'), 1);
  const retained = fixture({ completeError: error, retainAfterComplete: true });
  await retained.host.claim(); await assert.rejects(retained.host.close()); await assert.rejects(retained.host.close(), /unconfirmed/);
  assert.equal(retained.count('complete'), 1);
});

test('generation changes stop cleanup and structured errors omit private Profile/page text', async () => {
  const f = fixture(); await f.host.claim(); f.data.current.controlGeneration = 'test:9';
  await assert.rejects(f.host.close(), /ownership changed/); assert.equal(f.count('complete'), 0);
  const privateValue = 'private-profile https://github.com/private-page?token=private';
  const failed = fixture({ claimError: { stderr: JSON.stringify({ ok: false, code: 'NATIVE_USER_IN_CONTROL', error: privateValue, recovery: { actionOutcome: 'not-executed', requiresUser: true, instruction: privateValue } }) } });
  await assert.rejects(failed.host.claim(), error => {
    assert.equal(error.controlCode, 'NATIVE_USER_IN_CONTROL'); assert.equal(error.details.requiresUser, true);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(privateValue), false);
    assert.equal(JSON.stringify(error).includes(PROFILE), false); return true;
  });
  await failed.host.close();
});

test('a stuck CLI boundary is bounded even when no response arrives', async () => {
  const f = fixture({ hangClaim: true, commandTimeoutMs: 15 });
  await assert.rejects(f.host.claim(), error => error.controlCode === 'HOST_COMMAND_TIMEOUT');
  assert.equal(f.count('claim'), 1); await f.host.close(); assert.equal(f.count('complete'), 0);
});
