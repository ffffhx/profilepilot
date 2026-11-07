import { readFileSync } from 'node:fs';
import { hash } from './contracts.mjs';

export const ENVIRONMENT_SCHEMA_VERSION = '1.0.0';
export const ENVIRONMENT_TRACKS = Object.freeze(['synthetic', 'live-site', 'recovery']);
const schema = JSON.parse(readFileSync(new URL('../environments.schema.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const placeholder = value => /^(?:replace(?:_|-)|unknown$|unavailable$|configured$|default$|latest$|pending$)/i.test(String(value));
const ref = name => ({ $ref: `#/$defs/${name}` });
const reason = (reasons, code, field, message) => reasons.push({ code, field, message });

function validFormat(value, format) {
  try {
    if (format === 'public-url' || format === 'origin') {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
      if (url.protocol === 'http:' && !loopback(url.hostname)) return false;
      return format === 'origin' ? value === url.origin : value === url.href;
    }
    if (format === 'locale') return Intl.getCanonicalLocales(value)[0] === value;
    if (format === 'timezone') { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    if (format === 'date-time') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  } catch { return false; }
  return true;
}

// This small validator covers exactly the schema vocabulary used by this file.
// Failure messages never interpolate input values or unknown property names.
function shape(value, definition, field, reasons) {
  if (definition.$ref) definition = schema.$defs[definition.$ref.slice('#/$defs/'.length)];
  if (definition.const !== undefined && value !== definition.const) reason(reasons, 'INVALID_VALUE', field, 'The field must use the supported fixed value.');
  if (definition.enum && !definition.enum.includes(value)) reason(reasons, 'INVALID_VALUE', field, 'The field must use a supported value.');
  const type = definition.type;
  if (type && !(type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) {
    reason(reasons, 'INVALID_TYPE', field, `Expected ${type}.`); return;
  }
  if (typeof value === 'string') {
    if ((definition.minLength !== undefined && value.length < definition.minLength) || (definition.maxLength !== undefined && value.length > definition.maxLength) || (definition.pattern && !new RegExp(definition.pattern).test(value)) || (definition.format && !validFormat(value, definition.format))) reason(reasons, 'INVALID_FORMAT', field, 'The field does not match its documented public format.');
  }
  if (typeof value === 'number' && ((definition.minimum !== undefined && value < definition.minimum) || (definition.maximum !== undefined && value > definition.maximum))) reason(reasons, 'OUT_OF_RANGE', field, 'The numeric field is outside its supported range.');
  if (Array.isArray(value)) {
    if ((definition.minItems !== undefined && value.length < definition.minItems) || (definition.maxItems !== undefined && value.length > definition.maxItems) || (definition.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length)) reason(reasons, 'INVALID_ITEMS', field, 'The list length or uniqueness requirement was not met.');
    if (definition.items) value.forEach((item, index) => shape(item, definition.items, `${field}[${index}]`, reasons));
  }
  if (object(value)) {
    if (definition.minProperties && Object.keys(value).length < definition.minProperties) reason(reasons, 'MISSING_FIELD', field, 'At least one configured entry is required.');
    for (const key of definition.required || []) if (!own(value, key)) reason(reasons, 'MISSING_FIELD', `${field}.${key}`, 'A required environment field is missing.');
    for (const [key, item] of Object.entries(value)) {
      const known = definition.properties?.[key];
      const pattern = Object.entries(definition.patternProperties || {}).find(([expression]) => new RegExp(expression).test(key));
      if (known) shape(item, known, `${field}.${key}`, reasons);
      else if (pattern) shape(item, pattern[1], `${field}.<binding>`, reasons);
      else if (definition.additionalProperties === false) reason(reasons, 'UNKNOWN_FIELD', field, 'Unexpected fields, raw identities and credentials are not allowed here.');
    }
  }
}

function semantic(contract, reasons) {
  const start = new URL(contract.startUrl);
  if (!contract.allowedOrigins.includes(start.origin)) reason(reasons, 'START_ORIGIN_NOT_ALLOWED', 'contract.allowedOrigins', 'The start page origin must be explicitly allowed.');
  if (contract.track === 'synthetic' && !loopback(start.hostname)) reason(reasons, 'TRACK_SITE_MISMATCH', 'contract.startUrl', 'Synthetic tasks require a loopback fixture.');
  if (contract.track === 'live-site' && loopback(start.hostname)) reason(reasons, 'TRACK_SITE_MISMATCH', 'contract.startUrl', 'Live-site tasks require a real non-loopback site.');
  if (contract.profile.strategy === 'reuse' && !contract.profile.binding) reason(reasons, 'PROFILE_BINDING_REQUIRED', 'contract.profile.binding', 'Reuse requires a named local Profile binding.');
  if (contract.profile.strategy === 'fresh' && contract.profile.binding) reason(reasons, 'FRESH_PROFILE_BOUND', 'contract.profile.binding', 'A fresh Profile must not select an existing local binding.');
  if (contract.profile.strategy === 'reuse' && contract.cleanup.profile !== 'retain') reason(reasons, 'REUSED_PROFILE_CLEANUP', 'contract.cleanup.profile', 'Reused Profiles and their authentication must be retained.');
  if (contract.login.state === 'none' && contract.login.accountAlias) reason(reasons, 'UNEXPECTED_ACCOUNT', 'contract.login.accountAlias', 'Anonymous preparation must not declare an authenticated account.');
  if (contract.login.state !== 'none' && !contract.login.accountAlias) reason(reasons, 'ACCOUNT_ALIAS_REQUIRED', 'contract.login.accountAlias', 'Authenticated or expired preparation requires a local account alias.');
  if (contract.login.state === 'expired' && contract.track !== 'recovery') reason(reasons, 'EXPIRED_LOGIN_TRACK', 'contract.login.state', 'An intentionally expired login is allowed only in the recovery track.');
  if (contract.transport.kind === 'extension' && !contract.transport.extension) reason(reasons, 'EXTENSION_IDENTITY_REQUIRED', 'contract.transport.extension', 'Extension transport requires a pinned extension ID and version.');
  if (contract.transport.kind === 'gateway' && contract.transport.extension) reason(reasons, 'TRANSPORT_IDENTITY_MISMATCH', 'contract.transport.extension', 'Gateway transport must not claim an extension identity.');
  for (const field of ['siteId', 'platform.release', 'network.egressAlias', 'taskData.namespace', 'profile.binding', 'login.accountAlias']) {
    const value = field.split('.').reduce((current, key) => current?.[key], contract);
    if (value !== undefined && placeholder(value)) reason(reasons, 'UNRESOLVED_PIN', `contract.${field}`, 'Replace all example placeholders with verified local values.');
  }
}

/** Validate a public contract; local bindings and observation values are never returned. */
export function validateEnvironmentContract(input) {
  const reasons = [];
  shape(input, schema.$defs.contract, 'contract', reasons);
  if (!reasons.length) semantic(input, reasons);
  if (reasons.length) return { ok: false, status: 'environment_invalid', reasons };
  const contract = copy(input);
  contract.allowedOrigins.sort();
  return { ok: true, status: 'ready', reasons: [], contract, contractHash: hash(canonical(contract)) };
}

/** Explicit human evidence for fields unavailable from the live CLI status API. */
export function validateOperatorAttestation(input, { now = Date.now() } = {}) {
  const reasons = [];
  shape(input, schema.$defs.attestation, 'attestation', reasons);
  if (!Number.isFinite(now)) reason(reasons, 'CLOCK_INVALID', 'now', 'A finite trusted verification timestamp is required.');
  if (!reasons.length) {
    const age = now - Date.parse(input.checkedAt);
    if (age < 0 || age > 86400000) reason(reasons, 'OPERATOR_ATTESTATION_STALE', 'attestation.checkedAt', 'Operator verification must precede this run by no more than 24 hours.');
    if (placeholder(input.network.egressAlias)) reason(reasons, 'UNRESOLVED_PIN', 'attestation.network.egressAlias', 'Replace the egress placeholder with a verified policy alias.');
  }
  return reasons.length ? { ok: false, status: 'environment_invalid', reasons }
    : { ok: true, status: 'ready', reasons: [], attestation: copy(input), evidenceSource: 'operator-attestation' };
}

const observedSchema = copy(schema.$defs.contract);
delete observedSchema.properties.schemaVersion;
observedSchema.required = observedSchema.required.filter(key => key !== 'schemaVersion');
observedSchema.properties.profile = {
  type: 'object', additionalProperties: false, required: ['strategy', 'profileId', 'runOwned'],
  properties: { strategy: { enum: ['fresh', 'reuse'] }, binding: ref('alias'), profileId: ref('profileId'), runOwned: { type: 'boolean' } },
};
observedSchema.properties.login = {
  type: 'object', additionalProperties: false, required: ['state', 'checkedAt', 'siteId', 'origin', 'profileId', 'method'],
  properties: {
    state: { enum: ['none', 'preauthenticated', 'expired'] }, accountAlias: ref('alias'), identitySha256: ref('identitySha256'),
    checkedAt: { type: 'string', format: 'date-time' }, siteId: ref('alias'), origin: ref('origin'), profileId: ref('profileId'),
    method: { enum: ['visible-ui', 'site-api', 'fixture'] },
  },
};
observedSchema.properties.taskData = {
  type: 'object', additionalProperties: false, required: ['strategy', 'namespace', 'authResetPerformed', 'runOwned'],
  properties: { strategy: { enum: ['seeded-reset', 'run-owned', 'read-only'] }, namespace: ref('alias'), authResetPerformed: { const: false }, runOwned: { type: 'boolean' } },
};

function publicObserved(observed) {
  const { track, siteId, startUrl, allowedOrigins, transport, platform, browser, viewport, locale, timezone, network, cleanup } = observed;
  return copy({ track, siteId, startUrl, allowedOrigins: [...allowedOrigins].sort(), transport, platform, browser, viewport, locale, timezone, network, cleanup,
    profile: { strategy: observed.profile.strategy, ...(observed.profile.binding ? { binding: observed.profile.binding } : {}), runOwned: observed.profile.runOwned },
    login: { state: observed.login.state, ...(observed.login.accountAlias ? { accountAlias: observed.login.accountAlias } : {}), checkedAt: observed.login.checkedAt, method: observed.login.method },
    taskData: observed.taskData,
  });
}

/**
 * Compare a trusted preparer's readback to the preregistered environment.
 * bindings is local-only: {profiles:{alias:profileId},accounts:{alias:{siteId,identitySha256}}}.
 * A task Agent's self-reported identity is not a login preflight. This function performs no I/O.
 */
export function checkPreparedEnvironment(input, observedEnvironment, { bindings = { profiles: {}, accounts: {} }, now = Date.now() } = {}) {
  const validated = validateEnvironmentContract(input);
  if (!validated.ok) return validated;
  const contract = validated.contract;
  const reasons = [];
  shape(bindings, schema.$defs.bindings, 'bindings', reasons);
  shape(observedEnvironment, observedSchema, 'observedEnvironment', reasons);
  if (!Number.isFinite(now)) reason(reasons, 'CLOCK_INVALID', 'now', 'A finite trusted verification timestamp is required.');
  if (reasons.length) return { ok: false, status: 'environment_invalid', reasons, contractHash: validated.contractHash };
  const observed = observedEnvironment;
  for (const field of ['track', 'siteId', 'startUrl', 'transport', 'platform', 'browser', 'viewport', 'locale', 'timezone', 'network', 'cleanup']) {
    if (!same(contract[field], observed[field])) reason(reasons, 'ENVIRONMENT_MISMATCH', field, 'The prepared value does not match the pinned contract.');
  }
  if (!same([...contract.allowedOrigins].sort(), [...observed.allowedOrigins].sort())) reason(reasons, 'ORIGIN_SCOPE_MISMATCH', 'allowedOrigins', 'The prepared access scope differs from the registered origin allowlist.');
  if (contract.profile.strategy !== observed.profile.strategy) reason(reasons, 'PROFILE_STRATEGY_MISMATCH', 'profile.strategy', 'The prepared Profile strategy differs from the contract.');
  if (contract.profile.strategy === 'reuse') {
    const bound = bindings.profiles[contract.profile.binding];
    if (!bound) reason(reasons, 'PROFILE_BINDING_MISSING', 'bindings.profiles', 'The required local Profile binding is absent.');
    else if (placeholder(bound)) reason(reasons, 'UNRESOLVED_PIN', 'bindings.profiles', 'The local Profile binding is still an example placeholder.');
    else if (observed.profile.profileId !== bound) reason(reasons, 'PROFILE_IDENTITY_MISMATCH', 'profile', 'The prepared Profile is not the locally bound Profile.');
    if (observed.profile.binding !== contract.profile.binding) reason(reasons, 'PROFILE_BINDING_MISMATCH', 'profile.binding', 'The prepared Profile alias differs from the contract.');
    if (observed.profile.runOwned) reason(reasons, 'REUSED_PROFILE_OWNERSHIP', 'profile.runOwned', 'A reused Profile cannot be claimed as disposable run-owned state.');
  } else {
    if (!observed.profile.runOwned || observed.profile.binding || Object.values(bindings.profiles).includes(observed.profile.profileId)) reason(reasons, 'FRESH_PROFILE_NOT_OWNED', 'profile', 'A fresh Profile must be newly run-owned, without an existing Profile binding.');
  }
  if (contract.cleanup.profile === 'dispose-run-owned' && !observed.profile.runOwned) reason(reasons, 'PROFILE_CLEANUP_NOT_OWNED', 'cleanup.profile', 'Only a Profile created and owned by this run may be disposed.');
  if (contract.login.state !== observed.login.state) reason(reasons, 'LOGIN_STATE_MISMATCH', 'login.state', 'The observed login state differs from the required starting state.');
  const checkedAt = Date.parse(observed.login.checkedAt);
  if (checkedAt > now + 30000 || now - checkedAt > contract.login.maxEvidenceAgeSeconds * 1000) reason(reasons, 'LOGIN_EVIDENCE_STALE', 'login.checkedAt', 'Login evidence is expired or unexpectedly in the future.');
  if (observed.login.siteId !== contract.siteId || observed.login.origin !== new URL(observed.startUrl).origin || observed.login.profileId !== observed.profile.profileId) reason(reasons, 'LOGIN_EVIDENCE_SCOPE_MISMATCH', 'login', 'Login evidence must belong to this site origin and this exact prepared Profile.');
  if (!loopback(new URL(contract.startUrl).hostname) && observed.login.method === 'fixture') reason(reasons, 'LOGIN_EVIDENCE_METHOD_MISMATCH', 'login.method', 'A fixture assertion cannot establish a real-site login, including recovery runs.');
  if (contract.login.state === 'none') {
    if (observed.login.accountAlias || observed.login.identitySha256) reason(reasons, 'UNEXPECTED_LOGIN_IDENTITY', 'login', 'An anonymous starting state must not carry an account identity.');
  } else {
    const account = bindings.accounts[contract.login.accountAlias];
    if (!account || account.siteId !== contract.siteId) reason(reasons, 'ACCOUNT_BINDING_MISSING', 'bindings.accounts', 'The expected account identity is not bound to this site locally.');
    if (observed.login.accountAlias !== contract.login.accountAlias || !account || observed.login.identitySha256 !== account.identitySha256) reason(reasons, 'ACCOUNT_IDENTITY_MISMATCH', 'login', 'The independently observed account identity does not match the approved local alias.');
  }
  if (contract.taskData.strategy !== observed.taskData.strategy || contract.taskData.namespace !== observed.taskData.namespace) reason(reasons, 'TASK_DATA_SCOPE_MISMATCH', 'taskData', 'Task data preparation differs from the registered scope.');
  if ((contract.taskData.strategy !== 'read-only' || contract.cleanup.taskData === 'run-owned-only') && !observed.taskData.runOwned) reason(reasons, 'TASK_DATA_NOT_OWNED', 'taskData.runOwned', 'Task data reset or cleanup requires data owned by this run; authentication is excluded.');
  return { ok: reasons.length === 0, status: reasons.length ? 'environment_invalid' : 'ready', reasons,
    contractHash: validated.contractHash, environment: publicObserved(observed) };
}
