declare global {
  interface Window {
    desktopWindow?: {
      platform: string;
      setAppearance(background: string, symbols: string): void;
      onNavigate?(listener: (href: string) => void): () => void;
    };
  }
}

const root = document.documentElement;
const enabled = Boolean(window.desktopWindow) && new URLSearchParams(location.search).get("mode") !== "mini";
let sidebar: Element | null = null;
let navigation: Element | null = null;
let appearance = "";
let pending = false;
const observer = new ResizeObserver(scheduleUpdate);

function scheduleUpdate(): void {
  if (!enabled || pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; updateWindowChrome(); });
}

export function updateWindowChrome(): void {
  if (!enabled) return;
  const nextSidebar = document.querySelector(".app-sidebar, .app-frame > .sidebar");
  const rail = document.querySelector(".workspace-rail");
  if (nextSidebar !== sidebar || rail !== navigation) {
    observer.disconnect();
    sidebar = nextSidebar;
    navigation = rail;
    if (sidebar) observer.observe(sidebar);
    if (navigation) observer.observe(navigation);
  }
  const width = (sidebar ? sidebar.getBoundingClientRect().width : 0) + (rail ? rail.getBoundingClientRect().width : 0);
  const sidebarWidth = `${width}px`;
  if (root.style.getPropertyValue("--window-sidebar-width") !== sidebarWidth) {
    root.style.setProperty("--window-sidebar-width", sidebarWidth);
  }
  const styles = getComputedStyle(root);
  const background = styles.getPropertyValue("--panel-soft").trim() || styles.getPropertyValue("--bg").trim();
  const symbols = styles.getPropertyValue("--muted").trim();
  const nextAppearance = `${background}/${symbols}`;
  if (appearance !== nextAppearance) {
    appearance = nextAppearance;
    window.desktopWindow?.setAppearance(background, symbols);
  }
}

if (enabled) {
  root.classList.add("desktop-window");
  root.dataset.platform = window.desktopWindow!.platform;
  new MutationObserver(scheduleUpdate).observe(root, { attributes: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleUpdate);
  scheduleUpdate();
}
