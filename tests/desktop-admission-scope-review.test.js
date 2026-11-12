const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const test = require('node:test');

// Scoped discovery and remaining conservative boundaries. No real process or
// filesystem providers run; current production source executes with mocks.
function source(name, stubs = {}) {
  const file = path.resolve(__dirname, '../src/main', `${name}.ts`);
  const output = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  const module = { exports: {} };
  const forbidden = () => assert.fail('A review test attempted real OS or profile access');
  vm.runInThisContext(`(function(require,module,exports,process){${output}\n})`, { filename: file })(id => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id === './profile-process-change' || id === '../profile-process-change') return source('profile-process-change');
    if (id === './windows-sampler-protocol') return source('windows-sampler-protocol');
    if (id === 'node:path') return path.win32;
    if (id === 'node:fs') return { existsSync: forbidden, promises: new Proxy({}, { get: () => forbidden }) };
    if (id === 'node:child_process') return { execFile: forbidden, spawn: forbidden };
    if (id === 'electron') return { app: { getAppMetrics: forbidden } };
    if (id.startsWith('node:') || id === 'zod') return require(id);
    if (id.startsWith('.')) return {};
    throw new Error(`Unexpected dependency ${id}`);
  }, module, module.exports, { platform: 'win32', env: {}, pid: 1234 });
  return module.exports;
}
const admission = source('desktop/admission');
const ready = value => ({ state: 'ready', value, capturedAt: 100 });
const emptyCatalog = () => ({ profiles: [], externalInstances: [], discovery: {
  snapshotId: 'fixture', capturedAt: 100, complete: true, processPids: [321, 701, 702], scopedGaps: [] } });
const emptySnapshots = () => ({ catalog: ready(emptyCatalog()), gateway: ready({ profiles: [], ports: [] }),
  native: ready([]), apps: ready([]) });
function providers(catalog) {
  return { catalog, gateway: () => ready({ profiles: [], ports: [] }), native: () => ready([]), apps: () => ready([]) };
}
const target = { pid: 321 };
const processRow = (pid, name, commandLineAvailable = true) => ({ pid, name, parentPid: 4,
  executablePath: `C:\\Applications\\${name}`, commandLine: `C:\\Applications\\${name}`,
  commandLineAvailable, startedAt: '2026-10-29T00:00:00Z', identityStatus: 'confirmed', creationFileTime: '134000000000000000' });

test('scoped unreadable Chrome denies its PID but excludes an unrelated observed PID without name inference', async () => {
  const catalog = emptyCatalog();
  catalog.discovery.scopedGaps = [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [701] }];
  const decide = admission.createDesktopAdmission(providers(() => ready(catalog)), { now: () => 100 });
  const decision = await decide(target);
  assert.equal(decision.status, 'unmanaged');
  assert.deepEqual(decision.matches, []);
  assert.deepEqual(decision.gaps, []);
  assert.equal((await decide({ pid: 701 })).status, 'unknown');
  assert.equal((await decide({ pid: 999 })).status, 'unknown');
  assert.equal((await decide({ pid: 321, process: 'chrome.exe' })).status, 'unmanaged');
});

test('counterexample: malformed native Local State denies the whole catalog before target association', async () => {
  const { ProfileStateReader } = source('profile-state', {
    'node:fs': { promises: { readFile: async () => '{broken-json' } },
    './chrome-launch': { nativeChromeUserDataDir: () => 'C:\\ChromeData' },
    './process-scan': { createControlRuntimeScan: async () => ({ strict: true,
      processes: [processRow(321, 'Fixture.exe'), processRow(701, 'chrome.exe')],
      controlDiscovery: { ...emptyCatalog().discovery,
        scopedGaps: [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [701] }] } }) }
  });
  const reader = new ProfileStateReader({ dataDir: 'C:\\Store', profilesDir: 'C:\\Store\\profiles',
    readGatewayStatus: async () => null, loadRegistry: async () => ({ profiles: [] }), getActivity: () => null });
  const decide = admission.createDesktopAdmission(providers(async () => {
    const { state } = await reader.collect({ strictDiscovery: true });
    return ready({ profiles: state.profiles, externalInstances: state.externalInstances });
  }), { now: () => 100 });
  const decision = await decide(target);
  assert.equal(decision.status, 'unknown');
  assert.deepEqual(decision.matches, []);
  assert.deepEqual(decision.gaps, ['catalog:provider_failed']);
});

test('counterexample: two exactly matched app candidates lose their PIDs when represented as unknown', () => {
  const idleRuntime = () => ({ status: 'stopped', pid: null, startedAt: null, exitCode: null, error: '' });
  const { processRuntimeFromSnapshot } = source('local-apps/service-runtime', { './protocol': { idleRuntime } });
  const config = { id: 'app', mode: 'attach', command: 'C:\\Applications\\Editor.exe', cwd: '', cdpPort: 9223 };
  const processes = [processRow(321, 'Fixture.exe'), processRow(701, 'Editor.exe'), processRow(702, 'Editor.exe')];
  const runtime = processRuntimeFromSnapshot(config, { processes, tcp: [], processesAvailable: true, tcpAvailable: true }, 'win32');
  assert.equal(runtime.status, 'unknown');
  assert.equal(runtime.pid, null);
  const snapshots = emptySnapshots();
  snapshots.apps = ready([{ id: 'app', runtime, agent: { connected: false } }]);
  const decision = admission.evaluateDesktopAdmission(target, snapshots, { now: 100 });
  assert.equal(decision.status, 'unknown');
  assert.deepEqual(decision.matches, []);
  assert.deepEqual(decision.gaps, ['apps:unresolved_process']);
});

test('global boundary: a malformed row containing an unidentified PID cannot prove target exclusion', () => {
  const snapshots = emptySnapshots();
  snapshots.catalog = ready({ ...emptyCatalog(), profiles: [{ id: 'isolated:bad', source: 'isolated', pids: [701, 'invalid'],
    browserPids: [701], cdpPort: null, fixedCdpPort: null, cdpClients: [] }] });
  const decision = admission.evaluateDesktopAdmission(target, snapshots, { now: 100 });
  assert.equal(decision.status, 'unknown');
  assert.deepEqual(decision.gaps, ['catalog:invalid_profile']);
});

test('scope boundary: native file-lock mapping currently admits a non-browser process as a Profile PID', async () => {
  const processes = [processRow(321, 'Fixture.exe'), processRow(701, 'chrome.exe')];
  const scan = source('process-scan', {
    'node:fs': { existsSync: () => false, promises: { stat: async () => ({ isFile: () => true }) } },
    './windows-platform': { createWindowsReadContext: () => ({ now: Date.now, deadlineAt: Date.now() + 8000, signal: new AbortController().signal }),
      findWindowsProcessIdentitiesLockingPaths: async paths => new Map([[paths[0], [{ pid: 321, creationFileTime: '134000000000000000' }]]]) }
  });
  const profilePath = 'C:\\ChromeData\\Default';
  const result = await scan.getOpenProfilePidsByPath([profilePath], { strict: true,
    windowsSnapshot: { processes, tcp: [], processesAvailable: true, processesComplete: true } });
  assert.ok(result.get(profilePath).includes(321), 'an executable-name exclusion alone would disagree with current mapping');
});

test('baseline: fully identified unrelated active owner is excluded without discarding its occupancy', () => {
  const snapshots = emptySnapshots();
  snapshots.gateway = ready({ ports: [9223], profiles: [{ profileId: 'isolated:known', publicPort: 9223,
    chromePid: 701, ownerSessionId: 'other', ownership: 'agent', sessionStatus: 'active', controlGeneration: 1 }] });
  assert.equal(admission.evaluateDesktopAdmission(target, snapshots, { now: 100 }).status, 'unmanaged');
  assert.equal(admission.evaluateDesktopAdmission({ pid: 701 }, snapshots, { now: 100 }).status, 'occupied');
});

function runtimeOptions(overrides = {}) {
  return { catalog: async () => emptyCatalog(), apps: async () => [],
    gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }), ...overrides };
}
function runtimeFactory() {
  return source('desktop/runtime-admission', { './admission': admission }).createRuntimeDesktopAdmission;
}

test('cost boundary: completed sequential reads start fresh catalog and app scans each time', async () => {
  const calls = { catalog: 0, apps: 0, gateway: 0, native: 0 };
  let now = 100;
  const decide = runtimeFactory()(runtimeOptions({ now: () => now,
    catalog: async () => { calls.catalog++; return emptyCatalog(); }, apps: async () => { calls.apps++; return []; },
    gateway: async () => { calls.gateway++; return { state: { profiles: [] }, ports: [] }; },
    native: async () => { calls.native++; return { states: [] }; } }));
  for (let index = 0; index < 5; index++) { assert.equal((await decide(target)).status, 'unmanaged'); now += 250; }
  assert.deepEqual(calls, { catalog: 5, apps: 5, gateway: 5, native: 5 });
});

test('cost boundary: only concurrent reads share the in-flight discovery operation', async () => {
  let finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const decide = runtimeFactory()(runtimeOptions({ now: () => 100, catalog: async () => { calls++; await gate; return emptyCatalog(); } }));
  const first = decide(target), second = decide(target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  await decide(target);
  assert.equal(calls, 2);
});

test('freshness boundary: slow collection retains its original timestamp and is rejected when already stale', async () => {
  let now = 100;
  // Isolate stale evidence from the separately tested caller deadline.
  const decide = runtimeFactory()(runtimeOptions({ now: () => now, timeoutMs: 10000,
    catalog: async () => { now += 7000; return emptyCatalog(); } }));
  const decision = await decide(target);
  assert.equal(decision.status, 'unknown');
  assert.ok(decision.gaps.includes('catalog:stale_snapshot'));
});

test('catalog evidence retains its age even when a provider returns the old value in a fresh wrapper', async () => {
  let now = 100, providerCalls = 0;
  const oldValue = emptyCatalog();
  const decide = runtimeFactory()(runtimeOptions({ now: () => now,
    catalog: async () => { providerCalls++; return oldValue; } }));
  assert.equal((await decide(target)).status, 'unmanaged');
  now += 60000;
  const result = await decide(target);
  assert.equal(result.status, 'unknown');
  assert.ok(result.gaps.includes('catalog:stale_discovery'));
  assert.equal(result.gaps.includes('catalog:stale_snapshot'), false);
  assert.equal(providerCalls, 2);
});

test('missing or invalid same-collection evidence cannot turn a scoped failure into unmanaged', () => {
  const variants = [undefined, null, {}, { complete: false },
    { ...emptyCatalog().discovery, processPids: [] }, { ...emptyCatalog().discovery, processPids: [321, 321] },
    { ...emptyCatalog().discovery, processPids: [321, '701'] },
    { ...emptyCatalog().discovery, scopedGaps: [{ code: 'PROFILE_LOCAL_STATE_FAILED', processPids: [701] }] },
    { ...emptyCatalog().discovery, scopedGaps: [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [] }] },
    { ...emptyCatalog().discovery, scopedGaps: [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [999] }] }];
  for (const discovery of variants) {
    const snapshots = emptySnapshots(); snapshots.catalog.value.discovery = discovery;
    assert.equal(admission.evaluateDesktopAdmission(target, snapshots, { now: 100 }).status, 'unknown', JSON.stringify(discovery));
  }
});

test('both evidence and wrapper timestamps must be fresh and valid', () => {
  for (const [capturedAt, wrappedAt, reason] of [[0, 100, 'stale_discovery'], [100, 0, 'stale_snapshot'],
    [101, 100, 'stale_discovery'], [NaN, 100, 'stale_discovery']]) {
    const snapshots = emptySnapshots();
    snapshots.catalog.value.discovery.capturedAt = capturedAt; snapshots.catalog.capturedAt = wrappedAt;
    const result = admission.evaluateDesktopAdmission(target, snapshots, { now: 100, maxAgeMs: 50 });
    assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes(`catalog:${reason}`));
  }
});

test('a known owner without a resolved PID remains global even beside a valid unrelated scoped gap', () => {
  const snapshots = emptySnapshots();
  snapshots.catalog.value.discovery.scopedGaps = [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [701] }];
  snapshots.native = ready([{ profileId: 'native:Default', connected: true, ownerSessionId: 'browser-task', ownership: 'agent' }]);
  const result = admission.evaluateDesktopAdmission(target, snapshots, { now: 100 });
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('native:owner_pid_unresolved'));
  snapshots.native = ready([]);
  snapshots.catalog.value.profiles = [{ id: 'isolated:a', source: 'isolated', pids: [], browserPids: [],
    cdpClients: [], agentBrowserOccupancy: { session: 'known', ownership: 'agent' } }];
  assert.ok(admission.evaluateDesktopAdmission(target, snapshots, { now: 100 }).gaps.includes('catalog:owner_pid_unresolved'));
});

test('target outside the process universe remains unknown even if a later Gateway sample reports its owner', () => {
  const snapshots = emptySnapshots();
  snapshots.gateway = ready({ ports: [9223], profiles: [{ profileId: 'isolated:later', publicPort: 9223,
    chromePid: 999, ownerSessionId: 'other', ownership: 'agent', sessionStatus: 'active', controlGeneration: 1 }] });
  const result = admission.evaluateDesktopAdmission({ pid: 999 }, snapshots, { now: 100 });
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('catalog:target_process_not_observed'));
});
