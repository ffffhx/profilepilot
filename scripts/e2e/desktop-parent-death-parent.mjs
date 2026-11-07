import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertDesktopAcceptanceWindow } from './desktop-acceptance-window.mjs';
import { assertOwnedIdentity } from '../verify-desktop-observer-startup.mjs';
import { pollProviderFile, verifyProviderBaseline } from '../verify-desktop-provider-block.mjs';
import { digest, verifyArtifacts, verifyParentBuild, verifyProbeHelper, verifyParentRuntime, errorInfo } from './desktop-parent-death-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function save(file, value) { const temporary = file + '.' + process.pid + '.tmp'; writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, file); }

export async function runIsolatedDesktopParent(configFile, electronRuntime) {
  await assertDesktopAcceptanceWindow();
  const config = read(configFile); assert.equal(config.root, root); assert.match(config.nonce, /^[a-f0-9]{32}$/);
  await verifyArtifacts(config.artifacts); assert.equal((await verifyParentBuild(root)).buildId, config.build.buildId);
  const inspect = args => JSON.parse(execFileSync(config.identityExe, args, { encoding: 'utf8', windowsHide: true, timeout: 12000 }));
  const parentIdentity = inspect(['--inspect', String(process.pid)]);
  assertOwnedIdentity(parentIdentity, { pid: process.pid, executable: config.parentExecutable, sha256: config.parentHash });
  const runtime = () => verifyParentRuntime(electronRuntime ? electronRuntime() : { kind: 'node',
    versions: { node: process.versions.node, uv: process.versions.uv, electron: process.versions.electron }, processType: process.type }, config.runtime);
  const state = { nonce: config.nonce, runId: config.runId, parentIdentity, runtime: runtime(), phase: 'ready', requestSettled: false };
  save(config.parentReady, { nonce: config.nonce, identity: parentIdentity, runtime: state.runtime });
  let worker, stopping = false, completed, ticker;
  const publish = () => save(config.parentState, { ...state, capturedAt: Date.now() });
  const stop = async reason => {
    if (stopping) return; stopping = true; clearInterval(ticker);
    try { if (worker) await worker.close(); state.phase = 'closed'; }
    catch (error) { state.error = errorInfo(error); }
    state.reason = reason; publish();
    save(config.parentClosed, { nonce: config.nonce, pid: process.pid, startedUtcTicks: parentIdentity.startedUtcTicks,
      reason, exitCode: reason === 'requested' && !state.error ? 0 : 1 });
    completed?.(); process.exitCode = reason === 'requested' && !state.error ? 0 : 1;
  };
  const stopped = () => { assert.equal(stopping, false, 'Isolated parent stopped'); };
  const token = file => existsSync(file) && readFileSync(file, 'utf8') === config.nonce;
  const lifetime = performance.now();
  ticker = setInterval(() => {
    try {
      if (token(config.parentStop)) { void stop('requested'); return; }
      if (performance.now() - lifetime > 90000) { void stop('parent_deadman'); return; }
      publish();
    } catch (error) { state.error = errorInfo(error); void stop('parent_state_error'); }
  }, 100);
  try {
    await pollProviderFile(async () => { stopped(); return token(config.parentGo); }, Boolean, 'parent go', 15000);
    const { DesktopWorker, desktopExecutable } = require(path.join(root, 'dist/main/desktop/worker.js'));
    assert.equal(path.resolve(desktopExecutable()).toLowerCase(), path.join(root, 'dist/native/ProfilePilot.Desktop.exe').toLowerCase());
    let helper;
    worker = new DesktopWorker(undefined, (executable, args, options) => {
      assert.equal(helper, undefined, 'Only one production helper may be spawned');
      assert.equal(digest(readFileSync(executable)), config.build.components['dist/native/ProfilePilot.Desktop.exe']);
      assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'pipe');
      assert.notEqual(options.detached, true, 'Production helper must retain non-detached spawn behavior');
      helper = spawn(executable, args, options);
      state.helperCandidate = { pid: helper.pid, executable, sha256: config.build.components['dist/native/ProfilePilot.Desktop.exe'] }; publish();
      helper.once('spawn', () => {
        try {
          const value = inspect(['--inspect', String(helper.pid)]);
          state.helperIdentity = verifyProbeHelper(value, parentIdentity, config.build.components['dist/native/ProfilePilot.Desktop.exe'], path.join(os.tmpdir(), 'profilepilot-desktop-runtime'));
          publish();
        } catch (error) { state.error = errorInfo(error); void stop('helper_identity_failed'); }
      });
      helper.once('exit', (code, signal) => { state.helperExitEvent = { code, signal, at: Date.now() }; publish(); });
      return helper;
    });
    const listed = await worker.request('windows', {}); stopped();
    const selected = listed.windows.filter(value => value.pid === config.fixture.pid && value.nativeHandle === config.fixture.hwnd && value.title === config.fixture.rootName);
    assert.equal(selected.length, 1); const target = selected[0];
    // Discard all unrelated window rows. Never publish the native window catalog.
    const baseline = await worker.request('window.observe', { windowId: target.id }); stopped();
    verifyProviderBaseline(baseline, { nonce: config.nonce, windowId: target.id, rootName: config.fixture.rootName });
    assert.ok(state.helperIdentity); state.phase = 'baseline-ready'; state.target = target;
    state.baseline = { version: baseline.version, elementCount: baseline.elements.length, rootName: config.fixture.rootName,
      truncated: baseline.truncated, gaps: baseline.gaps }; publish();
    await pollProviderFile(async () => { stopped(); return token(config.parentObserve); }, Boolean, 'owned observe command', 15000);
    state.runtime = runtime(); state.phase = 'observing'; state.dispatchedUtc = Date.now(); state.requestSettled = false; publish();
    void worker.request('window.observe', { windowId: target.id }).then(value => {
      state.requestSettled = true; state.phase = 'read-returned'; state.readResult = { ok: true, version: value.version, elementCount: value.elements?.length }; publish();
    }, error => { state.requestSettled = true; state.phase = 'read-returned'; state.readResult = { ok: false, error: errorInfo(error) }; publish(); });
    await new Promise(resolve => { completed = resolve; if (stopping) resolve(); });
  } catch (error) { state.error = errorInfo(error); await stop('setup_failed'); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('One private config path is required');
  runIsolatedDesktopParent(process.argv[2]).catch(error => { console.error(JSON.stringify(errorInfo(error))); process.exitCode = 1; });
}
