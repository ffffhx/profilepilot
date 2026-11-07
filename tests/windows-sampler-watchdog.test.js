const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

test('native lifetime policy has a fixed deadline, bounded waits, cancellation, and no OS dependencies', { skip: process.platform !== 'win32' }, t => {
  const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sampler-watchdog-pure-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pp-sampler-watchdog-pure-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const executable = path.join(directory, 'WatchdogPure.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:WindowsSamplerWatchdogTests', '/r:System.Web.Extensions.dll', `/out:${executable}`, path.join(root, 'native/windows-sampler/watchdog.cs'),
    path.join(root, 'scripts/e2e/windows-sampler-watchdog-identity.cs'),
    path.join(__dirname, 'helpers/windows-sampler-watchdog-tests.cs')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const report = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.deepEqual(report, { ok: true, checks: 17, nativeCalls: 0, threadsStarted: 0 });
});

test('normal error must echo the owned request header and a precise bounded error', async () => {
  const { verifyWatchdogCase } = await import('../scripts/verify-windows-sampler-watchdog.mjs');
  const requestId = '1cec77a4-1582-4ab7-a1d8-c972c6cda96b';
  const envelope = { version: 1, requestId, operation: 'fileLocks', ok: false, error: { code: 'WINDOWS_SAMPLER_BAD_REQUEST', stage: 'protocol' } };
  const row = { name: 'normal-error', requestId, nonce: requestId.replaceAll('-', ''), closeConfirmed: true, forced: false,
    stderr: '', signal: null, exitCode: 2, elapsedMs: 100, stdout: JSON.stringify(envelope) + '\n' };
  assert.doesNotThrow(() => verifyWatchdogCase(row));
  for (const extra of [{ requestId: 'other' }, { operation: 'snapshot' }, { version: 2 }, { ok: true }, { unexpected: true }, { error: { code: 'WINDOWS_SAMPLER_BAD_REQUEST' } }])
    assert.throws(() => verifyWatchdogCase({ ...row, stdout: JSON.stringify({ ...envelope, ...extra }) + '\n' }));
});

test('parent death evidence requires a surviving child and exact birth/exe/hash before independent waiting', async () => {
  const { verifyWatchdogCase, verifyWatchdogParentReady } = await import('../scripts/verify-windows-sampler-watchdog.mjs');
  const nonce = '1'.repeat(32), startTicks = '639289000000000000';
  const handleInheritance = [-10, -11, -12].map(standard => ({ standard, inheritedBefore: true, inheritedAfter: false }));
  const child = { pid: 43, startTicks, executable: path.resolve('owned-fixture.exe'), sha256: 'a'.repeat(64) };
  const frame = { kind: 'parent-ready', nonce, parentPid: 42, handleInheritance, child, childReady: { kind: 'ready', nonce, pid: 43, startTicks } };
  const expected = { nonce, parentPid: 42, executable: child.executable, sha256: child.sha256 };
  assert.doesNotThrow(() => verifyWatchdogParentReady(frame, expected));
  for (const extra of [{ nonce: '2'.repeat(32) }, { parentPid: 44 }, { child: { ...child, sha256: 'b'.repeat(64) } },
    { child: { ...child, executable: path.resolve('other.exe') } }, { childReady: { ...frame.childReady, startTicks: '639289000000000001' } },
    { handleInheritance: handleInheritance.map(row => ({ ...row, inheritedAfter: true })) }])
    assert.throws(() => verifyWatchdogParentReady({ ...frame, ...extra }, expected));
  const alive = { ok: true, originalExited: false, replacementUntouched: false, timedOut: true, forced: false };
  const childExit = { ok: true, originalExited: true, replacementUntouched: false, timedOut: false, forced: false, closeConfirmed: true,
    exitCode: 2, startedUtcTicks: startTicks, exitedUtcTicks: '639289000100000000' };
  const row = { name: 'parent-death', closeConfirmed: true, forced: false, stderr: '', signal: null, exitCode: 2,
    parent: { killReturned: true, closeConfirmed: true, exitConfirmed: true, readyVerified: true, killRequestedAtMs: 100,
      exitEventAtMs: 102, closeEventAtMs: 103 }, child,
    beforeParentDeath: alive, afterParentDeath: alive, afterParentDeathProbeAtMs: 104, childExit, childLifetimeMs: 10000, afterParentExitObservedMs: 9900 };
  assert.doesNotThrow(() => verifyWatchdogCase(row));
  for (const extra of [{ afterParentDeath: { ...alive, originalExited: true } }, { childExit: { ...childExit, forced: true } },
    { childExit: { ...childExit, replacementUntouched: true } }, { childExit: { ...childExit, exitCode: null } },
    { childExit: { ...childExit, startedUtcTicks: '639289000000000001' } }, { failure: 'partial setup' },
    { parent: { ...row.parent, exitConfirmed: false } }, { parent: { ...row.parent, closeEventAtMs: 101 } }, { afterParentDeathProbeAtMs: 101 },
    { parent: { ...row.parent, cleanupUnconfirmed: true } }, { childCleanupUnconfirmed: true }])
    assert.throws(() => verifyWatchdogCase({ ...row, ...extra }));
});

test('parent pipe-close timeout preserves the first kill receipt and never kills an exited parent again', async () => {
  const { createWatchdogParentStop } = await import('../scripts/verify-windows-sampler-watchdog.mjs');
  let kills = 0, waits = 0, clock = 100;
  const record = { closeConfirmed: false };
  const stop = createWatchdogParentStop({ kill: () => { kills++; return true; } }, record, async () => {
    waits++;
    if (waits === 1) { record.exitConfirmed = true; throw new Error('pipe close pending'); }
    record.closeConfirmed = true;
  }, () => clock);
  await assert.rejects(stop(), /pipe close pending/);
  clock = 3300; await stop(); await stop();
  assert.equal(kills, 1); assert.equal(waits, 2);
  assert.equal(record.killReturned, true); assert.equal(record.killRequestedAtMs, 100);

  const alreadyExited = { exitConfirmed: true, closeConfirmed: false };
  await createWatchdogParentStop({ kill: () => assert.fail('Already exited parent must not receive kill') }, alreadyExited,
    async () => { alreadyExited.closeConfirmed = true; }, () => assert.fail('No replacement timestamp'))();
  assert.equal(alreadyExited.closeConfirmed, true); assert.equal(alreadyExited.killRequestedAtMs, undefined);
});

test('watchdog harness defaults to compile-only and requires confirmed, unforced exit evidence', async () => {
  const { parseWatchdogOptions, verifyWatchdogCase } = await import('../scripts/verify-windows-sampler-watchdog.mjs');
  assert.deepEqual(parseWatchdogOptions([]), { run: false }); assert.deepEqual(parseWatchdogOptions(['--run']), { run: true });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--anything']]) assert.throws(() => parseWatchdogOptions(args));
  const base = { name: 'stdin-stall', closeConfirmed: true, forced: false, stderr: '', signal: null, exitCode: 2, stdout: '', elapsedMs: 10040 };
  assert.doesNotThrow(() => verifyWatchdogCase(base));
  for (const extra of [{ closeConfirmed: false }, { forced: true }, { elapsedMs: 9999 }, { elapsedMs: 14001 }, { stdout: 'unrequested frame' }, { exitCode: 0 }])
    assert.throws(() => verifyWatchdogCase({ ...base, ...extra }));
  const nonce = '1'.repeat(32), frames = [{ kind: 'ready', nonce, pid: 42, startTicks: '639289000000000000' }, { kind: 'cancelled', nonce }, { kind: 'completed', nonce }];
  const cancelled = { ...base, name: 'cancel-and-hold', nonce, pid: 42, exitCode: 0, elapsedMs: 11030, stdout: frames.map(row => JSON.stringify(row)).join('\n') + '\n' };
  assert.doesNotThrow(() => verifyWatchdogCase(cancelled));
  assert.throws(() => verifyWatchdogCase({ ...cancelled, nonce: '2'.repeat(32) }));
  assert.throws(() => verifyWatchdogCase({ ...cancelled, pid: 43 }));
});

async function stdoutFixture() {
  const { runWatchdogStdoutStall, verifyWatchdogCase, WATCHDOG_STDOUT_BYTES } = await import('../scripts/verify-windows-sampler-watchdog.mjs');
  const child = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter(), stdin = new EventEmitter();
  let clock = 0, kills = 0, resumed = 0, next = 0; const timers = new Map();
  Object.assign(child, { pid: 42, stdout, stderr, stdin, kill() { kills++; return true; } }); stdin.end = () => {};
  stdout.pause = () => { stdout.readableFlowing = false; };
  stdout.resume = () => { resumed++; stdout.readableFlowing = true; stdout.emit('data', Buffer.alloc(65536, 90)); };
  const nonce = 'a'.repeat(32);
  const promise = runWatchdogStdoutStall('not-a-real-exe', { nonce, now: () => clock,
    spawnProcess: (_file, args, options) => { assert.deepEqual(args, ['stdout-stall', nonce]); assert.equal(options.windowsHide, true); return child; },
    setTimeout: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  const ready = { kind: 'ready', nonce, pid: 42, startTicks: '639289000000000000' };
  const started = { kind: 'write-started', nonce, plannedBytes: WATCHDOG_STDOUT_BYTES, chunkBytes: 65536 };
  const emitMarkers = (frames = [ready, started]) => stderr.emit('data', Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'));
  return { promise, child, stdout, stderr, emitMarkers, ready, started, verifyWatchdogCase, WATCHDOG_STDOUT_BYTES,
    clock: value => { clock = value; }, kills: () => kills, resumed: () => resumed,
    fire: ms => { const timer = [...timers.values()].find(value => value.ms === ms); assert.ok(timer); timer.callback(); } };
}

test('stdout stall reads zero payload before real exit and drains only byte counts before close', async () => {
  const f = await stdoutFixture();
  assert.equal(f.stdout.listenerCount('data'), 0); assert.equal(f.stdout.readableFlowing, false);
  f.emitMarkers(); f.clock(10040); f.child.emit('exit', 2, null);
  assert.equal(f.resumed(), 1); assert.equal(f.stdout.listenerCount('data'), 1);
  f.clock(10050); f.child.emit('close', 2, null);
  const row = await f.promise; f.verifyWatchdogCase(row);
  assert.equal(row.stdoutBytes, 65536); assert.equal(row.stdoutRetainedBytes, 0); assert.equal(Object.hasOwn(row, 'stdout'), false);
  assert.equal(row.exitEventAtMs, 10040); assert.equal(row.drainStartedAtMs, 10040); assert.equal(row.closeEventAtMs, 10050);
  assert.equal(f.kills(), 0); assert.ok(JSON.stringify(row).length < 4096);
  for (const extra of [{ stdoutBytes: 0 }, { stdoutBytes: f.WATCHDOG_STDOUT_BYTES }, { stdoutObservedBeforeExit: 1 },
    { stdoutRetainedBytes: 1 }, { drainStartedAtMs: 10039 }, { exitConfirmed: false }, { closeEventAtMs: 10039 },
    { stderrMarkers: [f.ready] }, { stderrMarkers: [f.ready, { ...f.started, nonce: 'b'.repeat(32) }] },
    { stderrMarkers: [f.ready, f.started, { kind: 'write-returned', nonce: f.ready.nonce, writtenBytes: f.WATCHDOG_STDOUT_BYTES }] }])
    assert.throws(() => f.verifyWatchdogCase({ ...row, ...extra }));
});

test('stdout stall owned force and absent close are failures even if late exit drains the pipe', async () => {
  const forced = await stdoutFixture(); forced.emitMarkers(); forced.clock(14000); forced.fire(14000);
  assert.equal(forced.kills(), 1); assert.equal(forced.resumed(), 0);
  forced.clock(14001); forced.child.emit('exit', 2, null); forced.clock(14002); forced.child.emit('close', 2, null);
  const row = await forced.promise; assert.equal(row.forced, true); assert.throws(() => forced.verifyWatchdogCase(row));
  const pending = await stdoutFixture(); pending.emitMarkers(); pending.clock(10040); pending.child.emit('exit', 2, null);
  pending.clock(14000); pending.fire(14000); const incomplete = await pending.promise;
  assert.equal(incomplete.cleanupUnconfirmed, true); assert.equal(incomplete.closeConfirmed, false); assert.equal(pending.kills(), 0);
  assert.throws(() => pending.verifyWatchdogCase(incomplete));
});

test('stdout stall rejects close without exit, unexpected errors and a completed writer', async () => {
  const early = await stdoutFixture(); early.emitMarkers(); early.clock(10050); early.child.emit('close', 2, null);
  const earlyRow = await early.promise; assert.equal(earlyRow.failure, 'EXIT_CLOSE_MISMATCH'); assert.equal(early.resumed(), 0);
  assert.throws(() => early.verifyWatchdogCase(earlyRow));
  const returned = await stdoutFixture(); returned.emitMarkers([returned.ready, returned.started,
    { kind: 'write-returned', nonce: returned.ready.nonce, writtenBytes: returned.WATCHDOG_STDOUT_BYTES }]);
  returned.clock(300); returned.child.emit('exit', 0, null); returned.child.emit('close', 0, null);
  const returnedRow = await returned.promise; assert.throws(() => returned.verifyWatchdogCase(returnedRow));
  const broken = await stdoutFixture(); broken.stderr.emit('error', new Error('fixture error')); assert.equal(broken.kills(), 1);
  broken.clock(10050); broken.child.emit('exit', 2, null); broken.child.emit('close', 2, null);
  const brokenRow = await broken.promise; assert.equal(brokenRow.failure, 'STDERR_STREAM_ERROR'); assert.throws(() => broken.verifyWatchdogCase(brokenRow));
});
