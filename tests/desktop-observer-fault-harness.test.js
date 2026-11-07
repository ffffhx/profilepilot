const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Script, createContext } = require('node:vm');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { OwnedObserverFaultOnce, validateOwnedObserverFault } = loadCli('scripts/e2e/desktop-observer-fault-policy.ts');
const clone = value => JSON.parse(JSON.stringify(value));
function facts() {
  const nonce = 'a'.repeat(32), epoch = 'epoch', generation = 'g1';
  const child = { pid: 789, parentPid: 456, startedUtcTicks: '638970000000000000', integrityRid: 8192, elevated: false, uiAccess: false, sha256: 'b'.repeat(64), executable: 'C:\\owned.exe' };
  const request = { id: crypto.randomUUID(), action: 'fault', nonce, expiresAt: 2000, session: 'owned', epoch, generation, childPid: child.pid, childStartedUtcTicks: child.startedUtcTicks };
  const evidence = { browserFactoryCalls: 0, ownedReferenceCurrent: true, spawnCount: 1, session: 'owned', targetPid: 123, targetHwnd: '99', mainPid: 456,
    expectedHash: child.sha256, expectedPath: child.executable, exited: false, child: { ...child }, originalChild: { ...child },
    status: { session: { name: 'owned', state: 'active', window: { pid: 123, nativeHandle: '99' } }, inputObservation: { epoch, generation, phase: 'ready' } },
    runtime: { connected: true, epoch, transport: { epoch, state: 'ready' }, desktop: { epoch, generation, phase: 'ready' }, pendingGeneration: null,
      browserPids: [], browserProtection: { activePids: [], verified: true, pendingConfigurations: 0 } } };
  return { nonce, request, evidence };
}
test('owned fault policy requires exact process and session identities with no shared browser subscription', () => {
  const patches = [
    e => e.browserFactoryCalls++, e => e.ownedReferenceCurrent = false, e => e.spawnCount++, e => e.exited = true,
    e => e.status.session.name = 'another', e => e.status.session.state = 'paused', e => e.status.session.window.pid++,
    e => e.status.session.window.nativeHandle = 'another', e => e.status.inputObservation.phase = 'arming',
    e => e.runtime.browserPids.push(99), e => e.runtime.browserProtection.activePids.push(99), e => e.runtime.browserProtection.pendingConfigurations++,
    e => e.runtime.browserProtection.verified = false, e => e.runtime.desktop.epoch = 'old', e => e.runtime.pendingGeneration = 'new',
    e => e.child.pid++, e => e.child.parentPid++, e => e.child.startedUtcTicks = '638970000000000001',
    e => e.child.sha256 = 'c'.repeat(64), e => e.child.executable = 'C:\\other.exe', e => e.child.integrityRid = 12288,
    e => e.child.elevated = true, e => e.child.uiAccess = true, e => e.originalChild.parentPid++
  ];
  for (const patch of patches) { const f = facts(); patch(f.evidence); assert.throws(() => validateOwnedObserverFault(f.request, f.evidence, f.nonce, 1000)); }
  for (const patch of [r => r.nonce = 'c'.repeat(32), r => r.expiresAt = 1000, r => r.epoch = 'old', r => r.extra = true]) {
    const f = facts(); patch(f.request); assert.throws(() => validateOwnedObserverFault(f.request, f.evidence, f.nonce, 1000));
  }
});
test('validated fault calls only the injected exact child once and latches false or throwing outcomes against retry', () => {
  for (const outcome of ['accepted', 'false', 'throw']) {
    const f = facts(), fault = new OwnedObserverFaultOnce(); let calls = 0;
    const run = () => fault.run(f.request, f.evidence, f.nonce, () => { calls++; if (outcome === 'throw') throw new Error('unknown'); return outcome === 'accepted'; }, 1000);
    if (outcome === 'accepted') assert.equal(run().exitConfirmed, false); else assert.throws(run);
    assert.throws(run); assert.equal(calls, 1);
  }
});

const entry = path.resolve(__dirname, '../scripts/verify-desktop-observer-fault.mjs'), root = path.resolve(__dirname, '..');
const source = readFileSync(entry, 'utf8').replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', 'fixtureModuleUrl');
async function runHarness(scenario = 'success', args = ['--run']) {
  const { evaluateOwnedObserverExitEvidence } = await import('../scripts/e2e/desktop-observer-fault-evidence.mjs');
  const files = new Map(), calls = [], output = [], actions = []; let home, fileBase, base, nonce, config, owner = null, receipt, history, launches = 0, faults = 0;
  const tmp = path.join(root, '.tools/mock-observer-fault'), hash = 'b'.repeat(64);
  const target = { id: 'owned-window', pid: 123, nativeHandle: '99', title: 'Owned' };
  const mainIdentity = { pid: 456, parentPid: 77, startedUtcTicks: '638970000000000001', executable: path.join(tmp, 'electron.exe'), sha256: hash, integrityRid: 8192, elevated: false, uiAccess: false };
  const child = { pid: 789, expectedPath: path.join(tmp, 'profilepilot-input-observer-runtime', hash + '.exe'), closed: false,
    identity: { pid: 789, parentPid: 456, startedUtcTicks: '638970000000000002', sha256: hash } };
  const status = () => ({ available: true, session: owner && { name: owner, window: target, state: faults || scenario === 'unexpected-pause' && history ? 'paused' : 'active' },
    inputObservation: { available: true, phase: owner ? faults || scenario === 'unexpected-pause' && history ? 'paused' : 'ready' : 'idle',
      ...(owner ? { generation: 'g1', epoch: 'e1' } : {}), ...(faults ? { reason: scenario === 'stream-first' ? 'disconnected' : 'helper_exited', certainty: 'unknown' } : {}) } });
  const inspection = () => ({ browserFactoryCalls: 0, spawnCount: scenario === 'restarted' && faults ? 2 : 1,
    runtime: { browserPids: scenario === 'shared-browser' ? [55] : [], stopConfirmed: Boolean(faults) },
    child: { ...child, closed: Boolean(faults), exited: Boolean(faults) }, drivers: [{ stopConfirmed: false }, { stopConfirmed: Boolean(faults) }],
    events: faults ? [
      { sequence: 1, kind: 'fault-attempt', childPid: 789, generation: 'g1', epoch: 'e1' },
      { sequence: 2, kind: scenario === 'stream-first' ? 'observer-transport' : 'observer-exit', source: 'stdout:end', childPid: 789 },
      { sequence: 3, kind: 'service-state', state: 'paused', phase: 'paused', generation: 'g1', epoch: 'e1', certainty: 'unknown', reason: scenario === 'stream-first' ? 'disconnected' : 'helper_exited' },
      ...(scenario === 'stream-first' ? [{ sequence: 4, kind: 'observer-exit', childPid: 789 }] : [])
    ] : [] });
  const process = { platform: 'win32', argv: ['node', entry, ...args], env: {}, exitCode: 0 };
  const context = createContext({ assert, path, fileURLToPath, fixtureModuleUrl: pathToFileURL(entry).href, process,
    os: { tmpdir: () => tmp }, createHash: crypto.createHash, randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID,
    createRequire: () => () => mainIdentity.executable, buildSync: () => calls.push('bundle'), evaluateOwnedObserverExitEvidence,
    console: { log: value => output.push(JSON.parse(value)) }, setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: callback => { queueMicrotask(callback); return 1; },
    assertDesktopAcceptanceWindow: async () => calls.push('gate'), assistedFixtureSource: 'assisted.cs', compileAssistedPreparer() {}, prepareAssistedForeground: async () => ({ ok: true }),
    mkdir: async () => {}, mkdtemp: async prefix => (home = prefix + 'pure'),
    writeFile: async (file, content) => files.set(file, String(content)),
    readFile: async file => {
      if (file.endsWith('.cjs') || file.endsWith('.exe')) return Buffer.from('mock bundle or executable');
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file);
    },
    execFileSync: (_file, args) => { if (args[0] !== '--cleanup-owned') { calls.push('compile'); return ''; } calls.push('cleanup-main'); return JSON.stringify({ ok: true, originalExited: true }); },
    rename: async (from, to) => {
      files.set(to, files.get(from)); files.delete(from); if (to !== base + '.request.json') return;
      const request = JSON.parse(files.get(to)); calls.push('private-' + request.action); let response = { id: request.id, ok: true };
      if (request.action === 'inspect') response.result = inspection();
      if (request.action === 'fault') {
        faults++; if (scenario === 'fault-refused') { response.ok = false; response.error = 'identity changed'; faults--; }
        else { response.result = { requested: true }; if (scenario === 'leaked-effect') receipt.text = 'MUST-NOT-APPEAR'; }
        files.set(fileBase + '.input.json', JSON.stringify(receipt));
      }
      if (request.action === 'close') files.set(base + '.closed.json', JSON.stringify({ nonce, cleanupConfirmed: scenario !== 'cleanup-failure' }));
      files.set(base + '.response.json', JSON.stringify(response));
    },
    launchWindowsUserProcess: async (_executable, parameters) => {
      launches++;
      if (launches === 1) {
        [fileBase, nonce] = parameters;
        files.set(fileBase + '.environment.json', JSON.stringify({ nonce, pid: 123, hwnd: '99', startedUtcTicks: '638970000000000003', administrator: false, hooksInstalled: false }));
        receipt = { nonce, pid: 123, text: '', textChanges: 0, foreign: { attempted: false } }; files.set(fileBase + '.input.json', JSON.stringify(receipt)); return { pid: 123 };
      }
      config = JSON.parse(files.get(parameters[1])); base = config.base;
      files.set(base + '.ready.json', JSON.stringify({ nonce, pid: 456, mainIdentity, managementRoot: path.join(home, 'management'), sourceHash: hash })); return { pid: 456 };
    },
    terminateOwnedWindowsProcess: pid => { assert.equal(pid, 123); calls.push('cleanup-fixture'); },
    runDesktopCliProcess: async ({ args: parameters, expectedExitCode, env }) => {
      assert.equal(env.PROFILEPILOT_MANAGEMENT_ROOT, path.join(home, 'management')); const name = parameters[0] === 'desktop' ? parameters[1] : 'ping'; calls.push(name);
      const flag = name => parameters[parameters.indexOf(name) + 1]; let response, exitCode = 0;
      if (name === 'ping') response = { ok: true, data: { pid: 456, build: { entry: path.join(home, 'observer-fault-main.cjs') } } };
      else if (name === 'status') response = { ok: true, result: status() };
      else if (name === 'windows') response = { ok: true, result: { windows: [target] } };
      else if (name === 'claim') { owner = flag('--session'); response = { ok: true, result: status() }; }
      else if (name === 'observe') response = { ok: true, result: { version: 'v1', elements: [{ name: 'Takeover owned edit', role: 'Edit', reference: 'e1', actions: ['set_value'] }] } };
      else if (name === 'doctor') response = { ok: true, result: { source: { integrity: { rid: 8192, elevated: false } }, target: { pid: 123, integrity: { rid: 8192 } } } };
      else if (name === 'receipt') response = { ok: true, result: history };
      else if (name === 'release') { owner = null; response = { ok: true, result: status() }; }
      else if (name === 'action') {
        const action = JSON.parse(files.get(flag('--params-file'))); actions.push(action);
        if (faults) { exitCode = 75; response = { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }; }
        else { receipt.text = action.value; receipt.textChanges++; files.set(fileBase + '.input.json', JSON.stringify(receipt)); response = { ok: true, result: { executed: true } }; history = { historical: true, state: 'succeeded', result: response.result }; }
      } else throw new Error('Forbidden CLI operation: ' + name);
      if (expectedExitCode !== null) assert.equal(expectedExitCode, exitCode); return { response: clone(response), exitCode };
    }
  });
  await new Script('(async () => {\n' + source + '\n})()', { filename: entry }).runInContext(context);
  const record = [...files].find(([file]) => file.endsWith('report.json'));
  return { report: record && JSON.parse(record[1]), calls, actions, output, launches, faults, exitCode: process.exitCode };
}
test('default observer-fault harness compiles only, without querying a service or starting a process', async () => {
  const value = await runHarness('success', []); assert.deepEqual(value.calls, ['compile', 'compile', 'bundle']); assert.equal(value.launches, 0); assert.equal(value.output[0].guiStarted, false);
});
for (const scenario of ['success', 'stream-first']) test('isolated fault workflow accepts matching owned loss ordering: ' + scenario, async () => {
  const value = await runHarness(scenario); assert.equal(value.report.ok, true, JSON.stringify(value.report.error)); assert.equal(value.report.checks.length, 3); assert.equal(value.faults, 1);
  assert.equal(value.calls.includes('resume'), false); assert.equal(value.calls.includes('cleanup-main'), true); assert.equal(value.calls.includes('cleanup-fixture'), true);
  assert.equal(value.report.runningUserAppTested, false); assert.equal(value.actions.length, 2);
  assert.equal(value.report.lossEvidence.order, scenario === 'stream-first' ? 'transport-before-pause-before-exit' : 'exit-before-pause');
});
for (const scenario of ['shared-browser', 'unexpected-pause', 'fault-refused', 'leaked-effect', 'restarted', 'cleanup-failure']) test('fault workflow fails closed and independently cleans its owned processes: ' + scenario, async () => {
  const value = await runHarness(scenario); assert.equal(value.report.ok, false); assert.equal(value.exitCode, 1);
  assert.equal(value.calls.includes('resume'), false); assert.equal(value.calls.includes('cleanup-main'), true); assert.equal(value.calls.includes('cleanup-fixture'), true);
  assert.ok(value.calls.filter(call => call === 'private-fault').length <= 1);
  if (['shared-browser', 'unexpected-pause'].includes(scenario)) assert.equal(value.faults, 0);
});

test('loss evidence rejects unsourced, unrelated, physical and unconfirmed-exit pauses', async () => {
  const { evaluateOwnedObserverExitEvidence } = await import('../scripts/e2e/desktop-observer-fault-evidence.mjs');
  const expected = { childPid: 789, generation: 'g1', epoch: 'e1' };
  const original = [
    { sequence: 1, kind: 'fault-attempt', ...expected },
    { sequence: 2, kind: 'observer-transport', childPid: 789, source: 'stdout:end' },
    { sequence: 3, kind: 'service-state', state: 'paused', phase: 'paused', ...expected, certainty: 'unknown', reason: 'disconnected' },
    { sequence: 4, kind: 'observer-exit', childPid: 789 }
  ];
  for (const change of [
    values => values.shift(), values => values.pop(), values => values[1].source = 'stdin:close', values => values[1].childPid++,
    values => values[1].sequence = 5, values => values[2].reason = 'physical_input', values => values[2].certainty = 'observed',
    values => values[2].generation = 'other', values => values[3].childPid++
  ]) { const values = clone(original); change(values); assert.throws(() => evaluateOwnedObserverExitEvidence(values, expected)); }
  const closedPipe = clone(original); closedPipe[1].source = 'stdout:close';
  assert.equal(evaluateOwnedObserverExitEvidence(closedPipe, expected).reason, 'disconnected');
  closedPipe.pop(); assert.throws(() => evaluateOwnedObserverExitEvidence(closedPipe, expected));
});
