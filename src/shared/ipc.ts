export const IPC_CHANNELS = {
  getState: "profiles:get-state",
  createProfile: "profiles:create",
  launchProfile: "profiles:launch",
  openProfileFolder: "profiles:open-folder",
  deleteProfile: "profiles:delete"
} as const;
