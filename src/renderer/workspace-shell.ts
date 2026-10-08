import { workspacePages, workspaceRoute, type WorkspaceId } from "../shared/workspaces";
import { workspaceSwitcher, workspaceIdentityBar, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { createWorkspaceGuide } from "./workspace-guide";
import "./workspace-lifecycle";

type Page = { id: WorkspaceId; frame: HTMLIFrameElement; ready: boolean; search: string; timer?: number; failed?: boolean };
const pages = new Map<WorkspaceId, Page>();
const container = document.getElementById("workspace-pages")!;
const loading = document.getElementById("workspace-loading")!;
const initial = new URLSearchParams(location.search).get("workspace") || "agent";
let requested: WorkspaceId = Object.hasOwn(workspacePages, initial) ? initial as WorkspaceId : "agent";
let active: Page | undefined;
document.getElementById("workspace-chrome")!.innerHTML = workspaceSwitcher(requested) + workspaceIdentityBar();
refreshWorkspaceSwitcher();
const guide = createWorkspaceGuide(navigate);

function pageFor(source: Window): Page | undefined {
  return [...pages.values()].find(page => page.frame.contentWindow === source &&
    workspaceRoute(source.location.href, location.href)?.id === page.id);
}

function syncIdentity(source: Window): void {
  if (active?.frame.contentWindow !== source) return;
  const from = source.document.querySelector(".workspace-identity");
  const to = document.querySelector(".workspace-identity");
  if (!from || !to) return;
  const fromSelect = from.querySelector<HTMLSelectElement>("select")!;
  const toSelect = to.querySelector<HTMLSelectElement>("select")!;
  if (toSelect.innerHTML !== fromSelect.innerHTML) toSelect.innerHTML = fromSelect.innerHTML;
  toSelect.value = fromSelect.value;
  toSelect.disabled = fromSelect.disabled;
  (to as HTMLElement).dataset.identityProfile = (from as HTMLElement).dataset.identityProfile;
  const fromStatus = from.querySelector(".workspace-connection")!;
  const toStatus = to.querySelector(".workspace-connection")!;
  toStatus.className = fromStatus.className;
  toStatus.querySelector("span")!.textContent = fromStatus.querySelector("span")!.textContent;
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
    document.querySelectorAll<HTMLAnchorElement>(".workspace-link").forEach(link => {
      const selected = link.dataset.workspace === page.id;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      link.removeAttribute("aria-busy");
    });
  }
  page.frame.contentWindow?.workspacePane?.setActive(true);
  if (page.search) { const search = page.search; page.search = ""; page.frame.contentWindow?.workspacePane?.route(search); }
  syncIdentity(page.frame.contentWindow!);
  loading.hidden = true;
  document.documentElement.dataset.workspaceLoading = "false";
  guide.showOnce();
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
  requested = route.id;
  let page = pages.get(route.id);
  if (!page) {
    const frame = document.createElement("iframe");
    frame.className = "workspace-page";
    frame.name = `workspace-${route.id}`;
    frame.title = workspacePages[route.id].label;
    frame.dataset.workspace = route.id;
    frame.dataset.active = "false";
    frame.inert = true;
    // Keep existing media-query/layout coordinates while the outer rail and
    // title bar stay mounted. Hidden pages keep their DOM and JS state.
    frame.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-modals allow-downloads");
    page = { id: route.id, frame, ready: false, search: route.url.search };
    pages.set(route.id, page);
    frame.src = route.url.href;
    container.append(frame);
    const loadingPage = page;
    page.timer = window.setTimeout(() => fail(loadingPage), 15000);
  } else if (route.url.search) page.search = route.url.search;
  document.querySelectorAll<HTMLAnchorElement>(".workspace-link").forEach(link => {
    if (link.dataset.workspace === route.id && !page!.ready) link.setAttribute("aria-busy", "true");
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
  syncIdentity,
  ready(source) {
    const page = pageFor(source);
    if (!page) return;
    if (!page.ready) { page.ready = true; window.clearTimeout(page.timer); }
    activate(page);
  }
};
document.addEventListener("click", event => {
  const target = event.target as Element;
  if (target.closest("[data-workspace-search]")) { active?.frame.contentWindow?.workspacePane?.search(); return; }
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (navigate(link.href)) event.preventDefault();
});
document.addEventListener("workspace-profile-selected", event => {
  active?.frame.contentWindow?.workspacePane?.selectProfile((event as CustomEvent<string>).detail);
});
document.addEventListener("keydown", event => {
  if (document.querySelector(".workspace-guide[open]")) return;
  const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  if (event.isComposing || !modifier || active?.id !== "agent") return;
  if (!["k", "f"].includes(event.key.toLowerCase()) && !(event.shiftKey && event.key.toLowerCase() === "o")) return;
  if (active.frame.contentWindow?.workspacePane?.shortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey })) event.preventDefault();
});
window.desktopWindow?.onNavigate?.(href => navigate(href));
navigate(workspacePages[requested].file);
