import type { DesktopApi, DesktopStatus } from '../shared/desktop';

// Push changes invalidate in-flight reads so a stale active reply cannot
// overwrite a takeover/stop that arrived while that read was pending.
export function followDesktopStatus(api: Pick<DesktopApi, 'status' | 'onChanged'>,
  render: (status: DesktopStatus) => void, reportError: (error: unknown) => void) {
  let revision = 0, disposed = false;
  const unsubscribe = api.onChanged(state => {
    if (disposed) return;
    revision++; render(state);
  });
  return {
    async refresh() {
      const request = ++revision;
      try {
        const state = await api.status();
        if (!disposed && request === revision) render(state);
        return state;
      } catch (error) {
        if (!disposed && request === revision) reportError(error);
        return undefined;
      }
    },
    dispose() { if (disposed) return; disposed = true; revision++; unsubscribe(); }
  };
}
