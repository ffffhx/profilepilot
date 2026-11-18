import type { WorkspaceId } from "../shared/workspaces";

const agentPreference = "profilepilot-experimental-agent";
const proxyRoutingPreference = "profilepilot-experimental-proxy-routing";
const gpuiPreference = "profilepilot-experimental-gpui";
const desktopPreference = "profilepilot-experimental-desktop";
const gameFollowPreference = "profilepilot-experimental-game-follow";
const screenCameraPreference = "profilepilot-experimental-screen-camera";
const allPreferences = [
  agentPreference,
  proxyRoutingPreference,
  gpuiPreference,
  desktopPreference,
  gameFollowPreference,
  screenCameraPreference
];
const changeEvent = "profilepilot-experimental-features-changed";

export function experimentalAgentEnabled(): boolean {
  try {
    const raw = localStorage.getItem(agentPreference);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function notifyExperimentalFeaturesChanged(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(changeEvent));
  }
}

export function setExperimentalAgentEnabled(enabled: boolean): void {
  // Report a failed save instead of displaying an enabled state that won't persist.
  localStorage.setItem(agentPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalProxyRoutingEnabled(): boolean {
  try { return localStorage.getItem(proxyRoutingPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalProxyRoutingEnabled(enabled: boolean): void {
  localStorage.setItem(proxyRoutingPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalGpuiEnabled(): boolean {
  try { return localStorage.getItem(gpuiPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalGpuiEnabled(enabled: boolean): void {
  localStorage.setItem(gpuiPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalDesktopEnabled(): boolean {
  try { return localStorage.getItem(desktopPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalDesktopEnabled(enabled: boolean): void {
  localStorage.setItem(desktopPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalGameFollowEnabled(): boolean {
  try { return localStorage.getItem(gameFollowPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalGameFollowEnabled(enabled: boolean): void {
  localStorage.setItem(gameFollowPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalScreenCameraEnabled(): boolean {
  try { return localStorage.getItem(screenCameraPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalScreenCameraEnabled(enabled: boolean): void {
  localStorage.setItem(screenCameraPreference, String(enabled));
  notifyExperimentalFeaturesChanged();
}

export function experimentalWorkspaceEnabled(workspace: WorkspaceId): boolean {
  if (workspace === "agent") return experimentalAgentEnabled();
  if (workspace === "gpui") return experimentalGpuiEnabled();
  if (workspace === "desktop") return experimentalDesktopEnabled();
  return true;
}

export function onExperimentalFeaturesChanged(listener: () => void): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener(changeEvent, listener);
  // The shell, embedded settings and other windows share the same preference.
  window.addEventListener("storage", event => {
    if (event.key === null || allPreferences.includes(event.key)) listener();
  });
}
