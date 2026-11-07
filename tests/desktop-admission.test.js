const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { evaluateDesktopAdmission, createDesktopAdmission } = loadCli('src/main/desktop/admission.ts');
const target = { pid: 41, title: 'Not an identity', className: 'Chrome_WidgetWin_1', process: 'ProfilePilot' };
const ready = value => ({ state: 'ready', value, capturedAt: 1000 });
const unavailable = (lastKnown, reason = 'disconnected') => ({ state: 'unavailable', reason, ...(lastKnown === undefined ? {} : { lastKnown }) });
const catalog = (capturedAt = 1000) => ({ profiles: [], externalInstances: [], discovery: {
  snapshotId: 'fixture', capturedAt, complete: true, processPids: [41, 42, 81, 91, 99], scopedGaps: [] } });
const base = () => ({ catalog: ready(catalog()), gateway: ready({ profiles: [], ports: [] }), native: ready([]), apps: ready([]) });
const binding = (extra = {}) => ({ profileId: 'isolated:a', profileName: 'A', publicPort: 9224, chromePid: 41, ownership: 'user', sessionStatus: 'stopped', agentHealth: 'offline', driverState: 'disconnected', controlGeneration: 1, updatedAt: '2026-10-29T00:00:00Z', ...extra });
const profile = (extra = {}) => ({ id: 'isolated:a', source: 'isolated', pids: [41], browserPids: [41], cdpPort: 9224, fixedCdpPort: 9224, gatewayControl: null, agentBrowserOccupancy: null, cdpClients: [], ...extra });
const app = (extra = {}) => ({ id: 'app-a', agentPort: null, runtime: { status: 'running', pid: 41, startedAt: '2026-10-29T00:00:00Z', exitCode: null, error: '' }, ...extra });
const native = (extra = {}) => ({ profileId: 'native:Default', connected: true, ownership: 'user', controlGeneration: 'worker:1', ...extra });
const owned = (extra = {}) => binding({ ownerSessionId: 'same-name', ownership: 'agent', sessionStatus: 'active', driverState: 'connected', agentHealth: 'online', ...extra });

test('strict discovery reason codes survive without exposing arbitrary provider text', async () => {
  for (const message of ['PROFILE_PROCESS_SCAN_INCOMPLETE', 'private token or file path']) {
    const snapshots = base();
    const providers = Object.fromEntries(Object.entries(snapshots).map(([key, value]) => [key, async () => value]));
    providers.catalog = async () => { throw new Error(message); };
    const result = await createDesktopAdmission(providers, { now: () => 1000 })(target);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.gaps, [message.startsWith('PROFILE_') ? `catalog:${message}` : 'catalog:provider_failed']);
    assert.equal(JSON.stringify(result).includes('private token'), false);
  }
});
function gateway(s, value) { s.gateway = ready({ profiles: [value], ports: [value.publicPort] }); return s; }
function evaluate(s, expected, reason) {
  const result = evaluateDesktopAdmission(target, s, { now: 1000 });
  assert.equal(result.status, expected, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
  return result;
}

test('complete discovery returns unmanaged without treating Chrome window class or title as identity', () => {
  for (const process of ['ProfilePilot', 'unregistered-electron', 'fixture', 'chrome']) {
    const result = evaluateDesktopAdmission({ ...target, process, title: 'Chrome - Agent active' }, base(), { now: 1000 });
    assert.equal(result.status, 'unmanaged'); assert.deepEqual(result.matches, []); assert.equal(result.code, undefined);
  }
});
test('missing, stale and incomplete mapping sources never become unmanaged', () => {
  for (const key of ['catalog', 'gateway', 'apps']) for (const shape of ['missing', 'unavailable', 'stale', 'incomplete', 'gaps']) {
    const s = base();
    if (shape === 'missing') delete s[key];
    else if (shape === 'unavailable') s[key] = unavailable();
    else if (shape === 'stale') s[key].capturedAt = -10000;
    else if (shape === 'incomplete') s[key].complete = false;
    else s[key].gaps = ['process_scan_failed'];
    assert.equal(evaluate(s, 'unknown').code, 'DESKTOP_ADMISSION_UNKNOWN');
  }
});
test('an unavailable extension source does not identify an otherwise unmanaged WinForms or Electron target', () => {
  const s = base(); s.native = unavailable(); evaluate(s, 'unmanaged');
});
test('Gateway owner blocks even when caller uses the identical session string', () => {
  const s = gateway(base(), owned());
  const result = evaluateDesktopAdmission({ ...target, session: 'same-name' }, s, { now: 1000, session: 'same-name' });
  assert.equal(result.status, 'occupied'); assert.equal(result.code, 'DESKTOP_TARGET_OCCUPIED');
  assert.equal(result.matches[0].ownerSessionId, 'same-name'); assert.equal(result.matches[0].generation, 1);
});
test('user handoff, parked, reconnecting and disconnected drivers do not release authoritative ownership', () => {
  for (const driverState of ['parked', 'reconnecting', 'disconnected']) {
    const s = gateway(base(), owned({ ownership: 'user', driverState, agentHealth: 'waiting' }));
    assert.equal(evaluate(s, 'occupied').matches[0].reason, 'gateway_user_control');
  }
});
test('Gateway no-owner state is available only while its route is present', () => {
  const s = gateway(base(), binding()); evaluate(s, 'available');
  s.gateway.value.ports = [];
  assert.equal(evaluate(s, 'unknown').matches[0].reason, 'gateway_route_disconnected');
});
test('last-known Gateway PID keeps a failed service associated and unknown', () => {
  const s = gateway(base(), owned()); s.gateway = unavailable(s.gateway.value);
  const result = evaluate(s, 'unknown'); assert.equal(result.matches[0].profileId, 'isolated:a');
  assert.equal(result.matches[0].reason, 'gateway_unavailable');
});
test('catalog and Gateway rows for one PID and Profile form one association', () => {
  const s = gateway(base(), binding()); s.catalog.value.profiles.push(profile());
  assert.equal(evaluate(s, 'available').matches.length, 1);
});
test('a changed target PID or conflicting port identity fails closed', () => {
  const s = gateway(base(), binding({ chromePid: 99 })); s.catalog.value.profiles.push(profile());
  assert.equal(evaluate(s, 'unknown').matches[0].reason, 'target_pid_changed');
  s.gateway.value.profiles[0] = binding({ profileId: 'isolated:other' });
  evaluate(s, 'unknown', 'ambiguous_target_mapping');
});
test('multiple Profiles in the same native Chrome process remain ambiguous, including a known owner', () => {
  const s = base();
  s.catalog.value.profiles = [profile({ id: 'native:Default', source: 'native' }), profile({ id: 'native:Work', source: 'native' })];
  s.native = ready([native({ ownerSessionId: 'busy', ownership: 'agent' }), native({ profileId: 'native:Work' })]);
  evaluate(s, 'unknown', 'ambiguous_target_mapping');
});
test('default Chrome extension ownership is joined through Profile PID membership', () => {
  const s = base(); s.catalog.value.profiles = [profile({ id: 'native:Default', source: 'native', pids: [41, 42], browserPids: [41] })];
  s.native = ready([native({ ownerSessionId: 'browser-task', ownership: 'agent' })]);
  const result = evaluate(s, 'occupied'); assert.equal(result.matches[0].source, 'native');
  s.native.value[0] = native({ ownerSessionId: 'browser-task', pausedByBrowser: true });
  assert.equal(evaluate(s, 'occupied').matches[0].reason, 'native_user_control');
  s.native.value[0] = native(); evaluate(s, 'available');
});
test('known native mapping with missing, disconnected, interrupted or stale control state is unknown', () => {
  for (const state of [ready([]), ready([native({ connected: false, ownerSessionId: 'old' })]), ready([native({ controlIssue: { code: 'X', message: 'private data' } })]), unavailable()]) {
    const s = base(); s.catalog.value.profiles = [profile({ id: 'native:Default', source: 'native' })]; s.native = state;
    const result = evaluate(s, 'unknown'); assert.equal(JSON.stringify(result).includes('private data'), false);
  }
});
test('an extension owner without a discoverable Profile PID cannot disappear into unmanaged', () => {
  const s = base(); s.native = ready([native({ ownerSessionId: 'busy' })]);
  assert.ok(evaluate(s, 'unknown').gaps.includes('native:owner_pid_unresolved'));
});
test('Gateway and compatibility owners without any resolvable process keep mapping unknown', () => {
  const s = gateway(base(), owned({ chromePid: undefined }));
  assert.ok(evaluate(s, 'unknown').gaps.includes('gateway:unresolved_process'));
  s.gateway = ready({ profiles: [], ports: [] });
  s.catalog.value.profiles = [profile({ pids: [], browserPids: [], agentBrowserOccupancy: { session: 'reserved', ownership: 'user' } })];
  assert.ok(evaluate(s, 'unknown').gaps.includes('catalog:owner_pid_unresolved'));
});
test('registered Electron uses local-app ID and actual target PID, not the daemon PID', () => {
  const s = gateway(base(), owned({ profileId: 'local-app:app-a', daemonPid: 91 })); s.apps = ready([app({ agentPort: 9224 })]);
  const result = evaluate(s, 'occupied'); assert.equal(result.matches[0].profileId, 'local-app:app-a');
  assert.equal(evaluateDesktopAdmission({ pid: 91 }, s, { now: 1000 }).status, 'unmanaged');
});
test('registered app with known absent agent route is available; expected but missing route is unknown', () => {
  const s = base(); s.apps = ready([app()]); evaluate(s, 'available');
  s.apps.value[0].agentPort = 9224; assert.equal(evaluate(s, 'unknown').matches[0].reason, 'app_gateway_binding_missing');
});
test('a runtime-disconnected app retains its PID association; a running app without PID leaves discovery incomplete', () => {
  const s = base(); s.apps = ready([app({ runtime: { status: 'unknown', pid: 41 } })]); evaluate(s, 'unknown');
  s.apps.value[0].runtime.pid = null; evaluate(s, 'unknown', 'mapping_incomplete');
});
test('legacy delegated leases block but never mistake holder or daemon PIDs for target PIDs', () => {
  const s = base(); s.catalog.value.profiles = [profile({ agentBrowserOccupancy: { session: 'legacy', ownership: 'user', holderPid: 81, daemonPid: 82 } })];
  assert.equal(evaluate(s, 'occupied').matches[0].reason, 'legacy_user_control');
  assert.equal(evaluateDesktopAdmission({ pid: 81 }, s, { now: 1000 }).status, 'unmanaged');
});
test('authoritative stopped Gateway state supersedes an old compatibility lease', () => {
  const s = gateway(base(), binding()); s.catalog.value.profiles = [profile({ agentBrowserOccupancy: { session: 'old', ownership: 'user' } })];
  evaluate(s, 'available');
});
test('cached Gateway metadata or raw legacy clients cannot substitute for a missing owner snapshot', () => {
  const s = base(); s.catalog.value.profiles = [profile({ gatewayControl: { ownerSessionId: 'old' } })]; evaluate(s, 'unknown');
  s.catalog.value.profiles = [profile({ cdpClients: [{ pid: 91, session: 'legacy' }] })]; evaluate(s, 'unknown');
});
test('external browser PID can join a known Gateway route; an unmapped external control remains unknown', () => {
  const s = gateway(base(), owned()); s.catalog.value.externalInstances = [{ pid: 41, cdpPort: 9224, cdpClients: [] }]; evaluate(s, 'occupied');
  s.gateway = ready({ profiles: [], ports: [] }); evaluate(s, 'unknown');
});
test('malformed rows, duplicate bindings and invalid target PID do not become free targets', () => {
  for (const key of ['catalog', 'gateway', 'apps']) { const s = base(); s[key] = ready(null); evaluate(s, 'unknown'); }
  const s = gateway(base(), binding()); s.gateway.value.profiles.push(binding()); evaluate(s, 'unknown');
  assert.equal(evaluateDesktopAdmission({ pid: 0 }, base(), { now: 1000 }).status, 'unknown');
});
test('pure admission does not mutate providers and cannot reserve against a later owner', () => {
  const s = gateway(base(), binding()), before = structuredClone(s); evaluate(s, 'available'); assert.deepEqual(s, before);
  s.gateway.value.profiles[0] = owned({ controlGeneration: 2 }); evaluate(s, 'occupied');
});
function providersFor(s, extra = {}) { return Object.fromEntries(Object.keys(s).map(name => [name, extra[name] || (() => s[name])])); }
test('async wrapper reads injected providers once, performs no retries, and preserves known mapping on failure', async () => {
  const s = gateway(base(), owned()); let calls = 0, fail = false;
  const check = createDesktopAdmission(providersFor(s, { gateway: () => { calls++; if (fail) throw new Error('private path/token'); return s.gateway; } }), { now: () => 1000, timeoutMs: 100 });
  assert.equal((await check(target)).status, 'occupied'); fail = true;
  const result = await check(target); assert.equal(result.status, 'unknown'); assert.equal(result.matches[0].profileId, 'isolated:a');
  assert.equal(calls, 2); assert.equal(JSON.stringify(result).includes('private path/token'), false);
});
test('provider timeout is bounded, keeps old associations, and ignores late success for caching', async () => {
  const s = gateway(base(), owned()); let read = 0, late;
  const check = createDesktopAdmission(providersFor(s, { gateway: () => {
    read++;
    if (read === 1) return s.gateway;
    if (read === 2) return new Promise(resolve => { late = resolve; });
    return unavailable();
  } }), { now: () => 1000, timeoutMs: 20 });
  await check(target);
  const result = await check(target); assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('gateway:provider_timeout'));
  late(ready({ profiles: [], ports: [] })); await new Promise(resolve => setImmediate(resolve));
  const after = await check(target); assert.equal(after.matches[0].profileId, 'isolated:a'); assert.equal(read, 3);
});
test('wrapper keeps source unavailability and does not refresh a stale provider timestamp', async () => {
  const s = base(); s.catalog.capturedAt = -10000;
  const check = createDesktopAdmission(providersFor(s), { now: () => 1000, timeoutMs: 100 });
  assert.ok((await check(target)).gaps.includes('catalog:stale_snapshot'));
});
test('discovery-first samples a new owner after slow PID discovery instead of retaining an earlier idle result', async () => {
  for (const discoveryFirst of [false, true]) {
    let now = 1000, becameOwned = false, releaseCatalog, gatewayReads = 0, nativeReads = 0;
    const stamp = value => ({ state: 'ready', value, capturedAt: now });
    const check = createDesktopAdmission({
      catalog: () => { const capturedAt = now; return new Promise(resolve => { releaseCatalog = () => resolve({ state: 'ready', capturedAt, value: catalog(capturedAt) }); }); },
      apps: () => stamp([]),
      gateway: () => { gatewayReads++; return stamp({ profiles: [becameOwned ? owned() : binding()], ports: [9224] }); },
      native: () => { nativeReads++; return stamp([]); }
    }, { now: () => now, maxAgeMs: 10000, controlMaxAgeMs: 2500, discoveryFirst, timeoutMs: 100 });
    const pending = check(target); await new Promise(resolve => setImmediate(resolve));
    assert.equal(gatewayReads, discoveryFirst ? 0 : 1); assert.equal(nativeReads, discoveryFirst ? 0 : 1);
    now = 3000; becameOwned = true; releaseCatalog();
    const result = await pending;
    assert.equal(result.status, discoveryFirst ? 'occupied' : 'available');
    assert.equal(gatewayReads, 1); assert.equal(nativeReads, 1);
  }
});
test('ownership freshness rejects an early control response while a second control source is delayed', async () => {
  let now = 1000, releaseNative;
  const stamp = value => ({ state: 'ready', value, capturedAt: now });
  const check = createDesktopAdmission({
    catalog: () => stamp(catalog(now)), apps: () => stamp([]),
    gateway: () => stamp({ profiles: [binding()], ports: [9224] }),
    native: () => new Promise(resolve => { releaseNative = () => resolve(stamp([])); })
  }, { now: () => now, maxAgeMs: 10000, controlMaxAgeMs: 2500, discoveryFirst: true, timeoutMs: 100 });
  const pending = check(target); await new Promise(resolve => setImmediate(resolve));
  now = 3501; releaseNative();
  const result = await pending;
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('gateway:stale_snapshot'));
  assert.equal(result.gaps.includes('catalog:stale_snapshot'), false);
});
test('native ownership has the shorter freshness limit independently of PID discovery', () => {
  const s = base(); s.catalog.value.profiles = [profile({ id: 'native:Default', source: 'native' })];
  s.native = ready([native()]); s.gateway.capturedAt = 4000;
  const result = evaluateDesktopAdmission(target, s, { now: 4000, maxAgeMs: 10000, controlMaxAgeMs: 2500 });
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('native:stale_snapshot'));
  assert.equal(result.gaps.includes('catalog:stale_snapshot'), false);
});
test('discovery-first preserves original mapping timestamps instead of refreshing them before owner checks', async () => {
  let now = 1000, releaseCatalog;
  const stamp = value => ({ state: 'ready', value, capturedAt: now });
  const check = createDesktopAdmission({
    catalog: () => { const capturedAt = now; return new Promise(resolve => { releaseCatalog = () => resolve({ state: 'ready', capturedAt, value: catalog(capturedAt) }); }); },
    apps: () => stamp([]), gateway: () => stamp({ profiles: [], ports: [] }), native: () => stamp([])
  }, { now: () => now, maxAgeMs: 3000, controlMaxAgeMs: 2500, discoveryFirst: true, timeoutMs: 100 });
  const pending = check(target); await new Promise(resolve => setImmediate(resolve)); now = 4001; releaseCatalog();
  const result = await pending;
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('catalog:stale_snapshot'));
  assert.equal(result.gaps.includes('gateway:stale_snapshot'), false);
});
