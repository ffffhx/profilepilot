import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileWindowsSampler } from './build-windows-sampler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);
const tickDuration = (end, start) => Number(BigInt(end) - BigInt(start)) / 10000;
export const WATCHDOG_STDOUT_BYTES = 16 * 1024 * 1024;
export function parseWatchdogOptions(args) {
  assert.ok(args.length === 0 || args.length === 1 && ['--check', '--run'].includes(args[0]), 'Use --check or --run.');
  return { run: args[0] === '--run' };
}
export function verifyWatchdogCase(value) {
  assert.equal(value.closeConfirmed, true); assert.equal(value.forced, false);
  if (value.name !== 'stdout-stall') assert.equal(value.stderr, '');
  assert.equal(value.signal, null);
  if (value.name === 'normal-error') {
    assert.equal(value.exitCode, 2); assert.ok(value.elapsedMs < 3000);
    assert.match(value.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.equal(value.requestId.replaceAll('-', ''), value.nonce);
    assert.deepEqual(JSON.parse(value.stdout), { version: 1, requestId: value.requestId, operation: 'fileLocks', ok: false,
      error: { code: 'WINDOWS_SAMPLER_BAD_REQUEST', stage: 'protocol' } });
  } else if (value.name === 'stdin-stall') {
    assert.equal(value.exitCode, 2); assert.equal(value.stdout, ''); assert.ok(value.elapsedMs >= 10000 && value.elapsedMs < 14000);
  } else if (value.name === 'stdout-stall') {
    assert.equal(value.failure, undefined); assert.notEqual(value.cleanupUnconfirmed, true);
    assert.equal(value.exitConfirmed, true); assert.equal(value.exitCode, 2);
    assert.ok(value.exitEventAtMs >= 10000 && value.exitEventAtMs < 14000);
    assert.ok(value.drainStartedAtMs >= value.exitEventAtMs);
    assert.ok(value.closeEventAtMs >= value.drainStartedAtMs);
    assert.ok(value.elapsedMs < 14000);
    assert.equal(value.pausedBeforeRead, true); assert.equal(value.stdoutObservedBeforeExit, 0);
    assert.equal(value.stdoutRetainedBytes, 0); assert.equal(Object.hasOwn(value, 'stdout'), false);
    assert.ok(Number.isSafeInteger(value.stdoutBytes) && value.stdoutBytes > 0 && value.stdoutBytes < WATCHDOG_STDOUT_BYTES);
    assert.ok(value.stderrBytes > 0 && value.stderrBytes <= 4096);
    assert.equal(value.stderrMarkers.length, 2);
    const [ready, write] = value.stderrMarkers;
    assert.deepEqual(Object.keys(ready).sort(), ['kind', 'nonce', 'pid', 'startTicks']);
    assert.equal(ready.kind, 'ready'); assert.equal(ready.nonce, value.nonce); assert.equal(ready.pid, value.pid);
    assert.match(ready.startTicks, /^[1-9][0-9]{10,19}$/);
    assert.deepEqual(write, { kind: 'write-started', nonce: value.nonce, plannedBytes: WATCHDOG_STDOUT_BYTES, chunkBytes: 64 * 1024 });
  } else if (value.name === 'parent-death') {
    assert.equal(value.failure, undefined);
    assert.notEqual(value.parent.cleanupUnconfirmed, true);
    assert.notEqual(value.childCleanupUnconfirmed, true);
    assert.equal(value.exitCode, 2); assert.equal(value.parent.killReturned, true); assert.equal(value.parent.closeConfirmed, true);
    assert.equal(value.parent.exitConfirmed, true);
    assert.ok(value.parent.exitEventAtMs >= value.parent.killRequestedAtMs);
    assert.ok(value.parent.closeEventAtMs >= value.parent.exitEventAtMs);
    assert.ok(value.afterParentDeathProbeAtMs >= value.parent.exitEventAtMs);
    assert.ok(value.parent.killRequestedAtMs < 3000); assert.equal(value.parent.readyVerified, true);
    for (const probe of [value.beforeParentDeath, value.afterParentDeath]) {
      assert.equal(probe.ok, true); assert.equal(probe.originalExited, false); assert.equal(probe.replacementUntouched, false);
      assert.equal(probe.timedOut, true); assert.equal(probe.forced, false);
    }
    const ended = value.childExit;
    assert.equal(ended.ok, true); assert.equal(ended.originalExited, true); assert.equal(ended.closeConfirmed, true);
    assert.equal(ended.forced, false); assert.equal(ended.replacementUntouched, false); assert.equal(ended.timedOut, false);
    assert.equal(ended.exitCode, 2); assert.equal(ended.startedUtcTicks, value.child.startTicks);
    assert.equal(value.childLifetimeMs, tickDuration(ended.exitedUtcTicks, ended.startedUtcTicks));
    assert.ok(value.childLifetimeMs >= 10000 && value.childLifetimeMs < 14000);
    assert.ok(value.afterParentExitObservedMs > 0 && value.afterParentExitObservedMs < 12000);
  } else {
    const frames = value.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(frames.every(frame => frame.nonce === value.nonce));
    assert.equal(frames[0].kind, 'ready'); assert.equal(frames[0].pid, value.pid); assert.match(frames[0].startTicks, /^[1-9][0-9]{10,19}$/);
    if (value.name === 'blocked-provider') {
      assert.equal(value.exitCode, 2); assert.equal(frames.length, 1); assert.ok(value.elapsedMs >= 10000 && value.elapsedMs < 14000);
    } else {
      assert.equal(value.name, 'cancel-and-hold'); assert.equal(value.exitCode, 0);
      assert.deepEqual(frames.map(frame => frame.kind), ['ready', 'cancelled', 'completed']);
      assert.ok(value.elapsedMs >= 11000 && value.elapsedMs < 14000);
    }
  }
}

// Injectable child/timers permit pure event-order tests. No application stdout
// data handler exists before exit; Node/OS buffers may still prefetch. The later
// drain counts bytes without retaining the payload.
export function runWatchdogStdoutStall(executable, options = {}) {
  const nonce = options.nonce || randomUUID().replaceAll('-', ''), now = options.now || (() => performance.now());
  const set = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
  const started = now(), spawnProcess = options.spawnProcess || spawn;
  return new Promise(resolve => {
    const child = spawnProcess(executable, ['stdout-stall', nonce], { windowsHide: true, stdio: 'pipe' });
    const row = { name: 'stdout-stall', nonce, pid: child.pid, forced: false, closeConfirmed: false, exitConfirmed: false,
      exitCode: null, signal: null, stdoutBytes: 0, stdoutObservedBeforeExit: 0, stdoutRetainedBytes: 0,
      stdoutReadScope: 'application_data_events_only', osReadCountKnown: false, stderrBytes: 0, stderrMarkers: [] };
    let finished = false, grace, stderr = '';
    child.stdout.pause(); row.pausedBeforeRead = child.stdout.readableFlowing === false;
    const finish = () => {
      if (finished) return; finished = true; clear(deadline); if (grace !== undefined) clear(grace);
      try {
        const lines = stderr.trim().split(/\r?\n/); row.stderrMarkers = lines.filter(Boolean).map(line => JSON.parse(line));
      } catch { row.failure ||= 'STDERR_MARKER_INVALID'; }
      row.elapsedMs = now() - started; resolve(row);
    };
    const stop = () => {
      if (finished || row.forced) return;
      if (row.exitConfirmed) { row.cleanupUnconfirmed = true; finish(); return; }
      row.forced = true;
      try { row.killReturned = child.kill(); } catch { row.killReturned = false; }
      grace = set(() => { row.cleanupUnconfirmed = true; finish(); }, 2000);
    };
    const deadline = set(stop, 14000);
    child.stderr.on('data', bytes => {
      row.stderrBytes += bytes.length;
      if (row.stderrBytes > 4096) { row.failure ||= 'STDERR_BYTE_LIMIT'; stop(); return; }
      stderr += bytes.toString('utf8');
    });
    child.stdout.on('error', () => { row.failure ||= 'STDOUT_STREAM_ERROR'; stop(); });
    child.stderr.on('error', () => { row.failure ||= 'STDERR_STREAM_ERROR'; stop(); });
    child.on('exit', (code, signal) => {
      row.exitConfirmed = true; row.exitEventAtMs = now() - started; row.exitCode = code; row.signal = signal;
      row.drainStartedAtMs = now() - started;
      child.stdout.on('data', bytes => {
        if (!row.exitConfirmed) row.stdoutObservedBeforeExit += bytes.length;
        row.stdoutBytes += bytes.length;
        if (row.stdoutBytes > WATCHDOG_STDOUT_BYTES) { row.failure ||= 'STDOUT_BYTE_LIMIT'; stop(); }
      });
      child.stdout.resume();
    });
    child.on('close', (code, signal) => {
      row.closeConfirmed = true; row.closeEventAtMs = now() - started;
      if (!row.exitConfirmed || code !== row.exitCode || signal !== row.signal) row.failure ||= 'EXIT_CLOSE_MISMATCH';
      finish();
    });
    child.on('error', () => { row.failure ||= 'OWNED_CHILD_ERROR'; if (child.pid) stop(); });
    child.stdin.on('error', () => {}); child.stdin.end();
  });
}
async function runOwned(executable, name) {
  const nonce = randomUUID().replaceAll('-', ''), started = performance.now();
  const args = name === 'blocked-provider' ? ['block', nonce] : name === 'cancel-and-hold' ? ['cancel-and-hold', nonce] : [];
  return new Promise(resolve => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' });
    const requestId = nonce.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const row = { name, nonce, requestId, pid: child.pid, stdout: '', stderr: '', forced: false, closeConfirmed: false, exitCode: null, signal: null };
    let finished = false, grace;
    const finish = () => { if (finished) return; finished = true; clearTimeout(deadline); clearTimeout(grace);
      row.elapsedMs = performance.now() - started; resolve(row); };
    const stop = () => {
      if (row.forced || finished) return;
      row.forced = true;
      try { row.killReturned = child.kill(); } catch { row.killReturned = false; }
      grace = setTimeout(finish, 2000);
    };
    const deadline = setTimeout(stop, 14000);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
      row[stream] += bytes.toString('utf8'); if (Buffer.byteLength(row[stream]) > 4096) { row[stream] = row[stream].slice(0, 4096); stop(); }
    });
    child.on('error', () => { row.spawnError = true; if (child.pid) stop(); });
    child.on('close', (code, signal) => { row.closeConfirmed = true; row.exitCode = code; row.signal = signal; finish(); });
    child.stdin.on('error', () => {});
    if (name === 'normal-error') child.stdin.end(JSON.stringify({ version: 1, requestId, operation: 'fileLocks', params: {} }) + '\n');
    else if (name === 'stdin-stall') child.stdin.write('{'); // Deliberately never EOF; no OS operation is parsed.
    else child.stdin.end();
  });
}

export function verifyWatchdogParentReady(frame, expected) {
  assert.equal(frame.kind, 'parent-ready'); assert.equal(frame.nonce, expected.nonce); assert.equal(frame.parentPid, expected.parentPid);
  assert.deepEqual(frame.handleInheritance?.map(row => row.standard), [-10, -11, -12]);
  for (const row of frame.handleInheritance) { assert.equal(typeof row.inheritedBefore, 'boolean'); assert.equal(row.inheritedAfter, false); }
  assert.ok(Number.isSafeInteger(frame.child.pid) && frame.child.pid > 0 && frame.child.pid !== expected.parentPid);
  assert.match(frame.child.startTicks, /^[1-9][0-9]{10,19}$/);
  assert.equal(path.resolve(frame.child.executable).toLowerCase(), path.resolve(expected.executable).toLowerCase());
  assert.equal(frame.child.sha256, expected.sha256);
  assert.deepEqual(frame.childReady, { kind: 'ready', nonce: expected.nonce, pid: frame.child.pid, startTicks: frame.child.startTicks });
}
function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OWNED_PROCESS_WAIT_TIMEOUT')), milliseconds); })]).finally(() => clearTimeout(timer));
}
export function createWatchdogParentStop(parent, record, waitClosed, elapsed) {
  let requested = false;
  return async () => {
    if (record.closeConfirmed) return;
    // A delayed pipe close must not send another kill or overwrite the first
    // accepted termination receipt with a later false return.
    if (!requested && !record.exitConfirmed) {
      requested = true; record.killRequestedAtMs = elapsed(); record.killReturned = parent.kill();
    }
    await waitClosed();
  };
}
async function runParentDeath(parentExe, fixture, fixtureHash, identityExe) {
  const started = performance.now(), nonce = randomUUID().replaceAll('-', '');
  const parent = spawn(parentExe, [nonce, fixture], { windowsHide: true, stdio: 'pipe' });
  const row = { name: 'parent-death', nonce, parent: { pid: parent.pid, closeConfirmed: false }, stdout: '', stderr: '', forced: false,
    closeConfirmed: false, exitCode: null, signal: null };
  let resolveReady, rejectReady, received = '', parentExitedAt;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => parent.on('close', (exitCode, signal) => {
    row.parent.closeConfirmed = true; row.parent.exitCode = exitCode; row.parent.signal = signal;
    row.parent.closeEventAtMs = performance.now() - started;
    rejectReady(new Error('PARENT_EXITED_BEFORE_READY')); resolve();
  }));
  const exited = new Promise(resolve => parent.once('exit', (exitCode, signal) => {
    parentExitedAt = performance.now(); row.parent.exitConfirmed = true; row.parent.exitEventAtMs = parentExitedAt - started;
    row.parent.exitEventCode = exitCode; row.parent.exitEventSignal = signal;
    resolve();
  }));
  parent.on('error', () => rejectReady(new Error('PARENT_SPAWN_FAILED')));
  parent.stdout.on('data', bytes => {
    received += bytes.toString('utf8');
    if (Buffer.byteLength(received) > 4096) { rejectReady(new Error('PARENT_READY_TOO_LARGE')); return; }
    if (received.includes('\n')) { try { resolveReady(JSON.parse(received.trim())); } catch { rejectReady(new Error('PARENT_READY_INVALID')); } }
  });
  parent.stderr.on('data', bytes => { row.stderr = (row.stderr + bytes.toString('utf8')).slice(0, 4096); });
  parent.stdin.on('error', () => {}); parent.stdin.end();
  const waitChild = async (milliseconds, force = false) => {
    const args = ['--wait-owned-exit', String(row.child.pid), row.child.startTicks, row.child.executable, row.child.sha256,
      String(milliseconds), ...(force ? ['--force-if-timeout'] : [])];
    const { stdout, stderr } = await execFileAsync(identityExe, args, { windowsHide: true, encoding: 'utf8', timeout: milliseconds + 4000, maxBuffer: 4096 });
    assert.equal(stderr, ''); return JSON.parse(stdout);
  };
  // Process death and inherited-pipe closure are distinct. Prove the orphan
  // while it is alive; require pipe closure separately after its own exit.
  const stopParent = createWatchdogParentStop(parent, row.parent, () => bounded(exited, 3000), () => performance.now() - started);
  try {
    const frame = await bounded(ready, 3000);
    verifyWatchdogParentReady(frame, { nonce, parentPid: parent.pid, executable: fixture, sha256: fixtureHash });
    row.parent.readyVerified = true; row.parent.handleInheritance = frame.handleInheritance; row.child = frame.child; row.childReady = frame.childReady;
    row.beforeParentDeath = await waitChild(1); assert.equal(row.beforeParentDeath.originalExited, false);
    await stopParent(); assert.equal(row.parent.exitConfirmed, true); assert.equal(row.parent.killReturned, true);
    row.parentExitedAt = new Date().toISOString();
    row.afterParentDeathProbeAtMs = performance.now() - started;
    row.afterParentDeath = await waitChild(1);
    // A job object that kills the child with the parent is an unobserved case,
    // never evidence that the independent watchdog handled an orphan.
    assert.equal(row.afterParentDeath.originalExited, false, 'Child did not remain alive after parent death');
    row.childExit = await waitChild(10000, true);
    row.afterParentExitObservedMs = performance.now() - parentExitedAt;
  } catch (error) { row.failure = String(error.message).slice(0, 500); }
  finally {
    try { await stopParent(); } catch { row.parent.cleanupUnconfirmed = true; }
    if (row.child && !row.childExit) try { row.childExit = await waitChild(10000, true); } catch { row.childCleanupUnconfirmed = true; }
    try { await bounded(closed, 3000); } catch { row.parent.cleanupUnconfirmed = true; }
    if (row.childExit) {
      row.forced = row.childExit.forced === true; row.closeConfirmed = row.childExit.closeConfirmed === true;
      row.exitCode = row.childExit.exitCode;
      if (row.childExit.exitedUtcTicks && row.childExit.startedUtcTicks) row.childLifetimeMs = tickDuration(row.childExit.exitedUtcTicks, row.childExit.startedUtcTicks);
    }
    row.elapsedMs = performance.now() - started;
  }
  return row;
}
export async function verifyWindowsSamplerWatchdog(options) {
  assert.equal(process.platform, 'win32');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-sampler-watchdog-'));
  const output = path.join(root, '.tools/desktop-verification', path.basename(directory)); await mkdir(output, { recursive: true });
  const fixture = path.join(directory, 'SamplerWatchdogFixture.exe');
  const parentFixture = path.join(directory, 'SamplerWatchdogParent.exe'), identity = path.join(directory, 'SamplerWatchdogIdentity.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const fixtureSources = ['native/windows-sampler/watchdog.cs', 'scripts/e2e/windows-sampler-watchdog-fixture.cs'];
  execFileSync(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', `/out:${fixture}`, ...fixtureSources.map(file => path.join(root, file))],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  const parentSource = 'scripts/e2e/windows-sampler-watchdog-parent.cs', identitySource = 'scripts/e2e/windows-sampler-watchdog-identity.cs';
  for (const [executable, sources] of [[parentFixture, ['native/windows-sampler/watchdog.cs', parentSource]], [identity, [identitySource]]]) {
    execFileSync(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${executable}`,
      ...sources.map(file => path.join(root, file))], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  }
  const build = await compileWindowsSampler();
  const report = { ok: false, mode: options.run ? 'runtime' : 'compile-only', output,
    scope: 'Sampler lifetime only: owned child processes; no WMI/RM/process scan, GUI, input, hooks, or App control.',
    parentDeathTested: false, stdoutStallTested: false, realtimeDeadlineGuaranteed: false, forcedFinallyGuaranteed: false,
    build, fixture: { executable: fixture, sha256: hash(await readFile(fixture)), sources: Object.fromEntries(await Promise.all(fixtureSources.map(async file => [file, hash(await readFile(path.join(root, file)))]))) },
    parentFixture: { executable: parentFixture, sha256: hash(await readFile(parentFixture)), sourceSha256: hash(await readFile(path.join(root, parentSource))) },
    identity: { executable: identity, sha256: hash(await readFile(identity)), sourceSha256: hash(await readFile(path.join(root, identitySource))) }, cases: [] };
  try {
    if (options.run) for (const name of ['normal-error', 'stdin-stall', 'blocked-provider', 'cancel-and-hold']) {
      const executable = ['normal-error', 'stdin-stall'].includes(name) ? build.executable : fixture;
      const expected = executable === fixture ? report.fixture.sha256 : build.sha256;
      assert.equal(hash(await readFile(executable)), expected);
      const row = await runOwned(executable, name); report.cases.push(row);
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      verifyWatchdogCase(row); // Never proceed past an unconfirmed/forced cleanup.
    }
    if (options.run) {
      for (const artifact of [report.fixture, report.parentFixture, report.identity]) assert.equal(hash(await readFile(artifact.executable)), artifact.sha256);
      const row = await runParentDeath(parentFixture, fixture, report.fixture.sha256, identity); report.cases.push(row);
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      verifyWatchdogCase(row); report.parentDeathTested = true;
    }
    if (options.run) {
      assert.equal(hash(await readFile(fixture)), report.fixture.sha256);
      const row = await runWatchdogStdoutStall(fixture); report.cases.push(row);
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      verifyWatchdogCase(row); report.stdoutStallTested = true;
    }
    report.ok = true;
  } catch (error) { report.error = { code: error.code || 'WATCHDOG_VERIFICATION_FAILED', message: String(error.message).slice(0, 1000) }; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { const report = await verifyWindowsSamplerWatchdog(parseWatchdogOptions(process.argv.slice(2))); console.log(JSON.stringify({ok:report.ok,mode:report.mode,report:path.join(report.output,'report.json'),cases:report.cases.length,parentDeathTested:report.parentDeathTested,stdoutStallTested:report.stdoutStallTested})); if (!report.ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
