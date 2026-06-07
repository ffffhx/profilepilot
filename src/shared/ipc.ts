export const IPC_CHANNELS = {
  getState: "profiles:get-state",
  createProfile: "profiles:create",
  renameProfile: "profiles:rename",
  launchProfile: "profiles:launch",
  launchProfileWithCdp: "profiles:launch-cdp",
  focusProfile: "profiles:focus",
  closeProfile: "profiles:close",
  openProfileFolder: "profiles:open-folder",
  deleteProfile: "profiles:delete",
  scanProfileExtensions: "profiles:extensions:scan",
  migrateExtensions: "profiles:extensions:migrate",
  deleteProfileExtension: "profiles:extensions:delete",
  listExtensionMigrationBackups: "profiles:extensions:backups",
  restoreExtensionMigrationBackup: "profiles:extensions:restore-backup",
  syncAccount: "profiles:account:sync",
  listAccountSyncBackups: "profiles:account:backups",
  restoreAccountSyncBackup: "profiles:account:restore-backup"
} as const;
