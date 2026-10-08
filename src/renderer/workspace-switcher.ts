import { taskIcon } from "./task-icons";
import { updateWindowChrome } from "./window-chrome";
import { installPhoneStatus } from "./phone-status";
import { workspaceRendered, workspaceIdentityChanged } from "./workspace-lifecycle";
import { openWorkspaceGuide } from "./workspace-guide";
import type { AppState, PublicProfile } from "./types";

type Workspace = "agent" | "browser" | "local-apps" | "tools" | "phones";
const workspaces = [
  ["agent", "Agent", "任务与对话", "./tasks.html", "message"],
  ["browser", "浏览器", "Profile 与浏览器连接", "./index.html", "browser"],
  ["local-apps", "本地应用", "开发项目与后台服务", "./local-apps.html", "desktop"],
  ["phones", "手机", "设备连接与控制", "./phones.html", "phone"],
  ["tools", "配套工具", "扩展、Skill 与 CLI", "./tools.html", "settings"]
] as const;
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export const workspaceBrandMark = '<svg class="workspace-brand-glyph" viewBox="0 0 28 34" aria-hidden="true"><path fill="#1474ff" d="M3 1 26 17 3 33Z"/><path fill="#004ce9" d="m3 15 12 2L3 33Z"/><path fill="#fff" d="m10 10 10 7-10 7Z"/></svg>';
const navigationIcon = (key: Workspace, fallback: Parameters<typeof taskIcon>[0]) => key === "agent"
  ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="5" r="3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4H5v4m7-4h7v4"/></svg>'
  : key === "browser" ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18m-16-5h14M5 17h14"/></svg>' : key === "tools" ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 6a6 6 0 0 0-7 7L2.8 17.2a2.8 2.8 0 0 0 4 4L11 17a6 6 0 0 0 7-8l-4 4-3-3 4-4Z"/></svg>' : taskIcon(fallback);
let identityState: AppState | undefined;
let identityRequest: Promise<void> | undefined;
let subscribed = false;
let nativeConnections: ReadonlyArray<{ profileId: string; connected: boolean }> = [];
let preferredProfile = "";
try { preferredProfile = sessionStorage.getItem("profilepilot-workspace-profile") || ""; } catch { /* Optional preference. */ }
export function workspaceSwitcher(current: Workspace): string {
  installPhoneStatus();
  document.documentElement.classList.add("workspace-layout");
  document.documentElement.dataset.workspace = current;
  return `<aside class="workspace-rail" aria-label="工作区导航">
    <a class="workspace-logo" href="./tasks.html" data-workspace="agent" title="ProfilePilot · Agent">${workspaceBrandMark}<span>ProfilePilot</span></a>
    <nav class="workspace-links" aria-label="工作空间">${workspaces.map(([key, label, detail, href, glyph]) => `<a href="${href}" class="workspace-link${key === current ? " active" : ""}" data-workspace="${key}" ${key === current ? 'aria-current="page"' : ""} title="${label} · ${detail}">${navigationIcon(key, glyph)}<span>${label}</span></a>`).join("")}</nav>
    <a class="workspace-settings" href="./tasks.html?view=settings" title="设置"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/></svg><span>设置</span></a>
    <button type="button" class="workspace-help" data-workspace-guide aria-label="打开新手引导" title="新手引导 · 了解各个 Tab 的用途"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.2.6-1.7 1.2-1.7 2.7M12 17h.01"/></svg><span>新手引导</span></button>
    <div class="workspace-rail-footer"><span class="workspace-local-dot" aria-hidden="true"></span><span>本机工作区<small>本地服务</small></span></div>
  </aside>`;
}
function identityOptions(profiles: PublicProfile[], selectedId: string): string {
  return profiles.length ? profiles.map(profile => `<option value="${escape(profile.id)}" ${profile.id === selectedId ? "selected" : ""}>${escape(profile.name)}</option>`).join("") : '<option value="">暂无 Profile</option>';
}
function selectedIdentity(state: AppState | undefined, requested = ""): PublicProfile | undefined {
  return state?.profiles.find(profile => profile.id === (requested || preferredProfile)) || state?.currentProfile || state?.profiles[0];
}
function identityStatus(profile?: PublicProfile): {label: string; ready: boolean} {
  const connected = Boolean(profile?.cdpUrl || profile?.gatewayControl?.connectionActive || nativeConnections.some(item => item.profileId === profile?.id && item.connected));
  return { label: connected ? "已连接" : profile?.running ? "运行中" : profile ? "未启动" : "待连接", ready: connected || !!profile?.running };
}
export function workspaceIdentityBar(state?: AppState, requested = "", locked = false, browsers?: ReadonlyArray<{ profileId: string; connected: boolean }>): string {
  if (state) identityState = state;
  if (browsers) nativeConnections = browsers;
  const profile = selectedIdentity(identityState, requested), status = identityStatus(profile);
  return `<header class="workspace-identity" aria-label="当前工作环境" data-identity-profile="${escape(requested)}">
    <select id="workspace-profile" data-native-select aria-label="当前 Profile" ${locked ? "disabled" : ""}>${identityOptions(identityState?.profiles || [], profile?.id || "")}</select>
    <span class="workspace-connection ${status.ready ? "ready" : ""}" role="status"><i aria-hidden="true"></i><span>${status.label}</span></span>
    <button class="workspace-search" type="button" data-workspace-search><span>搜索功能、任务或配置…</span><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg></button>
  </header>`;
}
function refreshIdentity(): void {
  const header = document.querySelector<HTMLElement>(".workspace-identity");
  const select = header?.querySelector<HTMLSelectElement>("#workspace-profile");
  if (!select || !identityState) return;
  const profile = selectedIdentity(identityState, header?.dataset.identityProfile);
  const options = identityOptions(identityState.profiles, profile?.id || "");
  if (select.innerHTML !== options) select.innerHTML = options;
  const status = identityStatus(profile), indicator = header!.querySelector<HTMLElement>(".workspace-connection")!;
  indicator.classList.toggle("ready", status.ready);
  indicator.querySelector("span")!.textContent = status.label;
  workspaceIdentityChanged();
}
export function refreshWorkspaceSwitcher(): void {
  updateWindowChrome();
  workspaceRendered();
  if (!document.querySelector(".workspace-identity") || !window.profileManager) return;
  if (!subscribed) {
    subscribed = true;
    window.profileManager.onStateChanged(state => { identityState = state; refreshIdentity(); });
  }
  if (identityState) refreshIdentity();
  else if (!identityRequest) identityRequest = window.profileManager.getInitialState().then(state => { identityState = state; refreshIdentity(); }).catch(() => {}).finally(() => { identityRequest = undefined; });
}
document.addEventListener("change", event => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.id !== "workspace-profile") return;
  preferredProfile = target.value;
  try { sessionStorage.setItem("profilepilot-workspace-profile", preferredProfile); } catch { /* Keep working without storage. */ }
  refreshIdentity();
  document.dispatchEvent(new CustomEvent("workspace-profile-selected", { detail: preferredProfile }));
});
document.addEventListener("click", event => {
  const target = event.target as Element;
  if (target.closest("[data-workspace-guide]")) { openWorkspaceGuide(); return; }
  if (target.closest("[data-workspace-search]")) {
    const command = document.querySelector<HTMLButtonElement>('[data-action="commands"]');
    if (document.documentElement.dataset.workspace === "agent" && command) command.click();
    else document.querySelector<HTMLInputElement>('#profile-search,#tools-search,.app-search input,.phone-search input')?.focus();
    return;
  }
  const link = target.closest<HTMLAnchorElement>(".workspace-rail [data-workspace]");
  if (!link) return;
  if (link.dataset.workspace === document.documentElement.dataset.workspace) { event.preventDefault(); window.workspaceHost?.navigate(link.href); return; }
  if (!event.defaultPrevented && !(event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))) {
    document.dispatchEvent(new CustomEvent("workspace-before-switch", { detail: link.dataset.workspace }));
  }
});
