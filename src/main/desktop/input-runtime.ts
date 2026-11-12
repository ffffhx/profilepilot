import { WindowsInputBroker, type WindowsInputBrokerOptions } from './input-broker';
import { WindowsBrowserInputGuard } from './browser-input-guard';
import { spawnWindowsInputObserver } from './input-observer-process';
import type { InputGuardFactory } from '../input-guard';
import type { DesktopServiceInputObserver } from './service';
import type { InputObserverPause } from './input-observer';

// One runtime per App: browser protection and desktop observation share the
// same lazy child. Constructing a runtime or a subscription never installs a
// hook. There is no fallback to a second Windows helper when this one fails.
export class WindowsInputRuntime {
  private readonly broker: WindowsInputBroker;
  private desktop?: { onPause(event: InputObserverPause): void; detaching: boolean };
  private browserSequence = 0;
  private closed = false;

  constructor(options: Omit<WindowsInputBrokerOptions, 'spawn' | 'onPause'> & {
    spawn?: WindowsInputBrokerOptions['spawn'];
  } = {}) {
    this.broker = new WindowsInputBroker({ ...options, spawn: options.spawn || (() => spawnWindowsInputObserver()),
      onPause: event => { if (this.desktop && !this.desktop.detaching) this.desktop.onPause(event); } });
  }

  readonly browserGuard: InputGuardFactory = callbacks => {
    this.assertOpen();
    return new WindowsBrowserInputGuard({ broker: this.broker, subscriptionId: 'app-overlay-' + ++this.browserSequence, ...callbacks });
  };

  readonly observeDesktop = (onPause: (event: InputObserverPause) => void): DesktopServiceInputObserver => {
    this.assertOpen();
    if (this.desktop) throw Object.assign(new Error('Desktop input observation is already bound.'), { code: 'DESKTOP_INPUT_OBSERVER_BUSY' });
    const binding = { onPause, detaching: false };
    this.desktop = binding;
    const current = () => {
      this.assertOpen();
      if (this.desktop !== binding || binding.detaching) throw Object.assign(new Error('Desktop input subscription has ended.'), { code: 'DESKTOP_INPUT_OBSERVER_CANCELLED' });
    };
    return {
      arm: (generation, marker, backgroundTarget) => {
        try { current(); } catch (error) { return Promise.reject(error); }
        return this.broker.arm(generation, marker, backgroundTarget);
      },
      disarm: generation => {
        // Only this binding can own the broker's single desktop slot. The
        // broker checks exact live generations and retains reuse history.
        if (this.desktop === binding && !binding.detaching) this.broker.disarm(generation);
      },
      snapshot: () => {
        current();
        const state = this.broker.snapshot();
        return { connected: state.connected && state.transport.state === 'ready', epoch: state.epoch, desktop: state.desktop };
      },
      detach: () => {
        if (this.desktop !== binding || binding.detaching) return;
        // Reserve the slot through synchronous broker callbacks: a successor
        // must not be armed between cancelling a pending generation and its
        // ready predecessor. No lifetime duplicate of their history is needed.
        binding.detaching = true;
        try {
          const state = this.broker.snapshot();
          for (const generation of new Set([state.pendingGeneration, state.desktop?.generation])) {
            if (generation) this.broker.disarm(generation);
          }
        } finally { if (this.desktop === binding) this.desktop = undefined; }
      }
    };
  };

  snapshot() { return this.broker.snapshot(); }
  dispose(): Promise<void> {
    this.closed = true;
    this.desktop = undefined;
    return this.broker.dispose();
  }
  private assertOpen() {
    if (this.closed) throw Object.assign(new Error('Windows input runtime has closed.'), { code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' });
  }
}

// The general shutdown coordinator runs stages in parallel. These three
// dependencies form one stage so the shared helper outlives both subscribers.
// Attempt every cleanup even if an earlier subscriber fails to release.
export async function closeInputControl(options: {
  closeDesktop(): void | Promise<void>;
  closeOverlay(): void | Promise<void>;
  closeRuntime(): void | Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const close of [options.closeDesktop, options.closeOverlay, options.closeRuntime]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw Object.assign(new Error('Input control cleanup was not fully confirmed.'), { failures });
}
