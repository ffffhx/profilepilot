import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import type { AppState, DeleteProfileResult } from "../shared/types";
import { APP_TITLE, createProfileManager } from "./profile-manager";

const profileManager = createProfileManager();
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  const smokeTest = process.env.CPM_ELECTRON_SMOKE_TEST === "1";

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: !smokeTest,
    title: APP_TITLE,
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
                  hasFocusProfile: typeof window.profileManager?.focusProfile === "function",
                  hasCloseProfile: typeof window.profileManager?.closeProfile === "function",
                  hasLaunchProfileWithCdp: typeof window.profileManager?.launchProfileWithCdp === "function",
                  buttonCount: document.querySelectorAll("button").length,
                  statusLabels: Array.from(document.querySelectorAll(".status-label")).map((item) => item.textContent),
                  statusValues: Array.from(document.querySelectorAll(".status-value")).map((item) => item.textContent),
                  sourcePills: Array.from(document.querySelectorAll(".source-pill")).map((item) => item.textContent),
                  cdpTooltips: Array.from(document.querySelectorAll(".action-tooltip")).map((item) => item.getAttribute("data-tooltip")),
                  detailTitleBeforeSelection: document.querySelector(".details h2")?.textContent || null,
                  detailProcessLabelBeforeSelection:
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent?.includes("进程"))?.querySelector("span")?.textContent || null,
                  detailListeningPortsBeforeSelection:
                    Array.from(document.querySelectorAll(".detail-row")).find((row) => row.querySelector("span")?.textContent === "本机监听端口")?.querySelector("strong")?.textContent || null,
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
}

app.name = APP_TITLE;
app.whenReady().then(() => {
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
