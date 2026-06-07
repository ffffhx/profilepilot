import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import type {
  AccountSyncBackupSummary,
  AccountSyncRequest,
  AccountSyncRestoreResult,
  AccountSyncResult,
  AppState,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationBackupSummary,
  ExtensionMigrationRequest,
  ExtensionMigrationRestoreResult,
  ExtensionMigrationResult,
  ExtensionScanResult
} from "../shared/types";
import { APP_TITLE, createProfileManager } from "./profile-manager";

const profileManager = createProfileManager();
let mainWindow: BrowserWindow | null = null;
const APP_ICON_PATH = path.join(__dirname, "../../public/assets/profilepilot-icon-512.png");

function createMainWindow(): void {
  const smokeTest = process.env.CPM_ELECTRON_SMOKE_TEST === "1";

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: !smokeTest,
    title: APP_TITLE,
    icon: APP_ICON_PATH,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (smokeTest) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const runCrud = process.env.CPM_ELECTRON_SMOKE_CRUD === "1";
        const result = await mainWindow?.webContents.executeJavaScript(`
          new Promise(async (resolve, reject) => {
            window.setTimeout(() => {
              (async () => {
                const smokeResult = {
                  title: document.title,
                  h1: document.querySelector("h1")?.textContent || null,
                  hasBridge: Boolean(window.profileManager),
                  hasRenameProfile: typeof window.profileManager?.renameProfile === "function",
                  hasFocusProfile: typeof window.profileManager?.focusProfile === "function",
                  hasCloseProfile: typeof window.profileManager?.closeProfile === "function",
                  hasLaunchProfileWithCdp: typeof window.profileManager?.launchProfileWithCdp === "function",
                  hasScanProfileExtensions: typeof window.profileManager?.scanProfileExtensions === "function",
                  hasMigrateExtensions: typeof window.profileManager?.migrateExtensions === "function",
                  hasDeleteProfileExtension: typeof window.profileManager?.deleteProfileExtension === "function",
                  hasRestoreExtensionMigrationBackup: typeof window.profileManager?.restoreExtensionMigrationBackup === "function",
                  hasSyncAccount: typeof window.profileManager?.syncAccount === "function",
                  hasRestoreAccountSyncBackup: typeof window.profileManager?.restoreAccountSyncBackup === "function",
                  buttonCount: document.querySelectorAll("button").length,
                  statusLabels: Array.from(document.querySelectorAll(".status-label")).map((item) => item.textContent),
                  statusValues: Array.from(document.querySelectorAll(".status-value")).map((item) => item.textContent),
                  accountSyncTitle: document.querySelector("[data-account-sync] h2")?.textContent || null,
                  accountSyncSelectCount: document.querySelectorAll("[data-account-sync] select").length,
                  migrationTitle: document.querySelector("[data-extension-migration] h2")?.textContent || null,
                  migrationSelectCount: document.querySelectorAll("[data-extension-migration] select").length,
                  shellWidthRatio: (() => {
                    const shell = document.querySelector(".shell");
                    return shell ? Math.round((shell.clientWidth / window.innerWidth) * 100) / 100 : null;
                  })(),
                  profileTableHasHorizontalOverflow: (() => {
                    const tableWrap = document.querySelector(".profiles-table-wrap");
                    return tableWrap ? tableWrap.scrollWidth > tableWrap.clientWidth + 1 : null;
                  })(),
                  sourcePills: Array.from(document.querySelectorAll(".source-pill")).map((item) => item.textContent),
                  cdpTooltips: Array.from(document.querySelectorAll(".action-tooltip")).map((item) => item.getAttribute("data-tooltip")),
                  detailTitleBeforeSelection: document.querySelector(".details h2")?.textContent || null,
                  detailProcessLabelBeforeSelection:
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent?.includes("进程"))?.querySelector("span")?.textContent || null,
                  detailListeningPortsBeforeSelection:
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent === "本机监听端口")?.querySelector("strong")?.textContent || null,
                  profilePrimaryActions: Array.from(document.querySelectorAll(".profiles-table tbody tr:first-child .profile-actions > .action-button")).map((item) => item.textContent),
                  profileMenuLabels: [],
                  detailTitleAfterSecondRowClick: null,
                  detailSourceAfterSecondRowClick: null,
                  detailProcessLabelAfterSecondRowClick: null,
                  detailProcessNoteAfterSecondRowClick: null,
                  detailListeningPortsAfterSecondRowClick: null,
                  detailCdpValueAfterSecondRowClick: null,
                  nativeProfileCount: null,
                  firstNativeProfile: null,
                  runningProfileIds: [],
                  defaultProfileRunning: null,
                  defaultProfileLastLaunchedAt: null,
                  defaultProfilePids: [],
                  defaultProfileListeningPorts: [],
                  firstProfileExtensionCount: null,
                  backupCount: null,
                  accountSyncBackupCount: null,
                  crud: null
                };

                const visibleState = await window.profileManager.getState();
                smokeResult.nativeProfileCount = visibleState.nativeChromeProfiles.length;
                smokeResult.firstNativeProfile = visibleState.nativeChromeProfiles[0]?.dirName || null;
                smokeResult.runningProfileIds = visibleState.runningProfiles.map((profile) => profile.id);
                const defaultProfile = visibleState.profiles.find((profile) => profile.id === "native:Default");
                smokeResult.defaultProfileRunning = defaultProfile?.running ?? null;
                smokeResult.defaultProfileLastLaunchedAt = defaultProfile?.lastLaunchedAt ?? null;
                smokeResult.defaultProfilePids = defaultProfile?.pids ?? [];
                smokeResult.defaultProfileListeningPorts = defaultProfile?.listeningPorts ?? [];
                smokeResult.backupCount = (await window.profileManager.listExtensionMigrationBackups()).length;
                smokeResult.accountSyncBackupCount = (await window.profileManager.listAccountSyncBackups()).length;
                const firstProfileForScan = visibleState.profiles[0];
                if (firstProfileForScan) {
                  const scan = await window.profileManager.scanProfileExtensions(firstProfileForScan.id);
                  smokeResult.firstProfileExtensionCount = scan.extensions.length;
                }
                const firstMenuButton = document.querySelector(".profiles-table tbody tr:first-child .menu-button");
                if (firstMenuButton) {
                  firstMenuButton.click();
                  await new Promise((done) => window.setTimeout(done, 0));
                  smokeResult.profileMenuLabels = Array.from(document.querySelectorAll(".action-menu button")).map((item) => item.textContent);
                }

                const secondRow = document.querySelectorAll("[data-profile-row]")[1];
                if (secondRow) {
                  secondRow.click();
                  await new Promise((done) => window.setTimeout(done, 0));
                  smokeResult.detailTitleAfterSecondRowClick = document.querySelector(".details h2")?.textContent || null;
                  smokeResult.detailSourceAfterSecondRowClick =
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent === "来源")?.querySelector("strong")?.textContent || null;
                  const processRow = Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent?.includes("进程"));
                  smokeResult.detailProcessLabelAfterSecondRowClick = processRow?.querySelector("span")?.textContent || null;
                  smokeResult.detailProcessNoteAfterSecondRowClick = processRow?.querySelector(".detail-note")?.textContent || null;
                  smokeResult.detailListeningPortsAfterSecondRowClick =
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent === "本机监听端口")?.querySelector("strong")?.textContent || null;
                  const cdpRow = Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent === "CDP 地址");
                  smokeResult.detailCdpValueAfterSecondRowClick = cdpRow?.querySelector("strong, code")?.textContent || null;
                }

                if (${JSON.stringify(runCrud)}) {
                  const initial = visibleState;
                  const createdState = await window.profileManager.createProfile("Smoke Test");
                  const created = createdState.profiles.find((profile) => profile.name === "Smoke Test");
                  if (!created) {
                    throw new Error("Smoke profile was not created.");
                  }

                  const launchedState = await window.profileManager.launchProfile(created.id);
                  const launched = launchedState.profiles.find((profile) => profile.id === created.id);
                  if (!launched?.lastLaunchedAt) {
                    throw new Error("Smoke profile launch timestamp was not updated.");
                  }

                  const deleted = await window.profileManager.deleteProfile(created.id);
                  const finalState = await window.profileManager.getState();
                  smokeResult.crud = {
                    initialProfiles: initial.profiles.length,
                    createdProfile: created.name,
                    afterCreateProfiles: createdState.profiles.length,
                    lastLaunchedAt: launched.lastLaunchedAt,
                    afterDeleteProfiles: finalState.profiles.length,
                    trashPath: deleted.trashPath
                  };
                }

                resolve(smokeResult);
              })().catch(reject);
            }, 250);
          });
        `);
        console.log(JSON.stringify({ smokeTest: result }, null, 2));
      } finally {
        app.quit();
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, "../../public/index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getState, async (): Promise<AppState> => profileManager.getState());

  ipcMain.handle(IPC_CHANNELS.createProfile, async (_event, name: string): Promise<AppState> => {
    await profileManager.createProfile(name);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.renameProfile, async (_event, id: string, name: string): Promise<AppState> => {
    await profileManager.renameProfile(id, name);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.launchProfile, async (_event, id: string): Promise<AppState> => {
    await profileManager.launchProfile(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.launchProfileWithCdp, async (_event, id: string, port?: number | null): Promise<AppState> => {
    await profileManager.launchProfileWithCdp(id, port);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.focusProfile, async (_event, id: string): Promise<AppState> => {
    await profileManager.focusProfile(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.closeProfile, async (_event, id: string): Promise<AppState> => {
    await profileManager.closeProfile(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.openProfileFolder, async (_event, id: string): Promise<AppState> => {
    await profileManager.openProfileFolder(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.deleteProfile, async (_event, id: string): Promise<DeleteProfileResult> => {
    return profileManager.deleteProfile(id);
  });

  ipcMain.handle(IPC_CHANNELS.scanProfileExtensions, async (_event, id: string): Promise<ExtensionScanResult> => {
    return profileManager.scanProfileExtensions(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.migrateExtensions,
    async (_event, request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult> => {
      return profileManager.migrateExtensions(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteProfileExtension,
    async (_event, profileId: string, extensionId: string): Promise<ExtensionDeleteResult> => {
      return profileManager.deleteProfileExtension(profileId, extensionId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.listExtensionMigrationBackups, async (): Promise<ExtensionMigrationBackupSummary[]> => {
    return profileManager.listExtensionMigrationBackups();
  });

  ipcMain.handle(
    IPC_CHANNELS.restoreExtensionMigrationBackup,
    async (_event, backupId: string): Promise<ExtensionMigrationRestoreResult> => {
      return profileManager.restoreExtensionMigrationBackup(backupId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.syncAccount, async (_event, request: AccountSyncRequest): Promise<AccountSyncResult> => {
    return profileManager.syncAccount(request);
  });

  ipcMain.handle(IPC_CHANNELS.listAccountSyncBackups, async (): Promise<AccountSyncBackupSummary[]> => {
    return profileManager.listAccountSyncBackups();
  });

  ipcMain.handle(
    IPC_CHANNELS.restoreAccountSyncBackup,
    async (_event, backupId: string): Promise<AccountSyncRestoreResult> => {
      return profileManager.restoreAccountSyncBackup(backupId);
    }
  );
}

app.name = APP_TITLE;
app.setName(APP_TITLE);
app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.dock?.setIcon(APP_ICON_PATH);
  }

  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
