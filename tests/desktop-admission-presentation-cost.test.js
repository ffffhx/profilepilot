const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const test = require('node:test');

// Only checked-in source is read. OS, git, session archives and profile files
// below are synthetic boundaries; counts are not a wall-clock benchmark.
const forbidden = () => assert.fail('Unexpected OS, network, user file or GUI access');
const absent = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const compiled = new Map();
const now = 1000;
class Clock extends Date { static now() { return now; } }
function load(name, platform, stubs = {}, importer = Function) {
  const file = path.resolve(__dirname, '../src/main', `${name}.ts`);
  if (!compiled.has(file)) compiled.set(file, transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code);
  const module = { exports: {} };
  const requireStub = id => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id === './profile-process-change' || id === '../profile-process-change') return load('profile-process-change', platform);
    if (id === 'node:path') return platform === 'win32' ? path.win32 : path.posix;
    if (id === 'node:os') return { homedir: () => platform === 'win32' ? 'C:\\Fixture' : '/Fixture' };
    if (id === 'node:fs' || id === 'node:fs/promises' || id === 'node:child_process' || id === 'node:http' || id === 'node:net')
      return new Proxy({}, { get: () => forbidden });
    if (id === 'electron') return { app: { getAppMetrics: () => [] } };
    if (id.startsWith('node:')) return require(id);
    if (id.startsWith('.')) return {};
    throw Error(`Unexpected dependency ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports,process,Date,Function){${compiled.get(file)}\n})`, { filename: file })(
    requireStub, module, module.exports, { platform, pid: 9000, env: { CPM_E2E_DETERMINISTIC: '1' },
      execPath: platform === 'win32' ? 'C:\\ProfilePilot\\app.exe' : '/ProfilePilot.app/ProfilePilot' }, Clock, importer);
  return module.exports;
}
const session = 'cx-11111111-1111-1111-1111-111111111111';
const activity = (extra = {}) => ({ version: 1, session, command: 'observe', pid: 44, cdpPort: 9203,
  cwd: '/Fixture/repository', updatedAt: new Date(500).toISOString(), expiresAt: new Date(2000).toISOString(), ...extra });
const records = () => ({
  'active.json': activity(),
  'stored.json': activity({ session: 'stored', pid: 77, project: 'stored-project', branch: 'stored-branch' }),
  'other-port.json': activity({ session: 'other', pid: 78, cdpPort: 9299 }),
  'expired.json': activity({ session: 'expired', pid: 79, expiresAt: new Date(999).toISOString() }),
  'invalid.json': activity({ session: 'invalid', pid: -1 }),
  'broken.json': '{',
  'ignored.txt': activity()
});
function activityApi(platform, counts) {
  const entries = records(), pathApi = platform === 'win32' ? path.win32 : path.posix;
  const repository = load('browser-driver-context', platform, { 'node:child_process': { execFileSync: (_exe, args) => {
    counts.git++;
    if (args.includes('--show-toplevel')) return '/Fixture/repository\n';
    if (args.includes('get-url')) return 'https://fixture.invalid/example/project.git\n';
    if (args.includes('--show-current')) return 'fixture-branch\n';
    return '1234567\n';
  } } });
  return load('agent-browser-session', platform, {
    './browser-driver-context': repository,
    'node:fs/promises': {
      readdir: async () => { counts.activityLists++; return Object.keys(entries); },
      readFile: async file => { counts.activityReads++; const value = entries[pathApi.basename(file)]; return typeof value === 'string' ? value : JSON.stringify(value); },
      rm: async file => { counts.removed.push(pathApi.basename(file)); }
    }
  });
}
const counters = () => ({ git: 0, activityLists: 0, activityReads: 0, removed: [],
  contexts: 0, os: 0, canonical: 0, archiveEnumerations: 0 });
const withoutDisplay = client => {
  const { project, branch, canonicalSessionId, sessionRepresentations, sessionDiagnostics, ...evidence } = client;
  return evidence;
};
const mapEvidence = map => [...map].map(([port, clients]) => [port, clients.map(withoutDisplay)]);

for (const platform of ['win32', 'darwin']) test(`${platform}: activity presentation opt-out keeps all occupancy records and TTL/port filtering`, async () => {
  const displayed = counters(), minimal = counters();
  const normal = await activityApi(platform, displayed).readActiveAgentBrowserSessionActivityClientsByPort([9203], undefined, now);
  const control = await activityApi(platform, minimal).readActiveAgentBrowserSessionActivityClientsByPort([9203], undefined, now, { includeRepository: false });
  assert.equal(displayed.git, 6, 'both active records without repository metadata are enriched before port filtering');
  assert.equal(minimal.git, 0, 'control collection must never execute display-only git');
  assert.deepEqual(mapEvidence(control), mapEvidence(normal));
  assert.equal(control.get(9203).length, 2);
  assert.equal(normal.get(9203)[0].project, 'project');
  assert.equal(normal.get(9203)[0].branch, 'fixture-branch');
  assert.equal(control.get(9203)[1].project, 'stored-project', 'existing metadata is retained');
  assert.equal(control.get(9203)[1].branch, 'stored-branch');
  assert.equal(minimal.activityReads, displayed.activityReads);
  assert.equal(minimal.activityLists, displayed.activityLists);
  assert.deepEqual(minimal.removed.sort(), displayed.removed.sort(), 'cleanup/invalid/expired handling is unchanged');
});

function readerFixture(platform) {
  const counts = counters(), pathApi = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\Fixture' : '/Fixture';
  const processes = [41, 42, 43, 44, 77, 78, 88].map(pid => ({ pid, parentPid: 4, name: 'fixture', commandLine: 'fixture',
    executablePath: null, commandLineAvailable: true, startedAt: null }));
  const snapshot = { processes, tcp: [{ pid: 44, state: 'Established', localPort: 50000, remotePort: 9203 }],
    processesAvailable: true, processesComplete: true, tcpAvailable: true, tcpComplete: true };
  const discovery = { snapshotId: 'fixture', capturedAt: now, complete: true, processPids: processes.map(row => row.pid), scopedGaps: [] };
  const scan = { strict: true, processes: [], windowsSnapshot: snapshot, controlDiscovery: discovery };
  const activities = activityApi(platform, counts);
  const scanner = load('process-scan', platform, {
    './agent-browser-session': activities,
    './agent-browser-lease': { readAgentBrowserProfileLeaseSync: port => port === 9202 ? {
      delegatedToUser: true, session: 'paused-owner', holderPid: 88, daemonPid: 88, updatedAt: new Date(500).toISOString() } : null },
    './windows-platform': { getWindowsSystemSnapshot: forbidden,
      createWindowsReadContext: () => ({ now: () => now, deadlineAt: now + 8000, signal: new AbortController().signal }) },
    './session-context': { resolveClientContexts: async () => { counts.contexts++; return new Map([[44, { label: 'agent-browser', session }]]); } },
    './cdp-client': { isValidTcpPort: value => Number.isInteger(value) && value > 0 && value <= 65535 },
    './fs-util': { uniqueNumbers: values => [...new Set(values)], compareNumbers: (a, b) => a - b,
      laterIsoDate: (a, b) => a > b ? a : b,
      execFileAsync: async (executable, args) => { counts.os++;
        if (executable === 'lsof' && args.includes('-sTCP:ESTABLISHED')) return { stdout: 'p44\ncnode\nn127.0.0.1:50000->127.0.0.1:9203\n', stderr: '' };
        if (executable === 'ps' && args.includes('pid=,comm=')) return { stdout: '44 /fixture-driver\n', stderr: '' };
        return forbidden();
      } }
  });
  const core = {
    defaultRoots: () => ({ codex: ['/synthetic/codex'], claude: ['/synthetic/claude'] }),
    discoverSessionFiles: () => { counts.archiveEnumerations++; return [{ path: `/synthetic/session-${session.slice(3)}.jsonl`, mtimeMs: 0, sizeBytes: 1 }]; }
  };
  function importer(...args) { assert.deepEqual(args, ['specifier', 'return import(specifier)']); return async () => core; }
  const identities = load('session-identity', platform, {}, importer);
  const connections = load('profile-connections', platform, {
    './session-identity': { resolveCanonicalSessionIdentity: async id => { counts.canonical++; return identities.resolveCanonicalSessionIdentity(id); } }
  });
  const profileRows = [1, 2, 3].map(id => ({ id: String(id), dirName: `profile-${id}`, name: `Fixture ${id}`, createdAt: '2026-10-30', fixedCdpPort: 9200 + id }));
  const { ProfileStateReader } = load('profile-state', platform, {
    'node:fs': { promises: { readFile: absent } },
    './process-scan': { ...scanner, createControlRuntimeScan: async () => scan,
      findExternalChromeInstances: async () => [], emptyRuntimeProfile: () => ({ pids: [], browserPids: [], cdpPort: null, listeningPorts: [], startedAt: null }) },
    './chrome-launch': { nativeChromeUserDataDir: () => pathApi.join(root, 'native'), makeIsolatedProfileId: id => `isolated:${id}`,
      readIsolatedProfileUserName: async () => null, resolveIsolatedProfileDataPath: async value => value, getDirectChromeCommand: () => null },
    './profile-avatar': { readProfileAvatar: async () => null },
    './profile-connections': { ...connections, gatewayManagedPortSet: () => new Set(), gatewayControlsByPort: () => new Map(),
      compatibilityCdpPorts: ports => ports, gatewayOverlayClients: () => [] },
    './agent-browser-lease': { readActiveAgentBrowserProfileOccupancySync: port => port === 9202 ? { session: 'paused-owner', ownership: 'user' } : null },
    './cdp-client': { makeCdpUrl: port => port ? `http://localhost:${port}` : null, requestCdpTargets: forbidden },
    './cdp-contention': { resolveCdpContention: () => null },
    './profile-layout': { normalizeMiniProfileIds: () => [], normalizeProfileOrder: () => [] },
    '../shared/quick-launch-shortcut': { normalizeQuickLaunchShortcuts: () => ({}) },
    './shell-integration': { getShellIntegrationStatus: async () => ({ installed: false }) }
  });
  const reader = new ProfileStateReader({ dataDir: root, profilesDir: pathApi.join(root, 'profiles'),
    loadRegistry: async () => ({ profiles: profileRows }), readGatewayStatus: async () => null, getActivity: () => null });
  reader.getRuntime = async () => new Map(profileRows.map((row, index) => [pathApi.join(root, 'profiles', row.dirName), {
    pids: [41 + index], browserPids: [41 + index], cdpPort: 9201 + index, listeningPorts: [9201 + index], startedAt: null }]));
  const { evaluateDesktopAdmission } = load('desktop/admission', platform);
  const decide = (state, pid) => {
    const ready = value => ({ state: 'ready', value, capturedAt: now });
    return evaluateDesktopAdmission({ pid, title: 'Fixture', className: 'fixture', process: 'fixture' }, {
      catalog: ready({ profiles: state.profiles, externalInstances: state.externalInstances, discovery }),
      gateway: ready({ profiles: [], ports: [] }), native: ready([]), apps: ready([])
    }, { now });
  };
  return { reader, counts, decide };
}

for (const platform of ['win32', 'darwin']) test(`${platform}: admission skips repository/session archive display work without losing occupancy or changing decisions`, async () => {
  const displayFixture = readerFixture(platform), controlFixture = readerFixture(platform);
  const displayed = (await displayFixture.reader.collect({ strictDiscovery: true })).state;
  const control = await controlFixture.reader.collectForControlAdmission();
  assert.equal(displayFixture.counts.git, 6);
  assert.ok(displayFixture.counts.canonical > 0);
  assert.equal(displayFixture.counts.archiveEnumerations, 2, 'actual session identity code enumerates synthetic roots');
  assert.equal(controlFixture.counts.git, 0);
  assert.equal(controlFixture.counts.canonical, 0);
  assert.equal(controlFixture.counts.archiveEnumerations, 0);
  assert.equal(controlFixture.counts.contexts, displayFixture.counts.contexts, 'base client context/identity collection remains');
  assert.equal(controlFixture.counts.os, displayFixture.counts.os, 'base OS identity and socket collection remains');
  assert.equal(controlFixture.counts.activityReads, displayFixture.counts.activityReads);
  assert.deepEqual(controlFixture.counts.removed.sort(), displayFixture.counts.removed.sort());
  const evidence = rows => rows.map(({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients }) =>
    ({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients: cdpClients.map(withoutDisplay) }));
  assert.deepEqual(evidence(control.profiles), evidence(displayed.profiles));
  assert.equal(control.profiles.find(row => row.id === 'isolated:3').cdpClients.length, 2, 'raw + activity session merge is preserved');
  assert.equal(control.profiles.find(row => row.id === 'isolated:2').cdpClients[0].session, 'paused-owner', 'delegated user lease remains');
  for (const [pid, expected] of [[41, 'available'], [42, 'occupied'], [43, 'unknown']]) {
    const before = displayFixture.decide(displayed, pid), after = controlFixture.decide(control, pid);
    assert.equal(before.status, expected); assert.deepEqual(after, before, `every decision field for PID ${pid}`);
  }
});
