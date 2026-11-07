export interface MainWindowStartupMode {
  platform: string;
  background: boolean;
  backgroundE2e: boolean;
  smokeTest: boolean;
  driverTest: boolean;
}

export function mainWindowInitialVisibility(mode: MainWindowStartupMode): { show: boolean; waitForFirstPaint: boolean } {
  const visible = !mode.backgroundE2e && !mode.background && (!mode.smokeTest || mode.driverTest);
  const waitForFirstPaint = visible && mode.platform === "win32";
  return { show: visible && !waitForFirstPaint, waitForFirstPaint };
}

interface FirstPaintWindow {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
}

export interface FirstPaintResult {
  trigger: "ready-to-show" | "timeout" | "cancel";
  cancellation?: string;
  elapsedMs: number;
  showRequested: boolean;
  current: boolean;
  quitting: boolean;
  destroyed: boolean;
  visible: boolean;
  minimized: boolean;
}

/** One initial show only; renderer readiness does not prove asynchronous iframe content has painted. */
export function waitForMainWindowFirstPaint(options: {
  window: FirstPaintWindow;
  isCurrent: () => boolean;
  isQuitting: () => boolean;
  onSettled: (result: FirstPaintResult) => void;
  timeoutMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}): { cancel: (reason: string) => void } {
  const window = options.window;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let pending = true;
  let stopTimer: (() => void) | undefined;
  const listeners: Array<[string, () => void]> = [];
  const snapshot = () => {
    const destroyed = window.isDestroyed();
    return { current: options.isCurrent(), quitting: options.isQuitting(), destroyed,
      visible: !destroyed && window.isVisible(), minimized: !destroyed && window.isMinimized() };
  };
  const finish = (trigger: FirstPaintResult["trigger"], cancellation?: string) => {
    if (!pending) return;
    pending = false;
    stopTimer?.();
    for (const [event, listener] of listeners) window.removeListener(event, listener);
    const state = snapshot();
    const showRequested = trigger !== "cancel" && state.current && !state.quitting && !state.destroyed && !state.visible && !state.minimized;
    if (showRequested) window.show();
    options.onSettled({ trigger, cancellation, elapsedMs: Math.max(0, now() - startedAt), showRequested, ...snapshot() });
  };
  const cancel = (reason: string) => finish("cancel", reason);
  listeners.push(["ready-to-show", () => finish("ready-to-show")]);
  for (const event of ["show", "hide", "minimize", "close", "closed"]) listeners.push([event, () => cancel(event)]);
  for (const [event, listener] of listeners) window.on(event, listener);
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  });
  stopTimer = schedule(() => finish("timeout"), options.timeoutMs ?? 5000);
  return { cancel };
}
