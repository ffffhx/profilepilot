import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';
import { isCreationFileTime, runWindowsSampler } from './e2e/windows-sampler-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => ({ code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'SAMPLER_ACCEPTANCE_FAILED',
  ...(error?.causeCode ? { causeCode: error.causeCode } : {}), ...(error?.details ? { details: error.details } : {}) });
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
export function parseSamplerOptions(args) {
  let execution, rounds = 5, specified = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--check', '--run'].includes(arg) && execution === undefined) execution = arg;
    else if (arg === '--rounds' && !specified) { specified = true; const value = args[++index]; check(/^(?:[1-9]|10)$/.test(value), 'SAMPLER_INVALID_ROUNDS'); rounds = Number(value); }
    else throw Object.assign(new Error('Use [--check | --run] [--rounds 1..10].'), { code: 'SAMPLER_INVALID_OPTIONS' });
  }
  return { run: execution === '--run', rounds };
}
export function sampleOrder(round) { return round % 2 === 0 ? ['legacy', 'candidate'] : ['candidate', 'legacy']; }
export function verifyOwnSample(processes, tcp, fixture, candidate) {
  const own = processes.filter(row => row.pid === fixture.pid); check(own.length === 1, 'SAMPLER_OWN_PROCESS_MISSING');
  if (candidate) check(own[0].identityStatus === 'confirmed' && own[0].creationFileTime === fixture.creationFileTime, 'SAMPLER_OWN_BIRTH_MISMATCH');
  for (const [port, address] of [[fixture.ipv4Port, '127.0.0.1'], [fixture.ipv6Port, '::1']])
    check(tcp.some(row => row.pid === fixture.pid && row.localPort === port && row.localAddress === address && String(row.state).toLowerCase() === 'listen'), 'SAMPLER_OWN_LISTENER_MISSING');
  return { processCount: processes.length, tcpCount: tcp.length, ownPid: fixture.pid,
    ...(candidate ? { ownCreationFileTime: own[0].creationFileTime } : {}), ownIPv4: true, ownIPv6: true };
}
export function verifyOwnLocks(rows, fixture, file) {
  check(rows.some(row => row.path === file && row.pid === fixture.pid && row.creationFileTime === fixture.creationFileTime), 'SAMPLER_OWN_LOCK_BIRTH_MISMATCH');
  return { rowCount: rows.length, ownPid: fixture.pid, ownCreationFileTime: fixture.creationFileTime };
}
export async function settleSamplerReads(reads) {
  const settled = await Promise.allSettled(reads);
  const failed = settled.find(value => value.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(value => value.value);
}
async function poll(read, accept, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await pause(50);
  }
  throw Object.assign(new Error(code), { code });
}
function inspector(executable) { return args => JSON.parse(execFileSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 12000 })); }
function ownedReceipt(value, config, identity) {
  check(value?.nonce === config.nonce && value.pid === identity.pid && value.startedUtcTicks === identity.startedUtcTicks, 'SAMPLER_FIXTURE_IDENTITY_MISMATCH'); return value;
}
export async function retireSamplerProcess({ identity, executable, close, closed, inspect }) {
  const result = { ok: true };
  try { await close(); result.receipt = await closed(); check(result.receipt.reason === 'requested' && result.receipt.exitCode === 0, 'SAMPLER_NORMAL_EXIT_MISSING'); }
  catch (error) { result.ok = false; result.receiptError = safeError(error); }
  let exited = false;
  try {
    const exit = inspect(['--wait-owned-exit', String(identity.pid), identity.startedUtcTicks, '5000']); result.exit = exit;
    exited = exit?.ok === true && exit.originalExited === true;
    check(exited, 'SAMPLER_EXIT_UNCONFIRMED');
  } catch (error) { result.ok = false; result.exitError = safeError(error); }
  if (!exited) {
    result.ok = false;
    try { result.forced = inspect(['--cleanup-owned', String(identity.pid), identity.startedUtcTicks, executable, identity.sha256, String(identity.parentPid)]); }
    catch (error) { result.forceError = safeError(error); }
  }
  return result;
}

// This is the frozen pre-integration baseline, not current windows-platform.
// Its exact bytes/hash are retained separately; only the read-only paths below
// are exposed. Never resolve local imports to the current native candidate.
export function loadLegacySampler(source, segments, options = {}) {
  const ts = require('typescript'), child = require('node:child_process'), original = options.execute || promisify(child.execFile);
  const pending = new Set();
  const wrapped = (...args) => child.execFile(...args);
  wrapped[promisify.custom] = (...args) => {
    const began = performance.now(), binary = path.basename(String(args[0])).toLowerCase();
    const operation = binary === 'netstat' || binary === 'netstat.exe' ? 'netstat.' + args[1].at(-1)
      : String(args[1]?.at(-1) || '').includes('ProfilePilotRestartManager') ? 'powershell.rm' : 'powershell.process';
    const running = (async () => {
      let ok = false;
      try { const result = await original(...args); ok = true; return result; }
      finally { segments.push({ operation, elapsedMs: performance.now() - began, ok }); }
    })();
    pending.add(running); void running.then(() => pending.delete(running), () => pending.delete(running));
    return running;
  };
  const transformed = ts.transpileModule(source + '\nexport const __samplerBenchmarkTcp = readWindowsNetstat;\n', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  const allowed = new Set(['node:os', 'node:path', 'node:child_process', 'node:util', 'node:crypto']);
  vm.runInNewContext(transformed, { module, exports: module.exports, Buffer, process,
    require: name => { check(allowed.has(name), 'SAMPLER_LEGACY_IMPORT_FORBIDDEN'); return name === 'node:child_process' ? { ...child, execFile: wrapped } : require(name); }
  }, { filename: 'owned-legacy-windows-platform.cjs' });
  return { getWindowsSystemSnapshot: module.exports.getWindowsSystemSnapshot, findWindowsProcessesLockingPaths: module.exports.findWindowsProcessesLockingPaths,
    __samplerBenchmarkTcp: module.exports.__samplerBenchmarkTcp, __samplerBenchmarkSettle: () => Promise.allSettled([...pending]) };
}

async function mediumRun(configPath) {
  await assertDesktopAcceptanceWindow();
  const config = await json(configPath), inspect = inspector(config.identityExe), segments = [];
  check(config.root === root && /^[a-f0-9]{32}$/.test(config.nonce), 'SAMPLER_INVALID_CONFIG');
  const report = { ok: false, mode: 'medium-read-only', nonce: config.nonce, rounds: [], cleanup: {},
    scope: 'Own file lock and IPv4/IPv6 loopback listeners; process payloads are used only in memory.',
    coldDefinition: 'Every sampler/PowerShell is a fresh child process. First iteration is reported separately; OS caches, JIT dependencies and antivirus are not reset.',
    limitations: ['Sequential paired observations are not an atomic OS snapshot or a causally isolated benchmark.', 'The candidate adds precise process identities; legacy CIM timestamps are not compared as exact FILETIME.',
      'No App admission, UIA, desktop input or end-to-end observe performance is measured here.', 'One Windows Medium token; no macOS or cross-integrity coverage.'] };
  let fixture, fixtureIdentity;
  const save = () => writeFile(config.childReport, JSON.stringify(report, null, 2));
  const continueRun = async () => {
    try { if (await readFile(config.stop, 'utf8') === config.nonce) throw Object.assign(new Error('Stopped'), { code: 'SAMPLER_RUN_CANCELLED' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  try {
    for (const [file, digest] of Object.entries(config.artifacts)) check(hash(await readFile(file)) === digest, 'SAMPLER_ARTIFACT_CHANGED');
    report.runner = inspect(['--inspect', String(process.pid)]); assertOwnedIdentity(report.runner, { pid: process.pid, executable: process.execPath, sha256: config.nodeSha256 });
    await writeFile(config.runnerReady, JSON.stringify({ nonce: config.nonce, identity: report.runner }));
    await poll(async () => { await continueRun(); return readFile(config.go, 'utf8'); }, value => value === config.nonce, 30000, 'SAMPLER_RUNNER_ACK_MISSING');
    const legacy = loadLegacySampler(await readFile(config.baseline, 'utf8'), segments);
    fixture = spawn(config.fixtureExe, [config.state, config.nonce, config.file], { windowsHide: true, stdio: 'ignore' });
    report.fixtureSpawnAttempted = true;
    fixture.on('error', () => {});
    check(Number.isSafeInteger(fixture.pid), 'SAMPLER_FIXTURE_SPAWN_FAILED');
    const fixtureCandidate = inspect(['--inspect', String(fixture.pid)]);
    assertOwnedIdentity(fixtureCandidate, { pid: fixture.pid, executable: config.fixtureExe, sha256: config.artifacts[config.fixtureExe] });
    check(fixtureCandidate.parentPid === process.pid, 'SAMPLER_FIXTURE_PARENT_MISMATCH');
    fixtureIdentity = report.fixtureIdentity = fixtureCandidate;
    await writeFile(config.fixtureIdentityFile, JSON.stringify({ nonce: config.nonce, identity: fixtureIdentity }));
    const ready = report.fixture = await poll(() => json(config.state + '.ready.json'), value => { ownedReceipt(value, config, fixtureIdentity); return true; }, 10000, 'SAMPLER_FIXTURE_READY_MISSING');
    check(isCreationFileTime(ready.creationFileTime), 'SAMPLER_FIXTURE_BIRTH_INVALID');
    const birth = JSON.parse(execFileSync(config.fixtureExe, ['--birth', String(fixture.pid), ready.creationFileTime], { windowsHide: true, encoding: 'utf8', timeout: 5000 }));
    check(birth.ok && birth.pid === ready.pid && birth.creationFileTime === ready.creationFileTime, 'SAMPLER_OWN_BIRTH_MISMATCH'); report.pinnedBirth = birth;
    for (let round = 0; round < config.rounds; round++) {
      const entry = { index: round + 1, firstIteration: round === 0, order: sampleOrder(round), samples: [], locks: [] }; report.rounds.push(entry); await save();
      for (const variant of entry.order) {
        await continueRun();
        const sample = { variant }; entry.samples.push(sample); segments.length = 0; const began = performance.now();
        try {
          if (variant === 'legacy') {
            const value = await legacy.getWindowsSystemSnapshot(true);
            check(value.processesComplete === true && value.tcpComplete === true, 'SAMPLER_LEGACY_INCOMPLETE');
            Object.assign(sample, verifyOwnSample(value.processes, value.tcp, ready, false));
          } else {
            const [value, tcp] = await settleSamplerReads([runWindowsSampler({ executable: config.samplerExe, request: { version: 1, requestId: randomUUID(), operation: 'snapshot', params: {} } }), legacy.__samplerBenchmarkTcp()]);
            check(tcp?.complete === true, 'SAMPLER_TCP_INCOMPLETE');
            Object.assign(sample, verifyOwnSample(value.result.processes, tcp.connections, ready, true), { nativeTimings: value.result.timings, helperElapsedMs: value.elapsedMs, stdoutBytes: value.stdoutBytes });
          }
          sample.ok = true;
        } catch (error) { sample.ok = false; sample.error = safeError(error); throw error; }
        finally { await legacy.__samplerBenchmarkSettle(); sample.elapsedMs = performance.now() - began; sample.segments = segments.splice(0); await save(); }
      }
      for (const variant of entry.order) {
        await continueRun();
        const lock = { variant }; entry.locks.push(lock); segments.length = 0; const began = performance.now();
        try {
          if (variant === 'legacy') {
            const value = await legacy.findWindowsProcessesLockingPaths([config.file], { strict: true });
            check(value.get(config.file)?.includes(ready.pid), 'SAMPLER_LEGACY_OWN_LOCK_MISSING'); lock.ownPid = ready.pid; lock.rowCount = [...value.values()].reduce((count, rows) => count + rows.length, 0);
          } else {
            const value = await runWindowsSampler({ executable: config.samplerExe, request: { version: 1, requestId: randomUUID(), operation: 'fileLocks', params: { paths: [config.file] } } });
            Object.assign(lock, verifyOwnLocks(value.result.rows, ready, config.file), { nativeTimings: value.result.timings, stdoutBytes: value.stdoutBytes });
          }
          lock.ok = true;
        } catch (error) { lock.ok = false; lock.error = safeError(error); throw error; }
        finally { await legacy.__samplerBenchmarkSettle(); lock.elapsedMs = performance.now() - began; lock.segments = segments.splice(0); await save(); }
      }
      const still = inspect(['--inspect', String(ready.pid)]);
      assertOwnedIdentity(still, { pid: ready.pid, executable: config.fixtureExe, sha256: fixtureIdentity.sha256, original: fixtureIdentity });
    }
    for (const [file, digest] of Object.entries(config.artifacts)) check(hash(await readFile(file)) === digest, 'SAMPLER_ARTIFACT_CHANGED');
    report.ok = true;
  } catch (error) { report.error = safeError(error); }
  finally {
    if (fixtureIdentity) {
      report.cleanup.fixture = await retireSamplerProcess({ identity: fixtureIdentity, executable: config.fixtureExe, inspect,
        close: () => writeFile(config.state + '.close', config.nonce), closed: () => poll(() => json(config.state + '.closed.json'), value => { ownedReceipt(value, config, fixtureIdentity); return true; }, 7000, 'SAMPLER_FIXTURE_CLOSE_MISSING') });
      if (!report.cleanup.fixture.ok) report.ok = false;
    } else if (fixture) {
      report.ok = false; report.cleanup.fixtureIdentityMissing = true;
      // A nonce close request is safe even when exact identity inspection
      // failed. Never force-stop an unverified PID; lack of proof stays failed.
      try { await writeFile(config.state + '.close', config.nonce); report.cleanup.unverifiedFixtureCloseRequested = true; }
      catch (error) { report.cleanup.unverifiedFixtureCloseError = safeError(error); }
    }
    report.finished = true; await save();
    await writeFile(config.runnerClosed, JSON.stringify({ nonce: config.nonce, pid: process.pid, startedUtcTicks: report.runner?.startedUtcTicks, reason: 'requested', exitCode: report.ok ? 0 : 1 }));
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSamplerOptions(args); check(process.platform === 'win32', 'SAMPLER_WINDOWS_REQUIRED');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-windows-sampler-')), output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const nonce = randomBytes(16).toString('hex'), state = path.join(home, 'fixture');
  const config = { root, home, nonce, rounds: options.rounds, state, file: path.join(home, nonce + '.txt'), fixtureExe: path.join(home, 'SamplerFixture.exe'), identityExe: path.join(home, 'SamplerIdentity.exe'),
    baseline: path.join(home, 'windows-platform.ts'), childReport: path.join(output, 'medium-report.json'), runnerReady: path.join(home, 'runner-ready.json'), runnerClosed: path.join(home, 'runner-closed.json'), go: path.join(home, 'go'), stop: path.join(home, 'stop'), fixtureIdentityFile: path.join(home, 'fixture-identity.json') };
  const reportFile = path.join(output, 'report.json'), configPath = path.join(home, 'config.json');
  const report = { ok: false, mode: options.run ? 'read-only-medium-benchmark' : 'compile-only', startedAt: new Date().toISOString(), fixtureStarted: false, output, cleanup: {} };
  let runner, runnerIdentity, heartbeat;
  const inspect = inspector(config.identityExe);
  try {
    const built = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/build-windows-sampler.mjs'), '--check'], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
    check(built.ok === true, 'SAMPLER_BUILD_FAILED'); report.samplerBuild = built; config.samplerExe = built.executable;
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const sources = ['scripts/e2e/windows-sampler-fixture.cs', 'scripts/e2e/desktop-observer-fault-identity.cs'];
    const compile = (destination, source, refs) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/warnaserror+', '/target:exe', '/out:' + destination,
      ...refs.map(value => '/r:' + value), path.join(root, source)], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    compile(config.fixtureExe, sources[0], ['System.Web.Extensions.dll']); compile(config.identityExe, sources[1], ['System.Management.dll', 'System.Web.Extensions.dll']);
    const baselineFile = path.join(root, 'scripts/e2e/windows-sampler-legacy-platform.ts');
    const baselineSource = await readFile(baselineFile, 'utf8'), baselineMetadata = await json(path.join(root, 'scripts/e2e/windows-sampler-legacy-platform.json'));
    check(baselineMetadata.format === 1 && hash(baselineSource) === baselineMetadata.sha256, 'SAMPLER_LEGACY_HASH_MISMATCH');
    await writeFile(config.baseline, baselineSource); loadLegacySampler(baselineSource, []);
    report.baseline = baselineMetadata; report.baselineSourceSha256 = hash(baselineSource); report.fixtureSources = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(path.join(root, file)))])));
    config.nodeSha256 = hash(await readFile(process.execPath));
    config.artifacts = Object.fromEntries(await Promise.all([config.fixtureExe, config.identityExe, config.samplerExe, config.baseline, fileURLToPath(import.meta.url), path.join(root, 'scripts/e2e/windows-sampler-protocol.mjs')].map(async file => [file, hash(await readFile(file))])));
    report.artifacts = config.artifacts; await writeFile(configPath, JSON.stringify(config));
    if (!options.run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    await writeFile(config.file, 'Owned sampler fixture ' + nonce, { flag: 'wx' }); await writeFile(state + '.heartbeat', nonce, { flag: 'wx' });
    heartbeat = setInterval(() => { const now = new Date(); void utimes(state + '.heartbeat', now, now).catch(() => { report.cleanup.heartbeatFailed = true; }); }, 2000);
    runner = await launchWindowsUserProcess(process.execPath, [fileURLToPath(import.meta.url), '--medium-run', configPath], root);
    const runnerCandidate = inspect(['--inspect', String(runner.pid)]);
    assertOwnedIdentity(runnerCandidate, { pid: runner.pid, executable: process.execPath, sha256: config.nodeSha256 });
    await poll(() => json(config.runnerReady), value => { check(value.nonce === nonce, 'SAMPLER_RUNNER_NONCE_MISMATCH'); assertOwnedIdentity(value.identity, { pid: runner.pid, executable: process.execPath, sha256: config.nodeSha256, original: runnerCandidate }); return true; }, 15000, 'SAMPLER_RUNNER_READY_MISSING');
    runnerIdentity = report.runnerIdentity = runnerCandidate;
    await writeFile(config.go, nonce); report.fixtureStartAuthorized = true;
    report.measurement = await poll(() => json(config.childReport), value => { check(value.nonce === nonce, 'SAMPLER_RUNNER_NONCE_MISMATCH'); return value.finished === true; }, 240000, 'SAMPLER_BENCHMARK_TIMEOUT');
    report.fixtureStarted = report.measurement.fixtureSpawnAttempted === true;
    report.ok = report.measurement.ok === true;
  } catch (error) { report.error = safeError(error); }
  finally {
    if (runnerIdentity) {
      report.cleanup.runner = await retireSamplerProcess({ identity: runnerIdentity, executable: process.execPath, inspect, close: () => writeFile(config.stop, nonce),
        closed: () => poll(() => json(config.runnerClosed), value => { check(value.nonce === nonce && value.pid === runnerIdentity.pid && value.startedUtcTicks === runnerIdentity.startedUtcTicks, 'SAMPLER_RUNNER_CLOSE_IDENTITY'); return true; }, 45000, 'SAMPLER_RUNNER_CLOSE_MISSING') });
      if (!report.cleanup.runner.ok) report.ok = false;
    } else if (runner) {
      report.ok = false; report.cleanup.runnerIdentityUnconfirmed = true;
      try { await writeFile(config.stop, nonce); report.cleanup.unverifiedRunnerStopRequested = true; }
      catch (error) { report.cleanup.unverifiedRunnerStopError = safeError(error); }
    }
    // Independent parent cleanup still runs if the Medium runner failed before
    // its own finally. Identity is the exact captured owned process, never a scan.
    try {
      if (report.fixtureStartAuthorized) await writeFile(state + '.close', nonce);
      const value = await json(config.fixtureIdentityFile); check(value.nonce === nonce, 'SAMPLER_FIXTURE_IDENTITY_MISMATCH'); const identity = value.identity;
      assertOwnedIdentity(identity, { pid: identity.pid, executable: config.fixtureExe, sha256: config.artifacts[config.fixtureExe] });
      report.fixtureStarted = true;
      report.cleanup.fixture = await retireSamplerProcess({ identity, executable: config.fixtureExe, inspect, close: () => writeFile(state + '.close', nonce),
        closed: () => poll(() => json(state + '.closed.json'), value => { ownedReceipt(value, config, identity); return true; }, 7000, 'SAMPLER_FIXTURE_CLOSE_MISSING') });
      if (!report.cleanup.fixture.ok) report.ok = false;
    } catch (error) { if (error.code !== 'ENOENT' || report.measurement?.fixtureSpawnAttempted) { report.cleanup.fixtureError = safeError(error); report.ok = false; } }
    if (heartbeat) clearInterval(heartbeat); if (report.cleanup.heartbeatFailed) report.ok = false;
    report.finishedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: reportFile, fixtureStarted: report.fixtureStarted }));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] === '--medium-run' && process.argv.length === 4 ? mediumRun(process.argv[3]) : main();
  try { const result = await action; if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; }
}
