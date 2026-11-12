/** Input completion is separate from both observation and business completion. */
export interface ActionFeedback<T> {
  actionOutcome: 'completed';
  observationStatus: 'available' | 'unavailable';
  observation?: T;
  observationError?: { code: string; message: string };
  nextStep: 'use-observation' | 'observe-or-check-control';
}
export const ACTION_SETTLE_MS = 500;

/** Call only after acknowledged input. Never retries input or resumes control. */
export async function observeAfterAction<T>(options: {
  observe: () => Promise<T>;
  check?: () => void | Promise<void>;
  invalidate: (error: unknown) => void;
  settleMs?: number;
  errorCode?: string;
}): Promise<ActionFeedback<T>> {
  try {
    await options.check?.();
    await new Promise(resolve => setTimeout(resolve, options.settleMs ?? ACTION_SETTLE_MS));
    await options.check?.();
    const observation = await options.observe();
    await options.check?.();
    return { actionOutcome: 'completed', observationStatus: 'available', observation, nextStep: 'use-observation' };
  } catch (error) {
    options.invalidate(error);
    return { actionOutcome: 'completed', observationStatus: 'unavailable', nextStep: 'observe-or-check-control',
      observationError: { code: (error as { code?: string })?.code || options.errorCode || 'POST_ACTION_OBSERVATION_FAILED',
        message: '动作已执行，但未取得操作后的界面观察。请检查控制状态或重新观察；不要因此重复动作。' } };
  }
}
