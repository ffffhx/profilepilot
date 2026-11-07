const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { createDesktopAdmission, evaluateDesktopAdmission } = loadCli('src/main/desktop/admission.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { profileFileProcessChanged, copyProfileProcessChange, readProfileProcessChangeError } = loadCli('src/main/profile-process-change.ts');
const code = 'PROFILE_FILE_PROCESS_CHANGED', uuid = '1cec77a4-1582-4ab7-a1d8-c972c6cda96b';
const evidence = (extra = {}) => ({ code, stage: 'windows_rm_pid_join', pid: 88, processCount: 1, snapshotId: uuid, capturedAt: 123, ...extra });
const failure = (detail = evidence()) => Object.assign(new Error(code), { code, profileProcessChange: detail, privatePath: 'C:/Private/SecretProfile' });
const snapshots = () => ({ catalog: { state: 'ready', capturedAt: 1000, value: { profiles: [], externalInstances: [], discovery: {
  snapshotId: uuid, capturedAt: 1000, complete: true, processPids: [41], scopedGaps: [] } } },
  apps: { state: 'ready', capturedAt: 1000, value: [] }, gateway: { state: 'ready', capturedAt: 1000, value: { profiles: [], ports: [] } },
  native: { state: 'ready', capturedAt: 1000, value: [] } });
const providers = (catalog) => Object.fromEntries(Object.entries(snapshots()).map(([key, value]) => [key, key === 'catalog' ? catalog : async () => value]));
const target = { id: 'a'.repeat(32), pid: 41, process: 'fixture', className: 'Fake', title: 'Owned fake' };
const expected = detail => [{ source: 'catalog', ...detail }];

test('current provider PID-join evidence survives as bounded diagnostics without changing refusal', async () => {
  let scans = 0;
  const decide = createDesktopAdmission(providers(async () => { scans++; throw failure(); }), { now: () => 1000 });
  const result = await decide(target);
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.gaps, ['catalog:' + code]);
  assert.deepEqual(result.providerIssues, expected(evidence())); assert.equal(scans, 1);
  assert.equal(JSON.stringify(result).includes('Private'), false);
});

test('birth diagnostics distinguish command evidence from Restart Manager without exposing the birth or path', async () => {
  for (const detail of [
    { origin: 'profile_command', reason: 'unavailable', identityReason: 'not_pinned' },
    { origin: 'restart_manager', reason: 'unavailable', identityReason: 'exited' },
    { origin: 'restart_manager', reason: 'birth_mismatch' },
    { origin: 'restart_manager_batch', reason: 'batch_conflict' }
  ]) {
    let scans = 0;
    const error = profileFileProcessChanged('windows_rm_birth_join', 88, 512, { snapshotId: uuid, capturedAt: 123 }, detail);
    const wanted = evidence({ stage: 'windows_rm_birth_join', processCount: 512, ...detail });
    assert.deepEqual(error.profileProcessChange, wanted);
    const admission = createDesktopAdmission(providers(async () => { scans++; throw error; }), { now: () => 1000 });
    const service = new DesktopService({ platform: 'win32', available: () => true, now: () => 1000, admission, allowUnobservedTestDriver: true,
      driver: () => ({ close() {}, async request(operation) { if (operation === 'windows') return { windows: [target] }; if (operation === 'diagnostics') return {}; throw new Error('No input allowed'); } }) });
    try {
      assert.deepEqual((await service.execute({ action: 'desktop', method: 'doctor', windowId: target.id })).admission.providerIssues, expected(wanted));
      await assert.rejects(service.execute({ action: 'desktop', method: 'claim', session: 'birth-details', windowId: target.id }), value => {
        assert.equal(value.code, 'DESKTOP_CONTROL_STATE_UNKNOWN'); assert.deepEqual(value.details.admission.providerIssues, expected(wanted)); return true;
      });
      assert.equal(scans, 2, 'One sample per explicit read, no automatic retry'); assert.equal(service.status().session, null);
    } finally { await service.close(); }
  }
});

test('new diagnostic fields remain finite, paired, stage-compatible, and getter-safe', () => {
  const valid = evidence({ stage: 'windows_rm_birth_join', origin: 'restart_manager', reason: 'unavailable', identityReason: 'exited' });
  assert.deepEqual(copyProfileProcessChange(valid), valid);
  let getters = 0;
  for (const extra of [{ origin: 'Private path' }, { reason: 'secret command' }, { identityReason: 'C:/private' },
    { creationFileTime: '134000000000000000' }, { reason: 'birth_mismatch' }, { origin: undefined },
    { stage: 'windows_rm_pid_join' }, { origin: 'parent_chain' }]) assert.equal(copyProfileProcessChange({ ...valid, ...extra }), undefined);
  const accessor = Object.defineProperty({ ...valid }, 'identityReason', { get() { getters++; throw Error('Private'); } });
  assert.equal(copyProfileProcessChange(accessor), undefined); assert.equal(getters, 0);
  const detailAccessor = Object.defineProperty({ origin: 'restart_manager', reason: 'unavailable' }, 'identityReason', { get() { getters++; throw Error('Private'); } });
  for (const details of [detailAccessor, new Proxy({}, { ownKeys() { throw Error('Private'); } }),
    { origin: 'restart_manager', reason: 'unavailable', path: 'Private' }]) {
    const error = profileFileProcessChanged('windows_rm_birth_join', 88, 512, { snapshotId: uuid, capturedAt: 123 }, details);
    assert.equal(error.message, code); assert.equal(error.code, code);
    assert.deepEqual(error.profileProcessChange, evidence({ stage: 'windows_rm_birth_join', processCount: 512 }));
  }
  assert.equal(getters, 0);
});

test('actual Service doctor and refused claim retain safe provider evidence without input', async () => {
  let inputs = 0;
  const admission = createDesktopAdmission(providers(async () => { throw failure(); }), { now: () => 1000 });
  const service = new DesktopService({ platform: 'win32', available: () => true, now: () => 1000, admission, allowUnobservedTestDriver: true,
    driver: () => ({ close() {}, async request(operation) {
      if (operation === 'windows') return { windows: [target] };
      if (operation === 'diagnostics') return { pure: true };
      inputs++; throw new Error('Unexpected input or observation');
    } }) });
  try {
    const doctor = await service.execute({ action: 'desktop', method: 'doctor', windowId: target.id });
    assert.deepEqual(doctor.admission.providerIssues, expected(evidence()));
    await assert.rejects(service.execute({ action: 'desktop', method: 'claim', session: 'diagnostic-test', windowId: target.id }), error => {
      assert.equal(error.code, 'DESKTOP_CONTROL_STATE_UNKNOWN'); assert.deepEqual(error.details.admission.providerIssues, expected(evidence()));
      assert.equal(JSON.stringify(error.details).includes('Private'), false); return true;
    });
    assert.equal(service.status().session, null); assert.equal(inputs, 0);
  } finally { await service.close(); }
});

test('factory uses only original optional metadata and never synthesizes sampling time', () => {
  const plain = profileFileProcessChanged('profile_runtime_pid_join', 88, 1);
  assert.equal(plain.message, code); assert.equal(plain.code, code);
  assert.deepEqual(plain.profileProcessChange, { code, stage: 'profile_runtime_pid_join', pid: 88, processCount: 1 });
  const context = { snapshotId: uuid, capturedAt: 17, profilePath: 'C:/Private/SecretProfile', command: 'private command' };
  assert.deepEqual(profileFileProcessChanged('windows_rm_pid_join', 88, 1, context).profileProcessChange, evidence({ capturedAt: 17 }));
  let invoked = 0;
  const getters = Object.defineProperties({}, { snapshotId: { get() { invoked++; throw new Error('private'); } }, capturedAt: { get() { invoked++; throw new Error('private'); } } });
  assert.deepEqual(profileFileProcessChanged('profile_runtime_pid_join', 88, 1, getters).profileProcessChange, plain.profileProcessChange); assert.equal(invoked, 0);
});

test('diagnostic whitelist drops the whole malformed payload, including getters and extra keys', async () => {
  let reads = 0;
  const getter = Object.defineProperty(evidence(), 'pid', { get() { reads++; throw new Error('Private getter'); } });
  const throwingProxy = new Proxy({}, { ownKeys() { throw new Error('Private proxy'); } });
  for (const detail of [null, [], { ...evidence(), path: 'C:/Private' }, { ...evidence(), command: 'secret' }, { ...evidence(), source: 'catalog' },
    evidence({ stage: 'C:/Private' }), evidence({ pid: 0 }), evidence({ pid: 2 ** 40 }), evidence({ processCount: -1 }), evidence({ processCount: 1_000_001 }),
    evidence({ snapshotId: 'Private profile' }), evidence({ capturedAt: NaN }), evidence({ capturedAt: -1 }), evidence({ capturedAt: undefined }),
    evidence({ code: 'other' }), { ...evidence(), [Symbol('private')]: 'private' }, getter, throwingProxy]) {
    assert.equal(copyProfileProcessChange(detail), undefined);
    const result = await createDesktopAdmission(providers(async () => { throw failure(detail); }), { now: () => 1000 })(target);
    assert.equal(result.status, 'unknown'); assert.deepEqual(result.gaps, ['catalog:' + code]); assert.equal(result.providerIssues, undefined);
    assert.equal(JSON.stringify(result).includes('Private'), false);
  }
  assert.equal(reads, 0);
  const error = Object.defineProperty(failure(), 'profileProcessChange', { get() { reads++; throw new Error('Private envelope getter'); } });
  assert.equal(readProfileProcessChangeError(error), undefined);
  const result = await createDesktopAdmission(providers(async () => { throw error; }), { now: () => 1000 })(target);
  assert.equal(result.status, 'unknown'); assert.equal(result.providerIssues, undefined); assert.equal(reads, 0);
});

test('unsafe error accessors never replace the original unavailable decision', async () => {
  for (const property of ['code', 'message']) {
    const error = Object.defineProperty(failure(), property, { get() { throw new Error('Private'); } });
    const result = await createDesktopAdmission(providers(async () => { throw error; }), { now: () => 1000 })(target);
    assert.equal(result.status, 'unknown'); assert.equal(result.providerIssues, undefined); assert.equal(JSON.stringify(result).includes('Private'), false);
  }
});

test('lastKnown keeps its age and never supplies identity or time for a failed sample', async () => {
  let now = 1000, calls = 0; const first = snapshots().catalog;
  const decide = createDesktopAdmission(providers(async () => {
    calls++; if (calls === 1) return first;
    throw calls === 2 ? failure(evidence({ capturedAt: 17 })) : profileFileProcessChanged('windows_rm_pid_join', 88, 1);
  }), { now: () => now, maxAgeMs: 10 });
  assert.equal((await decide(target)).status, 'unmanaged'); now = 2000;
  const second = await decide(target); assert.equal(second.status, 'unknown'); assert.ok(second.gaps.includes('catalog:stale_discovery'));
  assert.deepEqual(second.providerIssues, expected(evidence({ capturedAt: 17 })));
  const third = await decide(target); assert.equal(third.status, 'unknown');
  assert.deepEqual(third.providerIssues, expected({ code, stage: 'windows_rm_pid_join', pid: 88, processCount: 1 })); assert.equal(calls, 3);
});

test('unavailable snapshot diagnostic getter is discarded even when lastKnown must be attached', async () => {
  let calls = 0, reads = 0;
  const bad = Object.defineProperty({ state: 'unavailable', reason: code }, 'processIssue', { enumerable: true, get() { reads++; throw new Error('Private'); } });
  const decide = createDesktopAdmission(providers(async () => ++calls === 1 ? snapshots().catalog : bad), { now: () => 1000 });
  await decide(target); const value = await decide(target); assert.equal(value.status, 'unknown'); assert.equal(value.providerIssues, undefined); assert.equal(reads, 0);
});

test('late timeout rejection cannot backfill evidence or trigger an automatic rescan', async () => {
  let reject, calls = 0;
  const pending = new Promise((_, no) => { reject = no; });
  const decide = createDesktopAdmission(providers(() => { calls++; return pending; }), { now: () => 1000, timeoutMs: 10 });
  const result = await decide(target), before = JSON.stringify(result);
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.gaps, ['catalog:provider_timeout']); assert.equal(result.providerIssues, undefined);
  reject(failure()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(result), before); assert.equal(calls, 1);
});

test('provider source is fixed by collection and at most one safe issue per source is exposed', () => {
  const values = snapshots();
  for (const source of Object.keys(values)) values[source] = { state: 'unavailable', reason: code, processIssue: evidence() };
  const result = evaluateDesktopAdmission(target, values, { now: 1000 });
  assert.equal(result.status, 'unknown'); assert.equal(result.providerIssues.length, 4);
  assert.deepEqual(result.providerIssues.map(item => item.source), ['catalog', 'gateway', 'native', 'apps']);
});

test('doctor and refused resume preserve an existing user pause and its lease', async () => {
  let failing = false, now = 1000;
  const decide = createDesktopAdmission(providers(async () => { if (failing) throw failure(); return { ...snapshots().catalog, capturedAt: now, value: {
    ...snapshots().catalog.value, discovery: { ...snapshots().catalog.value.discovery, capturedAt: now } } }; }), { now: () => now });
  const service = new DesktopService({ platform: 'win32', available: () => true, now: () => now, admission: decide, allowUnobservedTestDriver: true,
    driver: () => ({ close() {}, async request(operation) { if (operation === 'windows') return { windows: [target] }; if (operation === 'diagnostics') return {}; throw new Error('No input permitted'); } }) });
  try {
    await service.execute({ action: 'desktop', method: 'claim', session: 'pause-test', windowId: target.id }); service.control('takeover');
    const paused = service.status(); failing = true; now += 100;
    const doctor = await service.execute({ action: 'desktop', method: 'doctor', windowId: target.id }); assert.deepEqual(doctor.admission.providerIssues, expected(evidence()));
    assert.deepEqual(service.status(), paused);
    await assert.rejects(service.resume(), { code: 'DESKTOP_CONTROL_STATE_UNKNOWN' }); assert.deepEqual(service.status(), paused);
  } finally { await service.close(); }
});
