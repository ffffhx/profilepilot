export const IPC_CHANNELS = {
  getState: "profiles:get-state",
  createProfile: "profiles:create",
  launchProfile: "profiles:launch",
  launchProfileWithCdp: "profiles:launch-cdp",
  focusProfile: "profiles:focus",
  closeProfile: "profiles:close",
  openProfileFolder: "profiles:open-folder",
  deleteProfile: "profiles:delete"
} as const;
