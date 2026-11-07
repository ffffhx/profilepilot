const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');
const catalog = (capturedAt = Date.now()) => ({ profiles: [], externalInstances: [], discovery: {
  snapshotId: 'fixture', capturedAt, complete: true, processPids: [10, 20], scopedGaps: [] } });
const empty = () => ({
  catalog: async () => catalog(), apps: async () => [],
  gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] })
});
const binding = extra => ({ profileId: 'local-app:fixture', profileName: 'Fixture', publicPort: 9223,
  chromePid: 10, ownerSessionId: 'task', ownership: 'user', sessionStatus: 'active', driverState: 'parked',
  agentHealth: 'waiting', controlGeneration: 1, updatedAt: new Date(0).toISOString(), ...extra });

test('runtime adapters consult only injected read-only sources and preserve user ownership', async () => {
  const options = empty(); let reads = 0;
  options.gateway = async () => { reads++; return { state: { profiles: [binding()] }, ports: [9223] }; };
  const admit = createRuntimeDesktopAdmission(options);
  assert.equal(reads, 0);
  assert.equal((await admit({ pid: 10 })).status, 'occupied');
  assert.equal(reads, 1);
  assert.equal((await admit({ pid: 20 })).status, 'unmanaged');
});

test('missing or malformed gateway snapshots never become an empty ready mapping', async () => {
  for (const response of [undefined, {}, { state: {}, ports: [] }, { state: { profiles: [binding({ chromePid: -1 })] }, ports: [9223] }]) {
    const options = empty(); options.gateway = async () => response;
    assert.equal((await createRuntimeDesktopAdmission(options)({ pid: 20 })).status, 'unknown');
  }
});

test('native technical interruption survives adapter validation and denies an idle-looking owner', async () => {
  const options = empty();
  options.catalog = async () => ({ ...catalog(), profiles: [{ id: 'native:Default', source: 'native', pids: [10], browserPids: [10], cdpPort: null, fixedCdpPort: null, gatewayControl: null, agentBrowserOccupancy: null, cdpClients: [] }] });
  options.native = async () => ({ states: [{ profileId: 'native:Default', connected: true, ownership: 'user', controlGeneration: 'generation-1', controlIssue: { code: 'NATIVE_INTERRUPTED', message: 'fixture' } }] });
  const result = await createRuntimeDesktopAdmission(options)({ pid: 10 });
  assert.equal(result.status, 'unknown');
  assert.ok(result.matches.some(match => match.reason === 'native_disconnected_or_interrupted'));
});

test('provider sampling time cannot be refreshed after a slow collection', async () => {
  let now = 100;
  const options = empty(); options.now = () => now; options.maxAgeMs = 100;
  options.catalog = async () => { const value = catalog(now); now += 101; return value; };
  const result = await createRuntimeDesktopAdmission(options)({ pid: 20 });
  assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('catalog:stale_snapshot'));
});

test('a timed-out process scan is not stacked by subsequent admission requests', async () => {
  const options = empty(); let scans = 0, resolve;
  options.timeoutMs = 10;
  options.catalog = () => { scans++; return new Promise(done => { resolve = done; }); };
  const admit = createRuntimeDesktopAdmission(options);
  assert.equal((await admit({ pid: 20 })).status, 'unknown');
  assert.equal((await admit({ pid: 20 })).status, 'unknown');
  assert.equal(scans, 1);
  resolve(catalog());
  await new Promise(done => setImmediate(done));
  const next = admit({ pid: 20 }); await new Promise(done => setImmediate(done));
  assert.equal(scans, 2); resolve(catalog());
  assert.equal((await next).status, 'unmanaged');
});

test('unavailable services retain known associations without granting current ownership', async () => {
  const options = empty(); let available = true;
  options.gateway = async () => {
    if (!available) throw new Error('connection lost');
    return { state: { profiles: [binding()] }, ports: [9223] };
  };
  const admit = createRuntimeDesktopAdmission(options);
  assert.equal((await admit({ pid: 10 })).status, 'occupied'); available = false;
  const result = await admit({ pid: 10 });
  assert.equal(result.status, 'unknown'); assert.equal(result.matches[0].profileId, 'local-app:fixture');
});

test('shared discovery retains both results until both settle and resamples ownership afterwards', async () => {
  let rounds = 0, finish, now = 100; const order = [];
  const admit = createRuntimeDesktopAdmission({ now: () => now, timeoutMs: 10,
    discovery: () => { rounds++; order.push('discovery'); return {
      catalog: new Promise(resolve => { finish = () => resolve(catalog(100)); }),
      apps: Promise.resolve({ applications: [] }) }; },
    gateway: async () => { order.push('gateway'); return { state: { profiles: [] }, ports: [] }; },
    native: async () => { order.push('native'); return { states: [] }; } });
  assert.equal((await admit({ pid: 20 })).status, 'unknown'); now = 200;
  assert.equal((await admit({ pid: 20 })).status, 'unknown'); assert.equal(rounds, 1);
  finish(); await new Promise(resolve => setImmediate(resolve));
  const next = admit({ pid: 20 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(rounds, 2); assert.equal(order.at(-1), 'discovery');
  finish(); assert.equal((await next).status, 'unmanaged');
  assert.deepEqual(order.slice(-2).sort(), ['gateway', 'native']);
});

test('shared discovery preserves a successful apps association when catalog fails', async () => {
  const admit = createRuntimeDesktopAdmission({
    discovery: () => ({ catalog: Promise.reject(new Error('PROFILE_PROCESS_SCAN_INCOMPLETE')),
      apps: Promise.resolve({ applications: [{ id: 'fixture', agentPort: null, runtime: { status: 'running', pid: 10 } }] }) }),
    gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) });
  const result = await admit({ pid: 10 });
  assert.equal(result.status, 'unknown');
  assert.ok(result.matches.some(match => match.profileId === 'local-app:fixture'));
  assert.ok(result.gaps.includes('catalog:PROFILE_PROCESS_SCAN_INCOMPLETE'));
});

test('shared pending round cannot freshen an early completed apps result while catalog remains pending', async () => {
  let now = 100, finish, rounds = 0;
  const admit = createRuntimeDesktopAdmission({ now: () => now, timeoutMs: 10, maxAgeMs: 50,
    discovery: () => { rounds++; return { catalog: new Promise(resolve => { finish = () => resolve(catalog(100)); }), apps: Promise.resolve({ applications: [] }) }; },
    gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) });
  await admit({ pid: 20 }); now = 200;
  const next = admit({ pid: 20 }); await new Promise(resolve => setImmediate(resolve)); finish();
  const result = await next; assert.equal(rounds, 1); assert.equal(result.status, 'unknown');
  assert.ok(result.gaps.includes('apps:stale_snapshot'));
});
