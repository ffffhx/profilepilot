const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const harness = import('../scripts/verify-windows-sampler.mjs');
const fixture = { pid: 456, creationFileTime: '134273376000000007', ipv4Port: 22345, ipv6Port: 22346 };
const own = { pid: fixture.pid, identityStatus: 'confirmed', creationFileTime: fixture.creationFileTime };
const tcp = [
  { pid: fixture.pid, localPort: fixture.ipv4Port, localAddress: '127.0.0.1', state: 'LISTEN' },
  { pid: fixture.pid, localPort: fixture.ipv6Port, localAddress: '::1', state: 'listen' }
];
const identity = { pid: 456, startedUtcTicks: '639289200000000001', sha256: 'a'.repeat(64), parentPid: 123 };
const normal = { reason: 'requested', exitCode: 0 };

test('sampler harness defaults to compilation and accepts only bounded explicit run options', async () => {
  const { parseSamplerOptions, sampleOrder } = await harness;
  assert.deepEqual(parseSamplerOptions([]), { run: false, rounds: 5 });
  assert.deepEqual(parseSamplerOptions(['--check']), { run: false, rounds: 5 });
  assert.deepEqual(parseSamplerOptions(['--run', '--rounds', '10']), { run: true, rounds: 10 });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--rounds'], ['--rounds', '0'], ['--rounds', '11'], ['--rounds', '1.5'], ['--rounds', '2', '--rounds', '3'], ['--capture']])
    assert.throws(() => parseSamplerOptions(args));
  assert.deepEqual(sampleOrder(0), ['legacy', 'candidate']); assert.deepEqual(sampleOrder(1), ['candidate', 'legacy']);
});
test('both variants must contain the own PID and exact IPv4 and IPv6 listeners', async () => {
  const { verifyOwnSample } = await harness;
  for (const candidate of [false, true]) {
    assert.equal(verifyOwnSample([own], tcp, fixture, candidate).ownIPv6, true);
    for (const processes of [[], [own, own], [{ ...own, pid: 999 }]])
      assert.throws(() => verifyOwnSample(processes, tcp, fixture, candidate), { code: 'SAMPLER_OWN_PROCESS_MISSING' });
    for (const rows of [tcp.slice(0, 1), tcp.slice(1), [tcp[0], { ...tcp[1], pid: 999 }],
      [tcp[0], { ...tcp[1], localAddress: '::' }], [tcp[0], { ...tcp[1], state: 'established' }], [tcp[0], { ...tcp[1], localPort: 1 }]])
      assert.throws(() => verifyOwnSample([own], rows, fixture, candidate), { code: 'SAMPLER_OWN_LISTENER_MISSING' });
  }
});
test('candidate exact birth is checked without expecting legacy CIM milliseconds to equal FILETIME', async () => {
  const { verifyOwnSample } = await harness;
  assert.doesNotThrow(() => verifyOwnSample([{ pid: fixture.pid, startedAt: '2026-10-30T00:00:00.000Z' }], tcp, fixture, false));
  for (const patch of [{ creationFileTime: '134273376000000008' }, { creationFileTime: null, identityStatus: 'unavailable' }, { creationFileTime: Number(fixture.creationFileTime) }])
    assert.throws(() => verifyOwnSample([{ ...own, ...patch }], tcp, fixture, true), { code: 'SAMPLER_OWN_BIRTH_MISMATCH' });
});
test('own RM evidence needs the exact request path and exact process birth', async () => {
  const { verifyOwnLocks } = await harness; const file = 'C:\\owned\\nonce.txt';
  const row = { path: file, pid: fixture.pid, creationFileTime: fixture.creationFileTime };
  assert.equal(verifyOwnLocks([row], fixture, file).rowCount, 1);
  for (const rows of [[], [{ ...row, path: 'C:\\other.txt' }], [{ ...row, pid: 999 }], [{ ...row, creationFileTime: '134273376000000008' }]])
    assert.throws(() => verifyOwnLocks(rows, fixture, file), { code: 'SAMPLER_OWN_LOCK_BIRTH_MISMATCH' });
});
test('measurements export counts and owned identity, never process payload or other paths', async () => {
  const { verifyOwnSample, verifyOwnLocks } = await harness;
  const rows = [{ ...own, commandLine: 'private user command', executablePath: 'C:\\private-user-app.exe' }, { pid: 999, commandLine: 'another private command' }];
  const output = JSON.stringify({ sample: verifyOwnSample(rows, tcp, fixture, true), locks: verifyOwnLocks([{ ...own, path: 'C:\\owned\\nonce.txt' }], fixture, 'C:\\owned\\nonce.txt') });
  assert.equal(output.includes('private'), false); assert.equal(output.includes('commandLine'), false); assert.equal(output.includes('path'), false);
});
test('a failed paired read waits for its companion before allowing cleanup', async () => {
  const { settleSamplerReads } = await harness;
  let finish, finished = false;
  const other = new Promise(resolve => { finish = resolve; });
  const failure = Object.assign(new Error('safe'), { code: 'OWN_READ_FAILED' });
  const paired = settleSamplerReads([Promise.reject(failure), other]).finally(() => { finished = true; });
  const rejected = assert.rejects(paired, { code: 'OWN_READ_FAILED' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  finish('tcp settled'); await rejected; assert.equal(finished, true);
  assert.deepEqual(await settleSamplerReads([Promise.resolve('snapshot'), Promise.resolve('tcp')]), ['snapshot', 'tcp']);
});
test('cleanup confirms normal receipt and original process exit without force', async () => {
  const { retireSamplerProcess } = await harness; const calls = [];
  const result = await retireSamplerProcess({ identity, executable: 'C:\\owned.exe', close: async () => calls.push('close'), closed: async () => normal,
    inspect: args => { calls.push(args); return { ok: true, originalExited: true, replacementUntouched: true }; } });
  assert.equal(result.ok, true); assert.equal(result.forced, undefined);
  assert.deepEqual(calls, ['close', ['--wait-owned-exit', '456', identity.startedUtcTicks, '5000']]);
});
test('missing receipt still verifies exit and cannot pass as successful cleanup', async () => {
  const { retireSamplerProcess } = await harness; const calls = [];
  const result = await retireSamplerProcess({ identity, executable: 'C:\\owned.exe', close: async () => {}, closed: async () => { throw Object.assign(new Error('private'), { code: 'OWN_RECEIPT_MISSING' }); },
    inspect: args => { calls.push(args); return { ok: true, originalExited: true }; } });
  assert.equal(result.ok, false); assert.equal(result.receiptError.code, 'OWN_RECEIPT_MISSING'); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('force cleanup is exact-identity bounded and always fails the benchmark even if it succeeds', async () => {
  const { retireSamplerProcess } = await harness; const calls = [];
  const result = await retireSamplerProcess({ identity, executable: 'C:\\owned.exe', close: async () => {}, closed: async () => normal,
    inspect: args => { calls.push(args); return args[0] === '--wait-owned-exit' ? { ok: true, originalExited: false, timedOut: true } : { ok: true, originalExited: true, forced: true }; } });
  assert.equal(result.ok, false); assert.equal(result.forced.forced, true);
  assert.deepEqual(calls[1], ['--cleanup-owned', '456', identity.startedUtcTicks, 'C:\\owned.exe', identity.sha256, '123']);
});
test('close and exit-query failures do not skip independent exact-identity cleanup', async () => {
  const { retireSamplerProcess } = await harness; const calls = [];
  const result = await retireSamplerProcess({ identity, executable: 'C:\\owned.exe', close: async () => { throw new Error('close failure'); }, closed: async () => normal,
    inspect: args => { calls.push(args); if (args[0] === '--wait-owned-exit') throw Object.assign(new Error('wait failure'), { code: 'OWN_WAIT_FAILED' }); return { ok: true, originalExited: true, forced: true }; } });
  assert.equal(result.ok, false); assert.equal(result.exitError.code, 'OWN_WAIT_FAILED'); assert.equal(calls.length, 2);
});
test('legacy module loading is isolated and compile-only invokes no OS read', async () => {
  const { loadLegacySampler } = await harness; const segments = [];
  const source = 'let calls=0; async function readWindowsNetstat(){calls++; return {complete:true,connections:[]};} export function getWindowsSystemSnapshot(){return calls;} export function unsafeExtra(){throw Error("forbidden");}';
  const isolated = loadLegacySampler(source, segments); assert.equal(isolated.getWindowsSystemSnapshot(), 0);
  await isolated.__samplerBenchmarkSettle(); assert.equal(isolated.getWindowsSystemSnapshot(), 0); assert.deepEqual(segments, []);
  await isolated.__samplerBenchmarkTcp(); assert.equal(isolated.getWindowsSystemSnapshot(), 1); assert.deepEqual(segments, []); assert.equal(isolated.unsafeExtra, undefined);
  // Loading the frozen historical TypeScript is still not a process query.
  const actual = loadLegacySampler(await fs.readFile(path.join(__dirname, '../scripts/e2e/windows-sampler-legacy-platform.ts'), 'utf8'), segments);
  assert.equal(typeof actual.getWindowsSystemSnapshot, 'function'); assert.equal(typeof actual.findWindowsProcessesLockingPaths, 'function');
  await actual.__samplerBenchmarkSettle(); assert.deepEqual(segments, []);
});
test('frozen legacy baseline really calls PowerShell process/RM and dual-family netstat with zero candidate calls', async () => {
  const { loadLegacySampler } = await harness, segments = [], calls = []; let candidateCalls = 0;
  const source = await fs.readFile(path.join(__dirname, '../scripts/e2e/windows-sampler-legacy-platform.ts'), 'utf8');
  const metadata = JSON.parse(await fs.readFile(path.join(__dirname, '../scripts/e2e/windows-sampler-legacy-platform.json'), 'utf8'));
  assert.equal(createHash('sha256').update(source).digest('hex'), metadata.sha256);
  const file = 'C:\\owned\\nonce.txt';
  const legacy = loadLegacySampler(source, segments, { execute: async (binary, args) => {
    if (/WindowsSampler/i.test(binary)) { candidateCalls++; throw Error('Candidate forbidden'); }
    if (path.basename(binary).toLowerCase() === 'netstat') {
      const family = args.at(-1); calls.push('netstat.' + family);
      return { stdout: 'Active Connections\n  Proto  Local Address  Foreign Address  State  PID\n' + (family === 'tcp'
        ? '  TCP  127.0.0.1:22345  0.0.0.0:0  LISTENING  456\n' : '  TCP  [::1]:22346  [::]:0  LISTENING  456\n'), stderr: '' };
    }
    assert.equal(path.basename(binary).toLowerCase(), 'powershell.exe'); assert.match(args.at(-1), /Add-Type/);
    if (args.at(-1).includes('ProfilePilotRestartManager')) {
      calls.push('powershell.rm'); return { stdout: JSON.stringify([{ path: file, pid: fixture.pid }]), stderr: '' };
    }
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/); calls.push('powershell.process');
    return { stdout: JSON.stringify({ processes: [{ pid: fixture.pid, parentPid: 123, name: 'owned.exe', executablePath: 'C:\\owned.exe', commandLine: 'owned.exe', commandLineAvailable: true, startedAt: null }] }), stderr: '' };
  } });
  const sample = await legacy.getWindowsSystemSnapshot(true); assert.equal(sample.processesComplete, true); assert.equal(sample.tcpComplete, true);
  assert.equal(sample.processes[0].pid, fixture.pid); assert.equal(sample.tcp.length, 2);
  assert.deepEqual(Array.from((await legacy.findWindowsProcessesLockingPaths([file], { strict: true })).get(file)), [fixture.pid]);
  assert.deepEqual(calls.sort(), ['netstat.tcp', 'netstat.tcpv6', 'powershell.process', 'powershell.rm']); assert.equal(candidateCalls, 0);
  assert.equal(segments.length, 4); assert.equal(legacy.collectWindowsControlSample, undefined);
  assert.throws(() => loadLegacySampler('import "./windows-sampler"; function readWindowsNetstat(){}', []), { code: 'SAMPLER_LEGACY_IMPORT_FORBIDDEN' });
});
