import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const lifecycleError = error => ({ code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'SAMPLER_LIFECYCLE_FAILED',
  ...(typeof error?.causeCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.causeCode) ? { causeCode: error.causeCode } : {}) });
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export function ownedCreationFileTimeFromTicks(startedUtcTicks) {
  check(typeof startedUtcTicks === 'string' && /^[1-9][0-9]{0,18}$/.test(startedUtcTicks), 'SAMPLER_LIFECYCLE_OWN_TICKS_INVALID');
  const birth = BigInt(startedUtcTicks) - 504911232000000000n;
  check(birth > 0n && birth <= 18446744073709551615n, 'SAMPLER_LIFECYCLE_OWN_TICKS_INVALID');
  return birth.toString();
}
export function summarizeSamplerSnapshot(value, ownPid, expectedCreationFileTime) {
  check(value?.complete === true && Array.isArray(value.processes) && value.processes.length > 0, 'SAMPLER_LIFECYCLE_INCOMPLETE');
  const own = value.processes.filter(row => row.pid === ownPid);
  check(own.length === 1 && own[0].identityStatus === 'confirmed' && /^[1-9][0-9]{0,19}$/.test(own[0].creationFileTime), 'SAMPLER_LIFECYCLE_OWN_IDENTITY_MISSING');
  if (expectedCreationFileTime !== undefined) check(own[0].creationFileTime === expectedCreationFileTime, 'SAMPLER_LIFECYCLE_OWN_BIRTH_MISMATCH');
  return { processCount: value.processes.length, ownPid, ownCreationFileTime: own[0].creationFileTime, nativeTimings: value.timings };
}

// This wrapper delegates to the real Node spawn in --run. It records the exact
// returned ChildProcess, never reopens a PID to terminate a possibly reused one.
export function createSamplerLifecycleRecorder({ expectedHelperHash, spawnProcess = spawn, now = Date.now, readHash = hashFile,
  runtimeDirectory = path.join(os.tmpdir(), 'profilepilot-windows-sampler-runtime'), changed = () => {} } = {}) {
  const records = [], children = [], events = [], notificationErrors = []; let sequence = 0, currentCase = 'initial', afterSpawn;
  const notify = () => { try { changed(); } catch (error) { notificationErrors.push(lifecycleError(error)); } };
  const event = (record, kind, extra = {}) => {
    const value = { sequence: ++sequence, child: record.index, case: record.case, kind, at: now(), ...extra };
    events.push(value); notify(); return value;
  };
  const delegated = (executable, args, options) => {
    const pending = records.find(record => record.closedAt === undefined);
    if (pending) { event(pending, 'overlap-attempt'); check(false, 'SAMPLER_LIFECYCLE_OVERLAP'); }
    check(path.resolve(path.dirname(executable)).toLowerCase() === path.resolve(runtimeDirectory).toLowerCase(), 'SAMPLER_LIFECYCLE_RUNTIME_PATH');
    check(readHash(executable) === expectedHelperHash, 'SAMPLER_LIFECYCLE_RUNTIME_HASH');
    check(args.length === 0 && options.windowsHide === true && options.stdio === 'pipe', 'SAMPLER_LIFECYCLE_SPAWN_CONTRACT');
    const record = { index: records.length, case: currentCase, requestedAt: now(), executable, sha256: expectedHelperHash };
    const child = spawnProcess(executable, args, options); records.push(record); children.push(child);
    record.pid = Number.isSafeInteger(child.pid) ? child.pid : null; event(record, 'spawn-call-returned');
    const trigger = () => {
      if (record.spawnedAt === undefined || record.stdinFinishedAt === undefined || record.triggered) return;
      record.triggered = true;
      try { afterSpawn?.(child, record); } catch (error) { record.triggerError = lifecycleError(error); notify(); }
    };
    if (child.stdin) {
      const originalEnd = child.stdin.end;
      child.stdin.end = function (...values) {
        record.stdinEndedAt = now(); record.requestBytes = Buffer.byteLength(values[0] || ''); event(record, 'stdin-end-called');
        return originalEnd.apply(this, values);
      };
      child.stdin.once('finish', () => { record.stdinFinishedAt = now(); event(record, 'stdin-finished'); trigger(); });
    }
    child.once('spawn', () => {
      record.spawnedAt = now(); record.spawnSequence = event(record, 'os-spawn').sequence;
      trigger();
    });
    child.on('error', error => { record.processError = lifecycleError(error); event(record, 'process-error', record.processError); });
    child.once('exit', (code, signal) => { record.exitEventAt = now(); event(record, 'exit', { code, signal }); });
    child.once('close', (code, signal) => {
      record.closedAt = now(); record.closeCode = code; record.closeSignal = signal;
      record.closeSequence = event(record, 'close', { code, signal }).sequence;
    });
    return child;
  };
  return { records, events, notificationErrors, spawnProcess: delegated,
    stage(name, callback) { currentCase = name; afterSpawn = callback; },
    allClosed: () => records.every(record => record.closedAt !== undefined),
    async awaitClosed(timeoutMs = 10000) { const deadline = Date.now() + timeoutMs; while (!this.allClosed() && Date.now() < deadline) await delay(10); return this.allClosed(); },
    forceOwnChildren() {
      for (const [index, child] of children.entries()) if (records[index].closedAt === undefined) {
        records[index].forced = true; event(records[index], 'cleanup-kill');
        try { records[index].killAccepted = child.kill(); } catch (error) { records[index].killError = lifecycleError(error); }
      }
    }
  };
}

function observePromise(promise) {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: lifecycleError(error) }));
}
function failed(value, code) { check(value.ok === false && value.error.code === code, 'SAMPLER_LIFECYCLE_EXPECTED_' + code); }

// The lifecycle is implemented by the loaded production class. This harness
// only requests reads, abort/close, records real OS events and checks outcomes.
export async function runSamplerClientCases({ Client, recorder, ownPid, ownCreationFileTime, deadlineMs = 75, changed = () => {}, shouldStop = () => false,
  cleanupTimeoutMs = 10000 } = {}) {
  const report = { ok: false, cases: [], children: recorder.records, events: recorder.events, cleanup: { clients: [] },
    limitations: ['All operations are read-only process snapshots; no GUI, hooks, input or user file reads.',
      'Abort and close require both the real spawn event and stdin finish after the production client ends its request. Pipe completion is not proof that the native WMI query has begun.',
      'The short deadline case fails as not observed if preparation prevents spawn or the read completes early; it is not retried.',
      'Only counts, native phase timings and the owned runner identity are retained from process results.'] };
  const clients = [], context = (controller = new AbortController(), duration = 8000) => ({ now: Date.now, deadlineAt: Date.now() + duration, signal: controller.signal });
  const newClient = () => { const value = new Client({ spawnProcess: recorder.spawnProcess }); clients.push(value); return value; };
  const run = async (name, body) => {
    check(!shouldStop(), 'SAMPLER_LIFECYCLE_STOPPED');
    const entry = { name, startedAt: Date.now(), childStartIndex: recorder.records.length }; report.cases.push(entry); changed(report);
    try { await body(entry); check(!recorder.records.slice(entry.childStartIndex).some(value => value.triggerError), 'SAMPLER_LIFECYCLE_TRIGGER_FAILED'); entry.ok = true; }
    catch (error) { entry.ok = false; entry.error = lifecycleError(error); throw error; }
    finally { entry.elapsedMs = Date.now() - entry.startedAt; entry.childCount = recorder.records.length - entry.childStartIndex; changed(report); }
  };
  try {
    await run('normal', async entry => {
      recorder.stage('normal'); const client = newClient(), value = await client.sampleWindowsProcesses(context());
      Object.assign(entry, summarizeSamplerSnapshot(value, ownPid, ownCreationFileTime));
      check(recorder.records.length === entry.childStartIndex + 1 && recorder.records.at(-1).spawnedAt !== undefined && recorder.allClosed(), 'SAMPLER_LIFECYCLE_NORMAL_CLOSE');
      await client.close();
    });
    await run('abort-after-spawn-with-queued-successor', async entry => {
      const client = newClient(), controller = new AbortController(); let triggered = false;
      recorder.stage(entry.name, (_child, record) => { if (record.index === entry.childStartIndex) { triggered = true; entry.abortRequestedAt = Date.now(); controller.abort(); } });
      const first = observePromise(client.sampleWindowsProcesses(context(controller)));
      const second = observePromise(client.sampleWindowsProcesses(context()));
      const [aborted, successor] = await Promise.all([first, second]); entry.active = aborted.ok ? { ok: true } : aborted; entry.successor = successor.ok ? { ok: true } : successor;
      failed(aborted, 'WINDOWS_SAMPLER_ABORTED'); check(triggered && recorder.records[entry.childStartIndex]?.stdinFinishedAt !== undefined, 'SAMPLER_LIFECYCLE_ABORT_NOT_TRIGGERED');
      check(successor.ok, 'SAMPLER_LIFECYCLE_SUCCESSOR_FAILED'); Object.assign(entry, summarizeSamplerSnapshot(successor.value, ownPid, ownCreationFileTime));
      const [old, next] = recorder.records.slice(entry.childStartIndex);
      check(recorder.records.length === entry.childStartIndex + 2 && old?.closeSequence < next?.spawnSequence && recorder.allClosed(), 'SAMPLER_LIFECYCLE_SUCCESSOR_BEFORE_CLOSE');
      await client.close();
    });
    await run('short-original-deadline', async entry => {
      recorder.stage(entry.name); const client = newClient(); entry.deadlineMs = deadlineMs;
      const value = await observePromise(client.sampleWindowsProcesses(context(new AbortController(), deadlineMs))); entry.result = value.ok ? { ok: true } : value;
      failed(value, 'WINDOWS_SAMPLER_TIMEOUT');
      check(recorder.records.length === entry.childStartIndex + 1 && recorder.records.at(-1).spawnedAt !== undefined && recorder.allClosed(), 'SAMPLER_LIFECYCLE_TIMEOUT_WITHOUT_SPAWN_CLOSE');
      await client.close();
    });
    await run('close-with-active-and-queued', async entry => {
      const client = newClient(); let closing, triggered = false;
      recorder.stage(entry.name, () => { triggered = true; entry.closeRequestedAt = Date.now(); closing = observePromise(client.close()); });
      const active = observePromise(client.sampleWindowsProcesses(context())), queued = observePromise(client.sampleWindowsProcesses(context()));
      const values = await Promise.all([active, queued]); entry.active = values[0].ok ? { ok: true } : values[0]; entry.queued = values[1].ok ? { ok: true } : values[1];
      check(triggered && closing && recorder.records[entry.childStartIndex]?.stdinFinishedAt !== undefined, 'SAMPLER_LIFECYCLE_CLOSE_NOT_TRIGGERED');
      failed(values[0], 'WINDOWS_SAMPLER_CLOSED'); failed(values[1], 'WINDOWS_SAMPLER_CLOSED');
      entry.closeResult = await closing; check(entry.closeResult.ok, 'SAMPLER_LIFECYCLE_CLOSE_UNCONFIRMED');
      const later = await observePromise(client.sampleWindowsProcesses(context())); entry.afterClose = later.ok ? { ok: true } : later;
      failed(later, 'WINDOWS_SAMPLER_CLOSED');
      check(recorder.records.length === entry.childStartIndex + 1 && recorder.allClosed(), 'SAMPLER_LIFECYCLE_SPAWN_AFTER_CLOSE');
    });
    report.ok = true;
  } catch (error) { report.error = lifecycleError(error); }
  finally {
    for (const client of clients) {
      const closed = await observePromise(client.close()); report.cleanup.clients.push(closed.ok ? { ok: true } : closed); if (!closed.ok) report.ok = false;
    }
    report.cleanup.allChildrenClosed = await recorder.awaitClosed(cleanupTimeoutMs);
    if (!report.cleanup.allChildrenClosed) {
      report.ok = false; report.cleanup.forced = true; recorder.forceOwnChildren();
      report.cleanup.allChildrenClosed = await recorder.awaitClosed(5000);
    }
    if (recorder.records.some(record => record.forced)) report.ok = false;
    if (recorder.notificationErrors.length) { report.ok = false; report.cleanup.notificationErrors = recorder.notificationErrors; }
    changed(report);
  }
  return report;
}
