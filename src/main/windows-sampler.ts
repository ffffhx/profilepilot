import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { nativeRuntimeCopy } from './native-runtime';
import { WINDOWS_SAMPLER_LIMITS, validateWindowsSamplerReply, validateWindowsSamplerRequest, windowsSamplerError,
  type WindowsSamplerError, type WindowsSamplerFileLocksResult, type WindowsSamplerRequest,
  type WindowsSamplerResult, type WindowsSamplerSnapshotResult } from './windows-sampler-protocol';

export type { WindowsSamplerFileLocksResult, WindowsSamplerSnapshotResult } from './windows-sampler-protocol';
export type WindowsSamplerReadContext = { deadlineAt: number; now: () => number; signal: AbortSignal };
export interface WindowsSamplerChild extends Pick<EventEmitter, 'on' | 'once'> {
  pid?: number; stdin: Writable | null; stdout: Readable | null; stderr: Readable | null; kill(): boolean;
}
export interface WindowsSamplerClientOptions {
  platform?: NodeJS.Platform; executable?: string;
  spawnProcess?: (executable: string, args: string[], options: { windowsHide: true; stdio: 'pipe' }) => WindowsSamplerChild;
  prepareExecutable?: () => string;
  timeoutMs?: number; killGraceMs?: number; maxQueued?: number;
  timers?: { set(callback: () => void, milliseconds: number): unknown; clear(timer: unknown): void };
}
interface PendingRead {
  request: WindowsSamplerRequest; bytes: Buffer; context: WindowsSamplerReadContext; deadlineAt: number;
  resolve(value: WindowsSamplerResult): void; reject(error: WindowsSamplerError): void;
  settled: boolean; timer?: unknown; abort?: () => void;
}
interface ActiveRead {
  task: PendingRead; child?: WindowsSamplerChild; chunks: Buffer[]; stdoutBytes: number; stderrBytes: number;
  failure?: WindowsSamplerError; killStarted: boolean; unconfirmed: boolean; closed: boolean; grace?: unknown;
  retired: Promise<void>; retire(): void;
}
const timers = { set: (callback: () => void, milliseconds: number): unknown => setTimeout(callback, milliseconds),
  clear: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout) };

export function windowsSamplerExecutable(): string {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'native', 'ProfilePilot.WindowsSampler.exe') : null;
  return packaged && existsSync(packaged) ? packaged : path.resolve(__dirname, '../native/ProfilePilot.WindowsSampler.exe');
}

// One short-lived child at a time. Completion of a failed request is distinct
// from child retirement: only close releases the barrier, even after a rejected
// kill, error, exit event or bounded termination wait. No action retry exists.
export class WindowsSamplerClient {
  private readonly options: WindowsSamplerClientOptions;
  private readonly timers: NonNullable<WindowsSamplerClientOptions['timers']>;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly maxQueued: number;
  private queue: PendingRead[] = [];
  private active?: ActiveRead;
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: WindowsSamplerClientOptions = {}) {
    this.options = options; this.timers = options.timers || timers;
    this.timeoutMs = options.timeoutMs ?? 8000; this.killGraceMs = options.killGraceMs ?? 1500; this.maxQueued = options.maxQueued ?? 8;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 8000
      || !Number.isFinite(this.killGraceMs) || this.killGraceMs < 1 || this.killGraceMs > 5000
      || !Number.isSafeInteger(this.maxQueued) || this.maxQueued < 0 || this.maxQueued > 64)
      throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_OPTIONS');
  }

  sampleWindowsProcesses(context?: WindowsSamplerReadContext): Promise<WindowsSamplerSnapshotResult> {
    return this.request({ version: 1, requestId: randomUUID(), operation: 'snapshot', params: {} }, context) as Promise<WindowsSamplerSnapshotResult>;
  }
  sampleWindowsFileLocks(paths: string[], context?: WindowsSamplerReadContext): Promise<WindowsSamplerFileLocksResult> {
    // Copy paths before queuing: subsequent caller mutation cannot alter the
    // request sent on stdin or the exact-path response validation envelope.
    const copied = Array.isArray(paths) ? [...paths] : paths;
    return this.request({ version: 1, requestId: randomUUID(), operation: 'fileLocks', params: { paths: copied } }, context) as Promise<WindowsSamplerFileLocksResult>;
  }

  private request(request: WindowsSamplerRequest, supplied?: WindowsSamplerReadContext): Promise<WindowsSamplerResult> {
    try {
      if ((this.options.platform || process.platform) !== 'win32') throw windowsSamplerError('WINDOWS_SAMPLER_PLATFORM_UNAVAILABLE');
      if (this.closed) throw windowsSamplerError('WINDOWS_SAMPLER_CLOSED');
      if (this.active?.unconfirmed) throw windowsSamplerError('WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
      const bytes = validateWindowsSamplerRequest(request);
      const input = supplied || { deadlineAt: Date.now() + this.timeoutMs, now: Date.now, signal: new AbortController().signal };
      const context = { deadlineAt: input.deadlineAt, now: input.now, signal: input.signal };
      if (typeof context.now !== 'function' || !Number.isFinite(context.deadlineAt) || typeof context.signal?.aborted !== 'boolean'
        || typeof context.signal.addEventListener !== 'function' || typeof context.signal.removeEventListener !== 'function')
        throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_CONTEXT');
      const now = context.now(); if (!Number.isFinite(now)) throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_CONTEXT');
      const deadlineAt = Math.min(context.deadlineAt, now + this.timeoutMs);
      if (context.signal.aborted) throw windowsSamplerError('WINDOWS_SAMPLER_ABORTED');
      if (deadlineAt <= now) throw windowsSamplerError('WINDOWS_SAMPLER_TIMEOUT');
      if (this.active && this.queue.length >= this.maxQueued) throw windowsSamplerError('WINDOWS_SAMPLER_BUSY');
      return new Promise((resolve, reject) => {
        const task: PendingRead = { request, bytes, context, deadlineAt, resolve, reject, settled: false };
        task.abort = () => this.interrupt(task, windowsSamplerError('WINDOWS_SAMPLER_ABORTED'));
        this.queue.push(task);
        task.timer = this.timers.set(() => this.interrupt(task, windowsSamplerError('WINDOWS_SAMPLER_TIMEOUT')), deadlineAt - now);
        context.signal.addEventListener('abort', task.abort, { once: true });
        // Catch an abort which occurred during listener installation.
        if (context.signal.aborted) task.abort();
        this.pump();
      });
    } catch (error) { return Promise.reject(this.safeFailure(error, 'WINDOWS_SAMPLER_INVALID_CONTEXT')); }
  }

  private safeFailure(error: unknown, fallback: string): WindowsSamplerError {
    const value = error as Partial<WindowsSamplerError> | null;
    return value && typeof value.code === 'string' && /^WINDOWS_SAMPLER_[A-Z0-9_]{1,64}$/.test(value.code)
      && value.outcome === 'unavailable' ? error as WindowsSamplerError : windowsSamplerError(fallback);
  }
  private contextFailure(task: PendingRead): WindowsSamplerError | undefined {
    if (task.context.signal.aborted) return windowsSamplerError('WINDOWS_SAMPLER_ABORTED');
    try {
      const now = task.context.now();
      if (!Number.isFinite(now)) return windowsSamplerError('WINDOWS_SAMPLER_INVALID_CONTEXT');
      if (now >= task.deadlineAt) return windowsSamplerError('WINDOWS_SAMPLER_TIMEOUT');
    } catch { return windowsSamplerError('WINDOWS_SAMPLER_INVALID_CONTEXT'); }
    return undefined;
  }
  private settle(task: PendingRead, error?: WindowsSamplerError, result?: WindowsSamplerResult): void {
    if (task.settled) return;
    task.settled = true;
    if (task.timer !== undefined) this.timers.clear(task.timer);
    if (task.abort) task.context.signal.removeEventListener('abort', task.abort);
    if (error) task.reject(error); else task.resolve(result!);
  }
  private interrupt(task: PendingRead, error: WindowsSamplerError): void {
    if (task.settled) return;
    if (this.active?.task === task) this.stop(this.active, error);
    else { this.queue = this.queue.filter(value => value !== task); this.settle(task, error); }
  }
  private pump(): void {
    while (!this.closed && !this.active && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.settled) continue;
      const expired = this.contextFailure(task);
      if (expired) { this.settle(task, expired); continue; }
      let retire!: () => void;
      const active: ActiveRead = { task, chunks: [], stdoutBytes: 0, stderrBytes: 0, killStarted: false, unconfirmed: false, closed: false,
        retired: new Promise<void>(resolve => { retire = resolve; }), retire: () => retire() };
      this.active = active;
      this.start(active);
    }
  }
  private start(active: ActiveRead): void {
    let executable: string;
    try {
      if (this.options.prepareExecutable) executable = this.options.prepareExecutable();
      else {
        const source = this.options.executable || windowsSamplerExecutable();
        if (!existsSync(source)) throw windowsSamplerError('WINDOWS_SAMPLER_HELPER_MISSING');
        executable = nativeRuntimeCopy(source, 'profilepilot-windows-sampler-runtime');
      }
    } catch (error) { this.unspawned(active, active.failure || this.safeFailure(error, 'WINDOWS_SAMPLER_HELPER_UNAVAILABLE')); return; }
    const expired = active.failure || this.contextFailure(active.task);
    if (expired || this.closed) { this.unspawned(active, expired || windowsSamplerError('WINDOWS_SAMPLER_CLOSED')); return; }
    let child: WindowsSamplerChild;
    try { child = (this.options.spawnProcess || spawn)(executable, [], { windowsHide: true, stdio: 'pipe' }); }
    catch { this.unspawned(active, active.failure || windowsSamplerError('WINDOWS_SAMPLER_SPAWN_FAILED')); return; }
    active.child = child;
    child.on('error', () => this.stop(active, windowsSamplerError(child.pid === undefined ? 'WINDOWS_SAMPLER_SPAWN_FAILED' : 'WINDOWS_SAMPLER_PROCESS_ERROR')));
    // Deliberately do not release on exit: unread stdout must drain and close.
    child.once('close', code => this.complete(active, typeof code === 'number' ? code : null));
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_PIPE_ERROR')));
    if (!child.stdin || !child.stdout || !child.stderr) { this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_PIPE_UNAVAILABLE')); return; }
    child.stdout.on('data', (chunk: unknown) => {
      if (active.closed || active.failure) return;
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_INVALID_RESPONSE')); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      active.stdoutBytes += bytes.length;
      if (active.stdoutBytes > WINDOWS_SAMPLER_LIMITS.responseBytes) this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_RESPONSE_TOO_LARGE'));
      else active.chunks.push(bytes);
    });
    child.stderr.on('data', () => { if (!active.closed) this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_UNEXPECTED_STDERR')); });
    const beforeWrite = active.failure || this.contextFailure(active.task);
    if (beforeWrite || this.closed) { this.stop(active, beforeWrite || windowsSamplerError('WINDOWS_SAMPLER_CLOSED')); return; }
    try { child.stdin.end(active.task.bytes); }
    catch { this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_PIPE_ERROR')); }
  }
  private unspawned(active: ActiveRead, error: WindowsSamplerError): void {
    active.closed = true; this.settle(active.task, error); active.retire();
    if (this.active === active) this.active = undefined;
  }
  private stop(active: ActiveRead, error: WindowsSamplerError): void {
    if (active.closed || this.active !== active) return;
    active.failure ||= error; active.chunks.length = 0;
    // Reentrant cancellation during preparation is handled by start before
    // spawn, or immediately after a synchronous spawn implementation returns.
    if (!active.child || active.killStarted) return;
    active.killStarted = true;
    active.grace = this.timers.set(() => {
      if (active.closed) return;
      active.unconfirmed = true;
      const unknown = Object.assign(windowsSamplerError('WINDOWS_SAMPLER_EXIT_UNCONFIRMED'), { causeCode: active.failure!.code });
      this.settle(active.task, unknown);
      // Failed callers never reappear when a late close finally arrives.
      for (const queued of this.queue.splice(0)) this.settle(queued, windowsSamplerError('WINDOWS_SAMPLER_EXIT_UNCONFIRMED'));
    }, this.killGraceMs);
    try { active.child.kill(); } catch { /* A kill return/error never proves retirement. */ }
  }
  private complete(active: ActiveRead, exitCode: number | null): void {
    if (active.closed) return;
    active.closed = true; if (active.grace !== undefined) this.timers.clear(active.grace);
    let error = active.failure || this.contextFailure(active.task), result: WindowsSamplerResult | undefined;
    if (!error && !active.task.settled) {
      try {
        result = validateWindowsSamplerReply(Buffer.concat(active.chunks), active.task.request, exitCode);
        // Parsing a large bounded response also consumes the caller's budget.
        error = this.contextFailure(active.task);
      } catch (failure) { error = this.safeFailure(failure, 'WINDOWS_SAMPLER_INVALID_RESPONSE'); }
    }
    active.chunks.length = 0; this.settle(active.task, error, result); active.retire();
    if (this.active === active) this.active = undefined;
    this.pump();
  }

  close(): Promise<void> {
    this.closed = true;
    for (const queued of this.queue.splice(0)) this.settle(queued, windowsSamplerError('WINDOWS_SAMPLER_CLOSED'));
    const active = this.active;
    if (!active) return Promise.resolve();
    if (this.closing) return this.closing;
    const closing = this.closing = new Promise<void>((resolve, reject) => {
      const timer = this.timers.set(() => reject(windowsSamplerError('WINDOWS_SAMPLER_EXIT_UNCONFIRMED')), this.killGraceMs);
      void active.retired.then(() => { this.timers.clear(timer); resolve(); });
    });
    // Shutdown callers may start retirement synchronously before awaiting it.
    void closing.catch(() => {});
    this.stop(active, windowsSamplerError('WINDOWS_SAMPLER_CLOSED'));
    return closing;
  }
}

let singleton: WindowsSamplerClient | undefined;
let shutdown = false;
const client = () => singleton ||= new WindowsSamplerClient();
export async function sampleWindowsProcesses(context?: WindowsSamplerReadContext): Promise<WindowsSamplerSnapshotResult> {
  if (shutdown) throw windowsSamplerError('WINDOWS_SAMPLER_CLOSED');
  return client().sampleWindowsProcesses(context);
}
export async function sampleWindowsFileLocks(paths: string[], context?: WindowsSamplerReadContext): Promise<WindowsSamplerFileLocksResult> {
  if (shutdown) throw windowsSamplerError('WINDOWS_SAMPLER_CLOSED');
  return client().sampleWindowsFileLocks(paths, context);
}
export function closeWindowsSampler(): Promise<void> {
  shutdown = true;
  return singleton ? singleton.close() : Promise.resolve();
}
