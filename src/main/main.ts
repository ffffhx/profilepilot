import { promises as fs } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent, type Rectangle } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  SetupAgentBrowserRequest,
  SetupAgentBrowserResult,
  AppState,
  CancelOperationRequest,
  ControlOperationRequest,
  DeleteProfileOptions,
  DeleteProfileResult,
  ExtensionDeleteResult,
  ExtensionMigrationDiffResult,
  ExtensionMigrationRequest,
  ExtensionMigrationResult,
  ExtensionScanResult,
  GlobalInstructionUpdateRequest,
  GlobalInstructionsSnapshot,
  OperationPauseSignal,
  OperationProgress,
  OperationProgressUpdate
} from "../shared/types";
import { defaultDataDir } from "./fs-util";
import { ensureClaudeInstructionShell, readGlobalInstructions, writeGlobalInstruction } from "./global-instructions";
import { APP_TITLE, createProfileManager } from "./profile-manager";

const profileManager = createProfileManager();
let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let miniOutsideClickWindows: BrowserWindow[] = [];
let miniOutsideClickUpdateTimer: NodeJS.Timeout | null = null;
let miniWindowSaveTimer: NodeJS.Timeout | null = null;
const APP_ICON_PATH = path.join(__dirname, "../../public/assets/profilepilot-icon-512.png");
// 整个界面的统一缩放系数（等比例放大字号/间距/控件）。想再大/再小只改这一个数。
const UI_ZOOM_FACTOR = 1.0;
const MINI_DOCK_SIZE = 80;
// 一键唤起 / 聚焦 Mini 面板的全局快捷键（macOS = Cmd+Shift+P）
const MINI_SUMMON_SHORTCUT = "CommandOrControl+Shift+P";
const MINI_PANEL_WIDTH = 360;
const MINI_PANEL_HEIGHT = 250;
const MINI_WINDOW_MARGIN = 16;
const activeOperations = new Map<string, ActiveOperation>();
let miniWindowPanelOpen = false;
let miniWindowDragState: { offsetX: number; offsetY: number } | null = null;

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

function miniWindowStatePath(): string {
  return path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "mini-window.json");
}

interface MiniWindowPosition {
  x: number;
  y: number;
  dock?: boolean;
}

function defaultMiniWindowDockBounds(): Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - MINI_DOCK_SIZE - MINI_WINDOW_MARGIN,
    y: workArea.y + MINI_WINDOW_MARGIN,
    width: MINI_DOCK_SIZE,
    height: MINI_DOCK_SIZE
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeMiniWindowDockBounds(saved: MiniWindowPosition | null): Rectangle {
  if (!saved) {
    return defaultMiniWindowDockBounds();
  }

  const savedX = saved.dock === false ? saved.x + MINI_PANEL_WIDTH - MINI_DOCK_SIZE : saved.x;
  const candidate = { x: savedX, y: saved.y, width: MINI_DOCK_SIZE, height: MINI_DOCK_SIZE };
  const workArea = screen.getDisplayMatching(candidate).workArea;
  return {
    x: clamp(candidate.x, workArea.x, workArea.x + workArea.width - MINI_DOCK_SIZE),
    y: clamp(candidate.y, workArea.y, workArea.y + workArea.height - MINI_DOCK_SIZE),
    width: MINI_DOCK_SIZE,
    height: MINI_DOCK_SIZE
  };
}

function miniDockBoundsFromWindowBounds(bounds: Rectangle): Rectangle {
  return {
    x: bounds.width > MINI_DOCK_SIZE ? bounds.x + bounds.width - MINI_DOCK_SIZE : bounds.x,
    y: bounds.y,
    width: MINI_DOCK_SIZE,
    height: MINI_DOCK_SIZE
  };
}

function miniPanelBoundsFromDockBounds(dockBounds: Rectangle): Rectangle {
  const candidate = {
    x: dockBounds.x - (MINI_PANEL_WIDTH - MINI_DOCK_SIZE),
    y: dockBounds.y,
    width: MINI_PANEL_WIDTH,
    height: MINI_PANEL_HEIGHT
  };
  const workArea = screen.getDisplayMatching(dockBounds).workArea;
  return {
    x: clamp(candidate.x, workArea.x, workArea.x + workArea.width - MINI_PANEL_WIDTH),
    y: clamp(candidate.y, workArea.y, workArea.y + workArea.height - MINI_PANEL_HEIGHT),
    width: MINI_PANEL_WIDTH,
    height: MINI_PANEL_HEIGHT
  };
}

function clampMiniWindowBoundsToPoint(bounds: Rectangle, point: { x: number; y: number }): Rectangle {
  const workArea = screen.getDisplayNearestPoint(point).workArea;
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - bounds.width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - bounds.height),
    width: bounds.width,
    height: bounds.height
  };
}

function raiseMiniWindow(windowRef = miniWindow): void {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  // 用 "floating" 而不是 "pop-up-menu"：后者层级过高，会把整个 App 变成 UIElement（无 Dock 图标）。
  // "floating" 既能保持悬浮在普通窗口之上，又不会让 App 从程序坞消失。
  windowRef.setAlwaysOnTop(true, "floating");
  (windowRef as BrowserWindow & { moveTop?: () => void }).moveTop?.();
}

function closeMiniOutsideClickWindows(): void {
  if (miniOutsideClickUpdateTimer) {
    clearTimeout(miniOutsideClickUpdateTimer);
    miniOutsideClickUpdateTimer = null;
  }

  const windows = miniOutsideClickWindows.splice(0);
  windows.forEach((windowRef) => {
    if (!windowRef.isDestroyed()) {
      windowRef.close();
    }
  });
}

function clearMiniWindowBoundsSave(): void {
  if (miniWindowSaveTimer) {
    clearTimeout(miniWindowSaveTimer);
    miniWindowSaveTimer = null;
  }
}

function miniOutsideClickBounds(panelBounds: Rectangle): Rectangle[] {
  const workArea = screen.getDisplayMatching(panelBounds).workArea;
  const panelRight = panelBounds.x + panelBounds.width;
  const panelBottom = panelBounds.y + panelBounds.height;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const candidates: Rectangle[] = [
    {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: panelBounds.y - workArea.y
    },
    {
      x: workArea.x,
      y: panelBounds.y,
      width: panelBounds.x - workArea.x,
      height: panelBounds.height
    },
    {
      x: panelRight,
      y: panelBounds.y,
      width: workRight - panelRight,
      height: panelBounds.height
    },
    {
      x: workArea.x,
      y: panelBottom,
      width: workArea.width,
      height: workBottom - panelBottom
    }
  ];

  return candidates.filter((bounds) => bounds.width > 0 && bounds.height > 0);
}

function requestMiniWindowPanelClose(): void {
  if (miniWindowPanelOpen) {
    notifyMiniWindowPanelOpen(false);
  }
}

function showMiniOutsideClickWindows(): void {
  const windowRef = miniWindow;
  closeMiniOutsideClickWindows();
  if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible() || !miniWindowPanelOpen) {
    return;
  }


  const html = encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: transparent;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <script>
      window.addEventListener("pointerdown", () => {
        window.profileManager?.requestMiniWindowPanelClose?.();
      });
    </script>
  </body>
</html>`);
  const overlayUrl = `data:text/html;charset=utf-8,${html}`;
  miniOutsideClickWindows = miniOutsideClickBounds(windowRef.getBounds()).map((bounds) => {
    const overlayWindow = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    overlayWindow.setAlwaysOnTop(true, "floating");
    overlayWindow.setVisibleOnAllWorkspaces(true);
    overlayWindow.on("closed", () => {
      miniOutsideClickWindows = miniOutsideClickWindows.filter((item) => item !== overlayWindow);
    });
    void overlayWindow.loadURL(overlayUrl).then(() => {
      if (!overlayWindow.isDestroyed()) {
        overlayWindow.showInactive();
      }
      if (!windowRef.isDestroyed()) {
        windowRef.show();
        raiseMiniWindow(windowRef);
        windowRef.focus();
      }
    });

    return overlayWindow;
  });
}

function scheduleMiniOutsideClickWindowsUpdate(): void {
  if (!miniWindowPanelOpen) {
    closeMiniOutsideClickWindows();
    return;
  }

  if (miniOutsideClickUpdateTimer) {
    clearTimeout(miniOutsideClickUpdateTimer);
  }
  miniOutsideClickUpdateTimer = setTimeout(() => {
    miniOutsideClickUpdateTimer = null;
    showMiniOutsideClickWindows();
  }, 80);
}

async function readMiniWindowPosition(): Promise<MiniWindowPosition | null> {
  try {
    const raw = await fs.readFile(miniWindowStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<MiniWindowPosition>;
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: Number(parsed.x), y: Number(parsed.y), dock: parsed.dock === true };
    }
  } catch {
    return null;
  }

  return null;
}

async function saveMiniWindowBounds(bounds: Rectangle): Promise<void> {
  const statePath = miniWindowStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ x: Math.round(bounds.x), y: Math.round(bounds.y), dock: true }, null, 2)}\n`,
    "utf8"
  );
}

function saveMiniWindowBoundsSoon(bounds: Rectangle): void {
  clearMiniWindowBoundsSave();
  miniWindowSaveTimer = setTimeout(() => {
    miniWindowSaveTimer = null;
    void saveMiniWindowBounds(bounds);
  }, 180);
}

async function createMiniWindow(): Promise<BrowserWindow> {
  if (miniWindow && !miniWindow.isDestroyed()) {
    return miniWindow;
  }

  const bounds = normalizeMiniWindowDockBounds(await readMiniWindowPosition());
  miniWindow = new BrowserWindow({
    ...bounds,
    width: MINI_DOCK_SIZE,
    height: MINI_DOCK_SIZE,
    minWidth: MINI_DOCK_SIZE,
    minHeight: MINI_DOCK_SIZE,
    maxWidth: MINI_PANEL_WIDTH,
    maxHeight: MINI_PANEL_HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: `${APP_TITLE} Mini`,
    icon: APP_ICON_PATH,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  raiseMiniWindow(miniWindow);
  miniWindow.setVisibleOnAllWorkspaces(true);
  miniWindow.webContents.on("did-finish-load", () => {
    notifyMiniWindowPanelOpen(miniWindowPanelOpen);
  });
  // 注意：不再用 blur 自动收起面板。失焦的来源太多（点“显示”把 Chrome 拉前、切窗口、
  // 展开时重排窗口等），会导致面板被意外收起。收起只由：① 点“收起”；② 点面板外面（覆盖窗）触发。
  miniWindow.on("moved", () => {
    const windowRef = miniWindow;
    if (windowRef && !windowRef.isDestroyed()) {
      if (miniWindowDragState) {
        return;
      }

      saveMiniWindowBoundsSoon(miniDockBoundsFromWindowBounds(windowRef.getBounds()));
      scheduleMiniOutsideClickWindowsUpdate();
    }
  });
  miniWindow.on("closed", () => {
    closeMiniOutsideClickWindows();
    clearMiniWindowBoundsSave();
    miniWindow = null;
  });

  await miniWindow.loadFile(path.join(__dirname, "../../public/index.html"), { query: { mode: "mini" } });
  await waitForMiniWindowFirstPaint(miniWindow, ".mini-logo-glyph");

  return miniWindow;
}

async function waitForMiniWindowFirstPaint(windowRef: BrowserWindow, selector = ".mini-logo-glyph, .mini-shell"): Promise<void> {
  if (windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) {
    return;
  }

  try {
    await Promise.race([
      windowRef.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const selector = ${JSON.stringify(selector)};
          const started = performance.now();
          const wait = () => {
            const ready = Boolean(document.querySelector(selector));
            if (ready || performance.now() - started > 500) {
              requestAnimationFrame(() => resolve(true));
              return;
            }
            requestAnimationFrame(wait);
          };
          wait();
        })`,
        true
      ),
      new Promise((resolve) => setTimeout(resolve, 650))
    ]);
  } catch {
    // Showing a hidden mini window is still safe if the renderer was reloaded or closed mid-wait.
  }
}

function notifyMiniWindowPanelOpen(open: boolean): void {
  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) {
    return;
  }

  windowRef.webContents.send(IPC_CHANNELS.miniWindowPanelOpenChanged, open);
}

function setMiniWindowPanelOpen(open: boolean): void {
  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed()) {
    miniWindowPanelOpen = open;
    return;
  }

  const currentBounds = windowRef.getBounds();
  const expectedWidth = open ? MINI_PANEL_WIDTH : MINI_DOCK_SIZE;
  const expectedHeight = open ? MINI_PANEL_HEIGHT : MINI_DOCK_SIZE;
  if (miniWindowPanelOpen === open && currentBounds.width === expectedWidth && currentBounds.height === expectedHeight) {
    notifyMiniWindowPanelOpen(open);
    if (open) {
      showMiniOutsideClickWindows();
      raiseMiniWindow(windowRef);
    } else {
      closeMiniOutsideClickWindows();
    }
    return;
  }

  const dockBounds = miniDockBoundsFromWindowBounds(currentBounds);
  miniWindowPanelOpen = open;
  windowRef.setBounds(open ? miniPanelBoundsFromDockBounds(dockBounds) : normalizeMiniWindowDockBounds(dockBounds), false);
  notifyMiniWindowPanelOpen(open);
  if (open) {
    showMiniOutsideClickWindows();
    raiseMiniWindow(windowRef);
  } else {
    closeMiniOutsideClickWindows();
  }
  void saveMiniWindowBounds(dockBounds);
}

function isMiniWindowPointerInside(): boolean {
  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible()) {
    return false;
  }

  const bounds = windowRef.getBounds();
  const point = screen.getCursorScreenPoint();
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

function dragMiniWindow(event: IpcMainInvokeEvent, screenX: number, screenY: number, phase: "start" | "move" | "end"): void {
  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed() || windowRef.webContents !== event.sender) {
    return;
  }

  if (phase === "end") {
    miniWindowDragState = null;
    clearMiniWindowBoundsSave();
    void saveMiniWindowBounds(miniDockBoundsFromWindowBounds(windowRef.getBounds()));
    scheduleMiniOutsideClickWindowsUpdate();
    return;
  }

  const pointerX = Number(screenX);
  const pointerY = Number(screenY);
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
    return;
  }

  const currentBounds = windowRef.getBounds();
  if (phase === "start" || !miniWindowDragState) {
    miniWindowDragState = {
      offsetX: pointerX - currentBounds.x,
      offsetY: pointerY - currentBounds.y
    };
    closeMiniOutsideClickWindows();
  }

  if (phase === "start") {
    return;
  }

  const nextBounds = clampMiniWindowBoundsToPoint(
    {
      x: Math.round(pointerX - miniWindowDragState.offsetX),
      y: Math.round(pointerY - miniWindowDragState.offsetY),
      width: currentBounds.width,
      height: currentBounds.height
    },
    { x: pointerX, y: pointerY }
  );
  windowRef.setBounds(nextBounds, false);
}

async function showMiniWindow(): Promise<void> {
  const windowRef = await createMiniWindow();
  setMiniWindowPanelOpen(false);
  await waitForMiniWindowFirstPaint(windowRef, ".mini-logo-glyph");
  windowRef.show();
  raiseMiniWindow(windowRef);
  windowRef.focus();
  mainWindow?.hide();
}

// 全局快捷键触发：把 Mini 面板唤到眼前。
// 已展开且在前台 → 收起；否则 → 确保可见、展开、置顶并聚焦（类似 Spotlight 行为）。
async function summonMiniWindowViaHotkey(): Promise<void> {
  if (!miniWindow || miniWindow.isDestroyed()) {
    await showMiniWindow();
  } else if (!miniWindow.isVisible()) {
    miniWindow.show();
    mainWindow?.hide();
  } else if (mainWindow?.isVisible()) {
    mainWindow.hide();
  }

  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  if (miniWindowPanelOpen && windowRef.isFocused()) {
    setMiniWindowPanelOpen(false);
    return;
  }

  setMiniWindowPanelOpen(true);
  raiseMiniWindow(windowRef);
  windowRef.focus();
}

function registerGlobalShortcuts(): void {
  globalShortcut.unregister(MINI_SUMMON_SHORTCUT);
  const registered = globalShortcut.register(MINI_SUMMON_SHORTCUT, () => {
    void summonMiniWindowViaHotkey();
  });
  if (!registered) {
    console.warn(`[mini] 全局快捷键注册失败（可能被占用）：${MINI_SUMMON_SHORTCUT}`);
  }
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  mainWindow?.show();
  mainWindow?.focus();
  closeMiniOutsideClickWindows();
  miniWindow?.hide();
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

  // UI 是深色仪表台主题，原生控件（select 弹出菜单、滚动条等）必须跟随深色
  nativeTheme.themeSource = "dark";

  // 默认窗口尺寸随 UI_ZOOM_FACTOR 一起放大，保证缩放后二栏布局仍有原来的可用空间。
  mainWindow = new BrowserWindow({
    width: Math.round(1120 * UI_ZOOM_FACTOR),
    height: Math.round(760 * UI_ZOOM_FACTOR),
    minWidth: 860,
    minHeight: 620,
    show: !smokeTest,
    title: APP_TITLE,
    icon: APP_ICON_PATH,
    backgroundColor: "#0a1014",
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

                await waitForSmokeCondition(() => document.querySelector("h1") && document.querySelector('[data-action="open-global-instructions"]'), 5000);

                const smokeResult = {
                  title: document.title,
                  h1: document.querySelector("h1")?.textContent || null,
                  hasBridge: Boolean(window.profileManager),
                  hasRenameProfile: typeof window.profileManager?.renameProfile === "function",
                  hasFocusProfile: typeof window.profileManager?.focusProfile === "function",
                  hasCloseProfile: typeof window.profileManager?.closeProfile === "function",
                  hasLaunchProfileWithCdp: typeof window.profileManager?.launchProfileWithCdp === "function",
                  hasConnectRunningSystemChrome:
                    typeof window.profileManager?.connectRunningSystemChrome === "function",
                  hasScanProfileExtensions: typeof window.profileManager?.scanProfileExtensions === "function",
                  hasMigrateExtensions: typeof window.profileManager?.migrateExtensions === "function",
                  hasDeleteProfileExtension: typeof window.profileManager?.deleteProfileExtension === "function",
                  hasInspectAccountSyncDiff: typeof window.profileManager?.inspectAccountSyncDiff === "function",
                  hasInspectExtensionMigrationDiff: typeof window.profileManager?.inspectExtensionMigrationDiff === "function",
                  hasSyncAccount: typeof window.profileManager?.syncAccount === "function",
                  hasCancelOperation: typeof window.profileManager?.cancelOperation === "function",
                  hasControlOperation: typeof window.profileManager?.controlOperation === "function",
                  hasReadGlobalInstructions: typeof window.profileManager?.readGlobalInstructions === "function",
                  hasWriteGlobalInstruction: typeof window.profileManager?.writeGlobalInstruction === "function",
                  hasEnsureClaudeInstructionShell: typeof window.profileManager?.ensureClaudeInstructionShell === "function",
                  hasOperationProgress: typeof window.profileManager?.onOperationProgress === "function",
                  buttonCount: document.querySelectorAll("button").length,
                  statusLabels: Array.from(document.querySelectorAll(".status-label")).map((item) => item.textContent),
                  statusValues: Array.from(document.querySelectorAll(".status-value")).map((item) => item.textContent),
                  accountSyncTitle: document.querySelector("[data-account-sync] h2")?.textContent || null,
                  accountSyncSelectCount: document.querySelectorAll("[data-account-sync] select").length,
                  accountSyncScopeHeadings: Array.from(document.querySelectorAll(".account-sync-scope-group strong")).map((item) => item.textContent),
                  accountSyncScopeItems: Array.from(document.querySelectorAll(".account-sync-scope-group li")).map((item) => item.textContent),
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
                    document.querySelectorAll("[data-profile-row] .profile-actions > .action-button, [data-profile-row] .profile-actions > .action-tooltip > .action-button")
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
                  globalInstructionFiles: [],
                  globalInstructionHasContent: false,
                  globalInstructionsModalTitle: null,
                  globalInstructionsModalTabs: [],
                  globalInstructionsModalPath: null,
                  globalInstructionsModalHasContent: false,
                  globalInstructionsEditorReady: false,
                  globalInstructionsEditorDraftLength: null,
                  crud: null
                };

                const visibleState = await window.profileManager.getState();
                const globalInstructions = await window.profileManager.readGlobalInstructions();
                smokeResult.globalInstructionFiles = globalInstructions.files.map((file) => file.fileName);
                smokeResult.globalInstructionHasContent = globalInstructions.files.some((file) => file.exists && file.content.length > 0);
                const globalInstructionsButton = document.querySelector('[data-action="open-global-instructions"]');
                if (globalInstructionsButton instanceof HTMLButtonElement) {
                  globalInstructionsButton.click();
                  await waitForSmokeCondition(() => document.querySelector(".global-instructions-modal"), 1000);
                  await waitForSmokeCondition(() => document.querySelector(".global-instruction-content, .global-instruction-message"), 2500);
                  smokeResult.globalInstructionsModalTitle = document.querySelector(".global-instructions-modal h2")?.textContent || null;
                  smokeResult.globalInstructionsModalTabs = Array.from(document.querySelectorAll(".global-instruction-tab span")).map((item) => item.textContent);
                  smokeResult.globalInstructionsModalPath = document.querySelector(".global-instruction-meta code")?.textContent || null;
                  smokeResult.globalInstructionsModalHasContent = Boolean(document.querySelector(".global-instruction-content")?.textContent?.length);
                  const editButton = document.querySelector('[data-action="edit-global-instruction"]');
                  if (editButton instanceof HTMLButtonElement && !editButton.disabled) {
                    editButton.click();
                    await waitForSmokeCondition(() => document.querySelector("[data-global-instruction-editor]"), 1000);
                    const editor = document.querySelector("[data-global-instruction-editor]");
                    smokeResult.globalInstructionsEditorReady = editor instanceof HTMLTextAreaElement;
                    smokeResult.globalInstructionsEditorDraftLength = editor instanceof HTMLTextAreaElement ? editor.value.length : null;
                    document.querySelector('[data-action="cancel-global-instruction-edit"]')?.click();
                    await new Promise((done) => window.setTimeout(done, 0));
                  }
                  document.querySelector('.global-instructions-modal [data-action="close-modal"]')?.click();
                  await new Promise((done) => window.setTimeout(done, 0));
                }
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
                const firstMenuButton = document.querySelector("[data-profile-row] .menu-button");
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

  // 整体 UI 缩放：样式表保持原始的紧凑基准字号/间距，这里用一个统一的缩放系数
  // 等比例放大整个界面（字号、间距、控件一起放大），比逐条加 px 更协调，调一个数即可。
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.setZoomFactor(UI_ZOOM_FACTOR);
  });

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

  ipcMain.handle(IPC_CHANNELS.connectRunningSystemChrome, async (_event, id: string): Promise<AppState> => {
    await profileManager.connectRunningSystemChrome(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.suggestCdpPort, async (_event, preferredPort?: number | null) => {
    return profileManager.suggestCdpPort(preferredPort);
  });

  ipcMain.handle(IPC_CHANNELS.setAgentBrowserConfig, async (_event, id: string, port: number): Promise<AppState> => {
    await profileManager.setAgentBrowserConfig(id, port);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.clearAgentBrowserConfig, async (_event, id: string): Promise<AppState> => {
    await profileManager.clearAgentBrowserConfig(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.setMiniProfilePinned, async (_event, id: string, pinned: boolean): Promise<AppState> => {
    await profileManager.setMiniProfilePinned(id, Boolean(pinned));
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.showMiniWindow, async (): Promise<void> => {
    await showMiniWindow();
  });

  ipcMain.handle(IPC_CHANNELS.showMainWindow, async (): Promise<void> => {
    await showMainWindow();
  });

  ipcMain.handle(IPC_CHANNELS.setMiniWindowPanelOpen, async (_event, open: boolean): Promise<void> => {
    setMiniWindowPanelOpen(Boolean(open));
  });

  ipcMain.handle(IPC_CHANNELS.requestMiniWindowPanelClose, async (): Promise<void> => {
    requestMiniWindowPanelClose();
  });

  ipcMain.handle(
    IPC_CHANNELS.dragMiniWindow,
    async (event, screenX: number, screenY: number, phase: "start" | "move" | "end"): Promise<void> => {
      if (phase !== "start" && phase !== "move" && phase !== "end") {
        return;
      }

      dragMiniWindow(event, screenX, screenY, phase);
    }
  );

  ipcMain.handle(IPC_CHANNELS.isMiniWindowPointerInside, async (): Promise<boolean> => {
    return isMiniWindowPointerInside();
  });

  ipcMain.handle(IPC_CHANNELS.readGlobalInstructions, async (): Promise<GlobalInstructionsSnapshot> => {
    return readGlobalInstructions();
  });

  ipcMain.handle(
    IPC_CHANNELS.writeGlobalInstruction,
    async (_event, request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot> => {
      return writeGlobalInstruction(request);
    }
  );

  ipcMain.handle(IPC_CHANNELS.ensureClaudeInstructionShell, async (): Promise<GlobalInstructionsSnapshot> => {
    return ensureClaudeInstructionShell();
  });

  ipcMain.handle(IPC_CHANNELS.focusProfile, async (_event, id: string): Promise<AppState> => {
    await profileManager.focusProfile(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.isProfileFrontmost, async (_event, id: string): Promise<boolean> => {
    return profileManager.isProfileFrontmost(id);
  });

  ipcMain.handle(IPC_CHANNELS.closeProfile, async (_event, id: string): Promise<AppState> => {
    await profileManager.closeProfile(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.focusExternalInstance, async (_event, userDataDir: string): Promise<AppState> => {
    await profileManager.focusExternalInstance(userDataDir);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.closeExternalInstance, async (_event, userDataDir: string): Promise<AppState> => {
    await profileManager.closeExternalInstance(userDataDir);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.openProfileFolder, async (_event, id: string): Promise<AppState> => {
    await profileManager.openProfileFolder(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.openProfileExtensionsPage, async (_event, id: string): Promise<AppState> => {
    await profileManager.openProfileExtensionsPage(id);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, targetPath: string): Promise<boolean> => {
    await profileManager.openPath(targetPath);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.deleteProfile, async (_event, id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult> => {
    return profileManager.deleteProfile(id, options);
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

  ipcMain.handle(
    IPC_CHANNELS.setupAgentBrowser,
    async (event, request: SetupAgentBrowserRequest): Promise<SetupAgentBrowserResult> => {
      const id = operationId("setup-agent-browser");
      const controller = new AbortController();
      const pause = new OperationPauseController();
      activeOperations.set(id, { controller, pause });

      try {
        return await profileManager.setupAgentBrowser(
          request,
          createProgressReporter(event, { key: "setup-agent-browser" }),
          controller.signal,
          pause
        );
      } finally {
        activeOperations.delete(id);
      }
    }
  );

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
  registerGlobalShortcuts();
  createMainWindow();

  // 点击 Dock 图标：始终把主控制台拉回来（必要时重建），并收起悬浮窗。
  // 覆盖“主窗口已关闭、只剩悬浮窗”的情况——此时旧逻辑会因为还有窗口而什么都不做。
  app.on("activate", () => {
    void showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
