const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../scripts/e2e/desktop-parent-death-protocol.mjs');
const hash = 'b'.repeat(64), nonce = 'a'.repeat(32);
const parent = { ok: true, pid: 22, parentPid: 9, executable: 'C:\\Owned\\node.exe', sha256: hash,
  startedUtcTicks: '639289105934552999', integrityRid: 8192, elevated: false, uiAccess: false };
const helper = { ...parent, pid: 33, parentPid: 22, executable: 'C:\\Temp\\profilepilot-desktop-runtime\\' + hash + '.exe' };
const expected = { nonce, pid: 44, startedUtcTicks: '639289105934552998', hwnd: '123', runId: '39cd4cbf-195b-4e90-9542-7385712323ac' };
const pending = () => ({ ...expected, phase: 'entered', getterActive: true, entries: 1, returned: 0 });
function fake() {
  const events = [], options = { expected, parent, helper, observationStartedAt: 0 }, record = {};
  const entered = { ...expected, marker: 'entered', source: 'accessible-name-getter', entries: 1, returned: 0,
    getterActive: true, counter: '100', frequency: 10000000, getterThreadId: 99, utc: '2026-10-30T00:00:00.000Z' };
  const parentPending = { nonce, runId: expected.runId, phase: 'observing', requestSettled: false,
    parentIdentity: parent, helperIdentity: helper, dispatchedUtc: Date.parse(entered.utc) - 1 };
  let clock = 0;
  const io = {
    now: () => ++clock,
    entered: async () => { events.push('entered'); return entered; },
    parentPending: async () => { events.push('parent-pending'); return parentPending; },
    providerPending: async () => { events.push('provider-pending'); return pending(); },
    terminateParent: async () => { events.push('planned-parent-fault'); return { ok: true, originalExited: true, forced: true }; },
    waitParentExit: async () => { events.push('parent-original-exit'); return { ok: true, originalExited: true }; },
    waitHelperExit: async ms => { assert.equal(ms, 5000); events.push('helper-original-exit'); return { ok: true, originalExited: true }; }
  };
  return { options, record, io, events, entered, parentPending };
}
test('parent-death probe defaults to compile-only and requires explicit run', async () => {
  const { parentDeathOptions } = await load();
  assert.deepEqual(parentDeathOptions([]), { run: false, runtime: 'node' }); assert.deepEqual(parentDeathOptions(['--check']), { run: false, runtime: 'node' });
  assert.deepEqual(parentDeathOptions(['--run']), { run: true, runtime: 'node' });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--kill-app'], ['--run', '--pid', '22']]) assert.throws(() => parentDeathOptions(args));
});
test('parent and helper exits are independently required while the provider remains blocked', async () => {
  const { runParentDeathCase } = await load(); const f = fake();
  assert.equal((await runParentDeathCase(f.options, f.io, f.record)).ok, true);
  assert.deepEqual(f.events, ['entered', 'parent-pending', 'provider-pending', 'planned-parent-fault', 'parent-original-exit', 'provider-pending', 'helper-original-exit', 'provider-pending']);
});
test('a surviving helper is preserved as failed baseline evidence, not washed into later cleanup success', async () => {
  const { runParentDeathCase } = await load(); const f = fake();
  f.io.waitHelperExit = async () => ({ ok: true, originalExited: false, timedOut: true });
  await assert.rejects(runParentDeathCase(f.options, f.io, f.record), { code: 'DESKTOP_PARENT_DEATH_HELPER_SURVIVED' });
  assert.equal(f.record.ok, undefined); assert.equal(f.record.helperExit.originalExited, false);
  assert.equal(f.record.providerAfterHelperWait.getterActive, true);
});
test('a close-like indication or an already exited parent is not a planned confirmed parent fault', async () => {
  const { runParentDeathCase } = await load();
  for (const mutate of [f => { f.io.terminateParent = async () => ({ ok: true, originalExited: true }); },
    f => { f.io.waitParentExit = async () => ({ ok: true, close: true, originalExited: false }); },
    f => { f.io.waitParentExit = async () => { throw new Error('Access denied'); }; }]) {
    const f = fake(); mutate(f); await assert.rejects(runParentDeathCase(f.options, f.io, f.record));
    assert.equal(f.record.ok, undefined); assert.ok(!f.events.includes('helper-original-exit'));
  }
});
test('parent exit must be confirmed before the original worker request timeout can explain helper retirement', async () => {
  const { runParentDeathCase } = await load();
  for (const observedAt of [10000, 12000, NaN, -1]) {
    const f = fake(); let times = 0; f.io.now = () => ++times === 1 ? 1 : observedAt;
    await assert.rejects(runParentDeathCase(f.options, f.io, f.record), { code: 'DESKTOP_PARENT_DEATH_PARENT_EXIT_TOO_LATE' });
    assert.equal(f.record.ok, undefined); assert.ok(!f.events.includes('helper-original-exit'));
  }
  const f = fake(); f.options.observationStartedAt = undefined;
  await assert.rejects(runParentDeathCase(f.options, f.io, f.record));
  assert.ok(!f.events.includes('planned-parent-fault'));
});
test('early read completion, stale entry and mismatched process identities prevent planned termination', async () => {
  const { runParentDeathCase } = await load();
  for (const mutate of [f => { f.parentPending.requestSettled = true; }, f => { f.parentPending.phase = 'read-returned'; },
    f => { f.parentPending.dispatchedUtc = Date.parse(f.entered.utc) + 1; },
    f => { f.parentPending.helperIdentity = { ...helper, startedUtcTicks: '639289105934553000' }; },
    f => { f.entered.runId = 'different'; }]) {
    const f = fake(); mutate(f); await assert.rejects(runParentDeathCase(f.options, f.io, f.record));
    assert.ok(!f.events.includes('planned-parent-fault')); assert.equal(f.record.ok, undefined);
  }
});
test('provider returning before either independent exit check fails coverage', async () => {
  const { runParentDeathCase } = await load();
  for (const position of [1, 2, 3]) {
    const f = fake(); let reads = 0;
    f.io.providerPending = async () => ++reads === position ? { ...pending(), phase: 'returned', getterActive: false, returned: 1 } : pending();
    await assert.rejects(runParentDeathCase(f.options, f.io, f.record)); assert.equal(f.record.ok, undefined);
  }
});
test('full parent/helper identity validation excludes the running App or an unrelated process', async () => {
  const { verifyProbeParent, verifyProbeHelper } = await load();
  const expect = { nonce, executable: parent.executable, sha256: hash };
  assert.deepEqual(verifyProbeParent({ nonce, identity: parent }, expect, 22), parent);
  assert.deepEqual(verifyProbeHelper(helper, parent, hash, path.win32.dirname(helper.executable)), helper);
  for (const patch of [{ parentPid: 32176 }, { sha256: 'c'.repeat(64) }, { integrityRid: 12288 }, { uiAccess: true },
    { pid: 0 }, { executable: 'C:\\unrelated\\' + hash + '.exe' }]) {
    assert.throws(() => verifyProbeHelper({ ...helper, ...patch }, parent, hash, path.win32.dirname(helper.executable)));
  }
  assert.throws(() => verifyProbeParent({ nonce, identity: parent }, expect, 999));
});
test('cleanup force never passes and independently checks original exit afterwards', async () => {
  const { retireProbeProcess } = await load(); const calls = []; let waits = 0;
  const result = await retireProbeProcess(helper, { wait: async () => { calls.push('wait'); return { ok: true, originalExited: ++waits === 2 }; },
    force: async value => { assert.deepEqual(value, helper); calls.push('force'); return { ok: true, originalExited: true, forced: true }; } });
  assert.equal(result.ok, false); assert.equal(result.after.originalExited, true); assert.deepEqual(calls, ['wait', 'force', 'wait']);
  let touched = false;
  await assert.rejects(retireProbeProcess({ pid: 33 }, { wait: () => { touched = true; }, force: () => { touched = true; } }));
  assert.equal(touched, false);
});
test('build validation pins actual dist modules and native bytes rather than compiling a new helper', async () => {
  const { verifyParentBuild, desktopParentComponents, digest } = await load();
  const components = Object.fromEntries(desktopParentComponents.map(name => [name, digest(Buffer.from(name))]));
  const manifest = { version: 1, components, buildId: digest(JSON.stringify(components)) };
  const read = async file => file.endsWith('control-build.json') ? JSON.stringify(manifest) : Buffer.from(desktopParentComponents.find(name => file.endsWith(name.replaceAll('/', path.sep))));
  assert.equal((await verifyParentBuild('owned', read)).buildId, manifest.buildId);
  await assert.rejects(verifyParentBuild('owned', async file => file.endsWith('control-build.json') ? JSON.stringify(manifest) : Buffer.from('changed')));
});
test('real entry keeps failure cleanup and never contacts the running App or installs input observation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-desktop-parent-death.mjs'), 'utf8');
  assert.ok(source.indexOf('if (!options.run)') < source.indexOf('await assertDesktopAcceptanceWindow()'));
  assert.ok(source.indexOf('report.parentAttempted = true') < source.indexOf('parentLaunch = await launchWindowsUserProcess'));
  const cleanup = source.slice(source.indexOf('  finally {'));
  assert.ok(cleanup.indexOf("clean('providerRelease'") < cleanup.indexOf('retireProbeProcess(helperIdentity'));
  assert.match(cleanup, /if \(!result\.ok\) report\.ok = false/);
  assert.doesNotMatch(cleanup, /report\.ok = true/);
  assert.doesNotMatch(source, /ppilot|runDesktopCliProcess|\.kill\(|InputObserver/);
  const parentSource = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-parent-death-parent.mjs'), 'utf8');
  assert.match(parentSource, /new DesktopWorker\(undefined/);
  assert.match(parentSource, /helper\.once\('exit'/); assert.doesNotMatch(parentSource, /helper\.once\('close'/);
  assert.doesNotMatch(parentSource, /window\.action|window\.screenshot|inputObserver|SendInput/);
});
