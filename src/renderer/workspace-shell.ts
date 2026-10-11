import { workspacePages, workspaceRoute, workspaceNavigationId, type WorkspaceId } from "../shared/workspaces";
import { workspaceSwitcher, workspaceIdentityBar, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { createWorkspaceGuide } from "./workspace-guide";
import "./workspace-lifecycle";
import { experimentalAgentEnabled, onExperimentalFeaturesChanged } from "./experimental-features";

type Page = { id: WorkspaceId; frame: HTMLIFrameElement; ready: boolean; search: string; timer?: number; failed?: boolean };
const pages = new Map<WorkspaceId, Page>();
const container = document.getElementById("workspace-pages")!;
const loading = document.getElementById("workspace-loading")!;
const initial = new URLSearchParams(location.search).get("workspace") || "browser";
let requested: WorkspaceId = Object.hasOwn(workspacePages, initial) ? initial as WorkspaceId : "browser";
const consolePreference = "profilepilot-console-tab";
let lastConsole: WorkspaceId = "browser";
try {
  const saved = localStorage.getItem(consolePreference) as WorkspaceId;
  if (["browser", "local-apps", "phones"].includes(saved)) lastConsole = saved;
} catch { /* The console still works without persistent storage. */ }
if (requested === "browser") requested = lastConsole;
if (requested === "agent" && !experimentalAgentEnabled()) requested = "browser";
let active: Page | undefined;
const agentZoomPreference = "profilepilot-agent-zoom";
let agentZoom = 100;
try {
  const saved = Number(localStorage.getItem(agentZoomPreference));
  if (Number.isFinite(saved) && saved >= 80 && saved <= 150) agentZoom = Math.round(saved / 10) * 10;
} catch { /* Storage is optional; Agent starts at its default size. */ }

function applyAgentZoom(frame: HTMLIFrameElement): void {
  frame.style.setProperty("--agent-zoom", String(agentZoom / 100));
  frame.dataset.zoom = String(agentZoom);
}
document.getElementById("workspace-chrome")!.innerHTML = workspaceSwitcher(requested) + workspaceIdentityBar();
refreshWorkspaceSwitcher();
const guide = createWorkspaceGuide();

function pageFor(source: Window): Page | undefined {
  return [...pages.values()].find(page => page.frame.contentWindow === source &&
    workspaceRoute(source.location.href, location.href)?.id === page.id);
}

function activate(page: Page): void {
  if (!page.ready || page.id !== requested) return;
  if (active !== page) {
    active?.frame.contentWindow?.workspacePane?.setActive(false);
    if (active) { active.frame.dataset.active = "false"; active.frame.inert = true; }
    active = page;
    page.frame.dataset.active = "true";
    page.frame.inert = false;
    document.documentElement.dataset.workspace = page.id;
    document.title = `ProfilePilot · ${workspacePages[page.id].label}`;
    if (workspaceNavigationId(page.id) === "browser") {
      lastConsole = page.id;
      try { localStorage.setItem(consolePreference, lastConsole); } catch { /* Keep the current tab in memory. */ }
    }
    document.querySelectorAll<HTMLAnchorElement>('.workspace-link[data-workspace="browser"], .workspace-logo').forEach(link => link.href = `./${workspacePages[lastConsole].file}`);
    document.querySelectorAll<HTMLAnchorElement>(".workspace-link, .workspace-settings").forEach(link => {
      const selected = link.dataset.workspace === workspaceNavigationId(page.id);
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      link.removeAttribute("aria-busy");
    });
  }
  page.frame.contentWindow?.workspacePane?.setActive(true);
  if (page.search) { const search = page.search; page.search = ""; page.frame.contentWindow?.workspacePane?.route(search); }
  loading.hidden = true;
  document.documentElement.dataset.workspaceLoading = "false";
  if (page.id === "agent" && page.frame.contentDocument?.querySelector('[data-nav="settings"].active')) guide.close();
  else guide.showOnce(page.id);
}

function fail(page: Page): void {
  if (page.ready) return;
  page.failed = true;
  if (page.id !== requested) return;
  loading.replaceChildren(document.createTextNode(`${workspacePages[page.id].label} 加载未完成。`));
  const retry = document.createElement("button"); retry.textContent = "重试";
  retry.onclick = () => {
    page.frame.contentWindow?.workspacePane?.dispose();
    page.frame.remove(); pages.delete(page.id);
    navigate(workspacePages[page.id].file + page.search);
  };
  loading.append(retry); loading.hidden = false;
}

function navigate(href: string): boolean {
  const route = workspaceRoute(href, location.href);
  if (!route) return false;
  if (route.id === "agent" && !experimentalAgentEnabled()) return navigate(workspacePages.settings.file + "#experimental-features");
  requested = route.id;
  let page = pages.get(route.id);
  if (!page) {
    const frame = document.createElement("iframe");
    frame.className = "workspace-page";
    frame.name = `workspace-${route.id}`;
    frame.title = workspacePages[route.id].label;
    frame.dataset.workspace = route.id;
    frame.dataset.active = "false";
    if (route.id === "agent") applyAgentZoom(frame);
    frame.inert = true;
    // Each page owns only the content viewport, including its dialogs.
    // Hidden pages keep their DOM and JS state while the shell stays mounted.
    frame.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-modals allow-downloads");
    page = { id: route.id, frame, ready: false, search: route.url.search };
    pages.set(route.id, page);
    frame.src = route.url.href;
    container.append(frame);
    const loadingPage = page;
    page.timer = window.setTimeout(() => fail(loadingPage), 15000);
  } else if (route.url.search) page.search = route.url.search;
  document.querySelectorAll<HTMLAnchorElement>(".workspace-link, .workspace-settings").forEach(link => {
    if (link.dataset.workspace === workspaceNavigationId(route.id) && !page!.ready) link.setAttribute("aria-busy", "true");
    else link.removeAttribute("aria-busy");
  });
  if (page.ready) activate(page);
  else {
    document.documentElement.dataset.workspaceLoading = "true";
    loading.textContent = `正在打开${workspacePages[route.id].label}…`;
    loading.hidden = false;
    if (page.failed) fail(page);
  }
  return true;
}

window.workspaceHost = {
  navigate,
  openGuide: () => guide.open(),
  owns: source => Boolean(pageFor(source)),
  ready(source) {
    const page = pageFor(source);
    if (!page) return;
    if (!page.ready) { page.ready = true; window.clearTimeout(page.timer); }
    activate(page);
  }
};
document.addEventListener("click", event => {
  const target = event.target as Element;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (navigate(link.href)) event.preventDefault();
});
document.addEventListener("keydown", event => {
  if (document.querySelector(".workspace-guide[open]")) return;
  const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  if (event.isComposing || !modifier || active?.id !== "agent") return;
  if (!["k", "f"].includes(event.key.toLowerCase()) && !(event.shiftKey && event.key.toLowerCase() === "o")) return;
  if (active.frame.contentWindow?.workspacePane?.shortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey })) event.preventDefault();
});
window.desktopWindow?.onNavigate?.(href => navigate(href));
window.desktopWindow?.onAgentZoom?.(command => {
  if (active?.id !== "agent" || document.querySelector(".workspace-guide[open]")) return;
  agentZoom = command === "reset" ? 100 : Math.max(80, Math.min(150, agentZoom + (command === "in" ? 10 : -10)));
  applyAgentZoom(active.frame);
  try { localStorage.setItem(agentZoomPreference, String(agentZoom)); } catch { /* Keep the current zoom in memory. */ }
});
onExperimentalFeaturesChanged(() => {
  if (!experimentalAgentEnabled() && requested === "agent") { guide.close(); navigate(workspacePages.browser.file); }
});
navigate(workspacePages[requested].file);
