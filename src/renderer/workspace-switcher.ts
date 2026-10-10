import { taskIcon } from "./task-icons";
import { workspaceNavigationId } from "../shared/workspaces";
import { updateWindowChrome } from "./window-chrome";
import { installPhoneStatus } from "./phone-status";
import { workspaceRendered } from "./workspace-lifecycle";
import { openWorkspaceGuide } from "./workspace-guide";
import { experimentalAgentEnabled, onExperimentalFeaturesChanged } from "./experimental-features";
import { installSidebarResize, sidebarResizeHandle } from "./sidebar-resize";

type Workspace = import("../shared/workspaces").WorkspaceId;
const railPreference = "profilepilot-workspace-rail";
const compactRail = window.matchMedia("(max-width:800px)");
const refreshRailWidth = installSidebarResize({
  id: "workspace", pane: "#workspace-rail", property: "--workspace-rail-custom-width",
  preference: "profilepilot-workspace-rail-width", min: 176, max: () => Math.min(360, window.innerWidth - 520)
});
let railChoice: string | null = null;
try { railChoice = localStorage.getItem(railPreference); } catch { /* Use the responsive default. */ }
function refreshRail(): void {
  const collapsed = railChoice === "collapsed" || railChoice !== "expanded" && compactRail.matches;
  document.documentElement.dataset.workspaceRail = collapsed ? "collapsed" : "expanded";
  const label = collapsed ? "展开主导航" : "收起主导航";
  document.querySelectorAll<HTMLButtonElement>("[data-toggle-workspace-rail]").forEach(button => {
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(!collapsed));
  });
  refreshRailWidth();
}
refreshRail();
compactRail.addEventListener("change", refreshRail);
window.addEventListener("storage", event => {
  if (event.key === railPreference) { railChoice = event.newValue; refreshRail(); }
});
const workspaces = [
  ["browser", "PC 控制", "浏览器 Profiles 与 Electron 应用", "./index.html", "desktop"],
  ["phones", "手机控制", "设备连接与控制", "./phones.html", "phone"],
  ["tools", "配套工具", "扩展、Skill 与 CLI", "./tools.html", "settings"],
  ["agent", "Agent", "任务与对话", "./tasks.html", "message"]
] as const;
export const workspaceBrandMark = '<svg class="workspace-brand-glyph" viewBox="0 0 28 34" aria-hidden="true"><path fill="#1474ff" d="M3 1 26 17 3 33Z"/><path fill="#004ce9" d="m3 15 12 2L3 33Z"/><path fill="#fff" d="m10 10 10 7-10 7Z"/></svg>';
const navigationIcon = (key: Workspace, fallback: Parameters<typeof taskIcon>[0]) => key === "agent"
  ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="5" r="3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4H5v4m7-4h7v4"/></svg>'
  : key === "browser" ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18m-16-5h14M5 17h14"/></svg>' : key === "tools" ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 6a6 6 0 0 0-7 7L2.8 17.2a2.8 2.8 0 0 0 4 4L11 17a6 6 0 0 0 7-8l-4 4-3-3 4-4Z"/></svg>' : taskIcon(fallback);
export function workspaceSwitcher(current: Workspace): string {
  installPhoneStatus();
  document.documentElement.classList.add("workspace-layout");
  document.documentElement.dataset.workspace = current;
  const navigation = workspaceNavigationId(current);
  return `<aside id="workspace-rail" class="workspace-rail" aria-label="工作区导航">
    <a class="workspace-logo" href="./index.html" data-workspace="browser" aria-label="ProfilePilot · PC 控制" title="ProfilePilot · PC 控制">${workspaceBrandMark}<span>ProfilePilot</span></a>
    <nav class="workspace-links" aria-label="工作空间">${workspaces.map(([key, label, detail, href, glyph]) => `<a href="${href}" class="workspace-link${key === navigation ? " active" : ""}" data-workspace="${key}" ${key === "agent" && !experimentalAgentEnabled() ? "hidden" : ""} ${key === navigation ? 'aria-current="page"' : ""} title="${label} · ${detail}">${key === "browser" ? taskIcon("desktop") : navigationIcon(key, glyph)}<span>${label}</span></a>`).join("")}</nav>
    <a class="workspace-settings${current === "settings" ? " active" : ""}" href="./settings.html" data-workspace="settings" ${current === "settings" ? 'aria-current="page"' : ""} title="全局设置"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/></svg><span>设置</span></a>
    <button type="button" class="workspace-help" data-workspace-guide aria-label="打开新手引导" title="新手引导 · 了解各个 Tab 的用途"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.2.6-1.7 1.2-1.7 2.7M12 17h.01"/></svg><span>新手引导</span></button>
    ${sidebarResizeHandle("workspace", "workspace-rail", "调整主导航宽度")}
  </aside>`;
}
export function workspaceIdentityBar(): string {
  // Keep the native window's drag area on both Windows and macOS.
  const collapsed = document.documentElement.dataset.workspaceRail === "collapsed";
  const label = collapsed ? "展开主导航" : "收起主导航";
  return `<header class="workspace-identity" aria-label="窗口标题栏"><button type="button" class="workspace-rail-toggle" data-toggle-workspace-rail aria-controls="workspace-rail" aria-expanded="${!collapsed}" aria-label="${label}" title="${label}">${taskIcon("sidebar")}</button></header>`;
}
export function refreshWorkspaceSwitcher(): void {
  refreshExperiments();
  refreshRail();
  updateWindowChrome();
  workspaceRendered();
}
function refreshExperiments(): void {
  document.querySelectorAll<HTMLAnchorElement>('.workspace-link[data-workspace="agent"]').forEach(link => { link.hidden = !experimentalAgentEnabled(); });
}
onExperimentalFeaturesChanged(refreshExperiments);
document.addEventListener("click", event => {
  const target = event.target as Element;
  if (target.closest("[data-toggle-workspace-rail]")) {
    railChoice = document.documentElement.dataset.workspaceRail === "collapsed" ? "expanded" : "collapsed";
    try { localStorage.setItem(railPreference, railChoice); } catch { /* The current window still updates. */ }
    refreshRail();
    updateWindowChrome();
    return;
  }
  if (target.closest("[data-workspace-guide]")) { openWorkspaceGuide(); return; }
  const link = target.closest<HTMLAnchorElement>(".workspace-rail [data-workspace]");
  if (!link) return;
  if (link.dataset.workspace === document.documentElement.dataset.workspace) { event.preventDefault(); window.workspaceHost?.navigate(link.href); return; }
  if (!event.defaultPrevented && !(event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))) {
    document.dispatchEvent(new CustomEvent("workspace-before-switch", { detail: link.dataset.workspace }));
  }
});
