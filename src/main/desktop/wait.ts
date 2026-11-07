import { performance } from 'node:perf_hooks';
import type { DesktopObservation } from '../../shared/desktop';
import { desktopError } from './worker';

export interface DesktopWaitCondition { name?: string; role?: string; automationId?: string; text?: string; hasAction?: string; }
export interface DesktopWaitOptions { condition: DesktopWaitCondition; timeoutMs: number; intervalMs: number; }
export interface DesktopWaitResult {
  matched: boolean; timedOut: boolean; attempts: number; elapsedMs: number;
  matchedReferences: string[]; observation?: DesktopObservation; requiresObservation: boolean;
}

type ObservedElement = DesktopObservation['elements'][number];
function completeField(observation: DesktopObservation, element: ObservedElement, field: 'name' | 'automationId' | 'text'): boolean {
  // New helpers identify the affected node. Older helpers only identify the
  // field globally, so a matching prefix is not proof of exact equality.
  if (Array.isArray(element.truncatedFields)) return !element.truncatedFields.includes(field);
  const gap = field === 'automationId' ? 'automation_id_limit' : `${field}_limit`;
  return !observation.gaps?.includes(gap);
}
function readableText(element: ObservedElement): boolean {
  if (element.password) return false;
  if (element.stateGaps?.includes('value_evidence') ||
    (element.state?.valueStatus === 'readable' && element.state.valueEvidence === 'unconfirmed')) return false;
  if (element.textStatus !== undefined) return element.textStatus === 'readable';
  const status = element.state?.valueStatus;
  if (status === 'unavailable' || status === 'redacted') return false;
  // Legacy nonempty text proves a successful Value/TextPattern read. An empty
  // Document could equally mean TryGetCurrentPattern failed, so only an
  // explicitly readable Value can prove an empty value without new metadata.
  return element.text !== '' || status === 'readable';
}

// Poll only observations. A successful Invoke does not mean its asynchronous
// UI effect has completed, and waiting must never repeat that input.
export async function waitForDesktopCondition(options: DesktopWaitOptions, observe: () => Promise<DesktopObservation>, signal: AbortSignal): Promise<{ result: DesktopWaitResult; pendingRead: boolean }> {
  const started = performance.now();
  let attempts = 0, last: DesktopObservation | undefined, pendingRead = false;
  let timer: NodeJS.Timeout | undefined;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(desktopError('DESKTOP_USER_IN_CONTROL', '控制权已变化，已停止等待。'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  // A caller can pass an already-aborted signal, before the first race exists.
  void cancelled.catch(() => {});
  const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), options.timeoutMs); });
  const result = (matchedReferences: string[], timedOut: boolean): DesktopWaitResult => ({
    matched: matchedReferences.length > 0, timedOut, attempts, elapsedMs: Math.round(performance.now() - started),
    matchedReferences, observation: last, requiresObservation: timedOut
  });
  try {
    for (;;) {
      if (signal.aborted) throw desktopError('DESKTOP_USER_IN_CONTROL', '控制权已变化，已停止等待。');
      if (performance.now() - started >= options.timeoutMs) return { result: result([], true), pendingRead: false };
      attempts++;
      pendingRead = true;
      const read = observe().then(value => { pendingRead = false; return value; });
      const observed = await Promise.race([read, deadline, cancelled]);
      if (observed === 'deadline') return { result: result([], true), pendingRead };
      last = observed;
      const matches = observed.elements.filter(element => {
        const { condition } = options;
        return (condition.name === undefined || (!element.password && completeField(observed, element, 'name') && element.name === condition.name))
          && (condition.role === undefined || element.role === condition.role)
          && (condition.automationId === undefined || (completeField(observed, element, 'automationId') && element.automationId === condition.automationId))
          && (condition.text === undefined || (readableText(element) && completeField(observed, element, 'text') && element.text === condition.text))
          && (condition.hasAction === undefined || element.actions.includes(condition.hasAction));
      }).map(element => element.reference);
      // Promise microtasks can beat an overdue timer after a blocked event
      // loop. Enforce the monotonic deadline as well as racing the timer.
      if (signal.aborted) throw desktopError('DESKTOP_USER_IN_CONTROL', '控制权已变化，已停止等待。');
      if (performance.now() - started >= options.timeoutMs) return { result: result([], true), pendingRead: false };
      if (matches.length) return { result: result(matches, false), pendingRead: false };
      let interval: NodeJS.Timeout | undefined;
      try {
        const waited = await Promise.race([new Promise<'interval'>(resolve => { interval = setTimeout(() => resolve('interval'), options.intervalMs); }), deadline, cancelled]);
        if (waited === 'deadline') return { result: result([], true), pendingRead: false };
      } finally { if (interval) clearTimeout(interval); }
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
