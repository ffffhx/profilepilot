// Render real components in an isolated window; no device or installation APIs.
import { store } from "../../../src/renderer/state";
import { render } from "../../../src/renderer/render/render-root";
import { renderButtonLabel } from "../../../src/renderer/button-label";

const defaults = structuredClone(store);
const profile = (id: string, source = "isolated") => ({
  id, source, name: `布局测试 ${id}`, dirName: id, path: `/fixture/${id}`, userDataDir: `/fixture/${id}`,
  profileDataPath: `/fixture/${id}/Default`, createdAt: "2026-08-01T00:00:00Z", lastLaunchedAt: null,
  userName: "", isDefault: false, deletable: true, running: false, pids: [], cdpPort: null,
  cdpUrl: null, fixedCdpPort: 9223, bifrostProxy: null, upstreamProxy: null, directConnection: false,
  listeningPorts: [], pinnedToMini: false, quickLaunchSlot: null, clonedFromProfileId: null,
  clonedFromName: null, cloneCount: 0, projectTag: null, agentAccessDisabled: false,
  cdpClients: [], gatewayControl: null, agentBrowserOccupancy: null, livePrimaryUrl: null,
  liveTabCount: null, cdpContention: null, agentActivity: null, windowActivation: "background"
});
const skill = { key: "profilepilot", installed: true, upToDate: true, managed: true, installedTargetCount: 3, targets: [] };
const diagnostic = { inspectedAt: "2026-08-01T00:00:00Z", ready: true, tools: [], wrappers: [], skills: [skill],
  shellIntegration: { installed: true }, managementCli: { installed: true, bundleInstalled: true, launcherInstalled: true, upToDate: true, skill },
  inputGuard: { platform: "darwin", supported: true, granted: false, appName: "ProfilePilot", inspectedAt: "2026-08-01T00:00:00Z" } };
const scenarios = ["browser-refresh", "tools-refresh", "tools-cli", "tools-folder", "tools-permission", "profile-create", "profile-rename", "profile-tag", "profile-launch", "profile-close", "clone-create", "clone-refresh", "account-sync"];
function scenario(name: string, loading: boolean, platform: string) {
  const p = profile("p1"), target = profile("p2");
  Object.assign(store, structuredClone(defaults), {
    workspace: name.startsWith("tools") ? "tools" : "browser",
    state: { platform, profiles: [p, target, profile("native", "native")], externalInstances: [], runningProfiles: [], currentProfile: null },
    selectedId: p.id, nativeExtensionProfileId: "native", nativeExtensionBrowsers: [{ profileId: "native", connected: true, taskTabs: true }],
    agentIntegrationDiagnostic: structuredClone(diagnostic)
  });
  let key = "";
  if (name === "browser-refresh") key = "refresh";
  if (name === "tools-refresh") store.agentIntegrationLoading = loading;
  if (name === "tools-cli") key = "profilepilot-management-cli";
  if (name === "tools-folder") key = "open-browser-extension-folder";
  if (name === "tools-permission") { store.modal = { kind: "onboarding" }; store.inputGuardPermissionLoading = loading; }
  if (name === "profile-create") { store.modal = { kind: "new" }; key = "create-profile"; }
  if (name === "profile-rename") { store.modal = { kind: "rename", profileId: p.id }; key = "rename-profile"; }
  if (name === "profile-tag") { store.modal = { kind: "clone-tag", profileId: p.id }; key = "set-clone-tag"; }
  if (name === "profile-launch") key = "launch-cdp";
  if (name === "profile-close") { p.running = true; key = "close-profile"; }
  if (name.startsWith("clone-")) { (target as any).clonedFromProfileId = p.id; store.modal = { kind: "clone-pool" }; store.clonePoolSourceId = p.id; key = name === "clone-create" ? "clone-profiles" : "refresh-clones"; }
  if (name === "account-sync") { store.accountSyncSourceId = p.id; store.accountSyncTargetId = target.id; key = "account-sync"; }
  if (loading && key) { store.busy = true; store.busyState = { key, profileId: p.id, message: "正在处理，请稍候…", stepIndex: 1, stepCount: 3 }; }
  render();
}

function boxes() {
  const result: Record<string, number[]> = {};
  const counts = new Map<string, number>();
  const modal = document.querySelector(".modal"), scope = modal || document.querySelector(".shell")!;
  for (const [i, node] of [...scope.querySelectorAll<HTMLElement>("button, input, select, textarea, .tools-overview-card, #main-content, .modal-actions")].entries()) {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height || node.closest(".operation-progress") || node.closest("details:not([open])") && !node.closest("summary")) continue;
    const base = node.id || [node.tagName, node.dataset.action || node.getAttribute("name") || node.getAttribute("type") || node.className || i, node.dataset.id || ""].join(":");
    const count = counts.get(base) || 0; counts.set(base, count + 1);
    const key = `${base}:${count}`;
    result[key] = [rect.x, rect.y, rect.width, rect.height];
  }
  if (modal) { const rect = modal.getBoundingClientRect(); result.modal = [rect.x, rect.y, rect.width, rect.height]; }
  return result;
}

Object.assign(window, { buttonLayout: { scenarios, scenario, boxes, labels(pairs: string[][], busy: boolean, compact: boolean) {
  document.getElementById("app")!.innerHTML = `<div class="shell"><div class="${compact ? "profile-actions" : "header-actions"}" style="flex-wrap:wrap">${pairs.map(([idle, active], index) => `<button data-label-index="${index}" class="action-button ${busy ? "loading" : ""}">${renderButtonLabel(busy, idle, active)}</button>`).join("")}</div></div>`;
  return [...document.querySelectorAll<HTMLElement>("[data-label-index]")].map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
} } });
