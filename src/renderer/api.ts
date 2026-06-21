import { ProfileManagerApi } from "./types";

declare global {
  interface Window {
    profileManager: ProfileManagerApi;
  }
}


export function profileApi(): ProfileManagerApi {
  if (!window.profileManager) {
    throw new Error("Desktop bridge is not available.");
  }

  return window.profileManager;
}
