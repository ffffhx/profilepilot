declare global {
  interface Window {
    desktopWindow?: {
      platform: string;
      setAppearance(background: string, symbols: string, guideActive?: boolean): void;
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

function shadeColor(color: string, overlay: string): string {
  if (!/^#[\da-f]{6}$/i.test(color) || !/^#[\da-f]{8}$/i.test(overlay)) return color;
  const alpha = parseInt(overlay.slice(7, 9), 16) / 255;
  return "#" + [1, 3, 5].map(offset => Math.round(
    parseInt(overlay.slice(offset, offset + 2), 16) * alpha +
    parseInt(color.slice(offset, offset + 2), 16) * (1 - alpha)
  ).toString(16).padStart(2, "0")).join("");
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
  const guideActive = root.dataset.workspaceGuideActive === "true";
  const shade = styles.getPropertyValue("--workspace-guide-shade").trim();
  const backgroundColor = styles.getPropertyValue("--panel-soft").trim() || styles.getPropertyValue("--bg").trim();
  const symbolColor = styles.getPropertyValue("--muted").trim();
  // Native caption controls sit above DOM overlays. Apply the same composited
  // colors to that surface so it joins the guide shade, then restore on close.
  const background = guideActive ? shadeColor(backgroundColor, shade) : backgroundColor;
  const symbols = guideActive ? shadeColor(symbolColor, shade) : symbolColor;
  const nextAppearance = `${background}/${symbols}/${guideActive}`;
  if (appearance !== nextAppearance) {
    appearance = nextAppearance;
    window.desktopWindow?.setAppearance(background, symbols, guideActive);
  }
}

if (enabled) {
  root.classList.add("desktop-window");
  root.dataset.platform = window.desktopWindow!.platform;
  new MutationObserver(scheduleUpdate).observe(root, { attributes: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleUpdate);
  scheduleUpdate();
}
