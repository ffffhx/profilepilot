import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkPreparedEnvironment, validateEnvironmentContract, validateOperatorAttestation, ENVIRONMENT_SCHEMA_VERSION, ENVIRONMENT_TRACKS } from '../benchmarks/agent-tasks/lib/environments.mjs';

const NOW = Date.parse('2030-08-01T12:00:00.000Z');
function setup() {
  const contract = {
    schemaVersion: '1.0.0', track: 'live-site', siteId: 'github', startUrl: 'https://github.com/settings/profile', allowedOrigins: ['https://github.com'],
    profile: { strategy: 'reuse', binding: 'github-eval-profile' },
    login: { state: 'preauthenticated', accountAlias: 'github-eval-account', maxEvidenceAgeSeconds: 300 },
    transport: { kind: 'extension', extension: { id: 'abcdefghijklmnopabcdefghijklmnop', version: '1.2.3' } },
    platform: { os: 'win32', arch: 'x64', release: '10.0.26100' }, browser: { name: 'chrome', version: '142.0.7444.60', mode: 'headed' },
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, locale: 'zh-CN', timezone: 'Asia/Shanghai',
    network: { mode: 'direct', egressAlias: 'lab-cn-direct' },
    taskData: { strategy: 'read-only', namespace: 'github-account-review', authReset: 'forbidden' },
    cleanup: { taskData: 'retain', profile: 'retain' },
  };
  const profileId = 'private-local-profile-fixture-only';
  const identitySha256 = 'a'.repeat(64);
  const bindings = { profiles: { 'github-eval-profile': profileId }, accounts: { 'github-eval-account': { siteId: 'github', identitySha256 } } };
  const observed = structuredClone(contract);
  delete observed.schemaVersion;
  observed.profile = { ...contract.profile, profileId, runOwned: false };
  observed.login = { state: 'preauthenticated', accountAlias: 'github-eval-account', identitySha256, checkedAt: '2030-08-01T11:59:50.000Z', siteId: 'github', origin: 'https://github.com', profileId, method: 'visible-ui' };
  observed.taskData = { strategy: 'read-only', namespace: 'github-account-review', authResetPerformed: false, runOwned: false };
  return { contract, observed, bindings };
}
const verify = ({ contract, observed, bindings }) => checkPreparedEnvironment(contract, observed, { bindings, now: NOW });
function invalid(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 'environment_invalid');
  assert.ok(result.reasons.length > 0);
  if (code) assert.ok(result.reasons.some(reason => reason.code === code), JSON.stringify(result.reasons));
  assert.equal(Object.hasOwn(result, 'businessGoalAchieved'), false, 'Preparation failure is not a task failure or task verdict');
}

test('a matched real-site Profile and fresh account preflight return only a public summary', () => {
  const inputs = setup();
  const before = structuredClone(inputs);
  const result = verify(inputs);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.status, 'ready');
  assert.match(result.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(result.environment.profile.binding, 'github-eval-profile');
  assert.equal(result.environment.login.accountAlias, 'github-eval-account');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(inputs.observed.profile.profileId));
  assert.ok(!serialized.includes(inputs.observed.login.identitySha256));
  assert.ok(!serialized.includes('identitySha256'));
  assert.deepEqual(inputs, before, 'Validation must not modify preparation or local bindings');
  result.environment.viewport.width = 999;
  assert.equal(inputs.observed.viewport.width, 1280);
});

test('contract hashing ignores object and allowed-origin ordering without depending on private bindings', () => {
  const { contract } = setup();
  contract.allowedOrigins.push('https://docs.github.com');
  const reversed = Object.fromEntries(Object.entries(structuredClone(contract)).reverse());
  reversed.allowedOrigins.reverse();
  assert.equal(validateEnvironmentContract(contract).contractHash, validateEnvironmentContract(reversed).contractHash);
  reversed.network.egressAlias = 'different-egress';
  assert.notEqual(validateEnvironmentContract(contract).contractHash, validateEnvironmentContract(reversed).contractHash);
});

test('every pinned environment dimension is compared to prepared readback', () => {
  const cases = [
    value => { value.track = 'recovery'; }, value => { value.siteId = 'other-site'; },
    value => { value.startUrl = 'https://github.com/'; }, value => { value.allowedOrigins.push('https://docs.github.com'); },
    value => { value.transport.extension.version = '1.2.4'; }, value => { value.transport.extension.id = 'p'.repeat(32); },
    value => { value.transport = { kind: 'gateway' }; }, value => { value.platform.os = 'darwin'; },
    value => { value.platform.arch = 'arm64'; }, value => { value.platform.release = '10.0.26000'; },
    value => { value.browser.version = '143.0.1.2'; }, value => { value.browser.mode = 'headless'; },
    value => { value.viewport.width = 1440; }, value => { value.viewport.deviceScaleFactor = 2; },
    value => { value.locale = 'en-US'; }, value => { value.timezone = 'UTC'; },
    value => { value.network.mode = 'proxy'; }, value => { value.network.egressAlias = 'other-route'; },
    value => { value.cleanup.taskData = 'run-owned-only'; },
  ];
  for (const mutate of cases) { const inputs = setup(); mutate(inputs.observed); invalid(verify(inputs)); }
});

test('login expiration, stale evidence and identity drift invalidate preparation', () => {
  const cases = [
    ['LOGIN_STATE_MISMATCH', value => { value.login.state = 'expired'; }],
    ['ACCOUNT_IDENTITY_MISMATCH', value => { value.login.identitySha256 = 'b'.repeat(64); }],
    ['ACCOUNT_IDENTITY_MISMATCH', value => { value.login.accountAlias = 'another-account'; }],
    ['LOGIN_EVIDENCE_STALE', value => { value.login.checkedAt = '2030-08-01T11:54:59.000Z'; }],
    ['LOGIN_EVIDENCE_STALE', value => { value.login.checkedAt = '2030-08-01T12:00:31.000Z'; }],
    ['LOGIN_EVIDENCE_SCOPE_MISMATCH', value => { value.login.profileId = 'other-private-profile'; }],
    ['LOGIN_EVIDENCE_SCOPE_MISMATCH', value => { value.login.siteId = 'other-site'; }],
    ['LOGIN_EVIDENCE_SCOPE_MISMATCH', value => { value.login.origin = 'https://example.test'; }],
    ['LOGIN_EVIDENCE_METHOD_MISMATCH', value => { value.login.method = 'fixture'; }],
  ];
  for (const [code, mutate] of cases) { const inputs = setup(); mutate(inputs.observed); invalid(verify(inputs), code); }
  const boundary = setup(); boundary.observed.login.checkedAt = '2030-08-01T11:55:00.000Z';
  assert.equal(verify(boundary).ok, true);
});

test('an explicitly expired recovery starting state is valid without pretending it is authenticated', () => {
  const inputs = setup();
  inputs.contract.track = inputs.observed.track = 'recovery';
  inputs.contract.login.state = inputs.observed.login.state = 'expired';
  assert.equal(verify(inputs).ok, true);
  inputs.observed.login.method = 'fixture';
  invalid(verify(inputs), 'LOGIN_EVIDENCE_METHOD_MISMATCH');
  inputs.contract.track = 'live-site';
  invalid(validateEnvironmentContract(inputs.contract), 'EXPIRED_LOGIN_TRACK');
});

test('local Profile and account bindings cannot be omitted, swapped, or claimed as disposable', () => {
  const cases = [
    ['PROFILE_BINDING_MISSING', inputs => { delete inputs.bindings.profiles['github-eval-profile']; }],
    ['PROFILE_IDENTITY_MISMATCH', inputs => { inputs.bindings.profiles['github-eval-profile'] = 'other-profile'; }],
    ['UNRESOLVED_PIN', inputs => { inputs.bindings.profiles['github-eval-profile'] = 'REPLACE_PROFILE_ID'; }],
    ['PROFILE_BINDING_MISMATCH', inputs => { inputs.observed.profile.binding = 'wrong-binding'; }],
    ['REUSED_PROFILE_OWNERSHIP', inputs => { inputs.observed.profile.runOwned = true; }],
    ['ACCOUNT_BINDING_MISSING', inputs => { delete inputs.bindings.accounts['github-eval-account']; }],
    ['ACCOUNT_BINDING_MISSING', inputs => { inputs.bindings.accounts['github-eval-account'].siteId = 'other-site'; }],
  ];
  for (const [code, mutate] of cases) { const inputs = setup(); mutate(inputs); invalid(verify(inputs), code); }
});

test('synthetic preparation permits only a fresh owned loopback Profile and independent task-data reset', () => {
  const inputs = setup();
  Object.assign(inputs.contract, { track: 'synthetic', siteId: 'synthetic-mail', startUrl: 'http://127.0.0.1:45678/', allowedOrigins: ['http://127.0.0.1:45678'] });
  inputs.contract.profile = { strategy: 'fresh' };
  inputs.contract.login = { state: 'none', maxEvidenceAgeSeconds: 60 };
  inputs.contract.transport = { kind: 'gateway' };
  inputs.contract.taskData = { strategy: 'seeded-reset', namespace: 'mail-run-1', authReset: 'forbidden' };
  inputs.contract.cleanup = { taskData: 'run-owned-only', profile: 'dispose-run-owned' };
  inputs.bindings = { profiles: {}, accounts: {} };
  inputs.observed = structuredClone(inputs.contract); delete inputs.observed.schemaVersion;
  inputs.observed.profile = { strategy: 'fresh', profileId: 'new-run-owned-profile', runOwned: true };
  inputs.observed.login = { state: 'none', checkedAt: '2030-08-01T11:59:50.000Z', siteId: 'synthetic-mail', origin: 'http://127.0.0.1:45678', profileId: 'new-run-owned-profile', method: 'fixture' };
  inputs.observed.taskData = { strategy: 'seeded-reset', namespace: 'mail-run-1', authResetPerformed: false, runOwned: true };
  assert.equal(verify(inputs).ok, true, JSON.stringify(verify(inputs).reasons));
  inputs.observed.taskData.authResetPerformed = true;
  invalid(verify(inputs), 'INVALID_VALUE');
  inputs.observed.taskData.authResetPerformed = false; inputs.observed.taskData.runOwned = false;
  invalid(verify(inputs), 'TASK_DATA_NOT_OWNED');
  inputs.observed.taskData.runOwned = true; inputs.observed.profile.runOwned = false;
  invalid(verify(inputs), 'FRESH_PROFILE_NOT_OWNED');
});

test('missing observation fields fail closed rather than inferring the requested environment', () => {
  for (const field of ['profile', 'login', 'transport', 'platform', 'browser', 'viewport', 'locale', 'timezone', 'network', 'taskData', 'cleanup']) {
    const inputs = setup(); delete inputs.observed[field]; invalid(verify(inputs), 'MISSING_FIELD');
  }
  for (const field of ['checkedAt', 'profileId', 'origin', 'method']) {
    const inputs = setup(); delete inputs.observed.login[field]; invalid(verify(inputs), 'MISSING_FIELD');
  }
  const inputs = setup(); delete inputs.observed.login.identitySha256;
  invalid(verify(inputs), 'ACCOUNT_IDENTITY_MISMATCH');
});

test('configuration forbids ambiguous transports, auth resets, unsafe cleanup and credential URLs', () => {
  const cases = [
    value => { value.transport = { kind: 'extension' }; }, value => { value.transport.kind = 'gateway'; },
    value => { delete value.profile.binding; }, value => { value.cleanup.profile = 'dispose-run-owned'; },
    value => { value.taskData.authReset = 'clear-cookies'; }, value => { value.cleanup.taskData = 'delete-everything'; },
    value => { value.login.state = 'none'; }, value => { value.login.state = 'expired'; },
    value => { value.startUrl = 'https://user:secret@github.com/settings/profile'; },
    value => { value.startUrl = 'https://github.com/settings/profile?token=secret'; },
    value => { value.startUrl = 'https://github.com/settings/profile#access_token=secret'; },
    value => { value.startUrl = 'http://github.com/settings/profile'; },
    value => { value.allowedOrigins = ['https://github.com/']; },
    value => { value.allowedOrigins = ['https://example.test']; },
    value => { value.track = 'synthetic'; }, value => { value.platform.release = 'unknown'; },
    value => { value.browser.version = 'REPLACE_BROWSER_VERSION'; }, value => { value.timezone = 'not/a-timezone'; },
    value => { value.locale = 'not_a_locale'; },
  ];
  for (const mutate of cases) { const { contract } = setup(); mutate(contract); invalid(validateEnvironmentContract(contract)); }
});

test('unknown credentials and private identity mismatches do not leak values into reasons or snapshots', () => {
  const secret = 'synthetic-secret-credential-never-publish';
  for (const mutate of [
    inputs => { inputs.contract.password = secret; },
    inputs => { inputs.observed.login.cookies = secret; },
    inputs => { inputs.bindings.accounts['github-eval-account'].token = secret; },
    inputs => { inputs.contract.startUrl = `https://github.com/?token=${secret}`; },
    inputs => { inputs.observed.profile.profileId = secret; },
    inputs => { inputs.observed.login.profileId = secret; },
    inputs => { inputs.bindings.profiles['github-eval-profile'] = secret; },
  ]) {
    const inputs = setup(); mutate(inputs);
    const result = verify(inputs); invalid(result);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(inputs.bindings.accounts['github-eval-account'].identitySha256));
  }
});

test('shared example explicitly remains invalid until locally pinned; schema declares the same tracks', async () => {
  const example = JSON.parse(await readFile(new URL('../benchmarks/agent-tasks/environments.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example.environments), ['live-github-account-review', 'live-github-issue-read']);
  for (const contract of Object.values(example.environments)) invalid(validateEnvironmentContract(contract));
  assert.match(example.bindings.profiles['github-evaluation-profile'], /^REPLACE_/);
  invalid(validateOperatorAttestation(example.attestation, { now: NOW }));
  const schema = JSON.parse(await readFile(new URL('../benchmarks/agent-tasks/environments.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.contract.properties.schemaVersion.const, ENVIRONMENT_SCHEMA_VERSION);
  assert.deepEqual(schema.$defs.contract.properties.track.enum, ENVIRONMENT_TRACKS);
  assert.equal(schema.additionalProperties, false);
});

test('operator attestation is explicitly manual, fresh for at most 24 hours and contains no credentials', () => {
  const evidence = { checkedAt: '2030-08-01T11:00:00.000Z', extensionId: 'abcdefghijklmnopabcdefghijklmnop', network: { mode: 'direct', egressAlias: 'lab-cn-direct' } };
  const result = validateOperatorAttestation(evidence, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceSource, 'operator-attestation');
  assert.deepEqual(result.attestation, evidence);
  for (const checkedAt of ['2030-07-31T11:59:59.000Z', '2030-08-01T12:00:01.000Z', 'REPLACE_TIMESTAMP']) {
    invalid(validateOperatorAttestation({ ...evidence, checkedAt }, { now: NOW }));
  }
  assert.equal(validateOperatorAttestation({ ...evidence, checkedAt: '2030-07-31T12:00:00.000Z' }, { now: NOW }).ok, true);
  invalid(validateOperatorAttestation({ checkedAt: evidence.checkedAt }, { now: NOW }), 'MISSING_FIELD');
  const secret = 'synthetic-attestation-password-never-publish';
  const rejected = validateOperatorAttestation({ ...evidence, network: { ...evidence.network, password: secret } }, { now: NOW });
  invalid(rejected, 'UNKNOWN_FIELD');
  assert.ok(!JSON.stringify(rejected).includes(secret));
});

test('invalid clocks and nonobject contracts or observations cannot produce an environment pass', () => {
  for (const value of [null, [], undefined, 123, 'config']) invalid(validateEnvironmentContract(value));
  const inputs = setup();
  for (const value of [null, [], undefined]) invalid(checkPreparedEnvironment(inputs.contract, value, { bindings: inputs.bindings, now: NOW }));
  invalid(checkPreparedEnvironment(inputs.contract, inputs.observed, { bindings: inputs.bindings, now: NaN }), 'CLOCK_INVALID');
});
