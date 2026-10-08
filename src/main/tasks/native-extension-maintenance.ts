import type { NativeInstallDriver } from "./native-installer";

interface MaintenanceState {
  profileId: string; connected: boolean; extensionVersion?: string; installationType?: string; installationMode?: string;
  ownerSessionId?: string; pausedByBrowser?: boolean;
}
interface MaintenanceBridge {
  states(): MaintenanceState[];
  onEvent(listener: (event: { type: string }) => void): () => void;
  request(profileId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function olderVersion(actual: string, expected: string): boolean {
  if (![actual, expected].every(v => /^\d+(?:\.\d+){0,3}$/.test(v))) return false;
  const a = actual.split('.').map(Number), b = expected.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

// Files are repaired once on app startup. An active task (including user
// takeover) is never disrupted. Chrome owns updates for store installations.
export function startNativeExtensionMaintenance(driver: NativeInstallDriver, bridge: MaintenanceBridge, onError: (error: unknown) => void = console.error): () => void {
  let closed = false;
  let expectedVersion: string | undefined;
  let extensionPath: string | undefined;
  const attempted = new Set<string>();
  const legacyReported = new Set<string>();
  const waiting = new Map<string, NodeJS.Timeout>();
  const fail = (profileId: string, error: unknown) => {
    if (closed) return;
    clearTimeout(waiting.get(profileId)); waiting.delete(profileId);
    driver.reportMaintenance?.(profileId, { stage: 'failed', mode: 'local', extensionPath, version: expectedVersion,
      message: '扩展自动更新未完成。请在 Chrome 扩展管理页重新加载 ProfilePilot；如仍为旧版本，请从固定目录重新加载扩展。配对信息会保留。' });
    onError(error);
  };
  const refresh = () => {
    if (closed || !expectedVersion) return;
    for (const state of bridge.states()) {
      if (state.connected && !state.extensionVersion) {
        if (!legacyReported.has(state.profileId)) {
          legacyReported.add(state.profileId);
          driver.reportMaintenance?.(state.profileId, { stage: 'failed', extensionPath, version: expectedVersion,
            message: `检测到旧版扩展，需要升级后才能使用当前浏览器能力。请在 Chrome 扩展管理页从固定目录 ${extensionPath} 重新加载 ProfilePilot；保留现有扩展和配对信息，无需卸载或重新配对。` });
        }
        continue;
      }
      if (state.connected && state.extensionVersion && !olderVersion(state.extensionVersion, expectedVersion)) {
        clearTimeout(waiting.get(state.profileId)); waiting.delete(state.profileId);
        driver.reportMaintenance?.(state.profileId);
      }
      if (!state.connected || state.ownerSessionId || state.pausedByBrowser || state.installationMode === 'temporary' || state.installationType !== 'development' || !state.extensionVersion || !olderVersion(state.extensionVersion, expectedVersion)) continue;
      const key = `${state.profileId}:${state.extensionVersion}:${expectedVersion}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      const timer = setTimeout(() => fail(state.profileId, new Error('Extension did not report the expected version after reload')), 20000);
      timer.unref(); waiting.set(state.profileId, timer);
      // The extension rechecks ownership when this request actually arrives.
      void bridge.request(state.profileId, 'extension.reload', {}).catch(error => fail(state.profileId, error));
    }
  };
  const unsubscribe = bridge.onEvent(event => { if (event.type === 'state') refresh(); });
  if (driver.prepare) void driver.prepare().then(prepared => { expectedVersion = prepared.version; extensionPath = prepared.extensionPath; refresh(); }).catch(error => { if (!closed) onError(error); });
  return () => { closed = true; unsubscribe(); for (const timer of waiting.values()) clearTimeout(timer); waiting.clear(); };
}
