import { createHash, randomUUID } from 'node:crypto';
import { backgroundDesktopActions } from '../../shared/desktop';
import { backgroundTargetSchema, sameBackgroundTarget, type BackgroundTarget } from './input-observer';
import { existsSync } from 'node:fs';
import type { DesktopImage, DesktopObservation, DesktopStatus, DesktopWindow, DesktopWindowList, DesktopReturnExpectation } from '../../shared/desktop';
import { desktopError, desktopExecutable, DesktopWorker, type DesktopDriver } from './worker';
import { desktopCommandSchema, desktopWindowIdSchema as windowId, type DesktopCommand } from './schema';
import { waitForDesktopCondition } from './wait';
import { observeAfterAction } from '../action-feedback';
import { desktopPauseMessage } from './errors';
import type { DesktopAdmissionDecision } from './admission';
import { describeInputObserverStartupFailure, inputObserverStartupErrorFailure, inputObserverStartupFailureSchema,
  isInputObserverStartupErrorCode, type DesktopObserverSubscription, type InputObserverPause } from './input-observer';
export { desktopActionSchema, desktopCommandSchema, type DesktopCommand } from './schema';

const pointerKinds = ['click', 'double_click', 'move', 'drag', 'wheel'];
type InputBinding = {
  generation: string; previousGeneration?: string; epoch?: string;
  phase: 'arming' | 'ready' | 'pending' | 'paused'; reason?: string; certainty?: 'observed' | 'unknown';
  revision: number; serviceGeneration: number; driver: DesktopDriver; windowId: string;
  noticePreparation?: AbortController;
};
type Session = NonNullable<DesktopStatus['session']> & {
  driver: DesktopDriver; revision: number; coordinateVersion?: string; input?: InputBinding; freshReadRequired?: boolean;
};
export interface DesktopServiceInputObserver {
  arm(generation: string, marker: string, backgroundTarget?: BackgroundTarget): Promise<DesktopObserverSubscription>;
  disarm(generation: string): void;
  snapshot(): { connected: boolean; epoch: string | null; desktop: DesktopObserverSubscription | null };
  // Detach only this service's subscription/callback; never dispose the shared
  // browser broker or create another observer process.
  detach(): void | Promise<void>;
}
type Receipt = {
  hash: string; result: Promise<unknown>; state: 'pending' | 'succeeded' | 'failed';
  receivedAt: number; completedAt?: number; value?: unknown;
  error?: { code: string; message: string; details?: unknown };
};
type DriverClosure = { driver: DesktopDriver; settled: Promise<void>; done: boolean; error?: Error };
export interface DesktopServiceOptions {
  platform?: string; available?: () => boolean; driver?: () => DesktopDriver; now?: () => number;
  onChanged?: (status: DesktopStatus) => void;
  capture?: (window: DesktopWindow, image: DesktopImage) => Promise<DesktopImage>;
  stopShortcutAvailable?: () => boolean;
  admission?: (window: DesktopWindow) => Promise<DesktopAdmissionDecision>;
  inputObserver?: (onPause: (event: InputObserverPause) => void) => DesktopServiceInputObserver;
  prepareControlNotice?: (signal: AbortSignal) => Promise<void>;
  // Explicit test seam only. Also requires an injected driver factory and is
  // deliberately absent from registerDesktop's production options.
  allowUnobservedTestDriver?: boolean;
}

export class DesktopService {
  private owner?: Session;
  private ended = new Set<string>();
  private receipts = new Map<string, Receipt>();
  private catalog: DesktopDriver;
  private catalogQueue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private generation = 0;
  private closed = false;
  private waiting?: AbortController;
  private timer: NodeJS.Timeout;
  private platform: string;
  private now: () => number;
  private createDriver: () => DesktopDriver;
  private inputObserver?: DesktopServiceInputObserver;
  private unobservedTestDriver: boolean;
  private driverClosures = new WeakMap<DesktopDriver, DriverClosure>();
  private retiringDrivers = new Set<DriverClosure>();
  private stopFailures: Error[] = [];
  private stopFailureCount = 0;
  private closePromise?: Promise<void>;
  constructor(private options: DesktopServiceOptions = {}) {
    this.platform = options.platform || process.platform;
    this.now = options.now || Date.now;
    this.createDriver = options.driver || (() => new DesktopWorker());
    this.unobservedTestDriver = options.allowUnobservedTestDriver === true && typeof options.driver === 'function';
    if (options.allowUnobservedTestDriver && !options.driver) throw desktopError('DESKTOP_BAD_REQUEST', 'Unobserved tests require an explicit fake driver.');
    if (this.platform === 'win32' && options.inputObserver) {
      try { this.inputObserver = options.inputObserver(event => this.observerPaused(event)); }
      catch { /* Catalog reads remain available; control fails closed below. */ }
    }
    this.catalog = this.createDriver();
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  status(): DesktopStatus {
    this.expire();
    const supported = this.platform === 'win32';
    const available = !this.closed && supported && (this.options.available?.() ?? existsSync(desktopExecutable()));
    const owner = this.owner;
    return { supported, available, platform: this.platform, stopShortcutAvailable: this.options.stopShortcutAvailable?.() ?? false,
      reason: this.closed ? '桌面服务已关闭。' : !supported ? '本机桌面控制目前支持 Windows；macOS 暂未提供原生桌面驱动。' : !available ? '桌面控制组件尚未安装，请更新 ProfilePilot。' : undefined,
      inputObservation: this.observationStatus(),
      session: owner ? { name: owner.name, window: { ...owner.window }, mode: owner.mode || 'interactive', state: owner.state, expiresAt: owner.expiresAt, revision: owner.revision } : null };
  }
  private observationStatus(): DesktopStatus['inputObservation'] {
    const input = this.owner?.input;
    if (!this.inputObserver) return { available: false, phase: 'unavailable', reason: 'observer_unavailable',
      ...(this.unobservedTestDriver ? { unobservedTestDriver: true as const } : {}) };
    return { available: true, phase: input?.phase || 'idle', ...(input ? { generation: input.generation,
      ...(input.epoch ? { epoch: input.epoch } : {}), ...(input.reason ? { reason: input.reason } : {}),
      ...(input.phase === 'paused' ? { message: desktopPauseMessage(input.reason) } : {}),
      ...(input.certainty ? { certainty: input.certainty } : {}) } : {}) };
  }
  private requireObserver() {
    if (!this.inputObserver && !this.unobservedTestDriver) throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE');
  }
  private disarm(input: InputBinding | undefined) {
    input?.noticePreparation?.abort();
    if (input && this.inputObserver) try { this.inputObserver.disarm(input.generation); } catch { /* State is already invalidated. */ }
  }
  private closeDriver(driver: DesktopDriver): DriverClosure {
    this.pendingRetirements();
    const previous = this.driverClosures.get(driver); if (previous) return previous;
    let resolve!: () => void;
    const entry: DriverClosure = { driver, done: false, settled: new Promise<void>(done => { resolve = done; }) };
    // Publish before invoking a driver: close/onChanged callbacks can re-enter.
    this.driverClosures.set(driver, entry); this.retiringDrivers.add(entry);
    const finish = (failed: boolean, error?: unknown) => {
      entry.done = true;
      if (failed) {
        entry.error = (error as any)?.code === 'DESKTOP_DRIVER_STOP_UNCONFIRMED' ? error as Error
          : Object.assign(desktopError('DESKTOP_DRIVER_STOP_UNCONFIRMED'), { cause: error });
        this.stopFailureCount++;
        if (this.stopFailures.length < 32) this.stopFailures.push(entry.error);
        if (entry.driver.stopConfirmed === true) this.retiringDrivers.delete(entry);
      } else this.retiringDrivers.delete(entry);
      resolve();
    };
    try {
      const closing = driver.close();
      if (closing) void Promise.resolve(closing).then(() => finish(false), error => finish(true, error));
      else finish(false);
    } catch (error) { finish(true, error); }
    return entry;
  }
  private pendingRetirements(): DriverClosure[] {
    // A late exit is fresh evidence, even if that driver's first stop attempt
    // failed. Preserve the failure for shutdown, but allow explicit recovery.
    for (const entry of this.retiringDrivers) if (entry.driver.stopConfirmed === true) this.retiringDrivers.delete(entry);
    return [...this.retiringDrivers];
  }
  private async waitForDrivers(): Promise<void> {
    for (;;) {
      const pending = this.pendingRetirements(); if (!pending.length) return;
      await Promise.all(pending.map(entry => entry.settled));
      const failed = this.pendingRetirements().find(entry => entry.done && entry.error);
      if (failed) throw failed.error;
    }
  }
  private pauseOwner(owner: Session, reason: string, certainty: 'observed' | 'unknown', notify = true) {
    if (this.owner !== owner) return;
    // Invalidate synchronously before cancellation or callbacks can re-enter.
    this.generation++; owner.revision++; owner.state = 'paused'; owner.coordinateVersion = undefined; owner.freshReadRequired = true;
    if (owner.input) { owner.input.phase = 'paused'; owner.input.reason = reason; owner.input.certainty = certainty; }
    this.waiting?.abort(); this.closeDriver(owner.driver); this.disarm(owner.input);
    if (notify) this.changed();
  }
  private pauseForFailure(owner: Session, reason: string) {
    this.expire();
    if (this.owner !== owner) return;
    owner.expiresAt = this.now() + 300_000;
    this.pauseOwner(owner, reason, 'unknown');
  }
  private pauseForOperationFailure(owner: Session, revision: number, error: unknown) {
    const reasons: Record<string, string> = { DESKTOP_OUTCOME_UNKNOWN: 'outcome_unknown',
      DESKTOP_DESKTOP_LOCKED: 'desktop_locked', DESKTOP_DRIVER_STOP_UNCONFIRMED: 'driver_stop_unconfirmed', DESKTOP_BACKGROUND_TARGET_ACTIVE: 'target_active' };
    const reason = reasons[(error as { code?: string })?.code || ''];
    if (reason && this.owner === owner && owner.revision === revision) this.pauseForFailure(owner, reason);
  }
  private observerPaused(event: InputObserverPause) {
    if (this.closed) return;
    const owner = this.owner, input = owner?.input;
    if (!owner || !input || input.phase === 'paused' || event.generation !== input.generation
      && !(input.phase === 'arming' && event.generation === input.previousGeneration)) return;
    if (input.epoch && input.epoch !== event.epoch) return;
    let reason = event.reason;
    if (['instance_in_use', 'instance_access_denied', 'instance_gate_failed'].includes(reason)) {
      const parsed = inputObserverStartupFailureSchema.safeParse(event.startupFailure);
      if (!parsed.success || describeInputObserverStartupFailure(parsed.data).reason !== reason) reason = 'unavailable';
    }
    this.pauseOwner(owner, reason, event.certainty);
  }
  private bindingCurrent(owner: Session, input: InputBinding) {
    this.expire();
    return !this.closed && this.owner === owner && owner.input === input && owner.revision === input.revision
      && this.generation === input.serviceGeneration && owner.driver === input.driver && owner.window.id === input.windowId;
  }
  private assertObserved(owner: Session) {
    this.requireObserver(); if (!this.inputObserver) return;
    const input = owner.input;
    if (!input || input.phase === 'pending' || input.phase === 'arming') throw desktopError('DESKTOP_INPUT_OBSERVER_PENDING');
    if (!this.bindingCurrent(owner, input) || owner.state !== 'active' || input.phase !== 'ready') throw desktopError('DESKTOP_USER_IN_CONTROL');
    let snapshot;
    try { snapshot = this.inputObserver.snapshot(); } catch { this.pauseOwner(owner, 'unavailable', 'unknown'); throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE'); }
    if (!snapshot.connected || snapshot.epoch !== input.epoch || snapshot.desktop?.generation !== input.generation
      || snapshot.desktop.epoch !== input.epoch || snapshot.desktop.phase !== 'ready'
      || !sameBackgroundTarget(snapshot.desktop.backgroundTarget, this.backgroundTarget(owner))) {
      this.pauseOwner(owner, snapshot.desktop?.reason || 'unavailable', snapshot.desktop?.certainty || 'unknown');
      throw desktopError('DESKTOP_USER_IN_CONTROL');
    }
    if (!this.bindingCurrent(owner, input) || owner.state !== 'active') throw desktopError('DESKTOP_USER_IN_CONTROL');
  }
  private async armOwner(owner: Session) {
    this.requireObserver();
    const old = owner.input;
    const input: InputBinding = { generation: 'desktop-' + randomUUID(),
      ...((old?.phase === 'ready' || old?.phase === 'pending') ? { previousGeneration: old.generation } : {}),
      phase: 'arming', revision: owner.revision, serviceGeneration: this.generation, driver: owner.driver, windowId: owner.window.id };
    owner.input = input; owner.state = 'paused'; owner.coordinateVersion = undefined;
    this.changed();
    if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
    try {
      // Do not arm a replacement child while a retiring driver can still emit
      // cleanup input carrying a marker unknown to that new observer epoch.
      // Recheck after every await: another catalog can start retiring while an
      // earlier stop promise settles. An empty set must not introduce a yield.
      while (this.pendingRetirements().length) {
        await this.waitForDrivers();
        if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
      }
      if (this.options.prepareControlNotice) {
        const controller = input.noticePreparation = new AbortController();
        let cancel!: () => void;
        const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(desktopError('DESKTOP_USER_IN_CONTROL')); });
        void cancelled.catch(() => {});
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          // Race cancellation even if an injected UI provider ignores its
          // signal. A late UI resolution never keeps busy set or permits ARM.
          await Promise.race([this.options.prepareControlNotice(controller.signal), cancelled]);
        } catch (error) {
          if (this.owner === owner && owner.input === input && input.phase === 'paused' && input.reason === 'notice_unavailable') {
            throw Object.assign(desktopError('DESKTOP_CONTROL_NOTICE_UNAVAILABLE'), { cause: error });
          }
          if (controller.signal.aborted || !this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
          throw Object.assign(desktopError('DESKTOP_CONTROL_NOTICE_UNAVAILABLE'), { cause: error });
        } finally {
          controller.signal.removeEventListener('abort', cancel); input.noticePreparation = undefined;
        }
        if (controller.signal.aborted || !this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
      }
      const backgroundTarget = this.backgroundTarget(owner);
      if (backgroundTarget) {
        await owner.driver.request('windows', {});
        if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
        const policy = await owner.driver.request('control.background', { windowId: owner.window.id });
        if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
        if (policy?.mode !== 'background' || !sameBackgroundTarget(policy.backgroundTarget, backgroundTarget)) throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE');
      }
      if (!this.inputObserver) {
        input.phase = 'ready'; owner.state = 'active'; this.changed();
        if (!this.bindingCurrent(owner, input) || owner.state !== 'active') throw desktopError('DESKTOP_USER_IN_CONTROL');
        return;
      }
      const marker = owner.driver.inputMarker;
      if (typeof marker !== 'string' || !/^[a-fA-F0-9]{1,16}$/.test(marker) || BigInt('0x' + marker) === 0n) {
        this.pauseOwner(owner, 'invalid_driver_marker', 'unknown'); throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE');
      }
      if (input.previousGeneration) {
        const previous = this.inputObserver.snapshot();
        if (!previous.connected || previous.desktop?.phase !== 'ready' || previous.desktop.generation !== input.previousGeneration
          || previous.desktop.epoch !== previous.epoch || old?.epoch !== previous.epoch) {
          this.pauseOwner(owner, previous.desktop?.reason || 'unavailable', previous.desktop?.certainty || 'unknown');
          throw desktopError('DESKTOP_USER_IN_CONTROL');
        }
        if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
      }
      const acknowledged = await this.inputObserver.arm(input.generation, marker, backgroundTarget);
      if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
      // ACK describes one instant. An activity frame in the same stdout chunk
      // can already have paused it before this promise continuation runs.
      const fresh = this.inputObserver.snapshot();
      if (!fresh.connected || acknowledged.phase !== 'ready' || acknowledged.generation !== input.generation
        || fresh.epoch !== acknowledged.epoch || fresh.desktop?.epoch !== acknowledged.epoch
        || fresh.desktop.generation !== input.generation || fresh.desktop.phase !== 'ready'
        || !sameBackgroundTarget(acknowledged.backgroundTarget, backgroundTarget) || !sameBackgroundTarget(fresh.desktop.backgroundTarget, backgroundTarget)) {
        this.pauseOwner(owner, fresh.desktop?.reason || 'unavailable', fresh.desktop?.certainty || 'unknown');
        throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE');
      }
      if (!this.bindingCurrent(owner, input)) throw desktopError('DESKTOP_USER_IN_CONTROL');
      input.epoch = acknowledged.epoch; input.phase = 'ready'; input.previousGeneration = undefined;
      owner.state = 'active'; this.changed(); this.assertObserved(owner);
    } catch (error) {
      // Only the bounded startup envelope and its matching code establish this
      // diagnostic. Arbitrary error.reason/message/details are not evidence.
      const failure = inputObserverStartupErrorFailure(error);
      const diagnostic = failure && describeInputObserverStartupFailure(failure);
      if (this.bindingCurrent(owner, input)) this.pauseOwner(owner, (error as any)?.code === 'DESKTOP_CONTROL_NOTICE_UNAVAILABLE' ? 'notice_unavailable' : (error as any)?.code === 'DESKTOP_BACKGROUND_TARGET_ACTIVE' ? 'target_active' : diagnostic?.reason || 'unavailable', 'unknown');
      if (failure && diagnostic) throw Object.assign(desktopError(diagnostic.code), {
        details: { inputObserver: { stage: failure.stage, win32Error: failure.win32Error } }
      });
      if (isInputObserverStartupErrorCode((error as any)?.code)) throw desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE');
      if (!(error as any)?.code) throw Object.assign(desktopError('DESKTOP_INPUT_OBSERVER_UNAVAILABLE'), { cause: error });
      throw error;
    }
  }
  private backgroundTarget(owner: Session): BackgroundTarget | undefined {
    if (owner.mode !== 'background') return undefined;
    const parsed = backgroundTargetSchema.safeParse({ pid: owner.window.pid, window: owner.window.nativeHandle });
    if (!parsed.success) throw desktopError('DESKTOP_WINDOW_CHANGED');
    return parsed.data;
  }
  private replaceReadDriver(owner: Session): boolean {
    const revision = ++owner.revision;
    owner.coordinateVersion = undefined; owner.freshReadRequired = true;
    this.closeDriver(owner.driver);
    if (this.owner !== owner || owner.revision !== revision || owner.state !== 'active') return false;
    owner.driver = this.createDriver();
    // Keep the previous observer generation alive until continuous REARM.
    // An event during this pending interval still pauses the current owner.
    if (owner.input) owner.input.phase = 'pending';
    return true;
  }
  private changed() { this.options.onChanged?.(this.status()); }
  private ready() { if (this.closed) throw desktopError('DESKTOP_SERVICE_UNAVAILABLE', '桌面服务已关闭。'); const state = this.status(); if (!state.available) throw desktopError(state.supported ? 'DESKTOP_HELPER_MISSING' : 'DESKTOP_PLATFORM_UNAVAILABLE', state.reason); }
  private expire() { if (this.owner && this.owner.expiresAt <= this.now()) this.end(); }
  private end() {
    const owner = this.owner; this.owner = undefined;
    this.generation++;
    if (owner) {
      owner.revision++; owner.state = 'paused'; owner.coordinateVersion = undefined;
      this.ended.add(owner.name); this.waiting?.abort(); this.closeDriver(owner.driver); this.disarm(owner.input); this.changed();
    } else this.waiting?.abort();
  }
  private check(name: string | undefined, active = true, pendingRead = false): Session {
    this.expire();
    const owner = this.owner;
    if (!name || !owner || owner.name !== name) throw desktopError('DESKTOP_SESSION_ENDED');
    if (active && owner.state !== 'active') throw desktopError(owner.input?.phase === 'arming' ? 'DESKTOP_INPUT_OBSERVER_PENDING' : 'DESKTOP_USER_IN_CONTROL');
    if (active && !(pendingRead && owner.input?.phase === 'pending')) this.assertObserved(owner);
    return owner;
  }
  control(action: 'return'): Promise<DesktopStatus>;
  control(action: 'takeover' | 'stop'): DesktopStatus;
  control(action: 'takeover' | 'return' | 'stop'): DesktopStatus | Promise<DesktopStatus> {
    if (action === 'return') return this.resume();
    if (this.closed) return this.status();
    this.expire();
    if (action === 'stop') this.end();
    else if (this.owner) {
      const owner = this.owner;
      owner.expiresAt = this.now() + 300_000;
      this.pauseOwner(owner, 'user_takeover', 'observed');
    } else { this.generation++; this.waiting?.abort(); }
    return this.status();
  }
  noticeUnavailable(): DesktopStatus {
    if (this.closed) return this.status();
    this.expire();
    const owner = this.owner;
    // Renderer failure is a system interruption, not an observed user action.
    // Repeated failures cannot erase an earlier pause or keep renewing it.
    if (owner && (owner.state === 'active' || owner.input?.phase === 'arming' || owner.input?.phase === 'pending'))
      this.pauseForFailure(owner, 'notice_unavailable');
    return this.status();
  }
  async resume(expected?: DesktopReturnExpectation): Promise<DesktopStatus> {
    this.ready(); this.requireObserver();
    if (this.busy) throw desktopError('DESKTOP_BUSY');
    this.busy = true;
    try {
      const owner = this.owner, generation = this.generation;
      if (!owner) throw desktopError('DESKTOP_SESSION_ENDED');
      // UI requests must refer to the state actually rendered before the click.
      // Another takeover can keep the same observer generation but increments
      // revision, so name/generation alone is not a sufficient return fence.
      if (expected && (owner.name !== expected.session || owner.input?.generation !== expected.generation
          || owner.revision !== expected.revision || owner.state !== 'paused'))
        throw desktopError('DESKTOP_USER_IN_CONTROL', '桌面控制状态已变化，请查看当前会话后再交还控制。');
      if (owner.state === 'active' && owner.input?.phase !== 'pending') { this.assertObserved(owner); return this.status(); }
      const revision = owner.revision, target = owner.window.id, previousDriver = owner.driver;
      await this.checkAdmission(owner.window);
      this.ready();
      if (this.owner !== owner || this.generation !== generation || owner.revision !== revision || owner.window.id !== target || owner.driver !== previousDriver) throw desktopError('DESKTOP_USER_IN_CONTROL');
      if (owner.state === 'paused') {
        const nextRevision = ++owner.revision;
        owner.coordinateVersion = undefined; owner.freshReadRequired = true;
        this.closeDriver(owner.driver);
        if (this.owner !== owner || owner.revision !== nextRevision || this.generation !== generation) throw desktopError('DESKTOP_USER_IN_CONTROL');
        owner.driver = this.createDriver();
      }
      owner.expiresAt = this.now() + 300_000;
      await this.armOwner(owner);
      return this.status();
    } finally { this.busy = false; }
  }
  private async checkAdmission(window: DesktopWindow, owner?: Session, revision?: number) {
    if (!this.options.admission) return;
    let decision: DesktopAdmissionDecision;
    try { decision = await this.options.admission(window); }
    catch {
      if (owner) { this.assertOwner(owner, revision!); this.pauseForFailure(owner, 'control_state_unknown'); }
      throw desktopError('DESKTOP_CONTROL_STATE_UNKNOWN');
    }
    if (owner) this.assertOwner(owner, revision!);
    if (decision.status === 'available' || decision.status === 'unmanaged') return;
    if (owner) this.pauseForFailure(owner, decision.status === 'occupied' ? 'control_occupied' : 'control_state_unknown');
    throw Object.assign(desktopError(decision.status === 'occupied' ? 'DESKTOP_CONTROL_OCCUPIED' : 'DESKTOP_CONTROL_STATE_UNKNOWN'), { details: { admission: decision } });
  }
  private readCatalog<T>(read: (driver: DesktopDriver) => Promise<T>): Promise<T> {
    this.ready();
    const result = this.catalogQueue.then(async () => {
      this.ready();
      const value = await read(this.catalog);
      this.ready();
      return value;
    }).catch(error => {
      if (!this.closed) { this.closeDriver(this.catalog); this.catalog = this.createDriver(); }
      throw error;
    });
    this.catalogQueue = result.catch(() => undefined);
    return result;
  }
  private async capture(window: DesktopWindow, image: DesktopImage): Promise<DesktopImage> {
    if (!this.options.capture) return image;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.options.capture(window, image), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(desktopError('DESKTOP_SCREENSHOT_UNAVAILABLE', '窗口截图超时，请检查窗口状态。')), 8000);
      })]);
    } catch { throw desktopError('DESKTOP_SCREENSHOT_UNAVAILABLE', '窗口画面暂不可用，请检查窗口状态后重试截图。'); }
    finally { if (timer) clearTimeout(timer); }
  }
  windows(): Promise<DesktopWindowList> { return this.readCatalog(driver => driver.request('windows', {})); }
  preview(id: string): Promise<DesktopObservation> {
    windowId.parse(id);
    return this.readCatalog(async driver => {
      const windows = await driver.request('windows', {});
      this.ready();
      const target = (windows.windows as DesktopWindow[]).find(window => window.id === id);
      if (!target) throw desktopError('DESKTOP_WINDOW_CHANGED');
      const result = await driver.request('window.screenshot', { windowId: id, screenshotOnly: true });
      this.ready();
      if (result.image) result.image = await this.capture(target, result.image);
      return result;
    });
  }
  async execute(input: unknown): Promise<unknown> {
    let command: DesktopCommand;
    try { command = desktopCommandSchema.parse(input); } catch { throw desktopError('DESKTOP_BAD_REQUEST', '桌面命令参数无效。'); }
    if (command.method === 'status') return this.status();
    if (command.method === 'receipt') {
      const receipt = this.receipts.get(command.session + ':' + command.requestId);
      if (!receipt) throw desktopError('DESKTOP_RECEIPT_UNAVAILABLE', '回执不存在或已过期；这不表示操作未执行。请核查窗口结果，不要据此重放输入。');
      return { session: command.session, requestId: command.requestId, state: receipt.state,
        receivedAt: receipt.receivedAt, completedAt: receipt.completedAt, historical: true, requiresObservation: true,
        ...(receipt.state === 'succeeded' ? { result: receipt.value } : receipt.state === 'failed' ? { error: receipt.error } : {}) };
    }
    this.ready();
    if (command.method === 'windows') return this.windows();
    if (command.method === 'doctor') return this.readCatalog(async driver => {
      let target: DesktopWindow | undefined;
      if (command.windowId) {
        const listed = await driver.request('windows', {}); this.ready();
        target = (listed.windows as DesktopWindow[]).find(window => window.id === command.windowId);
        if (!target) throw desktopError('DESKTOP_WINDOW_CHANGED');
      }
      const diagnostics = await driver.request('diagnostics', command.windowId ? { windowId: command.windowId } : {});
      let admission: DesktopAdmissionDecision | undefined;
      if (target && this.options.admission) {
        try { admission = await this.options.admission(target); }
        catch { admission = { status: 'unknown', reason: 'provider_failed', matches: [], gaps: ['admission:provider_failed'] }; }
      }
      // Diagnostics reports occupancy without taking control, pausing a task,
      // renewing its lease or interpreting a provider failure as available.
      return { ...diagnostics, status: this.status(), ...(admission ? { admission } : {}) };
    });
    if (!command.session) throw desktopError('DESKTOP_BAD_REQUEST', '需要 --session 任务名。');
    if (command.method === 'handoff' || command.method === 'resume' || command.method === 'complete' || command.method === 'release') {
      // Conditional completion must check and end in this same synchronous
      // turn. A client's earlier status read cannot authorize ending a task
      // that has since been paused by the user or lost its observer.
      this.check(command.session, command.method === 'complete' && command.requireActive === true);
      return command.method === 'resume' ? this.resume() : this.control(command.method === 'handoff' ? 'takeover' : 'stop');
    }
    if (command.method === 'action') {
      this.check(command.session, false);
      if (!command.params || !command.requestId) throw desktopError('DESKTOP_BAD_REQUEST', 'action 需要操作参数和 requestId。');
      const key = command.session + ':' + command.requestId;
      const hash = createHash('sha256').update(JSON.stringify({ params: command.params, observeAfter: command.observeAfter !== false })).digest('hex');
      const previous = this.receipts.get(key);
      if (previous) {
        if (previous.hash !== hash) throw desktopError('DESKTOP_REQUEST_CHANGED', '相同 requestId 不得提交不同操作。');
        return previous.result;
      }
      this.check(command.session);
      // BUSY means nothing was dispatched. Do not poison that request ID with
      // a permanent rejection before the operation has even been admitted.
      if (this.busy) throw desktopError('DESKTOP_BUSY', '桌面操作仍在进行，请先检查状态。');
      const result = this.perform(command);
      const receipt: Receipt = { hash, result, state: 'pending', receivedAt: this.now() };
      this.receipts.set(key, receipt);
      // Keep rejected receipts too: uncertain input must never be dispatched again.
      void result.then(value => {
        receipt.state = 'succeeded'; receipt.value = value; receipt.completedAt = this.now();
      }, error => {
        receipt.state = 'failed'; receipt.completedAt = this.now();
        receipt.error = { code: error?.code || 'DESKTOP_ACTION_FAILED', message: error instanceof Error ? error.message : String(error), ...(error?.details ? { details: error.details } : {}) };
      });
      if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
      return result;
    }
    return this.perform(command);
  }
  private assertOwner(owner: Session, revision: number, driver = owner.driver, target = owner.window.id) {
    this.ready();
    if (this.owner !== owner || owner.revision !== revision || owner.state !== 'active' || owner.driver !== driver || owner.window.id !== target) throw desktopError('DESKTOP_USER_IN_CONTROL');
    this.assertObserved(owner);
  }
  private recoverReadDriver(owner: Session, revision: number, error: unknown) {
    if ((error as any)?.code !== 'DESKTOP_READ_INTERRUPTED') return;
    this.expire();
    if (this.closed || this.owner !== owner || owner.revision !== revision || owner.state !== 'active') return;
    if (this.replaceReadDriver(owner)) this.changed();
    // Prepare for a caller's explicit fresh read. Do not retry, renew the lease,
    // return user control, or dispatch a replacement request here. The worker's
    // retirement barrier still prevents overlap with the old helper.
  }
  private async observe(owner: Session, revision: number, driver: DesktopDriver, screenshot: boolean, screenshotOnly = false): Promise<DesktopObservation> {
    const target = owner.window.id;
    this.assertOwner(owner, revision, driver, target);
    await this.checkAdmission(owner.window, owner, revision);
    this.assertOwner(owner, revision, driver, target);
    await driver.request('windows', {});
    this.assertOwner(owner, revision, driver, target);
    owner.coordinateVersion = undefined;
    const observed = await driver.request(screenshot ? 'window.screenshot' : 'window.observe', { windowId: owner.window.id, ...(screenshot ? { screenshotOnly } : {}) }) as DesktopObservation;
    this.assertOwner(owner, revision, driver, target);
    if (observed.image) {
      observed.image = await this.capture(owner.window, observed.image);
      if (owner.mode === 'background') observed.image.coordinateInputAvailable = false;
      this.assertOwner(owner, revision, driver, target);
      if (observed.image.coordinateInputAvailable === true) owner.coordinateVersion = observed.version;
    }
    owner.freshReadRequired = false;
    return observed;
  }
  private async perform(command: DesktopCommand): Promise<unknown> {
    if (this.busy) throw desktopError('DESKTOP_BUSY', '桌面操作仍在进行，请先检查状态。');
    this.busy = true;
    try {
      if (command.method === 'claim') {
        this.requireObserver();
        if (this.ended.has(command.session!)) throw desktopError('DESKTOP_SESSION_ENDED', '这个任务已结束，请为新任务使用新的会话名。');
        if (this.owner) {
          if (this.owner.name !== command.session) throw desktopError('DESKTOP_CONTROL_BUSY', '桌面正在由其他任务使用。');
          this.check(command.session);
          if (command.windowId && command.windowId !== this.owner.window.id) throw desktopError('DESKTOP_WINDOW_CHANGED', '更换窗口需要显式 select。');
          if (command.mode && command.mode !== (this.owner.mode || 'interactive')) throw desktopError('DESKTOP_MODE_CONFLICT');
          return this.status();
        }
        if (!command.windowId) throw desktopError('DESKTOP_BAD_REQUEST', 'claim 需要 windows 返回的 --window ID。');
        const generation = this.generation;
        const window = (await this.windows()).windows.find(item => item.id === command.windowId);
        if (this.generation !== generation) throw desktopError('DESKTOP_USER_IN_CONTROL', '用户已停止或接管，未开始控制。');
        if (!window) throw desktopError('DESKTOP_WINDOW_CHANGED', '窗口已变化，请重新读取 windows。');
        await this.checkAdmission(window);
        this.ready();
        if (this.generation !== generation) throw desktopError('DESKTOP_USER_IN_CONTROL', '用户已停止或接管，未开始控制。');
        const owner = this.owner = { name: command.session!, window: { ...window }, mode: command.mode || 'interactive', state: 'paused' as const, expiresAt: this.now() + 300_000, driver: this.createDriver(), revision: 0 };
        await this.armOwner(owner); return this.status();
      }
      const explicitRead = command.method === 'observe' || command.method === 'screenshot' || command.method === 'wait';
      const owner = this.check(command.session, true, explicitRead);
      if (explicitRead && owner.input?.phase === 'pending') await this.armOwner(owner);
      this.assertObserved(owner);
      const revision = owner.revision, driver = owner.driver, targetId = owner.window.id;
      owner.expiresAt = this.now() + 300_000;
      let result: unknown;
      try {
        if (command.method === 'select') {
          if (!command.windowId) throw desktopError('DESKTOP_BAD_REQUEST', 'select 需要 --window ID。');
          const windows = await driver.request('windows', {});
          this.assertOwner(owner, revision, driver, targetId);
          const target = (windows.windows as DesktopWindow[]).find(item => item.id === command.windowId);
          if (!target) throw desktopError('DESKTOP_WINDOW_CHANGED');
          await this.checkAdmission(target, owner, revision);
          this.assertOwner(owner, revision, driver, targetId);
          if (!this.replaceReadDriver(owner)) throw desktopError('DESKTOP_USER_IN_CONTROL');
          owner.window = { ...target };
          await this.armOwner(owner);
          return this.status();
        } else if (command.method === 'wait') {
          const waiting = this.waiting = new AbortController();
          try {
            const waited = await waitForDesktopCondition({ condition: command.condition!, timeoutMs: command.timeoutMs ?? 10000, intervalMs: command.intervalMs ?? 250 }, () => this.observe(owner, revision, driver, false), waiting.signal);
            this.assertOwner(owner, revision, driver, targetId);
            if (waited.result.timedOut) {
              // The returned observation is historical even when the timeout
              // falls between completed reads. Require a new explicit read
              // before any ref or coordinate input can use that evidence.
              owner.freshReadRequired = true; owner.coordinateVersion = undefined;
            }
            if (waited.pendingRead) {
              // A deadline must also stop a blocked read. Retire that helper
              // before permitting another request; its old refs are unusable.
              if (!this.replaceReadDriver(owner)) throw desktopError('DESKTOP_USER_IN_CONTROL');
            }
            this.changed();
            if (!waited.pendingRead) this.assertOwner(owner, revision, driver, targetId);
            else if (this.owner !== owner || owner.state !== 'active') throw desktopError('DESKTOP_USER_IN_CONTROL');
            return waited.result;
          } finally { if (this.waiting === waiting) this.waiting = undefined; }
        } else if (command.method === 'observe' || command.method === 'screenshot') {
          result = await this.observe(owner, revision, driver, command.method === 'screenshot', command.screenshotOnly);
        } else {
          const params = command.params!;
          if (owner.mode === 'background' && !(backgroundDesktopActions as readonly string[]).includes(params.kind)) throw desktopError('DESKTOP_BACKGROUND_ACTION_DENIED');
          await this.checkAdmission(owner.window, owner, revision);
          this.assertOwner(owner, revision, driver, targetId);
          if (owner.freshReadRequired) throw desktopError('DESKTOP_FRESH_OBSERVATION_REQUIRED');
          if (pointerKinds.includes(params.kind) && (!params.ref || params.kind === 'drag') && owner.coordinateVersion !== params.version) throw desktopError('DESKTOP_SCREENSHOT_REQUIRED', '这次观察没有可用于坐标输入的窗口画面，请使用控件引用或重新截图。');
          owner.coordinateVersion = undefined;
          result = await driver.request('window.action', params);
          if (command.observeAfter !== false) {
            let feedback = await observeAfterAction({
              check: () => this.assertOwner(owner, revision, driver, targetId),
              observe: () => this.observe(owner, revision, driver, false),
              errorCode: 'DESKTOP_OBSERVATION_FAILED',
              invalidate: error => {
                owner.freshReadRequired = true; owner.coordinateVersion = undefined;
                this.recoverReadDriver(owner, revision, error);
                this.pauseForOperationFailure(owner, revision, error);
              }
            });
            this.changed();
            // Notification delivery can revoke control synchronously. Keep
            // the executed receipt, but never return its observation as usable.
            if (feedback.observationStatus === 'available') {
              try { this.assertOwner(owner, revision, driver, targetId); }
              catch {
                feedback = { actionOutcome: 'completed', observationStatus: 'unavailable', nextStep: 'observe-or-check-control',
                  observationError: { code: 'DESKTOP_USER_IN_CONTROL', message: '输入已完成，但控制权已变化；返回的观察不能用于继续操作。' } };
              }
            }
            return { ...result as object, ...feedback, requiresObservation: feedback.observationStatus !== 'available' };
          }
        }
      } catch (error) {
        if (command.method !== 'action') this.recoverReadDriver(owner, revision, error);
        if (command.method === 'action' && ['DESKTOP_INPUT_FAILED', 'DESKTOP_FOCUS_CHANGED'].includes((error as any).code)) error = Object.assign(desktopError('DESKTOP_OUTCOME_UNKNOWN', '输入可能部分生效，请检查窗口结果。'), { cause: error });
        this.pauseForOperationFailure(owner, revision, error);
        throw error;
      }
      this.changed();
      let changedControl: unknown;
      try { this.assertOwner(owner, revision, driver, targetId); } catch (error) { changedControl = error; }
      if (changedControl) {
        if (command.method === 'action' && (result as any)?.executed === true) return {
          ...result as object, observation: undefined, requiresObservation: true,
          observationError: { code: 'DESKTOP_USER_IN_CONTROL', message: '输入已完成，但控制权已变化；返回的观察不能用于继续操作。' }
        };
        throw desktopError(command.method === 'action' ? 'DESKTOP_OUTCOME_UNKNOWN' : 'DESKTOP_USER_IN_CONTROL', '操作期间控制权发生变化，请检查窗口结果。');
      }
      return result;
    } finally { this.busy = false; }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const closing = this.closePromise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    void closing.catch(() => {}); // Synchronous takeover/event paths must not create unhandled rejections.
    const failures: unknown[] = [];
    this.closed = true; clearInterval(this.timer);
    try { this.end(); } catch (error) { failures.push(error); }
    this.closeDriver(this.catalog);
    void (async () => {
      // Include previously replaced catalog/owner drivers, not just the two
      // current references. All cancellations above happened before this await.
      for (;;) {
        const pending = [...this.retiringDrivers].filter(entry => !entry.done);
        if (!pending.length) break;
        await Promise.all(pending.map(entry => entry.settled));
      }
      try { await this.inputObserver?.detach(); } catch (error) { failures.push(error); }
      this.pendingRetirements();
      if (failures.length || this.stopFailureCount) throw Object.assign(desktopError('DESKTOP_DRIVER_STOP_UNCONFIRMED'), {
        details: { failureCount: failures.length + this.stopFailureCount, failures: [...failures, ...this.stopFailures] }
      });
    })().then(resolve, reject);
    return closing;
  }
}
