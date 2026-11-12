import { randomUUID } from 'node:crypto';
import { backgroundTargetSchema, sameBackgroundTarget, type BackgroundTarget } from './input-observer';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { parseInputGuardOutputLine } from '../input-guard';
import { desktopErrorMessage } from './errors';
import { DesktopInputObserver, inputObserverMessageSchema, inputObserverStartupFailureSchema, describeInputObserverStartupFailure,
  type InputObserverStartupFailure, type DesktopObserverSubscription, type InputObserverCommand,
  type InputObserverPause, type InputObserverPauseReason } from './input-observer';

// Shared Windows transport, injected by input-runtime. Callers must arm with
// their actual DesktopDriver.inputMarker, not an
// independently generated value. Collection backend/provenance is not proven by
// this protocol handshake. Existing macOS Input Guard behavior is untouched.
export interface InputBrokerChild extends EventEmitter {
  stdin: Writable; stdout: Readable; stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface InputBrokerClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export type LegacyInputGuardMessage = NonNullable<ReturnType<typeof parseInputGuardOutputLine>>;
export interface InputBrokerStatus {
  state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'unavailable';
  epoch: string | null;
  reason?: InputObserverPauseReason | 'stop_unconfirmed';
  startupFailure?: InputObserverStartupFailure;
}
export interface InputBrokerBrowserProtection {
  epoch: string | null;
  // A completed SET proves only these PIDs in this epoch. Pending additions
  // are not protected merely because the transport or another PID is healthy.
  verified: boolean;
  activePids: number[];
  pendingConfigurations: number;
}
export interface InputBrokerBrowserCallbacks {
  // Sanitized legacy mouse/status messages, not synthesized clicks. An adapter
  // can reuse the existing click pairing algorithm. Global sync-complete counts
  // describe the union PID set; they are not a per-subscriber health guarantee.
  onLegacyMessage?(message: LegacyInputGuardMessage): void;
  onStatus?(status: InputBrokerStatus): void;
  onProtection?(snapshot: InputBrokerBrowserProtection): void;
}
export interface InputBrokerBrowser {
  sync(pids: number[]): void;
  dispose(): void;
}
export interface WindowsInputBrokerOptions {
  spawn(): InputBrokerChild;
  onPause(event: InputObserverPause): void;
  clock?: InputBrokerClock;
  createEpoch?(): string;
  startupTimeoutMs?: number; armTimeoutMs?: number; drainTimeoutMs?: number;
  browserConfigTimeoutMs?: number;
  stopTimeoutMs?: number; killTimeoutMs?: number; restartDelayMs?: number;
}
interface BrowserEntry { pids: number[]; callbacks: InputBrokerBrowserCallbacks; }
interface ArmRequest {
  backgroundTarget?: BackgroundTarget;
  generation: string; marker: string; epoch?: string; sent: boolean; transmitted: boolean;
  promise: Promise<DesktopObserverSubscription>;
  resolve(value: DesktopObserverSubscription): void; reject(error: Error): void;
  timer?: unknown;
}
interface ChildState {
  process: InputBrokerChild; epoch: string; phase: 'starting' | 'ready' | 'stopping';
  buffer: Buffer; queue: Array<{ text: string; command: InputObserverCommand }>; queuedBytes: number; blocked: boolean; writing: boolean;
  startupTimer?: unknown; drainTimer?: unknown; stopTimer?: unknown; killTimer?: unknown;
  exitSeen?: boolean;
  failure?: { reason: InputObserverPauseReason; startupFailure?: InputObserverStartupFailure };
}
const MAX_LINE_BYTES = 2048, MAX_CHUNK_BYTES = 65536, MAX_WRITE_BYTES = 8192;
const MAX_BROWSERS = 32, MAX_PIDS = 256;
const LEGACY_STATUSES = new Set(['ready', 'hook-create-failed', 'invalid-command', 'invalid-pid',
  'tap-active', 'tap-removed', 'tap-create-failed', 'sync-complete', 'tap-disabled', 'tap-reenabled']);
const DESKTOP_TYPES = new Set(['desktop-armed', 'input-activity', 'observer-fault']);
const validIdentity = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(value);
function fault(reason: string, code = 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE'): Error {
  return Object.assign(new Error('Desktop input observer is unavailable: ' + reason), { code, reason });
}
function startupFault(failure: InputObserverStartupFailure): Error {
  const { reason, code } = describeInputObserverStartupFailure(failure);
  return Object.assign(new Error(desktopErrorMessage(code)), { code, reason,
    details: { inputObserver: { stage: failure.stage, win32Error: failure.win32Error } } });
}
function normalizeMarker(marker: string): string {
  if (typeof marker !== 'string' || !/^[a-fA-F0-9]{1,16}$/.test(marker) || BigInt('0x' + marker) === 0n) throw fault('invalid_marker', 'DESKTOP_BAD_REQUEST');
  return marker.toLowerCase().padStart(16, '0');
}

export class WindowsInputBroker {
  private readonly observer: DesktopInputObserver;
  private readonly clock: InputBrokerClock;
  private readonly timing: Required<Pick<WindowsInputBrokerOptions, 'startupTimeoutMs' | 'armTimeoutMs' | 'drainTimeoutMs' | 'browserConfigTimeoutMs' | 'stopTimeoutMs' | 'killTimeoutMs' | 'restartDelayMs'>>;
  private readonly browsers = new Map<string, BrowserEntry>();
  private readonly generations = new Map<string, string>();
  private readonly epochs = new Set<string>();
  private child: ChildState | null = null;
  private pendingArm: ArmRequest | null = null;
  private desktopWanted = false;
  private closed = false;
  private stopUnconfirmed = false;
  private restartTimer?: unknown;
  private transportStatus: InputBrokerStatus = { state: 'stopped', epoch: null };
  private readonly browserCandidates = new Set<number>();
  private readonly browserConfirmed = new Set<number>();
  private readonly browserConfigurations: Array<{ pids: number[]; revision: string; timer?: unknown }> = [];
  private browserVerified = false;
  private browserRefreshRevision = 0n;
  private disposePromise?: Promise<void>;
  private disposeResolve?: () => void;
  private disposeReject?: (error: Error) => void;

  constructor(private readonly options: WindowsInputBrokerOptions) {
    if (typeof options.spawn !== 'function' || typeof options.onPause !== 'function') throw new Error('Explicit spawn and onPause providers are required.');
    this.clock = options.clock || {
      setTimeout(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; },
      clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); }
    };
    this.timing = { startupTimeoutMs: options.startupTimeoutMs ?? 2000, armTimeoutMs: options.armTimeoutMs ?? 2000,
      browserConfigTimeoutMs: options.browserConfigTimeoutMs ?? 2000,
      drainTimeoutMs: options.drainTimeoutMs ?? 1000, stopTimeoutMs: options.stopTimeoutMs ?? 750,
      killTimeoutMs: options.killTimeoutMs ?? 750, restartDelayMs: options.restartDelayMs ?? 1000 };
    for (const value of Object.values(this.timing)) if (!Number.isSafeInteger(value) || value < 1 || value > 30000) throw new Error('Input broker deadlines must be 1..30000 ms.');
    this.observer = new DesktopInputObserver({ send: command => this.send(command), onPause: event => this.onObserverPause(event) });
  }

  snapshot() {
    return { transport: this.copyStatus(), stopConfirmed: this.child === null && !this.stopUnconfirmed,
      ...this.observer.snapshot(), pendingGeneration: this.pendingArm?.generation ?? null, browserProtection: this.protection() };
  }
  browser(id: string, callbacks: InputBrokerBrowserCallbacks = {}): InputBrokerBrowser {
    this.assertOpen();
    if (!validIdentity(id) || this.browsers.has(id) || this.browsers.size >= MAX_BROWSERS) throw fault('invalid_browser_subscription', 'DESKTOP_BAD_REQUEST');
    const entry: BrowserEntry = { pids: [], callbacks }; this.browsers.set(id, entry);
    let disposed = false;
    return {
      sync: pids => {
        this.assertOpen(); if (disposed) throw fault('browser_subscription_disposed');
        if (!Array.isArray(pids) || pids.length > MAX_PIDS || pids.some(pid => !Number.isInteger(pid) || pid < 1 || pid > 0xffffffff)) throw fault('invalid_browser_pids', 'DESKTOP_BAD_REQUEST');
        const next = [...new Set(pids)].sort((a, b) => a - b);
        const union = new Set([...this.browsers].flatMap(([key, value]) => key === id ? next : value.pids));
        if (union.size > MAX_PIDS) throw fault('browser_pid_union_limit', 'DESKTOP_BAD_REQUEST');
        const unchanged = next.length === entry.pids.length && next.every((pid, index) => pid === entry.pids[index]);
        entry.pids = next; this.observer.setBrowserSubscription(id, next); this.reconcile();
        // Preserve legacy health retry: a PID that failed creation may become
        // available later even though this subscriber's desired set is unchanged.
        const record = this.child;
        if (unchanged && next.length && record?.phase === 'ready') this.send({ type: 'browser-config', epoch: record.epoch,
          revision: 'refresh-' + ++this.browserRefreshRevision, pids: this.observer.snapshot().browserPids });
      },
      dispose: () => {
        if (disposed) return; disposed = true;
        this.browsers.delete(id); this.observer.removeBrowserSubscription(id); this.reconcile();
      }
    };
  }
  arm(generation: string, marker: string, backgroundTarget?: BackgroundTarget): Promise<DesktopObserverSubscription> {
    try { this.assertOpen(); if (!validIdentity(generation)) throw fault('invalid_generation', 'DESKTOP_BAD_REQUEST'); marker = normalizeMarker(marker); if (backgroundTarget) backgroundTarget = backgroundTargetSchema.parse(backgroundTarget); }
    catch (error) { return Promise.reject(error); }
    if (this.pendingArm?.generation === generation && this.pendingArm.marker === marker && sameBackgroundTarget(this.pendingArm.backgroundTarget, backgroundTarget)) return this.pendingArm.promise;
    if (this.pendingArm) return Promise.reject(fault('arm_in_progress', 'DESKTOP_INPUT_OBSERVER_BUSY'));
    const current = this.observer.snapshot().desktop;
    if (this.generations.has(generation)) {
      if (current?.generation === generation && current.phase === 'ready' && this.generations.get(generation) === marker && sameBackgroundTarget(current.backgroundTarget, backgroundTarget) && this.desktopWanted) return Promise.resolve(current);
      return Promise.reject(fault('generation_cannot_be_reused', 'DESKTOP_BAD_REQUEST'));
    }
    // Keep a ready predecessor armed. The observer emits REARM so native can
    // reject the transition if input has already latched the old generation.
    if (current && current.phase !== 'ready') this.observer.stopDesktop(current.generation);
    let resolve!: ArmRequest['resolve'], reject!: ArmRequest['reject'];
    const promise = new Promise<DesktopObserverSubscription>((yes, no) => { resolve = yes; reject = no; });
    this.generations.set(generation, marker); this.desktopWanted = true;
    this.pendingArm = { generation, marker, backgroundTarget, promise, resolve, reject, sent: false, transmitted: false };
    this.reconcile(); this.startArm();
    return promise;
  }
  disarm(generation: string): void {
    if (this.pendingArm?.generation === generation) {
      this.desktopWanted = false; this.rejectArm(fault('disarmed', 'DESKTOP_INPUT_OBSERVER_CANCELLED'));
    }
    if (this.observer.snapshot().desktop?.generation === generation) {
      this.desktopWanted = false; this.observer.stopDesktop(generation);
    }
    this.reconcile();
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true; this.clearRestart(); this.desktopWanted = false;
    this.rejectArm(fault('disposed', 'DESKTOP_INPUT_OBSERVER_CANCELLED'));
    const desktop = this.observer.snapshot().desktop;
    if (desktop) this.observer.stopDesktop(desktop.generation);
    this.disposePromise = new Promise<void>((resolve, reject) => { this.disposeResolve = resolve; this.disposeReject = reject; });
    if (this.stopUnconfirmed) this.disposeReject!(fault('stop_unconfirmed', 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED'));
    else if (this.child) this.retire(this.child);
    else this.disposeResolve!();
    return this.disposePromise;
  }

  private assertOpen() {
    if (this.closed) throw fault('disposed');
    if (this.stopUnconfirmed) throw fault('stop_unconfirmed', 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED');
  }
  private hasBrowsers() { return [...this.browsers.values()].some(entry => entry.pids.length > 0); }
  private wanted() { return !this.closed && (this.hasBrowsers() || this.desktopWanted); }
  private clearTimer(handle: unknown) { if (handle !== undefined) this.clock.clearTimeout(handle); }
  private clearRestart() { this.clearTimer(this.restartTimer); this.restartTimer = undefined; }
  private status(status: InputBrokerStatus) {
    const failure = this.child?.epoch === status.epoch ? this.child.failure : undefined;
    if (failure) status = { ...status, reason: status.reason || failure.reason,
      ...(failure.startupFailure ? { startupFailure: { ...failure.startupFailure } } : {}) };
    this.transportStatus = status;
    if (status.state !== 'ready') {
      for (const config of this.browserConfigurations) this.clearTimer(config.timer);
      this.browserCandidates.clear(); this.browserConfirmed.clear(); this.browserConfigurations.length = 0; this.browserVerified = false;
    }
    this.notifyProtection();
    for (const entry of this.browsers.values()) try { entry.callbacks.onStatus?.(this.copyStatus()); } catch { /* Consumer exceptions cannot interrupt cleanup. */ }
  }
  private copyStatus(): InputBrokerStatus {
    return { ...this.transportStatus, ...(this.transportStatus.startupFailure ? { startupFailure: { ...this.transportStatus.startupFailure } } : {}) };
  }
  private protection(): InputBrokerBrowserProtection {
    return { epoch: this.transportStatus.epoch, verified: this.browserVerified && this.child?.phase === 'ready' && !this.stopUnconfirmed,
      activePids: [...this.browserConfirmed].sort((a, b) => a - b),
      pendingConfigurations: this.browserConfigurations.length + (this.child?.queue.filter(item => item.command.type === 'browser-config').length || 0) };
  }
  private notifyProtection() {
    for (const entry of this.browsers.values()) try { entry.callbacks.onProtection?.(this.protection()); } catch { /* Subscriber errors do not alter shared evidence. */ }
  }
  private updateProtection(record: ChildState, message: LegacyInputGuardMessage) {
    if (message.type !== 'status') return;
    const pending = this.browserConfigurations[0];
    if (message.status === 'tap-active' || message.status === 'tap-reenabled') {
      if (message.pid && pending?.pids.includes(message.pid)) this.browserCandidates.add(message.pid);
    } else if (['tap-removed', 'tap-create-failed', 'tap-disabled'].includes(message.status)) {
      if (message.pid) { this.browserCandidates.delete(message.pid); this.browserConfirmed.delete(message.pid); }
      else { this.browserCandidates.clear(); this.browserConfirmed.clear(); this.browserVerified = false; }
      this.notifyProtection();
    } else if (message.status === 'sync-complete') {
      if (!pending || message.activeCount !== this.browserCandidates.size || [...this.browserCandidates].some(pid => !pending.pids.includes(pid))) {
        this.fail(record, 'protocol_error'); return;
      }
      this.browserConfigurations.shift(); this.clearTimer(pending.timer); this.browserVerified = true;
      this.browserConfirmed.clear();
      for (const pid of this.browserCandidates) {
        // Later sent/queued removals revoke the earlier receipt immediately.
        const pendingRemoval = this.browserConfigurations.some(config => !config.pids.includes(pid))
          || record.queue.some(item => item.command.type === 'browser-config' && !item.command.pids.includes(pid));
        if (!pendingRemoval) this.browserConfirmed.add(pid);
      }
      // Commit before legacy sync-complete reaches any adapter.
      this.notifyProtection();
    }
  }
  private reconcile() {
    if (!this.wanted()) {
      this.clearRestart(); if (this.child && this.child.phase !== 'stopping') this.retire(this.child); return;
    }
    if (this.stopUnconfirmed || this.child || this.restartTimer !== undefined) return;
    this.spawn();
  }
  private spawn() {
    let epoch: string;
    try {
      epoch = (this.options.createEpoch || randomUUID)();
      if (!validIdentity(epoch) || this.epochs.has(epoch)) throw new Error('Invalid or repeated epoch');
      this.epochs.add(epoch);
    } catch {
      this.pausePending('unavailable', 'unallocated'); this.status({ state: 'unavailable', epoch: null, reason: 'unavailable' }); this.restartBrowsers(); return;
    }
    if (this.pendingArm) this.pendingArm.epoch = epoch;
    let process: InputBrokerChild;
    try { process = this.options.spawn(); }
    catch {
      this.pausePending('unavailable', epoch); this.status({ state: 'unavailable', epoch, reason: 'unavailable' }); this.restartBrowsers(); return;
    }
    const record: ChildState = { process, epoch, phase: 'starting', buffer: Buffer.alloc(0), queue: [], queuedBytes: 0, blocked: false, writing: false };
    this.child = record;
    // Failed spawns can still return a ChildProcess and emit error/close later.
    // Observe its lifetime before touching possibly absent stdio pipes.
    process.on('error', () => { if (!record.exitSeen) this.fail(record, 'unavailable'); });
    process.on('exit', () => {
      record.exitSeen = true;
      // Node exit can precede stdout's last data/end. Only startup diagnostics
      // may still arrive; the original startup deadline bounds this wait.
      if (record.phase !== 'starting') this.fail(record, 'helper_exited');
    });
    process.on('close', () => this.stopped(record));
    for (const pipe of [process.stdin, process.stdout, process.stderr]) {
      if (typeof pipe?.on === 'function') pipe.on('error', () => {
        if (record.exitSeen && record.phase === 'starting' && pipe !== process.stdout) return;
        this.fail(record, pipe === process.stdin ? 'send_failed' : 'disconnected');
      });
    }
    if (!process.stdin || typeof process.stdin.on !== 'function' || typeof process.stdin.write !== 'function' || typeof process.stdin.end !== 'function'
      || !process.stdout || typeof process.stdout.on !== 'function' || !process.stderr || typeof process.stderr.on !== 'function') {
      this.fail(record, 'unavailable'); return;
    }
    process.stdout.on('data', chunk => this.read(record, chunk));
    const outputEnded = () => { if (this.live(record)) this.fail(record, record.exitSeen ? 'helper_exited' : 'disconnected'); };
    process.stdout.on('end', outputEnded);
    process.stdout.on('close', outputEnded);
    process.stderr.on('data', () => {}); // Drain without retaining potentially sensitive output.
    process.stdin.on('close', () => { if (this.live(record) && !(record.exitSeen && record.phase === 'starting')) this.fail(record, 'send_failed'); });
    process.stdin.on('drain', () => {
      if (!this.live(record)) return;
      record.blocked = false; this.clearTimer(record.drainTimer); record.drainTimer = undefined; this.flush(record);
    });
    this.status({ state: 'starting', epoch });
    if (this.live(record) && record.phase === 'starting') record.startupTimer = this.clock.setTimeout(() => this.fail(record, record.exitSeen ? 'helper_exited' : 'unavailable'), this.timing.startupTimeoutMs);
  }
  private live(record: ChildState) { return this.child === record && record.phase !== 'stopping' && !this.stopUnconfirmed; }
  private startArm() {
    const request = this.pendingArm, record = this.child;
    if (!request || request.sent || !record || record.exitSeen || record.phase !== 'ready' || !this.desktopWanted) return;
    request.epoch = record.epoch; request.sent = true;
    request.timer = this.clock.setTimeout(() => {
      if (this.pendingArm === request) this.fail(record, 'unavailable');
    }, this.timing.armTimeoutMs);
    try { this.observer.observeDesktop(request.generation, request.marker, request.backgroundTarget); }
    catch { this.fail(record, 'unavailable'); }
  }
  private rejectArm(error: Error) {
    const request = this.pendingArm; if (!request) return;
    this.pendingArm = null; this.clearTimer(request.timer); request.reject(error);
  }
  private pausePending(reason: InputObserverPauseReason, epoch: string, startupFailure?: InputObserverStartupFailure) {
    const request = this.pendingArm; if (!request) return;
    const event: InputObserverPause = { epoch, generation: request.generation, reason, certainty: 'unknown',
      ...(startupFailure ? { startupFailure: { ...startupFailure } } : {}) };
    this.desktopWanted = false; this.rejectArm(startupFailure ? startupFault(startupFailure) : fault(reason));
    try { this.options.onPause({ ...event }); } catch { /* Keep transport cleanup independent. */ }
  }
  private onObserverPause(event: InputObserverPause) {
    this.desktopWanted = false;
    if (this.pendingArm?.generation === event.generation) this.rejectArm(fault(event.reason));
    try { this.options.onPause({ ...event }); } catch { /* Keep transport cleanup independent. */ }
    const record = this.child;
    if (record && this.live(record) && record.epoch === event.epoch) {
      if (event.certainty === 'unknown') this.retire(record);
      else {
        try { this.send({ type: 'desktop-disarm', epoch: event.epoch, generation: event.generation }); } catch { this.fail(record, 'send_failed'); }
        this.reconcile();
      }
    }
  }
  private send(command: InputObserverCommand) {
    const record = this.child;
    if (!record || record.exitSeen || !this.live(record) || record.phase !== 'ready' || record.epoch !== command.epoch) throw fault('send_failed');
    const scope = (command.type === 'desktop-arm' || command.type === 'desktop-rearm') && command.backgroundTarget
      ? ` BACKGROUND ${command.backgroundTarget.pid} ${command.backgroundTarget.window}` : '';
    const text = command.type === 'browser-config' ? 'SET' + (command.pids.length ? ' ' + command.pids.join(' ') : '') + '\n'
      : command.type === 'desktop-arm' ? `ARM ${command.epoch} ${command.generation} ${command.marker}${scope}\n`
        : command.type === 'desktop-rearm' ? `REARM ${command.epoch} ${command.previousGeneration} ${command.generation} ${command.marker}${scope}\n`
        : `DISARM ${command.epoch} ${command.generation}\n`;
    if (record.queuedBytes + record.process.stdin.writableLength + Buffer.byteLength(text) > MAX_WRITE_BYTES) {
      this.fail(record, 'overflow'); throw fault('send_failed');
    }
    if (command.type === 'browser-config') {
      if (this.browserConfigurations.length + record.queue.filter(item => item.command.type === 'browser-config').length >= 64) {
        this.fail(record, 'overflow'); throw fault('send_failed');
      }
      for (const pid of this.browserConfirmed) if (!command.pids.includes(pid)) this.browserConfirmed.delete(pid);
    }
    record.queue.push({ text, command }); record.queuedBytes += Buffer.byteLength(text);
    if (command.type === 'browser-config') this.notifyProtection();
    this.flush(record);
  }
  private flush(record: ChildState) {
    if (!this.live(record) || record.exitSeen || record.blocked || record.writing) return;
    record.writing = true;
    try {
      while (record.queue.length && this.live(record) && !record.exitSeen && !record.blocked) {
        const { text, command } = record.queue.shift()!; record.queuedBytes -= Buffer.byteLength(text);
        if (record.process.stdin.destroyed || !record.process.stdin.writable) { this.fail(record, 'send_failed'); return; }
        if (command.type === 'browser-config') {
          const config: typeof this.browserConfigurations[number] = { pids: [...command.pids], revision: command.revision };
          this.browserConfigurations.push(config);
          config.timer = this.clock.setTimeout(() => {
            if (this.live(record) && this.browserConfigurations.includes(config)) this.fail(record, 'unavailable');
          }, this.timing.browserConfigTimeoutMs);
        }
        let accepted: boolean;
        try { accepted = record.process.stdin.write(text, 'utf8', error => { if (error) this.fail(record, 'send_failed'); }); }
        catch { this.fail(record, 'send_failed'); return; }
        if ((command.type === 'desktop-arm' || command.type === 'desktop-rearm') && this.pendingArm?.generation === command.generation && this.live(record)) this.pendingArm.transmitted = true;
        if (!accepted && this.live(record)) {
          record.blocked = true;
          record.drainTimer = this.clock.setTimeout(() => this.fail(record, 'send_failed'), this.timing.drainTimeoutMs);
        }
      }
    } finally { record.writing = false; }
  }
  private read(record: ChildState, value: Buffer | string) {
    if (!this.live(record)) return;
    if (!(Buffer.isBuffer(value) || typeof value === 'string') || Buffer.byteLength(value) > MAX_CHUNK_BYTES) { this.fail(record, 'overflow'); return; }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length && this.live(record)) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      if (record.buffer.length + end - start > MAX_LINE_BYTES) { this.fail(record, 'overflow'); return; }
      record.buffer = Buffer.concat([record.buffer, chunk.subarray(start, end)]);
      if (newline < 0) return;
      let line: string;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(record.buffer); }
      catch { this.fail(record, 'protocol_error'); return; }
      record.buffer = Buffer.alloc(0); start = newline + 1;
      this.line(record, line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }
  private line(record: ChildState, line: string) {
    let value: any;
    try { value = JSON.parse(line); } catch { this.fail(record, 'protocol_error'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.fail(record, 'protocol_error'); return; }
    if (value.type === 'startup-failure') {
      const parsed = inputObserverStartupFailureSchema.safeParse(value);
      if (record.phase !== 'starting' || !parsed.success) { this.fail(record, 'protocol_error'); return; }
      this.fail(record, describeInputObserverStartupFailure(parsed.data).reason, parsed.data); return;
    }
    if (DESKTOP_TYPES.has(value.type)) {
      if (record.phase !== 'ready') { this.fail(record, 'protocol_error'); return; }
      const previous = this.observer.snapshot().desktop;
      const stale = typeof value.epoch === 'string' && value.epoch !== record.epoch
        || previous && typeof value.generation === 'string' && value.generation !== previous.generation
          && !(previous.phase === 'arming' && value.generation === previous.previousGeneration);
      if (stale) return;
      if (!inputObserverMessageSchema.safeParse(value).success) { this.fail(record, 'protocol_error'); return; }
      const pending = this.pendingArm;
      if (value.type === 'desktop-armed' && pending && pending.generation === value.generation && value.epoch === record.epoch && !pending.transmitted) { this.fail(record, 'protocol_error'); return; }
      this.observer.receive(record.epoch, value);
      const desktop = this.observer.snapshot().desktop, request = this.pendingArm;
      if (request && desktop?.phase === 'ready' && desktop.epoch === record.epoch && desktop.generation === request.generation) {
        this.pendingArm = null; this.clearTimer(request.timer); request.resolve(desktop);
      }
      return;
    }
    const legacy = parseInputGuardOutputLine(line);
    if (!legacy || legacy.type === 'status' && !LEGACY_STATUSES.has(legacy.status)) { this.fail(record, 'protocol_error'); return; }
    if (legacy.type === 'status' && ['hook-create-failed', 'invalid-command', 'invalid-pid', 'tap-disabled'].includes(legacy.status)) {
      this.browserConfirmed.clear(); this.browserVerified = false; this.notifyProtection();
      this.deliverLegacy(legacy); this.fail(record, 'unavailable'); return;
    }
    if (legacy.type === 'status' && legacy.status === 'ready') {
      if (record.phase !== 'starting') { this.fail(record, 'protocol_error'); return; }
      if (record.exitSeen) { this.fail(record, 'helper_exited'); return; }
      this.clearTimer(record.startupTimer); record.startupTimer = undefined; record.phase = 'ready';
      this.observer.connect(record.epoch);
      if (!this.live(record)) return;
      this.status({ state: 'ready', epoch: record.epoch }); this.startArm();
    } else if (record.phase !== 'ready') { this.fail(record, 'protocol_error'); return; }
    if (!this.live(record)) return;
    this.updateProtection(record, legacy);
    if (!this.live(record)) return;
    this.deliverLegacy(legacy);
  }
  private deliverLegacy(legacy: LegacyInputGuardMessage) {
    for (const entry of this.browsers.values()) {
      if (legacy.type === 'mouse' && !entry.pids.includes(legacy.pid)) continue;
      if (legacy.type === 'status' && legacy.pid && !entry.pids.includes(legacy.pid)) continue;
      const copy = legacy.type === 'mouse' ? { ...legacy, window: legacy.window ? { ...legacy.window } : null } : { ...legacy };
      try { entry.callbacks.onLegacyMessage?.(copy); } catch { /* An adapter cannot break another subscriber. */ }
    }
  }
  private fail(record: ChildState, reason: InputObserverPauseReason, startupFailure?: InputObserverStartupFailure) {
    if (!this.live(record)) return;
    record.failure ??= { reason, ...(startupFailure ? { startupFailure: { ...startupFailure } } : {}) };
    this.status({ state: 'unavailable', epoch: record.epoch, reason });
    const state = this.observer.snapshot().desktop;
    if (state && state.epoch === record.epoch && state.phase !== 'paused') {
      if (reason === 'protocol_error') this.observer.receive(record.epoch, {});
      else if (reason === 'overflow' || reason === 'unavailable') this.observer.receive(record.epoch, { type: 'observer-fault', epoch: record.epoch, generation: state.generation, reason });
      else this.observer.disconnect(record.epoch, reason === 'helper_exited' ? 'helper_exited' : 'disconnected');
    }
    this.pausePending(reason, record.epoch, startupFailure); this.retire(record);
  }
  private retire(record: ChildState) {
    if (this.child !== record || record.phase === 'stopping') return;
    const wasReady = record.phase === 'ready';
    record.phase = 'stopping'; this.clearTimer(record.startupTimer); this.clearTimer(record.drainTimer);
    record.queue = []; record.queuedBytes = 0; record.buffer = Buffer.alloc(0);
    this.observer.disconnect(record.epoch);
    this.status({ state: 'stopping', epoch: record.epoch });
    record.stopTimer = this.clock.setTimeout(() => this.kill(record), this.timing.stopTimeoutMs);
    try { if (record.process.stdin.destroyed || !record.process.stdin.writable) this.kill(record);
      else record.process.stdin.end(record.exitSeen ? undefined : wasReady ? 'SET\nQUIT\n' : 'QUIT\n'); }
    catch { this.kill(record); }
  }
  private kill(record: ChildState) {
    if (this.child !== record || record.killTimer !== undefined) return;
    this.clearTimer(record.stopTimer); record.stopTimer = undefined;
    try { if (!record.exitSeen) record.process.kill(); } catch { /* Only close confirms retirement. */ }
    if (this.child !== record) return;
    record.killTimer = this.clock.setTimeout(() => {
      if (this.child !== record) return;
      this.stopUnconfirmed = true; this.clearRestart();
      this.pausePending('unavailable', record.epoch);
      this.status({ state: 'unavailable', epoch: record.epoch, reason: 'stop_unconfirmed' });
      this.disposeReject?.(fault('stop_unconfirmed', 'DESKTOP_INPUT_OBSERVER_STOP_UNCONFIRMED'));
    }, this.timing.killTimeoutMs);
  }
  private stopped(record: ChildState) {
    if (this.child !== record) return;
    record.exitSeen = true;
    if (record.phase !== 'stopping') this.fail(record, 'helper_exited');
    for (const timer of [record.startupTimer, record.drainTimer, record.stopTimer, record.killTimer]) this.clearTimer(timer);
    this.observer.disconnect(record.epoch, 'helper_exited'); this.child = null;
    // A late close can confirm process death, but never silently clear a latched
    // stop failure or resume a desktop. A new broker lifetime is required.
    if (this.stopUnconfirmed) return;
    this.status({ state: 'stopped', epoch: record.epoch, ...(record.failure ? { reason: record.failure.reason,
      ...(record.failure.startupFailure ? { startupFailure: { ...record.failure.startupFailure } } : {}) } : {}) });
    if (this.closed) this.disposeResolve?.();
    else if (this.desktopWanted && this.pendingArm) this.reconcile();
    else this.restartBrowsers();
  }
  private restartBrowsers() {
    if (this.closed || this.stopUnconfirmed || this.child || !this.hasBrowsers() || this.restartTimer !== undefined) return;
    this.restartTimer = this.clock.setTimeout(() => { this.restartTimer = undefined; this.reconcile(); }, this.timing.restartDelayMs);
  }
}
