const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { buildDesktopAppsControlFromSample } = loadCli('src/main/desktop/apps-discovery.ts');
const { createWindowsDesktopDiscovery, createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');
const { processRuntimeFromSnapshot } = loadCli('src/main/local-apps/service-runtime.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');

// Pure investigation only. Real discovery/evaluator/Service, injected sample,
// catalog, Gateway, native snapshot, and fake driver. No OS reads or input hook.
const identities = [
  { identityStatus: 'confirmed', creationFileTime: '134000000000000001' },
  { identityStatus: 'confirmed', creationFileTime: '134000000000000002' },
  ...['not_pinned', 'open_failed', 'exited', 'wait_failed'].map(identityReason =>
    ({ identityStatus: 'unavailable', creationFileTime: null, identityReason }))
];
const appConfig = identified => ({ id: 'fixture-app', mode: 'attach', name: 'Owned fixture',
  command: identified ? 'C:\\Owned\\Editor.exe' : '', cwd: '', environment: '', createdAt: '',
  cdpPort: 53663, inspectPort: null, agentPort: 56527 });
const processRow = (pid, identity) => ({ pid, parentPid: 1, name: pid === 701 ? 'Editor.exe' : 'Fixture.exe',
  executablePath: pid === 701 ? 'C:\\Owned\\Editor.exe' : 'C:\\Owned\\Fixture.exe',
  commandLine: pid === 701 ? '"C:\\Owned\\Editor.exe" --fixture' : '"C:\\Owned\\Fixture.exe" --fixture',
  commandLineAvailable: true, startedAt: '2026-10-30T00:00:00.000Z', ...identity });
function sample(identity, listener = true, includeOwner = true) {
  return { snapshotId: randomUUID(), capturedAt: 100, snapshot: {
    processes: [processRow(42, identities[0]), ...(includeOwner ? [processRow(701, identity)] : [])],
    tcp: listener ? [{ pid: 701, state: 'Listen', localPort: 53663, localAddress: '127.0.0.1', remotePort: 0, remoteAddress: '0.0.0.0' }] : [],
    processesAvailable: true, processesComplete: true, tcpAvailable: true, tcpComplete: true
  } };
}
function gateway(mode, pid = 701) {
  if (mode === 'none') return { state: { profiles: [] }, ports: [] };
  return { state: { profiles: [{ profileId: 'local-app:fixture-app', profileName: 'Owned fixture', publicPort: 56527,
    ...(pid === undefined ? {} : { chromePid: pid }), ownership: 'user', sessionStatus: mode === 'owned' ? 'active' : 'stopped',
    ...(mode === 'owned' ? { ownerSessionId: 'other-owner' } : {}), driverState: 'parked', agentHealth: 'waiting',
    controlGeneration: 1, updatedAt: new Date(0).toISOString() }] }, ports: [56527] };
}
function fixture({ identity = identities[0], listener = true, identified = false, owner = 'none', gatewayPid = 701, includeOwner = true } = {}) {
  const config = appConfig(identified), calls = [], decisions = [];
  const makeSample = () => sample(identity, listener, includeOwner);
  const discovery = createWindowsDesktopDiscovery({
    sample: async () => makeSample(),
    catalog: async pending => { const value = await pending; return { profiles: [], externalInstances: [], discovery: {
      snapshotId: value.snapshotId, capturedAt: value.capturedAt, complete: true,
      processPids: value.snapshot.processes.map(row => row.pid), scopedGaps: [] } }; },
    apps: async pending => {
      const value = await pending;
      return [{ ...config, runtime: processRuntimeFromSnapshot(config, value.snapshot, 'win32') }];
    }
  });
  const admit = createRuntimeDesktopAdmission({ discovery, now: () => 100,
    gateway: async () => gateway(owner, gatewayPid), native: async () => ({ states: [] }) });
  function service(pid) {
    const target = { id: 'a'.repeat(32), pid, title: 'Owned fixture', process: 'fixture', className: 'Form' };
    return new DesktopService({ platform: 'win32', available: () => true, allowUnobservedTestDriver: true,
      admission: async window => { const decision = await admit(window); decisions.push(decision); return decision; },
      driver: () => ({ close() {}, async request(op) {
        calls.push(op);
        if (op === 'windows') return { windows: [target] };
        if (op === 'window.action') return { executed: true };
        return { windowId: target.id, version: 'b'.repeat(32), elements: [], image: null };
      } })
    });
  }
  return { config, makeSample, admit, service, calls, decisions };
}
async function assertClaim(f, pid, expected) {
  const service = f.service(pid);
  try {
    const claim = service.execute({ action: 'desktop', method: 'claim', session: 'identity-review', windowId: 'a'.repeat(32) });
    if (expected === 'unknown' || expected === 'occupied') {
      await assert.rejects(claim, { code: expected === 'occupied' ? 'DESKTOP_CONTROL_OCCUPIED' : 'DESKTOP_CONTROL_STATE_UNKNOWN' });
      assert.equal(service.status().session, null); assert.deepEqual(f.calls, ['windows']);
    } else {
      await claim; assert.equal(service.status().session.state, 'active');
      await service.execute({ action: 'desktop', method: 'observe', session: 'identity-review' });
      await service.execute({ action: 'desktop', method: 'action', session: 'identity-review', requestId: randomUUID(),
        params: { kind: 'invoke', version: 'b'.repeat(32), ref: 'e1' } });
      assert.ok(f.calls.includes('window.action'));
    }
    assert.ok(f.decisions.every(value => value.status === expected));
  } finally { await service.close(); }
}

test('unreadable or changed process birth leaves route output identical but its listener still blocks all target claims', async () => {
  let first;
  for (const identity of identities) {
    const f = fixture({ identity }), value = f.makeSample();
    const control = buildDesktopAppsControlFromSample([f.config], value); delete control.snapshotId;
    if (first) assert.deepEqual(control, first); else first = control;
    assert.equal(control.complete, true); assert.deepEqual(control.applications[0].candidatePids, [701]);
    for (const pid of [42, 701]) await assertClaim(fixture({ identity }), pid, 'unknown');
  }
});

test('an unidentified app with a known Gateway owner never frees the associated target', async () => {
  for (const identity of identities) await assertClaim(fixture({ identity, owner: 'owned' }), 701, 'unknown');
});

test('an identified app with a current Gateway owner denies the associated target for every birth state', async () => {
  for (const identity of identities) await assertClaim(fixture({ identity, identified: true, owner: 'owned' }), 701, 'occupied');
});

test('unknown identities are not intrinsically a conflict when a complete no-listener route has no known owner', async () => {
  for (const identity of identities) await assertClaim(fixture({ identity, listener: false }), 42, 'unmanaged');
});

test('known current owner at a different PID scopes an unknown app, not ownership of the unrelated target', async () => {
  for (const identity of identities) await assertClaim(fixture({ identity, owner: 'owned' }), 42, 'unmanaged');
});

test('the current PID-only model can allow an identified idle app with unavailable birth, without dropping a known owner', async () => {
  for (const identity of identities) await assertClaim(fixture({ identity, identified: true, owner: 'idle' }), 701, 'available');
});

test('TCP owners absent from the complete process table and absent target PIDs cannot be treated as free', async () => {
  await assertClaim(fixture({ includeOwner: false }), 42, 'unknown');
  await assertClaim(fixture({ includeOwner: false, owner: 'owned' }), 42, 'unknown');
  await assertClaim(fixture({ includeOwner: false, listener: false }), 701, 'unknown');
});
