import { contextBridge, ipcRenderer } from 'electron';

const documentNonce = new URLSearchParams(location.search).get('notice');
let unavailable = false;
const revoke = () => {
  if (unavailable) return; unavailable = true;
  try { void ipcRenderer.invoke('desktop:request', 'notice-unavailable', { documentNonce }).catch(() => {}); }
  catch { /* Renderer teardown cannot restore document readiness. */ }
};
window.addEventListener('pagehide', revoke, { once: true });
window.addEventListener('error', revoke, { once: true, capture: true });
window.addEventListener('unhandledrejection', revoke, { once: true });
// Sandboxed control bar: expose only its three controls, never the app's APIs.
contextBridge.exposeInMainWorld('desktopControl', {
  status: () => ipcRenderer.invoke('desktop:request', 'status'),
  // Main-world exceptions do not reliably cross the context-isolation boundary.
  // The page can revoke only this nonce; it cannot select a target or channel.
  noticeFailed: revoke,
  noticeReady: (generation: string) => unavailable ? Promise.reject(new Error('Control notice document is unavailable'))
    : ipcRenderer.invoke('desktop:request', 'notice-ready', { generation, documentNonce }),
  control: (action: string, expected?: { session: string; generation: string; revision: number }) =>
    ipcRenderer.invoke('desktop:request', 'control', action === 'return'
      ? { action, session: expected?.session, generation: expected?.generation, revision: expected?.revision } : action),
  onChanged: (listener: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on('desktop:changed', handler);
    return () => ipcRenderer.removeListener('desktop:changed', handler);
  }
});
