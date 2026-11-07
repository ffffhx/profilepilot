import { matchInputGuardClick, parseInputGuardOutputLine, type InputGuardCallbacks, type InputGuardController,
  type InputGuardMouseMessage, type InputGuardStatusMessage } from '../input-guard';
import type { WindowsInputBroker, InputBrokerBrowser, InputBrokerBrowserProtection, InputBrokerClock,
  InputBrokerStatus, LegacyInputGuardMessage } from './input-broker';

export interface WindowsBrowserInputGuardOptions extends InputGuardCallbacks {
  broker: Pick<WindowsInputBroker, 'browser' | 'snapshot'>;
  subscriptionId: string;
  clock?: InputBrokerClock;
  healthRetryMs?: number;
}

// Browser facade only. It neither starts a helper nor owns the shared broker.
// The App may inject it on Windows; omitting the factory keeps the macOS path.
export class WindowsBrowserInputGuard implements InputGuardController {
  private readonly subscription: InputBrokerBrowser;
  private readonly clock: InputBrokerClock;
  private readonly retryMs: number;
  private wanted: number[] = [];
  private readonly down = new Map<number, InputGuardMouseMessage>();
  private protection: InputBrokerBrowserProtection;
  private disposed = false;
  private retry?: unknown;
  private lastHealth?: string;

  constructor(private readonly options: WindowsBrowserInputGuardOptions) {
    this.clock = options.clock || {
      setTimeout(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; },
      clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); }
    };
    this.retryMs = options.healthRetryMs ?? 1500;
    if (!Number.isSafeInteger(this.retryMs) || this.retryMs < 1 || this.retryMs > 30000) throw new Error('Invalid browser input health retry.');
    this.protection = options.broker.snapshot().browserProtection;
    this.subscription = options.broker.browser(options.subscriptionId, {
      onLegacyMessage: message => this.legacy(message), onStatus: status => this.transport(status),
      onProtection: state => this.acceptProtection(state)
    });
  }
  sync(pids: number[]): void {
    if (this.disposed) return;
    // Preserve legacy normalization while allowing the broker to enforce the
    // aggregate 256-PID limit across subscribers before committing a new set.
    const next = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))].sort((a, b) => a - b);
    const previous = this.wanted; this.wanted = next; this.down.clear();
    try { this.subscription.sync(next); }
    catch (error) { this.wanted = previous; this.acceptProtection(this.options.broker.snapshot().browserProtection); throw error; }
    this.acceptProtection(this.options.broker.snapshot().browserProtection);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.wanted = []; this.down.clear(); this.clearRetry();
    this.subscription.dispose();
  }
  private transport(status: InputBrokerStatus) {
    if (this.disposed) return;
    if (status.state !== 'ready') { this.down.clear(); this.clearRetry(); }
    this.acceptProtection(this.options.broker.snapshot().browserProtection);
    if (this.wanted.length && (status.state === 'unavailable' || status.state === 'stopped')) this.report({ type: 'status', status: 'helper-exited', ...(status.reason ? { reason: status.reason } : {}) });
  }
  private acceptProtection(snapshot: InputBrokerBrowserProtection) {
    if (this.disposed) return;
    const previous = this.protection;
    this.protection = { ...snapshot, activePids: [...snapshot.activePids] };
    if (!snapshot.verified || previous.epoch !== snapshot.epoch) this.down.clear();
    else for (const pid of this.down.keys()) if (!snapshot.activePids.includes(pid)) this.down.delete(pid);
    // Legacy sync([]) reports no health failure: the overlay owns its separate
    // idle/starting presentation when there is no browser target to protect.
    if (!this.wanted.length) { this.lastHealth = undefined; this.clearRetry(); return; }
    const activeCount = this.wanted.filter(pid => snapshot.verified && snapshot.activePids.includes(pid)).length;
    const healthy = this.wanted.length > 0 && activeCount === this.wanted.length;
    const key = `${healthy}:${activeCount}:${this.wanted.length}:${snapshot.epoch}`;
    if (key !== this.lastHealth) {
      this.lastHealth = key;
      this.report({ type: 'status', status: healthy ? 'guard-active' : 'guard-unavailable', activeCount });
    }
    if (healthy || !this.wanted.length || snapshot.pendingConfigurations > 0 || this.options.broker.snapshot().transport.state !== 'ready') this.clearRetry();
    else this.scheduleRetry();
  }
  private legacy(value: LegacyInputGuardMessage) {
    if (this.disposed) return;
    // The broker validates messages; this also protects alternate injected test
    // providers and avoids retaining caller-owned mutable geometry objects.
    let message: ReturnType<typeof parseInputGuardOutputLine> = null;
    try { const line = JSON.stringify(value); if (Buffer.byteLength(line) <= 2048) message = parseInputGuardOutputLine(line); } catch { }
    if (!message) { this.down.clear(); return; }
    if (message.type === 'status') {
      if (message.pid && !this.wanted.includes(message.pid)) return;
      if (message.status === 'tap-removed' || message.status === 'tap-create-failed' || message.status === 'tap-disabled') {
        if (message.pid) this.down.delete(message.pid); else this.down.clear();
      }
      // This count is intentionally subscriber-local, never the union count.
      if (message.status === 'sync-complete') this.report({ ...message, activeCount: this.wanted.filter(pid => this.protection.verified && this.protection.activePids.includes(pid)).length });
      else this.report(message);
      return;
    }
    if (message.button !== 0 || !this.wanted.includes(message.pid) || !this.protection.verified || !this.protection.activePids.includes(message.pid)) return;
    if (message.phase === 'down') { this.down.set(message.pid, message); return; }
    const down = this.down.get(message.pid); this.down.delete(message.pid);
    const click = matchInputGuardClick(down, message);
    if (click) this.options.onClick(click);
  }
  private report(status: InputGuardStatusMessage) { try { this.options.onStatus?.(status); } catch { /* Presentation cannot change shared protection. */ } }
  private clearRetry() { if (this.retry !== undefined) this.clock.clearTimeout(this.retry); this.retry = undefined; }
  private scheduleRetry() {
    if (this.retry !== undefined) return;
    this.retry = this.clock.setTimeout(() => {
      this.retry = undefined;
      if (this.disposed || !this.wanted.length || this.options.broker.snapshot().transport.state !== 'ready') return;
      try { this.subscription.sync([...this.wanted]); }
      catch { this.down.clear(); }
      this.acceptProtection(this.options.broker.snapshot().browserProtection);
    }, this.retryMs);
  }
}
