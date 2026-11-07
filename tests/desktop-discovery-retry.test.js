const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { createWindowsDesktopDiscovery, createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');
const { createDesktopAdmission } = loadCli('src/main/desktop/admission.ts');
const { profileFileProcessChanged } = loadCli('src/main/profile-process-change.ts');
const { buildDesktopAppsControlFromSample } = loadCli('src/main/desktop/apps-discovery.ts');
const turn = () => new Promise(resolve => setImmediate(resolve));
const sample = (round, at = 100) => ({ snapshotId: `${round}cec77a4-1582-4ab7-a1d8-c972c6cda96b`, capturedAt: at,
  snapshot: { processes: [{ pid: 42 }, { pid: 701 }], tcp: [], processesAvailable: true, processesComplete: true, tcpAvailable: true, tcpComplete: true } });
const catalog = s => ({ profiles: [], externalInstances: [], discovery: { snapshotId: s.snapshotId, capturedAt: s.capturedAt,
  complete: true, processPids: s.snapshot.processes.map(row => row.pid), scopedGaps: [] } });
const changed = s => profileFileProcessChanged('windows_rm_pid_join', 88, 2, s);
const controls = { gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) };
function contexts(now = () => 100, deadlineAt = 1000) {
  const a = new AbortController(), b = new AbortController();
  return { catalog: { now, deadlineAt, signal: a.signal }, apps: { now, deadlineAt, signal: b.signal }, a, b };
}
const unpinnedSample = (round, at = 100) => {
  const value = sample(round, at);
  value.snapshot.processes[1] = { pid: 701, identityStatus: 'unavailable', identityReason: 'not_pinned', creationFileTime: null };
  return value;
};
const unpinned = s => profileFileProcessChanged('windows_rm_birth_join', 701, s.snapshot.processes.length, s,
  { origin: 'restart_manager', reason: 'unavailable', identityReason: 'not_pinned' });

test('an exact same-sample Restart Manager not_pinned row triggers one complete fresh round', async () => {
  let scans = 0, catalogReads = 0, appReads = 0; const seen = [], logs = [], context = contexts(); context.apps.deadlineAt = 900;
  const round = createWindowsDesktopDiscovery({ sample: async original => {
    seen.push(original); const value = ++scans === 1 ? unpinnedSample(1) : sample(2, 200); return value;
  }, apps: async () => { appReads++; return []; }, onRetry: value => logs.push(value), catalog: async pending => {
    catalogReads++; const value = await pending; if (catalogReads === 1) throw unpinned(value); return catalog(value);
  } })(context);
  const [c, a] = await Promise.all([round.catalog, round.apps]);
  assert.deepEqual([scans, catalogReads, appReads], [2, 2, 2]);
  assert.equal(seen[0], seen[1]); assert.equal(seen[1].deadlineAt, 900);
  assert.equal(c.discovery.snapshotId, sample(2).snapshotId); assert.equal(a.control.snapshotId, c.discovery.snapshotId);
  assert.equal(c.discovery.capturedAt, 200); assert.equal(a.control.capturedAt, 200);
  assert.equal(logs[0].firstIssue.identityReason, 'not_pinned'); assert.equal(logs[0].firstIssue.origin, 'restart_manager');
  assert.equal(logs[1].outcome, 'round_published'); assert.equal(logs[1].attempts, 2);
});

test('not_pinned recollection requires exact diagnostic metadata and one explicit null-birth row', async () => {
  const changes = [
    s => { s.snapshot.processes = s.snapshot.processes.filter(row => row.pid !== 701); },
    s => { s.snapshot.processes.push({ ...s.snapshot.processes[1] }); },
    s => { s.snapshot.processes[1].identityStatus = 'confirmed'; },
    s => { s.snapshot.processes[1].identityStatus = undefined; },
    s => { s.snapshot.processes[1].identityReason = 'open_failed'; },
    s => { s.snapshot.processes[1].identityReason = 'exited'; },
    s => { s.snapshot.processes[1].identityReason = undefined; },
    s => { delete s.snapshot.processes[1].creationFileTime; },
    s => { s.snapshot.processes[1].creationFileTime = '134000000000000000'; },
    s => { s.snapshot.processes[1].creationFileTime = 'null'; },
    s => { s.snapshot.processes[1].identityWin32Error = 5; },
    s => { s.snapshot.processes[1].identityWin32Error = null; },
    s => { s.snapshot.processes[1].identityWin32Error = undefined; },
    s => { Object.defineProperty(s.snapshot.processes[1], 'identityWin32Error', { get() { assert.fail('Do not read a contradictory error getter'); } }); },
    () => {}
  ];
  for (const [index, mutate] of changes.entries()) {
    const sampled = unpinnedSample(1); mutate(sampled);
    const error = unpinned(sampled); if (index === changes.length - 1) error.profileProcessChange = { ...error.profileProcessChange, pid: 42 };
    let scans = 0;
    // Even a mocked complete apps builder cannot stand in for the exact row
    // check, including duplicated PIDs that the real builder also rejects.
    const round = factoryWithBuilder((a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), complete: true, gaps: [] }))({
      sample: async () => { scans++; return sampled; }, apps: async () => [], catalog: async () => { throw error; }
    })(contexts());
    const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(c.reason, error); assert.equal(scans, 1, 'row case ' + index);
  }
  for (const extra of [{ snapshotId: sample(2).snapshotId }, { capturedAt: 101 }, { processCount: 3 }, { snapshotId: undefined }, { capturedAt: undefined }]) {
    const sampled = unpinnedSample(1), error = unpinned(sampled); error.profileProcessChange = { ...error.profileProcessChange, ...extra }; let scans = 0;
    const round = createWindowsDesktopDiscovery({ sample: async () => { scans++; return sampled; }, apps: async () => [], catalog: async () => { throw error; } })(contexts());
    const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(c.reason, error); assert.equal(scans, 1);
  }
});

test('other identity failures and untrusted not_pinned strings never qualify for recollection', async () => {
  const sampled = unpinnedSample(1);
  const failures = [new Error('PROFILE_FILE_PROCESS_CHANGED'), new Error('not_pinned'),
    ...['open_failed', 'birth_failed', 'exited', 'wait_failed'].map(identityReason => profileFileProcessChanged('windows_rm_birth_join', 701, 2, sampled,
      { origin: 'restart_manager', reason: 'unavailable', identityReason })),
    profileFileProcessChanged('windows_rm_birth_join', 701, 2, sampled, { origin: 'restart_manager', reason: 'birth_mismatch' }),
    profileFileProcessChanged('windows_rm_birth_join', 701, 2, sampled, { origin: 'restart_manager', reason: 'invalid_birth' }),
    profileFileProcessChanged('windows_rm_birth_join', 701, 2, sampled, { origin: 'profile_command', reason: 'unavailable', identityReason: 'not_pinned' }),
    profileFileProcessChanged('windows_parent_identity', 701, 2, sampled, { origin: 'parent_chain', reason: 'unavailable', identityReason: 'not_pinned' }),
    profileFileProcessChanged('profile_runtime_birth_join', 701, 2, sampled, { origin: 'runtime_profile', reason: 'unavailable', identityReason: 'not_pinned' }),
    profileFileProcessChanged('windows_rm_birth_join', 701, 2, sampled, { origin: 'restart_manager_batch', reason: 'batch_conflict' })];
  for (const error of failures) {
    let scans = 0; const round = createWindowsDesktopDiscovery({ sample: async () => { scans++; return sampled; }, apps: async () => [], catalog: async () => { throw error; } })(contexts());
    const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(c.reason, error); assert.equal(scans, 1);
  }
});

test('not_pinned recovery never publishes first-round apps while the second catalog is pending', async () => {
  let scans = 0, finish, published = false;
  const round = createWindowsDesktopDiscovery({ sample: async () => ++scans === 1 ? unpinnedSample(1) : sample(2), apps: async () => [], catalog: async p => {
    const s = await p; if (scans === 1) throw unpinned(s); return new Promise(resolve => { finish = () => resolve(catalog(s)); });
  } })(contexts());
  const result = Promise.allSettled([round.catalog, round.apps.then(value => { published = true; return value; })]);
  await turn(); assert.equal(scans, 2); assert.equal(published, false); finish();
  const values = await result; assert.equal(values[0].status, 'fulfilled'); assert.equal(values[1].status, 'fulfilled');
  assert.equal(values[0].value.discovery.snapshotId, values[1].value.control.snapshotId);
});

test('one not_pinned retry cannot become a third round after any second failure', async () => {
  for (const second of [s => unpinned(s), s => changed(s), () => new Error('PROFILE_PROCESS_SCAN_INCOMPLETE')]) {
    let scans = 0; const logs = [];
    const round = createWindowsDesktopDiscovery({ sample: async () => unpinnedSample(++scans), apps: async () => [], onRetry: value => logs.push(value),
      catalog: async p => { const s = await p; throw scans === 1 ? unpinned(s) : second(s); } })(contexts());
    const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(values[0].status, 'rejected'); assert.equal(scans, 2);
    assert.equal(logs[1].outcome, 'second_failed'); assert.equal(logs[1].attempts, 2);
  }
});

test('not_pinned recollection still needs complete apps evidence from the same round', async () => {
  for (const builder of [() => { throw new Error('missing optional evidence'); },
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), complete: false }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), gaps: ['tcp_incomplete'] }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), snapshotId: sample(2).snapshotId }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), capturedAt: s.capturedAt + 1 })]) {
    let scans = 0; const sampled = unpinnedSample(1), error = unpinned(sampled);
    const round = factoryWithBuilder(builder)({ sample: async () => { scans++; return sampled; },
      apps: async () => [], catalog: async () => { throw error; } })(contexts());
    const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(values[0].reason, error); assert.equal(scans, 1);
  }
  let scans = 0; const error = new Error('PROFILE_LOCAL_APPS_CONFIG_CHANGED');
  const rejected = createWindowsDesktopDiscovery({ sample: async () => unpinnedSample(++scans),
    catalog: async p => { throw unpinned(await p); }, apps: async () => { throw error; } })(contexts());
  const values = await Promise.allSettled([rejected.catalog, rejected.apps]); assert.equal(values[1].reason, error); assert.equal(scans, 1);
});

test('not_pinned does not invent a missing context or renew either original deadline', async () => {
  for (const context of [undefined, {}, { catalog: contexts().catalog }, { apps: contexts().apps }]) {
    let scans = 0; const round = createWindowsDesktopDiscovery({ sample: async () => unpinnedSample(++scans),
      catalog: async p => { throw unpinned(await p); }, apps: async () => [] })(context);
    const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(values[0].status, 'rejected'); assert.equal(scans, 1);
  }
  for (const source of ['catalog', 'apps']) for (const cause of ['abort', 'deadline']) for (const phase of ['first', 'second']) {
    const clock = { catalog: 100, apps: 100 }, context = contexts(), seen = [];
    context.catalog.now = () => clock.catalog; context.apps.now = () => clock.apps; context.apps.deadlineAt = 900;
    let scans = 0, finish;
    const round = createWindowsDesktopDiscovery({ sample: async original => { seen.push(original); return unpinnedSample(++scans); },
      apps: async () => [], catalog: async p => {
        const s = await p;
        if ((scans === 1) === (phase === 'first')) await new Promise(resolve => { finish = resolve; });
        if (scans === 1) throw unpinned(s); return catalog(s);
      } })(context);
    const pending = Promise.allSettled([round.catalog, round.apps]); await turn();
    assert.equal(scans, phase === 'first' ? 1 : 2);
    if (cause === 'abort') context[source === 'catalog' ? 'a' : 'b'].abort(); else clock[source] = context[source].deadlineAt;
    finish(); const values = await pending;
    assert.equal(scans, phase === 'first' ? 1 : 2);
    for (const value of values) { assert.equal(value.status, 'rejected'); assert.equal(value.reason.message, 'provider_timeout'); }
    assert.equal(seen[0].deadlineAt, 900); if (phase === 'second') assert.equal(seen[0], seen[1]);
    if (cause === 'abort') assert.equal(seen[0].signal.aborted, true);
  }
});

test('late not_pinned second-round success cannot refresh pending admission or lastKnown', async () => {
  let scans = 0, resolveSecond, originalContext;
  const discovery = createWindowsDesktopDiscovery({ sample: async () => unpinnedSample(++scans), apps: async () => [],
    catalog: async p => {
      const s = await p; if (scans === 1) throw unpinned(s);
      return new Promise(resolve => { resolveSecond = () => resolve({ ...catalog(s), profiles: [{ id: 'late-owner', pids: [42], source: 'isolated' }] }); });
    } });
  const admit = createRuntimeDesktopAdmission({ ...controls, now: () => 100, timeoutMs: 15,
    discovery: context => { originalContext = context; return discovery(context); } });
  assert.equal((await admit({ pid: 42 })).status, 'unknown'); assert.equal(scans, 2);
  assert.ok(originalContext.catalog.signal.aborted && originalContext.apps.signal.aborted);
  const oldCatalogContext = originalContext.catalog, later = admit({ pid: 42 }); await turn(); resolveSecond();
  const result = await later; assert.equal(result.status, 'unknown'); assert.equal(originalContext.catalog, oldCatalogContext);
  assert.equal(result.matches.some(value => value.profileId === 'late-owner'), false); assert.equal(scans, 2);
});

test('one matching Windows join failure recollects both sources before publication', async () => {
  let scans = 0, c = 0, a = 0; const refs = [], logs = [];
  const discovery = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), onRetry: e => logs.push(e),
    catalog: async promise => { c++; refs.push(promise); const s = await promise; if (c === 1) throw changed(s); return catalog(s); },
    apps: async promise => { a++; refs.push(promise); await promise; return []; } });
  const round = discovery(contexts()), [found, apps] = await Promise.all([round.catalog, round.apps]);
  assert.deepEqual([scans, c, a], [2, 2, 2]); assert.equal(refs[0], refs[1]); assert.equal(refs[2], refs[3]); assert.notEqual(refs[0], refs[2]);
  assert.equal(found.discovery.snapshotId, sample(2).snapshotId); assert.equal(apps.control.snapshotId, sample(2).snapshotId);
  assert.deepEqual(logs.map(value => value.phase), ['started', 'finished']); assert.equal(logs[1].outcome, 'round_published');
  assert.equal(logs[0].retryId, logs[1].retryId); assert.equal(logs[1].firstIssue.snapshotId, sample(1).snapshotId);
});

test('original collect timeout aborts context and prevents retry after pending reuse', async () => {
  let scans = 0, rejectFirst, seenContext;
  const discovery = createWindowsDesktopDiscovery({ sample: async () => sample(++scans),
    catalog: async p => { const s = await p; return new Promise((_, reject) => { rejectFirst = () => reject(changed(s)); }); }, apps: async p => { await p; return []; } });
  const admit = createRuntimeDesktopAdmission({ ...controls, now: () => 100, timeoutMs: 15,
    discovery: context => { seenContext = context; return discovery(context); } });
  assert.equal((await admit({ pid: 42 })).status, 'unknown');
  assert.equal(seenContext.catalog.signal.aborted, true); assert.equal(seenContext.apps.signal.aborted, true);
  const original = seenContext.catalog, later = admit({ pid: 42 }); await turn(); rejectFirst();
  assert.equal((await later).status, 'unknown'); assert.equal(seenContext.catalog, original); assert.equal(scans, 1);
});

test('second round late success cannot seed lastKnown or publish ready through another waiter', async () => {
  let scans = 0, resolveSecond, contextsSeen;
  const discovery = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [],
    catalog: async promise => { const s = await promise; if (scans === 1) throw changed(s); return new Promise(resolve => { resolveSecond = () => resolve({ ...catalog(s), profiles: [{ id: 'late-owner', pids: [42], source: 'isolated' }] }); }); } });
  const admit = createRuntimeDesktopAdmission({ ...controls, now: () => 100, timeoutMs: 15, discovery: c => { contextsSeen = c; return discovery(c); } });
  assert.equal((await admit({ pid: 42 })).status, 'unknown'); assert.equal(scans, 2);
  assert.ok(contextsSeen.catalog.signal.aborted && contextsSeen.apps.signal.aborted);
  const later = admit({ pid: 42 }); await turn(); resolveSecond();
  const result = await later; assert.equal(result.status, 'unknown'); assert.equal(result.matches.some(value => value.profileId === 'late-owner'), false);
  assert.equal(scans, 2);
});

test('the collector aborts its signal before exposing the timeout result', async () => {
  let received, abortedAt;
  const unavailable = async () => ({ state: 'unavailable', reason: 'fixture' });
  const admit = createDesktopAdmission({ catalog: context => { received = context; context.signal.addEventListener('abort', () => { abortedAt = true; }); return new Promise(() => {}); },
    apps: unavailable, gateway: unavailable, native: unavailable }, { now: () => 100, timeoutMs: 10 });
  const result = await admit({ pid: 42 }); assert.equal(result.status, 'unknown'); assert.equal(abortedAt, true); assert.equal(received.deadlineAt, 110);
});

test('no context or either missing original sibling keeps the direct collector single-round', async () => {
  for (const context of [undefined, {}, { catalog: contexts().catalog }, { apps: contexts().apps }]) {
    let scans = 0;
    const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), catalog: async p => { throw changed(await p); }, apps: async () => [] })(context);
    const [c, a] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(c.status, 'rejected'); assert.equal(a.status, 'fulfilled'); assert.equal(scans, 1);
  }
});

test('first-round fast apps never publish before the selected second round is complete', async () => {
  let scans = 0, failFirst, finishSecond, published = false;
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], catalog: async p => {
    const s = await p; if (scans === 1) return new Promise((_, reject) => { failFirst = () => reject(changed(s)); });
    return new Promise(resolve => { finishSecond = () => resolve(catalog(s)); });
  } })(contexts());
  const pendingApps = round.apps.then(value => { published = true; return value; });
  await turn(); assert.equal(published, false); failFirst(); await turn(); assert.equal(scans, 2); assert.equal(published, false);
  finishSecond(); const [c, a] = await Promise.all([round.catalog, pendingApps]); assert.equal(c.discovery.snapshotId, a.control.snapshotId);
});

test('nontransient and unrelated join failures never start a second sample', async () => {
  for (const failure of [new Error('PROFILE_PROCESS_SCAN_INCOMPLETE'), new Error('access denied private path'), new Error('provider_timeout'),
    profileFileProcessChanged('windows_rm_birth_join', 88, 2, sample(1)), profileFileProcessChanged('windows_parent_identity', 88, 2, sample(1)),
    profileFileProcessChanged('windows_rm_birth_join', 88, 2, sample(1), { origin: 'profile_command', reason: 'unavailable', identityReason: 'not_pinned' }),
    profileFileProcessChanged('windows_rm_birth_join', 88, 2, sample(1), { origin: 'restart_manager', reason: 'birth_mismatch' }),
    profileFileProcessChanged('windows_rm_birth_join', 88, 2, sample(1), { origin: 'restart_manager_batch', reason: 'batch_conflict' }),
    profileFileProcessChanged('windows_parent_identity', 88, 2, sample(1), { origin: 'parent_chain', reason: 'parent_newer' }),
    profileFileProcessChanged('posix_lsof_pid_join', 88, 2, sample(1)), profileFileProcessChanged('profile_runtime_pid_join', 88, 2, sample(1)),
    profileFileProcessChanged('windows_rm_pid_join', 88, 2), changed(sample(2)),
    profileFileProcessChanged('windows_rm_pid_join', 42, 2, sample(1)), profileFileProcessChanged('windows_rm_pid_join', 88, 3, sample(1))]) {
    let scans = 0;
    const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), catalog: async () => { throw failure; }, apps: async () => [] })(contexts());
    const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(c.reason, failure); assert.equal(scans, 1);
  }
});

test('the native sampler and every retry inherit both original deadlines and abort signals', async () => {
  for (const key of ['a', 'b']) {
    const context = contexts(), seen = []; context.apps.deadlineAt = 900;
    let scans = 0;
    const round = createWindowsDesktopDiscovery({ sample: async native => { seen.push(native); return sample(++scans); },
      apps: async () => [], catalog: async promise => { const s = await promise; if (scans === 1) throw changed(s); return catalog(s); } })(context);
    await Promise.all([round.catalog, round.apps]);
    assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.equal(seen[0].deadlineAt, 900);
    assert.equal(seen[0].signal.aborted, false); context[key].abort(); assert.equal(seen[0].signal.aborted, true);
    assert.equal(Object.hasOwn((await round.catalog).discovery, 'context'), false);
  }
});

// Exercise malformed optional route evidence at the existing pure builder
// boundary. Every OS/service import remains absent or replaced.
function factoryWithBuilder(builder) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { transformSync } = require('esbuild');
  const source = fs.readFileSync(path.join(__dirname, '../src/main/desktop/runtime-admission.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${transformSync(source, { loader: 'ts', format: 'cjs' }).code}\n})`)(id => {
    if (id === './admission') return { createDesktopAdmission };
    if (id === './apps-discovery') return { buildDesktopAppsControlFromSample: builder };
    if (id === '../profile-process-change') return loadCli('src/main/profile-process-change.ts');
    if (id === '../windows-platform') return { collectWindowsControlSample: () => assert.fail('No real OS query') };
    if (id === 'zod' || id.startsWith('node:')) return require(id);
    return {};
  }, module, module.exports);
  return module.exports.createWindowsDesktopDiscovery;
}

test('missing incomplete or mismatched apps control evidence cannot authorize retry', async () => {
  for (const builder of [() => { throw new Error('missing optional evidence'); },
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), complete: false }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), gaps: ['tcp_incomplete'] }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), snapshotId: sample(2).snapshotId }),
    (a, s) => ({ ...buildDesktopAppsControlFromSample(a, s), capturedAt: s.capturedAt + 1 })]) {
    let scans = 0; const logs = [];
    const round = factoryWithBuilder(builder)({ sample: async () => sample(++scans), catalog: async p => { throw changed(await p); }, apps: async () => [], onRetry: e => logs.push(e) })(contexts());
    await Promise.allSettled([round.catalog, round.apps]); assert.equal(scans, 1); assert.equal(logs.length, 1); assert.equal(logs[0].outcome, 'not_retried');
  }
  let scans = 0;
  const rejected = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), catalog: async p => { throw changed(await p); },
    apps: async () => { throw new Error('PROFILE_LOCAL_APPS_CONFIG_CHANGED'); } })(contexts());
  const values = await Promise.allSettled([rejected.catalog, rejected.apps]); assert.equal(scans, 1); assert.equal(values[1].status, 'rejected');
});

test('both original contexts independently revoke the next sample without a fresh budget', async () => {
  for (const key of ['a', 'b']) {
    let scans = 0, finish; const context = contexts(), logs = [];
    const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
      catalog: async p => { const s = await p; return new Promise((_, reject) => { finish = () => reject(changed(s)); }); } })(context);
    await turn(); context[key].abort(); finish();
    const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(scans, 1); assert.equal(values[0].reason.message, 'provider_timeout');
    assert.equal(values[1].reason.message, 'provider_timeout'); assert.equal(logs[0].outcome, 'deadline');
  }
});

test('second failure remains final while retaining first diagnostic, and never starts a third sample', async () => {
  let scans = 0; const logs = [];
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { throw changed(await p); } })(contexts());
  const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(scans, 2);
  assert.equal(c.reason.profileProcessChange.snapshotId, sample(2).snapshotId); assert.equal(logs[1].outcome, 'second_failed');
  assert.equal(logs[1].firstIssue.snapshotId, sample(1).snapshotId); assert.equal(logs[1].secondSample.snapshotId, sample(2).snapshotId);
});

test('second sample time remains genuine while the outer provider wrapper retains the earlier start', async () => {
  let now = 100, scans = 0; const logs = []; let chosen;
  const discovery = createWindowsDesktopDiscovery({ sample: async () => sample(++scans, now), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { const s = await p; if (scans === 1) { now = 200; throw changed(s); } now = 300; return catalog(s); } });
  const admit = createRuntimeDesktopAdmission({ ...controls, now: () => now, timeoutMs: 1000, maxAgeMs: 150,
    discovery: context => (chosen = discovery(context)) });
  const result = await admit({ pid: 42 }); assert.equal(result.status, 'unknown'); assert.ok(result.gaps.includes('catalog:stale_snapshot'));
  assert.ok(!result.gaps.includes('catalog:stale_discovery')); assert.equal((await chosen.catalog).discovery.capturedAt, 200);
  assert.equal((await chosen.apps).control.capturedAt, 200); assert.equal(logs[1].secondSample.capturedAt, 200); assert.equal(logs[1].firstIssue.capturedAt, 100);
});

test('second-round identity mismatch cannot publish a successful catalog', async () => {
  let scans = 0; const logs = [];
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { const s = await p; if (scans === 1) throw changed(s); return catalog(sample(1)); } })(contexts());
  const [c] = await Promise.allSettled([round.catalog, round.apps]); assert.equal(scans, 2); assert.equal(c.status, 'rejected'); assert.equal(c.reason.message, 'PROFILE_DISCOVERY_ROUND_INVALID');
  assert.equal(logs[1].outcome, 'second_failed'); assert.equal(logs[1].reason, 'round_identity_mismatch');
});

test('diagnostic callback failure and mutation do not affect results or leak provider text', async () => {
  let scans = 0; const logs = [];
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [],
    catalog: async p => { const s = await p; if (scans === 1) throw Object.assign(changed(s), { privatePath: 'C:/Secret/account', command: 'private-command' }); return catalog(s); },
    onRetry: e => { logs.push(structuredClone(e)); e.firstIssue.snapshotId = 'mutated'; throw new Error('logger unavailable'); } })(contexts());
  const [c, a] = await Promise.all([round.catalog, round.apps]); assert.equal(c.discovery.snapshotId, a.control.snapshotId); assert.equal(scans, 2);
  assert.equal(logs[1].firstIssue.snapshotId, sample(1).snapshotId); assert.doesNotMatch(JSON.stringify(logs), /Secret|account|private-command|privatePath|command/);
  assert.equal(logs[1].outcome, 'round_published');
});

test('elapsed original deadline prevents a retry even before the abort timer callback runs', async () => {
  let now = 100, scans = 0; const context = contexts(() => now, 110), logs = [];
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { const s = await p; now = 110; throw changed(s); } })(context);
  const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(context.catalog.signal.aborted, false);
  assert.equal(scans, 1); assert.equal(values[0].reason.message, 'provider_timeout'); assert.equal(values[1].reason.message, 'provider_timeout');
  assert.equal(logs[0].outcome, 'deadline');
});

test('a second round crossing either original deadline cannot be published before timers run', async () => {
  let now = 100, scans = 0; const context = contexts(() => now, 110), logs = [];
  const round = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { const s = await p; if (scans === 1) throw changed(s); now = 110; return catalog(s); } })(context);
  const values = await Promise.allSettled([round.catalog, round.apps]); assert.equal(context.catalog.signal.aborted, false);
  assert.equal(scans, 2); assert.equal(values[0].reason.message, 'provider_timeout'); assert.equal(values[1].reason.message, 'provider_timeout');
  assert.equal(logs[1].outcome, 'deadline');
});

test('publishing the fresh round still samples current ownership afterwards and can deny control', async () => {
  let scans = 0, owner = false; const reads = [], logs = [];
  const discovery = createWindowsDesktopDiscovery({ sample: async () => sample(++scans), apps: async () => [], onRetry: e => logs.push(e),
    catalog: async p => { const s = await p; reads.push(`catalog:${scans}`); if (scans === 1) throw changed(s); owner = true; return catalog(s); } });
  const admit = createRuntimeDesktopAdmission({ ...controls, now: () => 100, discovery,
    gateway: async () => { reads.push('gateway'); return { state: { profiles: owner ? [{ profileId: 'fixture', profileName: 'Fixture', publicPort: 9223,
      chromePid: 42, ownerSessionId: 'other-owner', ownership: 'user', sessionStatus: 'active', driverState: 'parked',
      agentHealth: 'waiting', controlGeneration: 1, updatedAt: new Date(0).toISOString() }] : [] }, ports: [9223] }; } });
  const result = await admit({ pid: 42 }); assert.equal(result.status, 'occupied');
  assert.deepEqual(reads, ['catalog:1', 'catalog:2', 'gateway']); assert.equal(logs[1].outcome, 'round_published');
});
