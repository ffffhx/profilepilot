const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { transformSync } = require('esbuild');
const test = require('node:test');

// Source modules run with an explicit platform and all OS/filesystem boundaries
// replaced. These tests never enumerate actual processes or read real profiles.
const compiled = new Map();
const forbidden = () => assert.fail('Unexpected OS, filesystem, GUI, or maintenance access');
const missing = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
function load(name, platform = 'win32', stubs = {}, environment = {}) {
  const filename = path.resolve(__dirname, '../src/main', `${name}.ts`);
  if (!compiled.has(filename)) compiled.set(filename, transformSync(fs.readFileSync(filename, 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'node22' }).code);
  const module = { exports: {} };
  const fakeProcess = { platform, env: { ...environment }, pid: 9000,
    execPath: platform === 'win32' ? 'C:\\ProfilePilot\\app.exe' : '/ProfilePilot.app/Contents/MacOS/ProfilePilot' };
  const requireStub = id => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id === './default-targets') return { DefaultTargetStore: class { profile() { return null; } } };
    if (id === './profile-process-change' || id === '../profile-process-change') return load('profile-process-change', platform);
    if (id === './windows-sampler-protocol') return load('windows-sampler-protocol', platform);
    if (id === 'node:path') return platform === 'win32' ? path.win32 : path.posix;
    if (id === 'node:child_process') return { execFile: forbidden, spawn: forbidden };
    if (id === 'node:fs') return { existsSync: forbidden, promises: new Proxy({}, { get: () => forbidden }) };
    if (id === 'electron') return { app: { getAppMetrics: () => [] }, shell: {} };
    if (id.startsWith('node:')) return require(id);
    if (id.startsWith('.')) return {};
    throw new Error(`Unexpected dependency: ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports,process){${compiled.get(filename)}\n})`, { filename })(
    requireStub, module, module.exports, fakeProcess);
  return module.exports;
}
const proxyStubs = { normalizeStoredBifrostProxy: () => null, normalizeStoredUpstreamProxy: () => null };
function fsUtil(platform = 'win32', overrides = {}) {
  return { ...load('fs-util', platform, { './bifrost-proxy': proxyStubs }), ...overrides };
}
function windowsApi(execute = forbidden) {
  const execFile = forbidden.bind(null);
  execFile[promisify.custom] = execute;
  return load('windows-platform', 'win32', { 'node:child_process': { execFile }, './windows-sampler': {
    sampleWindowsProcesses: async () => ({ processes: JSON.parse((await execute('mock-native-sampler', [])).stdout).processes, complete: true }),
    sampleWindowsFileLocks: forbidden } });
}
const proc = (pid, name = 'System', commandLine = name, available = false) => ({ pid, parentPid: 4,
  name, commandLine, commandLineAvailable: available, executablePath: null, startedAt: '2026-10-29T00:00:00Z',
  identityStatus: 'confirmed', creationFileTime: '134000000000000000' });
const snapshot = (processes = [proc(4)]) => ({ processes, tcp: [], processesAvailable: true,
  processesComplete: true, tcpAvailable: true, tcpComplete: true });
function scanner(platform = 'win32', options = {}) {
  const api = load('process-scan', platform, {
    'node:fs': { existsSync: () => false, promises: { stat: missing, ...options.fs } },
    './fs-util': fsUtil(platform, { execFileAsync: options.execute || forbidden }),
    './windows-platform': { getWindowsSystemSnapshot: options.getSnapshot || forbidden,
      createWindowsReadContext: windowsApi().createWindowsReadContext,
      collectWindowsControlSample: async () => ({ snapshotId: require('node:crypto').randomUUID(), capturedAt: Date.now(), snapshot: await (options.getSnapshot || forbidden)(true), context: windowsApi().createWindowsReadContext() }),
      findWindowsProcessIdentitiesLockingPaths: async paths => new Map([...await (options.lockers || forbidden)(paths, { strict: true })].map(([file, pids]) => [file, pids.map(pid => ({ pid, creationFileTime: '134000000000000000' }))])),
      findWindowsProcessesLockingPaths: options.lockers || forbidden },
    './cdp-client': { isValidTcpPort: n => Number.isInteger(n) && n > 0 && n <= 65535,
      parseRemoteDebuggingPort: command => Number(command.match(/--remote-debugging-port=(\d+)/)?.[1]) || null,
      makeCdpUrl: n => n ? `http://localhost:${n}` : null, requestCdpVersionInfo: async () => ({}) },
    './agent-browser-lease': { readAgentBrowserProfileLeaseSync: () => null },
    './agent-browser-session': { readActiveAgentBrowserSessionActivityClientsByPort: () => new Map() },
    './session-context': { resolveClientContexts: async () => new Map() }
  });
  return api;
}

for (const platform of ['win32', 'darwin']) test('file PID join failure identifies its source without profile data: ' + platform, async () => {
  const profile = platform === 'win32' ? 'C:\\Private\\SecretProfile' : '/Private/SecretProfile';
  const file = (platform === 'win32' ? path.win32 : path.posix).join(profile, 'History');
  let calls = 0;
  const api = scanner(platform, { fs: { stat: async () => ({ isFile: () => true }) },
    lockers: async () => { calls++; return new Map([[file, [88]]]); },
    execute: async executable => { calls++; assert.equal(executable, 'lsof'); return { stdout: `p88\nn${file}\n`, stderr: '' }; } });
  const controlDiscovery = { snapshotId: '1cec77a4-1582-4ab7-a1d8-c972c6cda96b', capturedAt: 123, complete: true, processPids: [4], scopedGaps: [] };
  await assert.rejects(api.getOpenProfilePidsByPath([profile], { strict: true, processes: [{ pid: 4 }], windowsSnapshot: snapshot(), controlDiscovery }), error => {
    assert.equal(error.message, 'PROFILE_FILE_PROCESS_CHANGED'); assert.equal(error.code, error.message);
    assert.deepEqual(error.profileProcessChange, { code: error.message, stage: platform === 'win32' ? 'windows_rm_pid_join' : 'posix_lsof_pid_join',
      pid: 88, processCount: 1, snapshotId: controlDiscovery.snapshotId, capturedAt: 123 });
    assert.equal(JSON.stringify(error.profileProcessChange).includes('Private'), false); return true;
  });
  assert.equal(calls, 1, 'No second scan may hide the mismatch');
});

test('profile runtime join keeps a distinct mapping stage and original sample time', async () => {
  const controlDiscovery = { snapshotId: '1cec77a4-1582-4ab7-a1d8-c972c6cda96b', capturedAt: 17, complete: true, processPids: [4], scopedGaps: [] };
  const profile = { path: 'C:\\Private\\SecretProfile', dirName: 'Default' }; let scans = 0, locks = 0;
  const api = { ...scanner(), listRuntimeProcesses: async () => { scans++; return [{ pid: 4, command: 'System' }]; },
    getOpenProfilePidsByPath: async () => { locks++; return new Map([[profile.path, [88]]]); } };
  const { reader } = readerFixture('win32', { scanner: api });
  await assert.rejects(reader.getRuntime([], [profile], { strict: true, controlDiscovery }), error => {
    assert.equal(error.message, 'PROFILE_FILE_PROCESS_CHANGED'); assert.equal(error.code, error.message);
    assert.deepEqual(error.profileProcessChange, { code: error.message, stage: 'profile_runtime_pid_join', pid: 88, processCount: 1,
      snapshotId: controlDiscovery.snapshotId, capturedAt: 17 }); return true;
  });
  assert.equal(scans, 1); assert.equal(locks, 1);
});
function readerFixture(platform = 'win32', options = {}) {
  const nativeRoot = platform === 'win32' ? 'C:\\ChromeData' : '/ChromeData';
  const api = options.scanner || scanner(platform);
  const chrome = { nativeChromeUserDataDir: () => nativeRoot, scanNativeChromeProfiles: async () => [],
    scanChromeProfilesInDir: async () => [], getDirectChromeCommand: () => null,
    makeNativeProfileId: dir => `native:${dir}`, makeIsolatedProfileId: id => `isolated:${id}`,
    makeIsolatedSubProfileId: (id, dir) => `isolated-sub:${id}:${dir}`,
    frontmostMacProcessId: forbidden, resolveIsolatedProfileDataPath: async dir => dir,
    readIsolatedProfileUserName: async () => null };
  const profileConnections = { gatewayManagedPortSet: () => new Set(), gatewayControlsByPort: () => new Map(),
    compatibilityCdpPorts: ports => ports, enrichCdpClientSessionIdentities: async () => {},
    gatewayProfilesFromResponse: () => [], stripManagedCdpRuntimeMetadata: () => {},
    gatewayOverlayClients: () => [], filterCdpDriverClients: clients => clients };
  const { ProfileStateReader } = load('profile-state', platform, {
    'node:fs': { promises: { readFile: missing, realpath: async value => value, ...options.fs } },
    './fs-util': fsUtil(platform), './process-scan': api, './chrome-launch': chrome,
    './profile-connections': profileConnections,
    '../shared/quick-launch-shortcut': { normalizeQuickLaunchShortcuts: () => ({}) },
    './profile-layout': { normalizeMiniProfileIds: () => [], normalizeProfileOrder: () => [] },
    './shell-integration': { getShellIntegrationStatus: async () => ({ installed: false }) },
    './agent-browser-lease': { readActiveAgentBrowserProfileOccupancySync: () => null },
    './agent-overlay': { isAgentOverlayClient: () => false },
    './cdp-client': { makeCdpUrl: n => n ? `http://localhost:${n}` : null, requestCdpTargets: forbidden },
    './cdp-contention': { resolveCdpContention: () => null }
  }, { CPM_E2E_DETERMINISTIC: '1' });
  const reader = new ProfileStateReader({ dataDir: platform === 'win32' ? 'C:\\Store' : '/Store',
    profilesDir: platform === 'win32' ? 'C:\\Store\\profiles' : '/Store/profiles',
    loadRegistry: options.registry || (async () => ({ profiles: [] })), readGatewayStatus: async () => null,
    getActivity: () => null });
  return { reader, api, nativeRoot };
}

test('strict Windows extra profiles share one RM call and the original context across more than eight parents', async () => {
  const context = windowsApi().createWindowsReadContext(), options = { strict: true, windowsReadContext: context };
  let calls = 0;
  const api = { ...scanner(), getOpenProfilePidsByPath: async (paths, actualOptions) => {
    calls++; assert.equal(actualOptions, options); assert.equal(actualOptions.windowsReadContext, context);
    assert.equal(paths.length, 12); return new Map(paths.map((file, n) => [file, [100 + n]]));
  } };
  const { reader } = readerFixture('win32', { scanner: api });
  reader.scanProfilesForControl = async dir => [{ path: path.win32.join(dir, 'Default'), dirName: 'Default' },
    { path: path.win32.join(dir, 'Profile 1'), dirName: 'Profile 1' }];
  const rows = await reader.buildIsolatedSubProfiles({ profiles: Array.from({ length: 12 }, (_, n) => ({ id: String(n), dirName: 'p' + n })) }, new Map(), options);
  assert.equal(calls, 1); assert.equal(rows.length, 12); assert.deepEqual(rows.map(row => row.pids), Array.from({ length: 12 }, (_, n) => [100 + n]));
});

test('Windows parsing retains completeness failures but permits protected system rows and PID zero', () => {
  const api = windowsApi();
  const complete = api.parseWindowsSystemSnapshot(JSON.stringify({ processes: [proc(0), proc(4), proc(8, 'Secure System')] }));
  assert.equal(complete.processesComplete, true);
  assert.deepEqual(complete.processes.map(p => p.pid), [4, 8]);
  assert.equal(complete.processes[0].commandLineAvailable, false);
  for (const value of ['garbage', '{}', '{"processes":{}}', JSON.stringify({ processes: [proc(4), null] }),
    JSON.stringify({ processes: [proc(4), proc(4)] }), JSON.stringify({ processes: [{ pid: 8 }] })]) {
    assert.equal(api.parseWindowsSystemSnapshot(value).processesComplete, false, value);
  }
});

test('Windows strict TCP accepts localized empty-table envelopes and rejects malformed or missing output', () => {
  const api = windowsApi();
  const header = 'Active Connections\n  Proto  Local Address  Foreign Address  State  PID\n';
  assert.equal(api.windowsNetstatComplete(header), true);
  assert.equal(api.windowsNetstatComplete('活动连接\n  协议  本地地址  外部地址  状态  PID\n'), true);
  assert.equal(api.windowsNetstatComplete(header + 'TCP  127.0.0.1:9223  0.0.0.0:0  LISTENING  42'), true);
  assert.equal(api.windowsNetstatComplete(header + 'TCP  [::1]:5000  [::1]:9223  ESTABLISHED  44'), true);
  for (const value of ['', 'garbage', 'TCP  127.0.0.1:9223  0.0.0.0:0  LISTENING  42',
    header + 'TCP broken', header + 'permission denied', header + 'TCP  127.0.0.1:99999  0.0.0.0:0  LISTENING  42',
    header + 'TCP  127.0.0.1:9223  0.0.0.0:0  UNKNOWN  42']) assert.equal(api.windowsNetstatComplete(value), false, value);
});

test('Windows netstat warnings retain best-effort rows but cannot certify TCP completeness', async () => {
  const api = windowsApi(async executable => executable === 'netstat'
    ? { stdout: 'Proto  Local Address  Foreign Address  State  PID\nTCP  127.0.0.1:9223  0.0.0.0:0  LISTENING  42', stderr: 'partial scan warning' }
    : { stdout: JSON.stringify({ processes: [proc(4)] }) });
  const result = await api.getWindowsSystemSnapshot();
  assert.equal(result.tcp.length, 1);
  assert.equal(result.tcpAvailable, true);
  assert.equal(result.tcpComplete, false);
});

test('RestartManager strict reads require the promised JSON array and propagate native failures', async () => {
  let stdout = '[]', script = '';
  const api = windowsApi(async (_executable, args) => { script = args.at(-1); return { stdout }; });
  assert.equal((await api.findWindowsProcessesLockingPaths(['C:\\Data\\History'], { strict: true })).size, 0);
  assert.match(script, /ConvertTo-Json -InputObject @\(\$rows\)/);
  assert.match(script, /private static readonly bool Strict = true/);
  for (stdout of ['', '{}', 'null', '[{}]', '[{"path":"C:\\\\Other","pid":3}]']) {
    await assert.rejects(api.findWindowsProcessesLockingPaths(['C:\\Data\\History'], { strict: true }), /PROFILE_FILE_SCAN_INVALID/);
  }
  stdout = JSON.stringify([{ path: 'C:\\Data\\History', pid: 42 }]);
  assert.deepEqual((await api.findWindowsProcessesLockingPaths(['C:\\Data\\History'], { strict: true })).get('C:\\Data\\History'), [42]);
  const failed = windowsApi(async () => { throw new Error('native access denied'); });
  await assert.rejects(failed.findWindowsProcessesLockingPaths(['x'], { strict: true }), /native access denied/);
  assert.equal((await failed.findWindowsProcessesLockingPaths(['x'])).size, 0);
});

test('one strict Windows collection reuses its original process and TCP evidence everywhere', async () => {
  const original = snapshot([proc(4), proc(42, 'chrome.exe', 'chrome.exe --user-data-dir=C:\\External --remote-debugging-port=9223', true),
    proc(44, 'agent.exe', 'agent.exe', true)]);
  original.tcp = [{ pid: 42, state: 'Listen', localPort: 9223 }, { pid: 44, state: 'Established', remotePort: 9223 }];
  let scans = 0;
  const api = scanner('win32', { getSnapshot: async force => { assert.equal(force, true); scans++; return original; } });
  const context = await api.createControlRuntimeScan();
  assert.equal(context.windowsSnapshot, original);
  assert.deepEqual(context.controlDiscovery.processPids, [4, 42, 44]);
  assert.deepEqual(context.controlDiscovery.scopedGaps, []);
  assert.match(context.controlDiscovery.snapshotId, /^[a-f\d-]{36}$/);
  assert.ok(context.controlDiscovery.capturedAt <= Date.now());
  assert.equal(await api.listRuntimeProcesses(context), context.processes);
  assert.equal((await api.findExternalChromeInstances([], context))[0].pid, 42);
  assert.deepEqual((await api.getListeningPortsByPid(new Set([42]), context)).get(42), [9223]);
  assert.equal((await api.getCdpClientsByPort([9223], context)).get(9223)[0].pid, 44);
  assert.equal(scans, 1, 'no later independent snapshot can certify this catalog');
});

test('injected control sample keeps its original identity, time and failure without any fallback scan', async () => {
  const original = snapshot([proc(4), proc(321, 'Fixture.exe', 'Fixture.exe', true), proc(701, 'chrome.exe')]);
  const sample = Object.freeze({ snapshotId: 'shared-fixture', capturedAt: 1, snapshot: original });
  const api = scanner('win32', { getSnapshot: forbidden });
  const pending = Promise.resolve(sample);
  const context = await api.createControlRuntimeScan(pending);
  assert.equal(context.windowsSnapshot, original);
  assert.equal(context.controlDiscovery.snapshotId, sample.snapshotId);
  assert.equal(context.controlDiscovery.capturedAt, 1);
  const { reader } = readerFixture('win32', { scanner: api });
  const control = await reader.collectForControlAdmission(pending);
  assert.equal(control.controlDiscovery.snapshotId, sample.snapshotId);
  assert.equal(control.controlDiscovery.capturedAt, 1);
  assert.deepEqual(control.controlDiscovery.scopedGaps, [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [701] }]);
  await assert.rejects(api.createControlRuntimeScan(Promise.reject(new Error('sample unavailable'))), /sample unavailable/);
  for (const invalid of [undefined, null, {}, { ...sample, capturedAt: NaN }, { ...sample, snapshotId: '' }])
    await assert.rejects(api.createControlRuntimeScan(Promise.resolve(invalid)), /SAMPLE_INVALID/);
  await assert.rejects(api.createControlRuntimeScan(Promise.resolve({ ...sample, snapshot: { ...original, processesComplete: false } })), /PROCESS_SCAN_INCOMPLETE/);
  const incomplete = await api.createControlRuntimeScan(Promise.resolve({ ...sample, snapshot: { ...original, tcpComplete: false } }));
  await assert.rejects(api.getCdpClientsByPort([9223], incomplete), /TCP_SCAN_INCOMPLETE/);
  await assert.rejects(scanner('darwin').createControlRuntimeScan(pending), /WINDOWS_SAMPLE_UNSUPPORTED/);
});

test('Windows admission composition uses one fresh immutable OS read for catalog, all apps and route evidence', async () => {
  let cim = 0, tcp = 0, fail = false;
  const windows = windowsApi(async executable => {
    if (executable === 'netstat') { tcp++; return { stdout: 'Proto  Local Address  Foreign Address  State  PID\n' }; }
    cim++; if (fail) throw new Error('fixture process query failed');
    return { stdout: JSON.stringify({ processes: [proc(4), proc(321, 'Fixture.exe', 'Fixture.exe', true),
      { ...proc(42, 'Editor.exe', 'C:\\Fixture\\Editor.exe', true), executablePath: 'C:\\Fixture\\Editor.exe' }] }) };
  });
  const api = scanner('win32', { getSnapshot: forbidden });
  const { reader } = readerFixture('win32', { scanner: api });
  const manager = managerFixture(); manager.stateReader = reader;
  const idleRuntime = () => ({ status: 'stopped', pid: null, startedAt: null });
  const appRuntime = load('local-apps/service-runtime', 'win32', {
    '../windows-platform': { getWindowsSystemSnapshot: forbidden }, './protocol': { idleRuntime } });
  const appResolver = load('local-apps/runtime', 'win32', { './protocol': { idleRuntime } });
  const { LocalAppsService } = load('local-apps/service', 'win32', { zod: require('zod'),
    './service-runtime': appRuntime, './runtime': appResolver, './protocol': { idleRuntime } });
  const apps = Object.create(LocalAppsService.prototype);
  apps.configs = [{ id: 'fixture', mode: 'attach', cwd: '', command: 'C:\\Fixture\\Editor.exe', cdpPort: null, inspectPort: null, agentPort: null }];
  apps.views = new Map(); apps.agentStates = new Map(); apps.connector = { state: () => undefined };
  const appsDiscovery = load('desktop/apps-discovery', 'win32', { '../local-apps/service-runtime': appRuntime });
  const admission = load('desktop/admission', 'win32', { '../local-apps/service-runtime': appRuntime });
  const runtime = load('desktop/runtime-admission', 'win32', { zod: require('zod'), './admission': admission,
    './apps-discovery': appsDiscovery, '../windows-platform': windows });
  let catalogSample, appsSample;
  const prepareDiscovery = runtime.createWindowsDesktopDiscovery({
    catalog: async sample => { catalogSample = sample; const value = await manager.getStateForControlAdmission(sample);
      return { profiles: value.profiles, externalInstances: value.externalInstances, discovery: value.controlDiscovery }; },
    apps: sample => { appsSample = sample; return apps.listForControlAdmission(sample); }
  });
  let round;
  const decide = runtime.createRuntimeDesktopAdmission({ discovery: () => (round = prepareDiscovery()),
    gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) });
  const decisions = await Promise.all([decide({ pid: 321 }), decide({ pid: 42 })]);
  assert.deepEqual(decisions.map(result => result.status), ['unmanaged', 'available']);
  assert.equal(catalogSample, appsSample); assert.equal(cim, 1); assert.equal(tcp, 2, 'One read of each TCP address family shares the same process sample');
  const first = await catalogSample;
  const [catalogResult, appsResult] = await Promise.all([round.catalog, round.apps]);
  assert.equal(catalogResult.discovery.snapshotId, appsResult.control.snapshotId);
  assert.equal(catalogResult.discovery.capturedAt, appsResult.control.capturedAt);
  assert.equal(appsResult.control.capturedAt, first.capturedAt);
  assert.deepEqual([...catalogResult.discovery.processPids].sort((a, b) => a - b), appsResult.control.processPids);
  assert.ok(Object.isFrozen(first.snapshot.processes[0])); assert.equal(apps.views.size, 0);
  assert.equal((await decide({ pid: 321 })).status, 'unmanaged');
  assert.equal(cim, 2); assert.equal(tcp, 4); assert.notEqual((await catalogSample).snapshotId, first.snapshotId);
  fail = true;
  assert.equal((await decide({ pid: 321 })).status, 'unknown');
  assert.equal(cim, 3); assert.equal(tcp, 6, 'failed sample is never replaced by a successful display read');
});

test('Windows strict process evidence tolerates protected system command lines but rejects ambiguous browser rows', async () => {
  const api = scanner();
  assert.equal((await api.listRuntimeProcesses({ strict: true, windowsSnapshot: snapshot() })).length, 1);
  await assert.rejects(api.listRuntimeProcesses({ strict: true, windowsSnapshot: { ...snapshot(), processesComplete: false } }), /PROCESS_SCAN_INCOMPLETE/);
  await assert.rejects(api.listRuntimeProcesses({ strict: true,
    windowsSnapshot: snapshot([proc(42, 'chrome.exe')]) }), /BROWSER_COMMAND_LINE_UNAVAILABLE/);
  assert.equal((await api.listRuntimeProcesses({ windowsSnapshot: snapshot([proc(42, 'chrome.exe')]) })).length, 1);
  const incompleteTcp = { strict: true, windowsSnapshot: { ...snapshot(), tcpComplete: false } };
  await assert.rejects(api.getListeningPortsByPid(new Set([42]), incompleteTcp), /TCP_SCAN_INCOMPLETE/);
  await assert.rejects(api.getCdpClientsByPort([9223], incompleteTcp), /TCP_SCAN_INCOMPLETE/);
});

test('Windows strict file association reports access failure and process churn instead of an empty profile', async () => {
  const context = { strict: true, windowsSnapshot: snapshot(), processes: [] };
  const fs = { stat: async () => ({ isFile: () => true }) };
  const failed = scanner('win32', { fs, lockers: async (_paths, options) => {
    assert.equal(options.strict, true); throw new Error('RestartManager unavailable'); } });
  await assert.rejects(failed.getOpenProfilePidsByPath(['C:\\Profile'], context), /RestartManager unavailable/);
  const changed = scanner('win32', { fs, lockers: async paths => new Map([[paths[0], [777]]]) });
  await assert.rejects(changed.getOpenProfilePidsByPath(['C:\\Profile'], context), /FILE_PROCESS_CHANGED/);
  const denied = scanner('win32', { fs: { stat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  await assert.rejects(denied.getOpenProfilePidsByPath(['C:\\Profile'], context), /denied/);
});

const psRow = '42 Thu Oct 29 00:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/External';
test('macOS strict ps is untruncated, bounded, shared, and rejects malformed or failed scans', async () => {
  let stdout = psRow, scans = 0;
  const api = scanner('darwin', { execute: async (file, args, options) => {
    assert.equal(file, 'ps'); assert.equal(args[0], '-ww'); assert.equal(options.timeout, 8000); scans++; return { stdout }; } });
  const context = await api.createControlRuntimeScan();
  assert.deepEqual(context.controlDiscovery.processPids, [42]);
  assert.deepEqual(context.controlDiscovery.scopedGaps, []);
  assert.equal((await api.findExternalChromeInstances([], context))[0].pid, 42);
  assert.equal(scans, 1);
  stdout = `0 unavailable kernel_task\n${psRow}`;
  assert.deepEqual((await api.createControlRuntimeScan()).processes.map(p => p.pid), [42]);
  for (stdout of ['', '0 unavailable kernel_task', `${psRow}\ntruncated row`, `${psRow}\n${psRow}`]) await assert.rejects(api.createControlRuntimeScan(), /PROCESS_SCAN_(EMPTY|INVALID_ROW)/);
  const failed = scanner('darwin', { execute: async () => { throw new Error('ps denied'); } });
  await assert.rejects(failed.findExternalChromeInstances([], { strict: true }), /ps denied/);
  assert.deepEqual(await failed.findExternalChromeInstances([]), []);
});

test('macOS successful commands with incomplete-scan stderr remain unavailable', async () => {
  const api = scanner('darwin', { execute: async () => ({ stdout: psRow, stderr: 'output may be incomplete' }),
    fs: { stat: async () => ({ isFile: () => true }) } });
  await assert.rejects(api.createControlRuntimeScan(), /PROCESS_SCAN_INCOMPLETE/);
  await assert.rejects(api.getListeningPortsByPid(new Set([42]), { strict: true }), /TCP_SCAN_INCOMPLETE/);
  await assert.rejects(api.getCdpClientsByPort([9223], { strict: true }), /TCP_SCAN_INCOMPLETE/);
  await assert.rejects(api.getOpenProfilePidsByPath(['/Profile'], { strict: true }), /FILE_SCAN_INCOMPLETE/);
});

test('macOS strict lsof distinguishes confirmed no matches from errors and partial output', async () => {
  let failure = Object.assign(new Error('no matches'), { code: 1, stdout: '', stderr: '' });
  const api = scanner('darwin', { execute: async () => { throw failure; }, fs: { stat: async () => ({ isFile: () => true }) } });
  const calls = [() => api.getListeningPortsByPid(new Set([42]), { strict: true }),
    () => api.getCdpClientsByPort([9223], { strict: true }),
    () => api.getOpenProfilePidsByPath(['/Profile'], { strict: true })];
  for (const call of calls) assert.equal((await call()).size, 0);
  for (const error of [Object.assign(new Error('denied'), { code: 1, stderr: 'permission denied' }),
    Object.assign(new Error('partial'), { code: 1, stdout: 'p42' }), Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) {
    failure = error;
    for (const call of calls) await assert.rejects(call(), new RegExp(error.message));
  }
});

test('macOS malformed lsof ownership and file rows cannot disappear from strict results', async () => {
  let stdout = 'n127.0.0.1:5000->127.0.0.1:9223';
  const api = scanner('darwin', { execute: async () => ({ stdout }), fs: { stat: async () => ({ isFile: () => true }) } });
  await assert.rejects(api.getCdpClientsByPort([9223], { strict: true }), /TCP_SCAN_INVALID_ROW/);
  stdout = 'p42\ncagent\nntruncated';
  await assert.rejects(api.getCdpClientsByPort([9223], { strict: true }), /TCP_SCAN_INVALID_ROW/);
  stdout = 'p42\nn/Other';
  await assert.rejects(api.getOpenProfilePidsByPath(['/Profile'], { strict: true }), /FILE_SCAN_INVALID_PATH/);
  stdout = 'p42\nn/Profile/History';
  await assert.rejects(api.getOpenProfilePidsByPath(['/Profile'], { strict: true, processes: [] }), /FILE_PROCESS_CHANGED/);
});

test('macOS strict parsing accepts the implicit f fields emitted by older lsof versions', async () => {
  let stdout = 'p42\ncagent\nf12\nn127.0.0.1:5000->127.0.0.1:9223';
  const api = scanner('darwin', { execute: async file => ({ stdout: file === 'lsof' ? stdout : '' }),
    fs: { stat: async () => ({ isFile: () => true }) } });
  assert.equal((await api.getCdpClientsByPort([9223], { strict: true })).get(9223)[0].pid, 42);
  stdout = 'p42\nf15\nn/Profile/History';
  assert.deepEqual((await api.getOpenProfilePidsByPath(['/Profile'], { strict: true, processes: [{ pid: 42 }] })).get('/Profile'), [42]);
});

test('strict Local State recognizes absence but rejects unreadable, invalid, or unsafe catalogs', async () => {
  let value = Object.assign(new Error('absent'), { code: 'ENOENT' });
  const { reader, nativeRoot } = readerFixture('win32', { fs: { readFile: async () => {
    if (value instanceof Error) throw value; return value; } } });
  assert.deepEqual(await reader.scanProfilesForControl(nativeRoot), []);
  value = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(reader.scanProfilesForControl(nativeRoot), /denied/);
  for (value of ['bad json', '{}', '{"profile":{"info_cache":[]}}', '{"profile":{"info_cache":{"../bad":{}}}}'])
    await assert.rejects(reader.scanProfilesForControl(nativeRoot));
  value = '{"profile":{"info_cache":{"Default":{"name":"Main"},"Profile 1":{"name":"Second"}}}}';
  assert.deepEqual((await reader.scanProfilesForControl(nativeRoot)).map(p => p.dirName), ['Default', 'Profile 1']);
});

test('strict state on a fresh Windows installation permits protected system processes and absent Chrome data', async () => {
  let scans = 0, strictRegistry = false;
  const api = scanner('win32', { getSnapshot: async () => { scans++; return snapshot(); } });
  const { reader } = readerFixture('win32', { scanner: api, registry: async strict => {
    strictRegistry = strict; return { profiles: [] }; } });
  const result = await reader.collect({ strictDiscovery: true });
  assert.deepEqual(result.state.profiles, []);
  assert.deepEqual(result.state.externalInstances, []);
  assert.equal(strictRegistry, true);
  assert.equal(scans, 1);
});

test('strict state cannot hide an unmapped native Chrome behind an absent Local State or deterministic mode', async () => {
  const api = scanner('win32', { getSnapshot: async () => snapshot([proc(42, 'chrome.exe', 'chrome.exe', true)]) });
  const { reader } = readerFixture('win32', { scanner: api });
  await assert.rejects(reader.collect({ strictDiscovery: true }), /NATIVE_PROCESS_UNRESOLVED/);
});

test('strict native collection preserves real driver rows using one snapshot across the whole catalog', async () => {
  const original = snapshot([proc(42, 'chrome.exe', 'chrome.exe --remote-debugging-port=9223', true),
    proc(44, 'agent.exe', 'agent.exe', true)]);
  original.tcp = [{ pid: 42, state: 'Listen', localPort: 9223 }, { pid: 44, state: 'Established', remotePort: 9223 }];
  let scans = 0;
  const api = scanner('win32', { getSnapshot: async () => { scans++; return original; } });
  const { reader } = readerFixture('win32', { scanner: api,
    fs: { readFile: async () => '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
  const { state } = await reader.collect({ strictDiscovery: true });
  assert.deepEqual(state.profiles[0].pids, [42]);
  assert.equal(state.profiles[0].cdpClients[0].pid, 44);
  assert.equal(scans, 1);
  original.processesComplete = false;
  await assert.rejects(reader.collect({ strictDiscovery: true }), /PROCESS_SCAN_INCOMPLETE/);
  assert.equal(scans, 2, 'failed collection has no extra successful rescan');
});

test('strict runtime mapping separates native and isolated Default profiles and propagates late failures', async () => {
  const api = scanner();
  const { reader, nativeRoot } = readerFixture('win32', { scanner: api });
  const native = { dirName: 'Default', path: `${nativeRoot}\\Default`, userDataDir: nativeRoot, isDefault: true };
  const makeRuntime = command => api.parseRuntimeProcess(`42 Thu Oct 29 00:00:00 2026 ${command}`);
  const context = { strict: true, windowsSnapshot: snapshot(),
    processes: [makeRuntime('chrome.exe --user-data-dir=C:\\Isolated --profile-directory=Default')] };
  const isolated = await reader.getRuntime([native.path, 'C:\\Isolated'], [native], context);
  assert.equal(isolated.has('native:Default'), false);
  assert.deepEqual(isolated.get('C:\\Isolated').pids, [42]);
  context.processes = [makeRuntime(`chrome.exe --user-data-dir=${nativeRoot}`)];
  assert.deepEqual((await reader.getRuntime([native.path], [native], context)).get('native:Default').pids, [42]);
  context.windowsSnapshot = { ...snapshot(), tcpComplete: false };
  await assert.rejects(reader.getRuntime([native.path], [native], context), /TCP_SCAN_INCOMPLETE/);
  const failed = readerFixture('darwin', { scanner: scanner('darwin', { execute: async () => { throw new Error('scan unavailable'); } }) }).reader;
  await assert.rejects(failed.getRuntime(['/Profile'], [], { strict: true }), /scan unavailable/);
  assert.equal((await failed.getRuntime(['/Profile'], [])).size, 0, 'ordinary UI retains its best-effort behavior');
});

test('strict path comparison allows absent unrelated registered directories but rejects permission ambiguity', async () => {
  const { reader } = readerFixture('win32', { fs: { realpath: missing } });
  assert.equal(await reader.sameControlPath('C:\\Absent', 'C:\\Other'), false);
  assert.equal(await reader.sameControlPath('C:\\Case', 'c:\\case'), true);
  const denied = readerFixture('win32', { fs: { realpath: async () => { throw new Error('path access denied'); } } }).reader;
  await assert.rejects(denied.sameControlPath('C:\\A', 'C:\\B'), /path access denied/);
});

function managerFixture(readFile = missing) {
  const errors = load('profile-manager-error');
  const { ProfileManager } = load('profile-manager', 'win32', {
    'node:fs': { promises: { readFile } }, './fs-util': fsUtil(), './profile-manager-error': errors,
    './profile-connections': { errorMessage: error => error.message, normalizeTakeoverHistory: () => [] },
    './profile-layout': { normalizeMiniProfileIds: () => [], normalizeProfileOrder: () => [] },
    '../shared/quick-launch-shortcut': { normalizeQuickLaunchShortcuts: () => ({}) }
  });
  return Object.create(ProfileManager.prototype);
}
test('control manager entry requests strict collection without display caching or maintenance', async () => {
  const manager = managerFixture();
  const prior = { profiles: ['cached'] }, state = { profiles: [] };
  manager.displayState = prior;
  manager.collectState = forbidden;
  manager.runtimeMaintenance = { refresh: forbidden };
  const controlDiscovery = { snapshotId: 'fixture', capturedAt: 100, complete: true, processPids: [4], scopedGaps: [] };
  manager.stateReader = { collect: forbidden, collectForControlAdmission: async () => ({ ...state, controlDiscovery }) };
  const result = await manager.getStateForControlAdmission();
  assert.deepEqual(result, { ...state, controlDiscovery });
  assert.equal(result.controlDiscovery, controlDiscovery, 'forward the same collection evidence without a new timestamp');
  assert.equal(state.controlDiscovery, undefined, 'ordinary display state is not mutated');
  assert.equal(manager.displayState, prior);
  manager.stateReader.collectForControlAdmission = async () => state;
  await assert.rejects(manager.getStateForControlAdmission(), /DISCOVERY_INCOMPLETE/);
  manager.stateReader.collectForControlAdmission = async () => { throw new Error('incomplete'); };
  await assert.rejects(manager.getStateForControlAdmission(), /incomplete/);
  assert.equal(manager.displayState, prior);
});

for (const platform of ['win32', 'darwin']) test(`${platform} dedicated control collection preserves native PID/client evidence and never suppresses discovery failures`, async () => {
  const windows = snapshot([proc(42, 'chrome.exe', 'chrome.exe --remote-debugging-port=9223', true), proc(44, 'agent.exe', 'agent.exe', true)]);
  windows.tcp = [{ pid: 42, state: 'Listen', localPort: 9223 }, { pid: 44, state: 'Established', remotePort: 9223 }];
  let failure, scans = 0;
  const api = scanner(platform, {
    getSnapshot: async () => {
      scans++; if (failure === 'process') throw new Error('fixture process unavailable');
      return { ...windows, tcpComplete: failure !== 'tcp' };
    },
    fs: { stat: async () => ({ isFile: () => true }) },
    lockers: async () => { if (failure === 'file') throw new Error('fixture file unavailable'); return new Map(); },
    execute: async (file, args) => {
      if (file === 'ps') {
        if (args[0] === '-o') return { stdout: '44 /fixture-agent' }; // Exact executable filtering, distinct from the discovery sample.
        scans++; if (failure === 'process') throw new Error('fixture process unavailable');
        return { stdout: '42 Thu Oct 29 00:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223\n44 Thu Oct 29 00:00:00 2026 /fixture-agent' };
      }
      assert.equal(file, 'lsof');
      if (args.includes('--')) {
        if (failure === 'file') throw new Error('fixture file unavailable');
        return { stdout: '' };
      }
      if (failure === 'tcp') throw new Error('fixture TCP unavailable');
      return { stdout: args.includes('-sTCP:LISTEN')
        ? 'GoogleChrome 42 fixture 1u IPv4 1 0t0 TCP 127.0.0.1:9223 (LISTEN)'
        : 'p44\ncagent\nn127.0.0.1:5000->127.0.0.1:9223' };
    }
  });
  const { reader } = readerFixture(platform, { scanner: api,
    registry: async strict => { assert.equal(strict, true); if (failure === 'registry') throw new Error('fixture registry unavailable'); return { profiles: [] }; },
    fs: { readFile: async () => failure === 'local-state' ? '{malformed'
      : '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
  const legacy = await reader.collect({ strictDiscovery: true });
  const control = await reader.collectForControlAdmission();
  const project = ({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients }) =>
    ({ id, source, pids, browserPids, cdpPort, fixedCdpPort, gatewayControl, agentBrowserOccupancy, cdpClients });
  assert.deepEqual(control.profiles, legacy.state.profiles.map(project));
  assert.deepEqual(control.profiles[0].pids, [42]);
  assert.equal(control.profiles[0].cdpClients[0].pid, 44);
  assert.deepEqual(control.controlDiscovery.processPids, [42, 44]);
  assert.equal(scans, 2, 'each completed collection gets a new process sample');
  for (failure of ['process', 'registry', 'local-state', 'file', 'tcp']) {
    await assert.rejects(reader.collectForControlAdmission());
  }
});

test('dedicated control collection cannot publish missing discovery evidence or clear a later scoped failure', async () => {
  for (const failure of ['missing-evidence', 'local-state', 'restart-manager', 'tcp']) {
    const original = snapshot([proc(321, 'Fixture.exe', 'Fixture.exe', true), proc(701, 'chrome.exe'),
      ...(failure === 'tcp' ? [proc(702, 'chrome.exe', 'chrome.exe', true)] : [])]);
    if (failure === 'tcp') original.tcpComplete = false;
    let api = scanner('win32', { getSnapshot: async () => original,
      fs: { stat: async () => ({ isFile: () => true }) },
      lockers: async () => { if (failure === 'restart-manager') throw new Error('PROFILE_FILE_SCAN_UNAVAILABLE'); return new Map(); } });
    if (failure === 'missing-evidence') api = { ...api, createControlRuntimeScan: async () => ({ strict: true, windowsSnapshot: original, processes: [] }) };
    const { reader } = readerFixture('win32', { scanner: api, fs: { readFile: async () => failure === 'local-state'
      ? '{malformed' : '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
    await assert.rejects(reader.collectForControlAdmission(), failure === 'missing-evidence' ? /DISCOVERY_INCOMPLETE/
      : failure === 'tcp' ? /TCP_SCAN_INCOMPLETE/ : failure === 'restart-manager' ? /FILE_SCAN_UNAVAILABLE/ : SyntaxError);
  }
});

test('scoped unreadable browser evidence permits only unrelated PIDs from the completed same collection', async () => {
  const original = snapshot([proc(4), proc(321, 'Fixture.exe', 'Fixture.exe', true), proc(701, 'chrome.exe')]);
  let scans = 0;
  const api = scanner('win32', { getSnapshot: async () => { scans++; return original; } });
  const { reader } = readerFixture('win32', { scanner: api });
  const collected = await reader.collect({ strictDiscovery: true });
  assert.deepEqual(collected.controlDiscovery.processPids, [4, 321, 701]);
  assert.deepEqual(collected.controlDiscovery.scopedGaps,
    [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: [701] }]);
  assert.deepEqual(collected.state.profiles, []);
  assert.deepEqual(collected.state.externalInstances, []);
  assert.equal(scans, 1);
  const { evaluateDesktopAdmission } = load('desktop/admission');
  const capturedAt = collected.controlDiscovery.capturedAt;
  const ready = value => ({ state: 'ready', value, capturedAt });
  const snapshots = { catalog: ready({ profiles: collected.state.profiles, externalInstances: [], discovery: collected.controlDiscovery }),
    gateway: ready({ profiles: [], ports: [] }), native: ready([]), apps: ready([]) };
  assert.equal(evaluateDesktopAdmission({ pid: 321 }, snapshots, { now: capturedAt }).status, 'unmanaged');
  const blocked = evaluateDesktopAdmission({ pid: 701 }, snapshots, { now: capturedAt });
  assert.equal(blocked.status, 'unknown');
  assert.ok(blocked.gaps.includes('catalog:PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE'));
  const absent = evaluateDesktopAdmission({ pid: 999 }, snapshots, { now: capturedAt });
  assert.equal(absent.status, 'unknown');
  assert.ok(absent.gaps.includes('catalog:target_process_not_observed'));
  const control = await reader.collectForControlAdmission();
  assert.equal(scans, 2);
  assert.deepEqual(control.controlDiscovery.scopedGaps, collected.controlDiscovery.scopedGaps);
  const next = { ...snapshots, catalog: { state: 'ready', capturedAt: control.controlDiscovery.capturedAt,
    value: { profiles: control.profiles, externalInstances: control.externalInstances, discovery: control.controlDiscovery } } };
  for (const pid of [321, 701, 999]) assert.deepEqual(
    evaluateDesktopAdmission({ pid }, next, { now: control.controlDiscovery.capturedAt }),
    evaluateDesktopAdmission({ pid }, snapshots, { now: control.controlDiscovery.capturedAt }));
});

test('scoped browser impact includes browser ancestors and all their descendants, regardless of executable', async () => {
  const original = snapshot([proc(4), proc(321, 'Fixture.exe', 'Fixture.exe', true),
    proc(700, 'chrome.exe', 'chrome.exe --user-data-dir=C:\\External', true),
    { ...proc(701, 'chrome.exe'), parentPid: 700 }, { ...proc(702, 'Fixture.exe', 'Fixture.exe', true), parentPid: 701 },
    { ...proc(703, 'Other.exe', 'Other.exe', true), parentPid: 700 }]);
  const api = scanner('win32', { getSnapshot: async () => original });
  const context = await api.createControlRuntimeScan();
  assert.deepEqual(context.controlDiscovery.scopedGaps[0].processPids, [700, 701, 702, 703]);
  assert.deepEqual(context.processes.map(item => item.pid), context.controlDiscovery.processPids);
  const unreadable = context.processes.find(item => item.pid === 701);
  assert.equal(unreadable.command, '');
  assert.deepEqual(unreadable.browserPids, []);
  assert.equal(unreadable.cdpPort, null);
  assert.notEqual((await api.createControlRuntimeScan()).controlDiscovery.snapshotId, context.controlDiscovery.snapshotId);
});

test('strict missing command lines never infer Default, including the Windows open-file heuristic', async () => {
  let locks = 0;
  const api = scanner('win32', { getSnapshot: async () => snapshot([proc(321, 'Fixture.exe', 'Fixture.exe', true), proc(701, 'chrome.exe')]),
    fs: { stat: async () => ({ isFile: () => true }) }, lockers: async () => { locks++; return new Map(); } });
  const { reader } = readerFixture('win32', { scanner: api,
    fs: { readFile: async () => '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
  const result = await reader.collect({ strictDiscovery: true });
  assert.equal(locks, 1, 'strict discovery continues through RestartManager despite the scoped command-line gap');
  assert.deepEqual(result.state.profiles[0].pids, []);
  assert.deepEqual(result.state.profiles[0].browserPids, []);
  assert.equal(result.state.profiles[0].running, false);
  assert.deepEqual(result.controlDiscovery.scopedGaps[0].processPids, [701]);
});

test('a file lock can retain an unreadable process identity without claiming its command line or clearing its gap', async () => {
  const api = scanner('win32', { getSnapshot: async () => snapshot([proc(321, 'Fixture.exe', 'Fixture.exe', true), proc(701, 'chrome.exe')]),
    fs: { stat: async () => ({ isFile: () => true }) }, lockers: async paths => new Map([[paths[0], [701]]]) });
  const { reader } = readerFixture('win32', { scanner: api,
    fs: { readFile: async () => '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
  const result = await reader.collect({ strictDiscovery: true });
  assert.deepEqual(result.state.profiles[0].pids, [701], 'known raw PID is retained for strict file association');
  assert.deepEqual(result.state.profiles[0].browserPids, [], 'a file lock does not establish a readable main browser command');
  assert.deepEqual(result.controlDiscovery.scopedGaps[0].processPids, [701]);
});

test('an unreadable scoped browser does not hide a separate readable but unresolved native process', async () => {
  const api = scanner('win32', { getSnapshot: async () => snapshot([proc(701, 'chrome.exe'),
    proc(702, 'chrome.exe', 'chrome.exe', true)]) });
  const { reader } = readerFixture('win32', { scanner: api });
  await assert.rejects(reader.collect({ strictDiscovery: true }), /PROFILE_NATIVE_PROCESS_UNRESOLVED/);
});

test('scoped command-line gaps cannot mask subsequent Local State, RestartManager, or TCP failure', async () => {
  const unreadable = proc(701, 'chrome.exe');
  for (const failure of ['local-state', 'restart-manager', 'tcp']) {
    let scans = 0, locks = 0;
    const original = snapshot([proc(321, 'Fixture.exe', 'Fixture.exe', true), unreadable,
      ...(failure === 'tcp' ? [proc(702, 'chrome.exe', 'chrome.exe', true)] : [])]);
    if (failure === 'tcp') original.tcpComplete = false;
    const api = scanner('win32', { getSnapshot: async () => { scans++; return original; },
      fs: { stat: async () => ({ isFile: () => true }) }, lockers: async () => {
        locks++; if (failure === 'restart-manager') throw new Error('PROFILE_FILE_SCAN_UNAVAILABLE'); return new Map(); } });
    const { reader } = readerFixture('win32', { scanner: api, fs: { readFile: async () => failure === 'local-state'
      ? '{malformed' : '{"profile":{"info_cache":{"Default":{"name":"Main"}}}}' } });
    await assert.rejects(reader.collect({ strictDiscovery: true }), failure === 'tcp' ? /TCP_SCAN_INCOMPLETE/
      : failure === 'restart-manager' ? /FILE_SCAN_UNAVAILABLE/ : SyntaxError);
    assert.equal(scans, 1, failure);
    assert.equal(locks, failure === 'local-state' ? 0 : 1, failure);
  }
});

test('strict registry reading rejects dropped or ambiguous rows while normal UI still tolerates them', async () => {
  let value = '{}';
  const manager = managerFixture(async () => value);
  const row = { id: 'one', name: 'One', dirName: 'one', createdAt: '2026-10-29T00:00:00Z' };
  for (const input of [{}, { profiles: [null] }, { profiles: [row, row] },
    { profiles: [row, { ...row, id: 'two' }] }]) {
    value = JSON.stringify(input);
    await assert.rejects(manager.loadRegistry(true), error => error.code === 'REGISTRY_READ_FAILED');
    await manager.loadRegistry();
  }
  value = JSON.stringify({ profiles: [row] });
  assert.equal((await manager.loadRegistry(true)).profiles[0].id, 'one');
  assert.deepEqual((await managerFixture().loadRegistry(true)).profiles, []);
});
