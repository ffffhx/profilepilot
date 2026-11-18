import { workspaceRoute } from "../shared/workspaces";
import { REVIEW_METHODS } from "../shared/review";
import "./workspace-lifecycle";

const MAX_QUEUED_REVISIONS = 128;

type PendingBatch = { items: unknown[][]; overflowed?: boolean };

function isSequentialRevisionEvent(name: string, method: string, args: unknown[]): boolean {
  if (method !== "onChanged") return false;
  if (name === "tasks") return true;
  const payload = args[0];
  return typeof payload === "object" && payload !== null && typeof (payload as { revision?: unknown }).revision === "number";
}

if (/[?&]mode=mini(?:&|#|$)/.test(location.href)) {
  document.documentElement.classList.add("mini-document");
}

// Runs before each page bundle. Standalone/mini windows keep their own preload.
if (window.parent !== window && workspaceRoute(location.href, window.parent.location.href) && window.parent.workspaceHost?.owns(window)) {
  const workspace = workspaceRoute(location.href, window.parent.location.href)!.id;
  document.documentElement.classList.add("workspace-embedded");
  const subscriptions = new Set<() => void>();
  const liveCallbacks = new Set<(...args: unknown[]) => void>();
  const pending = new Map<(...args: unknown[]) => void, PendingBatch>();
  const pane: NonNullable<Window["workspacePane"]> = window.workspacePane = {
    active: false,
    setActive(active: boolean) {
      if (pane.active === active) return;
      if (!active) document.dispatchEvent(new CustomEvent("workspace-before-switch"));
      pane.active = active;
      document.documentElement.dataset.workspaceActive = String(active);
      if (active) {
        const queued = [...pending]; pending.clear();
        for (const [callback, batch] of queued) {
          for (const args of batch.items) {
            if (!liveCallbacks.has(callback)) break;
            callback(...args);
          }
        }
      }
      document.dispatchEvent(new CustomEvent("workspace-visibilitychange"));
    },
    route(search: string) { document.dispatchEvent(new CustomEvent("workspace-route", { detail: search })); },
    shortcut(event: KeyboardEventInit) { return !document.dispatchEvent(new KeyboardEvent("keydown", { ...event, bubbles: true, cancelable: true })); },
    dispose() { for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); liveCallbacks.clear(); pending.clear(); }
  };
  // All IPC still originates in the trusted top-level desktop document. No Node
  // integration, preload in subframes, remote content, or generic IPC forwarding.
  for (const name of ["profileManager", "browserConnection", "tasks", "localApps", "phones", "mobile", "desktopControl", "gpuiControl"] as const) {
    const source = window.parent[name];
    const api = Object.fromEntries(Object.entries(source).map(([method, value]) => {
      const allowed = name === "profileManager" ||
        (name === "desktopControl" && workspace === "desktop") ||
        (name === "gpuiControl" && workspace === "gpui") ||
        (name === "phones" && (workspace === "phones" || method === "snapshot" || method === "onChanged")) ||
        (name === "mobile" && workspace === "phones") || (name === "localApps" && workspace === "local-apps") ||
        (name === "browserConnection" && ["agent", "browser", "tools"].includes(workspace)) ||
        (name === "tasks" && ["agent", "browser", "tools"].includes(workspace)) ||
        (name === "tasks" && workspace === "settings" && REVIEW_METHODS.includes(method));
      const unavailable = name === "phones" || name === "mobile" ? "请在手机工作区操作设备。" : name === "localApps" ? "本地应用接口只能由本地应用工作区调用。" : "不允许此页面调用任务接口。";
      if (!allowed) return [method, method.startsWith("on") ? () => () => {} : () => Promise.reject(new Error(unavailable))];
      if (typeof value !== "function" || !method.startsWith("on")) return [method, value];
      return [method, (callback: (...args: unknown[]) => void) => {
        const deferWhenInactive = method === "onChanged" || method === "onStateChanged" || method === "onPreview";
        liveCallbacks.add(callback);
        const unsubscribe = value((...args: unknown[]) => {
          if (deferWhenInactive && !pane.active) {
            if (isSequentialRevisionEvent(name, method, args)) {
              const existing = pending.get(callback);
              if (!existing) {
                pending.set(callback, { items: [args] });
              } else if (existing.overflowed) {
                existing.items = [args];
              } else if (existing.items.length < MAX_QUEUED_REVISIONS) {
                existing.items.push(args);
              } else {
                existing.overflowed = true;
                existing.items = [args];
              }
            } else {
              pending.set(callback, { items: [args] });
            }
          } else {
            callback(...args);
          }
        }) as () => void;
        const dispose = () => { liveCallbacks.delete(callback); pending.delete(callback); subscriptions.delete(dispose); unsubscribe(); };
        subscriptions.add(dispose);
        return dispose;
      }];
    }));
    Object.defineProperty(window, name, { value: api });
  }
  Object.defineProperty(window, "desktopWindow", { value: { platform: window.parent.desktopWindow?.platform, setAppearance() {} } });
  if (workspace === "settings") Object.defineProperty(window, "appUpdate", { value: {
    status: () => window.parent.appUpdate.status(),
    open: () => window.parent.appUpdate.open()
  } });
  window.addEventListener("pagehide", () => pane.dispose());
  document.addEventListener("click", event => {
    const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (window.parent.workspaceHost?.navigate(link.href)) event.preventDefault();
  });
}
