import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { desktopErrorMessage } from './errors';
import { nativeRuntimeCopy } from '../native-runtime';

export const desktopError = (code: string, message = desktopErrorMessage(code)) => Object.assign(new Error(message), { code });
export interface DesktopDriver {
  readonly inputMarker?: string;
  // Latest process-exit evidence can supersede a previously rejected stop
  // attempt. Optional only for synchronous test drivers without child processes.
  readonly stopConfirmed?: boolean;
  request(operation: string, params: Record<string, unknown>): Promise<any>;
  close(): void | Promise<void>;
}
const readOperations = new Set(['windows', 'diagnostics', 'window.observe', 'window.screenshot']);
function interrupted(operation: string): Error {
  return Object.assign(desktopError(readOperations.has(operation) ? 'DESKTOP_READ_INTERRUPTED' : 'DESKTOP_OUTCOME_UNKNOWN'), {
    details: { operation, ...(readOperations.has(operation) ? { inputDispatched: false } : {}) }
  });
}
export function desktopExecutable(): string {
  const packaged = path.join(process.resourcesPath || '', 'native', 'ProfilePilot.Desktop.exe');
  return existsSync(packaged) ? packaged : path.resolve(__dirname, '../../native/ProfilePilot.Desktop.exe');
}
export class DesktopWorker implements DesktopDriver {
  // An observer hint, never an authentication token. Keep it stable across this
  // helper's actions and cleanup so releases remain identifiable after pause.
  readonly inputMarker = (() => { let marker: string; do { marker = randomBytes(8).toString('hex'); } while (marker === '0000000000000000'); return marker; })();
  private static retiring = new Set<Promise<void>>();
  private process?: ChildProcessWithoutNullStreams;
  private pending?: { id: string; operation: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private buffer = '';
  private closed = false;
  private spawnFailed = false;
  private stopPromise?: Promise<void>;
  private retirementConfirmed = false;
  get stopConfirmed(): boolean { return this.retirementConfirmed; }
  constructor(private executable = desktopExecutable(), private spawnProcess: typeof spawn = spawn) {}
  async request(operation: string, params: Record<string, unknown>): Promise<any> {
    // A replacement helper must not inject while an older helper is unwinding
    // its mouse/key releases after cancellation.
    // A helper may start retiring while an earlier barrier is awaited. Recheck
    // the set after every wait; an empty set must not introduce a yield between
    // confirming it and dispatching the request.
    while (DesktopWorker.retiring.size) await Promise.all(DesktopWorker.retiring);
    if (this.closed) throw readOperations.has(operation) ? interrupted(operation) : desktopError('DESKTOP_SESSION_ENDED', '桌面驱动已停止，请重新检查控制权。');
    if (this.pending) throw desktopError('DESKTOP_BUSY', '上一次桌面操作仍在进行。');
    if (!this.process) {
      if (!existsSync(this.executable)) throw desktopError('DESKTOP_HELPER_MISSING', '缺少桌面控制组件，请更新 ProfilePilot。');
      // Windows locks running executables. A content-addressed runtime copy lets
      // the next build/update replace its bundled helper without killing sessions.
      const executable = nativeRuntimeCopy(this.executable, 'profilepilot-desktop-runtime');
      const child = this.process = this.spawnProcess(executable, ['--input-marker', this.inputMarker], { windowsHide: true, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
      // Install process handlers before touching streams: failed spawns may not
      // provide pipes, and their first error is the evidence that no PID exists.
      child.on('error', () => {
        if (child.pid === undefined) this.spawnFailed = true;
        if (this.process === child) this.fail();
      });
      child.on('exit', () => {
        if (this.process !== child) return;
        // exit confirms process retirement, but stdout can still contain its
        // final reply. Stop accepting requests and drain until end/close.
        this.closed = true; this.retirementConfirmed = true;
        if (!this.pending) this.close();
      });
      child.on('close', () => { if (this.process === child) this.fail(); });
      // A failed spawn may expose only some streams. Those streams can still
      // emit errors after rejection; install handlers before the pipe check.
      for (const stream of [child.stdin, child.stderr, child.stdout]) {
        stream?.on('error', () => { if (this.process === child) this.fail(); });
      }
      if (!child.stdout || !child.stdin || !child.stderr) {
        this.spawnFailed = child.pid === undefined;
        this.fail();
        throw interrupted(operation);
      }
      child.stdout.setEncoding('utf8');
      child.stderr.resume();
      child.stdout.on('end', () => { if (this.process === child) this.fail(); });
      child.stdout.on('close', () => { if (this.process === child) this.fail(); });
      child.stdout.on('data', (chunk: string) => {
        if (this.process !== child) return;
        if (!this.pending) { this.fail(); return; }
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(); return; }
        for (;;) {
          const newline = this.buffer.indexOf('\n');
          if (newline < 0) {
            // With only one request in flight, trailing bytes after its reply
            // are unsolicited too. Never carry them into a later request.
            if (!this.pending && (this.buffer.length || this.closed)) this.fail();
            return;
          }
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
          try {
            const reply = JSON.parse(line), pending = this.pending;
            if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !pending || reply.id !== pending.id || typeof reply.ok !== 'boolean'
              || (reply.ok ? !Object.prototype.hasOwnProperty.call(reply, 'result') : typeof reply.code !== 'string' || !/^DESKTOP_[A-Z0-9_]{1,80}$/.test(reply.code))) {
              this.fail(); return;
            }
            clearTimeout(pending.timer); this.pending = undefined;
            if (reply.ok) pending.resolve(reply.result);
            else pending.reject(Object.assign(desktopError(reply.code), {
              cause: reply.cause,
              ...(reply.cause || reply.diagnostics ? { details: { cause: reply.cause, diagnostics: reply.diagnostics } } : {})
            }));
          } catch { this.fail(); return; }
        }
      });
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending = { id, operation, resolve, reject, timer: setTimeout(() => this.fail(), 12_000) };
      try { this.process!.stdin.write(JSON.stringify({ id, operation, params }) + '\n'); }
      catch { this.fail(); }
    });
  }
  private fail(): void { void this.close(); }
  close(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const retired = this.stopPromise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Cancellation callers may intentionally remain synchronous. Keep the
    // original rejection observable to shutdown without an unhandled promise.
    void retired.catch(() => {});
    this.closed = true;
    const child = this.process; this.process = undefined; this.buffer = '';
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(interrupted(pending.operation)); }
    if (!child || this.spawnFailed || child.exitCode !== null || child.signalCode !== null) {
      this.retirementConfirmed = true; resolve(); return retired;
    }
    DesktopWorker.retiring.add(retired);
    // A failed termination must keep later drivers blocked. An error event may
    // mean EPERM while the process is still alive; only exit proves retirement.
    let confirmation: NodeJS.Timeout | undefined;
    let killAttempted = false, killAccepted: boolean | null = null, cancelWriteFailed = false;
    const unconfirmed = (reason: 'exit_timeout' | 'kill_rejected' | 'kill_error' | 'process_error', error?: unknown) => {
      const code = (error as any)?.code;
      reject(Object.assign(desktopError('DESKTOP_DRIVER_STOP_UNCONFIRMED', '尚未确认旧桌面驱动退出，已阻止新的桌面操作。请检查控制状态。'), {
        details: { stop: { pid: Number.isSafeInteger(child.pid) ? child.pid : null, reason, killAttempted, killAccepted, cancelWriteFailed,
          ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}) } }
      }));
    };
    const kill = () => {
      confirmation = setTimeout(() => unconfirmed('exit_timeout'), 750);
      killAttempted = true;
      try { killAccepted = child.kill(); if (!killAccepted) unconfirmed('kill_rejected'); } catch (error) { unconfirmed('kill_error', error); }
    };
    const timer = setTimeout(kill, 750);
    const exited = () => {
      clearTimeout(timer); if (confirmation) clearTimeout(confirmation);
      this.retirementConfirmed = true; DesktopWorker.retiring.delete(retired); resolve();
    };
    child.once('exit', exited);
    child.once('close', exited);
    child.on('error', error => { if (child.pid === undefined) exited(); else unconfirmed('process_error', error); });
    // The native stdin reader cancels even while its main thread is applying
    // input. Let its finally blocks release held input before forced exit.
    try { child.stdin.end(JSON.stringify({ operation: 'cancel' }) + '\n'); }
    catch { cancelWriteFailed = true; clearTimeout(timer); kill(); }
    return retired;
  }
}
