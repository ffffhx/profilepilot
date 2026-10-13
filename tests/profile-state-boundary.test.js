const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { ProfileManager } = require('../dist/main/profile-manager.js');

function load(name, overrides) {
  const file = path.resolve(`dist/main/${name}.js`), module = { exports: {} }, requireLocal = createRequire(file);
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file,'utf8')}\n})`, { filename: file })(
    id => overrides[id] || requireLocal(id), module, module.exports);
  return module.exports;
}

test('status reads neither create a store nor repair duplicate ports, write leases, disconnect clients or sync overlays', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-state-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'new-store'), manager = new ProfileManager(folder);
  const forbidden = () => { assert.fail('A status read attempted runtime maintenance'); };
  const stale = { pid: 404, label: 'agent-browser', note: '共享 daemon：该目录下近期无活跃会话，无法从连接判定当前使用者' };
  const realChrome = require('../dist/main/chrome-launch.js');
  const { ProfileStateReader } = load('profile-state', {
    electron: { app: { getAppMetrics: () => [] } },
    './chrome-launch': { ...realChrome, scanNativeChromeProfiles: async () => [], frontmostMacProcessId: async () => null },
    './process-scan': { findExternalChromeInstances: async () => [], getCdpClientsByPort: async () => new Map([[45101, [stale]]]) },
    './cdp-client': { requestCdpTargets: async () => [] },
    './agent-browser-lease': { readActiveAgentBrowserProfileOccupancySync: () => null,
      updateAgentBrowserProfileLeaseTargetSync: forbidden, writeAgentBrowserRuntimeProfilesSync: forbidden },
    './cdp-contention': { resolveCdpContention: () => null, syncContentionObservers: forbidden },
    './shell-integration': { getShellIntegrationStatus: async () => ({ installed: false }) }
  });
  const reader = new ProfileStateReader({ dataDir: folder, profilesDir: path.join(folder,'profiles'),
    loadRegistry: () => manager.loadRegistry(), readGatewayStatus: async () => null, getActivity: () => null });
  reader.getRuntime = async () => new Map();
  reader.buildIsolatedSubProfiles = async () => [];
  reader.toIsolatedPublicProfile = async profile => ({ ...profile, id: `isolated:${profile.id}`, source: 'isolated',
    running: true, pids: [], cdpPort: profile.fixedCdpPort, cdpUrl: 'http://localhost:45101', cdpClients: [] });
  manager.stateReader = reader;
  manager.runtimeMaintenance = { refresh: forbidden };
  manager.agentOverlayManager = { sync: forbidden };
  await manager.getState();
  assert.equal(fs.existsSync(folder), false, 'Reading a fresh installation leaves disk untouched');
  fs.mkdirSync(folder);
  const registry = JSON.stringify({ profiles: ['a','b'].map(id => ({ id, name: id, dirName: id, fixedCdpPort:45101,
    createdAt: '2026-01-01T00:00:00Z', lastLaunchedAt: null })) });
  fs.writeFileSync(path.join(folder,'profiles.json'), registry);
  const state = await manager.getState();
  assert.equal(state.profiles.length, 2);
  assert.deepEqual(state.profiles.map(profile => profile.fixedCdpPort), [45101,45101]);
  assert.ok(state.profiles.every(profile => profile.cdpClients[0].pid === stale.pid));
  assert.equal(fs.readFileSync(path.join(folder,'profiles.json'),'utf8'), registry);
  assert.deepEqual(fs.readdirSync(folder), ['profiles.json']);
});

function maintenanceFixture(collect) {
  const calls = [];
  const { ProfileRuntimeMaintenance } = load('profile-maintenance', {
    './agent-browser-lease': { updateAgentBrowserProfileLeaseTargetSync: () => calls.push('lease'), writeAgentBrowserRuntimeProfilesSync: () => calls.push('catalog') },
    './cdp-contention': { syncContentionObservers: ports => calls.push(['observers',ports]), refreshPortOwners: () => calls.push('owners') },
    './profile-overlay': { profileOverlayInput: async () => ({ enabled: true, ports: [] }) }
  });
  const maintenance = new ProfileRuntimeMaintenance({ repairRegistry: async () => calls.push('repair'), collect,
    disconnect: async client => calls.push(['disconnect',client.pid]),
    overlay: { sync: () => calls.push('overlay'), dispose: async () => calls.push('dispose') } });
  return { maintenance, calls };
}
const empty = () => ({ state: { profiles: [], externalInstances: [], agentOverlayEnabled: true }, gatewayStatus: null });

test('maintenance runs serially and a refresh during a scan gets a subsequent scan', async () => {
  let release, scans = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { maintenance, calls } = maintenanceFixture(async () => { scans++; if(scans===1) await gate; return empty(); });
  const first = maintenance.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const second = maintenance.refresh();
  assert.equal(first, second);
  release(); await second;
  assert.equal(scans, 2);
  assert.equal(calls.filter(call => call === 'repair').length, 2);
  assert.equal(calls.filter(call => call === 'overlay').length, 2);
  await maintenance.dispose();
});

test('maintenance recollects after stale-client cleanup and leaves the old snapshot intact', async () => {
  const stale = { pid: 99, label: 'agent-browser', note: '共享 daemon：该目录下近期无活跃会话，无法从连接判定当前使用者' };
  const before = empty(); before.state.externalInstances = [{ cdpPort:null, cdpClients:[stale] }];
  let scans = 0;
  const { maintenance, calls } = maintenanceFixture(async () => ++scans===1 ? before : empty());
  const result = await maintenance.refresh();
  assert.equal(scans, 2);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'disconnect' && call[1]===99));
  assert.equal(result.externalInstances.length, 0);
  assert.equal(before.state.externalInstances[0].cdpClients[0], stale);
  await maintenance.dispose();
});

test('shutdown waits for an in-flight scan and cannot reactivate runtime observers or overlays', async () => {
  let release;
  const { maintenance, calls } = maintenanceFixture(() => new Promise(resolve => { release = resolve; }));
  const running = maintenance.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = maintenance.dispose();
  release(empty()); await Promise.all([running, stopping]);
  assert.deepEqual(calls, ['repair', ['observers',[]], 'dispose']);
  await assert.rejects(maintenance.refresh(), /stopped/);
});
