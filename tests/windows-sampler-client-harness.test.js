const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsSamplerClient } = loadCli('src/main/windows-sampler.ts');
const harness = import('../scripts/verify-windows-sampler-client.mjs');
const cases = import('../scripts/e2e/windows-sampler-client-cases.mjs');
const digest = 'a'.repeat(64), ownPid = 777;
const runtime = path.join(os.tmpdir(), 'profilepilot-windows-sampler-runtime');
const executable = path.join(runtime, digest + '.exe');
const snapshot = () => ({ complete: true, processes: [{ pid: ownPid, parentPid: 1, name: 'owned.exe', executablePath: 'C:\\owned.exe',
  commandLine: 'never retain this payload', commandLineAvailable: true, startedAt: null, identityStatus: 'confirmed', creationFileTime: '134273376000000007' }],
  timings: { totalMs: 1, enumerateMs: 0, pinMs: 0, cimMs: 1 } });
async function setup(options = {}) {
  const { createSamplerLifecycleRecorder } = await cases; const children = [];
  const recorder = createSamplerLifecycleRecorder({ expectedHelperHash: digest, runtimeDirectory: runtime, readHash: () => digest,
    changed: options.changed, spawnProcess() {
      const index = children.length;
      const child = Object.assign(new EventEmitter(), { pid: 1000 + index, stdin: new EventEmitter(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
      child.kill = () => { child.killed = true; queueMicrotask(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); return true; };
      child.stdin.end = bytes => {
        const request = JSON.parse(bytes);
        queueMicrotask(() => {
          if (!(options.noFinish && index === 1)) child.stdin.emit('finish');
          child.emit('spawn');
          if (index === 3 && !options.earlyDeadlineSuccess || options.noFinish && index === 1) return;
          setImmediate(() => {
            if (child.killed) return;
            child.stdout.emit('data', Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, operation: request.operation, ok: true, result: snapshot() }) + '\n'));
            child.emit('exit', 0, null); child.emit('close', 0, null);
          });
        });
      };
      children.push(child); return child;
    } });
  class Client extends WindowsSamplerClient {
    constructor(clientOptions) { super({ ...clientOptions, platform: 'win32', prepareExecutable: () => executable, ...(options.noFinish ? { timeoutMs: 30 } : {}) }); }
  }
  return { Client, recorder, children };
}

test('production client harness defaults to compile-only and bounded explicit deadline', async () => {
  const { parseSamplerClientOptions } = await harness;
  assert.deepEqual(parseSamplerClientOptions([]), { run: false, deadlineMs: 75 });
  assert.deepEqual(parseSamplerClientOptions(['--run', '--deadline-ms', '100']), { run: true, deadlineMs: 100 });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--deadline-ms'], ['--deadline-ms', '19'], ['--deadline-ms', '251'], ['--deadline-ms', '20.5'], ['--capture']])
    assert.throws(() => parseSamplerClientOptions(args));
});
test('build validation binds real dist client, protocol, runtime and native helper to one manifest', async () => {
  const { verifySamplerClientBuild, samplerClientComponents } = await harness;
  const root = path.resolve('owned-build'), bodies = new Map(samplerClientComponents.map(file => [file, Buffer.from(file)]));
  const entries = Object.fromEntries([...bodies].map(([file, bytes]) => [file, createHash('sha256').update(bytes).digest('hex')]));
  const manifest = { version: 1, buildId: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), builtAt: 'owned', components: entries };
  const read = async file => path.basename(file) === 'control-build.json' ? JSON.stringify(manifest) : bodies.get(path.relative(root, file).replaceAll('\\', '/'));
  assert.equal((await verifySamplerClientBuild(root, read)).buildId, manifest.buildId);
  bodies.set(samplerClientComponents[0], Buffer.from('changed')); await assert.rejects(verifySamplerClientBuild(root, read), { code: 'SAMPLER_CLIENT_BUILD_MISMATCH' });
  await assert.rejects(verifySamplerClientBuild(root, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), { code: 'SAMPLER_CLIENT_BUILD_REQUIRED' });
});
test('case runner uses production lifecycle with fake OS transport and keeps only own summary', async () => {
  const { runSamplerClientCases } = await cases, fixture = await setup();
  const report = await runSamplerClientCases({ ...fixture, ownPid, deadlineMs: 20 });
  assert.equal(report.ok, true); assert.equal(report.cases.length, 4); assert.equal(report.children.length, 5);
  assert.equal(report.cleanup.allChildrenClosed, true); assert.equal(report.cleanup.forced, undefined);
  assert.equal(JSON.stringify(report).includes('never retain this payload'), false); assert.equal(JSON.stringify(report).includes('commandLine'), false);
  const aborted = report.children[1], successor = report.children[2];
  assert.ok(aborted.stdinEndedAt !== undefined && aborted.stdinFinishedAt !== undefined && aborted.spawnedAt !== undefined);
  assert.ok(aborted.closeSequence < successor.spawnSequence); assert.equal(report.cases[3].queued.error.code, 'WINDOWS_SAMPLER_CLOSED');
});
test('a completed read before the short deadline is failure, never a silently retried timeout case', async () => {
  const { runSamplerClientCases } = await cases, fixture = await setup({ earlyDeadlineSuccess: true });
  const report = await runSamplerClientCases({ ...fixture, ownPid, deadlineMs: 75 });
  assert.equal(report.ok, false); assert.equal(report.cases.length, 3); assert.equal(report.cases[2].ok, false);
  assert.equal(report.error.code, 'SAMPLER_LIFECYCLE_EXPECTED_WINDOWS_SAMPLER_TIMEOUT'); assert.equal(report.children.length, 4); assert.equal(report.cleanup.allChildrenClosed, true);
});
test('spawn alone without completed request pipe cannot pass the abort case', async () => {
  const { runSamplerClientCases } = await cases, fixture = await setup({ noFinish: true });
  const report = await runSamplerClientCases({ ...fixture, ownPid, deadlineMs: 20 });
  assert.equal(report.ok, false); assert.equal(report.cases.length, 2); assert.equal(report.cases[1].abortRequestedAt, undefined);
  assert.equal(report.children[1].stdinFinishedAt, undefined); assert.ok(report.children[1].spawnedAt !== undefined); assert.equal(report.cleanup.allChildrenClosed, true);
});
test('recorder refuses a replacement after exit but before close and retains overlap attempt evidence', async () => {
  const fixture = await setup(), options = { windowsHide: true, stdio: 'pipe' };
  const child = fixture.recorder.spawnProcess(executable, [], options); child.emit('exit', 0, null);
  assert.throws(() => fixture.recorder.spawnProcess(executable, [], options), { code: 'SAMPLER_LIFECYCLE_OVERLAP' });
  assert.equal(fixture.children.length, 1); assert.equal(fixture.recorder.events.at(-1).kind, 'overlap-attempt');
  child.emit('close', 0, null); assert.equal(fixture.recorder.allClosed(), true);
});
test('event reporting failure is retained and fails acceptance without throwing from child events', async () => {
  const { runSamplerClientCases } = await cases, fixture = await setup({ changed() { throw Object.assign(new Error('disk failed'), { code: 'OWN_REPORT_FAILED' }); } });
  const report = await runSamplerClientCases({ ...fixture, ownPid, deadlineMs: 20 });
  assert.equal(report.ok, false); assert.ok(report.cleanup.notificationErrors.length > 0); assert.equal(report.cleanup.allChildrenClosed, true);
});
test('snapshot summary requires an exact owned row and drops all other process details', async () => {
  const { summarizeSamplerSnapshot, ownedCreationFileTimeFromTicks } = await cases;
  assert.equal(summarizeSamplerSnapshot(snapshot(), ownPid).ownPid, ownPid);
  const expected = snapshot().processes[0].creationFileTime;
  assert.equal(ownedCreationFileTimeFromTicks((BigInt(expected) + 504911232000000000n).toString()), expected);
  assert.equal(summarizeSamplerSnapshot(snapshot(), ownPid, expected).ownCreationFileTime, expected);
  assert.throws(() => summarizeSamplerSnapshot(snapshot(), ownPid, (BigInt(expected) + 1n).toString()), { code: 'SAMPLER_LIFECYCLE_OWN_BIRTH_MISMATCH' });
  for (const ticks of [Number(expected), '0', '504911232000000000', 'invalid']) assert.throws(() => ownedCreationFileTimeFromTicks(ticks));
  assert.throws(() => summarizeSamplerSnapshot(snapshot(), 999), { code: 'SAMPLER_LIFECYCLE_OWN_IDENTITY_MISSING' });
  const hidden = snapshot(); hidden.processes[0].identityStatus = 'unavailable';
  assert.throws(() => summarizeSamplerSnapshot(hidden, ownPid), { code: 'SAMPLER_LIFECYCLE_OWN_IDENTITY_MISSING' });
});
test('fallback cleanup of an unclosed owned child always fails acceptance even when kill confirms close', async () => {
  const { runSamplerClientCases } = await cases, fixture = await setup();
  class IncompleteClient {
    sampleWindowsProcesses() { fixture.recorder.spawnProcess(executable, [], { windowsHide: true, stdio: 'pipe' }); return Promise.resolve(snapshot()); }
    close() { return Promise.resolve(); }
  }
  const report = await runSamplerClientCases({ Client: IncompleteClient, recorder: fixture.recorder, ownPid, cleanupTimeoutMs: 0 });
  assert.equal(report.ok, false); assert.equal(report.cleanup.forced, true); assert.equal(report.cleanup.allChildrenClosed, true); assert.equal(report.children[0].forced, true);
});
