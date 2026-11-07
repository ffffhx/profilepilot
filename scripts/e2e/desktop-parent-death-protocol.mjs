import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertOwnedIdentity } from '../verify-desktop-observer-startup.mjs';
import { verifyProviderMarker, verifyProviderPending } from '../verify-desktop-provider-block.mjs';

export const desktopParentComponents = Object.freeze(['dist/main/desktop/worker.js', 'dist/main/desktop/errors.js',
  'dist/main/native-runtime.js', 'dist/native/ProfilePilot.Desktop.exe']);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const errorInfo = error => ({ code: typeof error?.code === 'string' ? error.code : 'PROBE_FAILED',
  message: error instanceof Error ? error.message : 'Unknown probe failure' });
export function parentDeathOptions(args) {
  let mode, runtime;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' || arg === '--run') { assert.equal(mode, undefined, 'Only one mode is allowed'); mode = arg; }
    else if (arg === '--parent-runtime') {
      assert.equal(runtime, undefined, 'Only one parent runtime is allowed'); runtime = args[++i];
      assert.ok(['node', 'electron'].includes(runtime), 'Parent runtime must be node or electron');
    } else throw new Error('Use [--check | --run] [--parent-runtime node | electron]');
  }
  return { run: mode === '--run', runtime: runtime || 'node' };
}
export function electronParentEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
}
export function verifyProbeDirectory(home, directory) {
  assert.ok(typeof home === 'string' && path.win32.isAbsolute(home));
  assert.ok(typeof directory === 'string' && path.win32.isAbsolute(directory));
  const relative = path.win32.relative(path.win32.resolve(home), path.win32.resolve(directory));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative), 'Runtime directory must stay inside the owned probe root');
  return directory;
}
export function verifyBootstrapCompletion(receipt, identity, nonce, exit) {
  requireIdentity(identity);
  assert.equal(receipt.nonce, nonce); assert.equal(receipt.pid, identity.pid); assert.equal(receipt.startedUtcTicks, identity.startedUtcTicks);
  assert.equal(receipt.reason, 'launched'); assert.equal(receipt.exitCode, 0);
  assert.equal(exit.ok, true); assert.equal(exit.originalExited, true);
  return { ok: true, receipt, exit };
}
export function verifyParentRuntime(value, expected) {
  assert.equal(value.kind, expected.kind);
  for (const key of ['node', 'uv']) assert.match(value.versions?.[key], /^\d+\.\d+\.\d+(?:[-+].*)?$/);
  if (expected.kind === 'electron') {
    assert.equal(value.versions.electron, expected.electronVersion); assert.equal(value.processType, 'browser');
    assert.equal(value.runAsNodePresent, false); assert.equal(value.windowCount, 0); assert.equal(value.webContentsCount, 0);
    for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
      verifyProbeDirectory(expected.home, value.directories?.[key]);
      assert.equal(path.win32.resolve(value.directories[key]).toLowerCase(), path.win32.resolve(expected.directories[key]).toLowerCase());
    }
  } else { assert.equal(value.versions.electron, undefined); assert.equal(value.processType, undefined); }
  return value;
}
export async function verifyParentBuild(root, read = readFile) {
  const manifest = JSON.parse(await read(path.join(root, 'dist/main/control-build.json'), 'utf8'));
  assert.equal(manifest.version, 1); assert.match(manifest.buildId, /^[a-f0-9]{64}$/);
  assert.equal(digest(JSON.stringify(manifest.components)), manifest.buildId);
  const components = {};
  for (const name of desktopParentComponents) {
    components[name] = digest(await read(path.join(root, name)));
    assert.equal(components[name], manifest.components[name], 'Build artifact mismatch: ' + name);
  }
  return { buildId: manifest.buildId, components };
}
export async function verifyArtifacts(artifacts) {
  for (const [file, hash] of Object.entries(artifacts)) assert.equal(digest(await readFile(file)), hash, 'Probe artifact changed');
}
function requireIdentity(identity) {
  assert.ok(Number.isSafeInteger(identity?.pid) && identity.pid > 0);
  assert.ok(typeof identity.executable === 'string' && path.win32.isAbsolute(identity.executable));
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  assertOwnedIdentity(identity, { pid: identity.pid, executable: identity.executable, sha256: identity.sha256 });
}
export function verifyProbeParent(value, expected, launchedPid) {
  assert.equal(value.nonce, expected.nonce);
  requireIdentity(value.identity);
  if (launchedPid !== undefined) assert.equal(value.identity.pid, launchedPid);
  assertOwnedIdentity(value.identity, { pid: value.identity.pid, executable: expected.executable, sha256: expected.sha256 });
  if (expected.runtime) verifyParentRuntime(value.runtime, expected.runtime);
  return Object.freeze({ ...value.identity });
}
export function verifyProbeHelper(value, parent, helperHash, runtimeDirectory) {
  requireIdentity(value); requireIdentity(parent);
  assertOwnedIdentity(value, { pid: value.pid, executable: value.executable, sha256: helperHash });
  assert.equal(value.parentPid, parent.pid);
  assert.equal(path.win32.resolve(path.win32.dirname(value.executable)).toLowerCase(), path.win32.resolve(runtimeDirectory).toLowerCase());
  assert.ok(path.win32.basename(value.executable).toLowerCase().startsWith(helperHash));
  return Object.freeze({ ...value });
}
export function verifyParentPending(value, expected, parent, helper) {
  assert.equal(value.nonce, expected.nonce); assert.equal(value.runId, expected.runId);
  assert.equal(value.phase, 'observing'); assert.equal(value.requestSettled, false);
  assert.equal(value.parentIdentity.pid, parent.pid); assert.equal(value.parentIdentity.startedUtcTicks, parent.startedUtcTicks);
  for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'executable', 'sha256']) assert.equal(value.helperIdentity[key], helper[key]);
  assert.ok(Number.isFinite(value.dispatchedUtc));
}
// Pure orchestration: the actual implementation supplies only owned process I/O.
// Planned parent termination is fault injection. A later cleanup force is FAIL.
export async function runParentDeathCase(options, io, record = {}) {
  assert.ok(Number.isFinite(options.observationStartedAt) && options.observationStartedAt >= 0);
  record.observationStartedAt = options.observationStartedAt;
  record.parentExitLimitMs = 10000;
  record.entered = await io.entered();
  verifyProviderMarker(record.entered, options.expected, 'entered', 'accessible-name-getter');
  record.pendingBeforeFault = await io.parentPending();
  verifyParentPending(record.pendingBeforeFault, options.expected, options.parent, options.helper);
  assert.ok(Date.parse(record.entered.utc) >= record.pendingBeforeFault.dispatchedUtc);
  record.providerBeforeFault = await io.providerPending(); verifyProviderPending(record.providerBeforeFault, options.expected);
  record.faultDispatchedAt = io.now();
  assert.ok(Number.isFinite(record.faultDispatchedAt) && record.faultDispatchedAt >= options.observationStartedAt &&
    record.faultDispatchedAt - options.observationStartedAt < record.parentExitLimitMs, 'Parent fault dispatch exceeded the original observation window');
  record.plannedParentTermination = await io.terminateParent();
  assert.equal(record.plannedParentTermination.ok, true); assert.equal(record.plannedParentTermination.originalExited, true);
  assert.equal(record.plannedParentTermination.forced, true, 'The planned parent fault must actually occur; a pre-existing exit is not this scenario');
  record.parentExit = await io.waitParentExit();
  assert.equal(record.parentExit.ok, true); assert.equal(record.parentExit.originalExited, true);
  record.parentExitObservedAt = io.now();
  record.parentExitElapsedMs = record.parentExitObservedAt - options.observationStartedAt;
  // The current pinned production DesktopWorker has a 12s request timer. The
  // supervisor starts this clock before publishing the observe command, and
  // requires parent death before 10s so that timer cannot retire the helper.
  if (!Number.isFinite(record.parentExitElapsedMs) || record.parentExitElapsedMs < 0 ||
    record.parentExitElapsedMs >= record.parentExitLimitMs) {
    throw Object.assign(new Error('Parent exit was not independently confirmed within 10s of the original observe command; helper retirement attribution is not covered'),
      { code: 'DESKTOP_PARENT_DEATH_PARENT_EXIT_TOO_LATE' });
  }
  record.providerAfterParentExit = await io.providerPending(); verifyProviderPending(record.providerAfterParentExit, options.expected);
  record.helperExit = await io.waitHelperExit(5000);
  record.helperWaitFinishedAt = io.now();
  record.providerAfterHelperWait = await io.providerPending(); verifyProviderPending(record.providerAfterHelperWait, options.expected);
  assert.equal(record.helperExit.ok, true);
  if (record.helperExit.originalExited !== true) throw Object.assign(new Error('Original helper survived the isolated parent termination while the provider remained blocked'), { code: 'DESKTOP_PARENT_DEATH_HELPER_SURVIVED' });
  record.ok = true; return record;
}
export async function retireProbeProcess(identity, io) {
  requireIdentity(identity);
  const result = { ok: false, forcedAttempts: [] };
  try { result.before = await io.wait(identity, 5000); }
  catch (error) { result.waitError = errorInfo(error); }
  if (result.before?.ok === true && result.before.originalExited === true) { result.ok = true; return result; }
  // Caller must already have verified the complete identity; never accept PID-only cleanup.
  assertOwnedIdentity(identity, { pid: identity.pid, executable: identity.executable, sha256: identity.sha256 });
  const forced = {}; result.forcedAttempts.push(forced);
  try { forced.result = await io.force(identity); } catch (error) { forced.error = errorInfo(error); }
  try { result.after = await io.wait(identity, 5000); } catch (error) { result.afterError = errorInfo(error); }
  return result;
}
