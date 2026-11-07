import { z } from 'zod';

// Pure protocol/state for the shared Windows input helper. Production wiring
// lives in input-runtime; this module itself performs no OS input collection.
const identity = z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/);
const markerValue = z.string().regex(/^[a-fA-F0-9]{1,16}$/).transform(value => value.toLowerCase().padStart(16, '0'));
const registeredMarker = markerValue.refine(value => value !== '0000000000000000');
const sequence = z.string().refine(value => /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
export function pointerInputMarker(value: string): string {
  const source = BigInt('0x' + registeredMarker.parse(value));
  const low = source & 0xffffffffn;
  return (low || source >> 32n).toString(16).padStart(16, '0');
}
const activityKind = z.enum(['keyboard', 'pointer', 'button', 'wheel']);
const startupDetailsSchema = z.object({ stage: z.literal('instance-gate'), win32Error: z.number().int().min(0).max(0xffffffff) }).strict();
export const inputObserverStartupFailureSchema = startupDetailsSchema.extend({ type: z.literal('startup-failure') }).strict();
export type InputObserverStartupFailure = z.infer<typeof inputObserverStartupFailureSchema>;
export type InputObserverStartupReason = 'instance_in_use' | 'instance_access_denied' | 'instance_gate_failed';
export function describeInputObserverStartupFailure(failure: InputObserverStartupFailure): { reason: InputObserverStartupReason; code: string } {
  return failure.win32Error === 183 ? { reason: 'instance_in_use', code: 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY' }
    : failure.win32Error === 5 ? { reason: 'instance_access_denied', code: 'DESKTOP_INPUT_OBSERVER_ACCESS_UNAVAILABLE' }
      : { reason: 'instance_gate_failed', code: 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE' };
}
export function inputObserverStartupErrorFailure(error: unknown): InputObserverStartupFailure | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; details?: unknown };
  const parsed = z.object({ inputObserver: startupDetailsSchema }).strict().safeParse(value.details);
  if (!parsed.success) return null;
  const failure: InputObserverStartupFailure = { type: 'startup-failure', ...parsed.data.inputObserver };
  return describeInputObserverStartupFailure(failure).code === value.code ? failure : null;
}
export const isInputObserverStartupErrorCode = (code: unknown): boolean => typeof code === 'string'
  && ['DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', 'DESKTOP_INPUT_OBSERVER_ACCESS_UNAVAILABLE', 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE'].includes(code);

// No virtual key, scan code, text, character, or global coordinate field is
// accepted. Unknown fields are rejected, never copied into state or callbacks.
export const inputObserverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('desktop-armed'), epoch: identity, generation: identity, sequence }).strict(),
  z.object({ type: z.literal('input-activity'), epoch: identity, generation: identity, sequence,
    kind: activityKind, injected: z.boolean(), marker: markerValue.optional() }).strict(),
  z.object({ type: z.literal('observer-fault'), epoch: identity, generation: identity,
    reason: z.enum(['overflow', 'unavailable']) }).strict()
]);

export type InputObserverCommand =
  | { type: 'browser-config'; epoch: string; revision: string; pids: number[] }
  | { type: 'desktop-arm'; epoch: string; generation: string; marker: string }
  | { type: 'desktop-rearm'; epoch: string; previousGeneration: string; generation: string; marker: string }
  | { type: 'desktop-disarm'; epoch: string; generation: string };
export type InputObserverPauseReason = 'physical_input' | 'external_input' | 'helper_exited' | 'disconnected'
  | 'helper_replaced' | 'overflow' | 'unavailable' | 'protocol_error' | 'send_failed' | InputObserverStartupReason;
export interface InputObserverPause {
  epoch: string; generation: string; reason: InputObserverPauseReason; certainty: 'observed' | 'unknown';
  kind?: z.infer<typeof activityKind>; sequence?: string;
  startupFailure?: InputObserverStartupFailure;
}
export interface DesktopObserverSubscription {
  epoch: string; generation: string; phase: 'arming' | 'ready' | 'paused'; sequence?: string;
  previousGeneration?: string;
  reason?: InputObserverPauseReason; certainty?: 'observed' | 'unknown';
}
export interface InputObserverSnapshot {
  connected: boolean; epoch: string | null; browserPids: number[]; desktop: DesktopObserverSubscription | null;
}
interface DesktopState extends DesktopObserverSubscription { marker: string; lastSequence: bigint; }
export interface DesktopInputObserverOptions {
  send(command: InputObserverCommand): void;
  onPause(event: InputObserverPause): void;
}

export class DesktopInputObserver {
  private epoch: string | null = null;
  private connected = false;
  private browsers = new Map<string, number[]>();
  private browserRevision = 0n;
  private desktop: DesktopState | null = null;
  private generations = new Set<string>();
  private epochs = new Set<string>();
  // Only acknowledged markers are trusted, and only within this child epoch.
  // They outlive subscriptions so a retiring driver's queued release is still
  // recognized. A replacement native child has no prior registration history.
  private markers = new Set<string>();
  private pointerMarkers = new Set<string>();
  constructor(private options: DesktopInputObserverOptions) {}

  snapshot(): InputObserverSnapshot {
    const state = this.desktop;
    const desktop: DesktopObserverSubscription | null = state ? {
      epoch: state.epoch, generation: state.generation, phase: state.phase,
      ...(state.phase === 'arming' && state.previousGeneration ? { previousGeneration: state.previousGeneration } : {}),
      ...(state.lastSequence >= 0n ? { sequence: state.lastSequence.toString() } : {}),
      ...(state.reason ? { reason: state.reason, certainty: state.certainty } : {})
    } : null;
    return { connected: this.connected, epoch: this.epoch, browserPids: this.browserPids(), desktop };
  }
  connect(epoch: string): InputObserverSnapshot {
    identity.parse(epoch);
    if (this.connected && this.epoch === epoch) return this.snapshot();
    if (this.epochs.has(epoch)) throw new Error('Desktop observer epochs cannot be reused.');
    this.epochs.add(epoch); this.markers.clear(); this.pointerMarkers.clear();
    this.epoch = epoch; this.connected = true;
    if (this.desktop) this.pause(this.desktop, 'helper_replaced', 'unknown');
    // Restoring the helper restores browser subscriptions only. A paused desktop
    // requires an explicit new generation and a fresh matching acknowledgement.
    this.sendBrowsers();
    return this.snapshot();
  }
  setBrowserSubscription(id: string, pids: number[]): void {
    identity.parse(id);
    const validated = z.array(z.number().int().min(1).max(0xffffffff)).max(256).parse(pids);
    const next = [...new Set(validated)].sort((a, b) => a - b);
    const previous = this.browsers.get(id);
    if (previous && previous.length === next.length && previous.every((pid, index) => pid === next[index])) return;
    this.browsers.set(id, next); this.browserRevision++; this.sendBrowsers();
  }
  removeBrowserSubscription(id: string): void {
    identity.parse(id);
    if (this.browsers.delete(id)) { this.browserRevision++; this.sendBrowsers(); }
  }
  observeDesktop(generation: string, marker: string): InputObserverSnapshot {
    identity.parse(generation);
    const normalizedMarker = registeredMarker.parse(marker);
    if (this.generations.has(generation)) {
      if (this.connected && this.desktop?.epoch === this.epoch && this.desktop.generation === generation && this.desktop.marker === normalizedMarker) return this.snapshot();
      throw new Error('Desktop observer generations cannot be reused.');
    }
    if (!this.connected || !this.epoch) throw new Error('Desktop observer helper is not connected.');
    const previous = this.desktop?.phase === 'ready' && this.desktop.epoch === this.epoch ? this.desktop : null;
    this.generations.add(generation);
    this.desktop = { epoch: this.epoch, generation, marker: normalizedMarker, phase: 'arming',
      lastSequence: previous?.lastSequence ?? -1n, ...(previous ? { previousGeneration: previous.generation } : {}) };
    // A ready predecessor must remain armed until the helper atomically checks
    // its latch and registers the successor. Never close that observation gap
    // with DISARM followed by an unconditional ARM.
    this.send(previous
      ? { type: 'desktop-rearm', epoch: this.epoch, previousGeneration: previous.generation, generation, marker: normalizedMarker }
      : { type: 'desktop-arm', epoch: this.epoch, generation, marker: normalizedMarker });
    return this.snapshot();
  }
  stopDesktop(generation: string): void {
    if (!this.desktop || this.desktop.generation !== generation) return;
    const previous = this.desktop; this.desktop = null;
    if (this.connected && this.epoch === previous.epoch) this.send({ type: 'desktop-disarm', epoch: previous.epoch, generation });
  }
  disconnect(sourceEpoch: string, reason: 'helper_exited' | 'disconnected' = 'disconnected'): void {
    if (!this.connected || this.epoch !== sourceEpoch) return;
    this.connected = false;
    if (this.desktop) this.pause(this.desktop, reason, 'unknown');
  }
  receiveLine(sourceEpoch: string, line: string): boolean {
    if (!this.connected || sourceEpoch !== this.epoch) return false;
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 2048) return this.protocolFailure();
    let value: unknown;
    try { value = JSON.parse(line); } catch { return this.protocolFailure(); }
    return this.receive(sourceEpoch, value);
  }
  receive(sourceEpoch: string, value: unknown): boolean {
    // Bind transport callbacks to their child epoch before parsing. Old helper
    // output, including malformed output, cannot affect a new helper's session.
    if (!this.connected || sourceEpoch !== this.epoch) return false;
    // A complete but obsolete envelope may belong to an earlier protocol/config
    // revision. Ignore its explicit routing identity before validating its body.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const route = value as Record<string, unknown>;
      if (typeof route.epoch === 'string' && route.epoch !== sourceEpoch) return false;
      if (this.desktop && typeof route.generation === 'string' && route.generation !== this.desktop.generation
          && !(this.desktop.phase === 'arming' && route.generation === this.desktop.previousGeneration)) return false;
    }
    const parsed = inputObserverMessageSchema.safeParse(value);
    if (!parsed.success) return this.protocolFailure();
    const message = parsed.data, state = this.desktop;
    if (message.epoch !== sourceEpoch || !state || state.epoch !== message.epoch) return false;
    const predecessor = state.phase === 'arming' && message.generation === state.previousGeneration;
    if (state.generation !== message.generation && !predecessor) return false;
    if (message.type === 'observer-fault') { this.pause(state, message.reason, 'unknown'); return true; }
    if (state.phase === 'paused') return false;
    const nextSequence = BigInt(message.sequence);
    if (message.type === 'desktop-armed') {
      if (predecessor) return false;
      if (state.phase !== 'arming' || nextSequence < state.lastSequence) return false;
      this.markers.add(state.marker);
      this.pointerMarkers.add(pointerInputMarker(state.marker));
      state.lastSequence = nextSequence; state.phase = 'ready'; state.previousGeneration = undefined; return true;
    }
    if (nextSequence <= state.lastSequence) return false;
    state.lastSequence = nextSequence;
    // Match the explicitly sent pointer value, not a masked version of an
    // arbitrary external event. Mouse paths may truncate ULONG_PTR to 32 bits;
    // keyboard registration and matching keep all 64 bits.
    if (message.injected && message.marker && (message.kind === 'keyboard' ? this.markers : this.pointerMarkers).has(message.marker)) return true;
    // Activity before the acknowledgement also latches pause. A delayed ack must
    // never turn that subscription ready after the user has started interacting.
    this.pause(state, message.injected ? 'external_input' : 'physical_input', 'observed', message.kind, message.sequence);
    return true;
  }
  private browserPids(): number[] { return [...new Set([...this.browsers.values()].flat())].sort((a, b) => a - b); }
  private sendBrowsers(): void {
    if (this.connected && this.epoch) this.send({ type: 'browser-config', epoch: this.epoch, revision: this.browserRevision.toString(), pids: this.browserPids() });
  }
  private send(command: InputObserverCommand): void {
    try { this.options.send(command); }
    catch {
      this.connected = false;
      if (this.desktop) this.pause(this.desktop, 'send_failed', 'unknown');
    }
  }
  private protocolFailure(): false {
    if (this.desktop) this.pause(this.desktop, 'protocol_error', 'unknown');
    return false;
  }
  private pause(state: DesktopState, reason: InputObserverPauseReason, certainty: 'observed' | 'unknown', kind?: z.infer<typeof activityKind>, sequence?: string): void {
    if (this.desktop !== state) return;
    if (state.phase === 'paused') {
      if (certainty === 'unknown') state.certainty = 'unknown';
      return;
    }
    state.phase = 'paused'; state.reason = reason; state.certainty = certainty;
    this.options.onPause({ epoch: state.epoch, generation: state.generation, reason, certainty,
      ...(kind ? { kind } : {}), ...(sequence ? { sequence } : {}) });
  }
}
