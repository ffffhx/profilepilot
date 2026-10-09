import { workspaceRoute } from "../shared/workspaces";
import "./workspace-lifecycle";

// Runs before each page bundle. Standalone/mini windows keep their own preload.
if (window.parent !== window && workspaceRoute(location.href, window.parent.location.href) && window.parent.workspaceHost?.owns(window)) {
  const workspace = workspaceRoute(location.href, window.parent.location.href)!.id;
  document.documentElement.classList.add("workspace-embedded");
  const subscriptions = new Set<() => void>();
  const pending = new Map<(...args: unknown[]) => void, unknown[]>();
  const pane: NonNullable<Window["workspacePane"]> = window.workspacePane = {
    active: false,
    setActive(active: boolean) {
      if (pane.active === active) return;
      if (!active) document.dispatchEvent(new CustomEvent("workspace-before-switch"));
      pane.active = active;
      document.documentElement.dataset.workspaceActive = String(active);
      if (active) {
        const queued = [...pending]; pending.clear();
        for (const [callback, args] of queued) callback(...args);
      }
      document.dispatchEvent(new CustomEvent("workspace-visibilitychange"));
    },
    route(search: string) { document.dispatchEvent(new CustomEvent("workspace-route", { detail: search })); },
    shortcut(event: KeyboardEventInit) { return !document.dispatchEvent(new KeyboardEvent("keydown", { ...event, bubbles: true, cancelable: true })); },
    dispose() { for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); pending.clear(); }
  };
  // All IPC still originates in the trusted top-level desktop document. No Node
  // integration, preload in subframes, remote content, or generic IPC forwarding.
  for (const name of ["profileManager", "tasks", "localApps", "phones", "mobile"] as const) {
    const source = window.parent[name];
    const api = Object.fromEntries(Object.entries(source).map(([method, value]) => {
      const allowed = name === "profileManager" ||
        (name === "phones" && (workspace === "phones" || method === "snapshot" || method === "onChanged")) ||
        (name === "mobile" && workspace === "phones") || (name === "localApps" && workspace === "local-apps") ||
        (name === "tasks" && ["agent", "browser", "tools"].includes(workspace));
      const unavailable = name === "phones" || name === "mobile" ? "请在手机工作区操作设备。" : name === "localApps" ? "本地应用接口只能由本地应用工作区调用。" : "不允许此页面调用任务接口。";
      if (!allowed) return [method, method.startsWith("on") ? () => () => {} : () => Promise.reject(new Error(unavailable))];
      if (typeof value !== "function" || !method.startsWith("on")) return [method, value];
      return [method, (callback: (...args: unknown[]) => void) => {
        const coalesce = method === "onChanged" || method === "onStateChanged";
        const unsubscribe = value((...args: unknown[]) => {
          if (coalesce && !pane.active) pending.set(callback, args);
          else callback(...args);
        }) as () => void;
        const dispose = () => { pending.delete(callback); subscriptions.delete(dispose); unsubscribe(); };
        subscriptions.add(dispose);
        return dispose;
      }];
    }));
    Object.defineProperty(window, name, { value: api });
  }
  Object.defineProperty(window, "desktopWindow", { value: { platform: window.parent.desktopWindow?.platform, setAppearance() {} } });
  window.addEventListener("pagehide", () => pane.dispose());
  document.addEventListener("click", event => {
    const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (window.parent.workspaceHost?.navigate(link.href)) event.preventDefault();
  });
}
