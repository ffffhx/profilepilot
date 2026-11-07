import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from './verify-desktop-observer-startup.mjs';
import { retireSamplerProcess } from './verify-windows-sampler.mjs';
import { createSamplerLifecycleRecorder, runSamplerClientCases, lifecycleError, ownedCreationFileTimeFromTicks } from './e2e/windows-sampler-client-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
export const samplerClientComponents = ['dist/main/windows-sampler.js', 'dist/main/windows-sampler-protocol.js',
  'dist/main/native-runtime.js', 'dist/native/ProfilePilot.WindowsSampler.exe'];
export function parseSamplerClientOptions(args) {
  let mode, deadlineMs = 75, deadlineSpecified = false;
  for (let index = 0; index < args.length; index++) {
    if (['--run', '--check'].includes(args[index]) && mode === undefined) mode = args[index];
    else if (args[index] === '--deadline-ms' && !deadlineSpecified) {
      deadlineSpecified = true; const value = args[++index]; check(/^\d{1,3}$/.test(value || ''), 'SAMPLER_CLIENT_INVALID_OPTIONS');
      deadlineMs = Number(value); check(deadlineMs >= 20 && deadlineMs <= 250, 'SAMPLER_CLIENT_INVALID_OPTIONS');
    } else throw Object.assign(new Error('Use [--check | --run] [--deadline-ms 20..250].'), { code: 'SAMPLER_CLIENT_INVALID_OPTIONS' });
  }
  return { run: mode === '--run', deadlineMs };
}
export async function verifySamplerClientBuild(projectRoot, read = readFile) {
  const manifestFile = path.join(projectRoot, 'dist/main/control-build.json');
  const required = async (file, encoding) => {
    try { return await read(file, encoding); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('A complete ProfilePilot build is required before this acceptance check.'), { code: 'SAMPLER_CLIENT_BUILD_REQUIRED' }); throw error; }
  };
  const manifest = JSON.parse(await required(manifestFile, 'utf8'));
  check(manifest.version === 1 && /^[a-f0-9]{64}$/.test(manifest.buildId) && manifest.components && hash(JSON.stringify(manifest.components)) === manifest.buildId, 'SAMPLER_CLIENT_BUILD_INVALID');
  const components = {};
  for (const component of samplerClientComponents) {
    const digest = hash(await required(path.join(projectRoot, component)));
    check(digest === manifest.components[component], 'SAMPLER_CLIENT_BUILD_MISMATCH'); components[component] = digest;
  }
  return { buildId: manifest.buildId, builtAt: manifest.builtAt, components };
}
async function poll(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await pause(25);
  }
  throw Object.assign(new Error(code), { code });
}
const inspector = executable => args => JSON.parse(execFileSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 12000 }));
async function verifyArtifacts(artifacts) { for (const [file, digest] of Object.entries(artifacts)) check(hash(await readFile(file)) === digest, 'SAMPLER_CLIENT_ARTIFACT_CHANGED'); }

async function mediumRun(configPath) {
  await assertDesktopAcceptanceWindow();
  const config = await json(configPath); check(config.root === root && /^[a-f0-9]{32}$/.test(config.nonce), 'SAMPLER_CLIENT_INVALID_CONFIG');
  const inspect = inspector(config.identityExe), report = { ok: false, mode: 'production-client-medium', nonce: config.nonce, build: config.build, cleanup: {} };
  let recorder;
  const save = () => writeFileSync(config.childReport, JSON.stringify(report, null, 2));
  const stopped = () => existsSync(config.stop);
  try {
    await verifyArtifacts(config.artifacts);
    report.runnerIdentity = inspect(['--inspect', String(process.pid)]);
    assertOwnedIdentity(report.runnerIdentity, { pid: process.pid, executable: process.execPath, sha256: config.nodeSha256 });
    await writeFile(config.ready, JSON.stringify({ nonce: config.nonce, identity: report.runnerIdentity }));
    await poll(async () => { check(!stopped(), 'SAMPLER_CLIENT_STOPPED'); return readFile(config.go, 'utf8'); }, value => value === config.nonce, 30000, 'SAMPLER_CLIENT_ACK_MISSING');
    // Load actual built production modules at their ordinary dist path. The
    // production executable resolver and content-addressed copy are untouched.
    const { WindowsSamplerClient, windowsSamplerExecutable } = require(path.join(root, 'dist/main/windows-sampler.js'));
    const bundled = path.join(root, 'dist/native/ProfilePilot.WindowsSampler.exe');
    check(path.resolve(windowsSamplerExecutable()).toLowerCase() === path.resolve(bundled).toLowerCase(), 'SAMPLER_CLIENT_SOURCE_PATH');
    report.defaultBundledExecutable = bundled;
    recorder = createSamplerLifecycleRecorder({ expectedHelperHash: config.build.components['dist/native/ProfilePilot.WindowsSampler.exe'], changed: () => save() });
    report.children = recorder.records; report.events = recorder.events;
    report.ownCreationFileTime = ownedCreationFileTimeFromTicks(report.runnerIdentity.startedUtcTicks);
    report.suite = await runSamplerClientCases({ Client: WindowsSamplerClient, recorder, ownPid: process.pid, ownCreationFileTime: report.ownCreationFileTime, deadlineMs: config.deadlineMs,
      shouldStop: stopped, changed: suite => { report.suite = suite; save(); } });
    report.ok = report.suite.ok;
    await verifyArtifacts(config.artifacts);
  } catch (error) { report.ok = false; report.error = lifecycleError(error); }
  finally {
    // Every suite path closes its production clients. If setup failed after a
    // spawn, independently account for the exact returned ChildProcesses too.
    if (recorder) {
      report.cleanup.allChildrenClosed = await recorder.awaitClosed(10000);
      if (!report.cleanup.allChildrenClosed) { report.ok = false; report.cleanup.forced = true; recorder.forceOwnChildren(); report.cleanup.allChildrenClosed = await recorder.awaitClosed(5000); }
      if (recorder.records.some(record => record.forced)) report.ok = false;
    }
    report.finished = true; save();
    await writeFile(config.closed, JSON.stringify({ nonce: config.nonce, pid: process.pid, startedUtcTicks: report.runnerIdentity?.startedUtcTicks,
      reason: 'requested', exitCode: report.ok ? 0 : 1 }));
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSamplerClientOptions(args); check(process.platform === 'win32', 'SAMPLER_CLIENT_WINDOWS_REQUIRED');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-sampler-client-')), output = path.join(root, '.tools/desktop-verification', path.basename(home));
  await mkdir(output, { recursive: true });
  const config = { root, nonce: randomBytes(16).toString('hex'), deadlineMs: options.deadlineMs, identityExe: path.join(home, 'SamplerClientIdentity.exe'),
    ready: path.join(home, 'ready.json'), closed: path.join(home, 'closed.json'), go: path.join(home, 'go'), stop: path.join(home, 'stop'), childReport: path.join(output, 'medium-report.json') };
  const report = { ok: false, mode: options.run ? 'production-client-medium-lifecycle' : 'compile-only', startedAt: new Date().toISOString(), childStarted: false, output, cleanup: {} };
  const reportFile = path.join(output, 'report.json'), configPath = path.join(home, 'config.json');
  let runner, identity; const inspect = inspector(config.identityExe);
  try {
    config.build = report.build = await verifySamplerClientBuild(root);
    // Import the already-built production module without invoking its lazy
    // query functions. Never compile a newer native candidate for this suite.
    const builtClient = require(path.join(root, 'dist/main/windows-sampler.js'));
    check(typeof builtClient.WindowsSamplerClient === 'function' && typeof builtClient.sampleWindowsProcesses === 'function'
      && typeof builtClient.sampleWindowsFileLocks === 'function' && typeof builtClient.closeWindowsSampler === 'function', 'SAMPLER_CLIENT_EXPORTS_MISSING');
    report.productionModuleLoaded = true; report.parentQueryStarted = false;
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const identitySource = path.join(root, 'scripts/e2e/desktop-observer-fault-identity.cs');
    execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/warnaserror+', '/target:exe', '/out:' + config.identityExe,
      '/r:System.Management.dll', '/r:System.Web.Extensions.dll', identitySource], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    report.identitySourceSha256 = hash(await readFile(identitySource));
    if (!options.run) { report.ok = true; return report; }
    await assertDesktopAcceptanceWindow();
    check((await verifySamplerClientBuild(root)).buildId === config.build.buildId, 'SAMPLER_CLIENT_BUILD_CHANGED');
    config.nodeSha256 = hash(await readFile(process.execPath));
    const files = [fileURLToPath(import.meta.url), path.join(root, 'scripts/e2e/windows-sampler-client-cases.mjs'), config.identityExe,
      path.join(root, 'dist/main/control-build.json'), ...samplerClientComponents.map(component => path.join(root, component))];
    config.artifacts = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file))])));
    report.artifacts = config.artifacts; await writeFile(configPath, JSON.stringify(config));
    runner = await launchWindowsUserProcess(process.execPath, [fileURLToPath(import.meta.url), '--medium-run', configPath], root); report.childStarted = true;
    const candidate = inspect(['--inspect', String(runner.pid)]);
    assertOwnedIdentity(candidate, { pid: runner.pid, executable: process.execPath, sha256: config.nodeSha256 });
    await poll(() => json(config.ready), value => {
      check(value.nonce === config.nonce, 'SAMPLER_CLIENT_NONCE_MISMATCH'); assertOwnedIdentity(value.identity, { pid: runner.pid, executable: process.execPath, sha256: config.nodeSha256, original: candidate }); return true;
    }, 15000, 'SAMPLER_CLIENT_READY_MISSING');
    identity = report.runnerIdentity = candidate; await writeFile(config.go, config.nonce);
    report.measurement = await poll(() => json(config.childReport), value => { check(value.nonce === config.nonce, 'SAMPLER_CLIENT_NONCE_MISMATCH'); return value.finished === true; }, 180000, 'SAMPLER_CLIENT_TOTAL_DEADLINE');
    report.ok = report.measurement.ok === true;
  } catch (error) { report.error = lifecycleError(error); }
  finally {
    if (identity) {
      report.cleanup.runner = await retireSamplerProcess({ identity, executable: process.execPath, inspect, close: () => writeFile(config.stop, config.nonce),
        closed: () => poll(() => json(config.closed), value => {
          check(value.nonce === config.nonce && value.pid === identity.pid && value.startedUtcTicks === identity.startedUtcTicks, 'SAMPLER_CLIENT_CLOSE_IDENTITY'); return true;
        }, 45000, 'SAMPLER_CLIENT_CLOSE_MISSING') });
      if (!report.cleanup.runner.ok) report.ok = false;
    } else if (runner) {
      report.ok = false; report.cleanup.runnerIdentityUnconfirmed = true;
      try { await writeFile(config.stop, config.nonce); report.cleanup.nonceStopRequested = true; }
      catch (error) { report.cleanup.stopError = lifecycleError(error); }
    }
    report.finishedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, childStarted: report.childStarted, report: reportFile }));
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const task = process.argv[2] === '--medium-run' && process.argv.length === 4 ? mediumRun(process.argv[3]) : main();
  try { if (!(await task).ok) process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify(lifecycleError(error))); process.exitCode = 1; }
}
