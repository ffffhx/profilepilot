import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { hash } from '../benchmarks/agent-tasks/lib/contracts.mjs';
import { LIVE_TASKS, extractGithubFacts, gradeLiveFacts, prepareLiveScenario } from '../benchmarks/agent-tasks/lib/live-sites.mjs';

const IDENTITY = 'synthetic-eval-account';
const PROFILE_ID = 'private-native-test-profile';
const POLICY = { controlPolicy: 'read-only', rejectedMutations: 0 };
const ACCOUNT_FACTS = { login: IDENTITY, name: 'Private oracle name sentinel', bio: 'Private oracle biography sentinel', location: 'Private oracle location sentinel' };
const ISSUE_FACTS = { number: 1, title: 'Private oracle issue title sentinel', state: 'closed', user: { login: 'synthetic-issue-author' }, labels: [{ name: 'test-zeta' }, { name: 'test-alpha' }], html_url: 'https://github.com/microsoft/TypeScript/issues/1' };

function setup(taskId = 'live-github-account-review') {
  const definition = LIVE_TASKS.find(task => task.id === taskId);
  const environment = {
    schemaVersion: '1.0.0', track: 'live-site', siteId: 'github', startUrl: definition.url, allowedOrigins: ['https://github.com'],
    profile: { strategy: 'reuse', binding: 'github-eval-profile' },
    login: { state: 'preauthenticated', accountAlias: 'github-eval-account', maxEvidenceAgeSeconds: 300 },
    transport: { kind: 'extension', extension: { id: 'abcdefghijklmnopabcdefghijklmnop', version: '1.2.3' } },
    platform: { os: process.platform, arch: process.arch, release: os.release() }, browser: { name: 'chrome', version: '156.0.8000.42', mode: 'headed' },
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, locale: 'zh-CN', timezone: 'Asia/Shanghai',
    network: { mode: 'direct', egressAlias: 'test-direct' },
    taskData: { strategy: 'read-only', namespace: taskId, authReset: 'forbidden' }, cleanup: { taskData: 'retain', profile: 'retain' },
  };
  const bindings = { profiles: { 'github-eval-profile': PROFILE_ID }, accounts: { 'github-eval-account': { siteId: 'github', identitySha256: hash(IDENTITY.toLowerCase()) } } };
  const attestation = { checkedAt: new Date().toISOString(), extensionId: environment.transport.extension.id, network: structuredClone(environment.network) };
  const state = { factories: [], claims: 0, closes: 0, waits: [], observations: 0, fetches: [], facts: structuredClone(taskId === 'live-github-account-review' ? ACCOUNT_FACTS : ISSUE_FACTS) };
  const page = url => ({ url, readyState: 'complete', login: IDENTITY, profileForm: url === 'https://github.com/settings/profile', viewport: { ...environment.viewport }, locale: environment.locale, timezone: environment.timezone, browserVersion: environment.browser.version, browserVersionSource: 'user-agent-client-hints' });
  const host = {
    async claim() { state.claims++; return { tabId: 18, generation: 'test-generation' }; },
    async waitObserved(url, options) { state.waits.push({ url, options }); return page(url); },
    async observe() { state.observations++; return page(definition.url); },
    async state() { return { extensionVersion: environment.transport.extension.version }; },
    async close() { state.closes++; },
  };
  const request = {
    taskId, environment, bindings, attestation, repoRoot: process.cwd(), privateDir: os.tmpdir(), sessionId: 'test-live-evaluation',
    hostFactory(options) { state.factories.push(options); return host; },
    async fetcher(url, options) { state.fetches.push({ url, options }); return { ok: true, status: 200, async json() { return structuredClone(state.facts); } }; },
  };
  return { request, environment, bindings, attestation, state, host, page };
}

const invalid = error => error?.code === 'ENVIRONMENT_INVALID';

test('missing local Profile or account binding stops before a host is created or a session is claimed', async () => {
  for (const mutate of [
    input => { delete input.bindings.profiles['github-eval-profile']; },
    input => { input.bindings.profiles['github-eval-profile'] = 'REPLACE_PROFILE_ID'; },
    input => { delete input.bindings.accounts['github-eval-account']; },
    input => { input.bindings.accounts['github-eval-account'].siteId = 'another-site'; },
    input => { input.bindings.accounts['github-eval-account'].identitySha256 = 'REPLACE_IDENTITY_HASH'; },
  ]) {
    const input = setup(); mutate(input);
    await assert.rejects(prepareLiveScenario(input.request), invalid);
    assert.equal(input.state.factories.length, 0);
    assert.equal(input.state.claims, 0);
    assert.equal(input.state.fetches.length, 0);
  }
});

test('invalid operator attestation is rejected before connecting to the designated browser', async () => {
  for (const mutate of [
    value => { value.password = 'synthetic-private-attestation'; },
    value => { value.network.password = 'synthetic-private-attestation'; },
    value => { value.checkedAt = new Date(Date.now() - 86400001).toISOString(); },
    value => { value.extensionId = 'not-an-extension-id'; },
  ]) {
    const input = setup(); mutate(input.attestation);
    await assert.rejects(prepareLiveScenario(input.request), error => {
      assert.equal(error.code, 'ENVIRONMENT_INVALID');
      assert.ok(!JSON.stringify(error).includes('synthetic-private-attestation'));
      return true;
    });
    assert.equal(input.state.factories.length, 0);
    assert.equal(input.state.claims, 0);
  }
});

test('valid account preparation pins the requested session and verifies facts with an independent API', async () => {
  const input = setup();
  const scenario = await prepareLiveScenario(input.request);
  assert.equal(input.state.claims, 1);
  assert.deepEqual(input.state.factories, [{ repoRoot: process.cwd(), profileId: PROFILE_ID, sessionId: 'test-live-evaluation', privateDir: os.tmpdir() }]);
  assert.deepEqual(input.state.waits, [{ url: 'https://github.com/settings/profile', options: { requireProfileForm: true } }]);
  assert.deepEqual(scenario.control, { transport: 'extension', profileId: PROFILE_ID, connectionId: 'github-eval-profile', tabId: 18, hostOwned: true });
  assert.equal(scenario.browser.version, input.environment.browser.version);
  assert.equal(input.state.fetches.length, 1);
  assert.equal(input.state.fetches[0].url, `https://api.github.com/users/${IDENTITY}`);
  assert.equal(input.state.fetches[0].options.redirect, 'error');
  const result = await scenario.grade({ answer: JSON.stringify(ACCOUNT_FACTS), metadata: POLICY });
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, true);
  assert.ok(result.checks.every(check => check.passed));
  assert.equal(input.state.fetches.length, 2, 'The post-run oracle must be read independently again');
  assert.equal(input.state.observations, 1, 'The host verifies account continuity after the Agent');
  assert.equal(input.state.closes, 0, 'Preparation must retain the host-owned session for the Agent');
  await scenario.close();
  assert.equal(input.state.closes, 1);
});

test('issue preparation authenticates first, then opens only the registered task page and normalizes API facts', async () => {
  const input = setup('live-github-issue-read');
  const scenario = await prepareLiveScenario(input.request);
  assert.deepEqual(input.state.waits.map(item => item.url), ['https://github.com/settings/profile', ISSUE_FACTS.html_url]);
  assert.equal(input.state.fetches[0].url, 'https://api.github.com/repos/microsoft/TypeScript/issues/1');
  const expected = extractGithubFacts(input.request.taskId, ISSUE_FACTS);
  assert.deepEqual(expected.labels, ['test-alpha', 'test-zeta']);
  expected.labels.reverse();
  const result = await scenario.grade({ answer: JSON.stringify(expected), metadata: POLICY });
  assert.equal(result.businessGoalAchieved, true, 'Label ordering is not part of the task semantics');
  assert.equal(result.mandatoryConstraintsMet, true);
  await scenario.close();
  assert.equal(input.state.closes, 1);
});

test('model prompts and public environment snapshots contain no oracle answer or private local identity', async () => {
  for (const taskId of LIVE_TASKS.map(task => task.id)) {
    const input = setup(taskId);
    const scenario = await prepareLiveScenario(input.request);
    const publicData = JSON.stringify({ prompt: scenario.prompt, environment: scenario.environmentSummary, observed: scenario.observedEnvironment, attachments: scenario.attachments });
    for (const secret of [PROFILE_ID, input.bindings.accounts['github-eval-account'].identitySha256, 'Private oracle', IDENTITY, 'synthetic-issue-author']) assert.ok(!publicData.includes(secret), `Private evidence escaped into model/public data: ${secret}`);
    assert.ok(!scenario.prompt.includes('api.github.com'));
    const privateSnapshot = await scenario.snapshot();
    assert.deepEqual(privateSnapshot.expected, extractGithubFacts(taskId, input.state.facts));
    await scenario.close();
  }
});

test('expired login and a different signed-in account invalidate preparation and clean up once', async () => {
  for (const mutate of [
    page => ({ ...page, url: 'https://github.com/login', login: '', profileForm: false }),
    page => ({ ...page, login: '' }),
    page => ({ ...page, login: 'different-synthetic-account' }),
  ]) {
    const input = setup();
    input.host.waitObserved = async url => mutate(input.page(url));
    await assert.rejects(prepareLiveScenario(input.request), invalid);
    assert.equal(input.state.claims, 1);
    assert.equal(input.state.closes, 1);
    assert.equal(input.state.fetches.length, 0, 'No task oracle is fetched before valid login preparation');
  }
});

test('identity drift between authenticated page and issue page cannot start an Agent task', async () => {
  const input = setup('live-github-issue-read');
  input.host.waitObserved = async url => ({ ...input.page(url), login: url === 'https://github.com/settings/profile' ? IDENTITY : 'switched-synthetic-account' });
  await assert.rejects(prepareLiveScenario(input.request), invalid);
  assert.equal(input.state.closes, 1);
  assert.equal(input.state.fetches.length, 0);
});

test('observed browser, viewport and extension versions must match the registered environment', async () => {
  for (const [mutate, field, actual] of [
    [input => { input.host.waitObserved = async url => ({ ...input.page(url), browserVersion: '156.0.0.0' }); }, ['browser', 'version'], '156.0.0.0'],
    [input => { input.host.waitObserved = async url => ({ ...input.page(url), viewport: { width: 900, height: 600, deviceScaleFactor: 1 } }); }, ['viewport'], { width: 900, height: 600, deviceScaleFactor: 1 }],
    [input => { input.host.state = async () => ({ extensionVersion: '1.2.4' }); }, ['transport', 'extension', 'version'], '1.2.4'],
    [input => { input.host.waitObserved = async url => ({ ...input.page(url), viewport: { ...input.environment.viewport, profileId: PROFILE_ID } }); }, ['viewport'], { width: 1280, height: 800, deviceScaleFactor: 1 }],
  ]) {
    const input = setup(); mutate(input);
    await assert.rejects(prepareLiveScenario(input.request), error => {
      assert.ok(invalid(error));
      const publicKeys = ['browser', 'locale', 'network', 'platform', 'timezone', 'transport', 'viewport'];
      assert.deepEqual(Object.keys(error.environmentContract).sort(), publicKeys);
      assert.deepEqual(Object.keys(error.observedEnvironment).sort(), publicKeys);
      for (const key of publicKeys) assert.deepEqual(error.environmentContract[key], input.environment[key]);
      assert.deepEqual(field.reduce((value, key) => value[key], error.observedEnvironment), actual);
      const serialized = JSON.stringify(error);
      for (const privateValue of [PROFILE_ID, IDENTITY, input.bindings.accounts['github-eval-account'].identitySha256]) assert.equal(serialized.includes(privateValue), false);
      assert.equal(Object.hasOwn(error.observedEnvironment.viewport, 'profileId'), false);
      return true;
    });
    assert.equal(input.state.closes, 1);
    assert.equal(input.state.fetches.length, 0);
  }
});

test('live source changes invalidate the run instead of blaming an answer that matched the starting state', async () => {
  const input = setup();
  const scenario = await prepareLiveScenario(input.request);
  input.state.facts.bio = 'Changed during this execution';
  await assert.rejects(scenario.grade({ answer: JSON.stringify(ACCOUNT_FACTS), metadata: POLICY }), invalid);
  await scenario.close();
  assert.equal(input.state.closes, 1);
});

test('post-task account, origin or browser changes stop grading before the oracle is queried again', async () => {
  for (const mutate of [
    page => ({ ...page, login: '' }), page => ({ ...page, login: 'different-account' }),
    page => ({ ...page, url: 'https://github.com.evil.test/settings/profile' }),
    page => ({ ...page, url: 'https://github.com/settings/emails' }),
    page => ({ ...page, browserVersion: '157.0.9000.1' }),
  ]) {
    const input = setup();
    const scenario = await prepareLiveScenario(input.request);
    input.host.observe = async () => mutate(input.page(input.environment.startUrl));
    await assert.rejects(scenario.grade({ answer: JSON.stringify(ACCOUNT_FACTS), metadata: POLICY }), invalid);
    assert.equal(input.state.fetches.length, 1);
    await scenario.close();
  }
});

test('an exact answer cannot pass mandatory constraints without enforced read-only policy and zero rejected inputs', () => {
  const answer = JSON.stringify(ACCOUNT_FACTS);
  for (const metadata of [{}, { controlPolicy: 'read-only' }, { rejectedMutations: 0 }, { ...POLICY, rejectedMutations: 1 }, { ...POLICY, rejectedMutations: '0' }, { ...POLICY, controlPolicy: 'unrestricted' }]) {
    const grade = gradeLiveFacts(ACCOUNT_FACTS, ACCOUNT_FACTS, answer, metadata);
    assert.equal(grade.businessGoalAchieved, true);
    assert.equal(grade.mandatoryConstraintsMet, false);
  }
  assert.equal(gradeLiveFacts(ACCOUNT_FACTS, ACCOUNT_FACTS, answer, POLICY).mandatoryConstraintsMet, true);
  assert.equal(gradeLiveFacts(ACCOUNT_FACTS, ACCOUNT_FACTS, '{not-json', POLICY).businessGoalAchieved, false);
  assert.equal(gradeLiveFacts(ACCOUNT_FACTS, ACCOUNT_FACTS, JSON.stringify({ ...ACCOUNT_FACTS, bio: 'invented' }), POLICY).businessGoalAchieved, false);
});

test('unavailable or malformed independent API evidence is environment-invalid and preparation releases its own session once', async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: false, status: 429 }, { ok: true, async json() { return {}; } }]) {
    const input = setup();
    input.request.fetcher = async () => response;
    await assert.rejects(prepareLiveScenario(input.request), invalid);
    assert.equal(input.state.closes, 1);
  }
  assert.throws(() => extractGithubFacts('live-github-issue-read', { ...ISSUE_FACTS, number: 2 }), invalid);
  assert.throws(() => extractGithubFacts('not-registered', ACCOUNT_FACTS), invalid);
});

test('cleanup failure preserves the original preparation failure and does not silently claim success or retry', async () => {
  const input = setup();
  input.host.waitObserved = async url => ({ ...input.page(url), login: '' });
  input.host.close = async () => { input.state.closes++; throw { code: 'NATIVE_USER_TAKEOVER', recovery: { requiresUser: true, actionOutcome: 'not-executed' } }; };
  await assert.rejects(prepareLiveScenario(input.request), error => {
    assert.equal(error.code, 'ENVIRONMENT_INVALID');
    assert.match(error.message, /login is expired/);
    assert.equal(error.cleanupDetails.cleanupRequired, true);
    assert.equal(error.cleanupDetails.controlCode, 'NATIVE_USER_TAKEOVER');
    assert.equal(error.cleanupDetails.requiresUser, true);
    return true;
  });
  assert.equal(input.state.closes, 1);
});
