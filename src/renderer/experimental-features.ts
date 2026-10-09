const agentPreference = "profilepilot-experimental-agent";
const changeEvent = "profilepilot-experimental-features-changed";

export function experimentalAgentEnabled(): boolean {
  try { return localStorage.getItem(agentPreference) === "true"; }
  catch { return false; }
}

export function setExperimentalAgentEnabled(enabled: boolean): void {
  // Report a failed save instead of displaying an enabled state that won't persist.
  localStorage.setItem(agentPreference, String(enabled));
  window.dispatchEvent(new Event(changeEvent));
}

export function onExperimentalFeaturesChanged(listener: () => void): void {
  window.addEventListener(changeEvent, listener);
  // The shell, embedded settings and other windows share the same preference.
  window.addEventListener("storage", event => {
    if (event.key === agentPreference || event.key === null) listener();
  });
}
