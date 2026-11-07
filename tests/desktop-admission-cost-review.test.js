const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');
const test = require('node:test');

// Call-count evidence for the current collection path, not a wall-clock
// benchmark. Every filesystem/process/network/Electron boundary is replaced;
// only checked-in TypeScript source is read by the loader itself.
const forbidden = () => assert.fail('Unexpected OS, profile, network, or GUI access');
const missing = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const compiled = new Map();
function load(name, platform, stubs = {}, clock = Date) {
  const filename = path.resolve(__dirname, '../src/main', `${name}.ts`);
  if (!compiled.has(filename)) compiled.set(filename, transformSync(fs.readFileSync(filename, 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'node22' }).code);
  const module = { exports: {} };
  const requireStub = id => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id === './profile-process-change' || id === '../profile-process-change') return load('profile-process-change', platform);
    if (id === 'node:path') return platform === 'win32' ? path.win32 : path.posix;
    if (id === 'node:child_process') return { execFile: forbidden, spawn: forbidden };
    if (id === 'node:fs') return { existsSync: forbidden, promises: new Proxy({}, { get: () => forbidden }) };
    if (id === 'node:http' || id === 'node:net') return { get: forbidden, connect: forbidden };
    if (id === 'electron') return { app: { getAppMetrics: () => [] } };
    if (id.startsWith('node:') || id === 'zod') return require(id);
    if (id.startsWith('.')) return {};
    throw new Error(`Unexpected dependency: ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports,process,Date){${compiled.get(filename)}\n})`, { filename })(
    requireStub, module, module.exports, { platform, env: { CPM_E2E_DETERMINISTIC: '1' }, pid: 9000 }, clock);
  return module.exports;
}
const emptyRuntime = () => ({ pids: [], browserPids: [], startedAt: null, cdpPort: null, listeningPorts: [] });
const idleRuntime = () => ({ status: 'stopped', pid: null, startedAt: null });
const projectProfile = ({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients }) =>
  ({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients });

test('forced Windows snapshots duplicate CIM and both netstat families even while another scan is pending', async () => {
  const counts = { powershell: 0, netstat: 0 }, complete = [];
  const execFile = forbidden.bind(null);
  execFile[promisify.custom] = executable => {
    const netstat = executable === 'netstat'; counts[netstat ? 'netstat' : 'powershell']++;
    return new Promise(resolve => complete.push(() => resolve({ stdout: netstat
      ? 'Proto Local Address Foreign Address State PID\n'
      : JSON.stringify({ processes: [{ pid: 4, parentPid: 0, name: 'System', commandLine: '', commandLineAvailable: false }] }) })));
  };
  const api = load('windows-platform', 'win32', { 'node:child_process': { execFile } });
  const first = api.getWindowsSystemSnapshot(true), second = api.getWindowsSystemSnapshot(true);
  const ordinary = api.getWindowsSystemSnapshot();
  assert.deepEqual(counts, { powershell: 2, netstat: 4 });
  complete.splice(0).forEach(done => done());
  const [a, b, c] = await Promise.all([first, second, ordinary]);
  assert.notEqual(a, b); assert.equal(b, c);
  await api.getWindowsSystemSnapshot();
  assert.deepEqual(counts, { powershell: 2, netstat: 4 }, 'ordinary reads share the completed cache');
  const third = api.getWindowsSystemSnapshot(true);
  assert.deepEqual(counts, { powershell: 3, netstat: 6 }, 'forced appsControl cannot reuse even a just-completed catalog scan');
  complete.splice(0).forEach(done => done()); await third;
});

for (const platform of ['win32', 'darwin']) test(`${platform} strict collection still performs presentation work for each isolated profile`, async () => {
  const counts = { scan: 0, registry: 0, gateway: 0, localState: 0, shell: 0, avatar: 0, userName: 0,
    profileDataPath: 0, sessionIdentity: 0, activity: 0 };
  const root = platform === 'win32' ? 'C:\\Fixture' : '/Fixture';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const profiles = [1, 2].map(id => ({ id: String(id), dirName: `profile-${id}`, name: `Fixture ${id}`, createdAt: `2026-10-${id + 10}`, lastLaunchedAt: null }));
  const discovery = { snapshotId: 'synthetic', capturedAt: Date.now(), complete: true, processPids: [4, 21, 22, 99], scopedGaps: [] };
  const externalPresentation = [];
  const { ProfileStateReader } = load('profile-state', platform, {
    'node:fs': { promises: { readFile: async () => { counts.localState++; return missing(); }, realpath: forbidden } },
    './process-scan': { createControlRuntimeScan: async () => { counts.scan++; return { strict: true, processes: [], controlDiscovery: discovery }; },
      listRuntimeProcesses: async () => [], emptyRuntimeProfile: emptyRuntime,
      getOpenProfilePidsByPath: async () => new Map(), attachListeningPorts: async () => {},
      findExternalChromeInstances: async (_paths, _scan, presentation) => { externalPresentation.push(presentation.includeDisplayCdpUrl); return []; },
      getCdpClientsByPort: async () => new Map([[9201, [{ pid: 21 }]], [9202, [{ pid: 22 }, { pid: 99, session: 'fixture-driver' }]]]) },
    './chrome-launch': { nativeChromeUserDataDir: () => pathApi.join(root, 'native'),
      makeIsolatedProfileId: id => `isolated:${id}`,
      readIsolatedProfileUserName: async () => { counts.userName++; return null; },
      resolveIsolatedProfileDataPath: async value => { counts.profileDataPath++; return value; }, getDirectChromeCommand: () => null },
    './profile-avatar': { readProfileAvatar: async () => { counts.avatar++; return null; } },
    './cdp-client': { makeCdpUrl: port => port ? `http://localhost:${port}` : null, requestCdpTargets: forbidden },
    './agent-browser-lease': { readActiveAgentBrowserProfileOccupancySync: port => port === 9201 ? { session: 'fixture-owner', ownership: 'user' } : null },
    './cdp-contention': { resolveCdpContention: () => null },
    './profile-connections': { gatewayManagedPortSet: () => new Set(), gatewayControlsByPort: () => new Map(), compatibilityCdpPorts: ports => ports,
      enrichCdpClientSessionIdentities: async () => { counts.sessionIdentity++; }, gatewayOverlayClients: () => [] },
    '../shared/quick-launch-shortcut': { normalizeQuickLaunchShortcuts: () => ({}) },
    './profile-layout': { normalizeMiniProfileIds: () => [], normalizeProfileOrder: () => [] },
    './shell-integration': { getShellIntegrationStatus: async () => { counts.shell++; return { installed: false }; } }
  });
  const reader = new ProfileStateReader({ dataDir: root, profilesDir: pathApi.join(root, 'profiles'),
    loadRegistry: async strict => { assert.equal(strict, true); counts.registry++; return { profiles }; },
    readGatewayStatus: async () => { counts.gateway++; return null; }, getActivity: () => { counts.activity++; return null; } });
  reader.getRuntime = async () => new Map([1, 2].map(id => [pathApi.join(root, 'profiles', `profile-${id}`),
    { pids: [20 + id], browserPids: [20 + id], cdpPort: 9200 + id, listeningPorts: [9200 + id], startedAt: null }]));
  const collected = await reader.collect({ strictDiscovery: true });
  assert.equal(collected.state.profiles.length, 2); assert.equal(collected.controlDiscovery, discovery);
  assert.deepEqual(counts, { scan: 1, registry: 1, gateway: 1, localState: 3, shell: 1, avatar: 2, userName: 2,
    profileDataPath: 2, sessionIdentity: 1, activity: 2 });
  Object.keys(counts).forEach(key => { counts[key] = 0; });
  const control = await reader.collectForControlAdmission();
  assert.deepEqual(counts, { scan: 1, registry: 1, gateway: 1, localState: 3, shell: 0, avatar: 0, userName: 0,
    profileDataPath: 0, sessionIdentity: 0, activity: 0 });
  assert.deepEqual(Object.keys(control).sort(), ['controlDiscovery', 'externalInstances', 'profiles']);
  assert.deepEqual(control.profiles, collected.state.profiles.map(projectProfile), 'same PID/port/owner/client fields and ordering');
  assert.deepEqual(control.externalInstances, collected.state.externalInstances);
  assert.equal(control.controlDiscovery, discovery, 'no new sampling timestamp');
  assert.deepEqual(externalPresentation, [true, false]);
  const { evaluateDesktopAdmission } = load('desktop/admission', platform);
  const decide = (state, pid) => {
    const ready = value => ({ state: 'ready', value, capturedAt: discovery.capturedAt });
    return evaluateDesktopAdmission({ pid }, { catalog: ready({ profiles: state.profiles, externalInstances: state.externalInstances, discovery }),
      gateway: ready({ profiles: [], ports: [] }), native: ready([]), apps: ready([]) }, { now: discovery.capturedAt + 1 });
  };
  for (const [pid, status] of [[21, 'occupied'], [22, 'unknown'], [4, 'unmanaged'], [999, 'unknown']]) {
    assert.deepEqual(decide(control, pid), decide(collected.state, pid));
    assert.equal(decide(control, pid).status, status);
  }
});

for (const platform of ['win32', 'darwin']) test(`${platform} strict external discovery still probes version endpoints for display cdpUrl`, async () => {
  const versions = [];
  const { findExternalChromeInstances } = load('process-scan', platform, {
    './cdp-client': { requestCdpVersionInfo: async port => { versions.push(port); return {}; }, makeCdpUrl: port => `http://localhost:${port}` }
  });
  const executable = platform === 'win32' ? 'chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const rows = [1, 2].map(id => ({ pid: 100 + id, command: `${executable} --user-data-dir=/fixture-${id} --remote-debugging-port=${9200 + id}`,
    cdpPort: 9200 + id, startedAt: null }));
  const result = await findExternalChromeInstances([], { strict: true, processes: rows });
  assert.deepEqual(versions, [9201, 9202]); assert.equal(result.length, 2);
  assert.ok(result.every(row => row.cdpUrl));
  versions.length = 0;
  const control = await findExternalChromeInstances([], { strict: true, processes: rows }, { includeDisplayCdpUrl: false });
  assert.deepEqual(versions, [], 'control discovery does not make a display-only HTTP request');
  assert.deepEqual(control.map(({ pid, cdpPort }) => ({ pid, cdpPort })), result.map(({ pid, cdpPort }) => ({ pid, cdpPort })));
  assert.ok(control.every(row => row.cdpUrl === null));
});

test('LocalApps.list inspects each config in parallel but probes both debug endpoints and every runtime', async () => {
  const counts = { process: 0, worker: 0, http: 0 }, releases = [];
  const http = { get: (_options, callback) => {
    counts.http++; const request = new EventEmitter(); request.destroy = forbidden;
    queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
      response.resume = () => {}; callback(response); response.emit('data', '[]'); response.emit('end'); request.emit('close'); });
    return request;
  } };
  const { LocalAppsService } = load('local-apps/service', 'win32', {
    'node:http': http,
    './protocol': { idleRuntime, workerRequest: async () => { counts.worker++; return idleRuntime(); } },
    './service-runtime': { processRuntime: () => { counts.process++; return new Promise(resolve => releases.push(() => resolve(idleRuntime()))); } },
    './runtime': { resolveAppRuntime: () => ({ runtime: idleRuntime() }) }
  });
  // Avoid the constructor's configuration/connector initialization entirely.
  const service = Object.create(LocalAppsService.prototype);
  service.configs = ['launch', 'attach'].map((mode, index) => ({ id: `fixture-${index}`, mode, cdpPort: 9200 + index * 2, inspectPort: 9201 + index * 2 }));
  service.views = new Map(); service.agentStates = new Map(); service.connector = { state: () => undefined };
  service.record = () => ({ runtime: { status: 'running' } });
  const pending = service.list();
  assert.deepEqual(counts, { process: 2, worker: 1, http: 4 }, 'all independent inspect work starts before the blocked OS result');
  releases.forEach(done => done()); assert.equal((await pending).length, 2);
});

test('control Windows samples bypass the display TTL, retain query start time, and freeze their own evidence', async () => {
  let now = 100, scans = 0;
  const finish = [];
  const execFile = forbidden.bind(null);
  execFile[promisify.custom] = executable => {
    const netstat = executable === 'netstat'; if (!netstat) scans++;
    return new Promise(resolve => finish.push(() => resolve({ stdout: netstat
      ? 'Proto  Local Address  Foreign Address  State  PID\n'
      : JSON.stringify({ processes: [{ pid: 4, parentPid: 0, name: 'System', commandLine: '', commandLineAvailable: false }] }) })));
  };
  const api = load('windows-platform', 'win32', { 'node:child_process': { execFile }, './windows-sampler': {
    sampleWindowsProcesses: () => { scans++; return new Promise(resolve => finish.push(() => resolve({ complete: true,
      processes: [{ pid: 4, parentPid: 0, name: 'System', commandLine: '', commandLineAvailable: false }] }))); }, sampleWindowsFileLocks: forbidden
  } }, class extends Date { static now() { return now; } });
  const display = api.getWindowsSystemSnapshot(); finish.splice(0).forEach(done => done()); const old = await display;
  const pending = api.collectWindowsControlSample(); assert.equal(scans, 2);
  now = 8000; finish.splice(0).forEach(done => done()); const sample = await pending;
  assert.equal(sample.capturedAt, 100); assert.match(sample.snapshotId, /^[a-f\d-]{36}$/);
  assert.ok(Object.isFrozen(sample) && Object.isFrozen(sample.snapshot) && Object.isFrozen(sample.snapshot.processes));
  assert.ok(Object.isFrozen(sample.snapshot.processes[0]) && Object.isFrozen(sample.snapshot.tcp));
  assert.equal(Reflect.set(sample.snapshot.processes[0], 'pid', 999), false);
  assert.throws(() => sample.snapshot.processes.push({ pid: 999 }), TypeError);
  assert.equal(old.processes[0].pid, 4); assert.equal(Object.isFrozen(old), false, 'do not freeze another consumer display object');
  const next = api.collectWindowsControlSample(); assert.equal(scans, 3);
  finish.splice(0).forEach(done => done()); assert.notEqual((await next).snapshotId, sample.snapshotId);
  await assert.rejects(load('windows-platform', 'darwin').collectWindowsControlSample(), /WINDOWS.*UNSUPPORTED/);
});

test('strict LocalApps listing rejects configuration replacement without updating presentation cache', async () => {
  const { LocalAppsService } = load('local-apps/service', 'win32');
  const service = Object.create(LocalAppsService.prototype), sample = Promise.resolve({ snapshotId: 'fixture', capturedAt: 100 });
  const original = { id: 'fixture', mode: 'attach', cdpPort: 9201 };
  service.configs = [original]; service.views = new Map();
  let finish;
  service.inspect = (config, options) => { assert.equal(options.windowsSample, sample); assert.ok(Object.isFrozen(config));
    return new Promise(resolve => { finish = () => resolve({ ...config, runtime: { status: 'unknown', pid: null } }); }); };
  const listing = service.listForControlAdmission(sample);
  service.configs = [{ ...original, cdpPort: 9202 }]; finish();
  await assert.rejects(listing, /PROFILE_LOCAL_APPS_CONFIG_CHANGED/);
  assert.equal(service.views.size, 0);
});
