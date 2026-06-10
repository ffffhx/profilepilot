import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  AppState,
  CancelOperationRequest,
  ControlOperationRequest,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationDiffResult,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionScanResult,
  OperationPauseSignal,
  OperationProgress,
  OperationProgressUpdate
} from "../shared/types";
import { APP_TITLE, createProfileManager } from "./profile-manager";

const profileManager = createProfileManager();
let mainWindow: BrowserWindow | null = null;
const APP_ICON_PATH = path.join(__dirname, "../../public/assets/profilepilot-icon-512.png");
const activeOperations = new Map<string, ActiveOperation>();

interface ActiveOperation {
  controller: AbortController;
  pause: OperationPauseController;
}

class OperationPauseController implements OperationPauseSignal {
  private pausedValue = false;
  private waiters: Array<() => void> = [];

  get paused(): boolean {
    return this.pausedValue;
  }

  pause(): void {
    this.pausedValue = true;
  }

  resume(): void {
    if (!this.pausedValue) {
      return;
    }

    this.pausedValue = false;
    const waiters = this.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  waitIfPaused(): Promise<void> {
    if (!this.pausedValue) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function operationId(key: string, profileId?: string): string {
  return `${key}:${profileId || "*"}`;
}

function createProgressReporter(
  event: IpcMainInvokeEvent,
  baseProgress: Pick<OperationProgress, "key" | "profileId">
): (progress: OperationProgressUpdate) => void {
  return (progress) => {
    event.sender.send(IPC_CHANNELS.operationProgress, {
      ...baseProgress,
      ...progress
    });
  };
}

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
                const waitForSmokeCondition = async (predicate, timeoutMs = 2500) => {
                  const startedAt = Date.now();
                  while (Date.now() - startedAt < timeoutMs) {
                    if (predicate()) {
                      return true;
                    }
                    await new Promise((done) => window.setTimeout(done, 50));
                  }
                  return false;
                };

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
                  hasInspectAccountSyncDiff: typeof window.profileManager?.inspectAccountSyncDiff === "function",
                  hasInspectExtensionMigrationDiff: typeof window.profileManager?.inspectExtensionMigrationDiff === "function",
                  hasSyncAccount: typeof window.profileManager?.syncAccount === "function",
                  hasCancelOperation: typeof window.profileManager?.cancelOperation === "function",
                  hasControlOperation: typeof window.profileManager?.controlOperation === "function",
                  hasOperationProgress: typeof window.profileManager?.onOperationProgress === "function",
                  buttonCount: document.querySelectorAll("button").length,
                  statusLabels: Array.from(document.querySelectorAll(".status-label")).map((item) => item.textContent),
                  statusValues: Array.from(document.querySelectorAll(".status-value")).map((item) => item.textContent),
                  accountSyncTitle: document.querySelector("[data-account-sync] h2")?.textContent || null,
                  accountSyncSelectCount: document.querySelectorAll("[data-account-sync] select").length,
                  accountSyncScopeHeadings: Array.from(document.querySelectorAll(".account-sync-scope-group strong")).map((item) => item.textContent),
                  accountSyncScopeItems: Array.from(document.querySelectorAll(".account-sync-scope-group li")).map((item) => item.textContent),
                  accountDiffHelp: null,
                  accountDiffMoreButton: null,
                  accountDiffIgnoredButton: null,
                  accountConfirmTitle: null,
                  accountConfirmButton: null,
                  accountConfirmSummary: [],
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
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent?.includes("监听端口"))?.querySelector("strong")?.textContent || null,
                  profilePrimaryActions: Array.from(
                    document.querySelectorAll(".profiles-table tbody tr:first-child .profile-actions > .action-button, .profiles-table tbody tr:first-child .profile-actions > .action-tooltip > .action-button")
                  ).map((item) => item.textContent),
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
                  extensionDataGuard: null,
                  crud: null
                };

                const visibleState = await window.profileManager.getState();
                await waitForSmokeCondition(() => document.querySelector(".diff-summary-grid") || document.querySelector(".diff-preview-head span")?.textContent?.includes("暂时无法读取差异"), 5000);
                smokeResult.accountDiffMoreButton = document.querySelector('[data-action="toggle-account-diff-expanded"]')?.textContent || null;
                smokeResult.accountDiffIgnoredButton = document.querySelector('[data-action="toggle-account-diff-ignored"]')?.textContent || null;
                const ignoredButton = document.querySelector('[data-action="toggle-account-diff-ignored"]');
                if (ignoredButton instanceof HTMLButtonElement) {
                  ignoredButton.click();
                  await waitForSmokeCondition(() => document.querySelector(".diff-ignored .diff-help"), 1000);
                }
                smokeResult.accountDiffHelp = document.querySelector(".diff-ignored .diff-help")?.textContent || null;
                const syncAccountButton = document.querySelector('[data-action="sync-account"]');
                if (syncAccountButton instanceof HTMLButtonElement && !syncAccountButton.disabled) {
                  syncAccountButton.click();
                  await waitForSmokeCondition(() => document.querySelector(".confirm-dialog"), 1000);
                  smokeResult.accountConfirmTitle = document.querySelector(".confirm-dialog h2")?.textContent || null;
                  smokeResult.accountConfirmButton = document.querySelector('[data-action="confirm-modal-action"]')?.textContent || null;
                  smokeResult.accountConfirmSummary = Array.from(document.querySelectorAll(".confirm-dialog .confirm-summary span")).map((item) => item.textContent);
                  const cancelConfirmButton = document.querySelector('.confirm-dialog [data-action="close-modal"]');
                  if (cancelConfirmButton instanceof HTMLButtonElement) {
                    cancelConfirmButton.click();
                  }
                }
                smokeResult.nativeProfileCount = visibleState.nativeChromeProfiles.length;
                smokeResult.firstNativeProfile = visibleState.nativeChromeProfiles[0]?.dirName || null;
                smokeResult.runningProfileIds = visibleState.runningProfiles.map((profile) => profile.id);
                const defaultProfile = visibleState.profiles.find((profile) => profile.id === "native:Default");
                smokeResult.defaultProfileRunning = defaultProfile?.running ?? null;
                smokeResult.defaultProfileLastLaunchedAt = defaultProfile?.lastLaunchedAt ?? null;
                smokeResult.defaultProfilePids = defaultProfile?.pids ?? [];
                smokeResult.defaultProfileListeningPorts = defaultProfile?.listeningPorts ?? [];
                const firstProfileForScan = visibleState.profiles[0];
                if (firstProfileForScan) {
                  const scan = await window.profileManager.scanProfileExtensions(firstProfileForScan.id);
                  smokeResult.firstProfileExtensionCount = scan.extensions.length;
                }
                if (defaultProfile?.running) {
                  const scanButton = document.querySelector('[data-action="scan-extensions"]');
                  scanButton?.click();
                  const tableReady = await waitForSmokeCondition(() => document.querySelector(".extensions-table"), 5000);
                  await waitForSmokeCondition(() => {
                    const button = document.querySelector('[data-action="migrate-extensions"]');
                    return button && !button.disabled;
                  }, 5000);

                  const migrateButton = document.querySelector('[data-action="migrate-extensions"]');
                  smokeResult.extensionDataGuard = {
                    scanButtonFound: Boolean(scanButton),
                    tableReady,
                    migrateButtonFound: Boolean(migrateButton),
                    migrateButtonDisabled: migrateButton?.disabled ?? null,
                    modalOpen: false,
                    includeDataChecked: null,
                    toastText: null
                  };
                  if (migrateButton && !migrateButton.disabled) {
                    migrateButton.click();
                    await waitForSmokeCondition(() => document.querySelector("[data-extension-migration-form]"));

                    const includeDataInput = document.querySelector("[data-include-extension-data]");
                    if (includeDataInput) {
                      includeDataInput.checked = true;
                      includeDataInput.dispatchEvent(new Event("change", { bubbles: true }));
                    }

                    const migrationForm = document.querySelector("[data-extension-migration-form]");
                    migrationForm?.requestSubmit();
                    await waitForSmokeCondition(() => document.querySelector(".toast.error"));

                    smokeResult.extensionDataGuard = {
                      ...smokeResult.extensionDataGuard,
                      modalOpen: Boolean(document.querySelector("[data-extension-migration-form]")),
                      includeDataChecked: document.querySelector("[data-include-extension-data]")?.checked ?? null,
                      toastText: document.querySelector(".toast.error")?.textContent || null
                    };

                    document.querySelector('[data-extension-migration-form] [data-action="close-modal"]')?.click();
                    await new Promise((done) => window.setTimeout(done, 0));
                  }
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
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent?.includes("监听端口"))?.querySelector("strong")?.textContent || null;
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

  ipcMain.handle(
    IPC_CHANNELS.inspectAccountSyncDiff,
    async (_event, request: AccountSyncRequest): Promise<AccountSyncDiffResult> => {
      return profileManager.inspectAccountSyncDiff(request);
    }
  );

  ipcMain.handle(IPC_CHANNELS.scanProfileExtensions, async (_event, id: string): Promise<ExtensionScanResult> => {
    return profileManager.scanProfileExtensions(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.inspectExtensionMigrationDiff,
    async (_event, request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult> => {
      return profileManager.inspectExtensionMigrationDiff(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.migrateExtensions,
    async (event, request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult> => {
      return profileManager.migrateExtensions(
        request,
        createProgressReporter(event, {
          key: "migrate-extensions",
          profileId: String(request.targetProfileId || "")
        })
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteProfileExtension,
    async (_event, profileId: string, extensionId: string): Promise<ExtensionDeleteResult> => {
      return profileManager.deleteProfileExtension(profileId, extensionId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.syncAccount, async (event, request: AccountSyncRequest): Promise<AccountSyncResult> => {
    const profileId = String(request.targetProfileId || "");
    const id = operationId("account-sync", profileId);
    const controller = new AbortController();
    const pause = new OperationPauseController();
    activeOperations.set(id, { controller, pause });

    try {
      return await profileManager.syncAccount(
        request,
        createProgressReporter(event, {
          key: "account-sync",
          profileId
        }),
        controller.signal,
        pause
      );
    } finally {
      activeOperations.delete(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.cancelOperation, async (_event, request: CancelOperationRequest): Promise<boolean> => {
    const id = operationId(String(request.key || ""), request.profileId ? String(request.profileId) : undefined);
    const operation = activeOperations.get(id);
    if (!operation) {
      return false;
    }

    operation.controller.abort();
    operation.pause.resume();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.controlOperation, async (event, request: ControlOperationRequest): Promise<boolean> => {
    const key = String(request.key || "");
    const profileId = request.profileId ? String(request.profileId) : undefined;
    const id = operationId(key, profileId);
    const operation = activeOperations.get(id);
    if (!operation) {
      return false;
    }

    if (request.action === "pause") {
      operation.pause.pause();
      event.sender.send(IPC_CHANNELS.operationProgress, {
        key,
        profileId,
        paused: true,
        message: "已收到暂停请求，当前文件复制完成后会停住。"
      } satisfies OperationProgress);
      return true;
    }

    operation.pause.resume();
    event.sender.send(IPC_CHANNELS.operationProgress, {
      key,
      profileId,
      paused: false,
      message: "已继续同步，正在等待下一个进度更新…"
    } satisfies OperationProgress);
    return true;
  });

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
