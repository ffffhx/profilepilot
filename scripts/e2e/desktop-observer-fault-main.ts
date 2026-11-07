import { app } from 'electron';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DesktopService } from '../../src/main/desktop/service';
import { DesktopWorker } from '../../src/main/desktop/worker';
import { WindowsInputRuntime } from '../../src/main/desktop/input-runtime';
import { spawnWindowsInputObserver } from '../../src/main/desktop/input-observer-process';
import { startProfilePilotManagementServer } from '../../src/main/profilepilot-management-server';
import { OwnedObserverFaultOnce, validateFaultEnvelope } from './desktop-observer-fault-policy';

// Standalone acceptance main, never imported by the product. It creates no
// BrowserWindow, ProfileManager, browser guard, registration or user connection.
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(process.platform, 'win32'); assert.match(config.nonce, /^[a-f0-9]{32}$/);
assert.equal(path.dirname(path.resolve(config.base)), path.resolve(config.home));
app.setPath('userData', path.join(config.home, 'electron-user-data'));
process.env.PROFILEPILOT_MANAGEMENT_ROOT = path.join(config.home, 'management');
const exec = promisify(execFile), fault = new OwnedObserverFaultOnce();
const sourceHash = createHash('sha256').update(readFileSync(config.observerExecutable)).digest('hex');
let service: DesktopService, runtime: WindowsInputRuntime, server: any, poll: NodeJS.Timeout;
let owned: any, mainIdentity: any, spawnCount = 0, browserFactoryCalls = 0, busy = false, closing: Promise<void> | undefined, lastRequest = '';
const drivers: DesktopWorker[] = [], events: any[] = []; let eventSequence = 0;
function save(suffix: string, value: any) { const file = config.base + suffix; writeFileSync(file + '.tmp', JSON.stringify(value)); renameSync(file + '.tmp', file); }
function event(kind: string, extra: any = {}) {
  events.push({ sequence: ++eventSequence, kind, at: Date.now(), ...extra }); if (events.length > 96) events.shift();
  save('.state.json', evidence());
}
function evidence() {
  return { nonce: config.nonce, pid: process.pid, mainIdentity, browserFactoryCalls, spawnCount,
    status: service?.status(), runtime: runtime?.snapshot(), events, faultAttempted: fault.attempted,
    child: owned && { pid: owned.child.pid, expectedPath: owned.path, expectedHash: sourceHash, identity: owned.identity,
      exited: owned.exited, exitAt: owned.exitAt, closed: owned.closed },
    drivers: drivers.map((driver, index) => ({ index, stopConfirmed: driver.stopConfirmed })) };
}
async function identify(pid: number) {
  const { stdout } = await exec(config.identityExecutable, ['--inspect', String(pid)], { windowsHide: true, timeout: 8000, maxBuffer: 65536 });
  const value = JSON.parse(stdout); assert.equal(value.ok, true); assert.equal(value.pid, pid); return value;
}
function medium(value: any) { assert.equal(value.integrityRid, 8192); assert.equal(value.elevated, false); assert.equal(value.uiAccess, false); }
async function gate() { const module = await import(pathToFileURL(config.gateModule).href); await module.assertDesktopAcceptanceWindow(); }
async function close(reason: string) {
  if (closing) return closing;
  closing = (async () => {
    clearInterval(poll); const errors: string[] = [];
    for (const operation of [() => service?.close(), () => runtime?.dispose(), () => server?.close()]) {
      try { await operation(); } catch (error: any) { errors.push(error.code || error.message); }
    }
    save('.closed.json', { ...evidence(), reason, cleanupConfirmed: errors.length === 0 && drivers.every(driver => driver.stopConfirmed)
      && (!runtime || runtime.snapshot().stopConfirmed), errors });
    app.exit(errors.length ? 1 : 0);
  })();
  return closing;
}
async function handle(request: any) {
  validateFaultEnvelope(request, config.nonce);
  if (request.action === 'close') { save('.response.json', { id: request.id, ok: true, closing: true }); void close('owned-request'); return; }
  if (request.action === 'inspect') {
    if (owned && !owned.exited) {
      const identity = await identify(owned.child.pid); medium(identity);
      assert.equal(identity.parentPid, process.pid); assert.equal(identity.executable.toLowerCase(), owned.path.toLowerCase()); assert.equal(identity.sha256, sourceHash);
      if (!owned.identity) owned.identity = identity;
      else assert.equal(identity.startedUtcTicks, owned.identity.startedUtcTicks);
    }
    save('.response.json', { id: request.id, ok: true, result: evidence() }); return;
  }
  await gate(); const record = owned; assert.ok(record?.identity, 'Owned child must first be inspected');
  const childIdentity = await identify(record.child.pid);
  // Re-read all control facts after asynchronous metadata inspection. No await
  // occurs between this validation and kill on the saved ChildProcess object.
  const facts = { status: service.status(), runtime: runtime.snapshot(), child: childIdentity, originalChild: record.identity,
    ownedReferenceCurrent: owned === record, browserFactoryCalls, spawnCount, session: config.session,
    targetPid: config.target.pid, targetHwnd: config.target.hwnd, mainPid: process.pid,
    expectedPath: record.path, expectedHash: sourceHash, exited: record.exited || record.child.exitCode !== null || record.child.signalCode !== null };
  const result = fault.run(request, facts, config.nonce, () => {
    event('fault-attempt', { childPid: record.child.pid, generation: request.generation, epoch: request.epoch });
    return record.child.kill();
  });
  event('fault-requested', { childPid: record.child.pid, generation: request.generation, epoch: request.epoch });
  save('.response.json', { id: request.id, ok: true, result, evidence: facts });
}
async function checkFiles() {
  if (busy || closing) return; busy = true;
  try {
    if (Date.now() - statSync(config.base + '.heartbeat').mtimeMs > 20000) { void close('heartbeat-expired'); return; }
    const file = config.base + '.request.json'; if (!existsSync(file)) return;
    assert.ok(statSync(file).isFile() && statSync(file).size <= 8192);
    const request = JSON.parse(readFileSync(file, 'utf8')); if (request.id === lastRequest) return; lastRequest = request.id;
    try { await handle(request); } catch (error: any) { save('.response.json', { id: request.id, ok: false, code: error.code, error: error.message }); }
  } catch (error: any) { save('.failure.json', { error: error.message }); void close('private-channel-failed'); }
  finally { busy = false; }
}
void (async () => {
  await gate(); await app.whenReady(); mainIdentity = await identify(process.pid); medium(mainIdentity);
  runtime = new WindowsInputRuntime({ spawn: () => spawnWindowsInputObserver({ executable: config.observerExecutable,
    spawnProcess: ((file: string, args: string[], options: any) => {
      const child = spawn(file, args, options), record: any = { child, path: path.resolve(file), exited: false, closed: false, identity: undefined, exitAt: undefined };
      owned = record; spawnCount++;
      // Register before broker handlers so the receipt shows the actual local
      // transport notification preceding pause, without delaying the pause.
      for (const [name, pipe] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]] as const) {
        for (const kind of ['end', 'close', 'error']) pipe?.on(kind, () => event('observer-transport', { childPid: child.pid, source: name + ':' + kind }));
      }
      child.on('error', () => event('observer-transport', { childPid: child.pid, source: 'process:error' }));
      child.once('exit', () => { record.exited = true; record.exitAt = Date.now(); event('observer-exit', { childPid: child.pid }); });
      child.once('close', () => { record.closed = true; event('observer-close', { childPid: child.pid }); });
      return child;
    }) as any }) });
  // Any accidental future browser use is rejected before subscribing. The
  // counter is evidence, rather than an assumed empty ProfileManager state.
  Object.defineProperty(runtime, 'browserGuard', { value: () => { browserFactoryCalls++; throw new Error('Browser subscription forbidden in isolated observer-fault fixture'); } });
  service = new DesktopService({ inputObserver: runtime.observeDesktop, available: () => true,
    driver: () => { const driver = new DesktopWorker(config.desktopExecutable); drivers.push(driver); return driver; },
    admission: async target => ({ status: target.pid === config.target.pid && target.nativeHandle === config.target.hwnd ? 'unmanaged' : 'unknown',
      reason: 'isolated-owned-target-only', matches: [], gaps: [] }),
    onChanged: status => event('service-state', { state: status.session?.state, phase: status.inputObservation.phase, reason: status.inputObservation.reason,
      certainty: status.inputObservation.certainty, generation: status.inputObservation.generation, epoch: status.inputObservation.epoch }) });
  const forbidden = async () => { throw new Error('Browser/Profile operations are absent from this isolated fixture'); };
  server = await startProfilePilotManagementServer({ profileManager: { getState: forbidden, createProfile: forbidden, renameProfile: forbidden,
    configureProfileBrowser: forbidden, launchProfile: forbidden, closeProfile: forbidden, deleteProfile: forbidden },
    getDesktopService: () => service, homeDir: config.home, env: process.env });
  save('.ready.json', { ...evidence(), managementRoot: process.env.PROFILEPILOT_MANAGEMENT_ROOT, sourceHash });
  poll = setInterval(() => { void checkFiles(); }, 100);
  setTimeout(() => { void close('hard-lifetime-expired'); }, 300000).unref();
})().catch(async error => { save('.failure.json', { error: error.message, code: error.code }); await close('startup-failed'); });
app.on('before-quit', event => { if (!closing) { event.preventDefault(); void close('electron-quit'); } });
