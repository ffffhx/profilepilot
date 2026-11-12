import { observeAfterAction } from './action-feedback';
export { ACTION_SETTLE_MS } from './action-feedback';
export type { ActionFeedback as BrowserActionFeedback } from './action-feedback';
import type { ActionFeedback } from './action-feedback';

/** Call only AFTER input has returned successfully. Never retries input or resumes control. */
export async function observeAfterBrowserAction<T>(options: {
  observe: () => Promise<T>;
  check?: () => void | Promise<void>;
  invalidate: () => void;
  settleMs?: number;
}): Promise<ActionFeedback<T>> {
  return observeAfterAction({ ...options, errorCode: 'BROWSER_POST_ACTION_OBSERVATION_FAILED' });
}
