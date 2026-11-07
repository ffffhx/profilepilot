const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { buildDesktopAppsControlSnapshot, buildDesktopAppsControlFromSample } = loadCli('src/main/desktop/apps-discovery.ts');
const { evaluateDesktopAdmission } = loadCli('src/main/desktop/admission.ts');
const { createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');
const ready = value => ({ state: 'ready', capturedAt: 100, value });
const app = extra => ({ id: 'app', mode: 'attach', command: '', cwd: '', cdpPort: 53663, inspectPort: null,
  agentPort: 56527, runtime: { status: 'unknown', pid: null }, ...extra });
const os = extra => ({ processes: [42, 701, 702].map(pid => ({ pid })), tcp: [],
  processesAvailable: true, processesComplete: true, tcpAvailable: true, tcpComplete: true, ...extra });
const binding = extra => ({ profileId: 'local-app:app', publicPort: 56527, chromePid: 701,
  ownership: 'user', sessionStatus: 'stopped', controlGeneration: 1, ...extra });
const snapshots = (apps = [app()]) => ({
  catalog: ready({ profiles: [], externalInstances: [], discovery: { snapshotId: 'fixture', capturedAt: 100,
    complete: true, processPids: [42, 701, 702], scopedGaps: [] } }),
  gateway: ready({ profiles: [], ports: [] }), native: ready([]), apps: ready(apps)
});
const decide = (s, pid = 42, options) => evaluateDesktopAdmission({ pid }, s, { now: 100, ...options });
function withControl(s, snapshot = os()) {
  const applications = Array.isArray(s.apps.value) ? s.apps.value : s.apps.value.applications;
  s.apps.value = { applications, control: buildDesktopAppsControlSnapshot(applications, snapshot, 100) };
  return s;
}

test('shared sample route evidence retains its identity, original age and incomplete flags', () => {
  const sample = { snapshotId: 'shared-fixture', capturedAt: 1, snapshot: os() };
  const control = buildDesktopAppsControlFromSample([app()], sample);
  assert.equal(control.snapshotId, sample.snapshotId); assert.equal(control.capturedAt, 1); assert.equal(control.complete, true);
  const incomplete = buildDesktopAppsControlFromSample([app()], { ...sample, snapshot: os({ tcpComplete: false }) });
  assert.equal(incomplete.complete, false); assert.ok(incomplete.gaps.includes('tcp_incomplete'));
  const invalidTime = buildDesktopAppsControlFromSample([app()], { ...sample, capturedAt: NaN });
  assert.equal(invalidTime.complete, false); assert.ok(invalidTime.gaps.includes('invalid_timestamp'));
  assert.throws(() => buildDesktopAppsControlFromSample([app()], { ...sample, snapshotId: '' }), /SAMPLE_INVALID/);
  const s = snapshots(); s.apps.value = { applications: [app()], control };
  assert.equal(decide(s, 42, { maxAgeMs: 50 }).status, 'unknown', 'a later wrapper cannot renew the OS evidence age');
});

test('fresh exact Gateway PID excludes an unrelated target without treating unknown runtime as healthy', () => {
  const s = snapshots(); s.gateway = ready({ profiles: [binding()], ports: [56527] });
  const before = structuredClone(s);
  assert.equal(decide(s).status, 'unmanaged');
  assert.equal(decide(s, 701).status, 'unknown');
  assert.ok(decide(s, 701).matches.some(match => match.reason === 'app_runtime_unavailable'));
  assert.deepEqual(s, before);
  s.gateway.value.profiles[0] = binding({ ownership: 'agent', ownerSessionId: 'owned', sessionStatus: 'active' });
  assert.equal(decide(s).status, 'unmanaged');
  assert.equal(decide(s, 701).status, 'unknown', 'an associated unknown app is not opened by a known owner');
});

test('Gateway PID scoping requires fresh complete universe, exact ID/port, and unique noncontradictory bindings', () => {
  const cases = [
    s => { s.gateway.capturedAt = -10000; },
    s => { s.apps.capturedAt = -10000; },
    s => { s.catalog.value.discovery.complete = false; },
    s => { s.catalog.value.discovery.processPids = [42]; },
    s => { s.catalog.value.discovery.capturedAt = -10000; },
    s => { s.gateway.value.profiles[0].profileId = 'local-app:other'; },
    s => { s.gateway.value.profiles[0].publicPort = 9223; },
    s => { s.gateway.value.profiles[0].chromePid = undefined; },
    s => { s.gateway.value.profiles.push(binding()); },
    s => { s.gateway.value.profiles.push(binding({ profileId: 'local-app:other', publicPort: 9223 })); },
    s => { s.gateway.value.profiles.push(binding({ chromePid: 702 })); },
    s => { s.apps.value.push(app({ id: 'other' })); },
    s => { s.apps.value.push(app({ agentPort: null })); }
  ];
  for (const mutate of cases) {
    const s = snapshots(); s.gateway = ready({ profiles: [binding()], ports: [56527] }); mutate(s);
    assert.equal(decide(s).status, 'unknown', mutate.toString());
  }
});

test('complete no-listener evidence excludes only an unidentified attach control route', () => {
  const s = withControl(snapshots()); const before = structuredClone(s);
  assert.equal(decide(s).status, 'unmanaged');
  assert.deepEqual(s, before);
  assert.equal(s.apps.value.applications[0].runtime.status, 'unknown');
  assert.equal(s.apps.value.applications[0].runtime.pid, null);
});

test('attach placeholder command text without process identity uses the same parser as OS evidence', () => {
  const s = withControl(snapshots([app({ command: 'placeholder' })]));
  assert.equal(s.apps.value.control.applications[0].identity, 'none');
  const before = structuredClone(s);
  assert.equal(decide(s).status, 'unmanaged');
  assert.deepEqual(s, before);
  s.apps.value.applications[0].command = 'C:\\Apps\\Editor.exe';
  const changed = decide(s);
  assert.equal(changed.status, 'unknown');
  assert.ok(changed.appIssues[0].reasons.includes('control_route_not_unidentified_attach'));
  const listener = withControl(snapshots([app({ command: 'placeholder' })]), os({ tcp: [{ state: 'Listen', localPort: 53663, pid: 701 }] }));
  assert.equal(decide(listener).status, 'unknown');
  const owned = withControl(snapshots([app({ command: 'placeholder', agent: { connected: false, sessionId: 'owner' } })]));
  assert.equal(decide(owned).status, 'unknown');
});

test('listener candidates retain exact PID evidence and prevent route-idle exclusion', () => {
  const tcp = [{ state: 'Listen', localPort: 53663, pid: 701 }, { state: 'Listen', localPort: 53663, pid: 702 },
    { state: 'Listen', localPort: 9333, pid: 42 }, { state: 'Established', localPort: 53663, pid: 42 }];
  const s = withControl(snapshots(), os({ tcp }));
  assert.deepEqual(s.apps.value.control.applications[0].candidatePids, [701, 702]);
  assert.deepEqual(s.apps.value.control.applications[0].listeners, [{ port: 53663, pid: 701 }, { port: 53663, pid: 702 }]);
  for (const pid of [42, 701, 702]) assert.equal(decide(s, pid).status, 'unknown');
  const agentOnly = withControl(snapshots(), os({ tcp: [{ state: 'Listen', localPort: 56527, pid: 701 }] }));
  assert.deepEqual(agentOnly.apps.value.control.applications[0].listeners, [{ port: 56527, pid: 701 }]);
  assert.deepEqual(agentOnly.apps.value.control.applications[0].candidatePids, [701]);
  assert.equal(decide(agentOnly).status, 'unknown', 'an unknown Agent-port listener cannot be treated as an empty route');
});

test('route-idle evidence rejects ownership, connected caches, Gateway bindings and live routes', () => {
  const agentCases = [{ connected: true }, { connected: false, sessionId: 'owned' },
    { connected: false, connectionActive: true }, { connected: false, ownership: 'agent' }, { sessionId: undefined }];
  for (const agent of agentCases) assert.equal(decide(withControl(snapshots([app({ agent })]))).status, 'unknown', JSON.stringify(agent));
  assert.equal(decide(withControl(snapshots([app({ agent: { connected: false, ownership: 'user' } })]))).status, 'unmanaged');
  for (const gateway of [
    { profiles: [binding({ chromePid: undefined })], ports: [] },
    { profiles: [binding({ profileId: 'other', chromePid: 701 })], ports: [] },
    { profiles: [binding({ publicPort: 9333, chromePid: undefined })], ports: [] },
    { profiles: [], ports: [56527] }, { profiles: [], ports: [53663] },
    { profiles: [binding({ profileId: 'other', publicPort: 53663 })], ports: [] }
  ]) {
    const s = withControl(snapshots()); s.gateway = ready(gateway);
    assert.equal(decide(s).status, 'unknown', JSON.stringify(gateway));
  }
});

test('stale, partial, mismatched, missing and malformed route evidence cannot free unknown apps', () => {
  const cases = [
    s => { s.apps.value.control = undefined; },
    s => { s.apps.value.control.complete = false; },
    s => { s.apps.value.control.capturedAt = -10000; },
    s => { s.apps.value.control.capturedAt = 101; },
    s => { s.apps.value.control.processPids = [701]; },
    s => { s.apps.value.control.processPids = [42, 42]; },
    s => { s.apps.value.control.applications = []; },
    s => { s.apps.value.control.applications.push(s.apps.value.control.applications[0]); },
    s => { s.apps.value.control.applications[0].routePorts = []; },
    s => { s.apps.value.control.applications[0].routePorts = [53664]; },
    s => { s.apps.value.control.applications[0].candidatePids = [701]; },
    s => { s.apps.value.control.applications[0].agentPort = 56528; },
    s => { s.apps.value.applications[0].mode = 'launch'; },
    s => { s.apps.value.applications[0].command = 'C:\\Apps\\Editor.exe'; },
    s => { s.apps.value.applications[0].cwd = 'C:\\Private'; },
    s => { s.apps.value.applications[0].cdpPort = 53664; },
    s => { s.gateway.capturedAt = -10000; },
    s => { s.catalog.value.discovery.complete = false; }
  ];
  for (const mutate of cases) { const s = withControl(snapshots()); mutate(s); assert.equal(decide(s).status, 'unknown', mutate.toString()); }
});

test('builder needs explicit OS completeness and excludes commands, paths and unrelated listeners from evidence', () => {
  const configured = app({ mode: 'launch', command: 'C:\\secret\\app.exe --token=private-token', cwd: 'C:\\secret' });
  const result = buildDesktopAppsControlSnapshot([configured], os({ tcp: [{ state: 'Listen', localPort: 9000, pid: 701 }] }), 100);
  assert.equal(result.complete, true); assert.equal(result.applications[0].identity, 'configured');
  assert.deepEqual(result.applications[0].listeners, []);
  assert.equal(/secret|private-token|app\.exe/.test(JSON.stringify(result)), false);
  for (const field of ['processesAvailable', 'processesComplete', 'tcpAvailable', 'tcpComplete']) {
    for (const value of [false, undefined]) assert.equal(buildDesktopAppsControlSnapshot([app()], os({ [field]: value }), 100).complete, false);
  }
  for (const snapshot of [os({ processes: [] }), os({ processes: [{ pid: 42 }, { pid: 42 }] }),
    os({ tcp: [{ state: 'Listen', localPort: 53663, pid: 999 }] }), os({ tcp: [{ state: 'Listen', localPort: 53663, pid: 0 }] }),
    os({ tcp: [{ state: 'Listen', localPort: -1, pid: 701 }] }), os({ tcp: [{ localPort: 53663, pid: 701 }] }),
    os({ tcp: [{ state: 'unknown', localPort: 53663, pid: 701 }] })]) {
    assert.equal(buildDesktopAppsControlSnapshot([app()], snapshot, 100).complete, false);
    assert.equal(decide(withControl(snapshots(), snapshot)).status, 'unknown');
  }
  assert.equal(buildDesktopAppsControlSnapshot([app(), app()], os(), 100).complete, false);
});

test('runtime collector passes exact application rows, shares pending scans and samples Gateway afterwards', async () => {
  const s = snapshots(); let release, controlCalls = 0, appCalls = 0; const order = [];
  const apps = [app()];
  const admit = createRuntimeDesktopAdmission({ now: () => 100,
    catalog: async () => s.catalog.value,
    apps: async () => { appCalls++; order.push('apps'); return apps; },
    appsControl: async rows => { assert.equal(rows, apps); controlCalls++; order.push('control');
      await new Promise(resolve => { release = resolve; }); return buildDesktopAppsControlSnapshot(rows, os(), 100); },
    gateway: async () => { order.push('gateway'); return { state: { profiles: [] }, ports: [] }; }, native: async () => ({ states: [] }) });
  const first = admit({ pid: 42 }), second = admit({ pid: 42 }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['apps', 'control']); assert.equal(controlCalls, 1); assert.equal(appCalls, 1);
  release(); assert.equal((await first).status, 'unmanaged'); assert.equal((await second).status, 'unmanaged');
  assert.ok(order.indexOf('gateway') > order.indexOf('control'));
  const third = admit({ pid: 42 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controlCalls, 2); release(); assert.equal((await third).status, 'unmanaged');
});

test('failed or stale optional evidence preserves known associations and never freshens an unknown route', async () => {
  for (const read of [async () => { throw new Error('private-path'); },
    async rows => buildDesktopAppsControlSnapshot(rows, os(), -10000)]) {
    const s = snapshots(); const admit = createRuntimeDesktopAdmission({ now: () => 100,
      catalog: async () => s.catalog.value, apps: async () => s.apps.value, appsControl: read,
      gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) });
    const result = await admit({ pid: 42 }); assert.equal(result.status, 'unknown');
    assert.ok(result.gaps.includes('apps:unresolved_process')); assert.equal(JSON.stringify(result).includes('private-path'), false);
  }
});

test('timed-out optional OS evidence is not retried concurrently or accepted as a new sample later', async () => {
  const s = snapshots(); let reads = 0, release;
  const admit = createRuntimeDesktopAdmission({ now: () => 100, timeoutMs: 10,
    catalog: async () => s.catalog.value, apps: async () => s.apps.value,
    appsControl: rows => { reads++; return new Promise(resolve => { release = () => resolve(buildDesktopAppsControlSnapshot(rows, os(), 100)); }); },
    gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) });
  assert.equal((await admit({ pid: 42 })).status, 'unknown');
  assert.equal((await admit({ pid: 42 })).status, 'unknown'); assert.equal(reads, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  const next = admit({ pid: 42 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2); release(); assert.equal((await next).status, 'unmanaged');
});

test('doctor evidence identifies the blocked app and exact OS, route or cached-owner reason', () => {
  const missing = decide(snapshots());
  assert.deepEqual(missing.appIssues, [{ appId: 'app', reasons: ['gateway_binding_missing', 'control_snapshot_missing'] }]);
  const partial = decide(withControl(snapshots(), os({ tcpComplete: false })));
  assert.deepEqual(partial.appIssues, [{ appId: 'app', reasons: ['gateway_binding_missing', 'control_tcp_incomplete', 'control_snapshot_incomplete'] }]);
  const gone = decide(withControl(snapshots(), os({ tcp: [{ state: 'Listen', localPort: 9999, pid: 999 }] })));
  assert.ok(gone.appIssues[0].reasons.includes('control_listener_process_unresolved'));
  const listener = decide(withControl(snapshots(), os({ tcp: [{ state: 'Listen', localPort: 56527, pid: 701 }] })));
  assert.ok(listener.appIssues[0].reasons.includes('control_route_listener_present'));
  const cached = decide(withControl(snapshots([app({ agent: { connected: false, sessionId: 'private-owner-name' } })])));
  assert.ok(cached.appIssues[0].reasons.includes('app_agent_owner_conflict'));
  assert.equal(JSON.stringify(cached.appIssues).includes('private-owner-name'), false);
  const stale = withControl(snapshots()); stale.apps.value.control.capturedAt = -10000;
  assert.ok(decide(stale).appIssues[0].reasons.includes('control_snapshot_stale'));
});

test('app diagnostics are bounded and never echo arbitrary configuration or provider content', () => {
  const s = withControl(snapshots([app({ id: 'C:\\private\\app.exe' })]));
  s.apps.value.control.complete = false;
  s.apps.value.control.gaps = ['private-token', 'C:\\private\\secret', 'tcp_incomplete'];
  const result = decide(s);
  assert.equal(result.appIssues[0].appId, 'invalid-app-id');
  assert.deepEqual(result.appIssues[0].reasons, ['gateway_binding_missing', 'control_tcp_incomplete', 'control_snapshot_incomplete']);
  assert.equal(/private|secret/.test(JSON.stringify(result.appIssues)), false);
  const many = decide(snapshots(Array.from({ length: 105 }, (_, i) => app({ id: `app-${i}` }))));
  assert.equal(many.appIssues.length, 100); assert.equal(many.appIssuesTruncated, true);
  assert.equal(many.status, 'unknown');
});
